'use strict';

/**
 * The money, held to its definition.
 *
 * Every other test in this slice — the gate's, the route's, the screen's —
 * trusts this file to be right about two subtractions and one sum. So the
 * definitions are asserted as a TABLE rather than as a handful of scenarios: a
 * row per shape of adjudication, with W and R written out, so the arithmetic can
 * be read against `docs/RCM_POSTING.md` without running anything.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const lineDecisions = require('./lineDecisions');
const migration = require('../../migrations-tenant/1787600000000_rcm_line_decisions');

const {
  LINE_DECISIONS,
  DEFAULT_LINE_DECISION,
  WRITEOFF_REASONS,
  formatDollars,
  lineMoney,
  decisionOf,
  isWriteoffReason,
  verdictFor,
} = lineDecisions;

/** A paired line with clean amounts, so a case only differs where it means to. */
function line(over = {}) {
  return {
    lineId: over.lineId || 'l-1',
    code: over.code || 'D0120',
    billedCents: 0,
    allowedCents: 0,
    paidCents: 0,
    decision: null,
    decisionReason: null,
    decidedBy: null,
    decidedAt: null,
    odClaimProcNum: 900001,
    odFeeDeltaCents: 0,
    ...over,
  };
}

// ─── The definitions, as a table ─────────────────────────────────────────────

/**
 * B / A / P → W (billed − allowed) and R (allowed − paid).
 *
 * The last three rows are the ones a clamp would get wrong: a carrier that
 * allowed MORE than was billed, one that paid more than it allowed, and a
 * straight denial. None of them is clamped, because hiding the case that most
 * needs a human to look at it is the failure this table exists to prevent.
 */
const MONEY_TABLE = [
  { name: 'an ordinary paid line', b: 15000, a: 10000, p: 8000, w: 5000, r: 2000 },
  { name: 'paid in full at the allowed rate', b: 15000, a: 10000, p: 10000, w: 5000, r: 0 },
  { name: 'no contract discount at all', b: 10000, a: 10000, p: 8000, w: 0, r: 2000 },
  { name: 'applied entirely to the deductible', b: 15000, a: 10000, p: 0, w: 5000, r: 10000 },
  { name: 'a zero-dollar line', b: 0, a: 0, p: 0, w: 0, r: 0 },
  { name: 'a denial — nothing allowed, nothing paid', b: 15000, a: 0, p: 0, w: 15000, r: 0 },
  { name: 'allowed MORE than billed', b: 10000, a: 12000, p: 12000, w: -2000, r: 0 },
  { name: 'paid MORE than allowed', b: 15000, a: 10000, p: 11000, w: 5000, r: -1000 },
];

for (const row of MONEY_TABLE) {
  test(`money: ${row.name} — B ${row.b} A ${row.a} P ${row.p}`, () => {
    const m = lineMoney({ billedCents: row.b, allowedCents: row.a, paidCents: row.p });
    assert.equal(m.contractualWriteOffCents, row.w, 'W = billed − allowed');
    assert.equal(m.patientRemainderCents, row.r, 'R = allowed − paid');
  });
}

test('money: a missing or unreadable amount is 0, never NaN', () => {
  const m = lineMoney({ billedCents: undefined, allowedCents: 'abc', paidCents: null });
  assert.equal(m.contractualWriteOffCents, 0);
  assert.equal(m.patientRemainderCents, 0);
});

// ─── The decision enum ───────────────────────────────────────────────────────

test('the two decisions are the two the migration CHECK holds', () => {
  /*
   * A value added to one and not the other is a 23514 discovered on a walk
   * night. Asserted rather than shared by import, because a service must not
   * take a migration as a runtime dependency.
   */
  assert.deepEqual([...LINE_DECISIONS], [...migration.LINE_DECISIONS]);
});

test('nobody-has-said reads as the default, and the default bills the patient', () => {
  assert.equal(DEFAULT_LINE_DECISION, 'bill_patient');
  assert.equal(decisionOf({ decision: null }), 'bill_patient');
  assert.equal(decisionOf({}), 'bill_patient');
  // An unrecognised value cannot be stored, and if it ever were, the outcome
  // that does not quietly move money is the one to fall back to.
  assert.equal(decisionOf({ decision: 'something_else' }), 'bill_patient');
  assert.equal(decisionOf({ decision: 'office_writeoff' }), 'office_writeoff');
});

test('exactly five canned reasons ship, and only those five are accepted', () => {
  assert.equal(WRITEOFF_REASONS.length, 5);
  assert.deepEqual(
    WRITEOFF_REASONS.map((r) => r.slug),
    ['xrays_bitewings', 'xrays_panoramic', 'xrays_other', 'not_chargeable', 'build_up']
  );
  for (const r of WRITEOFF_REASONS) assert.equal(isWriteoffReason(r.slug), true);
  assert.equal(isWriteoffReason('whatever_she_typed'), false);
  assert.equal(isWriteoffReason(''), false);
  assert.equal(isWriteoffReason(null), false);
});

// ─── The verdict, one test per state ─────────────────────────────────────────

test('GREEN — every line bills the patient, so the two numbers agree', () => {
  const v = verdictFor({
    register: 'projection',
    lines: [
      line({ lineId: 'a', code: 'D0120', billedCents: 15000, allowedCents: 10000, paidCents: 8000 }),
      line({ lineId: 'b', code: 'D1110', billedCents: 12000, allowedCents: 9000, paidCents: 9000 }),
    ],
  });
  assert.equal(v.state, 'green');
  assert.equal(v.eobPatientCents, 2000);
  assert.equal(v.projectedPatientCents, 2000);
  assert.equal(v.decidedWriteOffCents, 0);
  assert.equal(v.contractualWriteOffCents, 8000, 'the carrier took 5000 + 3000 by contract');
  assert.deepEqual(v.problems, []);
  assert.equal(v.sentence, 'Patient will owe $20.00 once posted — matches the EOB.');
});

test('AMBER — a line written off with a reason, and the sentence names it', () => {
  const v = verdictFor({
    register: 'projection',
    lines: [
      line({ lineId: 'a', code: 'D0120', billedCents: 15000, allowedCents: 10000, paidCents: 8000 }),
      line({
        lineId: 'b',
        code: 'D0274',
        billedCents: 6000,
        allowedCents: 4000,
        paidCents: 1000,
        decision: 'office_writeoff',
        decisionReason: 'xrays_bitewings',
        decidedBy: 'Billing User',
      }),
    ],
  });
  assert.equal(v.state, 'amber');
  assert.equal(v.eobPatientCents, 2000 + 3000, 'the EOB assigns the patient both remainders');
  assert.equal(v.projectedPatientCents, 2000, '…and only the billed one reaches them');
  assert.equal(v.decidedWriteOffCents, 3000);
  assert.deepEqual(v.problems, []);
  assert.equal(v.decisions.length, 1);
  assert.equal(v.decisions[0].code, 'D0274');
  assert.equal(v.decisions[0].reasonLabel, 'X-rays — bitewings');
  assert.equal(v.decisions[0].decidedBy, 'Billing User');
  assert.equal(
    v.sentence,
    'Patient will owe $20.00 — $30.00 below the EOB because you wrote off D0274.'
  );
});

test('AMBER holds the equation: projected + decided = EOB', () => {
  const v = verdictFor({
    register: 'projection',
    lines: [
      line({ lineId: 'a', billedCents: 15000, allowedCents: 10000, paidCents: 8000 }),
      line({
        lineId: 'b',
        billedCents: 6000,
        allowedCents: 4000,
        paidCents: 1000,
        decision: 'office_writeoff',
        decisionReason: 'build_up',
      }),
    ],
  });
  assert.equal(v.projectedPatientCents + v.decidedWriteOffCents, v.eobPatientCents);
});

test('RED — a write-off with NO reason recorded', () => {
  /*
   * Unreachable through the product: the route refuses it and
   * `rcm_procedure_lines_decision_reason_check` refuses it. It is asserted here
   * because `REASON_GATE`'s rule is the module's idiom — absent is blocking —
   * and a verdict function that silently accepted an unexplained write-off
   * would make both guards the only thing standing between a biller and a
   * chart that disagrees with the EOB for no recorded reason.
   */
  const v = verdictFor({
    register: 'projection',
    lines: [
      line({
        lineId: 'b',
        code: 'D0274',
        billedCents: 6000,
        allowedCents: 4000,
        paidCents: 1000,
        decision: 'office_writeoff',
        decisionReason: null,
      }),
    ],
  });
  assert.equal(v.state, 'red');
  assert.deepEqual(
    v.problems.map((p) => p.kind),
    ['decision_missing_reason']
  );
  /*
   * THE SENTENCE NAMES THE FAMILY, not two identical numbers.
   *
   * The sums here AGREE — 30.00 written off is 30.00 the patient no longer
   * owes — so the first draft printed "$0.00 here, $30.00 on the EOB"… no:
   * it printed the SAME figure twice, a sentence claiming two numbers differ
   * with both of them equal. A biller reading that has no way to know which
   * half to believe.
   */
  assert.match(v.sentence, /^Patient's number can't be trusted yet/);
  assert.match(v.sentence, /written off with nothing recorded about why/);
  assert.match(v.sentence, /Look at D0274\./);
  assert.doesNotMatch(v.sentence, /Open Dental/, 'the cause is here, not in the chart');
});

test("RED — Open Dental's fee is not what the carrier says was billed", () => {
  const v = verdictFor({
    register: 'projection',
    lines: [
      line({
        lineId: 'a',
        code: 'D2740',
        billedCents: 120000,
        allowedCents: 90000,
        paidCents: 72000,
        // We say 1200.00 was billed; the chart says 1150.00.
        odFeeDeltaCents: 5000,
      }),
    ],
  });
  assert.equal(v.state, 'red');
  assert.deepEqual(
    v.problems.map((p) => p.kind),
    ['od_fee_disagrees']
  );
  assert.match(
    v.problems[0].detail,
    /D2740 was billed \$1200\.00 on the remittance and \$1150\.00 in Open Dental/
  );
});

test('the three sums PARTITION one set, so an imbalance is unreachable', () => {
  /*
   * `projected + decided === eob` is a property of the loop, not of the world:
   * every line's remainder lands in exactly one of the first two, and the third
   * is their union. That is WHY the "doesn't match the EOB" sentence is a
   * backstop rather than a state a biller can reach, and it is asserted here so
   * that a later slice which breaks the partition — a part write-off, say —
   * fails this test rather than silently making a dead branch live.
   */
  for (const lines of [
    [line({ billedCents: 15000, allowedCents: 10000, paidCents: 8000 })],
    [
      line({ lineId: 'a', billedCents: 15000, allowedCents: 10000, paidCents: 8000 }),
      line({
        lineId: 'b',
        billedCents: 6000,
        allowedCents: 4000,
        paidCents: 1000,
        decision: 'office_writeoff',
        decisionReason: 'build_up',
      }),
    ],
    [line({ billedCents: 15000, allowedCents: 10000, paidCents: 11000 })],
  ]) {
    const v = verdictFor({ register: 'projection', lines });
    assert.equal(v.projectedPatientCents + v.decidedWriteOffCents, v.eobPatientCents);
    assert.doesNotMatch(v.sentence, /doesn't match the EOB/);
  }
});

test('a chart problem names OPEN DENTAL; an unexplained write-off does not', () => {
  /*
   * The two families ask for opposite next steps: an unexplained write-off is
   * fixed on this screen in one click, and a chart that disagrees is fixed in
   * Open Dental. Sending a biller out of the product over a reason she can pick
   * here would be a wasted trip.
   */
  const chartProblem = verdictFor({
    register: 'projection',
    lines: [line({ code: 'D2740', billedCents: 120000, allowedCents: 90000, paidCents: 72000, odFeeDeltaCents: 5000 })],
  });
  assert.match(chartProblem.sentence, /does not line up with Open Dental/);

  const missingReason = verdictFor({
    register: 'projection',
    lines: [
      line({
        code: 'D0274',
        billedCents: 6000,
        allowedCents: 4000,
        paidCents: 1000,
        decision: 'office_writeoff',
        decisionReason: null,
      }),
    ],
  });
  assert.match(missingReason.sentence, /written off with nothing recorded about why/);
  assert.doesNotMatch(missingReason.sentence, /Open Dental/);
});

test('RED — a line with no chart line at all', () => {
  const v = verdictFor({
    register: 'projection',
    lines: [line({ lineId: 'a', code: 'D0330', odClaimProcNum: null, odFeeDeltaCents: null })],
  });
  assert.equal(v.state, 'red');
  assert.deepEqual(
    v.problems.map((p) => p.kind),
    ['line_not_in_chart']
  );
});

test('a null fee delta is NOT a disagreement — nothing was compared', () => {
  /*
   * `null` means the pairing recorded no comparison (a snapshot written before
   * the field existed). Reading that as a zero-dollar agreement would be
   * confident about something nobody measured; reading it as a mismatch would
   * refuse every legacy claim. It is neither, and the verdict stays green.
   */
  const v = verdictFor({
    register: 'projection',
    lines: [
      line({ billedCents: 15000, allowedCents: 10000, paidCents: 8000, odFeeDeltaCents: null }),
    ],
  });
  assert.equal(v.state, 'green');
  assert.deepEqual(v.problems, []);
});

test('a line the patient owes nothing on carries no decision and no problem', () => {
  const v = verdictFor({
    register: 'projection',
    lines: [line({ billedCents: 15000, allowedCents: 10000, paidCents: 10000 })],
  });
  assert.equal(v.state, 'green');
  assert.equal(v.eobPatientCents, 0);
  assert.equal(v.sentence, 'Patient will owe $0.00 once posted — matches the EOB.');
});

// ─── The two registers ───────────────────────────────────────────────────────

test('a projection says "will owe … once posted"; a confirmation says "owes"', () => {
  const lines = [line({ billedCents: 15000, allowedCents: 10000, paidCents: 8000 })];
  const projected = verdictFor({ register: 'projection', lines });
  /*
   * B2: a confirmation is a MEASUREMENT. The same line, plus what Open Dental
   * came back holding — `FeeBilled 150 − InsPayAmt 80 − WriteOff 50 = 20`,
   * which is the projection landing exactly.
   */
  const confirmed = verdictFor({
    register: 'confirmed',
    lines: [{ ...lines[0], confirmedRemainderCents: 2000 }],
  });

  assert.match(projected.sentence, /will owe .* once posted — matches the EOB\.$/);
  assert.match(confirmed.sentence, /^Patient owes \$20\.00 — confirmed in Open Dental\.$/);
  // The numbers agree — but one was derived and the other was read back, and
  // that is the entire difference between the two sentences.
  assert.equal(projected.projectedPatientCents, confirmed.projectedPatientCents);
});

test('a confirmation over a line nobody read back is RED, not a confirmation', () => {
  /*
   * The trap this closes: a caller that flips the register to 'confirmed'
   * without gathering anything would have printed "confirmed in Open Dental"
   * over pure arithmetic — a projection wearing a confirmation's words, which
   * is the honest-states rule failing in the most expensive place there is.
   */
  const v = verdictFor({
    register: 'confirmed',
    lines: [line({ code: 'D0120', billedCents: 15000, allowedCents: 10000, paidCents: 8000 })],
  });
  assert.equal(v.state, 'red');
  assert.deepEqual(
    v.problems.map((p) => p.kind),
    ['line_not_confirmed']
  );
  assert.doesNotMatch(v.sentence, /confirmed in Open Dental/i);
});

test('a read-back that differs from what was promised names BOTH numbers', () => {
  /*
   * THE BACKSTOP SENTENCE, FINALLY REACHABLE.
   *
   * In the projection register `projected + decided === eob` holds by
   * construction — the three sums partition one set — so the imbalance wording
   * cannot print. Here the projected figure is MEASURED rather than derived, so
   * it can genuinely disagree: Open Dental came back saying the patient owes
   * $35.00 where the EOB says $20.00 (a write-off that did not land, say).
   *
   * This is B2's "Stuck — needs you": money has already moved, so the sentence
   * says what happens next rather than pretending nothing did.
   */
  const v = verdictFor({
    register: 'confirmed',
    lines: [
      line({
        code: 'D0120',
        billedCents: 15000,
        allowedCents: 10000,
        paidCents: 8000,
        confirmedRemainderCents: 3500,
      }),
    ],
  });
  assert.equal(v.state, 'red');
  assert.equal(
    v.sentence,
    'Open Dental says the patient owes $35.00 — this check said $20.00. ' +
      'This needs you before anything else posts. Look at D0120.'
  );
});

test('a projection can NEVER be worded as a confirmation', () => {
  for (const lines of [
    // green
    [line({ billedCents: 15000, allowedCents: 10000, paidCents: 8000 })],
    // amber
    [
      line({
        billedCents: 6000,
        allowedCents: 4000,
        paidCents: 1000,
        decision: 'office_writeoff',
        decisionReason: 'build_up',
      }),
    ],
    // red
    [line({ odClaimProcNum: null })],
  ]) {
    const projected = verdictFor({ register: 'projection', lines });
    assert.doesNotMatch(projected.sentence, /confirmed in Open Dental/i);
  }
});

test('the register is REQUIRED — there is no safe default', () => {
  /*
   * A caller that has not decided whether it is holding a projection or a
   * confirmation has not decided what its screen is claiming, and defaulting
   * either way would make one of the two wrong silently.
   */
  assert.throws(() => verdictFor({ lines: [] }), /register/);
  assert.throws(() => verdictFor({ lines: [], register: 'maybe' }), /register/);
});

test('an amber confirmation reads as a fact, not a forecast', () => {
  const v = verdictFor({
    register: 'confirmed',
    lines: [
      line({
        lineId: 'a',
        code: 'D0120',
        billedCents: 15000,
        allowedCents: 10000,
        paidCents: 8000,
        confirmedRemainderCents: 2000,
      }),
      /*
       * The written-off line reads ZERO out of the chart — the office's $30.00
       * landed — and that is the fact the confirmed amber sentence is asserting.
       */
      line({
        lineId: 'b',
        code: 'D0274',
        billedCents: 6000,
        allowedCents: 4000,
        paidCents: 1000,
        decision: 'office_writeoff',
        decisionReason: 'xrays_bitewings',
        confirmedRemainderCents: 0,
      }),
    ],
  });
  assert.equal(
    v.sentence,
    'Patient owes $20.00 — $30.00 below the EOB because you wrote off D0274. Confirmed in Open Dental.'
  );
});

// ─── The display formatter ───────────────────────────────────────────────────

test('formatDollars is two decimals, sign first, symbol second', () => {
  assert.equal(formatDollars(0), '$0.00');
  assert.equal(formatDollars(5), '$0.05');
  assert.equal(formatDollars(5408), '$54.08');
  assert.equal(formatDollars(5480), '$54.80');
  assert.equal(formatDollars(-350), '-$3.50');
  assert.equal(formatDollars(120000), '$1200.00');
  // Never NaN on the screen, whatever arrives.
  assert.equal(formatDollars(undefined), '$0.00');
  assert.equal(formatDollars('nope'), '$0.00');
});

test('formatDollars is NOT formatRecoupmentTotal — two jobs, two strings', () => {
  /*
   * One is a CONTRACT (the exact characters D-6 demands an approver types back,
   * so no symbol and no separators); the other is DISPLAY. They agree about the
   * digits and must differ about the symbol, and a future tidy-up that collapsed
   * them would either put a `$` into a typed confirmation or take it out of a
   * remittance figure.
   */
  const { formatRecoupmentTotal } = require('../../routes/rcm/approvalGate');
  assert.equal(formatRecoupmentTotal(-5408), '-54.08');
  assert.equal(formatDollars(-5408), '-$54.08');
});

// ─── B2: the decided figures, and where each mode books them ─────────────────

const { postedFigures, chartRemainderCents, WRITEOFF_MODES } = lineDecisions;

/** An approved posting line: the carrier's snapshot plus what was decided. */
function posted(over = {}) {
  return {
    intendedInsPayAmtCents: 8000,
    intendedWriteOffCents: 5000,
    intendedDedAppliedCents: 0,
    decidedWriteOffCents: null,
    ...over,
  };
}

test('the mode list agrees with the migration that constrains it', () => {
  assert.deepEqual([...WRITEOFF_MODES], [...migration.WRITEOFF_MODES]);
});

test('writeoff_field folds the decided amount into the claimproc write-off', () => {
  const f = postedFigures(posted({ decidedWriteOffCents: 2000 }), 'writeoff_field');
  assert.equal(f.insPayAmtCents, 8000);
  assert.equal(f.writeOffCents, 7000); // the carrier's $50 plus the office's $20
  assert.equal(f.adjustmentCents, 0);
});

test('adjustment_by_name leaves the carrier figure alone and books the rest separately', () => {
  const f = postedFigures(posted({ decidedWriteOffCents: 2000 }), 'adjustment_by_name');
  assert.equal(f.writeOffCents, 5000); // untouched: this is the CARRIER's number
  assert.equal(f.adjustmentCents, 2000);
});

test('a line nobody decided on posts identically under both modes', () => {
  for (const mode of WRITEOFF_MODES) {
    const f = postedFigures(posted(), mode);
    assert.equal(f.writeOffCents, 5000);
    assert.equal(f.adjustmentCents, 0);
  }
  // NULL is not zero in the column and does not become one here either.
  assert.equal(posted().decidedWriteOffCents, null);
});

test('THE INVARIANT: the mode chooses WHERE, never HOW MUCH', () => {
  /*
   * Written over the modes rather than over one worked example on purpose. A
   * third mode added later that quietly drops the decided amount is money
   * vanishing between a screen that promised it and a chart that never got it,
   * and this is the test that would go red.
   */
  for (const mode of WRITEOFF_MODES) {
    for (const decided of [null, 0, 1, 2000, 999999]) {
      const line = posted({ decidedWriteOffCents: decided });
      const f = postedFigures(line, mode);
      assert.equal(
        f.writeOffCents + f.adjustmentCents,
        line.intendedWriteOffCents + (decided || 0),
        `${mode} with ${decided} decided`
      );
      // And the carrier's payment is never touched by a decision about the
      // patient's remainder.
      assert.equal(f.insPayAmtCents, line.intendedInsPayAmtCents);
    }
  }
});

test('the mode is REQUIRED — there is no safe default', () => {
  assert.throws(() => postedFigures(posted(), undefined), /mode/);
  assert.throws(() => postedFigures(posted(), 'writeoff'), /mode/);
});

test("chartRemainderCents is Open Dental's own arithmetic, off the read-back", () => {
  // $150 billed, $80 paid, $50 written off → the patient owes $20.
  assert.equal(
    chartRemainderCents({ feeBilledCents: 15000, insPayAmtCents: 8000, writeOffCents: 5000 }),
    2000
  );
  // The same line under adjustment_by_name: the write-off field still holds the
  // carrier's $50, and the office's $20 came off the ledger instead.
  assert.equal(
    chartRemainderCents({
      feeBilledCents: 15000,
      insPayAmtCents: 8000,
      writeOffCents: 5000,
      adjustmentCents: 2000,
    }),
    0
  );
  // A deductible is part of what the patient owes, not a reduction of it, so
  // DedApplied is deliberately not an argument here at all.
});

test('two lines wrong in opposite directions do NOT pass on the total', () => {
  /*
   * The reason each line is checked as well as the sum. One line reads $10 high
   * and the other $10 low; the claim's total is exactly right, and nothing about
   * this claim is.
   */
  const v = verdictFor({
    register: 'confirmed',
    lines: [
      line({
        lineId: 'a',
        code: 'D0120',
        billedCents: 15000,
        allowedCents: 10000,
        paidCents: 8000,
        confirmedRemainderCents: 3000,
      }),
      line({
        lineId: 'b',
        code: 'D0274',
        billedCents: 6000,
        allowedCents: 4000,
        paidCents: 3000,
        confirmedRemainderCents: 0,
      }),
    ],
  });
  assert.equal(v.state, 'red');
  assert.equal(v.projectedPatientCents, 3000);
  assert.equal(v.eobPatientCents, 3000); // the total agrees, and it is still red
  assert.deepEqual(
    v.problems.map((p) => p.kind),
    ['chart_differs_from_decision', 'chart_differs_from_decision']
  );
  assert.match(v.sentence, /does not line up with Open Dental/);
});
