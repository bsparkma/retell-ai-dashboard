'use strict';

// Synthetic only — PatNum 900001 is not a real patient in either office.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'validate-benefits-formula.js');

test('requiring the validator loads no OD config or secrets', () => {
  const before = new Set(Object.keys(require.cache));
  require(SCRIPT);
  const added = Object.keys(require.cache).filter((k) => !before.has(k));
  assert.ok(!added.some((k) => /config[\\/](odOffices|secrets)\.js$/.test(k)), added.join('\n'));
});

test('parsePatNum accepts only a positive integer', () => {
  const { parsePatNum } = require(SCRIPT);
  assert.equal(parsePatNum('900001'), 900001);
  for (const bad of [undefined, '', '0', '-3', '12a', '1.5', '1; rm']) assert.equal(parsePatNum(bad), null, String(bad));
});

test('main refuses to run without a PatNum', async () => {
  const { main } = require(SCRIPT);
  await assert.rejects(main({ env: {}, log: () => {} }), /VALIDATE_PATNUM/);
});

test('figuresFor splits A and B the way the OD panel reads', () => {
  const { figuresFor } = require(SCRIPT);
  const snap = {
    plans: [
      {
        ordinal: 1,
        insSubNum: 10,
        planNum: 20,
        annualMax: 1500,
        deductible: 50,
        usage: { benefitYearStart: '2026-01-01', basis: 'calendar year' },
      },
    ],
  };
  const cps = [
    // paid in-year by both dates
    { InsSubNum: 10, PlanNum: 20, Status: 'Received', InsPayAmt: 300, DateCP: '2026-03-01', ProcDate: '2026-02-20' },
    // procedure last year, paid this year: in A, not in B
    { InsSubNum: 10, PlanNum: 20, Status: 'Received', InsPayAmt: 100, DateCP: '2026-01-10', ProcDate: '2025-12-15' },
    // sent, unpaid: pending in B only
    { InsSubNum: 10, PlanNum: 20, Status: 'NotReceived', ClaimNum: 5, InsPayEst: 200, InsPayAmt: 0, DateCP: '0001-01-01', ProcDate: '2026-10-01' },
    // an estimate on a TP procedure: in neither
    { InsSubNum: 10, PlanNum: 20, Status: 'Estimate', ClaimNum: 0, InsPayEst: 999, ProcDate: '2026-11-20' },
  ];
  const [r] = figuresFor(snap, cps);
  assert.equal(r.figA, 400);
  assert.equal(r.usedB, 300);
  assert.equal(r.pendingB, 200);
  assert.equal(r.figB, 500);
  assert.equal(r.remainA, 1100);
  assert.equal(r.remainB, 1000);
  assert.equal(r.annualMax, 1500);
  assert.equal(r.deductible, 50);
  assert.ok(!JSON.stringify(r).includes('900001'));
});
