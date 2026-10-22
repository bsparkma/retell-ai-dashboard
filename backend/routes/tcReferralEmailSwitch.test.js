'use strict';

/**
 * The referral EMAIL switch, end to end (R5): the platform console writes
 * `tc_referral_email_enabled`, and the send route obeys it on the very next
 * request — no restart. Independent of `tc_referrals_enabled`. Both mounts
 * over ONE express app against an in-memory control plane; mirrors
 * routes/tcReferralsSwitch.test.js. Nothing here can send: the referral the
 * route is asked about does not exist, so a request that passes the switch
 * stops at "not found".
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const express = require('express');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const userContext = require('../platform/userContext');
const tcReferrals = require('../config/tcReferrals');
const tcReferralEmail = require('../config/tcReferralEmail');
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

const SWITCH = '/api/platform/tc-referral-email-offices';
const STATUS = '/api/tc/referrals/status?office=roland';
const SEND = () => `/api/tc/referrals/${randomUUID()}/send-email?office=roland`;
const ENV_KEYS = [
  'TC_REFERRAL_EMAIL_ENABLED_ROLAND',
  'TC_REFERRAL_EMAIL_ENABLED_VALLEY',
  'TC_REFERRALS_ENABLED_ROLAND',
  'TC_REFERRALS_ENABLED_VALLEY',
];

async function boot(t, { superAdmin = true } = {}) {
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
    env: Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])),
  };
  for (const k of ENV_KEYS) delete process.env[k];
  tcReferrals.resetCacheForTests();
  tcReferralEmail.resetCacheForTests();

  // Referrals itself is ON for roland in the control plane; email is not chosen.
  const store = new Map([['tc_referrals_enabled', { key: 'tc_referrals_enabled', value: { roland: true }, updated_at: new Date(), updated_by: null }]]);
  registry.getUserByEmail = async () => ({ user_id: 'U1', tenant_id: 'T1', email: 'boss@carein.ai', role: 'admin', status: 'active' });
  registry.getTenantById = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN', status: 'active' });
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => ['tc'];
  registry.getPlatformAdminByEmail = async () =>
    superAdmin ? { email: 'boss@carein.ai', status: 'active', created_at: new Date() } : null;
  registry.touchUserLogin = async () => {};
  registry.getPlatformSetting = async (key) => store.get(key) || null;
  registry.setPlatformSetting = async (key, value, updatedBy) => {
    const row = { key, value, updated_at: new Date('2026-10-21T12:00:00Z'), updated_by: updatedBy };
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
        tcReferrals.resetCacheForTests();
        tcReferralEmail.resetCacheForTests();
        server.close(r);
      })
  );
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, db, store };
}

test('ON then OFF from the console: the very next send request obeys, with no restart', async (t) => {
  const { baseUrl, db, store } = await boot(t);

  const first = await api(baseUrl, 'GET', SWITCH);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.offices.map((o) => [o.office, o.enabled, o.source]), [
    ['roland', false, 'default'],
    ['valley', false, 'default'],
  ]);
  assert.equal((await api(baseUrl, 'POST', SEND(), {})).body.code, 'REFERRAL_EMAIL_DISABLED');
  assert.equal((await api(baseUrl, 'GET', STATUS)).body.emailSend.enabled, false);

  const on = await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(store.get('tc_referral_email_enabled').value, { roland: true });
  assert.deepEqual(store.get('tc_referrals_enabled').value, { roland: true }, 'the referrals switch is untouched');
  const passed = await api(baseUrl, 'POST', SEND(), {});
  assert.equal(passed.status, 404, 'past the switch: the (made-up) referral is simply not found');
  assert.equal((await api(baseUrl, 'GET', STATUS)).body.emailSend.enabled, true);

  const off = await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: false });
  assert.equal(off.status, 200);
  assert.equal((await api(baseUrl, 'POST', SEND(), {})).body.code, 'REFERRAL_EMAIL_DISABLED', 'off, on the very next request');

  const audits = auditRows(db).filter((a) => a.resource_type === 'platform_setting');
  assert.deepEqual(audits.map((a) => [a.resource_id, a.office, a.prior_state]), [
    ['tc_referral_email_enabled', 'roland', 'off'],
    ['tc_referral_email_enabled', 'roland', 'on'],
  ]);
});

test('the env break-glass =false wins over a console ON', async (t) => {
  const { baseUrl } = await boot(t);
  process.env.TC_REFERRAL_EMAIL_ENABLED_ROLAND = 'false';
  const on = await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: true });
  const roland = on.body.offices.find((o) => o.office === 'roland');
  assert.deepEqual([roland.enabled, roland.source], [false, 'env']);
  assert.equal((await api(baseUrl, 'POST', SEND(), {})).body.code, 'REFERRAL_EMAIL_DISABLED');
});

test('email ON does not turn referrals on: referrals OFF still refuses first', async (t) => {
  const { baseUrl, store } = await boot(t);
  await api(baseUrl, 'PUT', `${SWITCH}/valley`, { enabled: true });
  assert.deepEqual(store.get('tc_referral_email_enabled').value, { valley: true });
  const r = await api(baseUrl, 'POST', `/api/tc/referrals/${randomUUID()}/send-email?office=valley`, {});
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'REFERRALS_DISABLED');
});

test('only a super_admin can flip it; a bad body or office is refused and nothing is stored', async (t) => {
  const denied = await boot(t, { superAdmin: false });
  assert.equal((await api(denied.baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: true })).status, 403);
});

test('a bad body or an unknown office is refused', async (t) => {
  const { baseUrl, store } = await boot(t);
  assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: 'yes' })).status, 400);
  assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/nowhere`, { enabled: true })).status, 404);
  assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/unknown`, { enabled: true })).status, 404);
  assert.equal(store.has('tc_referral_email_enabled'), false);
});
