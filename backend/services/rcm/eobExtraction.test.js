'use strict';

/**
 * The pure extraction engine.
 *
 * Two jobs under test, and they are the two places a bad answer becomes a bad
 * claim row:
 *   NORMALIZATION — nothing the model returns reaches Postgres unexamined. Every
 *     value is coerced to something the column can hold, or dropped.
 *   DERIVATION — low confidence, placeholders, and failed arithmetic WIDEN
 *     review. Nothing here resolves an uncertainty; a flagged line is left
 *     exactly as the model read it.
 *
 * The fixtures below are entirely invented and carry no real patient, provider,
 * payer account or claim number. The two-claim case mirrors the source repo's
 * live acceptance shape (one bulk EFT covering two patients) without reusing
 * its names.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeExtraction,
  deriveClaimReviewReasons,
  deriveBatchReviewReasons,
  claimsPaidSum,
  EOB_EXTRACTION_SCHEMA,
  SYSTEM_PROMPT,
  buildUserPrompt,
  PLACEHOLDER_NPI,
  PLACEHOLDER_DOB,
  PLACEHOLDER_CHECK,
  PROCEDURE_FLAGS,
  CARC_GROUPS,
} = require('./eobExtraction');

const TODAY = '2026-08-14';

/** A clean, internally consistent one-claim remittance. */
function cleanDoc() {
  return {
    payment: {
      payer: 'Example Dental Plan',
      checkNumber: 'CHK-100200',
      checkDate: '2026-08-10',
      paymentMethod: 'eft',
      totalPaidCents: 20800,
    },
    confidence: 96,
    claims: [
      {
        patientName: 'Testpatient, Alpha',
        patientDOB: '1985-03-15',
        subscriberId: 'SUB-0001',
        groupNumber: 'GRP-4470',
        claimNumber: 'CLM-2026-1001',
        serviceDate: '2026-07-21',
        providerNPI: '1598324220',
        renderingProvider: 'Example Dental',
        totalBilledCents: 24000,
        totalAllowedCents: 20800,
        totalDeductibleCents: 0,
        totalCopayCents: 0,
        totalPaidCents: 20800,
        procedures: [
          {
            code: 'D0120',
            description: 'Periodic oral evaluation',
            billedCents: 5900,
            allowedCents: 5700,
            deductibleCents: 0,
            copayCents: 0,
            paidCents: 5700,
            confidence: 97,
            flags: [],
            adjustments: [
              {
                groupCode: 'CO',
                reasonCode: '45',
                reasonDescription: 'Charge exceeds fee schedule',
                amountCents: 200,
                remarkCode: '',
                remarkDescription: '',
              },
            ],
          },
          {
            code: 'D1110',
            description: 'Prophylaxis - adult',
            billedCents: 10800,
            allowedCents: 10600,
            deductibleCents: 0,
            copayCents: 0,
            paidCents: 10600,
            confidence: 95,
            flags: [],
            adjustments: [],
          },
          {
            code: 'D0274',
            description: 'Bitewing radiographs - 4 images',
            billedCents: 7300,
            allowedCents: 4500,
            deductibleCents: 0,
            copayCents: 0,
            paidCents: 4500,
            confidence: 93,
            flags: [],
            adjustments: [],
          },
        ],
      },
    ],
  };
}

// ─── The schema and prompt ───────────────────────────────────────────────────

test('the json schema is strict and closed at every level', () => {
  assert.equal(EOB_EXTRACTION_SCHEMA.strict, true);
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `${path} must be closed`);
      assert.deepEqual(
        Object.keys(node.properties).sort(),
        [...node.required].sort(),
        `${path}: strict mode requires every property to be listed in required`
      );
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`);
    }
    if (node.type === 'array') walk(node.items, `${path}[]`);
  };
  walk(EOB_EXTRACTION_SCHEMA.schema, 'root');
});

test('the prompt names the placeholders it asks the model to emit', () => {
  // The derivation flags these exact strings; if the prompt and the derivation
  // ever disagree, placeholders stop raising review reasons and start reading
  // as real values. This is the cheapest place to notice.
  assert.ok(SYSTEM_PROMPT.includes(PLACEHOLDER_NPI));
  assert.ok(SYSTEM_PROMPT.includes(PLACEHOLDER_DOB));
  assert.ok(SYSTEM_PROMPT.includes(PLACEHOLDER_CHECK));
});

test('the user prompt carries the document text verbatim', () => {
  const prompt = buildUserPrompt('PLAN PAID 208.00');
  assert.ok(prompt.includes('PLAN PAID 208.00'));
});

// ─── Normalization ───────────────────────────────────────────────────────────

test('a clean document normalizes without losing anything', () => {
  const out = normalizeExtraction(cleanDoc());
  assert.equal(out.claims.length, 1);
  assert.equal(out.payment.paymentMethod, 'eft');
  assert.equal(out.payment.totalPaidCents, 20800);
  assert.equal(out.claims[0].procedures.length, 3);
  assert.deepEqual(
    out.claims[0].procedures.map((p) => p.position),
    [0, 1, 2],
    'position must follow printed order — it is the claim/position unique key'
  );
  assert.equal(out.claims[0].procedures[0].adjustments.length, 1);
  assert.equal(out.claims[0].procedures[0].adjustments[0].groupCode, 'CO');
  assert.equal(out.claims[0].procedures[0].adjustments[0].remarkCode, null, 'empty RARC → null');
});

test('derived money is computed here, not taken from the model', () => {
  const out = normalizeExtraction(cleanDoc());
  const line = out.claims[0].procedures[2]; // billed 7300, allowed 4500
  assert.equal(line.adjustmentCents, 2800);
  assert.equal(line.writeOffCents, 2800);
  assert.equal(line.patientRespCents, 0);
});

test('a non-object result is refused rather than half-read', () => {
  for (const bad of [null, undefined, 'nope', 42, true]) {
    assert.throws(() => normalizeExtraction(bad), /EXTRACTION_MALFORMED|not a JSON object/);
  }
});

test('missing branches coerce to storable values instead of throwing', () => {
  const out = normalizeExtraction({});
  assert.deepEqual(out.claims, []);
  assert.equal(out.confidence, 0);
  assert.equal(out.payment.payer, '');
  assert.equal(out.payment.checkDate, null);
  assert.equal(out.payment.paymentMethod, null);
  assert.equal(out.payment.totalPaidCents, 0);
});

test('a date the column cannot hold becomes NULL, never a guess', () => {
  const doc = cleanDoc();
  doc.payment.checkDate = 'August 10th';
  doc.claims[0].serviceDate = '07/21/2026';
  doc.claims[0].patientDOB = '';
  const out = normalizeExtraction(doc);
  assert.equal(out.payment.checkDate, null);
  assert.equal(out.claims[0].serviceDate, null);
  assert.equal(out.claims[0].patientDOB, null);
});

test('paymentMethod outside the CHECK vocabulary becomes NULL', () => {
  for (const [given, expected] of [
    ['check', 'check'],
    ['EFT', 'eft'],
    ['virtual card', null],
    ['', null],
    [undefined, null],
  ]) {
    const doc = cleanDoc();
    doc.payment.paymentMethod = given;
    assert.equal(normalizeExtraction(doc).payment.paymentMethod, expected, `for ${given}`);
  }
});

test('a flag outside the CHECK vocabulary is dropped, and duplicates collapse', () => {
  const doc = cleanDoc();
  doc.claims[0].procedures[0].flags = ['denied', 'DENIED', 'low_confidence', 'sparkly', 'bundled'];
  const line = normalizeExtraction(doc).claims[0].procedures[0];
  assert.deepEqual(line.flags, ['denied', 'bundled']);
  for (const f of line.flags) assert.ok(PROCEDURE_FLAGS.includes(f));
});

test('an adjustment with no real CARC group is dropped, never coerced to CO', () => {
  const doc = cleanDoc();
  doc.claims[0].procedures[0].adjustments = [
    { groupCode: 'CO', reasonCode: '45', amountCents: 200 },
    { groupCode: 'XX', reasonCode: '45', amountCents: 100 }, // not a CARC group
    { groupCode: 'PR', reasonCode: '', amountCents: 100 }, // no reason code
    { groupCode: 'pr', reasonCode: '2', amountCents: 300 }, // case-insensitive
  ];
  const adjustments = normalizeExtraction(doc).claims[0].procedures[0].adjustments;
  assert.equal(adjustments.length, 2);
  assert.deepEqual(
    adjustments.map((a) => a.groupCode),
    ['CO', 'PR']
  );
  for (const a of adjustments) assert.ok(CARC_GROUPS.includes(a.groupCode));
});

test('confidence is clamped into 0..100', () => {
  const doc = cleanDoc();
  doc.confidence = 250;
  doc.claims[0].procedures[0].confidence = -40;
  doc.claims[0].procedures[1].confidence = 'very';
  const out = normalizeExtraction(doc);
  assert.equal(out.confidence, 100);
  assert.equal(out.claims[0].procedures[0].confidence, 0);
  assert.equal(out.claims[0].procedures[1].confidence, 0, 'unparseable confidence over-flags, not under');
});

// ─── Derivation ──────────────────────────────────────────────────────────────

test('a clean claim raises no review reasons', () => {
  const doc = normalizeExtraction(cleanDoc());
  const reasons = deriveClaimReviewReasons(doc.claims[0], doc.confidence, doc.payment, { today: TODAY });
  assert.deepEqual(reasons, [], `expected no reasons, got: ${reasons.join(', ')}`);
  assert.deepEqual(deriveBatchReviewReasons(doc), []);
});

test('every placeholder raises its own reason', () => {
  const raw = cleanDoc();
  raw.payment.checkNumber = PLACEHOLDER_CHECK;
  raw.claims[0].providerNPI = PLACEHOLDER_NPI;
  raw.claims[0].patientDOB = PLACEHOLDER_DOB;
  raw.claims[0].subscriberId = '';
  const doc = normalizeExtraction(raw);
  const reasons = deriveClaimReviewReasons(doc.claims[0], doc.confidence, doc.payment, { today: TODAY });
  for (const expected of ['missing_check_number', 'missing_npi', 'missing_dob', 'missing_subscriber_id']) {
    assert.ok(reasons.includes(expected), `expected ${expected} in ${reasons.join(', ')}`);
  }
});

test('low document confidence widens review; it never resolves anything', () => {
  const raw = cleanDoc();
  raw.confidence = 60;
  const doc = normalizeExtraction(raw);
  const reasons = deriveClaimReviewReasons(doc.claims[0], doc.confidence, doc.payment, { today: TODAY });
  assert.ok(reasons.includes('low_confidence'));
  // The numbers are untouched — nothing was "corrected" to compensate.
  assert.equal(doc.claims[0].totalPaidCents, 20800);
  assert.equal(doc.claims[0].procedures[0].paidCents, 5700);
});

test('an uncertain LINE is flagged by its printed position, 1-based', () => {
  const raw = cleanDoc();
  raw.claims[0].procedures[1].confidence = 40; // the second printed line
  const doc = normalizeExtraction(raw);
  const reasons = deriveClaimReviewReasons(doc.claims[0], doc.confidence, doc.payment, { today: TODAY });
  assert.ok(reasons.includes('uncertain_line:2'), reasons.join(', '));
  assert.ok(!reasons.includes('uncertain_line:1'));
  assert.ok(!reasons.includes('uncertain_line:3'));
});

test('arithmetic that does not reconcile is flagged, not silently accepted', () => {
  const raw = cleanDoc();
  raw.claims[0].totalPaidCents = 30000; // does not equal Σ procedure paid (20800)
  raw.claims[0].totalBilledCents = 90000; // nor Σ billed (24000)
  const doc = normalizeExtraction(raw);
  const reasons = deriveClaimReviewReasons(doc.claims[0], doc.confidence, doc.payment, { today: TODAY });
  assert.ok(reasons.includes('paid_total_mismatch'));
  assert.ok(reasons.includes('billed_total_mismatch'));
});

test('rounding noise inside the tolerance is NOT flagged', () => {
  const raw = cleanDoc();
  raw.claims[0].totalPaidCents = 20803; // 3¢ of source rounding noise
  const doc = normalizeExtraction(raw);
  const reasons = deriveClaimReviewReasons(doc.claims[0], doc.confidence, doc.payment, { today: TODAY });
  assert.ok(!reasons.includes('paid_total_mismatch'), reasons.join(', '));
});

test('a service date in the future, or unparseable, is flagged', () => {
  const future = normalizeExtraction(cleanDoc());
  future.claims[0].serviceDate = '2099-01-01';
  assert.ok(
    deriveClaimReviewReasons(future.claims[0], 96, future.payment, { today: TODAY }).includes(
      'service_date_in_future'
    )
  );

  const raw = cleanDoc();
  raw.claims[0].serviceDate = 'last Tuesday';
  const bad = normalizeExtraction(raw);
  assert.ok(
    deriveClaimReviewReasons(bad.claims[0], 96, bad.payment, { today: TODAY }).includes(
      'invalid_service_date'
    )
  );
});

test('a negative amount is flagged — an EOB that pays a negative is a misread', () => {
  const raw = cleanDoc();
  raw.claims[0].procedures[0].paidCents = -5700;
  const doc = normalizeExtraction(raw);
  assert.ok(
    deriveClaimReviewReasons(doc.claims[0], doc.confidence, doc.payment, { today: TODAY }).includes(
      'negative_amount'
    )
  );
});

test('a claim with no procedures is flagged rather than stored as a clean zero', () => {
  const raw = cleanDoc();
  raw.claims[0].procedures = [];
  const doc = normalizeExtraction(raw);
  assert.ok(
    deriveClaimReviewReasons(doc.claims[0], doc.confidence, doc.payment, { today: TODAY }).includes(
      'no_procedures_extracted'
    )
  );
});

test('a bulk check that does not balance is flagged at the batch level', () => {
  const raw = cleanDoc();
  // A second claim on the same $208.00 check — so Σ claims (416.00) no longer
  // equals the printed check total. This is the bulk-remittance failure mode
  // the source's reconcile-before-returning prompt exists to catch.
  raw.claims.push({ ...raw.claims[0], claimNumber: 'CLM-2026-1002', patientName: 'Testpatient, Beta' });
  const doc = normalizeExtraction(raw);
  assert.equal(doc.claims.length, 2);
  assert.equal(claimsPaidSum(doc), 41600);
  assert.deepEqual(deriveBatchReviewReasons(doc), ['batch_paid_total_mismatch']);
});

test('a balanced two-claim bulk check raises nothing', () => {
  const raw = cleanDoc();
  raw.claims.push({ ...raw.claims[0], claimNumber: 'CLM-2026-1002', patientName: 'Testpatient, Beta' });
  raw.payment.totalPaidCents = 41600;
  const doc = normalizeExtraction(raw);
  assert.deepEqual(deriveBatchReviewReasons(doc), []);
});

test('an extraction with no claims at all says so', () => {
  const doc = normalizeExtraction({ payment: {}, confidence: 90, claims: [] });
  assert.deepEqual(deriveBatchReviewReasons(doc), ['no_claims_extracted']);
});

// ─── COVERED IS NOT PAID ─────────────────────────────────────────────────────
//
// THE REAL CASE, as a fixture. The first genuine scanned EOB was a
// category-subtotal layout: it printed payment only at benefit-type subtotals
// and never per line. `paidCents` was a REQUIRED integer, so the model had no
// way to say "not stated" — and it filled each line with that line's COVERED
// amount. One line rendered a fabricated $1,229.00 paid. The claim totals were
// read correctly, the non-summing warnings fired, and approve was blocked, so no
// money moved. The numbers on screen were still invented.
//
// The schema now permits null and the prompt says when to use it. These pin both
// halves, plus the review reason that replaced the false mismatch.

/**
 * A category-subtotal claim: every line states billed and covered/allowed, none
 * states its own payment, and the CLAIM total is printed and correct.
 *
 * `allowedCents` is deliberately generous on the third line — 122900 is the
 * $1,229.00 that was once promoted into paid, so a regression that reinstates
 * the promotion produces that exact number again.
 */
function subtotalDoc() {
  const doc = cleanDoc();
  const claim = doc.claims[0];
  claim.totalBilledCents = 150000;
  claim.totalAllowedCents = 139100;
  claim.totalPaidCents = 139100;
  doc.payment.totalPaidCents = 139100;
  claim.procedures = [
    {
      code: 'D0120', description: 'Periodic oral evaluation',
      billedCents: 6500, allowedCents: 5200, deductibleCents: 0, copayCents: 0,
      paidCents: null, confidence: 88, flags: [], adjustments: [],
    },
    {
      code: 'D1110', description: 'Prophylaxis - adult',
      billedCents: 12000, allowedCents: 11000, deductibleCents: 0, copayCents: 0,
      paidCents: null, confidence: 86, flags: [], adjustments: [],
    },
    {
      code: 'D2750', description: 'Crown - porcelain/ceramic',
      billedCents: 131500, allowedCents: 122900, deductibleCents: 0, copayCents: 0,
      paidCents: null, confidence: 84, flags: [], adjustments: [],
    },
  ];
  return doc;
}

test('the schema lets a per-line payment be NOT STATED, because a required integer cannot', () => {
  const line =
    EOB_EXTRACTION_SCHEMA.schema.properties.claims.items.properties.procedures.items;
  assert.deepEqual(
    line.properties.paidCents.type,
    ['integer', 'null'],
    'a required integer is what forced the model to invent a number'
  );
  // Still REQUIRED — the model must answer, and null is the answer. Dropping it
  // from `required` would let the key go missing, which is indistinguishable
  // from a model that forgot to look.
  assert.ok(line.required.includes('paidCents'));
  // The claim total is NOT nullable: it stands alone and is always printed.
  const claim = EOB_EXTRACTION_SCHEMA.schema.properties.claims.items;
  assert.equal(claim.properties.totalPaidCents.type, 'integer');
});

test('the prompt forbids the promotion in the words that caused it', () => {
  assert.match(SYSTEM_PROMPT, /COVERED IS NOT PAID/);
  // The four column names a layout might print, each named so the model cannot
  // reason that only "covered" was meant.
  for (const word of ['allowed', 'covered', 'eligible', 'approved']) {
    assert.match(
      SYSTEM_PROMPT,
      new RegExp(`"${word}"`, 'i'),
      `the prompt must name the "${word}" column it must not copy`
    );
  }
  assert.match(SYSTEM_PROMPT, /subtotal/i, 'and it must name the layout that triggers null');
});

test('an unstated per-line payment stays NULL — it never becomes 0 and never becomes the covered amount', () => {
  const { claims } = normalizeExtraction(subtotalDoc());
  const lines = claims[0].procedures;

  for (const line of lines) {
    assert.equal(line.paidCents, null, `${line.code} must report no payment, not a number`);
  }
  // The specific fabrication, by value: $1,229.00 was the covered amount on the
  // crown line and the figure that reached the screen.
  assert.notEqual(lines[2].paidCents, 122900, 'the covered amount must not reappear as paid');
  // And the covered amounts themselves are untouched — they ARE on the page.
  assert.deepEqual(lines.map((l) => l.allowedCents), [5200, 11000, 122900]);
  // The claim total is read from the document and stands alone.
  assert.equal(claims[0].totalPaidCents, 139100);
});

test('every falsy and malformed paid value becomes null, and a real 0 stays 0', () => {
  const doc = cleanDoc();
  // A stated zero is DATA: the plan adjudicated this line and paid nothing.
  // It must survive, or "denied" becomes indistinguishable from "not printed".
  doc.claims[0].procedures[0].paidCents = 0;
  doc.claims[0].procedures[1].paidCents = undefined;
  doc.claims[0].procedures[2].paidCents = 'not a number';
  const lines = normalizeExtraction(doc).claims[0].procedures;
  assert.equal(lines[0].paidCents, 0, 'a stated zero payment is not an absent one');
  assert.equal(lines[1].paidCents, null);
  assert.equal(lines[2].paidCents, null);
});

test('derived money does not depend on the payment, so it survives an unstated one', () => {
  // billed − allowed, and deductible + copay. Neither reads paid, which is why a
  // subtotal layout still produces a usable write-off and patient-responsibility
  // figure. A derivation that reached for paid would have had to invent one.
  const lines = normalizeExtraction(subtotalDoc()).claims[0].procedures;
  assert.equal(lines[2].writeOffCents, 131500 - 122900);
  assert.equal(lines[2].adjustmentCents, 131500 - 122900);
  assert.equal(lines[2].patientRespCents, 0);
});

test('unstated line payments raise line_paid_not_stated, NOT a false paid_total_mismatch', () => {
  const doc = subtotalDoc();
  const reasons = deriveClaimReviewReasons(doc.claims[0], doc.confidence, doc.payment, {
    today: TODAY,
  });
  assert.ok(reasons.includes('line_paid_not_stated'), 'the layout fact has to be said out loud');
  assert.ok(
    !reasons.includes('paid_total_mismatch'),
    'the printed numbers do not disagree — one of them was never printed, and ' +
      'paid_total_mismatch sends a biller to hunt an error that is not there'
  );
  // Σ(line paid) is undefined, not zero, so it cannot be a negative amount either.
  assert.ok(!reasons.includes('negative_amount'));
});

test('a stated-but-not-summing claim still raises paid_total_mismatch', () => {
  // The other branch, kept honest: when the document states EVERY line payment
  // and they do not reach the claim total, that IS a disagreement between
  // printed figures, and the old reason is the right one.
  const doc = cleanDoc();
  doc.claims[0].procedures[0].paidCents = 100;
  const reasons = deriveClaimReviewReasons(doc.claims[0], doc.confidence, doc.payment, {
    today: TODAY,
  });
  assert.ok(reasons.includes('paid_total_mismatch'));
  assert.ok(!reasons.includes('line_paid_not_stated'));
});

test('one unstated line among stated ones is enough to stop the sum being claimed', () => {
  // A partial layout — some categories broken out, one not. The sum is still not
  // a sum, so it is still not checked.
  const doc = cleanDoc();
  doc.claims[0].procedures[1].paidCents = null;
  const reasons = deriveClaimReviewReasons(doc.claims[0], doc.confidence, doc.payment, {
    today: TODAY,
  });
  assert.ok(reasons.includes('line_paid_not_stated'));
  assert.ok(!reasons.includes('paid_total_mismatch'));
});

test('a genuinely negative stated payment is still caught beside an unstated one', () => {
  const doc = cleanDoc();
  doc.claims[0].procedures[0].paidCents = null;
  doc.claims[0].procedures[1].paidCents = -500;
  const reasons = deriveClaimReviewReasons(doc.claims[0], doc.confidence, doc.payment, {
    today: TODAY,
  });
  assert.ok(reasons.includes('negative_amount'), 'null must not mask a real negative');
  assert.ok(reasons.includes('line_paid_not_stated'));
});

test('the check total is still checked against the claim totals on a subtotal layout', () => {
  // The whole safety story for this layout: per-line payment is unknown, but the
  // claim total and the check total are both printed, and they still must agree.
  const doc = subtotalDoc();
  const extracted = normalizeExtraction(doc);
  assert.deepEqual(deriveBatchReviewReasons(extracted), []);
  assert.equal(claimsPaidSum(extracted), 139100);

  extracted.payment.totalPaidCents = 140000;
  assert.deepEqual(deriveBatchReviewReasons(extracted), ['batch_paid_total_mismatch']);
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE TWO-ROW DRAFT LAYOUT FAMILY
// ═══════════════════════════════════════════════════════════════════════════════
//
// A scanned multi-patient "draft" remittance whose column headers print at the
// top of EVERY page and govern the header-less claim blocks below them. Every
// service line is TWO physical rows — the allowance prints directly under its
// own charge — amount and code share one cell, claims continue across pages
// under a repeated header with the same claim number, and the document prints
// its own answer key (a Claim Totals row per claim, an EOB total, a draft
// amount).
//
// EVERY FIXTURE HERE IS FICTIONAL: invented names, invented ids, invented
// amounts, arithmetic worked so the document is internally consistent. No real
// remittance, patient or payer appears in this repo.
//
// The family is recognized by SHAPE, never by a payer name — nothing in the
// prompt or the derivation keys on who sent the document.

/**
 * One claim from the family, read CORRECTLY, as worked arithmetic:
 *
 *   line 1  charge 126.00 / allowance 101.80 (row 2, under its own charge)
 *           non-chargeable  24.20 /N01   MAC differential -> contractual write-off
 *           sub liability   12.80 / C1   coinsurance      -> patient responsibility
 *           paid to provider 89.00       (101.80 - 12.80)
 *   line 2  charge  74.00 / allowance  74.00
 *           sub liability   74.00 / H1   rejected but BILLABLE -> patient owes it
 *           paid to provider 0.00        (the plan paid nothing - a STATED zero)
 *
 *   Claim Totals   charge 200.00 - allowance 175.80 - liability 86.80 - paid 89.00
 *   EOB total / draft amount: 89.00
 */
function draftFamilyDoc() {
  return {
    payment: {
      payer: 'Fictional Dental Benefit Plan',
      // The draft number repeats in every page header and on the draft itself.
      checkNumber: 'DRAFT-7781234',
      checkDate: '2026-08-05',
      paymentMethod: 'check',
      totalPaidCents: 8900,
    },
    // A scan: this family only ever arrives as one.
    confidence: 78,
    claims: [
      {
        patientName: 'Quillfeather, Marisol',
        patientDOB: '2011-06-02',
        // The family shares one subscriber; the PATIENT is the claim's own.
        subscriberId: 'FICT-44120',
        groupNumber: 'GRP-0099',
        claimNumber: 'DCLM-5500871',
        serviceDate: '2026-07-28',
        providerNPI: '1598324220',
        renderingProvider: 'Example Dental Group',
        totalBilledCents: 20000,
        totalAllowedCents: 17580,
        totalDeductibleCents: 0,
        totalCopayCents: 8680,
        totalPaidCents: 8900,
        procedures: [
          {
            code: 'D2392',
            description: 'Resin-based composite - two surfaces, posterior',
            billedCents: 12600,
            allowedCents: 10180,
            deductibleCents: 0,
            copayCents: 1280,
            paidCents: 8900,
            excludedFromTotals: false,
            confidence: 82,
            flags: [],
            adjustments: [
              {
                groupCode: 'CO',
                reasonCode: '45',
                reasonDescription: 'Charge exceeds maximum allowable (N01)',
                amountCents: 2420,
                remarkCode: '',
                remarkDescription: '',
              },
              {
                groupCode: 'PR',
                reasonCode: '2',
                reasonDescription: 'Coinsurance (C1)',
                amountCents: 1280,
                remarkCode: '',
                remarkDescription: '',
              },
            ],
          },
          {
            code: 'D9110',
            description: 'Palliative treatment of dental pain',
            billedCents: 7400,
            allowedCents: 7400,
            deductibleCents: 0,
            copayCents: 7400,
            paidCents: 0,
            excludedFromTotals: false,
            confidence: 80,
            flags: ['not_covered'],
            adjustments: [
              {
                groupCode: 'PR',
                reasonCode: '96',
                reasonDescription: 'Non-covered, billable to patient (H1)',
                amountCents: 7400,
                remarkCode: '',
                remarkDescription: '',
              },
            ],
          },
        ],
      },
    ],
  };
}

/** The second physical row's allowance, by printed line position. */
function allowancesOf(claim) {
  return claim.procedures.map((p) => p.allowedCents);
}

// ─── The prompt teaches the family by its SHAPE ──────────────────────────────

test('the prompt teaches the two-row family by shape, never by a payer name', () => {
  // A trigger keyed on a payer would miss the next payer printing the same
  // table, and would misfire on this one's other forms.
  assert.match(SYSTEM_PROMPT, /TWO-ROW DRAFT TABLE/i);
  assert.match(SYSTEM_PROMPT, /by its SHAPE, never by the payer's name/i);
  for (const shape of [
    /TOP OF EACH PAGE/i,
    /TWO PHYSICAL ROWS/i,
    /DIRECTLY UNDER/i,
    /NEVER with a neighbouring line's charge/i,
    /AMOUNT AND CODE SHARE A CELL/i,
    /legend/i,
    /AMOUNT PAID TO PROVIDER/i,
    /CONTINUE ON THE NEXT PAGE/i,
    /SAME claim number/i,
    /PATIENT IS NOT SUBSCRIBER/i,
    /CLAIM SPECIFIC MESSAGE/i,
    /ANSWER KEY/i,
  ]) {
    assert.match(SYSTEM_PROMPT, shape, `the prompt must name: ${shape}`);
  }
  // And it must not have learned the shape by learning a name.
  assert.doesNotMatch(SYSTEM_PROMPT, /blue ?cross|blue ?shield|arkansas/i);
});

test('the prompt keeps BOTH families: per-line paid here, null on a subtotal layout', () => {
  // The two rules live side by side and neither weakens the other.
  assert.match(SYSTEM_PROMPT, /COVERED IS NOT PAID/);
  assert.match(SYSTEM_PROMPT, /THIS FAMILY STATES PAYMENT PER LINE/i);
  assert.match(
    SYSTEM_PROMPT,
    /Category-subtotal layouts still take null per line/i,
    'the per-line rule must say out loud that it does not repeal the subtotal rule'
  );
  assert.match(
    SYSTEM_PROMPT,
    /paid to the SUBSCRIBER is not a payment to the provider/i,
    'the other paid column must be refused by name'
  );
  assert.match(SYSTEM_PROMPT, /NEVER adjust a figure to force agreement/i);
});

// ─── (B) the two-row line: one line, its own allowance ───────────────────────

test('a correctly paired two-row claim reconciles against its printed Claim Totals', () => {
  const extracted = normalizeExtraction(draftFamilyDoc());
  const claim = extracted.claims[0];

  assert.equal(claim.procedures.length, 2, 'two LINES, not four rows');
  assert.deepEqual(allowancesOf(claim), [10180, 7400], 'each allowance under its own charge');
  assert.deepEqual(
    deriveClaimReviewReasons(claim, extracted.confidence, extracted.payment, { today: TODAY }),
    ['low_confidence'],
    'a scan is low-confidence and nothing else about it is wrong'
  );
  assert.deepEqual(deriveBatchReviewReasons(extracted), [], 'and it balances to the draft');
});

test('a MISPAIRED allowance is caught by the claim total the document itself prints', () => {
  /*
   * The classic misread of this layout: walking the two-row pairs, the model
   * loses its place and files line 2's allowance under line 1 as well — so
   * 101.80 is lost and 74.00 is used twice. The charges are untouched, so the
   * billed sum still agrees; the ALLOWANCE sum does not, and the Claim Totals
   * row is the answer key that says so.
   */
  const doc = draftFamilyDoc();
  doc.claims[0].procedures[0].allowedCents = 7400; // was 10180
  const extracted = normalizeExtraction(doc);
  const claim = extracted.claims[0];
  const reasons = deriveClaimReviewReasons(claim, extracted.confidence, extracted.payment, {
    today: TODAY,
  });

  assert.ok(
    reasons.includes('claim_line_allowed_mismatch'),
    'the mispairing must raise the allowed-total reason'
  );
  // NOTHING WAS REPAIRED. The honest (wrong) read is what is stored.
  assert.deepEqual(allowancesOf(claim), [7400, 7400]);
  assert.equal(claim.totalAllowedCents, 17580, 'the printed total is stored as printed');
});

test('a claim printing no allowed total is not flagged for an allowance it never stated', () => {
  const doc = draftFamilyDoc();
  doc.claims[0].totalAllowedCents = 0;
  const extracted = normalizeExtraction(doc);
  const reasons = deriveClaimReviewReasons(
    extracted.claims[0],
    extracted.confidence,
    extracted.payment,
    { today: TODAY }
  );
  assert.ok(!reasons.includes('claim_line_allowed_mismatch'));
});

// ─── (C) the shared amount/code cell decides whose money it is ───────────────

test('a shared amount/code cell lands the money where its code says, never elsewhere', () => {
  /*
   * "24.20 /N01" is a MAC differential: a CONTRACTUAL write-off, never the
   * patient's. "12.80 / C1" is coinsurance: the patient's. "74.00 / H1" is
   * rejected-but-billable: also the patient's, and the plan pays nothing.
   *
   * The derivation is what gives those meanings teeth — write-off is
   * billed − allowed and patient responsibility is deductible + copay — so a
   * code mapped into the wrong field moves money between the practice and the
   * patient, and these are the figures that would show it.
   */
  const extracted = normalizeExtraction(draftFamilyDoc());
  const [mac, nonCovered] = extracted.claims[0].procedures;

  // N01 — the whole non-chargeable amount is the practice's write-off.
  assert.equal(mac.writeOffCents, 2420);
  assert.equal(mac.adjustmentCents, 2420);
  // C1 — and only the coinsurance is the patient's.
  assert.equal(mac.patientRespCents, 1280);
  assert.equal(mac.paidCents, 8900, 'paid comes from AMOUNT PAID TO PROVIDER');

  // H1 — rejected but billable: the patient owes the charge, the plan paid 0,
  // and a STATED zero is a payment of zero, not an unstated figure (#212).
  assert.equal(nonCovered.writeOffCents, 0, 'a billable rejection is not a write-off');
  assert.equal(nonCovered.patientRespCents, 7400);
  assert.equal(nonCovered.paidCents, 0);
  assert.notEqual(nonCovered.paidCents, null);
});

test('the patient of a claim is the Patient field, never the shared subscriber', () => {
  // Two siblings on one subscriber: a claim that took the subscriber's name
  // would file one child's treatment under the other's chart.
  const doc = draftFamilyDoc();
  const sibling = JSON.parse(JSON.stringify(doc.claims[0]));
  sibling.claimNumber = 'DCLM-5500872';
  sibling.patientName = 'Quillfeather, Tobias';
  doc.claims.push(sibling);
  doc.payment.totalPaidCents = 17800;

  const extracted = normalizeExtraction(doc);
  assert.deepEqual(
    extracted.claims.map((c) => c.patientName),
    ['Quillfeather, Marisol', 'Quillfeather, Tobias'],
    'different patients, one subscriber — two claims, two names'
  );
  assert.equal(
    new Set(extracted.claims.map((c) => c.subscriberId)).size,
    1,
    'and they do share the subscriber id'
  );
  assert.match(
    SYSTEM_PROMPT,
    /never put the subscriber's name in patientName/i,
    'the prompt must say it too — derivation cannot tell the two names apart'
  );
});

// ─── (D) a claim that continues on the next page is ONE claim ────────────────

test('a claim continued on the next page merges into ONE claim, lines in printed order', () => {
  /*
   * The continuation block repeats the header with the SAME claim number and
   * carries no Claim Totals row of its own (its required integers arrive as
   * zeros). Left split, the first claim's lines come up short, the second's
   * totals are zeros, and the batch arithmetic counts the claim twice.
   */
  const doc = draftFamilyDoc();
  const continuation = JSON.parse(JSON.stringify(doc.claims[0]));
  for (const f of [
    'totalBilledCents',
    'totalAllowedCents',
    'totalDeductibleCents',
    'totalCopayCents',
    'totalPaidCents',
  ]) {
    continuation[f] = 0;
  }
  continuation.procedures = [
    {
      code: 'D0220',
      description: 'Intraoral periapical first radiographic image',
      billedCents: 3000,
      allowedCents: 2400,
      deductibleCents: 0,
      copayCents: 0,
      paidCents: 2400,
      excludedFromTotals: false,
      confidence: 81,
      flags: [],
      adjustments: [],
    },
  ];
  doc.claims.push(continuation);
  // The Claim Totals row attaches wherever it appears — here, to the first block.
  doc.claims[0].totalBilledCents = 23000;
  doc.claims[0].totalAllowedCents = 19980;
  doc.claims[0].totalPaidCents = 11300;
  doc.payment.totalPaidCents = 11300;

  const extracted = normalizeExtraction(doc);
  assert.equal(extracted.claims.length, 1, 'ONE claim number, ONE claim');
  const claim = extracted.claims[0];
  assert.deepEqual(
    claim.procedures.map((p) => p.code),
    ['D2392', 'D9110', 'D0220'],
    'all three lines, in printed order'
  );
  assert.deepEqual(
    claim.procedures.map((p) => p.position),
    [0, 1, 2],
    're-positioned, so uncertain_line:N still points at a countable row'
  );
  assert.equal(claim.totalPaidCents, 11300, 'the printed totals, from the block that carries them');
  assert.deepEqual(
    deriveClaimReviewReasons(claim, extracted.confidence, extracted.payment, { today: TODAY }),
    ['low_confidence'],
    'merged, the claim reconciles'
  );
  assert.deepEqual(deriveBatchReviewReasons(extracted), [], 'and the check is not double-counted');
});

test('a split claim left unmerged would have been flagged — the merge is what fixes it', () => {
  // The counterfactual, so the merge is shown to be load-bearing rather than
  // merely tidy: the same two blocks, summed as two claims, disagree with the
  // draft and with their own totals.
  const doc = draftFamilyDoc();
  const continuation = JSON.parse(JSON.stringify(doc.claims[0]));
  continuation.claimNumber = 'DCLM-5500871-PAGE2';
  for (const f of [
    'totalBilledCents',
    'totalAllowedCents',
    'totalDeductibleCents',
    'totalCopayCents',
    'totalPaidCents',
  ]) {
    continuation[f] = 0;
  }
  continuation.procedures = [
    {
      code: 'D0220',
      description: 'Intraoral periapical first radiographic image',
      billedCents: 3000,
      allowedCents: 2400,
      deductibleCents: 0,
      copayCents: 0,
      paidCents: 2400,
      excludedFromTotals: false,
      confidence: 81,
      flags: [],
      adjustments: [],
    },
  ];
  doc.claims.push(continuation);
  doc.claims[0].totalBilledCents = 23000;
  doc.claims[0].totalAllowedCents = 19980;
  doc.claims[0].totalPaidCents = 11300;
  doc.payment.totalPaidCents = 11300;

  const extracted = normalizeExtraction(doc);
  assert.equal(extracted.claims.length, 2, 'a different number is a different claim');
  const first = deriveClaimReviewReasons(
    extracted.claims[0],
    extracted.confidence,
    extracted.payment,
    { today: TODAY }
  );
  assert.ok(first.includes('paid_total_mismatch'), 'the first block is short of its own total');
  assert.ok(first.includes('billed_total_mismatch'), 'and short of its charges too');

  /*
   * And the second block is a PHANTOM CLAIM: real lines, and a Claim Totals row
   * of zeros because the continuation never printed one. It is flagged as well —
   * which is the point. Note what the BATCH check cannot see: 11300 + 0 still
   * equals the draft, so the outer answer key balances while two claims are
   * wrong. Nothing but the merge puts this document right.
   */
  const second = deriveClaimReviewReasons(
    extracted.claims[1],
    extracted.confidence,
    extracted.payment,
    { today: TODAY }
  );
  assert.ok(second.includes('paid_total_mismatch'), 'the phantom claim pays against a zero total');
  assert.equal(extracted.claims[1].totalPaidCents, 0);
  assert.deepEqual(
    deriveBatchReviewReasons(extracted),
    [],
    'the batch key is blind to a split, because the zeros still add to the draft'
  );
});

test('the Claim Totals row attaches wherever it appears — including on the continuation', () => {
  /*
   * The other way round, and the common one: the first page's block runs out of
   * room, so it prints LINES AND NO TOTALS, and the Claim Totals row prints on
   * the next page under the repeated header. The merged claim must take the
   * printed totals from whichever block carries them — a merge that only ever
   * kept the first block's zeros would report a claim that was paid nothing and
   * flag every sum against it.
   */
  const doc = draftFamilyDoc();
  const continuation = JSON.parse(JSON.stringify(doc.claims[0]));

  // Page 1: two lines, no Claim Totals row yet.
  for (const f of [
    'totalBilledCents',
    'totalAllowedCents',
    'totalDeductibleCents',
    'totalCopayCents',
    'totalPaidCents',
  ]) {
    doc.claims[0][f] = 0;
  }
  // Page 2: the third line AND the claim's printed totals.
  continuation.procedures = [
    {
      code: 'D0220',
      description: 'Intraoral periapical first radiographic image',
      billedCents: 3000,
      allowedCents: 2400,
      deductibleCents: 0,
      copayCents: 0,
      paidCents: 2400,
      excludedFromTotals: false,
      confidence: 81,
      flags: [],
      adjustments: [],
    },
  ];
  continuation.totalBilledCents = 23000;
  continuation.totalAllowedCents = 19980;
  continuation.totalDeductibleCents = 0;
  continuation.totalCopayCents = 8680;
  continuation.totalPaidCents = 11300;
  doc.claims.push(continuation);
  doc.payment.totalPaidCents = 11300;

  const extracted = normalizeExtraction(doc);
  assert.equal(extracted.claims.length, 1);
  const claim = extracted.claims[0];
  assert.equal(claim.totalPaidCents, 11300, 'the totals came from the block that printed them');
  assert.equal(claim.totalBilledCents, 23000);
  assert.equal(claim.totalAllowedCents, 19980);
  assert.deepEqual(
    claim.procedures.map((p) => p.code),
    ['D2392', 'D9110', 'D0220'],
    'and the lines are still in printed order'
  );
  assert.deepEqual(
    deriveClaimReviewReasons(claim, extracted.confidence, extracted.payment, { today: TODAY }),
    ['low_confidence'],
    'so the merged claim reconciles against its own printed answer key'
  );
  assert.deepEqual(deriveBatchReviewReasons(extracted), []);
});

test('a claim whose BOTH blocks print totals keeps the first stated set, never a sum', () => {
  // A repeated totals row is the same row printed twice, not two rows to add.
  // Summing them would double the claim against the draft.
  const doc = draftFamilyDoc();
  const continuation = JSON.parse(JSON.stringify(doc.claims[0]));
  continuation.procedures = [];
  doc.claims.push(continuation);

  const [claim] = normalizeExtraction(doc).claims;
  assert.equal(claim.totalPaidCents, 8900, 'kept verbatim');
  assert.equal(claim.totalBilledCents, 20000);
});

test('a continuation block supplies identity the first block could not read', () => {
  const doc = draftFamilyDoc();
  doc.claims[0].providerNPI = PLACEHOLDER_NPI;
  doc.claims[0].patientDOB = null;
  const continuation = JSON.parse(JSON.stringify(doc.claims[0]));
  continuation.providerNPI = '1902833271';
  continuation.patientDOB = '2011-06-02';
  continuation.procedures = [];
  for (const f of [
    'totalBilledCents',
    'totalAllowedCents',
    'totalDeductibleCents',
    'totalCopayCents',
    'totalPaidCents',
  ]) {
    continuation[f] = 0;
  }
  doc.claims.push(continuation);

  const [claim] = normalizeExtraction(doc).claims;
  assert.equal(claim.providerNPI, '1902833271', 'a real NPI beats a placeholder');
  assert.equal(claim.patientDOB, '2011-06-02');
});

test('claims with NO claim number never merge — absence is not a shared key', () => {
  const doc = draftFamilyDoc();
  const other = JSON.parse(JSON.stringify(doc.claims[0]));
  doc.claims[0].claimNumber = '';
  other.claimNumber = '';
  other.patientName = 'Ashgrove, Petra';
  doc.claims.push(other);

  const extracted = normalizeExtraction(doc);
  assert.equal(extracted.claims.length, 2, 'two unnumbered claims stay two claims');
});

// ─── (E) a line the document excludes from its own totals ────────────────────

test('a line the document excludes from TOTALS is extracted in full but left out of the sums', () => {
  /*
   * A claim-specific message says this line's amounts are not included in the
   * TOTALS line. Counting it would "discover" a mismatch the document itself
   * disclaims — three of them, in fact: billed, allowed and paid.
   */
  const doc = draftFamilyDoc();
  doc.claims[0].procedures.push({
    code: 'D4346',
    description: 'Scaling in presence of moderate inflammation',
    billedCents: 5000,
    allowedCents: 5000,
    deductibleCents: 0,
    copayCents: 0,
    paidCents: 5000,
    excludedFromTotals: true,
    confidence: 84,
    flags: [],
    adjustments: [],
  });

  const extracted = normalizeExtraction(doc);
  const claim = extracted.claims[0];
  assert.equal(claim.procedures.length, 3, 'the line is still extracted, in full');
  assert.equal(claim.procedures[2].excludedFromTotals, true);
  assert.equal(claim.procedures[2].paidCents, 5000, 'and its figures are untouched');

  assert.deepEqual(
    deriveClaimReviewReasons(claim, extracted.confidence, extracted.payment, { today: TODAY }),
    ['low_confidence'],
    'the printed totals still reconcile over the lines the document counts'
  );
});

test('an excluded line still has every other rule applied to it', () => {
  // Out of the SUMS is not out of REVIEW: a negative amount or a low-confidence
  // row is still a reason to look, wherever the document files it.
  const doc = draftFamilyDoc();
  doc.claims[0].procedures.push({
    code: 'D4346',
    description: 'Scaling in presence of moderate inflammation',
    billedCents: -5000,
    allowedCents: 0,
    deductibleCents: 0,
    copayCents: 0,
    paidCents: 0,
    excludedFromTotals: true,
    confidence: 40,
    flags: [],
    adjustments: [],
  });
  const extracted = normalizeExtraction(doc);
  const reasons = deriveClaimReviewReasons(
    extracted.claims[0],
    extracted.confidence,
    extracted.payment,
    { today: TODAY }
  );
  assert.ok(reasons.includes('negative_amount'), 'an excluded line is still read for sanity');
  assert.ok(reasons.includes('uncertain_line:3'), 'and still flagged as uncertain');
});

test('excludedFromTotals is strictly the literal true — a truthy slip reads as ordinary', () => {
  /*
   * Coercing a truthy would let a model slip SHRINK the very reconciliation
   * that catches misreads. Every non-true value, including the string "true",
   * leaves the line inside the sums.
   */
  for (const slip of ['true', 1, 'yes', {}, [], 'false', null, undefined]) {
    const doc = draftFamilyDoc();
    doc.claims[0].procedures[0].excludedFromTotals = slip;
    const claim = normalizeExtraction(doc).claims[0];
    assert.equal(
      claim.procedures[0].excludedFromTotals,
      false,
      `${JSON.stringify(slip)} must not exclude a line from the document's own arithmetic`
    );
  }
});

test('a claim whose every line is excluded is not flagged against an empty sum', () => {
  // A comparison against an empty sum would read "the lines total 0" and flag a
  // claim whose printed totals are fine.
  const doc = draftFamilyDoc();
  for (const p of doc.claims[0].procedures) p.excludedFromTotals = true;
  const extracted = normalizeExtraction(doc);
  const reasons = deriveClaimReviewReasons(
    extracted.claims[0],
    extracted.confidence,
    extracted.payment,
    { today: TODAY }
  );
  assert.ok(!reasons.includes('paid_total_mismatch'));
  assert.ok(!reasons.includes('billed_total_mismatch'));
  assert.ok(!reasons.includes('claim_line_allowed_mismatch'));
  assert.ok(!reasons.includes('line_paid_not_stated'));
});

// ─── (F) the document's own answer key, at the check level ───────────────────

test('perturbing one line is caught against the printed totals, and changes no figure', () => {
  /*
   * Two claims on one draft. Misread a single line's payment and the claim's own
   * Claim Totals row catches it; the sum of claim payments against the printed
   * EOB total / draft amount is the second, independent check — the one that
   * still fires when a whole claim total is misread.
   */
  const doc = draftFamilyDoc();
  const second = JSON.parse(JSON.stringify(doc.claims[0]));
  second.claimNumber = 'DCLM-5500873';
  second.patientName = 'Ashgrove, Petra';
  doc.claims.push(second);
  doc.payment.totalPaidCents = 17800; // 89.00 + 89.00, as printed on the draft

  const clean = normalizeExtraction(doc);
  assert.deepEqual(deriveBatchReviewReasons(clean), []);
  assert.equal(claimsPaidSum(clean), 17800);

  // Now misread line 1 of the second claim: 89.00 read as 80.90.
  doc.claims[1].procedures[0].paidCents = 8090;
  const perturbed = normalizeExtraction(doc);
  const claimReasons = deriveClaimReviewReasons(
    perturbed.claims[1],
    perturbed.confidence,
    perturbed.payment,
    { today: TODAY }
  );
  assert.ok(claimReasons.includes('paid_total_mismatch'), 'the claim answer key fires');
  // THE FLAG IS THE WHOLE RESPONSE. No figure moved toward agreement.
  assert.equal(perturbed.claims[1].procedures[0].paidCents, 8090, 'the honest read is stored');
  assert.equal(perturbed.claims[1].totalPaidCents, 8900, 'and so is the printed total');
});

test('a misread CLAIM total is caught by the draft amount, which the line sums cannot see', () => {
  const doc = draftFamilyDoc();
  const second = JSON.parse(JSON.stringify(doc.claims[0]));
  second.claimNumber = 'DCLM-5500874';
  second.patientName = 'Ashgrove, Petra';
  doc.claims.push(second);
  doc.payment.totalPaidCents = 17800;
  // Internally consistent — line and claim agree — and wrong against the draft.
  doc.claims[1].procedures[0].paidCents = 8000;
  doc.claims[1].totalPaidCents = 8000;

  const batch = normalizeExtraction(doc);
  assert.deepEqual(
    deriveClaimReviewReasons(batch.claims[1], batch.confidence, batch.payment, { today: TODAY }),
    ['low_confidence'],
    'the claim agrees with itself, so only the outer key can object'
  );
  assert.deepEqual(
    deriveBatchReviewReasons(batch),
    ['batch_paid_total_mismatch'],
    'the draft amount is the outer answer key'
  );
  assert.equal(batch.payment.totalPaidCents, 17800, 'and nothing was reconciled by force');
});

test('the family carries the draft number through as the check number', () => {
  // One number repeats in every page header and on the draft itself; it is what
  // a biller matches the paper against, so a missing one must still flag.
  const extracted = normalizeExtraction(draftFamilyDoc());
  assert.equal(extracted.payment.checkNumber, 'DRAFT-7781234');

  const doc = draftFamilyDoc();
  doc.payment.checkNumber = PLACEHOLDER_CHECK;
  const missing = normalizeExtraction(doc);
  const reasons = deriveClaimReviewReasons(missing.claims[0], missing.confidence, missing.payment, {
    today: TODAY,
  });
  assert.ok(reasons.includes('missing_check_number'));
});

test('the draft family stays a PROPOSAL — derivation widens review and resolves nothing', () => {
  // Nothing in this slice can mark a claim anything but reviewable: the only
  // outputs are review reasons and the figures exactly as read.
  const doc = draftFamilyDoc();
  doc.confidence = 55;
  const extracted = normalizeExtraction(doc);
  const reasons = deriveClaimReviewReasons(
    extracted.claims[0],
    extracted.confidence,
    extracted.payment,
    { today: TODAY }
  );
  assert.ok(reasons.includes('low_confidence'));
  assert.deepEqual(allowancesOf(extracted.claims[0]), [10180, 7400], 'figures as read, always');
});
