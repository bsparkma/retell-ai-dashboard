'use strict';

/**
 * R6.2 (B) — a referral started BY HAND from the hub: POST /api/tc/referrals
 * with source { patNum }.
 *
 *   - the shared createDraft path: a draft, its create event, its audit row;
 *     source_kind `manual`, source_ref '', no case
 *   - the office is the request's ?office= (requireOffice), never the body; the
 *     PatNum names WHICH patient only — it is re-read from THAT office's Open
 *     Dental (its own client, never another practice's), and the name comes
 *     from Open Dental, never from the body
 *   - strict body: an office, a name or any other smuggled field is a 400, and
 *     Open Dental is never asked
 *   - honest refusals: not in this office's OD (404), OD unreachable (502),
 *     office not connected (503) — and nothing is stored
 *   - tc.full only; dark while referrals is off; read-only toward OD; nothing
 *     sends
 *
 * The per-office OD clients are the REAL instances with apiGetRaw patched (the
 * handles are frozen, so the double goes on the client). Test patients only.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const odOffices = require('../../config/odOffices');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

/** Distinct rows per practice, so an assertion proves WHICH database was read. */
const OD_PATIENTS = {
  roland: {
    12827: { PatNum: 12827, LName: 'Test 2', FName: 'Stedi', Birthdate: '1980-01-01', PatStatus: 'Patient' },
    12900: { PatNum: 12900, LName: 'Gone', FName: 'Fixture', Birthdate: '1970-01-01', PatStatus: 'Deleted' },
  },
  valley: {
    7115: { PatNum: 7115, LName: 'TestValley', FName: 'Stedi', Birthdate: '1985-02-02', PatStatus: 'Patient' },
  },
};

const savedEnv = {};
let odCalls = [];
let patched = [];
/** Per-office override: return this { ok, status, data } instead of the row. */
let odAnswer = {};

before(() => {
  for (const k of ['OPENDENTAL_CUSTOMER_KEY', 'OPENDENTAL_CUSTOMER_KEY_VALLEY', 'OPENDENTAL_ALLOW_MOCK']) savedEnv[k] = process.env[k];
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

beforeEach(() => {
  odCalls = [];
  patched = [];
  odAnswer = {};
  for (const officeKey of ['roland', 'valley']) {
    const { client } = odOffices.getOdOffice(officeKey);
    patched.push({ client, original: client.apiGetRaw });
    client.apiGetRaw = async (path, params) => {
      odCalls.push({ office: officeKey, path, params });
      if (odAnswer[officeKey]) return odAnswer[officeKey];
      const m = /^\/patients\/(\d+)$/.exec(path);
      const row = m ? OD_PATIENTS[officeKey][m[1]] : null;
      return row ? { ok: true, status: 200, data: row } : { ok: false, status: 404, data: null };
    };
  }
});

afterEach(() => {
  for (const { client, original } of patched) client.apiGetRaw = original;
  patched = [];
});

function switchReferrals(t, byOffice = { roland: true, valley: true }) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' && byOffice ? { key, value: byOffice, updated_at: new Date(), updated_by: null } : null;
  tcReferrals.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcReferrals.resetCacheForTests();
  });
}

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const REF = (office = 'roland') => `/api/tc/referrals?office=${office}`;
const BODY = { reason: 'Possible cracked tooth, needs endo eval', urgency: 'soon', teeth: [3] };
const referralAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_referral');

test('a hand start: the shared create path — a manual draft, its event, its audit; patient from OD', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const r = await api(baseUrl, 'POST', REF(), { source: { patNum: 12827 }, referral: BODY });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ref = r.body.referral;
  assert.deepEqual(
    [ref.status, ref.sourceKind, ref.sourceRef, ref.tcCaseId, ref.officeId, ref.odPatientId, ref.patientName],
    ['draft', 'manual', '', null, 'roland', 12827, 'Test 2, Stedi']
  );
  assert.equal(ref.reason, BODY.reason);
  assert.deepEqual(odCalls.map((c) => [c.office, c.path]), [['roland', '/patients/12827']], "only roland's OD, only a GET");
  const events = db.table('tc_referral_events').filter((e) => e.referral_id === ref.referralId);
  assert.deepEqual(events.map((e) => [e.from_status, e.to_status]), [[null, 'draft']]);
  assert.deepEqual(referralAudits(db).filter((a) => a.action === 'CREATE').map((a) => a.resource_id), [ref.referralId]);
});

test("the office is the request's: valley reads valley's OD and stores a valley referral", async (t) => {
  switchReferrals(t);
  const { baseUrl } = await boot(t, { role: 'tc' });
  const r = await api(baseUrl, 'POST', REF('valley'), { source: { patNum: 7115 }, referral: BODY });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.referral.officeId, r.body.referral.patientName], ['valley', 'TestValley, Stedi']);
  assert.deepEqual(odCalls.map((c) => c.office), ['valley']);
  // ...and roland's PatNum means nothing at valley: refused, not looked up elsewhere.
  odCalls = [];
  const miss = await api(baseUrl, 'POST', REF('valley'), { source: { patNum: 12827 }, referral: BODY });
  assert.equal(miss.status, 404);
  assert.equal(miss.body.code, 'PATIENT_NOT_FOUND');
  assert.deepEqual(odCalls.map((c) => c.office), ['valley']);
});

test('strict body: a smuggled office, name, or anything else is a 400 — and OD is never asked', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const smuggled = [
    { source: { patNum: 12827, officeId: 'valley' }, referral: BODY },
    { source: { patNum: 12827, office: 'valley' }, referral: BODY },
    { source: { patNum: 12827, patientName: 'Somebody Else' }, referral: BODY },
    { source: { patNum: 12827 }, referral: BODY, office: 'valley' },
    { source: { patNum: 12827 }, referral: { ...BODY, patientName: 'Somebody Else' } },
    { source: { patNum: 12827 }, referral: { ...BODY, odPatientId: 1 } },
    { source: { patNum: '12827' }, referral: BODY },
    { source: { patNum: 0 }, referral: BODY },
    { source: { patNum: 1.5 }, referral: BODY },
    { source: { patNum: 12827, caseId: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff' }, referral: BODY },
  ];
  for (const body of smuggled) {
    const r = await api(baseUrl, 'POST', REF(), body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(odCalls.length, 0);
  assert.equal(db.table('tc_referrals').length, 0);
});

test('honest refusals, nothing stored: not in OD / a deleted patient (404), OD down (502), not connected (503)', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  let r = await api(baseUrl, 'POST', REF(), { source: { patNum: 99999 }, referral: BODY });
  assert.deepEqual([r.status, r.body.code], [404, 'PATIENT_NOT_FOUND']);
  r = await api(baseUrl, 'POST', REF(), { source: { patNum: 12900 }, referral: BODY });
  assert.deepEqual([r.status, r.body.code], [404, 'PATIENT_NOT_FOUND'], 'the statuses the search hides');

  odAnswer.roland = { ok: false, status: 500, data: null };
  r = await api(baseUrl, 'POST', REF(), { source: { patNum: 12827 }, referral: BODY });
  assert.deepEqual([r.status, r.body.code], [502, 'OD_READ_FAILED']);
  assert.match(r.body.error, /Nothing was saved/);

  const key = process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  odOffices.resetOdOfficeCache();
  t.after(() => {
    process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = key;
    odOffices.resetOdOfficeCache();
  });
  r = await api(baseUrl, 'POST', REF('valley'), { source: { patNum: 7115 }, referral: BODY });
  assert.deepEqual([r.status, r.body.code], [503, 'OFFICE_NOT_CONNECTED'], 'never falls back to another office');
  assert.ok(!odCalls.some((c) => c.office === 'roland' && c.path === '/patients/7115'));

  assert.equal(db.table('tc_referrals').length, 0);
  assert.equal(referralAudits(db).filter((a) => a.action === 'CREATE').length, 0);
});

test('tc.full only: hygiene and doctor are refused before OD is asked; dark → 403', async (t) => {
  switchReferrals(t);
  for (const role of ['hygiene', 'doctor', 'reviewer']) {
    const { baseUrl } = await boot(t, { role });
    const r = await api(baseUrl, 'POST', REF(), { source: { patNum: 12827 }, referral: BODY });
    assert.equal(r.status, 403, role);
  }
  assert.equal(odCalls.length, 0);
});

test('dark: referrals off for the office → 403, and OD is never asked', async (t) => {
  switchReferrals(t, { roland: false });
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const r = await api(baseUrl, 'POST', REF(), { source: { patNum: 12827 }, referral: BODY });
  assert.equal(r.status, 403);
  assert.equal(odCalls.length, 0);
  assert.equal(db.table('tc_referrals').length, 0);
});

test('the hub lists a manual referral, and its filter finds it by kind', async (t) => {
  switchReferrals(t);
  const { baseUrl } = await boot(t, { role: 'tc' });
  const made = (await api(baseUrl, 'POST', REF(), { source: { patNum: 12827 }, referral: BODY })).body.referral;
  const hub = await api(baseUrl, 'GET', `/api/tc/referrals/hub?office=roland&sourceKind=manual`);
  assert.equal(hub.status, 200, JSON.stringify(hub.body));
  assert.deepEqual(hub.body.referrals.map((x) => [x.referralId, x.sourceKind]), [[made.referralId, 'manual']]);
});
