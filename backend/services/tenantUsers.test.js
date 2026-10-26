'use strict';

/**
 * services/tenantUsers.js — the ONE user-management rule set behind both doors
 * (/api/users for a practice admin, /api/platform/practices/:tenantId/users for
 * a super_admin).
 *
 * The route suites (routes/users.test.js, routes/platform.test.js) prove each
 * door is wired; this suite proves the rules themselves, with no HTTP in the
 * way: last admin, platform admin, self, tenant scope — and the two cross-tenant
 * cases that only exist now that there are two doors: a super_admin acting on a
 * SECOND practice, and a tenant admin who cannot reach one.
 *
 * Synthetic addresses only (*.example.test).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const registry = require('../platform/registry');
const userContext = require('../platform/userContext');
const tenantUsers = require('./tenantUsers');

const T1 = 'tenant-one';
const T2 = 'tenant-two';

const ADMIN_1 = 'person.one@example.test';
const OFFICE_1 = 'person.two@example.test';
const ADMIN_2 = 'person.three@example.test';
const HYG_2 = 'person.four@example.test';
const OPERATOR = 'operator@example.test';

/** @type {Array<{ tenant_id: string, email: string, role: string, status: string, last_login_at: Date|null, home_office: string|null }>} */
let rows;
/** @type {Array<{ tenantId: string, action: string, resourceType: string, resourceId: string, result: string }>} */
let auditRows;
let platformAdmins;
let cacheClears;

const REGISTRY_KEYS = [
  'listTenantUsers',
  'getTenantUser',
  'createTenantUser',
  'updateTenantUser',
  'countActiveTenantAdmins',
  'getPlatformAdminByEmail',
];
const saved = {};
for (const k of REGISTRY_KEYS) saved[k] = registry[k];
const savedClearCache = userContext.clearCache;

const activeAdmins = (tenantId) =>
  rows.filter((r) => r.tenant_id === tenantId && r.role === 'admin' && r.status === 'active').length;
const find = (tenantId, email) =>
  rows.find((r) => r.tenant_id === tenantId && r.email === String(email).toLowerCase()) || null;

beforeEach(() => {
  rows = [
    { tenant_id: T1, email: ADMIN_1, role: 'admin', status: 'active', last_login_at: new Date('2026-09-01T12:00:00Z'), home_office: 'roland' },
    { tenant_id: T1, email: OFFICE_1, role: 'office', status: 'active', last_login_at: null, home_office: null },
    { tenant_id: T2, email: ADMIN_2, role: 'admin', status: 'active', last_login_at: null, home_office: null },
    { tenant_id: T2, email: HYG_2, role: 'hygiene', status: 'active', last_login_at: null, home_office: null },
  ];
  auditRows = [];
  platformAdmins = new Set();
  cacheClears = 0;

  // Every stub filters by tenant_id, mirroring the WHERE tenant_id = $1 the
  // real SQL carries. Rule 4 is the SQL's job; these doubles must not be more
  // forgiving than it is.
  registry.listTenantUsers = async (tenantId) => rows.filter((r) => r.tenant_id === tenantId);
  registry.getTenantUser = async (tenantId, email) => find(tenantId, email);
  registry.countActiveTenantAdmins = async (tenantId) => activeAdmins(tenantId);
  registry.getPlatformAdminByEmail = async (email) =>
    platformAdmins.has(email) ? { email, status: 'active' } : null;
  registry.createTenantUser = async (tenantId, email, role, homeOffice = null) => {
    if (find(tenantId, email)) return null;
    const row = { tenant_id: tenantId, email: email.toLowerCase(), role, status: 'active', last_login_at: null, home_office: homeOffice };
    rows.push(row);
    return row;
  };
  registry.updateTenantUser = async (tenantId, email, patch) => {
    const row = find(tenantId, email);
    if (!row) return null;
    const losesAdmin =
      (typeof patch.role === 'string' && patch.role !== 'admin') ||
      (typeof patch.status === 'string' && patch.status !== 'active');
    if (losesAdmin && row.role === 'admin' && row.status === 'active' && activeAdmins(tenantId) <= 1) {
      return null;
    }
    if (typeof patch.role === 'string') row.role = patch.role;
    if (typeof patch.status === 'string') row.status = patch.status;
    if ('home_office' in patch) row.home_office = patch.home_office;
    return row;
  };
  userContext.clearCache = () => {
    cacheClears += 1;
  };
});

afterEach(() => {
  for (const k of REGISTRY_KEYS) registry[k] = saved[k];
  userContext.clearCache = savedClearCache;
});

/** An audit writer bound to one tenant's log, as each door builds it. */
const auditInto = (tenantId) => async (entry) => {
  auditRows.push({ tenantId, ...entry });
};

const tenantAdmin = { email: ADMIN_1, isSuperAdmin: false };
const superAdmin = { email: OPERATOR, isSuperAdmin: true };

const update = (tenantId, actor, email, body) =>
  tenantUsers.updateUser({ tenantId, actor, audit: auditInto(tenantId), email, body });
const create = (tenantId, actor, fields) =>
  tenantUsers.createUser({ tenantId, actor, audit: auditInto(tenantId), ...fields });

// --- list -------------------------------------------------------------------

test('list: one tenant only, with the role and office vocabularies and the actor', async () => {
  const roster = await tenantUsers.listUsers(T1, tenantAdmin);
  assert.deepEqual(roster.users.map((u) => u.email), [ADMIN_1, OFFICE_1]);
  assert.deepEqual(roster.users[0], {
    email: ADMIN_1,
    role: 'admin',
    status: 'active',
    lastLoginAt: '2026-09-01T12:00:00.000Z',
    homeOffice: 'roland',
  });
  assert.ok(roster.roles.includes('admin'));
  assert.ok(roster.offices.every((o) => o.officeId !== 'unknown'), 'the unmapped bucket is not an office');
  assert.equal(roster.actor, ADMIN_1);
});

// --- create -----------------------------------------------------------------

test('create: lowercases, audits CREATE into the given log, clears the role cache', async () => {
  const out = await create(T1, tenantAdmin, { email: ' New.Person@Example.Test ', role: 'tc' });
  assert.equal(out.ok, true);
  assert.equal(out.status, 201);
  assert.equal(out.user.email, 'new.person@example.test');
  assert.equal(out.user.homeOffice, null);
  assert.deepEqual(auditRows, [
    { tenantId: T1, action: 'CREATE', resourceType: 'app_user', resourceId: 'new.person@example.test', result: 'SUCCESS' },
  ]);
  assert.equal(cacheClears, 1);
});

test('create: bad email, bad role, bad home office are refused before any write', async () => {
  const before = rows.length;
  assert.equal((await create(T1, tenantAdmin, { email: 'nope', role: 'office' })).code, 'INVALID_EMAIL');
  assert.equal((await create(T1, tenantAdmin, { email: 'a@example.test', role: 'owner' })).code, 'INVALID_ROLE');
  assert.equal(
    (await create(T1, tenantAdmin, { email: 'a@example.test', role: 'office', homeOffice: 'unknown' })).code,
    'INVALID_HOME_OFFICE'
  );
  assert.equal(rows.length, before);
  assert.equal(auditRows.length, 0);
});

test('create: a home office can be set at create time when the door offers one', async () => {
  const out = await create(T2, superAdmin, { email: 'new.hire@example.test', role: 'office', homeOffice: 'valley' });
  assert.equal(out.ok, true);
  assert.equal(out.user.homeOffice, 'valley');
});

test('create: a duplicate is a 409 USER_EXISTS and writes no audit row', async () => {
  const out = await create(T1, tenantAdmin, { email: OFFICE_1, role: 'admin' });
  assert.equal(out.status, 409);
  assert.equal(out.code, 'USER_EXISTS');
  assert.equal(find(T1, OFFICE_1).role, 'office', 'an existing role is never overwritten');
  assert.equal(auditRows.length, 0);
});

test('create: a failed audit write propagates — fail closed', async () => {
  await assert.rejects(
    tenantUsers.createUser({
      tenantId: T1,
      actor: tenantAdmin,
      audit: async () => {
        throw new Error('audit store down');
      },
      email: 'x@example.test',
      role: 'office',
    }),
    /audit store down/
  );
  assert.equal(cacheClears, 0, 'a write nobody can see in the trail is not reported as applied');
});

// --- update: shape ----------------------------------------------------------

test('update: an empty patch is EMPTY_PATCH; unknown values are refused', async () => {
  assert.equal((await update(T1, tenantAdmin, OFFICE_1, {})).code, 'EMPTY_PATCH');
  assert.equal((await update(T1, tenantAdmin, OFFICE_1, { role: 'owner' })).code, 'INVALID_ROLE');
  assert.equal((await update(T1, tenantAdmin, OFFICE_1, { status: 'gone' })).code, 'INVALID_STATUS');
  assert.equal((await update(T1, tenantAdmin, OFFICE_1, { homeOffice: 'mars' })).code, 'INVALID_HOME_OFFICE');
  assert.equal(auditRows.length, 0);
});

test('update: success audits UPDATE and clears the cache; null home office clears it', async () => {
  const out = await update(T1, tenantAdmin, OFFICE_1, { role: 'tc', homeOffice: 'valley' });
  assert.equal(out.ok, true);
  assert.equal(out.user.role, 'tc');
  assert.equal(out.user.homeOffice, 'valley');
  assert.equal((await update(T1, tenantAdmin, OFFICE_1, { homeOffice: null })).user.homeOffice, null);
  assert.deepEqual(auditRows.map((r) => r.result), ['SUCCESS', 'SUCCESS']);
  assert.equal(cacheClears, 2);
});

test('update: an unknown user is 404 and nothing is audited', async () => {
  const out = await update(T1, tenantAdmin, 'nobody@example.test', { role: 'tc' });
  assert.equal(out.status, 404);
  assert.equal(out.code, 'USER_NOT_FOUND');
  assert.equal(auditRows.length, 0);
});

// --- rule 1: last admin -----------------------------------------------------

test('RULE last-admin: the only active admin cannot be demoted or disabled — even by a super_admin', async () => {
  for (const body of [{ role: 'office' }, { status: 'disabled' }]) {
    const out = await update(T1, superAdmin, ADMIN_1, body);
    assert.equal(out.status, 409);
    assert.equal(out.code, 'LAST_ADMIN');
    assert.deepEqual(out.extra, { activeAdmins: 1 });
  }
  assert.equal(find(T1, ADMIN_1).role, 'admin');
  assert.equal(find(T1, ADMIN_1).status, 'active');
  assert.deepEqual(auditRows.map((r) => r.result), ['UNAUTHORIZED', 'UNAUTHORIZED'], 'refusals are recorded');
});

test('RULE last-admin: with a second admin, the first can be demoted', async () => {
  find(T1, OFFICE_1).role = 'admin';
  const out = await update(T1, superAdmin, ADMIN_1, { role: 'office' });
  assert.equal(out.ok, true);
});

// --- rule 2: platform admin -------------------------------------------------

test('RULE platform-admin: a tenant admin cannot touch a platform admin row; a super_admin can', async () => {
  platformAdmins.add(OFFICE_1);
  const refused = await update(T1, tenantAdmin, OFFICE_1, { status: 'disabled' });
  assert.equal(refused.status, 403);
  assert.equal(refused.code, 'PLATFORM_ADMIN_PROTECTED');
  assert.equal(find(T1, OFFICE_1).status, 'active');

  const allowed = await update(T1, superAdmin, OFFICE_1, { status: 'disabled' });
  assert.equal(allowed.ok, true);
});

// --- rule 3: self -----------------------------------------------------------

test('RULE self: no own role change, no self-deactivate; reactivate and home office are fine', async () => {
  assert.equal((await update(T1, tenantAdmin, ADMIN_1, { role: 'office' })).code, 'SELF_ROLE_CHANGE');
  assert.equal((await update(T1, tenantAdmin, ADMIN_1.toUpperCase(), { status: 'disabled' })).code, 'SELF_DEACTIVATE');
  assert.equal((await update(T1, tenantAdmin, ADMIN_1, { status: 'active' })).ok, true);
  assert.equal((await update(T1, tenantAdmin, ADMIN_1, { homeOffice: 'valley' })).ok, true);
});

test('RULE self: binds a super_admin too, on a practice where they have a row', async () => {
  rows.push({ tenant_id: T2, email: OPERATOR, role: 'admin', status: 'active', last_login_at: null, home_office: null });
  const out = await update(T2, superAdmin, OPERATOR, { role: 'office' });
  assert.equal(out.code, 'SELF_ROLE_CHANGE');
});

// --- rule 4: tenant scope ---------------------------------------------------

test('RULE tenant-scope: a super_admin acting on a SECOND practice writes there and audits there', async () => {
  const out = await update(T2, superAdmin, HYG_2, { role: 'tc' });
  assert.equal(out.ok, true);
  assert.equal(find(T2, HYG_2).role, 'tc');
  assert.deepEqual(auditRows, [
    { tenantId: T2, action: 'UPDATE', resourceType: 'app_user', resourceId: HYG_2, result: 'SUCCESS' },
  ]);
  // Tenant one is untouched, row for row.
  assert.deepEqual(
    rows.filter((r) => r.tenant_id === T1).map((r) => [r.email, r.role, r.status]),
    [[ADMIN_1, 'admin', 'active'], [OFFICE_1, 'office', 'active']]
  );
});

test('RULE tenant-scope: the last-admin count is per practice — T2 has its own single admin', async () => {
  find(T1, OFFICE_1).role = 'admin'; // T1 now has two admins; T2 still has one
  const out = await update(T2, superAdmin, ADMIN_2, { status: 'disabled' });
  assert.equal(out.code, 'LAST_ADMIN');
  assert.deepEqual(out.extra, { activeAdmins: 1 });
});

test('RULE tenant-scope: a tenant admin cannot reach another practice\'s user', async () => {
  // ADMIN_1 administers T1. Their door always passes T1; naming a T2 address
  // simply finds nothing — no write, no audit, no hint the row exists.
  const out = await update(T1, tenantAdmin, HYG_2, { status: 'disabled' });
  assert.equal(out.status, 404);
  assert.equal(out.code, 'USER_NOT_FOUND');
  assert.equal(find(T2, HYG_2).status, 'active');
  assert.equal(auditRows.length, 0);

  // And creating "the same" address lands in T1, not T2.
  const created = await create(T1, tenantAdmin, { email: HYG_2, role: 'office' });
  assert.equal(created.ok, true);
  assert.equal(find(T2, HYG_2).role, 'hygiene');
  assert.equal(find(T1, HYG_2).role, 'office');
});

test('update: a failed audit write propagates — fail closed', async () => {
  await assert.rejects(
    tenantUsers.updateUser({
      tenantId: T1,
      actor: tenantAdmin,
      audit: async () => {
        throw new Error('audit store down');
      },
      email: OFFICE_1,
      body: { role: 'tc' },
    }),
    /audit store down/
  );
  assert.equal(cacheClears, 0);
});
