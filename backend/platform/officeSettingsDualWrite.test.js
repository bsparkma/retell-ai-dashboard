'use strict';

/**
 * MT-2a dual-write, end to end through every write route of the ten keys:
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
 * turned on by a runbook statement. See docs/MT2A_OFFICE_SETTINGS.md.)
 *
 *   L  each route lands identical values in platform_setting and office_setting
 *      for tenant 'carein' (junk already in the map is kept in platform_setting
 *      and never mirrored)
 *   F  a forced failure of EITHER write, or a read-back that disagrees, rolls
 *      BOTH back and the route refuses with a 500
 *
 * The real registry.setPlatformSetting runs against an in-memory control plane
 * (platform/officeSettingsTestUtils.js); only identity and tenancy are stubbed.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const registry = require('./registry');
const parity = require('./officeSettingsParity');
const officeSettings = require('./officeSettings');
const tenantDb = require('./tenantDb');
const userContext = require('./userContext');
const { FakeControlPlane } = require('./officeSettingsTestUtils');
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

function resetReaders() {
  for (const [, , m] of SWITCH_ROUTES) m.resetCacheForTests();
  emailIdentity.resetCacheForTests();
  officeSettings.resetCacheForTests();
  parity.resetForTests();
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

for (const [route, key] of SWITCH_ROUTES) {
  test(`L: PUT /api/platform/${route} lands identical values in both tables`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const cp = new FakeControlPlane();
    const baseUrl = await bootPlatform(t, cp);

    let r = await api(baseUrl, 'PUT', `/api/platform/${route}/roland`, { enabled: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(cp.platformValue(key), { roland: true });
    assert.deepEqual(cp.officeValues(key), { roland: true });
    const rolandRow = [...cp.officeSetting.values()].find((x) => x.setting_key === key && x.office_key === 'roland');
    assert.equal(rolandRow.updated_by, 'boss@carein.ai');

    r = await api(baseUrl, 'PUT', `/api/platform/${route}/valley`, { enabled: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(cp.platformValue(key), { roland: true, valley: false });
    assert.deepEqual(cp.officeValues(key), { roland: true, valley: false });

    // Junk a runbook left in the map: kept in platform_setting, never mirrored.
    cp.seedPlatform(key, { roland: true, valley: false, unknown: true, bogus: 'yes' });
    r = await api(baseUrl, 'PUT', `/api/platform/${route}/roland`, { enabled: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(cp.platformValue(key), { roland: false, valley: false, unknown: true, bogus: 'yes' });
    assert.deepEqual(cp.officeValues(key), { roland: false, valley: false });
  });

  test(`F: PUT /api/platform/${route} — a failure of either write, or a bad read-back, rolls BOTH back`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const cp = new FakeControlPlane();
    const baseUrl = await bootPlatform(t, cp);
    assert.equal((await api(baseUrl, 'PUT', `/api/platform/${route}/roland`, { enabled: true })).status, 200);
    const before = { platform: cp.platformValue(key), office: cp.officeValues(key) };

    for (const force of ['officeUpsert', 'platformUpsert', 'officeReadbackTamper']) {
      if (force === 'officeReadbackTamper') {
        cp.fail.officeReadbackTamper = (rows) => rows.map((x) => ({ ...x, value: !x.value }));
      } else {
        cp.fail[force] = true;
      }
      const r = await api(baseUrl, 'PUT', `/api/platform/${route}/valley`, { enabled: true });
      assert.equal(r.status, 500, `${force}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.success, false);
      assert.deepEqual(cp.platformValue(key), before.platform, `${force}: platform_setting rolled back`);
      assert.deepEqual(cp.officeValues(key), before.office, `${force}: office_setting rolled back`);
      cp.fail = { platformUpsert: false, officeUpsert: false, officeReadbackTamper: null, listOfficeSettings: false };
    }
    assert.equal(
      (await api(baseUrl, 'PUT', `/api/platform/${route}/valley`, { enabled: true })).status,
      200,
      'and the next clean write goes through'
    );
    assert.deepEqual(cp.officeValues(key), { roland: true, valley: true });
  });
}

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

test('L: PUT /api/tc/email-identity lands identical values in both tables', async (t) => {
  t.mock.method(console, 'error', () => {});
  const cp = new FakeControlPlane();
  const { baseUrl } = await bootIdentity(t, cp);
  cp.seedPlatform('tc_email_identity', { valley: { practiceName: 'Valley Example' }, unknown: { replyTo: 'x@example.test' } });

  const r = await api(baseUrl, 'PUT', '/api/tc/email-identity?office=roland', IDENTITY);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const stored = cp.platformValue('tc_email_identity');
  assert.deepEqual(stored.roland, {
    replyTo: 'frontdesk@roland.example.test',
    practiceName: 'Roland Example Dental',
    practicePhone: '(918) 555-0142',
  });
  assert.deepEqual(cp.officeValues('tc_email_identity'), {
    roland: stored.roland,
    valley: { practiceName: 'Valley Example' },
  });
});

test('F: PUT /api/tc/email-identity — a failure of either write, or a bad read-back, rolls BOTH back', async (t) => {
  t.mock.method(console, 'error', () => {});
  const cp = new FakeControlPlane();
  const { baseUrl, db } = await bootIdentity(t, cp);
  assert.equal((await api(baseUrl, 'PUT', '/api/tc/email-identity?office=roland', IDENTITY)).status, 200);
  const before = { platform: cp.platformValue('tc_email_identity'), office: cp.officeValues('tc_email_identity') };
  const historyBefore = db.table('tc_email_identity_changes').length;

  for (const force of ['officeUpsert', 'platformUpsert', 'officeReadbackTamper']) {
    if (force === 'officeReadbackTamper') {
      cp.fail.officeReadbackTamper = (rows) => rows.map((x) => ({ ...x, value: {} }));
    } else {
      cp.fail[force] = true;
    }
    const r = await api(baseUrl, 'PUT', '/api/tc/email-identity?office=roland', { ...IDENTITY, practiceName: 'Changed Example' });
    assert.equal(r.status, 500, `${force}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(cp.platformValue('tc_email_identity'), before.platform, `${force}: platform_setting rolled back`);
    assert.deepEqual(cp.officeValues('tc_email_identity'), before.office, `${force}: office_setting rolled back`);
    assert.equal(db.table('tc_email_identity_changes').length, historyBefore, `${force}: no history row`);
    cp.fail = { platformUpsert: false, officeUpsert: false, officeReadbackTamper: null, listOfficeSettings: false };
  }
});

test('the three global keys keep the single upsert: no transaction, no office_setting statement', async (t) => {
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

test("an environment with no office rows still writes platform_setting, warns once, and writes no office_setting", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const cp = new FakeControlPlane({ offices: [] });
  registry.setPoolForTests(cp.pool());
  t.after(() => registry.setPoolForTests(null));
  await registry.setPlatformSetting('tc_referrals_enabled', { roland: true }, null, { officeKey: 'roland' });
  await registry.setPlatformSetting('tc_referrals_enabled', { roland: false }, null, { officeKey: 'roland' });
  assert.deepEqual(cp.platformValue('tc_referrals_enabled'), { roland: false });
  assert.deepEqual(cp.officeValues('tc_referrals_enabled'), {});
  assert.equal(warn.mock.calls.filter((c) => String(c.arguments[0]).includes('office_setting not written')).length, 1);
});
