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
const { normalizeTranscriptJson } = require('../utils/transcriptShape');
const { normalizeNotes, makeNote, normalizeActor } = require('../utils/callDispositions');
const callTwins = require('./callTwins');
const retention = require('./callRetention');

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
    // NORMALIZED caller index (M7). Distinct from byCallerNumber above, which keys on the
    // RAW string and therefore can never match a Mango row against a Retell one: the two
    // sources format the same number differently ("(918) 555-1234" vs "+19185551234").
    // Keyed on the last 10 digits so twin lookup is a Set hit instead of a full scan.
    this.byCallerKey = new Map(); // last-10-digits -> Set of call IDs

    // Persistence settings. Default resolves to <app>/data (next to the code). Override the
    // directory with CALLSTORE_DIR to point at a DURABLE mount — e.g. /data, the AzureFile
    // volume the prod container app already mounts.
    // ⚠️ COST/DURABILITY (cost-investigation #5): the prod AzureFile volume mounts at /data,
    // but this default path is <app>/data (__dirname is backend/services → ../../data). Until
    // CALLSTORE_DIR=/data is set, the store rides the EPHEMERAL container layer and is wiped
    // on every image deploy — which forces a full re-fetch + (pre-guard) re-transcription of
    // the lookback window. Setting CALLSTORE_DIR=/data in prod makes the existing volume
    // actually protect the store. Default is unchanged so this is inert until opted in.
    const callstoreDir = process.env.CALLSTORE_DIR
      ? process.env.CALLSTORE_DIR
      : path.join(__dirname, '../../data');
    this.persistPath = path.join(callstoreDir, 'unified_calls.json');
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
      // M7 tripwire. Counts Retell calls that ended in a transfer to a human. Production
      // has never seen one — that is exactly why it is counted rather than assumed: the
      // day this goes above zero, the "the Mango leg is pure duplication" premise this
      // slice is built on stops holding for those calls, and the transferred-leg design
      // has to be reopened. Persisted with the store so it survives a restart.
      transferDisconnects: 0,
    };

    // Reasons we've already warned about (transfer tripwire) / ambiguous twins we've
    // already reported, so a repeated condition logs once per process rather than per call.
    this.warnedTransferReasons = new Set();
    this.warnedAmbiguousTwins = new Set();

    /**
     * Ids of calls DELETED outright (the one-shot legacy purge), persisted with the
     * store so the deletion survives a restart.
     *
     * This is a tombstone, and it exists because deletion alone is not durable
     * against ingestion: the Mango walk re-reads a window on every sync and a gap
     * drain can reach much further back, so a purged row would simply come back.
     * Ids only — a Mango/Retell call id is an identifier, never PHI.
     *
     * BOUNDED BY DESIGN, and that is the whole reason the two primitives differ:
     * the scheduled pruner STUBS (it never deletes), so nothing but the one-shot
     * purge ever adds to this set. It does not grow with time the way the store did.
     */
    this.purgedIds = new Set();
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

        // Restore the purge tombstone BEFORE the calls: it is what refuses a
        // purged row, so loading it second would let one back in from the file.
        if (Array.isArray(parsed.purgedIds)) {
          this.purgedIds = new Set(parsed.purgedIds);
        }

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

        // M7 backlog pass: link the twins that were already in the store before this
        // slice existed. Idempotent, so a restart re-runs it harmlessly.
        const { linked, duplicates, transferred } = this.relinkAllTwins();
        console.log(
          `🔗 Mango↔Retell twins: ${duplicates} AI-answered duplicate leg(s)` +
          `${transferred ? `, ${transferred} transferred leg(s)` : ''}` +
          ` (${linked} newly linked this pass)`
        );
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

    // RETENTION GUARD 1 — the tombstone. A call deleted by the one-shot legacy
    // purge stays deleted. Without this the Mango walk (or a gap drain reaching
    // back into old history) would hand the row straight back and the purge would
    // undo itself on the next sync.
    if (this.purgedIds.has(id)) {
      return null;
    }

    // RETENTION GUARD 2 — no resurrection. A pruned call is a stub forever. This
    // path runs on every webhook re-delivery and every watermark-overlap
    // re-ingest, so without it a call would be un-pruned within the hour and its
    // content (transcript, summary, caller name) would be fetched back in.
    //
    // Returns null — the same "refused" answer as the tombstone — so callers
    // count and act on what they actually stored. Handing the stub back would
    // make addMangoCalls report it as newly added and then feed it to the Open
    // Dental matcher, which is the one place a pruned row must never reach.
    if (retention.isStub(this.calls.get(id))) {
      return null;
    }

    // A stub being replayed from disk on startup. It must NOT go through
    // normalizeCall — that rebuilds a full record from a field whitelist, so a
    // stub would come back as a live call with every content field set to null,
    // which reads as "we have this call, it just has nothing in it" rather than
    // "this call was pruned".
    if (retention.isStub(call)) {
      this.calls.set(id, call);
      this.indexCall(call, { caller: false });
      if (markDirty) {
        this.isDirty = true;
        this.requestPersist();
      }
      return call;
    }

    // Normalize the call structure
    const normalizedCall = this.normalizeCall(call);
    normalizedCall.id = id;

    // Store in main map
    this.calls.set(id, normalizedCall);

    this.indexCall(normalizedCall, { caller: true });

    if (markDirty) {
      this.isDirty = true;
      this.requestPersist();
    }

    return normalizedCall;
  }

  /**
   * Add one record to the lookup indexes.
   *
   * `caller: false` indexes everything EXCEPT the two caller-number indexes,
   * which is what a stub needs: a stub has no caller_number, and leaving a stale
   * entry in byCallerKey would offer it to the twin matcher as a candidate.
   *
   * @param {{id: string, source?: string, call_date?: string, caller_number?: string}} call
   * @param {{ caller?: boolean }} [opts]
   */
  indexCall(call, { caller = true } = {}) {
    const id = call.id;

    const source = call.source || 'retell';
    if (this.bySource[source]) {
      this.bySource[source].add(id);
    }

    if (typeof call.call_date === 'string' && call.call_date) {
      const dateKey = call.call_date.split('T')[0];
      if (!this.byDate.has(dateKey)) {
        this.byDate.set(dateKey, new Set());
      }
      this.byDate.get(dateKey).add(id);
    }

    if (!caller) return;

    const phone = call.caller_number;
    if (phone) {
      if (!this.byCallerNumber.has(phone)) {
        this.byCallerNumber.set(phone, new Set());
      }
      this.byCallerNumber.get(phone).add(id);
    }

    // The normalized caller index (M7 twin lookup).
    const callerKey = callTwins.callerKey(phone);
    if (callerKey) {
      if (!this.byCallerKey.has(callerKey)) {
        this.byCallerKey.set(callerKey, new Set());
      }
      this.byCallerKey.get(callerKey).add(id);
    }
  }

  /**
   * Drop one id from an index map, removing the bucket entirely when it empties.
   *
   * Emptying the bucket matters: `byCallerNumber.has(phone)` is how "have we ever
   * seen this number?" is answered, and a bucket left behind as an empty Set
   * would answer yes for a number whose only call has been deleted.
   *
   * @param {Map<string, Set<string>>} index
   * @param {string|null|undefined} key
   * @param {string} id
   */
  dropFromIndex(index, key, id) {
    if (!key) return;
    const bucket = index.get(key);
    if (!bucket) return;
    bucket.delete(id);
    if (bucket.size === 0) index.delete(key);
  }

  /**
   * Remove a record's caller-number entries. Used both when deleting a record and
   * when reducing one to a stub (a stub keeps its date, never its number).
   * @param {{id: string, caller_number?: string}} call
   */
  deindexCaller(call) {
    this.dropFromIndex(this.byCallerNumber, call.caller_number, call.id);
    this.dropFromIndex(this.byCallerKey, callTwins.callerKey(call.caller_number), call.id);
  }

  /**
   * Remove a record from every index. Only deletion uses this — stubbing keeps
   * the source and date entries, because the store still holds that id.
   * @param {{id: string, source?: string, call_date?: string, caller_number?: string}} call
   */
  deindexCall(call) {
    const id = call.id;
    const source = call.source || 'retell';
    if (this.bySource[source]) this.bySource[source].delete(id);
    if (typeof call.call_date === 'string' && call.call_date) {
      this.dropFromIndex(this.byDate, call.call_date.split('T')[0], id);
    }
    this.deindexCaller(call);
  }

  /**
   * Expand a set of ids to include the other leg of any twin among them.
   *
   * TWIN PAIRS AGE OUT AS A UNIT. If only one leg went, the survivor would hold a
   * `linked_call_id` pointing at a record that no longer exists — and on the
   * Mango side that link is what HIDES a duplicate leg from the worklist, so a
   * half-pruned pair would either resurface as clutter or reference nothing.
   *
   * @param {Iterable<string>} ids ids known to be in the store
   * @returns {Set<string>}
   */
  expandTwins(ids) {
    const targets = new Set();
    for (const id of ids) {
      targets.add(id);
      const call = this.calls.get(id);
      const twinId = call && call.linked_call_id;
      if (twinId && this.calls.has(twinId)) targets.add(twinId);
    }
    return targets;
  }

  /**
   * Delete records outright — the ONLY primitive that destroys data.
   *
   * Reserved for the one-shot legacy purge; the scheduled pruner stubs instead.
   * Goes through the in-memory store and the normal persist path, never the file:
   * a graceful shutdown writes the in-memory state back over unified_calls.json,
   * so a direct file edit would be silently undone.
   *
   * Idempotent: an unknown id is REPORTED in `missing`, never thrown, so re-running
   * a purge after a partial one is safe.
   *
   * @param {Iterable<string>|string} ids
   * @returns {{ deleted: number, missing: string[], ids: string[] }}
   */
  deleteCalls(ids) {
    const requested = typeof ids === 'string' ? [ids] : Array.from(ids || []);
    const missing = [];
    const present = [];
    for (const id of requested) {
      (this.calls.has(id) ? present : missing).push(id);
    }

    const targets = this.expandTwins(present);
    for (const id of targets) {
      const call = this.calls.get(id);
      this.deindexCall(call);
      this.calls.delete(id);
      this.purgedIds.add(id);
    }

    if (targets.size > 0) {
      this.isDirty = true;
      this.requestPersist();
    }

    return { deleted: targets.size, missing, ids: Array.from(targets) };
  }

  /**
   * Reduce records to their audit stubs — the retention primitive.
   *
   * Idempotent (a stub restubs to itself, counted in `alreadyStubbed`) and
   * RESUMABLE: each record is swapped in a single synchronous assignment, so a
   * process that dies mid-run leaves every record either fully live or fully
   * stubbed. There is no half-stubbed state to recover from.
   *
   * @param {Iterable<string>|string} ids
   * @param {{ now?: Date }} [opts]
   * @returns {{ stubbed: number, alreadyStubbed: number, missing: string[], ids: string[] }}
   */
  stubCalls(ids, { now = new Date() } = {}) {
    const requested = typeof ids === 'string' ? [ids] : Array.from(ids || []);
    const missing = [];
    const present = [];
    for (const id of requested) {
      (this.calls.has(id) ? present : missing).push(id);
    }

    const targets = this.expandTwins(present);
    const stubbedIds = [];
    let alreadyStubbed = 0;

    for (const id of targets) {
      const call = this.calls.get(id);
      if (retention.isStub(call)) {
        alreadyStubbed++;
        continue;
      }
      const stub = retention.toStub(call, { now });
      this.deindexCaller(call);
      this.calls.set(id, stub);
      stubbedIds.push(id);
    }

    if (stubbedIds.length > 0) {
      this.isDirty = true;
      this.requestPersist();
    }

    return { stubbed: stubbedIds.length, alreadyStubbed, missing, ids: stubbedIds };
  }

  /**
   * Is this id held as a pruned stub? Routes use it to answer a mutation with an
   * honest 409 instead of a 404 that would read as "no such call".
   * @param {string} id
   * @returns {boolean}
   */
  isPruned(id) {
    return retention.isStub(this.calls.get(id));
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
      // Office line the caller dialed (the DID). REQUIRED for Mango office attribution:
      // getOfficeForCall reads called_number, and normalizeCall rebuilds the record from
      // scratch — without carrying this through, the DID is dropped on storage and EVERY
      // Mango call resolves to office 'unknown' (day-1 office-attribution bug). direction
      // is preserved alongside it for completeness.
      called_number: call.called_number || call.to_number || null,
      direction: call.direction || null,
      caller_name: cleanCallerName(call.caller_name) || extractCallerNameFromCall(call),
      
      // Handler info
      handler_type: call.handler_type || (source === 'mango' ? 'staff' : 'ai'),
      handler_id: call.handler_id || call.agent_id || null,
      handler_name: call.handler_name || call.agent_name || null,
      
      // Call details
      outcome: call.outcome || call.success_status || 'unknown',
      call_reason: call.call_reason || call.reason || null,
      is_emergency: call.is_emergency || false,
      // Disposition signal for MANGO_WORKLIST_MODE='flagged' (PRD D1). Set from the
      // human-call analyzer; defaults false. callback is tracked by callback_required below.
      appointment_requested: call.appointment_requested || false,
      sentiment: call.sentiment || 'neutral',
      
      // Transfer tracking
      transfer_attempted: call.transfer_attempted || false,
      transfer_status: call.transfer_status || 'none',
      transfer_destination: call.transfer_destination || null,
      callback_required: call.callback_required || false,
      callback_reason: call.callback_reason || null,
      
      // Compact-summary fields for the OD chart note (day-1 item 2). Like the fields above,
      // these must survive normalizeCall's rebuild or the note's Action/Callback lines reset.
      action_needed: call.action_needed ?? null,
      callback_number: call.callback_number ?? null,

      // Content
      summary: call.summary || call.call_summary || call.call_analysis?.call_summary || null,
      transcript: call.transcript || null,
      // ONE canonical transcript shape in the store (utils/transcriptShape.js).
      // Producers disagreed — Retell writes {role, content}, the M4 on-demand path
      // writes Azure's {speaker, text, start, end} — and every consumer was left to
      // guess, which is how "Send transcript to chart" came to write
      // "[] 👤 Caller: undefined" for every on-demand line. Normalizing HERE means
      // the store holds one shape no matter who wrote it, and since this runs on
      // every re-ingest it also heals rows written before the fix. Idempotent, so
      // re-normalizing already-canonical data is a no-op.
      transcript_json: normalizeTranscriptJson(call.transcript_json || call.transcript_object),

      // On-demand transcription attribution (Mango slice M4). MUST survive re-normalization
      // for the same reason as od_* / triage_* below: the hourly sync re-ingests inside the
      // watermark overlap and addMangoCalls rebuilds the record through normalizeCall, so
      // without carrying these through, "who pressed Transcribe, and when" is erased within
      // the hour while the transcript it produced stays.
      transcribed_at: call.transcribed_at ?? null,
      transcribed_by: call.transcribed_by ?? null,
      transcribe_source: call.transcribe_source ?? null,
      // The last on-demand attempt's outcome. Carries 'no_speech' — an attempt that spent
      // budget and produced nothing — so the UI can hold that state across a reload and
      // require an explicit confirmation before spending on the same silent recording
      // again. Losing this to a re-ingest would silently re-arm accidental re-billing.
      transcribe_last_outcome: call.transcribe_last_outcome ?? null,
      transcribe_last_attempt_at: call.transcribe_last_attempt_at ?? null,
      transcribe_last_attempt_by: call.transcribe_last_attempt_by ?? null,
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

      // Cross-module handoff to Treatment Coordinator (Mango slice M6) — MUST
      // survive re-normalization for exactly the reason od_*/triage_*/no_speech
      // above do: the hourly Mango sync re-ingests inside the watermark overlap
      // and addMangoCalls rebuilds the record through normalizeCall. Without
      // carrying these through, a call handed to TC would lose its case linkage
      // within the hour — the "In TC" chip would vanish and the row would invite
      // a second send, while the case sits in TC unreferenced.
      tc_case_id: call.tc_case_id ?? null,
      tc_case_url: call.tc_case_url ?? null,
      tc_sent_at: call.tc_sent_at ?? null,
      tc_sent_by: call.tc_sent_by ?? null,

      // Mango ↔ Retell twin linkage (M7) — MUST survive re-normalization for exactly the
      // reason od_*/triage_*/tc_* above do: the hourly Mango sync re-ingests inside the
      // watermark overlap and addMangoCalls rebuilds the record through normalizeCall, and
      // every Retell webhook event re-adds the AI row. Without carrying these through, a
      // linked duplicate leg would un-hide itself within the hour and the front desk would
      // watch resolved clutter reappear. `linked_call_id` is the twin's store id on BOTH
      // rows; `link_role` is 'primary' (Retell) / 'duplicate_leg' / 'transferred_leg'.
      linked_call_id: call.linked_call_id ?? null,
      link_role: call.link_role ?? null,

      // Call disposition + internal notes — MUST survive re-normalization for exactly
      // the reason od_*/triage_*/tc_* above do: the hourly Mango sync re-ingests inside
      // the watermark overlap and every Retell webhook event re-adds the AI row. Without
      // carrying these through, a call somebody dispositioned as a lab or a vendor would
      // read as untouched backlog again within the hour, and the notes the team wrote on
      // it would be gone — worse than never having offered the field.
      //
      // `disposition` is the closed enum in utils/callDispositions.js; _by/_at are set and
      // cleared WITH it, so "handled by nobody at no time" is not a representable state.
      disposition: call.disposition ?? null,
      disposition_by: call.disposition_by ?? null,
      disposition_at: call.disposition_at ?? null,
      // Append-only free text. normalizeNotes is idempotent by contract (this runs on
      // every re-ingest) and drops malformed entries rather than storing half a note.
      notes: normalizeNotes(call.notes),

      // Retell's own reason the call ended. Captured on the call_ended webhook since day
      // one and thrown away here ever since — this whitelist is the only reason it never
      // reached the store. It is the ONLY honest basis for telling an AI-completed call
      // from one the AI transferred to a human; the duration delta cannot do it, because
      // the two legs end at the same instant by construction (see services/callTwins.js).
      disconnection_reason: call.disconnection_reason ?? null,

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
      // Preserve the transcript and recording across re-adds. POST /v3/list-calls
      // deliberately omits transcript / transcript_object / transcript_with_tool_calls
      // AND recording_url (they dominate the payload size), and addRetellCall rebuilds
      // the record while addCallInternal REPLACES the stored call — so without
      // inheriting these, the 15-minute poller would wipe what the call_analyzed webhook
      // already delivered, every run. Same rationale as the od_*/triage_*/tc_* fields
      // below; mangoApiClient does the same for the Mango side. Both come back from
      // GET /v2/get-call when a call genuinely needs re-hydrating.
      transcript: call.transcript ?? existing?.transcript ?? null,
      transcript_json:
        call.transcript_json ?? call.transcript_object ?? existing?.transcript_json ?? null,
      recording_url: call.recording_url ?? existing?.recording_url ?? null,
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
      // TC handoff linkage (M6) — same rationale: a Retell webhook re-delivery or
      // the 15-min poller payload carries none of these, so inherit them or a
      // re-add drops the call's TC case.
      tc_case_id: call.tc_case_id ?? existing?.tc_case_id ?? null,
      tc_case_url: call.tc_case_url ?? existing?.tc_case_url ?? null,
      tc_sent_at: call.tc_sent_at ?? existing?.tc_sent_at ?? null,
      tc_sent_by: call.tc_sent_by ?? existing?.tc_sent_by ?? null,
      // M7 — same rationale again. A Retell call is re-added at least three times
      // (call_started → call_ended → call_analyzed) plus every 15-min poll, and only ONE
      // of those payloads carries disconnection_reason. Inheriting it means the reason
      // survives the events that don't mention it; inheriting the link means the twin
      // survives them too.
      linked_call_id: call.linked_call_id ?? existing?.linked_call_id ?? null,
      link_role: call.link_role ?? existing?.link_role ?? null,
      disconnection_reason: call.disconnection_reason ?? existing?.disconnection_reason ?? null,
      // Disposition + notes — same rationale one more time. This layer matters on its
      // own: unlike addMangoCalls (which merges the EXISTING record into the payload
      // before normalizing), this path rebuilds from the incoming Retell payload alone,
      // so a field the payload never mentions is only preserved if it is inherited HERE.
      // Layer A's default for notes is [] — without this line every webhook re-delivery
      // would hand normalizeCall an empty array and the notes would be gone.
      disposition: call.disposition ?? existing?.disposition ?? null,
      disposition_by: call.disposition_by ?? existing?.disposition_by ?? null,
      disposition_at: call.disposition_at ?? existing?.disposition_at ?? null,
      notes: call.notes ?? existing?.notes ?? [],
    };

    this.noteTransferDisconnect(normalizedCall, existing);

    const stored = this.addCallInternal(normalizedCall);

    // `stored` is null when the call is tombstoned by the legacy purge — counting
    // it would inflate totalRetell on every poll for a call that is not there.
    if (stored && !existing) {
      this.stats.totalRetell++;
    }
    this.stats.lastRetellSync = new Date().toISOString();

    // A Retell call usually lands AFTER its Mango leg (the PBX row is created when the
    // call hits the PBX, the AI row when it is forwarded), so linking has to run from
    // this side too — not only on Mango ingest.
    if (stored) this.linkTwinFor(stored);

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

      // NOTE (retention): the upsert branch below needs no tombstone/stub guard of
      // its own. It is reached only via findByExternalId, and neither a deleted
      // record nor a stub carries an external_id — so both fall through to
      // addCallInternal, where the two guards live. Adding a second copy here
      // would be unreachable code pretending to be a safety net.

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

    // Link every row this upsert touched — added AND updated. The updated ones matter:
    // a Mango leg ingested before its Retell twin arrived would otherwise stay unlinked
    // until the next full relink, which is the window in which the duplicate is visible
    // in "Needs attention".
    let linked = 0;
    for (const call of [...added, ...updated]) {
      if (this.linkTwinFor(call)) linked++;
    }

    this.stats.lastMangoSync = new Date().toISOString();
    console.log(
      `✅ Mango store upsert: added ${added.length}, updated ${updated.length}` +
      (linked ? `, linked ${linked} AI twin(s)` : '')
    );

    return added;
  }

  /**
   * Count (and warn once about) a Retell call that ended by transferring to a human.
   *
   * This is the M7 tripwire. Every twin observed in production so far has been
   * AI-COMPLETED — the AI handled the call end to end and the Mango leg is pure
   * duplication — which is what makes hiding the Mango leg safe. A transfer breaks that:
   * the Mango leg then holds the human half of the conversation and must stay visible.
   * Rather than assume the observed pattern holds forever, we count the exception.
   * Counts CALLS, not events. A Retell call is re-added on every webhook event and on
   * every 15-minute poll, so incrementing unconditionally would inflate the count by an
   * order of magnitude and make the tripwire useless as a signal. Only a call whose stored
   * record did not already carry a transfer reason counts.
   *
   * @param {{source?: string, disconnection_reason?: string}} call the incoming record
   * @param {{disconnection_reason?: string}} [existing] the record already in the store
   */
  noteTransferDisconnect(call, existing) {
    if (!call || call.source !== 'retell') return;
    const reason = call.disconnection_reason;
    if (!callTwins.isTransferDisconnect(reason)) return;
    if (callTwins.isTransferDisconnect(existing && existing.disconnection_reason)) return;

    this.stats.transferDisconnects = (this.stats.transferDisconnects || 0) + 1;
    if (!this.warnedTransferReasons.has(reason)) {
      this.warnedTransferReasons.add(reason);
      console.warn(
        `[callTwins] TRIPWIRE: Retell disconnection_reason '${reason}' means the AI ` +
        `transferred this call to a human. Its Mango leg holds the human half of the ` +
        `conversation and is NOT a duplicate — it stays in the worklist. ` +
        `(transferDisconnects=${this.stats.transferDisconnects}) ` +
        `If this keeps firing, reopen the transferred-leg design.`
      );
    }
  }

  /**
   * Link one call to its twin on the other source, writing `linked_call_id` / `link_role`
   * onto BOTH rows. Idempotent: re-running over already-linked rows is a no-op, which is
   * what lets it be called on every ingest and on the whole backlog alike.
   *
   * Candidate lookup goes through byCallerKey, so this is a Set hit plus a handful of
   * comparisons rather than a scan of the store.
   *
   * @param {object} call either leg
   * @returns {boolean} true when a NEW link was written
   */
  linkTwinFor(call) {
    if (!call || (call.source !== 'mango' && call.source !== 'retell')) return false;
    // A stub has no caller number to correlate on and its pairing was already
    // settled before it was pruned. The startup backlog pass runs over the whole
    // store, so this is the guard that keeps it off pruned rows.
    if (retention.isStub(call)) return false;

    const key = callTwins.callerKey(call.caller_number);
    if (!key) return false;

    const candidateIds = this.byCallerKey.get(key);
    if (!candidateIds) return false;

    const bySource = { mango: [], retell: [] };
    for (const id of candidateIds) {
      const candidate = this.calls.get(id);
      if (candidate && bySource[candidate.source]) bySource[candidate.source].push(candidate);
    }
    if (!bySource.mango.length || !bySource.retell.length) return false;

    // ALWAYS resolve from the Mango side, whichever leg we were handed. Resolving from the
    // Retell side would only ever count competing MANGO rows, so a second Retell row with
    // the same timings would quietly steal an existing link instead of being caught as the
    // ambiguity it is. Every twin has exactly one Mango leg, so this is also the direction
    // that visits each pair once.
    const mangoLegs = call.source === 'mango' ? [call] : bySource.mango;

    let linked = false;
    for (const mangoLeg of mangoLegs) {
      const { twin, ambiguous } = callTwins.findTwin(mangoLeg, bySource.retell);

      if (ambiguous) {
        // We no longer know which Retell row this leg belongs to. Drop any link we wrote
        // earlier rather than leaving a confident-looking one we can't stand behind — a
        // wrongly linked leg is a HIDDEN leg.
        if (mangoLeg.linked_call_id) this.unlinkTwin(mangoLeg);
        this.reportAmbiguousTwin(mangoLeg);
        continue;
      }
      if (!twin) continue;

      const role = callTwins.mangoLegRole(twin);
      const alreadyLinked =
        mangoLeg.linked_call_id === twin.id &&
        twin.linked_call_id === mangoLeg.id &&
        mangoLeg.link_role === role &&
        twin.link_role === callTwins.ROLE_PRIMARY;
      if (alreadyLinked) continue;

      mangoLeg.linked_call_id = twin.id;
      mangoLeg.link_role = role;
      twin.linked_call_id = mangoLeg.id;
      twin.link_role = callTwins.ROLE_PRIMARY;

      this.isDirty = true;
      this.requestPersist();
      linked = true;
    }

    return linked;
  }

  /**
   * Clear a link from both sides. Used when a leg that was linked stops having exactly one
   * defensible twin — see the ambiguity branch of linkTwinFor().
   * @param {{linked_call_id?: string|null}} call
   */
  unlinkTwin(call) {
    const other = call.linked_call_id ? this.calls.get(call.linked_call_id) : null;
    if (other && other.linked_call_id === call.id) {
      other.linked_call_id = null;
      other.link_role = null;
    }
    call.linked_call_id = null;
    call.link_role = null;
    this.isDirty = true;
    this.requestPersist();
  }

  /**
   * Two candidates satisfied the twin rule for one leg. Link NOTHING — hiding the wrong
   * row is worse than hiding none — and say so once per call.
   * @param {{id: string}} call
   * @returns {false}
   */
  reportAmbiguousTwin(call) {
    if (!this.warnedAmbiguousTwins.has(call.id)) {
      this.warnedAmbiguousTwins.add(call.id);
      console.warn(
        `[callTwins] Ambiguous twin for call ${call.id} — more than one candidate matched ` +
        `the correlation rule, so nothing was linked. This has never fired on production ` +
        `data; if it does, tighten END_SKEW_SECONDS in services/callTwins.js.`
      );
    }
    return false;
  }

  /**
   * Link the whole store — the backlog pass.
   *
   * Runs once at startup, after the store is loaded from disk, so the twins that already
   * exist (67 of them on prod at the time this shipped, every one still sitting unworked
   * in "Needs attention") get linked without waiting for a re-ingest that may never come:
   * the Mango watermark only re-walks a short overlap, and a Retell call is re-added only
   * while the 15-minute poller still has it in its window.
   *
   * @returns {{linked: number, duplicates: number, transferred: number}}
   */
  relinkAllTwins() {
    let linked = 0;
    // Drive from the Mango side: every twin has exactly one Mango leg, so this visits each
    // pair once instead of twice.
    for (const call of this.calls.values()) {
      if (call.source !== 'mango') continue;
      if (this.linkTwinFor(call)) linked++;
    }

    let duplicates = 0;
    let transferred = 0;
    for (const call of this.calls.values()) {
      if (call.link_role === callTwins.ROLE_DUPLICATE) duplicates++;
      else if (call.link_role === callTwins.ROLE_TRANSFERRED) transferred++;
    }

    return { linked, duplicates, transferred };
  }

  /**
   * Get a call by ID
   */
  getCall(id) {
    return this.calls.get(id);
  }

  /**
   * Find a stored call by its source external_id (e.g. Mango 'mango_call_<id>').
   * Linear scan over the store (call counts are in the low thousands). Used by the
   * api-ingest dedup guard to REUSE an existing transcript/summary instead of re-sending
   * the same recording to Azure Speech (or re-billing the summarizer) on every poll —
   * the root fix for the re-transcription loop (cost-investigation #2/#4).
   * @param {string} externalId
   * @returns {object|undefined}
   */
  findByExternalId(externalId) {
    if (!externalId) return undefined;
    for (const call of this.calls.values()) {
      if (call.external_id === externalId) return call;
    }
    return undefined;
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

    // A pruned call is read-only. Every worklist mutation funnels through here
    // (triage, disposition, notes, OD sync state), so one guard closes all of
    // them — and writing a triage decision onto a record whose content is gone
    // would be recording a judgement about something nobody can look at.
    if (retention.isStub(call)) {
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
   * Set (or clear) a call's disposition, with attribution.
   *
   * The three fields move TOGETHER — `null` clears all three — so the store can
   * never hold "dispositioned by nobody at no time", and clearing a disposition
   * leaves no stale attribution behind for the UI to render.
   *
   * @param {string} id
   * @param {string|null} disposition one of DISPOSITIONS, or null to clear
   * @param {{ name: string|null, email: string|null }|null} actor
   * @returns {object|null} the updated call, or null if the call is unknown
   */
  setDisposition(id, disposition, actor) {
    if (!this.calls.has(id)) return null;
    return this.updateCall(id, disposition
      ? { disposition, disposition_by: normalizeActor(actor), disposition_at: new Date().toISOString() }
      : { disposition: null, disposition_by: null, disposition_at: null });
  }

  /**
   * Append one note to a call. Append-only: existing notes are never rewritten.
   *
   * The read-modify-write is deliberately SYNCHRONOUS with no await between the
   * read and the write, so two requests landing in the same tick cannot each
   * build their new array from the same pre-existing one and drop a note.
   *
   * @param {string} id
   * @param {string} text validated + trimmed by the caller
   * @param {{ name: string|null, email: string|null }|null} author
   * @returns {{ call: object, note: import('../utils/callDispositions').CallNote }|null}
   */
  addNote(id, text, author) {
    const call = this.calls.get(id);
    if (!call) return null;
    const note = makeNote(text, author);
    const updated = this.updateCall(id, { notes: [...normalizeNotes(call.notes), note] });
    // A refused write (today: the call is a pruned stub) must not hand back a note
    // that was never stored — the route would answer 201 with a note nobody can
    // read back, which is exactly the "a success we cannot show again is a lie"
    // failure the on-demand transcription path was built to avoid.
    if (!updated) return null;
    return { call: updated, note };
  }

  /**
   * Remove one note by id. WHO may do that is decided by the route (author or
   * admin) — this is only the mechanism.
   *
   * @param {string} id
   * @param {string} noteId
   * @returns {object|null} the updated call, or null if call/note is unknown
   */
  removeNote(id, noteId) {
    const call = this.calls.get(id);
    if (!call) return null;
    const notes = normalizeNotes(call.notes);
    const remaining = notes.filter((n) => n.id !== noteId);
    if (remaining.length === notes.length) return null;
    return this.updateCall(id, { notes: remaining });
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
    
    // Retention split. `totalCalls` still means "records the store holds", so the
    // number stays comparable across the cutover; `prunedCalls` is what makes the
    // difference legible instead of looking like calls went missing.
    const prunedCalls = allCalls.filter(retention.isStub).length;

    return {
      totalCalls: this.calls.size,
      prunedCalls,
      liveCalls: this.calls.size - prunedCalls,
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
      // M7. `transferDisconnects` is the tripwire — see noteTransferDisconnect(). While it
      // reads 0, every linked Mango leg is a pure duplicate of an AI-completed call, which
      // is the premise the hide-from-worklist behaviour rests on.
      twins: {
        duplicateLegs: allCalls.filter(c => c.link_role === callTwins.ROLE_DUPLICATE).length,
        transferredLegs: allCalls.filter(c => c.link_role === callTwins.ROLE_TRANSFERRED).length,
        transferDisconnects: this.stats.transferDisconnects || 0,
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
          const startedAt = Date.now();
          const snapshot = JSON.stringify(
            {
              calls: Array.from(this.calls.values()),
              stats: this.stats,
              purgedIds: Array.from(this.purgedIds),
              savedAt: new Date().toISOString(),
            },
            null,
            2,
          );
          await fs.writeFile(this.tempPath, snapshot);
          await fs.rename(this.tempPath, this.persistPath);
          // Structured + greppable, because this line is the measurement the
          // retention slice exists to move. persist() serializes the WHOLE store
          // synchronously onto an AzureFile mount, and its duration is the prime
          // suspect behind the chronic >5s readiness-probe timeouts. Without a
          // number here, "the store is smaller now" is a claim, not evidence.
          // Structured and greppable, because this line is the measurement the
          // retention slice exists to move. The prod runbook parses ms= and
          // bytes= out of Log Analytics to compare before and after the purge —
          // renaming this prefix silently breaks that comparison.
          console.log(
            `[callstore] persist ok calls=${this.calls.size} ` +
            `bytes=${Buffer.byteLength(snapshot)} ms=${Date.now() - startedAt}`
          );
          // Loop again only if another write came in during this iteration.
        } while (this.persistRequeued || this.isDirty);
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
    this.byCallerKey.clear();
    this.warnedTransferReasons.clear();
    this.warnedAmbiguousTwins.clear();
    this.purgedIds.clear();
    this.stats = {
      totalRetell: 0,
      totalMango: 0,
      lastRetellSync: null,
      lastMangoSync: null,
      transferDisconnects: 0,
    };
    this.isDirty = true;
  }
}

// Export singleton instance
const unifiedCallStore = new UnifiedCallStore();
module.exports = unifiedCallStore;

