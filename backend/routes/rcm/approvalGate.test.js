'use strict';

/**
 * THE APPROVAL GATE (Slice 6b), through the REAL /api/rcm stack.
 *
 * Booted the way server.js assembles it — auth gate → tenantContext →
 * requireModule('rcm') → requireReadWrite → the real router — so the permission
 * split and the office boundary are under test rather than assumed.
 *
 * The claims here, in order of how much they matter:
 *
 *  1. NOTHING gets through the gate that rule 4 of the slice brief forbids, and
 *     each refusal is named per claim rather than lumped into one failure.
 *  2. There is no way around it. No force flag, no override, no admin bypass —
 *     and the checks are re-read from the DATABASE, not from what the client
 *     sent or what the screen displayed.
 *  3. Approving twice never enqueues the same money twice, and the guarantee is
 *     the database's, not the handler's.
 *  4. A partial approve is a real success that says exactly what it covered.
 *  5. NOTHING is written to Open Dental. (Proven separately, and more strongly,
 *     in rcmNoOdWrites.test.js — which drives approve to success against a
 *     client whose every verb throws.)
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeRcmDb, bootRcmApp, api, auditRows } = require('./rcmTestUtils');
const approvalGate = require('./approvalGate');

// ─── Ids. Real uuids, because production could never mint 'b-1' ──────────────

const BATCH = '8acb0e32-35ae-5cd8-9692-7b5e318a31c2';
const CLAIM = 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d';
const CLAIM2 = 'ae21fad8-8cbb-5424-9780-b30be1cf31c9';
const LINE = 'a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90';
const LINE2 = '512be448-fb43-554c-a21d-33b0f80f9323';

const Q = '?office=roland';
const json = (body) => ({ body: JSON.stringify(body), json: true });

/**
 * A snapshot in the CURRENT shape, confirmed against `odClaimNum`.
 *
 * Built by a helper rather than pasted, because the gate reads five different
 * things out of it and a test that hand-rolled one per case would drift into
 * asserting against a shape `confirmMatch` no longer writes.
 */
function snapshot({ odClaimNum = 53648, blockers = [], version = 2, office = 'roland' } = {}) {
  return {
    version,
    office,
    fetchedAt: '2026-03-02T11:00:00.000Z',
    candidates: [{ odClaimNum, blockers, linePairs: [] }],
    confirmed: {
      odClaimNum,
      odPatNum: 12828,
      confirmedAt: '2026-03-02T11:00:00.000Z',
      confirmedBy: 'user-1',
      linePairs: [{ lineId: LINE, odClaimProcNum: 99001 }],
      odAmountsAsRead: {
        billedCents: 21000,
        claimHeaderFeeCents: 21000,
        insPaidCents: 0,
        writeOffCents: 0,
        claimStatus: 'S',
      },
    },
  };
}

/**
 * One batch, one claim, one line — and by default every condition satisfied.
 *
 * The default is APPROVABLE on purpose. Every test below then breaks exactly
 * one thing, so a refusal is attributable to the condition the test names
 * rather than to whatever else the fixture happened to be missing.
 */
function seed(db, over = {}) {
  const office = over.office || 'roland';
  db.seed('rcm_user_map', [
    {
      user_key: 'user-1',
      platform_email: 'biller@example.invalid',
      display_name: 'Fixture Biller',
      active: true,
    },
  ]);
  db.seed('rcm_payment_batches', [
    {
      batch_id: BATCH,
      office_id: office,
      payer: 'DELTA DENTAL OF ARKANSAS',
      check_number: '830200001',
      eft_number: null,
      trace_number: '830200001',
      payment_method: 'check',
      deposit_date: '2026-03-02',
      total_amount_cents: over.batchTotalCents ?? 15000,
      posted_amount_cents: 0,
      plb_total_cents: over.plbTotalCents ?? 0,
      plb_adjustments: [],
      claim_count: 1,
      status: over.batchStatus || 'ready',
      flags: over.batchFlags || [],
      era_file_key: 'tenant/carein/rcm/era/k1.edi',
      notes: '',
      created_by: null,
      created_at: new Date('2026-03-02T10:00:00Z'),
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: CLAIM,
      office_id: office,
      claim_number: '53648',
      check_number: '830200001',
      patient_name: 'Fixture, Synthetic',
      od_patient_id: 12828,
      od_claim_num: over.odClaimNum === null ? null : (over.odClaimNum ?? 53648),
      payer: 'DELTA DENTAL OF ARKANSAS',
      service_date: '2026-03-02',
      received_date: '2026-03-02',
      status: 'matched',
      payment_status: 'unpaid',
      insurance_type: 'primary',
      total_billed_cents: 21000,
      total_allowed_cents: 15000,
      total_paid_cents: over.paidCents ?? 15000,
      total_deductible_cents: 0,
      patient_balance_cents: over.patientBalanceCents ?? 0,
      needs_review_reasons: over.reviewReasons || [],
      confidence: 95,
      od_match_status: over.matchStatus || 'confirmed',
      od_match_snapshot: 'snapshot' in over ? over.snapshot : snapshot(),
      od_match_at: new Date('2026-03-02T11:00:00Z'),
      od_match_confirmed_at: new Date('2026-03-02T11:00:00Z'),
      od_matched_by: 'user-1',
      reviewed_at: over.reviewed === false ? null : new Date('2026-03-02T11:05:00Z'),
      reviewed_by: over.reviewed === false ? null : 'user-1',
      review_note: null,
      posting_queue_id: over.postingQueueId || null,
      approved_at: null,
      approved_by: null,
      created_at: new Date('2026-03-02T10:00:00Z'),
    },
  ]);
  db.seed('rcm_batch_claim_payments', [
    {
      batch_claim_payment_id: '5f46bb33-d78e-573d-87a6-bb42a7bd7478',
      batch_id: BATCH,
      claim_id: CLAIM,
      office_id: office,
      position: 1,
      paid_cents: over.paymentCents ?? over.paidCents ?? 15000,
    },
  ]);
  db.seed('rcm_procedure_lines', [
    {
      line_id: LINE,
      claim_id: CLAIM,
      office_id: office,
      position: 1,
      billed_code: 'D0150',
      paid_code: null,
      code: 'D0150',
      description: 'Comprehensive oral evaluation',
      billed_cents: 21000,
      allowed_cents: 15000,
      deductible_cents: over.lineDeductibleCents ?? 0,
      copay_cents: 0,
      paid_cents: over.linePaidCents ?? over.paidCents ?? 15000,
      adjustment_cents: 6000,
      patient_resp_cents: 0,
      write_off_cents: 6000,
      adjustment_reason: null,
      is_downcoded: false,
      is_bundled: false,
      is_denied: false,
      flags: over.lineFlags || [],
      od_claim_proc_num: over.odClaimProcNum === null ? null : (over.odClaimProcNum ?? 99001),
    },
  ]);
  return db;
}

/** A SECOND claim on the same remittance — the partial-approve fixture. */
function addSecondClaim(db, over = {}) {
  const first = db.table('rcm_claims')[0];
  db.seed('rcm_claims', [
    {
      ...first,
      claim_id: CLAIM2,
      claim_number: '53712',
      patient_name: 'Sample, Placeholder',
      needs_review_reasons: over.reviewReasons || [],
      od_match_status: over.matchStatus || 'confirmed',
      od_claim_num: over.matchStatus && over.matchStatus !== 'confirmed' ? null : 53712,
      od_match_snapshot:
        over.matchStatus && over.matchStatus !== 'confirmed' ? null : snapshot({ odClaimNum: 53712 }),
      total_paid_cents: 5000,
      posting_queue_id: null,
    },
  ]);
  db.seed('rcm_batch_claim_payments', [
    {
      batch_claim_payment_id: 'aa0f152d-3a6e-58aa-aa86-89bbf4b3af17',
      batch_id: BATCH,
      claim_id: CLAIM2,
      office_id: first.office_id,
      position: 2,
      paid_cents: 5000,
    },
  ]);
  db.seed('rcm_procedure_lines', [
    {
      ...db.table('rcm_procedure_lines')[0],
      line_id: LINE2,
      claim_id: CLAIM2,
      paid_cents: 5000,
      write_off_cents: 1000,
      deductible_cents: 0,
      od_claim_proc_num: 99002,
    },
  ]);
  // The batch now moves both claims.
  db.table('rcm_payment_batches')[0].total_amount_cents = 20000;
  return db;
}

async function withApp(opts, fn) {
  const app = await bootRcmApp(opts);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

const approve = (app, batch = BATCH) =>
  api(app.baseUrl, 'POST', `/api/rcm/remittances/${batch}/approve${Q}`, json({}));
const checklist = (app, batch = BATCH) =>
  api(app.baseUrl, 'GET', `/api/rcm/remittances/${batch}/approval${Q}`);

/** The codes that failed, for one claim in a checklist or a refusal body. */
const failedFor = (claims, claimId) => (claims.find((c) => c.claimId === claimId) || {}).failed;

// ─── The happy path, and what it durably records ─────────────────────────────

test('a confirmed, reviewed claim is approved into a durable posting plan', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await approve(app);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.queued.length, 1);
    assert.equal(res.body.withheld.length, 0);
    assert.equal(res.body.queued[0].claimId, CLAIM);
    assert.equal(res.body.queued[0].odClaimNum, 53648);

    // THE WORDS MATTER. Until 6c ships this sentence is exactly true, and it is
    // what the screen prints.
    assert.match(res.body.note, /nothing has been written to Open Dental yet/i);

    const queue = db.table('rcm_posting_queue');
    assert.equal(queue.length, 1);
    assert.equal(queue[0].status, 'approved', 'approved and NOT posted');
    assert.equal(queue[0].posted_total_cents, 0);
    assert.equal(queue[0].is_recoupment, false);
    assert.equal(queue[0].office_id, 'roland');
    assert.ok(queue[0].approved_by, 'a plan exists only because a person approved it');
    assert.equal(Number(queue[0].intended_total_cents), 15000);
  });
});

test('the queue LINE carries the OD identifiers and the intended amounts, in cents', async () => {
  /*
   * RCM_OD_WRITES §8: the worst failure window is between "claim marked
   * Received" and "check created", and recovery works only if the poster knows
   * exactly which claimprocs it had touched and what it meant to write on them.
   * This row is that record, and it exists BEFORE the first Open Dental call.
   */
  const db = seed(new FakeRcmDb(), { lineDeductibleCents: 2500 });
  await withApp({ db }, async (app) => {
    assert.equal((await approve(app)).status, 200);
    const [line] = db.table('rcm_posting_queue_line');
    assert.equal(line.od_claim_proc_num, 99001, 'the claimproc 6c will PUT against');
    assert.equal(line.od_claim_num, 53648, 'the claim whose status it will flip');
    assert.equal(line.claim_id, CLAIM);
    assert.equal(line.intended_ins_pay_amt_cents, 15000);
    // THE DERIVED WRITE-OFF (A3 / D-11), never a reported allowed amount.
    assert.equal(line.intended_write_off_cents, 6000);
    assert.equal(line.intended_ded_applied_cents, 2500);
    assert.equal(line.is_supplemental, false, '6b never plans a supplemental');
    assert.equal(line.status, 'pending');
    assert.equal(line.position, 1);
  });
});

test('the claim is linked to the plan, attributed, and stamped', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    await approve(app);
    const claim = db.table('rcm_claims')[0];
    assert.ok(claim.posting_queue_id, 'the claim-level idempotency guard');
    assert.equal(claim.posting_queue_id, db.table('rcm_posting_queue')[0].queue_id);
    assert.ok(claim.approved_at);
    // D-5: a crosswalk KEY that resolves to a row in rcm_user_map — never a
    // free-text email stamped straight onto the claim. `resolveRcmActor` upserts
    // the signed-in identity on first use, which is what makes the FK
    // satisfiable without anyone pre-seeding a staff crosswalk.
    assert.ok(claim.approved_by);
    const actor = db.table('rcm_user_map').find((u) => u.user_key === claim.approved_by);
    assert.ok(actor, 'approved_by must reference a real crosswalk row');
    assert.equal(actor.platform_email, 'billing@carein.ai');
    assert.equal(db.table('rcm_posting_queue')[0].approved_by, claim.approved_by);
  });
});

test('one audit row per approval, naming the approver, as a CREATE', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    await approve(app);
    const rows = auditRows(db).filter((r) => r.resource_type === 'rcm_posting_approval');
    // The checklist was not requested here, so the approval row is the only one.
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'CREATE', 'a person authorised money to move');
    assert.equal(rows[0].result, 'SUCCESS');
    assert.equal(rows[0].resource_id, BATCH);
    assert.equal(rows[0].office, 'roland');
    assert.ok(rows[0].user_id, 'and it names who');
  });
});

// ─── Rule 4: what can never get through, one condition at a time ─────────────

/**
 * Each row: a name, the fixture mutation that breaks exactly one condition, and
 * the check code that must fail.
 *
 * A table rather than eleven near-identical tests because the POINT is
 * exhaustiveness over rule 4 — a condition dropped from the gate should be a
 * missing row here, visible at a glance, not a test that quietly stopped
 * existing.
 */
const NEVER_APPROVABLE = [
  ['a claim that is not confirmed', { matchStatus: 'no_candidate', odClaimNum: null, snapshot: null }, 'MATCH_CONFIRMED'],
  ['a claim nobody has reviewed', { reviewed: false }, 'REVIEWED'],
  ['a reversal / takeback', { reviewReasons: ['reversal_not_postable'] }, 'NOT_REVERSAL'],
  ['a patient-responsibility-only claim', { paidCents: 0, linePaidCents: 0, paymentCents: 0, patientBalanceCents: 15000, batchTotalCents: 0 }, 'NOT_PATIENT_RESPONSIBILITY_ONLY'],
  ['a recoupment', { paidCents: -4000, linePaidCents: -4000, paymentCents: -4000, batchTotalCents: -4000 }, 'NOT_RECOUPMENT'],
  ['a blocking review reason on the claim', { reviewReasons: ['totals_unreconciled'] }, 'NO_BLOCKING_REASON'],
  ['a blocking flag on the whole remittance', { batchFlags: ['envelope_incomplete'] }, 'NO_BLOCKING_REASON'],
  ['a blocking flag on a line', { lineFlags: ['unreadable_amount'] }, 'NO_BLOCKING_REASON'],
  ['a stale match snapshot', { snapshot: snapshot({ version: 1 }) }, 'SNAPSHOT_CURRENT'],
  ['a snapshot taken against another office', { snapshot: snapshot({ office: 'valley' }) }, 'SNAPSHOT_CURRENT'],
  ['a blocking pre-flight fact', { snapshot: snapshot({ blockers: [{ code: 'LINE_HAS_CLAIM_PAYMENT', blocking: true }] }) }, 'NO_BLOCKING_PREFLIGHT'],
  ['a line with no ClaimProcNum', { odClaimProcNum: null }, 'LINES_PAIRED'],
  ['amounts that do not reconcile', { linePaidCents: 14000 }, 'CLAIM_TOTALS_AGREE'],
];

for (const [name, over, code] of NEVER_APPROVABLE) {
  test(`NEVER approvable: ${name}`, async () => {
    const db = seed(new FakeRcmDb(), over);
    await withApp({ db }, async (app) => {
      // The CHECKLIST predicts it…
      const pre = await checklist(app);
      assert.equal(pre.status, 200, JSON.stringify(pre.body));
      assert.equal(pre.body.postableCount, 0, 'the screen says so before anything is pressed');
      assert.ok(
        (failedFor(pre.body.claims, CLAIM) || []).includes(code),
        `expected ${code} among ${JSON.stringify(failedFor(pre.body.claims, CLAIM))}`
      );

      // …and the BUTTON agrees. A screen that predicts a different outcome from
      // the one the button produces is worse than no screen.
      const res = await approve(app);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.code, 'NOTHING_APPROVABLE');
      assert.ok((failedFor(res.body.claims, CLAIM) || []).includes(code));

      // Nothing was written. Not a queue row, not a line, not a linkage.
      assert.equal(db.table('rcm_posting_queue').length, 0);
      assert.equal(db.table('rcm_posting_queue_line').length, 0);
      assert.equal(db.table('rcm_claims')[0].posting_queue_id, null);
    });
  });
}

test('an unbalanced remittance holds the WHOLE approve, not one claim', async () => {
  /*
   * The missing cents could belong to any claim on the check, so there is no
   * honest way to approve "the ones that look fine". This is the one refusal
   * that is about the batch rather than about a claim.
   */
  const db = seed(new FakeRcmDb(), { batchTotalCents: 19999 });
  await withApp({ db }, async (app) => {
    const res = await approve(app);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'REMITTANCE_UNBALANCED');
    assert.equal(res.body.differenceCents, 4999);
    assert.equal(db.table('rcm_posting_queue').length, 0);

    const pre = await checklist(app);
    assert.equal(pre.body.balanced, false, 'and the checklist says so first');
    assert.equal(pre.body.differenceCents, 4999);
  });
});

test('a refusal is audited as ERROR, never as UNAUTHORIZED', async () => {
  /*
   * Nobody was refused ACCESS. Filing routine gate outcomes under UNAUTHORIZED
   * is how the one signal that means "somebody was refused" stops being
   * readable — the lesson auditRcmDenial's header already carries, applied on a
   * write path for the first time.
   */
  const db = seed(new FakeRcmDb(), { reviewed: false });
  await withApp({ db }, async (app) => {
    await approve(app);
    const rows = auditRows(db).filter((r) => r.resource_type === 'rcm_posting_approval');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, 'ERROR');
  });
});

// ─── Rule 2: there is no way around it ───────────────────────────────────────

test('there is no force flag, no override, and no query parameter that opens it', async () => {
  const db = seed(new FakeRcmDb(), { reviewReasons: ['reversal_not_postable'] });
  await withApp({ db }, async (app) => {
    for (const attempt of [
      { path: `/api/rcm/remittances/${BATCH}/approve${Q}`, body: { force: true } },
      { path: `/api/rcm/remittances/${BATCH}/approve${Q}`, body: { override: true, confirm: 'yes' } },
      { path: `/api/rcm/remittances/${BATCH}/approve${Q}`, body: { claimIds: [CLAIM], skipChecks: true } },
      { path: `/api/rcm/remittances/${BATCH}/approve${Q}&force=true&override=1`, body: {} },
    ]) {
      const res = await api(app.baseUrl, 'POST', attempt.path, json(attempt.body));
      assert.equal(res.status, 409, JSON.stringify(attempt.body));
      assert.equal(res.body.code, 'NOTHING_APPROVABLE');
    }
    assert.equal(db.table('rcm_posting_queue').length, 0);
  });
});

test('the gate re-reads the DATABASE, not what the client believed', async () => {
  /*
   * The workbench may have rendered this claim as confirmed a minute ago and
   * somebody may have force-re-matched it since. The screen is stale; the row
   * is not. Nothing in the request body can put the old answer back.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const claim = db.table('rcm_claims')[0];
    claim.od_match_status = 'candidates';
    claim.od_claim_num = null;

    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/approve${Q}`,
      // Everything the stale screen "knew", handed back to the server.
      json({ claims: [{ claimId: CLAIM, odClaimNum: 53648, confirmed: true, reviewed: true }] })
    );
    assert.equal(res.status, 409);
    assert.ok(failedFor(res.body.claims, CLAIM).includes('MATCH_CONFIRMED'));
  });
});

// ─── Rule 5: idempotency, enforced by the database ───────────────────────────

test('approving twice never enqueues the same claim twice', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    assert.equal((await approve(app)).status, 200);

    const again = await approve(app);
    // Everything postable is already queued, so there is nothing new to do —
    // and saying "approved 0 claims" with a 200 would read as "done" on a busy
    // screen. It is a refusal that names the state instead.
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'NOTHING_APPROVABLE');
    assert.match(again.body.error, /already queued/i);

    assert.equal(db.table('rcm_posting_queue').length, 1, 'one plan');
    assert.equal(db.table('rcm_posting_queue_line').length, 1, 'one line');
  });
});

test('the claim-level guard is the WHERE, so a racing second approve writes nothing', async () => {
  /*
   * `posting_queue_id IS NULL` re-asserted in the UPDATE makes the check and
   * the write ONE statement. The fake is single-threaded, so the race is
   * simulated by setting the linkage between the read and the write — which is
   * exactly what a concurrent approve would have done.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    db.failWhen = (sql) => {
      if (!/UPDATE rcm_claims SET posting_queue_id/.test(sql)) return false;
      db.table('rcm_claims')[0].posting_queue_id = 'someone-elses-plan';
      db.failWhen = null;
      return false;
    };
    const res = await approve(app);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'CLAIM_ALREADY_QUEUED');
    // And the whole transaction rolled back: no orphan plan, no orphan line.
    assert.equal(db.table('rcm_posting_queue').length, 0);
    assert.equal(db.table('rcm_posting_queue_line').length, 0);
  });
});

// ─── Rule: partial success is real success ───────────────────────────────────

test('a partial approve queues what it can and names what it did not', async () => {
  const db = addSecondClaim(seed(new FakeRcmDb()), { reviewReasons: ['reversal_not_postable'] });
  await withApp({ db }, async (app) => {
    const res = await approve(app);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.queued.map((q) => q.claimId), [CLAIM]);
    assert.equal(res.body.withheld.length, 1);
    assert.equal(res.body.withheld[0].claimId, CLAIM2);
    assert.ok(res.body.withheld[0].reasons.includes('NOT_REVERSAL'));
    // The withheld claim carries its full checklist, so the screen can say what
    // to fix without a second round trip.
    assert.ok(res.body.withheld[0].checks.some((c) => c.code === 'NOT_REVERSAL' && !c.passed));

    assert.equal(db.table('rcm_posting_queue_line').length, 1);
    assert.equal(db.table('rcm_claims').find((c) => c.claim_id === CLAIM2).posting_queue_id, null);
  });
});

test('re-approving after a fix enqueues only what was withheld — one plan, appended', async () => {
  const db = addSecondClaim(seed(new FakeRcmDb()), { reviewReasons: ['reversal_not_postable'] });
  await withApp({ db }, async (app) => {
    await approve(app);
    assert.equal(db.table('rcm_posting_queue_line').length, 1);

    // The biller fixes it — here, the carrier re-sent the claim without the
    // reversal flag.
    db.table('rcm_claims').find((c) => c.claim_id === CLAIM2).needs_review_reasons = [];

    const res = await approve(app);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.queued.map((q) => q.claimId), [CLAIM2], 'only the newly-fixed one');
    assert.equal(res.body.alreadyQueued.length, 1);
    assert.equal(res.body.alreadyQueued[0].claimId, CLAIM);

    assert.equal(db.table('rcm_posting_queue').length, 1, 'still ONE plan for the check');
    const lines = db.table('rcm_posting_queue_line');
    assert.equal(lines.length, 2);
    // Positions continue rather than collide — (queue_id, position) is unique,
    // and 6c replays in this order.
    assert.deepEqual(lines.map((l) => l.position).sort(), [1, 2]);
    assert.equal(Number(db.table('rcm_posting_queue')[0].intended_total_cents), 20000);
  });
});

// ─── Rule 3: permission ──────────────────────────────────────────────────────

test('a reviewer cannot approve — and the refusal names the tier', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'reviewer' }, async (app) => {
    const res = await approve(app);
    assert.equal(res.status, 403);
    // The mount's requireReadWrite refuses first (approve is deliberately NOT
    // in QUEUE_PATHS), so the code is the platform's FORBIDDEN and the action
    // it names is what a colleague would need. The route's own
    // APPROVE_REQUIRES_WRITE check behind it is defence in depth.
    assert.equal(res.body.action, 'rcm.write');
    assert.equal(db.table('rcm_posting_queue').length, 0);
  });
});

test('a reviewer CAN read the checklist, and is told who can press it', async () => {
  /*
   * The person who does the reviewing should be able to see the consequences of
   * her own work. Seeing why a claim will be withheld is not a posting act.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'reviewer' }, async (app) => {
    const res = await checklist(app);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.canApprove, false);
    assert.equal(res.body.approveRequires, 'rcm.write');
    assert.equal(res.body.postableCount, 1, 'and it still says the truth about the claim');
  });
});

test('an approver is told they can', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await checklist(app);
    assert.equal(res.body.canApprove, true);
  });
});

// ─── Office is a boundary, not a filter ──────────────────────────────────────

test("another practice's remittance is NOT FOUND, on both the checklist and the gate", async () => {
  const db = seed(new FakeRcmDb(), { office: 'valley' });
  await withApp({ db }, async (app) => {
    assert.equal((await checklist(app)).status, 404);
    const res = await approve(app);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'REMITTANCE_NOT_FOUND');
    assert.equal(db.table('rcm_posting_queue').length, 0);
  });
});

test('a malformed id is NOT FOUND rather than a 500', async () => {
  // Postgres refuses a non-uuid literal in a uuid comparison, which used to
  // surface as INTERNAL_ERROR — and the shape of the error told a prober which
  // ids were real.
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    for (const id of ['not-a-uuid', '../../etc', '1']) {
      const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances/${encodeURIComponent(id)}/approval${Q}`);
      assert.equal(res.status, 404, id);
      assert.equal(res.body.code, 'REMITTANCE_NOT_FOUND');
    }
  });
});

test('the office is required, and it comes from the query param alone', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/approve`,
      // A body that ASSERTS an office cannot supply one.
      json({ office: 'roland', office_id: 'roland' })
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_OFFICE');
  });
});

// ─── The pure evaluator, directly ────────────────────────────────────────────

test('every check the gate can apply has copy that says what to do about it', () => {
  for (const code of approvalGate.CHECK_ORDER) {
    const spec = approvalGate.CHECKS[code];
    assert.ok(spec.label && spec.label.length > 3, code);
    assert.ok(spec.fix && spec.fix.length > 20, `${code} must tell a biller what to DO`);
  }
});

test('patient-responsibility-only is "carrier paid nothing AND patient owes", not "paid nothing"', () => {
  /*
   * A genuine zero — a full contractual write-off, an applied-to-deductible
   * with no balance — is a legitimate $0 adjudication Open Dental takes
   * happily. Refusing every zero would strand every claim a payer zeroed out.
   */
  assert.equal(approvalGate.isPatientResponsibilityOnly({ totalPaidCents: 0, patientBalanceCents: 8000 }), true);
  assert.equal(approvalGate.isPatientResponsibilityOnly({ totalPaidCents: 0, patientBalanceCents: 0 }), false);
  assert.equal(approvalGate.isPatientResponsibilityOnly({ totalPaidCents: 15000, patientBalanceCents: 8000 }), false);
});

test('a takeback is read off the money, on both sides', () => {
  assert.equal(approvalGate.isRecoupment({ totalPaidCents: -4000 }, null), true);
  assert.equal(approvalGate.isRecoupment({ totalPaidCents: 0 }, { paidCents: -4000 }), true);
  assert.equal(approvalGate.isRecoupment({ totalPaidCents: 15000 }, { paidCents: 15000 }), false);
});

test('the cheap list predicate is a strict subset of the real gate', () => {
  /*
   * `looksApprovable` may say yes where the full gate says no — that is its
   * documented contract, and the two obligations it chooses between are both
   * obligations. What it must NEVER do is say no where the gate says yes, which
   * would hide an approvable remittance from the queue entirely.
   */
  const claim = {
    postingQueueId: null,
    odMatchStatus: 'confirmed',
    reviewedAt: '2026-03-02T11:05:00.000Z',
    needsReviewReasons: [],
  };
  assert.equal(approvalGate.looksApprovable(claim, []), true);
  assert.equal(approvalGate.looksApprovable({ ...claim, odMatchStatus: 'candidates' }, []), false);
  assert.equal(approvalGate.looksApprovable({ ...claim, reviewedAt: null }, []), false);
  assert.equal(approvalGate.looksApprovable({ ...claim, postingQueueId: 'q' }, []), false);
  assert.equal(approvalGate.looksApprovable(claim, ['envelope_incomplete']), false);
  // Annotating reasons never hide a remittance from the approval queue.
  assert.equal(approvalGate.looksApprovable({ ...claim, needsReviewReasons: ['procedure_downcoded'] }, []), true);
  assert.equal(approvalGate.looksApprovable(claim, ['plb_adjustments_present']), true);
});
