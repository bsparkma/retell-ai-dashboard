'use strict';

/**
 * GET /api/tc/od/patient-search — the ONE Open Dental read a hygienist holds.
 *
 * WHY IT IS ITS OWN ROUTE RATHER THAN A LOOSENED /od/patients:
 *
 *  1. /api/tc/od is gated tc.full at the mount. Narrowing one route inside it
 *     would mean dropping the mount gate and re-applying it per route — a
 *     fail-OPEN shape, where the next route someone adds to od.js is
 *     hygiene-readable by omission. This mount is gated tc.hygiene as a whole
 *     and contains exactly one route.
 *  2. It returns LESS. Attaching a patient to an intake needs a PatNum, a name
 *     and a date of birth to tell two same-named patients apart. It does not
 *     need the treatment plan, the money, or the insurance that the rest of
 *     /od serves.
 *  3. It resolves the OD client PER OFFICE (config/odOffices), which the rest
 *     of /od does not: those routes go through the tenant-level odAccess seam
 *     and are Roland-only. Riley is a SEPARATE Open Dental database — PatNum
 *     7115 is "Stedi TestValley" there and a different, real patient in Roland
 *     — so a search that ignored the office would hand back the wrong
 *     practice's patients for the hygienist to attach.
 *
 * Every test below is one of those three properties, or a way the office can
 * be got wrong.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;

const odOffices = require('../../config/odOffices');
const { bootTcApp, api, FakeTenantDb } = require('./tcTestUtils');

// --- per-office OD doubles --------------------------------------------------

/**
 * Distinct answers per practice, so an assertion can prove WHICH database was
 * read. Roland's row is a stand-in: the real collision (the same PatNum being a
 * different real person in each database) is the point, but naming that person
 * would put real patient data in a fixture.
 */
const OD_ROWS = {
  roland: [
    { PatNum: 12828, LName: 'Test', FName: 'MangoTest', Birthdate: '1990-04-01', PatStatus: 'Patient',
      WirelessPhone: '4795550100', Email: 'roland-fixture@example.invalid' },
  ],
  valley: [
    { PatNum: 7115, LName: 'TestValley', FName: 'Stedi', Birthdate: '1985-02-02', PatStatus: 'Patient',
      WirelessPhone: '4795550101', Email: 'valley-fixture@example.invalid' },
  ],
};

const savedEnv = {};
/** Every OD call any office made: { office, path, params }. */
let odCalls = [];
/** client instances we patched, so afterEach can put them back. */
let patched = [];

before(() => {
  for (const k of ['OPENDENTAL_CUSTOMER_KEY', 'OPENDENTAL_CUSTOMER_KEY_VALLEY', 'OPENDENTAL_ALLOW_MOCK']) {
    savedEnv[k] = process.env[k];
  }
  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-valley-customer-key';
  delete process.env.OPENDENTAL_ALLOW_MOCK;
  odOffices.resetOdOfficeCache();
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  odOffices.resetOdOfficeCache();
});

/**
 * Patch apiGetRaw on each office's REAL client instance, leaving the real
 * office→client wiring under test. The handle is frozen on purpose (an office
 * must not be re-pointed at another practice at runtime), so the double goes on
 * the client, not on the registry.
 */
function stubOdClients() {
  odCalls = [];
  patched = [];
  for (const officeKey of ['roland', 'valley']) {
    const { client } = odOffices.getOdOffice(officeKey);
    patched.push({ client, original: client.apiGetRaw });
    client.apiGetRaw = async (path, params) => {
      odCalls.push({ office: officeKey, path, params });
      const field = params && (params.LName || params.FName);
      const rows = OD_ROWS[officeKey].filter(
        (r) =>
          !field ||
          String(r.LName).toLowerCase().startsWith(String(field).toLowerCase()) ||
          String(r.FName).toLowerCase().startsWith(String(field).toLowerCase())
      );
      return { ok: true, status: 200, data: rows };
    };
  }
}

function restoreOdClients() {
  for (const { client, original } of patched) client.apiGetRaw = original;
  patched = [];
}

beforeEach(stubOdClients);
afterEach(restoreOdClients);

const SEARCH = '/api/tc/od/patient-search';

// --- 1. who may reach it ----------------------------------------------------

test('hygiene: may search patients for the office they are working at', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: new FakeTenantDb() });
  try {
    const res = await api(baseUrl, 'GET', `${SEARCH}?office=roland&q=Test`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.office, 'roland');
    assert.equal(res.body.patients.length, 1);
    assert.equal(res.body.patients[0].patNum, 12828);
  } finally {
    await close();
  }
});

test('hygiene: every OTHER /od read stays a 403 — this opens one route, not the family', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: new FakeTenantDb() });
  try {
    for (const p of [
      '/api/tc/od/status',
      '/api/tc/od/patients?q=Test',
      '/api/tc/od/patients/12828',
      '/api/tc/od/treatment-plan/12828',
      '/api/tc/od/unaccepted',
      '/api/tc/od/cob-procedures/12828',
      '/api/tc/od/insurance/12828',
      '/api/tc/od/next-appointment/12828',
    ]) {
      const res = await api(baseUrl, 'GET', `${p}${p.includes('?') ? '&' : '?'}office=roland`);
      assert.equal(res.status, 403, `hygiene must not reach ${p} (got ${res.status})`);
      assert.equal(res.body.action, 'tc.full');
    }
  } finally {
    await close();
  }
});

test('tc, office and admin reach the search too — it is a narrowing, not a swap', async () => {
  for (const role of ['tc', 'office', 'admin']) {
    const { baseUrl, close } = await bootTcApp({ role, db: new FakeTenantDb() });
    try {
      const res = await api(baseUrl, 'GET', `${SEARCH}?office=roland&q=Test`);
      assert.equal(res.status, 200, `${role} should reach the attach search`);
    } finally {
      await close();
    }
  }
});

// --- 2. the office is the whole ballgame ------------------------------------

test('the office selects which practice database is read', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: new FakeTenantDb() });
  try {
    const roland = await api(baseUrl, 'GET', `${SEARCH}?office=roland&q=Test`);
    const valley = await api(baseUrl, 'GET', `${SEARCH}?office=valley&q=Test`);

    assert.equal(roland.body.patients[0].patNum, 12828);
    assert.equal(valley.body.patients[0].patNum, 7115);
    assert.equal(valley.body.patients[0].displayName, 'TestValley, Stedi');

    // And nothing crossed: every OD call went to the office it was asked for.
    assert.ok(odCalls.length > 0);
    assert.deepEqual([...new Set(odCalls.map((c) => c.office))].sort(), ['roland', 'valley']);
  } finally {
    await close();
  }
});

test('an unknown office is refused BEFORE any Open Dental call', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: new FakeTenantDb() });
  try {
    for (const office of ['sneaky', 'unknown', '', 'ROLAND']) {
      const res = await api(baseUrl, 'GET', `${SEARCH}?office=${encodeURIComponent(office)}&q=Test`);
      assert.equal(res.status, 400, `office '${office}' must be refused`);
      assert.equal(res.body.code, 'INVALID_OFFICE');
    }
    const missing = await api(baseUrl, 'GET', `${SEARCH}?q=Test`);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'INVALID_OFFICE');

    assert.equal(odCalls.length, 0, 'a rejected office must never reach Open Dental');
  } finally {
    await close();
  }
});

test('an office with no Open Dental credentials gets the honest not-connected state', async () => {
  const savedKey = process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  odOffices.resetOdOfficeCache();
  restoreOdClients();

  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: new FakeTenantDb() });
  try {
    const res = await api(baseUrl, 'GET', `${SEARCH}?office=valley&q=Test`);
    // OFFICE_NOT_CONNECTED is the code the shared OD UI renders as "OD not
    // connected for this office yet" — an answer about that office, not an error.
    assert.equal(res.body.code, 'OFFICE_NOT_CONNECTED');
    assert.equal(res.body.office, 'valley');
    // The precise reason is carried too, so a log says WHY without guessing.
    assert.equal(res.body.reason, 'OFFICE_OD_KEY_MISSING');
    assert.ok(!('patients' in res.body) || res.body.patients.length === 0);
  } finally {
    await close();
    if (savedKey === undefined) delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
    else process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = savedKey;
    odOffices.resetOdOfficeCache();
  }
});

// --- 3. it returns the minimum, and nothing more ----------------------------

test('the result carries only what attaching needs — no phone, email or status', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: new FakeTenantDb() });
  try {
    const res = await api(baseUrl, 'GET', `${SEARCH}?office=roland&q=Test`);
    const [p] = res.body.patients;
    assert.deepEqual(Object.keys(p).sort(), [
      'birthdate',
      'displayName',
      'firstName',
      'lastName',
      'patNum',
    ]);
    // DOB is not decoration: OD matches names by PREFIX, so it is the only way
    // to tell two "Test" patients apart before attaching one to a chart.
    assert.equal(p.birthdate, '1990-04-01');
    assert.equal(res.body.matchMode, 'prefix');
  } finally {
    await close();
  }
});

test('a short query costs nothing — no OD round trip while the user is still typing', async () => {
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: new FakeTenantDb() });
  try {
    const res = await api(baseUrl, 'GET', `${SEARCH}?office=roland&q=T`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.patients, []);
    assert.equal(odCalls.length, 0);
  } finally {
    await close();
  }
});

test('the first-name lane runs too — a last-name-only search would miss the fixture', async () => {
  // PatNum 12828 is LName "Test", FName "MangoTest". Searching "MangoTest"
  // finds nothing on the LName lane; the merge is what makes it findable.
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db: new FakeTenantDb() });
  try {
    const res = await api(baseUrl, 'GET', `${SEARCH}?office=roland&q=MangoTest`);
    assert.equal(res.status, 200);
    assert.equal(res.body.patients.length, 1);
    assert.ok(
      odCalls.some((c) => c.params && c.params.FName === 'MangoTest'),
      'the first-name lane must be tried when the last-name lane is thin'
    );
  } finally {
    await close();
  }
});

// --- 4. audit ---------------------------------------------------------------

test('one audit row per search, naming the office and NEVER the search text', async () => {
  const db = new FakeTenantDb();
  const { baseUrl, close } = await bootTcApp({ role: 'hygiene', db });
  try {
    await api(baseUrl, 'GET', `${SEARCH}?office=valley&q=TestValley`);
    const rows = db.table('audit_log');
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].action, 'READ');
    assert.equal(rows[0].resource_type, 'od_patient_search');
    assert.equal(rows[0].resource_id, null, 'a search term is PHI and must not be stored');
    const serialized = JSON.stringify(rows[0]);
    assert.ok(!serialized.includes('TestValley'), `audit row leaked the query: ${serialized}`);
  } finally {
    await close();
  }
});
