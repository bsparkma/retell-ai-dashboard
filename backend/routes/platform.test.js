'use strict';

/**
 * /api/platform — the Platform Console (PR C).
 *
 * What this suite is actually defending:
 *
 *   1. THE GATE. A tenant admin holds `admin.all` and can reach every other
 *      admin surface in the product. Every route here must still refuse them.
 *      Tested route by route rather than once, because the gate is applied at
 *      the mount and a future route added under a different mount would
 *      otherwise inherit nothing and nobody would notice.
 *   2. THE READBACK. A module toggle reports the DATABASE's state, never the
 *      value the request sent. A write that silently did nothing must not be
 *      able to look like a success.
 *   3. THE AUDIT TARGET. A module flip is filed in the AFFECTED practice's log,
 *      not the operator's — it is that practice's admins who go looking for it.
 *   4. THE TENANT ID. `:tenantId` is resolved against the registry before
 *      anything opens a tenant database. An id that is not in the catalog is a
 *      404, not a connection attempt.
 *   5. THE SHORTENING COUNT. The number the console shows before you confirm is
 *      computed by the same selector the pruner uses to choose victims.
 *
 * The router is mounted over in-memory doubles in the same shape server.js
 * mounts it: the platform gate above it, tenant context already attached.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const express = require('express');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const auditModule = require('../platform/audit');
const retentionConfig = require('../config/retention');
const retentionScheduler = require('../services/retentionScheduler');
const store = require('../services/unifiedCallStore');
const { requireSuperAdmin } = require('../config/permissions');
const { MODULE_NAMES } = require('../config/modules');

const CAREIN = '11111111-1111-4111-8111-111111111111';
const SMITH = '22222222-2222-4222-8222-222222222222';

// --- in-memory control plane ------------------------------------------------

let tenants;
let modules;
let users;
let settings;
/** Every audit row written, with the tenant whose log it landed in. */
let auditRows;
/** Rows the fake audit_log SELECT returns. */
let auditLogRows;

const REGISTRY_KEYS = [
  'getTenantById',
  'listTenantsWithUserCounts',
  'listTenantModules',
  'setTenantModule',
  'listTenantUsers',
  'getPlatformSetting',
  'setPlatformSetting',
];
const savedRegistry = {};
for (const k of REGISTRY_KEYS) savedRegistry[k] = registry[k];
const savedGetTenantPool = tenantDb.getTenantPool;
const savedAudit = auditModule.audit;
const savedAuditForTenant = auditModule.auditForTenant;
const savedEnvDays = process.env.CALL_RETENTION_DAYS;
const savedCreateJob = retentionScheduler.createJob;
const savedRequestPersist = store.requestPersist;
const savedPersist = store.persist;

let app;
let server;
let baseUrl;
/** Flipped per test to change who the gate sees. */
let actor;

/** Build the fake control plane and mount the router. */
beforeEach(async () => {
  tenants = [
    { tenant_id: CAREIN, slug: 'carein', display_name: 'CareIN Dental', status: 'active', created_at: new Date('2026-01-05T00:00:00Z'), user_count: 13 },
    { tenant_id: SMITH, slug: 'smith', display_name: 'Smith Dental', status: 'active', created_at: new Date('2026-06-01T00:00:00Z'), user_count: 4 },
  ];
  // Note SMITH has a 'voice' row and NOTHING else — the composed response must
  // still show every module in the catalog, with the absent ones off.
  modules = {
    [CAREIN]: MODULE_NAMES.map((m) => ({ module: m, enabled: m === 'voice' || m === 'tc' })),
    [SMITH]: [{ module: 'voice', enabled: true }],
  };
  users = {
    [CAREIN]: [
      { email: 'boss@carein.ai', role: 'admin', status: 'active', last_login_at: new Date('2026-08-12T09:00:00Z'), home_office: 'roland' },
      { email: 'hyg@carein.ai', role: 'hygiene', status: 'active', last_login_at: null, home_office: null },
    ],
    [SMITH]: [],
  };
  settings = new Map();
  auditRows = [];
  auditLogRows = [];
  actor = { email: 'admin@carein.ai' };

  registry.getTenantById = async (id) => tenants.find((t) => t.tenant_id === id) || null;
  registry.listTenantsWithUserCounts = async () => tenants;
  registry.listTenantModules = async (id) => (modules[id] || []).slice();
  registry.setTenantModule = async (id, mod, enabled) => {
    const rows = (modules[id] = modules[id] || []);
    const existing = rows.find((r) => r.module === mod);
    if (existing) existing.enabled = enabled;
    else rows.push({ module: mod, enabled });
    return { module: mod, enabled };
  };
  registry.listTenantUsers = async (id) => (users[id] || []).slice();
  registry.getPlatformSetting = async (key) => settings.get(key) || null;
  registry.setPlatformSetting = async (key, value, updatedBy) => {
    const row = { key, value, updated_at: new Date('2026-08-13T12:00:00Z'), updated_by: updatedBy };
    settings.set(key, row);
    return row;
  };

  auditModule.audit = async (req, entry) => {
    auditRows.push({ tenantId: req.tenant.id, ...entry });
  };
  auditModule.auditForTenant = async (req, tenantId, entry) => {
    auditRows.push({ tenantId, ...entry });
  };

  // A pg-shaped double: the audit reader is the only thing that opens a tenant
  // database here, and what it needs is `query(sql, params)`.
  tenantDb.getTenantPool = async () => ({
    query: async (sql) => {
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: String(auditLogRows.length) }] };
      return { rows: auditLogRows };
    },
  });

  retentionConfig.resetCacheForTests();
  delete process.env.CALL_RETENTION_DAYS;

  // PUT /retention re-arms the nightly job when a stored window switches
  // retention on. Overriding the one method that touches node-cron keeps a live
  // cron task out of a test process — see the note at the top of
  // services/retentionScheduler.test.js for what a real one does to the runner.
  retentionScheduler.createJob = (schedule, timezone, handler) => ({
    schedule, timezone, handler, stop() {},
  });
  // The store writes to <repo>/data, which a fresh worktree does not have. These
  // tests assert over the in-memory map; nothing here needs a file.
  store.requestPersist = () => {};
  store.persist = async () => {};
  store.clear();

  app = express();
  app.use(express.json());
  // Exactly server.js's shape: tenant context, then the platform gate, then the
  // router. `isSuperAdmin` is what requireSuperAdmin() reads.
  app.use((req, _res, next) => {
    req.user = actor;
    req.tenant = { id: CAREIN, slug: 'carein', modules: ['voice'], clinics: [] };
    req.userRole = actor.role || 'admin';
    req.isSuperAdmin = actor.isSuperAdmin === true;
    next();
  });
  app.use('/api/platform', requireSuperAdmin(), require('./platform'));

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  for (const k of REGISTRY_KEYS) registry[k] = savedRegistry[k];
  tenantDb.getTenantPool = savedGetTenantPool;
  auditModule.audit = savedAudit;
  auditModule.auditForTenant = savedAuditForTenant;
  retentionConfig.resetCacheForTests();
  if (savedEnvDays === undefined) delete process.env.CALL_RETENTION_DAYS;
  else process.env.CALL_RETENTION_DAYS = savedEnvDays;
  retentionScheduler.stop();
  retentionScheduler.createJob = savedCreateJob;
  store.clear();
  store.requestPersist = savedRequestPersist;
  store.persist = savedPersist;
  await new Promise((resolve) => server.close(resolve));
});

/** Sign the next request in as a platform super_admin. */
function asSuperAdmin() {
  actor = { email: 'admin@carein.ai', role: 'admin', isSuperAdmin: true };
}
/** Sign the next request in as an ordinary tenant admin (holds admin.all). */
function asTenantAdmin() {
  actor = { email: 'boss@carein.ai', role: 'admin', isSuperAdmin: false };
}

function get(path) {
  return fetch(`${baseUrl}${path}`);
}
function send(method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// --- 1. the gate ------------------------------------------------------------

test('every platform route refuses a tenant admin — admin.all is not enough', async () => {
  asTenantAdmin();

  const calls = [
    ['GET', '/api/platform/practices'],
    ['GET', `/api/platform/practices/${SMITH}/modules`],
    ['PUT', `/api/platform/practices/${SMITH}/modules/tc`, { enabled: false }],
    ['GET', `/api/platform/practices/${SMITH}/users`],
    ['GET', `/api/platform/practices/${SMITH}/audit`],
    ['GET', '/api/platform/retention'],
    ['PUT', '/api/platform/retention', { days: 60 }],
    ['GET', '/api/platform/retention/impact?days=30'],
  ];

  for (const [method, path, body] of calls) {
    const res = method === 'GET' ? await get(path) : await send(method, path, body);
    assert.equal(res.status, 403, `${method} ${path} must refuse a tenant admin`);
    const json = await res.json();
    assert.equal(json.code, 'FORBIDDEN');
    assert.equal(json.action, 'platform.admin');
  }
});

test('a refused toggle changes nothing', async () => {
  asTenantAdmin();
  await send('PUT', `/api/platform/practices/${CAREIN}/modules/tc`, { enabled: false });

  assert.equal(modules[CAREIN].find((m) => m.module === 'tc').enabled, true);
  assert.equal(auditRows.length, 0);
});

// --- 2. practices -----------------------------------------------------------

test('the practice list composes EVERY catalog module, including the ones with no row', async () => {
  asSuperAdmin();

  const body = await (await get('/api/platform/practices')).json();

  assert.equal(body.success, true);
  assert.equal(body.practices.length, 2);

  const smith = body.practices.find((p) => p.slug === 'smith');
  assert.equal(smith.displayName, 'Smith Dental');
  assert.equal(smith.userCount, 4);
  // Derived from the catalog rather than restated, so adding a module (hyg was
  // the first) is a one-line catalog edit and not a test to go and fix. The
  // claim is the same either way: a missing tenant_module row is a toggle that
  // reads OFF, never a toggle that is absent from the console.
  assert.equal(
    smith.modules.length,
    MODULE_NAMES.length,
    'a missing tenant_module row is OFF, not a missing toggle'
  );
  assert.deepEqual(
    smith.modules.map((m) => [m.module, m.enabled]),
    MODULE_NAMES.map((m) => [m, m === 'voice'])
  );
});

// --- 3. the toggle ----------------------------------------------------------

test('a toggle round-trips: DB changes, audit row written, response is the readback', async () => {
  asSuperAdmin();

  const res = await send('PUT', `/api/platform/practices/${CAREIN}/modules/tc`, { enabled: false });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(modules[CAREIN].find((m) => m.module === 'tc').enabled, false, 'the DB changed');
  assert.equal(body.modules.find((m) => m.module === 'tc').enabled, false, 'the UI is told what the DB says');

  assert.equal(auditRows.length, 1);
  assert.deepEqual(auditRows[0], {
    tenantId: CAREIN,
    action: 'UPDATE',
    resourceType: 'tenant_module',
    resourceId: 'tc',
    result: 'SUCCESS',
  });
});

test('flipping back restores — the switch is not one-way', async () => {
  asSuperAdmin();

  await send('PUT', `/api/platform/practices/${CAREIN}/modules/tc`, { enabled: false });
  const back = await (await send('PUT', `/api/platform/practices/${CAREIN}/modules/tc`, { enabled: true })).json();

  assert.equal(back.modules.find((m) => m.module === 'tc').enabled, true);
  assert.equal(modules[CAREIN].find((m) => m.module === 'tc').enabled, true);
  assert.equal(auditRows.length, 2, 'both directions are recorded');
});

test("a flip is filed in the AFFECTED practice's log, not the operator's", async () => {
  asSuperAdmin(); // signed in under CareIN (req.tenant.id === CAREIN)

  await send('PUT', `/api/platform/practices/${SMITH}/modules/tc`, { enabled: true });

  assert.equal(
    auditRows[0].tenantId,
    SMITH,
    "Smith Dental's admins are the ones who go looking for why TC appeared"
  );
});

test('an unknown module is refused before it can reach the CHECK constraint', async () => {
  asSuperAdmin();

  // 'hyg' stood here until it became a real module (migration 1788100000000).
  // 'perio' is the next name nobody has registered — the point of the test is
  // that an UNREGISTERED name is refused by the route, not by the database.
  const res = await send('PUT', `/api/platform/practices/${CAREIN}/modules/perio`, { enabled: true });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.code, 'UNKNOWN_MODULE');
});

test('a non-boolean `enabled` is refused rather than coerced', async () => {
  asSuperAdmin();

  const res = await send('PUT', `/api/platform/practices/${CAREIN}/modules/tc`, { enabled: 'false' });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'INVALID_ENABLED');
  assert.equal(modules[CAREIN].find((m) => m.module === 'tc').enabled, true, 'the string "false" is not false');
});

// --- 4. the tenant id -------------------------------------------------------

test('an id that is not in the catalog is a 404, and never opens a database', async () => {
  asSuperAdmin();
  let poolOpened = false;
  tenantDb.getTenantPool = async () => {
    poolOpened = true;
    throw new Error('should not be reached');
  };

  const unknown = '99999999-9999-4999-8999-999999999999';
  for (const path of [
    `/api/platform/practices/${unknown}/modules`,
    `/api/platform/practices/${unknown}/users`,
    `/api/platform/practices/${unknown}/audit`,
  ]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).code, 'PRACTICE_NOT_FOUND');
  }
  assert.equal(poolOpened, false, 'a URL string must not become a connection attempt');
});

// --- 5. users (read-only) ---------------------------------------------------

test('the users panel lists role and home office, and points writes elsewhere', async () => {
  asSuperAdmin();

  const body = await (await get(`/api/platform/practices/${CAREIN}/users`)).json();

  assert.equal(body.users.length, 2);
  assert.deepEqual(body.users[0], {
    email: 'boss@carein.ai',
    role: 'admin',
    status: 'active',
    lastLoginAt: '2026-08-12T09:00:00.000Z',
    homeOffice: 'roland',
  });
  assert.equal(body.users[1].homeOffice, null, 'no home office is a real answer, not a blank guess');
  assert.equal(body.manageAt, '/admin/users');
});

test('the console exposes NO user write — role changes stay on /admin/users', async () => {
  asSuperAdmin();

  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const res = await send(method, `/api/platform/practices/${CAREIN}/users`, { role: 'admin' });
    assert.ok(res.status === 404 || res.status === 405, `${method} users must not be a route (got ${res.status})`);
  }
});

// --- 6. audit ---------------------------------------------------------------

test('the audit view paginates server-side and caps the page size', async () => {
  asSuperAdmin();
  auditLogRows = [
    { audit_id: 'a1', ts: new Date('2026-08-13T10:00:00Z'), user_id: 'boss@carein.ai', action: 'UPDATE', resource_type: 'app_user', resource_id: 'x@carein.ai', ip: '10.0.0.1', result: 'SUCCESS', endpoint: '/api/users/x', office: null, source_ref: null },
  ];

  const body = await (await get(`/api/platform/practices/${CAREIN}/audit?limit=500`)).json();

  assert.equal(body.limit, 100, 'a filter must not be able to ask for the whole table');
  assert.equal(body.total, 1);
  assert.equal(body.entries[0].actor, 'boss@carein.ai');
  assert.equal(body.entries[0].resourceType, 'app_user');
});

test('audit filters are validated against the schema vocabulary', async () => {
  asSuperAdmin();

  const bad = await get(`/api/platform/practices/${CAREIN}/audit?action=DROP`);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'INVALID_ACTION');

  const badDate = await get(`/api/platform/practices/${CAREIN}/audit?from=yesterday`);
  assert.equal(badDate.status, 400);
  assert.equal((await badDate.json()).code, 'INVALID_FROM');
});

test('the audit reader only ever SELECTs — no UPDATE or DELETE reaches the pool', async () => {
  asSuperAdmin();
  const statements = [];
  tenantDb.getTenantPool = async () => ({
    query: async (sql) => {
      statements.push(sql);
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: '0' }] };
      return { rows: [] };
    },
  });

  await get(`/api/platform/practices/${CAREIN}/audit?action=DELETE&resourceType=call_store`);

  assert.ok(statements.length > 0);
  for (const sql of statements) {
    assert.match(sql, /^\s*SELECT/i, `append-only: ${sql}`);
    assert.ok(!/\b(UPDATE|DELETE|TRUNCATE|INSERT)\s/i.test(sql), `append-only: ${sql}`);
  }
});

// --- 7. retention -----------------------------------------------------------

test('GET /retention reports the source, not just the number', async () => {
  asSuperAdmin();
  process.env.CALL_RETENTION_DAYS = '30';

  const body = await (await get('/api/platform/retention')).json();

  assert.equal(body.policy.days, 30);
  assert.equal(body.policy.source, 'env', 'nobody has chosen yet — say so');
  assert.deepEqual(body.policy.options, [30, 60, 90]);
  assert.equal(body.policy.policyKnown, true);
});

test('PUT /retention persists, is audited, and survives a process restart', async () => {
  asSuperAdmin();
  process.env.CALL_RETENTION_DAYS = '30';

  const res = await send('PUT', '/api/platform/retention', { days: 60 });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.policy.days, 60);
  assert.equal(body.policy.source, 'db', 'the stored value now outranks the environment');
  assert.equal(body.policy.updatedBy, 'admin@carein.ai');

  assert.deepEqual(auditRows[0], {
    tenantId: CAREIN,
    action: 'UPDATE',
    resourceType: 'platform_setting',
    resourceId: 'call_retention_days',
    result: 'SUCCESS',
  });

  // A restart forgets the cache but not the row: the setting is in the control
  // plane, and this is the read a freshly-booted container performs.
  retentionConfig.resetCacheForTests();
  assert.equal(retentionConfig.retentionDays(), 30, 'cache cleared ⇒ back to the env for a moment');
  await retentionConfig.refreshFromDb();
  assert.equal(retentionConfig.retentionDays(), 60, 'and the stored window is picked back up');
});

test('the window is a constrained choice — 45 days is refused', async () => {
  asSuperAdmin();

  for (const days of [45, 0, -30, '60', null]) {
    const res = await send('PUT', '/api/platform/retention', { days });
    assert.equal(res.status, 400, `days=${JSON.stringify(days)}`);
    assert.equal((await res.json()).code, 'INVALID_RETENTION_DAYS');
  }
  assert.equal(settings.size, 0, 'nothing was stored');
});

test('the shortening count comes from the pruner\'s own selector', async () => {
  asSuperAdmin();
  process.env.CALL_RETENTION_DAYS = '90';
  await retentionConfig.refreshFromDb(); // no row ⇒ env 90

  const day = 24 * 60 * 60 * 1000;
  for (const [id, age] of [['c40', 40], ['c50', 50], ['c20', 20]]) {
    store.addCallInternal({
      id: `mango_${id}`, external_id: `mango_${id}`, source: 'mango',
      caller_number: '+15550100777',
      call_date: new Date(Date.now() - age * day).toISOString(),
      summary: 'a synthetic summary',
    });
  }

  const body = await (await get('/api/platform/retention/impact?days=30')).json();

  assert.equal(body.currentDays, 90);
  assert.equal(body.shortening, true);
  assert.equal(body.wouldPrune, 2, 'the 40- and 50-day calls fall outside a 30-day window');
});

test('extending reports no gain — a stub cannot be un-stubbed', async () => {
  asSuperAdmin();
  process.env.CALL_RETENTION_DAYS = '30';
  await retentionConfig.refreshFromDb();

  const body = await (await get('/api/platform/retention/impact?days=90')).json();

  assert.equal(body.shortening, false);
  assert.equal(body.wouldPrune, 0);
});

test('the impact endpoint refuses a nonsense window rather than answering 0', async () => {
  asSuperAdmin();

  const res = await get('/api/platform/retention/impact?days=abc');

  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'INVALID_DAYS');
});
