'use strict';

/**
 * MT-2b: every background job asks the per-office readers for a TENANT it
 * resolved from registry.listTenants() (active tenants only) — never a
 * hardcoded one, never one from a request — and the jobs that read Open Dental
 * refuse every tenant but the one whose handles this deployment holds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { TcNurtureScheduler } = require('./tcNurture/scheduler');
const { TcOpportunitiesScheduler } = require('./tcOpportunities/scheduler');
const officeSettings = require('../platform/officeSettings');
const officeRegistry = require('../platform/officeRegistry');
const registryModule = require('../platform/registry');

const quiet = { warn: console.warn, error: console.error, log: console.log };
test.before(() => {
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
});
test.after(() => {
  Object.assign(console, quiet);
  officeSettings.resetCacheForTests();
  officeRegistry.resetCacheForTests();
});

/**
 * A control-plane registry fake: tenants, their modules, and office_setting
 * rows by tenant slug. Records which tenant each office_setting read was for.
 * @param {{ tenants: Array<{ tenant_id: string, slug: string, status: string }>,
 *           modules?: Record<string, string[]>,
 *           rows?: Record<string, Array<{ office_key: string, setting_key: string, value: unknown }>> }} spec
 */
function fakeRegistry(spec) {
  /** @type {string[]} */
  const asked = [];
  return {
    asked,
    listTenants: async () => spec.tenants,
    getEnabledModules: async (id) => (spec.modules && spec.modules[id]) || ['tc'],
    listOfficeSettings: async (slug) => {
      asked.push(slug);
      return (spec.rows && spec.rows[slug]) || [];
    },
  };
}

const CAREIN = { tenant_id: 'T-carein', slug: 'carein', status: 'active' };
const ACME = { tenant_id: 'T-acme', slug: 'acme', status: 'active' };
const OLD = { tenant_id: 'T-old', slug: 'old', status: 'suspended' };

test('nurture: the switch is read for the resolved tenant, and the tenant rides into the pass', async () => {
  const registry = fakeRegistry({
    tenants: [OLD, ACME, CAREIN],
    modules: { 'T-acme': ['voice'] },
    rows: {
      carein: [{ office_key: 'valley', setting_key: 'tc_nurture_enabled', value: true }],
      old: [{ office_key: 'roland', setting_key: 'tc_nurture_enabled', value: true }],
    },
  });
  /** @type {Array<{ tenantSlug: unknown, office: string }>} */
  const ran = [];
  const s = new TcNurtureScheduler({
    registry,
    tenantDb: { getTenantPool: async () => ({}) },
    runForOffice: async ({ tenantSlug, office }) => {
      ran.push({ tenantSlug, office });
      return { office, due: 0, queued: 0, completed: 0, deferred: 0, stopped: 0, lost_claim: 0, errors: 0, phoneConfigured: false, durationMs: 0 };
    },
  });
  await s.runNow();
  assert.deepEqual(registry.asked, ['carein'], 'only the one active, tc-entitled tenant is read');
  assert.deepEqual(ran, [{ tenantSlug: 'carein', office: 'valley' }]);
});

test("nurture: a sole tc tenant that is not 'carein' reads ITS rows, never carein's", async () => {
  const registry = fakeRegistry({
    tenants: [ACME],
    rows: {
      acme: [{ office_key: 'main', setting_key: 'tc_nurture_enabled', value: true }],
      carein: [{ office_key: 'roland', setting_key: 'tc_nurture_enabled', value: true }],
    },
  });
  const r = await new TcNurtureScheduler({ registry, tenantDb: { getTenantPool: async () => ({}) } }).runNow();
  assert.deepEqual(registry.asked, ['acme']);
  // acme's registry rows cannot be read here, so 'main' is not an office of acme: fail closed.
  assert.equal(r.skipped, 'NO_SETTING_ROW');
});

test('opportunities: a sole tc tenant without Open Dental handles is refused before its switch is read', async () => {
  const registry = fakeRegistry({
    tenants: [ACME],
    rows: { acme: [{ office_key: 'main', setting_key: 'tc_opportunities_sync', value: true }] },
  });
  /** @type {string[]} */
  const synced = [];
  const s = new TcOpportunitiesScheduler({
    registry,
    tenantDb: { getTenantPool: async () => ({}) },
    syncOffice: async ({ office }) => {
      synced.push(office);
      return { office, status: 'ok' };
    },
    odSyncSwitch: { refreshFromDb: async () => ({ ok: true }), enabledFor: () => true },
    pipelineSync: { SYNC_ACTOR: 'system', syncOffice: async () => ({ status: 'ok' }) },
  });
  const r = await s.runOpportunities(new Date().toISOString());
  assert.equal(r.skipped, 'OD_NOT_TENANT_BOUND');
  assert.deepEqual(registry.asked, []);
  assert.deepEqual(synced, []);
});

test('opportunities: carein — the switch is read for carein, and only switched-on, OD-ready offices run', async () => {
  const registry = fakeRegistry({
    tenants: [OLD, CAREIN],
    rows: {
      carein: [
        { office_key: 'roland', setting_key: 'tc_opportunities_sync', value: true },
        { office_key: 'valley', setting_key: 'tc_opportunities_sync', value: false },
      ],
    },
  });
  /** @type {string[]} */
  const synced = [];
  const s = new TcOpportunitiesScheduler({
    registry,
    tenantDb: { getTenantPool: async () => ({}) },
    odOffices: { isOdReady: () => true },
    syncOffice: async ({ office }) => {
      synced.push(office);
      return { office, status: 'ok', pages: 0, proceduresScanned: 0, patients: 0, inserted: 0, refreshed: 0, cleared: 0, resurrected: 0, nameReads: 0, namesPending: 0, odRequests: 0, durationMs: 0 };
    },
  });
  await s.runOpportunities(new Date().toISOString());
  assert.deepEqual(registry.asked, ['carein']);
  assert.deepEqual(synced, ['roland']);
});

test("the nightly pipeline sync asks the switch, and the engine, for the resolved tenant", async () => {
  /** @type {unknown[]} */
  const refreshedFor = [];
  /** @type {unknown[]} */
  const askedFor = [];
  /** @type {Array<{ tenantSlug: unknown, office: string }>} */
  const engineCalls = [];
  const s = new TcOpportunitiesScheduler({
    registry: fakeRegistry({ tenants: [CAREIN] }),
    tenantDb: { getTenantPool: async () => ({}) },
    audit: { auditForTenant: async () => {} },
    odSyncSwitch: {
      refreshFromDb: async (slug) => {
        refreshedFor.push(slug);
        return { ok: true };
      },
      enabledFor: (slug, office) => {
        askedFor.push(slug);
        return office === 'valley';
      },
    },
    pipelineSync: {
      SYNC_ACTOR: 'system',
      syncOffice: async ({ tenantSlug, office }) => {
        engineCalls.push({ tenantSlug, office });
        return { status: 'ok' };
      },
    },
  });
  await s.runPipelineSync();
  assert.deepEqual(refreshedFor, ['carein']);
  assert.deepEqual([...new Set(askedFor)], ['carein']);
  assert.deepEqual(engineCalls, [{ tenantSlug: 'carein', office: 'valley' }]);
});

test('the hygiene warm reads every ACTIVE tenant, and only carein can have an eligible office', async () => {
  const hygPilot = require('../config/hygPilot');
  const hygDayWarm = require('./hygDayWarm');
  const savedRefresh = hygPilot.refreshFromDb;
  const savedList = registryModule.listTenants;
  /** @type {unknown[]} */
  const refreshed = [];
  hygPilot.refreshFromDb = async (slug) => {
    refreshed.push(slug);
    return { ok: true, error: null };
  };
  registryModule.listTenants = async () => [OLD, ACME, CAREIN];
  try {
    const r = await hygDayWarm.runNow({ date: '2026-09-08' });
    assert.deepEqual(refreshed, ['acme', 'carein'], 'active tenants only, in listing order');
    assert.equal(r.skipped, 'NO_ELIGIBLE_OFFICES');
    assert.deepEqual(hygDayWarm.eligibleOffices('acme'), []);
  } finally {
    hygPilot.refreshFromDb = savedRefresh;
    registryModule.listTenants = savedList;
  }
});

test('the shared background refresh reads every ACTIVE tenant and no other', async () => {
  const savedList = registryModule.listTenants;
  const savedRows = registryModule.listOfficeSettings;
  const savedOffices = registryModule.listTenantOffices;
  /** @type {string[]} */
  const read = [];
  registryModule.listTenants = async () => [OLD, ACME, CAREIN];
  registryModule.listOfficeSettings = async (slug) => {
    read.push(slug);
    return [];
  };
  registryModule.listTenantOffices = async () => [];
  try {
    officeSettings.resetCacheForTests();
    const r = await officeSettings.refreshActiveTenants();
    assert.deepEqual(r, { tenants: ['acme', 'carein'], error: null });
    assert.deepEqual(read, ['acme', 'carein']);
  } finally {
    registryModule.listTenants = savedList;
    registryModule.listOfficeSettings = savedRows;
    registryModule.listTenantOffices = savedOffices;
  }
});
