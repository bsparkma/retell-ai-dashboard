'use strict';

/**
 * /api/users — tenant user management (Roles PR B).
 *
 * The guards are the point of this suite. Every one of them is reachable by
 * hand-crafting a request, so each is tested at the API, not at the UI: the
 * last-admin rule, the platform-admin protection, the self-change refusal, and
 * the audit row that must accompany every write (including the refused ones —
 * an attempt to demote the last admin is exactly the event you want recorded).
 *
 * The router is mounted over an in-memory registry double, in the same shape
 * server.js mounts it (permission gate above, tenant context already attached).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const express = require('express');

const registry = require('../platform/registry');
const auditModule = require('../platform/audit');
const userContext = require('../platform/userContext');
const { requirePermission } = require('../config/permissions');

const TENANT = 'T1';

// --- in-memory app_user ----------------------------------------------------

/** @type {Array<{ user_id: string, tenant_id: string, email: string, role: string, status: string, last_login_at: Date|null }>} */
let rows = [];
/** @type {Array<{ action: string, resourceType: string, resourceId: string, result: string }>} */
let auditRows = [];
/** @type {Set<string>} emails that are active platform admins */
let platformAdmins = new Set();

const REGISTRY_KEYS = [
  'listTenantUsers',
  'getTenantUser',
  'createTenantUser',
  'updateTenantUser',
  'countActiveTenantAdmins',
  'getPlatformAdminByEmail',
];
const original = {};
for (const k of REGISTRY_KEYS) original[k] = registry[k];
const originalAudit = auditModule.audit;

function activeAdmins() {
  return rows.filter((r) => r.role === 'admin' && r.status === 'active').length;
}

beforeEach(() => {
  rows = [
    { user_id: 'U1', tenant_id: TENANT, email: 'boss@carein.ai', role: 'admin', status: 'active', last_login_at: new Date('2026-08-10T12:00:00Z') },
    { user_id: 'U2', tenant_id: TENANT, email: 'front@carein.ai', role: 'office', status: 'active', last_login_at: null },
    { user_id: 'U3', tenant_id: TENANT, email: 'hyg@carein.ai', role: 'hygiene', status: 'active', last_login_at: null },
  ];
  auditRows = [];
  platformAdmins = new Set();

  registry.listTenantUsers = async (tenantId) => rows.filter((r) => r.tenant_id === tenantId);
  registry.getTenantUser = async (tenantId, email) =>
    rows.find((r) => r.tenant_id === tenantId && r.email.toLowerCase() === email.toLowerCase()) || null;
  registry.countActiveTenantAdmins = async () => activeAdmins();
  registry.getPlatformAdminByEmail = async (email) =>
    platformAdmins.has(String(email).toLowerCase())
      ? { email: String(email).toLowerCase(), status: 'active', created_at: new Date() }
      : null;

  registry.createTenantUser = async (tenantId, email, role) => {
    const lower = String(email).toLowerCase();
    if (rows.some((r) => r.tenant_id === tenantId && r.email === lower)) return null;
    const row = { user_id: `U${rows.length + 1}`, tenant_id: tenantId, email: lower, role, status: 'active', last_login_at: null };
    rows.push(row);
    return row;
  };

  // Mirrors the SQL guard: the write matches nothing when it would remove the
  // tenant's last active admin.
  registry.updateTenantUser = async (tenantId, email, patch) => {
    const row = rows.find(
      (r) => r.tenant_id === tenantId && r.email.toLowerCase() === String(email).toLowerCase()
    );
    if (!row) return null;
    const losesAdmin =
      (typeof patch.role === 'string' && patch.role !== 'admin') ||
      (typeof patch.status === 'string' && patch.status !== 'active');
    if (losesAdmin && row.role === 'admin' && row.status === 'active' && activeAdmins() <= 1) {
      return null;
    }
    if (typeof patch.role === 'string') row.role = patch.role;
    if (typeof patch.status === 'string') row.status = patch.status;
    // home_office is present-and-null when it is being CLEARED, so the check is
    // key PRESENCE, not truthiness — mirrors the real SQL builder.
    if ('home_office' in patch) row.home_office = patch.home_office;
    return row;
  };

  auditModule.audit = async (_req, entry) => {
    auditRows.push(entry);
  };
});

afterEach(() => {
  for (const k of REGISTRY_KEYS) registry[k] = original[k];
  auditModule.audit = originalAudit;
  userContext.clearCache();
});

// --- harness ---------------------------------------------------------------

/**
 * Mount /api/users the way server.js does: the permission gate above it, with
 * tenant context and role already attached by the (unmounted) upstream.
 */
function boot({ role = 'admin', isSuperAdmin = false, actor = 'boss@carein.ai' } = {}) {
  // Required lazily so the beforeEach stubs are in place first.
  const usersRouter = require('./users');

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { email: actor, name: 'Test' };
    req.tenant = { id: TENANT, slug: 'carein', modules: ['voice'], clinics: [] };
    req.userRole = role;
    req.isSuperAdmin = isSuperAdmin;
    next();
  });
  app.use('/api/users', requirePermission('admin.all'), usersRouter);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const call = async (method, path, body) => {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      };
      resolve({
        get: (p) => call('GET', p),
        post: (p, b) => call('POST', p, b),
        patch: (p, b) => call('PATCH', p, b),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// --- listing ----------------------------------------------------------------

test('GET /: an admin sees the tenant roster, the role vocabulary, and their own address', async () => {
  const app = await boot();
  try {
    const res = await app.get('/api/users');
    assert.equal(res.status, 200);
    assert.equal(res.body.users.length, 3);
    assert.deepEqual(
      res.body.users.map((u) => u.email),
      ['boss@carein.ai', 'front@carein.ai', 'hyg@carein.ai']
    );
    assert.deepEqual(res.body.roles, ['admin', 'office', 'tc', 'hygiene', 'billing']);
    assert.equal(res.body.actor, 'boss@carein.ai');
    // last_login_at is surfaced as an ISO string or null — never a raw Date.
    assert.equal(typeof res.body.users[0].lastLoginAt, 'string');
    assert.equal(res.body.users[1].lastLoginAt, null);
  } finally {
    await app.close();
  }
});

test('GET /: a non-admin is refused by the mount gate', async () => {
  for (const role of ['office', 'tc', 'hygiene']) {
    const app = await boot({ role });
    try {
      const res = await app.get('/api/users');
      assert.equal(res.status, 403, `${role} must not list users`);
      assert.equal(res.body.code, 'FORBIDDEN');
      assert.equal(res.body.action, 'admin.all');
    } finally {
      await app.close();
    }
  }
});

test('GET /: a super_admin passes even with a non-admin tenant role', async () => {
  const app = await boot({ role: 'hygiene', isSuperAdmin: true });
  try {
    assert.equal((await app.get('/api/users')).status, 200);
  } finally {
    await app.close();
  }
});

// --- create -----------------------------------------------------------------

test('POST /: creates a row, lowercases the email, and audits CREATE', async () => {
  const app = await boot();
  try {
    const res = await app.post('/api/users', { email: '  NewHire@CareIN.ai ', role: 'hygiene' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, 'newhire@carein.ai');
    assert.equal(res.body.user.role, 'hygiene');
    assert.equal(res.body.user.status, 'active');
    assert.equal(res.body.user.lastLoginAt, null, 'a pre-provisioned row has never signed in');

    assert.equal(auditRows.length, 1);
    assert.deepEqual(auditRows[0], {
      action: 'CREATE',
      resourceType: 'app_user',
      resourceId: 'newhire@carein.ai',
      result: 'SUCCESS',
    });
  } finally {
    await app.close();
  }
});

test('POST /: rejects a bad email and an unknown role before touching the DB', async () => {
  const app = await boot();
  try {
    const badEmail = await app.post('/api/users', { email: 'not-an-email', role: 'office' });
    assert.equal(badEmail.status, 400);
    assert.equal(badEmail.body.code, 'INVALID_EMAIL');

    const badRole = await app.post('/api/users', { email: 'a@carein.ai', role: 'superuser' });
    assert.equal(badRole.status, 400);
    assert.equal(badRole.body.code, 'INVALID_ROLE');

    assert.equal(rows.length, 3, 'nothing was written');
    assert.equal(auditRows.length, 0);
  } finally {
    await app.close();
  }
});

test('POST /: a duplicate is a 409, not a silent overwrite of somebody\'s role', async () => {
  const app = await boot();
  try {
    const res = await app.post('/api/users', { email: 'hyg@carein.ai', role: 'admin' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'USER_EXISTS');
    assert.equal(rows.find((r) => r.email === 'hyg@carein.ai').role, 'hygiene', 'unchanged');
  } finally {
    await app.close();
  }
});

test('POST /: a domain that is not the tenant\'s is ACCEPTED (the UI warns, the API does not block)', async () => {
  const app = await boot();
  try {
    const res = await app.post('/api/users', { email: 'contractor@example.com', role: 'office' });
    assert.equal(res.status, 201, 'practices hire people with other addresses');
  } finally {
    await app.close();
  }
});

// --- update -----------------------------------------------------------------

test('PATCH /:email: changes a role and audits UPDATE', async () => {
  const app = await boot();
  try {
    const res = await app.patch('/api/users/hyg@carein.ai', { role: 'tc' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'tc');
    assert.deepEqual(auditRows, [
      { action: 'UPDATE', resourceType: 'app_user', resourceId: 'hyg@carein.ai', result: 'SUCCESS' },
    ]);
  } finally {
    await app.close();
  }
});

test('PATCH /:email: deactivate and reactivate round-trip', async () => {
  const app = await boot();
  try {
    assert.equal((await app.patch('/api/users/front@carein.ai', { status: 'disabled' })).body.user.status, 'disabled');
    assert.equal((await app.patch('/api/users/front@carein.ai', { status: 'active' })).body.user.status, 'active');
  } finally {
    await app.close();
  }
});

test('PATCH /:email: an unknown user is 404, and nothing is audited', async () => {
  const app = await boot();
  try {
    const res = await app.patch('/api/users/ghost@carein.ai', { role: 'office' });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'USER_NOT_FOUND');
    assert.equal(auditRows.length, 0);
  } finally {
    await app.close();
  }
});

test('PATCH /:email: an empty patch is refused rather than treated as a no-op success', async () => {
  const app = await boot();
  try {
    const res = await app.patch('/api/users/front@carein.ai', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'EMPTY_PATCH');
  } finally {
    await app.close();
  }
});

// --- GUARD: last admin -------------------------------------------------------

test('GUARD last-admin: the only active admin cannot be demoted', async () => {
  // Acting as somebody else, so this isolates the last-admin rule from the
  // self-change rule (which would fire first if boss@ demoted boss@).
  const app = await boot({ actor: 'other@carein.ai' });
  try {
    const res = await app.patch('/api/users/boss@carein.ai', { role: 'office' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'LAST_ADMIN');
    assert.equal(res.body.activeAdmins, 1);
    assert.equal(rows[0].role, 'admin', 'unchanged');
    // The ATTEMPT is audited — this is precisely the event worth having a
    // record of.
    assert.deepEqual(auditRows, [
      { action: 'UPDATE', resourceType: 'app_user', resourceId: 'boss@carein.ai', result: 'UNAUTHORIZED' },
    ]);
  } finally {
    await app.close();
  }
});

test('GUARD last-admin: the only active admin cannot be deactivated either', async () => {
  const app = await boot({ actor: 'other@carein.ai' });
  try {
    const res = await app.patch('/api/users/boss@carein.ai', { status: 'disabled' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'LAST_ADMIN');
  } finally {
    await app.close();
  }
});

test('GUARD last-admin: with a SECOND admin, demoting the first is allowed', async () => {
  rows.push({ user_id: 'U4', tenant_id: TENANT, email: 'second@carein.ai', role: 'admin', status: 'active', last_login_at: null });
  const app = await boot({ actor: 'second@carein.ai' });
  try {
    const res = await app.patch('/api/users/boss@carein.ai', { role: 'office' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'office');
  } finally {
    await app.close();
  }
});

test('GUARD last-admin: a DISABLED admin does not count toward the minimum', async () => {
  rows.push({ user_id: 'U4', tenant_id: TENANT, email: 'onleave@carein.ai', role: 'admin', status: 'disabled', last_login_at: null });
  const app = await boot({ actor: 'other@carein.ai' });
  try {
    const res = await app.patch('/api/users/boss@carein.ai', { role: 'office' });
    assert.equal(res.status, 409, 'a disabled admin cannot administer anything');
    assert.equal(res.body.code, 'LAST_ADMIN');
  } finally {
    await app.close();
  }
});

// --- GUARD: platform admin ---------------------------------------------------

test('GUARD platform-admin: a tenant admin cannot touch a platform admin\'s row', async () => {
  platformAdmins.add('front@carein.ai');
  const app = await boot({ role: 'admin', isSuperAdmin: false });
  try {
    const res = await app.patch('/api/users/front@carein.ai', { status: 'disabled' });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'PLATFORM_ADMIN_PROTECTED');
    assert.equal(rows[1].status, 'active', 'unchanged');
    assert.equal(auditRows[0].result, 'UNAUTHORIZED');
  } finally {
    await app.close();
  }
});

test('GUARD platform-admin: a SUPER admin can', async () => {
  platformAdmins.add('front@carein.ai');
  const app = await boot({ role: 'admin', isSuperAdmin: true, actor: 'beau@carein.ai' });
  try {
    const res = await app.patch('/api/users/front@carein.ai', { status: 'disabled' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.status, 'disabled');
  } finally {
    await app.close();
  }
});

// --- GUARD: self -------------------------------------------------------------

test('GUARD self: an admin cannot change their own role', async () => {
  rows.push({ user_id: 'U4', tenant_id: TENANT, email: 'second@carein.ai', role: 'admin', status: 'active', last_login_at: null });
  const app = await boot({ actor: 'boss@carein.ai' });
  try {
    const res = await app.patch('/api/users/boss@carein.ai', { role: 'office' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'SELF_ROLE_CHANGE');
    assert.equal(rows[0].role, 'admin');
  } finally {
    await app.close();
  }
});

test('GUARD self: an admin cannot deactivate themselves', async () => {
  rows.push({ user_id: 'U4', tenant_id: TENANT, email: 'second@carein.ai', role: 'admin', status: 'active', last_login_at: null });
  const app = await boot({ actor: 'boss@carein.ai' });
  try {
    const res = await app.patch('/api/users/boss@carein.ai', { status: 'disabled' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'SELF_DEACTIVATE');
  } finally {
    await app.close();
  }
});

test('GUARD self: the check is case-insensitive on the address', async () => {
  rows.push({ user_id: 'U4', tenant_id: TENANT, email: 'second@carein.ai', role: 'admin', status: 'active', last_login_at: null });
  const app = await boot({ actor: 'BOSS@CareIN.ai' });
  try {
    const res = await app.patch('/api/users/boss@carein.ai', { role: 'office' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'SELF_ROLE_CHANGE');
  } finally {
    await app.close();
  }
});

test('GUARD self: REACTIVATING yourself is not blocked (it cannot lock anyone out)', async () => {
  rows[0].status = 'active';
  rows.push({ user_id: 'U4', tenant_id: TENANT, email: 'second@carein.ai', role: 'admin', status: 'active', last_login_at: null });
  const app = await boot({ actor: 'boss@carein.ai' });
  try {
    const res = await app.patch('/api/users/boss@carein.ai', { status: 'active' });
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});

// --- home office ------------------------------------------------------------
//
// A DEFAULT, not a restriction: it seeds someone's office picker and nothing
// else. Nothing below grants or denies access on the strength of it — the tests
// are about who may SET it and what values are accepted.

test('home office: an admin can set it, and it comes back on the row', async () => {
  const app = await boot();
  try {
    const res = await app.patch('/api/users/front@carein.ai', { homeOffice: 'valley' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.homeOffice, 'valley');

    const list = await app.get('/api/users');
    assert.equal(list.body.users.find((u) => u.email === 'front@carein.ai').homeOffice, 'valley');
  } finally {
    await app.close();
  }
});

test('home office: GET / carries the office roster so the picker never hardcodes it', async () => {
  const app = await boot();
  try {
    const res = await app.get('/api/users');
    assert.ok(Array.isArray(res.body.offices), 'the page must not invent the office list');
    const ids = res.body.offices.map((o) => o.officeId);
    assert.ok(ids.includes('roland') && ids.includes('valley'));
    // 'unknown' is the system bucket for unmapped phone lines, not a place
    // anybody works. Offering it would let an admin assign a home office that
    // resolves to no practice at all.
    assert.ok(!ids.includes('unknown'), `the unmapped bucket is not an office: ${ids.join()}`);
  } finally {
    await app.close();
  }
});

test('home office: an unknown office key is refused, and nothing is written', async () => {
  const app = await boot();
  try {
    for (const bad of ['sneaky', 'unknown', 'ROLAND', 'roland ']) {
      const res = await app.patch('/api/users/front@carein.ai', { homeOffice: bad });
      assert.equal(res.status, 400, `'${bad}' must be refused`);
      assert.equal(res.body.code, 'INVALID_HOME_OFFICE');
    }
    assert.equal(rows.find((r) => r.email === 'front@carein.ai').home_office, undefined);
  } finally {
    await app.close();
  }
});

test('home office: null clears it — temp accounts are meant to have none', async () => {
  const app = await boot();
  try {
    await app.patch('/api/users/hyg@carein.ai', { homeOffice: 'roland' });
    const cleared = await app.patch('/api/users/hyg@carein.ai', { homeOffice: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.user.homeOffice, null);
  } finally {
    await app.close();
  }
});

test('home office: setting it alone is a valid patch (not an EMPTY_PATCH)', async () => {
  const app = await boot();
  try {
    const res = await app.patch('/api/users/front@carein.ai', { homeOffice: 'roland' });
    assert.notEqual(res.body.code, 'EMPTY_PATCH');
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});

test('home office: the change is audited like a role change', async () => {
  const app = await boot();
  try {
    await app.patch('/api/users/front@carein.ai', { homeOffice: 'valley' });
    const row = auditRows.find((r) => r.resourceType === 'app_user' && r.result === 'SUCCESS');
    assert.ok(row, 'a home-office change must leave a trail');
    assert.equal(row.action, 'UPDATE');
    assert.equal(row.resourceId, 'front@carein.ai');
  } finally {
    await app.close();
  }
});

test('home office: a non-admin cannot set anyone’s — including their own', async () => {
  for (const role of ['office', 'tc', 'hygiene']) {
    const app = await boot({ role, actor: 'front@carein.ai' });
    try {
      const other = await app.patch('/api/users/hyg@carein.ai', { homeOffice: 'valley' });
      assert.equal(other.status, 403, `${role} must not set another person's home office`);
      const self = await app.patch('/api/users/front@carein.ai', { homeOffice: 'valley' });
      assert.equal(self.status, 403, `${role} must not reach /api/users at all`);
    } finally {
      await app.close();
    }
  }
});

test('home office: setting it on YOURSELF is allowed — it locks nobody out', async () => {
  // Unlike role and status, a home office cannot strand anyone: it only seeds a
  // picker that still offers every office. The self-change guard must not
  // spread to it.
  const app = await boot({ actor: 'boss@carein.ai' });
  try {
    const res = await app.patch('/api/users/boss@carein.ai', { homeOffice: 'roland' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.homeOffice, 'roland');
  } finally {
    await app.close();
  }
});
