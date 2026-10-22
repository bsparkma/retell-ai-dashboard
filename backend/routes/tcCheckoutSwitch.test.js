'use strict';

/**
 * The checkout switch, end to end (queue item 50): the platform console writes
 * `tc_checkout_enabled`, and the Checkout inbox obeys it on the very next
 * request — no restart, no sleep, no cache reset between the steps.
 *
 * Both mounts over ONE express app, as server.js assembles them, against an
 * in-memory control plane. Mirrors routes/hygPilotSwitch.test.js.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const userContext = require('../platform/userContext');
const tcCheckout = require('../config/tcCheckout');
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

const SWITCH = '/api/platform/tc-checkout-offices';
const SUMMARY = '/api/tc/checkout/summary?office=roland';
const LIST = '/api/tc/checkout?office=roland';

async function boot(t, { superAdmin = true } = {}) {
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
    env: {
      TC_CHECKOUT_ENABLED_ROLAND: process.env.TC_CHECKOUT_ENABLED_ROLAND,
      TC_CHECKOUT_ENABLED_VALLEY: process.env.TC_CHECKOUT_ENABLED_VALLEY,
    },
  };
  delete process.env.TC_CHECKOUT_ENABLED_ROLAND;
  delete process.env.TC_CHECKOUT_ENABLED_VALLEY;
  tcCheckout.resetCacheForTests();

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
    const row = { key, value, updated_at: new Date('2026-10-14T12:00:00Z'), updated_by: updatedBy };
    store.set(key, row);
    return row;
  };
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
  app.use('/api/platform', requireSuperAdmin(), require('./platform'));
  app.use('/api/tc', requireModule('tc'), require('./tc'));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(
    () =>
      new Promise((r) => {
        for (const k of REGISTRY_KEYS) registry[k] = originals.registry[k];
        tenantDb.withTenantDb = originals.withTenantDb;
        for (const [k, v] of Object.entries(originals.env)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        tcCheckout.resetCacheForTests();
        server.close(r);
      })
  );
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, db, store };
}

test('ON then OFF from the console: the very next Checkout request obeys, with no restart', async (t) => {
  const { baseUrl, db, store } = await boot(t);

  // Nobody has chosen: the floor answers.
  let s = await api(baseUrl, 'GET', SUMMARY);
  assert.equal(s.body.enabled, false);
  const first = await api(baseUrl, 'GET', SWITCH);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.offices.map((o) => [o.office, o.enabled, o.source]), [
    ['roland', false, 'default'],
    ['valley', false, 'default'],
  ]);

  const on = await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.offices.find((o) => o.office === 'roland').enabled, true);
  assert.deepEqual(store.get('tc_checkout_enabled').value, { roland: true });
  s = await api(baseUrl, 'GET', SUMMARY);
  assert.equal(s.body.enabled, true, 'on, immediately');
  assert.equal((await api(baseUrl, 'GET', LIST)).status, 200);

  const off = await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: false });
  assert.equal(off.status, 200);
  assert.equal((await api(baseUrl, 'GET', LIST)).status, 403, 'off, on the very next request');

  const audits = auditRows(db).filter((a) => a.resource_type === 'platform_setting');
  assert.deepEqual(audits.map((a) => [a.resource_id, a.office, a.prior_state]), [
    ['tc_checkout_enabled', 'roland', 'off'],
    ['tc_checkout_enabled', 'roland', 'on'],
  ]);
});

test('the env break-glass =false wins over a console ON, and the panel says so', async (t) => {
  const { baseUrl } = await boot(t);
  process.env.TC_CHECKOUT_ENABLED_ROLAND = 'false';
  const on = await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: true });
  assert.equal(on.status, 200);
  const roland = on.body.offices.find((o) => o.office === 'roland');
  assert.equal(roland.enabled, false);
  assert.equal(roland.source, 'env');
  assert.equal((await api(baseUrl, 'GET', LIST)).status, 403);
});

test('only a super_admin can flip it; a bad body or office is refused', async (t) => {
  const { baseUrl } = await boot(t, { superAdmin: false });
  assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: true })).status, 403);
});

test('a bad body or an unknown office is refused, and nothing is stored', async (t) => {
  const { baseUrl, store } = await boot(t);
  assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: 'yes' })).status, 400);
  assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/nowhere`, { enabled: true })).status, 404);
  // `unknown` is officeAgents' system bucket for unattributable calls, never a
  // location a feature can be switched on for.
  assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/unknown`, { enabled: true })).status, 404);
  assert.equal(store.size, 0);
});
