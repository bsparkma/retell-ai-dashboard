'use strict';

/**
 * The referral PATIENT email switch's console routes (R5b): the platform
 * console writes `tc_referral_patient_email_enabled` per office, default OFF,
 * env=false supreme, super_admin only, audited — and it touches neither the
 * referral email switch nor the referrals switch. Mirrors
 * routes/tcReferralEmailSwitch.test.js. That the send obeys it (off = a named
 * skip; the specialist letter, tokens and buttons unaffected) is pinned end
 * to end in routes/tc/tcReferralLinks.test.js (P).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const userContext = require('../platform/userContext');
const tcReferralPatientEmail = require('../config/tcReferralPatientEmail');
const { tenantContext } = require('../middleware/tenantContext');
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

const SWITCH = '/api/platform/tc-referral-patient-email-offices';
const ENV_KEYS = ['TC_REFERRAL_PATIENT_EMAIL_ENABLED_ROLAND', 'TC_REFERRAL_PATIENT_EMAIL_ENABLED_VALLEY'];

async function boot(t, { superAdmin = true } = {}) {
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
    env: Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])),
  };
  for (const k of ENV_KEYS) delete process.env[k];
  tcReferralPatientEmail.resetCacheForTests();

  // Referral email (the letter) is ON for roland; the patient switch is not chosen.
  const store = new Map([
    ['tc_referral_email_enabled', { key: 'tc_referral_email_enabled', value: { roland: true }, updated_at: new Date(), updated_by: null }],
  ]);
  registry.getUserByEmail = async () => ({ user_id: 'U1', tenant_id: 'T1', email: 'boss@carein.ai', role: 'admin', status: 'active' });
  registry.getTenantById = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN', status: 'active' });
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => ['tc'];
  registry.getPlatformAdminByEmail = async () =>
    superAdmin ? { email: 'boss@carein.ai', status: 'active', created_at: new Date() } : null;
  registry.touchUserLogin = async () => {};
  registry.getPlatformSetting = async (key) => store.get(key) || null;
  registry.setPlatformSetting = async (key, value, updatedBy) => {
    const row = { key, value, updated_at: new Date('2026-10-22T12:00:00Z'), updated_by: updatedBy };
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
        tcReferralPatientEmail.resetCacheForTests();
        server.close(r);
      })
  );
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, db, store };
}

test('default OFF for every office; ON then OFF from the console is stored, read back and audited', async (t) => {
  const { baseUrl, db, store } = await boot(t);
  const first = await api(baseUrl, 'GET', SWITCH);
  assert.equal(first.status, 200);
  assert.equal(first.body.settingKey, 'tc_referral_patient_email_enabled');
  assert.deepEqual(first.body.offices.map((o) => [o.office, o.enabled, o.source]), [
    ['roland', false, 'default'],
    ['valley', false, 'default'],
  ]);
  assert.equal(await tcReferralPatientEmail.isEnabled('roland'), false);

  const on = await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(store.get('tc_referral_patient_email_enabled').value, { roland: true });
  assert.deepEqual(store.get('tc_referral_email_enabled').value, { roland: true }, 'the letter switch is untouched');
  assert.equal(store.has('tc_referrals_enabled'), false, 'the referrals switch is untouched');
  assert.equal(await tcReferralPatientEmail.isEnabled('roland'), true);
  assert.equal(await tcReferralPatientEmail.isEnabled('valley'), false);

  const off = await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(await tcReferralPatientEmail.isEnabled('roland'), false);
  assert.deepEqual(
    auditRows(db).filter((a) => a.resource_type === 'platform_setting').map((a) => [a.resource_id, a.office, a.prior_state]),
    [
      ['tc_referral_patient_email_enabled', 'roland', 'off'],
      ['tc_referral_patient_email_enabled', 'roland', 'on'],
    ]
  );
});

test('the env break-glass =false wins over a console ON', async (t) => {
  const { baseUrl } = await boot(t);
  process.env.TC_REFERRAL_PATIENT_EMAIL_ENABLED_ROLAND = 'false';
  const on = await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: true });
  const roland = on.body.offices.find((o) => o.office === 'roland');
  assert.deepEqual([roland.enabled, roland.source], [false, 'env']);
  assert.equal(await tcReferralPatientEmail.isEnabled('roland'), false);
});

test('only a super_admin can flip it; a bad body or office is refused and nothing is stored', async (t) => {
  const denied = await boot(t, { superAdmin: false });
  assert.equal((await api(denied.baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: true })).status, 403);
  assert.equal(denied.store.has('tc_referral_patient_email_enabled'), false);
});

test('a bad body or an unknown office is refused', async (t) => {
  const { baseUrl, store } = await boot(t);
  assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/roland`, { enabled: 'yes' })).status, 400);
  assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/nowhere`, { enabled: true })).status, 404);
  assert.equal((await api(baseUrl, 'PUT', `${SWITCH}/unknown`, { enabled: true })).status, 404);
  assert.equal(store.has('tc_referral_patient_email_enabled'), false);
});
