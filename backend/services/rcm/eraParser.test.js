'use strict';

/**
 * eraParser regression + corpus tests (RCM Slice 5).
 *
 * Two halves:
 *
 *  1. **The ported suite** — `rcm-posting @ fix/prod-acr-registry-identity`,
 *     `server/eraParser.test.ts`. Test SEMANTICS are unchanged; only the
 *     harness moves from vitest to node:test. These pin the two regressions
 *     the source earned in production (the CAS window, and TRN02-vs-BPR16),
 *     and they are the reason the port is trustworthy at all.
 *
 *  2. **The corpus suite** — every one of the 13 synthetic 835s in
 *     `backend/test/fixtures/rcm`. That corpus is FIXED: no file may be
 *     edited, ever, because these assertions are what would silently move if
 *     one were. A new scenario is a new file.
 *
 * Where a fixture and the X12 specification disagree, the assertion states the
 * disagreement out loud rather than papering over it — see the downcode and
 * CAS-pair tests at the end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parse835, X12FormatError, isPlausibleCarc, toCents } = require('./eraParser');

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'rcm');

/** @param {string} name */
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// ─── Ported: CAS segments beyond the old 5-segment window ───────────────────

const SEG = '~\n';

function build835(claimBlocks) {
  return (
    [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260301*1200*^*00501*000000001*0*P*>',
      'GS*HP*SENDER*RECEIVER*20260301*1200*1*X*005010X221A1',
      'ST*835*0001',
      'BPR*I*150.00*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*999988880*DA*98765*20260301',
      'TRN*1*TRACE12345*1512345678',
      'DTM*405*20260301',
      'N1*PR*DELTA DENTAL',
      'N1*PE*DR SMITH*XX*1234567890',
      claimBlocks,
      'SE*20*0001',
      'GE*1*1',
      'IEA*1*000000001',
    ].join(SEG) + SEG
  );
}

test('captures adjustments separated from SVC by DTM/REF/AMT segments', () => {
  // CAS*CO and CAS*PR are the 5th and 6th segments after SVC — the old fixed
  // window (svcIndex..svcIndex+5) saw neither, and both write-offs and patient
  // responsibility posted as zero.
  const parsed = parse835(
    build835(
      [
        'CLP*CLM1001*1*200*150*30*12*ICN123*11*1',
        'NM1*QC*1*DOE*JANE****MI*SUB123',
        'DMG*D8*19800102',
        'SVC*AD:D2391*200*150',
        'DTM*472*20260215',
        'REF*6R*LINE1',
        'AMT*B6*180',
        'REF*LU*11',
        'CAS*CO*45*20',
        'CAS*PR*1*30',
      ].join(SEG)
    )
  );

  assert.equal(parsed.claims.length, 1);
  const proc = parsed.claims[0].procedures[0];
  assert.equal(proc.code, 'D2391');
  assert.equal(proc.billedCents, 20_000);
  assert.equal(proc.paidCents, 15_000);

  const co = proc.adjustments.find((a) => a.groupCode === 'CO' && a.reasonCode === '45');
  const pr = proc.adjustments.find((a) => a.groupCode === 'PR' && a.reasonCode === '1');
  assert.equal(co.amountCents, 2_000);
  assert.equal(pr.amountCents, 3_000);
  // allowed = billed - CO adjustments; deductible from PR/1.
  assert.equal(proc.allowedCents, 18_000);
  assert.equal(proc.deductibleCents, 3_000);
});

test('does not leak CAS segments from the NEXT service line into the previous one', () => {
  const parsed = parse835(
    build835(
      [
        'CLP*CLM1002*1*300*250*20*12*ICN124*11*1',
        'NM1*QC*1*ROE*JOHN****MI*SUB124',
        'SVC*AD:D0120*100*90',
        'DTM*472*20260215',
        'CAS*CO*45*10',
        'SVC*AD:D1110*200*160',
        'DTM*472*20260215',
        'CAS*CO*45*20',
        'CAS*PR*3*20',
      ].join(SEG)
    )
  );

  const [p1, p2] = parsed.claims[0].procedures;
  assert.equal(p1.code, 'D0120');
  assert.equal(p1.adjustments.length, 1);
  assert.equal(p1.adjustments[0].amountCents, 1_000);
  assert.equal(p2.code, 'D1110');
  assert.equal(p2.adjustments.length, 2);
  assert.deepEqual(
    p2.adjustments.map((a) => a.groupCode).sort(),
    ['CO', 'PR']
  );
});

test('parses a DMG date of birth, and reports a missing one as null', () => {
  // D11: the source wrote the string '0001-01-01' — Open Dental's null-date
  // sentinel — into what is a real `date` column here.
  const withDob = parse835(
    build835(
      ['CLP*C1*1*100*80*20*12*ICN1', 'NM1*QC*1*DOE*JANE****MI*S1', 'DMG*D8*19800102', 'SVC*AD:D0120*100*80'].join(SEG)
    )
  );
  assert.equal(withDob.claims[0].patientDOB, '1980-01-02');

  const withoutDob = parse835(
    build835(['CLP*C1*1*100*80*20*12*ICN1', 'NM1*QC*1*DOE*JANE****MI*S1', 'SVC*AD:D0120*100*80'].join(SEG))
  );
  assert.equal(withoutDob.claims[0].patientDOB, null);
});

test('a claim missing its own NM1 does not inherit the NEXT patient identity', () => {
  // D12. The source searched from the CLP to the END of the transaction, so
  // this file gave claim one the name, DOB and member id of claim two's
  // patient — a PHI mix-up, in the multi-claim shape that is the common one.
  const parsed = parse835(
    build835(
      [
        'CLP*NONAME*1*100*80*20*12*ICN1',
        'SVC*AD:D0120*100*80',
        'CLP*HASNAME*1*100*80*20*12*ICN2',
        'NM1*QC*1*ROE*JOHN****MI*SUB999',
        'DMG*D8*19700304',
        'SVC*AD:D0120*100*80',
      ].join(SEG)
    )
  );

  assert.equal(parsed.claims.length, 2);
  assert.equal(parsed.claims[0].patientName, 'Unknown Patient');
  assert.equal(parsed.claims[0].patientDOB, null);
  assert.equal(parsed.claims[0].subscriberId, '');
  assert.equal(parsed.claims[1].patientName, 'JOHN ROE');
  assert.equal(parsed.claims[1].subscriberId, 'SUB999');
});

// ─── Ported: BPR/TRN field mapping ──────────────────────────────────────────

const CLAIM = [
  'CLP*CLM1*1*100*80*20*12*ICN1',
  'NM1*QC*1*DOE*JOHN****MI*SUB1',
  'SVC*AD:D0120*100*80',
  'CAS*CO*45*20',
].join(SEG);

function build(bpr, { dtm = true } = {}) {
  return (
    [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260301*1200*^*00501*000000001*0*P*>',
      'GS*HP*SENDER*RECEIVER*20260301*1200*1*X*005010X221A1',
      'ST*835*0001',
      bpr,
      'TRN*1*820633511*1710673405',
      ...(dtm ? ['DTM*405*20260301'] : []),
      'N1*PR*DELTA DENTAL',
      CLAIM,
      'SE*20*0001',
      'GE*1*1',
      'IEA*1*000000001',
    ].join(SEG) + SEG
  );
}

// BPR16 = 20260203, deliberately different from DTM*405, so a regression that
// reads BPR16 as the check number is unmistakable.
const ACH_BPR =
  'BPR*I*80.00*C*ACH*CCP*01*101000695*DA*9872007859*1710673405**01*082900872*DA*0030045640*20260203';
const CHK_BPR =
  'BPR*I*80.00*C*CHK*CCP*01*101000695*DA*9872007859*1710673405**01*082900872*DA*0030045640*20260203';
const NON_BPR =
  'BPR*H*0.00*C*NON*CCP*01*101000695*DA*9872007859*1710673405**01*082900872*DA*0030045640*20260203';

test('takes the check number from TRN02, not BPR16 (which is a date)', () => {
  const parsed = parse835(build(ACH_BPR));
  assert.equal(parsed.checkNumber, '820633511');
  assert.notEqual(parsed.checkNumber, '20260203'); // BPR16 — the old bug
  assert.equal(parsed.traceNumber, '820633511');
});

test('reads BPR04=ACH as an EFT payment', () => {
  assert.equal(parse835(build(ACH_BPR)).paymentMethod, 'eft');
});

test('reads BPR04=CHK as a check payment', () => {
  assert.equal(parse835(build(CHK_BPR)).paymentMethod, 'check');
});

test('returns null for BPR04=NON (no payment) rather than guessing', () => {
  const parsed = parse835(build(NON_BPR));
  assert.equal(parsed.paymentMethod, null);
  // The raw code is kept, because "the payer says no funds moved" and "the
  // file did not say" are different facts and only bpr04 tells them apart.
  assert.equal(parsed.bpr04, 'NON');
});

test('prefers DTM*405 for the check date', () => {
  assert.equal(parse835(build(ACH_BPR)).checkDate, '2026-03-01');
});

test('falls back to BPR16 — not today — when DTM*405 is absent', () => {
  const parsed = parse835(build(ACH_BPR, { dtm: false }));
  assert.equal(parsed.checkDate, '2026-02-03');
  assert.notEqual(parsed.checkDate, new Date().toISOString().slice(0, 10));
});

test('reports NO payment date rather than inventing today when both are absent', () => {
  // D2. The source's last-resort `new Date()` invented a check date that
  // disagreed with the bank AND fed the remittance key, making the dedupe
  // primitive time-dependent. The upload route refuses on this null.
  const noDate = build('BPR*I*80.00*C*ACH*CCP*01*101000695*DA*9872007859*1710673405', { dtm: false });
  assert.equal(parse835(noDate).checkDate, null);
});

// ─── Malformed input ────────────────────────────────────────────────────────

test('refuses a file that is not X12 at all', () => {
  assert.throws(() => parse835('this is a PDF, not an 835'), X12FormatError);
});

test('refuses an interchange carrying no 835 transaction', () => {
  const notAn835 =
    [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260301*1200*^*00501*000000001*0*P*>',
      'GS*HC*SENDER*RECEIVER*20260301*1200*1*X*005010X222A1',
      'ST*837*0001',
      'SE*2*0001',
      'GE*1*1',
      'IEA*1*000000001',
    ].join(SEG) + SEG;
  assert.throws(() => parse835(notAn835), /No 835 transactions/);
});

test('reads the delimiters the interchange declares, not hardcoded ones', () => {
  // The corpus declares ':' at ISA16 and the ported fixtures declare '>'. Both
  // must parse, which is why x12.js reads ISA rather than assuming.
  assert.equal(parse835(build(ACH_BPR)).traceNumber, '820633511'); // '>' at ISA16
  assert.equal(
    parse835(fixture('Test_Minimal_835.edi')).traceNumber, // ':' at ISA16
    '000000006'
  );
});

test('toCents handles decimal dollars, negatives and absent values', () => {
  assert.equal(toCents('892.50'), 89_250);
  assert.equal(toCents('-285'), -28_500);
  assert.equal(toCents(''), 0);
  assert.equal(toCents(undefined), 0);
});

// ─── The corpus: all 13 fixtures ────────────────────────────────────────────

/**
 * Every file, its headline numbers. A single table so a corpus-wide regression
 * shows up as several failures rather than one.
 */
const CORPUS = [
  { file: 'Test_Minimal_835.edi', payer: 'MINIMAL PAYER', trace: '000000006', total: 10_800, method: 'check', claims: 1, lines: 1 },
  { file: 'Test_Guardian_Clean.edi', payer: 'GUARDIAN LIFE INSURANCE COMPANY', trace: '830400001', total: 16_300, method: 'eft', claims: 1, lines: 4 },
  { file: 'Test_Anthem_Deductible.edi', payer: 'ANTHEM BCBS DENTAL', trace: '830300002', total: 8_850, method: 'eft', claims: 1, lines: 2 },
  { file: 'Test_Applied_To_Deductible.edi', payer: 'DELTA DENTAL OF ARKANSAS', trace: '000000002', total: 0, method: null, claims: 1, lines: 5 },
  { file: 'Test_Principal_Major.edi', payer: 'PRINCIPAL FINANCIAL GROUP', trace: '830400002', total: 45_000, method: 'eft', claims: 1, lines: 3 },
  { file: 'Test_Cigna_Downcode.edi', payer: 'CIGNA DENTAL HEALTH INC', trace: '830300001', total: 31_200, method: 'eft', claims: 1, lines: 5 },
  { file: 'Test_Bundled_Downgraded.edi', payer: 'AETNA DENTAL', trace: '000000005', total: 48_500, method: 'eft', claims: 1, lines: 4 },
  { file: 'Test_Denied_Claims.edi', payer: 'TEST INSURANCE COMPANY', trace: '000000001', total: 0, method: null, claims: 1, lines: 5 },
  { file: 'Test_Mixed_Adjustments.edi', payer: 'HUMANA DENTAL', trace: '000000008', total: 89_250, method: 'eft', claims: 1, lines: 6 },
  { file: 'Test_Delta_Dental_MultiClaim.edi', payer: 'DELTA DENTAL OF ARKANSAS', trace: '830200001', total: 65_100, method: 'eft', claims: 2, lines: 4 },
  { file: 'Test_Secondary_COB.edi', payer: 'GUARDIAN LIFE INSURANCE', trace: '000000004', total: 9_500, method: 'eft', claims: 1, lines: 5 },
  { file: 'Test_Reversal_Recoupment.edi', payer: 'CIGNA DENTAL', trace: '000000003', total: -28_500, method: 'eft', claims: 1, lines: 3 },
  { file: 'Test_PLB_Adjustments.edi', payer: 'PRINCIPAL FINANCIAL', trace: '000000007', total: 15_800, method: 'eft', claims: 1, lines: 2 },
];

for (const spec of CORPUS) {
  test(`corpus: ${spec.file} parses to its headline numbers`, () => {
    const parsed = parse835(fixture(spec.file));

    assert.equal(parsed.transactionCount, 1, 'every fixture is a single ST*835');
    assert.equal(parsed.payerName, spec.payer);
    assert.equal(parsed.traceNumber, spec.trace);
    assert.equal(parsed.checkNumber, spec.trace, 'checkNumber is TRN02');
    assert.equal(parsed.totalPaymentCents, spec.total);
    assert.equal(parsed.paymentMethod, spec.method);
    assert.equal(parsed.claims.length, spec.claims);
    assert.equal(
      parsed.claims.reduce((n, c) => n + c.procedures.length, 0),
      spec.lines
    );

    // Every fixture carries a real payment date; none may fall back to today.
    assert.match(parsed.checkDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(parsed.checkDate, new Date().toISOString().slice(0, 10));

    // The payee is the practice, in every file. It is business identity, not
    // PHI, and it is what makes these parse as real 835s.
    assert.ok(parsed.payeeName.length > 0);
  });
}

test('corpus: BPR02 reconciles against claim payments plus PLB, in every file', () => {
  // The flag exists to catch a misread file. If it fires on the corpus, the
  // parser — not the corpus — is what changed.
  for (const spec of CORPUS) {
    const parsed = parse835(fixture(spec.file));
    for (const r of parsed.remittances) {
      assert.ok(
        !r.flags.includes('claim_total_mismatch'),
        `${spec.file}: claim payments + PLB do not reach BPR02`
      );
    }
  }
});

test('corpus: a denied claim is flagged, not silently zero-paid', () => {
  const parsed = parse835(fixture('Test_Denied_Claims.edi'));
  const claim = parsed.claims[0];

  assert.equal(claim.claimStatusCode, '4');
  assert.equal(claim.claimStatusLabel, 'denied');
  assert.equal(claim.isDenied, true);
  assert.deepEqual(claim.needsReviewReasons, ['claim_denied']);
  // D8: the source parsed CLP02 into a variable it never read, so a denial and
  // a clean payment were indistinguishable in the output.
  assert.ok(claim.procedures.every((p) => p.isDenied));
  assert.deepEqual(
    claim.procedures.map((p) => `${p.adjustments[0].groupCode}-${p.adjustments[0].reasonCode}`),
    ['CO-18', 'CO-29', 'CO-31', 'PR-96', 'CO-50']
  );
});

test('corpus: applied-to-deductible is NOT denied — its CAS already says why', () => {
  // Every line pays zero and the whole billed amount is PR-1. Calling that
  // "denied" would put a carrier appeal on a worklist where a patient
  // statement belongs.
  const claim = parse835(fixture('Test_Applied_To_Deductible.edi')).claims[0];
  assert.equal(claim.isDenied, false);
  assert.ok(claim.procedures.every((p) => p.isDenied === false));
  assert.ok(claim.procedures.every((p) => p.flags.includes('denied') === false));
  assert.equal(claim.totalDeductibleCents, 45_000);
  assert.equal(claim.totalPaidCents, 0);
});

test('corpus: a reversal is parsed AND flagged — never dropped, never postable', () => {
  const parsed = parse835(fixture('Test_Reversal_Recoupment.edi'));
  const claim = parsed.claims[0];

  assert.equal(claim.claimStatusCode, '22');
  assert.equal(claim.isReversal, true);
  assert.deepEqual(claim.needsReviewReasons, ['reversal_not_postable']);
  // Parsed, in full: three lines with negative payments, totalling BPR02.
  assert.equal(claim.procedures.length, 3);
  assert.deepEqual(
    claim.procedures.map((p) => p.paidCents),
    [-10_200, -10_800, -7_500]
  );
  assert.equal(parsed.totalPaymentCents, -28_500);
  assert.ok(parsed.remittances[0].flags.includes('negative_total_payment'));
});

test('corpus: PLB adjustments are parsed as pairs, with their reference ids', () => {
  const parsed = parse835(fixture('Test_PLB_Adjustments.edi'));

  assert.deepEqual(parsed.plbAdjustments, [
    {
      reasonCode: 'WO',
      reasonDescription: 'Overpayment recovery',
      referenceId: 'OLDCLM001',
      amountCents: -5_000,
    },
    {
      reasonCode: 'L6',
      reasonDescription: 'Interest owed',
      referenceId: 'OLDCLM002',
      amountCents: 800,
    },
  ]);
  // Signed, not absolute: a WO recoupment is money owed BY the provider.
  assert.equal(parsed.plbTotalCents, -4_200);
  assert.ok(parsed.remittances[0].flags.includes('plb_adjustments_present'));
  // 200.00 of claim payments less 42.00 of PLB is the 158.00 on the check.
  assert.equal(parsed.totalPaymentCents, 15_800);
});

test('corpus: secondary-payer adjudication surfaces the prior payment', () => {
  const parsed = parse835(fixture('Test_Secondary_COB.edi'));
  const claim = parsed.claims[0];

  // AMT*D — what a prior payer already paid — is the substantive COB signal.
  assert.equal(claim.priorPayerPaidCents, 28_000);
  assert.ok(claim.needsReviewReasons.includes('secondary_payer_adjudication'));
  // And the file contradicts itself: CLP02 = 1 says "processed as primary"
  // while reporting a prior payer's money. Surfaced, not reconciled.
  assert.equal(claim.claimStatusCode, '1');
  assert.ok(claim.needsReviewReasons.includes('prior_payer_payment_on_primary_claim'));
  // OA-23 on every line is the same story per service.
  assert.ok(
    claim.procedures.every((p) => p.adjustments.some((a) => a.groupCode === 'OA' && a.reasonCode === '23'))
  );
});

test('corpus: bundling is flagged per line from its CARC', () => {
  const claim = parse835(fixture('Test_Bundled_Downgraded.edi')).claims[0];
  const bundled = claim.procedures.filter((p) => p.isBundled);

  assert.equal(bundled.length, 3);
  assert.deepEqual(
    bundled.map((p) => p.adjustments[0].reasonCode),
    ['B15', '97', '54']
  );
  // Bundled is not denied. The claim was not denied, and the CARC says the
  // payment is inside another line rather than refused.
  assert.ok(bundled.every((p) => p.isDenied === false));
});

test('corpus: RARC remark codes are read from LQ*HE', () => {
  // D9. The source never read LQ at all, so rcm_procedure_adjustments.remark_code
  // had no source of data.
  const claim = parse835(fixture('Test_Denied_Claims.edi')).claims[0];
  assert.deepEqual(
    claim.procedures.map((p) => p.remarkCodes[0] || null),
    ['N19', 'N362', 'N290', 'N130', null]
  );
  assert.equal(claim.procedures[0].adjustments[0].remarkCode, 'N19');
});

test('corpus: the subscriber id comes from NM1, and REF*1L is the GROUP number', () => {
  // D6. The source read REF*1L (Group or Policy Number) as the subscriber id
  // and hardcoded the group to the string 'N/A'.
  const mixed = parse835(fixture('Test_Mixed_Adjustments.edi')).claims[0];
  assert.equal(mixed.subscriberId, '147258369');
  assert.equal(mixed.groupNumber, 'GRP12345');

  // On a dependent's claim the subscriber and the patient are different
  // people; the id belongs to the subscriber, the name to the patient.
  const dep = parse835(fixture('Test_Applied_To_Deductible.edi')).claims[0];
  assert.equal(dep.patientName, 'MARY JONES');
  assert.equal(dep.subscriberId, '987654321');
});

test('corpus: the rendering NPI falls back to NM1*82 when REF*1G is absent', () => {
  // D7. Every file in the corpus is this case; the source returned '0000000000'.
  const claim = parse835(fixture('Test_Guardian_Clean.edi')).claims[0];
  assert.equal(claim.providerNPI, '1437445400');
  assert.equal(claim.renderingProvider, 'BEAU SPARKMAN');
});

test('corpus: a multi-claim check keeps each claim to its own patient and lines', () => {
  const parsed = parse835(fixture('Test_Delta_Dental_MultiClaim.edi'));
  const [foster, navarro] = parsed.claims;

  assert.equal(foster.claimNumber, 'FOSTER001');
  assert.equal(foster.procedures.length, 3);
  assert.equal(foster.totalPaidCents, 20_800);
  assert.equal(navarro.claimNumber, 'NAVARRO001');
  assert.equal(navarro.procedures.length, 1);
  assert.equal(navarro.totalPaidCents, 44_300);
  // Both claims on ONE check, which is the payment-batch shape.
  assert.equal(foster.totalPaidCents + navarro.totalPaidCents, parsed.totalPaymentCents);
  assert.equal(parsed.remittances.length, 1);
});

test('corpus: a clean file raises no flags and no review reasons at all', () => {
  const parsed = parse835(fixture('Test_Guardian_Clean.edi'));
  assert.deepEqual(parsed.remittances[0].flags, []);
  assert.deepEqual(parsed.claims[0].needsReviewReasons, []);
});

// ─── The two places the corpus and the specification disagree ───────────────

test('DOWNCODE: SVC06 is the ORIGINAL SUBMITTED code (X12) — the two transposed fixtures read inverted', () => {
  // SETTLED by PM ruling in Slice 5 review: THE SPEC WINS. See the NOTE ON
  // DOWNCODES in eraParser.js and the section in fixtures/rcm/README.md.
  //
  // X12 005010X221A1: SVC01 is the ADJUDICATED code, SVC06 the ORIGINAL
  // SUBMITTED one. These two fixtures were AUTHORED TRANSPOSED:
  //
  //   Test_Cigna_Downcode.edi      SVC*AD:D0150*102*57***AD:D0120
  //   Test_Bundled_Downgraded.edi  SVC*AD:D2740*1258*485***AD:D2791
  //
  // The parser follows the specification, because real payer files do and
  // Slice 6 posts real money against whichever code we recorded. So these two
  // assertions record SPEC POSITIONS, not the original author's intent — and
  // the fixture bytes stay frozen, because the corpus rule protects bytes
  // rather than authoring mistakes.
  const cigna = parse835(fixture('Test_Cigna_Downcode.edi')).claims[0].procedures[0];
  assert.equal(cigna.billedCode, 'D0120', 'SVC06 — original submitted, per X12');
  assert.equal(cigna.paidCode, 'D0150', 'SVC01 — adjudicated, per X12');

  const aetna = parse835(fixture('Test_Bundled_Downgraded.edi')).claims[0].procedures[0];
  assert.equal(aetna.billedCode, 'D2791');
  assert.equal(aetna.paidCode, 'D2740');

  // DETECTION is symmetric and therefore unaffected by the ruling: the codes
  // differ, so the line is downcoded and the claim needs review either way.
  assert.equal(cigna.isDowncoded, true);
  assert.equal(aetna.isDowncoded, true);
  assert.ok(parse835(fixture('Test_Cigna_Downcode.edi')).claims[0].needsReviewReasons.includes('procedure_downcoded'));
});

test('a line with no SVC06 has no paid code, and is not a downcode', () => {
  const claim = parse835(fixture('Test_Guardian_Clean.edi')).claims[0];
  assert.ok(claim.procedures.every((p) => p.paidCode === null));
  assert.ok(claim.procedures.every((p) => p.isDowncoded === false));
  assert.ok(claim.procedures.every((p) => p.billedCode === p.code));
});

test('CAS PAIRS: an implausible CARC token is flagged, never invented', () => {
  // SETTLED by PM ruling in Slice 5 review: this is PRODUCTION behaviour, not
  // a fixture workaround — real payer files are malformed too. See the NOTE ON
  // CAS PAIRS in eraParser.js.
  //
  // Test_Mixed_Adjustments.edi writes `CAS*PR*1*50*2*25.50`. CAS repeats as
  // reason/amount/QUANTITY triples, so per the specification that is
  // (PR-1, $50.00, qty 2) followed by a reason code of "25.50". The author
  // meant two pairs — the claim's PR amounts only reach its CLP05 patient
  // responsibility of $257.50 that way — and omitted the empty quantity
  // element that would have said so (`CAS*PR*1*50**2*25.50`).
  const claim = parse835(fixture('Test_Mixed_Adjustments.edi')).claims[0];
  const line = claim.procedures.find((p) => p.code === 'D2391');

  // The readable pair is kept.
  assert.ok(line.adjustments.some((a) => a.groupCode === 'PR' && a.reasonCode === '1' && a.amountCents === 5_000));
  // The unreadable one produces NO adjustment row — a fabricated reason code
  // of '25.50' in front of billing staff would be worse than a gap.
  assert.ok(line.adjustments.every((a) => a.reasonCode !== '25.50'));
  // And the gap is visible, at both the line and the claim.
  assert.ok(line.flags.includes('unexplained_adj'));
  assert.ok(claim.needsReviewReasons.includes('unparseable_cas'));

  assert.equal(isPlausibleCarc('25.50'), false);
  assert.equal(isPlausibleCarc('B15'), true);
  assert.equal(isPlausibleCarc('45'), true);
  assert.equal(isPlausibleCarc(''), false);
});

test('a well-formed multi-pair CAS reads every pair', () => {
  // The same shape written to specification — the empty CAS04 — parses as the
  // author of the fixture intended, which is the evidence for the note above.
  const parsed = parse835(
    build835(
      ['CLP*C1*1*204*104*75*12*ICN1', 'NM1*QC*1*DOE*JANE****MI*S1', 'SVC*AD:D2391*204*104', 'CAS*PR*1*50**2*25.50'].join(SEG)
    )
  );
  const line = parsed.claims[0].procedures[0];
  assert.equal(line.adjustments.length, 2);
  assert.equal(line.deductibleCents, 5_000);
  assert.equal(line.copayCents, 2_550);
  assert.ok(line.flags.includes('unexplained_adj') === false);
});
