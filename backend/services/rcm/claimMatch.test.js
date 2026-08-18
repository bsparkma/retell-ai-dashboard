'use strict';

/**
 * The match core, tested exhaustively — because it is PURE and therefore can be.
 *
 * No I/O, no clock, no Open Dental, no database. Every test below is a claim
 * about arithmetic or about a documented Open Dental behaviour, and every OD
 * row here is in the SHAPE the live API returns: string enums (`Status:
 * "Received"`, `ProcStatus: "D"`), decimal-dollar amounts, `IsTransfer`, and
 * the `-1` "not calculated" sentinel.
 *
 * The invariant this file exists to defend, above every score: **nothing here
 * decides anything.** A HIGH score is an argument a human agrees or disagrees
 * with; ambiguity is reported, not resolved.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const m = require('./claimMatch');

// ─── Fixtures, in Open Dental's own shapes ───────────────────────────────────

/** The proposal side: what a carrier's remittance said. Money in CENTS. */
function proposal(over = {}) {
  return {
    claimNumber: '53648',
    patientName: 'Fixture, Synthetic',
    serviceDate: '2026-03-02',
    totalBilledCents: 21000,
    lines: [{ lineId: 'pl-1', position: 1, billedCode: 'D0150', billedCents: 21000 }],
    ...over,
  };
}

/** An OD claimproc row, in the shape `GET /claimprocs` returns. */
function claimProc(over = {}) {
  return {
    ClaimProcNum: 99001,
    ClaimNum: 53648,
    ProcNum: 8801,
    Status: 'NotReceived',
    FeeBilled: 210.0, // DOLLARS on the wire
    InsPayAmt: 0,
    WriteOff: 0,
    DedApplied: 0,
    IsTransfer: false,
    ClaimPaymentNum: 0, // zero is OD's "no check", not a check numbered zero
    ...over,
  };
}

/** An OD procedurelog row. */
function procedure(over = {}) {
  return { ProcNum: 8801, PatNum: 12828, procCode: 'D0150', ProcStatus: 'C', ProcFee: 210.0, ...over };
}

/** A whole candidate, assembled the way the shell hands it over. */
function candidate(over = {}) {
  const procs = over.procedures || [procedure()];
  return {
    claim: { ClaimNum: 53648, PatNum: 12828, DateService: '2026-03-02', ClaimFee: 210.0, ClaimStatus: 'S', ...over.claim },
    claimProcs: over.claimProcs || [claimProc()],
    procedures: new Map(procs.map((p) => [p.ProcNum, p])),
    patient: over.patient === undefined
      ? { PatNum: 12828, LName: 'Fixture', FName: 'Synthetic', Birthdate: '1990-01-01' }
      : over.patient,
  };
}

/** Did the result carry this evidence tag? */
function has(result, tag) {
  return result.evidence.some((e) => e.tag === tag);
}

/** The blocker codes on a result. */
function blockerCodes(result) {
  return result.blockers.map((b) => b.code);
}

// ─── Normalizers ─────────────────────────────────────────────────────────────

test('procCode strips the X12 ADA qualifier an 835 carries', () => {
  // SVC01 arrives as `AD:D0150`; Open Dental stores `D0150`. Comparing the raw
  // strings would find nothing, on every line of every remittance.
  assert.equal(m.procCode('AD:D0150'), 'D0150');
  assert.equal(m.procCode('D0150'), 'D0150');
  assert.equal(m.procCode('ad:d2740'), 'D2740');
});

test('procCode does not strip AD from something that is not a qualified code', () => {
  // The stripper only fires when what follows still looks like an ADA code, so
  // a code that merely begins with those letters survives intact.
  assert.equal(m.procCode('ADJUST'), 'ADJUST');
  assert.equal(m.procCode('AD'), 'AD');
});

test('procCode tolerates missing and non-string input', () => {
  assert.equal(m.procCode(null), '');
  assert.equal(m.procCode(undefined), '');
  assert.equal(m.procCode({}), '');
});

test("isoDay refuses Open Dental's 0001-01-01 null date", () => {
  // OD stores '0001-01-01' rather than SQL NULL. Read as a real date it would
  // score as a two-thousand-year mismatch instead of as an absent date.
  assert.equal(m.isoDay('0001-01-01'), null);
  assert.equal(m.isoDay('2026-03-02'), '2026-03-02');
  assert.equal(m.isoDay('2026-03-02T00:00:00.000Z'), '2026-03-02');
  assert.equal(m.isoDay(new Date('2026-03-02T12:00:00Z')), '2026-03-02');
  assert.equal(m.isoDay(null), null);
  assert.equal(m.isoDay('not a date'), null);
});

test('dollarsToCents rounds half away from zero, in both directions', () => {
  assert.equal(m.dollarsToCents(210), 21000);
  assert.equal(m.dollarsToCents(0.1 + 0.2), 30); // the classic float, landed exactly
  // 0.125 is exactly representable in binary, so 12.5 really is a half — and it
  // rounds AWAY from zero on both sides rather than to-even. (A decimal like
  // 1.005 is NOT representable; it is 1.00499… before it reaches us, so no
  // rounding rule can recover the third decimal a human typed. Open Dental
  // sends two-decimal money, which is why that is a curiosity and not a bug.)
  assert.equal(m.dollarsToCents(0.125), 13);
  assert.equal(m.dollarsToCents(-0.125), -13);
  assert.equal(m.dollarsToCents(-0.2), -20); // recoupments are legitimately negative
  assert.equal(m.dollarsToCents('12.34'), 1234);
  assert.equal(m.dollarsToCents(undefined), 0);
});

test('nameTokens drops middle initials rather than letting them cost a match', () => {
  // "SMITH JOHN Q" and "Smith, John" are the same person; a one-letter token
  // that failed to match would push a real match down a confidence band.
  assert.deepEqual(m.nameTokens('FIXTURE SYNTHETIC Q'), ['FIXTURE', 'SYNTHETIC']);
  assert.deepEqual(m.nameTokens('Fixture, Synthetic'), ['FIXTURE', 'SYNTHETIC']);
  assert.deepEqual(m.nameTokens(''), []);
  assert.deepEqual(m.nameTokens(null), []);
});

// ─── Scoring — the positive signals ──────────────────────────────────────────

test('a perfect candidate scores HIGH with every positive tag', () => {
  const r = m.scoreCandidate(proposal(), candidate());
  assert.equal(r.confidence, 'HIGH');
  for (const tag of [
    'CLAIM_NUMBER_MATCH',
    'PATIENT_NAME_MATCH',
    'SERVICE_DATE_MATCH',
    'CODES_ALL_PRESENT',
    'BILLED_AMOUNT_MATCH',
    'LINE_COUNT_MATCH',
  ]) {
    assert.ok(has(r, tag), `expected ${tag}`);
  }
  assert.equal(r.odClaimNum, 53648);
  assert.equal(r.odPatNum, 12828);
});

test('the score is the sum of its evidence weights, clamped to 0..100', () => {
  // The score is not a black box: a biller reading the evidence list can add it
  // up themselves, and that is the point of returning weights at all.
  const r = m.scoreCandidate(proposal(), candidate());
  const sum = r.evidence.reduce((s, e) => s + e.weight, 0);
  assert.equal(r.score, Math.max(0, Math.min(100, sum)));
  assert.ok(r.score <= 100);
});

test('a surname-only name match is weaker than a full one, and says so', () => {
  const r = m.scoreCandidate(
    proposal({ patientName: 'Fixture, Different' }),
    candidate()
  );
  assert.ok(has(r, 'PATIENT_NAME_PARTIAL'));
  assert.ok(!has(r, 'PATIENT_NAME_MATCH'));
});

test('a name that shares nothing is negative evidence, not merely absent evidence', () => {
  const r = m.scoreCandidate(proposal({ patientName: 'Other, Person' }), candidate());
  assert.ok(has(r, 'PATIENT_NAME_MISMATCH'));
  assert.ok(r.evidence.find((e) => e.tag === 'PATIENT_NAME_MISMATCH').weight < 0);
});

test('a name emits no tag at all when the chart has no patient row to compare', () => {
  const r = m.scoreCandidate(proposal(), candidate({ patient: null }));
  assert.ok(!has(r, 'PATIENT_NAME_MATCH'));
  assert.ok(!has(r, 'PATIENT_NAME_MISMATCH'));
});

// ─── Scoring — dates ─────────────────────────────────────────────────────────

test('a service date within the near window is weaker evidence, with the gap named', () => {
  const r = m.scoreCandidate(proposal({ serviceDate: '2026-03-05' }), candidate());
  assert.ok(has(r, 'SERVICE_DATE_NEAR'));
  assert.equal(r.evidence.find((e) => e.tag === 'SERVICE_DATE_NEAR').note, '3 days apart');
});

test('the near-date window boundary is inclusive, and one day past it flips', () => {
  const at = m.scoreCandidate(proposal({ serviceDate: '2026-03-09' }), candidate()); // 7 days
  assert.ok(has(at, 'SERVICE_DATE_NEAR'));
  const past = m.scoreCandidate(proposal({ serviceDate: '2026-03-10' }), candidate()); // 8
  assert.ok(has(past, 'SERVICE_DATE_MISMATCH'));
});

test('date distance is absolute — a chart date after the remittance scores the same', () => {
  const before = m.scoreCandidate(proposal({ serviceDate: '2026-02-28' }), candidate());
  const after = m.scoreCandidate(proposal({ serviceDate: '2026-03-04' }), candidate());
  assert.equal(before.score, after.score);
});

test("a claim with Open Dental's null service date emits no date tag", () => {
  const r = m.scoreCandidate(proposal(), candidate({ claim: { DateService: '0001-01-01' } }));
  assert.ok(!has(r, 'SERVICE_DATE_MATCH'));
  assert.ok(!has(r, 'SERVICE_DATE_MISMATCH'));
  assert.equal(r.od.dateService, null);
});

// ─── Scoring — money ─────────────────────────────────────────────────────────

test('the billed total is compared against LIVE lines, not the claim fee', () => {
  // ClaimFee still includes soft-deleted procedures. Counting them is exactly
  // the arithmetic that over-applied a reversal by $2.00 in the write spike.
  const r = m.scoreCandidate(
    proposal({ totalBilledCents: 21000 }),
    candidate({
      claim: { ClaimFee: 410.0 }, // OD's total, inflated by a deleted line
      claimProcs: [claimProc(), claimProc({ ClaimProcNum: 99002, ProcNum: 8802, FeeBilled: 200.0 })],
      procedures: [procedure(), procedure({ ProcNum: 8802, ProcStatus: 'D', procCode: 'D0220' })],
    })
  );
  assert.ok(has(r, 'BILLED_AMOUNT_MATCH'), 'the deleted $200 line must not count');
  assert.equal(r.od.deletedLineCount, 1);
});

test('a difference inside the $1.00 tolerance is NEAR, and the delta is reported', () => {
  const r = m.scoreCandidate(proposal({ totalBilledCents: 21100 }), candidate());
  assert.ok(has(r, 'BILLED_AMOUNT_NEAR'));
  assert.equal(r.evidence.find((e) => e.tag === 'BILLED_AMOUNT_NEAR').note, '$1.00 apart');
});

test('a money delta is written the way a biller reads money', () => {
  // Cents at the scale of a rounding disagreement; dollars once it is a real
  // discrepancy. "98400¢ apart" is a number somebody has to decode before they
  // can act on it, mid-decision.
  assert.equal(m.describeDelta(40), '40¢ apart');
  assert.equal(m.describeDelta(99), '99¢ apart');
  assert.equal(m.describeDelta(100), '$1.00 apart');
  assert.equal(m.describeDelta(98400), '$984.00 apart');
  assert.equal(m.describeDelta(-250), '$2.50 apart');
});

test('the money tolerance boundary is exactly $1.00, and a cent past it flips', () => {
  assert.equal(m.AMOUNT_NEAR_CENTS, 100);
  const at = m.scoreCandidate(proposal({ totalBilledCents: 21000 + m.AMOUNT_NEAR_CENTS }), candidate());
  assert.ok(has(at, 'BILLED_AMOUNT_NEAR'));
  const past = m.scoreCandidate(proposal({ totalBilledCents: 21000 + m.AMOUNT_NEAR_CENTS + 1 }), candidate());
  assert.ok(has(past, 'BILLED_AMOUNT_MISMATCH'));
});

test('no money tag is emitted when either side has no billed amount', () => {
  // Silence is honest here. A zero-vs-something comparison would manufacture a
  // mismatch out of an absence.
  const r = m.scoreCandidate(proposal({ totalBilledCents: 0 }), candidate());
  assert.ok(!has(r, 'BILLED_AMOUNT_MATCH'));
  assert.ok(!has(r, 'BILLED_AMOUNT_MISMATCH'));
});

// ─── Scoring — codes ─────────────────────────────────────────────────────────

test('a downcode matches on EITHER code, because the chart carries the other one', () => {
  // SVC01 is the ADJUDICATED code and SVC06 the ORIGINAL SUBMITTED one. On a
  // downcoded line the payer names one and Open Dental carries the other;
  // looking at only one would make every downcode read as a code mismatch.
  const r = m.scoreCandidate(
    proposal({ lines: [{ lineId: 'pl-1', billedCode: 'D0120', paidCode: 'D0150', billedCents: 21000 }] }),
    candidate()
  );
  assert.ok(has(r, 'CODES_ALL_PRESENT'));
});

test('code coverage is counted per proposal LINE, not per distinct code', () => {
  // Four lines of which one matches is 1/4, not "half the codes present".
  const lines = ['D0150', 'D1110', 'D0274', 'D2391'].map((c, i) => ({
    lineId: `pl-${i}`,
    billedCode: c,
    billedCents: 1000,
  }));
  const r = m.scoreCandidate(proposal({ lines }), candidate());
  assert.ok(has(r, 'CODES_ABSENT'));
  assert.equal(r.evidence.find((e) => e.tag === 'CODES_ABSENT').note, '1/4');
});

test('half the lines matching is CODES_PARTIAL', () => {
  const r = m.scoreCandidate(
    proposal({
      lines: [
        { lineId: 'a', billedCode: 'D0150', billedCents: 1000 },
        { lineId: 'b', billedCode: 'D9999', billedCents: 1000 },
      ],
    }),
    candidate()
  );
  assert.ok(has(r, 'CODES_PARTIAL'));
  assert.equal(r.evidence.find((e) => e.tag === 'CODES_PARTIAL').note, '1/2');
});

test('a deleted procedure does not lend its code to a match', () => {
  const r = m.scoreCandidate(
    proposal({ lines: [{ lineId: 'a', billedCode: 'D0150', billedCents: 21000 }] }),
    candidate({ procedures: [procedure({ ProcStatus: 'D' })] })
  );
  assert.ok(has(r, 'CODES_ABSENT'));
});

test('a line code falls back to CodeSent when the procedure was not scanned', () => {
  // The procedure scan is page-capped; a claimproc whose procedure fell outside
  // it still knows what it billed.
  const r = m.scoreCandidate(
    proposal(),
    candidate({ claimProcs: [claimProc({ CodeSent: 'D0150' })], procedures: [] })
  );
  assert.ok(has(r, 'CODES_ALL_PRESENT'));
});

// ─── Pre-flight blockers — what Slice 6c will refuse on ──────────────────────

test('IsTransfer is surfaced as a blocking pre-flight fact', () => {
  // PUT /claimprocs is refused when IsTransfer is true. Showing it at match
  // time is the difference between a biller seeing the refusal and hitting it.
  const r = m.scoreCandidate(proposal(), candidate({ claimProcs: [claimProc({ IsTransfer: true })] }));
  assert.ok(blockerCodes(r).includes('LINE_IS_TRANSFER'));
  assert.equal(r.blockers.find((b) => b.code === 'LINE_IS_TRANSFER').blocking, true);
});

test('every claimproc status Open Dental refuses to update is blocking', () => {
  for (const status of m.BLOCKED_CLAIMPROC_STATUSES) {
    const r = m.scoreCandidate(proposal(), candidate({ claimProcs: [claimProc({ Status: status })] }));
    assert.ok(blockerCodes(r).includes('LINE_STATUS_BLOCKED'), `${status} should block`);
  }
  assert.deepEqual(
    [...m.BLOCKED_CLAIMPROC_STATUSES],
    ['Adjustment', 'InsHist', 'CapClaim', 'CapComplete', 'CapEstimate']
  );
});

test('an attached ClaimPayment is blocking — InsPayAmt is locked once a check exists', () => {
  const r = m.scoreCandidate(proposal(), candidate({ claimProcs: [claimProc({ ClaimPaymentNum: 4471 })] }));
  assert.ok(blockerCodes(r).includes('LINE_HAS_CLAIM_PAYMENT'));
});

test('ClaimPaymentNum 0 is "no check", not a check numbered zero', () => {
  const r = m.scoreCandidate(proposal(), candidate());
  assert.ok(!blockerCodes(r).includes('LINE_HAS_CLAIM_PAYMENT'));
  assert.equal(r.od.lines[0].claimPaymentNum, null);
});

test('an already-Received claim is flagged but NOT blocking', () => {
  // A second payment on a received claim is a supplemental, not a receive. That
  // is a different call, not an impossible one.
  const r = m.scoreCandidate(proposal(), candidate({ claim: { ClaimStatus: 'R' } }));
  const blocker = r.blockers.find((b) => b.code === 'CLAIM_ALREADY_RECEIVED');
  assert.ok(blocker);
  assert.equal(blocker.blocking, false);
});

test('a claim whose every line is unusable reports NO_PAYABLE_LINES', () => {
  const r = m.scoreCandidate(
    proposal(),
    candidate({
      claimProcs: [claimProc({ IsTransfer: true }), claimProc({ ClaimProcNum: 99002, Status: 'InsHist' })],
    })
  );
  assert.ok(blockerCodes(r).includes('NO_PAYABLE_LINES'));
});

test('a clean candidate carries no blockers at all', () => {
  assert.deepEqual(blockerCodes(m.scoreCandidate(proposal(), candidate())), []);
});

test('deleted lines are excluded from the OD amounts recorded in the snapshot', () => {
  const r = m.scoreCandidate(
    proposal(),
    candidate({
      claimProcs: [
        claimProc({ InsPayAmt: 150.0, WriteOff: 60.0 }),
        claimProc({ ClaimProcNum: 99002, ProcNum: 8802, InsPayAmt: 99.0, WriteOff: 1.0 }),
      ],
      procedures: [procedure(), procedure({ ProcNum: 8802, ProcStatus: 'D' })],
    })
  );
  assert.equal(r.od.insPaidCents, 15000, 'the deleted line must not be counted');
  assert.equal(r.od.writeOffCents, 6000);
  assert.ok(blockerCodes(r).includes('DELETED_PROCEDURES_EXCLUDED'));
});

// --- The tri-state `deleted`, exercised on the branch it was written for -----

/**
 * A claimproc whose procedure the read shell could NOT return.
 *
 * The dangerous case, and the reason `deleted` is tri-state: `DELETE
 * /procedurelogs` is a SOFT delete (G12), so without the procedure row a
 * deleted line and a live one are indistinguishable - and an Open Dental key
 * without the `/procedurelogs` resource returns no rows at all, silently.
 */
function unreadable(over = {}) {
  return candidate({
    claimProcs: [claimProc(), claimProc({ ClaimProcNum: 99002, ProcNum: 8802, FeeBilled: 100.0 })],
    // 8802 deliberately absent from the map.
    procedures: [procedure()],
    ...over,
  });
}

test("a procedure that could not be read is 'unknown', not 'not deleted'", () => {
  const lines = m.summariseLines(
    [claimProc(), claimProc({ ClaimProcNum: 99002, ProcNum: 8802 })],
    new Map([[8801, procedure()]])
  );
  assert.equal(lines[0].deleted, false);
  assert.equal(lines[1].deleted, 'unknown');
});

test('an ABSENT ProcNum is unknown - not mistaken for the claim-level row', () => {
  /*
   * `Number(null)` is 0 and `Number(undefined)` is NaN, so a claimproc whose
   * ProcNum Open Dental omits or nulls used to read as OD's legitimate
   * claim-level `ProcNum 0` row - which has no procedure and is therefore
   * correctly `deleted: false`. That is the original soft-delete defect moved
   * from the procedure row to the FIELD.
   */
  const lines = m.summariseLines(
    [
      claimProc({ ClaimProcNum: 1, ProcNum: undefined }),
      claimProc({ ClaimProcNum: 2, ProcNum: null }),
      claimProc({ ClaimProcNum: 3, ProcNum: '' }),
      claimProc({ ClaimProcNum: 4, ProcNum: 0 }), // OD's claim-level row
    ],
    new Map()
  );
  assert.deepEqual(
    lines.map((l) => l.deleted),
    ['unknown', 'unknown', 'unknown', false]
  );
  assert.deepEqual(
    lines.map((l) => l.procNum),
    [null, null, null, 0]
  );
});

test('an unknown line is EXCLUDED from every amount', () => {
  const scored = m.scoreCandidate(proposal(), unreadable());
  // $210 live + $100 unreadable. Only the live one counts.
  assert.equal(scored.od.billedCents, 21000);
  assert.equal(scored.od.unknownDeletedLineCount, 1);
  // ...and the claim HEADER total is untouched and still contaminated, which is
  // exactly why it is named `claimHeaderFeeCents` rather than "the billed
  // amount". 6c re-verifies against `billedCents`.
  assert.equal(scored.od.claimHeaderFeeCents, 21000);
});

test('an unknown line suppresses the billed tag entirely - neither MATCH nor MISMATCH', () => {
  // Silence is the honest answer: the chart total is neither trustworthy nor
  // knowably wrong, so asserting either would be an assertion we cannot make.
  const scored = m.scoreCandidate(proposal(), unreadable());
  assert.equal(has(scored, 'BILLED_AMOUNT_MATCH'), false);
  assert.equal(has(scored, 'BILLED_AMOUNT_NEAR'), false);
  assert.equal(has(scored, 'BILLED_AMOUNT_MISMATCH'), false);
  assert.ok(blockerCodes(scored).includes('DELETED_STATUS_UNKNOWN'));
  // Blocking, not a caution: 6c would be PUTting money against a line that may
  // be a soft-deleted procedure.
  const blocker = scored.blockers.find((b) => b.code === 'DELETED_STATUS_UNKNOWN');
  assert.equal(blocker.blocking, true);
  assert.equal(blocker.count, 1);
});

test('an unknown line is NOT PAIRABLE', () => {
  // Pairing writes a ClaimProcNum that Slice 6c PUTs money against. An unread
  // procedure may be a soft-deleted one, so it is ineligible exactly like a
  // deleted, transferred, blocked or already-paid line.
  const lines = m.summariseLines(
    [claimProc({ ClaimProcNum: 99002, ProcNum: 8802 })],
    new Map() // 8802 unreadable
  );
  assert.equal(lines[0].deleted, 'unknown');
  const [pair] = m.pairLines(proposal().lines, lines);
  assert.equal(pair.odClaimProcNum, null);
  assert.equal(pair.reason, 'no postable line on this claim');
});

test('an unknown line still lends its CODE - money and identity fail differently', () => {
  /*
   * A line we cannot vouch for is out of every TOTAL, because a wrong total is
   * a wrong answer with no flag on it. But its code still answers "is this the
   * same claim?", and excluding it there would make a claim harder to recognise
   * for a reason that has nothing to do with recognising it.
   */
  const scored = m.scoreCandidate(
    proposal({ lines: [{ lineId: 'pl-1', position: 1, billedCode: 'D2740', billedCents: 10000 }] }),
    candidate({
      claimProcs: [claimProc({ ClaimProcNum: 99002, ProcNum: 8802, CodeSent: 'D2740' })],
      procedures: [], // 8802 unreadable
    })
  );
  assert.ok(has(scored, 'CODES_ALL_PRESENT'), 'the code is still evidence');
  assert.equal(scored.od.billedCents, 0, 'but the money is not');
});

test('a KNOWN-deleted line is out of BOTH money and identity', () => {
  // The one case with positive evidence the procedure is gone.
  const scored = m.scoreCandidate(
    proposal(),
    candidate({ procedures: [procedure({ ProcStatus: 'D' })] })
  );
  assert.equal(scored.od.billedCents, 0);
  assert.equal(scored.od.deletedLineCount, 1);
  assert.ok(blockerCodes(scored).includes('DELETED_PROCEDURES_EXCLUDED'));
  assert.equal(has(scored, 'CODES_ALL_PRESENT'), false);
});

test('the billed total 6c re-verifies against drops a deleted line the header keeps', () => {
  /*
   * The $2.00 reversal from the spike teardown, in miniature: `ClaimFee` is the
   * claim header and still counts soft-deleted procedures, so the two figures
   * MUST be able to disagree - and both must survive, under names that say
   * which is which.
   */
  const scored = m.scoreCandidate(
    proposal(),
    candidate({
      claim: { ClaimFee: 410.0 }, // header still counts the deleted $200
      claimProcs: [claimProc(), claimProc({ ClaimProcNum: 99002, ProcNum: 8802, FeeBilled: 200.0 })],
      procedures: [procedure(), procedure({ ProcNum: 8802, ProcStatus: 'D' })],
    })
  );
  assert.equal(scored.od.claimHeaderFeeCents, 41000, 'the header, verbatim and contaminated');
  assert.equal(scored.od.billedCents, 21000, 'the live lines, which is what 6c compares');
});

// ─── Ranking and ambiguity ───────────────────────────────────────────────────

test('candidates are ranked highest first', () => {
  // Weak but ABOVE the floor: right patient, right codes, wrong date and money.
  const weaker = candidate({
    claim: { ClaimNum: 60000, DateService: '2025-01-01', ClaimFee: 5.0 },
    claimProcs: [claimProc({ ClaimNum: 60000, ClaimProcNum: 70001, ProcNum: 9901, FeeBilled: 5.0 })],
    procedures: [procedure({ ProcNum: 9901, procCode: 'D0150' })],
  });
  const { candidates } = m.rankCandidates(proposal(), [weaker, candidate()]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].odClaimNum, 53648);
  assert.ok(candidates[0].score > candidates[1].score);
});

test('a candidate below the floor is NOT OFFERED, and the drop is counted', () => {
  // The second line of defence behind the read shell's client-side re-filter:
  // if Open Dental ever ignores the name filter, a stranger's claim must not
  // appear next to a Confirm button just because it was returned.
  const stranger = candidate({
    claim: { ClaimNum: 60000, PatNum: 999, DateService: '2020-01-01', ClaimFee: 5.0 },
    claimProcs: [claimProc({ ClaimNum: 60000, ClaimProcNum: 70001, ProcNum: 9901, FeeBilled: 5.0 })],
    procedures: [procedure({ ProcNum: 9901, procCode: 'D9999' })],
    patient: { PatNum: 999, LName: 'Unrelated', FName: 'Person' },
  });
  const ranked = m.rankCandidates(proposal(), [candidate(), stranger]);
  assert.deepEqual(ranked.candidates.map((c) => c.odClaimNum), [53648]);
  assert.equal(ranked.rejected, 1);
  assert.equal(ranked.rejectedReasons.nameMismatch, 1);
  assert.equal(ranked.minScore, m.MIN_CANDIDATE_SCORE);
});

test('a list of nothing but noise offers NOTHING — which reads as no_candidate', () => {
  const stranger = candidate({
    claim: { ClaimNum: 60000, PatNum: 999, DateService: '2020-01-01', ClaimFee: 5.0 },
    claimProcs: [claimProc({ ClaimNum: 60000, ClaimProcNum: 70001, ProcNum: 9901, FeeBilled: 5.0 })],
    procedures: [procedure({ ProcNum: 9901, procCode: 'D9999' })],
    patient: { PatNum: 999, LName: 'Unrelated', FName: 'Person' },
  });
  const ranked = m.rankCandidates(proposal({ claimNumber: '' }), [stranger, stranger]);
  assert.deepEqual(ranked.candidates, []);
  assert.equal(ranked.rejected, 2);
  assert.equal(ranked.ambiguous, false);
});

test('a name mismatch disqualifies at ANY score', () => {
  // A stranger with a same-day claim and a coincidental fee could clear a
  // numeric floor. Sharing no name token with the chart is disqualifying on its
  // own — that is the signature of an ignored Open Dental name filter.
  const sameDayStranger = candidate({
    claim: { ClaimNum: 70000, PatNum: 999, DateService: '2026-03-02', ClaimFee: 210.0 },
    claimProcs: [claimProc({ ClaimNum: 70000, ClaimProcNum: 70003, ProcNum: 9903, FeeBilled: 210.0 })],
    procedures: [procedure({ ProcNum: 9903, procCode: 'D0150' })],
    patient: { PatNum: 999, LName: 'Unrelated', FName: 'Person' },
  });
  const alone = m.scoreCandidate(proposal({ claimNumber: '' }), sameDayStranger);
  assert.ok(alone.score >= m.MIN_CANDIDATE_SCORE, 'this candidate clears the numeric floor');

  const ranked = m.rankCandidates(proposal({ claimNumber: '' }), [sameDayStranger]);
  assert.deepEqual(ranked.candidates, [], 'and is still not offered');
  assert.equal(ranked.rejectedReasons.nameMismatch, 1);
});

test('a candidate that BARELY clears the floor is still ranked, far below the winner', () => {
  /*
   * The floor excludes noise, not weak-but-real candidates - but a suite where
   * every offered candidate is strong never proves that ranking works ACROSS
   * the range it is supposed to span. This one scores a surname match plus a
   * near date and nothing else, which is the thinnest thing the LOW band is
   * meant to hold.
   */
  const barely = candidate({
    claim: { ClaimNum: 60002, PatNum: 4242, DateService: '2026-03-05', ClaimFee: 210.0 },
    claimProcs: [claimProc({ ClaimNum: 60002, ClaimProcNum: 70004, ProcNum: 9904, FeeBilled: 210.0 })],
    procedures: [procedure({ ProcNum: 9904, procCode: 'D9999' })],
    patient: { PatNum: 4242, LName: 'Fixture', FName: 'Different' },
  });
  const alone = m.scoreCandidate(proposal({ claimNumber: '' }), barely);
  assert.ok(
    alone.score >= m.MIN_CANDIDATE_SCORE && alone.score < 30,
    `expected a barely-passing score, got ${alone.score}`
  );

  const ranked = m.rankCandidates(proposal(), [barely, candidate()]);
  assert.equal(ranked.candidates.length, 2, 'it is offered');
  assert.equal(ranked.candidates[0].odClaimNum, 53648, 'and it is not the winner');
  assert.equal(ranked.candidates[1].confidence, 'LOW');
  assert.ok(ranked.margin > m.AMBIGUITY_MARGIN, 'a gap this wide is not ambiguous');
});

test('the floor is low enough to keep a weak-but-real candidate', () => {
  // A surname match plus a near date clears it. The floor excludes noise, not
  // the LOW band — that band exists precisely for candidates worth a look.
  const partial = candidate({
    claim: { ClaimNum: 60001, DateService: '2026-03-05', ClaimFee: 210.0 },
    claimProcs: [claimProc({ ClaimNum: 60001, ClaimProcNum: 70002, ProcNum: 9902, FeeBilled: 210.0 })],
    procedures: [procedure({ ProcNum: 9902, procCode: 'D9999' })],
    patient: { PatNum: 4242, LName: 'Fixture', FName: 'Different' },
  });
  const ranked = m.rankCandidates(proposal({ claimNumber: '' }), [partial]);
  assert.equal(ranked.candidates.length, 1, 'a surname + near-date match must survive the floor');
});

test('the name rule is OFF when the patient was already linked', () => {
  /*
   * The disqualifier defends against Open Dental returning STRANGERS when a
   * name filter is ignored. On the linked-PatNum lane there are no strangers to
   * defend against - the claims came from that patient's own chart - and a
   * married-name change ("SMITH, J" on the remittance, "JONES, JANE" on a
   * correctly linked chart) shares no token after the >=2-character filter.
   * Left on, it would report no_candidate for every claim on the right patient.
   */
  const married = candidate({
    claim: { ClaimNum: 53648, PatNum: 12828, DateService: '2026-03-02', ClaimFee: 210.0 },
    patient: { PatNum: 12828, LName: 'Jones', FName: 'Jane' },
  });
  const p = proposal({ patientName: 'Smith, J' });

  const byName = m.rankCandidates(p, [married]);
  assert.deepEqual(byName.candidates, [], 'the name-search lane still refuses it');
  assert.equal(byName.rejectedReasons.nameMismatch, 1);
  assert.equal(byName.nameRuleApplied, true);

  const byLink = m.rankCandidates(p, [married], { patientResolvedByLink: true });
  assert.equal(byLink.candidates.length, 1, 'the linked lane offers it');
  assert.equal(byLink.rejectedReasons.nameMismatch, 0);
  assert.equal(byLink.nameRuleApplied, false);
  // The disagreement is still EVIDENCE, and still costs the candidate points.
  assert.ok(has(byLink.candidates[0], 'PATIENT_NAME_MISMATCH'));
});

test('two indistinguishable candidates are AMBIGUOUS and neither is chosen', () => {
  // The whole point. Ambiguity is displayed, not resolved — the same stance
  // callTwins.findTwin takes on the voice side, where two matches are a
  // refusal rather than a coin flip.
  const twin = candidate({
    claim: { ClaimNum: 53649, PatNum: 12828, DateService: '2026-03-02', ClaimFee: 210.0, ClaimStatus: 'S' },
    claimProcs: [claimProc({ ClaimNum: 53649, ClaimProcNum: 99002, ProcNum: 8802 })],
    procedures: [procedure({ ProcNum: 8802 })],
  });
  const ranked = m.rankCandidates(proposal({ claimNumber: '' }), [candidate(), twin]);
  assert.equal(ranked.ambiguous, true);
  assert.equal(ranked.margin, 0);
  assert.equal(ranked.candidates.length, 2, 'nothing is dropped for being ambiguous');
});

test('a clear winner is not ambiguous', () => {
  // Both above the floor, so a margin genuinely exists to be compared.
  const weaker = candidate({
    claim: { ClaimNum: 60000, DateService: '2025-06-01', ClaimFee: 5.0 },
    claimProcs: [claimProc({ ClaimNum: 60000, ClaimProcNum: 70001, ProcNum: 9901, FeeBilled: 5.0 })],
    procedures: [procedure({ ProcNum: 9901, procCode: 'D0150' })],
  });
  const ranked = m.rankCandidates(proposal(), [candidate(), weaker]);
  assert.equal(ranked.candidates.length, 2);
  assert.equal(ranked.ambiguous, false);
  assert.ok(ranked.margin >= m.AMBIGUITY_MARGIN);
});

test('a single candidate is never ambiguous, and reports no margin', () => {
  const ranked = m.rankCandidates(proposal(), [candidate()]);
  assert.equal(ranked.ambiguous, false);
  assert.equal(ranked.margin, null);
});

test('no candidates ranks to an empty, non-ambiguous result', () => {
  const ranked = m.rankCandidates(proposal(), []);
  assert.deepEqual(ranked.candidates, []);
  assert.equal(ranked.ambiguous, false);
});

test('ranking is deterministic — equal scores tie-break on ClaimNum ascending', () => {
  // A stable order is what makes a screenshot and a re-run comparable.
  const a = candidate({ claim: { ClaimNum: 200 }, claimProcs: [claimProc({ ClaimNum: 200 })] });
  const b = candidate({ claim: { ClaimNum: 100 }, claimProcs: [claimProc({ ClaimNum: 100 })] });
  const first = m.rankCandidates(proposal({ claimNumber: '' }), [a, b]);
  const second = m.rankCandidates(proposal({ claimNumber: '' }), [b, a]);
  assert.deepEqual(
    first.candidates.map((c) => c.odClaimNum),
    second.candidates.map((c) => c.odClaimNum)
  );
  assert.equal(first.candidates[0].odClaimNum, 100);
});

test('the module exposes no way to auto-select a match', () => {
  // Structural: if a future caller wants "the" match, there is nothing to call.
  const surface = Object.keys(m);
  for (const forbidden of ['autoConfirm', 'bestMatch', 'chooseMatch', 'autoMatch', 'selectMatch']) {
    assert.ok(!surface.includes(forbidden), `${forbidden} must not exist`);
  }
});

test('confidence bands are the documented cutoffs, and nothing else uses its own', () => {
  assert.equal(m.bandFor(100), 'HIGH');
  assert.equal(m.bandFor(75), 'HIGH');
  assert.equal(m.bandFor(74), 'MEDIUM');
  assert.equal(m.bandFor(45), 'MEDIUM');
  assert.equal(m.bandFor(44), 'LOW');
  assert.equal(m.bandFor(0), 'LOW');
});

// ─── Line pairing ────────────────────────────────────────────────────────────

test('lines pair by code, recording the ClaimProcNum 6c will PUT against', () => {
  const pairs = m.pairLines(
    [{ lineId: 'pl-1', position: 1, billedCode: 'D0150', billedCents: 21000 }],
    m.summariseLines([claimProc()], new Map([[8801, procedure()]]))
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].odClaimProcNum, 99001);
  assert.equal(pairs[0].billedDeltaCents, 0);
  assert.equal(pairs[0].reason, null);
});

test('a line with no matching code pairs to null WITH a reason, never to a guess', () => {
  // 6c refusing to post an unpaired line is better than 6c posting it against
  // whichever claimproc happened to be next.
  const pairs = m.pairLines(
    [{ lineId: 'pl-1', billedCode: 'D9999', billedCents: 100 }],
    m.summariseLines([claimProc()], new Map([[8801, procedure()]]))
  );
  assert.equal(pairs[0].odClaimProcNum, null);
  assert.equal(pairs[0].reason, 'no line on this claim carries this code');
});

test('duplicate codes on one visit pair by closest billed amount', () => {
  // Two of the same restoration on one visit is ordinary dentistry.
  const odLines = m.summariseLines(
    [
      claimProc({ ClaimProcNum: 1, ProcNum: 10, FeeBilled: 100.0 }),
      claimProc({ ClaimProcNum: 2, ProcNum: 11, FeeBilled: 250.0 }),
    ],
    new Map([
      [10, procedure({ ProcNum: 10, procCode: 'D2391' })],
      [11, procedure({ ProcNum: 11, procCode: 'D2391' })],
    ])
  );
  const pairs = m.pairLines(
    [
      { lineId: 'a', billedCode: 'D2391', billedCents: 25000 },
      { lineId: 'b', billedCode: 'D2391', billedCents: 10000 },
    ],
    odLines
  );
  assert.equal(pairs[0].odClaimProcNum, 2);
  assert.equal(pairs[1].odClaimProcNum, 1);
});

test('one OD line is never claimed by two proposal lines', () => {
  const odLines = m.summariseLines([claimProc()], new Map([[8801, procedure()]]));
  const pairs = m.pairLines(
    [
      { lineId: 'a', billedCode: 'D0150', billedCents: 21000 },
      { lineId: 'b', billedCode: 'D0150', billedCents: 21000 },
    ],
    odLines
  );
  assert.equal(pairs[0].odClaimProcNum, 99001);
  assert.equal(pairs[1].odClaimProcNum, null);
});

test('deleted, transferred, blocked and already-paid lines are not pairable', () => {
  for (const [label, cp, proc] of [
    ['deleted', claimProc(), procedure({ ProcStatus: 'D' })],
    ['transfer', claimProc({ IsTransfer: true }), procedure()],
    ['blocked', claimProc({ Status: 'InsHist' }), procedure()],
    ['paid', claimProc({ ClaimPaymentNum: 55 }), procedure()],
  ]) {
    const pairs = m.pairLines(
      [{ lineId: 'a', billedCode: 'D0150', billedCents: 21000 }],
      m.summariseLines([cp], new Map([[8801, proc]]))
    );
    assert.equal(pairs[0].odClaimProcNum, null, `${label} must not be pairable`);
    assert.equal(pairs[0].reason, 'no postable line on this claim');
  }
});

// ─── Shape guarantees the UI depends on ──────────────────────────────────────

test('every evidence tag the scorer can emit is in the exported vocabulary', () => {
  // The UI's rendering map is exhaustive over EVIDENCE_TAGS; a tag emitted but
  // not exported would render as nothing.
  const emitted = new Set();
  for (const p of [proposal(), proposal({ patientName: 'Other, Person', serviceDate: '2020-01-01', totalBilledCents: 999 })]) {
    for (const c of [candidate(), candidate({ patient: null })]) {
      for (const e of m.scoreCandidate(p, c).evidence) emitted.add(e.tag);
    }
  }
  for (const tag of emitted) assert.ok(m.EVIDENCE_TAG_NAMES.includes(tag), `${tag} is not exported`);
  assert.ok(emitted.size > 0);
});

test('every evidence entry carries a label and a detail a human can read', () => {
  for (const e of m.scoreCandidate(proposal(), candidate()).evidence) {
    assert.equal(typeof e.label, 'string');
    assert.ok(e.label.length > 0);
    assert.ok(e.detail.length > 0);
    assert.equal(typeof e.weight, 'number');
  }
});

test('every blocker declares whether it actually blocks', () => {
  for (const spec of Object.values(m.OD_BLOCKERS)) {
    assert.equal(typeof spec.blocking, 'boolean');
    assert.ok(spec.label.length > 0);
    assert.ok(spec.detail.length > 0);
  }
});

test('scoring is a pure function of its inputs — same in, same out', () => {
  const a = m.scoreCandidate(proposal(), candidate());
  const b = m.scoreCandidate(proposal(), candidate());
  assert.deepEqual(a, b);
});
