'use strict';

/**
 * /api/hyg — the gates, in the order a request meets them.
 *
 * Every test here drives the REAL assembled chain from server.js (auth gate →
 * tenantContext → requireModule('hyg') → requireReadWrite → the router's own
 * requireOffice → the route), because mount order is only under test if the
 * test goes through it. A test that called the handler directly would pass with
 * `router.use(requireOffice)` deleted from index.js.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CLAIM THIS FILE EXISTS FOR
 * ═════════════════════════════════════════════════════════════════════════════
 * `{ appointments: [] }` means nobody is booked. It never means anything else.
 *
 * Five separate things can go wrong before there is a day to show — no
 * entitlement, no permission, no such office, hygiene not switched on for this
 * office, Open Dental unreachable — and a screen that rendered "no
 * appointments" for any of them would be lying to somebody standing at a chair
 * about what their day holds. Each is asserted below as a distinct non-2xx with
 * a distinct code.
 *
 * NO REAL PATIENT DATA. Every PatNum is a designated staging fixture (roland
 * 12827 / 12828, valley 7115) or an obviously synthetic number.
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

/** An Open Dental with one real hygiene day on it. */
function odWithADay() {
  return new FakeOd({
    '/appointments': [
      apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' }),
      apptRow({ AptNum: 900002, PatNum: 12828, AptDateTime: DATE + ' 09:00:00', Op: 3 }),
    ],
    '/operatories': [
      operatoryRow({ OperatoryNum: 2, OpName: 'Hygiene 1', ItemOrder: 1 }),
      operatoryRow({ OperatoryNum: 3, OpName: 'Hygiene 2', ItemOrder: 2 }),
    ],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow({ PatNum: 12827, LName: 'Test 2', FName: 'Stedi' }),
    '/patients/12828': patientRow({ PatNum: 12828, LName: 'Test', FName: 'MangoTest' }),
  });
}

// ── entitlement and permission ──────────────────────────────────────────────

test('a tenant without the hyg module gets MODULE_NOT_ENTITLED, not an empty day', async () => {
  const app = await bootHygApp({ modules: ['voice', 'tc'] });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + DATE);
    assert.equal(res.status, 403);
    // The platform's denial shape puts the code in `error`, not `code`.
    assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
    assert.equal(res.body.module, 'hyg');
    assert.equal(res.body.appointments, undefined, 'a refusal is not a day');
  } finally {
    await app.close();
  }
});

test('a role without hyg.read is refused', async () => {
  // `tc` deliberately does not hold hyg.read: the treatment coordinator is on
  // the receiving end of the handoff, not standing at the chair.
  const app = await bootHygApp({ role: 'tc' });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + DATE);
    assert.equal(res.status, 403);
    assert.equal(res.body.appointments, undefined);
  } finally {
    await app.close();
  }
});

test('the hygiene role, the module, and a switched-on office: a day', async () => {
  const app = await bootHygApp({ role: 'hygiene', od: odWithADay() });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + DATE);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.appointments.length, 2);
    assert.equal(res.body.office, 'roland');
    assert.equal(res.body.date, DATE);
  } finally {
    await app.close();
  }
});

// ── office ──────────────────────────────────────────────────────────────────

test('a missing or unknown office is a 400, and never reaches Open Dental', async () => {
  const od = odWithADay();
  const app = await bootHygApp({ od });
  try {
    for (const qs of ['', '?office=', '?office=all', '?office=unknown', '?office=../roland']) {
      const res = await api(app.baseUrl, 'GET', '/api/hyg/day' + (qs ? qs + '&' : '?') + 'date=' + DATE);
      assert.equal(res.status, 400, 'office=' + JSON.stringify(qs));
      assert.equal(res.body.code, 'INVALID_OFFICE');
    }
    assert.equal(od.calls.length, 0, 'a malformed office must not spend an Open Dental call');
  } finally {
    await app.close();
  }
});

test('an office whose hygiene switch is OFF is refused with its own reason', async () => {
  // The shipped default: hygOdEnabled is false for every office until a
  // location has been walked. valley is off in this boot; roland is on.
  const od = odWithADay();
  const app = await bootHygApp({ od, hygOffices: ['roland'] });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/day?office=valley&date=' + DATE);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'OFFICE_NOT_READY');
    assert.equal(res.body.reason, 'OFFICE_HYG_NOT_ENABLED');
    assert.equal(res.body.office, 'valley');
    assert.equal(res.body.appointments, undefined, 'not a day, and not an empty one');
    assert.equal(od.calls.length, 0, 'a switched-off office must not spend an Open Dental call');
  } finally {
    await app.close();
  }
});

test('an office with no customer key is refused, and never borrows another office’s', async () => {
  const od = odWithADay();
  const app = await bootHygApp({ od, hygOffices: ['roland', 'valley'], odUnavailableFor: ['valley'] });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/day?office=valley&date=' + DATE);
    // 503 rather than 409: the office IS switched on, its credentials are absent.
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'OFFICE_NOT_READY');
    assert.equal(res.body.reason, 'OFFICE_OD_KEY_MISSING');
    // The whole point of the per-office registry: PatNum 7115 is the valley
    // test patient and a DIFFERENT REAL PERSON in roland, so a valley request
    // answered with roland's client would show one practice's day under the
    // other's name.
    assert.equal(od.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('each office reads its OWN Open Dental, and the payload names which', async () => {
  const app = await bootHygApp({ od: odWithADay(), hygOffices: ['roland', 'valley'] });
  try {
    const roland = await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + DATE);
    const valley = await api(app.baseUrl, 'GET', '/api/hyg/day?office=valley&date=' + DATE);
    assert.equal(roland.body.officeName, 'Roland Family Dental');
    assert.equal(valley.body.officeName, 'Riley Family Dental');
  } finally {
    await app.close();
  }
});

// ── date ────────────────────────────────────────────────────────────────────

test('a malformed or impossible date is a 400, and never reaches Open Dental', async () => {
  const od = odWithADay();
  const app = await bootHygApp({ od });
  try {
    for (const date of ['', 'today', '2026-9-8', '08-09-2026', '2026-02-31', '2026-13-01', '2026-09-08T00:00']) {
      const res = await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + encodeURIComponent(date));
      assert.equal(res.status, 400, 'date=' + JSON.stringify(date));
      assert.equal(res.body.code, 'INVALID_DATE');
    }
    // 2026-02-31 is the one worth naming: it is well-shaped, and JavaScript
    // rolls it forward to March 3rd. Sending it to Open Dental would return a
    // different day's schedule under the heading the caller asked for.
    assert.equal(od.calls.length, 0);
  } finally {
    await app.close();
  }
});

// ── Open Dental is down ─────────────────────────────────────────────────────

test('an Open Dental outage is a 502 that SAYS so — never an empty day', async () => {
  const od = new FakeOd({
    '/appointments': { ok: false, status: 503, data: null, error: 'service unavailable' },
  });
  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + DATE);
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'OD_READ_FAILED');
    assert.equal(res.body.success, false);
    // The failure this whole endpoint is written against.
    assert.equal(res.body.appointments, undefined);
  } finally {
    await app.close();
  }
});

test('a genuinely empty day is a 200 with an empty list and no warnings', async () => {
  const od = new FakeOd({
    '/appointments': [],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [],
    '/providers': [],
  });
  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + DATE);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.appointments, []);
    // An empty day and a failed one are the two states this endpoint must never
    // conflate, so the empty one carries a positive claim: nothing went wrong.
    assert.deepEqual(res.body.warnings, []);
    assert.equal(res.body.truncated, false);
  } finally {
    await app.close();
  }
});

// ── audit ───────────────────────────────────────────────────────────────────

test('one audit row per PATIENT disclosed, plus one for the request', async () => {
  const app = await bootHygApp({ od: odWithADay() });
  try {
    await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + DATE);

    const rows = app.db.audit;
    const day = rows.filter((r) => r.resource_type === 'hyg_day');
    const patients = rows.filter((r) => r.resource_type === 'hyg_day_patient');

    assert.equal(day.length, 1, 'the request itself is one row');
    assert.equal(day[0].resource_id, DATE);
    // "Somebody opened Tuesday" cannot answer "whose chart was read on
    // Tuesday". Two patients on the day means two rows.
    assert.equal(patients.length, 2);
    assert.deepEqual(patients.map((r) => String(r.resource_id)).sort(), ['12827', '12828']);
    for (const r of rows) assert.equal(r.action, 'READ');
    for (const r of rows) assert.equal(r.result, 'SUCCESS');
  } finally {
    await app.close();
  }
});

test('a patient on TWO appointments is audited once, not twice', async () => {
  const od = new FakeOd({
    '/appointments': [
      apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' }),
      apptRow({ AptNum: 900009, PatNum: 12827, AptDateTime: DATE + ' 15:00:00' }),
    ],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [],
    '/providers': [],
    '/patients/12827': patientRow(),
  });
  const app = await bootHygApp({ od });
  try {
    await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + DATE);
    const patients = app.db.audit.filter((r) => r.resource_type === 'hyg_day_patient');
    assert.equal(patients.length, 1, 'one disclosure of one patient');
  } finally {
    await app.close();
  }
});

test('a REFUSED day is audited too — a probe must leave a trail', async () => {
  const app = await bootHygApp({ od: odWithADay(), hygOffices: ['roland'] });
  try {
    await api(app.baseUrl, 'GET', '/api/hyg/day?office=valley&date=' + DATE);
    const rows = app.db.audit;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].resource_type, 'hyg_day');
    // Auditing only successes discards exactly what a HIPAA trail most needs:
    // somebody walking offices or dates and being refused.
    assert.equal(rows[0].result, 'UNAUTHORIZED');
  } finally {
    await app.close();
  }
});

test('if the audit write fails, the PHI is not served (hard rule 5)', async () => {
  const app = await bootHygApp({ od: odWithADay() });
  try {
    app.db.failAudit = true;
    const res = await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + DATE);
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'AUDIT_FAILED');
    assert.equal(res.body.appointments, undefined, 'no trail, no disclosure');
  } finally {
    await app.close();
  }
});

// ── the payload ─────────────────────────────────────────────────────────────

test('the day carries the chairs, the labels, and honest unknowns', async () => {
  const app = await bootHygApp({ od: odWithADay() });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + DATE);
    const body = res.body;

    assert.deepEqual(body.operatories.map((o) => o.opNum), [2, 3]);
    const first = body.appointments[0];
    assert.equal(first.aptNum, 900001);
    assert.equal(first.patNum, 12827);
    assert.equal(first.patientName, 'Test 2, Stedi');
    assert.equal(first.opName, 'Hygiene 1');
    assert.equal(first.apptTypeLabel, 'Prophy Adult');
    assert.equal(first.providerName, 'HYG1');
    assert.equal(first.lengthMin, 60);
    assert.equal(first.confirmedStatus, 'Confirmed');

    // Every flag this slice does not read must be null AND say why.
    for (const unread of ['allergies', 'lastPerioDate', 'xraysDue', 'examNeeded', 'openTcCase']) {
      assert.equal(first.flags[unread], null);
      assert.equal(body.flagSources[unread], 'not_read');
    }
  } finally {
    await app.close();
  }
});
