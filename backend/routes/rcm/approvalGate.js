'use strict';

/**
 * THE APPROVAL GATE (Slice 6b) — and the durable record of intent behind it.
 *
 *   evaluateRemittance()  the pure pre-flight: per claim, every condition, with
 *                         pass/fail and the reason. No I/O, no side effects.
 *   approveRemittance()   re-reads everything, re-evaluates it, and writes the
 *                         posting queue in ONE transaction.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STILL ZERO OPEN DENTAL WRITES. STILL ZERO OPEN DENTAL CALLS.
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing in this file imports an Open Dental module of any kind, reads a
 * chart, or knows how to. Approving is a decision about OUR rows; posting is
 * Slice 6c and lives behind its own gated staging event.
 * `rcmNoOdWrites.test.js` drives the whole approve surface and asserts no OD
 * verb — read or write — was reached.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GATE TRUSTS NOTHING THE CLIENT SENT
 * ─────────────────────────────────────────────────────────────────────────────
 * `approveRemittance` takes an office and a batch id and nothing else. Every
 * condition below is re-read from the database inside the transaction and
 * re-checked there, whatever the workbench displayed a moment earlier — a
 * screen can be stale, and the claim it showed as confirmed may have been
 * force-re-matched by somebody else since. There is no force flag, no override,
 * no query parameter and no admin bypass: the ONLY way a withheld claim becomes
 * postable is for a human to fix the thing that withheld it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PARTIAL SUCCESS IS REAL SUCCESS
 * ─────────────────────────────────────────────────────────────────────────────
 * The unit of approval is the REMITTANCE, but the unit of refusal is the CLAIM.
 * A check carrying nine clean claims and one reversal enqueues nine and says so,
 * naming the tenth and why. Refusing the whole check over one claim would make
 * the gate something billers route around; enqueueing the tenth silently would
 * be the thing the gate exists to prevent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A QUEUE ROW MEANS, AND WHAT IT DOES NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * `status = 'approved'` is the Slice 1 vocabulary's word for "approved and NOT
 * yet posted". Nothing here starts a drain, schedules one, or sweeps at
 * startup. Until 6c ships, a queued row means a person authorised a posting and
 * the money has not moved — and the workbench says exactly that, in those words.
 */

const tenantDb = require('../../platform/tenantDb');
const rcmVocabulary = require('../../services/rcm/rcmVocabulary');
const { buildBatchRemittanceKey } = require('../../services/rcm/remittanceKey');
const { resolveRcmActor } = require('../../services/rcm/rcmUserMap');
const { SNAPSHOT_VERSION, CLAIM_DETAIL_COLUMNS, LINE_COLUMNS } = require('./matchService');
const { num, iso, isoDate } = require('./helpers');

/**
 * THE PRE-FLIGHT CONDITIONS, in the order a biller reads them.
 *
 * Each is a named check with copy that says what to DO about it, because the
 * whole point of showing the checklist before the button is pressed is that a
 * failing row should be actionable. `fix` is what the screen prints under a
 * failure.
 *
 * The order is deliberate: identity first (is this the right claim, in the
 * right office, linked to the right chart), then the human decisions (matched,
 * reviewed), then the facts about the file, then the arithmetic. A biller
 * reading top to bottom meets the cheapest fix first.
 */
const CHECKS = Object.freeze({
  OFFICE_CONSISTENT: {
    label: 'Belongs to this office',
    fix: 'This claim is stamped with a different practice than the remittance it sits on. Nothing here can be posted until that is corrected.',
  },
  MATCH_CONFIRMED: {
    label: 'Matched to an Open Dental claim',
    fix: 'Open the claim, run the match, and confirm the right one. Posting needs a ClaimNum, and nothing may choose it but a person.',
  },
  SNAPSHOT_CURRENT: {
    label: 'The match record is current and complete',
    fix: 'The stored match was recorded in an older format or against another office. Run the match again and re-confirm it.',
  },
  REVIEWED: {
    label: 'Reviewed by a person',
    fix: 'Mark the claim reviewed, with a note. A biller saying "looked, nothing to do" is the record that the work happened.',
  },
  NOT_REVERSAL: {
    label: 'Not a reversal or takeback',
    fix: 'A takeback is a negative supplemental, which cannot be undone in Open Dental. Handle it in Open Dental directly, following the practice takeback procedure.',
  },
  NOT_RECOUPMENT: {
    label: 'Not a recoupment',
    fix: 'The carrier is taking money back on this claim. Recoupments are the one irreversible Open Dental operation and are not approvable here.',
  },
  NOT_PATIENT_RESPONSIBILITY_ONLY: {
    label: 'The carrier actually paid something',
    fix: 'Every cent on this claim is patient responsibility, so there is no insurance payment to post. Bill the patient in Open Dental.',
  },
  NO_BLOCKING_REASON: {
    label: 'No blocking review reason',
    fix: 'Something on this claim or this remittance means the amounts cannot be trusted. Fix the source or dispose of the claim manually.',
  },
  NO_BLOCKING_PREFLIGHT: {
    label: 'Open Dental will accept the write',
    fix: 'The chart claim carries a fact Open Dental refuses to write over. Resolve it in Open Dental and run the match again.',
  },
  LINES_PAIRED: {
    label: 'Every line is paired to a chart line',
    fix: 'At least one procedure line has no ClaimProcNum. Re-run the match; if it still cannot pair, the chart and the remittance disagree about what was done.',
  },
  CLAIM_TOTALS_AGREE: {
    label: 'The amounts reconcile',
    fix: 'What the remittance says this claim was paid does not equal the sum of its lines. The difference is money nobody can account for.',
  },
});

/** @type {ReadonlyArray<string>} */
const CHECK_ORDER = Object.freeze(Object.keys(CHECKS));

/**
 * Is every cent on this claim the patient's?
 *
 * Deliberately NOT a review reason — there is no vocabulary member for it, and
 * inventing one would put a computed judgement into a column whose contract is
 * "a fact the parser or the reader established about the source". It is
 * computed here, from the stored totals, at the moment it matters.
 *
 * The test is "the carrier paid nothing AND the patient owes something",
 * because a genuine zero — a full contractual write-off, an applied-to-
 * deductible with no balance — is a legitimate $0 adjudication that Open Dental
 * takes happily, and refusing it would strand every claim a payer zeroed out.
 *
 * @param {{ totalPaidCents: number, patientBalanceCents: number }} claim
 * @returns {boolean}
 */
function isPatientResponsibilityOnly(claim) {
  return claim.totalPaidCents <= 0 && claim.patientBalanceCents > 0;
}

/**
 * Is the carrier taking money BACK on this claim?
 *
 * Read off the money rather than off a flag, in two places at once: the claim's
 * own paid total and what the batch says this claim moved. Either being
 * negative is a takeback, and `rcm_posting_queue.is_recoupment` exists so 6d has
 * a column to gate on rather than re-deriving the sign — but 6b never sets it
 * true, because a recoupment cannot get through this gate at all.
 *
 * @param {{ totalPaidCents: number }} claim
 * @param {{ paidCents: number }|null} payment the rcm_batch_claim_payments row
 * @returns {boolean}
 */
function isRecoupment(claim, payment) {
  if (claim.totalPaidCents < 0) return true;
  return Boolean(payment && payment.paidCents < 0);
}

/**
 * Evaluate ONE claim against every rule, and say which lines it would enqueue.
 *
 * Pure: it is handed rows and returns a verdict. That is what lets the GET
 * checklist and the POST use one implementation and be unable to disagree —
 * a screen that predicts a different answer from the one the button produces is
 * worse than no screen.
 *
 * @param {object} input
 * @param {string} input.office
 * @param {object} input.claim         a `toApprovalClaim` row
 * @param {ReadonlyArray<object>} input.lines
 * @param {{ paidCents: number, batchClaimPaymentId: string|null }|null} input.payment
 * @param {ReadonlyArray<string>} input.batchFlags
 * @returns {{ claimId: string, patientName: string, claimNumber: string,
 *             postable: boolean, alreadyQueued: boolean,
 *             checks: Array<{ code: string, label: string, passed: boolean, detail: string|null, fix: string }>,
 *             failed: string[], intent: null|{ odClaimNum: number, totalCents: number,
 *               lines: Array<{ lineId: string, position: number, odClaimProcNum: number,
 *                              insPayAmtCents: number, writeOffCents: number, dedAppliedCents: number }> } }}
 */
function evaluateClaim({ office, claim, lines, payment, batchFlags }) {
  /** @type {Array<{ code: string, label: string, passed: boolean, detail: string|null, fix: string }>} */
  const checks = [];
  const add = (code, passed, detail) =>
    checks.push({ code, label: CHECKS[code].label, passed, detail: detail || null, fix: CHECKS[code].fix });

  // ── Identity ──────────────────────────────────────────────────────────────
  add('OFFICE_CONSISTENT', claim.officeId === office, claim.officeId === office ? null : `stamped ${claim.officeId}`);

  const confirmed = claim.odMatchStatus === 'confirmed' && claim.odClaimNum != null;
  add('MATCH_CONFIRMED', confirmed, confirmed ? `ClaimNum ${claim.odClaimNum}` : `match is ${claim.odMatchStatus}`);

  /*
   * THE SNAPSHOT MUST BE THE CURRENT SHAPE, FROM THIS OFFICE, AND CONFIRMED.
   *
   * 6c reads `confirmed.linePairs` and `confirmed.odAmountsAsRead` out of this
   * structure to re-verify against before it writes. A v1 snapshot does not
   * carry them under the names v2 gave them (`claimHeaderFeeCents` vs the old
   * `claimFeeCents`), and reading it anyway would compare a clean number to a
   * contaminated one. `confirmMatch` refuses a stale snapshot for the same
   * reason; this is the same refusal, one step later, because a snapshot can go
   * stale between the confirmation and the approval.
   */
  const snapshot = claim.matchSnapshot;
  const snapshotUsable =
    Boolean(snapshot) &&
    Number(snapshot.version) === SNAPSHOT_VERSION &&
    snapshot.office === office &&
    Boolean(snapshot.confirmed) &&
    Number(snapshot.confirmed.odClaimNum) === Number(claim.odClaimNum);
  add(
    'SNAPSHOT_CURRENT',
    snapshotUsable,
    !snapshot
      ? 'no match record stored'
      : Number(snapshot.version) !== SNAPSHOT_VERSION
        ? `recorded in format v${snapshot.version}, current is v${SNAPSHOT_VERSION}`
        : snapshot.office !== office
          ? `recorded against ${snapshot.office}`
          : !snapshot.confirmed
            ? 'the record carries no confirmation'
            : 'the confirmation names a different Open Dental claim'
  );

  // ── The human decisions ───────────────────────────────────────────────────
  add('REVIEWED', Boolean(claim.reviewedAt), claim.reviewedAt ? null : 'nobody has dispositioned this claim');

  // ── Facts about the money and the file ────────────────────────────────────
  const reversal = claim.needsReviewReasons.includes(
    rcmVocabulary.ERA_REVIEW_REASONS.REVERSAL
  );
  add('NOT_REVERSAL', !reversal, reversal ? 'the carrier reversed this claim' : null);

  const recoup = isRecoupment(claim, payment);
  add('NOT_RECOUPMENT', !recoup, recoup ? `the remittance moves ${payment ? payment.paidCents : claim.totalPaidCents} cents` : null);

  const prOnly = isPatientResponsibilityOnly(claim);
  add(
    'NOT_PATIENT_RESPONSIBILITY_ONLY',
    !prOnly,
    prOnly ? 'the carrier paid nothing and the whole balance is the patient’s' : null
  );

  /*
   * BLOCKING REASONS COME FROM ALL THREE VOCABULARIES AT ONCE (D-11).
   *
   * The claim's own review reasons, the flags on the whole remittance, and the
   * flags on its lines. A truncated envelope is a fact about the FILE that makes
   * every claim on it untrustworthy, and a line whose amount could not be read
   * is money on THIS claim — both must reach the same gate, or the split would
   * be honest at one level and decorative at the others.
   */
  const lineFlags = lines.flatMap((l) => l.flags || []);
  const blocking = rcmVocabulary.blockingReasonsIn([
    ...claim.needsReviewReasons,
    ...batchFlags,
    ...lineFlags,
  ]);
  add('NO_BLOCKING_REASON', blocking.length === 0, blocking.length ? blocking.join(', ') : null);

  /*
   * THE PRE-FLIGHT FACTS THE MATCH ALREADY READ OUT OF OPEN DENTAL.
   *
   * `claimMatch.findBlockers` recorded them at match time precisely so the
   * refusal arrives before the refusal: 6c would be told "Cannot change
   * InsPayAmt when Status is Received and attached to a ClaimPayment", at the
   * point where money is half-written. Read from the snapshot, never from a
   * fresh Open Dental call — this file makes none.
   */
  const candidate = snapshotUsable
    ? (snapshot.candidates || []).find((c) => Number(c.odClaimNum) === Number(claim.odClaimNum))
    : null;
  const odBlockers = candidate ? (candidate.blockers || []).filter((b) => b.blocking) : [];
  add(
    'NO_BLOCKING_PREFLIGHT',
    snapshotUsable && odBlockers.length === 0,
    !snapshotUsable
      ? 'cannot be checked without a current match record'
      : odBlockers.length
        ? odBlockers.map((b) => b.code).join(', ')
        : null
  );

  // ── The intent this claim would enqueue ───────────────────────────────────
  /*
   * EVERY line must pair, not merely the ones carrying money.
   *
   * 6c PUTs against a ClaimProcNum; a line without one is a payment we cannot
   * say where to put. Splitting the claim — posting the paired lines and
   * leaving the rest — would mean the chart holds part of a carrier's
   * adjudication and nothing records which part, which is exactly the §8
   * half-written state the queue exists to make recoverable. Refusing the whole
   * claim keeps the unit of posting the same as the unit the carrier adjudicated.
   */
  const paired = lines.filter((l) => l.odClaimProcNum != null);
  add(
    'LINES_PAIRED',
    lines.length > 0 && paired.length === lines.length,
    lines.length === 0
      ? 'this claim has no procedure lines'
      : paired.length === lines.length
        ? null
        : `${lines.length - paired.length} of ${lines.length} lines have no ClaimProcNum`
  );

  /*
   * THE ARITHMETIC, RE-DERIVED FROM THE ROWS.
   *
   * Three numbers about one claim: what the claim row says it was paid, what
   * the batch says this claim moved, and what the lines sum to. They must all
   * agree, and a disagreement is a REFUSAL rather than a warning — the whole
   * cost of this module being wrong is money moving to the wrong place, and a
   * warning is something a busy person clicks past.
   */
  const lineSum = lines.reduce((n, l) => n + l.paidCents, 0);
  const paymentCents = payment ? payment.paidCents : claim.totalPaidCents;
  const totalsAgree = lineSum === claim.totalPaidCents && paymentCents === claim.totalPaidCents;
  add(
    'CLAIM_TOTALS_AGREE',
    totalsAgree,
    totalsAgree
      ? null
      : `claim ${claim.totalPaidCents}, lines ${lineSum}, remittance ${paymentCents} (cents)`
  );

  const failed = checks.filter((c) => !c.passed).map((c) => c.code);

  return {
    claimId: claim.claimId,
    patientName: claim.patientName,
    claimNumber: claim.claimNumber,
    alreadyQueued: claim.postingQueueId != null,
    postable: failed.length === 0 && claim.postingQueueId == null,
    checks,
    failed,
    intent:
      failed.length === 0
        ? {
            odClaimNum: Number(claim.odClaimNum),
            totalCents: lineSum,
            lines: lines.map((l) => ({
              lineId: l.lineId,
              position: l.position,
              odClaimProcNum: Number(l.odClaimProcNum),
              /*
               * THE DERIVED WRITE-OFF, never a reported one (A3 / D-11).
               *
               * `write_off_cents` is what the parser computed from the
               * contractual adjustments. A payer's own AMT*B6 allowed amount is
               * evidence and is deliberately not used here — preferring it
               * zeroed the write-off outright in the Slice 5.5 review.
               */
              insPayAmtCents: l.paidCents,
              writeOffCents: l.writeOffCents,
              dedAppliedCents: l.deductibleCents,
            })),
          }
        : null,
    batchClaimPaymentId: payment ? payment.batchClaimPaymentId : null,
  };
}

/**
 * The CHEAP, NECESSARY subset of the gate — for the remittance LIST only.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SECOND, WEAKER PREDICATE EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * The full gate reads every claim's match SNAPSHOT (the whole candidate
 * payload, Open Dental patient names included) and every procedure line. Doing
 * that for every claim on every batch on a page would put the module's largest
 * PHI object on the cheapest screen, once per row, to colour a chip.
 *
 * So the list uses this instead: the conditions answerable from columns the
 * claim list already selects. It is deliberately NECESSARY-BUT-NOT-SUFFICIENT —
 * a claim that passes here can still be withheld by the real gate over a stale
 * snapshot, an unpaired line or arithmetic that does not reconcile.
 *
 * THAT IS SAFE, AND HERE IS WHY. Both outcomes are OBLIGATIONS: a claim that
 * looks approvable produces `claims_awaiting_approval` (an approver owes an
 * action) and one that does not produces `claims_withheld` (somebody owes a fix
 * or a manual disposition). Being wrong between them mislabels WHICH human owes
 * the action, never WHETHER one does — and the detail screen's checklist, which
 * runs the full gate, resolves it in one click. Nothing is ever enqueued on the
 * strength of this function.
 *
 * @param {{ postingQueueId: string|null, odMatchStatus: string, reviewedAt: string|null,
 *           needsReviewReasons: string[] }} claim a `toClaimSummary` row
 * @param {ReadonlyArray<string>} batchFlags
 * @returns {boolean}
 */
function looksApprovable(claim, batchFlags) {
  if (claim.postingQueueId != null) return false;
  if (claim.odMatchStatus !== 'confirmed') return false;
  if (!claim.reviewedAt) return false;
  return (
    rcmVocabulary.blockingReasonsIn([...(claim.needsReviewReasons || []), ...(batchFlags || [])])
      .length === 0
  );
}

/**
 * Evaluate a whole remittance. Pure, like `evaluateClaim`.
 *
 * @param {object} input
 * @param {string} input.office
 * @param {object} input.batch
 * @param {ReadonlyArray<object>} input.claims
 * @param {Map<string, object[]>} input.linesByClaim
 * @param {Map<string, { paidCents: number, batchClaimPaymentId: string|null }>} input.paymentsByClaim
 * @returns {{ claims: ReturnType<typeof evaluateClaim>[], postable: object[], withheld: object[],
 *             alreadyQueued: object[], batchBalanced: boolean, batchDifferenceCents: number }}
 */
function evaluateRemittance({ office, batch, claims, linesByClaim, paymentsByClaim }) {
  const evaluated = claims.map((claim) =>
    evaluateClaim({
      office,
      claim,
      lines: linesByClaim.get(claim.claimId) || [],
      payment: paymentsByClaim.get(claim.claimId) || null,
      batchFlags: batch.flags,
    })
  );

  /*
   * THE BATCH'S OWN INTEGRITY, checked once and separately from any claim.
   *
   * Check total − PLB must equal the sum of EVERY claim payment on the batch,
   * including the ones being withheld. A remittance whose money does not add up
   * is not a remittance some of whose claims are fine — the missing cents could
   * belong to any of them. So this holds the whole approve, not one claim.
   */
  const claimSum = [...paymentsByClaim.values()].reduce((n, p) => n + p.paidCents, 0);
  const differenceCents = batch.totalAmountCents - batch.plbTotalCents - claimSum;

  return {
    claims: evaluated,
    postable: evaluated.filter((c) => c.postable),
    withheld: evaluated.filter((c) => !c.postable && !c.alreadyQueued),
    alreadyQueued: evaluated.filter((c) => c.alreadyQueued),
    batchBalanced: differenceCents === 0,
    batchDifferenceCents: differenceCents,
  };
}

// ─── Reading the rows the gate judges ────────────────────────────────────────

/**
 * The batch columns the gate needs. Deliberately its own list rather than
 * `BATCH_COLUMNS`: the gate reads money and flags, not display fields, and a
 * list that names exactly what a decision depends on is a list somebody can
 * audit.
 */
const APPROVAL_BATCH_COLUMNS = [
  'batch_id',
  'office_id',
  'payer',
  'check_number',
  'eft_number',
  'trace_number',
  'deposit_date',
  'total_amount_cents',
  'plb_total_cents',
  'flags',
  'status',
].join(', ');

/** @param {Record<string, unknown>} row */
function toApprovalBatch(row) {
  return {
    batchId: row.batch_id,
    officeId: row.office_id,
    payer: row.payer,
    checkNumber: row.check_number || null,
    eftNumber: row.eft_number || null,
    traceNumber: row.trace_number || null,
    depositDate: isoDate(row.deposit_date),
    totalAmountCents: num(row.total_amount_cents),
    plbTotalCents: num(row.plb_total_cents),
    flags: Array.isArray(row.flags) ? row.flags : [],
    status: row.status,
  };
}

/** The claim columns the gate needs — the detail set plus the approval linkage. */
const APPROVAL_CLAIM_COLUMNS = `${CLAIM_DETAIL_COLUMNS}, posting_queue_id, approved_at, approved_by`;

/** @param {Record<string, unknown>} row */
function toApprovalClaim(row) {
  return {
    claimId: row.claim_id,
    officeId: row.office_id,
    claimNumber: row.claim_number,
    patientName: row.patient_name,
    odClaimNum: row.od_claim_num == null ? null : num(row.od_claim_num),
    odMatchStatus: row.od_match_status || 'not_run',
    matchSnapshot: row.od_match_snapshot || null,
    reviewedAt: iso(row.reviewed_at),
    needsReviewReasons: Array.isArray(row.needs_review_reasons) ? row.needs_review_reasons : [],
    totalPaidCents: num(row.total_paid_cents),
    patientBalanceCents: num(row.patient_balance_cents),
    postingQueueId: row.posting_queue_id || null,
    approvedAt: iso(row.approved_at),
    approvedByKey: row.approved_by || null,
  };
}

/** @param {Record<string, unknown>} row */
function toApprovalLine(row) {
  return {
    lineId: row.line_id,
    position: num(row.position),
    paidCents: num(row.paid_cents),
    writeOffCents: num(row.write_off_cents),
    deductibleCents: num(row.deductible_cents),
    flags: Array.isArray(row.flags) ? row.flags : [],
    odClaimProcNum: row.od_claim_proc_num == null ? null : num(row.od_claim_proc_num),
  };
}

/**
 * Load everything the gate judges, on one connection.
 *
 * `lock` runs the claim SELECT with FOR UPDATE, which is what makes the
 * approve's re-read and its write one atomic decision. The GET checklist passes
 * false: predicting an outcome must never take a row lock a biller can hold
 * open by leaving a tab open.
 *
 * @param {{ query: Function }} client
 * @param {string} office
 * @param {string} batchId
 * @param {{ lock?: boolean }} [opts]
 */
async function loadForApproval(client, office, batchId, { lock = false } = {}) {
  const batches = await client.query(
    `SELECT ${APPROVAL_BATCH_COLUMNS} FROM rcm_payment_batches ` +
      `WHERE office_id = $1 AND batch_id = $2`,
    [office, batchId]
  );
  if (batches.rows.length === 0) return null;
  const batch = toApprovalBatch(batches.rows[0]);

  const links = await client.query(
    `SELECT batch_claim_payment_id, claim_id, position, paid_cents FROM rcm_batch_claim_payments ` +
      `WHERE office_id = $1 AND batch_id = $2 ORDER BY position ASC`,
    [office, batchId]
  );

  /** @type {Map<string, { paidCents: number, batchClaimPaymentId: string|null }>} */
  const paymentsByClaim = new Map();
  const claimIds = [];
  for (const link of links.rows) {
    if (!link.claim_id) continue;
    if (!paymentsByClaim.has(link.claim_id)) claimIds.push(link.claim_id);
    paymentsByClaim.set(link.claim_id, {
      paidCents: num(link.paid_cents),
      batchClaimPaymentId: link.batch_claim_payment_id || null,
    });
  }

  if (claimIds.length === 0) {
    return { batch, claims: [], linesByClaim: new Map(), paymentsByClaim };
  }

  const claims = await client.query(
    `SELECT ${APPROVAL_CLAIM_COLUMNS} FROM rcm_claims ` +
      `WHERE office_id = $1 AND claim_id = ANY($2::uuid[])` +
      (lock ? ' FOR UPDATE' : ''),
    [office, claimIds]
  );
  const byId = new Map(claims.rows.map((r) => [r.claim_id, toApprovalClaim(r)]));

  const lines = await client.query(
    `SELECT ${LINE_COLUMNS} FROM rcm_procedure_lines ` +
      `WHERE office_id = $1 AND claim_id = ANY($2::uuid[]) ORDER BY position ASC`,
    [office, claimIds]
  );
  /** @type {Map<string, object[]>} */
  const linesByClaim = new Map();
  for (const row of lines.rows) {
    if (!linesByClaim.has(row.claim_id)) linesByClaim.set(row.claim_id, []);
    linesByClaim.get(row.claim_id).push(toApprovalLine(row));
  }

  // Ordered by the batch's own positions, so the checklist reads in the order
  // the remittance lists its claims.
  const ordered = claimIds.map((id) => byId.get(id)).filter(Boolean);
  return { batch, claims: ordered, linesByClaim, paymentsByClaim };
}

/**
 * The read-only pre-flight: what WOULD happen, computed exactly as the approve
 * computes it.
 *
 * @param {import('express').Request} req
 * @param {string} office
 * @param {string} batchId
 * @returns {Promise<null|object>} null when there is no such remittance here
 */
async function previewApproval(req, office, batchId) {
  const loaded = await tenantDb.withTenantDb(req, (pool) => loadForApproval(pool, office, batchId));
  if (!loaded) return null;
  const verdict = evaluateRemittance({ office, ...loaded });
  return { batch: loaded.batch, ...verdict };
}

/**
 * A refusal carrying an HTTP status and a stable code, in the shape the RCM
 * routes already translate (see `respondToApprovalError`).
 */
class ApprovalError extends Error {
  /** @param {string} code @param {number} httpStatus @param {string} message @param {object} [extra] */
  constructor(code, httpStatus, message, extra = {}) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    this.httpStatus = httpStatus;
    Object.assign(this, extra);
  }
}

/**
 * Approve a remittance: evaluate, then write the durable record of intent.
 *
 * ONE transaction. The claims are locked FOR UPDATE, re-evaluated under the
 * lock, and the queue row, its lines and the per-claim linkage are written
 * together — so a concurrent force-re-match cannot land between the check and
 * the write, and a half-written plan cannot survive a failure.
 *
 * @param {import('express').Request} req
 * @param {string} office
 * @param {string} batchId
 * @param {{ email: string, displayName?: string }} actor
 * @returns {Promise<object>}
 */
async function approveRemittance(req, office, batchId, actor) {
  return tenantDb.withTenantDb(req, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const loaded = await loadForApproval(client, office, batchId, { lock: true });
      if (!loaded) {
        await client.query('ROLLBACK');
        throw new ApprovalError('REMITTANCE_NOT_FOUND', 404, 'No such remittance for this office');
      }

      const verdict = evaluateRemittance({ office, ...loaded });

      /*
       * THE BATCH'S ARITHMETIC HOLDS THE WHOLE APPROVE. See evaluateRemittance.
       */
      if (!verdict.batchBalanced) {
        await client.query('ROLLBACK');
        throw new ApprovalError(
          'REMITTANCE_UNBALANCED',
          409,
          'This remittance does not balance — the check total, its provider-level adjustments and the sum of its claim payments disagree. Nothing on it can be approved until they reconcile.',
          { differenceCents: verdict.batchDifferenceCents, claims: verdict.claims }
        );
      }

      /*
       * NOTHING TO APPROVE IS A REFUSAL, NOT AN EMPTY SUCCESS.
       *
       * A 200 saying "approved 0 claims" would read, on a busy screen, as
       * "done". The per-claim reasons ride on the refusal so the biller is told
       * what to fix in the same breath as being told nothing happened.
       */
      if (verdict.postable.length === 0) {
        await client.query('ROLLBACK');
        throw new ApprovalError(
          'NOTHING_APPROVABLE',
          409,
          verdict.alreadyQueued.length > 0
            ? 'Everything on this remittance that can be posted is already queued; the rest is withheld.'
            : 'Nothing on this remittance can be posted yet.',
          { claims: verdict.claims }
        );
      }

      // D-5: the acting user, created on first use, on THIS connection so the
      // FKs below see it.
      const approvedBy = await resolveRcmActor(client, actor);

      /*
       * ONE QUEUE ROW PER REMITTANCE, found or created.
       *
       * The Slice 1 schema keys it `(office_id, remittance_key)` — the same
       * primitive the double-posting guard uses — so a re-approve after a
       * partial one appends to the plan that already exists rather than
       * starting a second one. `ON CONFLICT DO NOTHING` makes find-or-create
       * one statement: two billers pressing Approve at the same instant both
       * see a row, and exactly one created it.
       */
      const remittanceKey = await resolveRemittanceKey(client, office, loaded.batch);
      const inserted = await client.query(
        `INSERT INTO rcm_posting_queue ` +
          `(office_id, batch_id, remittance_key, status, is_recoupment, intended_total_cents, ` +
          `posted_total_cents, approved_by) ` +
          `VALUES ($1, $2, $3, 'approved', false, 0, 0, $4) ` +
          `ON CONFLICT (office_id, remittance_key) DO NOTHING RETURNING queue_id`,
        [office, loaded.batch.batchId, remittanceKey, approvedBy]
      );

      let queueId = inserted.rows.length ? inserted.rows[0].queue_id : null;
      if (!queueId) {
        const existing = await client.query(
          `SELECT queue_id, status FROM rcm_posting_queue WHERE office_id = $1 AND remittance_key = $2`,
          [office, remittanceKey]
        );
        if (existing.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new ApprovalError(
            'QUEUE_ROW_UNAVAILABLE',
            500,
            'The posting plan for this remittance could neither be created nor found.'
          );
        }
        /*
         * A PLAN THAT HAS ALREADY LEFT 'approved' IS NOT ONE TO APPEND TO.
         *
         * Once 6c starts draining, adding lines to a running plan would mean a
         * claim whose money the drain never saw. Nothing sets a status past
         * 'approved' in this slice, so this cannot fire today — it is here
         * because the day it can is the day it matters, and it is cheaper than
         * remembering.
         */
        if (existing.rows[0].status !== 'approved') {
          await client.query('ROLLBACK');
          throw new ApprovalError(
            'QUEUE_ALREADY_RUNNING',
            409,
            'A posting run for this remittance is already under way — it cannot take more claims.'
          );
        }
        queueId = existing.rows[0].queue_id;
      }

      // Positions continue from whatever is already on the plan, so a re-approve
      // never collides with the queue's (queue_id, position) uniqueness and 6c's
      // replay order stays deterministic across both approvals.
      const positions = await client.query(
        `SELECT COUNT(*)::int AS n FROM rcm_posting_queue_line WHERE office_id = $1 AND queue_id = $2`,
        [office, queueId]
      );
      let position = num(positions.rows[0] && positions.rows[0].n);

      let intendedTotal = 0;
      /** @type {Array<{ claimId: string, odClaimNum: number, lines: number, totalCents: number }>} */
      const queued = [];

      for (const claim of verdict.postable) {
        /*
         * THE CLAIM'S LINK IS WRITTEN FIRST, AND ITS WHERE IS THE GUARD.
         *
         * `posting_queue_id IS NULL` re-asserted in the statement makes the
         * check and the write atomic: a second approve racing this one matches
         * no row, writes nothing, and is reported as already-queued rather than
         * enqueueing the same money twice. The database is what enforces it —
         * a single-valued column cannot hold two plans — so a future caller
         * that skips `evaluateClaim` still cannot double-enqueue.
         */
        const linked = await client.query(
          `UPDATE rcm_claims SET posting_queue_id = $3, approved_at = now(), approved_by = $4, ` +
            `updated_at = now() ` +
            `WHERE office_id = $1 AND claim_id = $2 AND posting_queue_id IS NULL`,
          [office, claim.claimId, queueId, approvedBy]
        );
        if (linked.rowCount === 0) {
          // Somebody approved it between our locked read and here, which the
          // FOR UPDATE should have prevented. Refuse the whole approve rather
          // than continue with a set we can no longer describe accurately.
          await client.query('ROLLBACK');
          throw new ApprovalError(
            'CLAIM_ALREADY_QUEUED',
            409,
            'A claim on this remittance was approved by somebody else while this approval was being written. Nothing was queued; open the remittance again.'
          );
        }

        for (const line of claim.intent.lines) {
          position += 1;
          await client.query(
            `INSERT INTO rcm_posting_queue_line ` +
              `(queue_id, office_id, position, od_claim_proc_num, od_claim_num, claim_id, ` +
              `batch_claim_payment_id, intended_ins_pay_amt_cents, intended_write_off_cents, ` +
              `intended_ded_applied_cents, is_supplemental, status) ` +
              `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, 'pending')`,
            [
              queueId,
              office,
              position,
              line.odClaimProcNum,
              claim.intent.odClaimNum,
              claim.claimId,
              claim.batchClaimPaymentId,
              line.insPayAmtCents,
              line.writeOffCents,
              line.dedAppliedCents,
            ]
          );
        }

        intendedTotal += claim.intent.totalCents;
        queued.push({
          claimId: claim.claimId,
          claimNumber: claim.claimNumber,
          patientName: claim.patientName,
          odClaimNum: claim.intent.odClaimNum,
          lines: claim.intent.lines.length,
          totalCents: claim.intent.totalCents,
        });
      }

      /*
       * THE PLAN'S OWN TOTAL IS RE-DERIVED FROM THE LINES ACTUALLY WRITTEN.
       *
       * Not accumulated from what we intended to write — read back out of the
       * table, so a bug in the insert loop fails here instead of shipping a
       * plan whose header disagrees with its own lines.
       */
      const written = await client.query(
        `SELECT COALESCE(SUM(intended_ins_pay_amt_cents), 0)::bigint AS total ` +
          `FROM rcm_posting_queue_line WHERE office_id = $1 AND queue_id = $2`,
        [office, queueId]
      );
      const writtenTotal = num(written.rows[0] && written.rows[0].total);

      await client.query(
        `UPDATE rcm_posting_queue SET intended_total_cents = $3, updated_at = now() ` +
          `WHERE office_id = $1 AND queue_id = $2`,
        [office, queueId, writtenTotal]
      );

      await client.query('COMMIT');

      return {
        queueId,
        remittanceKey,
        approvedBy,
        intendedTotalCents: writtenTotal,
        enqueuedTotalCents: intendedTotal,
        queued,
        withheld: verdict.withheld.map((c) => ({
          claimId: c.claimId,
          claimNumber: c.claimNumber,
          patientName: c.patientName,
          reasons: c.failed,
          checks: c.checks,
        })),
        alreadyQueued: verdict.alreadyQueued.map((c) => ({
          claimId: c.claimId,
          claimNumber: c.claimNumber,
          patientName: c.patientName,
        })),
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the original error is the one worth reporting */
      }
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * The remittance key this plan is guarded by.
 *
 * Preferred from `rcm_remittance_keys`, which the ERA path reserves at ingest —
 * so an 835 and its posting plan are guarded by the SAME key rather than by two
 * that happen to agree. When there is none (the EOB path never reserves one; a
 * PDF is read, not deduplicated at parse time), it is DERIVED from the batch's
 * own identity components through the module's single builder, so the two doors
 * still produce one key for one physical check.
 *
 * No reservation row is written here. Reserving is the posting protocol's act
 * and belongs to 6c; the queue's own `(office_id, remittance_key)` uniqueness is
 * what makes a second plan for one check impossible at this layer.
 *
 * @param {{ query: Function }} client
 * @param {string} office
 * @param {ReturnType<typeof toApprovalBatch>} batch
 * @returns {Promise<string>}
 */
async function resolveRemittanceKey(client, office, batch) {
  const found = await client.query(
    `SELECT remittance_key FROM rcm_remittance_keys WHERE office_id = $1 AND batch_id = $2`,
    [office, batch.batchId]
  );
  if (found.rows.length > 0 && found.rows[0].remittance_key) return found.rows[0].remittance_key;
  return buildBatchRemittanceKey({
    traceNumber: batch.traceNumber,
    checkNumber: batch.checkNumber,
    eftNumber: batch.eftNumber,
    payer: batch.payer,
    depositDate: batch.depositDate,
    totalAmountCents: batch.totalAmountCents,
  });
}

module.exports = {
  CHECKS,
  CHECK_ORDER,
  APPROVAL_BATCH_COLUMNS,
  APPROVAL_CLAIM_COLUMNS,
  ApprovalError,
  isPatientResponsibilityOnly,
  isRecoupment,
  evaluateClaim,
  looksApprovable,
  evaluateRemittance,
  loadForApproval,
  previewApproval,
  approveRemittance,
};
