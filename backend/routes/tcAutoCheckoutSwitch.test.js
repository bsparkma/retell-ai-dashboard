'use strict';

/**
 * CO-5b's per-office switch on the Platform console:
 * GET/PUT /api/platform/tc-auto-checkout-offices — the tc_checkout_enabled
 * shape exactly. Default OFF (no row), written and read back, audited with the
 * prior state, env =false supreme, super_admin only, the next schedule check
 * obeys with no restart.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const userContext = require('../platform/userContext');
const tcCheckout = require('../config/tcCheckout');
const tcAutoCheckout = require('../config/tcAutoCheckout');
const autoCheckout = require('../services/tc/autoCheckout');
const { tenantContext, requireModule } = require('../middleware/tenantContext');
const { requireSuperAdmin } = require('../config/permissions');
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
const ENV = ['TC_AUTO_CHECKOUT_ENABLED_ROLAND', 'TC_AUTO_CHECKOUT_ENABLED_VALLEY', 'TC_CHECKOUT_ENABLED_ROLAND'];
const SWITCH = '/api/platform/tc-auto-checkout-offices';
const CHECK = '/api/tc/checkout/schedule-check?office=roland';

async function boot(t, { superAdmin = true } = {}) {
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
    env: Object.fromEntries(ENV.map((k) => [k, process.env[k]])),
  };
  for (const k of ENV) delete process.env[k];
  // Checkout itself on for roland through its env fallback; this file is about the OTHER switch.
  process.env.TC_CHECKOUT_ENABLED_ROLAND = 'true';
  tcCheckout.resetCacheForTests();
  tcAutoCheckout.resetCacheForTests();
  autoCheckout.resetForTests();

  const store = new Map();
  registry.getUserByEmail = async () => ({ user_id: 'U1', tenant_id: 'T1', email: 'boss@carein.ai', role: 'admin', status: 'active' });
  registry.getTenantById = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN', status: 'active' });
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => ['tc'];
  registry.getPlatformAdminByEmail = async () =>
    superAdmin ? { email: 'boss@carein.ai', status: 'active', created_at: new Date() } : null;
  registry.touchUserLogin = async () => {};
  registry.getPlatformSetting = async (key) => store.get(key) || null;
  registry.setPlatformSetting = async (key, value, updatedBy) => {
    const row = { key, value, updated_at: new Date('2026-10-30T12:00:00Z'), updated_by: updatedBy };
    store.set(key, row);
    return row;
  };
  userContext.clearCache();
  const db = new FakeTenantDb();
  tenantDb.withTenantDb = async (_req, fn) => fn(db);

  // Every sweep the switch lets through is refused at Open Dental: this file
  // only asks WHETHER one ran.
  const sweeps = [];
  const realSweep = autoCheckout.sweepOffice;
  autoCheckout.sweepOffice = async (opts) => {
    sweeps.push(opts.office);
    return { status: 'ok', summary: { completedNonHygiene: 0, created: 0, alreadyCarded: 0, skippedHygiene: 0, skippedNoPatient: 0, deferred: 0, partial: false } };
  };

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { email: 'boss@carein.ai', name: 'Boss', tenantId: 'T1' };
    next();
  });
  app.use('/api', tenantContext());
  app.use('/api/platform', requireSuperAdmin(), require('./platform'));
  app.use('/api/tc', requireModule('tc'), require('./tc'));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(
    () =>
      new Promise((r) => {
        autoCheckout.sweepOffice = realSweep;
        for (const k of REGISTRY_KEYS) registry[k] = originals.registry[k];
        tenantDb.withTenantDb = originals.withTenantDb;
        for (const [k, v] of Object.entries(originals.env)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        tcCheckout.resetCacheForTests();
        tcAutoCheckout.resetCacheForTests();
        autoCheckout.resetForTests();
        server.close(r);
      })
  );
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, db, store, sweeps };
}

test('default OFF; ON then OFF from the console: the next schedule check obeys, audited with the prior state', async (t) => {
  const { baseUrl, db, store, sweeps } = await boot(t);

  const first = await api(baseUrl, 'GET', SWITCH);
  assert.equal(first.status, 200);
  assert.equal(first.body.settingKey, 'tc_auto_checkout_enabled');
  assert.deepEqual(first.body.offices.map((o) => [o.office, o.enabled, o.source]), [
    ['roland', false, 'default'],
    ['valley', false, 'default'],
  ]);
  let c = await api(baseUrl, 'GET', CHECK);
  assert.equal(c.body.status, 'off');
  await autoCheckout.waitForSweepsForTests();
  assert.deepEqual(sweeps, []);

  const on = await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(store.get('tc_auto_checkout_enabled').value, { roland: true });
  c = await api(baseUrl, 'GET', CHECK);
  await autoCheckout.waitForSweepsForTests();
  assert.notEqual(c.body.status, 'off');
  assert.deepEqual(sweeps, ['roland'], 'on, immediately');

  const off = await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: false });
  assert.equal(off.status, 200);
  autoCheckout.resetForTests();
  c = await api(baseUrl, 'GET', CHECK);
  await autoCheckout.waitForSweepsForTests();
  assert.equal(c.body.status, 'off');
  assert.deepEqual(sweeps, ['roland'], 'off, on the very next request');

  const audits = auditRows(db).filter((a) => a.resource_type === 'platform_setting');
  assert.deepEqual(audits.map((a) => [a.resource_id, a.office, a.prior_state]), [
    ['tc_auto_checkout_enabled', 'roland', 'off'],
    ['tc_auto_checkout_enabled', 'roland', 'on'],
  ]);
});

test('the env break-glass =false wins over a console ON', async (t) => {
  const { baseUrl, sweeps } = await boot(t);
  process.env.TC_AUTO_CHECKOUT_ENABLED_ROLAND = 'false';
  const on = await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: true });
  assert.equal(on.status, 200);
  const roland = on.body.offices.find((o) => o.office === 'roland');
  assert.deepEqual([roland.enabled, roland.source], [false, 'env']);
  const c = await api(baseUrl, 'GET', CHECK);
  await autoCheckout.waitForSweepsForTests();
  assert.equal(c.body.status, 'off');
  assert.deepEqual(sweeps, []);
});

test('only a super_admin can flip it; a bad body or office is refused and nothing is stored', async (t) => {
  {
    const { baseUrl } = await boot(t, { superAdmin: false });
    assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: true })).status, 403);
  }
  const { baseUrl, store } = await boot(t);
  assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: 'yes' })).status, 400);
  assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/unknown`, { enabled: true })).status, 404);
  assert.equal(store.size, 0);
});
