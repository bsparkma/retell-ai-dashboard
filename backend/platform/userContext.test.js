'use strict';

/**
 * Identity cache tests (Roles PR A).
 *
 * The properties that matter operationally:
 *  - a role change is visible within the TTL, with no re-login;
 *  - the control DB sees ~one identity query per user per TTL, not per request;
 *  - last_login_at is stamped at most once per TTL, and a failed stamp is
 *    invisible to the request.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterEach } = test;

const registry = require('./registry');
const userContext = require('./userContext');

const REGISTRY_KEYS = ['getUserByEmail', 'getPlatformAdminByEmail', 'touchUserLogin'];
const original = {};
for (const k of REGISTRY_KEYS) original[k] = registry[k];

afterEach(() => {
  for (const k of REGISTRY_KEYS) registry[k] = original[k];
  userContext.clearCache();
  userContext._setTtlForTests(userContext.DEFAULT_TTL_MS);
});

function stubUser(row, { superAdmin = false } = {}) {
  const counts = { user: 0, admin: 0 };
  registry.getUserByEmail = async () => {
    counts.user += 1;
    return typeof row === 'function' ? row() : row;
  };
  registry.getPlatformAdminByEmail = async () => {
    counts.admin += 1;
    return superAdmin ? { email: 'a@carein.ai', status: 'active', created_at: new Date() } : null;
  };
  registry.touchUserLogin = async () => {};
  return counts;
}

const ROW = { user_id: 'U1', tenant_id: 'T1', email: 'a@carein.ai', role: 'office', status: 'active' };

// --- cache behavior --------------------------------------------------------

test('a second lookup inside the TTL does not re-query the control DB', async () => {
  const counts = stubUser(ROW);

  const first = await userContext.getUserContext('a@carein.ai');
  const second = await userContext.getUserContext('a@carein.ai');

  assert.equal(counts.user, 1, 'one query for two lookups');
  assert.equal(first.appUser.role, 'office');
  assert.equal(second.appUser.role, 'office');
});

test('lookup is case-insensitive on email (one cache entry, not two)', async () => {
  const counts = stubUser(ROW);

  await userContext.getUserContext('a@carein.ai');
  await userContext.getUserContext('  A@CareIN.ai ');

  assert.equal(counts.user, 1);
});

test('a role change becomes visible once the TTL expires — no re-login', async () => {
  userContext._setTtlForTests(10);
  let role = 'office';
  const counts = stubUser(() => ({ ...ROW, role }));

  assert.equal((await userContext.getUserContext('a@carein.ai')).appUser.role, 'office');

  role = 'admin';
  // Still cached.
  assert.equal((await userContext.getUserContext('a@carein.ai')).appUser.role, 'office');
  assert.equal(counts.user, 1);

  await new Promise((r) => setTimeout(r, 25));

  assert.equal((await userContext.getUserContext('a@carein.ai')).appUser.role, 'admin');
  assert.equal(counts.user, 2, 'expiry causes exactly one re-read');
});

test('a MISS is cached too — an unseeded user does not re-query every request', async () => {
  const counts = stubUser(null);

  const a = await userContext.getUserContext('nobody@carein.ai');
  const b = await userContext.getUserContext('nobody@carein.ai');

  assert.equal(a.appUser, null);
  assert.equal(b.appUser, null);
  assert.equal(counts.user, 1);
});

test('concurrent misses for the same email collapse into ONE query', async () => {
  let inflightUser = 0;
  registry.getUserByEmail = async () => {
    inflightUser += 1;
    await new Promise((r) => setTimeout(r, 5));
    return ROW;
  };
  registry.getPlatformAdminByEmail = async () => null;

  const results = await Promise.all([
    userContext.getUserContext('a@carein.ai'),
    userContext.getUserContext('a@carein.ai'),
    userContext.getUserContext('a@carein.ai'),
  ]);

  assert.equal(inflightUser, 1);
  for (const r of results) assert.equal(r.appUser.role, 'office');
});

test('an active platform_admin row reads as isSuperAdmin', async () => {
  stubUser(ROW, { superAdmin: true });
  const ctx = await userContext.getUserContext('a@carein.ai');
  assert.equal(ctx.isSuperAdmin, true);
});

test('a DISABLED platform_admin row does NOT read as isSuperAdmin', async () => {
  registry.getUserByEmail = async () => ROW;
  registry.getPlatformAdminByEmail = async () => ({
    email: 'a@carein.ai',
    status: 'disabled',
    created_at: new Date(),
  });

  const ctx = await userContext.getUserContext('a@carein.ai');
  assert.equal(ctx.isSuperAdmin, false);
});

test('super_admin with NO app_user row still resolves as super_admin', async () => {
  registry.getUserByEmail = async () => null;
  registry.getPlatformAdminByEmail = async () => ({
    email: 'a@carein.ai',
    status: 'active',
    created_at: new Date(),
  });

  const ctx = await userContext.getUserContext('a@carein.ai');
  assert.equal(ctx.appUser, null);
  assert.equal(ctx.isSuperAdmin, true);
});

test('an empty email short-circuits without touching the registry', async () => {
  registry.getUserByEmail = async () => {
    throw new Error('should not be called');
  };
  registry.getPlatformAdminByEmail = async () => {
    throw new Error('should not be called');
  };

  assert.deepEqual(await userContext.getUserContext(''), { appUser: null, isSuperAdmin: false });
  assert.deepEqual(await userContext.getUserContext(undefined), { appUser: null, isSuperAdmin: false });
});

test('a control-DB failure PROPAGATES (callers must fail closed, not guess)', async () => {
  registry.getUserByEmail = async () => {
    throw new Error('control db down');
  };
  registry.getPlatformAdminByEmail = async () => null;

  await assert.rejects(() => userContext.getUserContext('a@carein.ai'), /control db down/);
});

test('a failed lookup is not cached as a miss', async () => {
  let attempt = 0;
  registry.getUserByEmail = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('transient');
    return ROW;
  };
  registry.getPlatformAdminByEmail = async () => null;

  await assert.rejects(() => userContext.getUserContext('a@carein.ai'));
  const ctx = await userContext.getUserContext('a@carein.ai');
  assert.equal(ctx.appUser.role, 'office', 'the retry must reach the registry, not a cached failure');
});

// --- last_login_at stamping ------------------------------------------------

test('last_login_at is stamped at most once per TTL window', async () => {
  let stamps = 0;
  registry.getUserByEmail = async () => ROW;
  registry.getPlatformAdminByEmail = async () => null;
  registry.touchUserLogin = async () => {
    stamps += 1;
  };

  await userContext.getUserContext('a@carein.ai');

  assert.equal(userContext.stampLoginIfDue(ROW), true, 'first call stamps');
  assert.equal(userContext.stampLoginIfDue(ROW), false, 'second call inside the TTL does not');
  assert.equal(userContext.stampLoginIfDue(ROW), false);

  await new Promise((r) => setImmediate(r));
  assert.equal(stamps, 1);
});

test('the throttle survives a cache refresh (stampedAt is carried forward)', async () => {
  userContext._setTtlForTests(10);
  registry.getUserByEmail = async () => ROW;
  registry.getPlatformAdminByEmail = async () => null;
  registry.touchUserLogin = async () => {};

  await userContext.getUserContext('a@carein.ai');
  const now = Date.now();
  assert.equal(userContext.stampLoginIfDue(ROW, { now }), true);

  // Identity re-read after expiry...
  await new Promise((r) => setTimeout(r, 25));
  await userContext.getUserContext('a@carein.ai');

  // ...but from the stamp's point of view only 1ms has passed, so no re-stamp.
  assert.equal(userContext.stampLoginIfDue(ROW, { now: now + 1 }), false);
});

test('a FAILED stamp is swallowed — it can never fail the request', async () => {
  registry.getUserByEmail = async () => ROW;
  registry.getPlatformAdminByEmail = async () => null;
  registry.touchUserLogin = async () => {
    throw new Error('column is missing');
  };

  await userContext.getUserContext('a@carein.ai');

  // Synchronous return is unaffected...
  assert.equal(userContext.stampLoginIfDue(ROW), true);
  // ...and the rejection does not escape as an unhandled rejection.
  await new Promise((r) => setTimeout(r, 5));
});

test('stampLoginIfDue is a no-op for a user with no row and for an uncached user', () => {
  assert.equal(userContext.stampLoginIfDue(null), false);
  assert.equal(userContext.stampLoginIfDue({ email: 'x@carein.ai' }), false, 'no user_id');
  assert.equal(userContext.stampLoginIfDue(ROW), false, 'not in the cache');
});

// --- unseeded warning ------------------------------------------------------

test('the unseeded warning fires exactly once per email per process', () => {
  assert.equal(userContext.warnUnseededOnce('new@carein.ai'), true);
  assert.equal(userContext.warnUnseededOnce('new@carein.ai'), false);
  assert.equal(userContext.warnUnseededOnce('NEW@carein.ai'), false, 'case-insensitive');
  assert.equal(userContext.warnUnseededOnce('other@carein.ai'), true, 'a different user warns');
  assert.equal(userContext.warnUnseededOnce(''), false);
});
