/**
 * Unified Calls API Route
 * 
 * Provides endpoints to query calls from all sources (Retell AI + Mango Voice staff calls)
 * with unified filtering, sorting, and pagination.
 */

const express = require('express');
const router = express.Router();
const unifiedCallStore = require('../services/unifiedCallStore');
const retellService = require('../config/retell');
const openDentalSync = require('../services/openDentalSync');
const audit = require('../platform/audit');
const { filterCallsForOffice, getOfficeConfig, getAllOfficeConfigs } = require('../config/officeAgents');

// --- Slice B: triage worklist + patient review queue -----------------------

/** Allowed triage_status values (see Slice B PRD §1). */
const TRIAGE_STATUSES = new Set(['new', 'needs_action', 'done']);
/** Allowed triage_outcome values — required when triage_status === 'done'. */
const TRIAGE_OUTCOMES = new Set([
  'called_back', 'scheduled', 'left_voicemail', 'no_answer', 'no_action_needed',
]);
/** Allowed not_a_patient reasons (review-queue close-out without an OD write). */
const NOT_A_PATIENT_REASONS = new Set(['spam', 'solicitor', 'wrong_number', 'other']);

/** Max length for the optional free-text triage note. */
const TRIAGE_NOTE_MAX = 280;

/**
 * The acting user, from the SSO session attached by the auth middleware. Used
 * for per-action attribution on triage/resolve. Returns null in the (dev-only)
 * case where no session user is present.
 * @param {import('express').Request} req
 * @returns {{ name: string|null, email: string|null } | null}
 */
const actorFrom = (req) =>
  req.user ? { name: req.user.name ?? null, email: req.user.email ?? null } : null;

// --- Caller Name Extraction Utilities (copied from calls.js) ---

/**
 * Convert transcript_json (array of {role, content} objects) to plain text transcript
 */
const transcriptJsonToText = (transcriptJson) => {
  if (!transcriptJson || !Array.isArray(transcriptJson)) return '';
  return transcriptJson
    .map(entry => `${entry.role || 'unknown'}: ${entry.content || ''}`)
    .join(' ');
};

/**
 * Basic regex-based name extraction from transcript
 */
const extractCallerNameBasic = (transcript, callerNumber) => {
  // Guard against a non-string transcript (Retell transcript_object array) before `.match()`.
  if (!transcript || typeof transcript !== 'string') return callerNumber;

  const agentNames = ['karen', 'assistant', 'agent', 'bot', 'ai', 'system', 'operator'];

  const callerPatterns = [
    /(?:user|caller):\s*.*?(?:my name is|i'm|this is|i am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?:user|caller):\s*.*?(?:call me|it's|name's)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?:user|caller):\s*(?:hi|hello),?\s*(?:my name is|i'm|this is)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?<!agent:.*?)(?:my name is|i'm|this is|i am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?:user|caller):\s*(?:hi|hello),?\s*([a-zA-Z]+(?:\s+[a-zA-Z]+)?)\s+(?:here|speaking|calling)/i,
    /(?:user|caller):\s*(?:this is|it's)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i
  ];

  for (const pattern of callerPatterns) {
    const match = transcript.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim().toLowerCase();
      const commonWords = ['okay', 'yes', 'no', 'sure', 'well', 'um', 'uh', 'the', 'that', 'this', 'here', 'calling'];
      if (name.length > 1 &&
          !commonWords.includes(name) &&
          !agentNames.includes(name)) {
        return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
      }
    }
  }

  return callerNumber;
};

/**
 * Extract name from call summary
 */
const extractNameFromSummary = (summary) => {
  if (!summary) return null;

  const summaryPatterns = [
    /(?:patient|caller),\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})(?:,|\s+(?:called|requested|asked|provided|said)\b)/,
    /(?:patient|caller)\s+named\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\b/,
    /Mr\.?\s+([A-Z][a-zA-Z]+)/i,
    /Mrs\.?\s+([A-Z][a-zA-Z]+)/i,
    /Ms\.?\s+([A-Z][a-zA-Z]+)/i,
    /([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\s+(?:called|requested|asked|provided)\b/,
    /([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\s+is\s+(?:calling|requesting|asking)\b/
  ];

  for (const pattern of summaryPatterns) {
    const match = summary.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      const commonWords = ['Patient', 'Caller', 'Person', 'User', 'Someone', 'Individual', 'The Caller', 'The Patient'];
      if (!commonWords.includes(name) && !/\b(reached|provided|requested|called|assistant|office|appointment|number)\b/i.test(name)) {
        return name;
      }
    }
  }

  return null;
};

/**
 * Advanced name extraction using context analysis
 */
const extractNameAdvanced = (transcript, summary) => {
  if (!transcript && !summary) return null;

  const fullText = `${transcript || ''} ${summary || ''}`;

  const advancedPatterns = [
    /(?:agent|assistant):\s*.*?(?:thank you|hello|hi),?\s+([A-Z][a-zA-Z]+)/i,
    /(?:agent|assistant):\s*.*?I(?:'ll|'d)\s+(?:be happy to\s+)?help\s+you,?\s+([A-Z][a-zA-Z]+)/i,
    /(?:appointment|booking|schedule).*?for\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    /(?:prescription|medication|refill).*for\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    /(?:patient|caller),\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*(?:,|\s+(?:needs|wants|requires|is)\b)/
  ];

  for (const pattern of advancedPatterns) {
    const match = fullText.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      if (name.length > 1 && !/^\d/.test(name)) {
        return name;
      }
    }
  }

  return null;
};

/**
 * Apply caller name extraction to a single call object.
 * Mutates and returns the call.
 */
const enrichCallerName = (call) => {
  if (call.caller_name && call.caller_name !== 'Unknown' && call.caller_name !== call.caller_number) {
    return call;
  }

  // Build a text transcript from transcript_json if transcript is missing
  let transcript = call.transcript || '';
  if (!transcript && call.transcript_json) {
    transcript = transcriptJsonToText(call.transcript_json);
  }

  const summary = call.summary || call.call_summary || '';

  // Try summary first
  const fromSummary = extractNameFromSummary(summary);
  if (fromSummary) {
    call.caller_name = fromSummary;
    return call;
  }

  // Try basic transcript extraction
  const fromTranscript = extractCallerNameBasic(transcript, call.caller_number || 'Unknown');
  if (fromTranscript !== call.caller_number && fromTranscript !== 'Unknown') {
    call.caller_name = fromTranscript;
    return call;
  }

  // Try advanced extraction
  const fromAdvanced = extractNameAdvanced(transcript, summary);
  if (fromAdvanced) {
    call.caller_name = fromAdvanced;
    return call;
  }

  return call;
};

// --- End Caller Name Extraction Utilities ---

/**
 * GET /api/unified-calls
 * Get all calls with optional filters
 * 
 * Query params:
 * - source: 'retell' | 'mango' | 'all' (default: 'all')
 * - handler_type: 'ai' | 'staff' | 'all' (default: 'all')
 * - start_date: ISO date string
 * - end_date: ISO date string
 * - sentiment: 'positive' | 'neutral' | 'negative'
 * - limit: number (default: 50)
 * - offset: number (default: 0)
 * - sort_by: field name (default: 'call_date')
 * - sort_order: 'asc' | 'desc' (default: 'desc')
 * - office_id: string (for office-specific filtering)
 */
router.get('/', async (req, res) => {
  try {
    const {
      source,
      handler_type,
      start_date,
      end_date,
      sentiment,
      outcome,
      is_emergency,
      callback_required,
      limit = 50,
      offset = 0,
      sort_by = 'call_date',
      sort_order = 'desc',
      office_id,
      search,
    } = req.query;

    // Build filter options
    const options = {
      limit: parseInt(limit),
      offset: parseInt(offset),
      sortBy: sort_by,
      sortOrder: sort_order,
    };

    // Add source filter
    if (source && source !== 'all') {
      options.source = source;
    }

    // Add handler type filter
    if (handler_type && handler_type !== 'all') {
      options.handlerType = handler_type;
    }

    // Add date filters
    if (start_date) {
      options.startDate = start_date;
    }
    if (end_date) {
      options.endDate = end_date;
    }

    // Add other filters
    if (sentiment) {
      options.sentiment = sentiment;
    }
    if (outcome) {
      options.outcome = outcome;
    }
    if (is_emergency !== undefined) {
      options.isEmergency = is_emergency === 'true';
    }
    if (callback_required !== undefined) {
      options.callbackRequired = callback_required === 'true';
    }

    // Get calls from unified store
    let result = unifiedCallStore.getCalls(options);

    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      result.calls = result.calls.filter(call =>
        call.caller_name?.toLowerCase().includes(searchLower) ||
        call.caller_number?.includes(search) ||
        call.summary?.toLowerCase().includes(searchLower) ||
        call.transcript?.toLowerCase().includes(searchLower)
      );
      result.total = result.calls.length;
    }

    // Apply caller name extraction to calls missing names
    result.calls = result.calls.map(enrichCallerName);

    // Apply office filtering if provided
    if (office_id) {
      result.calls = filterCallsForOffice(result.calls, office_id);
      result.total = result.calls.length;
    }

    // Add store stats
    const stats = unifiedCallStore.getStats();

    // HIPAA audit: the list returns call records (caller names/transcripts = PHI).
    await audit.audit(req, { action: 'READ', resourceType: 'call', resourceId: null, result: 'SUCCESS' });

    res.json({
      calls: result.calls,
      total: result.total,
      pagination: result.pagination,
      stats: {
        bySource: stats.bySource,
        byHandler: stats.byHandler,
        lastSync: stats.lastSync,
      },
      // Full office roster for the worklist selector (includes odConnected so the
      // UI can render Valley's "OD not connected for this office yet" state).
      offices: getAllOfficeConfigs(),
      office_config: office_id ? getOfficeConfig(office_id) : null,
    });
  } catch (error) {
    console.error('Error fetching unified calls:', error);
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

/**
 * GET /api/unified-calls/stats
 * Get unified call statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = unifiedCallStore.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching call stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * GET /api/unified-calls/offices
 * The office roster for the global office selector (agent→office config, with
 * odConnected). Non-PHI config — no audit. Registered before /:id so "offices"
 * isn't captured as an id.
 */
router.get('/offices', (req, res) => {
  res.json({ offices: getAllOfficeConfigs() });
});

/**
 * GET /api/unified-calls/:id
 * Get a specific call by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const call = unifiedCallStore.getCall(id);

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // Apply caller name extraction if name is missing
    enrichCallerName(call);

    // HIPAA audit: this returns a full call record (transcript = PHI). Audited
    // before responding; a failed audit write fails closed (no PHI returned).
    await audit.audit(req, { action: 'READ', resourceType: 'call', resourceId: id, result: 'SUCCESS' });

    res.json(call);
  } catch (error) {
    console.error('Error fetching call:', error);
    res.status(500).json({ error: 'Failed to fetch call' });
  }
});

/**
 * GET /api/unified-calls/phone/:phoneNumber
 * Get all calls for a specific phone number
 */
router.get('/phone/:phoneNumber', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const calls = unifiedCallStore.getCallsByPhone(phoneNumber);

    // HIPAA audit: phone lookup returns patient call data. resource_id is null —
    // the phone number itself is PHI and must not be stored in the audit log.
    await audit.audit(req, { action: 'READ', resourceType: 'call', resourceId: null, result: 'SUCCESS' });

    res.json({
      phone: phoneNumber,
      calls: calls,
      total: calls.length,
    });
  } catch (error) {
    console.error('Error fetching calls by phone:', error);
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

/**
 * POST /api/unified-calls/sync-retell
 * Manually trigger a sync from Retell API
 */
router.post('/sync-retell', async (req, res) => {
  try {
    const { limit = 1000, start_time, end_time } = req.body;

    console.log('🔄 Starting manual Retell sync...');

    const params = { limit };
    if (start_time) params.start_time = start_time;
    if (end_time) params.end_time = end_time;

    const apiResponse = await retellService.getCalls(params);
    
    let addedCount = 0;
    for (const call of apiResponse) {
      const stored = unifiedCallStore.addRetellCall(call);
      if (stored) addedCount++;
    }

    await unifiedCallStore.persist();

    const stats = unifiedCallStore.getStats();

    res.json({
      success: true,
      message: `Synced ${addedCount} calls from Retell`,
      stats: stats,
    });
  } catch (error) {
    console.error('Error syncing from Retell:', error);
    res.status(500).json({ error: 'Failed to sync from Retell' });
  }
});

/**
 * PATCH /api/unified-calls/:id
 * Update a call (for manual corrections, patient matching, etc.)
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Only allow certain fields to be updated
    const allowedUpdates = [
      'caller_name',
      'patient_id',
      'patient_matched_by',
      'is_new_patient',
      'call_reason',
      'summary',
      'callback_required',
      'callback_reason',
      'qa_score',
    ];

    const filteredUpdates = {};
    for (const key of allowedUpdates) {
      if (updates[key] !== undefined) {
        filteredUpdates[key] = updates[key];
      }
    }

    const updatedCall = unifiedCallStore.updateCall(id, filteredUpdates);

    if (!updatedCall) {
      return res.status(404).json({ error: 'Call not found' });
    }

    res.json(updatedCall);
  } catch (error) {
    console.error('Error updating call:', error);
    res.status(500).json({ error: 'Failed to update call' });
  }
});

/**
 * PATCH /api/unified-calls/:id/triage
 *
 * Set the per-call triage state from the worklist. Validates the enums, stamps
 * the acting user + timestamp, and persists. This is workflow metadata (NOT a
 * PHI write) — the "not a patient" close-out and patient resolution live on
 * POST /resolve-patient instead.
 *
 * Body: { triage_status, triage_outcome?, triage_note? }
 *  - triage_status: 'new' | 'needs_action' | 'done'
 *  - triage_outcome: required iff triage_status === 'done'; one of
 *      called_back | scheduled | left_voicemail | no_answer | no_action_needed
 *  - triage_note: optional short free text (<= 280 chars)
 */
router.patch('/:id/triage', async (req, res) => {
  try {
    const { id } = req.params;
    const { triage_status, triage_outcome, triage_note } = req.body || {};

    if (!TRIAGE_STATUSES.has(triage_status)) {
      return res.status(400).json({
        error: `triage_status must be one of: ${[...TRIAGE_STATUSES].join(', ')}`,
      });
    }

    // Outcome is required for 'done' and not accepted otherwise (it is cleared
    // when moving a call back to new/needs_action).
    let outcome = null;
    if (triage_status === 'done') {
      if (!TRIAGE_OUTCOMES.has(triage_outcome)) {
        return res.status(400).json({
          error: `triage_outcome is required when triage_status is 'done' and must be one of: ${[...TRIAGE_OUTCOMES].join(', ')}`,
        });
      }
      outcome = triage_outcome;
    } else if (triage_outcome !== undefined && triage_outcome !== null) {
      return res.status(400).json({
        error: "triage_outcome is only valid when triage_status is 'done'",
      });
    }

    let note = null;
    if (triage_note !== undefined && triage_note !== null) {
      if (typeof triage_note !== 'string') {
        return res.status(400).json({ error: 'triage_note must be a string' });
      }
      if (triage_note.length > TRIAGE_NOTE_MAX) {
        return res.status(400).json({ error: `triage_note must be <= ${TRIAGE_NOTE_MAX} characters` });
      }
      note = triage_note.trim() || null;
    }

    if (!unifiedCallStore.getCall(id)) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const updatedCall = unifiedCallStore.updateCall(id, {
      triage_status,
      triage_outcome: outcome,
      triage_note: note,
      triage_by: actorFrom(req),
      triage_at: new Date().toISOString(),
    });

    // Audit the workflow mutation (fail-closed, consistent with the read paths).
    await audit.audit(req, { action: 'UPDATE', resourceType: 'call', resourceId: id, result: 'SUCCESS' });

    res.json(updatedCall);
  } catch (error) {
    console.error('Error updating triage:', error);
    res.status(500).json({ error: 'Failed to update triage' });
  }
});

/**
 * POST /api/unified-calls/:id/resolve-patient
 *
 * The review-queue action. Two shapes:
 *
 *  A) { patientId }        — link the call to an OD patient and write the CareIN
 *                            inbound-call commlog via the SAME idempotent path
 *                            Slice A hardened (skips if already 'synced', so a
 *                            second resolve does NOT create a second commlog).
 *                            This is a user-initiated PHI write → audited CREATE.
 *
 *  B) { notAPatient: true, reason } — close the call out of the review pile with
 *                            no OD write (spam / solicitor / wrong number / other).
 *                            Audited UPDATE.
 *
 * Both stamp resolve attribution (resolved_by / resolved_at) from the session.
 */
router.post('/:id/resolve-patient', async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const actor = actorFrom(req);
    const nowIso = new Date().toISOString();

    const call = unifiedCallStore.getCall(id);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // ---- Shape B: "not a patient" close-out (no OD write) ------------------
    if (body.notAPatient === true) {
      if (!NOT_A_PATIENT_REASONS.has(body.reason)) {
        return res.status(400).json({
          error: `reason must be one of: ${[...NOT_A_PATIENT_REASONS].join(', ')}`,
        });
      }

      const updatedCall = unifiedCallStore.updateCall(id, {
        not_a_patient: true,
        not_a_patient_reason: body.reason,
        resolved_by: actor,
        resolved_at: nowIso,
      });

      await audit.audit(req, { action: 'UPDATE', resourceType: 'call', resourceId: id, result: 'SUCCESS' });

      return res.json({ success: true, notAPatient: true, call: updatedCall });
    }

    // ---- Shape A: resolve to an OD patient (idempotent PHI write) ----------
    const patientId = body.patientId;
    if (patientId === undefined || patientId === null || patientId === '') {
      return res.status(400).json({ error: 'patientId is required' });
    }

    // Idempotency guard: if this call is already synced, do not write a second
    // commlog. Return the existing linkage as a success no-op.
    if (call.od_sync_status === 'synced') {
      return res.json({
        success: true,
        alreadySynced: true,
        commLogNum: call.od_commlog_num ?? null,
        patientId: call.od_patient_id ?? null,
        call,
      });
    }

    // Link the call to the patient (validates the patient exists in OD). We pass
    // syncNow:false so we can drive the idempotent, NON-forced commlog write
    // ourselves — linkCallToPatient's own syncNow path forces the write and would
    // bypass the 'synced' dedup guard.
    const linkResult = await openDentalSync.linkCallToPatient(id, patientId, {
      syncNow: false,
      userId: actor?.email || 'system',
    });
    if (!linkResult.success) {
      const status = linkResult.error === 'Patient not found in Open Dental' ? 404 : 400;
      return res.status(status).json({ success: false, error: linkResult.error });
    }

    // Write the commlog via the hardened, non-forced path (skips if already synced).
    const syncResult = await openDentalSync.syncCallToCommLog(id, {});
    if (!syncResult.success) {
      return res.status(422).json({
        success: false,
        error: syncResult.error || 'CommLog write failed',
        requiresManualLink: syncResult.requiresManualLink || false,
      });
    }

    const updatedCall = unifiedCallStore.updateCall(id, {
      resolved_by: actor,
      resolved_at: nowIso,
    });

    // User-initiated PHI write (a commlog was created against a patient) → audit CREATE.
    await audit.audit(req, {
      action: 'CREATE',
      resourceType: 'commlog',
      resourceId: syncResult.commLogNum ?? id,
      result: 'SUCCESS',
    });

    res.json({
      success: true,
      commLogNum: syncResult.commLogNum ?? null,
      patientId: updatedCall.od_patient_id ?? patientId,
      call: updatedCall,
    });
  } catch (error) {
    console.error('Error resolving patient:', error);
    res.status(500).json({ error: 'Failed to resolve patient' });
  }
});

module.exports = router;

