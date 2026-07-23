/**
 * Sync Scheduler Service
 * 
 * Manages scheduled syncing of Mango Voice calls.
 * Handles automatic sync jobs and manual triggers.
 */

const cron = require('node-cron');
const mangoScraper = require('./mangoScraper');
const mangoApiClient = require('./mangoApiClient');
const transcriptionService = require('./transcriptionService');
const callAnalyzer = require('./callAnalyzer');
const unifiedCallStore = require('./unifiedCallStore');
const openDentalSyncService = require('./openDentalSync');
const retellService = require('../config/retell');
const mangoConfig = require('../config/mango');
const { isMangoSyncDisabled } = require('../middleware/envGuards');

// Last sync result — read by admin health endpoint
const _syncState = {
  lastRunAt: null,
  lastSuccess: null,
  lastErrorAt: null,
  lastErrorMessage: null,
};

function getSyncState() { return { ..._syncState }; }

/**
 * Does a single cron FIELD (minute/hour/day/month/dow) match a value? Supports
 * '*', '*​/n' (step), 'a-b' (range), 'a,b,c' (list), and plain numbers — the
 * standard 5-field syntax node-cron accepts. Any unparseable token → no match.
 * @param {string} field  one cron field
 * @param {number} value  the current value for that field
 * @param {number} min    field minimum (for '*​/n' phase)
 */
function cronFieldMatches(field, value, min) {
  for (const part of String(field).split(',')) {
    if (part === '*') return true;
    const step = part.match(/^\*\/(\d+)$/);
    if (step) {
      const n = parseInt(step[1], 10);
      if (n > 0 && (value - min) % n === 0) return true;
      continue;
    }
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      if (value >= parseInt(range[1], 10) && value <= parseInt(range[2], 10)) return true;
      continue;
    }
    const rangeStep = part.match(/^(\d+)-(\d+)\/(\d+)$/);
    if (rangeStep) {
      const a = parseInt(rangeStep[1], 10), b = parseInt(rangeStep[2], 10), n = parseInt(rangeStep[3], 10);
      if (n > 0 && value >= a && value <= b && (value - a) % n === 0) return true;
      continue;
    }
    if (/^\d+$/.test(part) && parseInt(part, 10) === value) return true;
  }
  return false;
}

/**
 * Next fire time for a 5-field cron expression at or after `from`, by stepping
 * minute-by-minute (bounded to ~366 days so a never-matching expression can't
 * loop forever). Returns a Date, or null if it never matches within the window.
 * Uses LOCAL time to mirror node-cron's default behavior.
 * @param {string} schedule  '<min> <hour> <dom> <month> <dow>'
 * @param {Date} from
 * @returns {Date|null}
 */
function computeNextCronRun(schedule, from) {
  const parts = String(schedule).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;

  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1); // strictly after `from`

  const MAX_MINUTES = 366 * 24 * 60;
  for (let i = 0; i < MAX_MINUTES; i++) {
    if (
      cronFieldMatches(min, next.getMinutes(), 0) &&
      cronFieldMatches(hour, next.getHours(), 0) &&
      cronFieldMatches(dom, next.getDate(), 1) &&
      cronFieldMatches(month, next.getMonth() + 1, 1) &&
      cronFieldMatches(dow, next.getDay(), 0)
    ) {
      return next;
    }
    next.setMinutes(next.getMinutes() + 1);
  }
  return null;
}

class SyncScheduler {
  constructor() {
    this.cronJob = null;
    this.isRunning = false;
    this.lastSync = null;
    this.nextSync = null;
    this.syncHistory = [];
    this.maxHistorySize = 50;
  }

  /**
   * Start the scheduled sync job
   */
  start() {
    if (isMangoSyncDisabled()) {
      console.log('⏸️  Mango sync disabled in this environment (MANGO_SYNC_DISABLED=true)');
      return;
    }
    if (this.cronJob) {
      console.log('⚠️ Sync scheduler already running');
      return;
    }

    const schedule = mangoConfig.sync.schedule;
    
    if (!cron.validate(schedule)) {
      console.error('❌ Invalid cron schedule:', schedule);
      return;
    }

    console.log(`⏰ Starting sync scheduler with schedule: ${schedule}`);
    
    this.cronJob = cron.schedule(schedule, async () => {
      await this.runSync();
    });

    this.updateNextSyncTime();
    console.log(`✅ Sync scheduler started. Next sync: ${this.nextSync}`);
  }

  /**
   * Stop the scheduled sync job
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      console.log('⏹️ Sync scheduler stopped');
    }
  }

  /**
   * Run a sync job (can be called manually or by scheduler)
   */
  async runSync(options = {}) {
    if (isMangoSyncDisabled()) {
      console.log('⏸️  Mango sync skipped (MANGO_SYNC_DISABLED=true)');
      return { success: false, message: 'Mango sync disabled in this environment' };
    }
    if (mangoConfig.ingestMode === 'off') {
      console.log('⏸️  Mango sync skipped (MANGO_INGEST_MODE=off)');
      return { success: false, message: 'Mango ingestion is off (MANGO_INGEST_MODE=off)' };
    }
    if (this.isRunning) {
      console.log('⚠️ Sync already in progress, skipping...');
      return { success: false, message: 'Sync already in progress' };
    }

    this.isRunning = true;
    const startTime = Date.now();
    
    const syncLog = {
      id: `sync_${Date.now()}`,
      started_at: new Date().toISOString(),
      completed_at: null,
      status: 'running',
      calls_found: 0,
      calls_imported: 0,
      calls_transcribed: 0,
      calls_analyzed: 0,
      errors: [],
    };

    // Add immediately so /api/admin/sync/history shows the running job
    this.syncHistory.unshift(syncLog);
    if (this.syncHistory.length > this.maxHistorySize) {
      this.syncHistory.pop();
    }

    console.log('🔄 Starting Mango sync job...');

    try {
      // Calculate date range
      const isInitialSync = !this.lastSync;
      const lookbackDays = isInitialSync 
        ? mangoConfig.sync.initialLookbackDays 
        : mangoConfig.sync.regularLookbackDays;
      
      // Step 1: Fetch calls from the configured source (MANGO_INGEST_MODE=api).
      // The internal REST API path fetches call detail + signed recording_url and
      // transcribes inline via Azure Speech (the signed URL expires quickly), so there is
      // no separate step-2/recording-download pass. See services/mangoApiClient.js.
      console.log('📞 Step 1/3: Fetching Mango calls (api)...');
      const sourceResult = await mangoApiClient.fullSync({
        sinceDays: lookbackDays,
        maxCalls: options.maxCalls || mangoConfig.sync.maxCallsPerSync,
      });

      syncLog.calls_found = sourceResult.calls_found;
      syncLog.calls_imported = sourceResult.calls_processed;
      syncLog.calls_transcribed = sourceResult.recordings_transcribed || 0;

      if (sourceResult.errors && sourceResult.errors.length > 0) {
        syncLog.errors.push(...sourceResult.errors);
      }

      const calls = sourceResult.calls || [];

      // Step 2: Analyze calls with AI
      console.log('🧠 Step 2/3: Analyzing calls with AI...');
      for (const call of calls) {
        // D4: skip the summary LLM for very short calls (transcript retained, no flags).
        if (call.transcript && (call.duration_seconds || 0) >= mangoConfig.summaryMinSeconds) {
          try {
            const analysis = await callAnalyzer.analyzeCall(call);
            if (analysis) {
              call.caller_name = analysis.caller_name || call.caller_number;
              call.call_reason = analysis.call_reason;
              call.sentiment = analysis.sentiment;
              call.summary = analysis.summary;
              call.is_emergency = analysis.is_emergency;
              // Disposition signals for MANGO_WORKLIST_MODE='flagged' (PRD D1).
              call.appointment_requested = analysis.appointment_requested ?? false;
              call.callback_required = analysis.callback_needed ?? call.callback_required ?? false;
              syncLog.calls_analyzed++;
            }
          } catch (e) {
            syncLog.errors.push(`Analysis failed for ${call.external_id}: ${e.message}`);
          }
        }
      }

      // Step 3: Store calls (would save to database in production)
      console.log('💾 Step 3/3: Storing call data...');
      // Save into unified store (persisted to JSON on disk)
      const newlyAdded = unifiedCallStore.addMangoCalls(calls);

      // Source-agnostic entry: run each NEW Mango call through the same match → status
      // transition Retell uses, so it lands in the Slice B worklist as 'matched' /
      // 'needs_review'. Only newly-added calls are matched (re-scrapes upsert instead of
      // re-adding, so a human's triage is never clobbered). No OD write happens here.
      syncLog.calls_matched = await this.matchMangoCalls(newlyAdded);

      await unifiedCallStore.persist();

      // Update imported count to reflect actual newly-added calls
      syncLog.calls_imported = newlyAdded.length;

      // Emit to any connected clients
      const liveCallManager = require('./liveCallManager');
      if (liveCallManager.io) {
        liveCallManager.io.emit('mango:sync-complete', {
          calls_imported: newlyAdded.length,
          calls_transcribed: syncLog.calls_transcribed,
        });
      }

      syncLog.status = 'completed';
      syncLog.completed_at = new Date().toISOString();
      this.lastSync = new Date();
      this.updateNextSyncTime();

      _syncState.lastRunAt = new Date().toISOString();
      _syncState.lastSuccess = new Date().toISOString();

      // After Mango sync, transcribe any new recordings
      if (syncLog.calls_imported > 0) {
        this.transcribeUntranscribedMango({ maxCalls: syncLog.calls_imported }).catch(err =>
          console.error('Post-sync transcription error:', err.message)
        );
      }

    } catch (error) {
      console.error('❌ Sync job failed:', error.message);
      _syncState.lastRunAt = new Date().toISOString();
      _syncState.lastErrorAt = new Date().toISOString();
      _syncState.lastErrorMessage = error.message;
      syncLog.status = 'failed';
      syncLog.errors.push(error.message);
    } finally {
      this.isRunning = false;
      syncLog.duration_ms = Date.now() - startTime;
      
      // Mark completion time (even if failed)
      syncLog.completed_at = syncLog.completed_at || new Date().toISOString();
      
      console.log(`✅ Sync job ${syncLog.status} in ${syncLog.duration_ms}ms`);
    }

    return syncLog;
  }

  /**
   * Run a Retell API sync — pulls recent calls and stores them in the unified store.
   * Also transcribes any Mango calls that have local recordings but no transcript.
   */
  async runRetellSync(options = {}) {
    const limit = options.limit || 1000;
    console.log(`🔄 Retell sync: fetching up to ${limit} calls...`);

    try {
      const apiResponse = await retellService.getCalls({ limit, sort_order: 'descending' });

      if (!apiResponse || !Array.isArray(apiResponse)) {
        console.warn('⚠️ Retell API returned no data');
        return { success: false, added: 0, message: 'No data from Retell API' };
      }

      let addedCount = 0;
      for (const call of apiResponse) {
        const stored = unifiedCallStore.addRetellCall(call);
        if (stored) addedCount++;
      }

      await unifiedCallStore.persist();
      console.log(`✅ Retell sync complete: ${addedCount} calls stored/updated (${apiResponse.length} fetched)`);

      return { success: true, added: addedCount, fetched: apiResponse.length };
    } catch (error) {
      console.error('❌ Retell sync failed:', error.message);
      return { success: false, added: 0, message: error.message };
    }
  }

  /**
   * Transcribe Mango calls that have local recordings but no transcript.
   * Runs through the Azure AI Speech transcription + optional AI analysis pipeline.
   */
  async transcribeUntranscribedMango(options = {}) {
    const maxCalls = options.maxCalls || 10;
    const fs = require('fs').promises;

    if (!transcriptionService.isAvailable()) {
      console.warn('⚠️ Azure AI Speech not configured (AZURE_SPEECH_ENDPOINT missing). Skipping Mango transcription.');
      return { transcribed: 0, analyzed: 0, errors: [] };
    }

    // Find Mango calls with a recording_path but no transcript
    const allCalls = unifiedCallStore.getCalls({ source: 'mango', limit: 5000 }).calls;
    const untranscribed = allCalls.filter(c =>
      c.recording_path &&
      !c.transcript &&
      c.duration_seconds > 5 // skip very short calls (noise/hangups)
    );

    if (untranscribed.length === 0) {
      console.log('✅ No untranscribed Mango calls found');
      return { transcribed: 0, analyzed: 0, errors: [] };
    }

    console.log(`🎤 Found ${untranscribed.length} untranscribed Mango calls (processing up to ${maxCalls})`);

    const batch = untranscribed.slice(0, maxCalls);
    let transcribed = 0;
    let analyzed = 0;
    const errors = [];

    for (const call of batch) {
      // Verify the recording file actually exists on disk
      try {
        await fs.access(call.recording_path);
      } catch {
        // File missing — skip silently
        continue;
      }

      // Step 1: Transcribe
      try {
        const result = await transcriptionService.transcribeFile(call.recording_path);
        if (result && result.text) {
          const updates = {
            transcript: result.text,
            transcript_json: result.utterances || result.words || null,
          };

          // Step 2: AI analysis (D4: skip the summary LLM for very short calls).
          try {
            const longEnough = (call.duration_seconds || 0) >= mangoConfig.summaryMinSeconds;
            const analysis = longEnough
              ? await callAnalyzer.analyzeCall({ ...call, transcript: result.text })
              : null;
            if (analysis) {
              if (analysis.caller_name) updates.caller_name = analysis.caller_name;
              if (analysis.call_reason) updates.call_reason = analysis.call_reason;
              if (analysis.sentiment) updates.sentiment = analysis.sentiment;
              if (analysis.summary) updates.summary = analysis.summary;
              if (analysis.is_emergency !== undefined) updates.is_emergency = analysis.is_emergency;
              // Disposition signals for MANGO_WORKLIST_MODE='flagged' (PRD D1).
              if (analysis.appointment_requested !== undefined) updates.appointment_requested = analysis.appointment_requested;
              if (analysis.callback_needed !== undefined) updates.callback_required = analysis.callback_needed;
              analyzed++;
            }
          } catch (e) {
            errors.push(`Analysis failed for ${call.id}: ${e.message}`);
          }

          unifiedCallStore.updateCall(call.id, updates);
          transcribed++;
        }
      } catch (e) {
        errors.push(`Transcription failed for ${call.id}: ${e.message}`);
      }
    }

    // Re-run match → status now that these calls have a transcript + caller_name (a
    // name can lift a phone-only 'needs_review' to a confident 'matched'). Skips synced.
    const matched = await this.matchMangoCalls(batch);

    if (transcribed > 0 || matched > 0) {
      await unifiedCallStore.persist();
    }

    console.log(`✅ Mango transcription: ${transcribed} transcribed, ${analyzed} analyzed, ${matched} matched, ${errors.length} errors`);
    return { transcribed, analyzed, matched, errors };
  }

  /**
   * Run each Mango call through the source-agnostic match → status transition
   * (openDentalSync.matchAndSetStatus), so it enters the Slice B worklist exactly like a
   * Retell call. Re-fetches current state per id (uses the latest caller_name/number) and
   * skips 'synced' calls — a human Send-to-chart is terminal and must never be re-touched.
   * No Open Dental write happens here. Returns the count matched/status-set.
   * @param {Array<{id?: string}>} calls
   * @returns {Promise<number>}
   */
  async matchMangoCalls(calls) {
    if (!Array.isArray(calls) || calls.length === 0) return 0;
    let matched = 0;
    for (const c of calls) {
      const id = c && c.id;
      if (!id) continue;
      const current = unifiedCallStore.getCall(id);
      if (!current || current.od_sync_status === 'synced') continue;
      try {
        await openDentalSyncService.matchAndSetStatus(id, {
          caller_number: current.caller_number,
          caller_name: current.caller_name,
        });
        matched++;
      } catch (e) {
        console.error(`[Mango] matchAndSetStatus failed for ${id}: ${e.message}`);
      }
    }
    return matched;
  }

  /**
   * Update the next sync time based on cron schedule
   */
  updateNextSyncTime() {
    if (this.cronJob) {
      const schedule = mangoConfig.sync.schedule;
      // Compute the real next fire time. The previous version did parseInt('*/5') → NaN
      // → minute 0, so step schedules like '*/5 * * * *' displayed the wrong next-sync.
      const next = computeNextCronRun(schedule, new Date());
      this.nextSync = next ? next.toISOString() : null;
    }
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      running: !!this.cronJob,
      syncing: this.isRunning,
      lastSync: this.lastSync?.toISOString() || null,
      nextSync: this.nextSync,
      schedule: mangoConfig.sync.schedule,
      recentHistory: this.syncHistory.slice(0, 10),
    };
  }

  /**
   * Get sync history
   */
  getHistory() {
    return this.syncHistory;
  }

  /**
   * Clear sync history
   */
  clearHistory() {
    this.syncHistory = [];
  }
}

// Export singleton instance
const _instance = new SyncScheduler();
_instance.getSyncState = getSyncState;
// Exposed for unit tests (pure cron math, no scheduler state).
_instance.computeNextCronRun = computeNextCronRun;
_instance.cronFieldMatches = cronFieldMatches;
module.exports = _instance;

