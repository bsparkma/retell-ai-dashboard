'use strict';

/**
 * Mount-order regression tests for routes/rcm/index.js.
 *
 * WHY THIS FILE EXISTS. The TC voice-handoff slice shipped a route whose office
 * comes from the request BODY, which meant it had to be registered ABOVE the
 * router that applies requireOffice — express matches mounts in registration
 * order, and the wrong order 400s a live integration. That constraint lived
 * only in a comment. Here it is a comment AND a test.
 *
 * RCM's rule is the simpler one: office scoping is router-wide, applied before
 * every route, with NO exceptions. The tests below pin all three halves of
 * that:
 *   1. structurally — requireOffice is the first layer of the assembled router,
 *      so it cannot be demoted below a route mount;
 *   2. by source — no route is declared above it (the exception list is empty
 *      and adding one is a deliberate edit to this file);
 *   3. behaviorally — every declared route, driven through the FULLY-ASSEMBLED
 *      chain, refuses a request with no office.
 *
 * (3) is the one that would actually catch a regression: it goes through
 * server.js's middleware shape into the real router, so deleting the
 * `router.use(requireOffice)` line turns these red. A test that called the
 * handlers directly would stay green.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { bootRcmApp, api } = require('./rcmTestUtils');

const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

/**
 * Routes deliberately mounted ABOVE the router-wide office guard, each with the
 * reason it cannot take `?office=`.
 *
 * EMPTY, and that is the current design: every RCM route takes its office from
 * the validated query param. Adding an entry here is how a future exception
 * (say, a webhook carrying office in a frozen payload) gets introduced —
 * consciously, with a reason, and never by an edit nobody noticed.
 *
 * @type {Array<{ path: string, why: string }>}
 */
const OFFICE_GUARD_EXCEPTIONS = [];

/** Every `router.use('/path', …)` in index.js, in registration order. */
function declaredMounts() {
  return [...indexSrc.matchAll(/router\.use\(\s*'(\/[^']*)'/g)].map((m) => m[1]);
}

test('requireOffice is the FIRST layer of the assembled router', () => {
  const router = require('./index');
  const layers = router.stack;
  assert.ok(layers.length > 1, 'expected the office guard plus at least one route mount');
  assert.equal(
    layers[0].handle.name,
    'requireOffice',
    'the office guard must run before every route in this module — see index.js'
  );
});

test('no route is declared above the office guard (documented exceptions only)', () => {
  const guardIdx = indexSrc.indexOf('router.use(requireOffice)');
  assert.ok(guardIdx > 0, 'index.js must apply requireOffice router-wide');

  const above = declaredMounts().filter((p) => indexSrc.indexOf(`router.use('${p}'`) < guardIdx);
  const allowed = OFFICE_GUARD_EXCEPTIONS.map((e) => e.path);
  for (const p of above) {
    assert.ok(
      allowed.includes(p),
      `'${p}' is mounted above the router-wide office guard. If that is deliberate, ` +
        'add it to OFFICE_GUARD_EXCEPTIONS in this file with the reason; if not, move it below.'
    );
  }
});

test('every declared route refuses a request with no office (400 INVALID_OFFICE)', async () => {
  const mounts = declaredMounts().filter((p) => !OFFICE_GUARD_EXCEPTIONS.some((e) => e.path === p));
  assert.ok(mounts.length >= 2, `expected the summary and claims mounts, got: ${mounts.join(', ')}`);

  const { baseUrl, close } = await bootRcmApp();
  try {
    for (const mount of mounts) {
      for (const qs of ['', '?office=', '?office=riley', '?office=ROLAND', '?office=all']) {
        const res = await api(baseUrl, 'GET', `/api/rcm${mount}${qs}`);
        assert.equal(res.status, 400, `/api/rcm${mount}${qs} must 400`);
        assert.equal(res.body.code, 'INVALID_OFFICE');
        assert.equal(res.body.success, false);
      }
    }
  } finally {
    await close();
  }
});

test('the office guard runs AFTER entitlement — an unentitled tenant gets 403, not 400', async () => {
  // Ordering that matters in the other direction: a practice that has not
  // bought RCM must not be told its office parameter is malformed. Entitlement
  // is the outer gate (server.js), office validity the inner one.
  const { baseUrl, close } = await bootRcmApp({ modules: ['voice'] });
  try {
    const res = await api(baseUrl, 'GET', '/api/rcm/claims'); // no office AND no entitlement
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
  } finally {
    await close();
  }
});

test('an unknown /api/rcm path 404s rather than falling through to a handler', async () => {
  const { baseUrl, close } = await bootRcmApp();
  try {
    const res = await api(baseUrl, 'GET', '/api/rcm/not-a-route?office=roland');
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});
