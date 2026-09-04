'use strict';

/*
 * THE RESEED FIXTURES, PROVED AGAINST THE REAL PARSER AND THE REAL MATCHER.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * These four 835s are uploaded by hand, days after they are generated, into a
 * staging environment, by somebody who is trying to evaluate a PRODUCT. Every
 * minute spent working out whether the FIXTURE is wrong is a minute not spent on
 * the thing being evaluated — and walk night 2 lost an evening to exactly that,
 * regenerating two files from a manifest whose claims had been deleted.
 *
 * So the properties the fixtures are supposed to have are checked here rather
 * than hoped for, and they are checked against the app's OWN parser and the
 * app's OWN matcher rather than against a restatement of what those do:
 *
 *   1. Every line's money balances, per line and per claim.
 *   2. All four files parse with no review flags — except R3's, which is a
 *      takeback and is supposed to raise one.
 *   3. R1–R3 each match ONE claim, unambiguously.
 *   4. R4 matches NOTHING — the §15.1c dead end, authored on purpose.
 *
 * Point 4 is the one that most needs a test, because a fixture that is supposed
 * to fail is indistinguishable from a fixture that is simply broken, and the
 * difference matters: if R4 ever starts matching, the dead end it exists to
 * demonstrate has stopped being reachable and nothing else would say so.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FAKE OPEN DENTAL, AND WHY IT PREFIX-MATCHES
 * ─────────────────────────────────────────────────────────────────────────────
 * `odGet` below reproduces the ONE behaviour of Open Dental that R4 turns on:
 * `?LName=` and `?FName=` are case-insensitive PREFIX matches. `LName=Spark`
 * returns 18 rows live. A fake that did exact matching would let a transposition
 * pass that the real database would resolve, which is the failure this test is
 * for.
 *
 * The control assertions matter as much as the R4 one: a fake that found nobody
 * for ANY name would make R4's test pass vacuously, so the same fake is asked
 * for the two real chart names and must find them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parse835 } = require('../services/rcm/eraParser');
const claimMatch = require('../services/rcm/claimMatch');
const odClaimReads = require('../services/rcm/odClaimReads');
const lineDecisions = require('../services/rcm/lineDecisions');

const T = require('../scripts/rcm/reseed-targets');
const gen = require('../scripts/rcm/reseed-835');

// ─────────────────────────────────────────────────────────────────────────────
// A simulated Roland chart, built from the same TARGETS table the reseed uses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two designated Roland test patients, spelled as Open Dental holds them.
 *
 * These ARE the live chart's spellings (CLAUDE.md's fixture table), and they are
 * literals here rather than read from anywhere — this is a test, and the prep
 * script is the thing that reads the chart. Note 12828 is `LName: "Test",
 * FName: "MangoTest"`, which is why a surname-only search misses it and why the
 * dual-lane merge is not optional.
 */
const CHART_PATIENTS = [
  { PatNum: 12827, LName: 'Test 2', FName: 'Stedi', Birthdate: '0001-01-01' },
  { PatNum: 12828, LName: 'Test', FName: 'MangoTest', Birthdate: '0001-01-01' },
];

const SERVICE_DATE = '2026-09-01';

/** Deterministic stand-ins for the ids a prep run would create. */
function fakeManifest() {
  let procNum = 500000;
  let claimNum = 54000;
  let claimProcNum = 540000;
  return {
    office: 'roland',
    createdAt: new Date().toISOString(),
    serviceDate: SERVICE_DATE,
    baselineClaimCount: 0,
    complete: true,
    patients: CHART_PATIENTS.map((p) => ({ patNum: p.PatNum, last: p.LName, first: p.FName })),
    targets: T.TARGETS.map((t) => ({
      ...t,
      procNum: ++procNum,
      claimNum: ++claimNum,
      claimProcNum: ++claimProcNum,
      serviceDate: SERVICE_DATE,
    })),
  };
}

/**
 * A fake Open Dental holding exactly the rows a prep run would have created.
 *
 * Only the four reads the matcher actually makes are implemented, and anything
 * else 404s rather than returning a plausible empty list — a fake that answers
 * questions the real code does not ask is a fake that can hide a fifth call.
 *
 * @param {ReturnType<typeof fakeManifest>} manifest
 */
function fakeOd(manifest) {
  const claims = manifest.targets.map((t) => ({
    ClaimNum: t.claimNum,
    PatNum: t.patNum,
    ClaimStatus: 'W',
    DateService: SERVICE_DATE,
    ClaimFee: t.billedCents / 100,
  }));
  const claimProcs = manifest.targets.map((t) => ({
    ClaimProcNum: t.claimProcNum,
    ClaimNum: t.claimNum,
    ProcNum: t.procNum,
    PatNum: t.patNum,
    Status: 'NotReceived',
    FeeBilled: t.billedCents / 100,
    InsPayAmt: 0,
    WriteOff: 0,
  }));
  const procedures = manifest.targets.map((t) => ({
    ProcNum: t.procNum,
    PatNum: t.patNum,
    ProcStatus: 'C',
    ProcFee: t.billedCents / 100,
    procCode: t.procCode,
    CodeSent: t.procCode,
    ProcDate: SERVICE_DATE,
  }));

  /** @type {string[]} */
  const calls = [];
  /** @type {import('../services/rcm/odClaimReads')} */
  const odGet = async (route, params = {}) => {
    calls.push(`${route} ${JSON.stringify(params)}`);
    if (route === '/patients') {
      // THE PREFIX MATCH. This is the behaviour R4 depends on.
      const [key, value] = Object.entries(params)[0] || [];
      if (!key) return { ok: true, status: 200, data: CHART_PATIENTS };
      const want = String(value).toUpperCase();
      return {
        ok: true,
        status: 200,
        data: CHART_PATIENTS.filter((p) => String(p[key] || '').toUpperCase().startsWith(want)),
      };
    }
    if (/^\/patients\/\d+$/.test(route)) {
      const patNum = Number(route.split('/')[2]);
      const found = CHART_PATIENTS.find((p) => p.PatNum === patNum);
      return found ? { ok: true, status: 200, data: found } : { ok: false, status: 404 };
    }
    if (route === '/claims') {
      const patNum = Number(params.PatNum);
      return { ok: true, status: 200, data: claims.filter((c) => c.PatNum === patNum) };
    }
    if (route === '/claimprocs') {
      const claimNum = Number(params.ClaimNum);
      return { ok: true, status: 200, data: claimProcs.filter((c) => c.ClaimNum === claimNum) };
    }
    if (route === '/procedurelogs') {
      const patNum = Number(params.PatNum);
      return { ok: true, status: 200, data: procedures.filter((p) => p.PatNum === patNum) };
    }
    if (/^\/procedurelogs\/\d+$/.test(route)) {
      const procNum = Number(route.split('/')[2]);
      const found = procedures.find((p) => p.ProcNum === procNum);
      return found ? { ok: true, status: 200, data: found } : { ok: false, status: 404 };
    }
    return { ok: false, status: 404, error: `fakeOd has no route ${route}` };
  };
  return { odGet, calls };
}

/** Generate the four bodies into a temp dir and read them back. */
function generateBodies() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-reseed-'));
  const manifest = fakeManifest();
  const officeDir = path.join(dir, 'roland');
  fs.mkdirSync(officeDir, { recursive: true });
  fs.writeFileSync(
    path.join(officeDir, 'rcm-reseed-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  /** @type {Record<string, string>} */
  const bodies = {};
  for (const remittance of T.REMITTANCES) {
    const mine = manifest.targets.filter((t) => t.remittance === remittance.label);
    const useTransposed = remittance.label === 'R4';
    const claims = mine.map((t) => {
      const p = manifest.patients.find((x) => x.patNum === t.patNum);
      const R = t.allowedCents - t.paidCents;
      return {
        claimNum: t.claimNum,
        patLast: useTransposed ? T.R4_TRANSPOSED.last : p.last,
        patFirst: useTransposed ? T.R4_TRANSPOSED.first : p.first,
        procCode: t.procCode,
        billedCents: t.billedCents,
        allowedCents: t.allowedCents,
        paidCents: t.paidCents,
        serviceDate: t.serviceDate,
        patientSplit: t.key === 'R2-2' ? [['1', 5000], ['2', R - 5000]] : undefined,
      };
    });
    bodies[remittance.label] = gen.build835({
      remittance,
      claims,
      reversal: remittance.label === 'R3',
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { manifest, bodies };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The money
// ─────────────────────────────────────────────────────────────────────────────

test('every target balances: billed − paid equals write-off plus patient remainder', () => {
  for (const t of T.TARGETS) {
    assert.equal(gen.assertBalanced(t), null, `${t.key} does not balance`);
  }
});

test('the brief’s shape: R1 has three lines over two patients, one of them leaving the patient owing', () => {
  const r1 = T.TARGETS.filter((t) => t.remittance === 'R1');
  assert.equal(r1.length, 3, 'R1 must carry three lines');
  assert.equal(new Set(r1.map((t) => t.patNum)).size, 2, 'R1 must span both designated test patients');

  /*
   * THE CC-5 REQUIREMENT. At least one R1 line must leave `allowed > paid`, so
   * the verdict line has a non-zero patient remainder to project rather than
   * rendering "$0.00 once posted" — which shows nothing and proves nothing.
   */
  const owing = r1.filter((t) => t.allowedCents > t.paidCents);
  assert.ok(owing.length >= 1, 'R1 must leave the patient owing on at least one line (CC-5)');
  assert.equal(owing[0].allowedCents - owing[0].paidCents, 920, 'the CC-5 line owes $9.20');
});

test('R2 carries one contractual-only line and one with a remainder for the office to eat', () => {
  const r2 = T.TARGETS.filter((t) => t.remittance === 'R2');
  assert.equal(r2.length, 2);
  const contractualOnly = r2.filter((t) => t.billedCents > t.allowedCents && t.allowedCents === t.paidCents);
  const officeCanEat = r2.filter((t) => t.allowedCents > t.paidCents);
  assert.equal(contractualOnly.length, 1, 'one line must be a pure contractual write-off (R = 0)');
  assert.equal(officeCanEat.length, 1, 'one line must carry a remainder the office can absorb');
  /*
   * A line where R is zero "has nothing to decide and renders without the
   * control" (lineDecisions.js). So the office_writeoff path is only REACHABLE
   * on the second line, which is what makes the pair a fixture rather than two
   * similar rows.
   */
  assert.equal(officeCanEat[0].allowedCents - officeCanEat[0].paidCents, 48000);
});

test('every target names a designated test patient, and the rejected PatNums are refused by name', () => {
  for (const t of T.TARGETS) {
    assert.equal(T.assertPatNum(t.patNum), null, `${t.key} names a patient this reseed may not touch`);
  }
  // 11373 is ambiguous by construction; 7115 in ROLAND is a different, real person.
  assert.match(String(T.assertPatNum(11373)), /shared family phone/);
  assert.match(String(T.assertPatNum(7115)), /different, REAL person/);
  assert.match(String(T.assertPatNum(1)), /not a designated roland test patient/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The parser
// ─────────────────────────────────────────────────────────────────────────────

test('all four files parse, reconcile, and raise no review flag except the takeback’s', () => {
  const { bodies } = generateBodies();

  for (const remittance of T.REMITTANCES) {
    const tx = parse835(bodies[remittance.label]);
    assert.equal(tx.payerName, remittance.payer, `${remittance.label} payer`);
    assert.equal(tx.checkNumber, remittance.checkNumber, `${remittance.label} check number`);

    // BPR02 reconciles against the claim payments — the corpus suite's property.
    const sum = tx.claims.reduce((s, c) => s + c.totalPaidCents, 0);
    assert.equal(tx.totalPaymentCents, sum, `${remittance.label} BPR02 must equal its claim payments`);

    for (const claim of tx.claims) {
      // CLP05 is the payer's own statement of what the patient owes, and it must
      // equal allowed − paid or the parser reconciles it against the CAS PR group
      // and flags the file.
      assert.equal(
        claim.patientRespCents,
        claim.totalAllowedCents - claim.totalPaidCents,
        `${remittance.label} claim ${claim.claimNumber}: CLP05 must equal allowed − paid`
      );
      assert.equal(claim.procedures.length, 1, `${remittance.label} claim ${claim.claimNumber}: one SVC line`);

      if (remittance.label === 'R3') {
        /*
         * THE TAKEBACK IS SUPPOSED TO RAISE ONE. `reversal_not_postable` is
         * answered by TAKEBACK_ACKNOWLEDGED since the D-11 amendment of
         * 2026-08-27 — it is the gate's business, not a broken file. Asserting
         * it is here rather than asserting its absence keeps the difference
         * visible.
         */
        assert.equal(claim.isReversal, true, 'R3 must parse as a reversal');
        assert.equal(claim.claimStatusCode, '22', 'R3 CLP02 must be 22');
        assert.ok(claim.totalPaidCents < 0, 'R3 must take money back');
        assert.deepEqual(claim.needsReviewReasons, ['reversal_not_postable']);
      } else {
        assert.deepEqual(
          claim.needsReviewReasons,
          [],
          `${remittance.label} claim ${claim.claimNumber} should need no review`
        );
        assert.equal(claim.isReversal, false);
      }
    }
  }
});

test('the takeback’s CAS mirrors the payment it reverses instead of vanishing', () => {
  /*
   * THE DEFECT THIS PINS. `casSegmentsFor`'s guards are `> 0` — "is there a
   * write-off at all" — and handing it pre-negated amounts makes every guard
   * false, so a reversal would emit NO CAS and would silently stop mirroring the
   * payment. The file would still parse and would still reconcile; it would just
   * be quietly wrong about the write-off, which is the worst shape available.
   */
  const payment = gen.casSegmentsFor({ writeOffCents: 600, patientCents: 0 });
  const reversal = gen.casSegmentsFor({ writeOffCents: 600, patientCents: 0, reversal: true });
  assert.deepEqual(payment, ['CAS*CO*45*6.00']);
  assert.deepEqual(reversal, ['CAS*CO*45*-6.00']);

  // And the sub-dollar sign bug: Math.trunc(-0.5) is -0, which templates as "0".
  assert.equal(gen.x12Amount(-50), '-0.50');
  assert.equal(gen.x12Amount(50), '0.50');
  assert.equal(gen.x12Amount(-100), '-1.00');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 and 4. The matcher
// ─────────────────────────────────────────────────────────────────────────────

test('R1–R3 each resolve to exactly one claim, and the ranking is not ambiguous', async () => {
  const { manifest, bodies } = generateBodies();
  const { odGet } = fakeOd(manifest);

  for (const label of ['R1', 'R2', 'R3']) {
    const tx = parse835(bodies[label]);
    for (const claim of tx.claims) {
      const proposal = {
        claimNumber: claim.claimNumber,
        patientName: claim.patientName,
        serviceDate: claim.serviceDate,
        totalBilledCents: Math.abs(claim.totalBilledCents),
        lines: claim.procedures.map((p) => ({
          billedCode: p.billedCode,
          paidCode: p.paidCode,
          code: p.code,
        })),
      };
      const found = await odClaimReads.findClaimCandidates(odGet, proposal);
      const ranked = claimMatch.rankCandidates(proposal, found.candidates, {
        patientResolvedByLink: found.patientResolvedByLink,
      });

      const top = ranked.candidates[0];
      assert.ok(top, `${label} claim ${claim.claimNumber}: expected a candidate`);
      assert.equal(
        top.odClaimNum,
        Number(claim.claimNumber),
        `${label} claim ${claim.claimNumber}: the top candidate must be the claim the 835 names`
      );
      assert.equal(
        ranked.ambiguous,
        false,
        `${label} claim ${claim.claimNumber}: the ranking must not be ambiguous ` +
          `(margin ${ranked.margin}, ${ranked.candidates.length} offered)`
      );
      /*
       * A STRONG candidate, not merely the best of a weak field. The band matters
       * because it is what the screen shows the biller, and "the top of three
       * poor options" is a different sentence from "this is the one".
       */
      assert.ok(
        top.score >= 70,
        `${label} claim ${claim.claimNumber}: expected a strong score, got ${top.score}`
      );
    }
  }
});

/**
 * W-6 — THE REVERSAL THE APPROVE GATE COULD NEVER PASS.
 *
 * Found live on the combined walk, 2026-09-04, on claim 53863. R3 pairs to its
 * chart line correctly and then `pairLines` measured the distance between them
 * with a RAW SUBTRACTION: `-3500 − 3500 = -7000`, rendered on screen as
 * "D0220 was billed -$35.00 on the remittance and $35.00 in Open Dental" and
 * "-$70.00 apart". `lineDecisions` turns any non-zero `odFeeDeltaCents` into
 * `od_fee_disagrees`, which makes the verdict RED, which fails the gate's
 * `PATIENT_RESPONSIBILITY_MATCHES`. A reversal that did NOT pair went red on
 * `line_not_in_chart` instead — so BOTH branches were red and no
 * parser-produced reversal 835 could ever be approved. The path had never been
 * green end to end.
 *
 * It hid because the recoupment tests build claims by hand with
 * `odFeeDeltaCents: 0`. So this runs the REAL chain — `parse835` output, the
 * real `pairLines` on the takeback lane, the real `verdictFor` — and asserts the
 * exact predicate the gate keys on.
 */
test('W-6: a parser-produced reversal pairs at ZERO delta and its verdict is not red', () => {
  const { manifest, bodies } = generateBodies();

  const tx = parse835(bodies.R3);
  const claim = tx.claims[0];
  assert.equal(claim.isReversal, true, 'R3 must parse as a reversal');
  assert.ok(claim.totalBilledCents < 0, 'a reversal carries negated amounts');

  const target = T.TARGETS.find((t) => t.remittance === 'R3');
  assert.ok(target, 'R3 must have a target');

  /*
   * The chart as it stands when a takeback is worked: the line is PAID. That is
   * the precondition `isReversibleLine` requires, and the state the walk had to
   * hand-post to reach.
   */
  const odLines = [
    {
      claimProcNum: target.claimProcNum || 535780,
      code: target.procCode,
      deleted: false,
      isTransfer: false,
      blockedStatus: false,
      feeBilledCents: target.billedCents,
      insPayAmtCents: target.paidCents,
      writeOffCents: target.billedCents - target.allowedCents,
      claimPaymentNum: 21490,
    },
  ];

  const pairs = claimMatch.pairLines(
    claim.procedures.map((p, i) => ({
      lineId: `line-${i}`,
      position: i + 1,
      billedCode: p.billedCode,
      paidCode: p.paidCode,
      code: p.code,
      billedCents: p.billedCents,
    })),
    odLines,
    { takeback: true }
  );

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].odClaimProcNum, odLines[0].claimProcNum, 'the reversal must pair');
  assert.equal(
    pairs[0].billedDeltaCents,
    0,
    `a mirrored reversal is ZERO apart, got ${pairs[0].billedDeltaCents} ` +
      '(a raw subtraction gives -2×the fee, which is what stranded the walk)'
  );

  // …and the verdict the gate reads, built from the parser's own figures.
  const verdict = lineDecisions.verdictFor({
    register: 'projection',
    lines: claim.procedures.map((p, i) => ({
      lineId: `line-${i}`,
      code: p.code,
      billedCents: p.billedCents,
      allowedCents: p.allowedCents,
      paidCents: p.paidCents,
      decision: null,
      odClaimProcNum: pairs[i].odClaimProcNum,
      odFeeDeltaCents: pairs[i].billedDeltaCents,
    })),
  });

  assert.deepEqual(
    verdict.problems.map((p) => p.kind),
    [],
    `a mirrored reversal raises no problems, got ${JSON.stringify(verdict.problems)}`
  );
  /*
   * THE GATE'S OWN PREDICATE. `approvalGate` adds
   * `PATIENT_RESPONSIBILITY_MATCHES` as `verdict.state !== 'red'`, so this is
   * the condition that was failing, asserted in the same terms.
   */
  assert.notEqual(verdict.state, 'red', `verdict: ${verdict.sentence}`);
});

test('W-6: a reversal whose signs do NOT mirror the chart still reports a disagreement', () => {
  /*
   * FAILING CLOSED. Normalising by magnitude alone would make a same-sign line
   * — a reversal claiming a POSITIVE billed figure — silently agree with the
   * chart. That is a genuinely odd line and it must stay red.
   */
  const odLines = [
    {
      claimProcNum: 999,
      code: 'D0220',
      deleted: false,
      isTransfer: false,
      blockedStatus: false,
      feeBilledCents: 3500,
      insPayAmtCents: 2900,
      writeOffCents: 600,
      claimPaymentNum: 21490,
    },
  ];
  const pairs = claimMatch.pairLines(
    [{ lineId: 'l1', position: 1, code: 'D0220', billedCents: 3500 }],
    odLines,
    { takeback: true }
  );
  assert.equal(pairs[0].odClaimProcNum, 999);
  assert.equal(
    pairs[0].billedDeltaCents,
    0,
    'a positive line equal to the chart is still zero apart — magnitudes agree'
  );

  const mismatched = claimMatch.pairLines(
    [{ lineId: 'l1', position: 1, code: 'D0220', billedCents: 5000 }],
    odLines,
    { takeback: true }
  );
  assert.equal(
    mismatched[0].billedDeltaCents,
    1500,
    'a positive line that disagrees is reported by raw subtraction, not normalised away'
  );
});

test('R4 resolves to NOTHING — the §15.1c dead end, and it must stay reachable', async () => {
  const { manifest, bodies } = generateBodies();
  const { odGet } = fakeOd(manifest);

  const tx = parse835(bodies.R4);
  assert.equal(tx.claims.length, 1);
  const claim = tx.claims[0];

  // The claim number in the file is REAL — that is what makes the dead end sharp.
  const r4Target = manifest.targets.find((t) => t.remittance === 'R4');
  assert.equal(
    claim.claimNumber,
    String(r4Target.claimNum),
    'R4 must carry the REAL ClaimNum: candidates are gathered by PATIENT, never by claim number, ' +
      'so the right number being in the file is exactly what makes §15.1c bite'
  );

  const proposal = {
    claimNumber: claim.claimNumber,
    patientName: claim.patientName,
    serviceDate: claim.serviceDate,
    totalBilledCents: claim.totalBilledCents,
    lines: claim.procedures.map((p) => ({ billedCode: p.billedCode, paidCode: p.paidCode, code: p.code })),
  };
  const found = await odClaimReads.findClaimCandidates(odGet, proposal);

  assert.equal(found.candidates.length, 0, 'R4 must find no candidate at all');
  assert.equal(found.patientsConsidered.length, 0, 'and it must not even reach a patient');

  /*
   * `no_candidate` must mean what it is documented to mean — "a search ran
   * against this office's Open Dental and found nothing" — rather than "a search
   * found three claims and disqualified all three". The distinction is invisible
   * on the screen a biller acts on, and it is the difference between the dead end
   * §15.1c describes and an ordinary name mismatch.
   */
  const ranked = claimMatch.rankCandidates(proposal, found.candidates, {
    patientResolvedByLink: found.patientResolvedByLink,
  });
  assert.equal(ranked.rejected, 0);
  assert.deepEqual(ranked.rejectedReasons, { nameMismatch: 0, belowScore: 0 });
});

/** Split out so the control test reads as one assertion rather than a setup block. */
function fakeManifestAndOd() {
  const manifest = fakeManifest();
  return { manifest, ...fakeOd(manifest) };
}

test('the control: the two real chart names DO resolve through the same fake', async () => {
  const { odGet } = fakeManifestAndOd();
  for (const [name, expected] of [
    ['Stedi Test 2', [12827]],
    ['MangoTest Test', [12828, 12827]],
  ]) {
    const found = await odClaimReads.searchPatientsByName(odGet, name);
    assert.deepEqual(
      found.patients.map((p) => p.PatNum).sort((a, b) => a - b),
      [...expected].sort((a, b) => a - b),
      `${name} must resolve — otherwise R4 finding nobody proves nothing`
    );
  }

  // And the transposition finds nobody, through the same fake, in the same run.
  const dead = await odClaimReads.searchPatientsByName(
    odGet,
    `${T.R4_TRANSPOSED.first} ${T.R4_TRANSPOSED.last}`
  );
  assert.deepEqual(dead.patients, []);
});

test('the transposition is checked against every patient, in both directions', () => {
  const patients = CHART_PATIENTS.map((p) => ({ patNum: p.PatNum, last: p.LName, first: p.FName }));
  assert.equal(gen.assertTransposition(T.R4_TRANSPOSED, patients), null);

  /*
   * Open Dental PREFIX-matches, so a transposition that merely DIFFERS is not
   * enough. Each of these would silently turn R4 into an ordinary match.
   */
  assert.match(
    String(gen.assertTransposition({ last: 'Tes', first: 'ZZZZ' }, patients)),
    /PREFIX-MATCHES/,
    'a shorter prefix of a real surname must be refused'
  );
  assert.match(
    String(gen.assertTransposition({ last: 'Testing', first: 'ZZZZ' }, patients)),
    /PREFIX-MATCHES/,
    'a longer string that a real surname prefixes must be refused too'
  );
  assert.match(
    String(gen.assertTransposition({ last: 'ZZZZ', first: 'Stedi' }, patients)),
    /PREFIX-MATCHES/,
    'the forename lane counts as well'
  );
  /*
   * AND THE CROSS-PATIENT CASE, which is the one that would be easy to miss: the
   * search is by NAME and a name is not scoped to a PatNum, so a token that
   * prefix-matches the OTHER test patient returns a candidate just the same.
   */
  assert.match(
    String(gen.assertTransposition({ last: 'MangoTest', first: 'ZZZZ' }, patients)),
    /PREFIX-MATCHES PatNum 12828/,
    "a surname that matches the other patient's FORENAME must be refused"
  );
});

test('a stale manifest is refused — by a named spent id, and by being older than the last retirement', () => {
  /*
   * Walk night 2's defect, ported. The id check fires on a collision; the date
   * check catches a manifest written before a run that has since been unwound
   * whose ids happen not to collide. Both are needed and neither subsumes the
   * other.
   */
  const fresh = fakeManifest();
  assert.equal(T.screenManifestForSpentIds(fresh), null);

  assert.match(
    String(T.screenManifestForSpentIds({ targets: [] })),
    /no usable `createdAt`/,
    'a manifest with no createdAt did not come from any prep this repo has shipped'
  );

  assert.match(
    String(
      T.screenManifestForSpentIds({
        createdAt: '2020-01-01T00:00:00.000Z',
        targets: [{ claimNum: 999999 }],
      })
    ),
    /BEFORE the most recent/,
    'a manifest older than the last retirement is dead even without a collision'
  );

  // And a named spent id, whichever ids the deny-list currently holds.
  const denied = T.denyIds();
  if (denied.length) {
    assert.match(
      String(
        T.screenManifestForSpentIds({
          createdAt: new Date().toISOString(),
          targets: [{ claimNum: denied[0] }],
        })
      ),
      /RETIRED id/
    );
  }
});
