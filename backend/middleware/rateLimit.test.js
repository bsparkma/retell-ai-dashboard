'use strict';

// Unit tests for the per-user API rate limiter (incident fix, 2026-08-12).
// Runner: `node --test`. The properties that matter, in order of how badly getting them
// wrong would hurt:
//
//   1. Webhooks / health / live Retell tools are NEVER limited. A 429'd call event is a
//      call that silently never reaches a chart.
//   2. Two signed-in users get two budgets — the regression that took prod down was one
//      shared bucket for the whole practice.
//   3. Anonymous traffic is a separate, tighter bucket and cannot spend a user's budget.
//   4. A throttled response is identifiable (code + Retry-After) so the dashboard can
//      say "busy" instead of "offline".

const test = require('node:test');
const assert = require('node:assert/strict');
const { beforeEach, afterEach } = test;
const express = require('express');

const {
  createApiRateLimiter, principalOf, isExempt, normalizeIp,
  AUTHENTICATED_MAX, ANONYMOUS_MAX, EXEMPT_PATHS,
} = require('./rateLimit');

let server;
let baseUrl;

/**
 * A tiny app shaped like server.js: the limiter sits above everything and reads identity
 * itself. `x-test-user` stands in for a verified SSO session (principalOf prefers an
 * already-resolved req.user, which is what the real auth gate sets).
 *
 * A FRESH limiter per test — the counter store is per-instance, so a shared one would
 * make each test's result depend on which tests ran before it.
 */
beforeEach(async () => {
  const app = express();
  app.use((req, _res, next) => {
    const email = req.get('x-test-user');
    if (email) req.user = { email };
    next();
  });
  app.use(createApiRateLimiter());
  app.all('*', (_req, res) => res.json({ ok: true }));

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const get = (path, headers = {}) => fetch(`${baseUrl}${path}`, { headers });

/** Fire n requests as `user` (or anonymously) and return the statuses seen. */
async function burst(path, n, user) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const res = await get(path, user ? { 'x-test-user': user } : {});
    out.push(res.status);
  }
  return out;
}

// --- 1. exemptions: the safety-critical property ----------------------------

test('webhooks, health and live retell-tools are never limited', () => {
  const exempt = [
    '/api/webhooks/retell',
    '/api/webhooks/mango',
    '/api/webhooks',
    '/api/health',
    '/api/retell-tools/check-availability',
    '/api/retell-tools',
  ];
  for (const p of exempt) {
    assert.equal(isExempt({ originalUrl: p }), true, `${p} must be exempt`);
  }
});

test('the exemption match ignores the query string', () => {
  assert.equal(isExempt({ originalUrl: '/api/health?verbose=1' }), true);
});

test('lookalike paths are NOT exempt — the dashboard config route is normal traffic', () => {
  // /api/retell-tools-config is a dashboard screen, not the live agent path. It must
  // stay limited; a prefix-only match would have wrongly exempted it.
  assert.equal(isExempt({ originalUrl: '/api/retell-tools-config' }), false);
  assert.equal(isExempt({ originalUrl: '/api/healthcheck' }), false);
  assert.equal(isExempt({ originalUrl: '/api/webhooksomething' }), false);
});

test('an exempt path survives a flood that would exhaust any bucket', async () => {
  const statuses = await burst('/api/webhooks/retell', ANONYMOUS_MAX + 25);
  assert.equal(statuses.every((s) => s === 200), true, 'a webhook was throttled');
});

test('health survives the same flood', async () => {
  const statuses = await burst('/api/health', ANONYMOUS_MAX + 25);
  assert.equal(statuses.every((s) => s === 200), true, 'health was throttled');
});

// --- 2. two users, two buckets ---------------------------------------------

test('one user exhausting their budget does not throttle a different user', async () => {
  // Spend the first user's entire allowance.
  const first = await burst('/api/unified-calls', AUTHENTICATED_MAX, 'sarah@carein.ai');
  assert.equal(first.every((s) => s === 200), true, 'user was throttled inside their budget');

  // One more from that user is refused...
  assert.equal((await get('/api/unified-calls', { 'x-test-user': 'sarah@carein.ai' })).status, 429);

  // ...and the second user is completely unaffected. This is the prod regression.
  assert.equal((await get('/api/unified-calls', { 'x-test-user': 'alex@carein.ai' })).status, 200);
});

test('the same user is one bucket regardless of letter case', async () => {
  await burst('/api/unified-calls', AUTHENTICATED_MAX, 'Sarah@CareIN.ai');
  assert.equal((await get('/api/unified-calls', { 'x-test-user': 'sarah@carein.ai' })).status, 429);
});

// --- 3. anonymous is a separate, tighter bucket -----------------------------

test('anonymous traffic gets the tighter budget', async () => {
  const statuses = await burst('/api/unified-calls', ANONYMOUS_MAX + 1);
  assert.equal(statuses.filter((s) => s === 200).length, ANONYMOUS_MAX);
  assert.equal(statuses[statuses.length - 1], 429);
});

test('an exhausted anonymous bucket does not touch a signed-in user', async () => {
  await burst('/api/unified-calls', ANONYMOUS_MAX + 5);
  assert.equal((await get('/api/unified-calls', { 'x-test-user': 'sarah@carein.ai' })).status, 200);
});

// --- 4. the refusal is legible ---------------------------------------------

test('a throttled response carries RATE_LIMITED and Retry-After', async () => {
  await burst('/api/unified-calls', ANONYMOUS_MAX);
  const res = await get('/api/unified-calls');

  assert.equal(res.status, 429);
  assert.ok(res.headers.get('retry-after'), 'Retry-After header missing');
  const body = await res.json();
  assert.equal(body.code, 'RATE_LIMITED');
  assert.equal(body.success, false);
  assert.equal(typeof body.retryAfter, 'number');
});

// --- principal resolution ---------------------------------------------------

test('principalOf distinguishes user, shared token, and anonymous', () => {
  const prior = process.env.DASHBOARD_API_TOKEN;
  process.env.DASHBOARD_API_TOKEN = 'test-shared-token';
  try {
    const mk = (over) => ({ get: () => undefined, ip: '203.0.113.9', ...over });

    assert.deepEqual(
      principalOf(mk({ user: { email: 'Sarah@carein.ai' } })),
      { kind: 'user', key: 'user:sarah@carein.ai' }
    );
    assert.deepEqual(
      principalOf(mk({ get: (h) => (h === 'authorization' ? 'Bearer test-shared-token' : undefined) })),
      { kind: 'token', key: 'token:dashboard' }
    );
    // A WRONG bearer is not a principal — it falls back to the anonymous bucket rather
    // than being handed the generous one.
    assert.deepEqual(
      principalOf(mk({ get: (h) => (h === 'authorization' ? 'Bearer wrong' : undefined) })),
      { kind: 'anon', key: 'ip:203.0.113.9' }
    );
    // Same LENGTH, different value — the case a length check alone would wave through,
    // and the one the constant-time comparison actually has to decide.
    assert.deepEqual(
      principalOf(mk({ get: (h) => (h === 'authorization' ? 'Bearer test-shared-tokeX' : undefined) })),
      { kind: 'anon', key: 'ip:203.0.113.9' }
    );
    assert.deepEqual(principalOf(mk({})), { kind: 'anon', key: 'ip:203.0.113.9' });
  } finally {
    if (prior === undefined) delete process.env.DASHBOARD_API_TOKEN;
    else process.env.DASHBOARD_API_TOKEN = prior;
  }
});

test('IPv6 collapses to a /64 so one allocation is one bucket', () => {
  assert.equal(normalizeIp('2001:db8:1234:5678:9abc:def0:1234:5678'), '2001:db8:1234:5678::/64');
  assert.equal(normalizeIp('2001:db8:1234:5678:ffff:ffff:ffff:ffff'), '2001:db8:1234:5678::/64');
  // IPv4 and IPv4-mapped are left alone.
  assert.equal(normalizeIp('203.0.113.9'), '203.0.113.9');
  assert.equal(normalizeIp('::ffff:203.0.113.9'), '::ffff:203.0.113.9');
  assert.equal(normalizeIp(undefined), 'unknown');
});

test('the exemption list is exactly the auth gate\'s, so the two cannot drift apart', () => {
  // server.js exempts these same three from requireDashboardAuth and tenantContext.
  // If a fourth is added there without adding it here, that route becomes limited —
  // which for an HMAC-authenticated caller means silently dropped events.
  assert.equal(EXEMPT_PATHS.length, 3);
});
