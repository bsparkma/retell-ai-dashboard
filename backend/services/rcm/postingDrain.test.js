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
const fs = require('node:fs');
const path = require('node:path');
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
      // 6d: the plan's SHAPE. NOT NULL DEFAULT true in the schema, so the
      // fixture carries the default rather than leaving it undefined.
      requires_check: true,
      // The withdrawal columns. Seeded as null rather than omitted: an omitted
      // column reads back `undefined`, a shape Postgres never produces, and a
      // fixture that hands one out certifies code the real database would fail.
      withdrawn_at: null,
      withdrawn_by: null,
      withdrawn_reason: null,
      withdrawn_note: null,
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
      // 6d columns, defaulted to NULL so the fixture matches what Postgres
      // actually returns for a row nothing has written them on. Leaving them
      // absent made them read `undefined`, which is a shape the real database
      // never produces.
      recoupment_path: null,
      od_adjustment_num: null,
      od_supplemental_claim_proc_num: null,
      // B1/B2 columns, seeded explicitly for the reason the 6d ones above are:
      // an omitted key reads `undefined`, which pg never produces. The promise
      // is $210 billed − $60 written off − $150 paid = the patient owes nothing.
      decided_write_off_cents: null,
      decided_reason: null,
      decided_by: null,
      od_writeoff_adjustment_num: null,
      intended_patient_cents: 0,
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
      // 6d: a PatNum needs its office (hard rule 3). The adjustment path posts
      // to a patient ledger and the EOB files into a patient's images, so both
      // are read off the claim.
      od_patient_id: null,
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

test('D-6: a takeback nobody confirmed is refused three different ways', () => {
  /*
   * 6c refused EVERY takeback. 6d refuses every UNCONFIRMED one, and the
   * distinction is the whole gate: `is_recoupment` on the plan is the
   * authorisation, and it can only be set by `approveRecoupment`, which cannot
   * be reached without the typed total matching one the server computed.
   *
   * All three probes below are money moving backwards on a plan that was
   * approved through the ORDINARY button.
   */
  // …a negative amount on a line…
  assert.equal(
    postingDrain.checkPreconditions(
      goodCtx({ lines: [{ ...goodCtx().lines[0], intendedInsPayAmtCents: -1500 }] })
    ).reason,
    postingDrain.BLOCK_REASONS.RECOUPMENT_UNCONFIRMED
  );
  // …a line flagged supplemental…
  assert.equal(
    postingDrain.checkPreconditions(
      goodCtx({ lines: [{ ...goodCtx().lines[0], isSupplemental: true }] })
    ).reason,
    postingDrain.BLOCK_REASONS.RECOUPMENT_UNCONFIRMED
  );
  // …and a negative total on the plan itself.
  assert.equal(
    postingDrain.checkPreconditions(
      goodCtx({
        queue: { ...goodCtx().queue, intendedTotalCents: -1500 },
        lines: [{ ...goodCtx().lines[0], intendedInsPayAmtCents: -1500 }],
      })
    ).reason,
    postingDrain.BLOCK_REASONS.RECOUPMENT_UNCONFIRMED
  );
});

test('D-6: a CONFIRMED takeback still has to say which write was authorised', () => {
  /*
   * The flag alone is not enough. The approver chose adjustment or supplemental
   * — one reversible, one not — and a line carrying neither is a line whose
   * irreversibility nobody agreed to. The drain will not pick one for them.
   */
  const blocked = postingDrain.checkPreconditions(
    goodCtx({
      queue: { ...goodCtx().queue, isRecoupment: true, intendedTotalCents: -1500 },
      lines: [
        {
          ...goodCtx().lines[0],
          intendedInsPayAmtCents: -1500,
          isSupplemental: true,
          recoupmentPath: null,
        },
      ],
    })
  );
  assert.equal(blocked.reason, postingDrain.BLOCK_REASONS.RECOUPMENT_UNCONFIRMED);
});

test('D-6: a confirmed takeback naming its path passes every precondition', () => {
  for (const path of postingDrain.RECOUPMENT_PATHS) {
    assert.equal(
      postingDrain.checkPreconditions(
        goodCtx({
          queue: { ...goodCtx().queue, isRecoupment: true, intendedTotalCents: -1500 },
          lines: [
            {
              ...goodCtx().lines[0],
              intendedInsPayAmtCents: -1500,
              isSupplemental: true,
              recoupmentPath: path,
            },
          ],
        })
      ),
      null,
      `a ${path} takeback that was confirmed must be drainable`
    );
  }
});

test('the drain and the approval gate agree on what the two paths are called', () => {
  /*
   * The list is duplicated so this service does not depend on a route module.
   * Duplication is fine; SILENT duplication is not — a third path added to one
   * and not the other would make the gate authorise a write the drain refuses.
   */
  const gate = require('../../routes/rcm/approvalGate');
  assert.deepEqual([...postingDrain.RECOUPMENT_PATHS], [...gate.RECOUPMENT_PATHS]);
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

test('STAGE B2: a decided office write-off no longer refuses the post', () => {
  /*
   * THE FLIP. B1 shipped this test asserting a refusal — `blocked` with
   * `office_writeoff_not_postable` — because its writes carried the CARRIER's
   * verbatim figures and posting a decision the write could not express would
   * have put a number in the chart the screen never showed.
   *
   * The write carries it now, so the refusal is gone and the same input is
   * simply a plan that may post. `postedFigures` decides where the amount goes;
   * `lineDecisions.test.js` holds the identity that it always goes SOMEWHERE.
   */
  const base = goodCtx();
  assert.equal(
    postingDrain.checkPreconditions({
      ...base,
      lines: [{ ...base.lines[0], decidedWriteOffCents: 3000 }],
    }),
    null
  );
  // And the reason itself is gone from the vocabulary, not merely unused.
  assert.equal(postingDrain.BLOCK_REASONS.OFFICE_WRITEOFF_NOT_POSTABLE, undefined);
});

test('a NEGATIVE office write-off is still refused — that is a charge, not a concession', () => {
  /*
   * What survives the flip. A negative decided amount would ADD to what the
   * patient owes, under a screen that said the office was taking money off, and
   * Open Dental would accept it without complaint.
   */
  const base = goodCtx();
  const blocked = postingDrain.checkPreconditions({
    ...base,
    lines: [{ ...base.lines[0], decidedWriteOffCents: -1 }],
  });
  assert.equal(blocked.reason, postingDrain.BLOCK_REASONS.NEGATIVE_INTENT);
  assert.match(blocked.detail, /negative office write-off/i);
});

test('…and a line with NO office write-off is untouched by any of that', () => {
  const base = goodCtx();
  // null is the shape a line with no decision carries; the CHECK constraint
  // keeps the three columns moving together, so 0 is not a state that exists.
  assert.equal(
    postingDrain.checkPreconditions({
      ...base,
      lines: [{ ...base.lines[0], decidedWriteOffCents: null }],
    }),
    null
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
  /*
   * READ FROM THE MIGRATION THAT OWNS THE VOCABULARY *NOW*.
   *
   * This read 6c's list, which the withdraw migration has since re-keyed. A
   * drift test pointed at a superseded CHECK stops drifting — it passes happily
   * while the database accepts a word nothing here has a label for. Same trap
   * `rcm-labels.test.ts` fell into once for the line vocabulary, and it is worth
   * saying twice: when you re-key a CHECK, the tests that read it move with it.
   */
  const stored = require('../../migrations-tenant/1787300000000_rcm_posting_withdraw').QUEUE_STATUSES;
  assert.ok(stored.includes('withdrawn'));
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
  /*
   * IT KEEPS THE SKIP, AND STILL CARRIES THE CHECK.
   *
   * This assertion used to read `assert.equal(line.status, 'paid')`, with a
   * comment claiming that "already done" and "we did it" stayed
   * distinguishable. They did not: moving the status to `paid` is what erases
   * the skip, and the paired CHECK constraint refuses the row outright. It only
   * ever passed because `FakeRcmDb` did not model that constraint — which is now
   * fixed in `rcmTestUtils.js`, so this test is what proves the drain writes a
   * row Postgres will actually take.
   *
   * The status says what THIS attempt did (nothing — the chart already had it);
   * the check number says what the chart holds. Both are true at once.
   */
  assert.equal(line.status, 'skipped_already_posted');
  assert.equal(line.skip_reason, 'already_received_matching');
  assert.equal(Number(line.od_claim_payment_num), Number(db.table('rcm_posting_queue')[0].od_claim_payment_num));
  assert.ok(line.od_claim_payment_num != null, 'the skipped line must still record its check');
  // `paid_at` stays null: an earlier attempt paid it, not this one.
  assert.equal(line.paid_at ?? null, null);
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

/**
 * W-9 — THE RESUME THAT STRANDED A LIVE PLAN, 2026-09-04.
 *
 * The combined walk killed the container 26s into a paused drain, after the
 * claimproc PUT had landed and before the check existed. The resume did the
 * right thing at every Open Dental boundary — it re-read the chart, saw the
 * money already there, skipped the write, created ONE check and attached the
 * line — and then could not say so: stamping the check meant writing
 * `status='paid'` over a row still carrying `skip_reason`, which the paired
 * CHECK constraint refuses. The UPDATE threw inside the `check` step, the catch
 * wrote `partially_posted`, and because the startup sweep only re-homes
 * `posting`, the plan was stuck for good — money correctly on the chart, the app
 * insisting it was half-done.
 *
 * The whole class hid because `FakeRcmDb` did not model CHECK constraints, so
 * every kill-and-resume test above wrote the illegal row and went green. The
 * fake now enforces it; this test pins the contract that follows from it.
 *
 * Deliberately driven through the REAL interrupt path (`dieAfterWrites: 1`, the
 * live window), not by seeding a skipped row by hand — a hand-built row is how
 * 6d's recoupment tests missed their own defect.
 */
test('W-9: a resume that SKIPS an already-posted line ends `posted`, keeps the skip, and records the check', async () => {
  const db = seedPlan(new FakeRcmDb());

  // Die immediately after the claimproc PUT lands — the exact live window.
  const dying = odFixture({ dieAfterWrites: 1 });
  const first = await postingDrain.drainOffice(ctxFor(db, dying));
  assert.equal(first.outcomes[0].status, 'partially_posted');

  // A restarted container: same chart, fresh client.
  const revived = odFixture();
  revived.rows = dying.rows;
  const second = await postingDrain.drainOffice(ctxFor(db, revived));

  // 1. The plan completes. `partially_posted` here is the defect.
  assert.equal(
    second.outcomes[0].status,
    'posted',
    `resume must finish, got ${JSON.stringify(second.outcomes[0])}`
  );

  const plan = db.table('rcm_posting_queue')[0];
  assert.equal(plan.status, 'posted');
  assert.ok(plan.reconciled_at != null, 'a completed plan must reconcile');
  assert.equal(plan.last_error ?? null, null, 'no constraint violation may survive');

  // 2. The line kept the skip THIS run made…
  const line = db.table('rcm_posting_queue_line')[0];
  assert.equal(line.status, 'skipped_already_posted');
  assert.equal(line.skip_reason, 'already_received_matching');

  // 3. …and still records the check the chart holds. This is the number
  //    §10.3's "exactly ONE check" proof counts off the LINE; before the fix it
  //    was null and that proof read 0 on a plan that had posted correctly.
  assert.ok(
    line.od_claim_payment_num != null,
    'the skipped line must carry the check number, or the §10.3 proof cannot see it'
  );
  assert.equal(
    Number(line.od_claim_payment_num),
    Number(plan.od_claim_payment_num),
    'the line and the plan must name the same check'
  );

  // 4. The row is one Postgres would accept — the fake now enforces the real
  //    constraint, so reaching this line at all is the proof.
  const skipped = ['skipped', 'skipped_already_posted'].includes(String(line.status));
  assert.equal(
    skipped,
    line.skip_reason != null,
    'status and skip_reason must satisfy rcm_posting_queue_line_skip_reason_check'
  );

  // 5. And the chart still holds exactly one check for one dollar of intent.
  const checkNums = new Set(odCheckNums(revived).filter((n) => n > 0));
  assert.equal(checkNums.size, 1, `chart carries ${checkNums.size} checks`);
});

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

// ═══════════════════════════════════════════════════════════════════════════
// 10. `blocked` has a way out — the recovery contract
// ═══════════════════════════════════════════════════════════════════════════

/*
 * THE DEFECT THESE FOUR PIN.
 *
 * `blocked` used to be excluded from DRAINABLE_STATUSES on the argument that
 * "retrying a refusal automatically is how it becomes a loop". But there is no
 * automatic anything here — pressing Drain is a human act — and with `blocked`
 * excluded nothing anywhere could ever run one again: not the drain's own scan,
 * not the startup sweep (which only re-homes `posting`), and not the 6b gate
 * (which refuses any plan past `approved`).
 *
 * Meanwhile every blocked row's own message says "…then drain again." That
 * instruction was impossible to follow, which is the honest-states rule failing
 * in the recovery path rather than in the reporting path.
 */

test('a blocked plan whose cause is FIXED drains to posted on the next press', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  // A foreign Received, unattached line makes OD's eligible total bigger than
  // this plan's, so the first press blocks before writing anything.
  const foreign = {
    ClaimProcNum: 533931,
    ClaimNum: 53648,
    ProcNum: 405238,
    Status: 'Received',
    InsPayAmt: 25.0,
    WriteOff: 0,
    DedApplied: 0,
    IsTransfer: false,
    ClaimPaymentNum: 0,
  };
  od.rows.claimProcs.push(foreign);

  const first = await postingDrain.drainOffice(ctxFor(db, od));
  assert.equal(first.outcomes[0].status, 'blocked');
  assert.equal(first.outcomes[0].reason, postingDrain.BLOCK_REASONS.ELIGIBLE_TOTAL_MISMATCH);
  assert.deepEqual(od.writesIssued(), [], 'nothing was written');

  // The biller does what the message told them to: resolves the extra line in
  // the chart. Here that is the line being attached to its own check.
  foreign.ClaimPaymentNum = 20999;

  const second = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(second.ran, 1, 'a blocked plan must be picked up again');
  assert.equal(second.outcomes[0].status, 'posted', JSON.stringify(second.outcomes[0]));

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'posted');
  assert.equal(row.blocked_reason, null, 'the reason clears with the state');
  assert.ok(row.od_claim_payment_num);
  assert.ok(row.reconciled_at);
  assert.equal(row.attempt_count, 2, 'both presses are counted');
});

test('a blocked plan whose cause PERSISTS re-blocks with the same reason and no OD call', async () => {
  /*
   * The other half. Re-drainable must not mean "eventually posts anyway": a plan
   * whose cause is still there says the same thing again, and for a POLICY block
   * it says it without touching Open Dental at all — `checkPreconditions` runs
   * before any transport is resolved.
   */
  const db = seedPlan(new FakeRcmDb(), { line: { intended_ins_pay_amt_cents: -1500 } });
  const od = odFixture();

  const first = await postingDrain.drainOffice(ctxFor(db, od));
  assert.equal(first.outcomes[0].reason, postingDrain.BLOCK_REASONS.RECOUPMENT_UNCONFIRMED);
  assert.equal(db.table('rcm_posting_queue')[0].attempt_count, 1);

  const second = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(second.ran, 1, 'it was picked up again');
  assert.equal(second.outcomes[0].status, 'blocked');
  assert.equal(
    second.outcomes[0].reason,
    postingDrain.BLOCK_REASONS.RECOUPMENT_UNCONFIRMED,
    'the same reason, not a different one'
  );

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'blocked');
  assert.equal(row.blocked_reason, 'recoupment_unconfirmed');
  assert.equal(row.attempt_count, 2, 'the retry is counted');
  assert.deepEqual(
    od.calls,
    [],
    'a policy block costs ZERO Open Dental calls, however many times it is pressed'
  );
});

test('a valley plan blocked on D-7 is still SELECTED by a later press', async () => {
  /*
   * The case that made this defect expensive: on the day valley is enabled, every
   * valley plan blocked in the meantime has to be reachable. Asserted against the
   * drainable-selection query rather than by enabling valley — D-7 stays closed,
   * and what is under test is whether the row can be picked up at all.
   */
  const db = seedPlan(new FakeRcmDb());
  for (const table of ['rcm_posting_queue', 'rcm_posting_queue_line', 'rcm_claims', 'rcm_payment_batches']) {
    for (const row of db.table(table)) row.office_id = 'valley';
  }
  const od = odFixture();

  const first = await postingDrain.drainOffice({ ...ctxFor(db, od), office: 'valley' });
  assert.equal(first.outcomes[0].reason, postingDrain.BLOCK_REASONS.VALLEY_NOT_ENABLED);
  assert.equal(db.table('rcm_posting_queue')[0].status, 'blocked');

  // The selection the next press makes — the exact query drainOffice issues.
  const waiting = await db.query(
    `SELECT queue_id FROM rcm_posting_queue ` +
      `WHERE office_id = $1 AND status = ANY($2) ` +
      `ORDER BY approved_at ASC`,
    ['valley', [...postingDrain.DRAINABLE_STATUSES]]
  );
  assert.equal(waiting.rows.length, 1, 'a blocked valley plan is still reachable');

  // And it really is picked up — still refused, still without an OD call.
  const second = await postingDrain.drainOffice({ ...ctxFor(db, od), office: 'valley' });
  assert.equal(second.ran, 1);
  assert.equal(second.outcomes[0].reason, postingDrain.BLOCK_REASONS.VALLEY_NOT_ENABLED);
  assert.deepEqual(od.calls, [], 'valley must not even READ Riley\'s definitions yet');
});

test('`posted` stays terminal — the ONE state a press must never pick up', async () => {
  /*
   * Widening DRAINABLE_STATUSES is only safe if it did not widen too far. A
   * posted plan re-entering the drain would re-read a chart it has finished with,
   * and — if anything went wrong in the reading — could put a completed plan back
   * into a non-terminal state.
   */
  assert.ok(
    !postingDrain.DRAINABLE_STATUSES.includes('posted'),
    'posted must never be drainable'
  );
  assert.ok(
    !postingDrain.DRAINABLE_STATUSES.includes('posting'),
    'a live run belongs to the startup sweep, not to a second press'
  );

  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  await postingDrain.drainOffice(ctxFor(db, od));
  assert.equal(db.table('rcm_posting_queue')[0].status, 'posted');

  const before = od.calls.length;
  const again = await postingDrain.drainOffice(ctxFor(db, od));
  assert.equal(again.ran, 0);
  assert.equal(od.calls.length, before, 'not one further Open Dental call');
});

test('a policy-blocked plan never reads this practice\'s definitions at all', async () => {
  /*
   * The lazy-config property, stated directly rather than inferred from the
   * recoupment test above. Configuration is resolved on the FIRST plan that gets
   * past its preconditions — so a run made entirely of policy refusals is a run
   * that touched Open Dental zero times, in any office.
   */
  const db = seedPlan(new FakeRcmDb(), { line: { intended_ins_pay_amt_cents: -1500 } });
  const od = odFixture();
  await postingDrain.drainOffice(ctxFor(db, od));
  assert.deepEqual(
    od.pathsRead(),
    [],
    'no /definitions and no /preferences read for a plan that was never going to post'
  );
});

test('a plan whose office config cannot be READ blocks, and does not fail', async () => {
  /*
   * `blocked`, not `failed`: nothing was attempted. Marking a plan `failed`
   * because a definitions read timed out would put it in a state that means
   * "something went wrong mid-posting" — and would send a biller looking in a
   * chart for money that never moved.
   */
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  od.fail = { '/definitions': { status: 503, error: 'Open Dental is unreachable' } };

  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes[0].status, 'blocked');
  assert.equal(result.outcomes[0].reason, postingDrain.BLOCK_REASONS.OFFICE_CONFIG_UNRESOLVED);
  assert.deepEqual(od.writesIssued(), [], 'nothing was written');

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'blocked');
  assert.equal(row.blocked_reason, 'office_config_unresolved');

  // …and because `blocked` is drainable, the biller can simply press it again
  // once Open Dental is back. This is the transient case the defect stranded.
  od.fail = {};
  const second = await postingDrain.drainOffice(ctxFor(db, od));
  assert.equal(second.outcomes[0].status, 'posted', JSON.stringify(second.outcomes[0]));
});

test('a config failure is not re-attempted once per plan in the same run', async () => {
  // Five paced reads per plan, for a condition that is the same for all of them.
  // Memoised on the run; `odOfficeConfig`'s own hour-long cache is a separate
  // thing and does not help on the first call.
  const db = seedPlan(new FakeRcmDb());
  /*
   * A SECOND, COMPLETE plan — its own line and its own claim. A queue row with no
   * lines would be refused `plan_empty` before it ever reached the config step,
   * and this test would then pass for entirely the wrong reason.
   */
  const SECOND_QUEUE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  const SECOND_CLAIM = '7f6e5d4c-3b2a-4190-8877-665544332211';
  db.seed('rcm_posting_queue', [
    {
      ...db.table('rcm_posting_queue')[0],
      queue_id: SECOND_QUEUE,
      remittance_key: 'roland:830200002',
    },
  ]);
  db.seed('rcm_posting_queue_line', [
    {
      ...db.table('rcm_posting_queue_line')[0],
      queue_line_id: '1a2b3c4d-5e6f-4708-8990-aabbccddeeff',
      queue_id: SECOND_QUEUE,
      od_claim_proc_num: 533940,
      claim_id: SECOND_CLAIM,
    },
  ]);
  db.seed('rcm_claims', [
    {
      ...db.table('rcm_claims')[0],
      claim_id: SECOND_CLAIM,
      posting_queue_id: SECOND_QUEUE,
    },
  ]);
  const od = odFixture();
  od.fail = { '/definitions': { status: 503, error: 'Open Dental is unreachable' } };

  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes.length, 2, 'both plans got an outcome');
  assert.ok(result.outcomes.every((o) => o.reason === postingDrain.BLOCK_REASONS.OFFICE_CONFIG_UNRESOLVED));
  assert.equal(
    od.pathsRead().filter((p) => p === '/definitions').length,
    1,
    'one attempt for the run, not one per plan'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. RCM_DRAIN_STEP_DELAY_MS — the staging-only pause hook (6d)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * §10.3's kill-mid-drain has never been proven: the drain takes ~9 s and a
 * container restart takes ~3 s to land, so the 2026-08-25 attempt restarted a
 * run that had already finished. This knob widens the window.
 *
 * The tests below are about the GUARD far more than the sleep. A delay that
 * works in production is a way to hold a chart write open in the §8 window, and
 * the environment this must never be live in is the one that looks MOST like
 * the one it is for: staging also runs `NODE_ENV=production`.
 */

test('the pause is off by default, and a blank or junk value is 0 rather than a crash', () => {
  assert.deepEqual(postingDrain.resolveStepDelayMs({}), {
    delayMs: 0,
    requestedMs: 0,
    refused: false,
    reason: null,
  });
  for (const raw of ['', '   ', 'soon', 'NaN', '-5', '0']) {
    const got = postingDrain.resolveStepDelayMs({ RCM_DRAIN_STEP_DELAY_MS: raw });
    assert.equal(got.delayMs, 0, `${JSON.stringify(raw)} must resolve to 0`);
    assert.equal(got.refused, false, `${JSON.stringify(raw)} is absent, not refused`);
  }
});

test('on a dev box the delay applies', () => {
  const got = postingDrain.resolveStepDelayMs({
    NODE_ENV: 'development',
    RCM_DRAIN_STEP_DELAY_MS: '15000',
  });
  assert.equal(got.delayMs, 15000);
  assert.equal(got.refused, false);
});

test('on STAGING the delay applies — NODE_ENV alone cannot tell it from prod', () => {
  /*
   * The whole reason the guard is not `NODE_ENV === 'production'`. Staging sets
   * NODE_ENV=production so Key Vault loading and cookieSecure switch on, so a
   * naive check would disable the hook on the one environment it exists for.
   */
  const got = postingDrain.resolveStepDelayMs({
    NODE_ENV: 'production',
    AZURE_KEY_VAULT_NAME: 'kv-carein-staging',
    RCM_DRAIN_STEP_DELAY_MS: '15000',
  });
  assert.equal(got.delayMs, 15000);
  assert.equal(got.refused, false);
});

test('in PRODUCTION the delay is refused, says so, and is treated as 0', () => {
  const got = postingDrain.resolveStepDelayMs({
    NODE_ENV: 'production',
    AZURE_KEY_VAULT_NAME: 'kv-carein-prod',
    RCM_DRAIN_STEP_DELAY_MS: '15000',
  });
  assert.equal(got.delayMs, 0, 'production must not pause mid-sequence');
  assert.equal(got.refused, true);
  assert.equal(got.requestedMs, 15000, 'what was asked for is reported, not erased');
  assert.match(String(got.reason), /IGNORED/);
});

test('an environment that cannot SAY who it is counts as production', () => {
  /*
   * FAIL CLOSED, and this is the load-bearing case. `AZURE_KEY_VAULT_NAME`
   * defaults to `kv-carein-core` when unset, so an app setting nobody added
   * must not read as "probably staging".
   */
  for (const env of [
    { NODE_ENV: 'production' },
    { NODE_ENV: 'production', AZURE_KEY_VAULT_NAME: '' },
    { NODE_ENV: 'production', AZURE_KEY_VAULT_NAME: 'kv-carein-core' },
  ]) {
    const got = postingDrain.resolveStepDelayMs({ ...env, RCM_DRAIN_STEP_DELAY_MS: '15000' });
    assert.equal(got.delayMs, 0, `${JSON.stringify(env)} must refuse`);
    assert.equal(got.refused, true);
  }
});

test('a fat-fingered delay is capped rather than honoured', () => {
  const got = postingDrain.resolveStepDelayMs({
    NODE_ENV: 'development',
    RCM_DRAIN_STEP_DELAY_MS: '9999999',
  });
  assert.equal(got.delayMs, postingDrain.MAX_STEP_DELAY_MS);
  assert.ok(postingDrain.MAX_STEP_DELAY_MS < postingDrain.DEFAULT_BUDGET_MS,
    'the cap must sit inside the drain\'s own budget or the run would time out pausing');
});

test('the pause is spent AFTER each write read-back, and the plan still posts', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();

  /** Spent time is RECORDED, not waited — a suite that slept 45 s is a suite nobody runs. */
  const slept = [];
  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { stepDelayMs: 15000, sleep: async (ms) => { slept.push(ms); } })
  );

  assert.equal(result.outcomes[0].status, 'posted');
  assert.equal(result.stepDelayMs, 15000, 'the run reports that it was deliberately slowed');

  /*
   * One pause per write in the forced order — the claimproc PUT, the claim PUT
   * and the check POST. Three writes, three windows a kill can land in.
   */
  assert.deepEqual(slept, [15000, 15000, 15000]);
  assert.deepEqual(od.writesIssued(), [
    'PUT /claimprocs/533930',
    'PUT /claims/53648',
    'POST /claimpayments',
  ]);
});

test('with no delay configured the drain never sleeps at all', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  const slept = [];
  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { stepDelayMs: 0, sleep: async (ms) => { slept.push(ms); } })
  );
  assert.equal(result.outcomes[0].status, 'posted');
  assert.deepEqual(slept, [], 'the default path must not acquire a timer it does not need');
  assert.equal(result.stepDelayMs, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. D-6 — the takeback, both paths (6d)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Roland's real recoupment-relevant Category-1 rows, plus the Category-18 one
 * the EOB attach needs. Configuration, not PHI.
 *
 * DefNum 10 is deliberately present and named `Write-off`, because it is
 * `Insurance Write off` in Riley — the collision that is the single best
 * argument for resolving every one of these by NAME.
 */
const RECOUPMENT_DEFINITIONS = [
  ...ROLAND_DEFINITIONS,
  { DefNum: 477, Category: 1, ItemName: 'Insurance deductions from previous payments', ItemValue: '-', isHidden: 'false' },
  { DefNum: 10, Category: 1, ItemName: 'Write-off', ItemValue: '-', isHidden: 'false' },
];

/** A plan that is an authorised takeback: negative money, a path on the line. */
function seedTakeback(db, path, overrides = {}) {
  return seedPlan(db, {
    queue: { is_recoupment: true, intended_total_cents: -1500, ...(overrides.queue || {}) },
    line: {
      intended_ins_pay_amt_cents: -1500,
      intended_write_off_cents: 0,
      is_supplemental: true,
      recoupment_path: path,
      ...(overrides.line || {}),
    },
    claim: { od_patient_id: 12827, ...(overrides.claim || {}) },
  });
}

/**
 * The chart a takeback acts on: the target claimproc is ALREADY Received and
 * ALREADY on a check. That is what makes it a takeback, and it is exactly the
 * shape that would read as `attached` and be adopted as `paid` if takeback lines
 * were not held out of the ordinary decision loop.
 */
function takebackFixture() {
  const od = odFixture();
  od.rows.definitions = RECOUPMENT_DEFINITIONS;
  od.rows.claimProcs[0].Status = 'Received';
  od.rows.claimProcs[0].InsPayAmt = 150.0;
  od.rows.claimProcs[0].ClaimPaymentNum = 21399;
  od.rows.claims[0].ClaimStatus = 'R';
  od.rows.patients = [{ PatNum: 12827, LName: 'Test 2', FName: 'Stedi' }];
  return od;
}

test('D-6 adjustment path: the REVERSIBLE takeback posts and is verified', async () => {
  const db = seedTakeback(new FakeRcmDb(), 'adjustment');
  const od = takebackFixture();

  const result = await postingDrain.drainOffice(ctxFor(db, od, { loadRemittancePdf: async () => null }));

  assert.equal(result.outcomes[0].status, 'posted', JSON.stringify(result.outcomes[0]));

  /*
   * NO CHECK. A plan whose every line is a takeback has no positive side to
   * assert, and minting a check to keep the shape uniform would put an entry in
   * the practice's deposit that never existed.
   */
  assert.deepEqual(od.writesIssued(), ['POST /adjustments']);

  const adj = od.rows.adjustments[0];
  assert.equal(adj.AdjAmt, -15.0, 'the takeback is negative on the wire');
  assert.equal(adj.PatNum, 12827, 'an adjustment posts to a PATIENT ledger, not a claim');
  assert.equal(
    adj.AdjType,
    477,
    "resolved by NAME from this office's own Category-1 list — never a hardcoded number"
  );

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'posted');
  assert.equal(row.od_claim_payment_num, null, 'a pure recoupment creates no check');
  assert.ok(row.reconciled_at, 'and STILL has to carry its proof');

  const line = db.table('rcm_posting_queue_line')[0];
  assert.equal(line.status, 'recouped', 'not `paid` — the carrier took, it did not pay');
  assert.equal(Number(line.od_adjustment_num), Number(adj.AdjNum));
  assert.equal(line.od_supplemental_claim_proc_num, null, 'each path leaves only its own id');
});

test('D-6 supplemental path: the ONE-WAY DOOR posts, and records its permanent id', async () => {
  const db = seedTakeback(new FakeRcmDb(), 'supplemental');
  const od = takebackFixture();

  const result = await postingDrain.drainOffice(ctxFor(db, od, { loadRemittancePdf: async () => null }));

  assert.equal(result.outcomes[0].status, 'posted');
  assert.deepEqual(od.writesIssued(), ['POST /claimprocs/Supplemental']);

  /*
   * A SECOND claimproc, not an edit of the target. The supplemental is its own
   * row in the chart and pins the one it reverses.
   */
  assert.equal(od.rows.claimProcs.length, 2);
  const supplemental = od.rows.claimProcs[1];
  assert.equal(supplemental.Status, 'Supplemental');
  assert.equal(supplemental.InsPayAmt, -15.0);

  const line = db.table('rcm_posting_queue_line')[0];
  assert.equal(line.status, 'recouped');
  assert.equal(
    Number(line.od_supplemental_claim_proc_num),
    Number(supplemental.ClaimProcNum),
    'the permanent id is recorded — nothing else can ever find this row again'
  );
  assert.equal(line.od_adjustment_num, null);
});

test('a supplemental that reads back WRONG is failed, and the row says it is PERMANENT', async () => {
  const db = seedTakeback(new FakeRcmDb(), 'supplemental');
  const od = takebackFixture();

  /*
   * G2 with the stakes at their highest. The POST succeeds, the chart holds a
   * different number, and there is no undo: not a retry, not an offsetting
   * entry through this API, not re-pressing Drain.
   */
  const realApply = od.applyWrite.bind(od);
  od.applyWrite = (verb, path, body) => {
    const res = realApply(verb, path, body);
    if (path === '/claimprocs/Supplemental' && res.ok) {
      const row = od.rows.claimProcs.find((r) => Number(r.ClaimProcNum) === Number(res.data.ClaimProcNum));
      row.InsPayAmt = -14.0; // the chart disagrees with what we sent
    }
    return res;
  };

  const result = await postingDrain.drainOffice(ctxFor(db, od, { loadRemittancePdf: async () => null }));

  assert.equal(
    result.outcomes[0].status,
    'partially_posted',
    'money moved, so it is never `failed` at the plan level and never `blocked`'
  );

  const line = db.table('rcm_posting_queue_line')[0];
  assert.equal(line.status, 'failed');
  assert.ok(
    Number(line.od_supplemental_claim_proc_num) > 0,
    'the id is kept even on failure — it is the only record of an operation nothing can undo'
  );
  assert.match(
    String(line.last_error),
    /PERMANENT/,
    'the row must SAY the supplemental exists and cannot be reversed'
  );
  assert.match(String(line.last_error), /desktop/i, 'and where the only remedy actually lives');

  const row = db.table('rcm_posting_queue')[0];
  assert.notEqual(row.status, 'posted');
});

test('a resume does not double-recoup: an id already on the line is adopted, not re-written', async () => {
  /*
   * §5.1's adopt-before-create, one level down. Re-issuing would post a SECOND
   * takeback — and on the supplemental path that second one could never be
   * removed.
   */
  for (const [path, column, existing] of [
    ['adjustment', 'od_adjustment_num', 19205],
    ['supplemental', 'od_supplemental_claim_proc_num', 540005],
  ]) {
    const db = seedTakeback(new FakeRcmDb(), path, { line: { [column]: existing } });
    const od = takebackFixture();

    const result = await postingDrain.drainOffice(
      ctxFor(db, od, { loadRemittancePdf: async () => null })
    );

    assert.equal(result.outcomes[0].status, 'posted', `${path} resume must complete`);
    assert.deepEqual(od.writesIssued(), [], `${path}: a resume issues ZERO writes`);
  }
});

test('the adjustment path REFUSES when the practice has no such adjustment type', async () => {
  const db = seedTakeback(new FakeRcmDb(), 'adjustment');
  const od = takebackFixture();
  // A practice whose Category-1 list simply does not carry the name.
  od.rows.definitions = od.rows.definitions.filter((d) => Number(d.DefNum) !== 477);

  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { loadRemittancePdf: async () => null })
  );

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.blocked_reason, postingDrain.BLOCK_REASONS.NO_ADJ_TYPE);
  assert.deepEqual(
    od.writesIssued(),
    [],
    'and it is NEVER promoted to the irreversible path — nobody authorised that'
  );
  assert.ok(result.outcomes[0]);
});

test('a MIXED plan writes a check for the positive lines ONLY', async () => {
  /*
   * The real shape of a real remittance: claims paid and one clawed back on the
   * same carrier check. `intended_total_cents` is the whole plan including the
   * negative; asserting THAT as a CheckAmt would be asserting a number Open
   * Dental's own eligible-total rule cannot produce.
   */
  const db = seedPlan(new FakeRcmDb(), {
    queue: { is_recoupment: true, intended_total_cents: 15000 - 1500 },
    claim: { od_patient_id: 12827 },
  });
  db.seed('rcm_posting_queue_line', [
    {
      ...db.table('rcm_posting_queue_line')[0],
      queue_line_id: 'aa11bb22-cc33-4d44-8e55-ff6677889900',
      position: 2,
      od_claim_proc_num: 533931,
      intended_ins_pay_amt_cents: -1500,
      intended_write_off_cents: 0,
      is_supplemental: true,
      recoupment_path: 'adjustment',
    },
  ]);

  const od = odFixture();
  od.rows.definitions = RECOUPMENT_DEFINITIONS;
  od.rows.patients = [{ PatNum: 12827, LName: 'Test 2', FName: 'Stedi' }];
  // The takeback's target: already paid, already on an earlier check.
  od.rows.claimProcs.push({
    ClaimProcNum: 533931,
    ClaimNum: 53648,
    Status: 'Received',
    InsPayAmt: 15.0,
    WriteOff: 0,
    DedApplied: 0,
    ClaimPaymentNum: 21399,
  });

  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { loadRemittancePdf: async () => null })
  );
  assert.equal(result.outcomes[0].status, 'posted', JSON.stringify(result.outcomes[0]));

  assert.deepEqual(od.writesIssued(), [
    'PUT /claimprocs/533930',
    'PUT /claims/53648',
    'POST /claimpayments',
    // The takeback comes LAST, after the positive side is complete and proven.
    'POST /adjustments',
  ]);

  const checkWrite = od.calls.find((c) => c.path === '/claimpayments');
  assert.equal(
    checkWrite.body.CheckAmt,
    150.0,
    'the check is the POSITIVE total (150.00), not the plan total (135.00)'
  );

  const lines = db.table('rcm_posting_queue_line');
  assert.equal(lines.find((l) => l.position === 1).status, 'paid');
  assert.equal(lines.find((l) => l.position === 2).status, 'recouped');
});

test('a takeback line is never adopted onto the check as though it had been paid', async () => {
  /*
   * The defect this whole split exists to prevent. The target claimproc is
   * Received and on a check, so `decideLineAction` would call it `attached`,
   * adopt it, and record `paid` — the machine reporting money arriving where
   * money left.
   */
  const db = seedTakeback(new FakeRcmDb(), 'adjustment');
  const od = takebackFixture();

  await postingDrain.drainOffice(ctxFor(db, od, { loadRemittancePdf: async () => null }));

  const line = db.table('rcm_posting_queue_line')[0];
  assert.equal(line.status, 'recouped');
  assert.equal(line.od_claim_payment_num, null, 'it never joins a check');
  assert.notEqual(line.status, 'paid');
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. The EOB document attach (6d)
// ═══════════════════════════════════════════════════════════════════════════

/** A one-page PDF, as base64. Bytes, not a patient. */
const FAKE_PDF = { base64: Buffer.from('%PDF-1.4 fixture').toString('base64'), extension: '.pdf' };

test('the EOB is filed after posting, into the patient chart, under the office DocCategory', async () => {
  const db = seedPlan(new FakeRcmDb(), {
    claim: { od_patient_id: 12827 },
  });
  const od = odFixture();
  od.rows.patients = [{ PatNum: 12827, LName: 'Test 2', FName: 'Stedi' }];

  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { loadRemittancePdf: async () => FAKE_PDF })
  );

  assert.equal(result.outcomes[0].status, 'posted');
  assert.equal(result.outcomes[0].documentAttach.status, 'attached');

  const doc = od.rows.documents[0];
  assert.equal(doc.PatNum, 12827);
  assert.equal(doc.DocCategory, 131, "Roland's own Insurance category, resolved by NAME");
  assert.match(doc.Description, /^CareIN RCM · /);
  assert.doesNotMatch(doc.Description, /Stedi|Test/, 'NO patient identity in the description');

  const stored = db.table('rcm_posting_document')[0];
  assert.equal(stored.status, 'attached');
  assert.equal(Number(stored.od_doc_num), Number(doc.DocNum));
  assert.equal(db.table('rcm_posting_queue')[0].document_attach_status, 'attached');
});

test('the attach runs ONLY after posted, and is the last thing the drain does', async () => {
  const db = seedPlan(new FakeRcmDb(), {
    claim: { od_patient_id: 12827 },
  });
  const od = odFixture();
  od.rows.patients = [{ PatNum: 12827, LName: 'Test 2', FName: 'Stedi' }];

  await postingDrain.drainOffice(ctxFor(db, od, { loadRemittancePdf: async () => FAKE_PDF }));

  const writes = od.writesIssued();
  assert.equal(
    writes[writes.length - 1],
    'POST /documents/Upload',
    'the document is last — a document failure is retryable and never a financial error'
  );
  assert.ok(writes.indexOf('POST /claimpayments') < writes.indexOf('POST /documents/Upload'));
});

test('a FAILED attach leaves `posted` alone — the money does not un-post', async () => {
  const db = seedPlan(new FakeRcmDb(), {
    claim: { od_patient_id: 12827 },
  });
  const od = odFixture();
  od.rows.patients = [{ PatNum: 12827, LName: 'Test 2', FName: 'Stedi' }];

  const result = await postingDrain.drainOffice(
    ctxFor(db, od, {
      loadRemittancePdf: async () => {
        throw new Error('the blob store is unreachable');
      },
    })
  );

  assert.equal(result.outcomes[0].status, 'posted', 'THE WHOLE POINT: the money is fine');
  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'posted');
  assert.equal(row.document_attach_status, 'failed');
  assert.match(String(row.document_attach_error), /unreachable/);
});

test('adopt before create: a document already carrying our description is not filed twice', async () => {
  const db = seedPlan(new FakeRcmDb(), {
    claim: { od_patient_id: 12827 },
  });
  const od = odFixture();
  od.rows.patients = [{ PatNum: 12827, LName: 'Test 2', FName: 'Stedi' }];

  // First run files it.
  await postingDrain.drainOffice(ctxFor(db, od, { loadRemittancePdf: async () => FAKE_PDF }));
  assert.equal(od.rows.documents.length, 1);

  // Wipe our record of it — what a process killed after the upload leaves — and
  // re-run. The patient's own document list is what stops a second copy.
  db.table('rcm_posting_document').length = 0;
  db.table('rcm_posting_queue')[0].status = 'approved';
  db.table('rcm_posting_queue')[0].document_attach_status = null;

  await postingDrain.drainOffice(ctxFor(db, od, { loadRemittancePdf: async () => FAKE_PDF }));

  assert.equal(
    od.rows.documents.length,
    1,
    'a retry after a lost response must ADOPT, never file a second copy into a chart'
  );
  assert.equal(db.table('rcm_posting_document')[0].status, 'attached');
});

test('no stored PDF is `none` — examined, nothing to file — and NOT null', async () => {
  /*
   * An 835 that arrived as raw EDI has no rendered PDF, and that is ordinary.
   * Marking it `failed` would put a retry button on a screen with nothing
   * behind it.
   *
   * BUT IT IS WRITTEN EXPLICITLY. NULL now means "not attempted" and nothing
   * else — see the next test for why that distinction is the whole point.
   */
  const db = seedPlan(new FakeRcmDb(), {
    claim: { od_patient_id: 12827 },
  });
  const od = odFixture();

  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { loadRemittancePdf: async () => null })
  );

  assert.equal(result.outcomes[0].status, 'posted');
  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.document_attach_status, 'none', 'examined, and there is nothing to file');
  assert.ok(row.document_attach_at, 'and "we looked" is a recorded fact, not an absence');
  assert.equal(od.rows.documents.length, 0);
  assert.equal(
    od.writesIssued().filter((w) => w.includes('documents')).length,
    0,
    'and it costs no Open Dental call at all'
  );
});

test('a crash between `posted` and the attach leaves NULL — and the retry files it', async () => {
  /*
   * ─────────────────────────────────────────────────────────────────────────
   * THE CASE NULL-MEANING-TWO-THINGS WOULD HAVE HIDDEN
   * ─────────────────────────────────────────────────────────────────────────
   * The plan is `posted`, the money is right, the screen is green — and the
   * attach never ran because the process died. Under the first draft that left
   * NULL, which the screen rendered as "nothing to file" with no retry offered,
   * and the EOB was silently never filed. A state that hides outstanding work
   * is exactly what the honest-states rule forbids.
   */
  const db = seedPlan(new FakeRcmDb(), {
    claim: { od_patient_id: 12827 },
  });
  const od = odFixture();
  od.rows.patients = [{ PatNum: 12827, LName: 'Test 2', FName: 'Stedi' }];

  // Die inside the attach, after the plan has been finalised `posted`.
  const dying = ctxFor(db, od, {
    loadRemittancePdf: async () => {
      throw Object.assign(new Error('killed'), { __crash: true });
    },
  });
  await postingDrain.drainOffice(dying);

  const posted = db.table('rcm_posting_queue')[0];
  assert.equal(posted.status, 'posted', 'the money is fine and stays fine');

  /*
   * Simulate the crash precisely: a process that died mid-attach never got to
   * write ANY status, so the column is NULL rather than `failed`.
   */
  posted.document_attach_status = null;
  posted.document_attach_error = null;
  posted.document_attach_at = null;

  // The sweep SEES it — and deliberately does not file it. Filing on boot
  // would be an automatic chart write.
  assert.equal(
    db.table('rcm_posting_queue').filter(
      (r) => r.status === 'posted' && r.document_attach_status == null
    ).length,
    1,
    'outstanding work a person can be told about'
  );

  // And a human pressing retry finishes the job.
  const retried = await postingDrain.retryDocumentAttach(
    {
      pool: db,
      req: dying.req,
      office: 'roland',
      transport: dying.transport,
      loadRemittancePdf: async () => FAKE_PDF,
    },
    QUEUE_ID
  );

  assert.equal(retried.code, 'OK');
  assert.equal(retried.result.status, 'attached');
  assert.equal(od.rows.documents.length, 1, 'the EOB is finally in the chart');
  assert.equal(db.table('rcm_posting_queue')[0].document_attach_status, 'attached');
});

test('the retry on an ERA-only plan does nothing and files nothing', async () => {
  /*
   * `none` is terminal in the way that matters: there is no document, so a
   * retry cannot conjure one. It must not invent a failure either.
   */
  const db = seedPlan(new FakeRcmDb(), {
    claim: { od_patient_id: 12827 },
  });
  const od = odFixture();
  const ctx = ctxFor(db, od, { loadRemittancePdf: async () => null });
  await postingDrain.drainOffice(ctx);
  assert.equal(db.table('rcm_posting_queue')[0].document_attach_status, 'none');

  const retried = await postingDrain.retryDocumentAttach(
    { pool: db, req: ctx.req, office: 'roland', transport: ctx.transport,
      loadRemittancePdf: async () => null },
    QUEUE_ID
  );
  assert.equal(retried.code, 'OK');
  assert.equal(retried.result.status, 'none');
  assert.equal(od.rows.documents.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. `requires_check` — the plan's SHAPE, not a flag about its contents
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The hole this closes: a MIXED plan is `is_recoupment = true` AND owes a
 * check. A `posted` proof keyed on the flag would have accepted that plan with
 * no check number — the exact false-`posted` the constraint exists to stop.
 *
 * The database is the guarantee (proven in the migration rehearsal); these
 * prove the CODE writes the value the database will be judging.
 */

test('a pure-recoupment plan records that it owes NO check', async () => {
  const db = seedTakeback(new FakeRcmDb(), 'adjustment');
  const od = takebackFixture();

  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { loadRemittancePdf: async () => null })
  );

  assert.equal(result.outcomes[0].status, 'posted');
  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.requires_check, false, 'takebacks only — there is no check to owe');
  assert.equal(row.od_claim_payment_num, null);
});

test('an ORDINARY plan records that it DOES owe a check', async () => {
  const db = seedPlan(new FakeRcmDb());
  /*
   * SEEDED WRONG ON PURPOSE. `requires_check` defaults to `true` in the schema,
   * so a test starting from the default would pass whether or not the drain
   * ever wrote the column — it would assert the fixture, not the behaviour.
   */
  db.table('rcm_posting_queue')[0].requires_check = false;
  const od = odFixture();

  await postingDrain.drainOffice(ctxFor(db, od, { loadRemittancePdf: async () => null }));

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.requires_check, true);
  assert.ok(row.od_claim_payment_num, 'and it produced one');
});

test('a MIXED plan owes a check even though it IS a recoupment', async () => {
  /*
   * THE CASE THE FLAG WOULD HAVE GOT WRONG. Nine paid claims and one clawed
   * back on the same carrier check: `is_recoupment` is true, and the positive
   * side still has to produce a real check before this plan may say `posted`.
   */
  const db = seedPlan(new FakeRcmDb(), {
    // Seeded FALSE — the value a flag-keyed derivation would have produced for
    // a recoupment plan, and the one that would let this plan post with no
    // check. The drain must correct it.
    queue: { is_recoupment: true, intended_total_cents: 15000 - 1500, requires_check: false },
    claim: { od_patient_id: 12827 },
  });
  db.seed('rcm_posting_queue_line', [
    {
      ...db.table('rcm_posting_queue_line')[0],
      queue_line_id: 'bb22cc33-dd44-4e55-8f66-001122334455',
      position: 2,
      od_claim_proc_num: 533931,
      intended_ins_pay_amt_cents: -1500,
      intended_write_off_cents: 0,
      is_supplemental: true,
      recoupment_path: 'adjustment',
    },
  ]);

  const od = odFixture();
  od.rows.definitions = RECOUPMENT_DEFINITIONS;
  od.rows.patients = [{ PatNum: 12827, LName: 'Test 2', FName: 'Stedi' }];
  od.rows.claimProcs.push({
    ClaimProcNum: 533931,
    ClaimNum: 53648,
    Status: 'Received',
    InsPayAmt: 15.0,
    WriteOff: 0,
    DedApplied: 0,
    ClaimPaymentNum: 21399,
  });

  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { loadRemittancePdf: async () => null })
  );
  assert.equal(result.outcomes[0].status, 'posted', JSON.stringify(result.outcomes[0]));

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.is_recoupment, true, 'it IS a recoupment…');
  assert.equal(row.requires_check, true, '…and it STILL owes a check');
  assert.ok(
    row.od_claim_payment_num,
    'and produced one — a `posted` mixed plan without a check number is the ' +
      'false-posted the constraint exists to refuse'
  );
});

test('the shape is persisted BEFORE the first Open Dental write', async () => {
  /*
   * The column is what the database's `posted` proof turns on, so it must be
   * true of the row before anything can reach a chart. A process that dies
   * mid-sequence must leave the constraint judging THIS plan's shape rather
   * than the `true` default.
   */
  const db = seedTakeback(new FakeRcmDb(), 'adjustment');
  const od = takebackFixture();

  let shapeAtFirstWrite = null;
  const realApply = od.applyWrite.bind(od);
  od.applyWrite = (verb, path, body) => {
    if (shapeAtFirstWrite === null) {
      shapeAtFirstWrite = db.table('rcm_posting_queue')[0].requires_check;
    }
    return realApply(verb, path, body);
  };

  await postingDrain.drainOffice(ctxFor(db, od, { loadRemittancePdf: async () => null }));

  assert.equal(
    shapeAtFirstWrite,
    false,
    'the plan already knew it owed no check before the first write went out'
  );
});

test('the drain re-asserts the shape, so a plan whose lines changed cannot post stale', async () => {
  /*
   * The gate derives this at enqueue and the drain derives it again. Belt and
   * braces on purpose: the drain is the last thing to see the plan before money
   * moves, and a stale `requires_check = false` on a plan that has since gained
   * an ordinary line would be a plan allowed to say `posted` with no check.
   */
  const db = seedPlan(new FakeRcmDb());
  // A stale value, as an enqueue that ran before the ordinary line existed
  // would have left behind.
  db.table('rcm_posting_queue')[0].requires_check = false;

  const od = odFixture();
  await postingDrain.drainOffice(ctxFor(db, od, { loadRemittancePdf: async () => null }));

  assert.equal(
    db.table('rcm_posting_queue')[0].requires_check,
    true,
    'the drain corrected it from the lines it is actually about to post'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. A FAILURE BEFORE THE FIRST OPEN DENTAL CALL LEAVES NOTHING MID-FLIGHT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The second defect the 2026-08-26 staging walk exposed, underneath the first.
 *
 * `loadPlan` named a column the schema does not have, and the exception escaped
 * `drainRow` entirely. The plan had already been claimed, so it sat at
 * `posting` — step "Reading this practice's Open Dental settings", first line
 * Not started — with no process anywhere behind it. Only a container restart,
 * and the startup sweep it runs, would ever have moved it.
 *
 * Nothing had been attempted against Open Dental. The honest state for that is
 * the state the plan was already in.
 */

/** A pool that is a real FakeRcmDb until a named statement goes past it. */
function poolThatThrowsOn(db, fragment, message) {
  return {
    ...db,
    table: (name) => db.table(name),
    seed: (name, rows) => db.seed(name, rows),
    query: (text, params) => {
      if (String(text).includes(fragment)) return Promise.reject(new Error(message));
      return db.query(text, params);
    },
  };
}

const DB_ERROR = 'column "od_patient_office" does not exist';

test('loadPlan throwing hands the plan back to approved, not left posting', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  const before = db.table('rcm_posting_queue')[0].attempt_count;

  const pool = poolThatThrowsOn(db, 'FROM rcm_claims', DB_ERROR);

  await assert.rejects(
    () => postingDrain.drainOffice({ ...ctxFor(db, od), pool }),
    /od_patient_office/,
    'the operator is still told — a plan that cannot be loaded is a defect, not a state'
  );

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'approved', 'THE FIX: not left at `posting` with nothing running');
  assert.equal(row.drain_step, null, 'and not still showing a step it is not on');
  assert.equal(row.last_error, DB_ERROR, 'and it says why, in the words Postgres used');
  assert.equal(
    row.attempt_count,
    before,
    'nothing was attempted against Open Dental, so nothing was attempted'
  );
  assert.equal(row.finished_at, null, 'it is not finished — it never started');
});

test('nothing reached Open Dental when the pre-flight threw', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  const pool = poolThatThrowsOn(db, 'FROM rcm_claims', DB_ERROR);

  await assert.rejects(() => postingDrain.drainOffice({ ...ctxFor(db, od), pool }));

  assert.deepEqual(od.writesIssued(), [], 'no chart was touched');
  const line = db.table('rcm_posting_queue_line')[0];
  assert.equal(line.status, 'pending', 'and no line moved');
});

test('the released plan can simply be pressed again', async () => {
  /*
   * The whole point of releasing rather than failing: once the defect is fixed
   * and the container is redeployed, the biller presses the same button and the
   * plan runs. No sweep, no manual UPDATE, no state a human has to reason about.
   */
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  const pool = poolThatThrowsOn(db, 'FROM rcm_claims', DB_ERROR);
  await assert.rejects(() => postingDrain.drainOffice({ ...ctxFor(db, od), pool }));

  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { loadRemittancePdf: async () => null })
  );
  assert.equal(result.outcomes[0].status, 'posted', JSON.stringify(result.outcomes[0]));
  assert.equal(
    db.table('rcm_posting_queue')[0].attempt_count,
    1,
    'and the attempt that counts is the one that actually ran'
  );
});

test('releaseRow refuses to touch a row this run does not hold', async () => {
  /*
   * `WHERE status = 'posting'` is what makes the catch safe to call blind. A
   * plan `blockRow` has already settled — or one another process owns — must not
   * be dragged back to `approved` by an exception thrown afterwards.
   */
  const db = seedPlan(new FakeRcmDb());
  const row = db.table('rcm_posting_queue')[0];
  row.status = 'blocked';
  row.blocked_reason = 'recoupment_unconfirmed';

  await postingDrain.releaseRow(db, row.queue_id, 'something else went wrong');

  assert.equal(row.status, 'blocked', 'left exactly as it was');
  assert.equal(row.blocked_reason, 'recoupment_unconfirmed');
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. `withdrawn` — a plan whose target is gone, and which must never run
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The 2026-08-26 walk enqueued a plan for claim 53805 and the §11 unwind then
 * deleted the claim out from under it. The unwind touches Open Dental and never
 * the tenant database, so a plan outliving its target is not an accident — it is
 * what the two halves of the walk do by design.
 *
 * Pressing Drain on such a plan reads a 404. That is not a failure to find out;
 * it IS finding out, and since Open Dental never reissues a ClaimNum the answer
 * will not change however many times it is asked.
 */

test('a plan whose claim has been deleted is WITHDRAWN, not failed', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  // The claim is gone from this practice's Open Dental. Everything else about
  // the plan is exactly as it was approved.
  od.rows.claims = [];

  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { loadRemittancePdf: async () => null })
  );

  assert.equal(result.outcomes[0].status, 'withdrawn', JSON.stringify(result.outcomes[0]));
  assert.equal(result.outcomes[0].reason, 'target_removed');

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'withdrawn');
  assert.equal(row.withdrawn_reason, 'target_removed');
  assert.ok(row.withdrawn_at, 'the instant is stamped — the CHECK demands it');
  assert.equal(row.withdrawn_note, null, 'no human in this path, so no invented prose');
  assert.equal(row.blocked_reason, null, 'and it is not ALSO blocked');
});

test('a withdrawn plan cannot be drained again', async () => {
  /*
   * THE WHOLE POINT, and the difference from `blocked`.
   *
   * §2.2.1 defines `blocked` by a promise — it has a way out, and it is in
   * DRAINABLE_STATUSES so a biller can fix the cause and press again. A deleted
   * claim has no way out. Filing this under `blocked` would let her press
   * forever, one paced Open Dental read each time, against a claim that will
   * never exist again.
   */
  assert.ok(!postingDrain.DRAINABLE_STATUSES.includes('withdrawn'));

  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  od.rows.claims = [];
  await postingDrain.drainOffice(ctxFor(db, od, { loadRemittancePdf: async () => null }));

  const callsBefore = od.pathsRead().length;
  const again = await postingDrain.drainOffice(
    ctxFor(db, od, { loadRemittancePdf: async () => null })
  );

  assert.equal(again.ran, 0, 'the scan does not even pick it up');
  assert.equal(
    od.pathsRead().length,
    callsBefore,
    'and not one further Open Dental call was made'
  );
});

test('exactly ONE Open Dental call is spent discovering the claim is gone', async () => {
  /*
   * The 404 pre-check is the read the forced order already makes first — rule 3,
   * Open Dental's truth before any decision. Asking "does this claim still
   * exist" is not a new call, it is a different reading of the answer. A test
   * that let this grow into a second probe would be letting the drain pay twice
   * for one fact.
   */
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  od.rows.claims = [];

  await postingDrain.drainOffice(ctxFor(db, od, { loadRemittancePdf: async () => null }));

  const claimReads = od.pathsRead().filter((p) => /^\/claims\//.test(p));
  assert.equal(claimReads.length, 1, `expected one claim read, got ${claimReads.join(', ')}`);
  assert.deepEqual(od.writesIssued(), [], 'and nothing was written');
});

test('a 500 on the claim read is still a failure, not a withdrawal', async () => {
  /*
   * THE DISTINCTION THAT MATTERS. Every other non-ok status means "we could not
   * find out" — a timeout, a 500, a rate limit — and the honest response is to
   * stop and let a human press again. Withdrawing on those would retire a
   * perfectly good plan because Open Dental had a bad minute, and there is no
   * un-withdraw.
   */
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  // The fake's own failure map, rather than a monkey-patch: a test that swaps a
  // method out is testing the swap as much as the code.
  od.fail = { '/claims/': { status: 500, error: 'upstream exploded' } };

  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { loadRemittancePdf: async () => null })
  );

  assert.equal(result.outcomes[0].status, 'failed');
  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.withdrawn_reason, null);
  assert.ok(
    postingDrain.DRAINABLE_STATUSES.includes('failed'),
    'and it stays pressable, because nobody knows yet whether the claim is there'
  );
});

// ─── withdrawRow: what it will and will not touch ────────────────────────────

test('withdrawRow refuses a plan that has already put money in a chart', async () => {
  /*
   * Money that moved happened. A withdrawal that could cover a `posted` plan
   * would be a way to make the queue disagree with Open Dental, and every rule
   * in this module points the other way.
   */
  for (const status of ['posted', 'partially_posted', 'posting']) {
    const db = seedPlan(new FakeRcmDb());
    const row = db.table('rcm_posting_queue')[0];
    row.status = status;

    const out = await postingDrain.withdrawRow(db, 'roland', row.queue_id, {
      reason: 'manual',
      note: 'no',
      by: 'biller@example.invalid',
    });

    assert.equal(out.withdrawn, false, `${status} must not be withdrawable`);
    assert.equal(out.status, status, 'and the caller is told which state it is in');
    assert.equal(db.table('rcm_posting_queue')[0].status, status, 'the row is untouched');
  }
});

test('withdrawRow works from approved, failed and blocked', async () => {
  for (const status of postingDrain.WITHDRAWABLE_STATUSES) {
    const db = seedPlan(new FakeRcmDb());
    const row = db.table('rcm_posting_queue')[0];
    row.status = status;
    if (status === 'blocked') row.blocked_reason = 'no_pay_type';

    const out = await postingDrain.withdrawRow(db, 'roland', row.queue_id, {
      reason: 'manual',
      note: 'Posted by hand in the desktop before this queue existed.',
      by: 'biller@example.invalid',
    });

    assert.equal(out.withdrawn, true, `${status} should be withdrawable`);
    assert.equal(row.status, 'withdrawn');
    assert.equal(row.withdrawn_note, 'Posted by hand in the desktop before this queue existed.');
    assert.equal(
      row.blocked_reason,
      null,
      'a stale refusal must not survive onto a state that is not blocked — the CHECK forbids it'
    );
  }
});

test('withdrawRow cannot reach into another office', async () => {
  const db = seedPlan(new FakeRcmDb());
  const row = db.table('rcm_posting_queue')[0];

  const out = await postingDrain.withdrawRow(db, 'valley', row.queue_id, {
    reason: 'manual',
    note: 'wrong office',
    by: null,
  });

  assert.equal(out.withdrawn, false);
  assert.equal(out.status, undefined, 'unreachable from the wrong office, not refused there');
  assert.equal(row.status, 'approved');
});

test('withdrawing does not delete the plan or its lines', async () => {
  /*
   * `rcm_posting_queue` is unique on (office_id, remittance_key) — a remittance
   * gets exactly ONE plan, ever (§15.1). Deleting the row would silently make a
   * second plan enqueueable for the same money, which is the one thing that
   * index exists to prevent.
   */
  const db = seedPlan(new FakeRcmDb());
  const row = db.table('rcm_posting_queue')[0];
  const lineCount = db.table('rcm_posting_queue_line').length;

  await postingDrain.withdrawRow(db, 'roland', row.queue_id, {
    reason: 'manual',
    note: 'retiring this',
    by: null,
  });

  assert.equal(db.table('rcm_posting_queue').length, 1, 'the plan is still there');
  assert.equal(db.table('rcm_posting_queue_line').length, lineCount, 'and so are its lines');
  assert.equal(row.approved_by, 'biller@example.invalid', 'and who approved it');
});

// ─── The auto-withdraw is provably PRE-WRITE ─────────────────────────────────

test('every claim is READ before the first Open Dental write', () => {
  /*
   * The ordering the auto-withdraw rests on, pinned against the source rather
   * than inferred. `read_od_truth` loops over every group reading its claim and
   * its claimprocs; `claimproc_writes` is a later step entirely. So on a first
   * attempt a 404 is always discovered with nothing written — which is what
   * makes withdrawing safe there, and what `rcm_posting_queue_withdrawn_no_money_check`
   * would otherwise have to catch after the fact.
   */
  const src = fs.readFileSync(
    path.join(__dirname, 'postingDrain.js'),
    'utf8'
  );
  const readStep = src.indexOf("step = 'read_od_truth'");
  const writeStep = src.indexOf("step = 'claimproc_writes'");
  const firstWrite = src.indexOf('odPostingWrites.writeClaimProc');
  assert.ok(readStep > 0 && writeStep > 0, 'both steps are findable');
  assert.ok(readStep < writeStep, 'the truth read precedes the write step');
  assert.ok(
    firstWrite === -1 || writeStep < firstWrite,
    'and no claimproc write is issued before that step begins'
  );
});

test('a claim 404 on a FRESH plan withdraws, with zero Open Dental writes', async () => {
  const db = seedPlan(new FakeRcmDb());
  const od = odFixture();
  od.rows.claims = [];

  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { loadRemittancePdf: async () => null })
  );

  assert.equal(result.outcomes[0].status, 'withdrawn');
  assert.deepEqual(od.writesIssued(), [], 'nothing was written, so nothing can be half-done');
  assert.equal(db.table('rcm_posting_queue')[0].withdrawn_reason, 'target_removed');
});

test('a claim 404 on a plan that ALREADY wrote is FAILED, never withdrawn', async () => {
  /*
   * THE RESUME CASE, and the one the constraint would not have caught.
   *
   * `read_od_truth` runs on EVERY attempt, so a plan whose first run wrote a
   * claimproc and died reaches this same 404 branch on its second. Retiring it
   * would put "this never happened" on a plan that partly did — and
   * `rcm_posting_queue_withdrawn_no_money_check` guards the CHECK NUMBER, which
   * such a plan does not have yet, so the database would have accepted it.
   */
  const db = seedPlan(new FakeRcmDb());
  const line = db.table('rcm_posting_queue_line')[0];
  line.status = 'claimproc_written';
  line.claimproc_written_at = new Date();

  const od = odFixture();
  od.rows.claims = [];

  const result = await postingDrain.drainOffice(
    ctxFor(db, od, { loadRemittancePdf: async () => null })
  );

  assert.equal(result.outcomes[0].status, 'failed', JSON.stringify(result.outcomes[0]));
  assert.match(result.outcomes[0].detail, /already written to a chart/);

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.withdrawn_reason, null, 'NOT withdrawn');
  assert.equal(row.withdrawn_at, null);
  assert.match(row.last_error, /already written to a chart/);
});

test('the withdrawal CHECK is never asked to catch this — the code refuses first', () => {
  /*
   * A thrown CHECK inside the drain is a wedged `posting` row: the exception
   * escapes mid-sequence with the plan claimed. The guard is in the code path so
   * the database is never the thing that says no.
   */
  const src = fs.readFileSync(path.join(__dirname, 'postingDrain.js'), 'utf8');
  const guard = src.indexOf('if (chartTouchedBy(plan.lines))');
  const withdraw = src.indexOf('reason: WITHDRAW_REASONS.TARGET_REMOVED');
  assert.ok(guard > 0 && withdraw > 0);
  assert.ok(guard < withdraw, 'the refusal comes before the withdrawal, not after it');
});

test('chartTouchedBy reads a write, not merely a status', async () => {
  /*
   * Four different marks mean the same thing, and any one of them is enough:
   * a line status past `pending`, a check number, a takeback adjustment, or a
   * supplemental. `skipped_already_posted` is NOT one of them — it means Open
   * Dental already showed the line Received with our amounts, so this module
   * wrote nothing.
   */
  assert.equal(postingDrain.chartTouchedBy([]), false);
  assert.equal(postingDrain.chartTouchedBy([{ status: 'pending' }]), false);
  assert.equal(postingDrain.chartTouchedBy([{ status: 'skipped_already_posted' }]), false);
  assert.equal(postingDrain.chartTouchedBy([{ status: 'skipped' }]), false);

  assert.equal(postingDrain.chartTouchedBy([{ status: 'claimproc_written' }]), true);
  assert.equal(postingDrain.chartTouchedBy([{ status: 'paid' }]), true);
  assert.equal(postingDrain.chartTouchedBy([{ status: 'recouped' }]), true);
  assert.equal(
    postingDrain.chartTouchedBy([{ status: 'pending', odClaimPaymentNum: 21399 }]),
    true,
    'a check number on a `pending` line is still a write that landed'
  );
  assert.equal(
    postingDrain.chartTouchedBy([{ status: 'pending', odAdjustmentNum: 19110 }]),
    true,
    'and so is a takeback adjustment'
  );
  assert.equal(
    postingDrain.chartTouchedBy([{ status: 'pending', odSupplementalClaimProcNum: 533931 }]),
    true,
    'and a supplemental most of all — that one is irreversible'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// STAGE B2 — the decided figures actually post
// ═══════════════════════════════════════════════════════════════════════════

const { seedOfficeSettings } = require('../../routes/rcm/rcmTestUtils');

/**
 * A plan with an office write-off on it, and the arithmetic that makes one
 * possible.
 *
 * The default fixture pays $150 against a $210 fee with a $60 contractual
 * write-off, which leaves the patient owing NOTHING — so there is nothing to
 * decide about. Here the carrier pays $130 of the same $150 allowed, leaving the
 * patient $20, and the office absorbs it.
 *
 *     billed   $210.00   (the chart's FeeBilled)
 *     allowed  $150.00   = billed − the carrier's $60 write-off
 *     paid     $130.00
 *     R         $20.00   ← decided: the office absorbs it
 */
function seedDecidedPlan(db, overrides = {}) {
  return seedPlan(db, {
    queue: { intended_total_cents: 13000, ...(overrides.queue || {}) },
    line: {
      intended_ins_pay_amt_cents: 13000,
      intended_write_off_cents: 6000,
      decided_write_off_cents: 2000,
      decided_reason: 'build_up',
      decided_by: 'biller@example.invalid',
      od_writeoff_adjustment_num: null,
      // The promise, frozen at approve: $210 − $60 − $130 = $20, which is
      // exactly what the office then decided to absorb.
      intended_patient_cents: 2000,
      ...(overrides.line || {}),
    },
    claim: { od_patient_id: 12827, ...(overrides.claim || {}) },
  });
}

test('B2 writeoff_field: the office write-off goes into the claimproc, beside the carrier figure', async () => {
  const db = seedOfficeSettings(seedDecidedPlan(new FakeRcmDb()), { roland: true });
  const od = odFixture();
  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes[0].status, 'posted', JSON.stringify(result.outcomes[0]));

  // No new verb, and no adjustment: this mode has one number to write and it
  // writes it in the field Open Dental already has for it.
  assert.deepEqual(od.writesIssued(), [
    'PUT /claimprocs/533930',
    'PUT /claims/53648',
    'POST /claimpayments',
  ]);

  // $60 contractual + $20 the office absorbed. The screen said the patient would
  // owe nothing, and this is the write that makes that true.
  assert.equal(od.rows.claimProcs[0].WriteOff, 80.0);
  assert.equal(od.rows.claimProcs[0].InsPayAmt, 130.0);
});

test('B2: the patient owes what the screen promised, CONFIRMED from the chart', async () => {
  const db = seedOfficeSettings(seedDecidedPlan(new FakeRcmDb()), { roland: true });
  const od = odFixture();
  await postingDrain.drainOffice(ctxFor(db, od));

  const claim = db.table('rcm_claims')[0];
  assert.ok(claim.confirmed_at, 'a confirmed verdict must carry when it was read');
  const verdict = claim.confirmed_verdict;
  assert.equal(verdict.register, 'confirmed');
  assert.equal(verdict.state, 'amber');
  // Below the EOB on purpose, and the sentence says so in the FACT tense.
  assert.equal(verdict.projectedPatientCents, 0);
  assert.equal(verdict.decidedWriteOffCents, 2000);
  assert.match(verdict.sentence, /Confirmed in Open Dental\.$/);
  assert.doesNotMatch(verdict.sentence, /will owe/);
});

test('B2 adjustment_by_name: the carrier figure is left alone and the office books its own', async () => {
  const db = seedOfficeSettings(
    seedDecidedPlan(new FakeRcmDb()),
    { roland: true },
    {
      writeoff_mode: 'adjustment_by_name',
      // Roland's own Category-1 list carries this one, signed '-'.
      writeoff_adjtype_name: 'Insurance Write-off',
    }
  );
  const od = odFixture();
  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes[0].status, 'posted', JSON.stringify(result.outcomes[0]));
  assert.deepEqual(od.writesIssued(), [
    'PUT /claimprocs/533930',
    'PUT /claims/53648',
    'POST /claimpayments',
    // LAST among the money writes, after the check is reconciled.
    'POST /adjustments',
  ]);

  // The claimproc keeps the CARRIER's $60 — this office reports the two apart.
  assert.equal(od.rows.claimProcs[0].WriteOff, 60.0);
  // …and the $20 the office absorbed is a ledger row, negative, under the
  // DefNum that practice's own database gave the name.
  const adj = od.rows.adjustments[0];
  assert.equal(adj.AdjAmt, -20.0);
  assert.equal(Number(adj.AdjType), 12);
  assert.equal(Number(adj.PatNum), 12827);

  const line = db.table('rcm_posting_queue_line')[0];
  assert.equal(Number(line.od_writeoff_adjustment_num), Number(adj.AdjNum));

  // Same patient balance, booked differently: the confirmed verdict does not
  // care which mode got it there.
  assert.equal(db.table('rcm_claims')[0].confirmed_verdict.state, 'amber');
  assert.equal(db.table('rcm_claims')[0].confirmed_verdict.projectedPatientCents, 0);
});

test('B2 D-13: an adjustment type this practice does not have REFUSES, before any write', async () => {
  const db = seedOfficeSettings(
    seedDecidedPlan(new FakeRcmDb()),
    { roland: true },
    { writeoff_mode: 'adjustment_by_name', writeoff_adjtype_name: 'Courtesy Discount' }
  );
  const od = odFixture();
  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes[0].status, 'blocked');
  assert.equal(result.outcomes[0].reason, postingDrain.BLOCK_REASONS.WRITEOFF_ADJTYPE_UNRESOLVED);
  assert.match(result.outcomes[0].detail, /Courtesy Discount/);
  assert.match(result.outcomes[0].detail, /Nothing was sent to Open Dental/);
  // Never a fallback to a plausible neighbour, and never a number.
  assert.deepEqual(od.writesIssued(), []);
});

test('B2 D-13: a `+` type wearing the right name is not the type the admin meant', async () => {
  const db = seedOfficeSettings(
    seedDecidedPlan(new FakeRcmDb()),
    { roland: true },
    {
      writeoff_mode: 'adjustment_by_name',
      /*
       * Real, and real in the WRONG direction: 'Insurance Adjustment' is a '+'
       * type in Roland's list, so booking a concession under it would be refused
       * by Open Dental with `AdjAmt must be negative for this AdjType.` —
       * discovering that mid-sequence is what resolving it up front avoids.
       */
      writeoff_adjtype_name: 'Insurance Adjustment',
    }
  );
  const od = odFixture();
  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes[0].reason, postingDrain.BLOCK_REASONS.WRITEOFF_ADJTYPE_UNRESOLVED);
  assert.deepEqual(od.writesIssued(), []);
});

test('B2: a plan with NO decided write-off never asks about the adjustment type', async () => {
  /*
   * A misconfigured name must not stop the ordinary work. Only the claims
   * carrying a concession wait for somebody to fix it.
   */
  const db = seedOfficeSettings(
    seedPlan(new FakeRcmDb()),
    { roland: true },
    { writeoff_mode: 'adjustment_by_name', writeoff_adjtype_name: 'Courtesy Discount' }
  );
  const od = odFixture();
  const result = await postingDrain.drainOffice(ctxFor(db, od));
  assert.equal(result.outcomes[0].status, 'posted', JSON.stringify(result.outcomes[0]));
});

test('B2: a second press does not book a SECOND concession', async () => {
  /*
   * There is no `DELETE /adjustments`, so a double-post is not a mistake
   * anybody can tidy up afterwards. The stored AdjNum is the idempotency key,
   * and the confirmation reads the ledger for it rather than assuming.
   */
  const db = seedOfficeSettings(
    seedDecidedPlan(new FakeRcmDb(), { line: { od_writeoff_adjustment_num: 19110 } }),
    { roland: true },
    { writeoff_mode: 'adjustment_by_name', writeoff_adjtype_name: 'Insurance Write-off' }
  );
  const od = odFixture({
    adjustments: [
      { AdjNum: 19110, PatNum: 12827, AdjAmt: -20.0, AdjType: 12, AdjDate: '2026-03-01' },
    ],
  });
  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes[0].status, 'posted', JSON.stringify(result.outcomes[0]));
  assert.equal(
    od.writesIssued().filter((w) => w === 'POST /adjustments').length,
    0,
    'the concession was already booked; posting it again would take $20 twice'
  );
  // And it still confirms, because the ledger was READ rather than assumed.
  assert.equal(db.table('rcm_claims')[0].confirmed_verdict.state, 'amber');
});

test('B2: a chart that does not say what was promised leaves the plan STUCK, not finished', async () => {
  /*
   * THE CASE THE PER-FIELD READ-BACK CANNOT SEE.
   *
   * Every field this run sent read back exactly as sent — the payment, the
   * write-off, the deductible, the check. What moved is the chart's OWN fee:
   * somebody edited the procedure between the approve and the press, so the
   * patient's portion is no longer the number the screen promised.
   *
   * `partially_posted`, deliberately not `failed`: money moved and every
   * carrier-side proof passed. It stays drainable, so the way out is the same
   * button once a person has sorted out the fee (D-15).
   */
  const db = seedOfficeSettings(seedDecidedPlan(new FakeRcmDb()), { roland: true });
  const od = odFixture();
  od.rows.claimProcs[0].FeeBilled = 230.0;
  const result = await postingDrain.drainOffice(ctxFor(db, od));

  assert.equal(result.outcomes[0].status, 'partially_posted', JSON.stringify(result.outcomes[0]));
  assert.equal(result.outcomes[0].reason, 'patient_total_unconfirmed');

  const row = db.table('rcm_posting_queue')[0];
  assert.equal(row.status, 'partially_posted');
  assert.ok(row.od_claim_payment_num, 'the check happened and the row must still name it');
  /*
   * TWO DIFFERENT NUMBERS, WHICH IS THE POINT. The chart says $20 and this
   * check said $0 — measured against the PROMISE, never against the raw EOB
   * total, which the office's write-off is allowed to differ from on purpose.
   */
  assert.match(row.last_error, /Open Dental says the patient owes \$20\.00 — this check said \$0\.00/);
  assert.match(row.last_error, /This needs you before anything else posts/);

  // The verdict is recorded on the RED claim too — the one that needs it most.
  const verdict = db.table('rcm_claims')[0].confirmed_verdict;
  assert.equal(verdict.state, 'red');
  assert.deepEqual(
    verdict.problems.map((p) => p.kind),
    ['chart_differs_from_decision']
  );
  // The frozen promise is what makes this detectable at all: derived from the
  // chart's own (edited) fee, the two would have agreed and the plan would have
  // finished quietly.
  assert.equal(verdict.eobPatientCents, 2000);

  // And the EOB is NOT filed: a plan that needs a person to look at it does not
  // quietly finish its paperwork.
  assert.equal(od.writesIssued().filter((w) => w.startsWith('POST /documents')).length, 0);
});

test('B2: a re-press of a written-off line reads as ALREADY DONE, not as a conflict', () => {
  /*
   * The comparison against the chart has to use what THIS run will send. A line
   * already carrying `W + decided` compared against `W` alone would read as
   * somebody else's posting and refuse the whole row — a plan refusing to
   * finish work it did itself.
   */
  const line = {
    intendedInsPayAmtCents: 13000,
    intendedWriteOffCents: 6000,
    intendedDedAppliedCents: 0,
    decidedWriteOffCents: 2000,
  };
  const figures = require('./lineDecisions').postedFigures(line, 'writeoff_field');
  const decision = postingDrain.decideLineAction(
    { ...line, intendedWriteOffCents: figures.writeOffCents },
    {
      ClaimProcNum: 533930,
      Status: 'Received',
      InsPayAmt: 130.0,
      WriteOff: 80.0,
      DedApplied: 0,
      ClaimPaymentNum: 0,
    }
  );
  assert.equal(decision.action, 'skip');
});


test('B2: a plan approved BEFORE the promise column falls back, and says nothing it cannot', () => {
  /*
   * `intended_patient_cents` is NULL on any plan approved before B2. The
   * confirmation still runs — it derives R from the chart's own `FeeBilled`,
   * which is what B1's screen showed anyway because the gate refuses a claim
   * whose fee disagrees with the carrier.
   *
   * The weaker guarantee is stated rather than hidden: derived that way, a fee
   * edited between the approve and the press moves the promise along with it,
   * so THAT case cannot be caught for those rows. It is caught for every plan
   * approved since.
   */
  const lineDecisions = require('./lineDecisions');
  const derived = lineDecisions.verdictFor({
    register: 'confirmed',
    lines: [
      {
        code: 'D0120',
        odClaimProcNum: 533930,
        // No `eobRemainderCents`: the pre-B2 shape.
        billedCents: 21000,
        allowedCents: 15000,
        paidCents: 13000,
        confirmedRemainderCents: 2000,
      },
    ],
  });
  assert.equal(derived.state, 'green');
  assert.equal(derived.eobPatientCents, 2000);

  // …and with the frozen figure present it is the frozen one that counts.
  const frozen = lineDecisions.verdictFor({
    register: 'confirmed',
    lines: [
      {
        code: 'D0120',
        odClaimProcNum: 533930,
        eobRemainderCents: 2000,
        billedCents: 23000, // the fee moved after the approve
        allowedCents: 17000,
        paidCents: 13000,
        confirmedRemainderCents: 4000,
      },
    ],
  });
  assert.equal(frozen.eobPatientCents, 2000, 'the promise, not the chart');
  assert.equal(frozen.state, 'red');
  assert.deepEqual(
    frozen.problems.map((p) => p.kind),
    ['chart_differs_from_decision']
  );
});
