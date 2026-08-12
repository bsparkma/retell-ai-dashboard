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
const { sanitizeForOd } = require('../utils/sanitizeForOd');
const audit = require('../platform/audit');
const syncScheduler = require('../services/syncScheduler');
const manualSyncThrottle = require('../services/manualSyncThrottle');
const { filterCallsForOffice, getOfficeForCall, getOfficeConfig, getAllOfficeConfigs } = require('../config/officeAgents');
const odOffices = require('../config/odOffices');
const mangoConfig = require('../config/mango');
const { isEntitledModule } = require('../middleware/tenantContext');
const { requirePermission } = require('../config/permissions');
const tcCaseClient = require('../services/tcCaseClient');

/**
 * Per-route permission gates (Roles PR A).
 *
 * The mount in server.js already applies voice.read to GETs and voice.write to
 * mutations. These NARROW that for the three things a worklist mutation is not:
 * spending money, writing to a patient's chart, and handing a case to another
 * module. Naming them here keeps the action next to the route it guards while
 * the role lists stay in the one map (backend/config/permissions.js).
 */
const canSync = requirePermission('voice.sync');
const canChartWrite = requirePermission('voice.chart_write');
const canSendToTc = requirePermission('voice.send_to_tc');

/**
 * The office roster for the UI, with EFFECTIVE Open Dental connectivity.
 *
 * officeAgents owns the intent flag (odConnected — the reversible switch); this
 * layer ANDs it with "are that office's credentials actually present". An office
 * switched on without its customer key therefore still renders as disconnected
 * rather than appearing live and failing at the moment someone clicks Send.
 * @returns {Array<{officeId: string, officeName: string, odConnected: boolean, odBlockedReason: string|null}>}
 */
const officeRoster = () =>
  getAllOfficeConfigs().map((o) => odOffices.describeOffice(o.officeId));

// --- Slice B: triage worklist + patient review queue -----------------------

/** Allowed triage_status values (see Slice B PRD §1). */
const TRIAGE_STATUSES = new Set(['new', 'needs_action', 'done']);
/** Allowed triage_outcome values — required when triage_status === 'done'. */
const TRIAGE_OUTCOMES = new Set([
  'called_back', 'scheduled', 'left_voicemail', 'no_answer', 'no_action_needed',
]);
/** Allowed not_a_patient reasons (review-queue close-out without an OD write). */
const NOT_A_PATIENT_REASONS = new Set(['spam', 'solicitor', 'vendor', 'lab', 'wrong_number', 'other']);

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

    // Stamp each call with its server-resolved office so the UI can (a) trust one
    // source of truth for office attribution and (b) render the "Unmapped line"
    // affordance for office_id === 'unknown' (using the call's called_number).
    result.calls = result.calls.map((c) => ({ ...c, office_id: getOfficeForCall(c) }));

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
      // Full office roster for the worklist selector, with EFFECTIVE odConnected so
      // the UI renders the honest "OD not connected for this office yet" state.
      offices: officeRoster(),
      office_config: office_id ? odOffices.describeOffice(office_id) : null,
      // PRD D1: tells the worklist whether ALL Mango calls demand attention ('all') or
      // only flagged ones ('flagged'). Backend-owned config so a flip is an env change.
      mango_worklist_mode: mangoConfig.worklistMode,
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

// --- Sync now: one button, both sources ------------------------------------
//
// The worklist used to offer a Retell-only "Sync" that reported a generic "Sync
// complete", so a staff-answered Mango call sat invisible until the hourly :15 cron.
// These two routes replace that: one pull of BOTH sources with per-source outcomes,
// plus a cheap status read the caption polls.

/**
 * Turn a syncScheduler.runSync() return value into the honest per-source state the UI
 * renders. The scheduler swallows its own errors and hands back a history entry, so a
 * failed run has to be recognized by `status`, not by a thrown exception.
 * @param {object} result
 * @returns {{status: 'ok'|'off'|'already_running'|'error', found?: number, imported?: number, message?: string}}
 */
function describeMangoResult(result) {
  if (!result) return { status: 'error', message: 'Mango sync returned nothing' };

  // Declined to run. "Ingestion is off" and "the autosync already has it" are answers,
  // not failures — reporting them as errors is what made the old button untrustworthy.
  // Anything else that declined IS a failure, including a refusal with no code: an
  // unrecognized shape must never fall through and be counted as a successful zero-call
  // sync.
  if (result.success === false) {
    if (result.code === syncScheduler.SYNC_SKIP_RUNNING) return { status: 'already_running' };
    if (result.code === syncScheduler.SYNC_SKIP_OFF || result.code === syncScheduler.SYNC_SKIP_DISABLED) {
      return { status: 'off' };
    }
    return { status: 'error', message: result.message || 'Mango sync declined to run' };
  }

  if (result.status === 'failed') {
    return { status: 'error', message: (result.errors && result.errors[0]) || 'Mango sync failed' };
  }

  return {
    status: 'ok',
    found: result.calls_found ?? 0,
    imported: result.calls_imported ?? 0,
  };
}

/**
 * POST /api/unified-calls/sync-now
 *
 * Pull Retell AND Mango, right now, because somebody pressed the button. Both run
 * concurrently and are reported separately: a source that is switched off or already
 * mid-run is NOT an error, and one source failing never hides the other's success.
 * 502 is reserved for the case where BOTH sources failed — the only outcome in which
 * pressing the button accomplished nothing at all.
 *
 * Throttled to one run per minute per process (429 + retryAfter), so a button-mash
 * costs one sync and a polite wait rather than N overlapping API walks.
 */
router.post('/sync-now', canSync, async (req, res) => {
  const claim = manualSyncThrottle.begin();
  if (!claim.allowed) {
    res.set('Retry-After', String(claim.retryAfter));
    return res.status(429).json({
      code: 'SYNC_COOLDOWN',
      error: 'A sync just ran — give it a moment',
      retryAfter: claim.retryAfter,
      lastSyncedAt: syncScheduler.getLastSyncedAt(),
    });
  }

  // `actor` is who to credit in the sync history. 'api-token' covers the bearer-token
  // path, where there is no SSO session and therefore no email.
  const actor = req.user?.email ?? 'api-token';

  try {
    const [retellSettled, mangoSettled] = await Promise.allSettled([
      syncScheduler.runRetellSync({ limit: 1000 }),
      syncScheduler.runSync({ trigger: 'manual', actor }),
    ]);

    // runRetellSync DOES throw on failure (deliberately — see its comment), so it is the
    // one source whose rejection has to be unwrapped.
    const retell = retellSettled.status === 'fulfilled'
      ? { status: 'ok', added: retellSettled.value?.added ?? 0, fetched: retellSettled.value?.fetched ?? 0 }
      : { status: 'error', message: retellSettled.reason?.message ?? 'Retell sync failed' };

    const mango = mangoSettled.status === 'fulfilled'
      ? describeMangoResult(mangoSettled.value)
      : { status: 'error', message: mangoSettled.reason?.message ?? 'Mango sync failed' };

    const body = {
      retell,
      mango,
      lastSyncedAt: syncScheduler.getLastSyncedAt(),
      nextAutoSync: syncScheduler.getNextAutoSync(),
    };

    // Append-only trail for an operator-initiated data pull. `action` is CHECK-constrained
    // to the four CRUD verbs, and there is no detail column, so the verb lives in
    // resource_type and the per-source outcome in resource_id — counts and status words,
    // never PHI.
    await audit.audit(req, {
      action: 'UPDATE',
      resourceType: 'voice.sync.manual',
      resourceId:
        `retell=${retell.status}${retell.status === 'ok' ? `:${retell.added}` : ''};` +
        `mango=${mango.status}${mango.status === 'ok' ? `:${mango.imported}` : ''}`,
      result: retell.status === 'error' && mango.status === 'error' ? 'ERROR' : 'SUCCESS',
    });

    // Both dead → the button did nothing, and it must not claim otherwise.
    const bothFailed = retell.status === 'error' && mango.status === 'error';
    return res.status(bothFailed ? 502 : 200).json(body);
  } catch (error) {
    console.error('Error running manual sync:', error);
    return res.status(500).json({ error: 'Sync failed', code: 'SYNC_FAILED' });
  } finally {
    // Starts the cooldown and clears the in-flight claim — in `finally` so a thrown
    // audit write can't wedge the button until the next deploy.
    manualSyncThrottle.end();
  }
});

/**
 * GET /api/unified-calls/sync-status
 *
 * The freshness caption's data source: when the list last got fresh calls, when the next
 * automatic pull lands, and whether Mango ingestion is on in this environment. No PHI, so
 * no audit — and deliberately NOT /api/admin/sync-status, which is heading behind a role
 * gate that the front desk will not have. Registered before /:id so "sync-status" isn't
 * captured as a call id.
 */
router.get('/sync-status', (req, res) => {
  try {
    res.json({
      lastSyncedAt: syncScheduler.getLastSyncedAt(),
      nextAutoSync: syncScheduler.getNextAutoSync(),
      mangoMode: syncScheduler.getMangoMode(),
    });
  } catch (error) {
    console.error('Error reading sync status:', error);
    res.status(500).json({ error: 'Failed to read sync status' });
  }
});

/**
 * GET /api/unified-calls/offices
 * The office roster for the global office selector (agent→office config, with
 * odConnected). Non-PHI config — no audit. Registered before /:id so "offices"
 * isn't captured as an id.
 */
router.get('/offices', (req, res) => {
  res.json({ offices: officeRoster() });
});

/**
 * GET /api/unified-calls/:id/patient-search?q=
 *
 * The Pick Patient modal's Open Dental search, scoped to the office of THE CALL
 * BEING RESOLVED. Deliberately call-scoped rather than a bare
 * /opendental/patients/search?office_id=… : the office is derived server-side
 * from the call, so no request can search one practice while resolving a call
 * that belongs to another. The response names the office so the modal can show
 * the operator which patient list they are looking at.
 *
 * Returns patient records (PHI) → audited READ.
 */
router.get('/:id/patient-search', async (req, res) => {
  try {
    const { id } = req.params;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const call = unifiedCallStore.getCall(id);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const officeKey = getOfficeForCall(call);
    const office = odOffices.describeOffice(officeKey);

    // Unknown / not-connected / unkeyed office: no search, no guessing.
    let od;
    try {
      od = odOffices.assertOfficeMatch(officeKey, odOffices.getOdOffice(officeKey));
    } catch (err) {
      return res.status(odOffices.httpStatusFor(err)).json({
        error: err.publicMessage || 'Open Dental is not available for this office',
        code: err.code,
        office,
        patients: [],
      });
    }

    if (q.length < 2) {
      return res.json({ patients: [], office });
    }

    const patients = await od.client.searchPatients(q);

    await audit.audit(req, {
      action: 'READ',
      resourceType: 'patient',
      // The query is PHI — never store it. The office IS recorded, so the trail
      // shows which practice's records were searched.
      resourceId: null,
      office: officeKey,
      result: 'SUCCESS',
    });

    res.json({ patients: patients || [], office });
  } catch (error) {
    console.error('Error searching patients for call:', error);
    res.status(500).json({ error: 'Failed to search patients' });
  }
});

/**
 * GET /api/unified-calls/:id/commlog-preview
 *
 * Returns the EXACT chart note that "Send to chart" will write, so the confirm
 * dialog shows a faithful preview. Built with the same formatter + options the
 * send path uses (openDentalSync.syncCallToCommLog → formatCommLogEntry, no
 * transcript). The note is call-derived PHI → audited READ. Registered before
 * /:id so "commlog-preview" isn't captured as an id (distinct path depth anyway).
 */
router.get('/:id/commlog-preview', async (req, res) => {
  try {
    const { id } = req.params;
    const call = unifiedCallStore.getCall(id);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    // content_type (item 4): 'summary' (default, compact block) | 'transcript' (full note).
    const contentType = req.query.content_type === 'transcript' ? 'transcript' : 'summary';
    const entry = openDentalSync.formatCommLogEntry(call, { contentType });
    const officeKey = getOfficeForCall(call);
    await audit.audit(req, {
      action: 'READ', resourceType: 'call', resourceId: id, office: officeKey, result: 'SUCCESS',
    });
    res.json({
      note: entry.Note,
      patientId: call.od_patient_id ?? null,
      patientName: call.od_patient_name ?? null,
      // Which chart this note is about to land in — shown in the confirm dialog so
      // the operator sees the practice, not just the patient, before sending.
      office: odOffices.describeOffice(officeKey),
    });
  } catch (error) {
    console.error('Error building commlog preview:', error);
    res.status(500).json({ error: 'Failed to build commlog preview' });
  }
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

    // Stamp the server-resolved office, same as the list endpoint does. Call detail
    // renders the same OD actions as the worklist, so it needs the same office truth
    // to gate them — without this a valley call opened directly would look Roland-ish.
    const officeKey = getOfficeForCall(call);

    // HIPAA audit: this returns a full call record (transcript = PHI). Audited
    // before responding; a failed audit write fails closed (no PHI returned).
    await audit.audit(req, {
      action: 'READ', resourceType: 'call', resourceId: id, office: officeKey, result: 'SUCCESS',
    });

    res.json({ ...call, office_id: officeKey, office: odOffices.describeOffice(officeKey) });
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
 * Manually trigger a sync from Retell API.
 *
 * @deprecated Superseded by POST /sync-now, which pulls Retell AND Mango and reports
 * each honestly. Kept working this release so anything still calling it (scripts, an
 * older cached bundle) doesn't break; remove once nothing does.
 */
router.post('/sync-retell', canSync, async (req, res) => {
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
router.post('/:id/resolve-patient', canChartWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const actor = actorFrom(req);
    const nowIso = new Date().toISOString();

    const call = unifiedCallStore.getCall(id);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // The office of THIS call, resolved server-side. Everything below that touches
    // Open Dental is bound to it.
    const officeKey = getOfficeForCall(call);

    // Cross-office guard. `office_id` in the body is the client saying which office
    // it BELIEVES it is acting on. It can only ever cause a refusal — it never
    // selects the target — so a request naming the wrong office is rejected rather
    // than obeyed. (This is the "valley call + roland office param" case.)
    if (typeof body.office_id === 'string' && body.office_id && body.office_id !== officeKey) {
      console.error(
        `[unifiedCalls] BLOCKED cross-office resolve on call ${id}: client claimed ` +
        `office '${body.office_id}' but the call belongs to '${officeKey}'`
      );
      await audit.audit(req, {
        action: 'UPDATE', resourceType: 'call', resourceId: id, office: officeKey, result: 'UNAUTHORIZED',
      });
      return res.status(409).json({
        success: false,
        error: 'This call belongs to a different office — refusing to touch that chart',
        code: 'OFFICE_MISMATCH',
        office: odOffices.describeOffice(officeKey),
      });
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

      await audit.audit(req, {
        action: 'UPDATE', resourceType: 'call', resourceId: id, office: officeKey, result: 'SUCCESS',
      });

      return res.json({ success: true, notAPatient: true, call: updatedCall });
    }

    // ---- Shape A: resolve to an OD patient (idempotent PHI write) ----------
    const patientId = body.patientId;
    if (patientId === undefined || patientId === null || patientId === '') {
      return res.status(400).json({ error: 'patientId is required' });
    }

    // Server-side OD lockout. The worklist already hides these actions for an
    // unmapped/unconnected office, but the UI is not the control — an 'unknown'
    // call must be unable to reach a chart even by a hand-rolled request.
    const blocked = odOffices.odBlockReason(officeKey);
    if (blocked) {
      await audit.audit(req, {
        action: 'CREATE', resourceType: 'commlog', resourceId: id, office: officeKey, result: 'UNAUTHORIZED',
      });
      return res.status(odOffices.httpStatusFor({ code: blocked.code })).json({
        success: false,
        error: blocked.message,
        code: blocked.code,
        office: odOffices.describeOffice(officeKey),
      });
    }

    // ---- Shape C: LINK ONLY — establish the match, write nothing to the chart --
    //
    // Identifying who called and filing a note about it are two different
    // decisions, and they were welded together: the only way to set od_patient_id
    // was to write a commlog in the same request. That forced a chart note onto
    // every match — including matches made just to see who it was, or to hand the
    // call to TC, which is not a chart write at all.
    //
    // This links and stops. od_sync_status becomes 'matched', which is the status
    // Slice B.1 already defined as "patient known, note not sent yet" — the same
    // state an auto-matched call lands in, so the review-then-send UI needs no new
    // vocabulary. "Send to chart" and "Send to TC" then stand on their own.
    if (body.linkOnly === true) {
      // Already on the chart: the commlog is written against whoever it was written
      // against. Silently re-pointing the linkage would make the stored record
      // disagree with the chart, so a DIFFERENT patient is refused outright. The
      // same patient is a harmless no-op.
      if (call.od_sync_status === 'synced') {
        if (String(call.od_patient_id) === String(patientId)) {
          return res.json({
            success: true,
            linked: true,
            alreadySynced: true,
            patientId: call.od_patient_id,
            office: odOffices.describeOffice(officeKey),
            call: { ...call, office_id: officeKey, office: odOffices.describeOffice(officeKey) },
          });
        }
        return res.status(409).json({
          success: false,
          error: 'This call already has a chart note on another patient — re-linking would leave the note filed under the wrong person',
          code: 'ALREADY_SENT_TO_CHART',
          office: odOffices.describeOffice(officeKey),
        });
      }

      // Validates the patient exists in THIS office's database and stamps
      // od_patient_id / od_patient_name / od_patient_office. syncNow:false is what
      // keeps it from writing a commlog.
      const linkResult = await openDentalSync.linkCallToPatient(id, patientId, {
        syncNow: false,
        userId: actor?.email || 'system',
        expectOfficeKey: officeKey,
      });
      if (!linkResult.success) {
        const status = linkResult.officeBlocked
          ? odOffices.httpStatusFor({ code: linkResult.code })
          : linkResult.error === 'Patient not found in Open Dental' ? 404 : 400;
        return res.status(status).json({
          success: false,
          error: linkResult.error,
          code: linkResult.code,
          office: odOffices.describeOffice(officeKey),
        });
      }

      // resolved_by/at = who established the match. sent_by/sent_at stay null:
      // nothing has been sent, and claiming otherwise would misattribute a chart
      // note that does not exist.
      const linkedCall = unifiedCallStore.updateCall(id, {
        od_sync_status: 'matched',
        resolved_by: actor,
        resolved_at: nowIso,
      });

      // UPDATE on the call, NOT CREATE on a commlog — nothing was written to any
      // chart, and the audit trail must not imply that it was.
      await audit.audit(req, {
        action: 'UPDATE', resourceType: 'call', resourceId: id, office: officeKey, result: 'SUCCESS',
      });

      return res.json({
        success: true,
        linked: true,
        patientId: linkedCall.od_patient_id ?? patientId,
        office: odOffices.describeOffice(officeKey),
        call: { ...linkedCall, office_id: officeKey, office: odOffices.describeOffice(officeKey) },
      });
    }

    // Idempotency guard: if this call is already synced, do not write a second
    // commlog. Return the existing linkage as a success no-op.
    if (call.od_sync_status === 'synced') {
      return res.json({
        success: true,
        alreadySynced: true,
        commLogNum: call.od_commlog_num ?? null,
        patientId: call.od_patient_id ?? null,
        // Same complete record GET /:id returns — see the note on the success
        // response below.
        call: { ...call, office_id: officeKey, office: odOffices.describeOffice(officeKey) },
      });
    }

    // Link the call to the patient (validates the patient exists in OD). We pass
    // syncNow:false so we can drive the idempotent, NON-forced commlog write
    // ourselves — linkCallToPatient's own syncNow path forces the write and would
    // bypass the 'synced' dedup guard.
    // expectOfficeKey re-asserts the office INSIDE the service, so the guard holds
    // even if this route is ever refactored around.
    const linkResult = await openDentalSync.linkCallToPatient(id, patientId, {
      syncNow: false,
      userId: actor?.email || 'system',
      expectOfficeKey: officeKey,
    });
    if (!linkResult.success) {
      const status = linkResult.officeBlocked
        ? odOffices.httpStatusFor({ code: linkResult.code })
        : linkResult.error === 'Patient not found in Open Dental' ? 404 : 400;
      return res.status(status).json({
        success: false,
        error: linkResult.error,
        code: linkResult.code,
        office: odOffices.describeOffice(officeKey),
      });
    }

    // Determine the note to send. The generated note is the baseline; a human-edited
    // note (from the review/edit dialog) wins. Both are OD-sanitized so what we persist,
    // preview, and write all match. note_edited records whether the human changed it.
    // content_type (item 4): the user chooses summary (compact) or full transcript at send.
    const contentType = body.content_type === 'transcript' ? 'transcript' : 'summary';
    const generatedNote = sanitizeForOd(openDentalSync.formatCommLogEntry(call, { contentType }).Note);
    const hasEdit = typeof body.note === 'string' && body.note.trim().length > 0;
    const sentNote = hasEdit ? sanitizeForOd(body.note) : generatedNote;
    const noteEdited = sentNote.trim() !== generatedNote.trim();

    // Write the commlog via the hardened, non-forced path (skips if already synced).
    const syncResult = await openDentalSync.syncCallToCommLog(id, {
      noteOverride: sentNote,
      expectOfficeKey: officeKey,
    });
    if (!syncResult.success) {
      return res.status(syncResult.officeBlocked ? odOffices.httpStatusFor({ code: syncResult.code }) : 422).json({
        success: false,
        error: syncResult.error || 'CommLog write failed',
        code: syncResult.code,
        requiresManualLink: syncResult.requiresManualLink || false,
        office: odOffices.describeOffice(officeKey),
      });
    }

    // Writing the commlog IS "send to chart" — stamp sent_by/sent_at (Slice B.1) and
    // persist the what-was-sent record (sent_note + note_edited). resolved_by/at stay
    // for continuity (who resolved the match); for a pre-matched call they equal the sender.
    const updatedCall = unifiedCallStore.updateCall(id, {
      resolved_by: actor,
      resolved_at: nowIso,
      sent_by: actor,
      sent_at: nowIso,
      sent_note: sentNote,
      note_edited: noteEdited,
    });

    // User-initiated PHI write (a commlog was created against a patient) → audit CREATE.
    // The office is recorded so the trail answers "whose chart?", not just "which PatNum?".
    await audit.audit(req, {
      action: 'CREATE',
      resourceType: 'commlog',
      resourceId: syncResult.commLogNum ?? id,
      office: officeKey,
      result: 'SUCCESS',
    });

    res.json({
      success: true,
      commLogNum: syncResult.commLogNum ?? null,
      patientId: updatedCall.od_patient_id ?? patientId,
      office: odOffices.describeOffice(officeKey),
      // The COMPLETE updated record, stamped with the server-resolved office
      // exactly as GET /:id stamps it. The client renders the post-send state
      // from this instead of hand-patching the two or three fields it happens to
      // know changed — a subset that silently goes stale every time a new
      // consumer starts reading a field nobody remembered to include (which is
      // how the TC button came to sit disabled until a page refresh).
      call: { ...updatedCall, office_id: officeKey, office: odOffices.describeOffice(officeKey) },
    });
  } catch (error) {
    console.error('Error resolving patient:', error);
    res.status(500).json({ error: 'Failed to resolve patient' });
  }
});

/**
 * POST /api/unified-calls/:id/send-to-tc
 *
 * The voice side of the cross-module handoff (Mango slice M6). Hands a matched
 * call to the Treatment Coordinator module, which either opens a new case or
 * attaches the call to the patient's existing open one.
 *
 * The payload is assembled HERE, from the stored call — never from the request
 * body. A PatNum means nothing without the practice it belongs to (numbering
 * restarts per Open Dental database), so letting a client name the patient and
 * the office independently would be the cross-office bug all over again. `office_id`
 * in the body is accepted only as an assertion: it can cause a refusal, never a
 * redirect — same shape as resolve-patient above.
 *
 * Idempotent twice over: this route short-circuits once the call carries a
 * tc_case_id, and the TC endpoint is itself idempotent on call_id, so even a
 * concurrent double-click converges on one case.
 *
 * Nothing here writes to Open Dental — a TC case is app data, not a chart entry —
 * so this path deliberately does NOT require an OD-connected office. It does
 * require a REAL office ('unknown' has no practice to file a case under).
 */
router.post('/:id/send-to-tc', canSendToTc, async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const actor = actorFrom(req);

    const call = unifiedCallStore.getCall(id);
    if (!call) {
      return res.status(404).json({ success: false, error: 'Call not found', code: 'CALL_NOT_FOUND' });
    }

    const officeKey = getOfficeForCall(call);

    // Entitlement, checked before anything else is spent. The button is hidden for
    // a voice-only tenant, but the UI is not the control — /api/tc would 403 this
    // anyway; refusing here makes the reason legible and skips the round trip.
    if (!isEntitledModule(req, 'tc')) {
      return res.status(403).json({
        success: false,
        error: 'MODULE_NOT_ENTITLED',
        code: 'MODULE_NOT_ENTITLED',
        module: 'tc',
        message: "This account is not entitled to the 'tc' module.",
      });
    }

    // Cross-office guard: the client saying which office it BELIEVES it is acting
    // on can only ever cause a refusal.
    if (typeof body.office_id === 'string' && body.office_id && body.office_id !== officeKey) {
      console.error(
        `[unifiedCalls] BLOCKED cross-office TC handoff on call ${id}: client claimed ` +
        `office '${body.office_id}' but the call belongs to '${officeKey}'`
      );
      await audit.audit(req, {
        action: 'CREATE', resourceType: 'tc_case', resourceId: id, office: officeKey, result: 'UNAUTHORIZED',
      });
      return res.status(409).json({
        success: false,
        error: 'This call belongs to a different office — refusing to file it there',
        code: 'OFFICE_MISMATCH',
        office: odOffices.describeOffice(officeKey),
      });
    }

    // A case has to belong to a practice. 'unknown' means the dialed line isn't
    // mapped yet (M5 already keeps those out of the chart path); it must not
    // reach TC either.
    if (!officeKey || officeKey === 'unknown') {
      return res.status(409).json({
        success: false,
        error: "This call's office is unknown — map its line before sending it to TC",
        code: 'OFFICE_UNKNOWN',
        office: odOffices.describeOffice(officeKey),
      });
    }

    const patientId = Number(call.od_patient_id);
    if (!call.od_patient_id || !Number.isFinite(patientId) || patientId <= 0) {
      return res.status(409).json({
        success: false,
        error: 'This call has no matched patient — match it before sending it to TC',
        code: 'NO_MATCHED_PATIENT',
      });
    }

    // patient_name is REQUIRED by the contract, and it is the snapshot TC files the
    // case under. A nameless payload would create a case nobody can identify, so
    // refuse rather than send one.
    const patientName = typeof call.od_patient_name === 'string' ? call.od_patient_name.trim() : '';
    if (!patientName) {
      return res.status(409).json({
        success: false,
        error: "The matched patient's name is unavailable — re-match the call before sending it to TC",
        code: 'PATIENT_NAME_UNAVAILABLE',
      });
    }

    // Already handed over → return the same case. No second call, no second audit row.
    if (call.tc_case_id) {
      return res.json({
        success: true,
        alreadySent: true,
        caseId: call.tc_case_id,
        url: call.tc_case_url ?? null,
        attached: null,
        call,
      });
    }

    const phone = typeof call.caller_number === 'string' && call.caller_number !== 'Unknown'
      ? call.caller_number
      : null;

    const result = await tcCaseClient.createCaseFromCall(req, {
      od_patient_id: patientId,
      office: officeKey,
      call_id: id,
      // A call that was never transcribed still has value to a coordinator — the
      // handoff does not require a summary, it just carries null when there is none.
      call_summary: call.summary ?? null,
      call_url: `/calls/${id}`,
      patient_name: patientName,
      ...(phone ? { patient_phone: phone } : {}),
    });

    if (!result.ok) {
      await audit.audit(req, {
        action: 'CREATE',
        resourceType: 'tc_case',
        resourceId: id,
        office: officeKey,
        result: result.code === 'TC_MODULE_NOT_ENTITLED' ? 'UNAUTHORIZED' : 'ERROR',
      });
      // 0 (unreachable) and 404 (endpoint not deployed) are the same thing to a
      // human: the TC app didn't take it. Surface them as 502 — our request, their
      // dependency — rather than echoing a 404 that reads like "call not found".
      const status = result.status === 403 ? 403 : result.status >= 400 && result.status < 500 && result.status !== 404
        ? result.status
        : 502;
      return res.status(status).json({
        success: false,
        error: result.error,
        code: result.code,
      });
    }

    // Persist the linkage. These four fields are on normalizeCall's preservation
    // list, so the hourly re-ingest inside the watermark overlap cannot wipe them.
    const updatedCall = unifiedCallStore.updateCall(id, {
      tc_case_id: result.caseId,
      tc_case_url: result.url,
      tc_sent_at: new Date().toISOString(),
      tc_sent_by: actor,
    });

    // Voice-side audit: TC audits the case; we audit the send. resource_id is the
    // case id — an identifier, never PHI.
    await audit.audit(req, {
      action: 'CREATE',
      resourceType: 'tc_case',
      resourceId: result.caseId,
      office: officeKey,
      result: 'SUCCESS',
    });

    res.json({
      success: true,
      caseId: result.caseId,
      url: result.url,
      attached: result.attached,
      office: odOffices.describeOffice(officeKey),
      call: updatedCall,
    });
  } catch (error) {
    console.error('Error sending call to TC:', error);
    res.status(500).json({ success: false, error: 'Failed to send this call to TC', code: 'SEND_TO_TC_FAILED' });
  }
});

module.exports = router;

