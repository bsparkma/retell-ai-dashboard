'use strict';

/**
 * MT-2b INVARIANTS for serving the per-office settings from office_setting.
 *
 *   1. A setting for tenant A's office is never read or written for tenant B
 *      (two tenants, each with an office keyed 'main', opposite values).
 *   2. Stuck-off-safe: no row / unreadable / stale / unknown office / unknown
 *      tenant => OFF; the env `=true` fallback answers for 'carein' ONLY.
 *   3. The env `=false` break-glass beats everything, for any tenant.
 *   4. A failed read is NOT served on (officeRegistry.servedOffices' rule).
 *   5. Office keys per tenant (MT-1c): known only with an ACTIVE registry row;
 *      'carein' = roland, valley whether or not the registry is readable.
 *   6. Writes for any tenant but 'carein' are refused, and write nothing.
 *   7. The global kill switches stay global and still stop every tenant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('./registry');
const officeSettings = require('./officeSettings');
const officeRegistry = require('./officeRegistry');
const { FakeControlPlane, TENANT_ID } = require('./officeSettingsTestUtils');
const { OFFICE_SETTING_KEYS } = require('./officeSettingKeys');

const tcCheckout = require('../config/tcCheckout');
const tcReferrals = require('../config/tcReferrals');
const tcOfficeSwitch = require('../config/tcOfficeSwitch');
const hygPilot = require('../config/hygPilot');
const nurture = require('../config/tcNurture');
const opps = require('../config/tcOpportunities');
const emailIdentity = require('../config/emailIdentity');
const acs = require('../config/acsEmail');
const odOffices = require('../config/odOffices');

const ACME_ID = '00000000-0000-4000-8000-0000000000a1';
const BETA_ID = '00000000-0000-4000-8000-0000000000b2';

/** A registry office row, as listTenantOffices returns it. */
function officeRow(officeKey, sortOrder, status = 'active') {
  return {
    office_key: officeKey,
    display_name: officeKey,
    sort_order: sortOrder,
    retell_agent_ids: [],
    mango_dids: [],
    od_customer_key_secret: null,
    od_customer_key_env: null,
    commtype_defnums: {},
    od_enabled: false,
    hyg_od_enabled: false,
    status,
    updated_at: new Date(0),
    updated_by: null,
  };
}

/** @type {FakeControlPlane} */
let fake;
/** @type {Record<string, unknown[]|Error>} */
let registryOffices;
const saved = { listTenantOffices: registry.listTenantOffices, listTenants: registry.listTenants };
const ENV_NAMES = [
  'TC_CHECKOUT_ENABLED_MAIN',
  'TC_CHECKOUT_ENABLED_ROLAND',
  'TC_CHECKOUT_ENABLED_VALLEY',
  'TC_REFERRALS_ENABLED_MAIN',
  'HYG_OD_ENABLED_MAIN',
  'HYG_OD_ENABLED_ROLAND',
  'TC_NURTURE_ENABLED',
  'TC_OPPS_SYNC_DISABLED',
  'ACS_EMAIL_REPLY_TO_MAIN',
  'ACS_EMAIL_REPLY_TO_ROLAND',
  'TC_EMAIL_PRACTICE_NAME_MAIN',
];
const savedEnv = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
const quiet = { warn: console.warn, error: console.error, log: console.log };

function freshWorld() {
  fake = new FakeControlPlane({
    tenants: [
      { tenant_id: TENANT_ID, slug: 'carein' },
      { tenant_id: ACME_ID, slug: 'acme' },
      { tenant_id: BETA_ID, slug: 'beta' },
    ],
    offices: [
      { tenant_id: TENANT_ID, office_key: 'roland' },
      { tenant_id: TENANT_ID, office_key: 'valley' },
      { tenant_id: ACME_ID, office_key: 'main' },
      { tenant_id: BETA_ID, office_key: 'main' },
    ],
  });
  registry.setPoolForTests(fake.pool());
  registryOffices = {
    acme: [officeRow('main', 1)],
    beta: [officeRow('main', 1)],
  };
  registry.listTenantOffices = async (slug) => {
    const v = registryOffices[slug];
    if (v instanceof Error) throw v;
    if (!v) throw new Error(`no registry rows for ${slug}`);
    return v;
  };
  officeSettings.resetCacheForTests();
  officeRegistry.resetCacheForTests();
  for (const n of ENV_NAMES) delete process.env[n];
}

/** Read both tenants' registry rows and office_setting rows. */
async function readAll() {
  for (const slug of ['acme', 'beta']) await officeRegistry.refreshFromDb(slug);
  for (const slug of ['carein', 'acme', 'beta']) assert.equal((await officeSettings.refreshFromDb(slug)).ok, true);
}

test.before(() => {
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
});
test.beforeEach(freshWorld);
test.after(() => {
  Object.assign(console, quiet);
  registry.setPoolForTests(null);
  registry.listTenantOffices = saved.listTenantOffices;
  registry.listTenants = saved.listTenants;
  officeSettings.resetCacheForTests();
  officeRegistry.resetCacheForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ── 1. two-tenant isolation ─────────────────────────────────────────────────

test("two tenants, one office key 'main', opposite values: each tenant reads only its own", async () => {
  fake.seedOffice('main', 'tc_checkout_enabled', true, ACME_ID);
  fake.seedOffice('main', 'tc_checkout_enabled', false, BETA_ID);
  fake.seedOffice('main', 'hyg_od_enabled', false, ACME_ID);
  fake.seedOffice('main', 'hyg_od_enabled', true, BETA_ID);
  fake.seedOffice('main', 'tc_nurture_enabled', true, BETA_ID);
  fake.seedOffice('main', 'tc_opportunities_sync', true, ACME_ID);
  fake.seedOffice('main', 'tc_email_identity', { practiceName: 'Acme Main Test' }, ACME_ID);
  fake.seedOffice('main', 'tc_email_identity', { practiceName: 'Beta Main Test' }, BETA_ID);
  await readAll();

  assert.equal(tcCheckout.enabledFor('acme', 'main'), true);
  assert.equal(tcCheckout.enabledFor('beta', 'main'), false);
  assert.equal(await tcCheckout.isEnabled('acme', 'main'), true);
  assert.equal(await tcCheckout.isEnabled('beta', 'main'), false);
  assert.equal(hygPilot.hygEnabledFor('acme', 'main'), false);
  assert.equal(hygPilot.hygEnabledFor('beta', 'main'), true);
  assert.deepEqual((await nurture.switchedOnOffices(registry, 'acme')).offices, []);
  assert.deepEqual((await nurture.switchedOnOffices(registry, 'beta')).offices, ['main']);
  assert.deepEqual((await opps.switchedOnOffices(registry, 'acme')).offices, ['main']);
  assert.deepEqual((await opps.switchedOnOffices(registry, 'beta')).offices, []);
  assert.equal(emailIdentity.storedValue('acme', 'main', 'practiceName'), 'Acme Main Test');
  assert.equal(emailIdentity.storedValue('beta', 'main', 'practiceName'), 'Beta Main Test');
  assert.equal(acs.practiceNameFor('acme', 'main'), null, "'main' is not an office of the deployment's mail config");

  // carein holds no 'main' office and no row: nothing leaks across.
  assert.equal(tcCheckout.enabledFor('carein', 'main'), false);
  assert.equal(hygPilot.hygEnabledFor('carein', 'main', true), false);
  assert.equal(emailIdentity.storedValue('carein', 'main', 'practiceName'), null);
});

test("a carein row is never served to another tenant, even for a key that tenant also has", async () => {
  registryOffices.acme = [officeRow('roland', 1)];
  fake.offices.push({ tenant_id: ACME_ID, office_key: 'roland' });
  fake.seedOffice('roland', 'tc_referrals_enabled', true, TENANT_ID);
  fake.seedOffice('roland', 'tc_email_identity', { replyTo: 'front@roland.example.test' }, TENANT_ID);
  await readAll();
  assert.equal(tcReferrals.enabledFor('carein', 'roland'), true);
  assert.equal(tcReferrals.enabledFor('acme', 'roland'), false);
  assert.equal(emailIdentity.storedValue('acme', 'roland', 'replyTo'), null);
  assert.equal(emailIdentity.storedValue('carein', 'roland', 'replyTo'), 'front@roland.example.test');
});

test('writes for any tenant but carein are refused and write NOTHING to either table', async () => {
  await readAll();
  const before = { platform: [...fake.platform.keys()], office: fake.officeSetting.size };
  await assert.rejects(tcCheckout.persist('acme', 'main', true, 'qa@example.test'), { code: 'OFFICE_SETTING_TENANT_NOT_WRITABLE' });
  await assert.rejects(hygPilot.persistHygEnabled('acme', 'main', true, 'qa@example.test'), {
    code: 'OFFICE_SETTING_TENANT_NOT_WRITABLE',
  });
  await assert.rejects(
    emailIdentity.persist('acme', 'main', { replyTo: 'x@example.test', practiceName: null, practicePhone: null, practiceAddress: null, referralBcc: null }, 'qa@example.test'),
    { code: 'OFFICE_SETTING_TENANT_NOT_WRITABLE' }
  );
  await assert.rejects(emailIdentity.readStoredFromDb('acme', 'main'), { code: 'OFFICE_SETTING_TENANT_NOT_WRITABLE' });
  assert.deepEqual([...fake.platform.keys()], before.platform);
  assert.equal(fake.officeSetting.size, before.office);
});

test("a carein write lands in carein's rows only, and is served back", async () => {
  fake.seedOffice('main', 'tc_checkout_enabled', false, ACME_ID);
  await readAll();
  const state = await tcCheckout.persist('carein', 'valley', true, 'qa@example.test');
  assert.equal(state.enabled, true);
  assert.equal(state.source, 'db');
  assert.deepEqual(fake.officeValues('tc_checkout_enabled'), { valley: true });
  assert.deepEqual(fake.officeValues('tc_checkout_enabled', ACME_ID), { main: false });
  assert.deepEqual(fake.platformValue('tc_checkout_enabled'), { valley: true });
});

// ── 2/3. stuck-off-safe, the fallback, the break-glass ──────────────────────

test('no row => OFF; env =true answers ONLY for carein', async () => {
  await readAll();
  process.env.TC_CHECKOUT_ENABLED_MAIN = 'true';
  process.env.TC_CHECKOUT_ENABLED_ROLAND = 'true';
  assert.equal(tcCheckout.enabledFor('acme', 'main'), false, 'another tenant: the fallback never answers');
  assert.equal(tcCheckout.sourceFor('acme', 'main'), 'default');
  assert.equal(tcCheckout.enabledFor('carein', 'roland'), true, 'carein: the fallback answers');
  assert.equal(tcCheckout.sourceFor('carein', 'roland'), 'env');

  process.env.ACS_EMAIL_REPLY_TO_MAIN = 'env@main.example.test';
  process.env.ACS_EMAIL_REPLY_TO_ROLAND = 'env@roland.example.test';
  assert.equal(acs.replyToFor('carein', 'roland'), 'env@roland.example.test');
  for (const field of Object.values(acs.identityStateFor('acme', 'main'))) {
    assert.equal(field.fallback, null, 'no app-setting fallback for another tenant');
  }
});

test('env =false break-glass beats a stored true, for ANY tenant', async () => {
  fake.seedOffice('main', 'tc_checkout_enabled', true, ACME_ID);
  fake.seedOffice('main', 'hyg_od_enabled', true, BETA_ID);
  fake.seedOffice('roland', 'tc_checkout_enabled', true, TENANT_ID);
  await readAll();
  process.env.TC_CHECKOUT_ENABLED_MAIN = 'false';
  process.env.TC_CHECKOUT_ENABLED_ROLAND = 'false';
  process.env.HYG_OD_ENABLED_MAIN = 'false';
  assert.equal(tcCheckout.enabledFor('acme', 'main'), false);
  assert.equal(tcCheckout.enabledFor('carein', 'roland'), false);
  assert.equal(hygPilot.hygEnabledFor('beta', 'main'), false);
  assert.equal(tcCheckout.sourceFor('acme', 'main'), 'env');
});

test('unknown office, unknown tenant, no tenant => OFF everywhere', async () => {
  fake.seedOffice('main', 'tc_checkout_enabled', true, ACME_ID);
  await readAll();
  process.env.TC_CHECKOUT_ENABLED_MAIN = 'true';
  for (const [tenant, office] of [
    ['acme', 'unknown'],
    ['acme', 'nope'],
    ['acme', 'roland'],
    ['nosuch', 'main'],
    [null, 'main'],
    [undefined, 'main'],
    ['', 'main'],
  ]) {
    assert.equal(tcCheckout.enabledFor(/** @type {string} */ (tenant), office), false, `${tenant}/${office}`);
    assert.equal(hygPilot.hygEnabledFor(/** @type {string} */ (tenant), office, true), false, `hyg ${tenant}/${office}`);
    assert.equal(emailIdentity.storedValue(/** @type {string} */ (tenant), office, 'replyTo'), null);
  }
  assert.deepEqual((await nurture.switchedOnOffices(registry, 'nosuch')).offices, []);
  assert.deepEqual((await nurture.switchedOnOffices(registry, /** @type {string} */ (/** @type {unknown} */ (null)))).offices, []);
});

test('unreadable office_setting => OFF, and the rows read before are NOT served on', async () => {
  fake.seedOffice('main', 'tc_checkout_enabled', true, ACME_ID);
  fake.seedOffice('roland', 'tc_checkout_enabled', true, TENANT_ID);
  await readAll();
  assert.equal(tcCheckout.enabledFor('acme', 'main'), true);
  assert.equal(tcCheckout.enabledFor('carein', 'roland'), true);

  fake.fail.listOfficeSettings = true;
  assert.equal((await officeSettings.refreshFromDb('acme')).ok, false);
  assert.equal((await officeSettings.refreshFromDb('carein')).ok, false);
  assert.equal(tcCheckout.enabledFor('acme', 'main'), false, 'not served after a failed read');
  assert.equal(tcCheckout.enabledFor('carein', 'roland'), false);
  assert.equal(tcCheckout.officeState('carein', 'roland').policyKnown, false);
  assert.deepEqual((await nurture.switchedOnOffices(registry, 'acme')).offices, []);
  assert.match(String((await opps.switchedOnOffices(registry, 'acme')).reason), /^CONTROL_PLANE_UNREADABLE/);

  // The carein env fallback still answers when nothing is served — and only for carein.
  process.env.TC_CHECKOUT_ENABLED_ROLAND = 'true';
  process.env.TC_CHECKOUT_ENABLED_MAIN = 'true';
  assert.equal(tcCheckout.enabledFor('carein', 'roland'), true);
  assert.equal(tcCheckout.enabledFor('acme', 'main'), false);

  // A read that succeeds again is served again.
  fake.fail.listOfficeSettings = false;
  assert.equal((await officeSettings.refreshFromDb('acme')).ok, true);
  assert.equal(tcCheckout.enabledFor('acme', 'main'), true);
});

test('a read older than 3 refresh windows is stale => not served => OFF', async () => {
  fake.seedOffice('main', 'tc_checkout_enabled', true, ACME_ID);
  await readAll();
  assert.equal(tcCheckout.enabledFor('acme', 'main'), true);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + officeSettings.maxServedAgeMs() + 1000;
    assert.equal(officeSettings.isServed('acme'), false);
    assert.equal(tcCheckout.enabledFor('acme', 'main'), false);
    assert.equal(hygPilot.policyKnown('acme'), false);
  } finally {
    Date.now = realNow;
  }
});

test('never read => nothing is served (OFF), and the request path reads before answering', async () => {
  fake.seedOffice('main', 'tc_checkout_enabled', true, ACME_ID);
  assert.equal(tcCheckout.enabledFor('acme', 'main'), false, 'sync, never read');
  assert.equal(await tcCheckout.isEnabled('acme', 'main'), true, 'isEnabled reads the registry and office_setting first');
});

// ── 5. office keys per tenant (MT-1c) ───────────────────────────────────────

test("carein's office keys are roland, valley — registry served AND registry unreadable", async () => {
  // Unreadable registry: the code maps, carein only.
  assert.deepEqual(tcOfficeSwitch.realOffices('carein'), ['roland', 'valley']);
  assert.deepEqual(officeRegistry.tenantOfficeKeys('carein'), ['roland', 'valley']);
  // Served registry, rows out of order: sort_order decides, same answer.
  registryOffices.carein = [officeRow('valley', 2), officeRow('roland', 1)];
  assert.equal((await officeRegistry.refreshFromDb('carein')).ok, true);
  assert.equal(JSON.stringify(tcOfficeSwitch.realOffices('carein')), '["roland","valley"]');
  assert.equal(tcOfficeSwitch.isKnownOffice('carein', 'unknown'), false);
});

test('another tenant: an ACTIVE registry row is the only way a key is known; unreadable => no offices', async () => {
  registryOffices.acme = [officeRow('main', 1), officeRow('annex', 2, 'disabled')];
  assert.deepEqual(officeRegistry.tenantOfficeKeys('acme'), [], 'never read: fail closed');
  await officeRegistry.refreshFromDb('acme');
  assert.deepEqual(officeRegistry.tenantOfficeKeys('acme'), ['main']);
  assert.equal(officeRegistry.isTenantOffice('acme', 'annex'), false, 'a disabled row is not an office');
  assert.equal(officeRegistry.isTenantOffice('acme', 'unknown'), false);

  registryOffices.acme = new Error('control plane down');
  await officeRegistry.refreshFromDb('acme');
  assert.deepEqual(officeRegistry.tenantOfficeKeys('acme'), [], 'last read failed: no offices, not the code maps');
  assert.deepEqual(officeRegistry.tenantOfficeKeys('nosuch'), []);
});

// ── 6. Open Dental stays carein's ───────────────────────────────────────────

test("no other tenant can reach this deployment's Open Dental handles through a switch", async () => {
  registryOffices.acme = [officeRow('roland', 1)];
  fake.offices.push({ tenant_id: ACME_ID, office_key: 'roland' });
  fake.seedOffice('roland', 'hyg_od_enabled', true, ACME_ID);
  await readAll();
  const blocked = odOffices.hygOdBlockReason('acme', 'roland');
  assert.equal(blocked && blocked.code, 'OFFICE_NOT_OD_CONNECTED');
  assert.equal(odOffices.isHygOdReady('acme', 'roland'), false);
  const autoCheckout = require('../services/tc/autoCheckout');
  assert.equal(await autoCheckout.isOn('acme', 'roland'), false);
  const odPipelineSync = require('../services/tc/odPipelineSync');
  const r = await odPipelineSync.syncOffice({
    tenantSlug: 'acme',
    office: 'roland',
    pool: /** @type {never} */ ({}),
    trigger: 'manual',
    audit: async () => {},
    sw: { isEnabled: async () => true },
  });
  assert.deepEqual(r, { status: 'skipped', reason: 'OD_NOT_TENANT_BOUND' });
});

// ── 7. the global kill switches ─────────────────────────────────────────────

test('the three global settings are not per-office keys, and their readers take no tenant', () => {
  for (const k of ['tc_email_enabled', 'tc_sms_enabled', 'call_retention_days']) {
    assert.equal(OFFICE_SETTING_KEYS.includes(k), false, k);
  }
  const tcEmail = require('../config/tcEmail');
  const tcSms = require('../config/tcSms');
  assert.equal(tcEmail.emailEnabled.length, 0);
  assert.equal(tcSms.smsEnabled.length, 0);
});

test('the nurture and opportunities env kill switches stop EVERY tenant, whatever is stored', async () => {
  fake.seedOffice('main', 'tc_nurture_enabled', true, ACME_ID);
  fake.seedOffice('main', 'tc_opportunities_sync', true, BETA_ID);
  fake.seedOffice('roland', 'tc_nurture_enabled', true, TENANT_ID);
  await readAll();
  process.env.TC_NURTURE_ENABLED = 'false';
  process.env.TC_OPPS_SYNC_DISABLED = 'true';
  for (const slug of ['carein', 'acme', 'beta']) {
    assert.deepEqual(await nurture.switchedOnOffices(registry, slug), { offices: [], reason: 'KILLED_BY_ENV' });
    assert.deepEqual(await opps.switchedOnOffices(registry, slug), { offices: [], reason: 'KILLED_BY_ENV' });
  }
});
