'use strict';

/**
 * Who asked for the post, and what a post that writes nothing is called.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE BUG THESE STAND OVER
 * ═════════════════════════════════════════════════════════════════════════════
 * `claimBatchForPosting` used to record the requester by writing `posted_by` at
 * claim time, with `posted_at IS NULL` in its own WHERE. That is exactly the row
 * `fees_import_batch_posted_pair_check` forbids, so the statement threw on the
 * FIRST post of EVERY batch — the job died at its first database write, before
 * the backup, the code map and the write loop. Fee posting had never
 * successfully written a fee when this was found on staging.
 * (docs/reports/fees-post-failure-recon.md.)
 *
 * The suite did not catch it because `FakeFeesDb` enforced the batch table's
 * CHECKs only at INSERT. It now enforces all of them after every mutation, from
 * one named list — so restoring the old statement turns eighteen tests red with
 * the same message Postgres raised in production.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS ASSERTED HERE
 * ═════════════════════════════════════════════════════════════════════════════
 *  1. The claim stamps `post_requested_by` and leaves BOTH halves of the
 *     completed-post pair empty.
 *  2. `markPosted` lands the pair together, attributed to the ORIGINAL
 *     requester — not to whoever's container resumed or took the run over.
 *  3. A run that can only ever write nothing ends `post_failed` with a reason,
 *     never `posted`. A cheerful lie is worse than a grim one: nobody
 *     investigates a success.
 *
 * NO REAL PATIENT DATA — a fee schedule carries procedure codes and money and
 * never a patient.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { withApp, api, filePart, fakeOd, waitForStatus, FakeFeesDb } = require('./feesTestUtils');
const fx = require('../../services/fees/feeFixtures');
const postJob = require('../../services/fees/postJob');

const PDF = 'application/pdf';

const CODE_NUMS = { D0120: 11, D0150: 12, D0210: 13, D1110: 14, D2740: 15, D4341: 16 };
const SCHEDULES = [
  { feeSchedNum: 55, description: 'Northstar PPO 2026', feeSchedType: 'Normal', isHidden: false, isGlobal: true },
];

async function uploadClean(app, office = 'roland') {
  const res = await api(app.baseUrl, 'POST', `/api/fees/imports?office=${office}`, {
    body: filePart(fx.syntheticFeePdf(fx.PDF_CLEAN), 'northstar.pdf', PDF),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.batch.batchId;
}

const target = (app, batchId, body, office = 'roland') =>
  api(app.baseUrl, 'PUT', `/api/fees/imports/${batchId}/target?office=${office}`, {
    body: JSON.stringify(body),
    json: true,
  });

const doPost = (app, batchId, office = 'roland') =>
  api(app.baseUrl, 'POST', `/api/fees/imports/${batchId}/post?office=${office}`, {
    body: JSON.stringify({}),
    json: true,
  });

const batchRow = (app) => app.db.table('fees_import_batch')[0];

// ════════════════════════════════════════════════════════════════════════════
// 1. The claim writes a column that is not half of a pair
// ════════════════════════════════════════════════════════════════════════════

test('THE FIX: claiming stamps the REQUESTER and leaves the posted pair empty', async () => {
  const db = new FakeFeesDb();
  db.table('fees_import_batch').push({
    batch_id: '44444444-4444-4444-8444-444444444444',
    office: 'roland',
    filename: 'northstar.pdf',
    file_sha256: 'b'.repeat(64),
    file_size_bytes: 120_000,
    source_type: 'pdf',
    status: 'ready',
    row_count: 6,
    warning_count: 0,
    parse_warnings: [],
    failure_reason: null,
    failure_code: null,
    created_by: 'manager@carein.ai',
    rows_written: 0,
    od_feesched_num: 55,
    od_feesched_desc: 'Northstar PPO 2026',
    od_feesched_is_new: false,
    post_error: null,
    posting_started_at: null,
    post_requested_by: null,
    posted_at: null,
    posted_by: null,
    rolled_back_at: null,
    rolled_back_by: null,
    created_at: new Date(),
    updated_at: new Date(),
  });

  const res = await postJob.claimBatchForPosting(
    db,
    'roland',
    '44444444-4444-4444-8444-444444444444',
    'manager@carein.ai'
  );
  assert.equal(res.ok, true);

  const b = db.table('fees_import_batch')[0];
  assert.equal(b.post_requested_by, 'manager@carein.ai', 'who pressed Post is recorded now');
  // THE POINT. Writing `posted_by` here is what threw in production, because
  // there is no `posted_at` to pair with until the run finishes.
  assert.equal(b.posted_by, null);
  assert.equal(b.posted_at, null);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. The pair lands together, naming the original requester
// ════════════════════════════════════════════════════════════════════════════

test('a completed post attributes to WHO PRESSED POST, and lands the pair together', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });
    assert.equal((await doPost(app, batchId)).status, 202);
    const done = await waitForStatus(app, batchId, ['posted', 'post_failed']);
    assert.equal(done.status, 'posted', done.postError || '');

    const b = batchRow(app);
    assert.equal(b.post_requested_by, 'manager@carein.ai');
    assert.equal(b.posted_by, 'manager@carein.ai', 'and that is who it is attributed to');
    assert.ok(b.posted_at instanceof Date, 'with a time, because half a pair is worse than none');
    // The progress payload says both, so the UI never has to guess which is
    // populated in which state.
    assert.equal(done.postedBy, 'manager@carein.ai');
    assert.equal(done.requestedBy, 'manager@carein.ai');
  });
});

test('a RESUME is attributed to the original requester, not the resumer', async () => {
  // The whole reason first-claim-wins exists. A container that picks up a
  // stalled run did not authorise the post, and a schedule showing its service
  // account as the author would send somebody asking the wrong person.
  // A mutable predicate, so the FIRST run stops partway and the SECOND one
  // genuinely completes. The closure is read per call, which is what lets one
  // fakeOd stand for a practice whose transient refusal has cleared.
  let refusing = true;
  const od = fakeOd({
    schedules: SCHEDULES,
    codeNums: CODE_NUMS,
    failOn: ({ codeNum }) => refusing && codeNum === 13,
  });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });
    await doPost(app, batchId);
    const stopped = await waitForStatus(app, batchId, ['post_failed']);
    assert.equal(stopped.status, 'post_failed');
    // Already answerable, which it was not before: who asked for the run that
    // failed. `postedBy` is null here and must be — the run did not complete.
    assert.equal(stopped.requestedBy, 'manager@carein.ai');
    assert.equal(stopped.postedBy, null, 'and nothing claims it completed');

    /*
     * A DIFFERENT ACTOR CLAIMS IT. Driven through `claimBatchForPosting`
     * directly rather than over HTTP, because the harness binds one identity
     * for the life of the app — an HTTP resume would re-run the COALESCE with
     * the SAME email and prove nothing about whose name wins.
     */
    app.db.table('fees_import_batch')[0].status = 'post_failed';
    const takenOver = await postJob.claimBatchForPosting(
      app.db,
      'roland',
      batchId,
      'biller@carein.ai'
    );
    assert.equal(takenOver.ok, true);
    assert.equal(
      app.db.table('fees_import_batch')[0].post_requested_by,
      'manager@carein.ai',
      'the second claimant does NOT become the author'
    );

    // And the run itself then finishes, once the refusal has cleared.
    refusing = false;
    app.db.table('fees_import_batch')[0].status = 'post_failed';
    app.db.table('fees_import_batch')[0].post_error = 'simulated interruption';
    const resumed = await api(
      app.baseUrl,
      'POST',
      `/api/fees/imports/${batchId}/post?office=roland`,
      { body: JSON.stringify({}), json: true }
    );
    assert.equal(resumed.status, 202);
    const done = await waitForStatus(app, batchId, ['posted', 'post_failed']);
    assert.equal(done.status, 'posted', done.postError || '');

    const b = batchRow(app);
    assert.equal(
      b.post_requested_by,
      'manager@carein.ai',
      'the resume did NOT overwrite who authorised it'
    );
    assert.equal(b.posted_by, 'manager@carein.ai', 'and the finished post names them, not the resumer');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. A post that can only write nothing is a failure
// ════════════════════════════════════════════════════════════════════════════

test('THE LATENT LIE: a batch whose codes match NOTHING fails, it does not "post"', async () => {
  // Before this, every row took the skip branch, the loop wrote nothing,
  // `markPosted` ran, and the batch ended at 'posted' with rows_written = 0 —
  // while the preview page told the office their fees were in Open Dental.
  const od = fakeOd({ schedules: SCHEDULES, codeNums: {} });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });
    assert.equal((await doPost(app, batchId)).status, 202);

    const done = await waitForStatus(app, batchId, ['posted', 'post_failed']);

    assert.equal(done.status, 'post_failed', 'a run that wrote nothing is NOT a post');
    assert.equal(done.rowsWritten, 0);
    // The reason names the count, so the office can tell "this file is for the
    // other practice" from "Open Dental refused one fee".
    assert.match(done.postError, /None of the 6 codes/);
    assert.match(done.postError, /right office/i);

    // And nothing was written, which is the fact the old 'posted' status hid.
    assert.deepEqual(od.calls.writeFee, []);
    assert.equal(od.store.size, 0);
    // The backup still exists: it is taken before the code map, and its
    // presence is what keeps a rollback available.
    assert.ok(done.backup, 'the snapshot was still taken before the first write');
  });
});

test('ONE unmatched code is still not fatal — only ALL of them is', async () => {
  // A payer schedule can legitimately list procedures an office never performs.
  // The distinction matters: the fatal case says the two sides do not describe
  // the same practice, and a per-row skip does not.
  const withoutOne = { ...CODE_NUMS };
  delete withoutOne.D4341;
  const od = fakeOd({ schedules: SCHEDULES, codeNums: withoutOne });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });
    await doPost(app, batchId);

    const done = await waitForStatus(app, batchId, ['posted', 'post_failed']);
    assert.equal(done.status, 'posted');
    assert.equal(done.rowsWritten, 5, 'the other five landed');
    assert.equal(od.calls.writeFee.length, 5);
  });
});

test('a resume with every row already written completes, rather than failing as empty', async () => {
  // The zero-landable guard counts a row that ALREADY carries a FeeNum. A
  // resume finishing off a fully-written run issues no new writes, and calling
  // that "nothing could be written" would turn a successful post into a
  // failure on its last step.
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });
    await doPost(app, batchId);
    await waitForStatus(app, batchId, ['posted']);

    // Every row now carries a FeeNum. Wind the batch back to post_failed and
    // resume it against a practice whose procedure list has since gone empty.
    const b = batchRow(app);
    b.status = 'post_failed';
    b.post_error = 'simulated interruption';
    b.posted_at = null;
    b.posted_by = null;
    app.od.fetchProcedureCodeMap = async () => ({ ok: true, codeNums: {}, total: 0 });

    const again = await doPost(app, batchId);
    assert.equal(again.status, 202);
    const done = await waitForStatus(app, batchId, ['posted', 'post_failed']);

    assert.equal(done.status, 'posted', 'the already-written rows are what it has to show');
    assert.equal(done.rowsWritten, 6);
  });
});
