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
const authRouter = require('./auth');

const REGISTRY_KEYS = ['getUserByEmail', 'getTenantById', 'getTenantBySlug', 'getEnabledModules'];
const originalRegistry = {};
for (const k of REGISTRY_KEYS) originalRegistry[k] = registry[k];
const originalVerifySession = sso.verifySession;

afterEach(() => {
  for (const k of REGISTRY_KEYS) registry[k] = originalRegistry[k];
  sso.verifySession = originalVerifySession;
});

const CLAIMS = { name: 'Beau', email: 'admin@carein.ai', tid: 'entra-tid' };

function stubSession() {
  sso.verifySession = (token) => (token === 'good-token' ? CLAIMS : null);
}

function stubTenant({ modules }) {
  registry.getUserByEmail = async () => ({
    user_id: 'U1',
    tenant_id: 'T1',
    email: CLAIMS.email,
    role: 'admin',
  });
  registry.getTenantById = async () => ({
    tenant_id: 'T1',
    slug: 'carein',
    display_name: 'CareIN Dental LLC',
    status: 'active',
  });
  registry.getEnabledModules = modules;
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
