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
const claimMatch = require('../../services/rcm/claimMatch');
const claimWorkbench = require('../../services/rcm/claimWorkbench');
const lineDecisions = require('../../services/rcm/lineDecisions');
const { buildBatchRemittanceKey } = require('../../services/rcm/remittanceKey');
const { resolveRcmActor, describeActors } = require('../../services/rcm/rcmUserMap');
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
/**
 * The two blocking reasons a typed takeback confirmation answers, and the ONLY
 * two (D-11 amendment, 2026-08-27).
 *
 * Both are what an honest parser says about a reversal 835: the claim is a
 * reversal, and the remittance nets negative. On the recoupment approve they are
 * exactly what the approver typed a number to confirm, so
 * `TAKEBACK_ACKNOWLEDGED` claims them by name. Everything else in the blocking
 * vocabulary still blocks, on both paths.
 *
 * ADDING TO THIS LIST IS A RULING, not a fix. It is the one place in the module
 * where a blocking reason can be answered by something other than removing its
 * cause.
 */
const TAKEBACK_FLAGS = Object.freeze([
  rcmVocabulary.ERA_REVIEW_REASONS.REVERSAL,
  'negative_total_payment',
]);

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
    fix: 'The carrier is taking money back on this claim. Approve it from the takeback panel instead — that path asks you to type the amount, and it offers the reversible adjustment as well as the permanent supplemental.',
  },
  /**
   * D-6's replacement for the two checks above, on the recoupment path ONLY.
   * It can only be true because the SERVER matched the approver's typed total
   * against money it computed itself — never because a client said so.
   */
  RECOUPMENT_CONFIRMED: {
    label: 'A takeback, confirmed by typing its amount',
    fix: 'This claim is not a takeback, so it cannot be approved on a recoupment confirmation. Approve it normally.',
  },
  TAKEBACK_ACKNOWLEDGED: {
    label: 'The takeback flags are what the typed amount confirmed',
    fix: 'This claim is not a takeback, so the reversal flags on it are not explained by a takeback confirmation. Dispose of it manually.',
  },
  /**
   * Walk night 2, finding 1. Recoupment path ONLY, like the two above.
   *
   * The match gathers the evidence this gate judges, and a payment and a
   * takeback ask OPPOSITE questions of the same chart. A snapshot taken for a
   * payment reports the paid line as a blocker and pairs to nothing; judging a
   * takeback on it produces two refusals that are both true sentences about a
   * payment and say nothing about the reversal in front of the biller.
   *
   * So the lane is asserted rather than assumed, and the fix is one she can act
   * on in a click.
   */
  MATCH_TAKEN_FOR_A_TAKEBACK: {
    label: 'The match record was taken for a takeback',
    fix: 'Run the match again on this claim. The stored record was taken for an ordinary payment, so it looked for a line to pay rather than the paid line this reverses.',
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
  CLAIMPROC_NOT_ALREADY_PLANNED: {
    label: 'No chart line is already on another posting plan',
    fix: 'Another claim in this practice is already planned to post money against one of these Open Dental lines. Two proposals have been confirmed to the same chart claim — release one of them before approving.',
  },
  /**
   * STAGE B1. The rule the workbench is built on, at the gate.
   *
   * What the remittance says the patient owes must equal what Open Dental will
   * say the patient owes once this posts — with one legitimate exception, a
   * write-off the office chose to make, which lowers the patient's number on
   * purpose and carries a reason and a name.
   *
   * It reads `services/rcm/lineDecisions.js`, the same function the workbench's
   * verdict line renders. ONE arithmetic, two renderers: a green line beside a
   * refusal here is not a bug that can be introduced, and
   * `approvalGate.test.js` pins that they agree over the same rows.
   *
   * AMBER PASSES. A write-off somebody decided on, with a reason, is the case
   * this check exists to let through — refusing it would refuse the ordinary
   * work. RED refuses.
   */
  PATIENT_RESPONSIBILITY_MATCHES: {
    label: "The patient's number matches the EOB",
    fix: 'What the patient will owe once this posts is not what the EOB says they owe. Either a line is written off with no reason recorded, a line has no match in Open Dental, or Open Dental was billed a different amount for a procedure. Fix the line the verdict names.',
  },
  CLAIM_TOTALS_AGREE: {
    label: 'The amounts reconcile',
    fix: 'What the remittance says this claim was paid does not equal the sum of its lines. The difference is money nobody can account for.',
  },
});

/** @type {ReadonlyArray<string>} */
const CHECK_ORDER = Object.freeze(Object.keys(CHECKS));

/**
 * Plan statuses that mean "a drain has already had this plan" (Slice 6c).
 *
 * `posting` is deliberately NOT one of them — that plan really is under way, and
 * that is the one status the original single sentence was ever true for.
 *
 * Everything here is a plan that has RUN. It cannot take more claims either way,
 * but the reason differs enough that the sentence differs with it: see
 * `alreadyRanMessage`.
 */
const TERMINAL_QUEUE_STATUSES = Object.freeze([
  'posted',
  'partially_posted',
  'failed',
  'blocked',
]);

/**
 * Plan statuses that DO NOT hold a chart line against a REVERSAL (walk 3).
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT `TERMINAL_QUEUE_STATUSES`, AND THE DIFFERENCE IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 * That list answers "has a drain already had this plan" and includes
 * `partially_posted`, `failed` and `blocked`. Reusing it here would release a
 * line held by a plan that may still write to it: a `partially_posted` plan has
 * unfinished lines, and a `failed` or `blocked` one is waiting to be re-drained.
 * Taking money back out from under a payment that is still arriving is the
 * genuinely unsafe case, so those keep holding the line on BOTH lanes.
 *
 * What is left is the pair that can never write again:
 *   `posted`    - the plan finished. Its payment is ON the chart, which is
 *                 precisely what makes the line REVERSIBLE. Being on this plan
 *                 is the takeback's PRECONDITION, not a conflict with it.
 *   `withdrawn` - the plan was retired and can never run (see 2.2.0).
 *
 * Walk 3, 2026-08-30: the reversal of plan A refused with "ClaimProcNum 535598
 * already on a posting plan", and its rendered fix - release the other posting
 * plan first - is IMPOSSIBLE by design, because withdraw correctly refuses a
 * posted plan. A refusal whose remedy cannot exist is the same defect class as
 * the re-match loop PR #123 fixed.
 *
 * The ORDINARY PAYMENT LANE IS UNTOUCHED: a posted plan's line already cannot
 * take a second payment (`LINE_HAS_CLAIM_PAYMENT`), and two plans paying one
 * line stays refused everywhere.
 */
const PLAN_STATUSES_RELEASED_FOR_REVERSAL = Object.freeze(['posted', 'withdrawn']);

/**
 * What to tell a biller whose claim cannot join an already-run plan.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LIMITATION THIS SENTENCE EXISTS TO STOP HIDING
 * ─────────────────────────────────────────────────────────────────────────────
 * `rcm_posting_queue` is unique on `(office_id, remittance_key)`: **a remittance
 * gets exactly ONE posting plan, ever.** So a claim withheld at approval and
 * fixed after its remittance's plan has run has nowhere to go — it cannot post
 * through CareIN at all, and the money goes in by hand in Open Dental until a
 * later slice adds a follow-on plan.
 *
 * Until 6c this was invisible behind *"a posting run is already under way"*,
 * which read as "wait a minute and try again" — advice that would never come
 * good.
 *
 * @param {string} status
 * @returns {string}
 */
function alreadyRanMessage(status) {
  if (status === 'posted') {
    return (
      'The posting run for this remittance has already finished and its payment is in Open ' +
      'Dental, so this claim cannot join it. Post this one by hand in Open Dental — CareIN ' +
      'cannot start a second run for the same check yet.'
    );
  }
  if (status === 'partially_posted') {
    return (
      'The posting run for this remittance has already put money in Open Dental and stopped ' +
      'part-way, so this claim cannot join it. Resolve that run on the Posting screen first; ' +
      'this claim posts by hand in Open Dental.'
    );
  }
  // `failed` and `blocked`: a drain has had the plan and it is not accepting
  // more claims. It CAN be drained again — which is what the Posting screen is
  // for — but this claim is not going to be part of it.
  return (
    "This remittance's posting plan has already been started and is not accepting more " +
    'claims. Resolve it on the Posting screen and drain it; this claim posts by hand in ' +
    'Open Dental.'
  );
}

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
 * a column to gate on rather than re-deriving the sign.
 *
 * DELEGATES TO `claimMatch.isTakeback`, and that is the point of it. This
 * function used to own the definition, and the MATCH had no notion of the
 * question at all — so the match gathered payment-lane evidence about a
 * takeback and this gate judged it as though the lane made no difference. One
 * predicate, two callers, and `claimMatch.test.js` pins the agreement.
 *
 * @param {{ totalPaidCents: number }} claim
 * @param {{ paidCents: number }|null} payment the rcm_batch_claim_payments row
 * @returns {boolean}
 */
function isRecoupment(claim, payment) {
  return claimMatch.isTakeback({
    totalPaidCents: claim.totalPaidCents,
    paidCents: payment ? payment.paidCents : null,
  });
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
 * @param {Map<number, { claimId: string, queueId: string }>} [input.plannedClaimprocs]
 * @returns {{ claimId: string, patientName: string, claimNumber: string,
 *             postable: boolean, alreadyQueued: boolean,
 *             checks: Array<{ code: string, label: string, passed: boolean, detail: string|null, fix: string }>,
 *             failed: string[], intent: null|{ odClaimNum: number, totalCents: number,
 *               lines: Array<{ lineId: string, position: number, odClaimProcNum: number,
 *                              insPayAmtCents: number, writeOffCents: number, dedAppliedCents: number }> } }}
 */
function evaluateClaim({ office, claim, lines, payment, batchFlags, plannedClaimprocs = new Map(), recoupmentAllowed = false }) {
  /** @type {Array<{ code: string, label: string, passed: boolean, detail: string|null, fix: string }>} */
  const checks = [];
  const add = (code, passed, detail) =>
    checks.push({ code, label: CHECKS[code].label, passed, detail: detail || null, fix: CHECKS[code].fix });

  // ── Identity ──────────────────────────────────────────────────────────────

  /*
   * OFFICE IS EVALUATED PER CLAIM, AND THIS CHECK USED TO BE UNREACHABLE.
   *
   * `loadForApproval` selected claims `WHERE office_id = $1`, so a claim
   * belonging to the other practice simply DROPPED OUT of the checklist — while
   * its payment still counted in the batch's own sum. The only symptom was a
   * `REMITTANCE_UNBALANCED` refusal naming no claim, which is the hardest
   * possible version of the problem to act on. The claims are now loaded by
   * BATCH and their office is judged here.
   *
   * A stranger's claim is REDACTED before it reaches this function (see
   * `toForeignClaim`): the mismatch is named and withheld, and no other
   * practice's patient name is rendered on this office's screen to do it. The
   * remaining conditions are not evaluated, and say so — asserting anything
   * about a row this office should not be reading would be a guess.
   */
  if (claim.officeId !== office) {
    add('OFFICE_CONSISTENT', false, `stamped ${claim.officeId}`);
    for (const code of CHECK_ORDER) {
      if (code !== 'OFFICE_CONSISTENT') add(code, false, 'not evaluated — this claim is not this practice\'s');
    }
    return {
      claimId: claim.claimId,
      patientName: claim.patientName,
      claimNumber: claim.claimNumber,
      alreadyQueued: false,
      postable: false,
      checks,
      failed: checks.filter((c) => !c.passed).map((c) => c.code),
      intent: null,
      batchClaimPaymentId: payment ? payment.batchClaimPaymentId : null,
    };
  }
  add('OFFICE_CONSISTENT', true, null);

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

  /*
   * THE CANDIDATE ITSELF MUST BE IN THE SNAPSHOT — F4, and it failed OPEN.
   *
   * `NO_BLOCKING_PREFLIGHT` below reads the confirmed candidate's `blockers`.
   * When the confirmed ClaimNum was not among `snapshot.candidates` the lookup
   * returned undefined, `blockers` defaulted to `[]`, and the check PASSED —
   * absence read as clean, which is this module's recurring defect shape and
   * the one it has spent three slices learning to refuse.
   *
   * `confirmMatch` will not confirm a ClaimNum that was not offered, so the only
   * ways to reach it are a snapshot rewritten underneath a confirmation or a row
   * edited by hand. Both are exactly the cases where posting on the strength of
   * an empty blocker list would be worst.
   */
  const candidate =
    snapshot && Array.isArray(snapshot.candidates)
      ? snapshot.candidates.find((c) => Number(c.odClaimNum) === Number(claim.odClaimNum)) || null
      : null;

  /*
   * OUR BILLED FIGURE MINUS OPEN DENTAL'S, PER LINE, FROM THE CONFIRMATION.
   *
   * `confirmMatch` wrote `linePairs` with `billedDeltaCents` on it — the only
   * place the two billed figures have ever been compared — so Stage B1's
   * patient-responsibility check reads a comparison that was already made
   * rather than making an Open Dental call this file is not allowed to make.
   */
  const feeDeltas = claimWorkbench.feeDeltasByLine(snapshot);

  const snapshotUsable =
    Boolean(snapshot) &&
    Number(snapshot.version) === SNAPSHOT_VERSION &&
    snapshot.office === office &&
    Boolean(snapshot.confirmed) &&
    Number(snapshot.confirmed.odClaimNum) === Number(claim.odClaimNum) &&
    candidate !== null;
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
            : Number(snapshot.confirmed.odClaimNum) !== Number(claim.odClaimNum)
              ? 'the confirmation names a different Open Dental claim'
              : 'the confirmed claim is not among the candidates the match recorded'
  );

  // ── The human decisions ───────────────────────────────────────────────────
  add('REVIEWED', Boolean(claim.reviewedAt), claim.reviewedAt ? null : 'nobody has dispositioned this claim');

  // ── Facts about the money and the file ────────────────────────────────────
  const reversal = claim.needsReviewReasons.includes(
    rcmVocabulary.ERA_REVIEW_REASONS.REVERSAL
  );
  const recoup = isRecoupment(claim, payment);

  /*
   * ── D-6: THE TWO TAKEBACK CHECKS SWAP, THEY DO NOT VANISH (6d) ────────────
   *
   * On the ORDINARY approve (`recoupmentAllowed: false`, the default and what
   * `POST /:id/approve` always passes) these two block exactly as they did in
   * 6b. A takeback cannot reach the chart through the ordinary button, ever.
   *
   * On the RECOUPMENT approve they are replaced by `RECOUPMENT_CONFIRMED` —
   * which the caller only sets true after the SERVER has matched the typed
   * total against the money it computed itself. So the gate never has fewer
   * conditions on a recoupment than on an ordinary claim; it has a different,
   * harder one, and the claim still has to satisfy every other check on the
   * list (matched, reviewed, office-consistent, lines paired, totals agree).
   *
   * Written as a swap rather than as an early return because a reviewer needs
   * to see, in one place, that nothing was merely switched off.
   */
  if (!recoupmentAllowed) {
    add('NOT_REVERSAL', !reversal, reversal ? 'the carrier reversed this claim' : null);
    add(
      'NOT_RECOUPMENT',
      !recoup,
      recoup ? `the remittance moves ${payment ? payment.paidCents : claim.totalPaidCents} cents` : null
    );
  } else {
    /*
     * A RECOUPMENT APPROVE MAY ONLY CARRY RECOUPMENTS.
     *
     * The typed phrase confirms a specific negative total. Letting an ordinary
     * positive claim ride along on that confirmation would post money the
     * approver never typed a number for — the confirmation would be attached to
     * a set larger than the one it described.
     */
    add(
      'RECOUPMENT_CONFIRMED',
      recoup,
      recoup ? null : 'this claim is not a takeback and cannot ride on a recoupment confirmation'
    );
  }

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
  const allBlocking = rcmVocabulary.blockingReasonsIn([
    ...claim.needsReviewReasons,
    ...batchFlags,
    ...lineFlags,
  ]);

  /*
   * ─── D-11 AMENDMENT (2026-08-27): THE TWO TAKEBACK FLAGS ARE PARTITIONED,
   *     NOT FILTERED ────────────────────────────────────────────────────────────────
   *
   * A reversal 835 the PARSER produced carries `reversal_not_postable` on the
   * claim and `negative_total_payment` on the remittance. Both are `blocking`,
   * and until this amendment `NO_BLOCKING_REASON` was computed over every reason
   * unconditionally — so D-6's typed-confirmation path was unreachable for any
   * 835 a real carrier would send. 6d never noticed because its recoupment tests
   * build the claim BY HAND, with a negative amount and no review reasons.
   *
   * EVERY REASON IS STILL ACCOUNTED FOR BY EXACTLY ONE CHECK. On the recoupment
   * path the two takeback flags are claimed by `TAKEBACK_ACKNOWLEDGED`, which
   * appears in the checklist and can FAIL; the rest go to `NO_BLOCKING_REASON`
   * as before. That is a partition, and it is the reason this is not written as
   * `blocking.filter(...)`: a filter makes a reason vanish from the screen, and
   * D-11's whole point is that no code path gets to decide a flag does not apply
   * to it. Here the flag still applies — it is answered, by name, in public.
   *
   * ON THE ORDINARY PATH NOTHING CHANGES. `TAKEBACK_ACKNOWLEDGED` is never added,
   * the partition never runs, and both flags block exactly as they did in 6b.
   * A takeback cannot reach a chart through the ordinary button, ever.
   *
   * Only these two, and only these two: a truncated envelope or an unreadable
   * line amount still blocks a recoupment approve, because neither is a fact
   * about the money moving backwards — they are facts about not being able to
   * read the file at all, and no typed amount confirms those.
   */
  const takebackClaimed = recoupmentAllowed
    ? allBlocking.filter((r) => TAKEBACK_FLAGS.includes(r))
    : [];
  const blocking = allBlocking.filter((r) => !takebackClaimed.includes(r));

  if (recoupmentAllowed) {
    /*
     * It passes when the claim really is a takeback — the same `recoup` that
     * `RECOUPMENT_CONFIRMED` turns on, so the two cannot disagree. A claim
     * carrying reversal flags that is NOT a takeback is a contradiction the
     * screen should show rather than absorb.
     */
    add(
      'TAKEBACK_ACKNOWLEDGED',
      recoup,
      recoup
        ? `This is a takeback — confirmed by typing ${formatRecoupmentTotal(
            payment ? payment.paidCents : claim.totalPaidCents
          )}`
        : `carries ${takebackClaimed.join(', ') || 'reversal flags'} but is not a takeback`
    );

    /*
     * ── THE LANE THE EVIDENCE WAS GATHERED ON ────────────────────────────────
     *
     * `NO_BLOCKING_PREFLIGHT` and `LINES_PAIRED` below both read the snapshot,
     * and the snapshot answers ONE of two opposite questions. Asserted here,
     * before either of them speaks, so a biller reading three red checks is
     * told the one thing that fixes all three.
     *
     * `snapshot.takeback !== true` rather than `=== false`: a v2 snapshot
     * written before the field existed carries no lane, and it really was taken
     * for a payment.
     */
    add(
      'MATCH_TAKEN_FOR_A_TAKEBACK',
      Boolean(snapshot) && snapshot.takeback === true,
      !snapshot
        ? 'no match record stored'
        : snapshot.takeback === true
          ? null
          : 'the stored match looked for a line to pay, not the paid line this reverses'
    );
  }

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
  const odBlockers = candidate ? (candidate.blockers || []).filter((b) => b.blocking) : [];
  add(
    // `candidate !== null` is re-asserted rather than inferred from
    // `snapshotUsable`: this is the check whose empty list is dangerous, and it
    // should not depend on another condition remembering to require it.
    'NO_BLOCKING_PREFLIGHT',
    snapshotUsable && candidate !== null && odBlockers.length === 0,
    !candidate
      ? 'cannot be checked — the confirmed claim is not in the match record'
      : !snapshotUsable
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
   * ALREADY PLANNED SOMEWHERE ELSE — F1, and it used to be a 500.
   *
   * Nothing makes `(office_id, od_claim_num)` unique across `rcm_claims`:
   * `confirmMatch` guards only its own row, and a re-uploaded EOB that slipped
   * the dedupe produces a second batch with a second set of claims. Two claims
   * can therefore be confirmed to one Open Dental claim, and their line pairing
   * resolves to the same ClaimProcNums.
   *
   * The partial unique index then refused the second approve with a raw 23505,
   * which `h()` turned into INTERNAL_ERROR — after the gate had already told the
   * biller the claim was postable. A constraint doing its job must not surface
   * as a crash: it is a refusal, and it belongs on the checklist BEFORE the
   * button, like every other one.
   *
   * The database remains the guarantee — `approveRemittance` still translates a
   * 23505 it loses a race to (see there). This is what makes the common case
   * legible rather than what makes it safe.
   */
  /*
   * ...AND THE THIRD PLACE THIS LESSON LANDED (walk 3, 2026-08-30).
   *
   * On the REVERSAL lane the question inverts, exactly as the pre-flight
   * blockers and the line pairing did in #121. A line on a POSTED plan is not
   * spoken for against a takeback - that plan is where the money being reversed
   * CAME FROM. See `PLAN_STATUSES_RELEASED_FOR_REVERSAL`.
   *
   * Gated on `recoupmentAllowed && recoup`, not on either alone: this relaxes
   * only when the recoupment approve is being evaluated AND the claim really is
   * a takeback. A claim that is not one already fails `TAKEBACK_ACKNOWLEDGED`,
   * so it can never reach a chart through this door.
   */
  const reversalLane = recoupmentAllowed && recoup;
  const conflicts = [];
  if (claim.postingQueueId == null) {
    for (const line of lines) {
      const planned = line.odClaimProcNum == null ? null : plannedClaimprocs.get(Number(line.odClaimProcNum));
      if (!planned || planned.claimId === claim.claimId) continue;
      /*
       * The status is consulted ONLY on the reversal lane. On the payment lane
       * any other plan holding the line is a conflict, which is the rule this
       * check has always enforced and still does.
       */
      if (reversalLane && PLAN_STATUSES_RELEASED_FOR_REVERSAL.includes(String(planned.status))) {
        continue;
      }
      /*
       * The status is NAMED in the refusal. "Already on a posting plan" sent a
       * biller looking for a plan she could release; "already on a posting plan
       * (approved)" tells her which one, and that releasing it is possible.
       */
      conflicts.push(
        planned.status
          ? `ClaimProcNum ${line.odClaimProcNum} (${planned.status})`
          : `ClaimProcNum ${line.odClaimProcNum}`
      );
    }
  }
  add(
    'CLAIMPROC_NOT_ALREADY_PLANNED',
    conflicts.length === 0,
    conflicts.length ? `${conflicts.join(', ')} already on a posting plan` : null
  );

  /*
   * ── STAGE B1: THE PATIENT'S NUMBER ────────────────────────────────────────
   *
   * The same verdict the workbench prints, from the same function, over the same
   * rows. `register: 'projection'` because nothing has posted: this check runs
   * BEFORE any Open Dental write, so it can only ever be holding a projection,
   * and the confirmed register belongs to the drain's read-back.
   *
   * The Open Dental fee deltas come from the CONFIRMED match snapshot's
   * `linePairs` — where our billed figure and the chart's were already compared
   * — so this reads no chart and makes no call, exactly like every other
   * condition in this file.
   *
   * AMBER passes and RED refuses. `verdict` is carried out on the result so the
   * screen renders the gate's own numbers rather than a second computation of
   * them.
   */
  const verdict = lineDecisions.verdictFor({
    register: 'projection',
    lines: lines.map((l) => ({
      lineId: l.lineId,
      code: l.code,
      billedCents: l.billedCents,
      allowedCents: l.allowedCents,
      paidCents: l.paidCents,
      decision: l.decision,
      decisionReason: l.decisionReason,
      // The display name the loader resolved; the raw key is still on the line
      // for the INSERT, which stores a key and not a name.
      decidedBy: l.decidedBy || null,
      decidedAt: l.decidedAt,
      odClaimProcNum: l.odClaimProcNum,
      odFeeDeltaCents: feeDeltas.has(l.lineId) ? feeDeltas.get(l.lineId) : null,
    })),
  });
  /*
   * AND A TAKEBACK MAY NOT CARRY AN OFFICE WRITE-OFF.
   *
   * The two are opposite operations on the same money: an office write-off says
   * "the practice absorbs what the patient would owe", and a takeback is the
   * carrier removing what it already paid. The recoupment INSERT writes
   * supplemental lines and has nowhere to put a decided write-off, so a claim
   * carrying one would have its decision SILENTLY DROPPED at approve — a screen
   * showing a write-off, a chart that never receives it, and nothing recording
   * the difference.
   *
   * Refused rather than dropped, and the reason says which of the two to undo.
   * On the ordinary lane this is false and the verdict decides alone.
   */
  const writeOffOnTakeback = reversalLane && verdict.decidedWriteOffCents !== 0;

  add(
    'PATIENT_RESPONSIBILITY_MATCHES',
    verdict.state !== 'red' && !writeOffOnTakeback,
    writeOffOnTakeback
      ? 'this claim is a takeback and one of its lines is written off — a takeback cannot carry an office write-off; clear the write-off, or approve it as an ordinary payment'
      : verdict.state === 'red'
        ? verdict.sentence
        : verdict.state === 'amber'
          ? verdict.decisions
              .map(
                (d) =>
                  `${d.code} ${lineDecisions.formatDollars(d.amountCents)} — ` +
                  `${d.reasonLabel || d.reason} (${d.decidedBy || 'unattributed'})`
              )
              .join('; ')
          : null
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
    /**
     * The verdict this claim's checklist was judged on, carried out whole.
     *
     * The panel renders `verdict.sentence` rather than re-deriving it, which is
     * what makes the checklist row and the verdict line above it the same
     * statement rather than two that agree today.
     */
    verdict,
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
              /*
               * THE SNAPSHOT OF THE DECISION (Stage B1, D-14).
               *
               * Frozen onto the posting at the instant of approval, SEPARATE
               * from the contractual figure beside it. The drain reads THIS and
               * never the review row: the review may have moved on, and posting
               * figures nobody approved is the worst failure this module has.
               *
               * `null` — not zero — when no office write-off was decided. The
               * database CHECK insists the three move together.
               */
              decidedWriteOffCents:
                l.decision === 'office_writeoff'
                  ? lineDecisions.lineMoney(l).patientRemainderCents
                  : null,
              decidedReason: l.decision === 'office_writeoff' ? l.decisionReason : null,
              decidedByKey: l.decision === 'office_writeoff' ? l.decidedByKey : null,
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
 * @param {Map<number, { claimId: string, queueId: string }>} [input.plannedClaimprocs]
 * @returns {{ claims: ReturnType<typeof evaluateClaim>[], postable: object[], withheld: object[],
 *             alreadyQueued: object[], batchBalanced: boolean, batchDifferenceCents: number }}
 */
function evaluateRemittance({
  office,
  batch,
  claims,
  linesByClaim,
  paymentsByClaim,
  plannedClaimprocs = new Map(),
  recoupmentAllowed = false,
}) {
  const evaluated = claims.map((claim) =>
    evaluateClaim({
      office,
      claim,
      lines: linesByClaim.get(claim.claimId) || [],
      payment: paymentsByClaim.get(claim.claimId) || null,
      batchFlags: batch.flags,
      plannedClaimprocs,
      recoupmentAllowed,
    })
  );

  /*
   * AND A COLLISION WITHIN THIS ONE APPROVE.
   *
   * `CLAIMPROC_NOT_ALREADY_PLANNED` consults plans that already EXIST, which is
   * everything the per-claim pass can know. It cannot see the other claims in
   * the same press — and two claims on one remittance confirmed to the same Open
   * Dental claim pair to the same ClaimProcNums, so the first insert succeeded
   * and the second hit the index. The refusal was correct and read as a race
   * ("somebody else was writing"), which is a confusing thing to tell somebody
   * who pressed the button once.
   *
   * So the postable set is checked against ITSELF, in the batch's own order.
   * The first claim to claim a ClaimProcNum keeps it; the later one is withheld
   * with the same named condition. Which of two duplicates wins is arbitrary —
   * that they cannot BOTH post the same chart line is not.
   */
  const claimedHere = new Map();
  for (const evaluation of evaluated) {
    if (!evaluation.postable || !evaluation.intent) continue;
    const collisions = [];
    for (const line of evaluation.intent.lines) {
      const owner = claimedHere.get(line.odClaimProcNum);
      if (owner && owner !== evaluation.claimId) collisions.push(`ClaimProcNum ${line.odClaimProcNum}`);
    }
    if (collisions.length > 0) {
      const check = evaluation.checks.find((c) => c.code === 'CLAIMPROC_NOT_ALREADY_PLANNED');
      check.passed = false;
      check.detail = `${collisions.join(', ')} is also on another claim in this same remittance`;
      evaluation.failed = evaluation.checks.filter((c) => !c.passed).map((c) => c.code);
      evaluation.postable = false;
      evaluation.intent = null;
      continue;
    }
    for (const line of evaluation.intent.lines) claimedHere.set(line.odClaimProcNum, evaluation.claimId);
  }

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
    // Recomputed AFTER the self-collision pass above, not before it.
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

/**
 * A claim the batch names but that belongs to ANOTHER PRACTICE.
 *
 * It has to be judged — silently dropping it is what hid the mismatch behind an
 * unexplained `REMITTANCE_UNBALANCED` — but it must not be RENDERED. This office
 * has no business seeing the other practice's patient on its own screen, so the
 * name is replaced before the row leaves the loader and every amount is dropped:
 * the only fact anybody needs is which claim, and that it is not ours.
 *
 * @param {Record<string, unknown>} row
 */
function toForeignClaim(row) {
  return {
    claimId: row.claim_id,
    officeId: row.office_id,
    claimNumber: row.claim_number,
    patientName: "(a claim belonging to another practice)",
    odClaimNum: null,
    odMatchStatus: 'not_run',
    matchSnapshot: null,
    reviewedAt: null,
    needsReviewReasons: [],
    totalPaidCents: 0,
    patientBalanceCents: 0,
    postingQueueId: null,
    approvedAt: null,
    approvedByKey: null,
  };
}

/** @param {Record<string, unknown>} row */
function toApprovalLine(row) {
  return {
    lineId: row.line_id,
    position: num(row.position),
    /** The ADA code, for a verdict that names the line a biller can find. */
    code: row.billed_code || row.code || '',
    /*
     * BILLED AND ALLOWED, for Stage B1's patient-responsibility check. The gate
     * did not need them before: every earlier condition is about what was PAID.
     * The patient's remainder is allowed − paid, and there is nowhere else to
     * get it from.
     */
    billedCents: num(row.billed_cents),
    allowedCents: num(row.allowed_cents),
    paidCents: num(row.paid_cents),
    writeOffCents: num(row.write_off_cents),
    deductibleCents: num(row.deductible_cents),
    flags: Array.isArray(row.flags) ? row.flags : [],
    odClaimProcNum: row.od_claim_proc_num == null ? null : num(row.od_claim_proc_num),
    /** The biller's decision about this line's patient remainder (Stage B1). */
    decision: row.line_decision || null,
    decisionReason: row.decision_reason || null,
    decidedByKey: row.decided_by || null,
    decidedAt: iso(row.decided_at),
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
    return {
      batch,
      claims: [],
      linesByClaim: new Map(),
      paymentsByClaim,
      plannedClaimprocs: new Map(),
    };
  }

  /*
   * BY CLAIM ID, NOT BY OFFICE — and that is the F3 fix.
   *
   * Every other read in this module filters on `office_id` so a foreign row is
   * a MISS rather than a refusal somebody had to remember. Here that idiom was
   * wrong: the claim ids come from THIS office's batch links, and a claim among
   * them stamped with the other practice is a defect this gate exists to catch.
   * Filtering it out made `OFFICE_CONSISTENT` unreachable and turned a nameable
   * mismatch into an unexplained unbalanced total.
   *
   * The office boundary is not weakened — nothing is served. A foreign row is
   * redacted by `toForeignClaim` on the way out and can only ever be withheld.
   */
  const claims = await client.query(
    `SELECT ${APPROVAL_CLAIM_COLUMNS} FROM rcm_claims ` +
      `WHERE claim_id = ANY($1::uuid[])` +
      (lock ? ' FOR UPDATE' : ''),
    [claimIds]
  );
  const byId = new Map(
    claims.rows.map((r) => [r.claim_id, r.office_id === office ? toApprovalClaim(r) : toForeignClaim(r)])
  );

  const lines = await client.query(
    `SELECT ${LINE_COLUMNS} FROM rcm_procedure_lines ` +
      `WHERE office_id = $1 AND claim_id = ANY($2::uuid[]) ORDER BY position ASC`,
    [office, claimIds]
  );
  /** @type {Map<string, object[]>} */
  const linesByClaim = new Map();
  /*
   * WHO DECIDED, BY NAME — resolved HERE, not left as a crosswalk key.
   *
   * The claim read resolves these before it builds a verdict, and the gate
   * builds a verdict from the same function. If only one of them resolved,
   * "one function, two renderers" would hold for the money and quietly fail for
   * the attribution: the workbench would name a person and the checklist beside
   * it would print `user-1`. A test asserts the two sentences match, and it
   * caught exactly that.
   *
   * One statement for the whole remittance, and only when a line actually
   * carries a decision.
   */
  const decidedKeys = lines.rows.map((r) => r.decided_by).filter(Boolean);
  const decidedActors = decidedKeys.length ? await describeActors(client, decidedKeys) : {};

  for (const row of lines.rows) {
    if (!linesByClaim.has(row.claim_id)) linesByClaim.set(row.claim_id, []);
    const line = toApprovalLine(row);
    linesByClaim.get(row.claim_id).push({
      ...line,
      decidedBy: line.decidedByKey
        ? (decidedActors[line.decidedByKey] || {}).displayName || line.decidedByKey
        : null,
    });
  }

  /*
   * WHICH OF THESE CLAIMPROCS ARE ALREADY ON A PLAN — F1's pre-check.
   *
   * One query for the whole remittance, over the exact set of ClaimProcNums it
   * would touch. `is_supplemental = false` mirrors the partial unique index's
   * own predicate, so the check and the constraint agree about what collides.
   */
  const claimProcNums = [
    ...new Set(
      [...linesByClaim.values()]
        .flat()
        .map((l) => l.odClaimProcNum)
        .filter((n) => n != null)
    ),
  ];
  /** @type {Map<number, { claimId: string, queueId: string, status: string|null }>} */
  const plannedClaimprocs = new Map();
  if (claimProcNums.length > 0) {
    const planned = await client.query(
      `SELECT od_claim_proc_num, claim_id, queue_id FROM rcm_posting_queue_line ` +
        `WHERE office_id = $1 AND is_supplemental = false AND od_claim_proc_num = ANY($2::bigint[])`,
      [office, claimProcNums]
    );

    /*
     * THE HOLDING PLAN'S STATUS, in a SECOND query rather than a join.
     *
     * The reversal partition needs to know whether the plan holding a line has
     * finished. Two office-scoped reads rather than one join: every other read
     * in this loader is shaped that way, and a join would be the only one in the
     * module.
     */
    const queueIds = [...new Set(planned.rows.map((r) => String(r.queue_id)).filter(Boolean))];
    const statusByQueueId = new Map();
    if (queueIds.length > 0) {
      const plans = await client.query(
        `SELECT queue_id, status FROM rcm_posting_queue ` +
          `WHERE office_id = $1 AND queue_id = ANY($2::uuid[])`,
        [office, queueIds]
      );
      for (const row of plans.rows) statusByQueueId.set(String(row.queue_id), String(row.status));
    }

    for (const row of planned.rows) {
      plannedClaimprocs.set(num(row.od_claim_proc_num), {
        claimId: row.claim_id,
        queueId: row.queue_id,
        /*
         * `null` when the plan row cannot be read - and `null` is NOT in
         * `PLAN_STATUSES_RELEASED_FOR_REVERSAL`, so an unreadable plan keeps
         * holding its line on both lanes. Fail closed.
         */
        status: statusByQueueId.get(String(row.queue_id)) || null,
      });
    }
  }

  // Ordered by the batch's own positions, so the checklist reads in the order
  // the remittance lists its claims.
  const ordered = claimIds.map((id) => byId.get(id)).filter(Boolean);
  return { batch, claims: ordered, linesByClaim, paymentsByClaim, plannedClaimprocs };
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
 * Record that a human pressed Approve on this remittance, whatever came of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN TRANSACTION
 * ─────────────────────────────────────────────────────────────────────────────
 * The case that needs it most is the one that ROLLED BACK. A wholly-refused
 * approve leaves no queue row, and `claims_withheld` fired only when a queue row
 * existed — so a biller who pressed Approve, was told "nothing here can be
 * posted, and here is why", and went back to the list found the remittance GONE
 * from the needs-attention view. Silence at the exact moment somebody was told
 * they owed work.
 *
 * So the stamp is written on its own connection, after the gate's transaction
 * has finished one way or the other. It is BEST EFFORT: failing to record an
 * attempt must not turn a clean refusal into a 500, and must not undo a
 * successful enqueue that has already committed. A missing stamp costs a
 * worklist chip; a rolled-back approval would cost the biller their work.
 *
 * @param {import('express').Request} req
 * @param {string} office
 * @param {string} batchId
 * @param {{ email: string, displayName?: string }} actor
 * @returns {Promise<void>}
 */
async function recordApprovalAttempt(req, office, batchId, actor) {
  try {
    await tenantDb.withTenantDb(req, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // D-5, on this connection so the FK below sees the row.
        const userKey = await resolveRcmActor(client, actor);
        await client.query(
          `UPDATE rcm_payment_batches SET approval_attempted_at = now(), ` +
            `approval_attempted_by = $3, updated_at = now() ` +
            `WHERE office_id = $1 AND batch_id = $2`,
          [office, batchId, userKey]
        );
        await client.query('COMMIT');
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
  } catch (err) {
    console.error(
      `[rcm] could not record the approval attempt on ${batchId}:`,
      (err && err.message) || err
    );
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
  /*
   * THE ATTEMPT IS RECORDED WHATEVER HAPPENED — including, and especially, a
   * refusal that rolled everything else back. See recordApprovalAttempt.
   *
   * Recorded on the way OUT of both paths rather than in a `finally`, because
   * one exit must not be stamped: a remittance that does not exist for this
   * office has no row to stamp and no worklist entry to keep, and upserting a
   * user-map row for somebody probing ids would be a write with no purpose.
   * Everything else IS stamped, including a partial approve — that remittance
   * still has withheld claims, and a human still owes them an action.
   */
  let result;
  try {
    result = await runApproval(req, office, batchId, actor);
  } catch (err) {
    if (!(err instanceof ApprovalError && err.code === 'REMITTANCE_NOT_FOUND')) {
      await recordApprovalAttempt(req, office, batchId, actor);
    }
    throw err;
  }
  await recordApprovalAttempt(req, office, batchId, actor);
  return result;
}


// ─── D-6: the typed confirmation (6d) ────────────────────────────────────────

/**
 * The two ways a takeback can be written, and the words the API accepts.
 *
 * `adjustment` is the DEFAULT the dialog pre-selects and the one a cautious
 * biller should take. `supplemental` is G10 — the single irreversible Open
 * Dental operation — and is opt-in only.
 */
const RECOUPMENT_PATHS = Object.freeze(['adjustment', 'supplemental']);

/**
 * What a takeback's total looks like ON THE SCREEN, and therefore exactly what
 * the approver has to type.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STRING IS THE CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 * D-6's friction is that a person reads a number and types it back. That only
 * works if the number they read and the number the server expects are produced
 * by ONE function — otherwise the dialog shows `-54.08`, the server wants
 * `-54.8`, and the approver is stuck typing a phrase the screen never displayed.
 * So this is the single formatter, it is exported, and the client renders the
 * value the server sent rather than formatting cents itself.
 *
 * Always signed, always two decimals, no thousands separators and no currency
 * symbol: every one of those is a place where a locale, a font or a habit could
 * make two people disagree about what "as displayed" meant.
 *
 * @param {number} cents
 * @returns {string}
 */
function formatRecoupmentTotal(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Does what the approver typed match what this remittance actually moves?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SERVER COMPUTES THE NUMBER. THE CLIENT ONLY CARRIES A STRING.
 * ─────────────────────────────────────────────────────────────────────────────
 * The expected value is derived here from the claim rows, never taken from the
 * request. A request that could name its own expected total would be a
 * confirmation dialog that confirms whatever it is told, which is not a gate at
 * all — the same reasoning that keeps `office_id` in a send-to-TC body an
 * assertion that can only cause a refusal.
 *
 * COMPARISON IS EXACT AFTER TRIM, and deliberately not "parse both and compare
 * numbers". Parsing would accept `-54.080`, `-54.8`, `(54.08)` and `- 54.08` as
 * the same answer — and the whole point of the ceremony is that the approver
 * looked at a specific number and reproduced it. Surrounding whitespace is
 * forgiven because it is invisible on a screen and carries no meaning; nothing
 * else is.
 *
 * @param {string|unknown} typed what the approver sent
 * @param {number} expectedCents what the server computed
 * @returns {{ ok: boolean, expected: string, typed: string }}
 */
function checkTypedRecoupmentTotal(typed, expectedCents) {
  const expected = formatRecoupmentTotal(expectedCents);
  const given = typeof typed === 'string' ? typed.trim() : '';
  return { ok: given.length > 0 && given === expected, expected, typed: given };
}

/**
 * The recoupment total for a loaded remittance, in cents.
 *
 * Summed over the claims that ARE takebacks, from the batch's own claim-payment
 * rows where it has them and the claim's paid total otherwise — the same two
 * places `isRecoupment` reads, so a claim that counts as a takeback for the gate
 * counts in the number the approver types.
 *
 * @param {{ claims: ReadonlyArray<object>, paymentsByClaim: Map<string, {paidCents:number}> }} loaded
 * @returns {{ totalCents: number, claimIds: string[] }}
 */
function recoupmentTotal(loaded) {
  let totalCents = 0;
  const claimIds = [];
  for (const claim of loaded.claims) {
    const payment = loaded.paymentsByClaim.get(claim.claimId) || null;
    if (!isRecoupment(claim, payment)) continue;
    claimIds.push(claim.claimId);
    totalCents += payment ? Number(payment.paidCents) : Number(claim.totalPaidCents);
  }
  return { totalCents, claimIds };
}

/**
 * The approval itself. Separated from `approveRemittance` only so the attempt
 * stamp above can wrap every exit path without indenting the whole body.
 *
 * @param {import('express').Request} req
 * @param {string} office
 * @param {string} batchId
 * @param {{ email: string, displayName?: string }} actor
 * @returns {Promise<object>}
 */
async function runApproval(req, office, batchId, actor) {
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
      /*
       * `carrier_eob_date` IS POPULATED HERE, from the batch's deposit date.
       *
       * Open Dental's `DateCP` is not writable — `PUT` returns 200 and ignores
       * the write (G2) — so the carrier's own adjudication date has nowhere to
       * live in the chart and lives on the plan instead. 6c puts it in the note.
       * Leaving the column NULL would have made that note say nothing, which is
       * the failure G2 exists to stop the module pretending its way past.
       *
       * The deposit date is the closest thing an 835 gives us: for an EFT it is
       * BPR16, for a check it is what the parser read off the remittance. Null
       * when the file carried neither, which the note then omits rather than
       * inventing.
       */
      const inserted = await client.query(
        `INSERT INTO rcm_posting_queue ` +
          `(office_id, batch_id, remittance_key, status, is_recoupment, carrier_eob_date, ` +
          `intended_total_cents, posted_total_cents, approved_by) ` +
          `VALUES ($1, $2, $3, 'approved', false, $4, 0, 0, $5) ` +
          `ON CONFLICT (office_id, remittance_key) DO NOTHING RETURNING queue_id`,
        [office, loaded.batch.batchId, remittanceKey, loaded.batch.depositDate, approvedBy]
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
         * Adding lines to a plan the drain has already walked would mean a claim
         * whose money the drain never saw.
         *
         * ── TWO REFUSALS, BECAUSE THEY ARE TWO DIFFERENT FACTS (6c) ───────────
         *
         * Until 6c there was one sentence — *"a posting run is already under
         * way"* — and the day the drain shipped, that sentence became FALSE for
         * most of the statuses that reach here. A plan that is `posted` is not
         * under way; it has finished. Telling a biller to wait for something that
         * already ended is the honest-states rule failing in the message rather
         * than in the column, and it hid the real consequence underneath.
         *
         * That consequence is worth saying plainly: `rcm_posting_queue` is unique
         * on `(office_id, remittance_key)`, so a remittance gets exactly ONE
         * plan, ever. A claim withheld at approval and fixed AFTER its
         * remittance's plan has drained therefore has nowhere to go — it cannot
         * post through CareIN at all, and the money goes in by hand in Open
         * Dental until a later slice adds a follow-on plan. See
         * docs/RCM_POSTING.md §15.
         */
        const existingStatus = String(existing.rows[0].status);
        if (TERMINAL_QUEUE_STATUSES.includes(existingStatus)) {
          await client.query('ROLLBACK');
          throw new ApprovalError(
            'QUEUE_ALREADY_RAN',
            409,
            alreadyRanMessage(existingStatus),
            { queueStatus: existingStatus }
          );
        }
        if (existingStatus !== 'approved') {
          await client.query('ROLLBACK');
          throw new ApprovalError(
            'QUEUE_ALREADY_RUNNING',
            409,
            'A posting run for this remittance is already under way — it cannot take more claims.',
            { queueStatus: existingStatus }
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
          try {
            await client.query(
              `INSERT INTO rcm_posting_queue_line ` +
                `(queue_id, office_id, position, od_claim_proc_num, od_claim_num, claim_id, ` +
                `batch_claim_payment_id, intended_ins_pay_amt_cents, intended_write_off_cents, ` +
                `intended_ded_applied_cents, decided_write_off_cents, decided_reason, ` +
                `decided_by, is_supplemental, status) ` +
                `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, 'pending')`,
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
                /*
                 * D-14, AS THREE COLUMNS. The office's own write-off, its
                 * reason and who decided it, frozen at the instant of approval
                 * and never read from the review row afterwards.
                 */
                line.decidedWriteOffCents,
                line.decidedReason,
                line.decidedByKey,
              ]
            );
          } catch (err) {
            // The database is the guarantee; this is what makes losing to it
            // legible. See asClaimprocConflict.
            const conflict = asClaimprocConflict(err, claim);
            if (!conflict) throw err;
            await client.query('ROLLBACK');
            throw conflict;
          }
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
        `SELECT COALESCE(SUM(intended_ins_pay_amt_cents), 0)::bigint AS total, ` +
          `COUNT(*) FILTER (WHERE is_supplemental = false)::int AS ordinary ` +
          `FROM rcm_posting_queue_line WHERE office_id = $1 AND queue_id = $2`,
        [office, queueId]
      );
      const writtenTotal = num(written.rows[0] && written.rows[0].total);
      /*
       * `requires_check` — DOES THIS PLAN OWE THE PRACTICE A CHECK?
       *
       * Derived from the LINES ACTUALLY WRITTEN, in the same statement as the
       * total and by the same rule the drain uses: true when at least one
       * ordinary (non-supplemental) line is on the plan.
       *
       * NOT `is_recoupment`. A MIXED plan — ordinary claims approved here, a
       * takeback appended by the recoupment path — is a recoupment AND owes a
       * check, and the database's `posted` proof turns on this column. Getting
       * it from the flag would let that plan claim `posted` with no check
       * number.
       */
      const requiresCheck = num(written.rows[0] && written.rows[0].ordinary) > 0;

      await client.query(
        `UPDATE rcm_posting_queue SET intended_total_cents = $3, requires_check = $4, ` +
          `updated_at = now() WHERE office_id = $1 AND queue_id = $2`,
        [office, queueId, writtenTotal, requiresCheck]
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
 * What a takeback approve WOULD do — including the exact phrase to type.
 *
 * The dialog renders `typedTotalExpected` verbatim. It is not a hint and the
 * client must not re-derive it from cents: `formatRecoupmentTotal` is the single
 * formatter precisely so the number a person reads and the number the server
 * will demand cannot drift apart.
 *
 * @param {import('express').Request} req
 * @param {string} office
 * @param {string} batchId
 * @returns {Promise<null|object>}
 */
async function previewRecoupment(req, office, batchId) {
  const loaded = await tenantDb.withTenantDb(req, (pool) => loadForApproval(pool, office, batchId));
  if (!loaded) return null;

  const { totalCents, claimIds } = recoupmentTotal(loaded);
  const verdict = evaluateRemittance({ office, ...loaded, recoupmentAllowed: true });

  return {
    batch: loaded.batch,
    ...verdict,
    /** How many claims on this remittance are takebacks. Zero is a real answer. */
    recoupmentClaims: claimIds.length,
    recoupmentTotalCents: totalCents,
    /** THE STRING. Exactly what must be typed back. */
    typedTotalExpected: formatRecoupmentTotal(totalCents),
    paths: RECOUPMENT_PATHS,
    /**
     * The dialog's pre-selection, stated by the server so a client cannot
     * quietly default to the irreversible one. D-6: the adjustment is the
     * default and the supplemental is the opt-in.
     */
    defaultPath: 'adjustment',
  };
}

/**
 * Approve a takeback. D-6's gate, and the only way `is_recoupment` becomes true.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CONFIRMATION IS VALIDATED HERE, NOT IN THE DIALOG
 * ═════════════════════════════════════════════════════════════════════════════
 * A client-side confirm is a speed bump for the person who reads the code and no
 * obstacle at all to the request that skips it. So this function computes the
 * total from the claim rows, formats it with the same function the screen used,
 * and compares it to the string the approver sent. There is NO request shape
 * that reaches the enqueue without matching — no flag, no header, no
 * already-confirmed token.
 *
 * A mismatch REFUSES BEFORE ANYTHING IS WRITTEN. No queue row, no claim links,
 * and deliberately no approval-attempt stamp: an attempt stamp is how the
 * worklist remembers that a human owes this remittance an action, and somebody
 * mistyping a number has not changed what is owed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE PATH CHOICE MEANS
 * ─────────────────────────────────────────────────────────────────────────────
 * `adjustment`   `POST /adjustments` under the office's own "Insurance
 *                deductions from previous payments" type. Reversible — though
 *                by an OFFSETTING adjustment, because there is no
 *                `DELETE /adjustments` (G6). The default.
 * `supplemental` `POST /claimprocs/Supplemental`. G10: cannot be reverted,
 *                cannot be deleted, and permanently pins its claim and
 *                procedure. Recorded on every line so the drain executes what
 *                was authorised rather than re-deciding.
 *
 * @param {import('express').Request} req
 * @param {string} office
 * @param {string} batchId
 * @param {{ email: string, displayName?: string }} actor
 * @param {{ typedTotal: unknown, path: unknown }} confirmation
 * @returns {Promise<object>}
 */
async function approveRecoupment(req, office, batchId, actor, confirmation) {
  const path = String((confirmation && confirmation.path) || '').trim();
  if (!RECOUPMENT_PATHS.includes(path)) {
    throw new ApprovalError(
      'RECOUPMENT_PATH_INVALID',
      422,
      'Choose how this takeback is written: adjustment (reversible) or supplemental (permanent).',
      { paths: RECOUPMENT_PATHS }
    );
  }

  return tenantDb.withTenantDb(req, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const loaded = await loadForApproval(client, office, batchId, { lock: true });
      if (!loaded) {
        await client.query('ROLLBACK');
        throw new ApprovalError('REMITTANCE_NOT_FOUND', 404, 'No such remittance for this office');
      }

      const { totalCents, claimIds } = recoupmentTotal(loaded);
      if (claimIds.length === 0) {
        await client.query('ROLLBACK');
        throw new ApprovalError(
          'NOT_A_RECOUPMENT',
          409,
          'Nothing on this remittance is a takeback. Approve it normally.'
        );
      }

      /*
       * THE TYPED PHRASE, CHECKED BEFORE ANY OTHER WORK.
       *
       * First because a wrong phrase must cost nothing and record nothing — and
       * because doing it first makes it impossible for a later edit to
       * accidentally move a write above it.
       */
      const typed = checkTypedRecoupmentTotal(confirmation && confirmation.typedTotal, totalCents);
      if (!typed.ok) {
        await client.query('ROLLBACK');
        throw new ApprovalError(
          'RECOUPMENT_CONFIRM_MISMATCH',
          422,
          `That is not the amount this takeback moves. Type ${typed.expected} exactly as it is shown.`,
          {
            expected: typed.expected,
            recoupmentTotalCents: totalCents,
            recoupmentClaims: claimIds.length,
          }
        );
      }

      const verdict = evaluateRemittance({ office, ...loaded, recoupmentAllowed: true });

      // The batch's own arithmetic holds a takeback exactly as it holds an
      // ordinary approve. See evaluateRemittance.
      if (!verdict.batchBalanced) {
        await client.query('ROLLBACK');
        throw new ApprovalError(
          'REMITTANCE_UNBALANCED',
          409,
          'This remittance does not balance — the check total, its provider-level adjustments and the sum of its claim payments disagree. Nothing on it can be approved until they reconcile.',
          { differenceCents: verdict.batchDifferenceCents, claims: verdict.claims }
        );
      }

      if (verdict.postable.length === 0) {
        await client.query('ROLLBACK');
        throw new ApprovalError(
          'NOTHING_APPROVABLE',
          409,
          'The takeback on this remittance cannot be posted yet.',
          { claims: verdict.claims }
        );
      }

      const approvedBy = await resolveRcmActor(client, actor);
      const remittanceKey = await resolveRemittanceKey(client, office, loaded.batch);

      /*
       * ONE PLAN PER REMITTANCE, STILL — and `is_recoupment` is set on the way
       * in AND re-asserted on an existing plan.
       *
       * A MIXED remittance is real: nine clean claims approved through the
       * ordinary button created a plan with `is_recoupment = false`, and the
       * tenth is a takeback approved here. The same plan takes it, and the flag
       * flips true — which is what tells the drain this plan needs the
       * recoupment sequence and what lets it reach `posted` without a check for
       * the takeback part.
       */
      const inserted = await client.query(
        `INSERT INTO rcm_posting_queue ` +
          `(office_id, batch_id, remittance_key, status, is_recoupment, carrier_eob_date, ` +
          `intended_total_cents, posted_total_cents, approved_by) ` +
          `VALUES ($1, $2, $3, 'approved', true, $4, 0, 0, $5) ` +
          `ON CONFLICT (office_id, remittance_key) DO NOTHING RETURNING queue_id`,
        [office, loaded.batch.batchId, remittanceKey, loaded.batch.depositDate, approvedBy]
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
        const existingStatus = String(existing.rows[0].status);
        if (TERMINAL_QUEUE_STATUSES.includes(existingStatus)) {
          await client.query('ROLLBACK');
          throw new ApprovalError('QUEUE_ALREADY_RAN', 409, alreadyRanMessage(existingStatus), {
            queueStatus: existingStatus,
          });
        }
        if (existingStatus !== 'approved') {
          await client.query('ROLLBACK');
          throw new ApprovalError(
            'QUEUE_ALREADY_RUNNING',
            409,
            'A posting run for this remittance is already under way — it cannot take more claims.',
            { queueStatus: existingStatus }
          );
        }
        queueId = existing.rows[0].queue_id;
        await client.query(
          `UPDATE rcm_posting_queue SET is_recoupment = true, updated_at = now() ` +
            `WHERE office_id = $1 AND queue_id = $2`,
          [office, queueId]
        );
      }

      const positions = await client.query(
        `SELECT COUNT(*)::int AS n FROM rcm_posting_queue_line WHERE office_id = $1 AND queue_id = $2`,
        [office, queueId]
      );
      let position = num(positions.rows[0] && positions.rows[0].n);

      /** @type {Array<object>} */
      const queued = [];

      for (const claim of verdict.postable) {
        const linked = await client.query(
          `UPDATE rcm_claims SET posting_queue_id = $3, approved_at = now(), approved_by = $4, ` +
            `updated_at = now() ` +
            `WHERE office_id = $1 AND claim_id = $2 AND posting_queue_id IS NULL`,
          [office, claim.claimId, queueId, approvedBy]
        );
        if (linked.rowCount === 0) {
          await client.query('ROLLBACK');
          throw new ApprovalError(
            'CLAIM_ALREADY_QUEUED',
            409,
            'A claim on this remittance was approved by somebody else while this approval was being written. Nothing was queued; open the remittance again.'
          );
        }

        for (const line of claim.intent.lines) {
          position += 1;
          /*
           * `is_supplemental = true` ON EVERY RECOUPMENT LINE, whichever path
           * was chosen.
           *
           * The column is not "this is a supplemental claimproc" — it is which
           * side of the money guard the row sits on. The partial unique index
           * on `(office_id, od_claim_proc_num) WHERE is_supplemental = false`
           * exists because a takeback TARGETS an already-paid claimproc that a
           * previous plan legitimately posted. A recoupment line marked false
           * would collide with the very adjudication it is reversing.
           */
          await client.query(
            `INSERT INTO rcm_posting_queue_line ` +
              `(queue_id, office_id, position, od_claim_proc_num, od_claim_num, claim_id, ` +
              `batch_claim_payment_id, intended_ins_pay_amt_cents, intended_write_off_cents, ` +
              `intended_ded_applied_cents, is_supplemental, recoupment_path, status) ` +
              `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, 'pending')`,
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
              path,
            ]
          );
        }

        queued.push({
          claimId: claim.claimId,
          claimNumber: claim.claimNumber,
          patientName: claim.patientName,
          odClaimNum: claim.intent.odClaimNum,
          lines: claim.intent.lines.length,
          totalCents: claim.intent.totalCents,
        });
      }

      // Re-derived from the lines actually written, exactly like the ordinary
      // approve — a bug in the loop above fails here rather than shipping a plan
      // whose header disagrees with its own lines.
      const written = await client.query(
        `SELECT COALESCE(SUM(intended_ins_pay_amt_cents), 0)::bigint AS total, ` +
          `COUNT(*) FILTER (WHERE is_supplemental = false)::int AS ordinary ` +
          `FROM rcm_posting_queue_line WHERE office_id = $1 AND queue_id = $2`,
        [office, queueId]
      );
      const writtenTotal = num(written.rows[0] && written.rows[0].total);
      /*
       * `requires_check` — DOES THIS PLAN OWE THE PRACTICE A CHECK?
       *
       * Derived from the LINES ACTUALLY WRITTEN, in the same statement as the
       * total and by the same rule the drain uses: true when at least one
       * ordinary (non-supplemental) line is on the plan.
       *
       * NOT `is_recoupment`. A MIXED plan — ordinary claims approved here, a
       * takeback appended by the recoupment path — is a recoupment AND owes a
       * check, and the database's `posted` proof turns on this column. Getting
       * it from the flag would let that plan claim `posted` with no check
       * number.
       */
      const requiresCheck = num(written.rows[0] && written.rows[0].ordinary) > 0;

      await client.query(
        `UPDATE rcm_posting_queue SET intended_total_cents = $3, requires_check = $4, ` +
          `updated_at = now() WHERE office_id = $1 AND queue_id = $2`,
        [office, queueId, writtenTotal, requiresCheck]
      );

      await client.query('COMMIT');

      return {
        queueId,
        remittanceKey,
        approvedBy,
        recoupmentPath: path,
        recoupmentTotalCents: totalCents,
        typedTotal: typed.expected,
        intendedTotalCents: writtenTotal,
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

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

/**
 * Turn a lost race with the claimproc uniqueness into the refusal it is.
 *
 * `CLAIMPROC_NOT_ALREADY_PLANNED` catches the ordinary case on the checklist,
 * before anything is written. This is what happens when two approvals are in
 * flight at once and the pre-check on one connection could not see the other's
 * uncommitted line: the index refuses, and without this the refusal reached the
 * biller as `INTERNAL_ERROR` — a constraint doing exactly its job, presented as
 * a crash.
 *
 * Only the CLAIMPROC index is translated. Any other unique violation is a bug
 * we have not thought about, and dressing it as a tidy refusal would hide it.
 *
 * @param {unknown} err
 * @param {{ claimNumber: string, patientName: string }} claim
 * @returns {ApprovalError|null} null when this is not that error
 */
function asClaimprocConflict(err, claim) {
  const e = /** @type {{ code?: string, constraint?: string }} */ (err);
  if (!e || e.code !== UNIQUE_VIOLATION) return null;
  if (e.constraint && e.constraint !== 'rcm_posting_queue_line_claimproc_unique') return null;
  return new ApprovalError(
    'CLAIMPROC_ALREADY_PLANNED',
    409,
    `An Open Dental line on claim ${claim.claimNumber} was put on a posting plan by somebody else while this approval was being written. Nothing was queued; open the remittance again.`,
    { claimId: claim.claimId }
  );
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
  TERMINAL_QUEUE_STATUSES,
  PLAN_STATUSES_RELEASED_FOR_REVERSAL,
  alreadyRanMessage,
  APPROVAL_BATCH_COLUMNS,
  APPROVAL_CLAIM_COLUMNS,
  ApprovalError,
  isPatientResponsibilityOnly,
  isRecoupment,
  TAKEBACK_FLAGS,
  asClaimprocConflict,
  recordApprovalAttempt,
  evaluateClaim,
  looksApprovable,
  evaluateRemittance,
  loadForApproval,
  previewApproval,
  approveRemittance,
  RECOUPMENT_PATHS,
  formatRecoupmentTotal,
  checkTypedRecoupmentTotal,
  recoupmentTotal,
  previewRecoupment,
  approveRecoupment,
};
