'use strict';

/**
 * The money, defined once — so the screen, the gate and the drain cannot
 * disagree about what the patient owes.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE RULE
 * ═════════════════════════════════════════════════════════════════════════════
 * The number that must reconcile is PATIENT RESPONSIBILITY: what the carrier's
 * remittance says the patient owes must equal what Open Dental will say the
 * patient owes once the payment and the write-offs post — with exactly one
 * legitimate exception, a write-off the office chose to make, which lowers the
 * patient's number on purpose and is recorded as a decision with a reason and a
 * name against it. Anything else is a real problem and cannot post.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE DEFINITIONS, IN ONE PLACE
 * ═════════════════════════════════════════════════════════════════════════════
 * Per line the carrier gives billed (B), allowed (A) and paid (P):
 *
 *     contractual write-off   W = B − A
 *     patient remainder       R = A − P
 *
 * W is the CARRIER's figure. This slice always accepts it: it is displayed as a
 * fact, never offered as a choice, and no decision here can change it. (A
 * per-office "do not accept contractual write-offs" flag is a later slice and
 * is deliberately not built.)
 *
 * R is the whole decision, and it is one enum per line:
 *
 *     bill_patient      DEFAULT, needs no action. The patient is billed R, and
 *                       their number matches the remittance exactly.
 *     office_writeoff   reason REQUIRED. The office absorbs R, and the patient's
 *                       number is deliberately R below the remittance.
 *
 * A line where R is zero has nothing to decide and renders without the control.
 * There is no third stored state and no amount field anywhere: the practice
 * owner's biller has never split a line, so a line is written off whole or
 * billed whole. The screen renders the accepted contractual write-off beside the
 * two choices — which reads as three things — but only the enum is stored.
 *
 * Over a claim:
 *
 *     EOB patient responsibility        Σ R over every line
 *     decided office write-off total    Σ R over `office_writeoff` lines
 *     projected patient responsibility  Σ R over `bill_patient` lines
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TWO REGISTERS, AND THE COPY SAYS WHICH ONE IT IS
 * ═════════════════════════════════════════════════════════════════════════════
 * Before posting — all of shadow mode, where posting is switched off — the
 * verdict is a PROJECTION from Open Dental's current figures plus the
 * decisions, and it says *"will owe … once posted"*. After a real post it is
 * recomputed from what Open Dental was read back as holding, and it says
 * *"owes … — confirmed in Open Dental"*.
 *
 * A projection worded as a confirmation is the honest-states rule failing in the
 * most expensive place there is, so the register is a REQUIRED argument with no
 * default. A caller that has not decided which one it is holding cannot get a
 * sentence out of this file.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE FUNCTION, TWO RENDERERS
 * ═════════════════════════════════════════════════════════════════════════════
 * `verdictFor()` is the only place any of this arithmetic happens. The workbench
 * renders its sentence; the approval gate's "Patient's number matches the EOB"
 * check renders the same verdict as a pass or a refusal. They read one function,
 * so a screen that shows green beside a gate that refuses is not a bug that can
 * be introduced — it is a shape this code cannot produce. `lineDecisions.test.js`
 * and `approvalGate.test.js` both pin that.
 *
 * The SENTENCE ships from the server already formatted, for the same reason
 * `typedTotalExpected` does (D-6): a client that formats cents itself is a
 * client that can display `$54.8` while the server means `$54.08`.
 */

/**
 * The two decisions. Same list the migration's CHECK constraint holds; the
 * migration exports it too and `lineDecisions.test.js` asserts they agree, so a
 * value added to one and not the other is a red test rather than a 23514 on a
 * walk night.
 */
const LINE_DECISIONS = Object.freeze(['bill_patient', 'office_writeoff']);

/**
 * The decision a line has when nobody has said anything.
 *
 * NULL in the database reads as this. Deliberately not defaulted in the schema:
 * "she decided to bill it" and "nobody looked" are different facts and only one
 * of them carries a name, but they have the same effect on the money, and the
 * money is what this file computes.
 */
const DEFAULT_LINE_DECISION = 'bill_patient';

/**
 * The canned reasons an office write-off can carry. Ship exactly these five.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A LIST AND NOT FREE TEXT
 * ─────────────────────────────────────────────────────────────────────────────
 * The reason is the difference between a write-off the practice chose and money
 * that went missing, and it is read months later by somebody reconciling. Five
 * buttons get typed the same way every time; a text box does not.
 *
 * Per-office editing of this list is a later slice. When it lands, this becomes
 * the seed rather than the constraint — which is why the database CHECK covers
 * only whether a reason is PRESENT, never which one it is.
 *
 * `slug` is the stored value and never changes. `label` is what a person reads.
 */
const WRITEOFF_REASONS = Object.freeze([
  Object.freeze({ slug: 'xrays_bitewings', label: 'X-rays — bitewings' }),
  Object.freeze({ slug: 'xrays_panoramic', label: 'X-rays — panoramic' }),
  Object.freeze({ slug: 'xrays_other', label: 'X-rays — other films/images (OFIs)' }),
  Object.freeze({ slug: 'not_chargeable', label: 'Not chargeable for this procedure' }),
  Object.freeze({ slug: 'build_up', label: 'Build-up' }),
]);

/** Reason slug → label, for the sentence and the gate's detail. */
const REASON_LABELS = Object.freeze(
  Object.fromEntries(WRITEOFF_REASONS.map((r) => [r.slug, r.label]))
);

/** The two registers a verdict can be stated in. See the header. */
const REGISTERS = Object.freeze(['projection', 'confirmed']);

/**
 * The three verdict states.
 *
 * `red` is the fail-closed default of `verdictFor` — every path that is not
 * demonstrably one of the other two lands here, so a case nobody anticipated
 * refuses rather than approves.
 */
const VERDICT_STATES = Object.freeze(['green', 'amber', 'red']);

/**
 * Why a verdict is red. Every member names one or more lines.
 *
 * These are NOT `REASON_GATE` members: that map is over facts the parser or a
 * reader established about a claim, and these are conclusions this file draws
 * from arithmetic. Mixing them would put a computed judgement into a vocabulary
 * whose contract is "a fact somebody observed" — the same line
 * `NOT_PATIENT_RESPONSIBILITY_ONLY` is on the right side of.
 */
const PROBLEM_KINDS = Object.freeze([
  /** Open Dental's fee for the line is not what the carrier says was billed. */
  'od_fee_disagrees',
  /** The line has no chart line to post against. */
  'line_not_in_chart',
  /** An office write-off with nothing recorded about why. */
  'decision_missing_reason',
]);

/**
 * Cents as a person reads them. `$142.00`, `-$3.50`.
 *
 * NOT `formatRecoupmentTotal` (approvalGate.js), and the difference matters:
 * that one is a CONTRACT — the exact characters an approver must type back, so
 * it carries no symbol and no separators. This one is DISPLAY, so it carries the
 * currency symbol a biller expects to see beside a number on a remittance. Two
 * jobs, two functions, and neither is a formatting preference.
 *
 * The sign leads the symbol (`-$3.50`), which is how every other amount in this
 * module already prints.
 *
 * @param {number} cents
 * @returns {string}
 */
function formatDollars(cents) {
  const n = Number.isFinite(Number(cents)) ? Math.trunc(Number(cents)) : 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** An integer cents figure, or 0. Never NaN, never a float. */
function cents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * The carrier's arithmetic for one line.
 *
 * Both figures can legitimately be negative — a carrier that allowed more than
 * was billed, or paid more than it allowed — and neither is clamped. Clamping
 * would hide the case that most needs a human to look at it, and the verdict
 * below catches it as an imbalance rather than as a zero.
 *
 * @param {{ billedCents?: unknown, allowedCents?: unknown, paidCents?: unknown }} line
 * @returns {{ contractualWriteOffCents: number, patientRemainderCents: number }}
 */
function lineMoney(line) {
  const billed = cents(line && line.billedCents);
  const allowed = cents(line && line.allowedCents);
  const paid = cents(line && line.paidCents);
  return {
    /** W = B − A. The carrier's figure. Always accepted, never a choice. */
    contractualWriteOffCents: billed - allowed,
    /** R = A − P. What the remittance says the patient owes on this line. */
    patientRemainderCents: allowed - paid,
  };
}

/**
 * The decision a line carries, normalised.
 *
 * An unrecognised value reads as the DEFAULT rather than throwing, and that is a
 * deliberate asymmetry: the database CHECK is what makes an unrecognised value
 * unstorable, and if one ever appeared anyway, billing the patient the amount
 * the carrier assigned is the outcome that does not quietly move money. The
 * verdict is unaffected either way — `bill_patient` is the state whose projected
 * number equals the remittance.
 *
 * @param {{ decision?: unknown }} line
 * @returns {'bill_patient'|'office_writeoff'}
 */
function decisionOf(line) {
  const raw = line && line.decision;
  return LINE_DECISIONS.includes(raw) ? raw : DEFAULT_LINE_DECISION;
}

/**
 * Is this reason slug one a decision may be stored with?
 *
 * The route's guard, kept here beside the list rather than in the route, so the
 * later per-office slice has one place to change.
 *
 * @param {unknown} slug
 * @returns {boolean}
 */
function isWriteoffReason(slug) {
  return typeof slug === 'string' && Object.prototype.hasOwnProperty.call(REASON_LABELS, slug);
}

/** A reason slug in a biller's words, falling back to the slug itself. */
function reasonLabel(slug) {
  return REASON_LABELS[slug] || String(slug || '');
}

/**
 * The verdict for one claim.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A LINE HAS TO CARRY
 * ─────────────────────────────────────────────────────────────────────────────
 *   code                        what the sentence names a line by
 *   billedCents/allowedCents/paidCents   the carrier's three numbers
 *   decision                    'bill_patient' | 'office_writeoff' | null
 *   decisionReason              slug, required for office_writeoff
 *   decidedBy / decidedAt       who and when (rendered, never computed from)
 *   odClaimProcNum              null ⇒ this line has no chart line
 *   odFeeDeltaCents             our billed − Open Dental's FeeBilled, or null
 *                               when nothing is paired to compare against
 *
 * `odFeeDeltaCents` comes from the confirmed match snapshot's `linePairs`, which
 * is where Open Dental's own figure already lives. Nothing in this file reads
 * Open Dental, and nothing in it may: it is pure arithmetic over facts that were
 * gathered and stored by somebody else, which is what lets the gate, the screen
 * and a unit test all call it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE STATES
 * ─────────────────────────────────────────────────────────────────────────────
 *   GREEN  projected == EOB, and no problems.
 *   AMBER  projected == EOB − decided office write-off total, every contributing
 *          line has a reason, and no problems.
 *   RED    anything else. RED cannot approve.
 *
 * The green/amber test is the SAME equation — projected + decided = EOB — and
 * that is not a coincidence worth collapsing: green is the case where the second
 * term is zero, and saying so as two states is what lets the sentence tell a
 * biller whether her number differs from the carrier's on purpose.
 *
 * @param {{
 *   lines?: ReadonlyArray<Record<string, unknown>>,
 *   register: 'projection'|'confirmed',
 * }} input
 * @returns {{
 *   state: 'green'|'amber'|'red',
 *   register: 'projection'|'confirmed',
 *   eobPatientCents: number,
 *   projectedPatientCents: number,
 *   decidedWriteOffCents: number,
 *   contractualWriteOffCents: number,
 *   decisions: Array<{ lineId: string|null, code: string, amountCents: number,
 *                      reason: string|null, reasonLabel: string|null,
 *                      decidedBy: string|null, decidedAt: string|null }>,
 *   problems: Array<{ kind: string, code: string, lineId: string|null, detail: string }>,
 *   sentence: string,
 * }}
 */
function verdictFor({ lines = [], register } = {}) {
  if (!REGISTERS.includes(register)) {
    // Not a defensive throw — a caller that has not decided whether it is
    // holding a projection or a confirmation has not decided what its screen is
    // claiming, and no default is safe.
    throw new TypeError(
      `verdictFor needs a register: one of ${REGISTERS.join(', ')} (see the file header)`
    );
  }

  let eobPatientCents = 0;
  let projectedPatientCents = 0;
  let decidedWriteOffCents = 0;
  let contractualWriteOffCents = 0;
  const decisions = [];
  const problems = [];

  for (const line of lines) {
    const { contractualWriteOffCents: w, patientRemainderCents: r } = lineMoney(line);
    const code = String((line && line.code) || '');
    const lineId = line && typeof line.lineId === 'string' ? line.lineId : null;

    contractualWriteOffCents += w;
    eobPatientCents += r;

    const decision = decisionOf(line);
    if (decision === 'office_writeoff') {
      decidedWriteOffCents += r;
      const reason = line && typeof line.decisionReason === 'string' ? line.decisionReason : null;
      decisions.push({
        lineId,
        code,
        amountCents: r,
        reason,
        reasonLabel: reason ? reasonLabel(reason) : null,
        decidedBy: (line && line.decidedBy) || null,
        decidedAt: (line && line.decidedAt) || null,
      });
      /*
       * A DECISION WITHOUT ITS REASON IS RED, not a decision with a blank field.
       *
       * The database refuses to store one and the route refuses to accept one,
       * so through the product this is unreachable — which is exactly why it is
       * here. `REASON_GATE`'s rule is the module's idiom: absent is blocking.
       * The unit test drives it directly; the two guards above make it a shape
       * nobody can get onto a screen.
       */
      if (!reason) {
        problems.push({
          kind: 'decision_missing_reason',
          code,
          lineId,
          detail: `${code || 'a line'} is written off with nothing recorded about why`,
        });
      }
    } else {
      projectedPatientCents += r;
    }

    /*
     * A LINE WITH NO CHART LINE CANNOT BE PROJECTED ONTO A CHART.
     *
     * `LINES_PAIRED` refuses the same shape at the gate, and this is not that
     * check twice: that one is about whether a payment has somewhere to go, this
     * one is about whether the patient's number can be computed at all. They
     * fail together on the same claim and say different things about why.
     */
    if (line && line.odClaimProcNum == null) {
      problems.push({
        kind: 'line_not_in_chart',
        code,
        lineId,
        detail: `${code || 'a line'} has no matching line in Open Dental`,
      });
    } else if (line && line.odFeeDeltaCents != null && cents(line.odFeeDeltaCents) !== 0) {
      /*
       * OPEN DENTAL'S FEE IS NOT WHAT THE CARRIER SAYS WAS BILLED.
       *
       * The projection is "what the chart will say the patient owes", and it is
       * computed from the carrier's figures. If the chart was billed a different
       * amount for this procedure, those figures describe a different line and
       * the projection is arithmetic about the wrong number — so it refuses
       * rather than printing a total nobody can reconcile.
       *
       * `null` is not zero here: null means nothing was paired to compare
       * against, which is already the problem above.
       */
      const delta = cents(line.odFeeDeltaCents);
      problems.push({
        kind: 'od_fee_disagrees',
        code,
        lineId,
        detail:
          `${code || 'a line'} was billed ${formatDollars(cents(line.billedCents))} on the ` +
          `remittance and ${formatDollars(cents(line.billedCents) - delta)} in Open Dental`,
      });
    }
  }

  const balances = projectedPatientCents + decidedWriteOffCents === eobPatientCents;
  const state =
    problems.length > 0 || !balances
      ? 'red'
      : decidedWriteOffCents === 0
        ? 'green'
        : 'amber';

  return {
    state,
    register,
    eobPatientCents,
    projectedPatientCents,
    decidedWriteOffCents,
    contractualWriteOffCents,
    decisions,
    problems,
    sentence: verdictSentence({
      state,
      register,
      eobPatientCents,
      projectedPatientCents,
      decidedWriteOffCents,
      decisions,
      problems,
    }),
  };
}

/**
 * The verdict, as one sentence in the biller's register.
 *
 * Plain register, no jargon, and the two tenses are the whole point:
 * *"will owe … once posted"* is a projection and *"owes … — confirmed in Open
 * Dental"* is a fact read back out of the chart. Nothing here may state the
 * second while holding the first.
 *
 * @param {Omit<ReturnType<typeof verdictFor>, 'sentence'|'contractualWriteOffCents'>} v
 * @returns {string}
 */
function verdictSentence(v) {
  const confirmed = v.register === 'confirmed';

  if (v.state === 'red') {
    const named = v.problems
      .map((p) => p.code)
      .filter(Boolean)
      .filter((code, i, all) => all.indexOf(code) === i);
    const which = named.length ? ` Look at ${named.join(', ')}.` : '';

    /*
     * ═════════════════════════════════════════════════════════════════════════
     * TWO RED SENTENCES, AND ONLY ONE OF THEM IS REACHABLE TODAY
     * ═════════════════════════════════════════════════════════════════════════
     * The three sums PARTITION one set: every line's remainder lands in exactly
     * one of `projected` and `decided`, and `eob` is their union. So
     * `projected + decided === eob` holds by construction, and the only way to
     * be red is a PROBLEM.
     *
     * The imbalance sentence is therefore a BACKSTOP, not a state a biller can
     * reach — kept because the partition is a property of this loop rather than
     * of the world, and a later slice that lets a line be written off in PART
     * (deliberately not built: she has never split a line) would break it. If
     * that day comes the verdict says which two numbers disagree instead of
     * failing quietly, which is the direction this module always errs in.
     *
     * The first draft had this the other way round and printed the reachable
     * case in the unreachable sentence: "$480.00 here, $480.00 on the EOB" —
     * two identical numbers under a claim that they differ. A biller reading
     * that has no way to know which half to believe, which is exactly the copy
     * defect the pass/fail detail rule was written for one slice ago. The shot
     * caught it.
     */
    const balances = v.projectedPatientCents + v.decidedWriteOffCents === v.eobPatientCents;
    if (balances) {
      /*
       * …and the balanced case names the FAMILY of problem, because the two
       * families ask for opposite next steps: an unexplained write-off is fixed
       * on this screen in one click, and a chart that disagrees is fixed in Open
       * Dental. Telling a biller to go and look at Open Dental over a reason she
       * can pick here would send her out of the product for nothing.
       */
      const unexplained = v.problems.some((p) => p.kind === 'decision_missing_reason');
      return unexplained
        ? `Patient's number can't be trusted yet — a line is written off with nothing ` +
            `recorded about why.${which}`
        : `Patient's number can't be trusted yet — something on this claim does not line ` +
            `up with Open Dental.${which}`;
    }
    return (
      `Patient's number doesn't match the EOB — ${formatDollars(v.projectedPatientCents)} here, ` +
      `${formatDollars(v.eobPatientCents)} on the EOB.${which}`
    );
  }

  if (v.state === 'amber') {
    const codes = v.decisions
      .map((d) => d.code)
      .filter(Boolean)
      .filter((code, i, all) => all.indexOf(code) === i);
    const because = codes.length
      ? ` because you wrote off ${codes.join(', ')}`
      : ' because of a write-off you decided on';
    return confirmed
      ? `Patient owes ${formatDollars(v.projectedPatientCents)} — ` +
          `${formatDollars(v.decidedWriteOffCents)} below the EOB${because}. ` +
          'Confirmed in Open Dental.'
      : `Patient will owe ${formatDollars(v.projectedPatientCents)} — ` +
          `${formatDollars(v.decidedWriteOffCents)} below the EOB${because}.`;
  }

  return confirmed
    ? `Patient owes ${formatDollars(v.projectedPatientCents)} — confirmed in Open Dental.`
    : `Patient will owe ${formatDollars(v.projectedPatientCents)} once posted — matches the EOB.`;
}

module.exports = {
  LINE_DECISIONS,
  DEFAULT_LINE_DECISION,
  WRITEOFF_REASONS,
  REASON_LABELS,
  REGISTERS,
  VERDICT_STATES,
  PROBLEM_KINDS,
  formatDollars,
  lineMoney,
  decisionOf,
  isWriteoffReason,
  reasonLabel,
  verdictFor,
};
