/**
 * Regression tests for the Mango ingestion watermark (diagnosis H3 — silent call loss)
 * and the per-office sync counters (item 5).
 *
 * The bug: fullSync re-asked Mango for "the newest 25 in the last 1 day" every hour with
 * no cursor. On a busy hour the 25-cap saturated and the overflow was never ingested at
 * all — no metadata, no worklist row, no button a human could ever click.
 *
 * The seam these tests protect (M4 depends on it): the watermark advances on successful
 * INGESTION only. A call that was ingested but NOT transcribed keeps its store row and
 * stays transcribable later.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Isolate durable state in a temp dir BEFORE anything resolves CALLSTORE_DIR.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carein-wm-'));
const SAVED_CALLSTORE_DIR = process.env.CALLSTORE_DIR;
process.env.CALLSTORE_DIR = TMP_DIR;

const unifiedCallStore = require('./unifiedCallStore');
const transcriptionService = require('./transcriptionService');
const ingestionWatermark = require('./ingestionWatermark');
const { MangoApiClient } = require('./mangoApiClient');

const HOUR = 60 * 60 * 1000;

let saved;

function clearStore() {
  unifiedCallStore.calls.clear();
  unifiedCallStore.bySource.retell.clear();
  unifiedCallStore.bySource.mango.clear();
  unifiedCallStore.byDate.clear();
  unifiedCallStore.byCallerNumber.clear();
}

function clearWatermark() {
  try { fs.unlinkSync(path.join(TMP_DIR, 'mango_ingestion_watermark.json')); } catch (_) {}
  ingestionWatermark._state.reset();
}

beforeEach(() => {
  saved = {
    requestPersist: unifiedCallStore.requestPersist,
    isAvailable: transcriptionService.isAvailable,
    transcribeUrl: transcriptionService.transcribeUrl,
    checkDailyBudget: transcriptionService.checkDailyBudget,
    maxPages: ingestionWatermark.MAX_PAGES,
  };
  unifiedCallStore.requestPersist = () => {};
  transcriptionService.isAvailable = () => true;
  transcriptionService.checkDailyBudget = () => ({ allowed: true, usedMinutes: 0, capMinutes: 120, remainingMinutes: 120 });
  transcriptionService.transcribeUrl = async () => ({ text: 'transcript', utterances: [] });
  clearStore();
  clearWatermark();
});

afterEach(() => {
  unifiedCallStore.requestPersist = saved.requestPersist;
  transcriptionService.isAvailable = saved.isAvailable;
  transcriptionService.transcribeUrl = saved.transcribeUrl;
  transcriptionService.checkDailyBudget = saved.checkDailyBudget;
  ingestionWatermark.MAX_PAGES = saved.maxPages;
  clearStore();
  clearWatermark();
});

test.after(() => {
  if (SAVED_CALLSTORE_DIR === undefined) delete process.env.CALLSTORE_DIR;
  else process.env.CALLSTORE_DIR = SAVED_CALLSTORE_DIR;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

/**
 * A raw api.mangovoice.com /calls/ item. `to` is a real Roland DID by default so office
 * attribution resolves; pass `to` to move it to another office.
 */
function rawCall(id, startedAtMs, over = {}) {
  return {
    id,
    direction: 'inbound',
    type: 'standard',
    status: 'completed',
    is_missed: false,
    duration_in_seconds: 60,
    started_at: new Date(startedAtMs).toISOString(),
    from: { caller_id: '4795551234' },
    to: { caller_id: '9185036262' }, // roland
    ...over,
  };
}

/** A MangoApiClient wired to a fixed newest-first list, paged the way the real API pages. */
function makeClient(rawCalls, opts = {}) {
  const fakeAuth = { getToken: async () => 'Bearer test', invalidate() {}, async close() {} };
  const client = new MangoApiClient(fakeAuth);
  const pageSize = 50;
  let listCallsCount = 0;
  let getCallCount = 0;
  client.listCalls = async ({ offset = 0 } = {}) => {
    listCallsCount++;
    return { count: rawCalls.length, next: null, results: rawCalls.slice(offset, offset + pageSize) };
  };
  client.getCall = async (id) => {
    getCallCount++;
    if (opts.noRecording) return { id, recording_url: null };
    return { id, recording_url: `https://signed.example/${id}.mp3` };
  };
  return { client, listCallsCount: () => listCallsCount, getCallCount: () => getCallCount };
}

// ── Cold start ──────────────────────────────────────────────────────────────────────

test('cold start: no stored watermark → falls back to the sinceDays window and initializes', async () => {
  const now = Date.now();
  assert.equal(ingestionWatermark.get().startedAt, null, 'precondition: no watermark');

  const { client } = makeClient([
    rawCall(1, now - 1 * HOUR),
    rawCall(2, now - 2 * HOUR),
    rawCall(3, now - 40 * HOUR), // outside the 1-day fallback window
  ]);
  const result = await client.fullSync({ sinceDays: 1, maxCalls: 100 });

  assert.equal(result.cold_start, true);
  assert.equal(result.watermark_before, null);
  assert.equal(result.calls_processed, 2, 'only calls inside the fallback window are ingested');
  assert.equal(result.watermark_after, new Date(now - 1 * HOUR).toISOString(),
    'watermark initializes to the newest ingested call');
});

// ── Advance + overlap ───────────────────────────────────────────────────────────────

test('watermark advances to the newest ingested call and is monotonic', async () => {
  const now = Date.now();
  ingestionWatermark.advance(new Date(now - 5 * HOUR).toISOString());

  const { client } = makeClient([rawCall(10, now - 1 * HOUR), rawCall(11, now - 2 * HOUR)]);
  const result = await client.fullSync();

  assert.equal(result.watermark_after, new Date(now - 1 * HOUR).toISOString());

  // An older timestamp must never pull it backwards.
  assert.equal(
    ingestionWatermark.advance(new Date(now - 9 * HOUR).toISOString()),
    new Date(now - 1 * HOUR).toISOString(),
  );
});

test('the walk stops at watermark − OVERLAP, and re-ingesting inside the overlap is idempotent', async () => {
  const now = Date.now();
  const overlapH = ingestionWatermark.OVERLAP_MS / HOUR;
  assert.ok(overlapH >= 1, 'overlap should be at least an hour');

  // Watermark 1h ago → floor is (1 + overlap) hours ago.
  ingestionWatermark.advance(new Date(now - 1 * HOUR).toISOString());

  const inside = rawCall(20, now - (overlapH + 0.5) * HOUR); // above the floor
  const outside = rawCall(21, now - (overlapH + 5) * HOUR);  // below the floor
  const fresh = rawCall(22, now - 0.5 * HOUR);

  const first = await makeClient([fresh, inside, outside]).client.fullSync();
  assert.equal(first.calls_processed, 2, 'the overlap re-covers the call just below the watermark');
  assert.equal(first.walk_complete, true);

  // Store what the first sync produced, then re-run: the overlap re-fetches the same calls
  // and the store must upsert them rather than duplicate.
  unifiedCallStore.addMangoCalls(first.calls);
  const before = unifiedCallStore.bySource.mango.size;

  const second = await makeClient([fresh, inside, outside]).client.fullSync();
  unifiedCallStore.addMangoCalls(second.calls);

  assert.equal(unifiedCallStore.bySource.mango.size, before, 'overlap re-ingest is idempotent (dedup on external_id)');
  assert.equal(second.recordings_reused, 2, 'and the transcripts are reused, not re-billed');
});

test('a busy hour above the old 25-call cap is ingested in full (H3)', async () => {
  const now = Date.now();
  ingestionWatermark.advance(new Date(now - 1 * HOUR).toISOString());

  // 60 calls in the window — more than one page and far more than MANGO_MAX_CALLS_PER_SYNC.
  const calls = Array.from({ length: 60 }, (_, i) => rawCall(100 + i, now - i * 60 * 1000));
  const { client } = makeClient(calls);

  // maxCalls is what USED to truncate the walk. It must not truncate a watermarked walk.
  const result = await client.fullSync({ maxCalls: 25 });

  assert.equal(result.calls_processed, 60, 'every call above the floor is ingested');
  assert.equal(result.walk_complete, true);
  assert.equal(result.page_cap_hit, false);
});

// ── Page cap ────────────────────────────────────────────────────────────────────────

test('page cap hit: flagged, logged, and the watermark is HELD (no silent truncation)', async () => {
  const now = Date.now();
  const watermark = new Date(now - 1 * HOUR).toISOString();
  ingestionWatermark.advance(watermark);

  ingestionWatermark.MAX_PAGES = 2; // 2 pages × 50 = 100 of the 150 available

  // 150 calls, all above the floor → the walk can never reach it within 2 pages.
  const calls = Array.from({ length: 150 }, (_, i) => rawCall(200 + i, now - i * 1000));
  const { client } = makeClient(calls);

  const logged = [];
  const savedError = console.error;
  console.error = (msg) => logged.push(String(msg));
  let result;
  try {
    result = await client.fullSync();
  } finally {
    console.error = savedError;
  }

  assert.equal(result.page_cap_hit, true);
  assert.equal(result.walk_complete, false);
  assert.equal(result.pages_fetched, 2);
  assert.equal(result.calls_scanned, 100);
  assert.equal(result.watermark_after, watermark, 'watermark HELD so the next sync re-walks the same floor');
  assert.equal(ingestionWatermark.get().startedAt, watermark);

  const capLine = logged.find((l) => l.includes('PAGE CAP HIT'));
  assert.ok(capLine, 'the cap must be logged explicitly, never silently');
  assert.ok(capLine.includes('up to 50 older calls left UNFETCHED'), 'the log states the count left unfetched');
});

// ── THE M4 SEAM ─────────────────────────────────────────────────────────────────────

test('M4 SEAM: transcription failure does not lose the call and does not corrupt the watermark', async () => {
  const now = Date.now();
  ingestionWatermark.advance(new Date(now - 1 * HOUR).toISOString());

  // Azure Speech throws for every call in this batch.
  transcriptionService.transcribeUrl = async () => { throw new Error('Azure Speech transcription failed: 503'); };

  const newest = now - 5 * 60 * 1000;
  const { client } = makeClient([rawCall(300, newest), rawCall(301, now - 10 * 60 * 1000)]);
  const result = await client.fullSync();

  assert.equal(result.recordings_transcribed, 0);
  assert.equal(result.calls_processed, 2, 'both calls are still INGESTED');
  assert.equal(result.calls[0].transcript ?? null, null, 'and are stored without a transcript');

  // Ingestion succeeded, so the watermark advances — it is never gated on transcription.
  assert.equal(result.watermark_after, new Date(newest).toISOString());

  // The rows survive in the store and are still transcribable later (M4's button).
  unifiedCallStore.addMangoCalls(result.calls);
  const stored = unifiedCallStore.findByExternalId('mango_call_300');
  assert.ok(stored, 'the call has a store row');
  assert.equal(stored.transcript ?? null, null, 'with no transcript, so it stays a transcribe candidate');
});

test('M4 SEAM: a budget-skipped call keeps its row and stays transcribable', async () => {
  const now = Date.now();
  ingestionWatermark.advance(new Date(now - 1 * HOUR).toISOString());
  transcriptionService.checkDailyBudget = () => ({ allowed: false, usedMinutes: 120, capMinutes: 120, remainingMinutes: 0 });

  const newest = now - 2 * 60 * 1000;
  const { client, getCallCount } = makeClient([rawCall(400, newest)]);
  const result = await client.fullSync();

  assert.equal(result.transcription_skipped_budget, 1);
  assert.equal(getCallCount(), 0, 'budget spent → the recording detail is not even fetched');
  assert.equal(result.calls_processed, 1);
  assert.equal(result.watermark_after, new Date(newest).toISOString(), 'ingestion still advances the watermark');

  unifiedCallStore.addMangoCalls(result.calls);
  assert.equal(unifiedCallStore.findByExternalId('mango_call_400').transcript ?? null, null);
});

// ── Per-office counters (item 5) ────────────────────────────────────────────────────

test('per-office counters sum to the batch total and close the accounting', async () => {
  const now = Date.now();
  ingestionWatermark.advance(new Date(now - 1 * HOUR).toISOString());

  const rolandDid = { caller_id: '9185036262' };
  const valleyDid = { caller_id: '4797854390' };

  unifiedCallStore.addMangoCalls([
    { external_id: 'mango_call_501', caller_number: '4795551234', transcript: 'already done', duration_seconds: 60 },
  ]);

  const { client } = makeClient([
    rawCall(500, now - 1 * 60 * 1000, { to: rolandDid }),                            // transcribed
    rawCall(501, now - 2 * 60 * 1000, { to: rolandDid }),                            // reused
    rawCall(502, now - 3 * 60 * 1000, { to: rolandDid, is_missed: true }),           // missed
    rawCall(503, now - 4 * 60 * 1000, { to: valleyDid, duration_in_seconds: 2 }),    // too_short
    rawCall(504, now - 5 * 60 * 1000, { to: valleyDid }),                            // transcribed
    rawCall(505, now - 6 * 60 * 1000, { to: { caller_id: 'ring-group' } }),          // unknown office, no DID
  ]);
  const result = await client.fullSync();

  const roland = result.by_office.roland;
  const valley = result.by_office.valley;
  const unknown = result.by_office.unknown;

  assert.equal(roland.ingested, 3);
  assert.equal(roland.transcribed, 1);
  assert.equal(roland.reused, 1);
  assert.equal(roland.missed, 1);
  assert.equal(valley.ingested, 2);
  assert.equal(valley.too_short, 1);
  assert.equal(valley.transcribed, 1);
  assert.equal(unknown.ingested, 1);
  assert.equal(result.no_did, 1, 'the ring-group party yields no usable DID and is counted per sync');

  // Every ingested call lands in exactly one outcome bucket.
  const closed = (o) =>
    o.transcribed + o.reused + o.budget_skipped + o.no_recording +
    o.missed + o.too_short + o.errors + o.unavailable + o.empty;
  let total = 0;
  for (const key of Object.keys(result.by_office)) {
    const o = result.by_office[key];
    assert.equal(closed(o), o.ingested, `office '${key}' accounting must be closed`);
    total += o.ingested;
  }
  assert.equal(total, result.calls_processed, 'per-office counters sum to the batch total');
});

test('a missing recording_url is counted and aged, not silently skipped (H7)', async () => {
  const now = Date.now();
  ingestionWatermark.advance(new Date(now - 3 * HOUR).toISOString());

  const { client } = makeClient(
    [
      rawCall(600, now - 5 * 60 * 1000),   // <15m old
      rawCall(601, now - 30 * 60 * 1000),  // 15-60m old
      rawCall(602, now - 130 * 60 * 1000), // >60m old
    ],
    { noRecording: true },
  );
  const result = await client.fullSync();

  assert.equal(result.recordings_missing, 3);
  assert.equal(result.recordings_transcribed, 0);
  const age = result.by_office.roland.no_recording_age;
  assert.deepEqual(age, { lt15m: 1, m15to60: 1, gt60m: 1, unknown: 0 });
  assert.equal(result.by_office.roland.no_recording, 3);
  assert.equal(result.calls_processed, 3, 'they are still ingested — only the transcript is missing');
});

test('the office key is attached in-flight but never persisted (office stays read-time derived)', async () => {
  const now = Date.now();
  ingestionWatermark.advance(new Date(now - 1 * HOUR).toISOString());

  const { client } = makeClient([rawCall(700, now - 60 * 1000)]);
  const result = await client.fullSync();

  assert.equal(result.calls[0].office_id, 'roland', 'available in-flight for counters/logging');
  unifiedCallStore.addMangoCalls(result.calls);
  const stored = unifiedCallStore.findByExternalId('mango_call_700');
  assert.equal(stored.office_id, undefined, 'normalizeCall whitelists fields — office is never stored');
  assert.equal(stored.called_number, '9185036262', 'the DID it is derived from IS stored');
});
