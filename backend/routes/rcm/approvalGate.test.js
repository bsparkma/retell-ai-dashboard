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

const { FakeRcmDb, FakeOd, bootRcmApp, api, auditRows } = require('./rcmTestUtils');
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
    /*
     * THE ORIGIN OF THE REFUSAL IS PINNED, not just its status.
     *
     * `FORBIDDEN` is the MOUNT's code: approve is deliberately not in
     * QUEUE_PATHS, so `requireReadWrite` refuses before the handler runs and the
     * route's own APPROVE_REQUIRES_WRITE check never fires. Asserting the code
     * is what makes that structural — if somebody exempts the path later, this
     * test goes red instead of quietly relying on defence in depth.
     */
    assert.equal(res.body.code, 'FORBIDDEN');
    assert.equal(res.body.action, 'rcm.write');

    // AND NO SIDE EFFECT. Not a queue row, not a linkage, and not even the
    // attempt stamp — the handler was never reached.
    assert.equal(db.table('rcm_posting_queue').length, 0);
    assert.equal(db.table('rcm_posting_queue_line').length, 0);
    assert.equal(db.table('rcm_claims')[0].posting_queue_id, null);
    assert.equal(db.table('rcm_payment_batches')[0].approval_attempted_at, undefined);
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

// ─── Review fixes (PR #96) ───────────────────────────────────────────────────

test('F1: two claims on ONE remittance cannot both take the same chart line', async () => {
  /*
   * Nothing makes `(office_id, od_claim_num)` unique across `rcm_claims`, so two
   * claims can be confirmed to one Open Dental claim and pair to the same
   * ClaimProcNums. When both are on the SAME remittance the collision happens
   * inside one press, which the per-claim pre-check cannot see — it consults
   * plans that already exist. It used to reach the index and come back as a
   * race ("somebody else was writing"), which is a confusing thing to tell
   * somebody who pressed the button once.
   *
   * Partial success is real success: the first claim posts, the second is
   * withheld and named.
   */
  const db = addSecondClaim(seed(new FakeRcmDb()));
  // The second claim's confirmed match resolves to the SAME chart line.
  db.table('rcm_procedure_lines').find((l) => l.claim_id === CLAIM2).od_claim_proc_num = 99001;

  await withApp({ db }, async (app) => {
    // The CHECKLIST predicts it, before anything is pressed.
    const pre = await checklist(app);
    assert.equal(pre.body.postableCount, 1, 'one of the two, not both');
    assert.equal(pre.body.withheldCount, 1);
    const held = pre.body.claims.find((c) => !c.postable);
    assert.ok(held.failed.includes('CLAIMPROC_NOT_ALREADY_PLANNED'));
    assert.match(
      held.checks.find((c) => c.code === 'CLAIMPROC_NOT_ALREADY_PLANNED').detail,
      /also on another claim in this same remittance/
    );

    // And the button agrees — no crash, no race message, one line planned.
    const res = await approve(app);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.queued.length, 1);
    assert.equal(res.body.withheld.length, 1);
    assert.equal(db.table('rcm_posting_queue_line').length, 1);
  });
});

test('F1: the pre-check names the claim whose chart line is already planned', async () => {
  const db = addSecondClaim(seed(new FakeRcmDb()));
  const second = db.table('rcm_procedure_lines').find((l) => l.claim_id === CLAIM2);
  second.od_claim_proc_num = 99001;

  // CLAIM was approved earlier; CLAIM2 now collides with its plan.
  db.seed('rcm_posting_queue', [
    {
      queue_id: 'aaaaaaaa-1111-4111-8111-111111111111',
      office_id: 'roland',
      batch_id: BATCH,
      remittance_key: 'EARLIER',
      status: 'approved',
      approved_by: 'user-1',
    },
  ]);
  db.seed('rcm_posting_queue_line', [
    {
      queue_line_id: 'bbbbbbbb-1111-4111-8111-111111111111',
      queue_id: 'aaaaaaaa-1111-4111-8111-111111111111',
      office_id: 'roland',
      position: 1,
      od_claim_proc_num: 99001,
      claim_id: CLAIM,
      intended_ins_pay_amt_cents: 15000,
      is_supplemental: false,
      status: 'pending',
    },
  ]);
  Object.assign(db.table('rcm_claims').find((c) => c.claim_id === CLAIM), {
    posting_queue_id: 'aaaaaaaa-1111-4111-8111-111111111111',
    approved_at: new Date(),
    approved_by: 'user-1',
  });

  await withApp({ db }, async (app) => {
    // Predicted BEFORE the button, which is the whole point of the checklist.
    const pre = await checklist(app);
    assert.equal(pre.status, 200, JSON.stringify(pre.body));
    assert.ok(failedFor(pre.body.claims, CLAIM2).includes('CLAIMPROC_NOT_ALREADY_PLANNED'));
    const check = pre.body.claims
      .find((c) => c.claimId === CLAIM2)
      .checks.find((c) => c.code === 'CLAIMPROC_NOT_ALREADY_PLANNED');
    assert.match(check.detail, /ClaimProcNum 99001/);
    assert.equal(pre.body.postableCount, 0);

    // And the button agrees, with no crash and nothing written.
    const res = await approve(app);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'NOTHING_APPROVABLE');
    assert.equal(db.table('rcm_posting_queue_line').length, 1, 'the earlier plan is untouched');
  });
});

test('F1: losing the RACE to the index is a named 409, and rolls back', async () => {
  /*
   * The pre-check reads on this connection and cannot see another transaction's
   * uncommitted line. The database is still the guarantee — this asserts that
   * losing to it reaches the biller as a refusal rather than as INTERNAL_ERROR.
   *
   * The race is simulated by planting the conflicting line between the check and
   * the write, which is exactly what a concurrent approve would have done.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    db.failWhen = (sql) => {
      if (!/INSERT INTO rcm_posting_queue_line/.test(sql)) return false;
      db.table('rcm_posting_queue_line').push({
        queue_line_id: 'cccccccc-1111-4111-8111-111111111111',
        queue_id: 'someone-elses-plan',
        office_id: 'roland',
        position: 99,
        od_claim_proc_num: 99001,
        is_supplemental: false,
      });
      db.failWhen = null;
      return false;
    };

    const res = await approve(app);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'CLAIMPROC_ALREADY_PLANNED');
    assert.match(res.body.error, /somebody else/i);

    // Rolled back: no plan, no linkage. Only the planted row survives.
    assert.equal(db.table('rcm_posting_queue').length, 0);
    assert.equal(db.table('rcm_claims')[0].posting_queue_id, null);
  });
});

test('F1: any OTHER unique violation is still a 500 — it is a bug, not a refusal', () => {
  // Dressing an unexpected constraint failure as a tidy refusal would hide it.
  const claim = { claimId: CLAIM, claimNumber: '53648', patientName: 'Fixture, Synthetic' };
  const other = Object.assign(new Error('dup'), { code: '23505', constraint: 'something_else' });
  assert.equal(approvalGate.asClaimprocConflict(other, claim), null);

  const notUnique = Object.assign(new Error('boom'), { code: '23503' });
  assert.equal(approvalGate.asClaimprocConflict(notUnique, claim), null);

  const ours = Object.assign(new Error('dup'), {
    code: '23505',
    constraint: 'rcm_posting_queue_line_claimproc_unique',
  });
  assert.equal(approvalGate.asClaimprocConflict(ours, claim).code, 'CLAIMPROC_ALREADY_PLANNED');
});

test('F2: a wholly-refused approve is RECORDED, so the remittance stays in the queue', async () => {
  /*
   * The hole: a refusal rolls back, so it left no queue row — and
   * `claims_withheld` fired only when a queue row existed. A biller who pressed
   * Approve, was told "nothing here can be posted and here is why", and went
   * back to the list found the remittance GONE from the default view.
   */
  const db = seed(new FakeRcmDb(), { reviewed: false });
  await withApp({ db }, async (app) => {
    assert.equal(
      db.table('rcm_payment_batches')[0].approval_attempted_at,
      undefined,
      'nobody has pressed it yet'
    );

    const res = await approve(app);
    assert.equal(res.status, 409);
    assert.equal(db.table('rcm_posting_queue').length, 0, 'and nothing was queued');

    /*
     * Re-read rather than holding a reference across the call: the refusal
     * ROLLED BACK, and a rollback restores the snapshot, so the row object the
     * table held beforehand is not the row object it holds now. Which is the
     * whole point — the stamp is written on its own connection, AFTER that
     * rollback, and is the only thing that survives it.
     */
    const batch = db.table('rcm_payment_batches')[0];
    assert.ok(batch.approval_attempted_at, 'the attempt is on the record');
    assert.ok(batch.approval_attempted_by, 'and it names who');
  });
});

test('F2: after a refused approve the remittance is WITHHELD, not merely unready', async () => {
  const db = seed(new FakeRcmDb(), { reviewed: false });
  await withApp({ db }, async (app) => {
    // Reviewed now, but still unapprovable for another reason.
    Object.assign(db.table('rcm_claims')[0], {
      reviewed_at: new Date(),
      reviewed_by: 'user-1',
      needs_review_reasons: ['totals_unreconciled'],
    });

    const before = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.equal(before.body.remittances[0].needsAttention, false, 'nothing owed BEFORE anyone tries');

    await approve(app);

    const after = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    const row = after.body.remittances[0];
    assert.equal(row.needsAttention, true, 'somebody was told this needs work — it stays in view');
    assert.deepEqual(row.attentionReasons, ['claims_withheld']);
    assert.ok(row.approvalAttemptedAt, 'and the wire says when it was tried');
    assert.equal(after.body.needsAttentionCount, 1);
  });
});

test('F3: a claim stamped with ANOTHER office is withheld and NAMED', async () => {
  /*
   * `loadForApproval` used to select claims `WHERE office_id = $1`, so a foreign
   * claim dropped silently out of the checklist while its payment still counted
   * in the batch sum. The only symptom was REMITTANCE_UNBALANCED naming nobody.
   */
  const db = addSecondClaim(seed(new FakeRcmDb()));
  const foreign = db.table('rcm_claims').find((c) => c.claim_id === CLAIM2);
  foreign.office_id = 'valley';
  foreign.patient_name = 'Valley, Patient';

  await withApp({ db }, async (app) => {
    const pre = await checklist(app);
    assert.equal(pre.status, 200, JSON.stringify(pre.body));

    const row = pre.body.claims.find((c) => c.claimId === CLAIM2);
    assert.ok(row, 'the foreign claim is still SHOWN — dropping it is what hid the defect');
    assert.equal(row.postable, false);
    assert.ok(row.failed.includes('OFFICE_CONSISTENT'));
    const check = row.checks.find((c) => c.code === 'OFFICE_CONSISTENT');
    assert.equal(check.passed, false);
    assert.match(check.detail, /valley/);

    // AND NO CROSS-OFFICE PHI. This office has no business reading the other
    // practice's patient on its own screen.
    assert.equal(row.patientName, "(a claim belonging to another practice)");
    assert.ok(!JSON.stringify(pre.body).includes('Valley, Patient'));

    // The remaining conditions say they were not evaluated rather than
    // asserting anything about a row we should not be reading.
    for (const c of row.checks.filter((x) => x.code !== 'OFFICE_CONSISTENT')) {
      assert.equal(c.passed, false);
      assert.match(c.detail, /not evaluated/);
    }
  });
});

test('F4: a confirmed ClaimNum missing from the candidates FAILS, it does not pass', async () => {
  /*
   * The lookup returned undefined, `blockers` defaulted to `[]`, and
   * NO_BLOCKING_PREFLIGHT passed — absence read as clean, which is the module's
   * recurring defect shape.
   */
  const db = seed(new FakeRcmDb(), {
    // A snapshot whose confirmation names 53648 but whose candidate list does not.
    snapshot: {
      ...snapshot(),
      candidates: [{ odClaimNum: 99999, blockers: [], linePairs: [] }],
    },
  });
  await withApp({ db }, async (app) => {
    const pre = await checklist(app);
    const failed = failedFor(pre.body.claims, CLAIM);
    assert.ok(failed.includes('SNAPSHOT_CURRENT'), JSON.stringify(failed));
    assert.ok(
      failed.includes('NO_BLOCKING_PREFLIGHT'),
      'the check whose empty list is dangerous must not pass on absence'
    );
    assert.equal(pre.body.postableCount, 0);

    const res = await approve(app);
    assert.equal(res.status, 409);
    assert.equal(db.table('rcm_posting_queue').length, 0);
  });
});

test('F5: a claim on a posting plan cannot be re-matched, and no chart is read', async () => {
  /*
   * A forced re-run NULLs `od_claim_num` and moves the status off `confirmed`,
   * which `rcm_claims_approved_is_confirmed_check` refuses — so it used to 500
   * AFTER the Open Dental read had already happened. A chart read for an
   * operation that could never have completed.
   */
  const db = seed(new FakeRcmDb(), { postingQueueId: 'aaaaaaaa-1111-4111-8111-111111111111' });
  Object.assign(db.table('rcm_claims')[0], {
    approved_at: new Date(),
    approved_by: 'user-1',
  });
  const od = new FakeOd({ patients: [], claims: [], claimProcs: [], procedures: [] });

  await withApp({ db, od }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/${CLAIM}/match${Q}`, json({ force: true }));
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'CLAIM_ON_POSTING_PLAN');

    // BEFORE any Open Dental call — that is the half that mattered.
    assert.deepEqual(od.methodsUsed(), []);
    // And the confirmation is intact.
    assert.equal(db.table('rcm_claims')[0].od_claim_num, 53648);
    assert.equal(db.table('rcm_claims')[0].od_match_status, 'confirmed');
  });
});

test('F5: a queued claim cannot be re-pointed at a different Open Dental claim', async () => {
  const db = seed(new FakeRcmDb(), { postingQueueId: 'aaaaaaaa-1111-4111-8111-111111111111' });
  Object.assign(db.table('rcm_claims')[0], { approved_at: new Date(), approved_by: 'user-1' });

  await withApp({ db }, async (app) => {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/${CLAIM}/confirm-match${Q}`,
      json({ odClaimNum: 77777 })
    );
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'CLAIM_ON_POSTING_PLAN');
    // "Release that first" was impossible advice here; the message says the
    // reachable thing instead.
    assert.match(res.body.error, /posting plan/i);
    assert.equal(db.table('rcm_claims')[0].od_claim_num, 53648);
  });

  // Re-confirming the SAME ClaimNum stays idempotent — it asks for a decision
  // that is already recorded, and gets it.
  const db2 = seed(new FakeRcmDb(), { postingQueueId: 'aaaaaaaa-1111-4111-8111-111111111111' });
  Object.assign(db2.table('rcm_claims')[0], { approved_at: new Date(), approved_by: 'user-1' });
  await withApp({ db: db2 }, async (app) => {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/${CLAIM}/confirm-match${Q}`,
      json({ odClaimNum: 53648 })
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.alreadyConfirmed, true);
  });
});

test('the approve reads the claims FOR UPDATE, inside one transaction', async () => {
  /*
   * The lock is what makes "re-read and re-check inside the transaction" mean
   * anything: without it two approvals both read a postable claim and the second
   * write lands on top of the first. Mirrors the confirm-match lock test.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    db.log.length = 0;
    assert.equal((await approve(app)).status, 200);

    const sql = db.log.map((q) => q.sql);
    const begin = sql.indexOf('BEGIN');
    const commit = sql.indexOf('COMMIT');
    assert.ok(begin > -1 && commit > begin, 'BEGIN … COMMIT');

    const read = db.log
      .slice(begin, commit)
      .filter((q) => /^SELECT .* FROM rcm_claims WHERE/.test(q.sql));
    assert.ok(read.length > 0, 'the claims are read inside the transaction');
    assert.match(read[0].sql, / FOR UPDATE$/, 'and held for its length');

    // Every write lands between the two, so a refusal after any of them undoes
    // all of them.
    for (const pattern of [
      /^INSERT INTO rcm_posting_queue /,
      /^INSERT INTO rcm_posting_queue_line /,
      /^UPDATE rcm_claims SET posting_queue_id/,
    ]) {
      const at = sql.findIndex((q) => pattern.test(q));
      assert.ok(at > begin && at < commit, `${pattern} must be inside the transaction`);
    }
  });
});

// ─── Slice 6c: the refusal when the plan has already been drained ────────────

/**
 * Approve once, then put the plan into `status`, then approve again with a
 * second claim that is now postable.
 *
 * The plan has to be created by a real approve rather than seeded, because the
 * second press has to find it through `resolveRemittanceKey` — the same key the
 * first press derived. Seeding a row with a guessed key would test nothing.
 */
async function approveThenSetStatus(app, db, status) {
  const first = await approve(app);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.queued.length, 1, 'only the reviewed claim was queued');
  assert.equal(first.body.withheld.length, 1, 'and the second was withheld');

  const plan = db.table('rcm_posting_queue')[0];
  plan.status = status;
  if (status === 'posted') {
    plan.od_claim_payment_num = 21253;
    plan.reconciled_at = new Date();
  }

  // The biller now does the thing that was withholding the second claim. This is
  // exactly the sequence the limitation bites on: fix a withheld claim AFTER its
  // remittance's plan has run.
  const second = db.table('rcm_claims').find((c) => c.claim_id === CLAIM2);
  second.reviewed_at = new Date();
  second.reviewed_by = 'user-1';
  return plan;
}

/** The second claim, present and postable EXCEPT that nobody has reviewed it. */
function withUnreviewedSecondClaim(db) {
  addSecondClaim(db);
  const second = db.table('rcm_claims').find((c) => c.claim_id === CLAIM2);
  second.reviewed_at = null;
  second.reviewed_by = null;
  return db;
}

test('6c: a claim cannot join a plan that has already POSTED, and the refusal says so', async () => {
  /*
   * THE LIMITATION THIS MAKES VISIBLE.
   *
   * `rcm_posting_queue` is unique on `(office_id, remittance_key)`, so a
   * remittance gets exactly one plan, ever. A claim withheld at approval and
   * fixed after that plan has drained cannot post through CareIN at all.
   *
   * Before 6c the refusal said "a posting run for this remittance is already
   * under way" — false for a plan that finished hours ago, and it read as "wait
   * a minute and try again", which would never come good.
   */
  const db = withUnreviewedSecondClaim(seed(new FakeRcmDb()));
  await withApp({ db }, async (app) => {
    await approveThenSetStatus(app, db, 'posted');

    const res = await approve(app);

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'QUEUE_ALREADY_RAN', 'not QUEUE_ALREADY_RUNNING');
    assert.equal(res.body.queueStatus, 'posted', 'the screen can link somewhere useful');

    // The sentence is TRUE, and it names the way out.
    assert.doesNotMatch(res.body.error, /under way/i);
    assert.match(res.body.error, /already finished/i);
    assert.match(res.body.error, /by hand in Open Dental/i);

    // Nothing was appended to the finished plan.
    assert.equal(db.table('rcm_posting_queue').length, 1);
    assert.equal(db.table('rcm_posting_queue_line').length, 1);
  });
});

test('6c: a plan a drain holds RIGHT NOW still says "under way" — waiting is the answer', async () => {
  // The one status the original single sentence was ever true for, kept.
  const db = withUnreviewedSecondClaim(seed(new FakeRcmDb()));
  await withApp({ db }, async (app) => {
    await approveThenSetStatus(app, db, 'posting');

    const res = await approve(app);

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'QUEUE_ALREADY_RUNNING');
    assert.equal(res.body.queueStatus, 'posting');
    assert.match(res.body.error, /already under way/i);
  });
});

test('6c: every already-ran status gets a sentence that is true of it', async () => {
  /*
   * `partially_posted` is the one that would be most damaging to get wrong: money
   * IS in the chart, and a sentence saying the run "finished" would send a biller
   * looking for a completed payment that is not there.
   */
  const posted = approvalGate.alreadyRanMessage('posted');
  const partial = approvalGate.alreadyRanMessage('partially_posted');
  const failed = approvalGate.alreadyRanMessage('failed');
  const blocked = approvalGate.alreadyRanMessage('blocked');

  assert.match(posted, /already finished/i);
  assert.match(partial, /stopped\s+part-way/i);
  assert.doesNotMatch(partial, /already finished/i);
  assert.equal(failed, blocked, 'both mean "a drain has had it and it is not accepting more"');
  assert.doesNotMatch(failed, /already finished/i);

  // None of them claims a run is in progress.
  for (const [label, msg] of [['posted', posted], ['partial', partial], ['failed', failed]]) {
    assert.doesNotMatch(msg, /under way/i, label);
    assert.match(msg, /by hand in Open Dental/i, label);
  }

  // And `posting` is deliberately NOT one of them.
  assert.ok(!approvalGate.TERMINAL_QUEUE_STATUSES.includes('posting'));
  assert.ok(!approvalGate.TERMINAL_QUEUE_STATUSES.includes('approved'));
});

// ═══════════════════════════════════════════════════════════════════════════
// D-6 — the typed confirmation (6d)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The friction D-6 chose over a second approver: the person authorising an
 * irreversible chart write reads an amount and types it back.
 *
 * These tests are about the STRING, because that is the contract. The dialog
 * shows what the server computed; the server demands what it showed. Any
 * looseness in between — a parse, a locale, a currency symbol — is a place where
 * two people can disagree about what "as displayed" meant.
 */


/**
 * A claim row shaped exactly as `toApprovalClaim` produces one, PASSING every
 * check that is not the subject of the test using it.
 *
 * Built by hand rather than seeded through the database because these tests are
 * about `evaluateClaim` as a pure function — one claim in, a verdict out — and
 * a fixture that had to travel through Postgres to be judged would make a
 * failure ambiguous between the rule and the round trip.
 */
function baseClaim() {
  return {
    claimId: 'c0000000-0000-4000-8000-000000000001',
    officeId: 'roland',
    claimNumber: '53648',
    patientName: 'Test 2, Stedi',
    odClaimNum: 53648,
    odMatchStatus: 'confirmed',
    matchSnapshot: {
      version: SNAPSHOT_VERSION_FOR_TEST,
      office: 'roland',
      candidates: [{ odClaimNum: 53648 }],
      confirmed: { odClaimNum: 53648 },
    },
    reviewedAt: '2026-08-26T00:00:00.000Z',
    needsReviewReasons: [],
    totalPaidCents: 0,
    patientBalanceCents: 0,
    postingQueueId: null,
    approvedAt: null,
    approvedByKey: null,
  };
}

/** The snapshot version the gate demands, read from the module rather than typed. */
const SNAPSHOT_VERSION_FOR_TEST = require('./matchService').SNAPSHOT_VERSION;

test('the displayed total and the demanded phrase come from ONE formatter', () => {
  assert.equal(approvalGate.formatRecoupmentTotal(-5408), '-54.08');
  assert.equal(approvalGate.formatRecoupmentTotal(-20), '-0.20');
  assert.equal(approvalGate.formatRecoupmentTotal(-100000), '-1000.00');
  // No thousands separators: a comma is a decimal point in half the world.
  assert.doesNotMatch(approvalGate.formatRecoupmentTotal(-123456), /,/);
  // Two decimals always, so 54.8 and 54.80 are never both "right".
  assert.equal(approvalGate.formatRecoupmentTotal(-5480), '-54.80');
  // A positive total still formats, so a mixed remittance can display one.
  assert.equal(approvalGate.formatRecoupmentTotal(1500), '15.00');
});

test('the typed phrase must match EXACTLY — a parse would accept four wrong answers', () => {
  const expected = -5408;
  assert.equal(approvalGate.checkTypedRecoupmentTotal('-54.08', expected).ok, true);
  // Whitespace is invisible on a screen and carries no meaning.
  assert.equal(approvalGate.checkTypedRecoupmentTotal('  -54.08 ', expected).ok, true);

  /*
   * Every one of these parses to the same NUMBER and none of them is what the
   * screen displayed. Accepting them would mean the approver never had to look.
   */
  for (const near of ['-54.080', '-54.8', '- 54.08', '(54.08)', '−54.08', '54.08', '-5408']) {
    assert.equal(
      approvalGate.checkTypedRecoupmentTotal(near, expected).ok,
      false,
      `${JSON.stringify(near)} must NOT be accepted as -54.08`
    );
  }
});

test('an empty or non-string confirmation is refused, never treated as absent', () => {
  for (const junk of ['', '   ', null, undefined, 5408, {}, ['-54.08']]) {
    assert.equal(
      approvalGate.checkTypedRecoupmentTotal(junk, -5408).ok,
      false,
      `${JSON.stringify(junk)} must be refused`
    );
  }
});

test('the checker reports what it WANTED, so a refusal can show the phrase again', () => {
  const got = approvalGate.checkTypedRecoupmentTotal('-54.00', -5408);
  assert.equal(got.ok, false);
  assert.equal(got.expected, '-54.08', 'a dialog that says "wrong" without saying what is wanted is a guessing game');
});

test('the ordinary approve can NEVER take a takeback, whatever it is passed', () => {
  /*
   * The load-bearing half of the swap. `recoupmentAllowed` defaults to false and
   * `POST /:id/approve` never passes it, so both takeback checks block exactly
   * as they did in 6b.
   */
  const claim = { totalPaidCents: -5408, patientBalanceCents: 0, needsReviewReasons: [] };
  const codes = (checks) => checks.filter((c) => !c.passed).map((c) => c.code);

  const ordinary = approvalGate.evaluateClaim({
    office: 'roland',
    claim: { ...baseClaim(), ...claim },
    lines: [],
    payment: { paidCents: -5408, batchClaimPaymentId: null },
    batchFlags: [],
  });
  assert.ok(codes(ordinary.checks).includes('NOT_RECOUPMENT'));
  assert.equal(ordinary.postable, false);
});

test('the recoupment approve SWAPS the takeback checks — it does not remove them', () => {
  /*
   * On the recoupment path `NOT_RECOUPMENT` is gone and `RECOUPMENT_CONFIRMED`
   * is in its place, so the gate never has FEWER conditions on a takeback than
   * on an ordinary claim — it has a different, harder one.
   */
  const evaluated = approvalGate.evaluateClaim({
    office: 'roland',
    claim: { ...baseClaim(), totalPaidCents: -5408, patientBalanceCents: 0, needsReviewReasons: [] },
    lines: [],
    payment: { paidCents: -5408, batchClaimPaymentId: null },
    batchFlags: [],
    recoupmentAllowed: true,
  });
  const codes = evaluated.checks.map((c) => c.code);
  assert.ok(!codes.includes('NOT_RECOUPMENT'), 'the blanket refusal is gone');
  assert.ok(codes.includes('RECOUPMENT_CONFIRMED'), 'and something harder took its place');
  assert.equal(
    evaluated.checks.find((c) => c.code === 'RECOUPMENT_CONFIRMED').passed,
    true
  );

  // …and every OTHER condition still applies. This is the whole claim.
  for (const still of ['OFFICE_CONSISTENT', 'MATCH_CONFIRMED', 'REVIEWED', 'LINES_PAIRED', 'CLAIM_TOTALS_AGREE']) {
    assert.ok(codes.includes(still), `${still} must still be checked on a takeback`);
  }
});

test('an ORDINARY claim cannot ride along on a takeback confirmation', () => {
  /*
   * The typed phrase confirms one specific negative total. A positive claim
   * riding on it would post money the approver never typed a number for — the
   * confirmation would describe a smaller set than the one it authorised.
   */
  const evaluated = approvalGate.evaluateClaim({
    office: 'roland',
    claim: { ...baseClaim(), totalPaidCents: 15000, patientBalanceCents: 0, needsReviewReasons: [] },
    lines: [],
    payment: { paidCents: 15000, batchClaimPaymentId: null },
    batchFlags: [],
    recoupmentAllowed: true,
  });
  const confirmed = evaluated.checks.find((c) => c.code === 'RECOUPMENT_CONFIRMED');
  assert.equal(confirmed.passed, false);
  assert.equal(evaluated.postable, false);
});

test('every check the gate can fail has copy a screen can print', () => {
  /*
   * `RECOUPMENT_CONFIRMED` is new, and a check with no entry in CHECKS renders
   * as an empty row on the checklist — the same failure the 6b labels test
   * caught one level down.
   */
  for (const code of approvalGate.CHECK_ORDER) {
    assert.ok(approvalGate.CHECKS[code], `${code} has no label`);
    assert.ok(approvalGate.CHECKS[code].label, `${code} has no label`);
    assert.ok(approvalGate.CHECKS[code].fix, `${code} has no fix text`);
  }
  assert.ok(approvalGate.CHECK_ORDER.includes('RECOUPMENT_CONFIRMED'));
});

test('the two takeback paths are named, and the reversible one is the default', () => {
  assert.deepEqual([...approvalGate.RECOUPMENT_PATHS], ['adjustment', 'supplemental']);
});

// ═══════════════════════════════════════════════════════════════════════════
// D-6 at the route: what a WRONG phrase costs, and what it leaves behind
// ═══════════════════════════════════════════════════════════════════════════

/** A takeback: the batch and its claim both move money backwards. */
function seedTakebackRemittance(db) {
  seed(db);
  const batch = db.table('rcm_payment_batches')[0];
  batch.total_amount_cents = -5408;
  for (const claim of db.table('rcm_claims')) {
    claim.total_paid_cents = -5408;
    claim.patient_balance_cents = 0;
  }
  for (const payment of db.table('rcm_batch_claim_payments')) {
    payment.paid_cents = -5408;
  }
  for (const line of db.table('rcm_procedure_lines')) {
    line.paid_cents = -5408;
  }
  return db;
}

const approveRecoup = (app, body, batch = BATCH) =>
  api(app.baseUrl, 'POST', `/api/rcm/remittances/${batch}/approve-recoupment${Q}`, json(body));

test('the takeback checklist ships the phrase to type, formatted by the server', async () => {
  const db = seedTakebackRemittance(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances/${BATCH}/recoupment${Q}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    /*
     * RENDERED VERBATIM by the client. The whole point of the server owning the
     * formatting is that the number a person reads and the number the server
     * will demand cannot drift apart.
     */
    assert.equal(res.body.typedTotalExpected, '-54.08');
    assert.equal(res.body.recoupmentTotalCents, -5408);
    assert.ok(res.body.recoupmentClaims >= 1);
    // The server states the default so a client cannot pre-select the
    // irreversible path by omission.
    assert.equal(res.body.defaultPath, 'adjustment');
    assert.deepEqual(res.body.paths, ['adjustment', 'supplemental']);
  });
});

test('a WRONG typed phrase refuses, records no approval — and LEAVES AN AUDIT ROW', async () => {
  /*
   * ─────────────────────────────────────────────────────────────────────────
   * "NOTHING RECORDED" MEANS NO APPROVAL. IT DOES NOT MEAN NO TRAIL.
   * ─────────────────────────────────────────────────────────────────────────
   * The 6d brief said a mismatch records nothing, and read literally that would
   * make repeated wrong guesses at an irreversible operation INVISIBLE — which
   * is the one thing an audit log exists to prevent. Beau's ruling: the refusal
   * is audited.
   *
   * The two halves are different claims and both are asserted below:
   *   - nothing was AUTHORISED — no plan, no claim link, no attempt stamp;
   *   - something was RECORDED — who tried, on which remittance, in which
   *     office, and that it failed.
   */
  const db = seedTakebackRemittance(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await approveRecoup(app, { typedTotal: '-54.00', path: 'adjustment' });

    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.code, 'RECOUPMENT_CONFIRM_MISMATCH');
    // The refusal says what it WANTED — a dialog that says "wrong" without
    // saying what is wanted is a guessing game.
    assert.equal(res.body.expected, '-54.08');

    // ── Nothing was authorised. ──────────────────────────────────────────
    assert.equal(db.table('rcm_posting_queue').length, 0, 'no plan may exist');
    assert.equal(db.table('rcm_posting_queue_line').length, 0, 'and no lines');
    for (const claim of db.table('rcm_claims')) {
      assert.equal(claim.posting_queue_id, null, 'no claim may be linked to a plan');
    }

    // ── But the attempt IS on the record. ────────────────────────────────
    const rows = auditRows(db).filter((r) => r.resource_type === 'rcm_recoupment_approval');
    assert.equal(rows.length, 1, 'a refused takeback must still leave a trail');
    assert.equal(rows[0].result, 'ERROR', 'it failed, and says so');
    assert.equal(rows[0].resource_id, BATCH, 'on which remittance');
    assert.equal(rows[0].office, 'roland', 'and in which practice');
    assert.ok(rows[0].user_id, 'and who tried — the point of recording it at all');

    /*
     * AND IT IS FILED UNDER THE TAKEBACK RESOURCE, NOT THE ORDINARY ONE.
     * That is what keeps `rcm_recoupment_approval` a COMPLETE record of every
     * takeback anybody attempted — refusals included — rather than only the
     * ones that succeeded.
     */
    assert.equal(
      auditRows(db).filter((r) => r.resource_type === 'rcm_posting_approval').length,
      0,
      'a refused takeback must not appear in the ordinary-approval trail'
    );
  });
});

test('repeated wrong guesses are each recorded, which is the whole reason to record them', async () => {
  const db = seedTakebackRemittance(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    for (const guess of ['-54.00', '-54.8', '54.08']) {
      const res = await approveRecoup(app, { typedTotal: guess, path: 'supplemental' });
      assert.equal(res.status, 422, `${guess} must refuse`);
    }
    const rows = auditRows(db).filter((r) => r.resource_type === 'rcm_recoupment_approval');
    assert.equal(rows.length, 3, 'three attempts, three rows — a pattern is visible');
    assert.equal(db.table('rcm_posting_queue').length, 0, 'and still nothing authorised');
  });
});

test('the RIGHT phrase approves, records the path, and audits as a CREATE', async () => {
  const db = seedTakebackRemittance(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await approveRecoup(app, { typedTotal: '-54.08', path: 'adjustment' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.recoupmentPath, 'adjustment');

    const plan = db.table('rcm_posting_queue')[0];
    assert.ok(plan, 'a plan exists');
    assert.equal(plan.is_recoupment, true, 'and it is flagged as a takeback');

    /*
     * EVERY takeback line is `is_supplemental = true` whichever path was
     * chosen. The column is not "this is a supplemental claimproc" — it is
     * which side of the money guard the row sits on, and a takeback TARGETS an
     * already-paid claimproc a previous plan legitimately posted.
     */
    for (const line of db.table('rcm_posting_queue_line')) {
      assert.equal(line.is_supplemental, true);
      assert.equal(line.recoupment_path, 'adjustment');
    }

    const rows = auditRows(db).filter((r) => r.resource_type === 'rcm_recoupment_approval');
    const created = rows.filter((r) => r.action === 'CREATE');
    assert.equal(created.length, 1, 'a person authorised an irreversible-class write');
    assert.equal(created[0].result, 'SUCCESS');
    // ORDINARY APPROVE IS NEVER WRITTEN FOR A TAKEBACK. The two resource types
    // are disjoint, so "every takeback anyone ever authorised" is one query.
    assert.equal(
      auditRows(db).filter((r) => r.resource_type === 'rcm_posting_approval').length,
      0
    );
  });
});

test('the ordinary approve still refuses this remittance outright', async () => {
  /*
   * The other half of the swap, driven through the real route rather than the
   * pure function: a takeback cannot reach the chart through the ordinary
   * button, and no request shape changes that.
   */
  const db = seedTakebackRemittance(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await approve(app);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'NOTHING_APPROVABLE');
    assert.equal(db.table('rcm_posting_queue').length, 0);
  });
});

test('an unrecognised path is refused before the phrase is even considered', async () => {
  const db = seedTakebackRemittance(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await approveRecoup(app, { typedTotal: '-54.08', path: 'delete_it' });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'RECOUPMENT_PATH_INVALID');
    assert.deepEqual(res.body.paths, ['adjustment', 'supplemental']);
    assert.equal(db.table('rcm_posting_queue').length, 0);
  });
});

// ─── A REAL reversal 835 is refused, and that is recorded, not fixed ──────────

test('the recoupment approve REFUSES a claim carrying the parser reversal flags', () => {
  /*
   * ⛔ FOUND 2026-08-27, NOT FIXED — see docs/RCM_POSTING.md §10.6.1.
   *
   * 6d's recoupment tests build the claim BY HAND: a negative amount and an
   * empty `needsReviewReasons`. A claim the ERA PARSER produced from a real
   * reversal 835 looks different — it carries `reversal_not_postable`, and its
   * remittance carries `negative_total_payment`. Both are `blocking` in
   * rcmVocabulary, and `NO_BLOCKING_REASON` is computed unconditionally, so the
   * D-6 typed-confirmation path is unreachable for any 835 a carrier would send.
   *
   * This test PINS the refusal rather than asserting the behaviour is right.
   * Whether those two flags should be non-blocking on the recoupment approve is
   * a ruling — D-11 ratified a single blocking vocabulary precisely so no code
   * path gets to decide a flag does not apply to it, and this would be the
   * first exception. When it is decided, it becomes one named check with its own
   * code, and this test changes with it.
   */
  const claim = {
    claimId: 'c1',
    officeId: 'roland',
    patientName: 'X',
    claimNumber: '53805',
    totalPaidCents: -100,
    reviewedAt: new Date(),
    odMatchStatus: 'confirmed',
    needsReviewReasons: ['reversal_not_postable'],
  };
  const result = approvalGate.evaluateClaim({
    office: 'roland',
    claim,
    lines: [{ flags: [] }],
    payment: { paidCents: -100, batchClaimPaymentId: 'p1' },
    batchFlags: ['negative_total_payment'],
    plannedClaimprocs: new Map(),
    recoupmentAllowed: true,
  });

  const check = result.checks.find((c) => c.code === 'NO_BLOCKING_REASON');
  assert.equal(check.passed, false, 'a real reversal 835 cannot be approved today');
  assert.match(check.detail, /reversal_not_postable/);
  assert.match(check.detail, /negative_total_payment/);
  assert.equal(result.postable, false);

  // And the D-6 swap DID happen — the refusal is the blocking list, not the
  // takeback checks. That distinction is the whole finding.
  assert.ok(result.checks.some((c) => c.code === 'RECOUPMENT_CONFIRMED' && c.passed));
  assert.ok(!result.checks.some((c) => c.code === 'NOT_REVERSAL'));
});

test('the same claim WITHOUT the parser flags passes — which is why 6d missed it', () => {
  const result = approvalGate.evaluateClaim({
    office: 'roland',
    claim: {
      claimId: 'c1',
      officeId: 'roland',
      patientName: 'X',
      claimNumber: '53805',
      totalPaidCents: -100,
      reviewedAt: new Date(),
      odMatchStatus: 'confirmed',
      needsReviewReasons: [],
    },
    lines: [{ flags: [] }],
    payment: { paidCents: -100, batchClaimPaymentId: 'p1' },
    batchFlags: [],
    plannedClaimprocs: new Map(),
    recoupmentAllowed: true,
  });
  const check = result.checks.find((c) => c.code === 'NO_BLOCKING_REASON');
  assert.equal(check.passed, true, 'the hand-built fixture sails through');
});
