'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterEach } = test;

const registry = require('../platform/registry');
const userContext = require('../platform/userContext');
const {
  tenantContext,
  resolveUserContext,
  requireEntitledClinic,
  requireModule,
  isEntitledModule,
  CAREIN_FALLBACK,
  FALLBACK_ROLE,
  FALLBACK_ENV_KEY,
  bootstrapFallbackEnabled,
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
  'getPlatformAdminByEmail',
  'touchUserLogin',
];
const original = {};
for (const k of REGISTRY_KEYS) original[k] = registry[k];

// The identity read is cached (platform/userContext, 60s TTL) and is shared
// process-wide, so it MUST be cleared between tests or one test's stubbed user
// answers the next test's lookup. Roles PR A.
test.beforeEach(() => {
  userContext.clearCache();
  // Sensible defaults for the two Roles PR A lookups, so tests that predate
  // roles (and care only about tenant resolution) don't have to stub them.
  registry.getPlatformAdminByEmail = async () => null;
  registry.touchUserLogin = async () => {};
});

afterEach(() => {
  for (const k of REGISTRY_KEYS) registry[k] = original[k];
  userContext.clearCache();
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

// --- role attachment (Roles PR A) ------------------------------------------

/** Wire the registry for one user and run tenantContext over a /calls request. */
async function runWithUser({ appUser, platformAdmin = null, email, tid = CAREIN_FALLBACK.entraTenantId }) {
  registry.getUserByEmail = async () => appUser;
  registry.getTenantById = async (id) => ({ tenant_id: id, slug: 'carein', display_name: 'CareIN Dental LLC' });
  registry.getTenantBySlug = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN Dental LLC' });
  registry.getTenantClinics = async () => CLINICS;
  registry.getEnabledModules = async () => ['voice'];
  registry.getPlatformAdminByEmail = async () => platformAdmin;

  const mw = tenantContext();
  const req = { path: '/calls', user: { email, tenantId: tid } };
  const res = makeRes();
  const next = makeNext();
  await mw(req, res, next);
  return { req, res, next };
}

test('roles: a seeded user gets their app_user role on req.userRole', async () => {
  const { req, next } = await runWithUser({
    email: 'hyg@carein.ai',
    appUser: { user_id: 'U9', tenant_id: 'T1', email: 'hyg@carein.ai', role: 'hygiene', status: 'active' },
  });

  assert.equal(next.calls.count, 1);
  assert.equal(req.userRole, 'hygiene');
  assert.equal(req.isSuperAdmin, false);
});

test('roles: a DISABLED app_user resolves a tenant but NO role (denied every action)', async () => {
  const { req, next } = await runWithUser({
    email: 'gone@carein.ai',
    appUser: { user_id: 'U8', tenant_id: 'T1', email: 'gone@carein.ai', role: 'admin', status: 'disabled' },
  });

  // The tenant still resolves, so the user gets an honest per-action 403 rather
  // than a confusing "no tenant is mapped to this account".
  assert.equal(next.calls.count, 1);
  assert.equal(req.tenant.slug, 'carein');
  assert.equal(req.userRole, null);
});

test('roles: an active platform_admin sets req.isSuperAdmin', async () => {
  const { req } = await runWithUser({
    email: 'admin@carein.ai',
    appUser: { user_id: 'U1', tenant_id: 'T1', email: 'admin@carein.ai', role: 'admin', status: 'active' },
    platformAdmin: { email: 'admin@carein.ai', status: 'active', created_at: new Date() },
  });

  assert.equal(req.userRole, 'admin');
  assert.equal(req.isSuperAdmin, true);
});

test('roles: a disabled platform_admin row does NOT grant super_admin', async () => {
  const { req } = await runWithUser({
    email: 'ex@carein.ai',
    appUser: { user_id: 'U7', tenant_id: 'T1', email: 'ex@carein.ai', role: 'office', status: 'active' },
    platformAdmin: { email: 'ex@carein.ai', status: 'disabled', created_at: new Date() },
  });

  assert.equal(req.isSuperAdmin, false);
});

test('roles: the PR A fallback degrades an unseeded @carein.ai user to office, and warns once', async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const first = await runWithUser({ email: 'unseeded@carein.ai', appUser: null });
    assert.equal(first.next.calls.count, 1);
    assert.equal(first.req.tenant.slug, 'carein');
    assert.equal(first.req.userRole, FALLBACK_ROLE);
    assert.equal(first.req.userRole, 'office', 'the fallback must never be admin');

    // A second request from the same user goes through the fallback again and
    // must not warn a second time.
    const second = await runWithUser({ email: 'unseeded@carein.ai', appUser: null });
    assert.equal(second.req.userRole, FALLBACK_ROLE);
  } finally {
    console.warn = realWarn;
  }

  const roleWarnings = warnings.filter((w) => w.includes('NO app_user ROW'));
  assert.equal(roleWarnings.length, 1, 'exactly one warning per user per process');
  assert.match(roleWarnings[0], /unseeded@carein\.ai/);
});

test('roles: a super_admin with no app_user row still gets isSuperAdmin via the fallback', async () => {
  const { req } = await runWithUser({
    email: 'platform@carein.ai',
    appUser: null,
    platformAdmin: { email: 'platform@carein.ai', status: 'active', created_at: new Date() },
  });

  assert.equal(req.userRole, FALLBACK_ROLE);
  assert.equal(req.isSuperAdmin, true);
});

test('roles: last_login_at is stamped at most once per cache TTL, and a failure does not fail the request', async () => {
  let stamps = 0;
  registry.touchUserLogin = async () => {
    stamps += 1;
    throw new Error('control db write failed');
  };

  const appUser = { user_id: 'U5', tenant_id: 'T1', email: 'stamp@carein.ai', role: 'office', status: 'active' };
  const a = await runWithUser({ email: 'stamp@carein.ai', appUser });
  registry.touchUserLogin = async () => {
    stamps += 1;
    throw new Error('control db write failed');
  };
  const b = await runWithUser({ email: 'stamp@carein.ai', appUser });

  await new Promise((r) => setTimeout(r, 5));

  assert.equal(a.next.calls.count, 1, 'a failing stamp must not fail the request');
  assert.equal(b.next.calls.count, 1);
  assert.equal(stamps, 1, 'throttled to one write per TTL despite two requests');
});

test('roles: a control-DB failure during role resolution still fails CLOSED (503)', async () => {
  registry.getUserByEmail = async () => {
    throw new Error('control db down');
  };
  registry.getPlatformAdminByEmail = async () => null;

  const mw = tenantContext();
  const req = { path: '/calls', user: { email: 'a@carein.ai', tenantId: CAREIN_FALLBACK.entraTenantId } };
  const res = makeRes();
  const next = makeNext();
  await mw(req, res, next);

  assert.equal(next.calls.count, 0);
  assert.equal(res.statusCode, 503);
  assert.equal(req.userRole, undefined);
});

test('roles: resolveUserContext returns tenant + role + isSuperAdmin together', async () => {
  registry.getUserByEmail = async () => ({
    user_id: 'U1', tenant_id: 'T1', email: 'x@carein.ai', role: 'tc', status: 'active',
  });
  registry.getTenantById = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN Dental LLC' });
  registry.getPlatformAdminByEmail = async () => null;

  const resolved = await resolveUserContext({ email: 'x@carein.ai', tenantId: 'whatever' });

  assert.equal(resolved.tenant.slug, 'carein');
  assert.equal(resolved.role, 'tc');
  assert.equal(resolved.isSuperAdmin, false);
  assert.equal(resolved.viaFallback, false);
});

// --- bootstrap fallback flag (Roles PR B) -----------------------------------

/** Set/restore ROLES_BOOTSTRAP_FALLBACK around one assertion. */
async function withFlag(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, FALLBACK_ENV_KEY);
  const previous = process.env[FALLBACK_ENV_KEY];
  if (value === undefined) delete process.env[FALLBACK_ENV_KEY];
  else process.env[FALLBACK_ENV_KEY] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[FALLBACK_ENV_KEY] = previous;
    else delete process.env[FALLBACK_ENV_KEY];
  }
}

test('flag: unset means ON — the fallback still grants office', async () => {
  await withFlag(undefined, async () => {
    assert.equal(bootstrapFallbackEnabled(), true);
    const { req } = await runWithUser({ email: 'unset@carein.ai', appUser: null });
    assert.equal(req.userRole, FALLBACK_ROLE);
  });
});

test('flag: off → an unseeded user resolves a TENANT but no role', async () => {
  await withFlag('off', async () => {
    assert.equal(bootstrapFallbackEnabled(), false);
    const { req, next } = await runWithUser({ email: 'locked@carein.ai', appUser: null });

    // next() is still called: the request proceeds with a tenant so the SPA can
    // render the access-request screen. What they may DO is nothing.
    assert.equal(next.calls.count, 1);
    assert.equal(req.tenant.slug, 'carein');
    assert.equal(req.userRole, null);
  });
});

test('flag: off does NOT affect a user who HAS an app_user row', async () => {
  await withFlag('off', async () => {
    const { req } = await runWithUser({
      email: 'seeded@carein.ai',
      appUser: { user_id: 'U3', tenant_id: 'T1', email: 'seeded@carein.ai', role: 'hygiene', status: 'active' },
    });
    assert.equal(req.userRole, 'hygiene');
  });
});

test('flag: off still grants super_admin — the lockdown must not lock Beau out', async () => {
  await withFlag('off', async () => {
    const { req } = await runWithUser({
      email: 'platform@carein.ai',
      appUser: null,
      platformAdmin: { email: 'platform@carein.ai', status: 'active', created_at: new Date() },
    });
    assert.equal(req.userRole, null);
    assert.equal(req.isSuperAdmin, true, 'a super_admin can always get back in to fix the roster');
  });
});

test('flag: every off-ish spelling turns it off; anything else leaves it ON', async () => {
  for (const off of ['off', 'OFF', ' off ', 'false', '0', 'no', 'disabled']) {
    await withFlag(off, () => assert.equal(bootstrapFallbackEnabled(), false, `${off} should be off`));
  }
  // A typo must fail toward "team keeps working", never toward a surprise
  // lockout. The lockdown is deliberate and should need a deliberate value.
  for (const on of ['on', 'true', '1', 'yes', 'offf', 'Off!', '']) {
    await withFlag(on, () => assert.equal(bootstrapFallbackEnabled(), true, `${on} should be on`));
  }
});

test('flag: read PER REQUEST — flipping it takes effect with no restart', async () => {
  await withFlag('on', async () => {
    const first = await runWithUser({ email: 'flip@carein.ai', appUser: null });
    assert.equal(first.req.userRole, FALLBACK_ROLE);
  });
  await withFlag('off', async () => {
    const second = await runWithUser({ email: 'flip@carein.ai', appUser: null });
    assert.equal(second.req.userRole, null, 'the same process must honor the new value');
  });
});

test('flag: off suppresses the unseeded warning — there is nothing left to fix a role for', async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    await withFlag('off', () => runWithUser({ email: 'quiet@carein.ai', appUser: null }));
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.filter((w) => w.includes('NO app_user ROW')).length, 0);
});

// --- home office -------------------------------------------------------------
//
// resolveUserContext is what /auth/me reads, so the home office has to come out
// of the SAME identity read as the role. Splitting it into a second lookup
// would mean two queries and a window in which they could disagree.

test('roles: resolveUserContext carries the home office off the app_user row', async () => {
  registry.getUserByEmail = async () => ({
    user_id: 'U1', tenant_id: 'T1', email: 'x@carein.ai', role: 'hygiene', status: 'active',
    home_office: 'valley',
  });
  registry.getTenantById = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN' });
  registry.getPlatformAdminByEmail = async () => null;
  userContext.clearCache();

  const resolved = await resolveUserContext({ email: 'x@carein.ai', tenantId: 'whatever' });
  assert.equal(resolved.homeOffice, 'valley');
});

test('roles: no home office resolves to null, never to a guessed office', async () => {
  // The shared temp@ account is MEANT to have none — the office picker is its
  // "which office are you at today?" prompt. Inventing a default here would
  // silently file a temp's work under the wrong practice.
  registry.getUserByEmail = async () => ({
    user_id: 'U1', tenant_id: 'T1', email: 'temp@carein.ai', role: 'hygiene', status: 'active',
    home_office: null,
  });
  registry.getTenantById = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN' });
  registry.getPlatformAdminByEmail = async () => null;
  userContext.clearCache();

  const resolved = await resolveUserContext({ email: 'temp@carein.ai', tenantId: 'whatever' });
  assert.equal(resolved.homeOffice, null);
});

test('roles: an unseeded user on the bootstrap fallback has no home office', async () => {
  // There is no row to read one from. null is the honest answer; the fallback
  // grants a ROLE so the team keeps working, and inventing an office on top of
  // that would be a second guess stacked on the first.
  registry.getUserByEmail = async () => null;
  registry.getTenantBySlug = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN' });
  registry.getPlatformAdminByEmail = async () => null;
  userContext.clearCache();

  const resolved = await resolveUserContext({
    email: 'nobody@carein.ai',
    tenantId: CAREIN_FALLBACK.entraTenantId,
  });
  assert.equal(resolved.homeOffice, null);
});
