'use strict';

/**
 * A TAKEBACK, AGAINST THE CHART THE DRAIN ACTUALLY WROTE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Walk night 2 (2026-08-28), finding 1. With a reversal 835 matched to claim
 * 53830 — Received, InsPayAmt $1.00, on check 21424, the state the drain had
 * put it in twenty minutes earlier — the takeback approve refused with the
 * correct typed total. The checklist named two culprits:
 *
 *     The chart is ready for this payment   LINE_HAS_CLAIM_PAYMENT, NO_PAYABLE_LINES
 *     Every line matched to a chart line    1 of 1 lines have no ClaimProcNum
 *                                           "no postable line on this claim"
 *
 * Every one of those sentences is TRUE about a payment and says nothing about a
 * reversal. A takeback's target line is paid and on a check BY DEFINITION —
 * that is the money it is taking back — so the payment lane's preconditions are
 * the takeback lane's, inverted.
 *
 * This is §3.1's lesson exactly one stage further down, and it is the reason
 * this file drives the REAL DRAIN rather than describing its result:
 *
 *   > A hand-built fixture for one stage of a pipeline is a claim about the
 *   > stage upstream of it, and nothing was checking that claim.
 *
 * §3.1's own tests passed because they hand-built a takeback claim with no
 * parser flags. 6d's tests passed because they hand-built a chart. So here the
 * chart is not written down at all: plan A is posted through
 * `postingDrain.drainOffice` against `FakeOd`, and whatever state that leaves is
 * what the reversal is then evaluated against. If the drain's output and the
 * takeback's expectations ever drift apart again, this file is what notices.
 *
 * NO PHI. PatNum 12827 / `Test 2, Stedi` is the documented Roland fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeRcmDb, FakeOd } = require('./rcmTestUtils');
const postingDrain = require('../../services/rcm/postingDrain');
const odOfficeConfig = require('../../services/rcm/odOfficeConfig');
const odPacer = require('../../services/rcm/odPacer');
const claimMatch = require('../../services/rcm/claimMatch');
const approvalGate = require('./approvalGate');

/**
 * The audit layer writes through `withTenantDb`, which this file does not boot.
 * Patched to a no-op RECORDER rather than removed, exactly as
 * `postingDrain.test.js` does it: the fail-closed rule says a failed audit
 * aborts the row, and a test that deleted auditing could not tell "audited"
 * from "the call was never made".
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
  // The pacer's 1200ms production floor is proven in odPacer.test.js; paying it
  // here would make one drain take a minute for reasons unrelated to takebacks.
  odPacer._resetForTests();
  odPacer._setIntervalForTests(1);
  odOfficeConfig._resetForTests();
  postingDrain.DRAIN_MUTEX.running = false;
});
test.after(() => {
  auditModule.audit = originalAudit;
  odPacer._resetForTests();
});

/**
 * Roland's real Category 32 / 1 / 18 rows — configuration, not PHI, and the
 * same list `postingDrain.test.js` uses. Copied rather than imported: a test
 * file exporting fixtures to another test file is a dependency `node --test`
 * has no reason to load, and these numbers are pinned live in
 * `odOfficeConfig.test.js` either way.
 */
const ROLAND_DEFINITIONS = [
  { DefNum: 296, Category: 32, ItemName: 'Check', isHidden: 'false' },
  { DefNum: 472, Category: 32, ItemName: 'Insurance Check', isHidden: 'false' },
  { DefNum: 260, Category: 1, ItemName: 'Insurance Adjustment', ItemValue: '+', isHidden: 'false' },
  { DefNum: 131, Category: 18, ItemName: 'Insurance', isHidden: 'false' },
];
const ROLAND_PREFERENCES = [
  { PrefName: 'ClaimPaymentBatchOnly', ValueString: '0' },
  { PrefName: 'ShowAutoDeposit', ValueString: '0' },
];

const OD_CLAIM_NUM = 53830;
const OD_CLAIM_PROC_NUM = 533930;
const OD_PROC_NUM = 405237;
const PAID_CENTS = 100;

const QUEUE_ID = '11111111-2222-4333-8444-555555555555';
const LINE_ID = '66666666-7777-4888-8999-000000000000';
const BATCH_ID = '8acb0e32-35ae-5cd8-9692-7b5e318a31c2';
const CLAIM_ID = 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d';

/**
 * THE REVERSAL IS ITS OWN CLAIM ROW, and that is not a detail.
 *
 * A reversal 835 is a separate remittance: it ingests its own batch, its own
 * `rcm_claims` row and its own lines. On staging, walk 3, plan A's claim was
 * `262063fb-...` and the recoupment's claim was `22533a81-...` - two rows, one
 * Open Dental claim.
 *
 * This file used ONE id for both, and `CLAIMPROC_NOT_ALREADY_PLANNED` only fires
 * when `planned.claimId !== claim.claimId`. So even after the empty
 * `plannedClaimprocs` was fixed, the fixture STILL could not reproduce walk 3:
 * the payment and its reversal were the same row, so nothing ever conflicted.
 *
 * Two separate reasons this file passed while staging refused, and the second
 * one would have survived fixing the first.
 */
const REVERSAL_CLAIM_ID = '22533a81-bece-4e9c-a0e6-282292308908';

/** The chart BEFORE anything posts: a sent claim, one unpaid line. */
function chartBeforeTheDrain() {
  return new FakeOd({
    writable: true,
    definitions: ROLAND_DEFINITIONS,
    preferences: ROLAND_PREFERENCES,
    claims: [
      {
        ClaimNum: OD_CLAIM_NUM,
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
        ClaimProcNum: OD_CLAIM_PROC_NUM,
        ClaimNum: OD_CLAIM_NUM,
        ProcNum: OD_PROC_NUM,
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
    procedures: [{ ProcNum: OD_PROC_NUM, ProcStatus: 'C', procCode: 'D0120' }],
  });
}

/** Plan A: one line, $1.00, approved and waiting. */
function seedPlanA(db) {
  db.seed('rcm_user_map', [
    {
      user_key: 'biller@example.invalid',
      platform_email: 'biller@example.invalid',
      display_name: 'Fixture Biller',
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
      total_amount_cents: PAID_CENTS,
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
      requires_check: true,
      withdrawn_at: null,
      withdrawn_by: null,
      withdrawn_reason: null,
      withdrawn_note: null,
      carrier_eob_date: '2026-03-01',
      intended_total_cents: PAID_CENTS,
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
      document_attach_status: null,
    },
  ]);
  db.seed('rcm_posting_queue_line', [
    {
      queue_line_id: LINE_ID,
      queue_id: QUEUE_ID,
      office_id: 'roland',
      position: 1,
      od_claim_proc_num: OD_CLAIM_PROC_NUM,
      od_claim_num: OD_CLAIM_NUM,
      claim_id: CLAIM_ID,
      batch_claim_payment_id: null,
      intended_ins_pay_amt_cents: PAID_CENTS,
      intended_write_off_cents: 0,
      intended_ded_applied_cents: 0,
      is_supplemental: false,
      recoupment_path: null,
      od_adjustment_num: null,
      od_supplemental_claim_proc_num: null,
      status: 'pending',
      claimproc_written_at: null,
      claim_received_at: null,
      paid_at: null,
      od_claim_payment_num: null,
      last_error: null,
      readback: null,
      readback_at: null,
      skip_reason: null,
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: CLAIM_ID,
      office_id: 'roland',
      claim_number: String(OD_CLAIM_NUM),
      patient_name: 'Test 2, Stedi',
      od_patient_id: 12827,
      od_claim_num: OD_CLAIM_NUM,
      od_match_status: 'confirmed',
      posting_queue_id: QUEUE_ID,
      od_match_snapshot: { version: 2 },
    },
  ]);
  return db;
}

/**
 * Post plan A for real, and hand back the chart it left behind.
 *
 * THE WHOLE POINT OF THIS FILE. Nothing below writes a claimproc by hand.
 */
async function chartAfterPostingPlanA() {
  const db = seedPlanA(new FakeRcmDb());
  const od = chartBeforeTheDrain();

  const result = await postingDrain.drainOffice({
    pool: db,
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
    loadRemittancePdf: async () => null,
    transport: {
      officeKey: 'roland',
      officeName: 'Roland Family Dental',
      get: (path, params, opts) => od.client.apiGetRaw(path, params, opts),
      write: (method, path, body, opts) => od.client.apiWriteRaw(method, path, body, opts),
    },
  });

  assert.equal(
    result.outcomes[0] && result.outcomes[0].status,
    'posted',
    `plan A must post before there is anything to take back: ${JSON.stringify(result.outcomes)}`
  );
  return { od, db, plan: db.table('rcm_posting_queue')[0] };
}

/** The candidate shape `scoreCandidate` takes, read off the fake's chart. */
function candidateFrom(od) {
  return {
    claim: od.rows.claims.find((c) => Number(c.ClaimNum) === OD_CLAIM_NUM),
    claimProcs: od.rows.claimProcs.filter((r) => Number(r.ClaimNum) === OD_CLAIM_NUM),
    procedures: new Map(od.rows.procedures.map((p) => [Number(p.ProcNum), p])),
    patient: { PatNum: 12827 },
  };
}

/** The reversal 835's own claim, as the ERA parser produces one. */
const REVERSAL_PROPOSAL = {
  claimNumber: String(OD_CLAIM_NUM),
  patientName: 'Test 2, Stedi',
  serviceDate: '2026-03-02',
  totalBilledCents: 21000,
  lines: [{ lineId: LINE_ID, position: 1, billedCode: 'D0120', code: 'D0120', billedCents: 21000 }],
};

const codes = (blockers) => blockers.map((b) => b.code);
const blockingCodes = (blockers) => blockers.filter((b) => b.blocking).map((b) => b.code);

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE CHART THE DRAIN LEAVES IS THE CHART A TAKEBACK TARGETS
// ═══════════════════════════════════════════════════════════════════════════

test('the drain leaves the line paid, Received and on a check — the takeback target', async () => {
  /*
   * The premise every assertion below rests on, stated once and read out of the
   * fake rather than assumed. If the drain ever stops leaving this state, the
   * rest of this file is testing something that cannot happen.
   */
  const { od } = await chartAfterPostingPlanA();
  const line = od.rows.claimProcs[0];

  assert.equal(line.Status, 'Received');
  assert.equal(Math.round(Number(line.InsPayAmt) * 100), PAID_CENTS);
  assert.ok(Number(line.ClaimPaymentNum) > 0, 'and it is attached to the check the drain created');
  assert.equal(String(od.rows.claims[0].ClaimStatus), 'R');
});

test('THE BUG: on the payment lane that chart has no postable line and two blockers', async () => {
  /*
   * Walk night 2's checklist, reproduced from the real drain's output. This is
   * the state the takeback path was being judged in, and every one of these
   * verdicts is correct — about a payment.
   */
  const { od } = await chartAfterPostingPlanA();
  const scored = claimMatch.scoreCandidate(REVERSAL_PROPOSAL, candidateFrom(od));

  assert.deepEqual(blockingCodes(scored.blockers).sort(), [
    'LINE_HAS_CLAIM_PAYMENT',
    'NO_PAYABLE_LINES',
  ]);

  const pairs = claimMatch.pairLines(REVERSAL_PROPOSAL.lines, scored.od.lines);
  assert.equal(pairs[0].odClaimProcNum, null);
  assert.equal(pairs[0].reason, 'no postable line on this claim');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE FIX: THE TAKEBACK LANE ASKS THE INVERSE
// ═══════════════════════════════════════════════════════════════════════════

test('on the takeback lane the SAME chart carries no blocking pre-flight fact', async () => {
  const { od } = await chartAfterPostingPlanA();
  const scored = claimMatch.scoreCandidate(REVERSAL_PROPOSAL, candidateFrom(od), {
    takeback: true,
    takebackCents: -PAID_CENTS,
  });

  assert.deepEqual(blockingCodes(scored.blockers), [], JSON.stringify(scored.blockers));
});

test('the attached check is REPORTED, not removed — a partition, not a filter', async () => {
  /*
   * §3.1's rule, applied one stage down. The fact that made the ordinary button
   * refuse is still on the screen, by name, with the opposite verdict — because
   * it is exactly the fact a biller needs in front of her when she reaches for
   * the takeback panel instead.
   */
  const { od } = await chartAfterPostingPlanA();
  const scored = claimMatch.scoreCandidate(REVERSAL_PROPOSAL, candidateFrom(od), {
    takeback: true,
    takebackCents: -PAID_CENTS,
  });

  const reported = scored.blockers.find((b) => b.code === 'LINE_PAID_AND_ON_CHECK');
  assert.ok(reported, `the fact must still print: ${JSON.stringify(codes(scored.blockers))}`);
  assert.equal(reported.blocking, false);
  assert.equal(reported.count, 1);
  assert.ok(!codes(scored.blockers).includes('LINE_HAS_CLAIM_PAYMENT'), 'and not under both names');
  assert.ok(!codes(scored.blockers).includes('NO_PAYABLE_LINES'));
});

test('the pairing targets the PAID line — the one the reversal reverses', async () => {
  const { od } = await chartAfterPostingPlanA();
  const scored = claimMatch.scoreCandidate(REVERSAL_PROPOSAL, candidateFrom(od), { takeback: true });
  const pairs = claimMatch.pairLines(REVERSAL_PROPOSAL.lines, scored.od.lines, { takeback: true });

  assert.equal(pairs[0].odClaimProcNum, OD_CLAIM_PROC_NUM);
  assert.equal(pairs[0].reason, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE TAKEBACK'S OWN REFUSALS — the inverse can say no
// ═══════════════════════════════════════════════════════════════════════════

test('a takeback against a line nobody paid is refused, and says which', async () => {
  /*
   * The thing that SHOULD refuse, and the reason this is an inversion rather
   * than a relaxation. Same chart, before the drain ran: nothing has been paid,
   * so there is nothing to take back.
   */
  const od = chartBeforeTheDrain();
  const scored = claimMatch.scoreCandidate(REVERSAL_PROPOSAL, candidateFrom(od), {
    takeback: true,
    takebackCents: -PAID_CENTS,
  });

  assert.ok(blockingCodes(scored.blockers).includes('NO_REVERSIBLE_LINES'));

  const pairs = claimMatch.pairLines(REVERSAL_PROPOSAL.lines, scored.od.lines, { takeback: true });
  assert.equal(pairs[0].odClaimProcNum, null);
  assert.equal(
    pairs[0].reason,
    'no paid line on this claim to reverse',
    'and the sentence is about a reversal, not about a payment'
  );
});

test('a takeback bigger than the payment on the chart is refused', async () => {
  const { od } = await chartAfterPostingPlanA();
  const scored = claimMatch.scoreCandidate(REVERSAL_PROPOSAL, candidateFrom(od), {
    takeback: true,
    // $2.00 back off a $1.00 payment.
    takebackCents: -200,
  });
  assert.ok(blockingCodes(scored.blockers).includes('TAKEBACK_EXCEEDS_PAYMENT'));
});

test('a takeback for exactly what was paid is not "bigger than"', async () => {
  // The boundary, in the direction that matters: an off-by-one here refuses
  // every honest full reversal there will ever be.
  const { od } = await chartAfterPostingPlanA();
  const scored = claimMatch.scoreCandidate(REVERSAL_PROPOSAL, candidateFrom(od), {
    takeback: true,
    takebackCents: -PAID_CENTS,
  });
  assert.ok(!blockingCodes(scored.blockers).includes('TAKEBACK_EXCEEDS_PAYMENT'));
});

test('an unknown takeback amount does not silently pass the coverage check', async () => {
  /*
   * A missing amount is not evidence that the chart covers it. The check is not
   * MADE rather than passed — and the difference shows up as the absence of a
   * verdict, which is what `NO_REVERSIBLE_LINES` is still there to catch.
   */
  const { od } = await chartAfterPostingPlanA();
  const scored = claimMatch.scoreCandidate(REVERSAL_PROPOSAL, candidateFrom(od), {
    takeback: true,
    takebackCents: null,
  });
  assert.ok(!codes(scored.blockers).includes('TAKEBACK_EXCEEDS_PAYMENT'));
  assert.deepEqual(blockingCodes(scored.blockers), []);
});

test('deleted, transferred and blocked-status lines are refused on BOTH lanes', async () => {
  /*
   * The inversion is exactly two codes wide. Everything else is a reason Open
   * Dental cannot be trusted about a line at all, and no direction of money
   * makes an unreadable procedure safe.
   */
  const { od } = await chartAfterPostingPlanA();
  od.rows.claimProcs[0].IsTransfer = true;
  const scored = claimMatch.scoreCandidate(REVERSAL_PROPOSAL, candidateFrom(od), {
    takeback: true,
    takebackCents: -PAID_CENTS,
  });
  assert.ok(blockingCodes(scored.blockers).includes('LINE_IS_TRANSFER'));
  // And with the only line ineligible, there is nothing left to reverse.
  assert.ok(blockingCodes(scored.blockers).includes('NO_REVERSIBLE_LINES'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. END TO END: THE GATE ITSELF, ON EVIDENCE THE DRAIN PRODUCED
// ═══════════════════════════════════════════════════════════════════════════

/**
 * THE MAP THIS FIXTURE USED TO THROW AWAY.
 *
 * Walk 3, 2026-08-30. This file drives the REAL drain and then evaluates the
 * reversal, and it was built so a refusal that only appears against a genuinely
 * posted chart could not hide. It passed anyway, while staging refused - because
 * every `evaluateClaim` call below handed in `plannedClaimprocs: new Map()`.
 *
 * The drain had written `rcm_posting_queue_line` into this very db. The chart
 * state was faithful and the PLAN state was discarded, so
 * `CLAIMPROC_NOT_ALREADY_PLANNED` was satisfied VACUOUSLY: there was nothing in
 * the map to conflict with. That is the same lesson as 10.6.1 and 10.6.3 - a
 * hand-built input for one layer is a claim about the layer beside it - and this
 * is its third appearance.
 *
 * Built the way `loadForApproval` builds it, including the plan status the
 * reversal partition reads.
 *
 * @param {import('./rcmTestUtils').FakeRcmDb} db
 * @returns {Map<number, { claimId: string, queueId: string, status: string|null }>}
 */
function plannedFromDb(db, office = 'roland') {
  const statusByQueueId = new Map(
    db
      .table('rcm_posting_queue')
      .filter((q) => q.office_id === office)
      .map((q) => [String(q.queue_id), String(q.status)])
  );
  const map = new Map();
  for (const line of db.table('rcm_posting_queue_line')) {
    if (line.office_id !== office) continue;
    if (line.is_supplemental) continue;
    if (line.od_claim_proc_num == null) continue;
    map.set(Number(line.od_claim_proc_num), {
      claimId: line.claim_id,
      queueId: line.queue_id,
      status: statusByQueueId.get(String(line.queue_id)) || null,
    });
  }
  return map;
}

/**
 * Assemble the snapshot `matchService` would store for this chart, on the given
 * lane, and run the real gate over it.
 */
function gateOverChart(od, { takeback, db }) {
  const scored = claimMatch.scoreCandidate(REVERSAL_PROPOSAL, candidateFrom(od), {
    takeback,
    takebackCents: -PAID_CENTS,
  });
  const linePairs = claimMatch.pairLines(REVERSAL_PROPOSAL.lines, scored.od.lines, { takeback });

  const snapshot = {
    version: 2,
    office: 'roland',
    takeback,
    fetchedAt: '2026-03-02T12:00:00.000Z',
    candidates: [{ ...scored, linePairs }],
    confirmed: {
      odClaimNum: OD_CLAIM_NUM,
      odPatNum: 12827,
      confirmedAt: '2026-03-02T12:00:00.000Z',
      confirmedBy: 'biller@example.invalid',
      linePairs,
      odAmountsAsRead: {
        billedCents: 21000,
        claimHeaderFeeCents: 21000,
        insPaidCents: PAID_CENTS,
        writeOffCents: 0,
        claimStatus: 'R',
      },
    },
  };

  return approvalGate.evaluateClaim({
    office: 'roland',
    claim: {
      // The REVERSAL's own row, distinct from the claim plan A paid. See
      // `REVERSAL_CLAIM_ID`.
      claimId: REVERSAL_CLAIM_ID,
      officeId: 'roland',
      patientName: 'Test 2, Stedi',
      claimNumber: String(OD_CLAIM_NUM),
      // The parser's own output for a reversal: negative money, and the flag.
      totalPaidCents: -PAID_CENTS,
      patientBalanceCents: 0,
      needsReviewReasons: ['reversal_not_postable'],
      reviewedAt: new Date('2026-03-02T12:30:00Z'),
      odMatchStatus: 'confirmed',
      odClaimNum: OD_CLAIM_NUM,
      matchSnapshot: snapshot,
      postingQueueId: null,
    },
    // The reversal line, paired by the snapshot above.
    lines: [
      {
        lineId: LINE_ID,
        position: 1,
        odClaimProcNum: linePairs[0].odClaimProcNum,
        paidCents: -PAID_CENTS,
        writeOffCents: 0,
        deductibleCents: 0,
        flags: [],
      },
    ],
    payment: { paidCents: -PAID_CENTS, batchClaimPaymentId: 'p1' },
    batchFlags: ['negative_total_payment'],
    /*
     * THE REAL PLAN STATE, not an empty map. `plan A` is `posted` by the time
     * this runs, and a posted plan does not hold its line against the reversal
     * OF that plan - which is exactly what walk 3 found and what
     * `PLAN_STATUSES_RELEASED_FOR_REVERSAL` now encodes.
     */
    plannedClaimprocs: plannedFromDb(db),
    recoupmentAllowed: true,
  });
}

test('THE WALK NIGHT REFUSAL, FIXED: the takeback is approvable against the posted chart', async () => {
  /*
   * The whole finding, in one assertion. Plan A really posted; the chart really
   * carries its payment; and the reversal of it now clears every condition —
   * including the two that refused on the night, and including every one that
   * was already passing and must keep passing.
   */
  const { od, db } = await chartAfterPostingPlanA();
  const verdict = gateOverChart(od, { takeback: true, db });

  assert.deepEqual(verdict.failed, [], JSON.stringify(verdict.checks, null, 2));
  assert.equal(verdict.postable, true);

  const preflight = verdict.checks.find((c) => c.code === 'NO_BLOCKING_PREFLIGHT');
  assert.equal(preflight.passed, true, 'the two payment-lane blockers are gone');
  const paired = verdict.checks.find((c) => c.code === 'LINES_PAIRED');
  assert.equal(paired.passed, true, 'and the reversal is paired to the line it reverses');

  // And it enqueues against the PAID claimproc, which is what 6d writes the
  // adjustment or the supplemental against.
  assert.equal(verdict.intent.lines[0].odClaimProcNum, OD_CLAIM_PROC_NUM);
  assert.equal(verdict.intent.lines[0].insPayAmtCents, -PAID_CENTS);
});

test('a snapshot taken for a PAYMENT cannot be used to approve a takeback', async () => {
  /*
   * The half that keeps the fix honest. Evidence gathered for the opposite
   * question is refused by name, with the one action that fixes it — rather
   * than being read as though the lane made no difference, which is precisely
   * what produced two true-but-irrelevant sentences on the night.
   */
  const { od, db } = await chartAfterPostingPlanA();
  const verdict = gateOverChart(od, { takeback: false, db });

  assert.equal(verdict.postable, false);
  assert.ok(verdict.failed.includes('MATCH_TAKEN_FOR_A_TAKEBACK'));

  const lane = verdict.checks.find((c) => c.code === 'MATCH_TAKEN_FOR_A_TAKEBACK');
  assert.match(lane.detail, /looked for a line to pay/);
  assert.match(lane.fix, /Run the match again/);
});

test('the ORDINARY approve is untouched — it still refuses this chart', async () => {
  /*
   * The rule the whole module is built on: a takeback cannot reach a chart
   * through the ordinary button, ever. Nothing in this fix widens the payment
   * lane, and the payment lane still reads a paid, checked line as unpostable —
   * because for a payment it is.
   */
  const { od, db } = await chartAfterPostingPlanA();
  const scored = claimMatch.scoreCandidate(REVERSAL_PROPOSAL, candidateFrom(od));
  assert.deepEqual(blockingCodes(scored.blockers).sort(), [
    'LINE_HAS_CLAIM_PAYMENT',
    'NO_PAYABLE_LINES',
  ]);

  const verdict = approvalGate.evaluateClaim({
    office: 'roland',
    claim: {
      claimId: REVERSAL_CLAIM_ID,
      officeId: 'roland',
      patientName: 'Test 2, Stedi',
      claimNumber: String(OD_CLAIM_NUM),
      totalPaidCents: -PAID_CENTS,
      patientBalanceCents: 0,
      needsReviewReasons: ['reversal_not_postable'],
      reviewedAt: new Date('2026-03-02T12:30:00Z'),
      odMatchStatus: 'confirmed',
      odClaimNum: OD_CLAIM_NUM,
      matchSnapshot: { version: 2, office: 'roland', takeback: true, candidates: [], confirmed: null },
      postingQueueId: null,
    },
    lines: [{ lineId: LINE_ID, position: 1, odClaimProcNum: OD_CLAIM_PROC_NUM, paidCents: -PAID_CENTS, flags: [] }],
    payment: { paidCents: -PAID_CENTS, batchClaimPaymentId: 'p1' },
    batchFlags: ['negative_total_payment'],
    // The real plan state here too: on the PAYMENT lane a posted plan still
    // holds its line, and this fixture is now the thing that proves it.
    plannedClaimprocs: plannedFromDb(db),
    recoupmentAllowed: false,
  });

  assert.equal(verdict.postable, false);
  assert.ok(verdict.failed.includes('NOT_REVERSAL'));
  assert.ok(verdict.failed.includes('NOT_RECOUPMENT'));
  assert.ok(
    !verdict.checks.some((c) => c.code === 'MATCH_TAKEN_FOR_A_TAKEBACK'),
    'and the lane check never appears on an ordinary checklist'
  );
});

// ===========================================================================
// 5. THE GAP THAT LET THIS FILE PASS WHILE STAGING REFUSED
// ===========================================================================

test('the fixture EARNS its pass: the plan map it evaluates against is not empty', async () => {
  /*
   * The guard on the gap itself.
   *
   * Every `evaluateClaim` above used to receive `plannedClaimprocs: new Map()`.
   * With an empty map `CLAIMPROC_NOT_ALREADY_PLANNED` cannot fail, so 13 tests
   * asserted a verdict that no chart state could have changed. If somebody
   * reaches for `new Map()` again to make a test go green, this fails.
   */
  const { db } = await chartAfterPostingPlanA();
  const planned = plannedFromDb(db);

  assert.ok(planned.size > 0, 'the drain wrote a plan line and the fixture must see it');
  const held = planned.get(OD_CLAIM_PROC_NUM);
  assert.ok(held, `ClaimProcNum ${OD_CLAIM_PROC_NUM} must be in the map the gate reads`);
  assert.equal(held.claimId, CLAIM_ID, 'and it is held by plan A, whose claim it is');
  /*
   * AND THE STATUS IS THE POINT. `posted` is what makes the partition release
   * it; the map carrying `undefined` here would let the reversal through for
   * the wrong reason and this file would be lying again.
   */
  assert.equal(held.status, 'posted', 'plan A really finished, and the map says so');
});

test('an ACTIVE plan still holds the line against a reversal — only a finished one lets go', async () => {
  /*
   * The other half of the partition, on the same driven chart. Taking money
   * back out from under a payment that is still arriving is the genuinely
   * unsafe case, and it stays refused on BOTH lanes.
   */
  const { od, db } = await chartAfterPostingPlanA();

  // The same chart, but the plan holding the line is mid-flight rather than done.
  db.table('rcm_posting_queue')[0].status = 'posting';

  const verdict = gateOverChart(od, { takeback: true, db });
  assert.equal(verdict.postable, false, 'a reversal must not slip past an in-flight plan');
  assert.ok(verdict.failed.includes('CLAIMPROC_NOT_ALREADY_PLANNED'));
  const check = verdict.checks.find((c) => c.code === 'CLAIMPROC_NOT_ALREADY_PLANNED');
  // And the refusal NAMES the status, so the rendered fix is possible to act on.
  assert.match(check.detail, /posting/);
});

test('a POSTED plan belonging to ANOTHER claim releases the line — the walk-3 refusal itself', async () => {
  /*
   * Staging, reproduced exactly. On the night, plan A held ClaimProcNum 535598
   * and the reversal was a DIFFERENT claim, so `planned.claimId !== claim.claimId`
   * and the conflict fired. Being on that posted plan is the takeback's
   * precondition, so it must not.
   */
  const { od, db } = await chartAfterPostingPlanA();
  // No hand-editing needed: the reversal is its own claim row (REVERSAL_CLAIM_ID)
  // and plan A's line belongs to the claim it paid, which is the staging shape.
  assert.notEqual(
    db.table('rcm_posting_queue_line')[0].claim_id,
    REVERSAL_CLAIM_ID,
    'the plan line and the reversal must be different claims, as they are in production'
  );

  const verdict = gateOverChart(od, { takeback: true, db });
  assert.ok(
    !verdict.failed.includes('CLAIMPROC_NOT_ALREADY_PLANNED'),
    'the plan the payment came FROM cannot be the reason its reversal is refused'
  );
});
