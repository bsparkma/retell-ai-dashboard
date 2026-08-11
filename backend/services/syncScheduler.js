/**
 * Sync Scheduler Service
 * 
 * Manages scheduled syncing of Mango Voice calls.
 * Handles automatic sync jobs and manual triggers.
 */

const cron = require('node-cron');
const mangoScraper = require('./mangoScraper');
const mangoApiClient = require('./mangoApiClient');
const callAnalyzer = require('./callAnalyzer');
const unifiedCallStore = require('./unifiedCallStore');
const openDentalSyncService = require('./openDentalSync');
const retellService = require('../config/retell');
const mangoConfig = require('../config/mango');
const { isMangoSyncDisabled } = require('../middleware/envGuards');

// Hard cap on how many /v3/list-calls pages one Retell sync will walk. At the default
// limit of 1000 per page that is 5000 calls per run — far beyond a practice's 15-minute
// volume — and it bounds a runaway cursor. Hitting the cap is logged, never silent.
const RETELL_SYNC_MAX_PAGES = 5;

// How often the automatic Retell pull fires. Owned here (rather than as a bare
// setInterval in server.js) so the scheduler can answer "when does the next automatic
// sync land?" — the freshness caption on the worklist is only honest if one object
// knows both cadences.
const RETELL_SYNC_INTERVAL_MS = 15 * 60 * 1000;

// Why a manual Mango sync declined to run. These are ANSWERS, not errors: the sync-now
// route reports them per source and still returns 200 when the other source succeeded.
const SYNC_SKIP_DISABLED = 'MANGO_DISABLED';   // MANGO_SYNC_DISABLED=true
const SYNC_SKIP_OFF = 'MANGO_OFF';             // MANGO_INGEST_MODE=off
const SYNC_SKIP_RUNNING = 'ALREADY_RUNNING';   // the :15 autosync is mid-flight

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
    /** Retell auto-sync timer + the ISO time of its next fire (null until started). */
    this.retellTimer = null;
    this.nextRetellSync = null;
    /**
     * When a Retell pull last COMPLETED — not when a Retell call last arrived. The store's
     * own `lastRetellSync` stat is stamped per stored call, so a quiet hour leaves it
     * frozen; a freshness caption built on it would claim the list is stale when it is
     * merely uneventful.
     */
    this.lastRetellSync = null;
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
   * Run a sync job (can be called manually or by scheduler).
   *
   * @param {{ maxCalls?: number, trigger?: 'scheduled'|'manual', actor?: string|null }} options
   *   `trigger`/`actor` are recorded on the history entry so /api/admin/sync/history can
   *   answer "was this the :15 cron or did someone press Sync now, and who?". They change
   *   nothing about what the sync does.
   * @returns {Promise<object>} the history entry, or `{ success: false, code, message }`
   *   when the sync declined to run (see SYNC_SKIP_*).
   */
  async runSync(options = {}) {
    if (isMangoSyncDisabled()) {
      console.log('⏸️  Mango sync skipped (MANGO_SYNC_DISABLED=true)');
      return { success: false, code: SYNC_SKIP_DISABLED, message: 'Mango sync disabled in this environment' };
    }
    if (mangoConfig.ingestMode === 'off') {
      console.log('⏸️  Mango sync skipped (MANGO_INGEST_MODE=off)');
      return { success: false, code: SYNC_SKIP_OFF, message: 'Mango ingestion is off (MANGO_INGEST_MODE=off)' };
    }
    if (this.isRunning) {
      console.log('⚠️ Sync already in progress, skipping...');
      return { success: false, code: SYNC_SKIP_RUNNING, message: 'Sync already in progress' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    const syncLog = {
      id: `sync_${Date.now()}`,
      started_at: new Date().toISOString(),
      completed_at: null,
      status: 'running',
      // Who/what asked for this run. Defaults describe the cron, which is the only
      // caller that passes neither.
      trigger: options.trigger === 'manual' ? 'manual' : 'scheduled',
      actor: options.actor ?? null,
      calls_found: 0,
      calls_imported: 0,
      calls_transcribed: 0,
      calls_skipped_auto_off: 0,
      calls_skipped_budget: 0,
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
      // (M4) Calls that WOULD have been transcribed automatically but were left for a human
      // to decide on. Reported separately from calls_skipped_budget so "the valve is off"
      // never reads as "the breaker fired".
      syncLog.calls_skipped_auto_off = sourceResult.transcription_skipped_auto_off || 0;
      syncLog.calls_skipped_budget = sourceResult.transcription_skipped_budget || 0;

      if (sourceResult.errors && sourceResult.errors.length > 0) {
        syncLog.errors.push(...sourceResult.errors);
      }

      const calls = sourceResult.calls || [];

      // Step 2: Analyze calls with AI
      console.log('🧠 Step 2/3: Analyzing calls with AI...');
      for (const call of calls) {
        // RE-ANALYSIS DEDUP GUARD (cost-investigation #2a): if this call already has a
        // summary in the store, don't re-bill the summarizer LLM on every poll. A prior
        // FAILED analysis leaves summary null, so it is still retried. Mirrors the
        // transcription dedup guard in mangoApiClient.fullSync.
        const existingForCall = unifiedCallStore.findByExternalId(call.external_id);
        if (existingForCall && existingForCall.summary) {
          continue;
        }
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
              // Compact-summary fields (item 2) for the OD note.
              call.action_needed = analysis.action_needed ?? null;
              call.callback_number = analysis.callback_number ?? null;
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

      // (M3) The post-sync `transcribeUntranscribedMango` sweep was removed here: it
      // filtered on `recording_path`, which the API ingest path never sets, so it found
      // zero candidates on every run for 14 days (diagnosis H2). With the ingestion
      // watermark in place, the retry for an untranscribed call is M4's on-demand button
      // over the store — not a second automatic sweep.

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
   *
   * Pages through POST /v3/list-calls with the returned pagination_key. v3 replaced the
   * legacy POST /v2/list-calls (removed 2026-06-15) and answers with an
   * { items, pagination_key, has_more } envelope instead of a bare array.
   */
  async runRetellSync(options = {}) {
    const limit = options.limit || 1000;
    console.log(`🔄 Retell sync: fetching up to ${limit} calls per page (max ${RETELL_SYNC_MAX_PAGES} pages)...`);

    try {
      let addedCount = 0;
      let fetched = 0;
      let pages = 0;
      let paginationKey = null;
      let hasMore = true;

      while (hasMore && pages < RETELL_SYNC_MAX_PAGES) {
        const page = await retellService.getCallsPage({
          limit,
          sort_order: 'descending',
          ...(paginationKey ? { pagination_key: paginationKey } : {}),
        });

        // Fail loudly. The old code console.warn'd and returned { success: false }, so a
        // changed API contract read as "quiet day" — the dashboard went stale while the
        // sync history stayed green. Throwing surfaces it in PM2 logs and marks the run
        // failed, which is the whole point of migrating off the deprecated endpoint.
        if (!page || typeof page !== 'object' || !Array.isArray(page.items)) {
          throw new Error(
            'Retell POST /v3/list-calls returned an unexpected shape (expected { items: [...] })'
          );
        }

        for (const call of page.items) {
          const stored = unifiedCallStore.addRetellCall(call);
          if (stored) addedCount++;
        }

        fetched += page.items.length;
        pages++;

        paginationKey = page.pagination_key || null;
        // Stop when the API says there is no more, and also when it claims more but hands
        // back no cursor — without that guard we would re-request page 1 forever.
        hasMore = Boolean(page.has_more) && Boolean(paginationKey);
      }

      if (hasMore) {
        console.warn(
          `⚠️ Retell sync stopped at the ${RETELL_SYNC_MAX_PAGES}-page cap with more results still available — ` +
          `${fetched} calls fetched; the remainder will be picked up on the next run.`
        );
      }

      await unifiedCallStore.persist();
      this.lastRetellSync = new Date().toISOString();
      console.log(
        `✅ Retell sync complete: ${addedCount} calls stored/updated (${fetched} fetched across ${pages} page(s))`
      );

      return { success: true, added: addedCount, fetched };
    } catch (error) {
      console.error('❌ Retell sync failed:', error.message);
      throw error;
    }
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
   * Start the periodic Retell pull (every 15 minutes) and remember when it next fires.
   *
   * This used to be a bare `setInterval` in server.js. It moved here unchanged in cadence
   * so that ONE object knows both automatic schedules — the worklist's "next auto 1:15 PM"
   * caption is a lie unless the next Retell tick is knowable, and an interval anchored to
   * process start is not derivable from a cron expression.
   */
  startRetellAutoSync() {
    if (this.retellTimer) {
      console.log('⚠️ Retell auto-sync already running');
      return;
    }
    const arm = () => { this.nextRetellSync = new Date(Date.now() + RETELL_SYNC_INTERVAL_MS).toISOString(); };
    arm();
    this.retellTimer = setInterval(() => {
      arm();
      this.runRetellSync({ limit: 1000 }).catch((err) =>
        console.error('Periodic Retell sync error:', err.message)
      );
    }, RETELL_SYNC_INTERVAL_MS);
    console.log(`⏰ Retell auto-sync scheduled every ${RETELL_SYNC_INTERVAL_MS / 60000} minutes`);
  }

  /** Stop the periodic Retell pull (tests / shutdown). */
  stopRetellAutoSync() {
    if (this.retellTimer) {
      clearInterval(this.retellTimer);
      this.retellTimer = null;
      this.nextRetellSync = null;
    }
  }

  /**
   * When the next AUTOMATIC pull lands, from either source — the sooner of the next Mango
   * cron fire and the next Retell tick. Either side may be absent (Mango is dark on
   * staging; the Retell interval isn't armed under test), in which case the other wins.
   * @returns {string|null} ISO timestamp, or null when nothing is scheduled at all.
   */
  getNextAutoSync() {
    const candidates = [];
    if (this.cronJob) {
      // Computed fresh rather than read off this.nextSync, which is only refreshed when a
      // sync completes — a caption built from a stale value drifts into the past.
      const next = computeNextCronRun(mangoConfig.sync.schedule, new Date());
      if (next) candidates.push(next.getTime());
    }
    if (this.nextRetellSync) candidates.push(new Date(this.nextRetellSync).getTime());
    if (candidates.length === 0) return null;
    return new Date(Math.min(...candidates)).toISOString();
  }

  /**
   * When call data was last pulled from ANY source — the most recent of the two syncs.
   * The persisted store stats are included as a floor so a fresh process reports the
   * truth from disk instead of "never synced" until its first run lands.
   * @returns {string|null} ISO timestamp, or null if nothing has ever synced.
   */
  getLastSyncedAt() {
    const storeStats = unifiedCallStore.getStats().lastSync || {};
    const times = [
      this.lastRetellSync,
      this.lastSync ? this.lastSync.toISOString() : null,
      storeStats.retell,
      storeStats.mango,
    ]
      .filter(Boolean)
      .map((t) => new Date(t).getTime())
      .filter((t) => Number.isFinite(t));
    if (times.length === 0) return null;
    return new Date(Math.max(...times)).toISOString();
  }

  /**
   * How Mango ingestion is configured right now, for the freshness caption:
   *   'disabled' — MANGO_SYNC_DISABLED=true (env kill switch)
   *   'off'      — MANGO_INGEST_MODE is not 'api' (staging is dark by design)
   *   'api'      — ingestion is live
   * @returns {'disabled'|'off'|'api'}
   */
  getMangoMode() {
    if (isMangoSyncDisabled()) return 'disabled';
    return mangoConfig.ingestMode === 'api' ? 'api' : 'off';
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
// Skip codes — the sync-now route maps these to honest per-source states.
_instance.SYNC_SKIP_DISABLED = SYNC_SKIP_DISABLED;
_instance.SYNC_SKIP_OFF = SYNC_SKIP_OFF;
_instance.SYNC_SKIP_RUNNING = SYNC_SKIP_RUNNING;
_instance.RETELL_SYNC_INTERVAL_MS = RETELL_SYNC_INTERVAL_MS;
module.exports = _instance;

