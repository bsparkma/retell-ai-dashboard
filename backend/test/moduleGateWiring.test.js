'use strict';

/**
 * Module-entitlement wiring regression tests.
 *
 * Two layers:
 *  1. SOURCE SCAN of server.js — the tenant-exempt mounts (webhooks,
 *     retell-tools) must never gain a module guard (guarding them would 403
 *     the LIVE voice agent mid-call / drop webhooks), and every tenant-scoped
 *     voice mount must carry one. This trips if a future edit reorders or
 *     forgets a guard.
 *  2. BEHAVIORAL — the real tenantContext + requireModule middlewares mounted
 *     in the same shape as server.js, over an ephemeral HTTP server: exempt
 *     routes respond without any tenant context; guarded routes 403 without
 *     entitlement and pass with it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterEach } = test;
const fs = require('node:fs');
const path = require('node:path');

const express = require('express');
const registry = require('../platform/registry');
const userContext = require('../platform/userContext');
const { tenantContext, requireModule } = require('../middleware/tenantContext');

// --- 1. source scan ---------------------------------------------------------

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/**
 * Grab the whole app.use(...) CALL for a mount path from server.js.
 *
 * Not just the first line: since Roles PR A most mounts carry a module guard
 * AND a permission guard and are wrapped across several lines, and a
 * line-limited match would silently stop seeing the guards it is here to check.
 */
function mountLine(mountPath) {
  const rx = new RegExp(`app\\.use\\(\\s*'${mountPath.replace(/[/-]/g, '\\$&')}'[\\s\\S]*?\\);`);
  const m = serverSrc.match(rx);
  assert.ok(m, `server.js has no mount for ${mountPath}`);
  return m[0];
}

test('server.js: tenant-exempt mounts carry NO module guard', () => {
  for (const p of ['/api/webhooks', '/api/retell-tools']) {
    const line = mountLine(p);
    assert.ok(
      !/requireModule|voiceModule/.test(line),
      `${p} must stay unguarded (no tenant context — guarding it breaks the live agent): ${line}`
    );
  }
});

test('server.js: every tenant-scoped voice mount carries the voice module guard', () => {
  const guarded = [
    '/api/calls',
    '/api/agents',
    '/api/opendental',
    '/api/opendental-sync',
    '/api/live-calls',
    '/api/admin',
    '/api/mango',
    '/api/callbacks',
    '/api/unified-calls',
    '/api/analytics',
    '/api/retell-tools-config',
    '/api/agent-config',
    '/api/notifications-config',
    '/api/slot-markers',
  ];
  for (const p of guarded) {
    const line = mountLine(p);
    assert.ok(
      /requireModule\('voice'|voiceModule/.test(line),
      `${p} is tenant-scoped voice product and must be guarded: ${line}`
    );
  }
});

test('server.js: every non-voice module mount carries its OWN module guard', () => {
  // These were missing from the scan above, which only knew about voice. A
  // module mount with no guard is entitlement bypass for that whole product.
  const guarded = [
    { mount: '/api/tc', module: 'tc' },
    { mount: '/api/rcm', module: 'rcm' },
    { mount: '/api/hyg', module: 'hyg' },
  ];
  for (const { mount, module } of guarded) {
    const line = mountLine(mount);
    assert.ok(
      new RegExp(`requireModule\\('${module}'\\)`).test(line),
      `${mount} must be guarded by requireModule('${module}'): ${line}`
    );
  }
});

test('server.js: /api/platform carries the platform gate and NO module guard', () => {
  const line = mountLine('/api/platform');
  // Circular otherwise: the console is the surface that decides which modules a
  // practice has, so it cannot itself be gated on having one.
  assert.ok(
    !/requireModule|voiceModule/.test(line),
    `/api/platform must carry no module guard — it is the surface that sets entitlements: ${line}`
  );
  // Tenant 'admin' is not enough, and requireSuperAdmin() additionally refuses
  // the shared machine token (config/permissions.js).
  assert.ok(
    /requireSuperAdmin\(\)/.test(line),
    `/api/platform must be behind requireSuperAdmin(): ${line}`
  );
});

test("server.js: /api/mango guard exempts the tenant-exempt dev seeder", () => {
  const line = mountLine('/api/mango');
  assert.ok(
    /exempt:\s*\[\/\^\\\/dev\\\/seed\$\/\]/.test(line),
    `/api/mango must exempt /dev/seed from the module guard: ${line}`
  );
});

// --- 2. behavioral ----------------------------------------------------------

const REGISTRY_KEYS = [
  'getUserByEmail',
  'getTenantById',
  'getTenantClinics',
  'getEnabledModules',
  'getPlatformAdminByEmail',
  'touchUserLogin',
];
const original = {};
for (const k of REGISTRY_KEYS) original[k] = registry[k];

// Roles PR A: the identity read is cached process-wide and now also asks
// platform_admin. Both need resetting or one test's user answers the next.
test.beforeEach(() => {
  userContext.clearCache();
  registry.getPlatformAdminByEmail = async () => null;
  registry.touchUserLogin = async () => {};
});

afterEach(() => {
  for (const k of REGISTRY_KEYS) registry[k] = original[k];
  userContext.clearCache();
});

/** Boot a mini app wired like server.js and return { baseUrl, close }. */
function bootApp() {
  const app = express();

  // Same exemption shape as server.js (auth gate omitted — not under test).
  app.use(
    '/api',
    tenantContext({
      exempt: [/^\/webhooks(\/|$)/, /^\/health$/, /^\/retell-tools(\/|$)/, /^\/mango\/dev\/seed$/],
    })
  );

  const ok = (name) => (_req, res) => res.json({ ok: true, route: name });

  app.use('/api/webhooks', express.Router().post('/retell', ok('webhooks')).get('/retell', ok('webhooks')));
  app.use('/api/retell-tools', express.Router().get('/health', ok('retell-tools')));
  app.use('/api/calls', requireModule('voice'), express.Router().get('/', ok('calls')));
  app.use(
    '/api/mango',
    requireModule('voice', { exempt: [/^\/dev\/seed$/] }),
    express.Router().post('/dev/seed', ok('mango-dev-seed'))
  );

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Fake an authenticated user upstream of tenantContext. */
function bootAppWithUser(user, modules) {
  registry.getUserByEmail = async () => ({ user_id: 'U1', tenant_id: 'T1', email: user.email, role: 'admin' });
  registry.getTenantById = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN', status: 'active' });
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => modules;

  const app = express();
  app.use('/api', (req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api', tenantContext({ exempt: [/^\/webhooks(\/|$)/, /^\/retell-tools(\/|$)/] }));
  app.use('/api/calls', requireModule('voice'), express.Router().get('/', (_req, res) => res.json({ ok: true })));

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('exempt routes respond WITHOUT any tenant context (webhooks, retell-tools, mango dev seed)', async () => {
  registry.getUserByEmail = async () => {
    throw new Error('exempt paths must never hit the registry');
  };
  const { baseUrl, close } = await bootApp();
  try {
    const webhook = await fetch(`${baseUrl}/api/webhooks/retell`, { method: 'POST' });
    assert.equal(webhook.status, 200);

    const tools = await fetch(`${baseUrl}/api/retell-tools/health`);
    assert.equal(tools.status, 200);

    const seed = await fetch(`${baseUrl}/api/mango/dev/seed`, { method: 'POST' });
    assert.equal(seed.status, 200);
  } finally {
    await close();
  }
});

test('guarded route without tenant context → 403 (not 500, not pass-through)', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const res = await fetch(`${baseUrl}/api/calls`);
    assert.equal(res.status, 403); // tenantContext fails closed before the guard
    const body = await res.json();
    assert.equal(body.success, false);
  } finally {
    await close();
  }
});

test('guarded route: entitled tenant passes, unentitled tenant gets MODULE_NOT_ENTITLED', async () => {
  const user = { email: 'admin@carein.ai', tenantId: 'x' };

  const entitled = await bootAppWithUser(user, ['voice']);
  try {
    const res = await fetch(`${entitled.baseUrl}/api/calls`);
    assert.equal(res.status, 200);
  } finally {
    await entitled.close();
  }

  const unentitled = await bootAppWithUser(user, ['tc']); // has a tenant, lacks voice
  try {
    const res = await fetch(`${unentitled.baseUrl}/api/calls`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'MODULE_NOT_ENTITLED');
    assert.equal(body.module, 'voice');
  } finally {
    await unentitled.close();
  }
});
