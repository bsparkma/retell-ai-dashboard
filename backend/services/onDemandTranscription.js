'use strict';

/**
 * On-demand transcription (Mango slice M4, decision D1-REVISED).
 *
 * Transcription stops being automatic and becomes a HUMAN DECISION. A team member clicks
 * "Transcribe & Summarize" on a call that matters; interoffice, vendor and spam calls are
 * simply never clicked and never billed. The hourly sync keeps ingesting every call
 * (M3 watermark) — it just no longer transcribes by default (MANGO_AUTO_TRANSCRIBE).
 *
 * THIS IS THE SEAM M3 BUILT. The ingestion watermark advances on ingestion alone, never on
 * transcription outcome, so a call the old auto pipeline skipped — budget spent, recording
 * not yet published, Azure error — still has a store row, and this makes that row
 * transcribable at any later time. That is also the fix for the afternoon blackout's tail.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, having replaced the route that did:
 *   - It never reports success before the result is PERSISTED (the deleted
 *     POST /fetch/:mangoCallId swallowed transcription failures in an empty catch and
 *     returned `success: true, transcript: null`).
 *   - It never swallows TRANSCRIPTION_BUDGET_EXCEEDED. The breaker is surfaced to the
 *     user, with the time it resets, and is never bypassed.
 *   - It never writes to Open Dental. Review-then-send is unchanged; the only OD-adjacent
 *     step is matchAndSetStatus, which sets worklist status and writes nothing to OD.
 *
 * Compliance (D3/D7): Azure Speech + Azure OpenAI only, both BAA-covered. Audio is fetched
 * from the signed, expiring Mango URL into memory and discarded — never written to disk.
 */

const mangoConfig = require('../config/mango');
const mangoApiClient = require('./mangoApiClient');
const transcriptionService = require('./transcriptionService');
const callAnalyzer = require('./callAnalyzer');
const unifiedCallStore = require('./unifiedCallStore');
const openDentalSyncService = require('./openDentalSync');
const ledger = require('./onDemandTranscriptionLedger');
const { getOfficeForCall } = require('../config/officeAgents');
const { normalizeTranscriptJson } = require('../utils/transcriptShape');

/**
 * How recent a call has to be for "Mango has no recording_url" to mean PUBLISH LAG rather
 * than "gone". The M3 sync's no-recording age buckets showed the mass of missing
 * recordings sitting under 15 minutes old, so 30 is a comfortable margin either side.
 */
const RECORDING_LAG_MINUTES = (() => {
  const raw = process.env.MANGO_RECORDING_LAG_MINUTES;
  if (raw === undefined || raw === '') return 30;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

/**
 * Per-call in-flight lock. A single container serves the dashboard, so an in-memory Map is
 * the correct scope: it exists to stop a DOUBLE-CLICK from billing Azure Speech twice for
 * the same recording, which is a within-process race. Always released in `finally`.
 * @type {Set<string>}
 */
const inFlight = new Set();

/** The Mango-side call id for a stored call, or null if we can't derive one. */
function mangoIdFor(call) {
  if (call.mango_call_id) return String(call.mango_call_id);
  if (typeof call.external_id === 'string' && call.external_id.startsWith('mango_call_')) {
    return call.external_id.replace(/^mango_call_/, '');
  }
  return null;
}

/** Age of the call in minutes at `now`, or null when the stored date is unusable. */
function ageMinutes(call, now) {
  const t = call.call_date ? Date.parse(call.call_date) : NaN;
  if (!Number.isFinite(t)) return null;
  return (now - t) / 60000;
}

/**
 * Run the source-agnostic match → status transition so a freshly transcribed call lands in
 * the Slice B worklist exactly like an ingested one — now with the caller name the summary
 * just extracted, which a metadata-only Mango row never had.
 *
 * ONLY for calls with no patient linkage yet. This mirrors the rule the sync path follows
 * for the same reason (syncScheduler.matchMangoCalls matches newly-added calls only): once
 * a call has an od_patient_id it may be a HUMAN's choice from the Pick Patient modal, and
 * re-running the auto-matcher over it could silently replace that person's decision with a
 * different patient. 'synced' and 'not a patient' are terminal for the same reason.
 *
 * Best-effort: a matcher failure must never discard a transcript we already hold and paid
 * for — worst case the call sits in the worklist un-matched, exactly as it did before.
 * @param {string} callId
 */
async function matchIfNeeded(callId) {
  try {
    const call = unifiedCallStore.getCall(callId);
    if (!call) return;
    if (call.od_sync_status === 'synced' || call.not_a_patient) return;
    if (call.od_patient_id !== null && call.od_patient_id !== undefined && call.od_patient_id !== '') return;
    await openDentalSyncService.matchAndSetStatus(callId, {
      caller_number: call.caller_number,
      caller_name: call.caller_name,
    });
  } catch (e) {
    console.error(`[M4] matchAndSetStatus failed for ${callId}: ${e.message}`);
  }
}

/**
 * Transcribe one stored Mango call on demand.
 *
 * Never throws: every failure mode is a typed result the route turns into an HTTP status
 * and the UI turns into a specific message. A failed attempt ALWAYS leaves the call
 * transcribable — nothing here marks a call "done" without a transcript to show for it.
 *
 * @param {string} callId  unified-store call id (NOT the Mango id)
 * @param {{ actor?: {name?: string|null, email?: string|null}|null }} [options]
 * @returns {Promise<{httpStatus: number, outcome: string, body: object, call?: object}>}
 */
async function transcribeCall(callId, options = {}) {
  const actor = options.actor || null;

  const call = unifiedCallStore.getCall(callId);
  // 1. Not in the store (or not a Mango call — Retell transcripts come from Retell).
  if (!call || call.source !== 'mango') {
    return {
      httpStatus: 404,
      outcome: 'not_found',
      body: { status: 'not_found', error: 'Call not found' },
    };
  }

  const office = getOfficeForCall(call) || 'unknown';

  // 2. DEDUP GUARD. An existing transcript is REUSED, never re-billed. This is the same
  //    guard the ingest path uses (cost-investigation #2/#4) — here it means a second
  //    click, or a click on a call the auto pipeline already did, costs nothing.
  if (call.transcript) {
    ledger.record({ callId, office, actor, outcome: 'exists' });
    return {
      httpStatus: 200,
      outcome: 'exists',
      body: { status: 'exists', transcript: call.transcript, summary: call.summary ?? null },
      call,
    };
  }

  // 3. IN-FLIGHT LOCK. Two clicks, one recording, one bill.
  if (inFlight.has(callId)) {
    ledger.record({ callId, office, actor, outcome: 'in_progress' });
    return {
      httpStatus: 409,
      outcome: 'in_progress',
      body: { status: 'in_progress', error: 'A transcription for this call is already running' },
    };
  }

  inFlight.add(callId);
  let result;
  try {
    result = await runTranscription(call, { actor });
  } catch (error) {
    // Belt-and-braces: runTranscription types its own failures, so reaching here means
    // something genuinely unexpected. The call keeps its row and stays transcribable.
    console.error(`[M4] on-demand transcription failed for ${callId}:`, error.message);
    result = {
      httpStatus: 500,
      outcome: 'error',
      body: {
        status: 'error',
        error: 'Transcription failed — nothing was saved. Try again.',
        detail: String(error.message || error).slice(0, 200),
      },
    };
  } finally {
    inFlight.delete(callId);
  }

  ledger.record({
    callId,
    office,
    actor,
    outcome: result.outcome,
    minutes: result.minutes || 0,
    summaryCost: result.summaryCost || 0,
  });

  return result;
}

/**
 * Remember the outcome of an attempt that produced no transcript but DID spend budget, so
 * the UI can hold that state across a reload and ask before spending again.
 *
 * Best-effort and non-fatal by design: this is a guard rail on a refusal we have already
 * reported honestly. Failing to record it must not turn "no speech was found" into a
 * different, more confusing error.
 * @param {string} callId
 * @param {string} outcome
 * @param {{name?: string|null, email?: string|null}|null} actor
 */
async function rememberAttempt(callId, outcome, actor) {
  try {
    unifiedCallStore.updateCall(callId, {
      transcribe_last_outcome: outcome,
      transcribe_last_attempt_at: new Date().toISOString(),
      transcribe_last_attempt_by: actor,
    });
    await unifiedCallStore.persist();
  } catch (e) {
    console.error(`[M4] could not record the '${outcome}' attempt for ${callId}: ${e.message}`);
  }
}

/**
 * The billing path, run under the in-flight lock. Ordered so nothing is spent before we
 * know it can be: availability → budget → fresh recording URL → Speech → summary →
 * persist. Returns `{httpStatus, outcome, body, minutes?, summaryCost?, call?}`.
 */
async function runTranscription(call, { actor }) {
  const callId = call.id;

  // Azure Speech unconfigured (e.g. a local dev box) — say so rather than fail obscurely.
  if (!transcriptionService.isAvailable()) {
    return {
      httpStatus: 503,
      outcome: 'unavailable',
      body: { status: 'unavailable', error: 'Transcription is not configured in this environment' },
    };
  }

  // CIRCUIT BREAKER, surfaced not swallowed. Checked BEFORE we ask Mango for the recording
  // so a spent budget costs zero round trips; the hard backstop inside transcribeBuffer is
  // still caught below, because the budget can be spent by a concurrent request in between.
  const budget = transcriptionService.checkDailyBudget();
  if (!budget.allowed) {
    return budgetExhausted(budget);
  }

  const mangoId = mangoIdFor(call);
  const now = Date.now();
  if (!mangoId) {
    // No Mango id → there is no recording we can ever fetch for this row.
    return recordingMissing(call, now, /* forceUnavailable */ true);
  }

  // Re-fetch the CURRENT signed recording_url. The one captured at ingest has expired, and
  // a call that had none at ingest may have had one published since — which is exactly the
  // publish-lag case this button exists to recover.
  let detail;
  try {
    detail = await mangoApiClient.getCall(mangoId);
  } catch (e) {
    console.error(`[M4] Mango detail fetch failed for ${callId}: ${e.message}`);
    return {
      httpStatus: 502,
      outcome: 'error',
      body: {
        status: 'error',
        error: 'Could not reach the phone system. Nothing was saved — try again.',
        detail: String(e.message || e).slice(0, 200),
      },
    };
  }

  const recordingUrl = detail && typeof detail.recording_url === 'string' ? detail.recording_url : null;
  if (!recordingUrl) {
    return recordingMissing(call, now, false);
  }

  // ── Azure Speech (audio in memory, discarded — D3) ───────────────────────────────────
  let transcript;
  try {
    transcript = await transcriptionService.transcribeUrl(recordingUrl);
  } catch (e) {
    if (e && e.code === 'TRANSCRIPTION_BUDGET_EXCEEDED') {
      return budgetExhausted(transcriptionService.checkDailyBudget());
    }
    console.error(`[M4] Azure Speech failed for ${callId}: ${e.message}`);
    return {
      httpStatus: 502,
      outcome: 'error',
      body: {
        status: 'error',
        error: 'Transcription failed — nothing was saved. Try again.',
        detail: String(e.message || e).slice(0, 200),
      },
    };
  }

  const minutes = transcript && transcript.duration_seconds ? transcript.duration_seconds / 60 : 0;

  if (!transcript || !transcript.text) {
    // Speech ran (and BILLED) but heard nothing — a silent or music-only recording. No
    // transcript is stored, so the call stays clickable and the UI says what happened
    // rather than showing an empty transcript that looks like a bug.
    //
    // But this is the one refusal that already cost money, so it MUST be remembered: a
    // silent-call row that re-bills on every misclick breaks the promise the whole button
    // makes ("an existing result is never re-billed"). Persisting the outcome lets the UI
    // hold the state across reloads and demand an explicit confirmation before spending
    // again. Deliberately NOT a lockout — a human may still have a reason to retry.
    await rememberAttempt(callId, 'no_speech', actor);
    return {
      httpStatus: 422,
      outcome: 'no_speech',
      minutes,
      body: {
        status: 'no_speech',
        error: 'No speech was detected in this recording — there is nothing to summarize.',
        /** Tells the client to require a confirmation before spending on this call again. */
        alreadyBilled: true,
      },
    };
  }

  // ── Summary (Azure OpenAI, D2) ───────────────────────────────────────────────────────
  // Same D4 gate the sync uses: below MANGO_SUMMARY_MIN_SECONDS the transcript is kept and
  // the summarizer LLM is skipped. analyzeCall never throws (it degrades to the regex
  // fallback), so a summarizer outage cannot cost us the transcript we just paid for.
  const durationSeconds = call.duration_seconds || transcript.duration_seconds || 0;
  const costBefore = callAnalyzer.getStats().estimatedCost || 0;
  let analysis = null;
  if (durationSeconds >= mangoConfig.summaryMinSeconds) {
    analysis = await callAnalyzer.analyzeCall({ ...call, transcript: transcript.text, source: 'mango' });
  }
  const summaryCost = Math.max(0, (callAnalyzer.getStats().estimatedCost || 0) - costBefore);

  // ── PERSIST, THEN report success. Never the other way round. ─────────────────────────
  const updates = {
    transcript: transcript.text,
    // Canonical shape at the source (utils/transcriptShape.js). Azure hands us
    // {speaker, text, start, end}; the store's canonical entry is {role, speaker,
    // content, start, end}. normalizeCall normalizes too — writing it canonical
    // here keeps the divergence from being re-introduced by some future path that
    // bypasses the store's normalizer.
    transcript_json: normalizeTranscriptJson(transcript.utterances || transcript.words),
    // Attribution for the on-demand decision, alongside triage_by / sent_by.
    transcribed_at: new Date().toISOString(),
    transcribed_by: actor,
    transcribe_source: 'on_demand',
    // Clears any remembered 'no_speech' from an earlier attempt — a retry that DID find
    // speech must not leave the row still warning about the previous silent one.
    transcribe_last_outcome: 'completed',
    transcribe_last_attempt_at: new Date().toISOString(),
    transcribe_last_attempt_by: actor,
  };
  if (analysis) {
    updates.caller_name = analysis.caller_name || call.caller_name;
    updates.call_reason = analysis.call_reason ?? call.call_reason ?? null;
    updates.sentiment = analysis.sentiment ?? call.sentiment ?? 'neutral';
    updates.summary = analysis.summary ?? null;
    updates.is_emergency = analysis.is_emergency ?? false;
    updates.action_needed = analysis.action_needed ?? null;
    updates.callback_number = analysis.callback_number ?? null;
    updates.appointment_requested = analysis.appointment_requested ?? false;
    updates.callback_required = analysis.callback_needed ?? call.callback_required ?? false;
  }

  const updated = unifiedCallStore.updateCall(callId, updates);
  if (!updated) {
    return {
      httpStatus: 500,
      outcome: 'error',
      minutes,
      summaryCost,
      body: { status: 'error', error: 'Transcription completed but could not be saved. Try again.' },
    };
  }

  // Enter the worklist (status only — no Open Dental write happens here).
  await matchIfNeeded(callId);

  // Flush to disk BEFORE claiming success. If this throws, or the transcript somehow is
  // not readable back out of the store, we report an error — a success we cannot show the
  // user again is a lie.
  try {
    await unifiedCallStore.persist();
    const persisted = unifiedCallStore.getCall(callId);
    if (!persisted || !persisted.transcript) throw new Error('transcript missing from the store after persist');
  } catch (e) {
    console.error(`[M4] persist failed for ${callId}: ${e.message}`);
    return {
      httpStatus: 500,
      outcome: 'error',
      minutes,
      summaryCost,
      body: {
        status: 'error',
        error: 'Transcription completed but could not be saved. Try again.',
        detail: String(e.message || e).slice(0, 200),
      },
    };
  }

  const final = unifiedCallStore.getCall(callId);
  return {
    httpStatus: 200,
    outcome: 'completed',
    minutes,
    summaryCost,
    call: final,
    body: {
      status: 'completed',
      transcript: final.transcript,
      summary: final.summary ?? null,
      minutesUsed: Number(minutes.toFixed(2)),
    },
  };
}

/** 429 + when the budget rolls over. Surfaced to the user; never bypassed. */
function budgetExhausted(budget) {
  return {
    httpStatus: 429,
    outcome: 'budget_exhausted',
    body: {
      status: 'budget_exhausted',
      error: 'Daily transcription budget is used up.',
      resetsAt: transcriptionService.nextBudgetResetIso(),
      usedMinutes: Number((budget.usedMinutes || 0).toFixed(1)),
      capMinutes: budget.capMinutes,
    },
  };
}

/**
 * Mango served no recording. Split by the call's age: a young call is publish lag and
 * worth retrying in a few minutes; an old one is gone from the phone system.
 */
function recordingMissing(call, now, forceUnavailable) {
  const age = ageMinutes(call, now);
  const notReady = !forceUnavailable && age !== null && age < RECORDING_LAG_MINUTES;
  return notReady
    ? {
        httpStatus: 422,
        outcome: 'recording_not_ready',
        body: {
          status: 'recording_not_ready',
          error: "The recording isn't ready yet — try again in a few minutes.",
          retryAfterMinutes: Math.max(1, Math.ceil(RECORDING_LAG_MINUTES - age)),
        },
      }
    : {
        httpStatus: 422,
        outcome: 'recording_unavailable',
        body: {
          status: 'recording_unavailable',
          error: 'The recording is no longer available from the phone system.',
        },
      };
}

module.exports = {
  transcribeCall,
  RECORDING_LAG_MINUTES,
  /** Exposed for tests only — asserting the lock is released is part of the contract. */
  _inFlight: inFlight,
};
