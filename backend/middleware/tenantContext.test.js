'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterEach } = test;

const registry = require('../platform/registry');
const {
  tenantContext,
  requireEntitledClinic,
  requireModule,
  isEntitledModule,
  CAREIN_FALLBACK,
} = require('./tenantContext');

// --- test doubles ----------------------------------------------------------

/** Capture status/json without a real Express response. */
function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}

function makeNext() {
  const calls = { count: 0, err: undefined };
  const next = (err) => {
    calls.count += 1;
    calls.err = err;
  };
  next.calls = calls;
  return next;
}

// Snapshot the registry functions we override so each test starts clean.
const REGISTRY_KEYS = [
  'getUserByEmail',
  'getTenantById',
  'getTenantBySlug',
  'getTenantClinics',
  'getEnabledModules',
];
const original = {};
for (const k of REGISTRY_KEYS) original[k] = registry[k];

afterEach(() => {
  for (const k of REGISTRY_KEYS) registry[k] = original[k];
});

const CLINICS = [
  { tenant_id: 'T1', clinic_num: 1, name: 'Roland' },
  { tenant_id: 'T1', clinic_num: 2, name: 'Valley' },
];

// --- tenantContext: resolution paths --------------------------------------

test('authed user with a seeded app_user → req.tenant is set and next() called', async () => {
  registry.getUserByEmail = async (email) => {
    assert.equal(email, 'admin@carein.ai');
    return { user_id: 'U1', tenant_id: 'T1', email, role: 'admin' };
  };
  registry.getTenantById = async (id) => {
    assert.equal(id, 'T1');
    return { tenant_id: 'T1', slug: 'carein', display_name: 'CareIN Dental LLC', status: 'active' };
  };
  registry.getTenantClinics = async () => CLINICS;
  registry.getEnabledModules = async () => ['voice'];

  const mw = tenantContext();
  const req = { path: '/calls', user: { email: 'admin@carein.ai', tenantId: 'whatever' } };
  const res = makeRes();
  const next = makeNext();

  await mw(req, res, next);

  assert.equal(next.calls.count, 1);
  assert.equal(next.calls.err, undefined);
  assert.deepEqual(req.tenant, {
    id: 'T1',
    slug: 'carein',
    modules: ['voice'],
    clinics: [
      { clinic_num: 1, name: 'Roland' },
      { clinic_num: 2, name: 'Valley' },
    ],
  });
});

test('@carein.ai user with NO app_user row but careindent tid → mapped to carein via fallback', async () => {
  registry.getUserByEmail = async () => null;
  let slugAsked = null;
  registry.getTenantBySlug = async (slug) => {
    slugAsked = slug;
    return { tenant_id: 'T1', slug: 'carein' };
  };
  registry.getTenantClinics = async () => CLINICS;
  registry.getEnabledModules = async () => ['voice'];

  const mw = tenantContext();
  const req = {
    path: '/calls',
    user: { email: 'Beau@carein.ai', tenantId: CAREIN_FALLBACK.entraTenantId },
  };
  const res = makeRes();
  const next = makeNext();

  await mw(req, res, next);

  assert.equal(slugAsked, 'carein');
  assert.equal(next.calls.count, 1);
  assert.equal(req.tenant.slug, 'carein');
  assert.deepEqual(req.tenant.modules, ['voice']);
});

test('authed user with wrong tid/domain and no app_user row → 403, next() not called', async () => {
  registry.getUserByEmail = async () => null;
  registry.getTenantBySlug = async () => {
    throw new Error('getTenantBySlug should not be called when the fallback does not match');
  };

  const mw = tenantContext();
  const req = {
    path: '/calls',
    user: { email: 'stranger@example.com', tenantId: 'some-other-entra-tenant' },
  };
  const res = makeRes();
  const next = makeNext();

  await mw(req, res, next);

  assert.equal(next.calls.count, 0);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'TENANT_UNRESOLVED');
  assert.equal(req.tenant, undefined);
});

test('right careindent tid but non-carein.ai domain → fallback does NOT apply → 403', async () => {
  registry.getUserByEmail = async () => null;
  registry.getTenantBySlug = async () => {
    throw new Error('fallback must require BOTH tid and @carein.ai domain');
  };

  const mw = tenantContext();
  const req = {
    path: '/calls',
    user: { email: 'guest@gmail.com', tenantId: CAREIN_FALLBACK.entraTenantId },
  };
  const res = makeRes();
  const next = makeNext();

  await mw(req, res, next);

  assert.equal(res.statusCode, 403);
  assert.equal(next.calls.count, 0);
});

test('exempt path bypasses tenant resolution', async () => {
  registry.getUserByEmail = async () => {
    throw new Error('exempt paths must not hit the registry');
  };
  const mw = tenantContext({ exempt: [/^\/health$/] });
  const req = { path: '/health' };
  const res = makeRes();
  const next = makeNext();

  await mw(req, res, next);
  assert.equal(next.calls.count, 1);
});

test('no authenticated user identity → 403 (fail closed)', async () => {
  const mw = tenantContext();
  const req = { path: '/calls' }; // no req.user
  const res = makeRes();
  const next = makeNext();

  await mw(req, res, next);
  assert.equal(res.statusCode, 403);
  assert.equal(next.calls.count, 0);
});

// --- requireEntitledClinic helper -----------------------------------------

test('requireEntitledClinic accepts entitled clinics, rejects others', () => {
  const req = { tenant: { clinics: [{ clinic_num: 1, name: 'Roland' }, { clinic_num: 2, name: 'Valley' }] } };
  assert.equal(requireEntitledClinic(req, '1'), true);
  assert.equal(requireEntitledClinic(req, 2), true);
  assert.equal(requireEntitledClinic(req, '99'), false);
  assert.equal(requireEntitledClinic(req, 'abc'), false);
  assert.equal(requireEntitledClinic(req, '1.5'), false);
  assert.equal(requireEntitledClinic({}, '1'), false); // no tenant
});

// --- isEntitledModule predicate --------------------------------------------

test('isEntitledModule: entitled module true, others false, no tenant false', () => {
  const req = { tenant: { modules: ['voice'] } };
  assert.equal(isEntitledModule(req, 'voice'), true);
  assert.equal(isEntitledModule(req, 'tc'), false);
  assert.equal(isEntitledModule({}, 'voice'), false); // no tenant context
  assert.equal(isEntitledModule({ tenant: {} }, 'voice'), false); // malformed modules
  assert.equal(isEntitledModule({ tenant: { modules: 'voice' } }, 'voice'), false); // not an array
});

// --- requireModule guard ----------------------------------------------------

test('requireModule: entitled module → next() called, no response written', () => {
  const mw = requireModule('voice');
  const req = { path: '/worklist', tenant: { modules: ['voice', 'tc'] } };
  const res = makeRes();
  const next = makeNext();

  mw(req, res, next);

  assert.equal(next.calls.count, 1);
  assert.equal(next.calls.err, undefined);
  assert.equal(res.body, undefined);
});

test('requireModule: unentitled module → 403 MODULE_NOT_ENTITLED, next() not called', () => {
  const mw = requireModule('tc');
  const req = { path: '/cases', tenant: { modules: ['voice'] } };
  const res = makeRes();
  const next = makeNext();

  mw(req, res, next);

  assert.equal(next.calls.count, 0);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
  assert.equal(res.body.module, 'tc');
  assert.equal(res.body.success, false);
});

test('requireModule: missing tenant context → 403 (fail closed), never 500 / pass-through', () => {
  const mw = requireModule('voice');
  const req = { path: '/calls' }; // no req.tenant at all
  const res = makeRes();
  const next = makeNext();

  mw(req, res, next); // must not throw

  assert.equal(next.calls.count, 0);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
  assert.equal(res.body.module, 'voice');
});

test('requireModule: exempt path bypasses the guard even without tenant context', () => {
  const mw = requireModule('voice', { exempt: [/^\/dev\/seed$/] });
  const req = { path: '/dev/seed' }; // tenant-exempt upstream → no req.tenant here
  const res = makeRes();
  const next = makeNext();

  mw(req, res, next);

  assert.equal(next.calls.count, 1);
  assert.equal(res.body, undefined);
});

test('requireModule: non-exempt path on a guarded mount with exemptions still enforces', () => {
  const mw = requireModule('voice', { exempt: [/^\/dev\/seed$/] });
  const req = { path: '/fetch/abc123', tenant: { modules: [] } };
  const res = makeRes();
  const next = makeNext();

  mw(req, res, next);

  assert.equal(next.calls.count, 0);
  assert.equal(res.statusCode, 403);
});

test('requireModule: empty module name throws at construction (misuse is loud)', () => {
  assert.throws(() => requireModule(''), /module name/);
});

// NOTE: the slot-markers route is now thin and delegates to odAccess; its
// clinic-entitlement + connector-forwarding behavior is covered in
// platform/odAccess.test.js.
