'use strict';

/**
 * MT-2c — the practice's own door to its per-office settings:
 * /api/admin/office-settings, behind admin.all (ruling A).
 *
 * Mounted the way server.js mounts it: tenantContext on /api, then
 * /api/admin/office-settings under requirePermission('admin.all'), then the
 * Developer Console at /api/platform under requireSuperAdmin(). The control
 * plane is the in-memory stub every switch test uses; the tenant database is a
 * FakeTenantDb, so the audit rows can be read back.
 *
 * Pinned here:
 *   - a practice admin (NOT a super_admin) can write their own office's key,
 *     for every one of the seven switches, with one audit row per write
 *   - an admin of ANOTHER practice cannot write this practice's office: 404,
 *     the same body as an office that does not exist at all (no oracle), and
 *     nothing is written
 *   - a non-admin role is refused (403), reads and writes alike
 *   - each switch is guarded by its module
 *   - the read-only nurture / opportunities view, and that it has no write
 *   - the global keys are not served here, and the Developer Console door
 *     stays closed to a practice admin
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');

const registry = require('../platform/registry');
const { mirrorPlatformStubIntoOfficeSettings } = require('../platform/officeSettingsTestUtils');
const tenantDb = require('../platform/tenantDb');
const userContext = require('../platform/userContext');
const officeSettings = require('../platform/officeSettings');
const { tenantContext } = require('../middleware/tenantContext');
const { requirePermission, requireSuperAdmin } = require('../config/permissions');
const { FakeTenantDb, api, auditRows } = require('./tc/tcTestUtils');

const REGISTRY_KEYS = [
  'getUserByEmail',
  'getTenantById',
  'getTenantClinics',
  'getEnabledModules',
  'getPlatformAdminByEmail',
  'touchUserLogin',
  'getPlatformSetting',
  'setPlatformSetting',
];

const BASE = '/api/admin/office-settings';

/** Every switch the /admin door serves: path segment -> its setting key and module. */
const SWITCHES = [
  { path: 'tc-checkout-offices', key: 'tc_checkout_enabled', module: 'tc' },
  { path: 'tc-od-sync-offices', key: 'tc_od_sync_enabled', module: 'tc' },
  { path: 'tc-auto-checkout-offices', key: 'tc_auto_checkout_enabled', module: 'tc' },
  { path: 'tc-referrals-offices', key: 'tc_referrals_enabled', module: 'tc' },
  { path: 'tc-referral-email-offices', key: 'tc_referral_email_enabled', module: 'tc' },
  { path: 'tc-referral-patient-email-offices', key: 'tc_referral_patient_email_enabled', module: 'tc' },
  { path: 'hyg-offices', key: 'hyg_od_enabled', module: 'hyg' },
];

/** The env break-glass vars these switches read — cleared so the stored row answers. */
const ENV_VARS = [
  'TC_CHECKOUT_ENABLED',
  'TC_OD_SYNC_ENABLED',
  'TC_AUTO_CHECKOUT_ENABLED',
  'TC_REFERRALS_ENABLED',
  'TC_REFERRAL_EMAIL_ENABLED',
  'TC_REFERRAL_PATIENT_EMAIL_ENABLED',
  'HYG_OD_ENABLED',
].flatMap((p) => [`${p}_ROLAND`, `${p}_VALLEY`]);

/**
 * Two practices: T1 is 'carein' (roland, valley), T2 is another practice with
 * no offices of carein's. The signed-in user belongs to `tenantId`.
 */
const TENANTS = {
  T1: { tenant_id: 'T1', slug: 'carein', display_name: 'CareIN', status: 'active' },
  T2: { tenant_id: 'T2', slug: 'lakeside', display_name: 'Lakeside Dental', status: 'active' },
};

async function boot(t, { role = 'admin', tenantId = 'T1', modules = ['tc', 'hyg'], superAdmin = false, seed = {} } = {}) {
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
    env: Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]])),
  };
  for (const k of ENV_VARS) delete process.env[k];
  officeSettings.resetCacheForTests();

  const store = new Map(Object.entries(seed).map(([key, value]) => [key, { key, value, updated_at: new Date(), updated_by: 'runbook' }]));
  /** @type {string[]} every key a write reached the control plane for */
  const writes = [];
  registry.getUserByEmail = async (email) => ({ user_id: 'U1', tenant_id: tenantId, email, role, status: 'active' });
  registry.getTenantById = async (id) => TENANTS[/** @type {'T1'|'T2'} */ (id)] || null;
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => modules;
  registry.getPlatformAdminByEmail = async (email) =>
    superAdmin ? { email, status: 'active', created_at: new Date() } : null;
  registry.touchUserLogin = async () => {};
  registry.getPlatformSetting = async (key) => store.get(key) || null;
  registry.setPlatformSetting = async (key, value, updatedBy) => {
    writes.push(key);
    const row = { key, value, updated_at: new Date('2026-11-18T12:00:00Z'), updated_by: updatedBy };
    store.set(key, row);
    return row;
  };
  userContext.clearCache();
  const restoreMirror = mirrorPlatformStubIntoOfficeSettings(registry);
  const db = new FakeTenantDb();
  tenantDb.withTenantDb = async (_req, fn) => fn(db);

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { email: 'manager@example.test', name: 'Manager', tenantId: 'entra-tid' };
    next();
  });
  app.use('/api', tenantContext());
  app.use(BASE, requirePermission('admin.all'), require('./adminOfficeSettings'));
  app.use('/api/platform', requireSuperAdmin(), require('./platform'));
  // Anything the /admin door does not serve falls through to here, as it
  // falls through to the next /api/admin mount in server.js.
  app.use((_req, res) => res.status(404).json({ success: false, error: 'Not found', code: 'NOT_FOUND' }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(
    () =>
      new Promise((r) => {
        for (const k of REGISTRY_KEYS) registry[k] = originals.registry[k];
        restoreMirror();
        tenantDb.withTenantDb = originals.withTenantDb;
        for (const [k, v] of Object.entries(originals.env)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        officeSettings.resetCacheForTests();
        userContext.clearCache();
        server.close(r);
      })
  );
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, db, store, writes };
}

/** The served state of one office, whichever of the two payload shapes the switch answers with. */
function officeEnabled(body, office) {
  const row = body.offices.find((o) => (o.office || o.officeKey) === office);
  return row ? row.enabled : undefined;
}

test('a practice admin (not a super_admin) writes their own office, for every switch, with one audit row each', async (t) => {
  const { baseUrl, db, store } = await boot(t);

  for (const s of SWITCHES) {
    const before = await api(baseUrl, 'GET', `${BASE}/${s.path}`);
    assert.equal(before.status, 200, `${s.path}: ${JSON.stringify(before.body)}`);
    assert.equal(officeEnabled(before.body, 'roland'), false, s.path);

    const on = await api(baseUrl, 'PUT', `${BASE}/${s.path}/roland`, { enabled: true });
    assert.equal(on.status, 200, `${s.path}: ${JSON.stringify(on.body)}`);
    // The answer is the READ-BACK, not the echo of the request.
    assert.equal(officeEnabled(on.body, 'roland'), true, s.path);
    assert.equal(officeEnabled(on.body, 'valley'), false, s.path);
    assert.deepEqual(store.get(s.key).value, { roland: true }, s.path);
  }

  const audits = auditRows(db).filter((a) => a.resource_type === 'platform_setting');
  assert.deepEqual(
    audits.map((a) => [a.resource_id, a.office, a.prior_state, a.user_id, a.tenant_id, a.result]),
    SWITCHES.map((s) => [s.key, 'roland', 'off', 'manager@example.test', 'T1', 'SUCCESS'])
  );
});

test("an admin of ANOTHER practice cannot write this practice's office: 404, no oracle, nothing written", async (t) => {
  const { baseUrl, db, store, writes } = await boot(t, { tenantId: 'T2' });

  for (const s of SWITCHES) {
    // Their GET lists THEIR offices — none of carein's.
    const list = await api(baseUrl, 'GET', `${BASE}/${s.path}`);
    assert.equal(list.status, 200, s.path);
    assert.deepEqual(list.body.offices, [], s.path);

    const foreign = await api(baseUrl, 'PUT', `${BASE}/${s.path}/roland`, { enabled: true });
    const missing = await api(baseUrl, 'PUT', `${BASE}/${s.path}/no-such-office`, { enabled: true });
    assert.equal(foreign.status, 404, s.path);
    assert.equal(foreign.body.code, 'INVALID_OFFICE', s.path);
    // Oracle-free: carein's real office and an office that exists nowhere get
    // byte-for-byte the same refusal.
    assert.deepEqual(foreign.body, missing.body, s.path);
    assert.equal(foreign.status, missing.status, s.path);
  }

  assert.deepEqual(writes, []);
  assert.equal(store.size, 0);
  assert.deepEqual(auditRows(db).filter((a) => a.resource_type === 'platform_setting'), []);
});

test('the tenant is the session\'s: a tenant named in the query or body changes nothing', async (t) => {
  const { baseUrl, writes } = await boot(t, { tenantId: 'T2' });
  const res = await api(baseUrl, 'PUT', `${BASE}/tc-checkout-offices/roland?tenant=carein&tenantId=T1`, {
    enabled: true,
    tenant: 'carein',
    tenantId: 'T1',
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'INVALID_OFFICE');
  assert.deepEqual(writes, []);
});

for (const role of ['office', 'tc', 'hygiene', 'reviewer', 'doctor', 'rcm_biller']) {
  test(`a non-admin role (${role}) is refused, reads and writes alike`, async (t) => {
    const { baseUrl, writes } = await boot(t, { role });
    for (const s of SWITCHES) {
      const get = await api(baseUrl, 'GET', `${BASE}/${s.path}`);
      const put = await api(baseUrl, 'PUT', `${BASE}/${s.path}/roland`, { enabled: true });
      assert.equal(get.status, 403, `${role} GET ${s.path}`);
      assert.equal(put.status, 403, `${role} PUT ${s.path}`);
    }
    const runbook = await api(baseUrl, 'GET', `${BASE}/runbook-switches`);
    assert.equal(runbook.status, 403);
    assert.deepEqual(writes, []);
  });
}

test('each switch is guarded by its module', async (t) => {
  const { baseUrl, writes } = await boot(t, { modules: ['voice'] });
  for (const s of SWITCHES) {
    const put = await api(baseUrl, 'PUT', `${BASE}/${s.path}/roland`, { enabled: true });
    assert.equal(put.status, 403, s.path);
    assert.equal(put.body.error, 'MODULE_NOT_ENTITLED', s.path);
    assert.equal(put.body.module, s.module, s.path);
  }
  assert.deepEqual(writes, []);
});

test('tc without hyg: the TC switches answer, the hygiene switch does not', async (t) => {
  const { baseUrl } = await boot(t, { modules: ['tc'] });
  assert.equal((await api(baseUrl, 'GET', `${BASE}/tc-checkout-offices`)).status, 200);
  const hyg = await api(baseUrl, 'GET', `${BASE}/hyg-offices`);
  assert.equal(hyg.status, 403);
  assert.equal(hyg.body.module, 'hyg');
});

test('the nurture and opportunities switches are visible, read-only, and have no write', async (t) => {
  const { baseUrl, writes } = await boot(t, {
    seed: { tc_nurture_enabled: { roland: true }, tc_opportunities_sync: { valley: true, roland: 'true' } },
  });
  const res = await api(baseUrl, 'GET', `${BASE}/runbook-switches`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.offices, ['roland', 'valley']);
  assert.equal(res.body.policyKnown, true);
  assert.deepEqual(
    res.body.switches.map((s) => [s.settingKey, s.office, s.enabled]),
    [
      ['tc_nurture_enabled', 'roland', true],
      ['tc_nurture_enabled', 'valley', false],
      // Only a literal true is ON; the string 'true' is not.
      ['tc_opportunities_sync', 'roland', false],
      ['tc_opportunities_sync', 'valley', true],
    ]
  );

  for (const method of ['PUT', 'POST', 'PATCH']) {
    const w = await api(baseUrl, method, `${BASE}/runbook-switches`, { office: 'roland', enabled: false });
    assert.equal(w.status, 404, method);
  }
  assert.deepEqual(writes, []);
});

test('the global keys are not on the practice door, and the Developer Console stays closed to a practice admin', async (t) => {
  const { baseUrl, writes } = await boot(t);

  for (const p of ['retention', 'retention/impact?days=30', 'tc-email-enabled', 'tc-sms-enabled', 'call-retention-days']) {
    const get = await api(baseUrl, 'GET', `${BASE}/${p}`);
    assert.equal(get.status, 404, `GET ${p}`);
  }
  const put = await api(baseUrl, 'PUT', `${BASE}/retention`, { days: 60 });
  assert.equal(put.status, 404);

  // The Developer Console's own door, including the global retention key and
  // the very switches the practice door serves: super_admin only.
  for (const p of ['/api/platform/retention', '/api/platform/tc-checkout-offices', '/api/platform/hyg-offices']) {
    assert.equal((await api(baseUrl, 'GET', p)).status, 403, p);
  }
  assert.equal((await api(baseUrl, 'PUT', '/api/platform/retention', { days: 60 })).status, 403);
  assert.equal((await api(baseUrl, 'PUT', '/api/platform/tc-checkout-offices/roland', { enabled: true })).status, 403);

  assert.deepEqual(writes, []);
});

test('the Developer Console door still serves a super_admin, unchanged, through the same handlers', async (t) => {
  const { baseUrl, store } = await boot(t, { superAdmin: true });
  const on = await api(baseUrl, 'PUT', '/api/platform/tc-checkout-offices/valley', { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(store.get('tc_checkout_enabled').value, { valley: true });
  // ...and what one door wrote, the other reads.
  const viaAdmin = await api(baseUrl, 'GET', `${BASE}/tc-checkout-offices`);
  assert.equal(officeEnabled(viaAdmin.body, 'valley'), true);
});

test('validation is the Developer Console\'s: a non-boolean is a 400 and writes nothing', async (t) => {
  const { baseUrl, writes } = await boot(t);
  for (const s of SWITCHES) {
    const bad = await api(baseUrl, 'PUT', `${BASE}/${s.path}/roland`, { enabled: 'yes' });
    assert.equal(bad.status, 400, s.path);
  }
  assert.deepEqual(writes, []);
});
