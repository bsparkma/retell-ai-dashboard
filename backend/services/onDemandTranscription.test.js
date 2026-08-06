'use strict';

/**
 * On-demand transcription (Mango slice M4) — the contract tests.
 *
 * These pin the behaviours the deleted POST /fetch/:mangoCallId got wrong, plus the cost
 * guarantees the whole slice exists to provide:
 *
 *   - an existing transcript is REUSED, never re-billed;
 *   - a double click bills once (per-call in-flight lock, always released);
 *   - the daily breaker is SURFACED with the time it resets, never swallowed;
 *   - "no recording" splits honestly by call age into "not ready yet" vs "gone";
 *   - success is claimed ONLY after the transcript is persisted and readable back;
 *   - every failure leaves the call transcribable — a failed attempt never burns the row.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Isolate durable state (budget accounting, the on-demand ledger) in a temp dir so the
// suite neither reads nor writes the repo's data/ directory. Set before the modules below
// resolve CALLSTORE_DIR.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carein-m4-'));
const SAVED_CALLSTORE_DIR = process.env.CALLSTORE_DIR;
process.env.CALLSTORE_DIR = TMP_DIR;

const unifiedCallStore = require('./unifiedCallStore');
const transcriptionService = require('./transcriptionService');
const callAnalyzer = require('./callAnalyzer');
const mangoApiClient = require('./mangoApiClient');
const openDentalSync = require('./openDentalSync');
const ledger = require('./onDemandTranscriptionLedger');
const onDemand = require('./onDemandTranscription');

test.after(() => {
  if (SAVED_CALLSTORE_DIR === undefined) delete process.env.CALLSTORE_DIR;
  else process.env.CALLSTORE_DIR = SAVED_CALLSTORE_DIR;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const ACTOR = { name: 'Front Desk', email: 'desk@example.com' };

const saved = {};

function clearStore() {
  unifiedCallStore.calls.clear();
  unifiedCallStore.bySource.retell.clear();
  unifiedCallStore.bySource.mango.clear();
  unifiedCallStore.byDate.clear();
  unifiedCallStore.byCallerNumber.clear();
}

/** Seed one stored Mango call. `minutesAgo` drives the recording-age split. */
function seedCall({ id = 'mango_call_1', transcript = null, minutesAgo = 120, durationSeconds = 90 } = {}) {
  unifiedCallStore.addMangoCalls([{
    external_id: id,
    caller_number: '4795551234',
    called_number: '4790000000',
    call_date: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    duration_seconds: durationSeconds,
    mango_call_id: id.replace(/^mango_call_/, ''),
    transcript,
  }]);
  const stored = unifiedCallStore.findByExternalId(id);
  assert.ok(stored, 'seed failed');
  return stored;
}

beforeEach(() => {
  saved.requestPersist = unifiedCallStore.requestPersist;
  saved.persist = unifiedCallStore.persist;
  saved.isAvailable = transcriptionService.isAvailable;
  saved.checkDailyBudget = transcriptionService.checkDailyBudget;
  saved.transcribeUrl = transcriptionService.transcribeUrl;
  saved.analyzeCall = callAnalyzer.analyzeCall;
  saved.analyzerStats = callAnalyzer.getStats;
  saved.getCall = mangoApiClient.getCall;
  saved.matchAndSetStatus = openDentalSync.matchAndSetStatus;

  clearStore();
  unifiedCallStore.requestPersist = () => {};
  unifiedCallStore.persist = async () => {};

  transcriptionService.isAvailable = () => true;
  transcriptionService.checkDailyBudget = () => ({ allowed: true, usedMinutes: 0, capMinutes: 120, remainingMinutes: 120 });
  transcriptionService.transcribeUrl = async () => ({ text: 'hello from the front desk', utterances: [], duration_seconds: 90 });
  callAnalyzer.analyzeCall = async () => ({ summary: 'Patient asked about a cleaning.', sentiment: 'positive', caller_name: 'Pat' });
  callAnalyzer.getStats = () => ({ estimatedCost: 0, totalAnalyses: 0, totalTokens: 0, isInitialized: true });
  mangoApiClient.getCall = async (id) => ({ id, recording_url: `https://signed.example/${id}.mp3` });
  // The matcher talks to Open Dental; this slice writes nothing there, so stub it out.
  openDentalSync.matchAndSetStatus = async () => ({ success: true });

  ledger._reset();
  onDemand._inFlight.clear();
});

afterEach(() => {
  unifiedCallStore.requestPersist = saved.requestPersist;
  unifiedCallStore.persist = saved.persist;
  transcriptionService.isAvailable = saved.isAvailable;
  transcriptionService.checkDailyBudget = saved.checkDailyBudget;
  transcriptionService.transcribeUrl = saved.transcribeUrl;
  callAnalyzer.analyzeCall = saved.analyzeCall;
  callAnalyzer.getStats = saved.analyzerStats;
  mangoApiClient.getCall = saved.getCall;
  openDentalSync.matchAndSetStatus = saved.matchAndSetStatus;
  clearStore();
  onDemand._inFlight.clear();
});

// --- happy path -------------------------------------------------------------

test('completed: transcribes, summarizes, persists, and reports minutes', async () => {
  const call = seedCall();
  let speechCalls = 0;
  transcriptionService.transcribeUrl = async () => {
    speechCalls++;
    return { text: 'hello from the front desk', utterances: [{ speaker: 0, text: 'hi' }], duration_seconds: 90 };
  };

  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.httpStatus, 200);
  assert.equal(res.outcome, 'completed');
  assert.equal(res.body.status, 'completed');
  assert.equal(res.body.transcript, 'hello from the front desk');
  assert.equal(res.body.summary, 'Patient asked about a cleaning.');
  assert.equal(res.body.minutesUsed, 1.5, '90s of audio = 1.5 min');
  assert.equal(speechCalls, 1);

  const stored = unifiedCallStore.getCall(call.id);
  assert.equal(stored.transcript, 'hello from the front desk');
  assert.equal(stored.summary, 'Patient asked about a cleaning.');
  assert.equal(stored.transcribe_source, 'on_demand');
  assert.deepEqual(stored.transcribed_by, ACTOR, 'the decision is attributed to the person who made it');
  assert.ok(stored.transcribed_at);
});

test('the in-flight lock is released after a successful run', async () => {
  const call = seedCall();
  await onDemand.transcribeCall(call.id, { actor: ACTOR });
  assert.equal(onDemand._inFlight.size, 0);
});

test('an unmatched call is run through the matcher with its freshly extracted name', async () => {
  const call = seedCall();
  const seen = [];
  openDentalSync.matchAndSetStatus = async (id, input) => { seen.push({ id, input }); return { status: 'matched' }; };
  callAnalyzer.analyzeCall = async () => ({ summary: 'S', sentiment: 'neutral', caller_name: 'Pat Sparkman' });

  await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].input.caller_name, 'Pat Sparkman', 'the name the summary just found');
});

test('a call whose patient a HUMAN already chose is never re-matched', async () => {
  // Re-running the auto-matcher over a human's Pick Patient choice could silently swap the
  // patient. Same rule the sync path follows for newly-added calls only.
  const call = seedCall();
  unifiedCallStore.updateCall(call.id, { od_patient_id: 4242, od_sync_status: 'matched' });
  let matcherRuns = 0;
  openDentalSync.matchAndSetStatus = async () => { matcherRuns++; return { status: 'matched' }; };

  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.body.status, 'completed', 'it still transcribes');
  assert.equal(matcherRuns, 0, 'but it does not touch the linkage');
  assert.equal(unifiedCallStore.getCall(call.id).od_patient_id, 4242);
});

test("a 'not a patient' close-out is left alone too", async () => {
  const call = seedCall();
  unifiedCallStore.updateCall(call.id, { not_a_patient: true, not_a_patient_reason: 'vendor' });
  let matcherRuns = 0;
  openDentalSync.matchAndSetStatus = async () => { matcherRuns++; return { status: 'matched' }; };

  await onDemand.transcribeCall(call.id, { actor: ACTOR });
  assert.equal(matcherRuns, 0);
});

// --- dedup ------------------------------------------------------------------

test('exists: an already-transcribed call is reused, with ZERO Azure spend', async () => {
  const call = seedCall({ transcript: 'already transcribed' });
  let speechCalls = 0;
  let detailFetches = 0;
  transcriptionService.transcribeUrl = async () => { speechCalls++; return { text: 'SHOULD NOT RUN' }; };
  mangoApiClient.getCall = async () => { detailFetches++; return { recording_url: 'x' }; };

  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.httpStatus, 200);
  assert.equal(res.body.status, 'exists');
  assert.equal(res.body.transcript, 'already transcribed');
  assert.equal(speechCalls, 0, 'never re-send an existing transcript to Speech');
  assert.equal(detailFetches, 0, 'not even a Mango round trip');
});

// --- in-flight lock ---------------------------------------------------------

test('in_progress: a second click while one is running is 409, and bills once', async () => {
  const call = seedCall();
  let speechCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  transcriptionService.transcribeUrl = async () => {
    speechCalls++;
    await gate;
    return { text: 'one transcript', utterances: [], duration_seconds: 60 };
  };

  const first = onDemand.transcribeCall(call.id, { actor: ACTOR });
  // Let the first request reach Azure Speech before the second click lands.
  await new Promise((r) => setImmediate(r));

  const second = await onDemand.transcribeCall(call.id, { actor: ACTOR });
  assert.equal(second.httpStatus, 409);
  assert.equal(second.body.status, 'in_progress');

  release();
  const firstResult = await first;
  assert.equal(firstResult.body.status, 'completed');
  assert.equal(speechCalls, 1, 'a double click must bill Azure Speech exactly once');
  assert.equal(onDemand._inFlight.size, 0, 'the lock is released in finally');
});

// --- the breaker ------------------------------------------------------------

test('budget_exhausted: 429 with resetsAt, and nothing is sent to Azure', async () => {
  const call = seedCall();
  transcriptionService.checkDailyBudget = () => ({ allowed: false, usedMinutes: 120, capMinutes: 120, remainingMinutes: 0 });
  let speechCalls = 0;
  let detailFetches = 0;
  transcriptionService.transcribeUrl = async () => { speechCalls++; return { text: 'x' }; };
  mangoApiClient.getCall = async () => { detailFetches++; return { recording_url: 'x' }; };

  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.httpStatus, 429);
  assert.equal(res.body.status, 'budget_exhausted');
  assert.equal(res.body.capMinutes, 120);
  assert.equal(res.body.usedMinutes, 120);
  assert.ok(res.body.resetsAt, 'the user must be told WHEN it resets');
  assert.ok(Number.isFinite(Date.parse(res.body.resetsAt)), 'resetsAt is a real instant');
  assert.ok(Date.parse(res.body.resetsAt) > Date.now(), 'resetsAt is in the future');
  assert.equal(speechCalls, 0);
  assert.equal(detailFetches, 0, 'a spent budget costs zero round trips');
});

test('budget_exhausted: the breaker firing MID-RUN is surfaced, never swallowed', async () => {
  // The pre-check passed, then a concurrent run spent the budget and the hard backstop
  // inside transcribeBuffer threw. That must still reach the user as a budget message.
  const call = seedCall();
  transcriptionService.transcribeUrl = async () => {
    const err = new Error('Transcription daily budget exceeded (120 min/day)');
    err.code = 'TRANSCRIPTION_BUDGET_EXCEEDED';
    throw err;
  };

  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.httpStatus, 429);
  assert.equal(res.body.status, 'budget_exhausted');
  assert.ok(res.body.resetsAt);
  assert.equal(unifiedCallStore.getCall(call.id).transcript, null, 'still transcribable tomorrow');
});

// --- missing recording ------------------------------------------------------

test('recording_not_ready: a YOUNG call with no recording is publish lag, retryable', async () => {
  const call = seedCall({ minutesAgo: 5 });
  mangoApiClient.getCall = async () => ({ recording_url: null });

  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.httpStatus, 422);
  assert.equal(res.body.status, 'recording_not_ready');
  assert.ok(res.body.retryAfterMinutes > 0);
});

test('recording_unavailable: an OLD call with no recording is gone from the phone system', async () => {
  const call = seedCall({ minutesAgo: 60 * 24 });
  mangoApiClient.getCall = async () => ({ recording_url: null });

  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.httpStatus, 422);
  assert.equal(res.body.status, 'recording_unavailable');
});

test('the not-ready / unavailable split lands on the RECORDING_LAG_MINUTES boundary', async () => {
  mangoApiClient.getCall = async () => ({ recording_url: null });
  const lag = onDemand.RECORDING_LAG_MINUTES;

  const young = seedCall({ id: 'mango_call_young', minutesAgo: lag - 1 });
  const old = seedCall({ id: 'mango_call_old', minutesAgo: lag + 1 });

  assert.equal((await onDemand.transcribeCall(young.id, {})).body.status, 'recording_not_ready');
  assert.equal((await onDemand.transcribeCall(old.id, {})).body.status, 'recording_unavailable');
});

// --- persistence ------------------------------------------------------------

test('a store persist failure is an ERROR, never a reported success', async () => {
  const call = seedCall();
  unifiedCallStore.persist = async () => { throw new Error('disk is full'); };

  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.httpStatus, 500);
  assert.equal(res.outcome, 'error');
  assert.equal(res.body.status, 'error');
  assert.notEqual(res.body.status, 'completed', 'never claim success we cannot show again');
});

test('a store update failure is an ERROR, never a reported success', async () => {
  const call = seedCall();
  unifiedCallStore.updateCall = () => null;
  try {
    const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });
    assert.equal(res.httpStatus, 500);
    assert.equal(res.body.status, 'error');
  } finally {
    delete unifiedCallStore.updateCall; // restore the prototype method
  }
});

// --- failures leave the row workable ---------------------------------------

test('a failed attempt leaves the call transcribable (the M3 seam)', async () => {
  const call = seedCall();
  transcriptionService.transcribeUrl = async () => { throw new Error('Azure Speech 503'); };

  const failed = await onDemand.transcribeCall(call.id, { actor: ACTOR });
  assert.equal(failed.outcome, 'error');
  assert.equal(unifiedCallStore.getCall(call.id).transcript, null, 'no half-written state');
  assert.equal(onDemand._inFlight.size, 0, 'the lock did not leak');

  // ...and the very next click works.
  transcriptionService.transcribeUrl = async () => ({ text: 'second time lucky', utterances: [], duration_seconds: 30 });
  const retry = await onDemand.transcribeCall(call.id, { actor: ACTOR });
  assert.equal(retry.body.status, 'completed');
  assert.equal(unifiedCallStore.getCall(call.id).transcript, 'second time lucky');
});

test('no_speech: Speech heard nothing — no empty transcript is stored', async () => {
  const call = seedCall();
  transcriptionService.transcribeUrl = async () => ({ text: '', utterances: [], duration_seconds: 12 });

  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.httpStatus, 422);
  assert.equal(res.body.status, 'no_speech');
  assert.equal(unifiedCallStore.getCall(call.id).transcript, null);
});

test('no_speech is REMEMBERED on the call — it already spent budget', async () => {
  // This is the one refusal that cost money. If the row goes back to looking idle, a
  // misclick re-bills the same silent recording, which breaks the button's promise that
  // an existing result is never re-billed. So it is persisted, and flagged to the client.
  const call = seedCall();
  transcriptionService.transcribeUrl = async () => ({ text: '', utterances: [], duration_seconds: 30 });

  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.body.alreadyBilled, true, 'the client must know this one cost money');

  const stored = unifiedCallStore.getCall(call.id);
  assert.equal(stored.transcribe_last_outcome, 'no_speech');
  assert.ok(stored.transcribe_last_attempt_at, 'and when');
  assert.deepEqual(stored.transcribe_last_attempt_by, ACTOR, 'and who');
  assert.equal(stored.transcript, null, 'still no transcript — the call stays workable');
  assert.equal(res.minutes, 0.5, 'the billed minutes are still counted against the budget');
});

test('a remembered no_speech survives a re-ingest of the same call', async () => {
  // The hourly sync re-ingests inside the watermark overlap and rebuilds the record through
  // normalizeCall's whitelist. Losing the marker there would silently re-arm the misclick.
  const call = seedCall();
  transcriptionService.transcribeUrl = async () => ({ text: '', utterances: [], duration_seconds: 30 });
  await onDemand.transcribeCall(call.id, { actor: ACTOR });

  unifiedCallStore.addMangoCalls([{
    external_id: call.external_id,
    caller_number: '4795551234',
    call_date: call.call_date,
    duration_seconds: 90,
  }]);

  assert.equal(unifiedCallStore.getCall(call.id).transcribe_last_outcome, 'no_speech');
});

test('a retry that DOES find speech clears the remembered no_speech', async () => {
  const call = seedCall();
  transcriptionService.transcribeUrl = async () => ({ text: '', utterances: [], duration_seconds: 30 });
  await onDemand.transcribeCall(call.id, { actor: ACTOR });
  assert.equal(unifiedCallStore.getCall(call.id).transcribe_last_outcome, 'no_speech');

  transcriptionService.transcribeUrl = async () => ({ text: 'there was speech after all', utterances: [], duration_seconds: 60 });
  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.body.status, 'completed');
  assert.equal(unifiedCallStore.getCall(call.id).transcribe_last_outcome, 'completed',
    'the row must stop warning about a silence that is no longer true');
});

test('a free refusal does NOT get the already-billed marker', async () => {
  // Only no_speech spent money. A budget refusal, a missing recording, an in-flight click:
  // all free, so none of them may make the next click ask for confirmation.
  const call = seedCall();
  transcriptionService.checkDailyBudget = () => ({ allowed: false, usedMinutes: 120, capMinutes: 120, remainingMinutes: 0 });

  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.body.status, 'budget_exhausted');
  assert.equal(res.body.alreadyBilled, undefined);
  assert.equal(unifiedCallStore.getCall(call.id).transcribe_last_outcome ?? null, null);
});

test('unavailable: Azure Speech unconfigured says so instead of failing obscurely', async () => {
  const call = seedCall();
  transcriptionService.isAvailable = () => false;

  const res = await onDemand.transcribeCall(call.id, { actor: ACTOR });

  assert.equal(res.httpStatus, 503);
  assert.equal(res.body.status, 'unavailable');
});

// --- lookup -----------------------------------------------------------------

test('not_found: an unknown id, and a non-Mango call, both 404', async () => {
  const missing = await onDemand.transcribeCall('nope', {});
  assert.equal(missing.httpStatus, 404);
  assert.equal(missing.body.status, 'not_found');

  unifiedCallStore.addRetellCall({ call_id: 'retell_1', from_number: '4795551234' });
  const retell = await onDemand.transcribeCall('retell_1', {});
  assert.equal(retell.httpStatus, 404, 'Retell transcripts come from Retell, not this button');
});

// --- the operational audit trail -------------------------------------------

test('the ledger records one row per attempt, with its outcome and minutes', async () => {
  const ok = seedCall({ id: 'mango_call_ok' });
  await onDemand.transcribeCall(ok.id, { actor: ACTOR });

  transcriptionService.checkDailyBudget = () => ({ allowed: false, usedMinutes: 120, capMinutes: 120, remainingMinutes: 0 });
  const broke = seedCall({ id: 'mango_call_broke' });
  await onDemand.transcribeCall(broke.id, { actor: ACTOR });

  const today = ledger.today();
  assert.equal(today.total, 2, 'every attempt is recorded, refusals included');
  assert.equal(today.completed, 1);
  assert.equal(today.minutes, 1.5);

  const recent = ledger.recent();
  assert.equal(recent.length, 2);
  assert.equal(recent[0].outcome, 'budget_exhausted', 'newest first');
  assert.equal(recent[0].actor, ACTOR.email);
  assert.equal(recent[1].outcome, 'completed');
  assert.equal(recent[1].minutes, 1.5);

  const month = ledger.month();
  assert.equal(month.transcriptions, 1);
  assert.equal(month.minutes, 1.5);
  assert.ok(month.speech_cost > 0, 'billed minutes carry a cost estimate');
});

test('a deduped click costs nothing in the ledger either', async () => {
  const call = seedCall({ transcript: 'already there' });
  await onDemand.transcribeCall(call.id, { actor: ACTOR });

  const today = ledger.today();
  assert.equal(today.total, 1);
  assert.equal(today.completed, 0);
  assert.equal(today.minutes, 0, 'a reuse bills zero minutes');
  assert.equal(ledger.month().speech_cost, 0);
});
