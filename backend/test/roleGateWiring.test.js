'use strict';

/**
 * Role-gate wiring regression tests (Roles PR A).
 *
 * Two layers, mirroring moduleGateWiring.test.js:
 *
 *  1. SOURCE SCAN of server.js — the mounts that MUST carry a permission gate,
 *     the ones that must NOT (tenant-exempt: webhooks, retell-tools, health),
 *     and the two documented exemptions (mango /dev/seed, unified-calls
 *     /sync-status). This trips if a future edit drops or reorders a guard.
 *  2. BEHAVIORAL — the real tenantContext + requirePermission middlewares
 *     mounted in the same shape as server.js, over an ephemeral HTTP server,
 *     driven by a real app_user role from a stubbed registry. This is the
 *     end-to-end path a signed-in hygienist actually takes.
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
const { requirePermission, requireReadWrite } = require('../config/permissions');

// --- 1. source scan ---------------------------------------------------------

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/** Grab the whole app.use(...) call for a mount path. */
function mount(mountPath) {
  const rx = new RegExp(`app\\.use\\(\\s*'${mountPath.replace(/[/-]/g, '\\$&')}'[\\s\\S]*?\\);`);
  const m = serverSrc.match(rx);
  assert.ok(m, `server.js has no mount for ${mountPath}`);
  return m[0];
}

test('server.js: /api/admin is gated on admin.all — the one surface office does not get', () => {
  const line = mount('/api/admin');
  assert.match(line, /requirePermission\('admin\.all'\)/, `/api/admin must require admin.all: ${line}`);
});

test('server.js: every tenant-scoped voice mount carries a permission gate', () => {
  const gated = [
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
    '/api/mango/recordings',
  ];
  for (const p of gated) {
    const line = mount(p);
    assert.match(
      line,
      /requirePermission\(|requireReadWrite\(|voiceSurface/,
      `${p} serves tenant data and must carry a permission gate: ${line}`
    );
  }
});

test('server.js: tenant-exempt mounts carry NO permission gate', () => {
  // These have no user identity (HMAC-authenticated / monitors), so there is no
  // role to check. Gating them would 403 the LIVE voice agent mid-call.
  for (const p of ['/api/webhooks', '/api/retell-tools']) {
    const line = mount(p);
    assert.ok(
      !/requirePermission\(|requireReadWrite\(|voiceSurface/.test(line),
      `${p} must stay ungated (no tenant context, no role): ${line}`
    );
  }
});

test('server.js: the documented permission exemptions are present', () => {
  const mango = mount('/api/mango');
  assert.match(
    mango,
    /requireReadWrite\([\s\S]*?exempt:\s*\[\/\^\\\/dev\\\/seed\$\/\]/,
    `/api/mango must exempt the tenant-exempt dev seeder from the permission gate: ${mango}`
  );

  const unified = mount('/api/unified-calls');
  assert.match(
    unified,
    /exempt:\s*\[[\s\S]*?\/\^\\\/sync-status\$\/[\s\S]*?\]/,
    `GET /unified-calls/sync-status must stay open to any authenticated user: ${unified}`
  );
  // The office roster is the shell's own config read. A hygienist holds no
  // voice permission, so without this exemption every hygiene page renders the
  // zero-office dead end instead of the office picker.
  assert.match(
    unified,
    /exempt:\s*\[[\s\S]*?\/\^\\\/offices\$\/[\s\S]*?\]/,
    `GET /unified-calls/offices must stay open to any authenticated user: ${unified}`
  );
});

test('server.js: /api/tc mounts the TC router, whose gates live in routes/tc/index.js', () => {
  const tcIndex = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tc', 'index.js'), 'utf8');

  // Every sub-router is gated, and the tc.hygiene grant is exactly these two
  // mounts — nothing else in the TC surface may carry it.
  // Alternation order matters: the requirePermission(...) form must be tried
  // before the bare-identifier form, or [A-Za-z]+ swallows its name.
  const uses = [...tcIndex.matchAll(/router\.use\('([^']+)',\s*(requirePermission\('[^']+'\)|[A-Za-z]+)/g)];
  assert.ok(uses.length >= 13, `expected every /api/tc sub-router to be gated, saw ${uses.length}`);

  const HYGIENE_MOUNTS = ['/hygiene-intakes', '/od/patient-search'];
  for (const p of HYGIENE_MOUNTS) {
    const found = uses.find(([, mountPath]) => mountPath === p);
    assert.ok(found, `${p} must be mounted`);
    assert.equal(found[2], "requirePermission('tc.hygiene')", `${p} is the hygiene grant`);
  }

  for (const [, mountPath, guard] of uses) {
    if (HYGIENE_MOUNTS.includes(mountPath)) continue;
    assert.equal(guard, 'tcFull', `${mountPath} must be gated on tc.full, saw ${guard}`);
  }

  // Registration order is load-bearing: '/od' mounted first would swallow
  // '/od/patient-search' and put it behind tc.full.
  const searchAt = tcIndex.indexOf("router.use('/od/patient-search'");
  const odAt = tcIndex.indexOf("router.use('/od',");
  assert.ok(searchAt > -1 && odAt > -1);
  assert.ok(
    searchAt < odAt,
    '/od/patient-search must be registered BEFORE /od, or the tc.full mount captures it'
  );
});

test('routes/tc/hygiene.js: claim is the one route narrowed to tc.full', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tc', 'hygiene.js'), 'utf8');
  assert.match(
    src,
    /router\.post\(\s*'\/:caseId\/claim',\s*requirePermission\('tc\.full'\)/,
    'claiming a case out of the inbox is a TC action, not a hygiene one'
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

afterEach(() => {
  for (const k of REGISTRY_KEYS) registry[k] = original[k];
  userContext.clearCache();
});

/**
 * Boot a mini app wired exactly like server.js — real auth-less session shim,
 * real tenantContext, real module + permission guards — for a user with `role`.
 */
function bootApp({ role = 'office', status = 'active', superAdmin = false } = {}) {
  userContext.clearCache();
  registry.getUserByEmail = async () => ({
    user_id: 'U1',
    tenant_id: 'T1',
    email: 'user@carein.ai',
    role,
    status,
  });
  registry.getTenantById = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN' });
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => ['voice', 'tc'];
  registry.getPlatformAdminByEmail = async () =>
    superAdmin ? { email: 'user@carein.ai', status: 'active', created_at: new Date() } : null;
  registry.touchUserLogin = async () => {};

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { email: 'user@carein.ai', name: 'Test', tenantId: 'x' };
    next();
  });
  app.use('/api', tenantContext({ exempt: [/^\/health$/] }));

  const voiceModule = requireModule('voice');
  const voiceSurface = requireReadWrite('voice.read', 'voice.write');
  const ok = (name) => (_req, res) => res.json({ ok: true, route: name });

  app.use(
    '/api/admin',
    voiceModule,
    requirePermission('admin.all'),
    express.Router().get('/sync-status', ok('admin-sync-status')).post('/sync/stop', ok('admin-sync-stop'))
  );
  app.use(
    '/api/unified-calls',
    voiceModule,
    // Mirrors server.js exactly — the source scan above is what pins that.
    requireReadWrite('voice.read', 'voice.write', { exempt: [/^\/sync-status$/, /^\/offices$/] }),
    express
      .Router()
      .get('/', ok('list'))
      .get('/sync-status', ok('sync-status'))
      .get('/offices', ok('offices'))
      .patch('/:id/triage', ok('triage'))
      .post('/sync-now', requirePermission('voice.sync'), ok('sync-now'))
      .post('/:id/resolve-patient', requirePermission('voice.chart_write'), ok('resolve-patient'))
      .post('/:id/send-to-tc', requirePermission('voice.send_to_tc'), ok('send-to-tc'))
  );
  app.use(
    '/api/mango',
    voiceModule,
    voiceSurface,
    express.Router().post('/calls/:id/transcribe', requirePermission('voice.transcribe'), ok('transcribe'))
  );

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        get: (p) => fetch(`http://127.0.0.1:${port}${p}`),
        post: (p) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST' }),
        patch: (p) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'PATCH' }),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('office: 403 on /api/admin/sync-status, passes /api/unified-calls/sync-now', async () => {
  const app = await bootApp({ role: 'office' });
  try {
    const denied = await app.get('/api/admin/sync-status');
    assert.equal(denied.status, 403);
    const body = await denied.json();
    assert.equal(body.code, 'FORBIDDEN');
    assert.equal(body.action, 'admin.all');

    const allowed = await app.post('/api/unified-calls/sync-now');
    assert.equal(allowed.status, 200, 'office must keep the Sync Now button');
    assert.deepEqual(await allowed.json(), { ok: true, route: 'sync-now' });
  } finally {
    await app.close();
  }
});

test('admin: reaches everything, including /api/admin', async () => {
  const app = await bootApp({ role: 'admin' });
  try {
    for (const [method, p] of [
      ['get', '/api/admin/sync-status'],
      ['post', '/api/admin/sync/stop'],
      ['post', '/api/unified-calls/sync-now'],
      ['post', '/api/unified-calls/c1/resolve-patient'],
      ['post', '/api/unified-calls/c1/send-to-tc'],
      ['post', '/api/mango/calls/c1/transcribe'],
    ]) {
      const res = await app[method](p);
      assert.equal(res.status, 200, `admin should reach ${method.toUpperCase()} ${p}`);
    }
  } finally {
    await app.close();
  }
});

test('tc: reads the worklist but cannot mutate, sync, transcribe, or chart-write', async () => {
  const app = await bootApp({ role: 'tc' });
  try {
    assert.equal((await app.get('/api/unified-calls/')).status, 200, 'tc may read voice');

    for (const [method, p, action] of [
      ['patch', '/api/unified-calls/c1/triage', 'voice.write'],
      ['post', '/api/unified-calls/sync-now', 'voice.write'],
      ['post', '/api/unified-calls/c1/resolve-patient', 'voice.write'],
      ['post', '/api/mango/calls/c1/transcribe', 'voice.write'],
    ]) {
      const res = await app[method](p);
      assert.equal(res.status, 403, `tc must not ${method.toUpperCase()} ${p}`);
      // The mount-level write gate refuses first — the caller learns which
      // permission they lack, and the paid route body is never entered.
      assert.equal((await res.json()).action, action);
    }
  } finally {
    await app.close();
  }
});

test('hygiene: 403 across the whole voice surface, including /api/admin', async () => {
  const app = await bootApp({ role: 'hygiene' });
  try {
    for (const [method, p] of [
      ['get', '/api/unified-calls/'],
      ['patch', '/api/unified-calls/c1/triage'],
      ['post', '/api/unified-calls/sync-now'],
      ['post', '/api/unified-calls/c1/resolve-patient'],
      ['post', '/api/mango/calls/c1/transcribe'],
      ['get', '/api/admin/sync-status'],
    ]) {
      const res = await app[method](p);
      assert.equal(res.status, 403, `hygiene must be refused ${method.toUpperCase()} ${p}`);
    }
  } finally {
    await app.close();
  }
});

test('GET /unified-calls/sync-status stays open to every authenticated role', async () => {
  for (const role of ['admin', 'office', 'tc', 'hygiene']) {
    const app = await bootApp({ role });
    try {
      const res = await app.get('/api/unified-calls/sync-status');
      assert.equal(res.status, 200, `sync-status must stay open for ${role}`);
      assert.deepEqual(await res.json(), { ok: true, route: 'sync-status' });
    } finally {
      await app.close();
    }
  }
});

test('GET /unified-calls/offices stays open to every authenticated role', async () => {
  // The office roster is non-PHI tenant config that EVERY signed-in user's
  // shell needs before it can render anything office-scoped. Gating it on
  // voice.read is what made every hygiene page show "No offices configured".
  for (const role of ['admin', 'office', 'tc', 'hygiene']) {
    const app = await bootApp({ role });
    try {
      const res = await app.get('/api/unified-calls/offices');
      assert.equal(res.status, 200, `the office roster must stay open for ${role}`);
      assert.deepEqual(await res.json(), { ok: true, route: 'offices' });
    } finally {
      await app.close();
    }
  }
});

test('the roster exemption does NOT leak the rest of /unified-calls to hygiene', async () => {
  // An exemption is a hole in a gate; this asserts the hole is exactly one
  // path wide. If a future edit widened the regex, the worklist itself would
  // open up and this fails.
  const app = await bootApp({ role: 'hygiene' });
  try {
    assert.equal((await app.get('/api/unified-calls/offices')).status, 200);
    for (const p of ['/api/unified-calls/', '/api/unified-calls/offices-and-more']) {
      assert.equal((await app.get(p)).status, 403, `hygiene must still be refused ${p}`);
    }
  } finally {
    await app.close();
  }
});

test('a DISABLED app_user is refused everything, even with role admin on the row', async () => {
  const app = await bootApp({ role: 'admin', status: 'disabled' });
  try {
    assert.equal((await app.get('/api/unified-calls/')).status, 403);
    assert.equal((await app.get('/api/admin/sync-status')).status, 403);
    assert.equal((await app.post('/api/unified-calls/sync-now')).status, 403);
  } finally {
    await app.close();
  }
});

test('a super_admin passes every gate even when the tenant role would not', async () => {
  const app = await bootApp({ role: 'hygiene', superAdmin: true });
  try {
    for (const [method, p] of [
      ['get', '/api/admin/sync-status'],
      ['post', '/api/unified-calls/sync-now'],
      ['post', '/api/unified-calls/c1/resolve-patient'],
      ['post', '/api/mango/calls/c1/transcribe'],
    ]) {
      assert.equal((await app[method](p)).status, 200, `super_admin should reach ${p}`);
    }
  } finally {
    await app.close();
  }
});
