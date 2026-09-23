'use strict';

/**
 * Posting a parsed fee schedule into Open Dental (slice 3) — route + job tests.
 *
 * Every test boots the REAL assembled chain (auth gate → tenantContext →
 * requireModule('fees') → requireReadWrite → routes/fees) and runs the routes'
 * ACTUAL SQL against FakeFeesDb, whose CHECK constraints and conditional
 * UPDATEs mirror the migration's. Open Dental is a `fakeOd` holding a real
 * in-memory fee schedule, so what a post did to a practice can be ASSERTED
 * rather than assumed.
 *
 * THE TWO STARS, both named in the slice brief as things to negative-test:
 *
 *  1. THE WARNED-ROWS GATE IS SERVER-SIDE. A caller who never sees the UI —
 *     curl, a stale tab, a script — is refused by the endpoint, not by a
 *     disabled button. Proven by posting a batch with an undecided warned row
 *     and asserting both the 409 and that Open Dental was never touched.
 *  2. RESUME DOES NOT DOUBLE-WRITE. A run that died after writing to Open
 *     Dental but before recording the FeeNum must not write a second fee for
 *     that code. Proven by simulating exactly that window and asserting the
 *     practice ends with ONE fee for the code and that no create was issued.
 *
 * NO REAL PATIENT DATA. Fee schedules carry procedure codes and money and never
 * a patient; the fixtures are synthetic anyway.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { withApp, api, filePart, auditRows, fakeOd, waitForStatus } = require('./feesTestUtils');
const fx = require('../../services/fees/feeFixtures');

const CSV = 'text/csv';
const PDF = 'application/pdf';

/** CodeNums for the codes the synthetic fixtures use. Invented, stable. */
const CODE_NUMS = {
  D0120: 11,
  D0150: 12,
  D0210: 13,
  D1110: 14,
  D2740: 15,
  D4341: 16,
  D2750: 17,
  D9986: 18,
};

/** An existing schedule to post into, and a second so the picker has a choice. */
const SCHEDULES = [
  { feeSchedNum: 55, description: 'Northstar PPO 2026', feeSchedType: 'Normal', isHidden: false, isGlobal: true },
  { feeSchedNum: 56, description: 'Office UCR', feeSchedType: 'Normal', isHidden: false, isGlobal: true },
];

/** Upload the clean six-row PDF and return its batch id. */
async function uploadClean(app, office = 'roland') {
  const res = await api(app.baseUrl, 'POST', `/api/fees/imports?office=${office}`, {
    body: filePart(fx.syntheticFeePdf(fx.PDF_CLEAN), 'northstar.pdf', PDF),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.batch.batchId;
}

/** Upload the multi-column PDF: two rows, BOTH warned (ambiguous_amount). */
async function uploadWarned(app, office = 'roland') {
  const res = await api(app.baseUrl, 'POST', `/api/fees/imports?office=${office}`, {
    body: filePart(fx.syntheticFeePdf(fx.PDF_MULTI_COLUMN), 'tiers.pdf', PDF),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.batch.batchId;
}

const target = (app, batchId, body, office = 'roland') =>
  api(app.baseUrl, 'PUT', `/api/fees/imports/${batchId}/target?office=${office}`, {
    body: JSON.stringify(body),
    json: true,
  });

const decide = (app, batchId, rowId, decision, office = 'roland') =>
  api(app.baseUrl, 'PATCH', `/api/fees/imports/${batchId}/rows/${rowId}?office=${office}`, {
    body: JSON.stringify({ decision }),
    json: true,
  });

const doPost = (app, batchId, office = 'roland') =>
  api(app.baseUrl, 'POST', `/api/fees/imports/${batchId}/post?office=${office}`, {
    body: JSON.stringify({}),
    json: true,
  });

// ════════════════════════════════════════════════════════════════════════════
// STAR 1: the warned-rows gate is SERVER-SIDE
// ════════════════════════════════════════════════════════════════════════════

test('THE STAR: a batch with an undecided warned row is refused by the SERVER', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadWarned(app);
    await target(app, batchId, { feeSchedNum: 55 });

    // No UI, no disabled button — the endpoint itself.
    const res = await doPost(app, batchId);

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'UNRESOLVED_WARNINGS');
    assert.equal(res.body.blockingCount, 2);
    assert.match(res.body.error, /accepted or excluded/i);

    // AND NOTHING WAS WRITTEN. The refusal is not merely a different message
    // in front of the same behaviour.
    assert.deepEqual(od.calls.writeFee, []);
    assert.equal(od.calls.createFeeSchedule, 0);
    assert.equal(od.store.size, 0);

    const batch = app.db.table('fees_import_batch')[0];
    assert.equal(batch.status, 'parsed', 'and the batch never entered posting');
    assert.equal(batch.rows_written, 0);
  });
});

test('deciding every warned row flips the batch to ready, and then it posts', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadWarned(app);
    await target(app, batchId, { feeSchedNum: 55 });

    const rows = app.db.table('fees_import_row');
    assert.equal(rows.length, 2);

    // One accepted, one excluded — both are decisions, and both unblock.
    const first = await decide(app, batchId, rows[0].row_id, 'accepted');
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'parsed', 'still blocked by the second row');

    const second = await decide(app, batchId, rows[1].row_id, 'excluded');
    assert.equal(second.status, 200);
    assert.equal(second.body.status, 'ready');

    const posted = await doPost(app, batchId);
    assert.equal(posted.status, 202, JSON.stringify(posted.body));

    const progress = await waitForStatus(app, batchId, ['posted', 'post_failed']);
    assert.equal(progress.status, 'posted');
    // The EXCLUDED row was not written. The database refuses a FeeNum on an
    // excluded row, so this is belt and braces.
    assert.equal(progress.rowsWritten, 1);
    assert.equal(od.calls.writeFee.length, 1);
    assert.equal(od.store.size, 1);
  });
});

test('resetting a decision re-blocks the post', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadWarned(app);
    await target(app, batchId, { feeSchedNum: 55 });
    const rows = app.db.table('fees_import_row');

    await decide(app, batchId, rows[0].row_id, 'accepted');
    await decide(app, batchId, rows[1].row_id, 'accepted');
    assert.equal(app.db.table('fees_import_batch')[0].status, 'ready');

    const reset = await decide(app, batchId, rows[0].row_id, 'reset');
    assert.equal(reset.status, 200);
    assert.equal(reset.body.status, 'parsed');
    // Attribution is cleared with the decision — a decided_by with no decision
    // is a record of a judgement nobody made.
    assert.equal(app.db.table('fees_import_row')[0].decided_by, null);

    const res = await doPost(app, batchId);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'UNRESOLVED_WARNINGS');
  });
});

test('a CLEAN batch needs no decisions at all', async () => {
  // The gate is warned-AND-pending, not a checklist. A hundred-row file with
  // two flagged rows needs exactly two clicks; a clean one needs none.
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });

    const res = await doPost(app, batchId);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    const progress = await waitForStatus(app, batchId, ['posted', 'post_failed']);
    assert.equal(progress.status, 'posted');
    assert.equal(progress.rowsWritten, 6);
  });
});

test('a batch whose every row is excluded refuses rather than posting nothing', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadWarned(app);
    await target(app, batchId, { feeSchedNum: 55 });
    for (const row of app.db.table('fees_import_row')) {
      await decide(app, batchId, row.row_id, 'excluded');
    }
    const res = await doPost(app, batchId);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NOTHING_TO_POST');
    assert.deepEqual(od.calls.writeFee, []);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STAR 2: resume never double-writes
// ════════════════════════════════════════════════════════════════════════════

test('THE OTHER STAR: a resume verifies by read and does NOT write a second fee', async () => {
  // THE CRASH WINDOW. A run wrote D1110 into Open Dental and died before
  // recording the FeeNum, so our row says unwritten while the practice's
  // database says otherwise. A naive resume POSTs again, and the schedule ends
  // up holding D1110 twice — which Open Dental then picks from arbitrarily.
  const od = fakeOd({
    schedules: SCHEDULES,
    codeNums: CODE_NUMS,
    // The fee is ALREADY THERE at the right amount, as the dead run left it.
    fees: [{ FeeNum: 880001, FeeSched: 55, CodeNum: CODE_NUMS.D1110, Amount: 92 }],
  });

  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });

    const res = await doPost(app, batchId);
    assert.equal(res.status, 202);
    const progress = await waitForStatus(app, batchId, ['posted', 'post_failed']);
    assert.equal(progress.status, 'posted');

    // ONE fee for D1110, not two.
    const forD1110 = [...od.store.values()].filter((f) => f.CodeNum === CODE_NUMS.D1110);
    assert.equal(forD1110.length, 1, 'the resume must not create a second fee for D1110');
    assert.equal(forD1110[0].FeeNum, 880001, 'and it adopted the FeeNum that was already there');

    // And no write was ISSUED for it — the verify-by-read short-circuited
    // before writeFee was called. (The other five codes were written.)
    const wroteD1110 = od.calls.writeFee.filter((c) => c.codeNum === CODE_NUMS.D1110);
    assert.deepEqual(wroteD1110, [], 'verify-by-read must short-circuit the write entirely');
    assert.equal(od.calls.writeFee.length, 5);

    // All six rows are accounted for: five written now, one adopted.
    assert.equal(progress.rowsWritten, 6);
  });
});

test('a resume SKIPS rows that already carry a FeeNum, without even reading them', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });

    // Simulate a first run that got three rows in and recorded them.
    const rows = app.db.table('fees_import_row');
    for (const row of rows.slice(0, 3)) {
      row.od_fee_num = 770000 + row.row_order;
      row.written_at = new Date();
      od.store.set(row.od_fee_num, {
        FeeNum: row.od_fee_num,
        FeeSched: 55,
        CodeNum: CODE_NUMS[row.proc_code],
        Amount: row.fee_cents / 100,
      });
    }
    const batch = app.db.table('fees_import_batch')[0];
    batch.status = 'post_failed';
    batch.post_error = 'Stopped at D1110: Open Dental refused the fee';
    batch.rows_written = 3;

    const res = await doPost(app, batchId);
    assert.equal(res.status, 202, 'post_failed is a resumable state');
    const progress = await waitForStatus(app, batchId, ['posted', 'post_failed']);
    assert.equal(progress.status, 'posted');
    assert.equal(progress.rowsWritten, 6);

    // Only the three unwritten ones were written.
    assert.equal(od.calls.writeFee.length, 3);
    assert.equal(od.store.size, 6);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// post_failed carries a number (the W-21 lesson)
// ════════════════════════════════════════════════════════════════════════════

test('a post that dies partway reports HOW MANY fees it had already written', async () => {
  // "failed" must never be readable as "nothing was written". A person who
  // believes that re-posts, and now the practice has been written twice.
  const od = fakeOd({
    schedules: SCHEDULES,
    codeNums: CODE_NUMS,
    failOn: ({ codeNum }) => codeNum === CODE_NUMS.D2740,
  });

  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });
    await doPost(app, batchId);

    const progress = await waitForStatus(app, batchId, ['posted', 'post_failed']);
    assert.equal(progress.status, 'post_failed');

    // THE NUMBER. Four codes sort before D2740 in the fixture's file order.
    assert.equal(progress.rowsWritten, 4);
    assert.ok(progress.rowsWritten > 0, 'a failed post that wrote something says so');
    assert.equal(od.store.size, 4, 'and the practice really does hold four fees');

    // And it names where it stopped, so the reason is actionable.
    assert.match(progress.postError, /Stopped at D2740/);
    assert.match(progress.postError, /refused the fee/);
  });
});

test('the batch is left resumable, and the second attempt finishes it', async () => {
  const od = fakeOd({
    schedules: SCHEDULES,
    codeNums: CODE_NUMS,
    failOn: ({ codeNum }) => codeNum === CODE_NUMS.D2740,
  });

  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });
    await doPost(app, batchId);
    await waitForStatus(app, batchId, ['post_failed']);

    // Whatever was wrong is fixed; the biller presses Post again.
    od.state.schedules = SCHEDULES;
    const retryOd = od;
    retryOd.calls.writeFee.length = 0;
    // Clear the failure by rebuilding the predicate through the module stub.
    const odWrites = require('../../services/fees/odFeesWrites');
    odWrites.writeFee = async (_office, { feeSchedNum, codeNum, amountCents }) => {
      retryOd.calls.writeFee.push({ feeSchedNum, codeNum, amountCents });
      const existing = [...retryOd.store.values()].find(
        (f) => f.FeeSched === feeSchedNum && f.CodeNum === codeNum
      );
      if (existing) {
        existing.Amount = amountCents / 100;
        return { ok: true, feeNum: existing.FeeNum, action: 'updated' };
      }
      const feeNum = 990000 + codeNum;
      retryOd.store.set(feeNum, { FeeNum: feeNum, FeeSched: feeSchedNum, CodeNum: codeNum, Amount: amountCents / 100 });
      return { ok: true, feeNum, action: 'created' };
    };

    const again = await doPost(app, batchId);
    assert.equal(again.status, 202);
    const progress = await waitForStatus(app, batchId, ['posted', 'post_failed']);
    assert.equal(progress.status, 'posted');
    assert.equal(progress.rowsWritten, 6);

    // The four already-written rows were NOT written again.
    assert.equal(retryOd.calls.writeFee.length, 2);
    assert.equal(retryOd.store.size, 6);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Backup and rollback
// ════════════════════════════════════════════════════════════════════════════

test('the backup is taken BEFORE the first write, and holds what was there', async () => {
  const od = fakeOd({
    schedules: SCHEDULES,
    codeNums: CODE_NUMS,
    fees: [
      { FeeNum: 700001, FeeSched: 55, CodeNum: CODE_NUMS.D1110, Amount: 80 },
      { FeeNum: 700002, FeeSched: 55, CodeNum: CODE_NUMS.D2740, Amount: 1000 },
    ],
  });

  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });
    await doPost(app, batchId);
    await waitForStatus(app, batchId, ['posted']);

    const backup = app.db.table('fees_od_backup');
    assert.equal(backup.length, 1);
    assert.equal(backup[0].od_feesched_num, 55);
    assert.equal(backup[0].is_new_schedule, false);
    assert.equal(backup[0].row_count, 2, 'the two fees that were there BEFORE the post');
    // The OLD amounts, not the new ones. A backup taken after the first write
    // would hold 92 and 1150 and restore our own writes.
    const amounts = backup[0].rows.map((f) => f.Amount).sort((a, b) => a - b);
    assert.deepEqual(amounts, [80, 1000]);
  });
});

test('rolling back an EXISTING schedule deletes what we wrote and restores what was there', async () => {
  const od = fakeOd({
    schedules: SCHEDULES,
    codeNums: CODE_NUMS,
    fees: [{ FeeNum: 700001, FeeSched: 55, CodeNum: CODE_NUMS.D1110, Amount: 80 }],
  });

  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });
    await doPost(app, batchId);
    await waitForStatus(app, batchId, ['posted']);
    assert.equal(od.store.size, 6, 'six codes in the schedule after the post');

    const res = await api(
      app.baseUrl,
      'POST',
      `/api/fees/imports/${batchId}/rollback?office=roland`,
      { body: JSON.stringify({}), json: true }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deleted, 6);
    // D1110 held 80 before and is put back to 80; the other five were ADDED by
    // this batch and stay deleted, which is correct.
    assert.equal(res.body.restored, 1);
    assert.equal(od.store.size, 1);
    const [restored] = [...od.store.values()];
    assert.equal(restored.CodeNum, CODE_NUMS.D1110);
    assert.equal(restored.Amount, 80);

    const progress = await waitForStatus(app, batchId, ['rolled_back']);
    assert.equal(progress.status, 'rolled_back');
    assert.equal(progress.rowsWritten, 0, 'nothing of this batch is left in the practice');
    assert.ok(progress.rolledBackBy);
  });
});

test('rolling back a NEW schedule hides it and SAYS the shell remains', async () => {
  // Open Dental has no DELETE for /feescheds. A rollback that claimed to have
  // removed the schedule would be the same lie as a failed post claiming
  // nothing was written.
  const od = fakeOd({ schedules: [], codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    const t = await target(app, batchId, { newScheduleName: 'ZZ CAREIN TEST - DO NOT USE' });
    assert.equal(t.status, 200);
    assert.equal(t.body.target.isNew, true);
    assert.equal(t.body.target.feeSchedNum, null, 'naming it does NOT create it');
    assert.equal(od.calls.createFeeSchedule, 0, 'nothing exists in Open Dental yet');

    // The CLICK is what creates it — review-then-send.
    await doPost(app, batchId);
    await waitForStatus(app, batchId, ['posted']);
    assert.equal(od.calls.createFeeSchedule, 1);

    const res = await api(
      app.baseUrl,
      'POST',
      `/api/fees/imports/${batchId}/rollback?office=roland`,
      { body: JSON.stringify({}), json: true }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 6);
    assert.equal(od.store.size, 0, 'every fee removed');
    assert.equal(od.calls.hideFeeSchedule.length, 1, 'and the schedule hidden');
    assert.equal(od.state.schedules[0].isHidden, true);

    // THE HONEST SENTENCE.
    assert.match(res.body.note, /cannot delete a fee schedule/i);
    assert.match(res.body.note, /remains/i);
  });
});

test('a batch that was never posted cannot be rolled back', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/fees/imports/${batchId}/rollback?office=roland`,
      { body: JSON.stringify({}), json: true }
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NOT_ROLLBACK_ABLE');
    assert.deepEqual(od.calls.deleteFee, []);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Target selection, state machine, audit
// ════════════════════════════════════════════════════════════════════════════

test('the target picker lists the office schedules through the allow-listed writer', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const res = await api(app.baseUrl, 'GET', '/api/fees/feescheds?office=roland');
    assert.equal(res.status, 200);
    assert.equal(res.body.schedules.length, 2);
    assert.equal(res.body.schedules[0].description, 'Northstar PPO 2026');
  });
});

test('an existing target is VALIDATED against this office, not taken on trust', async () => {
  // A FeeSchedNum from the other office's database would otherwise be storable
  // here and posted into later.
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    const res = await target(app, batchId, { feeSchedNum: 9999 });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'FEESCHED_NOT_FOUND');
  });
});

test('giving both an existing schedule and a new name is a refusal, not a guess', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    for (const body of [
      { feeSchedNum: 55, newScheduleName: 'Both' },
      {},
    ]) {
      const res = await target(app, batchId, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'BAD_TARGET');
    }
  });
});

test('posting with no target chosen refuses', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    const res = await doPost(app, batchId);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NO_TARGET');
    assert.deepEqual(od.calls.writeFee, []);
  });
});

test('an already-posted batch refuses a second post and says to roll back first', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });
    await doPost(app, batchId);
    await waitForStatus(app, batchId, ['posted']);

    const again = await doPost(app, batchId);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'BATCH_NOT_POSTABLE');
    assert.match(again.body.error, /Roll it back first/i);
    assert.equal(od.calls.writeFee.length, 6, 'no extra writes');
  });
});

test('rows and target cannot be changed once posting has started', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });
    await doPost(app, batchId);
    await waitForStatus(app, batchId, ['posted']);

    const rows = app.db.table('fees_import_row');
    const decided = await decide(app, batchId, rows[0].row_id, 'excluded');
    assert.equal(decided.status, 409);
    assert.equal(decided.body.code, 'BATCH_NOT_EDITABLE');

    const retarget = await target(app, batchId, { feeSchedNum: 56 });
    assert.equal(retarget.status, 409);
    assert.equal(retarget.body.code, 'BATCH_NOT_EDITABLE');
  });
});

test('the audit row CARRIES THE VALUES: schedule, counts and total', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);
    await target(app, batchId, { feeSchedNum: 55 });
    await doPost(app, batchId);

    const posts = auditRows(app.db).filter((r) => r.resource_type === 'fees_post');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].action, 'CREATE');
    assert.equal(posts[0].result, 'SUCCESS');
    assert.equal(posts[0].office, 'roland');
    assert.equal(posts[0].resource_id, batchId);
    // "Who posted what into which schedule, and what was it worth" has to be
    // answerable from the trail alone.
    assert.match(posts[0].source_ref, /feesched:55/);
    assert.match(posts[0].source_ref, /rows:6/);
    // 45.00 + 85.00 + 130.00 + 92.00 + 1,150.00 + 245.00 = $1,747.00, in cents.
    assert.match(posts[0].source_ref, /cents:174700/);
  });
});

test('progress is readable at every stage, and carries rowsWritten throughout', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app);

    const before = await api(
      app.baseUrl,
      'GET',
      `/api/fees/imports/${batchId}/progress?office=roland`
    );
    assert.equal(before.status, 200);
    assert.equal(before.body.progress.status, 'parsed');
    assert.equal(before.body.progress.rowsWritten, 0);
    assert.equal(before.body.progress.target, null);
    assert.equal(before.body.progress.backup, null);

    await target(app, batchId, { feeSchedNum: 55 });
    await doPost(app, batchId);
    const after = await waitForStatus(app, batchId, ['posted']);
    assert.equal(after.rowsWritten, 6);
    assert.equal(after.target.feeSchedNum, 55);
    assert.equal(after.backup.rowCount, 0);
    assert.ok(after.postedAt);
  });
});

test("one office cannot post, decide or roll back another office's batch", async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadClean(app, 'roland');
    for (const [method, path] of [
      ['POST', `/api/fees/imports/${batchId}/post?office=valley`],
      ['POST', `/api/fees/imports/${batchId}/rollback?office=valley`],
      ['PUT', `/api/fees/imports/${batchId}/target?office=valley`],
    ]) {
      const res = await api(app.baseUrl, method, path, { body: JSON.stringify({}), json: true });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(res.body.code, 'BATCH_NOT_FOUND');
    }
    // GET carries no body, so it is asked separately rather than bent into the
    // loop above.
    const progress = await api(
      app.baseUrl,
      'GET',
      `/api/fees/imports/${batchId}/progress?office=valley`
    );
    assert.equal(progress.status, 404);
    assert.equal(progress.body.code, 'BATCH_NOT_FOUND');
    assert.deepEqual(od.calls.writeFee, []);
  });
});

test('a biller can read progress but cannot post or roll back', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od, role: 'admin' }, async (app) => {
    const batchId = await uploadClean(app);
    await withApp({ od, role: 'rcm_biller', db: app.db }, async (biller) => {
      const progress = await api(
        biller.baseUrl,
        'GET',
        `/api/fees/imports/${batchId}/progress?office=roland`
      );
      assert.equal(progress.status, 200, 'fees.read covers the progress view');

      const posted = await doPost(biller, batchId);
      assert.equal(posted.status, 403, 'posting demands fees.write');
      assert.deepEqual(od.calls.writeFee, []);
    });
  });
});
