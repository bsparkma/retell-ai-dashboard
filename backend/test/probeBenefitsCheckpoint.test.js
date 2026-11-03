'use strict';

// Synthetic only — PatNums 900001+ are not real patients in either office.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const probe = require('../scripts/probe-benefits-remaining');

const PATS = [900001, 900002, 900003];

/** A fake OD with three hygiene patients. */
function fakeOd() {
  const appts = PATS.map((PatNum, i) => ({
    AptNum: i + 1,
    PatNum,
    AptStatus: 'Scheduled',
    AptDateTime: `2026-11-0${4 + i} 09:00:00`,
    IsHygiene: 'true',
    ProvHyg: 7,
    ProvNum: 1,
    Op: 1,
    ClinicNum: 0,
  }));
  const seen = [];
  const routes = {
    '/operatories': () => [{ OperatoryNum: 1, IsHygiene: 'true' }],
    '/providers': () => [{ ProvNum: 1, IsSecondary: 'false' }],
    '/appointmenttypes': () => [],
    '/appointments': (q) =>
      q.date ? appts.filter((a) => a.AptDateTime.startsWith(q.date)) : appts.filter((a) => a.AptDateTime.slice(0, 10) >= q.dateStart && a.AptDateTime.slice(0, 10) <= q.dateEnd),
    '/procedurelogs': () => [],
    '/patplans': (q) => [{ PatPlanNum: q.PatNum - 900000 + 50, InsSubNum: 60, Ordinal: 1 }],
    '/inssubs/60': () => ({ InsSubNum: 60, PlanNum: 70 }),
    '/insplans/70': () => ({ PlanNum: 70, MonthRenew: 0, CarrierNum: 0 }),
    '/benefits': (q) => (q.PlanNum === 70 ? [{ PlanNum: 70, BenefitType: 'Limitations', MonetaryAmt: 1234, TimePeriod: 'CalendarYear', CoverageLevel: 'Individual', CovCatNum: 0 }] : []),
    '/claimprocs': (q) => [
      { PatNum: q.PatNum, InsSubNum: 60, PlanNum: 70, Status: 'Received', InsPayAmt: 111, DateCP: `${new Date().getFullYear()}-03-01`, ProcDate: `${new Date().getFullYear()}-02-01`, ClaimNum: 4 },
    ],
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

const deps = (od) => ({
  odOffices: { getOdOffice: () => od, assertOfficeMatch: (_k, h) => h },
  odReads: require('../routes/tc/odReads'),
  odDayMod: require('../services/hyg/odDay'),
});
const cfg = { days: 7, maxPatients: 250, minIntervalMs: 1200, clock: () => ({ ymd: '2026-11-02', hour: 19, minute: 0 }) };

test('a crash mid-cohort keeps finished patients; the relaunch resumes, never repeats them', async () => {
  const state = probe.newOfficeState();
  const snapshots = [];
  let killAfterFirstPatient = true;
  const save = () => {
    snapshots.push(JSON.stringify(state));
    // The container is replaced right after patient 1's checkpoint lands.
    if (killAfterFirstPatient && state.patientsDone === 1) {
      killAfterFirstPatient = false;
      throw new Error('container replaced');
    }
  };

  const od1 = fakeOd();
  await assert.rejects(probe.probeOffice('roland', deps(od1), cfg, () => {}, { state, save }), /container replaced/);
  assert.equal(state.phase, 'patients');
  assert.equal(state.patientsDone, 1, 'the finished patient is checkpointed');
  assert.ok(state.report.q1.cohort, 'Q1 is checkpointed');

  // Run 2: same state (as read back from /data), no crash.
  const od2 = fakeOd();
  const r = await probe.probeOffice('roland', deps(od2), cfg, () => {}, { state, save });
  assert.equal(state.phase, 'done');
  assert.equal(r.q2.patients, 3);
  assert.equal(state.resumes.length, 1);
  assert.equal(state.resumes[0].cohortSizeNow, 3);
  // Q1's config reads are not repeated, nor patient 1's.
  assert.ok(!od2.seen.some((c) => c.p === '/operatories'), 'Q1 re-ran on resume');
  assert.ok(!od2.seen.some((c) => c.p === '/patplans' && c.params.PatNum === 900001), 'a finished patient was re-read');
  assert.ok(od2.seen.some((c) => c.p === '/patplans' && c.params.PatNum === 900002));
  assert.deepEqual(r.window, { dateStart: '2026-11-03', dateEnd: '2026-11-09', days: 7 });

  // Nothing ever written to the checkpoint names a cohort PatNum or a per-patient dollar figure.
  // (The designated test patient's own snapshot may carry figures; it is excluded, as in the main test.)
  for (const raw of snapshots) {
    const o = JSON.parse(raw);
    if (o.report.q3) delete o.report.q3.testPatientSnapshot;
    const text = JSON.stringify(o);
    for (const p of PATS) assert.ok(!text.includes(String(p)), `PatNum ${p} reached the checkpoint`);
    assert.ok(!text.includes('1123'), 'a per-patient remaining figure reached the checkpoint'); // 1234 − 111
  }

  // A finished office returns its report without touching Open Dental.
  const od3 = fakeOd();
  const again = await probe.probeOffice('roland', deps(od3), cfg, () => {}, { state, save });
  assert.equal(od3.seen.length, 0);
  assert.equal(again.q2.patients, 3);
});

test('main refuses without a durable checkpoint path, and never overwrites another run', async () => {
  await assert.rejects(probe.main({ env: { PROBE_OFFICES: 'roland' }, log: () => {} }), /PROBE_CHECKPOINT/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-ck-'));
  const file = path.join(dir, 'probe-benefits-results.json');
  fs.writeFileSync(file, JSON.stringify({ version: probe.CHECKPOINT_VERSION, cfg: { days: 14, maxPatients: 250 }, offices: { roland: {} } }));
  await assert.rejects(
    probe.main({ env: { PROBE_OFFICES: 'roland', PROBE_CHECKPOINT: file }, log: () => {} }),
    /different run/
  );
  assert.match(fs.readFileSync(file, 'utf8'), /"days":14/, 'the other run was overwritten');
  fs.rmSync(dir, { recursive: true, force: true });
});
