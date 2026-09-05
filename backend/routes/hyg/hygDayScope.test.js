'use strict';

/**
 * THE HYGIENE LENS — what a day read serves, and what it therefore costs.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ONE THAT SILENTLY LOSES A PATIENT
 * ═════════════════════════════════════════════════════════════════════════════
 * A hygiene appointment can sit in a DOCTOR's operatory on an overflow day. The
 * lazy filter — "show the hygiene chairs" — drops that patient off the
 * hygienist's day, and it does it silently, on the busiest day of the month,
 * for the appointment most likely to be an overflow.
 *
 * So the filter is the APPOINTMENT's own `IsHygiene`, never the chair's, and
 * the first test below is that overflow case. `HygAppointment` carries both
 * flags precisely so this distinction is expressible (H0 §5).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A PATIENT NOT SERVED IS NOT DISCLOSED
 * ═════════════════════════════════════════════════════════════════════════════
 * Under `scope=hygiene` the doctors' patients are never fetched from Open
 * Dental, never named, and never sent — so there is no audit row for them, and
 * a trail that recorded one would be claiming a disclosure that did not happen.
 * That is asserted here as a COUNT of `/patients/` reads and a count of audit
 * rows, because both halves have to hold.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FakeOd,
  bootHygApp,
  api,
  apptRow,
  patientRow,
  operatoryRow,
} = require('./hygTestUtils');

const DATE = '2026-09-08';

/**
 * A real-shaped mixed day: two hygiene chairs, two doctor chairs, and — the
 * case that matters — one hygiene appointment parked in a doctor's op.
 *
 * Every PatNum is a designated staging fixture or an obviously synthetic number.
 */
function mixedDay() {
  return new FakeOd({
    '/appointments': [
      // Hygiene, in the hygiene chair.
      apptRow({ AptNum: 900001, PatNum: 12827, Op: 2, IsHygiene: true, AptDateTime: DATE + ' 08:00:00' }),
      // THE OVERFLOW CASE: hygiene appointment, DOCTOR's chair.
      apptRow({ AptNum: 900002, PatNum: 12828, Op: 5, IsHygiene: true, AptDateTime: DATE + ' 09:00:00' }),
      // A doctor's visit in the doctor's chair.
      apptRow({ AptNum: 900003, PatNum: 990003, Op: 5, IsHygiene: false, AptDateTime: DATE + ' 10:00:00' }),
      // Another doctor's visit, different patient.
      apptRow({ AptNum: 900004, PatNum: 990004, Op: 6, IsHygiene: false, AptDateTime: DATE + ' 11:00:00' }),
      // Open Dental did not say. Served under the lens — "we could not tell"
      // is not "no".
      apptRow({ AptNum: 900005, PatNum: 990005, Op: 2, IsHygiene: null, AptDateTime: DATE + ' 12:00:00' }),
    ],
    '/operatories': [
      operatoryRow({ OperatoryNum: 2, OpName: 'Hygiene 1', IsHygiene: 'true', ItemOrder: 1 }),
      operatoryRow({ OperatoryNum: 5, OpName: 'Dr Farmer', IsHygiene: 'false', ItemOrder: 2 }),
      operatoryRow({ OperatoryNum: 6, OpName: 'Dr Reed', IsHygiene: 'false', ItemOrder: 3 }),
    ],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [
      { ProvNum: 7, Abbr: 'HYG1' },
      { ProvNum: 8, Abbr: 'HYG2' },
    ],
    '/patients/12827': patientRow({ PatNum: 12827 }),
    '/patients/12828': patientRow({ PatNum: 12828, LName: 'Test', FName: 'MangoTest' }),
    '/patients/990003': patientRow({ PatNum: 990003, LName: 'Doctorpatient', FName: 'A' }),
    '/patients/990004': patientRow({ PatNum: 990004, LName: 'Doctorpatient', FName: 'B' }),
    '/patients/990005': patientRow({ PatNum: 990005, LName: 'Unclassified', FName: 'C' }),
  });
}

/** How many `/patients/{n}` requests a client actually issued. */
function patientReads(od) {
  return od.calls.filter((c) => c.path.startsWith('/patients/')).length;
}

test('A HYGIENE APPOINTMENT IN A DOCTOR’S CHAIR IS STILL SERVED', async () => {
  const od = mixedDay();
  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'GET', `/api/hyg/day?office=roland&date=${DATE}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.scope, 'hygiene', 'the lens is the default');

    const apt = res.body.appointments.find((a) => a.aptNum === 900002);
    assert.ok(apt, 'the overflow appointment must not vanish');
    // In the DOCTOR's chair, and named, because the appointment says hygiene.
    assert.equal(apt.opName, 'Dr Farmer');
    assert.equal(apt.isHygiene, true);
    assert.equal(apt.opIsHygiene, false, 'the two flags disagree, and both survive');
    assert.equal(apt.patientName, 'Test, MangoTest');
  } finally {
    await app.close();
  }
});

test('the lens serves hygiene and unclassified, and reports what it did not', async () => {
  const od = mixedDay();
  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'GET', `/api/hyg/day?office=roland&date=${DATE}`);
    assert.deepEqual(
      res.body.appointments.map((a) => a.aptNum).sort(),
      [900001, 900002, 900005],
      'two hygiene, one unclassified — and neither doctor visit'
    );
    // Reported, never silently dropped: "where did my 2pm doctor visit go" has
    // an answer.
    assert.equal(res.body.excludedByScope, 2);
    // And it is NOT the same number as excludedByStatus, which counts rows that
    // are not visits at all.
    assert.equal(res.body.excludedByStatus, 0);
  } finally {
    await app.close();
  }
});

test('the lens pays for the hygiene patients ONLY, and discloses only those', async () => {
  const od = mixedDay();
  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'GET', `/api/hyg/day?office=roland&date=${DATE}`);
    assert.equal(res.status, 200);

    // Three served patients, three Open Dental identity reads. The doctors'
    // two are never fetched — that is the saving, and it is one second each
    // against a credential the voice and RCM modules also use.
    assert.equal(patientReads(od), 3);
    assert.deepEqual(
      od.calls.filter((c) => c.path.startsWith('/patients/')).map((c) => c.path).sort(),
      ['/patients/12827', '/patients/12828', '/patients/990005']
    );
    assert.equal(res.body.stats.odPatientReads, 3);
    assert.equal(res.body.stats.patientsRequested, 3);

    // A PATIENT NOT SERVED IS NOT DISCLOSED. One audit row per served patient,
    // and none for the two the response does not carry.
    const disclosed = app.db.audit.filter((r) => r.resource_type === 'hyg_day_patient');
    assert.equal(disclosed.length, 3);
    assert.deepEqual(
      disclosed.map((r) => r.resource_id).sort(),
      ['12827', '12828', '990005']
    );
  } finally {
    await app.close();
  }
});

test('scope=all serves the whole day and pays its own cost', async () => {
  const od = mixedDay();
  const app = await bootHygApp({ od });
  try {
    const res = await api(
      app.baseUrl,
      'GET',
      `/api/hyg/day?office=roland&date=${DATE}&scope=all`
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.scope, 'all');
    assert.equal(res.body.appointments.length, 5);
    assert.equal(res.body.excludedByScope, 0, 'nothing is hidden, so nothing to report');

    // Five patients, five reads — the wider fetch is the rare path and it is
    // not free, which is the whole reason the default is narrower.
    assert.equal(patientReads(od), 5);
    assert.equal(app.db.audit.filter((r) => r.resource_type === 'hyg_day_patient').length, 5);
  } finally {
    await app.close();
  }
});

test('an unrecognised scope is a 400, never a silent fallback', async () => {
  const od = mixedDay();
  const app = await bootHygApp({ od });
  try {
    for (const bad of ['everything', 'HYGIENE', '', 'hygiene ']) {
      const res = await api(
        app.baseUrl,
        'GET',
        `/api/hyg/day?office=roland&date=${DATE}&scope=${encodeURIComponent(bad)}`
      );
      // 'hygiene ' trims to 'hygiene' and is fine; the rest are refused.
      if (bad.trim() === 'hygiene') {
        assert.equal(res.status, 200, JSON.stringify(bad));
        continue;
      }
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.body.code, 'INVALID_SCOPE');
    }
    // The two scopes differ by how many patients are disclosed. Guessing which
    // one a caller meant is not a decision this route may make.
    assert.equal(patientReads(od), 3, 'only the one valid request read anything');
  } finally {
    await app.close();
  }
});

test('a day of nothing but doctor appointments is EMPTY, not an error', async () => {
  // The distinction the whole screen is written around, under the new filter:
  // an empty hygiene day and a failed read must not look the same.
  const od = new FakeOd({
    '/appointments': [
      apptRow({ AptNum: 900003, PatNum: 990003, Op: 5, IsHygiene: false }),
    ],
    '/operatories': [operatoryRow({ OperatoryNum: 5, OpName: 'Dr Farmer', IsHygiene: 'false' })],
    '/appointmenttypes': [],
    '/providers': [],
  });
  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'GET', `/api/hyg/day?office=roland&date=${DATE}`);
    assert.equal(res.status, 200, 'an empty hygiene day is a SUCCESS');
    assert.deepEqual(res.body.appointments, []);
    assert.equal(res.body.excludedByScope, 1, 'and it says why it is empty');
    assert.equal(patientReads(od), 0, 'nobody was named, so nobody was fetched');
    assert.equal(app.db.audit.filter((r) => r.resource_type === 'hyg_day_patient').length, 0);
  } finally {
    await app.close();
  }
});

test('the truncation facts stay about the schedule and the served scope', async () => {
  const od = mixedDay();
  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'GET', `/api/hyg/day?office=roland&date=${DATE}`);
    // An appointment the lens did not serve is neither missing nor unnamed —
    // it was not asked for, and excludedByScope is where that is said.
    assert.equal(res.body.truncated, false);
    assert.equal(res.body.patientNamesTruncated, false);
    assert.equal(res.body.excludedByScope, 2);
  } finally {
    await app.close();
  }
});
