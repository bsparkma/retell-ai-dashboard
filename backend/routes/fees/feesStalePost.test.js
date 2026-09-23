'use strict';

/**
 * THE STALE-'posting' TAKEOVER: a batch whose container was hard-killed
 * mid-post must not be stuck forever.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE HOLE THIS CLOSES
 * ═════════════════════════════════════════════════════════════════════════════
 * Every handled failure inside `runPost` lands the batch in 'post_failed',
 * which is resumable — the catch-block path was always fine. A SIGKILL is not a
 * handled failure: a deploy or an OOM runs no handler at all, so the row is
 * left saying 'posting' with nothing alive to finish it. And
 * `claimBatchForPosting` accepted only 'ready' and 'post_failed', with nothing
 * anywhere resetting a stale 'posting'.
 *
 * So a deploy during a post produced a batch that could be neither continued
 * nor rolled back, with some unknown number of fees already in a live
 * practice's fee schedule. That is the worst state this module can reach, and
 * it needed no bug to trigger — only a release at the wrong minute.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THESE TESTS DRIVE THE FUNCTION, NOT THE ROUTE
 * ═════════════════════════════════════════════════════════════════════════════
 * The property under test IS the WHERE clause — which states it accepts, and
 * that two racing claims still resolve to one winner. Going through HTTP would
 * put a route's own preconditions in front of the single statement that
 * matters, and a green test would then prove something weaker than it claimed.
 *
 * `FakeFeesDb` honours the new condition exactly, including the
 * `posting_started_at IS NOT NULL`, so reverting the clause in `postJob.js`
 * turns these red rather than leaving them passing on a permissive fake.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const postJob = require('../../services/fees/postJob');
const { FakeFeesDb } = require('./feesTestUtils');

const BATCH_ID = '33333333-3333-4333-8333-333333333333';

/** A batch row in whatever posting state a test needs. */
function seedBatch(db, over = {}) {
  const row = {
    batch_id: BATCH_ID,
    office: 'roland',
    filename: 'northstar.pdf',
    status: 'posting',
    row_count: 500,
    rows_written: 299,
    od_feesched_num: 55,
    od_feesched_desc: 'Northstar PPO 2026',
    od_feesched_is_new: false,
    post_error: null,
    posting_started_at: new Date(),
    posted_at: null,
    posted_by: 'manager@carein.ai',
    rolled_back_at: null,
    rolled_back_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
  db.table('fees_import_batch').push(row);
  return row;
}

/** `ms` milliseconds ago. */
const agoMs = (ms) => new Date(Date.now() - ms);

const claim = (db, actor = 'other@carein.ai') =>
  postJob.claimBatchForPosting(db, 'roland', BATCH_ID, actor);

// ─── Refused ────────────────────────────────────────────────────────────────

test('a FRESH posting row is refused — a live run is never taken over', async () => {
  const db = new FakeFeesDb();
  seedBatch(db, { posting_started_at: agoMs(60_000) });

  const res = await claim(db);

  assert.equal(res.ok, false);
  assert.equal(res.code, 'BATCH_NOT_POSTABLE');
  // And the row is untouched. Two writers on one practice's fee schedule is the
  // failure this refusal exists to prevent, and it would be worse than the
  // stuck batch the takeover fixes.
  const batch = db.table('fees_import_batch')[0];
  assert.equal(batch.status, 'posting');
  assert.equal(batch.post_error, null);
});

test('a posting row just INSIDE the threshold is still refused', async () => {
  // The boundary, from the safe side. A run at 29 minutes of a documented
  // ~20-minute worst case is slow, not dead.
  const db = new FakeFeesDb();
  seedBatch(db, { posting_started_at: agoMs(postJob.STALE_POSTING_MS - 60_000) });

  const res = await claim(db);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BATCH_NOT_POSTABLE');
});

test('a posting row with NO recorded start time is never taken over', async () => {
  // Fails closed: the comparison yields NULL, which is not TRUE. That state
  // should not exist, and guessing that a run with no recorded start is dead is
  // worse than leaving it for a human.
  const db = new FakeFeesDb();
  seedBatch(db, { posting_started_at: null });

  const res = await claim(db);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BATCH_NOT_POSTABLE');
});

test('a POSTED batch is never taken over, however old', async () => {
  // 'posted' is finished, not stalled. Re-posting would rewrite every fee for
  // no reason, and age is not evidence of anything here.
  const db = new FakeFeesDb();
  seedBatch(db, {
    status: 'posted',
    posted_at: agoMs(postJob.STALE_POSTING_MS * 10),
    posting_started_at: agoMs(postJob.STALE_POSTING_MS * 10),
  });

  const res = await claim(db);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BATCH_NOT_POSTABLE');
});

// ─── Claimed ────────────────────────────────────────────────────────────────

test('THE FIX: a STALE posting row is claimed, and the takeover is recorded', async () => {
  const db = new FakeFeesDb();
  const before = agoMs(postJob.STALE_POSTING_MS + 60_000);
  seedBatch(db, { posting_started_at: before });

  const res = await claim(db);

  assert.equal(res.ok, true);
  assert.equal(res.tookOver, true, 'and it knows it was a takeover, not a first claim');

  const batch = db.table('fees_import_batch')[0];
  assert.equal(batch.status, 'posting');
  // The clock restarts, so the new run gets its own full window.
  assert.ok(batch.posting_started_at.getTime() > before.getTime());

  // The run is EXPLAINABLE: the note says what happened, and that the fees the
  // dead run wrote are verified rather than written twice.
  assert.ok(batch.post_error.startsWith(postJob.TAKEOVER_NOTE));
  assert.match(batch.post_error, /stopped responding/i);
  assert.match(batch.post_error, /not written twice/i);
  assert.match(batch.post_error, /never finished/);

  // Attribution is NOT overwritten. Whoever authorised the post still did; a
  // takeover is not a second authorisation.
  assert.equal(batch.posted_by, 'manager@carein.ai');
  // And what the dead run already wrote is left alone for the resume to verify.
  assert.equal(batch.rows_written, 299);
});

test('an ordinary resume is not a takeover, and clears the previous error', async () => {
  // The other half of the CASE. A resume's banner must describe THIS attempt
  // rather than inheriting the last one's reason for stopping.
  const db = new FakeFeesDb();
  seedBatch(db, {
    status: 'post_failed',
    post_error: 'Stopped at D2740: Open Dental refused the fee',
    posting_started_at: agoMs(postJob.STALE_POSTING_MS + 60_000),
  });

  const res = await claim(db);

  assert.equal(res.ok, true);
  assert.equal(res.tookOver, false, 'a post_failed resume is not a takeover');
  assert.equal(db.table('fees_import_batch')[0].post_error, null);
});

test('a ready batch still claims normally, with no takeover note', async () => {
  const db = new FakeFeesDb();
  seedBatch(db, { status: 'ready', rows_written: 0, posting_started_at: null, posted_by: null });

  const res = await claim(db, 'manager@carein.ai');

  assert.equal(res.ok, true);
  assert.equal(res.tookOver, false);
  const batch = db.table('fees_import_batch')[0];
  assert.equal(batch.post_error, null);
  assert.equal(batch.posted_by, 'manager@carein.ai', 'a first claim DOES stamp attribution');
});

// ─── The race ───────────────────────────────────────────────────────────────

test('TWO RACING takeovers of the same stale row produce exactly ONE winner', async () => {
  // The whole reason the stale clause lives INSIDE the claim's single
  // conditional UPDATE rather than in a preceding "unstick it" statement. Two
  // containers noticing the same dead run at the same moment must not both
  // start writing into one practice's fee schedule.
  const db = new FakeFeesDb();
  seedBatch(db, { posting_started_at: agoMs(postJob.STALE_POSTING_MS + 60_000) });

  const [first, second] = await Promise.all([claim(db, 'a@carein.ai'), claim(db, 'b@carein.ai')]);

  const winners = [first, second].filter((r) => r.ok);
  const losers = [first, second].filter((r) => !r.ok);
  assert.equal(winners.length, 1, 'exactly one claim may win');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, 'BATCH_NOT_POSTABLE');

  // The loser lost because the winner's claim made the row fresh again — the
  // same mechanism that refuses a claim on a live run, which is precisely why
  // it is one statement.
  assert.equal(db.table('fees_import_batch')[0].status, 'posting');
});

// ─── The constant ───────────────────────────────────────────────────────────

test('the threshold sits comfortably past the worst-case run it documents', () => {
  // A stale window SHORTER than the longest post the module can issue would
  // take over runs that are merely slow — the failure worth avoiding, and the
  // one a well-meaning "make it snappier" edit would introduce.
  assert.ok(
    postJob.STALE_POSTING_MS >= 30 * 60 * 1000,
    'the documented worst case is ~20 minutes; do not tune below it'
  );
});
