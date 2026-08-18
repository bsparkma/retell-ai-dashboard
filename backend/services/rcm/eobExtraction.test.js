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
