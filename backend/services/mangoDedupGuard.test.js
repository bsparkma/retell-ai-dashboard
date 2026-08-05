/**
 * Regression tests for the Mango transcription/analysis dedup guard
 * (cost-investigation #2/#4 — the re-transcription loop).
 *
 * The bug: mangoApiClient.fullSync transcribed EVERY answered call in the rolling
 * lookback window on EVERY poll (every 5 min in prod), with no check against the store
 * for an existing transcript — so the same calls were re-sent to Azure Speech until they
 * aged out. The fix reuses an existing transcript (keyed by external_id) and never re-bills.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Isolate durable state (the ingestion watermark, the budget accounting) in a temp dir so
// the suite neither reads nor writes the repo's data/ directory. Must be set before the
// modules below resolve CALLSTORE_DIR.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carein-dedup-'));
const SAVED_CALLSTORE_DIR = process.env.CALLSTORE_DIR;
process.env.CALLSTORE_DIR = TMP_DIR;

const unifiedCallStore = require('./unifiedCallStore');
const transcriptionService = require('./transcriptionService');
const ingestionWatermark = require('./ingestionWatermark');
const { MangoApiClient } = require('./mangoApiClient');

test.after(() => {
  if (SAVED_CALLSTORE_DIR === undefined) delete process.env.CALLSTORE_DIR;
  else process.env.CALLSTORE_DIR = SAVED_CALLSTORE_DIR;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

let savedRequestPersist;
let savedIsAvailable;
let savedTranscribeUrl;
let savedCheckBudget;

function clearStore() {
  unifiedCallStore.calls.clear();
  unifiedCallStore.bySource.retell.clear();
  unifiedCallStore.bySource.mango.clear();
  unifiedCallStore.byDate.clear();
  unifiedCallStore.byCallerNumber.clear();
}

beforeEach(() => {
  savedRequestPersist = unifiedCallStore.requestPersist;
  unifiedCallStore.requestPersist = () => {};
  clearStore();
  // Each test starts from a cold watermark (see ingestionWatermark.test.js for the
  // watermark's own coverage) so these dedup assertions stay independent of walk state.
  try { fs.unlinkSync(path.join(TMP_DIR, 'mango_ingestion_watermark.json')); } catch (_) {}
  ingestionWatermark._state.reset();

  savedIsAvailable = transcriptionService.isAvailable;
  savedTranscribeUrl = transcriptionService.transcribeUrl;
  savedCheckBudget = transcriptionService.checkDailyBudget;
  transcriptionService.isAvailable = () => true;
  transcriptionService.checkDailyBudget = () => ({ allowed: true, usedMinutes: 0, capMinutes: 120, remainingMinutes: 120 });
});

afterEach(() => {
  unifiedCallStore.requestPersist = savedRequestPersist;
  transcriptionService.isAvailable = savedIsAvailable;
  transcriptionService.transcribeUrl = savedTranscribeUrl;
  transcriptionService.checkDailyBudget = savedCheckBudget;
  clearStore();
});

/** A raw api.mangovoice.com /calls/ item that is ingestible + transcribable. */
function rawCall(id) {
  return {
    id,
    direction: 'inbound',
    type: 'standard',
    status: 'completed',
    is_missed: false,
    duration_in_seconds: 60,
    started_at: new Date().toISOString(),
    from: { caller_id: '4795551234' },
    to: { caller_id: '4790000000' },
  };
}

/** A MangoApiClient wired to fixed pages, with a spy on getCall/transcribeUrl. */
function makeClient(rawCalls) {
  const fakeAuth = { getToken: async () => 'Bearer test', invalidate() {}, async close() {} };
  const client = new MangoApiClient(fakeAuth);
  let getCallCount = 0;
  client.listCalls = async ({ offset = 0 } = {}) =>
    offset === 0
      ? { count: rawCalls.length, next: null, results: rawCalls }
      : { count: rawCalls.length, next: null, results: [] };
  client.getCall = async (id) => { getCallCount++; return { id, recording_url: `https://signed.example/${id}.mp3` }; };
  return { client, getCallCount: () => getCallCount };
}

test('findByExternalId returns the stored call (and undefined when absent)', () => {
  unifiedCallStore.addMangoCalls([
    { external_id: 'mango_call_1', caller_number: '4795551234', transcript: 'hello there', duration_seconds: 60 },
  ]);
  assert.equal(unifiedCallStore.findByExternalId('mango_call_1')?.transcript, 'hello there');
  assert.equal(unifiedCallStore.findByExternalId('mango_call_999'), undefined);
  assert.equal(unifiedCallStore.findByExternalId(''), undefined);
  assert.equal(unifiedCallStore.findByExternalId(undefined), undefined);
});

test('fullSync REUSES an existing transcript — never re-sends to Azure Speech', async () => {
  // Seed the store: this call was already transcribed on a prior sync.
  unifiedCallStore.addMangoCalls([
    { external_id: 'mango_call_1', caller_number: '4795551234', transcript: 'already transcribed', duration_seconds: 60 },
  ]);

  let transcribeCalls = 0;
  transcriptionService.transcribeUrl = async () => { transcribeCalls++; return { text: 'SHOULD NOT RUN' }; };

  const { client, getCallCount } = makeClient([rawCall(1)]);
  const result = await client.fullSync();

  assert.equal(transcribeCalls, 0, 'Azure Speech must NOT be called for an already-transcribed call');
  assert.equal(getCallCount(), 0, 'recording detail should not be fetched when reusing');
  assert.equal(result.recordings_reused, 1);
  assert.equal(result.recordings_transcribed, 0);
  assert.equal(result.calls[0].transcript, 'already transcribed');
});

test('fullSync transcribes a NEW call exactly once', async () => {
  let transcribeCalls = 0;
  transcriptionService.transcribeUrl = async () => { transcribeCalls++; return { text: 'fresh transcript', utterances: [] }; };

  const { client } = makeClient([rawCall(2)]);
  const result = await client.fullSync();

  assert.equal(transcribeCalls, 1, 'a never-seen call is transcribed once');
  assert.equal(result.recordings_transcribed, 1);
  assert.equal(result.recordings_reused, 0);
  assert.equal(result.calls[0].transcript, 'fresh transcript');
});

test('fullSync skips transcription (metadata only) when the daily budget is spent', async () => {
  transcriptionService.checkDailyBudget = () => ({ allowed: false, usedMinutes: 120, capMinutes: 120, remainingMinutes: 0 });
  let transcribeCalls = 0;
  transcriptionService.transcribeUrl = async () => { transcribeCalls++; return { text: 'x' }; };

  const { client } = makeClient([rawCall(3)]);
  const result = await client.fullSync();

  assert.equal(transcribeCalls, 0, 'budget spent → no Azure Speech call');
  assert.equal(result.transcription_skipped_budget, 1);
  assert.equal(result.calls_processed, 1, 'call metadata still ingested');
  assert.equal(result.calls[0].transcript ?? null, null);
});
