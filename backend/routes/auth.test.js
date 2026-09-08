'use strict';

/**
 * /auth/me contract tests — the SPA reads the tenant payload (including the
 * enabled `modules` array, added by the module-entitlement slice) from here.
 *
 * The router is mounted on a real ephemeral Express server; sso.verifySession
 * and the registry are monkey-patched the same way tenantContext.test.js does.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterEach } = test;

const express = require('express');

const sso = require('../config/sso');
const registry = require('../platform/registry');
const userContext = require('../platform/userContext');
const { PERMISSIONS } = require('../config/permissions');
const authRouter = require('./auth');

const REGISTRY_KEYS = [
  'getUserByEmail',
  'getTenantById',
  'getTenantBySlug',
  'getEnabledModules',
  'getPlatformAdminByEmail',
  'touchUserLogin',
];
const originalRegistry = {};
for (const k of REGISTRY_KEYS) originalRegistry[k] = registry[k];
const originalVerifySession = sso.verifySession;

test.beforeEach(() => {
  userContext.clearCache();
  registry.getPlatformAdminByEmail = async () => null;
  registry.touchUserLogin = async () => {};
});

afterEach(() => {
  for (const k of REGISTRY_KEYS) registry[k] = originalRegistry[k];
  sso.verifySession = originalVerifySession;
  userContext.clearCache();
});

const CLAIMS = { name: 'Beau', email: 'admin@carein.ai', tid: 'entra-tid' };

function stubSession() {
  sso.verifySession = (token) => (token === 'good-token' ? CLAIMS : null);
}

function stubTenant({ modules, role = 'admin', status = 'active', superAdmin = false }) {
  registry.getUserByEmail = async () => ({
    user_id: 'U1',
    tenant_id: 'T1',
    email: CLAIMS.email,
    role,
    status,
  });
  registry.getTenantById = async () => ({
    tenant_id: 'T1',
    slug: 'carein',
    display_name: 'CareIN Dental LLC',
    status: 'active',
  });
  registry.getEnabledModules = modules;
  registry.getPlatformAdminByEmail = async () =>
    superAdmin ? { email: CLAIMS.email, status: 'active', created_at: new Date() } : null;
}

/** Minimal req.cookies shim so the test doesn't depend on cookie-parser. */
function cookieShim(req, _res, next) {
  req.cookies = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) req.cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  next();
}

function boot() {
  const app = express();
  app.use(cookieShim);
  app.use('/auth', authRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        me: (cookie) =>
          fetch(`http://127.0.0.1:${port}/auth/me`, {
            headers: cookie ? { Cookie: `${sso.cookieName}=${cookie}` } : {},
          }),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('/auth/me: authenticated → tenant payload includes enabled modules', async () => {
  stubSession();
  stubTenant({ modules: async () => ['voice'] });

  const { me, close } = await boot();
  try {
    const res = await me('good-token');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.authenticated, true);
    assert.deepEqual(body.user, { name: 'Beau', email: 'admin@carein.ai', tenantId: 'entra-tid' });
    assert.deepEqual(body.tenant, {
      slug: 'carein',
      displayName: 'CareIN Dental LLC',
      modules: ['voice'],
    });
  } finally {
    await close();
  }
});

test('/auth/me: modules lookup failure degrades to [] — auth must not break', async () => {
  stubSession();
  stubTenant({
    modules: async () => {
      throw new Error('control db down');
    },
  });

  const { me, close } = await boot();
  try {
    const res = await me('good-token');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.authenticated, true);
    assert.deepEqual(body.tenant.modules, []);
  } finally {
    await close();
  }
});

test('/auth/me: no/invalid session cookie → 401 { authenticated: false }', async () => {
  stubSession();
  const { me, close } = await boot();
  try {
    for (const cookie of [undefined, 'bad-token']) {
      const res = await me(cookie);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.authenticated, false);
    }
  } finally {
    await close();
  }
});

// --- role payload (Roles PR A) ---------------------------------------------

test('/auth/me: returns the role, super_admin flag, and the derived permissions', async () => {
  stubSession();
  stubTenant({ modules: async () => ['voice', 'tc'], role: 'hygiene' });

  const { me, close } = await boot();
  try {
    const body = await (await me('good-token')).json();
    assert.equal(body.role, 'hygiene');
    assert.equal(body.isSuperAdmin, false);
    // A hygienist reaches the TC handoff screens and the hyg module, and
    // nothing else. Spelled out rather than counted: the failure this guards
    // against is voice.read or tc.full leaking in, which a length check misses.
    assert.deepEqual(body.permissions, ['hyg.read', 'hyg.write', 'tc.hygiene']);
  } finally {
    await close();
  }
});

test('/auth/me: a super_admin reports every action', async () => {
  stubSession();
  stubTenant({ modules: async () => ['voice'], role: 'office', superAdmin: true });

  const { me, close } = await boot();
  try {
    const body = await (await me('good-token')).json();
    assert.equal(body.role, 'office');
    assert.equal(body.isSuperAdmin, true);
    assert.deepEqual(body.permissions, Object.keys(PERMISSIONS).sort());
    assert.ok(body.permissions.includes('admin.all'), 'super_admin holds admin.all even as tenant office');
  } finally {
    await close();
  }
});

test('/auth/me: a disabled account reports no role and no permissions', async () => {
  stubSession();
  stubTenant({ modules: async () => ['voice'], role: 'admin', status: 'disabled' });

  const { me, close } = await boot();
  try {
    const res = await me('good-token');
    // Still authenticated — the SESSION is valid. What they may DO is empty.
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.role, null);
    assert.deepEqual(body.permissions, []);
  } finally {
    await close();
  }
});

test('/auth/me: a control-plane failure hides everything rather than guessing', async () => {
  stubSession();
  registry.getUserByEmail = async () => {
    throw new Error('control db down');
  };

  const { me, close } = await boot();
  try {
    const res = await me('good-token');
    assert.equal(res.status, 200, 'auth status must not depend on the control DB');
    const body = await res.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.tenant, null);
    assert.equal(body.role, null);
    assert.deepEqual(body.permissions, [], 'degrade to hiding, never to allowing');
  } finally {
    await close();
  }
});
