'use strict';

/**
 * The match core — PURE. No I/O, no Open Dental, no database, no clock.
 *
 * Given one proposal claim (what a carrier's EOB or 835 said) and a list of
 * candidate Open Dental claims already fetched by the shell
 * (./odClaimReads.js), score and explain each candidate. That is all it does.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS FILE EXISTS TO OBEY
 * ─────────────────────────────────────────────────────────────────────────────
 * **No auto-match ever decides anything.** There is no `autoConfirm`, no
 * threshold above which a candidate is chosen, and no code path in this module
 * that returns "the" match. It returns candidates, ranked, each with the
 * evidence that produced its score — and when the top two are close it says
 * `ambiguous: true` rather than picking. Ambiguity is displayed, never
 * resolved (hard rule 4; the same stance callTwins.findTwin takes on the voice
 * side, where two matches are a refusal rather than a coin flip).
 *
 * A score is an argument, not a verdict. Everything a biller needs to disagree
 * with it is in `evidence[]`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MONEY IS INTEGER CENTS, AND THE TOLERANCES ARE STATED
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing here divides by 100 or touches a float. Two tolerances exist and both
 * are named constants with a reason:
 *
 *   AMOUNT_EXACT      0 cents. A billed total that agrees to the cent is the
 *                     strongest money evidence there is.
 *   AMOUNT_NEAR_CENTS 100 cents ($1.00). Chosen because Open Dental's `-1`
 *                     sentinel for "not calculated" produced exactly a
 *                     one-dollar error in the legacy COB calculator
 *                     (TC_OD_READS.md, trap 1) — a real, documented,
 *                     one-dollar-shaped disagreement. Wider than that and a
 *                     genuinely different claim starts scoring as near.
 *
 *   DATE_NEAR_DAYS    7 days. A carrier's reported service date and the chart's
 *                     can differ by a few days on a multi-visit claim; a week
 *                     is generous without spanning a recall interval.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELETED PROCEDURES ARE EXCLUDED FROM ALL AMOUNT MATH
 * ─────────────────────────────────────────────────────────────────────────────
 * `DELETE /procedurelogs` is a SOFT delete (RCM_OD_WRITES G12): a deleted
 * procedure comes back as `ProcStatus: "D"` and still appears in list reads.
 * The spike's own teardown counted "D" rows as live charges and over-applied a
 * reversal by $2.00. Every claimproc whose procedure reads "D" is dropped
 * before any total is computed here, and the count is reported so the screen
 * can say so rather than silently showing a smaller number.
 */

// ─── Tolerances ──────────────────────────────────────────────────────────────

/** Cents of slack that still counts as an exact money match. Zero, deliberately. */
const AMOUNT_EXACT_CENTS = 0;

/** $1.00 — the shape of the documented OD `-1` sentinel error. See the header. */
const AMOUNT_NEAR_CENTS = 100;

/** Days of slack on a service date before it stops being evidence. */
const DATE_NEAR_DAYS = 7;

/**
 * The score below which a candidate is NOT OFFERED AT ALL.
 *
 * Ranking without a floor means the worst candidate in a bad list is still
 * presented as a candidate. That is not theoretical: if Open Dental's name
 * filter is ever ignored, the read shell's client-side re-filter is what keeps
 * strangers out — and this is the second line of that defence. A claim that
 * matches on nothing but "the patient has some claims" scores at or below zero
 * once PATIENT_NAME_MISMATCH (−15) and CODES_ABSENT (−15) land, and a biller
 * should never be shown it next to a Confirm button.
 *
 * 15 is deliberately low: it is cleared by a surname match plus a near date, or
 * by matching codes alone. It excludes noise, not weak-but-real candidates —
 * the LOW band exists precisely for those.
 *
 * It is the WEAKER of the two guards. The sharper one is below: a candidate
 * whose patient name affirmatively DISAGREES with the chart is never offered at
 * any score, because that is the exact signature of the failure this defends
 * against — Open Dental returning strangers when a name filter is ignored.
 */
const MIN_CANDIDATE_SCORE = 15;

/**
 * Evidence that disqualifies a candidate outright, whatever else it scored.
 *
 * A claim whose patient shares NO name token with the remittance is not this
 * patient's claim. A same-day appointment and a coincidental fee could
 * otherwise lift a total stranger over a numeric floor — and the whole point of
 * the floor is that a stranger must never appear beside a Confirm button.
 *
 * IT APPLIES ONLY TO THE NAME-SEARCH LANE. When the biller has already LINKED
 * the patient, the candidates came from `?PatNum=` — that patient's own claims,
 * by construction — and the remedy above ("link the patient first") has already
 * been taken. A married-name change is then routine: `SMITH, J` on the
 * remittance against `JONES, JANE` on a correctly linked chart shares no token,
 * and disqualifying on it would report `no_candidate` for every claim on the
 * right patient. On that lane a name disagreement is EVIDENCE (it still costs
 * −15), not a wall.
 */
const DISQUALIFYING_TAGS = Object.freeze(['PATIENT_NAME_MISMATCH']);

/**
 * How close the runner-up may score before the result is called ambiguous.
 *
 * 10 points on a 100-point scale. Deliberately generous: the cost of saying
 * "these two look alike, you decide" is one extra glance, and the cost of not
 * saying it is money posted to the wrong patient's chart.
 */
const AMBIGUITY_MARGIN = 10;

// ─── Evidence vocabulary ─────────────────────────────────────────────────────

/**
 * Every tag this module can emit. A closed set, exported, so the UI's rendering
 * map is exhaustive by construction and a new signal is a compile-time problem
 * rather than a chip that renders as nothing.
 *
 * `weight` is the points the tag contributes. Negative weights are real
 * evidence too — "the amounts disagree" is information, not the absence of it.
 */
const EVIDENCE_TAGS = Object.freeze({
  CLAIM_NUMBER_MATCH: {
    weight: 35,
    label: 'Claim number matches',
    detail: "The carrier's claim number is this Open Dental ClaimNum.",
  },
  PATIENT_NAME_MATCH: {
    weight: 20,
    label: 'Patient name matches',
    detail: 'First and last name both match the chart.',
  },
  PATIENT_NAME_PARTIAL: {
    weight: 10,
    label: 'Surname matches',
    detail: 'Last name matches; the first name does not, or was not reported.',
  },
  PATIENT_NAME_MISMATCH: {
    weight: -15,
    label: 'Patient name differs',
    detail: 'Neither name on the remittance matches this chart.',
  },
  SERVICE_DATE_MATCH: {
    weight: 15,
    label: 'Service date matches',
    detail: 'Same date of service.',
  },
  SERVICE_DATE_NEAR: {
    weight: 7,
    label: `Service date within ${DATE_NEAR_DAYS} days`,
    detail: 'Close, but not the same day.',
  },
  SERVICE_DATE_MISMATCH: {
    weight: -10,
    label: 'Service date differs',
    detail: `More than ${DATE_NEAR_DAYS} days apart.`,
  },
  CODES_ALL_PRESENT: {
    weight: 20,
    label: 'All procedure codes present',
    detail: 'Every code on the remittance appears on this claim.',
  },
  CODES_PARTIAL: {
    weight: 10,
    label: 'Some procedure codes present',
    detail: 'At least half the codes on the remittance appear on this claim.',
  },
  CODES_ABSENT: {
    weight: -15,
    label: 'Procedure codes do not appear',
    detail: 'None of the remittance codes are on this claim.',
  },
  BILLED_AMOUNT_MATCH: {
    weight: 10,
    label: 'Billed total matches',
    detail: 'Billed to the cent.',
  },
  BILLED_AMOUNT_NEAR: {
    weight: 5,
    label: 'Billed total within $1.00',
    detail: 'Within the tolerance Open Dental’s "not calculated" sentinel produces.',
  },
  BILLED_AMOUNT_MISMATCH: {
    weight: -10,
    label: 'Billed total differs',
    detail: 'The remittance and the chart disagree on what was billed.',
  },
  LINE_COUNT_MATCH: {
    weight: 5,
    label: 'Same number of lines',
    detail: 'The claim has as many payable procedures as the remittance has lines.',
  },
});

/** The tag names, for exhaustiveness checks in tests and the UI. */
const EVIDENCE_TAG_NAMES = Object.freeze(Object.keys(EVIDENCE_TAGS));

/**
 * Pre-flight facts about a candidate that Slice 6c will REFUSE on.
 *
 * Surfaced here, at match time, so the biller sees the refusal before the
 * refusal — the alternative is confirming a match, approving it, and finding
 * out at drain time that Open Dental will not take it.
 *
 * `blocking: true` means 6c cannot post this line at all. `blocking: false`
 * means it is a caution the biller should read, not a wall.
 */
const OD_BLOCKERS = Object.freeze({
  CLAIM_ALREADY_RECEIVED: {
    blocking: false,
    label: 'Claim is already Received in Open Dental',
    detail:
      'ClaimStatus is "R". Posting again would be a second payment on a received claim, which is a supplemental, not a receive.',
  },
  LINE_HAS_CLAIM_PAYMENT: {
    blocking: true,
    label: 'A check is already attached to a line',
    detail:
      'Open Dental refuses to change InsPayAmt once a ClaimPayment is attached: "Cannot change InsPayAmt when Status is Received and attached to a ClaimPayment."',
  },
  LINE_IS_TRANSFER: {
    blocking: true,
    label: 'A line is an income transfer',
    detail: 'PUT /claimprocs is refused when IsTransfer is true.',
  },
  LINE_STATUS_BLOCKED: {
    blocking: true,
    label: 'A line has a status Open Dental will not update',
    detail:
      'PUT /claimprocs is refused for Adjustment, InsHist, CapClaim, CapComplete and CapEstimate lines.',
  },
  DELETED_PROCEDURES_EXCLUDED: {
    blocking: false,
    label: 'Deleted procedures excluded',
    detail:
      'DELETE /procedurelogs is a soft delete — a deleted procedure still appears in Open Dental list reads as ProcStatus "D". Those lines are left out of every total here.',
  },
  NO_PAYABLE_LINES: {
    blocking: true,
    label: 'No payable lines',
    detail: 'Every line on this claim is deleted, transferred, or in a blocked status.',
  },

  /*
   * ── THE TAKEBACK LANE ─────────────────────────────────────────────────────
   *
   * A takeback asks the OPPOSITE question of a payment, and until walk night 2
   * this file only knew how to ask one of them.
   *
   * A payment needs a line Open Dental will let us PUT money onto: not deleted,
   * not transferred, not a blocked status, and NOT already attached to a check
   * (`LINE_HAS_CLAIM_PAYMENT` — OD refuses `Cannot change InsPayAmt when Status
   * is Received and attached to a ClaimPayment`).
   *
   * A takeback needs the exact state that refusal describes. The line it
   * reverses must ALREADY be paid, and on a real reversal it is also already on
   * a check — because the money it is taking back is money this module posted.
   * Reading `LINE_HAS_CLAIM_PAYMENT` and `NO_PAYABLE_LINES` as blocking on that
   * lane made D-6's typed-confirmation path unreachable for the only chart state
   * a takeback can ever target: the one the drain itself just wrote.
   *
   * So the two codes below REPLACE those two on the takeback lane. They are not
   * a filter and nothing vanishes — the fact is still reported, by name, with
   * the opposite verdict, and the takeback lane grows two refusals of its own
   * that the payment lane has no use for.
   */

  /**
   * The precondition, reported rather than refused.
   *
   * Non-blocking on purpose: this is the state a takeback REQUIRES. It stays on
   * the list so the screen still shows a biller that the chart line carries a
   * check — which is the fact that makes the ordinary Approve button refuse, and
   * therefore the fact she needs in front of her when she reaches for the
   * takeback panel instead.
   */
  LINE_PAID_AND_ON_CHECK: {
    blocking: false,
    label: 'The payment this takeback reverses is on the chart',
    detail:
      'A line carries an insurance payment attached to a check. That is what a takeback ' +
      'reverses — and it is also why this claim cannot be approved through the ordinary ' +
      'button, which would try to change InsPayAmt on a line Open Dental has locked.',
  },
  /** The inverse of NO_PAYABLE_LINES: nothing here has been paid. */
  NO_REVERSIBLE_LINES: {
    blocking: true,
    label: 'No payment on this claim to take back',
    detail:
      'No live line on this claim carries an insurance payment. A takeback against a line ' +
      'the carrier never paid is not a reversal of anything — it would put money on a ' +
      'ledger nobody can account for.',
  },
  /** More coming back than ever went in. */
  TAKEBACK_EXCEEDS_PAYMENT: {
    blocking: true,
    label: 'The takeback is larger than the payment on the chart',
    detail:
      'The carrier is asking for more than Open Dental shows was paid on this claim. Either ' +
      'the remittance is not about these lines or part of the payment is somewhere else — ' +
      'posting it would leave the ledger short by the difference.',
  },
  DELETED_STATUS_UNKNOWN: {
    blocking: true,
    label: 'Cannot tell whether a line was deleted',
    detail:
      "Open Dental did not return the procedure behind this line, so we cannot check its ProcStatus. Because DELETE is a SOFT delete, a deleted procedure is indistinguishable from a live one without that row — so the line is excluded from every total here and cannot be posted until the read succeeds.",
  },
});

/**
 * claimproc.Status values `PUT /claimprocs/{n}` refuses, as the OD API spells
 * them — STRING enums, not the DB integers (docs/OD_API_CONTRACT.md §1).
 * Straight from RCM_OD_WRITES §2, "Blocking restrictions".
 */
const BLOCKED_CLAIMPROC_STATUSES = Object.freeze([
  'Adjustment',
  'InsHist',
  'CapClaim',
  'CapComplete',
  'CapEstimate',
]);

/** OD's soft-delete marker on a procedurelog row (G12). */
const DELETED_PROC_STATUS = 'D';

// ─── Normalizers ─────────────────────────────────────────────────────────────

/**
 * Uppercase alphanumerics only. Used for names and codes alike, because both
 * arrive punctuated in one system and not the other ("D0150" vs "AD:D0150",
 * "Fixture, Synthetic" vs "FIXTURE SYNTHETIC").
 * @param {unknown} value
 * @returns {string}
 */
function squash(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).toUpperCase().replace(/[^A-Z0-9]/g, '')
    : '';
}

/**
 * Name tokens, longest-first-ish order preserved, dropping single characters.
 *
 * Middle initials are dropped on purpose: an 835 carrying "SMITH JOHN Q" and a
 * chart carrying "Smith, John" describe the same person, and letting a middle
 * initial cost a name match would push real matches into MEDIUM for nothing.
 * @param {unknown} name
 * @returns {string[]}
 */
function nameTokens(name) {
  if (typeof name !== 'string') return [];
  return name
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((t) => t.length >= 2);
}

/**
 * A dental procedure code, stripped of the X12 qualifier the 835 carries.
 *
 * SVC01 arrives as `AD:D0150` — `AD` is the ADA code-list qualifier. Open
 * Dental stores `D0150`. Comparing the raw strings would find nothing.
 * @param {unknown} code
 * @returns {string}
 */
function procCode(code) {
  const s = squash(code);
  // A leading ADA qualifier, only when what follows still looks like a code.
  const m = s.match(/^AD(D\d{4})$/);
  return m ? m[1] : s;
}

/**
 * 'YYYY-MM-DD' from anything date-shaped OD or our schema hands over, or null.
 *
 * OD's null-date convention is '0001-01-01' (never SQL NULL), and that sentinel
 * must never be read as a real date — a claim "serviced" in the year 1 would
 * score as an enormous date mismatch rather than as the absence of a date.
 * @param {unknown} value
 * @returns {string|null}
 */
function isoDay(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  if (m[1] === '0001') return null; // OD's null date
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Whole days between two 'YYYY-MM-DD' strings, or null if either is missing. */
function daysApart(a, b) {
  if (!a || !b) return null;
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.round(Math.abs(ms) / 86400000);
}

/**
 * Dollars → integer cents, rounded half-away-from-zero.
 *
 * Open Dental speaks decimal dollars on the wire; every amount in our schema is
 * integer cents. This is the ONLY place the conversion happens, and it happens
 * once per field on the way in — never on the way out, and never in the middle
 * of arithmetic where a float would accumulate.
 * @param {unknown} value
 * @returns {number}
 */
function dollarsToCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? -Math.round(-n * 100) : Math.round(n * 100);
}

/**
 * A cent difference, written the way a biller reads money.
 *
 * Under a dollar it stays in cents, because "40¢ apart" is exactly the scale of
 * a rounding disagreement and rendering it as "$0.40" makes it look like a real
 * discrepancy. At a dollar or more it becomes dollars: "$984.00 apart" is a
 * number somebody can act on, and "98400¢ apart" is one they have to decode
 * before they can — in front of staff, mid-decision.
 *
 * @param {number} cents
 * @returns {string}
 */
function describeDelta(cents) {
  const abs = Math.abs(cents);
  if (abs < 100) return `${abs}¢ apart`;
  return `$${(abs / 100).toFixed(2)} apart`;
}

/**
 * OD writes -1 into estimate columns to mean "not calculated", not "zero
 * dollars" (TC_OD_READS.md, trap 1). Anything negative from those columns is
 * therefore an absence.
 * @param {unknown} value
 * @returns {number|null}
 */
function odAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return dollarsToCents(n);
}

// ─── Candidate summarisation ─────────────────────────────────────────────────

/**
 * Open Dental's own estimate of what insurance will pay on a line, in cents, or
 * `null` when it has not calculated one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * -1 IS A SENTINEL, NOT A DOLLAR AMOUNT
 * ─────────────────────────────────────────────────────────────────────────────
 * Open Dental writes **-1** into `InsEstTotal` to mean "not calculated"
 * (`docs/TC_OD_READS.md` §"The -1 sentinel"), and `InsEstTotalOverride` wins
 * whenever it is set. A `COALESCE(..., 0)` over that produces a confident
 * "$-0.01 estimated", which is the class of quiet wrongness this module keeps
 * finding on estimate columns. Null means "Open Dental has not said", and the
 * screen prints that rather than a number.
 *
 * PROJECTION ONLY — NO NEW OPEN DENTAL CALL. `InsEstTotal` and its override
 * arrive on the very `GET /claimprocs` rows `odClaimReads` already fetches for
 * the match; this reads bytes that were being thrown away at the projection,
 * exactly as Stage A did for the patient's birthdate and subscriber id. Adding
 * it changes no score, no evidence tag and no blocker.
 *
 * @param {Record<string, unknown>} cp a claimproc row, verbatim from OD
 * @returns {number|null}
 */
function odInsEstimate(cp) {
  const override = Number(cp.InsEstTotalOverride);
  if (Number.isFinite(override) && override >= 0) return dollarsToCents(override);
  const value = Number(cp.InsEstTotal);
  return Number.isFinite(value) && value >= 0 ? dollarsToCents(value) : null;
}

/**
 * @typedef {Object} OdLineFacts
 * @property {number} claimProcNum
 * @property {number|null} procNum
 * @property {string} code            the ADA code, from the procedure or CodeSent
 * @property {string} status          OD's string enum
 * @property {number} feeBilledCents
 * @property {number} insPayAmtCents
 * @property {number} writeOffCents
 * @property {number} dedAppliedCents
 * @property {number|null} insEstCents  what OD ESTIMATES insurance will pay on
 *   this line, or null when Open Dental has not calculated one. See `odInsEstimate`.
 * @property {boolean} isTransfer
 * @property {number|null} claimPaymentNum  non-null ⇒ InsPayAmt is locked
 * @property {boolean|'unknown'} deleted  true = ProcStatus 'D'; 'unknown' = the
 *   procedure row could not be read, so a soft delete cannot be ruled out
 * @property {boolean} blockedStatus  PUT /claimprocs would refuse this status
 */

/**
 * Flatten one candidate's claimprocs into the facts the scorer and the screen
 * both use, resolving each line's ADA code through the procedure it adjudicates.
 *
 * `deleted` IS TRI-STATE, and that is the point. It used to be
 * `!!proc && ProcStatus === 'D'`, which reads a MISSING procedure row as "not
 * deleted" — the one direction that is unsafe. `DELETE /procedurelogs` is a
 * soft delete (G12), so without the procedure row a deleted line and a live one
 * are indistinguishable; and an Open Dental key without the `/procedurelogs`
 * resource returns no rows at all. Failing open there silently inflates every
 * amount, hides the exclusion blocker, and lets `pairLines` hand Slice 6c the
 * ClaimProcNum of a deleted procedure to PUT against.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} claimProcs raw OD claimproc rows
 * @param {Map<number, Record<string, unknown>>} proceduresByProcNum raw procedurelog rows
 * @returns {OdLineFacts[]}
 */
function summariseLines(claimProcs, proceduresByProcNum) {
  return (claimProcs || []).map((cp) => {
    /*
     * "OD said ProcNum 0" AND "OD did not say" ARE DIFFERENT FACTS.
     *
     * This used to be `Number(cp.ProcNum) > 0`, and `Number(null)` is 0 while
     * `Number(undefined)` is NaN — so a claimproc whose ProcNum the API omits
     * or nulls read as OD's legitimate claim-level `ProcNum 0` row, which has
     * no procedure to delete and is therefore `deleted: false`. That is the
     * original soft-delete defect moved from the procedure row to the field:
     * an unreadable line counted in every total and was eligible for pairing.
     *
     * So the ABSENCE of the field is 'unknown', and only an explicit 0 is the
     * claim-level row.
     */
    const raw = cp.ProcNum;
    // `Number()` is far too generous to lean on: '  ', [], false and null all
    // coerce to 0, which is OD's claim-level row — the one value that means
    // "there is no procedure here and that is fine". Only an actual number or a
    // string that is entirely digits counts as OD having STATED one.
    const stated =
      (typeof raw === 'number' && Number.isFinite(raw)) ||
      (typeof raw === 'string' && /^\s*-?\d+\s*$/.test(raw));
    const procNum = stated ? Number(raw) : NaN;
    const usable = stated && Number.isFinite(procNum);
    const proc = usable ? proceduresByProcNum.get(procNum) : undefined;
    // WHY the row is missing (an unentitled resource, a page cap, a procedure
    // outside the scan, or a field OD never sent) is already reported as a note
    // by the read shell; here it is enough that we could not check.
    const deleted = !usable
      ? 'unknown'
      : procNum === 0
        ? false // OD's claim-level claimproc: no procedure, nothing to delete
        : proc
          ? String(proc.ProcStatus) === DELETED_PROC_STATUS
          : 'unknown';
    const status = typeof cp.Status === 'string' ? cp.Status : String(cp.Status ?? '');
    // Zero is OD's "no check" for ClaimPaymentNum, not a check numbered zero.
    const payNum = Number(cp.ClaimPaymentNum);
    return {
      claimProcNum: Number(cp.ClaimProcNum),
      procNum: usable ? procNum : null,
      code: procCode((proc && (proc.procCode || proc.ProcCode)) || cp.CodeSent || ''),
      status,
      feeBilledCents: odAmount(cp.FeeBilled) ?? 0,
      insPayAmtCents: dollarsToCents(cp.InsPayAmt),
      writeOffCents: dollarsToCents(cp.WriteOff),
      dedAppliedCents: dollarsToCents(cp.DedApplied),
      insEstCents: odInsEstimate(cp),
      isTransfer: cp.IsTransfer === true || cp.IsTransfer === 'true',
      claimPaymentNum: Number.isFinite(payNum) && payNum > 0 ? payNum : null,
      deleted,
      blockedStatus: BLOCKED_CLAIMPROC_STATUSES.includes(status),
    };
  });
}

/**
 * Is the carrier taking money BACK?
 *
 * ONE definition, and `routes/rcm/approvalGate.js` calls this rather than
 * keeping its own — the gate and the match must not be able to disagree about
 * which lane a claim is on, because the match gathers the evidence the gate then
 * judges. They disagreed for exactly one walk night and it cost the third
 * takeback attempt.
 *
 * Read off the MONEY, never off a flag: the claim's own paid total, and what the
 * batch says this claim moved. Either being negative is a takeback.
 *
 * @param {{ totalPaidCents?: unknown, paidCents?: unknown }} [amounts]
 * @returns {boolean}
 */
function isTakeback({ totalPaidCents, paidCents } = {}) {
  const claimTotal = Number(totalPaidCents);
  if (Number.isFinite(claimTotal) && claimTotal < 0) return true;
  const batchPaid = Number(paidCents);
  return Number.isFinite(batchPaid) && batchPaid < 0;
}

/**
 * Can this chart line be REVERSED — i.e. does it carry insurance money?
 *
 * Deliberately not "is it on a check". A line paid but not yet attached to a
 * ClaimPayment still has money on it to take back, and demanding the check
 * would refuse a takeback against a payment posted by hand in Open Dental. The
 * check is REPORTED (`LINE_PAID_AND_ON_CHECK`), not required.
 *
 * `deleted === false` rather than `!deleted` for the same reason the payment
 * lane uses it: `'unknown'` means the procedure row could not be read, and a
 * soft-deleted procedure is indistinguishable from a live one without it.
 *
 * @param {OdLineFacts} l
 * @returns {boolean}
 */
function isReversibleLine(l) {
  return (
    l.deleted === false && !l.isTransfer && !l.blockedStatus && Number(l.insPayAmtCents || 0) !== 0
  );
}

/**
 * The pre-flight blockers on one candidate, in the order a biller reads them.
 *
 * `takeback` swaps two of them for their inverses — see the takeback lane in
 * `OD_BLOCKERS`. Everything else (deleted, transferred, blocked status,
 * unreadable) is the same fact and the same verdict on both lanes: they are
 * reasons Open Dental cannot be trusted about a line at all, and no direction of
 * money makes them safe.
 *
 * @param {OdLineFacts[]} lines
 * @param {Record<string, unknown>} claim raw OD claim row
 * @param {{ takeback?: boolean, takebackCents?: number|null }} [opts]
 *   `takebackCents` is the remittance's own (negative) total for this claim,
 *   when known. Omitted, the coverage check is simply not made — a missing
 *   amount is not evidence that the chart covers it.
 * @returns {Array<{ code: string, blocking: boolean, label: string, detail: string, count?: number }>}
 */
function findBlockers(lines, claim, { takeback = false, takebackCents = null } = {}) {
  /** @type {Array<{code:string, blocking:boolean, label:string, detail:string, count?:number}>} */
  const out = [];
  const add = (code, count) => out.push({ code, ...OD_BLOCKERS[code], ...(count ? { count } : {}) });

  if (String(claim.ClaimStatus) === 'R') add('CLAIM_ALREADY_RECEIVED');

  const deleted = lines.filter((l) => l.deleted === true).length;
  if (deleted) add('DELETED_PROCEDURES_EXCLUDED', deleted);

  // Blocking, not a caution: a line whose procedure we could not read may be a
  // soft-deleted one, and 6c would be PUTting money against it.
  const unknown = lines.filter((l) => l.deleted === 'unknown').length;
  if (unknown) add('DELETED_STATUS_UNKNOWN', unknown);

  const live = lines.filter((l) => l.deleted === false);
  const withPayment = live.filter((l) => l.claimPaymentNum !== null).length;
  // THE SWAP. On the takeback lane an attached check is the precondition, and
  // saying so is not the same as saying nothing — the fact still prints.
  if (withPayment) add(takeback ? 'LINE_PAID_AND_ON_CHECK' : 'LINE_HAS_CLAIM_PAYMENT', withPayment);

  const transfers = live.filter((l) => l.isTransfer).length;
  if (transfers) add('LINE_IS_TRANSFER', transfers);

  const blockedStatus = live.filter((l) => l.blockedStatus).length;
  if (blockedStatus) add('LINE_STATUS_BLOCKED', blockedStatus);

  if (takeback) {
    /*
     * THE INVERSE, AND IT IS A REAL REFUSAL.
     *
     * "Every line is already paid" is what the payment lane calls
     * NO_PAYABLE_LINES and refuses on. The takeback lane refuses on the
     * opposite: nothing here was ever paid, so there is nothing to reverse.
     */
    const reversible = live.filter(isReversibleLine);
    if (lines.length > 0 && reversible.length === 0) add('NO_REVERSIBLE_LINES');

    /*
     * AND IT MUST FIT. A carrier asking for $2.00 back off a $1.00 payment is
     * either not talking about these lines or is taking part of it from
     * somewhere else; posting it would leave the ledger short by the
     * difference. Compared as magnitudes so the sign convention on either side
     * cannot turn a refusal into a pass.
     */
    const asked = Math.abs(Number(takebackCents));
    if (Number.isFinite(asked) && asked > 0 && reversible.length > 0) {
      const paidOnChart = reversible.reduce((a, l) => a + Math.abs(Number(l.insPayAmtCents) || 0), 0);
      if (asked > paidOnChart) add('TAKEBACK_EXCEEDS_PAYMENT');
    }
    return out;
  }

  const payable = live.filter((l) => !l.isTransfer && !l.blockedStatus && l.claimPaymentNum === null);
  if (lines.length > 0 && payable.length === 0) add('NO_PAYABLE_LINES');

  return out;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Confidence bands. Named so the UI never invents its own cutoffs, and so
 * "HIGH" means the same thing in the screenshot and in the test.
 *
 * HIGH does NOT mean "post it". It means the evidence is strong enough that a
 * biller reading the evidence list will probably agree. They still click.
 */
const CONFIDENCE_BANDS = Object.freeze([
  { band: 'HIGH', min: 75 },
  { band: 'MEDIUM', min: 45 },
  { band: 'LOW', min: 0 },
]);

/**
 * @param {number} score
 * @returns {'HIGH'|'MEDIUM'|'LOW'}
 */
function bandFor(score) {
  for (const { band, min } of CONFIDENCE_BANDS) if (score >= min) return band;
  return 'LOW';
}

/**
 * Compare one proposal claim against one candidate OD claim.
 *
 * @param {{ claimNumber?: unknown, patientName?: unknown, serviceDate?: unknown,
 *           totalBilledCents?: unknown,
 *           lines?: ReadonlyArray<{ billedCode?: unknown, paidCode?: unknown, code?: unknown,
 *                                   billedCents?: unknown }> }} proposal
 * @param {{ claim: Record<string, unknown>,
 *           claimProcs?: ReadonlyArray<Record<string, unknown>>,
 *           procedures?: Map<number, Record<string, unknown>>,
 *           patient?: Record<string, unknown>|null }} candidate
 * @returns {{
 *   odClaimNum: number, odPatNum: number|null,
 *   score: number, confidence: 'HIGH'|'MEDIUM'|'LOW',
 *   evidence: Array<{ tag: string, weight: number, label: string, detail: string, note?: string }>,
 *   blockers: Array<{ code: string, blocking: boolean, label: string, detail: string, count?: number }>,
 *   od: { claimStatus: string, dateService: string|null, claimFeeCents: number,
 *         insPaidCents: number, writeOffCents: number, patientName: string|null,
 *         patientBirthdate: string|null, subscriberId: string|null,
 *         lines: OdLineFacts[], deletedLineCount: number },
 * }}
 */
/**
 * Open Dental's NULL DATE, which is a real date rather than a null.
 * @see CLAUDE.md — "NULL DATES: stored as '0001-01-01', never as SQL NULL".
 */
const OD_NULL_DATE = '0001-01-01';

/**
 * A patient's birthdate as `yyyy-MM-dd`, or null.
 *
 * Date part only — see the note at the call site. Anything that is not a
 * recognisable `yyyy-MM-dd` prefix comes back null: this feeds a screen a person
 * checks an identity against, and half-parsing a date there is worse than
 * admitting the field was not readable.
 *
 * @param {Record<string, unknown>|null} patient
 * @returns {string|null}
 */
function odBirthdate(patient) {
  if (!patient) return null;
  const raw = patient.Birthdate ?? patient.birthdate ?? null;
  if (typeof raw !== 'string') return null;
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  if (!day) return null;
  return day[1] === OD_NULL_DATE ? null : day[1];
}

/**
 * The subscriber id Open Dental holds for this patient, or null.
 *
 * Read from whichever spelling the resource used, because this is documented as
 * a request parameter rather than as a response field and the response's casing
 * is therefore not something to rely on. An empty string is NOT an id: it is the
 * absence of one, and it says so.
 *
 * @param {Record<string, unknown>|null} patient
 * @returns {string|null}
 */
function odSubscriberId(patient) {
  if (!patient) return null;
  const raw = patient.SubscriberId ?? patient.SubscriberID ?? patient.subscriberId ?? null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function scoreCandidate(proposal, candidate, { takeback = false, takebackCents = null } = {}) {
  const claim = candidate.claim || {};
  const lines = summariseLines(candidate.claimProcs || [], candidate.procedures || new Map());
  /*
   * TWO DIFFERENT LINE SETS, because money and identity fail differently.
   *
   * `live` — known NOT deleted. Feeds every AMOUNT. A line we cannot vouch for
   *   is excluded exactly like a deleted one, because a wrong total is a wrong
   *   answer with no flag on it.
   *
   * `identity` — everything not KNOWN deleted. Feeds procedure codes and the
   *   line count, which answer "is this the same claim?" rather than "how much
   *   money is on it". A procedure whose row we could not read still tells us
   *   this claim carries that code; excluding it would make a claim harder to
   *   recognise for a reason that has nothing to do with recognising it.
   *
   * A KNOWN-deleted line is out of both: it is the one case where we have
   * positive evidence the procedure is gone.
   */
  const live = lines.filter((l) => l.deleted === false);
  const identity = lines.filter((l) => l.deleted !== true);
  const unknownLines = lines.filter((l) => l.deleted === 'unknown').length;

  /** @type {Array<{tag:string, weight:number, label:string, detail:string, note?:string}>} */
  const evidence = [];
  const tag = (name, note) => {
    const spec = EVIDENCE_TAGS[name];
    evidence.push({ tag: name, weight: spec.weight, label: spec.label, detail: spec.detail, ...(note ? { note } : {}) });
  };

  // ── Claim number ──────────────────────────────────────────────────────────
  // The carrier echoes the payer's own claim id in CLP01, which for a claim
  // Open Dental submitted IS the ClaimNum. When it matches, nothing else has to
  // work very hard — but it is still only 35 of 100, because a payer that
  // renumbers claims would otherwise carry a match on its own.
  const odClaimNum = Number(claim.ClaimNum);
  if (squash(proposal.claimNumber) && squash(proposal.claimNumber) === squash(odClaimNum)) {
    tag('CLAIM_NUMBER_MATCH');
  }

  // ── Patient ───────────────────────────────────────────────────────────────
  const patient = candidate.patient || null;
  const odNameTokens = patient ? nameTokens(`${patient.LName || ''} ${patient.FName || ''}`) : [];
  const ourNameTokens = nameTokens(proposal.patientName);
  if (odNameTokens.length && ourNameTokens.length) {
    const shared = ourNameTokens.filter((t) => odNameTokens.includes(t));
    if (shared.length >= 2) tag('PATIENT_NAME_MATCH', shared.join(' '));
    else if (shared.length === 1) tag('PATIENT_NAME_PARTIAL', shared[0]);
    else tag('PATIENT_NAME_MISMATCH');
  }

  // ── Service date ──────────────────────────────────────────────────────────
  const ourDate = isoDay(proposal.serviceDate);
  const odDate = isoDay(claim.DateService);
  const gap = daysApart(ourDate, odDate);
  if (gap === 0) tag('SERVICE_DATE_MATCH');
  else if (gap !== null && gap <= DATE_NEAR_DAYS) tag('SERVICE_DATE_NEAR', `${gap} day${gap === 1 ? '' : 's'} apart`);
  else if (gap !== null) tag('SERVICE_DATE_MISMATCH', `${gap} days apart`);

  // ── Procedure codes ───────────────────────────────────────────────────────
  // Both the billed and the paid code count as "ours": on a downcoded line the
  // carrier reports one code and the chart carries the other, and refusing to
  // look at both would make every downcode look like a code mismatch.
  const ourCodes = new Set();
  for (const line of proposal.lines || []) {
    for (const c of [line.billedCode, line.paidCode, line.code]) {
      const code = procCode(c);
      if (code) ourCodes.add(code);
    }
  }
  const odCodes = new Set(identity.map((l) => l.code).filter(Boolean));
  // Guarded on the claim HAVING lines, not on the live codes being non-empty. A
  // claim whose every procedure was deleted genuinely does not carry our codes,
  // and that is a signal — whereas a claim whose claimprocs were never fetched
  // (a capability miss, a page cap) tells us nothing, and silence is the honest
  // answer there.
  if (ourCodes.size && lines.length > 0) {
    // Count per PROPOSAL LINE, not per distinct code, so a claim with 4 lines
    // of which 1 matches does not read as "half the codes present".
    const lineCodes = (proposal.lines || []).map((l) => [l.billedCode, l.paidCode, l.code].map(procCode).filter(Boolean));
    const hits = lineCodes.filter((codes) => codes.some((c) => odCodes.has(c))).length;
    const ratio = lineCodes.length ? hits / lineCodes.length : 0;
    if (ratio === 1) tag('CODES_ALL_PRESENT', `${hits}/${lineCodes.length}`);
    else if (ratio >= 0.5) tag('CODES_PARTIAL', `${hits}/${lineCodes.length}`);
    else tag('CODES_ABSENT', `${hits}/${lineCodes.length}`);
  }

  // ── Billed total ──────────────────────────────────────────────────────────
  // Against the LIVE lines' FeeBilled, not the claim's ClaimFee: ClaimFee still
  // includes soft-deleted procedures (G12), which is precisely the arithmetic
  // that over-applied a reversal by $2.00 in the spike teardown.
  const odBilledCents = live.reduce((sum, l) => sum + l.feeBilledCents, 0);
  const ourBilledCents = Number(proposal.totalBilledCents);
  // NO money tag at all when a line's deleted state is unknown: the chart total
  // is then neither trustworthy nor knowably wrong, and either a MATCH or a
  // MISMATCH would be an assertion we cannot make. Silence is the honest answer,
  // and the blocker says why.
  if (unknownLines === 0 && Number.isFinite(ourBilledCents) && ourBilledCents > 0 && odBilledCents > 0) {
    const delta = Math.abs(ourBilledCents - odBilledCents);
    if (delta <= AMOUNT_EXACT_CENTS) tag('BILLED_AMOUNT_MATCH');
    else if (delta <= AMOUNT_NEAR_CENTS) tag('BILLED_AMOUNT_NEAR', describeDelta(delta));
    else tag('BILLED_AMOUNT_MISMATCH', describeDelta(delta));
  }

  // ── Line count ────────────────────────────────────────────────────────────
  const ourLineCount = (proposal.lines || []).length;
  if (ourLineCount > 0 && identity.length === ourLineCount) tag('LINE_COUNT_MATCH');

  const raw = evidence.reduce((sum, e) => sum + e.weight, 0);
  const score = Math.max(0, Math.min(100, raw));

  const odPatNum = Number(claim.PatNum);

  return {
    odClaimNum: Number.isFinite(odClaimNum) ? odClaimNum : 0,
    odPatNum: Number.isFinite(odPatNum) ? odPatNum : null,
    score,
    confidence: bandFor(score),
    evidence,
    blockers: findBlockers(lines, claim, { takeback, takebackCents }),
    od: {
      claimStatus: String(claim.ClaimStatus ?? ''),
      dateService: odDate,
      /**
       * The claim HEADER's total, verbatim from OD — and CONTAMINATED by
       * design: `ClaimFee` still includes soft-deleted procedures (G12), which
       * is the arithmetic that over-applied a reversal by $2.00 in the spike
       * teardown. Kept because it is what the chart displays and a biller
       * comparing screens will see it; never used as a line-derived figure.
       * `billedCents` below is the one to compare against.
       */
      claimHeaderFeeCents: dollarsToCents(claim.ClaimFee),
      /**
       * The LIVE lines' FeeBilled — the same number the BILLED_AMOUNT_* tags
       * were computed from, and the one Slice 6c re-verifies against. It used
       * to be computed here and thrown away, which left `claimHeaderFeeCents`
       * as the only billed figure that survived into a confirmation.
       */
      billedCents: odBilledCents,
      // "As read", for the snapshot 6c re-verifies against. Live lines only.
      insPaidCents: live.reduce((s, l) => s + l.insPayAmtCents, 0),
      writeOffCents: live.reduce((s, l) => s + l.writeOffCents, 0),
      patientName: patient ? `${patient.LName || ''}, ${patient.FName || ''}`.trim().replace(/^,\s*/, '') : null,
      /**
       * TWO IDENTITY FACTS FOR STAGE B'S SIDE-BY-SIDE, AND NOT ONE OD CALL MORE.
       *
       * The candidate's patient row is ALREADY fetched — `odClaimReads` reads it
       * whole, either by `/patients/{PatNum}` on the linked lane or out of the
       * name search on the other. These two fields were being thrown away at
       * this projection, so a screen wanting to show a biller the chart beside
       * the EOB had nothing to show but a name.
       *
       * NO NEW VERB, no new request, no new pacing cost: this is a projection of
       * bytes already in hand. `rcmNoOdWrites.test.js` is unaffected because
       * nothing here reaches a transport at all.
       *
       * BOTH ARE `null` WHEN OPEN DENTAL DID NOT SEND THEM, and that is load
       * bearing rather than defensive. `Birthdate` is a `/patients` field this
       * platform reads elsewhere; `SubscriberId` is documented as a SEARCH
       * PARAMETER on `/patients` (docs/OD_API_CONTRACT.md §7) and is not
       * promised in the response body, so on some rows it will simply be absent.
       * A missing identity fact must read as "not recorded" and never as a value
       * somebody could compare against an EOB — a fabricated subscriber id on a
       * verification screen is the worst failure this module has.
       *
       * `patientBirthdate` is the DATE PART ONLY. Open Dental returns a
       * birthdate as `yyyy-MM-dd` or as a midnight instant depending on the
       * resource, and a snapshot carrying an instant would print the wrong day
       * for anybody east of UTC — the `format.day()` bug PR #112 found, in the
       * one place where being a day out means the wrong person.
       *
       * OD's NULL DATE is `'0001-01-01'`, never SQL NULL, so it is screened here
       * rather than shipped as a birthday in the year 1.
       */
      patientBirthdate: odBirthdate(patient),
      /** As Open Dental spells it. `null` = not recorded, never an empty string. */
      subscriberId: odSubscriberId(patient),
      lines,
      deletedLineCount: lines.filter((l) => l.deleted === true).length,
      /** Lines whose procedure could not be read — excluded from every total. */
      unknownDeletedLineCount: unknownLines,
    },
  };
}

/**
 * Score every candidate, rank them, and say whether the ranking is safe to read
 * as an ordering.
 *
 * Ties and near-ties set `ambiguous`. Nothing is dropped for being ambiguous —
 * the whole list is returned, because the biller resolving it needs to see both.
 *
 * @param {Parameters<typeof scoreCandidate>[0]} proposal
 * @param {ReadonlyArray<Parameters<typeof scoreCandidate>[1]>} candidates
 * @param {{ patientResolvedByLink?: boolean }} [opts] true when the candidates
 *   came from a LINKED PatNum rather than from a name search — see
 *   DISQUALIFYING_TAGS for why that turns the name rule off.
 * @returns {{ candidates: ReturnType<typeof scoreCandidate>[], ambiguous: boolean, margin: number|null }}
 */
function rankCandidates(
  proposal,
  candidates,
  { patientResolvedByLink = false, takeback = false, takebackCents = null } = {}
) {
  const scored = (candidates || [])
    .map((c) => scoreCandidate(proposal, c, { takeback, takebackCents }))
    // Highest first; ClaimNum ascending as the tie-break so the order is
    // deterministic across runs. A stable order is what makes a screenshot and
    // a re-run comparable.
    .sort((a, b) => b.score - a.score || a.odClaimNum - b.odClaimNum);

  // Noise is not "a weak candidate", and offering it beside a Confirm button is
  // how a stranger's ClaimNum gets written onto a claim. Dropped candidates are
  // COUNTED and their reason recorded — never silently vanished.
  const nameMismatch = (c) =>
    !patientResolvedByLink && c.evidence.some((e) => DISQUALIFYING_TAGS.includes(e.tag));
  const rejectedForName = scored.filter(nameMismatch).length;
  const offered = scored.filter((c) => !nameMismatch(c) && c.score >= MIN_CANDIDATE_SCORE);
  const rejectedForScore = scored.length - offered.length - rejectedForName;

  const margin = offered.length >= 2 ? offered[0].score - offered[1].score : null;
  return {
    candidates: offered,
    ambiguous: margin !== null && margin < AMBIGUITY_MARGIN,
    margin,
    /** Examined and not offered. */
    rejected: scored.length - offered.length,
    /**
     * WHY they were not offered, split by rule.
     *
     * This is what stops `no_candidate` from being a lie. Its documented
     * meaning is "a search ran against this office's Open Dental and found
     * nothing", and without these counts a search that found three claims and
     * disqualified all three is indistinguishable from one that found none —
     * on the screen a biller acts on.
     */
    rejectedReasons: { nameMismatch: rejectedForName, belowScore: rejectedForScore },
    minScore: MIN_CANDIDATE_SCORE,
    /** False when the name rule was off because the patient was already linked. */
    nameRuleApplied: !patientResolvedByLink,
  };
}

/**
 * Pair our procedure lines to a candidate's claimprocs, so a confirmed match
 * can record a ClaimProcNum per line — the number Slice 6c PUTs against, and
 * the one thing the §8 recovery window needs and cannot get back afterwards.
 *
 * Greedy on (code, then closest billed amount). A line that cannot be paired is
 * returned with `odClaimProcNum: null` rather than guessed at: an unpaired line
 * is a real answer, and 6c refusing to post one is better than 6c posting it
 * against whichever claimproc happened to be next.
 *
 * On the PAYMENT lane, deleted, transferred, blocked and already-paid lines are
 * NOT eligible — every one of them is a line Open Dental would refuse to PUT
 * money onto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON THE TAKEBACK LANE THE PAID LINES ARE THE ONLY ELIGIBLE ONES
 * ─────────────────────────────────────────────────────────────────────────────
 * A reversal does not pair to a line it could be paid into; it pairs to the line
 * it is taking money OUT of. Walk night 2 found this the hard way: with the
 * reversal 835 matched to the claim the drain had just posted, every line on the
 * chart was paid and on a check, the eligible set was empty, and the match
 * reported *"no postable line on this claim"* — a sentence that is true of a
 * payment and meaningless about a reversal. `LINES_PAIRED` then failed at the
 * gate and D-6's typed confirmation could never be reached.
 *
 * The rule inverts and nothing else changes: same greedy code-then-amount
 * pairing, same refusal to guess, same one-claimproc-per-line.
 *
 * @param {ReadonlyArray<{ lineId?: string, position?: number, billedCode?: unknown,
 *                         paidCode?: unknown, code?: unknown, billedCents?: unknown }>} proposalLines
 * @param {ReadonlyArray<OdLineFacts>} odLines
 * @param {{ takeback?: boolean }} [opts]
 * @returns {Array<{ lineId: string|null, position: number|null, code: string,
 *                   odClaimProcNum: number|null, odCode: string|null,
 *                   billedDeltaCents: number|null, reason: string|null }>}
 */
/**
 * How far our billed figure sits from the chart's — with a REVERSAL compared as
 * a mirror rather than as a subtraction.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * W-6: WITHOUT THIS, NO TAKEBACK COULD EVER BE APPROVED
 * ─────────────────────────────────────────────────────────────────────────────
 * A reversal 835 carries NEGATED amounts: the line the carrier is taking $29.00
 * back from is billed `-3500` where the chart says `3500`. A raw subtraction
 * makes that `-7000` — never zero for any non-zero fee — and `lineDecisions`
 * turns any non-zero delta into `od_fee_disagrees`, a RED verdict, and a failed
 * `PATIENT_RESPONSIBILITY_MATCHES` at the gate. If the line did NOT pair, the
 * verdict went red on `line_not_in_chart` instead. Both branches red, so the
 * takeback approve was unreachable for every parser-produced reversal, and the
 * path had never been green end to end. Found on the combined walk, 2026-09-04,
 * on claim 53863 reading "-$70.00 apart".
 *
 * It hid because the recoupment tests build their claims by hand with
 * `odFeeDeltaCents: 0`, so no test ever ran a real reversal through here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY MAGNITUDES, AND WHY IT STILL FAILS CLOSED
 * ─────────────────────────────────────────────────────────────────────────────
 * This delta answers an IDENTITY question — "is this the same procedure line?" —
 * and for identity the magnitudes are what agree. The MONEY question, "is the
 * carrier taking back more than the chart holds?", is a different one and is
 * already answered by `TAKEBACK_EXCEEDS_PAYMENT` in `findBlockers`, which
 * compares `Math.abs` on both sides. This is deliberately not widened to do that
 * job twice.
 *
 * A reversal must MIRROR the chart line: equal magnitude, OPPOSITE sign. Same
 * sign is not a mirror, so it is left as a raw subtraction and stays a
 * disagreement — normalising it away would turn a genuinely odd line into a
 * silent pass, which is the opposite of failing closed.
 *
 * @param {number} ourBilled the remittance's billed figure, negative on a reversal
 * @param {number} odFee Open Dental's FeeBilled for the paired line
 * @param {boolean} takeback whether this claim is on the reversal lane
 * @returns {number}
 */
function billedDelta(ourBilled, odFee, takeback) {
  if (!takeback) return ourBilled - odFee;
  // Not mirrored — our side non-negative, or the chart's negative. Report the
  // disagreement rather than normalising it out of existence.
  if (ourBilled > 0 || odFee < 0) return ourBilled - odFee;
  return Math.abs(ourBilled) - Math.abs(odFee);
}

function pairLines(proposalLines, odLines, { takeback = false } = {}) {
  // `deleted === false` rather than `!deleted`: 'unknown' is truthy-adjacent
  // and must NOT be pairable — pairing writes a ClaimProcNum that Slice 6c PUTs
  // money against, and an unread procedure may be a soft-deleted one.
  const eligible = (odLines || []).filter((l) =>
    takeback
      ? isReversibleLine(l)
      : l.deleted === false && !l.isTransfer && !l.blockedStatus && l.claimPaymentNum === null
  );
  const taken = new Set();

  return (proposalLines || []).map((line) => {
    const codes = [line.billedCode, line.paidCode, line.code].map(procCode).filter(Boolean);
    const ourBilled = Number(line.billedCents);

    const byCode = eligible.filter((l) => !taken.has(l.claimProcNum) && codes.includes(l.code));
    let chosen = null;
    if (byCode.length === 1) {
      chosen = byCode[0];
    } else if (byCode.length > 1 && Number.isFinite(ourBilled)) {
      // Several lines carry the same code (two of the same restoration on one
      // visit is ordinary). Closest billed amount wins; an exact tie stays
      // stable because sort is stable and the OD order is ClaimProcNum order.
      chosen = byCode
        .slice()
        .sort((a, b) => Math.abs(a.feeBilledCents - ourBilled) - Math.abs(b.feeBilledCents - ourBilled))[0];
    } else if (byCode.length > 1) {
      chosen = byCode[0];
    }

    if (chosen) taken.add(chosen.claimProcNum);

    return {
      lineId: typeof line.lineId === 'string' ? line.lineId : null,
      position: Number.isFinite(Number(line.position)) ? Number(line.position) : null,
      code: codes[0] || '',
      odClaimProcNum: chosen ? chosen.claimProcNum : null,
      odCode: chosen ? chosen.code : null,
      billedDeltaCents:
        chosen && Number.isFinite(ourBilled)
          ? billedDelta(ourBilled, chosen.feeBilledCents, takeback)
          : null,
      reason: chosen
        ? null
        : eligible.length === 0
          ? takeback
            ? 'no paid line on this claim to reverse'
            : 'no postable line on this claim'
          : 'no line on this claim carries this code',
    };
  });
}

module.exports = {
  // Tunables — exported so the docs, the tests and the UI copy read one number.
  AMOUNT_EXACT_CENTS,
  AMOUNT_NEAR_CENTS,
  DATE_NEAR_DAYS,
  AMBIGUITY_MARGIN,
  MIN_CANDIDATE_SCORE,
  DISQUALIFYING_TAGS,
  CONFIDENCE_BANDS,
  EVIDENCE_TAGS,
  EVIDENCE_TAG_NAMES,
  OD_BLOCKERS,
  BLOCKED_CLAIMPROC_STATUSES,
  DELETED_PROC_STATUS,
  // The core.
  scoreCandidate,
  rankCandidates,
  pairLines,
  isTakeback,
  isReversibleLine,
  // Exported for the shell and its tests; pure and individually meaningful.
  summariseLines,
  procCode,
  nameTokens,
  isoDay,
  dollarsToCents,
  bandFor,
  describeDelta,
};
