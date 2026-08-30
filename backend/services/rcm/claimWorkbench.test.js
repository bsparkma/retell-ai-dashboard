'use strict';

/**
 * Is this the patient on the EOB — and what does the chart hold?
 *
 * The identity comparison is a GATE CHECK, not a warning, so the cases that make
 * it block and the cases that make it stay quiet are both worth writing down.
 * The distinction this file exists to defend is between DIFFERS and UNKNOWN: an
 * absence is not a disagreement, and manufacturing a mismatch out of a field
 * Open Dental never sent would refuse real work for no safety gained.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  namesAgree,
  identityFor,
  chartFor,
  confirmedCandidate,
  feeDeltasByLine,
  buildWorkbenchView,
} = require('./claimWorkbench');

/** A confirmed candidate carrying whatever the case is about. */
function candidate(od = {}) {
  return {
    odClaimNum: 53784,
    odPatNum: 12828,
    od: {
      claimStatus: 'S',
      billedCents: 21000,
      insPaidCents: 0,
      writeOffCents: 0,
      patientName: 'Test, MangoTest',
      patientBirthdate: '1990-04-11',
      subscriberId: 'ABC-123456',
      lines: [],
      ...od,
    },
  };
}

const CLAIM = Object.freeze({
  odClaimNum: 53784,
  patientName: 'MangoTest Test',
  patientDob: '1990-04-11',
  subscriberId: 'ABC123456',
});

const field = (identity, name) => identity.fields.find((f) => f.field === name);

// ─── Names ───────────────────────────────────────────────────────────────────

test('names agree across the two spellings the two systems use', () => {
  // Open Dental spells "Last, First"; a carrier spells it however it likes.
  assert.equal(namesAgree('MangoTest Test', 'Test, MangoTest'), true);
  assert.equal(namesAgree('test, mangotest', 'MANGOTEST TEST'), true);
  // A middle name on one side only is not two people.
  assert.equal(namesAgree('Test, MangoTest R', 'MangoTest Test'), true);
});

test('two different people do NOT agree', () => {
  assert.equal(namesAgree('Test, MangoTest', 'Test, Jonathan'), false);
  assert.equal(namesAgree('Stedi TestValley', 'Test 2, Stedi'), false);
});

test('an empty name is not agreement', () => {
  assert.equal(namesAgree('', 'Test, MangoTest'), false);
  assert.equal(namesAgree('Test, MangoTest', null), false);
  assert.equal(namesAgree(null, null), false);
});

// ─── The three fields, each way ──────────────────────────────────────────────

test('everything agrees: nothing blocks and the panel says so', () => {
  const identity = identityFor(CLAIM, candidate());
  assert.equal(identity.matched, true);
  assert.equal(identity.blocking, false);
  assert.equal(field(identity, 'name').status, 'agrees');
  assert.equal(field(identity, 'dob').status, 'agrees');
  assert.equal(field(identity, 'subscriber').status, 'agrees', 'punctuation and case are ignored');
});

test('a NAME mismatch BLOCKS, and the two values are both shown', () => {
  const identity = identityFor(CLAIM, candidate({ patientName: 'Test, Jonathan' }));
  assert.equal(identity.blocking, true);
  assert.equal(identity.matched, false);
  const name = field(identity, 'name');
  assert.equal(name.status, 'differs');
  assert.equal(name.blocking, true);
  // Both values reach the screen — a refusal that will not say what disagreed
  // is a refusal nobody can act on.
  assert.equal(name.eob, 'MangoTest Test');
  assert.equal(name.od, 'Test, Jonathan');
});

test('a DATE OF BIRTH mismatch BLOCKS — it is what separates two people with one name', () => {
  const identity = identityFor(CLAIM, candidate({ patientBirthdate: '1991-04-11' }));
  assert.equal(identity.blocking, true);
  assert.equal(field(identity, 'dob').status, 'differs');
  assert.equal(field(identity, 'dob').blocking, true);
  // …and the name still agrees, which is exactly why the date is checked.
  assert.equal(field(identity, 'name').status, 'agrees');
});

test('a date of birth is compared as a DAY, whatever shape it arrives in', () => {
  const identity = identityFor(CLAIM, candidate({ patientBirthdate: '1990-04-11T00:00:00Z' }));
  assert.equal(field(identity, 'dob').status, 'agrees');
});

test('a SUBSCRIBER ID mismatch is reported and does NOT block', () => {
  const identity = identityFor(CLAIM, candidate({ subscriberId: 'ZZZ999' }));
  assert.equal(identity.blocking, false, 'carriers reformat member numbers constantly');
  assert.equal(identity.matched, false, '…but it is still a disagreement, and it is shown');
  const sub = field(identity, 'subscriber');
  assert.equal(sub.status, 'differs');
  assert.equal(sub.blocking, false);
});

test('a subscriber id agrees across punctuation, case and spacing', () => {
  for (const spelling of ['ABC-123456', 'abc123456', 'ABC 123 456', 'abc-123-456']) {
    const identity = identityFor(CLAIM, candidate({ subscriberId: spelling }));
    assert.equal(field(identity, 'subscriber').status, 'agrees', spelling);
  }
});

// ─── Absence is not disagreement ─────────────────────────────────────────────

test('a field Open Dental did not send is UNKNOWN, never a mismatch', () => {
  const identity = identityFor(
    CLAIM,
    candidate({ patientBirthdate: null, subscriberId: null })
  );
  assert.equal(identity.blocking, false, 'an absence refuses nothing');
  assert.equal(identity.matched, true, 'nothing DISAGREES');
  assert.equal(field(identity, 'dob').status, 'unknown');
  assert.equal(field(identity, 'dob').od, null, 'so the screen can say "not recorded"');
  assert.equal(field(identity, 'subscriber').status, 'unknown');
});

test('a field the REMITTANCE did not carry is unknown too', () => {
  const identity = identityFor({ ...CLAIM, patientDob: null }, candidate());
  assert.equal(field(identity, 'dob').status, 'unknown');
  assert.equal(identity.blocking, false);
});

test('an empty string is an absence, not a value', () => {
  const identity = identityFor({ ...CLAIM, subscriberId: '' }, candidate({ subscriberId: '   ' }));
  assert.equal(field(identity, 'subscriber').status, 'unknown');
});

test('no confirmed candidate at all: every field is unknown and nothing blocks', () => {
  const identity = identityFor(CLAIM, null);
  assert.equal(identity.blocking, false);
  assert.deepEqual(
    identity.fields.map((f) => f.status),
    ['unknown', 'unknown', 'unknown']
  );
});

// ─── The confirmed candidate ─────────────────────────────────────────────────

test('the candidate is found by the CLAIM\'s ClaimNum, not by the snapshot\'s confirmation', () => {
  /*
   * A snapshot whose confirmation was superseded must not hand back a candidate
   * the claim is no longer linked to. The claim's own `od_claim_num` is the
   * linkage a DB CHECK guards; the snapshot is a record of an observation.
   */
  const snapshot = {
    candidates: [candidate(), { odClaimNum: 99999, od: { patientName: 'Somebody Else' } }],
    confirmed: { odClaimNum: 99999 },
  };
  const found = confirmedCandidate({ odClaimNum: 53784 }, snapshot);
  assert.equal(found.odClaimNum, 53784);
});

test('an unconfirmed claim has no candidate, whatever the snapshot holds', () => {
  const snapshot = { candidates: [candidate()], confirmed: null };
  assert.equal(confirmedCandidate({ odClaimNum: null }, snapshot), null);
  assert.equal(confirmedCandidate({ odClaimNum: 0 }, snapshot), null);
});

// ─── What the chart holds ────────────────────────────────────────────────────

test('the chart panel reports only LIVE lines, and says when it was read', () => {
  const snapshot = {
    fetchedAt: '2026-08-30T14:00:00.000Z',
    candidates: [
      candidate({
        lines: [
          {
            claimProcNum: 900001,
            code: 'D0120',
            status: 'NotReceived',
            feeBilledCents: 15000,
            insEstCents: 8000,
            insPayAmtCents: 0,
            writeOffCents: 0,
            deleted: false,
          },
          // Soft-deleted: OD still returns it in a list read (G12).
          { claimProcNum: 900002, code: 'D1110', deleted: true, feeBilledCents: 12000 },
          // Unreadable procedure row — 'unknown' is NOT false.
          { claimProcNum: 900003, code: 'D0274', deleted: 'unknown', feeBilledCents: 6000 },
        ],
      }),
    ],
  };
  const chart = chartFor({ odClaimNum: 53784 }, snapshot);
  assert.equal(chart.odClaimNum, 53784);
  assert.equal(chart.fetchedAt, '2026-08-30T14:00:00.000Z');
  assert.deepEqual(
    chart.lines.map((l) => l.odClaimProcNum),
    [900001],
    'a deleted line and an unreadable one are both out'
  );
  assert.equal(chart.lines[0].insEstCents, 8000);
});

test("an insurance estimate Open Dental has not calculated stays NULL, never $0", () => {
  const snapshot = {
    candidates: [
      candidate({
        lines: [
          {
            claimProcNum: 900001,
            code: 'D0120',
            status: 'NotReceived',
            feeBilledCents: 15000,
            insEstCents: null,
            insPayAmtCents: 0,
            writeOffCents: 0,
            deleted: false,
          },
        ],
      }),
    ],
  };
  assert.equal(chartFor({ odClaimNum: 53784 }, snapshot).lines[0].insEstCents, null);
});

test('an unconfirmed claim has no chart panel at all', () => {
  assert.equal(chartFor({ odClaimNum: null }, { candidates: [candidate()] }), null);
});

// ─── The fee deltas the verdict judges ───────────────────────────────────────

test('fee deltas come from the CONFIRMATION, per line id', () => {
  const deltas = feeDeltasByLine({
    confirmed: {
      linePairs: [
        { lineId: 'l-1', odClaimProcNum: 900001, billedDeltaCents: 0 },
        { lineId: 'l-2', odClaimProcNum: 900002, billedDeltaCents: 5000 },
        // An unpaired line records no comparison.
        { lineId: 'l-3', odClaimProcNum: null, billedDeltaCents: null },
      ],
    },
  });
  assert.equal(deltas.get('l-1'), 0);
  assert.equal(deltas.get('l-2'), 5000);
  assert.equal(deltas.get('l-3'), null);
  assert.equal(deltas.has('l-4'), false, 'a line the confirmation never saw is absent, not zero');
});

test('no confirmation, no deltas — and no false agreement either', () => {
  assert.equal(feeDeltasByLine(null).size, 0);
  assert.equal(feeDeltasByLine({ confirmed: null }).size, 0);
});

// ─── The whole view ──────────────────────────────────────────────────────────

test('the view assembles identity, chart and verdict from one set of facts', () => {
  const snapshot = {
    fetchedAt: '2026-08-30T14:00:00.000Z',
    candidates: [candidate()],
    confirmed: {
      odClaimNum: 53784,
      linePairs: [{ lineId: 'l-1', odClaimProcNum: 900001, billedDeltaCents: 0 }],
    },
  };
  const view = buildWorkbenchView({
    claim: CLAIM,
    lines: [
      {
        lineId: 'l-1',
        billedCode: 'D0120',
        billedCents: 15000,
        allowedCents: 10000,
        paidCents: 8000,
        decision: null,
        decisionReason: null,
        decidedBy: null,
        decidedAt: null,
        odClaimProcNum: 900001,
      },
    ],
    snapshot,
    register: 'projection',
  });

  assert.equal(view.identity.blocking, false);
  assert.equal(view.chart.odClaimNum, 53784);
  assert.equal(view.verdict.state, 'green');
  assert.equal(view.verdict.projectedPatientCents, 2000);
});

test('a stale-shaped snapshot yields no chart and refuses to compare identity', () => {
  /*
   * `loadClaimBundle` hands `null` rather than a snapshot of the wrong version,
   * and this is what that produces: three unknowns and no chart, instead of a
   * screen confidently reading fields that version does not have.
   */
  const view = buildWorkbenchView({ claim: CLAIM, lines: [], snapshot: null });
  assert.equal(view.chart, null);
  assert.equal(view.identity.blocking, false);
  assert.deepEqual(
    view.identity.fields.map((f) => f.status),
    ['unknown', 'unknown', 'unknown']
  );
  assert.equal(view.verdict.register, 'projection', 'a read can only ever be a projection');
});
