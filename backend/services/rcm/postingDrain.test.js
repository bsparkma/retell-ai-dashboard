'use strict';

/**
 * RCM Slice 6c — the posting state machine, against a recorded-shape Open Dental.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the code that writes to a patient's ledger. The two things that can go
 * wrong are posting money that was never approved, and posting the same money
 * twice — so the suite is built around those two, not around line coverage.
 *
 * The fake Open Dental (`rcmTestUtils.FakeOd`, `writable: true`) models the four
 * live-proven behaviours a permissive stub would hide:
 *
 *   - `DateCP` accepts a write, answers 200, changes nothing              (G2)
 *   - `CheckAmt` ≠ the eligible total is a 400                       (test 5)
 *   - a PUT to a check-attached line is a 400                       (test 11)
 *   - `POST /claimpayments` returns a ClaimPaymentNum and attaches the eligible
 *     claimprocs to it                                            (tests 4/10)
 *
 * The kill-and-resume tests use `dieAfterWrites`, which makes the fake throw a
 * transport error after N successful writes — what a container being killed
 * looks like from inside the drain. Each step is killed in turn and the resume
 * must complete WITHOUT a duplicate write and WITHOUT a second check.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const postingDrain = require('./postingDrain');
const odOfficeConfig = require('./odOfficeConfig');
const odPacer = require('./odPacer');
const { FakeRcmDb, FakeOd } = require('../../routes/rcm/rcmTestUtils');

const QUEUE_ID = 'b4f0e2c1-9a3d-4e58-8f21-7c6d5a4b3e29';
const LINE_ID = 'c5a1f3d2-8b4e-4f69-9012-6d7e8f9a0b1c';
const LINE_ID_2 = 'd6b2a4e3-7c5f-4a70-8123-5e6f7a8b9c0d';
const CLAIM_ID = 'e7c3b5f4-6d60-4b81-9234-4f5a6b7c8d9e';
const BATCH_ID = 'f8d4c6a5-5e71-4c92-8345-3a4b5c6d7e8f';

/** Roland's real Category-32 rows (RCM_OD_WRITES §Probe C). Configuration, not PHI. */
const ROLAND_DEFINITIONS = [
  { DefNum: 296, Category: 32, ItemName: 'Check', isHidden: 'false' },
  { DefNum: 297, Category: 32, ItemName: 'EFT', isHidden: 'false' },
  { DefNum: 404, Category: 32, ItemName: 'Credit Card', isHidden: 'false' },
  { DefNum: 472, Category: 32, ItemName: 'Insurance Check', isHidden: 'false' },
  { DefNum: 12, Category: 1, ItemName: 'Insurance Write-off', ItemValue: '-', isHidden: 'false' },
  { DefNum: 260, Category: 1, ItemName: 'Insurance Adjustment', ItemValue: '+', isHidden: 'false' },
  { DefNum: 131, Category: 18, ItemName: 'Insurance', isHidden: 'false' },
];

/** Live on Roland: both preferences are 0, and both come back as strings. */
const ROLAND_PREFERENCES = [
  { PrefName: 'ClaimPaymentBatchOnly', ValueString: '0' },
  { PrefName: 'ShowAutoDeposit', ValueString: '0' },
  { PrefName: 'RigorousAccounting', ValueString: '2' },
];

/**
 * A writable Open Dental holding one claim with one NotReceived claimproc — the
 * shape Spike 0b test 1 created: `POST /claims` auto-creates the claimproc at
 * `Status: "NotReceived", InsPayAmt: 0`.
 */
function odFixture(overrides = {}) {
  return new FakeOd({
    writable: true,
    definitions: ROLAND_DEFINITIONS,
    preferences: ROLAND_PREFERENCES,
    claims: [
      {
        ClaimNum: 53648,
        PatNum: 12827,
        ClaimStatus: 'W',
        DateService: '2026-03-02',
        ClaimFee: 210.0,
        DateReceived: '0001-01-01',
        ClaimNote: '',
      },
    ],
    claimProcs: [
      {
        ClaimProcNum: 533930,
        ClaimNum: 53648,
        ProcNum: 405237,
        Status: 'NotReceived',
        FeeBilled: 210.0,
        InsPayAmt: 0,
        WriteOff: 0,
        DedApplied: 0,
        DateCP: '2026-08-13',
        IsTransfer: false,
        ClaimPaymentNum: 0,
      },
    ],
    ...overrides,
  });
}

/**
 * An approved plan in the shape 6b's gate writes: one queue row at `approved`,
 * one line carrying the intended cents, a confirmed claim linked to the plan.
 */
function seedPlan(db, overrides = {}) {
  db.seed('rcm_user_map', [
    { user_key: 'biller@example.invalid', platform_email: 'biller@example.invalid', display_name: 'Fixture Biller', active: true },
  ]);
  db.seed('rcm_payment_batches', [
    {
      batch_id: BATCH_ID,
      office_id: 'roland',
      payer: 'DELTA DENTAL OF ARKANSAS',
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
      status: 'approved',
      is_recoupment: false,
      carrier_eob_date: '2026-03-01',
      intended_total_cents: 15000,
      posted_total_cents: 0,
      od_claim_payment_num: null,
      approved_by: 'biller@example.invalid',
      approved_at: new Date('2026-03-02T11:00:00Z'),
      started_at: null,
      finished_at: null,
      attempt_count: 0,
      last_error: null,
      blocked_reason: null,
      drain_step: null,
      drained_by: null,
      drain_attempt_at: null,
      reconciled_at: null,
      ...(overrides.queue || {}),
    },
  ]);
  db.seed('rcm_posting_queue_line', [
    {
      queue_line_id: LINE_ID,
      queue_id: QUEUE_ID,
      office_id: 'roland',
      position: 1,
      od_claim_proc_num: 533930,
      od_claim_num: 53648,
      claim_id: CLAIM_ID,
      batch_claim_payment_id: null,
      intended_ins_pay_amt_cents: 15000,
      intended_write_off_cents: 6000,
      intended_ded_applied_cents: 0,
      is_supplemental: false,
      status: 'pending',
      claimproc_written_at: null,
      claim_received_at: null,
      paid_at: null,
      od_claim_payment_num: null,
      last_error: null,
      readback: null,
      readback_at: null,
      skip_reason: null,
      ...(overrides.line || {}),
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: CLAIM_ID,
      office_id: 'roland',
      claim_number: '53648',
      patient_name: 'Test 2, Stedi',
      od_claim_num: 53648,
      od_patient_id: 12827,
      od_match_status: 'confirmed',
      posting_queue_id: QUEUE_ID,
      od_match_snapshot: { version: 2, office: 'roland', candidates: [], confirmed: {} },
      ...(overrides.claim || {}),
    },
  ]);
  return db;
}

/** The drain's dependency bundle, with the transport injected. */
function ctxFor(db, od, extra = {}) {
  return {
    pool: db,
    // The audit layer takes a req; these are the fields it reads. A drain that
    // stopped writing audit rows would fail against the real `audit()`, which is
    // what runs here — nothing about auditing is stubbed out.
    req: {
      user: { email: 'biller@example.invalid', name: 'Fixture Biller' },
      tenant: { id: 'T1', slug: 'carein' },
      ip: '127.0.0.1',
      method: 'POST',
      originalUrl: '/api/rcm/posting/drain?office=roland',
    },
    office: 'roland',
    operator: 'Fixture Biller',
    drainedBy: 'biller@example.invalid',
    snapshotVersion: 2,
    transport: {
      officeKey: 'roland',
      officeName: 'Roland Family Dental',
      get: (path, params, opts) => od.client.apiGetRaw(path, params, opts),
      write: (method, path, body, opts) => od.client.apiWriteRaw(method, path, body, opts),
    },
    ...extra,
  };
}

/**
 * The audit layer writes to the tenant database through `withTenantDb`, which
 * these unit tests do not boot. Patched to a no-op RECORDER rather than removed:
 * the fail-closed rule says a failed audit aborts the row, and a test that
 * deleted auditing entirely could not tell the difference between "audited" and
 * "the call was never made".
 */
const auditModule = require('../../platform/audit');
const originalAudit = auditModule.audit;
/** @type {Array<object>} */
let auditRows = [];
test.beforeEach(() => {
  auditRows = [];
  auditModule.audit = async (_req, entry) => {
    auditRows.push(entry);
  };
  odPacer._resetForTests();
  odPacer._setIntervalForTests(1);
  odOfficeConfig._resetForTests();
  postingDrain.DRAIN_MUTEX.running = false;
});
test.after(() => {
  auditModule.audit = originalAudit;
  odPacer._resetForTests();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The pure core — preconditions
// ═══════════════════════════════════════════════════════════════════════════

/** A precondition context that PASSES, so each test can break exactly one thing. */
function goodCtx(overrides = {}) {
  return {
    queue: {
      queueId: QUEUE_ID,
      officeId: 'roland',
      status: 'approved',
      isRecoupment: false,
      intendedTotalCents: 15000,
    },
    lines: [
      {
        queueLineId: LINE_ID,
        officeId: 'roland',
        position: 1,
        odClaimProcNum: 533930,
        odClaimNum: 53648,
        claimId: CLAIM_ID,
        intendedInsPayAmtCents: 15000,
        intendedWriteOffCents: 6000,
        intendedDedAppliedCents: 0,
        isSupplemental: false,
        status: 'pending',
      },
    ],
    claims: [
      {
        claimId: CLAIM_ID,
        officeId: 'roland',
        odMatchStatus: 'confirmed',
        odClaimNum: 53648,
        postingQueueId: QUEUE_ID,
        snapshotVersion: 2,
      },
    ],
    office: 'roland',
    odWritesDisabled: false,
    snapshotVersion: 2,
    ...overrides,
  };
}

test('a well-formed roland plan passes every precondition', () => {
  assert.equal(postingDrain.checkPreconditions(goodCtx()), null);
});

test('D-7: valley is blocked BY NAME, before anything else is even looked at', () => {
  // Deliberately ALSO broken in three other ways. Valley must refuse first, and
  // it must refuse for being valley — not incidentally, because something else
  // about the plan happened to be wrong too.
  const blocked = postingDrain.checkPreconditions(
    goodCtx({
      office: 'valley',
      queue: { queueId: QUEUE_ID, officeId: 'valley', status: 'approved', isRecoupment: false, intendedTotalCents: 999 },
      claims: [],
      lines: [],
    })
  );
  assert.equal(blocked.reason, postingDrain.BLOCK_REASONS.VALLEY_NOT_ENABLED);
  assert.match(blocked.detail, /not enabled for 'valley'/);
});

test('D-7: only roland is enabled, and enabling another office is a code change', () => {
  assert.deepEqual([...postingDrain.OFFICES_ENABLED_FOR_POSTING], ['roland']);
  // No env var may open it. A misconfigured app setting must not be able to post
  // into a practice whose DefNums nobody has verified.
  process.env.RCM_POSTING_OFFICES = 'roland,valley';
  try {
    const blocked = postingDrain.checkPreconditions(goodCtx({ office: 'valley' }));
    assert.equal(blocked.reason, postingDrain.BLOCK_REASONS.VALLEY_NOT_ENABLED);
  } finally {
    delete process.env.RCM_POSTING_OFFICES;
  }
});

test('D-6: a recoupment is refused three different ways', () => {
  // The flag on the plan…
  assert.equal(
    postingDrain.checkPreconditions(
      goodCtx({ queue: { ...goodCtx().queue, isRecoupment: true } })
    ).reason,
    postingDrain.BLOCK_REASONS.RECOUPMENT_NOT_IN_SCOPE
  );
  // …a negative amount on a line…
  assert.equal(
    postingDrain.checkPreconditions(
      goodCtx({ lines: [{ ...goodCtx().lines[0], intendedInsPayAmtCents: -1500 }] })
    ).reason,
    postingDrain.BLOCK_REASONS.RECOUPMENT_NOT_IN_SCOPE
  );
  // …and a line flagged supplemental, which is the call 6d makes and this slice
  // does not.
  assert.equal(
    postingDrain.checkPreconditions(
      goodCtx({ lines: [{ ...goodCtx().lines[0], isSupplemental: true }] })
    ).reason,
    postingDrain.BLOCK_REASONS.RECOUPMENT_NOT_IN_SCOPE
  );
});

test('the environment guard blocks rather than fails', () => {
  const blocked = postingDrain.checkPreconditions(goodCtx({ odWritesDisabled: true }));
  assert.equal(blocked.reason, postingDrain.BLOCK_REASONS.OD_WRITES_DISABLED);
});

test('an office disagreement at ANY of the three levels is a refusal', () => {
  const base = goodCtx();
  assert.equal(
    postingDrain.checkPreconditions({ ...base, queue: { ...base.queue, officeId: 'valley' } }).reason,
    postingDrain.BLOCK_REASONS.OFFICE_MISMATCH
  );
  assert.equal(
    postingDrain.checkPreconditions({ ...base, lines: [{ ...base.lines[0], officeId: 'valley' }] }).reason,
    postingDrain.BLOCK_REASONS.OFFICE_MISMATCH
  );
  assert.equal(
    postingDrain.checkPreconditions({ ...base, claims: [{ ...base.claims[0], officeId: 'valley' }] }).reason,
    postingDrain.BLOCK_REASONS.OFFICE_MISMATCH
  );
});

test('a claim that is no longer confirmed, or is on another plan, is a refusal', () => {
  const base = goodCtx();
  assert.equal(
    postingDrain.checkPreconditions({
      ...base,
      claims: [{ ...base.claims[0], odMatchStatus: 'needs_review' }],
    }).reason,
    postingDrain.BLOCK_REASONS.CLAIM_NOT_CONFIRMED
  );
  assert.equal(
    postingDrain.checkPreconditions({
      ...base,
      claims: [{ ...base.claims[0], postingQueueId: 'other-plan' }],
    }).reason,
    postingDrain.BLOCK_REASONS.CLAIM_NOT_ON_THIS_PLAN
  );
});

test('a snapshot written in an older format is a refusal, not a best effort', () => {
  const base = goodCtx();
  assert.equal(
    postingDrain.checkPreconditions({
      ...base,
      claims: [{ ...base.claims[0], snapshotVersion: 1 }],
    }).reason,
    postingDrain.BLOCK_REASONS.SNAPSHOT_SUPERSEDED
  );
});

test('the arithmetic must agree BEFORE any call — a 400 at the check is too late', () => {
  const base = goodCtx();
  const blocked = postingDrain.checkPreconditions({
    ...base,
    queue: { ...base.queue, intendedTotalCents: 14999 },
  });
  assert.equal(blocked.reason, postingDrain.BLOCK_REASONS.PLAN_TOTAL_MISMATCH);
  assert.match(blocked.detail, /15000 cents but the plan records 14999/);
});

test('a negative write-off is caught even though it is not a recoupment', () => {
  const base = goodCtx();
  assert.equal(
    postingDrain.checkPreconditions({
      ...base,
      lines: [{ ...base.lines[0], intendedWriteOffCents: -1 }],
    }).reason,
    postingDrain.BLOCK_REASONS.NEGATIVE_INTENT
  );
});

test('a plan with no lines, or a line naming no claim, cannot be drained', () => {
  const base = goodCtx();
  assert.equal(
    postingDrain.checkPreconditions({ ...base, lines: [], queue: { ...base.queue, intendedTotalCents: 0 } }).reason,
    postingDrain.BLOCK_REASONS.PLAN_EMPTY
  );
  assert.equal(
    postingDrain.checkPreconditions({ ...base, lines: [{ ...base.lines[0], odClaimNum: null }] }).reason,
    postingDrain.BLOCK_REASONS.PLAN_EMPTY
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The pure core — what resume decides from the chart
// ═══════════════════════════════════════════════════════════════════════════

const plannedLine = {
  intendedInsPayAmtCents: 15000,
  intendedWriteOffCents: 6000,
  intendedDedAppliedCents: 0,
};

test('a NotReceived line is written', () => {
  const d = postingDrain.decideLineAction(plannedLine, {
    ClaimProcNum: 533930,
    Status: 'NotReceived',
    InsPayAmt: 0,
    WriteOff: 0,
    DedApplied: 0,
    ClaimPaymentNum: 0,
  });
  assert.equal(d.action, 'write');
});

test('a line already Received with OUR EXACT amounts is skipped, not re-written', () => {
  const d = postingDrain.decideLineAction(plannedLine, {
    ClaimProcNum: 533930,
    Status: 'Received',
    InsPayAmt: 150.0,
    WriteOff: 60.0,
    DedApplied: 0,
    ClaimPaymentNum: 0,
  });
  assert.equal(d.action, 'skip');
});

test('a line already on a CHECK is adopted, never PUT again (test 11)', () => {
  const d = postingDrain.decideLineAction(plannedLine, {
    ClaimProcNum: 533930,
    Status: 'Received',
    InsPayAmt: 150.0,
    WriteOff: 60.0,
    DedApplied: 0,
    ClaimPaymentNum: 21253,
  });
  assert.equal(d.action, 'attached');
  assert.equal(d.checkNum, 21253);
});

test('a line Received with DIFFERENT amounts is a conflict — somebody else posted it', () => {
  const d = postingDrain.decideLineAction(plannedLine, {
    ClaimProcNum: 533930,
    Status: 'Received',
    InsPayAmt: 99.0,
    WriteOff: 60.0,
    DedApplied: 0,
    ClaimPaymentNum: 0,
  });
  assert.equal(d.action, 'conflict');
  assert.ok(d.mismatches.some((m) => m.field === 'InsPayAmt'));
});

test('a line on a check with amounts that are NOT ours is a conflict, not an adoption', () => {
  const d = postingDrain.decideLineAction(plannedLine, {
    ClaimProcNum: 533930,
    Status: 'Received',
    InsPayAmt: 99.0,
    WriteOff: 60.0,
    DedApplied: 0,
    ClaimPaymentNum: 21253,
  });
  assert.equal(d.action, 'conflict');
  assert.equal(d.checkNum, 21253);
});

test("a status Open Dental refuses to update is predicted, not discovered as a 400", () => {
  for (const Status of ['Adjustment', 'InsHist', 'CapClaim', 'CapComplete', 'CapEstimate']) {
    const d = postingDrain.decideLineAction(plannedLine, {
      ClaimProcNum: 533930,
      Status,
      InsPayAmt: 0,
      WriteOff: 0,
      DedApplied: 0,
      ClaimPaymentNum: 0,
    });
    assert.equal(d.action, 'conflict', `${Status} should be refused`);
  }
});

test('IsTransfer is refused — as a boolean AND as the string Open Dental sometimes returns', () => {
  for (const IsTransfer of [true, 'true']) {
    const d = postingDrain.decideLineAction(plannedLine, {
      ClaimProcNum: 533930,
      Status: 'NotReceived',
      InsPayAmt: 0,
      WriteOff: 0,
      DedApplied: 0,
      ClaimPaymentNum: 0,
      IsTransfer,
    });
    assert.equal(d.action, 'conflict', `IsTransfer=${JSON.stringify(IsTransfer)} should be refused`);
  }
});

test('a planned claimproc the chart does not have is a conflict, never a write', () => {
  assert.equal(postingDrain.decideLineAction(plannedLine, undefined).action, 'conflict');
});

test('the stored vocabulary and the screen vocabulary map one to one', () => {
  const stored = require('../../migrations-tenant/1787120000000_rcm_posting_drain').QUEUE_STATUSES;
  for (const status of stored) {
    assert.ok(
      postingDrain.QUEUE_STATUS_LABEL[status],
      `stored status '${status}' has no label — a screen would print the raw word`
    );
  }
  for (const status of Object.keys(postingDrain.QUEUE_STATUS_LABEL)) {
    assert.ok(
      stored.includes(status),
      `label invented for '${status}', which the CHECK constraint cannot hold`
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The happy path, end to end
// ═══════════════════════════════════════════════════════════════════════════

test('a clean plan posts: the forced order, verified, with a reconciled check', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.ran, 1, JSON.stringify(result.outcomes));
  assert.equal(result.outcomes[0].status, 'posted', JSON.stringify(result.outcomes[0]));

  /*
   * THE EXACT WRITE SEQUENCE. Not "some writes happened" — the forced order and
   * nothing else, so a fifth call added three files deep fails here.
   */
  assert.deepEqual(od.writesIssued(), [
    'PUT /claimprocs/533930',
    'PUT /claims/53648',
    'POST /claimpayments',
  ]);

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'posted');
  assert.ok(row.od_claim_payment_num, 'a posted plan must carry its check number');
  assert.ok(row.reconciled_at, 'a posted plan must carry its reconciliation proof');
  assert.equal(row.posted_total_cents, 15000);
  assert.equal(row.blocked_reason, null);

  const line = db.table('rcm_posting_queue_line')[0];
  assert.equal(line.status, 'paid');
  assert.equal(Number(line.od_claim_payment_num), Number(row.od_claim_payment_num));
  assert.ok(line.readback, 'the read-back evidence is kept, not recomputed');
  assert.equal(line.readback.agreed, true);

  // The chart itself.
  assert.equal(od.rows.claimProcs[0].Status, 'Received');
  assert.equal(od.rows.claimProcs[0].InsPayAmt, 150.0);
  assert.equal(od.rows.claimProcs[0].WriteOff, 60.0);
  assert.equal(od.rows.claims[0].ClaimStatus, 'R');
});

test('DateCP is never sent — the field that returns 200 and lies (G2)', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  await postingDrain.drainOffice(ctxFor(db, od));

  for (const call of od.calls.filter((c) => c.method === 'apiWriteRaw')) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(call.body || {}, 'DateCP'),
      `DateCP was sent to ${call.path} — it is not writable and a 200 would be a lie`
    );
  }
});

test('the claim carries the carrier EOB date and the operator, and does not lose its own note', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  od.rows.claims[0].ClaimNote = 'Called the carrier 3/1 — awaiting corrected EOB.';
  await postingDrain.drainOffice(ctxFor(db, od));

  const note = od.rows.claims[0].ClaimNote;
  assert.match(note, /Called the carrier 3\/1/, 'the practice\'s own note must survive');
  assert.match(note, /Fixture Biller/, 'the operator is the only attribution OD can hold');
  assert.match(note, /carrier EOB date 2026-03-01/);
  assert.match(note, new RegExp(QUEUE_ID));

  // DateReceived comes from the carrier's date, not from the day the drain ran.
  assert.equal(od.rows.claims[0].DateReceived, '2026-03-01');
});

test('every Open Dental call writes an audit row, reads included', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  await postingDrain.drainOffice(ctxFor(db, od));

  const odCalls = od.calls.filter(
    (c) => c.method === 'apiWriteRaw' || (c.method === 'apiGetRaw' && !['/definitions', '/preferences'].includes(c.path))
  );
  assert.equal(
    auditRows.length,
    odCalls.length,
    `${odCalls.length} chart calls but ${auditRows.length} audit rows`
  );
  assert.ok(auditRows.every((r) => r.office === 'roland'));
  assert.ok(auditRows.some((r) => r.action === 'UPDATE' && r.resourceType === 'rcm_od_claimproc'));
  assert.ok(auditRows.some((r) => r.action === 'CREATE' && r.resourceType === 'rcm_od_claimpayment'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Idempotency and replay
// ═══════════════════════════════════════════════════════════════════════════

test('draining a POSTED plan again does nothing — no call, no second check', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  await postingDrain.drainOffice(ctxFor(db, od));
  const checkNum = db.table('rcm_posting_queue')[0].od_claim_payment_num;

  const before = od.calls.length;
  const again = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(again.ran, 0, 'a posted plan is not drainable');
  assert.equal(od.calls.length, before, 'a replay must not touch Open Dental at all');
  assert.equal(db.table('rcm_posting_queue')[0].od_claim_payment_num, checkNum);
});

test('a plan whose lines are ALREADY on a check adopts it rather than creating a second', async () => {
  const db = seedPlan(new FakeRcmDb(), { queue: { status: 'partially_posted' } });
  const od = odFixture();
  /*
   * The chart exactly as a COMPLETED run left it — written, received, noted and
   * on a check — but our row never recorded the number, because the process died
   * between the 201 and the statement that stores it. That is the narrowest
   * window in the whole sequence and the one that would otherwise produce a
   * second check.
   */
  od.rows.claimProcs[0].Status = 'Received';
  od.rows.claimProcs[0].InsPayAmt = 150.0;
  od.rows.claimProcs[0].WriteOff = 60.0;
  od.rows.claimProcs[0].ClaimPaymentNum = 21253;
  od.rows.claims[0].ClaimStatus = 'R';
  od.rows.claims[0].DateReceived = '2026-03-01';
  od.rows.claims[0].ClaimNote = odPostingWrites.buildPostingNote({
    queueId: QUEUE_ID,
    operator: 'Fixture Biller',
    carrierEobDate: '2026-03-01',
  });

  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes[0].status, 'posted', JSON.stringify(result.outcomes[0]));
  assert.deepEqual(od.writesIssued(), [], 'nothing needed writing — it was all already there');
  assert.equal(Number(db.table('rcm_posting_queue')[0].od_claim_payment_num), 21253);
});

test('adopting a check STILL adds the attribution note if a dead run never wrote it', async () => {
  /*
   * The complement of the test above, and the reason it is not folded into it.
   *
   * Open Dental cannot attribute an API write to a human at all, so the free-text
   * note is the only record IN THE CHART that a person did this. A resume that
   * skipped the claim PUT because the status was already `R` would leave the
   * practice with a payment nobody's name is on.
   */
  const db = seedPlan(new FakeRcmDb(), { queue: { status: 'partially_posted' } });
  const od = odFixture();
  od.rows.claimProcs[0].Status = 'Received';
  od.rows.claimProcs[0].InsPayAmt = 150.0;
  od.rows.claimProcs[0].WriteOff = 60.0;
  od.rows.claimProcs[0].ClaimPaymentNum = 21253;
  od.rows.claims[0].ClaimStatus = 'R';
  od.rows.claims[0].DateReceived = '2026-03-01';
  od.rows.claims[0].ClaimNote = '';

  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes[0].status, 'posted');
  assert.deepEqual(od.writesIssued(), ['PUT /claims/53648'], 'only the note was missing');
  assert.match(od.rows.claims[0].ClaimNote, new RegExp(QUEUE_ID));
  // And still exactly one check.
  assert.equal(Number(db.table('rcm_posting_queue')[0].od_claim_payment_num), 21253);
});

test('a line the chart already shows Received with our amounts is skipped WITH A REASON', async () => {
  const db = seedPlan(new FakeRcmDb(), { queue: { status: 'failed' } });
  const od = odFixture();
  od.rows.claimProcs[0].Status = 'Received';
  od.rows.claimProcs[0].InsPayAmt = 150.0;
  od.rows.claimProcs[0].WriteOff = 60.0;

  const result = await postingDrain.drainOffice(ctxFor(db, od));
  assert.equal(result.outcomes[0].status, 'posted');

  // No claimproc PUT — the check POST is the only write left to do.
  assert.deepEqual(od.writesIssued(), ['PUT /claims/53648', 'POST /claimpayments']);

  const line = db.table('rcm_posting_queue_line')[0];
  // It ends `paid` because the check attached it, and the SKIP is recorded on
  // the way through — "already done" and "we did it" stay distinguishable.
  assert.equal(line.status, 'paid');
});

test('two concurrent drains cannot both run', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  postingDrain.DRAIN_MUTEX.running = true;
  try {
    await assert.rejects(
      () => postingDrain.drainOffice(ctxFor(db, od)),
      (err) => err.code === 'DRAIN_ALREADY_RUNNING'
    );
  } finally {
    postingDrain.DRAIN_MUTEX.running = false;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Kill and resume — one test per step in the sequence
// ═══════════════════════════════════════════════════════════════════════════

/**
 * THE CENTRAL SAFETY TEST.
 *
 * Kill the process after each write in turn, then resume, and prove:
 *   - the plan reaches `posted`;
 *   - no claimproc was written twice;
 *   - exactly ONE ClaimPayment exists.
 *
 * `dieAfterWrites: n` makes the fake throw a transport error on write n+1, which
 * is what a container being killed looks like from inside the drain. The three
 * cases below are the three windows §8 names, including the worst one — between
 * the claim PUT and the check POST, where *"the claim reads Received with money
 * on the lines and no check exists"*.
 */
for (const { name, dieAfter, expectMidState } of [
  /*
   * `partially_posted` even here, and that is deliberate. A request that threw
   * MAY have reached Open Dental — a dead socket does not say whether the
   * server acted — so from inside the drain "the first PUT was attempted" and
   * "the first PUT landed" are indistinguishable. Claiming `failed` would be
   * claiming nothing moved, which is exactly the sort of thing this module is
   * not allowed to guess about.
   */
  { name: 'before the claimproc PUT lands', dieAfter: 0, expectMidState: 'partially_posted' },
  { name: 'after the claimproc PUT, before the claim PUT', dieAfter: 1, expectMidState: 'partially_posted' },
  { name: 'after the claim PUT, before the check (the worst window)', dieAfter: 2, expectMidState: 'partially_posted' },
]) {
  test(`killed ${name} → resume completes with ONE check and no duplicate write`, async () => {
    const db = seedPlan(new FakeRcmDb());
    const dying = odFixture({ dieAfterWrites: dieAfter });

    const first = await postingDrain.drainOffice(ctxFor(db, dying));
    assert.equal(first.outcomes[0].status, expectMidState, JSON.stringify(first.outcomes[0]));

    /*
     * The RESUME runs against the SAME chart the dying run left behind — the
     * fake's rows are the durable state — but through a fresh, non-dying client,
     * which is exactly what a restarted container gets.
     */
    const revived = odFixture();
    revived.rows = dying.rows;
    const second = await postingDrain.drainOffice(ctxFor(db, revived));

    assert.equal(second.outcomes[0].status, 'posted', JSON.stringify(second.outcomes[0]));

    const allWrites = [...dying.writesIssued(), ...revived.writesIssued()];

    /*
     * NO DUPLICATE WRITE — counted as writes that LANDED, not as calls attempted.
     *
     * The dying run's final call is recorded before it throws, and a call that
     * never reached the database changed nothing. What must not happen twice is a
     * write that took effect, so the successful claimproc PUT is what is counted.
     */
    const landedClaimprocWrites = [dying, revived].reduce(
      (n, client) =>
        n +
        client.calls.filter(
          (c) => c.method === 'apiWriteRaw' && c.path === '/claimprocs/533930' && c.landed
        ).length,
      0
    );
    assert.equal(
      landedClaimprocWrites,
      1,
      `claimproc 533930 was written ${landedClaimprocWrites} times: ${allWrites.join(' | ')}`
    );

    // EXACTLY ONE CHECK on the chart — the property that actually matters. A
    // second ClaimPayment would give the practice two checks for one carrier
    // payment and a deposit that cannot be reconciled.
    const checkNums = new Set(odCheckNums(revived).filter((n) => n > 0));
    assert.equal(
      checkNums.size,
      1,
      `the chart carries ${checkNums.size} distinct checks: ${[...checkNums].join(', ')}`
    );
  });
}

test('a check that LANDED but whose response was lost is adopted, never re-created', async () => {
  /*
   * THE WORST CRASH IN THE SEQUENCE, and the one rule 4 exists for.
   *
   * `POST /claimpayments` reaches Open Dental, the check is created, and the
   * process dies before the 201 comes back — so a real check exists in the
   * practice's books that our plan has never heard of. A resume that trusted
   * `od_claim_payment_num IS NULL` would post a second one.
   *
   * The resume must find it by READING the chart: our own lines now carry a
   * non-zero ClaimPaymentNum, and that number IS this plan's check.
   */
  const db = seedPlan(new FakeRcmDb());
  const dying = odFixture({ dieOnLandedWrite: 3 }); // claimproc PUT, claim PUT, then the check
  const first = await postingDrain.drainOffice(ctxFor(db, dying));
  assert.equal(first.outcomes[0].status, 'partially_posted', JSON.stringify(first.outcomes[0]));
  assert.equal(db.table('rcm_posting_queue')[0].od_claim_payment_num, null, 'the number was lost');
  assert.ok(dying.rows.claimProcs[0].ClaimPaymentNum > 0, 'but the check is really there');

  const revived = odFixture();
  revived.rows = dying.rows;
  const second = await postingDrain.drainOffice(ctxFor(db, revived));

  assert.equal(second.outcomes[0].status, 'posted', JSON.stringify(second.outcomes[0]));
  assert.deepEqual(
    revived.writesIssued(),
    [],
    'the resume must ADOPT the orphaned check, not write anything at all'
  );
  assert.equal(new Set(odCheckNums(revived).filter((n) => n > 0)).size, 1);
});

/** Every ClaimPaymentNum on the fake's claimprocs. */
function odCheckNums(od) {
  return od.rows.claimProcs.map((r) => Number(r.ClaimPaymentNum || 0));
}

test('a run that fails while READING leaves the plan `failed` — nothing was attempted', async () => {
  /*
   * `failed` and `partially_posted` are two different promises and the boundary
   * between them is "was a write attempted at all".
   *
   * A read that fails is unambiguous: no write was issued, so `failed` promises
   * nothing moved and the next attempt starts clean. Once the first PUT has been
   * ATTEMPTED the promise is no longer available — see the loop above — so this
   * is the only shape that earns `failed` from an exception.
   */
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  od.fail = { '/claims/': { status: 503, error: 'Open Dental is unreachable' } };

  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes[0].status, 'failed', JSON.stringify(result.outcomes[0]));
  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.posted_total_cents, 0);
  assert.deepEqual(od.writesIssued(), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Refusals from Open Dental itself
// ═══════════════════════════════════════════════════════════════════════════

test('foreign money on the claim blocks BEFORE the first write, not after', async () => {
  /*
   * The claim carries another Received, unattached line this plan never knew
   * about, so Open Dental's ELIGIBLE total is bigger than ours and `POST
   * /claimpayments` would be a 400 (test 5).
   *
   * THE POINT OF THIS TEST IS THE TIMING. Discovering it at the check step would
   * leave the chart in the §8 window — our lines Received, money on them, no
   * check — over a condition that was already visible in the resume read. The
   * plan must block having written NOTHING, which is what `blocked` promises.
   */
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  od.rows.claimProcs.push({
    ClaimProcNum: 533931,
    ClaimNum: 53648,
    ProcNum: 405238,
    Status: 'Received',
    InsPayAmt: 25.0,
    WriteOff: 0,
    DedApplied: 0,
    IsTransfer: false,
    ClaimPaymentNum: 0,
  });

  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes[0].status, 'blocked');
  assert.equal(result.outcomes[0].reason, postingDrain.BLOCK_REASONS.ELIGIBLE_TOTAL_MISMATCH);
  assert.deepEqual(
    od.writesIssued(),
    [],
    'not one write — `blocked` promises nothing was attempted, and here nothing was'
  );

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'blocked');
  assert.equal(row.blocked_reason, 'eligible_total_mismatch');
  assert.match(row.last_error, /2500 cents of insurance payment that this plan did not put there/);
  // And the line is untouched — a blocked plan leaves its lines where they were.
  assert.equal(db.table('rcm_posting_queue_line')[0].status, 'pending');
});

test('foreign money ALREADY on a check is not foreign eligible money', async () => {
  /*
   * The complement, and the reason the pre-check filters on the check number
   * rather than merely on "not ours". A line that is already attached to a check
   * contributes nothing to the eligible total — Open Dental's own definition of
   * eligible is `ClaimPaymentNum = 0` — so refusing over it would strand every
   * claim the practice has ever posted a supplemental against.
   */
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  od.rows.claimProcs.push({
    ClaimProcNum: 533931,
    ClaimNum: 53648,
    ProcNum: 405238,
    Status: 'Received',
    InsPayAmt: 25.0,
    WriteOff: 0,
    DedApplied: 0,
    IsTransfer: false,
    ClaimPaymentNum: 20999, // somebody else's check, from a previous adjudication
  });

  const result = await postingDrain.drainOffice(ctxFor(db, od));
  assert.equal(result.outcomes[0].status, 'posted', JSON.stringify(result.outcomes[0]));
});

test('a chart holding different amounts stops the row before ANY write', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  od.rows.claimProcs[0].Status = 'Received';
  od.rows.claimProcs[0].InsPayAmt = 99.0;

  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes[0].status, 'failed');
  assert.deepEqual(od.writesIssued(), [], 'a conflict is discovered by READING, before any write');
  assert.equal(db.table('rcm_posting_queue_line')[0].status, 'failed');
  assert.ok(db.table('rcm_posting_queue_line')[0].readback.mismatches.length > 0);
});

test('a valley plan is blocked with a named reason and makes NO Open Dental call', async () => {
  const db = seedPlan(new FakeRcmDb());
  // Re-stamp the whole plan as valley.
  db.table('rcm_posting_queue')[0].office_id = 'valley';
  db.table('rcm_posting_queue_line')[0].office_id = 'valley';
  db.table('rcm_claims')[0].office_id = 'valley';
  db.table('rcm_payment_batches')[0].office_id = 'valley';

  const od = odFixture();
  const result = await postingDrain.drainOffice({ ...ctxFor(db, od), office: 'valley' });

  assert.equal(result.outcomes[0].status, 'blocked');
  assert.equal(result.outcomes[0].reason, postingDrain.BLOCK_REASONS.VALLEY_NOT_ENABLED);
  assert.deepEqual(od.calls, [], 'valley must not even READ Riley\'s definitions yet');
  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'blocked');
  assert.equal(row.blocked_reason, 'valley_not_enabled');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. The budget
// ═══════════════════════════════════════════════════════════════════════════

test('the budget stops the run BETWEEN rows and says how many are left', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  // A clock that is already past the deadline by the time the first row is
  // reached, so the run stops before touching anything.
  let calls = 0;
  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { budgetMs: 1000, now: () => (calls++ < 1 ? 0 : 999999) })
  );

  assert.equal(result.outOfTime, true);
  assert.equal(result.ran, 0);
  assert.equal(result.remaining, 1);
  assert.deepEqual(od.writesIssued(), []);
  // And the plan is untouched — still waiting, not half-run.
  assert.equal(db.table('rcm_posting_queue')[0].status, 'approved');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. The startup sweep
// ═══════════════════════════════════════════════════════════════════════════

test('the startup sweep re-QUEUES interrupted plans — it never drains them', async () => {
  const db = seedPlan(new FakeRcmDb(), { queue: { status: 'posting', drain_step: 'claimproc_writes' } });
  const result = await postingDrain.sweepInterruptedPostings({
    registry: { listTenants: async () => [{ tenant_id: 'T1', slug: 'carein', status: 'active' }] },
    tenantDb: { getTenantPool: async () => db },
  });

  assert.equal(result.swept, 1);
  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'approved', 'an interrupted plan goes back to waiting for a human');
  assert.equal(row.drain_step, null);
  assert.match(row.last_error, /restarted while this plan was posting/);
});

test('an unreachable tenant is skipped rather than blocking startup', async () => {
  const result = await postingDrain.sweepInterruptedPostings({
    registry: { listTenants: async () => [{ tenant_id: 'T1', slug: 'carein', status: 'active' }] },
    tenantDb: {
      getTenantPool: async () => {
        throw new Error('connection refused');
      },
    },
  });
  assert.equal(result.skipped, 1);
  assert.equal(result.swept, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Money conversion — the boundary where cents become dollars
// ═══════════════════════════════════════════════════════════════════════════

const odPostingWrites = require('./odPostingWrites');

test('cents survive the round trip through Open Dental decimals', () => {
  for (const cents of [0, 1, 60, 150, 15000, 99999, 123456789]) {
    assert.equal(
      odPostingWrites.dollarsToCents(odPostingWrites.centsToDollars(cents)),
      cents,
      `${cents} cents did not survive`
    );
  }
});

test('OD\'s 0.6 reads back as exactly 60 cents, not 59', () => {
  /*
   * 0.6 * 100 is 60.00000000000001 in IEEE 754 and 0.29 * 100 is
   * 28.999999999999996. Truncation gets one of those right and the other wrong,
   * which is worse than being wrong consistently: it would report a write as
   * disagreeing when it agreed exactly, on values that depend on the amount.
   *
   * These are the shapes Open Dental actually returns — two decimal places, as
   * numbers. A three-decimal value is not money and does not appear.
   */
  assert.equal(odPostingWrites.dollarsToCents(0.6), 60);
  assert.equal(odPostingWrites.dollarsToCents(0.29), 29);
  assert.equal(odPostingWrites.dollarsToCents(0.2), 20);
  assert.equal(odPostingWrites.dollarsToCents(1234.56), 123456);
  // A string is what a differently-configured driver could hand back.
  assert.equal(odPostingWrites.dollarsToCents('150.00'), 15000);
  // And a non-number is null — "absent", never a silent zero, because a zero
  // would compare equal to a genuinely zero-dollar line.
  assert.equal(odPostingWrites.dollarsToCents(undefined), null);
  assert.equal(odPostingWrites.dollarsToCents('abc'), null);
});

test('a field Open Dental did not return at all is a MISMATCH, never a pass', () => {
  const verdict = odPostingWrites.compareClaimProc(
    { Status: 'Received', InsPayAmt: 150, WriteOff: 60, DedApplied: 0 },
    { Status: 'Received', InsPayAmt: 150 }
  );
  assert.equal(verdict.agreed, false);
  assert.ok(verdict.mismatches.some((m) => m.field === 'WriteOff'));
});

test('the posting note carries no patient identity', () => {
  const note = odPostingWrites.buildPostingNote({
    queueId: QUEUE_ID,
    operator: 'Fixture Biller',
    carrierEobDate: '2026-03-01',
  });
  assert.match(note, /CareIN RCM posting/);
  assert.match(note, /Fixture Biller/);
  assert.match(note, /2026-03-01/);
});

test('a note already carrying this plan does not get a second copy', () => {
  const line = odPostingWrites.buildPostingNote({
    queueId: QUEUE_ID,
    operator: 'Fixture Biller',
    carrierEobDate: null,
  });
  assert.equal(odPostingWrites.appendClaimNote(line, line, QUEUE_ID), null);
  assert.equal(odPostingWrites.appendClaimNote('', line, QUEUE_ID), line);
  assert.equal(odPostingWrites.appendClaimNote('existing', line, QUEUE_ID), `existing\n${line}`);
});

test('the eligible total counts only unattached lines — OD\'s own definition', () => {
  assert.equal(
    odPostingWrites.eligibleTotalCents([
      { InsPayAmt: 1.5, ClaimPaymentNum: 0 },
      { InsPayAmt: 2.5, ClaimPaymentNum: 0 },
      { InsPayAmt: 9.0, ClaimPaymentNum: 21253 },
    ]),
    400
  );
});

test('reconciliation catches all three ways a check can be wrong', () => {
  const planned = [
    { odClaimProcNum: 1, intendedInsPayAmtCents: 100 },
    { odClaimProcNum: 2, intendedInsPayAmtCents: 200 },
  ];
  // Missing.
  assert.equal(
    odPostingWrites.reconcileCheck([{ ClaimProcNum: 1, InsPayAmt: 1.0, ClaimPaymentNum: 9 }], planned).matched,
    false
  );
  // Unexpected.
  assert.deepEqual(
    odPostingWrites.reconcileCheck(
      [
        { ClaimProcNum: 1, InsPayAmt: 1.0 },
        { ClaimProcNum: 2, InsPayAmt: 2.0 },
        { ClaimProcNum: 3, InsPayAmt: 3.0 },
      ],
      planned
    ).unexpected,
    [3]
  );
  // Wrong amount.
  assert.equal(
    odPostingWrites.reconcileCheck(
      [
        { ClaimProcNum: 1, InsPayAmt: 1.0 },
        { ClaimProcNum: 2, InsPayAmt: 9.99 },
      ],
      planned
    ).amountMismatches.length,
    1
  );
  // And the clean case.
  assert.equal(
    odPostingWrites.reconcileCheck(
      [
        { ClaimProcNum: 1, InsPayAmt: 1.0 },
        { ClaimProcNum: 2, InsPayAmt: 2.0 },
      ],
      planned
    ).matched,
    true
  );
});
