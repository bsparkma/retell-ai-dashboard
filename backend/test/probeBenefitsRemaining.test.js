'use strict';

/**
 * The benefits-remaining probe — everything provable without Open Dental: the
 * run-window guard, the pure tallies, and one whole office pass against a
 * synthetic in-memory OD so the request counting and the roll-ups are checked
 * end to end.
 *
 * NO PHI: 12827 / 7115 are the designated fixtures; 900001+ are synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const SCRIPT = require.resolve('../scripts/probe-benefits-remaining.js');

test('requiring the probe loads no Open Dental config and no secrets', () => {
  const odOffices = require.resolve('../config/odOffices.js');
  const secrets = require.resolve('../config/secrets.js');
  delete require.cache[odOffices];
  delete require.cache[secrets];
  delete require.cache[SCRIPT];
  require(SCRIPT);
  assert.equal(require.cache[odOffices], undefined);
  assert.equal(require.cache[secrets], undefined);
});

const probe = require(SCRIPT);

test('window guard: aborts 01:55–03:59, pauses :13–:17, otherwise goes', () => {
  assert.equal(probe.windowVerdict({ hour: 1, minute: 54 }), 'go');
  assert.equal(probe.windowVerdict({ hour: 1, minute: 55 }), 'abort');
  assert.equal(probe.windowVerdict({ hour: 2, minute: 30 }), 'abort');
  assert.equal(probe.windowVerdict({ hour: 3, minute: 59 }), 'abort');
  assert.equal(probe.windowVerdict({ hour: 4, minute: 0 }), 'go');
  assert.equal(probe.windowVerdict({ hour: 19, minute: 13 }), 'pause');
  assert.equal(probe.windowVerdict({ hour: 19, minute: 17 }), 'pause');
  assert.equal(probe.windowVerdict({ hour: 19, minute: 18 }), 'go');
});

test('ctClock reads the practice zone, not the host zone', () => {
  // 2026-11-02 18:46Z is 12:46 CST.
  assert.deepEqual(probe.ctClock(new Date('2026-11-02T18:46:00Z')), { ymd: '2026-11-02', hour: 12, minute: 46 });
});

test('endpointKey groups by endpoint, never by id', () => {
  assert.equal(probe.endpointKey('/inssubs/15019'), '/inssubs/{n}');
  assert.equal(probe.endpointKey('/familymodules/7115/Insurance'), '/familymodules/{n}/Insurance');
  assert.equal(probe.endpointKey('/claimprocs'), '/claimprocs');
});

test('dollarBucket never returns the figure', () => {
  assert.equal(probe.dollarBucket(null), 'unknown');
  assert.equal(probe.dollarBucket(0), '$0');
  assert.equal(probe.dollarBucket(1234.56), '$1001-2000');
});

test('benefitPickAudit flags a lifetime ortho max and a family deductible', () => {
  const a = probe.benefitPickAudit([
    { BenefitType: 'Limitations', MonetaryAmt: 1500, TimePeriod: 'CalendarYear', CoverageLevel: 'Individual', CovCatNum: 0 },
    { BenefitType: 'Limitations', MonetaryAmt: 2000, TimePeriod: 'Lifetime', CoverageLevel: 'Individual', CovCatNum: 9 },
    { BenefitType: 'Deductible', MonetaryAmt: 150, CoverageLevel: 'Family', CovCatNum: 0 },
    { BenefitType: 'Deductible', MonetaryAmt: 50, CoverageLevel: 'Individual', CovCatNum: 0 },
  ]);
  assert.equal(a.maxPickReason, 'category-scoped');
  assert.equal(a.maxCleanCandidates, 1);
  assert.equal(a.dedPickReason, 'family');
  assert.deepEqual(a.dedLevels, ['Family', 'Individual']);
});

test('usageBases: DateCP-paid vs ProcDate + pending + adjustment', () => {
  const u = probe.usageBases(
    [
      { Status: 'Received', InsPayAmt: 300, DateCP: '2026-02-01', ProcDate: '2025-12-20' },
      { Status: 'NotReceived', ClaimNum: 5, InsPayEst: 200, DateCP: '0001-01-01', ProcDate: '2026-10-01' },
      { Status: 'NotReceived', ClaimNum: 0, InsPayEst: 999, ProcDate: '2026-10-01' }, // estimate, not a sent claim
      { Status: 'Estimate', InsPayEst: 999, ProcDate: '2026-10-01' },
      { Status: 'Adjustment', InsPayAmt: 40, ProcDate: '2026-03-01' },
    ],
    '2026-01-01'
  );
  assert.equal(u.paidDateCP, 300);
  assert.equal(u.paidProcDate, 0); // the procedure was done last year
  assert.equal(u.pending, 200);
  assert.equal(u.pendingRows, 1);
  assert.equal(u.adjustment, 40);
  assert.equal(u.pendingField, 'InsPayEst');
});

test('main refuses an unknown office before loading anything', async () => {
  await assert.rejects(probe.main({ env: { PROBE_OFFICES: 'roland,elsewhere' }, log: () => {} }), /Refusing to run/);
  await assert.rejects(probe.main({ env: {}, log: () => {} }), /Refusing to run/);
});

// ── one whole office pass on a synthetic Open Dental ─────────────────────────

function fakeOd(year) {
  const appts = [
    { AptNum: 1, PatNum: 900001, AptStatus: 'Scheduled', AptDateTime: '2026-11-04 09:00:00', IsHygiene: 'true', ProvHyg: 7, ProvNum: 1, Op: 1, AppointmentTypeNum: 3, ClinicNum: 0 },
    { AptNum: 2, PatNum: 900002, AptStatus: 'Scheduled', AptDateTime: '2026-11-05 09:00:00', IsHygiene: 'false', ProvHyg: 0, ProvNum: 1, Op: 2, AppointmentTypeNum: 0, ClinicNum: 0 },
    { AptNum: 3, PatNum: 900003, AptStatus: 'Broken', AptDateTime: '2026-11-05 10:00:00', IsHygiene: 'true', ProvHyg: 7, ProvNum: 1, Op: 1, ClinicNum: 0 },
  ];
  const seen = [];
  const routes = {
    '/operatories': () => [{ OperatoryNum: 1, IsHygiene: 'true' }, { OperatoryNum: 2, IsHygiene: 'false' }],
    '/providers': () => [{ ProvNum: 7, IsSecondary: 'true' }, { ProvNum: 1, IsSecondary: 'false' }],
    '/appointmenttypes': () => [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy' }],
    '/appointments': (q) =>
      q.date ? appts.filter((a) => a.AptDateTime.startsWith(q.date)) : appts.filter((a) => a.AptDateTime.slice(0, 10) >= q.dateStart && a.AptDateTime.slice(0, 10) <= q.dateEnd),
    '/procedurelogs': (q) => (q.PatNum === 900001 ? [{ ProcNum: 11, PatNum: 900001, ProcStatus: 'TP' }, { ProcNum: 12, PatNum: 900001, ProcStatus: 'TP' }] : []),
    '/patplans': (q) => (q.PatNum === 900001 ? [{ PatPlanNum: 50, InsSubNum: 60, Ordinal: 1 }] : []),
    '/inssubs/60': () => ({ InsSubNum: 60, PlanNum: 70, DateEffective: '2020-01-01', DateTerm: '0001-01-01' }),
    '/insplans/70': () => ({ PlanNum: 70, MonthRenew: 0, CarrierNum: 80 }),
    '/carriers/80': () => ({ CarrierNum: 80, CarrierName: 'Synthetic Carrier' }),
    '/benefits': (q) =>
      q.PlanNum === 70
        ? [
            { PlanNum: 70, BenefitType: 'Limitations', MonetaryAmt: 1500, TimePeriod: 'CalendarYear', CoverageLevel: 'Individual', CovCatNum: 0 },
            { PlanNum: 70, BenefitType: 'Limitations', MonetaryAmt: 2000, TimePeriod: 'Lifetime', CoverageLevel: 'Individual', CovCatNum: 9 },
            { PlanNum: 70, BenefitType: 'Deductible', MonetaryAmt: 50, TimePeriod: 'CalendarYear', CoverageLevel: 'Individual', CovCatNum: 0 },
          ]
        : [],
    '/claimprocs': (q) => {
      const rows =
        q.PatNum === 900001
          ? [
              { ClaimProcNum: 1, PatNum: 900001, InsSubNum: 60, PlanNum: 70, Status: 'Received', InsPayAmt: 300, DedApplied: 50, DateCP: `${year}-03-01`, ProcDate: `${year}-02-20`, ClaimNum: 4 },
              { ClaimProcNum: 2, PatNum: 900001, InsSubNum: 60, PlanNum: 70, Status: 'NotReceived', InsPayEst: 200, DateCP: '0001-01-01', ProcDate: `${year}-01-15`, ClaimNum: 5 },
              { ClaimProcNum: 3, PatNum: 900001, InsSubNum: 60, PlanNum: 70, Status: 'Received', InsPayAmt: 500, DateCP: `${year - 1}-06-01`, ProcDate: `${year - 1}-05-20`, ClaimNum: 3 },
            ]
          : [];
      return q.DateCP ? rows.filter((r) => r.DateCP >= q.DateCP) : rows;
    },
  };
  return {
    seen,
    client: {
      async apiGetRaw(p, params) {
        seen.push({ p, params });
        if ((params.Offset || 0) > 0) return { ok: true, status: 200, data: [] };
        const h = routes[p];
        if (!h) return { ok: false, status: 404, data: null, error: 'not a valid resource' };
        return { ok: true, status: 200, data: h(params) };
      },
    },
  };
}

test('probeOffice: one office end to end on a synthetic OD — counts, cohort, and the two usage bases', async () => {
  const year = new Date().getFullYear();
  const od = fakeOd(year);
  const deps = {
    odOffices: { getOdOffice: () => od, assertOfficeMatch: (_k, h) => h },
    odReads: require('../routes/tc/odReads'),
    odDayMod: require('../services/hyg/odDay'),
  };
  const cfg = { days: 7, maxPatients: 250, minIntervalMs: 1200, clock: () => ({ ymd: '2026-11-02', hour: 19, minute: 0 }) };
  const r = await probe.probeOffice('roland', deps, cfg, () => {});

  // Never a write: the fake only exposes apiGetRaw, so any other verb would throw.
  assert.ok(od.seen.length > 0);

  assert.deepEqual(r.window, { dateStart: '2026-11-03', dateEnd: '2026-11-09', days: 7 });
  assert.equal(r.q1.rangeRead.rows, 3);
  assert.equal(r.q1.perDayReads.rows, 3);
  assert.equal(r.q1.perDayReads.inRangeNotPerDay, 0);
  assert.equal(r.q1.scheduled.rows, 2);
  assert.deepEqual(r.q1.cohort, { distinctPatients_IsHygieneNotFalse: 1, distinctPatients_IsHygieneTrue: 1, probed: 1, capped: false });
  assert.equal(r.q1.scheduled.signalCrossTab['apt=true|provHyg=true|op=true|provIsHygienist=false'], 1);

  assert.equal(r.q2.patients, 1);
  assert.equal(r.q2.requestsPerPatient.max, 1);
  assert.equal(r.q2.tpRowsPerPatient.max, 2);

  // patplans 1 + inssub 1 + insplan 1 + carrier 1 + benefits 2 + claimprocs 1 = 7
  assert.equal(r.q3.cohort.requestsPerPatient.max, 7);
  assert.equal(r.q3.cohort.requestsByEndpointTotal['/carriers/{n}'], 1);
  // readBenefits picks the larger lifetime, category-scoped row as the annual max.
  assert.deepEqual(r.q3.benefits.maxPick, { 'category-scoped': 1 });
  assert.equal(r.q3.remaining.plansWithKnownMax, 1);
  // current code: 2000 − 300 = 1700; ProcDate + pending: 2000 − (300 + 200) = 1500
  assert.equal(r.q3.remaining.absDeltaBetweenBases.max, 200);
  assert.equal(r.q3.remaining.patientsWithPendingClaimRows, 1);
  assert.equal(r.q3.dateCpFilter.filteredRows, 1);
  assert.equal(r.q3.dateCpFilter.filteredRowsBeforeStart, 0);
  assert.equal(r.q3.familyModulesInsurance.patNum, 12827);
  assert.equal(r.q3.familyModulesInsurance.status, 404);

  // No synthetic PatNum, and no dollar figure for a cohort patient, leaks into the report.
  const text = JSON.stringify({ ...r, q3: { ...r.q3, testPatientSnapshot: undefined } });
  assert.ok(!text.includes('900001'), 'a cohort PatNum leaked into the report');
  assert.ok(!text.includes('1700') && !text.includes('1500'), 'a cohort dollar figure leaked into the report');
  assert.equal(r.q4.rateLimited429, 0);
  assert.ok(r.q4.sweepMinutes_full_at1200ms > 0);
});
