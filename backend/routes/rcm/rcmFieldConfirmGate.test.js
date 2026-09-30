'use strict';

/**
 * THE TWO FIELD-CONFIRM GATE CONDITIONS, over the PURE evaluator.
 *
 * `evaluateRemittance` is deliberately I/O-free, so these drive it directly with
 * rows rather than through the fake database. That is the right level for this
 * guard: what is under test is the DECISION — an OCR-sourced check cannot reach
 * approve while a money field is unconfirmed or the confirmed figures do not add
 * up to the cheque — and nothing about that decision depends on how the rows
 * were fetched.
 *
 * The route-level half (that `loadForApproval` actually reads the confirmation
 * rows, so the decision is made on real state) is asserted by
 * `approvalGate.test.js`'s existing end-to-end approve cases, which now travel
 * through the same code path with `provenance: null`.
 *
 * Every claim in here fails other conditions too — no match, not reviewed. That
 * is fine and deliberate: these tests assert the state of TWO named checks, not
 * that a claim is postable, so they cannot be broken by an unrelated condition
 * changing. `postable` is asserted only where it is the point.
 *
 * No real patient data: synthetic names and invented amounts throughout.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const approvalGate = require('./approvalGate');

const BATCH = '8acb0e32-35ae-5cd8-9692-7b5e318a31c2';
const CLAIM = 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d';
const CLAIM2 = 'ae21fad8-8cbb-5424-9780-b30be1cf31c9';
const LINE = 'a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90';
const ACTOR = 'user-key-1';

/** The five line-level confirmable fields, in vocabulary order. */
const LINE_FIELDS = ['line_paid', 'line_billed', 'line_allowed', 'line_deductible', 'line_copay'];

/**
 * A one-claim, one-line OCR remittance whose figures DO add up: the cheque is
 * for $184.00 and the single claim was paid $184.00.
 */
function remittance({ claimTotalPaidCents = 18400, checkTotalCents = 18400, claims = 1 } = {}) {
  const claimIds = claims === 2 ? [CLAIM, CLAIM2] : [CLAIM];
  const per = Math.round(claimTotalPaidCents / claimIds.length);
  return {
    office: 'roland',
    batch: {
      batchId: BATCH,
      officeId: 'roland',
      totalAmountCents: checkTotalCents,
      plbTotalCents: 0,
      flags: [],
    },
    claims: claimIds.map((claimId, i) => ({
      claimId,
      officeId: 'roland',
      patientName: `Synthetic, Patient ${i + 1}`,
      claimNumber: `SYNCLM000${i + 1}`,
      totalPaidCents: per,
      needsReviewReasons: [],
      postingQueueId: null,
      odClaimNum: null,
      matchSnapshot: null,
      reviewedAt: null,
    })),
    linesByClaim: new Map(claimIds.map((claimId) => [claimId, [{ lineId: LINE, paidCents: per }]])),
    paymentsByClaim: new Map(
      claimIds.map((claimId) => [claimId, { paidCents: per, batchClaimPaymentId: null }])
    ),
  };
}

/** Provenance that makes the confirm step apply. */
const FROM_A_SCAN = { textSource: 'ocr' };

/**
 * Confirmation rows covering every required field on a one-claim, one-line
 * check, each agreeing with what the read produced.
 */
function fullyConfirmed({ checkTotalCents = 18400, claimTotalPaidCents = 18400, claimId = CLAIM } = {}) {
  const rows = [
    {
      claim_id: null,
      line_id: null,
      field: 'check_total',
      state: 'confirmed',
      extracted_cents: checkTotalCents,
      confirmed_cents: checkTotalCents,
      confirmed_by: ACTOR,
      confirmed_at: null,
    },
    {
      claim_id: claimId,
      line_id: null,
      field: 'claim_total_paid',
      state: 'confirmed',
      extracted_cents: claimTotalPaidCents,
      confirmed_cents: claimTotalPaidCents,
      confirmed_by: ACTOR,
      confirmed_at: null,
    },
  ];
  for (const field of LINE_FIELDS) {
    rows.push({
      claim_id: claimId,
      line_id: LINE,
      field,
      state: 'confirmed',
      extracted_cents: 0,
      confirmed_cents: 0,
      confirmed_by: ACTOR,
      confirmed_at: null,
    });
  }
  return rows;
}

/** The named check off the first claim's checklist. */
function checkOn(result, code) {
  const found = result.claims[0].checks.find((c) => c.code === code);
  assert.ok(found, `the checklist must always carry ${code}, on every path`);
  return found;
}

// ─── An 835, and a PDF with its own text, are not confirmed ──────────────────

test('an 835 needs no confirm step — both conditions pass with nothing to say', () => {
  // `provenance: null` is what an 835 looks like: nothing was READ, the file was
  // parsed. Adding a confirm step to delimited data would be ceremony, and
  // ceremony is how billers learn a review step can be clicked through.
  const result = approvalGate.evaluateRemittance({ ...remittance(), provenance: null });

  assert.equal(result.fieldConfirm.required, false);
  assert.equal(checkOn(result, 'FIELDS_CONFIRMED').passed, true);
  assert.equal(checkOn(result, 'FIELDS_CONFIRMED').detail, null);
  assert.equal(checkOn(result, 'CONFIRMED_SUMS_TO_CHECK').passed, true);
  assert.equal(checkOn(result, 'CONFIRMED_SUMS_TO_CHECK').detail, null);
});

test('a PDF read from its own text layer needs no confirm step either', () => {
  // Only `ocr` triggers it. A digital payer-portal export was not squinted at.
  const result = approvalGate.evaluateRemittance({
    ...remittance(),
    provenance: { textSource: 'text_layer' },
  });
  assert.equal(result.fieldConfirm.required, false);
  assert.equal(checkOn(result, 'FIELDS_CONFIRMED').passed, true);
});

test('both conditions are on EVERY checklist, so neither can read as a missing check', () => {
  for (const provenance of [null, { textSource: 'text_layer' }, FROM_A_SCAN]) {
    const result = approvalGate.evaluateRemittance({ ...remittance(), provenance });
    assert.ok(approvalGate.CHECK_ORDER.includes('FIELDS_CONFIRMED'));
    assert.ok(approvalGate.CHECK_ORDER.includes('CONFIRMED_SUMS_TO_CHECK'));
    checkOn(result, 'FIELDS_CONFIRMED');
    checkOn(result, 'CONFIRMED_SUMS_TO_CHECK');
  }
});

// ─── A scan with nothing confirmed is withheld ───────────────────────────────

test('an OCR-sourced check with no confirmations is withheld, and says how many fields are outstanding', () => {
  const result = approvalGate.evaluateRemittance({
    ...remittance(),
    provenance: FROM_A_SCAN,
    confirmations: [],
  });

  assert.equal(result.fieldConfirm.required, true);
  const check = checkOn(result, 'FIELDS_CONFIRMED');
  assert.equal(check.passed, false);
  // One check total + one claim total + five line fields.
  assert.equal(result.fieldConfirm.confirmed.outstanding, 7);
  assert.match(check.detail, /7 money field\(s\)/);
  // The refusal names the RULE and what to do, not a wall.
  assert.match(check.fix, /confirm each one/);
  assert.equal(result.claims[0].postable, false);
});

test('a partly-confirmed check is still withheld, and the count shrinks as work is done', () => {
  const rows = fullyConfirmed();
  const result = approvalGate.evaluateRemittance({
    ...remittance(),
    provenance: FROM_A_SCAN,
    confirmations: rows.slice(0, 3),
  });
  assert.equal(checkOn(result, 'FIELDS_CONFIRMED').passed, false);
  assert.equal(result.fieldConfirm.confirmed.outstanding, 4);
});

test('every required field confirmed clears the first condition', () => {
  const result = approvalGate.evaluateRemittance({
    ...remittance(),
    provenance: FROM_A_SCAN,
    confirmations: fullyConfirmed(),
  });
  assert.equal(checkOn(result, 'FIELDS_CONFIRMED').passed, true);
  assert.equal(result.fieldConfirm.confirmed.outstanding, 0);
});

test('a second claim widens what must be confirmed, without anybody maintaining a list', () => {
  // `requiredFields` is derived from the rows, so a claim added by a
  // re-extraction is covered by construction.
  const result = approvalGate.evaluateRemittance({
    ...remittance({ claims: 2 }),
    provenance: FROM_A_SCAN,
    confirmations: fullyConfirmed({ claimTotalPaidCents: 9200 }),
  });
  // The second claim's total and its five line fields are still outstanding.
  assert.equal(result.fieldConfirm.confirmed.outstanding, 6);
  assert.equal(checkOn(result, 'FIELDS_CONFIRMED').passed, false);
});

// ─── THE CHECK IS THE ANCHOR ─────────────────────────────────────────────────

test('confirmed figures that sum to the cheque clear the second condition', () => {
  const result = approvalGate.evaluateRemittance({
    ...remittance(),
    provenance: FROM_A_SCAN,
    confirmations: fullyConfirmed(),
  });
  const sums = result.fieldConfirm.sums;
  assert.equal(sums.ok, true);
  assert.equal(sums.comparable, true);
  assert.equal(sums.differenceCents, 0);
  assert.equal(checkOn(result, 'CONFIRMED_SUMS_TO_CHECK').passed, true);
});

test('a confirmed claim total that does not reach the cheque is refused, with the difference in DOLLARS', () => {
  /*
   * THE REAL SHAPE OF THE BUG THIS CATCHES. The read put $1,229.00 on a line by
   * promoting its covered amount. Here a person has confirmed a claim total of
   * $1,229.00 against a cheque that is actually for $184.00 — so the anchor
   * refuses, and it names the gap rather than saying "does not reconcile".
   */
  const result = approvalGate.evaluateRemittance({
    ...remittance({ claimTotalPaidCents: 122900, checkTotalCents: 18400 }),
    provenance: FROM_A_SCAN,
    confirmations: fullyConfirmed({ claimTotalPaidCents: 122900, checkTotalCents: 18400 }),
  });

  const sums = result.fieldConfirm.sums;
  assert.equal(sums.ok, false);
  assert.equal(sums.comparable, true);
  assert.equal(sums.claimsTotalCents, 122900);
  assert.equal(sums.checkTotalCents, 18400);
  assert.equal(sums.differenceCents, 122900 - 18400);

  const check = checkOn(result, 'CONFIRMED_SUMS_TO_CHECK');
  assert.equal(check.passed, false);
  /*
   * DOLLARS, not cents — the biller is holding a cheque, not a database row.
   *
   * No thousands separator: `lineDecisions.formatDollars` is the module's one
   * money formatter and it does not add one. Asserted as it actually renders
   * rather than as it reads best, because the alternative is either a second
   * formatter (two ways to print money, which is how a screen and a refusal
   * start disagreeing) or editing the shared one, which this slice is not
   * allowed to touch.
   */
  assert.match(check.detail, /\$1229\.00/);
  assert.match(check.detail, /\$184\.00/);
  assert.match(check.detail, /difference of \$1045\.00/);
  assert.equal(result.claims[0].postable, false);
});

test('ONE CENT of disagreement is a refusal — there is no tolerance on the anchor', () => {
  /*
   * The extraction path allows a few cents of slack, which is right for a read
   * judging itself. This is a person reading a cheque and typing what is printed
   * on it, so a cent nobody can account for is a cent nobody can account for.
   */
  const result = approvalGate.evaluateRemittance({
    ...remittance({ claimTotalPaidCents: 18401, checkTotalCents: 18400 }),
    provenance: FROM_A_SCAN,
    confirmations: fullyConfirmed({ claimTotalPaidCents: 18401, checkTotalCents: 18400 }),
  });
  assert.equal(result.fieldConfirm.sums.ok, false);
  assert.equal(result.fieldConfirm.sums.differenceCents, 1);
  assert.match(checkOn(result, 'CONFIRMED_SUMS_TO_CHECK').detail, /difference of \$0\.01/);
});

test('a CORRECTION is what the sum is taken over — not the figure the read produced', () => {
  // The whole point of the screen: the biller types $184.00 over a read that
  // said $1,229.00, and the anchor then balances. If the sum were taken over the
  // extraction, correcting a figure could never clear the gate.
  const rows = fullyConfirmed({ claimTotalPaidCents: 18400, checkTotalCents: 18400 });
  const claimTotal = rows.find((r) => r.field === 'claim_total_paid');
  claimTotal.state = 'corrected';
  claimTotal.extracted_cents = 122900;
  claimTotal.confirmed_cents = 18400;

  const result = approvalGate.evaluateRemittance({
    ...remittance({ claimTotalPaidCents: 122900, checkTotalCents: 18400 }),
    provenance: FROM_A_SCAN,
    confirmations: rows,
  });
  assert.equal(result.fieldConfirm.sums.claimsTotalCents, 18400);
  assert.equal(result.fieldConfirm.sums.ok, true);
  assert.equal(checkOn(result, 'CONFIRMED_SUMS_TO_CHECK').passed, true);
});

test('an unconfirmed check total still ADDS UP — the other condition is what withholds it', () => {
  /*
   * A deliberate division of labour, and worth pinning because the alternative
   * looks tidier and is worse.
   *
   * `sumsToCheck` goes through `figure()`, which falls back to the extracted
   * value. So an anchor nobody has confirmed yet is still compared, using the
   * best figure available, and the arithmetic answer is the true one. What
   * withholds the check is `FIELDS_CONFIRMED`, which is the condition that
   * actually describes the problem: a person has not looked yet.
   *
   * Making the sum refuse as well would show a biller two failures for one piece
   * of undone work, and the second would name arithmetic that is fine.
   */
  const rows = fullyConfirmed().filter((r) => r.field !== 'check_total');
  const result = approvalGate.evaluateRemittance({
    ...remittance(),
    provenance: FROM_A_SCAN,
    confirmations: rows,
  });

  const sums = result.fieldConfirm.sums;
  assert.equal(sums.comparable, true);
  assert.equal(sums.ok, true);
  assert.equal(sums.checkTotalCents, 18400, 'the extracted anchor, used as the best figure we have');
  assert.equal(checkOn(result, 'CONFIRMED_SUMS_TO_CHECK').passed, true);

  // ...and the check is still withheld, by the condition that names the reason.
  assert.equal(checkOn(result, 'FIELDS_CONFIRMED').passed, false);
  assert.equal(result.claims[0].postable, false);
});

test('a cheque with no total stated at all cannot be added up, and no difference is invented', () => {
  /*
   * Treating a missing anchor as $0.00 would produce a dollar difference that is
   * an artefact of our own arithmetic, and send a biller hunting for it on the
   * page. "Nothing can be added up yet" is the true sentence.
   */
  const base = remittance();
  base.batch.totalAmountCents = null;
  const result = approvalGate.evaluateRemittance({
    ...base,
    provenance: FROM_A_SCAN,
    confirmations: fullyConfirmed().filter((r) => r.field !== 'check_total'),
  });

  const sums = result.fieldConfirm.sums;
  assert.equal(sums.comparable, false);
  assert.equal(sums.ok, false);
  assert.equal(sums.differenceCents, null, 'no difference may be named that was not computed');
  assert.equal(sums.claimsTotalCents, null);
  assert.match(checkOn(result, 'CONFIRMED_SUMS_TO_CHECK').detail, /not confirmed yet/);
});

test('a claim total confirmed as NOT STATED also makes the sum unknowable, never zero', () => {
  // A person read the page and there is genuinely no claim total on it. That is
  // a real answer — the field counts as confirmed — but it cannot be added up.
  const rows = fullyConfirmed();
  const claimTotal = rows.find((r) => r.field === 'claim_total_paid');
  claimTotal.state = 'corrected';
  claimTotal.confirmed_cents = null;

  const result = approvalGate.evaluateRemittance({
    ...remittance(),
    provenance: FROM_A_SCAN,
    confirmations: rows,
  });
  assert.equal(checkOn(result, 'FIELDS_CONFIRMED').passed, true, 'it IS confirmed');
  assert.equal(result.fieldConfirm.sums.comparable, false);
  assert.equal(result.fieldConfirm.sums.ok, false);
  assert.equal(result.fieldConfirm.sums.claimsTotalCents, null);
});

// ─── A line that states no payment ───────────────────────────────────────────

test('an unstated line payment is not summed as zero against the claim total', () => {
  /*
   * `CLAIM_TOTALS_AGREE` used to reduce with `n + l.paidCents`, which coerces
   * null to 0 and then reports "claim 18400, lines 0" — a refusal whose sentence
   * sends a biller to re-read a column that is correct. The claim is still
   * refused; what changed is that the sentence is true.
   */
  const base = remittance();
  base.linesByClaim = new Map([[CLAIM, [{ lineId: LINE, paidCents: null }]]]);

  const result = approvalGate.evaluateRemittance({ ...base, provenance: FROM_A_SCAN });
  const check = checkOn(result, 'CLAIM_TOTALS_AGREE');
  assert.equal(check.passed, false);
  assert.match(check.detail, /state no payment of their own/);
  assert.ok(!/lines 0/.test(check.detail), 'it must not claim the lines summed to zero');
});

test('a confirmation row outside the vocabulary is ignored, not trusted', () => {
  /*
   * The DB CHECK makes an unknown `field` unreachable through the route, so a
   * row carrying one means the constraint was bypassed — a restored dump, a
   * hand-run UPDATE, a migration rolled back halfway.
   *
   * Ignoring it degrades to "unconfirmed", which WITHHOLDS the check. Trusting
   * it would let an unknown slug carry a dollar figure into the sum the gate
   * reconciles against a cheque. The safe failure is the one that stops.
   */
  const rows = fullyConfirmed();
  const invented = { ...rows[1], field: 'line_invented', confirmed_cents: 999900 };
  const withoutClaimTotal = rows.filter((r) => r.field !== 'claim_total_paid');

  const result = approvalGate.evaluateRemittance({
    ...remittance(),
    provenance: FROM_A_SCAN,
    confirmations: [...withoutClaimTotal, invented],
  });

  // The invented row does not stand in for the real field it resembles.
  assert.equal(checkOn(result, 'FIELDS_CONFIRMED').passed, false);
  assert.equal(result.fieldConfirm.confirmed.outstanding, 1);
  assert.deepEqual(result.fieldConfirm.confirmed.first, {
    claimId: CLAIM,
    lineId: null,
    field: 'claim_total_paid',
  });

  // And its amount never reaches the sum: $9,999.00 would have swamped the anchor.
  assert.equal(result.fieldConfirm.sums.claimsTotalCents, 18400);
  assert.equal(result.fieldConfirm.sums.ok, true);
});

// ─── The category-subtotal document can actually be finished ─────────────────

test('a CONFIRMED absence of per-line payment clears CLAIM_TOTALS_AGREE, so the check is not a dead end', () => {
  /*
   * THE CASE THE WHOLE SLICE IS FOR, and the one this nearly walled off.
   *
   * A category-subtotal EOB states payment at a benefit-type subtotal and never
   * per line. `Σ(lines)` is not a number anybody printed. Before this, a biller
   * could work every field on the confirm screen — all seven — and still meet
   * `CLAIM_TOTALS_AGREE` refusing forever, over an absence she had just
   * confirmed. That is a wall, not a gate.
   *
   * What protects the money instead is the anchor: the claim total IS printed on
   * such a document, it IS confirmed against the page, and
   * CONFIRMED_SUMS_TO_CHECK reconciles it to the cheque exactly.
   */
  const base = remittance();
  base.linesByClaim = new Map([[CLAIM, [{ lineId: LINE, paidCents: null }]]]);

  const rows = fullyConfirmed();
  const linePaid = rows.find((r) => r.field === 'line_paid');
  linePaid.extracted_cents = null;
  linePaid.confirmed_cents = null;

  const result = approvalGate.evaluateRemittance({
    ...base,
    provenance: FROM_A_SCAN,
    confirmations: rows,
  });

  const check = checkOn(result, 'CLAIM_TOTALS_AGREE');
  assert.equal(check.passed, true);
  assert.match(check.detail, /states payment by category, not per line/);
  assert.match(check.detail, /stands on its own/);

  // The two confirm conditions are satisfied too, so nothing else withholds it.
  assert.equal(checkOn(result, 'FIELDS_CONFIRMED').passed, true);
  assert.equal(checkOn(result, 'CONFIRMED_SUMS_TO_CHECK').passed, true);
});

test('an UNCONFIRMED absence still fails — the reader guessed; nobody has answered', () => {
  const base = remittance();
  base.linesByClaim = new Map([[CLAIM, [{ lineId: LINE, paidCents: null }]]]);

  const result = approvalGate.evaluateRemittance({
    ...base,
    provenance: FROM_A_SCAN,
    confirmations: fullyConfirmed().filter((r) => r.field !== 'line_paid'),
  });

  const check = checkOn(result, 'CLAIM_TOTALS_AGREE');
  assert.equal(check.passed, false);
  assert.match(check.detail, /have not been checked against the page/);
});

test('the sum is taken over a CORRECTED line payment, not the figure the read produced', () => {
  // A person reads $52.00 off the page where the scan said nothing. The lines
  // then DO sum, and they have to sum to the claim total like any other check.
  const base = remittance({ claimTotalPaidCents: 5200, checkTotalCents: 5200 });
  base.linesByClaim = new Map([[CLAIM, [{ lineId: LINE, paidCents: null }]]]);

  const rows = fullyConfirmed({ claimTotalPaidCents: 5200, checkTotalCents: 5200 });
  const linePaid = rows.find((r) => r.field === 'line_paid');
  linePaid.state = 'corrected';
  linePaid.extracted_cents = null;
  linePaid.confirmed_cents = 5200;

  const result = approvalGate.evaluateRemittance({
    ...base,
    provenance: FROM_A_SCAN,
    confirmations: rows,
  });
  assert.equal(checkOn(result, 'CLAIM_TOTALS_AGREE').passed, true);
});

test('a corrected line payment that does NOT reach the claim total is still refused', () => {
  const base = remittance();
  base.linesByClaim = new Map([[CLAIM, [{ lineId: LINE, paidCents: null }]]]);

  const rows = fullyConfirmed();
  const linePaid = rows.find((r) => r.field === 'line_paid');
  linePaid.state = 'corrected';
  linePaid.extracted_cents = null;
  linePaid.confirmed_cents = 5200; // the claim total is 18400

  const result = approvalGate.evaluateRemittance({
    ...base,
    provenance: FROM_A_SCAN,
    confirmations: rows,
  });
  const check = checkOn(result, 'CLAIM_TOTALS_AGREE');
  assert.equal(check.passed, false);
  assert.match(check.detail, /lines 5200/);
});
