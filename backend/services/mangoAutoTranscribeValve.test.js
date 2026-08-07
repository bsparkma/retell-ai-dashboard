'use strict';

/**
 * MANGO_AUTO_TRANSCRIBE — the auto-transcription valve (Mango slice M4, D1-REVISED).
 *
 * Transcription stops being automatic. The critical property is that turning it off costs
 * us NOTHING in coverage: ingestion is untouched, so every call still gets a store row and
 * the M3 watermark still advances — which is exactly what makes the on-demand button able
 * to reach any call, at any time, including ones the old auto pipeline missed.
 *
 * The accounting must stay honest too: calls skipped because the valve is off are counted
 * under `auto_off`, NOT `budget_skipped`. Collapsing them would hide a breaker firing
 * behind a policy setting.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carein-valve-'));
const SAVED_CALLSTORE_DIR = process.env.CALLSTORE_DIR;
process.env.CALLSTORE_DIR = TMP_DIR;

const unifiedCallStore = require('./unifiedCallStore');
const transcriptionService = require('./transcriptionService');
const ingestionWatermark = require('./ingestionWatermark');
const mangoConfig = require('../config/mango');
const { MangoApiClient } = require('./mangoApiClient');

test.after(() => {
  if (SAVED_CALLSTORE_DIR === undefined) delete process.env.CALLSTORE_DIR;
  else process.env.CALLSTORE_DIR = SAVED_CALLSTORE_DIR;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const saved = {};

function clearStore() {
  unifiedCallStore.calls.clear();
  unifiedCallStore.bySource.retell.clear();
  unifiedCallStore.bySource.mango.clear();
  unifiedCallStore.byDate.clear();
  unifiedCallStore.byCallerNumber.clear();
}

/** A raw /calls/ row that is ingestible AND would be transcribed if auto were on. */
function rawCall(id, startedAt = new Date().toISOString()) {
  return {
    id,
    direction: 'inbound',
    type: 'standard',
    status: 'completed',
    is_missed: false,
    duration_in_seconds: 60,
    started_at: startedAt,
    from: { caller_id: '4795551234' },
    to: { caller_id: '4790000000' },
  };
}

function makeClient(rawCalls) {
  const client = new MangoApiClient({ getToken: async () => 'Bearer test', invalidate() {}, async close() {} });
  client.listCalls = async ({ offset = 0 } = {}) =>
    offset === 0
      ? { count: rawCalls.length, next: null, results: rawCalls }
      : { count: rawCalls.length, next: null, results: [] };
  client.getCall = async (id) => ({ id, recording_url: `https://signed.example/${id}.mp3` });
  return client;
}

beforeEach(() => {
  saved.requestPersist = unifiedCallStore.requestPersist;
  saved.isAvailable = transcriptionService.isAvailable;
  saved.transcribeUrl = transcriptionService.transcribeUrl;
  saved.checkDailyBudget = transcriptionService.checkDailyBudget;
  saved.autoTranscribe = mangoConfig.autoTranscribe;

  unifiedCallStore.requestPersist = () => {};
  clearStore();
  try { fs.unlinkSync(path.join(TMP_DIR, 'mango_ingestion_watermark.json')); } catch (_) {}
  ingestionWatermark._state.reset();

  transcriptionService.isAvailable = () => true;
  transcriptionService.checkDailyBudget = () => ({ allowed: true, usedMinutes: 0, capMinutes: 120, remainingMinutes: 120 });
});

afterEach(() => {
  unifiedCallStore.requestPersist = saved.requestPersist;
  transcriptionService.isAvailable = saved.isAvailable;
  transcriptionService.transcribeUrl = saved.transcribeUrl;
  transcriptionService.checkDailyBudget = saved.checkDailyBudget;
  mangoConfig.autoTranscribe = saved.autoTranscribe;
  clearStore();
});

test('the valve DEFAULTS to off — automatic transcription is opt-in, per release M4', () => {
  // config/mango.js reads MANGO_AUTO_TRANSCRIBE at require time. Neither staging nor prod
  // sets it, so the deployed default is what this asserts.
  const raw = process.env.MANGO_AUTO_TRANSCRIBE;
  const expected = String(raw ?? '').trim().toLowerCase() === 'true';
  assert.equal(saved.autoTranscribe, expected);
  if (raw === undefined) assert.equal(saved.autoTranscribe, false, 'unset must mean OFF');
});

test('auto OFF: calls are ingested but NOTHING is sent to Azure Speech', async () => {
  mangoConfig.autoTranscribe = false;
  let speechCalls = 0;
  let detailFetches = 0;
  transcriptionService.transcribeUrl = async () => { speechCalls++; return { text: 'x' }; };

  const client = makeClient([rawCall(1), rawCall(2)]);
  client.getCall = async (id) => { detailFetches++; return { id, recording_url: 'x' }; };
  const result = await client.fullSync();

  assert.equal(speechCalls, 0, 'the whole point of the slice');
  assert.equal(detailFetches, 0, 'not even a recording-detail round trip');
  assert.equal(result.calls_processed, 2, 'ingestion is UNTOUCHED — every call still gets a row');
  assert.equal(result.transcription_skipped_auto_off, 2);
  assert.equal(result.transcription_skipped_budget, 0, 'a policy is not a breaker');
  assert.equal(result.recordings_transcribed, 0);
  assert.equal(result.calls[0].transcript ?? null, null);
});

test('auto OFF: the per-office auto_off counter is populated, budget_skipped is not', async () => {
  mangoConfig.autoTranscribe = false;
  const client = makeClient([rawCall(3)]);
  const result = await client.fullSync();

  const offices = Object.values(result.by_office);
  assert.equal(offices.length, 1);
  assert.equal(offices[0].auto_off, 1);
  assert.equal(offices[0].budget_skipped, 0);
  assert.equal(offices[0].transcribed, 0);
  assert.equal(offices[0].ingested, 1);
  // Every ingested call lands in exactly one outcome bucket — the closed-set invariant.
  const buckets = offices[0].transcribed + offices[0].reused + offices[0].auto_off
    + offices[0].budget_skipped + offices[0].no_recording + offices[0].missed
    + offices[0].too_short + offices[0].errors + offices[0].unavailable + offices[0].empty;
  assert.equal(buckets, offices[0].ingested);
});

test('auto OFF: the M3 watermark STILL ADVANCES — this is the on-demand seam', async () => {
  mangoConfig.autoTranscribe = false;
  const started = new Date(Date.now() - 10 * 60_000).toISOString();

  assert.equal(ingestionWatermark.get().startedAt, null, 'cold start');
  const result = await makeClient([rawCall(4, started)]).fullSync();

  assert.equal(Date.parse(result.watermark_after), Date.parse(started));
  assert.equal(Date.parse(ingestionWatermark.get().startedAt), Date.parse(started));
  assert.equal(result.walk_complete, true);
});

test('auto ON: the legacy behaviour is unchanged — the valve is reversible', async () => {
  mangoConfig.autoTranscribe = true;
  let speechCalls = 0;
  transcriptionService.transcribeUrl = async () => {
    speechCalls++;
    return { text: 'transcribed automatically', utterances: [], duration_seconds: 60 };
  };

  const result = await makeClient([rawCall(5)]).fullSync();

  assert.equal(speechCalls, 1);
  assert.equal(result.recordings_transcribed, 1);
  assert.equal(result.transcription_skipped_auto_off, 0);
  assert.equal(result.calls[0].transcript, 'transcribed automatically');
});

test('auto OFF does not steal calls from the missed / too-short buckets', async () => {
  // auto_off must count exactly what auto WOULD have billed, so "what is the valve saving
  // us?" is answerable from the log. Calls that were never eligible keep their own bucket.
  mangoConfig.autoTranscribe = false;
  const missed = { ...rawCall(6), is_missed: true };
  const tooShort = { ...rawCall(7), duration_in_seconds: 2 };

  const result = await makeClient([missed, tooShort, rawCall(8)]).fullSync();

  const o = Object.values(result.by_office)[0];
  assert.equal(o.missed, 1);
  assert.equal(o.too_short, 1);
  assert.equal(o.auto_off, 1, 'only the one call auto would actually have transcribed');
  assert.equal(result.transcription_skipped_auto_off, 1);
});

test('auto OFF still REUSES an existing transcript rather than re-counting it', async () => {
  mangoConfig.autoTranscribe = false;
  unifiedCallStore.addMangoCalls([
    { external_id: 'mango_call_9', caller_number: '4795551234', transcript: 'from an earlier run', duration_seconds: 60 },
  ]);

  const result = await makeClient([rawCall(9)]).fullSync();

  assert.equal(result.recordings_reused, 1);
  assert.equal(result.transcription_skipped_auto_off, 0, 'a reuse is not a skip');
  assert.equal(result.calls[0].transcript, 'from an earlier run');
});
