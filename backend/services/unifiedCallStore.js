/**
 * Unified Call Store
 * 
 * In-memory store that combines calls from multiple sources:
 * - Retell AI (real-time via webhooks + API)
 * - Mango Voice (staff calls via scraper)
 * 
 * Provides unified API for querying all calls regardless of source.
 * 
 * Note: In production, this should be backed by a database (PostgreSQL/SQLite).
 * For now, we use in-memory storage with periodic persistence to JSON.
 */

const fs = require('fs').promises;
const path = require('path');

function normalizeCallDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1e12 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }

  return new Date().toISOString();
}

function cleanCallerName(value) {
  if (typeof value !== 'string') return null;

  const cleaned = value
    .replace(/[^a-zA-Z\s.'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');

  if (!cleaned) return null;

  const commonWords = new Set([
    'caller', 'patient', 'user', 'someone', 'appointment', 'cleaning',
    'morning', 'afternoon', 'emergency', 'office', 'phone', 'number',
    'unknown', 'yes', 'no', 'okay', 'sure', 'thanks', 'thank',
  ]);

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 3) return null;
  if (words.some(word => commonWords.has(word.toLowerCase()))) return null;

  return words
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function extractCallerNameFromCall(call) {
  const analysis = call.call_analysis || {};
  const explicitName =
    call.caller_name ||
    call.patient_name ||
    analysis.caller_name ||
    analysis.patient_name ||
    analysis.name;
  const explicit = cleanCallerName(explicitName);
  if (explicit) return explicit;

  const summary =
    call.summary ||
    call.call_summary ||
    analysis.call_summary ||
    analysis.detailed_call_summary ||
    '';
  const summaryPatterns = [
    /(?:caller|patient),?\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})(?:,|\s+(?:called|requested|asked|wants|needs|provided|said|is|was)\b)/,
    /(?:caller|patient)\s+(?:named\s+)?([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\b/,
    /([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\s+(?:called|requested|asked|provided)\b/,
  ];
  for (const pattern of summaryPatterns) {
    const match = summary.match(pattern);
    const name = cleanCallerName(match?.[1]);
    if (name) return name;
  }

  // Guard: a non-string transcript (e.g. Retell's transcript_object array) must not throw
  // "transcript.match is not a function" here — this runs on every addRetellCall via
  // normalizeCall, i.e. the call_started/call_ended persist path.
  const transcript = typeof call.transcript === 'string' ? call.transcript : '';
  const thanksMatch = transcript.match(/(?:thanks|thank you),?\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\b/);
  const thanksName = cleanCallerName(thanksMatch?.[1]);
  if (thanksName) return thanksName;

  const lines = transcript.split('\n').map(line => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^Agent:/i.test(lines[i]) || !/\b(name|who am i speaking with)\b/i.test(lines[i])) {
      continue;
    }

    const nextUserLine = lines.slice(i + 1).find(line => /^User:/i.test(line));
    const userText = nextUserLine?.replace(/^User:\s*/i, '');
    const name = cleanCallerName(userText);
    if (name) return name;
  }

  return null;
}

class UnifiedCallStore {
  constructor() {
    // All calls indexed by ID
    this.calls = new Map();
    
    // Indexes for fast lookups
    this.bySource = {
      retell: new Set(),
      mango: new Set(),
    };
    
    this.byDate = new Map(); // date string -> Set of call IDs
    this.byCallerNumber = new Map(); // phone -> Set of call IDs
    
    // Persistence settings
    this.persistPath = path.join(__dirname, '../../data/unified_calls.json');
    this.tempPath = `${this.persistPath}.tmp`;
    this.isDirty = false;
    this.autoSaveInterval = null;
    // Concurrency / debounce control for persist().
    this.persistInFlight = null;       // Promise of the currently-running persist
    this.persistRequeued = false;      // Another write came in while persisting
    this.persistDebounceTimer = null;  // Debounce handle for requestPersist()
    this.persistDebounceMs = 500;
    
    // Stats
    this.stats = {
      totalRetell: 0,
      totalMango: 0,
      lastRetellSync: null,
      lastMangoSync: null,
    };
  }

  /**
   * Initialize the store - load from disk if exists
   */
  async initialize() {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.persistPath);
      await fs.mkdir(dataDir, { recursive: true });
      
      // Try to load existing data
      try {
        const data = await fs.readFile(this.persistPath, 'utf-8');
        const parsed = JSON.parse(data);
        
        // Restore calls
        if (parsed.calls) {
          for (const call of parsed.calls) {
            this.addCallInternal(call, false);
          }
        }
        
        // Restore stats
        if (parsed.stats) {
          this.stats = { ...this.stats, ...parsed.stats };
        }
        
        console.log(`✅ Unified call store loaded: ${this.calls.size} calls`);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.error('⚠️ Error loading call store:', e.message);
        }
        console.log('📋 Starting with empty call store');
      }
      
      // Start auto-save interval
      this.startAutoSave();
      
    } catch (error) {
      console.error('❌ Failed to initialize call store:', error);
    }
  }

  /**
   * Add a call to the store (internal method)
   */
  addCallInternal(call, markDirty = true) {
    const id = call.id || call.call_id || call.external_id;
    if (!id) {
      console.error('Call missing ID, skipping');
      return null;
    }
    
    // Normalize the call structure
    const normalizedCall = this.normalizeCall(call);
    normalizedCall.id = id;
    
    // Store in main map
    this.calls.set(id, normalizedCall);
    
    // Update source index
    const source = normalizedCall.source || 'retell';
    if (this.bySource[source]) {
      this.bySource[source].add(id);
    }
    
    // Update date index
    const dateKey = normalizedCall.call_date.split('T')[0];
    if (!this.byDate.has(dateKey)) {
      this.byDate.set(dateKey, new Set());
    }
    this.byDate.get(dateKey).add(id);
    
    // Update caller number index
    const phone = normalizedCall.caller_number;
    if (phone) {
      if (!this.byCallerNumber.has(phone)) {
        this.byCallerNumber.set(phone, new Set());
      }
      this.byCallerNumber.get(phone).add(id);
    }
    
    if (markDirty) {
      this.isDirty = true;
      this.requestPersist();
    }
    
    return normalizedCall;
  }

  /**
   * Normalize call to unified format
   */
  normalizeCall(call) {
    const source = call.source || 'retell';
    
    // Common fields
    const normalized = {
      id: call.id || call.call_id || call.external_id,
      source: source,
      external_id: call.external_id || call.call_id || call.id,
      
      // Call metadata
      call_date: normalizeCallDate(call.call_date || call.start_timestamp),
      duration_seconds: call.duration_seconds || call.duration || 0,
      
      // Caller info
      caller_number: call.caller_number || call.from_number || 'Unknown',
      caller_name: cleanCallerName(call.caller_name) || extractCallerNameFromCall(call),
      
      // Handler info
      handler_type: call.handler_type || (source === 'mango' ? 'staff' : 'ai'),
      handler_id: call.handler_id || call.agent_id || null,
      handler_name: call.handler_name || call.agent_name || null,
      
      // Call details
      outcome: call.outcome || call.success_status || 'unknown',
      call_reason: call.call_reason || call.reason || null,
      is_emergency: call.is_emergency || false,
      sentiment: call.sentiment || 'neutral',
      
      // Transfer tracking
      transfer_attempted: call.transfer_attempted || false,
      transfer_status: call.transfer_status || 'none',
      transfer_destination: call.transfer_destination || null,
      callback_required: call.callback_required || false,
      callback_reason: call.callback_reason || null,
      
      // Content
      summary: call.summary || call.call_summary || call.call_analysis?.call_summary || null,
      transcript: call.transcript || null,
      transcript_json: call.transcript_json || call.transcript_object || null,
      recording_url: call.recording_url || null,
      recording_path: call.recording_path || null,

      // Source-specific metadata (useful for deep links + recording retrieval)
      mango_call_id: call.mango_call_id || call.raw_data?.mango_call_id || null,
      mango_detail_url: call.mango_detail_url || call.raw_data?.mango_detail_url || null,
      
      // Patient matching
      patient_id: call.patient_id || null,
      patient_matched_by: call.patient_matched_by || null,
      is_new_patient: call.is_new_patient || null,
      
      // QA
      qa_score: call.qa_score || null,
      qa_evaluated_at: call.qa_evaluated_at || null,

      // Open Dental commlog sync state — MUST survive re-normalization. normalizeCall
      // rebuilds the record from scratch and addCallInternal replaces the stored call,
      // so without carrying these through, every addRetellCall (webhook re-delivery AND
      // the 15-min poller) would wipe od_sync_status and defeat commlog dedup (both the
      // webhook guard below and the existing /sync-all guard). See
      // docs/SLICE_WEBHOOK_COMMLOG_HARDENING_PRD.md.
      od_sync_status: call.od_sync_status ?? null,
      od_patient_id: call.od_patient_id ?? null,
      // od_patient_name backs the "Matched: <name>" / "Sent" worklist label (Slice B.1);
      // preserve it like the other od_* fields so a re-add doesn't drop the matched name.
      od_patient_name: call.od_patient_name ?? null,
      od_commlog_num: call.od_commlog_num ?? null,
      od_synced_at: call.od_synced_at ?? null,
      od_match_confidence: call.od_match_confidence ?? null,
      od_match_candidates: call.od_match_candidates ?? null,
      od_sync_attempted_at: call.od_sync_attempted_at ?? null,
      od_sync_error: call.od_sync_error ?? null,
      // Who sent the chart note + when + the what-was-sent record (Slice B.1).
      sent_by: call.sent_by ?? null,
      sent_at: call.sent_at ?? null,
      sent_note: call.sent_note ?? null,
      note_edited: call.note_edited ?? null,

      // CareIN triage / review-queue state (Slice B) — MUST survive re-normalization
      // for the same reason as od_* above: addRetellCall rebuilds the record on every
      // Retell webhook re-delivery / 15-min poll, and the triage + resolve endpoints
      // write these via updateCall. Without carrying them through, a re-add would reset
      // a triaged/resolved call back to "new" and lose its attribution. See Slice B PRD.
      triage_status: call.triage_status ?? 'new',
      triage_outcome: call.triage_outcome ?? null,
      triage_by: call.triage_by ?? null,
      triage_at: call.triage_at ?? null,
      triage_note: call.triage_note ?? null,
      not_a_patient: call.not_a_patient ?? false,
      not_a_patient_reason: call.not_a_patient_reason ?? null,
      resolved_by: call.resolved_by ?? null,
      resolved_at: call.resolved_at ?? null,

      // Timestamps
      created_at: call.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    return normalized;
  }

  /**
   * Add or update a call from Retell AI
   */
  addRetellCall(call) {
    const existing = this.calls.get(call.call_id);

    // Compute duration from Retell timestamps if not already set
    let duration = call.duration_seconds || call.duration || 0;
    if (!duration && call.start_timestamp && call.end_timestamp) {
      duration = Math.round((new Date(call.end_timestamp) - new Date(call.start_timestamp)) / 1000);
    }

    const normalizedCall = {
      ...call,
      source: 'retell',
      handler_type: 'ai',
      duration_seconds: duration,
      // Map Retell-specific fields to our unified schema
      caller_number: call.caller_number || call.from_number || 'Unknown',
      call_date: call.call_date || call.start_timestamp || new Date().toISOString(),
      // Preserve OD commlog sync state across re-adds: a raw webhook re-delivery or the
      // 15-min poller payload has no od_* fields, so carry them from the existing record
      // (the incoming value wins only when explicitly set). This is what keeps the
      // commlog dedup guard honest across Retell retries.
      od_sync_status: call.od_sync_status ?? existing?.od_sync_status ?? null,
      od_patient_id: call.od_patient_id ?? existing?.od_patient_id ?? null,
      od_patient_name: call.od_patient_name ?? existing?.od_patient_name ?? null,
      od_commlog_num: call.od_commlog_num ?? existing?.od_commlog_num ?? null,
      od_synced_at: call.od_synced_at ?? existing?.od_synced_at ?? null,
      od_match_confidence: call.od_match_confidence ?? existing?.od_match_confidence ?? null,
      od_match_candidates: call.od_match_candidates ?? existing?.od_match_candidates ?? null,
      od_sync_attempted_at: call.od_sync_attempted_at ?? existing?.od_sync_attempted_at ?? null,
      od_sync_error: call.od_sync_error ?? existing?.od_sync_error ?? null,
      sent_by: call.sent_by ?? existing?.sent_by ?? null,
      sent_at: call.sent_at ?? existing?.sent_at ?? null,
      sent_note: call.sent_note ?? existing?.sent_note ?? null,
      note_edited: call.note_edited ?? existing?.note_edited ?? null,
      // Preserve Slice-B triage/review state across re-adds too (same rationale as od_*
      // above): the poller/webhook payload never carries these, so a re-add must inherit
      // them from the existing record or a worked call silently reverts to untriaged.
      triage_status: call.triage_status ?? existing?.triage_status ?? null,
      triage_outcome: call.triage_outcome ?? existing?.triage_outcome ?? null,
      triage_by: call.triage_by ?? existing?.triage_by ?? null,
      triage_at: call.triage_at ?? existing?.triage_at ?? null,
      triage_note: call.triage_note ?? existing?.triage_note ?? null,
      not_a_patient: call.not_a_patient ?? existing?.not_a_patient ?? null,
      not_a_patient_reason: call.not_a_patient_reason ?? existing?.not_a_patient_reason ?? null,
      resolved_by: call.resolved_by ?? existing?.resolved_by ?? null,
      resolved_at: call.resolved_at ?? existing?.resolved_at ?? null,
    };

    const stored = this.addCallInternal(normalizedCall);

    if (!existing) {
      this.stats.totalRetell++;
    }
    this.stats.lastRetellSync = new Date().toISOString();

    return stored;
  }

  /**
   * Add calls from Mango Voice scraper
   */
  addMangoCalls(calls) {
    const added = [];
    const updated = [];
    
    for (const call of calls) {
      // Check if already exists (by external_id)
      const existingId = Array.from(this.calls.values())
        .find(c => c.external_id === call.external_id)?.id;
      
      const normalizedCall = {
        ...call,
        source: 'mango',
        handler_type: 'staff',
      };

      // If it already exists, update it with any new fields (recording_url/path/transcript/etc)
      if (existingId) {
        const existing = this.calls.get(existingId);
        if (existing) {
          const merged = {
            ...existing,
            ...this.normalizeCall({ ...existing, ...normalizedCall, id: existingId }),
            updated_at: new Date().toISOString(),
          };
          this.calls.set(existingId, merged);
          this.isDirty = true;
          this.requestPersist();
          updated.push(merged);
        }
        continue;
      }

      const stored = this.addCallInternal(normalizedCall);
      if (stored) {
        added.push(stored);
        this.stats.totalMango++;
      }
    }
    
    this.stats.lastMangoSync = new Date().toISOString();
    console.log(`✅ Mango store upsert: added ${added.length}, updated ${updated.length}`);
    
    return added;
  }

  /**
   * Get a call by ID
   */
  getCall(id) {
    return this.calls.get(id);
  }

  /**
   * Get all calls with optional filters
   */
  getCalls(options = {}) {
    const {
      source, // 'retell', 'mango', or null for all
      startDate,
      endDate,
      limit = 100,
      offset = 0,
      sortBy = 'call_date',
      sortOrder = 'desc',
      callerNumber,
      sentiment,
      outcome,
      handlerType,
      isEmergency,
      callbackRequired,
    } = options;
    
    let results = Array.from(this.calls.values());
    
    // Filter by source
    if (source) {
      results = results.filter(c => c.source === source);
    }
    
    // Filter by date range
    if (startDate) {
      const start = new Date(startDate);
      results = results.filter(c => new Date(c.call_date) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      results = results.filter(c => new Date(c.call_date) <= end);
    }
    
    // Filter by caller number
    if (callerNumber) {
      results = results.filter(c => c.caller_number?.includes(callerNumber));
    }
    
    // Filter by sentiment
    if (sentiment) {
      results = results.filter(c => c.sentiment === sentiment);
    }
    
    // Filter by outcome
    if (outcome) {
      results = results.filter(c => c.outcome === outcome);
    }
    
    // Filter by handler type
    if (handlerType) {
      results = results.filter(c => c.handler_type === handlerType);
    }
    
    // Filter by emergency status
    if (isEmergency !== undefined) {
      results = results.filter(c => c.is_emergency === isEmergency);
    }
    
    // Filter by callback required
    if (callbackRequired !== undefined) {
      results = results.filter(c => c.callback_required === callbackRequired);
    }
    
    // Sort
    results.sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      
      // Handle date sorting
      if (sortBy === 'call_date') {
        valA = new Date(valA);
        valB = new Date(valB);
      }
      
      if (sortOrder === 'desc') {
        return valB > valA ? 1 : valB < valA ? -1 : 0;
      } else {
        return valA > valB ? 1 : valA < valB ? -1 : 0;
      }
    });
    
    // Get total before pagination
    const total = results.length;
    
    // Apply pagination
    results = results.slice(offset, offset + limit);
    
    return {
      calls: results,
      total,
      pagination: {
        limit,
        offset,
        hasMore: offset + results.length < total,
      },
    };
  }

  /**
   * Get calls by caller phone number
   */
  getCallsByPhone(phone) {
    const callIds = this.byCallerNumber.get(phone) || new Set();
    return Array.from(callIds).map(id => this.calls.get(id)).filter(Boolean);
  }

  /**
   * Get calls for a specific date
   */
  getCallsByDate(dateString) {
    const callIds = this.byDate.get(dateString) || new Set();
    return Array.from(callIds).map(id => this.calls.get(id)).filter(Boolean);
  }

  /**
   * Update a call
   */
  updateCall(id, updates) {
    const call = this.calls.get(id);
    if (!call) {
      return null;
    }
    
    const updatedCall = {
      ...call,
      ...updates,
      updated_at: new Date().toISOString(),
    };
    
    this.calls.set(id, updatedCall);
    this.isDirty = true;
    this.requestPersist();

    return updatedCall;
  }

  /**
   * Get store statistics
   */
  getStats() {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const todayCalls = this.getCallsByDate(today);
    
    // Calculate source breakdown
    const retellCalls = Array.from(this.bySource.retell).length;
    const mangoCalls = Array.from(this.bySource.mango).length;
    
    // Calculate sentiment breakdown
    const allCalls = Array.from(this.calls.values());
    const sentimentBreakdown = {
      positive: allCalls.filter(c => c.sentiment === 'positive').length,
      neutral: allCalls.filter(c => c.sentiment === 'neutral').length,
      negative: allCalls.filter(c => c.sentiment === 'negative').length,
    };
    
    // Calculate handler breakdown
    const aiCalls = allCalls.filter(c => c.handler_type === 'ai').length;
    const staffCalls = allCalls.filter(c => c.handler_type === 'staff').length;
    
    return {
      totalCalls: this.calls.size,
      todayCalls: todayCalls.length,
      bySource: {
        retell: retellCalls,
        mango: mangoCalls,
      },
      byHandler: {
        ai: aiCalls,
        staff: staffCalls,
      },
      sentiment: sentimentBreakdown,
      emergencyCalls: allCalls.filter(c => c.is_emergency).length,
      callbacksNeeded: allCalls.filter(c => c.callback_required).length,
      lastSync: {
        retell: this.stats.lastRetellSync,
        mango: this.stats.lastMangoSync,
      },
    };
  }

  /**
   * Request a persist soon (debounced).
   *
   * Callers in hot paths (every webhook event, every transcript update) should
   * call this instead of `persist()` directly so we coalesce bursts of writes
   * into a single fsync.
   */
  requestPersist() {
    if (this.persistDebounceTimer) return;
    this.persistDebounceTimer = setTimeout(() => {
      this.persistDebounceTimer = null;
      this.persist().catch(err =>
        console.error('❌ Debounced persist failed:', err)
      );
    }, this.persistDebounceMs);
  }

  /**
   * Persist store to disk atomically.
   *
   * Writes to `<path>.tmp` first then renames into place — on POSIX, rename(2)
   * is atomic, so a crash mid-write cannot leave us with a half-written
   * unified_calls.json. (On Windows the underlying MoveFile is also effectively
   * atomic for same-volume renames, which is what we have here.)
   *
   * Concurrency: only one persist runs at a time. If another write lands while
   * we're persisting, we set a "requeued" flag and run one more persist after
   * the current one finishes. This prevents fsync pile-ups under load and
   * still guarantees the latest state is eventually flushed.
   */
  async persist() {
    if (!this.isDirty) return;

    if (this.persistInFlight) {
      // Coalesce: just remember that another write is needed.
      this.persistRequeued = true;
      return this.persistInFlight;
    }

    this.persistInFlight = (async () => {
      try {
        do {
          this.persistRequeued = false;
          this.isDirty = false; // clear before snapshot — any new write while
                                // we're serializing will re-set it
          const snapshot = JSON.stringify(
            {
              calls: Array.from(this.calls.values()),
              stats: this.stats,
              savedAt: new Date().toISOString(),
            },
            null,
            2,
          );
          await fs.writeFile(this.tempPath, snapshot);
          await fs.rename(this.tempPath, this.persistPath);
          // Loop again only if another write came in during this iteration.
        } while (this.persistRequeued || this.isDirty);
        console.log(`💾 Saved ${this.calls.size} calls to disk`);
      } catch (error) {
        // On failure, mark dirty again so the next interval picks it up.
        this.isDirty = true;
        console.error('❌ Failed to persist call store:', error);
        // Best-effort cleanup of the temp file.
        try {
          await fs.unlink(this.tempPath);
        } catch (_) {
          /* ignore */
        }
      } finally {
        this.persistInFlight = null;
      }
    })();

    return this.persistInFlight;
  }

  /**
   * Start auto-save interval
   */
  startAutoSave(intervalMs = 60000) {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    
    this.autoSaveInterval = setInterval(() => {
      this.persist();
    }, intervalMs);
    
    console.log(`⏰ Auto-save enabled (every ${intervalMs / 1000}s)`);
  }

  /**
   * Stop auto-save and persist final state
   */
  async shutdown() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    await this.persist();
    console.log('✅ Call store shutdown complete');
  }

  /**
   * Clear all data (for testing)
   */
  clear() {
    this.calls.clear();
    this.bySource.retell.clear();
    this.bySource.mango.clear();
    this.byDate.clear();
    this.byCallerNumber.clear();
    this.stats = {
      totalRetell: 0,
      totalMango: 0,
      lastRetellSync: null,
      lastMangoSync: null,
    };
    this.isDirty = true;
  }
}

// Export singleton instance
const unifiedCallStore = new UnifiedCallStore();
module.exports = unifiedCallStore;

