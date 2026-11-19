'use strict';

/**
 * MT-2d SINGLE WRITER, end to end through every write route of the ten keys
 * (this file replaces officeSettingsDualWrite.test.js, which pinned MT-2a's
 * dual-write into platform_setting + office_setting):
 *
 *   PUT /api/platform/hyg-offices/:office
 *   PUT /api/platform/tc-checkout-offices/:office
 *   PUT /api/platform/tc-od-sync-offices/:office
 *   PUT /api/platform/tc-auto-checkout-offices/:office
 *   PUT /api/platform/tc-referrals-offices/:office
 *   PUT /api/platform/tc-referral-email-offices/:office
 *   PUT /api/platform/tc-referral-patient-email-offices/:office
 *   PUT /api/tc/email-identity?office=
 *
 * (tc_nurture_enabled and tc_opportunities_sync have no write route: they are
 * turned on by a runbook statement. See docs/MT2D_SINGLE_WRITER.md.)
 *
 *   W  a write lands in office_setting ONLY: platform_setting is never written
 *      or read (an inert history row stays byte-for-byte as it was), and the
 *      OTHER office's row keeps its value and its provenance
 *   R  read-back is unchanged: the route's response and the reader serve what
 *      was written, and a same-value write re-stamps the row
 *   F  a forced office_setting failure, or a read-back that disagrees, rolls
 *      the write back and the route refuses with a 500
 *   B  break-glass: env =false beats a console-written true (any tenant); the
 *      env =true fallback answers only where no row exists, for 'carein'
 *   G  the three global keys keep the single platform_setting upsert, and
 *      setPlatformSetting REFUSES the ten per-office keys
 *
 * The real registry.setOfficeSetting runs against an in-memory control plane
 * (platform/officeSettingsTestUtils.js); only identity and tenancy are stubbed.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const registry = require('./registry');
const officeSettings = require('./officeSettings');
const tenantDb = require('./tenantDb');
const userContext = require('./userContext');
const { FakeControlPlane, TENANT_ID } = require('./officeSettingsTestUtils');
const { OFFICE_SETTING_KEYS } = require('./officeSettingKeys');
const { tenantContext } = require('../middleware/tenantContext');
const { requireSuperAdmin } = require('../config/permissions');
const { FakeTenantDb, bootTcApp, api } = require('../routes/tc/tcTestUtils');
const hygPilot = require('../config/hygPilot');
const emailIdentity = require('../config/emailIdentity');

/** route -> [setting key, the reader module] */
const SWITCH_ROUTES = [
  ['hyg-offices', 'hyg_od_enabled', hygPilot],
  ['tc-checkout-offices', 'tc_checkout_enabled', require('../config/tcCheckout')],
  ['tc-od-sync-offices', 'tc_od_sync_enabled', require('../config/tcOdSync')],
  ['tc-auto-checkout-offices', 'tc_auto_checkout_enabled', require('../config/tcAutoCheckout')],
  ['tc-referrals-offices', 'tc_referrals_enabled', require('../config/tcReferrals')],
  ['tc-referral-email-offices', 'tc_referral_email_enabled', require('../config/tcReferralEmail')],
  ['tc-referral-patient-email-offices', 'tc_referral_patient_email_enabled', require('../config/tcReferralPatientEmail')],
];
/** The six TC switches: the ones with an env =true fallback. */
const TC_SWITCH_ROUTES = SWITCH_ROUTES.filter(([, key]) => key !== 'hyg_od_enabled');

const REGISTRY_KEYS = [
  'getUserByEmail',
  'getTenantById',
  'getTenantClinics',
  'getEnabledModules',
  'getPlatformAdminByEmail',
  'touchUserLogin',
];

const ENV_KEYS = [
  ...SWITCH_ROUTES.flatMap(([, , m]) => [m.envVarFor('roland'), m.envVarFor('valley')]),
  'ACS_EMAIL_FROM_ROLAND',
  'ACS_EMAIL_REPLY_TO_ROLAND',
];

const NO_FAIL = Object.freeze({ platformUpsert: false, officeUpsert: false, officeReadbackTamper: null, listOfficeSettings: false });

function resetReaders() {
  for (const [, , m] of SWITCH_ROUTES) m.resetCacheForTests();
  emailIdentity.resetCacheForTests();
  officeSettings.resetCacheForTests();
}

/** One office_setting row, with its provenance. */
function officeRow(cp, key, officeKey) {
  return [...cp.officeSetting.values()].find((x) => x.setting_key === key && x.office_key === officeKey);
}

/** A platform_setting row, serialised so "untouched" means byte-for-byte. */
function platformSnapshot(cp) {
  return JSON.stringify([...cp.platform.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** No statement against platform_setting was issued. */
function assertNoPlatformStatement(cp, label) {
  const touched = cp.log.filter((sql) => /platform_setting/.test(sql));
  assert.deepEqual(touched, [], `${label}: platform_setting was not read or written`);
}

/** The platform console over the fake control plane, as a super_admin. */
async function bootPlatform(t, cp) {
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
    env: Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])),
  };
  for (const k of ENV_KEYS) delete process.env[k];
  resetReaders();
  registry.setPoolForTests(cp.pool());
  registry.getUserByEmail = async () => ({ user_id: 'U1', tenant_id: 'T1', email: 'boss@carein.ai', role: 'admin', status: 'active' });
  registry.getTenantById = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN', status: 'active' });
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => ['tc'];
  registry.getPlatformAdminByEmail = async () => ({ email: 'boss@carein.ai', status: 'active', created_at: new Date() });
  registry.touchUserLogin = async () => {};
  userContext.clearCache();
  const db = new FakeTenantDb();
  tenantDb.withTenantDb = async (_req, fn) => fn(db);

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { email: 'boss@carein.ai', name: 'Boss', tenantId: 'T1' };
    next();
  });
  app.use('/api', tenantContext());
  app.use('/api/platform', requireSuperAdmin(), require('../routes/platform'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(
    () =>
      new Promise((r) => {
        for (const k of REGISTRY_KEYS) registry[k] = originals.registry[k];
        tenantDb.withTenantDb = originals.withTenantDb;
        registry.setPoolForTests(null);
        for (const [k, v] of Object.entries(originals.env)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        resetReaders();
        server.close(r);
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

/** The served state of one office, as the console's GET reports it. */
async function stateOf(baseUrl, route, officeKey) {
  const r = await api(baseUrl, 'GET', `/api/platform/${route}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const offices = r.body.offices || [];
  return offices.find((o) => (o.office || o.officeKey) === officeKey);
}

for (const [route, key, reader] of SWITCH_ROUTES) {
  test(`W+R: PUT /api/platform/${route} writes ONE office_setting row and nothing else`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const cp = new FakeControlPlane();
    // Inert history a pre-MT-2d dual-write left behind, deliberately stale.
    cp.seedPlatform(key, { roland: false, valley: true, bogus: 'yes' }, 'history@example.test');
    const history = platformSnapshot(cp);
    const baseUrl = await bootPlatform(t, cp);

    cp.log.length = 0;
    let r = await api(baseUrl, 'PUT', `/api/platform/${route}/roland`, { enabled: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(cp.officeValues(key), { roland: true }, 'only the written office has a row');
    assert.equal(officeRow(cp, key, 'roland').updated_by, 'boss@carein.ai');
    assertNoPlatformStatement(cp, 'first write');
    assert.equal(platformSnapshot(cp), history, 'platform_setting history is byte-for-byte untouched');

    // Read-back: the reader serves it and the console reports it.
    assert.equal(reader === hygPilot ? hygPilot.hygEnabledFor('carein', 'roland') : reader.enabledFor('carein', 'roland'), true);
    const st = await stateOf(baseUrl, route, 'roland');
    assert.equal(st.enabled, true);

    // The other office: its own row, its own provenance, untouched by a roland write.
    r = await api(baseUrl, 'PUT', `/api/platform/${route}/valley`, { enabled: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const valleyBefore = { ...officeRow(cp, key, 'valley') };
    r = await api(baseUrl, 'PUT', `/api/platform/${route}/roland`, { enabled: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(officeRow(cp, key, 'valley'), valleyBefore, 'valley row (value + provenance) untouched');
    assert.deepEqual(cp.officeValues(key), { roland: false, valley: false });

    // "Reaffirmed today": the same value again re-stamps the row.
    const stampBefore = officeRow(cp, key, 'roland').updated_at.getTime();
    r = await api(baseUrl, 'PUT', `/api/platform/${route}/roland`, { enabled: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(officeRow(cp, key, 'roland').updated_at.getTime() > stampBefore, 'same-value write re-stamps');

    assertNoPlatformStatement(cp, 'every write');
    assert.equal(platformSnapshot(cp), history);
  });

  test(`F: PUT /api/platform/${route} — a failed write or a bad read-back rolls back and refuses`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const cp = new FakeControlPlane();
    const baseUrl = await bootPlatform(t, cp);
    assert.equal((await api(baseUrl, 'PUT', `/api/platform/${route}/roland`, { enabled: true })).status, 200);
    const before = JSON.stringify([...cp.officeSetting.entries()]);

    for (const force of ['officeUpsert', 'officeReadbackTamper']) {
      if (force === 'officeReadbackTamper') {
        cp.fail.officeReadbackTamper = (rows) => rows.map((x) => ({ ...x, value: !x.value }));
      } else {
        cp.fail[force] = true;
      }
      const r = await api(baseUrl, 'PUT', `/api/platform/${route}/valley`, { enabled: true });
      assert.equal(r.status, 500, `${force}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.success, false);
      assert.equal(JSON.stringify([...cp.officeSetting.entries()]), before, `${force}: office_setting rolled back`);
      assert.deepEqual([...cp.platform.keys()], [], `${force}: platform_setting never written`);
      cp.fail = { ...NO_FAIL };
    }
    assert.equal(
      (await api(baseUrl, 'PUT', `/api/platform/${route}/valley`, { enabled: true })).status,
      200,
      'and the next clean write goes through'
    );
    assert.deepEqual(cp.officeValues(key), { roland: true, valley: true });
  });
}

for (const [route, key, reader] of TC_SWITCH_ROUTES) {
  test(`B: ${key} — env =false beats a console-written true; =true answers only where no row exists`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const cp = new FakeControlPlane();
    const baseUrl = await bootPlatform(t, cp);
    const rolandVar = reader.envVarFor('roland');
    const valleyVar = reader.envVarFor('valley');

    assert.equal((await api(baseUrl, 'PUT', `/api/platform/${route}/roland`, { enabled: true })).status, 200);
    assert.equal(reader.enabledFor('carein', 'roland'), true);

    // Break-glass: =false beats the stored true, with no restart, for every tenant.
    process.env[rolandVar] = 'false';
    assert.equal(reader.enabledFor('carein', 'roland'), false);
    assert.equal(reader.sourceFor('carein', 'roland'), 'env');
    let st = await stateOf(baseUrl, route, 'roland');
    assert.equal(st.enabled, false);
    assert.equal(st.source, 'env');
    delete process.env[rolandVar];
    assert.equal(reader.enabledFor('carein', 'roland'), true, 'and the stored value answers again');

    // =true fallback: only where nobody chose, and only for carein.
    process.env[valleyVar] = 'true';
    assert.equal(reader.enabledFor('carein', 'valley'), true);
    assert.equal(reader.sourceFor('carein', 'valley'), 'env');
    assert.equal(reader.enabledFor('acme', 'valley'), false, 'another tenant never gets carein’s =true');
    // A stored false is a choice, and beats the =true fallback.
    assert.equal((await api(baseUrl, 'PUT', `/api/platform/${route}/valley`, { enabled: false })).status, 200);
    assert.equal(reader.enabledFor('carein', 'valley'), false);
    assert.equal(reader.sourceFor('carein', 'valley'), 'db');
    st = await stateOf(baseUrl, route, 'valley');
    assert.equal(st.enabled, false);
    delete process.env[valleyVar];
    assert.deepEqual(cp.officeValues(key), { roland: true, valley: false });
  });
}

test('B: hyg_od_enabled — HYG_OD_ENABLED_<OFFICE>=false beats a console-written true', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const cp = new FakeControlPlane();
  const baseUrl = await bootPlatform(t, cp);
  assert.equal((await api(baseUrl, 'PUT', '/api/platform/hyg-offices/roland', { enabled: true })).status, 200);
  assert.equal(hygPilot.hygEnabledFor('carein', 'roland'), true);
  process.env[hygPilot.envVarFor('roland')] = 'false';
  assert.equal(hygPilot.hygEnabledFor('carein', 'roland'), false);
  delete process.env[hygPilot.envVarFor('roland')];
  assert.equal(hygPilot.hygEnabledFor('carein', 'roland'), true);
});

/** The TC app (email identity) over the fake control plane. */
async function bootIdentity(t, cp) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ACS_EMAIL_FROM_ROLAND = 'donotreply@roland.example.test';
  resetReaders();
  const db = new FakeTenantDb();
  // Make the fake honour ROLLBACK, as Postgres does (tcEmailIdentity.test.js 'H').
  let snapshot = null;
  db.onQuery(/^BEGIN$/, () => {
    snapshot = JSON.stringify([...db.tables.entries()]);
    return { rows: [] };
  });
  db.onQuery(/^ROLLBACK$/, () => {
    db.tables = new Map(JSON.parse(snapshot));
    return { rows: [] };
  });
  const app = await bootTcApp({ db, role: 'admin' });
  // bootTcApp does not touch the pool; install the fake after it.
  registry.setPoolForTests(cp.pool());
  t.after(async () => {
    await app.close();
    registry.setPoolForTests(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetReaders();
  });
  return { baseUrl: app.baseUrl, db };
}

const IDENTITY = {
  replyTo: 'FrontDesk@Roland.example.test',
  practiceName: 'Roland Example Dental',
  practicePhone: '(918) 555-0142',
};

test('W+R: PUT /api/tc/email-identity writes ONE office_setting row; valley and platform_setting untouched', async (t) => {
  t.mock.method(console, 'error', () => {});
  const cp = new FakeControlPlane();
  cp.seedPlatform('tc_email_identity', { roland: { practiceName: 'Stale History' }, unknown: { replyTo: 'x@example.test' } });
  const history = platformSnapshot(cp);
  cp.seedOffice('valley', 'tc_email_identity', { practiceName: 'Valley Example' });
  const { baseUrl } = await bootIdentity(t, cp);
  const valleyBefore = { ...officeRow(cp, 'tc_email_identity', 'valley') };

  cp.log.length = 0;
  const r = await api(baseUrl, 'PUT', '/api/tc/email-identity?office=roland', IDENTITY);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(cp.officeValues('tc_email_identity'), {
    roland: {
      replyTo: 'frontdesk@roland.example.test',
      practiceName: 'Roland Example Dental',
      practicePhone: '(918) 555-0142',
    },
    valley: { practiceName: 'Valley Example' },
  });
  assert.deepEqual(officeRow(cp, 'tc_email_identity', 'valley'), valleyBefore, 'valley row untouched');
  assertNoPlatformStatement(cp, 'identity write');
  assert.equal(platformSnapshot(cp), history, 'platform_setting history untouched');

  // Read-back: what is served is what was written.
  assert.equal(emailIdentity.storedValue('carein', 'roland', 'replyTo'), 'frontdesk@roland.example.test');
  const g = await api(baseUrl, 'GET', '/api/tc/email-identity?office=roland');
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(JSON.stringify(g.body).includes('Stale History'), false, 'the stale history row is never served');
});

test('F: PUT /api/tc/email-identity — a failed write or a bad read-back rolls back, with no history row', async (t) => {
  t.mock.method(console, 'error', () => {});
  const cp = new FakeControlPlane();
  const { baseUrl, db } = await bootIdentity(t, cp);
  assert.equal((await api(baseUrl, 'PUT', '/api/tc/email-identity?office=roland', IDENTITY)).status, 200);
  const before = cp.officeValues('tc_email_identity');
  const historyBefore = db.table('tc_email_identity_changes').length;

  for (const force of ['officeUpsert', 'officeReadbackTamper']) {
    if (force === 'officeReadbackTamper') {
      cp.fail.officeReadbackTamper = (rows) => rows.map((x) => ({ ...x, value: {} }));
    } else {
      cp.fail[force] = true;
    }
    const r = await api(baseUrl, 'PUT', '/api/tc/email-identity?office=roland', { ...IDENTITY, practiceName: 'Changed Example' });
    assert.equal(r.status, 500, `${force}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(cp.officeValues('tc_email_identity'), before, `${force}: office_setting rolled back`);
    assert.deepEqual([...cp.platform.keys()], [], `${force}: platform_setting never written`);
    assert.equal(db.table('tc_email_identity_changes').length, historyBefore, `${force}: no history row`);
    cp.fail = { ...NO_FAIL };
  }
});

test('G: the three global keys keep the single platform_setting upsert: no transaction, no office_setting statement', async (t) => {
  const cp = new FakeControlPlane();
  registry.setPoolForTests(cp.pool());
  t.after(() => registry.setPoolForTests(null));
  for (const key of ['tc_email_enabled', 'tc_sms_enabled', 'call_retention_days']) {
    cp.log.length = 0;
    await registry.setPlatformSetting(key, key === 'call_retention_days' ? 30 : true, 'boss@carein.ai');
    assert.equal(cp.log.length, 1, key);
    assert.match(cp.log[0], /^INSERT INTO platform_setting/);
  }
  assert.deepEqual([...cp.officeSetting.values()], []);
});

test('G: setPlatformSetting REFUSES every one of the ten per-office keys and issues no statement', async (t) => {
  const cp = new FakeControlPlane();
  registry.setPoolForTests(cp.pool());
  t.after(() => registry.setPoolForTests(null));
  for (const key of OFFICE_SETTING_KEYS) {
    await assert.rejects(registry.setPlatformSetting(key, { roland: true }, 'boss@carein.ai'), {
      code: 'OFFICE_SETTING_NOT_PLATFORM',
    });
  }
  assert.deepEqual(cp.log, []);
  assert.deepEqual([...cp.platform.keys()], []);
});

test('setOfficeSetting refuses a non-office key and a value of the wrong shape, issuing no statement', async (t) => {
  const cp = new FakeControlPlane();
  registry.setPoolForTests(cp.pool());
  t.after(() => registry.setPoolForTests(null));
  await assert.rejects(registry.setOfficeSetting('carein', 'roland', 'tc_email_enabled', true), { code: 'NOT_AN_OFFICE_SETTING' });
  await assert.rejects(registry.setOfficeSetting('carein', 'roland', 'toString', true), { code: 'NOT_AN_OFFICE_SETTING' });
  await assert.rejects(registry.setOfficeSetting('carein', 'roland', 'tc_checkout_enabled', 'true'), {
    code: 'INVALID_OFFICE_SETTING_VALUE',
  });
  await assert.rejects(registry.setOfficeSetting('carein', 'roland', 'tc_email_identity', true), {
    code: 'INVALID_OFFICE_SETTING_VALUE',
  });
  await assert.rejects(registry.setOfficeSetting('carein', 'roland', 'tc_email_identity', []), {
    code: 'INVALID_OFFICE_SETTING_VALUE',
  });
  assert.deepEqual(cp.log, []);
});

test('setOfficeSetting writes the named tenant’s row only (tenant_id from the slug), and returns it', async (t) => {
  const ACME = '00000000-0000-4000-8000-0000000000a1';
  const cp = new FakeControlPlane({
    tenants: [
      { tenant_id: TENANT_ID, slug: 'carein' },
      { tenant_id: ACME, slug: 'acme' },
    ],
    offices: [
      { tenant_id: TENANT_ID, office_key: 'roland' },
      { tenant_id: ACME, office_key: 'roland' },
    ],
  });
  registry.setPoolForTests(cp.pool());
  t.after(() => registry.setPoolForTests(null));
  const row = await registry.setOfficeSetting('acme', 'roland', 'tc_checkout_enabled', true, 'ops@example.test');
  assert.equal(row.value, true);
  assert.equal(row.updated_by, 'ops@example.test');
  assert.deepEqual(cp.officeValues('tc_checkout_enabled', ACME), { roland: true });
  assert.deepEqual(cp.officeValues('tc_checkout_enabled', TENANT_ID), {}, "carein's roland is not touched");
});

test('an environment with no office rows writes NOTHING, warns once, and the route refuses on read-back', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const cp = new FakeControlPlane({ offices: [] });
  registry.setPoolForTests(cp.pool());
  t.after(() => registry.setPoolForTests(null));
  assert.equal(await registry.setOfficeSetting('carein', 'roland', 'tc_referrals_enabled', true), null);
  assert.equal(await registry.setOfficeSetting('carein', 'roland', 'tc_referrals_enabled', false), null);
  assert.deepEqual(cp.officeValues('tc_referrals_enabled'), {});
  assert.deepEqual([...cp.platform.keys()], []);
  assert.equal(warn.mock.calls.filter((c) => String(c.arguments[0]).includes('office_setting not written')).length, 1);
});
