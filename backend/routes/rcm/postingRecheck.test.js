'use strict';

/**
 * `POST /api/rcm/posting/:id/recheck` — ask Open Dental again, write nothing.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS ROUTE IS FOR, AND WHY IT NEEDED TO EXIST
 * ═════════════════════════════════════════════════════════════════════════════
 * A plan that came back `partially_posted` is stuck on ONE thing: Open Dental
 * does not say about the patient's balance what the check promised. Money moved,
 * every carrier-side proof passed, and the patient's own number is wrong.
 *
 * The remedy is a person correcting the chart. Then she wants to ask one
 * question — *is it right now?* — and before Stage C the only way to ask was to
 * press Post again, because the confirmation ran inside the post. "Press the one
 * button that writes to a chart, in order to READ" is a shape nobody should have
 * to reason about at 6pm.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE FOUR CLAIMS
 * ═════════════════════════════════════════════════════════════════════════════
 *   1. IT WRITES NOTHING. Not a chart — asserted against the fake's own verb
 *      log, which records every write it was asked for. Not the plan either: the
 *      status, the stamps and `confirmed_verdict` are all exactly as they were.
 *   2. IT IS THE SAME ARITHMETIC. `postingDrain.confirmLineFor` +
 *      `verdictFor`'s CONFIRMED register — the identical pair the drain's own
 *      `confirm_patient` step uses, which is why the extraction happened at all.
 *   3. IT REFUSES ON A PLAN THAT HAS NOT POSTED. There is nothing in the chart
 *      to read back, and a "confirmation" over that would be a projection
 *      wearing a confirmation's words.
 *   4. IT IS AUDITED AS A READ, per claim, exactly as the drain audits the same
 *      call.
 *
 * NO REAL PATIENT DATA. PatNum 12827 is the module's own roland fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FakeRcmDb,
  FakeOd,
  bootRcmApp,
  api,
  auditRows,
  seedOfficeSettings,
} = require('./rcmTestUtils');

const QUEUE_ID = '11111111-2222-4333-8444-555555555555';
const LINE_ID = '66666666-7777-4888-8999-000000000000';
const BATCH_ID = '8acb0e32-35ae-5cd8-9692-7b5e318a31c2';
const CLAIM_ID = 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d';

/** The chart line, as Open Dental hands it back. */
const CHART_LINE = {
  ClaimProcNum: 99001,
  ClaimNum: 53648,
  CodeSent: 'D2740',
  FeeBilled: 210.0,
  InsPayAmt: 150.0,
  WriteOff: 60.0,
  DedApplied: 0,
};

/**
 * A plan that HAS posted, and the chart it posted into.
 *
 * The arithmetic, so the fixtures below are readable:
 *   FeeBilled 210 − InsPayAmt 150 − WriteOff 60 = 0 left on the patient.
 * `intended_patient_cents` is 0, so the chart agrees with the promise.
 */
function seedPosted(db, over = {}) {
  seedOfficeSettings(db, { roland: true, valley: false });
  db.seed('rcm_user_map', [
    {
      user_key: 'user-1',
      platform_email: 'billing@carein.ai',
      display_name: 'Billing User',
      active: true,
    },
  ]);
  db.seed('rcm_payment_batches', [
    {
      batch_id: BATCH_ID,
      office_id: 'roland',
      payer: 'SYNTHETIC DENTAL',
      check_number: '830200001',
      eft_number: null,
      payment_method: 'check',
      deposit_date: '2026-03-01',
      total_amount_cents: 15000,
      status: 'ready',
    },
  ]);
  db.seed('rcm_posting_queue', [
    {
      queue_id: QUEUE_ID,
      office_id: 'roland',
      batch_id: BATCH_ID,
      remittance_key: 'roland:830200001',
      status: 'partially_posted',
      is_recoupment: false,
      carrier_eob_date: '2026-03-01',
      intended_total_cents: 15000,
      posted_total_cents: 15000,
      od_claim_payment_num: 21436,
      approved_by: 'user-1',
      approved_at: new Date('2026-03-02T11:10:00Z'),
      started_at: new Date('2026-03-02T11:20:00Z'),
      finished_at: new Date('2026-03-02T11:21:00Z'),
      attempt_count: 1,
      last_error: 'Open Dental says the patient owes $20.00 — this check said $0.00.',
      blocked_reason: null,
      drain_step: 'confirm_patient',
      drained_by: 'user-1',
      drain_attempt_at: new Date('2026-03-02T11:20:00Z'),
      reconciled_at: null,
      ...(over.queue || {}),
    },
  ]);
  db.seed('rcm_posting_queue_line', [
    {
      queue_line_id: LINE_ID,
      queue_id: QUEUE_ID,
      office_id: 'roland',
      position: 1,
      od_claim_proc_num: 99001,
      od_claim_num: 53648,
      claim_id: CLAIM_ID,
      batch_claim_payment_id: null,
      intended_ins_pay_amt_cents: 15000,
      intended_write_off_cents: 6000,
      intended_ded_applied_cents: 0,
      intended_patient_cents: 0,
      decided_write_off_cents: null,
      decided_reason: null,
      decided_by: null,
      od_writeoff_adjustment_num: null,
      is_supplemental: false,
      status: 'paid',
      claimproc_written_at: new Date('2026-03-02T11:20:30Z'),
      claim_received_at: new Date('2026-03-02T11:20:40Z'),
      paid_at: new Date('2026-03-02T11:20:50Z'),
      od_claim_payment_num: 21436,
      last_error: null,
      readback: null,
      readback_at: null,
      skip_reason: null,
      ...(over.line || {}),
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: CLAIM_ID,
      office_id: 'roland',
      claim_number: '53648',
      patient_name: 'Test 2, Stedi',
      od_patient_id: 12827,
      od_claim_num: 53648,
      od_match_status: 'confirmed',
      posting_queue_id: QUEUE_ID,
      od_match_snapshot: { version: 2 },
      confirmed_verdict: null,
    },
  ]);
  return db;
}

const URL = `/api/rcm/posting/${QUEUE_ID}/recheck?office=roland`;

/** The harness wants a STRING body plus the json flag — same as every RCM test. */
const json = (body) => ({ body: JSON.stringify(body), json: true });

// ─────────────────────────────────────────────────────────────────────────────

test('it agrees when the chart now says what the check promised', async () => {
  const db = seedPosted(new FakeRcmDb());
  const od = new FakeOd({ claimProcs: [CHART_LINE] });
  const app = await bootRcmApp({ db, od });
  try {
    const res = await api(app.baseUrl, 'POST', URL, json({}));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.agreed, true);
    assert.equal(res.body.claims.length, 1);

    const verdict = res.body.claims[0].verdict;
    // THE CONFIRMED REGISTER — measured out of the chart, never re-derived.
    assert.equal(verdict.register, 'confirmed');
    assert.equal(verdict.state, 'green');
    assert.equal(verdict.projectedPatientCents, 0);
  } finally {
    await app.close();
  }
});

test('it DISAGREES, in the same sentence the post itself would have used', async () => {
  const db = seedPosted(new FakeRcmDb());
  // The write-off never landed, so the chart leaves the patient owing $60.
  const od = new FakeOd({ claimProcs: [{ ...CHART_LINE, WriteOff: 0 }] });
  const app = await bootRcmApp({ db, od });
  try {
    const res = await api(app.baseUrl, 'POST', URL, json({}));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.agreed, false);

    const verdict = res.body.claims[0].verdict;
    assert.equal(verdict.state, 'red');
    // It names the LINE, not just the total — two lines wrong by the same
    // amount in opposite directions sum to a total that agrees.
    assert.ok(
      verdict.problems.some((p) => p.kind === 'chart_differs_from_decision'),
      JSON.stringify(verdict.problems)
    );
    assert.ok(verdict.sentence.includes('D2740'), verdict.sentence);
  } finally {
    await app.close();
  }
});

test('IT WRITES NOTHING — not to a chart, and not to the plan', async () => {
  /*
   * The whole reason this route exists rather than "press Post again". The
   * fake's verb log records every write it was ASKED for, so a write attempted
   * and refused would still show here.
   */
  const db = seedPosted(new FakeRcmDb());
  const od = new FakeOd({ claimProcs: [CHART_LINE] });
  const app = await bootRcmApp({ db, od });
  try {
    const before = db.table('rcm_posting_queue')[0];
    const beforeStatus = before.status;
    const beforeAttempts = before.attempt_count;
    const beforeError = before.last_error;

    const res = await api(app.baseUrl, 'POST', URL, json({}));
    assert.equal(res.status, 200);

    // 1. NO Open Dental write of any kind. `writesIssued()` is the fake's own
    //    transcript of every write verb it was ASKED for, so a write attempted
    //    and refused downstream would still appear here.
    assert.deepEqual(od.writesIssued(), [], `it wrote: ${od.writesIssued().join(', ')}`);

    // 2. THE PLAN DID NOT MOVE. A read that quietly finished a check would be
    //    indistinguishable from a post in the record.
    const after = db.table('rcm_posting_queue')[0];
    assert.equal(after.status, beforeStatus);
    assert.equal(after.attempt_count, beforeAttempts);
    assert.equal(after.last_error, beforeError);
    // And the response says the status it found rather than one it set.
    assert.equal(res.body.status, 'partially_posted');

    // 3. NOT EVEN CareIN's own record of the verdict. It ANSWERS a question;
    //    the answer is not a state change.
    assert.equal(db.table('rcm_claims')[0].confirmed_verdict, null);
  } finally {
    await app.close();
  }
});

test('a plan that has NOT posted is refused — there is nothing to read back', async () => {
  const db = seedPosted(new FakeRcmDb(), {
    queue: {
      status: 'approved',
      od_claim_payment_num: null,
      posted_total_cents: 0,
      finished_at: null,
      last_error: null,
    },
  });
  const app = await bootRcmApp({ db, od: new FakeOd({ claimProcs: [] }) });
  try {
    const res = await api(app.baseUrl, 'POST', URL, json({}));
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NOTHING_POSTED_YET');
    // It names the state it found, so the screen can say which one.
    assert.equal(res.body.status, 'approved');
  } finally {
    await app.close();
  }
});

test('a POSTED plan may be re-checked too — asking again is always allowed', async () => {
  // `posted` and `partially_posted` both have a check in Open Dental to read.
  const db = seedPosted(new FakeRcmDb(), {
    queue: { status: 'posted', reconciled_at: new Date('2026-03-02T11:21:00Z'), last_error: null },
  });
  const app = await bootRcmApp({ db, od: new FakeOd({ claimProcs: [CHART_LINE] }) });
  try {
    const res = await api(app.baseUrl, 'POST', URL, json({}));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.agreed, true);
  } finally {
    await app.close();
  }
});

test("another office's plan is NOT FOUND, not refused", async () => {
  const db = seedPosted(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: new FakeOd({ claimProcs: [CHART_LINE] }) });
  try {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/posting/${QUEUE_ID}/recheck?office=valley`,
      json({})
    );
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'QUEUE_NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('every Open Dental read it makes is audited as a READ', async () => {
  const db = seedPosted(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: new FakeOd({ claimProcs: [CHART_LINE] }) });
  try {
    await api(app.baseUrl, 'POST', URL, json({}));

    const rows = auditRows(db);
    const claimProcRead = rows.find(
      (r) => r.resource_type === 'rcm_od_claimproc' && r.action === 'READ'
    );
    assert.ok(claimProcRead, 'no READ recorded for the chart read');
    // …and NOT as a write, under any resource type.
    assert.equal(
      rows.filter((r) => ['CREATE', 'UPDATE', 'DELETE'].includes(r.action)).length,
      0,
      'a read-only route recorded a write'
    );
  } finally {
    await app.close();
  }
});

test('a REVIEWER may press it — asking a question is not a posting act (D-9)', async () => {
  /*
   * IT IS ON `rcm.read`, and that is a decision rather than an oversight.
   *
   * The mount demands `rcm.write` for every POST that is not enumerated in
   * `QUEUE_PATHS`, and this one IS — because what it does is read. Demanding
   * write authority to LOOK would put the person best placed to notice a wrong
   * balance behind a permission she does not need, and would make the button's
   * own honest label ("reads the chart and writes nothing to it") a thing the
   * mount contradicted.
   *
   * A `reviewer` holds `rcm.read` + `rcm.queue` and NOT `rcm.write`.
   */
  const db = seedPosted(new FakeRcmDb());
  const od = new FakeOd({ claimProcs: [CHART_LINE] });
  const app = await bootRcmApp({ db, od, role: 'reviewer' });
  try {
    const res = await api(app.baseUrl, 'POST', URL, json({}));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.agreed, true);
    // …and she still wrote nothing, which is the reason it was safe to let her.
    assert.deepEqual(od.writesIssued(), []);
  } finally {
    await app.close();
  }
});
