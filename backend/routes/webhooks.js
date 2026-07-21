/**
 * Webhooks Router
 * 
 * Handles incoming webhook events from Retell AI.
 * Processes call events and updates live call state.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const liveCallManager = require('../services/liveCallManager');
const unifiedCallStore = require('../services/unifiedCallStore');
const openDentalSyncService = require('../services/openDentalSync');

/**
 * Verify Retell webhook signature.
 *
 * Per https://docs.retellai.com/features/secure-webhook the X-Retell-Signature
 * header has the format `v={ms-timestamp},d={hex-digest}` and the digest is
 *   HMAC-SHA256( raw_body + timestamp, api_key ) → hex
 *
 * We must verify against the raw request body (captured in server.js as
 * req.rawBody), NOT against JSON.stringify(req.body) — re-stringifying loses
 * key ordering and whitespace and will not match Retell's digest.
 *
 * Setting WEBHOOK_VERIFY_DISABLED=true bypasses verification (for local
 * development only; the bypass is logged loudly so it cannot ship silently).
 */
const SIGNATURE_PATTERN = /^v=(\d+),d=([0-9a-f]+)$/i;
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // Retell recommends 5 minutes

function verifyRetellSignature(req) {
  if (process.env.WEBHOOK_VERIFY_DISABLED === 'true') {
    console.warn(
      '⚠️ WEBHOOK_VERIFY_DISABLED=true — Retell signature NOT verified. ' +
      'Do not ship this to production.'
    );
    return true;
  }

  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    console.error('❌ RETELL_API_KEY is not set; cannot verify webhook.');
    return false;
  }

  const header = req.headers['x-retell-signature'];
  if (!header) {
    console.warn('⚠️ Missing x-retell-signature header');
    return false;
  }

  const match = SIGNATURE_PATTERN.exec(header.trim());
  if (!match) {
    console.warn(`⚠️ Malformed x-retell-signature header: ${header}`);
    return false;
  }
  const timestamp = match[1];
  const providedHex = match[2];

  const ageMs = Math.abs(Date.now() - Number(timestamp));
  if (ageMs > REPLAY_WINDOW_MS) {
    console.warn(
      `⚠️ Retell webhook outside ${REPLAY_WINDOW_MS}ms replay window (age=${ageMs}ms)`
    );
    return false;
  }

  const rawBody = req.rawBody;
  if (typeof rawBody !== 'string') {
    console.error(
      '❌ req.rawBody not captured. Ensure server.js attaches express.json({verify}) ' +
      'so HMAC can be computed against the unparsed body.'
    );
    return false;
  }

  const expectedHex = crypto
    .createHmac('sha256', apiKey)
    .update(rawBody + timestamp, 'utf8')
    .digest('hex');

  const provided = Buffer.from(providedHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

/**
 * POST /api/webhooks/retell
 * 
 * Main webhook endpoint for Retell AI events.
 * 
 * Retell sends these event types:
 * - call_started: When a call begins
 * - call_ended: When a call terminates
 * - call_analyzed: When post-call analysis is complete
 * 
 * For real-time transcription (if enabled):
 * - transcript: Real-time transcript updates
 */
router.post('/retell', async (req, res) => {
  // Verify signature in production
  if (!verifyRetellSignature(req)) {
    console.warn('⚠️ Invalid Retell signature — rejecting webhook');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const event = req.body;
    
    // Log the incoming event (useful for debugging)
    console.log('📨 Retell webhook received:', {
      event: event.event,
      call_id: event.call?.call_id || event.data?.call_id,
      timestamp: new Date().toISOString()
    });

    // Handle different event types
    switch (event.event) {
      case 'call_started':
        await handleCallStarted(event);
        break;

      case 'call_ended':
        await handleCallEnded(event);
        break;

      case 'call_analyzed':
        await handleCallAnalyzed(event);
        break;

      case 'transcript':
      case 'transcript_update':
        await handleTranscriptUpdate(event);
        break;

      default:
        console.log(`⚠️ Unknown webhook event type: ${event.event}`);
    }

    // Always respond with 200 to acknowledge receipt
    res.status(200).json({ 
      received: true, 
      event: event.event,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error processing Retell webhook:', error);
    
    // Still return 200 to prevent Retell from retrying
    // Log the error for investigation
    res.status(200).json({ 
      received: true, 
      error: 'Processing error logged',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Handle call_started event
 */
async function handleCallStarted(event) {
  const callData = event.call || event.data || event;
  
  const call = liveCallManager.addCall({
    call_id: callData.call_id,
    agent_id: callData.agent_id,
    agent_name: callData.agent_name,
    from_number: callData.from_number,
    to_number: callData.to_number,
    start_timestamp: callData.start_timestamp || new Date().toISOString(),
    metadata: callData.metadata || {}
  });

  console.log(`📞 [Webhook] Call started: ${call.call_id}`);

  // Store partial call immediately so it shows up in the unified dashboard
  try {
    unifiedCallStore.addRetellCall(call);
    await unifiedCallStore.persist();
  } catch (e) {
    console.warn('⚠️ Failed to persist call_started to unified store:', e.message);
  }
}

/**
 * Handle call_ended event
 */
async function handleCallEnded(event) {
  const callData = event.call || event.data || event;
  
  const finalCall = liveCallManager.endCall(callData.call_id, {
    end_timestamp: callData.end_timestamp || new Date().toISOString(),
    call_status: callData.call_status,
    disconnection_reason: callData.disconnection_reason,
    recording_url: callData.recording_url,
    call_analysis: callData.call_analysis
  });

  if (finalCall) {
    console.log(`📞 [Webhook] Call ended: ${finalCall.call_id} (${finalCall.duration}s)`);
    
    // Here you could trigger:
    // - Storing to database
    // - Syncing to Open Dental
    // - Triggering QA evaluation
    // - Creating callbacks if needed

    // Persist finalized call into unified store so it appears on dashboard
    try {
      unifiedCallStore.addRetellCall(finalCall);
      await unifiedCallStore.persist();
    } catch (e) {
      console.warn('⚠️ Failed to persist call_ended to unified store:', e.message);
    }
  }
}

// ── call_analyzed → Open Dental commlog (hardened) ───────────────────────────
// See docs/SLICE_WEBHOOK_COMMLOG_HARDENING_PRD.md. These writes hit LIVE patient
// charts, so the path must be idempotent (no double-write on a Retell retry),
// must NEVER auto-write to a guessed chart on an ambiguous match, and must ack
// Retell before the OD write so the 200 doesn't wait on OD latency.

// Auto-write only on a confident, UNAMBIGUOUS match. Everything else -> needs_review.
// The FIRM rule is "no alternatives" (a number/name on >1 record never auto-writes). The
// threshold then excludes the weak fuzzy band: phone_exact single = 0.95, name+phone = 0.98/0.85,
// a single strong name match (matchByNameFuzzy caps at 0.80) all write; phone-matched-but-name-
// disagreed (0.70) and weaker fuzzy names fall to needs_review. 0.80 keeps the established
// "Stedi Test" name-only confident-match protocol writing.
const CONFIDENT_WRITE_MIN = 0.80;

// call_ids whose commlog write is currently in-flight. Fix 2 makes the write async,
// so two near-simultaneous retries could both pass the persisted-status check before
// either finishes; this guards that window. The persisted od_sync_status guards the
// sequential-retry case after completion.
const commlogInFlight = new Set();

function isConfidentUnambiguousMatch(matchResult) {
  if (!matchResult || !matchResult.patient) return false;
  // A number on more than one record (matchByPhone returns `alternatives`) is ambiguous.
  if (Array.isArray(matchResult.alternatives) && matchResult.alternatives.length > 0) return false;
  return (matchResult.confidence || 0) >= CONFIDENT_WRITE_MIN;
}

function patientToCandidate(p) {
  if (!p || p.id == null) return null;
  const name = p.fullName
    || [p.firstName, p.lastName].filter(Boolean).join(' ').trim()
    || `Patient ${p.id}`;
  return { id: p.id, name };
}

// The top guess + alternatives, as {id, name}, de-duped by id — for the Slice-B review UI.
function buildMatchCandidates(matchResult) {
  if (!matchResult) return [];
  const seen = new Set();
  return [matchResult.patient, ...(matchResult.alternatives || [])]
    .map(patientToCandidate)
    .filter(Boolean)
    .filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/**
 * Handle call_analyzed event (comes after the call ends, with full analysis).
 *
 * Acks fast: persists the analysis to the unified store synchronously, then schedules
 * the OD match + commlog write to run AFTER the webhook response (Fix 2). The write
 * itself is idempotent (Fix 1) so a Retell retry is harmless.
 */
async function handleCallAnalyzed(event) {
  const callData = event.call || event.data || event;

  console.log(`📊 [Webhook] Call analyzed: ${callData.call_id}`);

  // Emit the analysis to any listening clients
  if (liveCallManager.io) {
    liveCallManager.io.emit('call:analyzed', {
      call_id: callData.call_id,
      analysis: callData.call_analysis,
      transcript: callData.transcript,
      transcript_object: callData.transcript_object,
      recording_url: callData.recording_url
    });
  }

  // Persist analysis updates into unified store (fast, in-memory; od_* sync state is
  // preserved across this re-add by unifiedCallStore so the dedup guard below holds).
  try {
    unifiedCallStore.addRetellCall({
      ...callData,
      call_id: callData.call_id,
      transcript: callData.transcript,
      transcript_object: callData.transcript_object,
      recording_url: callData.recording_url,
      call_analysis: callData.call_analysis,
      call_summary: callData.call_analysis?.call_summary || callData.call_summary,
    });
    await unifiedCallStore.persist();
  } catch (e) {
    console.warn('⚠️ Failed to persist call_analyzed to unified store:', e.message);
  }

  // Fix 2: ack the webhook FIRST. setImmediate defers the OD work until after the
  // response has been sent, so Retell's 200 never waits on OD latency. A failure in
  // the async task is caught here and must never crash the process.
  setImmediate(() => {
    writeCommlogForAnalyzedCall(callData).catch(err =>
      console.error(`❌ [Webhook] async commlog task crashed for ${callData.call_id}:`, err && err.message)
    );
  });
}

/**
 * Match the analyzed call to a patient and write the Open Dental commlog — idempotently,
 * and only when the match is confident + unambiguous. Safe to call more than once for the
 * same call_id (dedup by persisted od_sync_status + an in-flight guard).
 *
 * Returns a small result object (used by unit tests); never throws.
 */
async function writeCommlogForAnalyzedCall(callData) {
  const callId = callData && callData.call_id;
  if (!callId) {
    console.warn('⚠️ [Webhook] call_analyzed without call_id; skipping commlog');
    return { skipped: true, reason: 'no_call_id' };
  }

  // Dedup #1 (persisted): a prior delivery already wrote the commlog. This also makes a
  // later manual /sync-all a no-op for this call.
  const existing = unifiedCallStore.getCall(callId);
  if (existing && existing.od_sync_status === 'synced') {
    console.log(`↩️ [Webhook] commlog already written for ${callId} (synced) — dedup skip`);
    return { skipped: true, reason: 'already_synced' };
  }

  // Dedup #2 (in-flight): a concurrent retry is mid-write (the OD write is async).
  if (commlogInFlight.has(callId)) {
    console.log(`↩️ [Webhook] commlog write already in flight for ${callId} — dedup skip`);
    return { skipped: true, reason: 'in_flight' };
  }
  commlogInFlight.add(callId);

  try {
    const matchResult = await openDentalSyncService.matchCallToPatient({
      caller_number: callData.from_number,
      caller_name: callData.call_analysis?.caller_name || 'Unknown'
    });

    // Fix 3: ambiguous / low-confidence / no match -> needs_review. NEVER auto-write to a
    // guessed chart (e.g. when the caller's number is on more than one patient record).
    if (!isConfidentUnambiguousMatch(matchResult)) {
      const candidates = buildMatchCandidates(matchResult);
      unifiedCallStore.updateCall(callId, {
        od_sync_status: 'needs_review',
        od_match_candidates: candidates,
        od_match_confidence: matchResult ? (matchResult.confidence || 0) : 0,
        od_sync_attempted_at: new Date().toISOString(),
      });
      console.warn(
        `🟡 [Webhook] ${callId} needs_review (confidence=${matchResult ? (matchResult.confidence || 0) : 0}, ` +
        `candidates=${candidates.length}) — no commlog written`
      );
      return { needsReview: true, candidates };
    }

    // Confident, unambiguous single match.
    const patient = matchResult.patient;

    // Slice B.1 — review-then-send. Unless COMMLOG_AUTO_WRITE is explicitly enabled,
    // CareIN NEVER auto-writes a chart note: we store the matched patient in a
    // 'matched' (ready-to-send) state and a human sends it from the worklist / call
    // detail via the confirm-preview flow. COMMLOG_AUTO_WRITE=true restores the
    // legacy Slice-A auto-write (future per-tenant setting).
    if (process.env.COMMLOG_AUTO_WRITE !== 'true') {
      const matchedName =
        patient.fullName || [patient.firstName, patient.lastName].filter(Boolean).join(' ').trim() || null;
      unifiedCallStore.updateCall(callId, {
        od_sync_status: 'matched',
        od_patient_id: patient.id,
        od_patient_name: matchedName,
        od_match_confidence: matchResult.confidence,
        od_sync_attempted_at: new Date().toISOString(),
      });
      console.log(
        `🔵 [Webhook] ${callId} matched (patient=${patient.id}, confidence=${matchResult.confidence}) — ` +
        `held for review-then-send (COMMLOG_AUTO_WRITE off)`
      );
      return { matched: true, autoWrite: false, patientId: patient.id };
    }

    // COMMLOG_AUTO_WRITE=true → legacy auto-write (preserving the
    // [CareIN AI — Inbound Call] note format). createCommLog branches DB vs API mode.
    const startTime = callData.start_timestamp ? new Date(callData.start_timestamp).getTime() : 0;
    const endTime = callData.end_timestamp ? new Date(callData.end_timestamp).getTime() : 0;
    const durationSeconds = startTime && endTime ? Math.round((endTime - startTime) / 1000) : 0;

    const patientType = callData.call_analysis?.["new_patient or existing_patient"] || 'unknown';
    const appointmentBooked = callData.call_analysis?.appointment_booked ? 'yes' : 'no';
    const emergency = callData.call_analysis?.emergency_caller ? 'yes' : 'no';
    const insurance = callData.call_analysis?.dental_insurance || 'not provided';
    const summary = callData.call_analysis?.detailed_call_summary || callData.call_analysis?.call_summary || 'No summary available';
    const transcript = typeof callData.transcript === 'string' ? callData.transcript : 'No transcript available';

    const commlogNote = `[CareIN AI — Inbound Call] Duration: ${durationSeconds}s
Summary: ${summary}
Patient Type: ${patientType}
Appointment Booked: ${appointmentBooked}
Emergency: ${emergency}
Insurance: ${insurance}

--- Full Transcript ---
${transcript}`;

    const commLogEntry = {
      CommDateTime: callData.end_timestamp || new Date().toISOString(),
      Mode_: 3, // Phone (DB int; mapped to "Phone" for the API)
      SentOrReceived: 1, // Received (DB int; api sends "Received")
      Note: commlogNote,
      CommType: emergency === 'yes' ? 4 : (appointmentBooked === 'yes' ? 2 : 1),
      UserNum: 0,
      DateTimeEnd: callData.end_timestamp || new Date().toISOString()
    };

    const result = await openDentalSyncService.createCommLog(patient.id, commLogEntry);

    if (result.success) {
      // Persist synced state so a Retell retry AND a later /sync-all both no-op (Fix 1).
      unifiedCallStore.updateCall(callId, {
        od_sync_status: 'synced',
        od_patient_id: patient.id,
        od_commlog_num: result.commLogNum,
        od_synced_at: new Date().toISOString(),
        od_match_confidence: matchResult.confidence,
      });
      console.log(`✅ [Webhook] Open Dental commlog written for call ${callId}, patient: ${patient.lastName}, ${patient.firstName}`);
      return { written: true, commLogNum: result.commLogNum, patientId: patient.id };
    }

    // Write attempted but failed — record the error (NOT synced) so a retry can try again.
    unifiedCallStore.updateCall(callId, {
      od_sync_status: 'error',
      od_sync_error: result.error || 'CommLog create failed',
      od_sync_attempted_at: new Date().toISOString(),
    });
    console.warn(`⚠️ [Webhook] Failed to write Open Dental commlog for ${callId}: ${result.error}`);
    return { written: false, error: result.error };
  } catch (odError) {
    // Never crash the process on an async commlog failure.
    try {
      unifiedCallStore.updateCall(callId, {
        od_sync_status: 'error',
        od_sync_error: odError.message,
        od_sync_attempted_at: new Date().toISOString(),
      });
    } catch (_) { /* store update is best-effort */ }
    console.error(`❌ [Webhook] Open Dental commlog sync failed for call ${callId}:`, odError.message);
    return { written: false, error: odError.message };
  } finally {
    commlogInFlight.delete(callId);
  }
}

/**
 * Handle real-time transcript updates
 */
async function handleTranscriptUpdate(event) {
  const callId = event.call_id || event.data?.call_id;
  const transcript = event.transcript || event.data?.transcript;
  
  if (!callId || !transcript) {
    console.warn('⚠️ Transcript update missing call_id or transcript');
    return;
  }

  // If transcript is an array of utterances
  if (Array.isArray(transcript)) {
    transcript.forEach(utterance => {
      liveCallManager.addTranscriptUtterance(callId, utterance);
    });
  } 
  // If transcript is a single utterance
  else if (typeof transcript === 'object') {
    liveCallManager.addTranscriptUtterance(callId, transcript);
  }
  // If transcript is just text
  else if (typeof transcript === 'string') {
    liveCallManager.addTranscriptUtterance(callId, {
      role: event.role || 'unknown',
      content: transcript,
      timestamp: event.timestamp || new Date().toISOString()
    });
  }

  // Persist incremental transcript changes into unified store (best-effort)
  try {
    const current = liveCallManager.getCall(callId);
    if (current) {
      unifiedCallStore.addRetellCall(current);
      await unifiedCallStore.persist();
    }
  } catch (e) {
    // Don't spam logs for high-frequency transcript events
  }
}

/**
 * GET /api/webhooks/retell
 * 
 * Health check endpoint for webhook.
 * Retell may ping this to verify the endpoint is active.
 */
router.get('/retell', (req, res) => {
  res.status(200).json({
    status: 'active',
    service: 'CareIn Dashboard Webhook',
    timestamp: new Date().toISOString(),
    active_calls: liveCallManager.getActiveCount()
  });
});

/**
 * POST /api/webhooks/test
 * 
 * Test endpoint for simulating webhook events.
 * Only for development/testing purposes.
 */
router.post('/test', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Test endpoint disabled in production' });
  }

  const { event_type, call_data } = req.body;

  console.log('🧪 Test webhook received:', event_type);

  switch (event_type) {
    case 'call_started':
      liveCallManager.addCall({
        call_id: call_data?.call_id || `test-${Date.now()}`,
        agent_id: call_data?.agent_id || 'test-agent',
        agent_name: call_data?.agent_name || 'Test Agent',
        from_number: call_data?.from_number || '+1-555-TEST',
        ...call_data
      });
      break;

    case 'transcript':
      liveCallManager.addTranscriptUtterance(
        call_data?.call_id || 'test-call',
        {
          role: call_data?.role || 'user',
          content: call_data?.content || 'Test transcript message',
          timestamp: new Date().toISOString()
        }
      );
      break;

    case 'call_ended':
      liveCallManager.endCall(call_data?.call_id || 'test-call', {
        end_timestamp: new Date().toISOString(),
        ...call_data
      });
      break;

    default:
      return res.status(400).json({ error: 'Unknown event_type' });
  }

  res.status(200).json({ 
    success: true, 
    event: event_type,
    active_calls: liveCallManager.getActiveCount()
  });
});

// Expose the call_analyzed pipeline for unit tests (the router itself is the default export).
router.handleCallAnalyzed = handleCallAnalyzed;
router.writeCommlogForAnalyzedCall = writeCommlogForAnalyzedCall;
router.isConfidentUnambiguousMatch = isConfidentUnambiguousMatch;
router.buildMatchCandidates = buildMatchCandidates;
router._commlogInFlight = commlogInFlight;

module.exports = router;

