'use strict';

/**
 * The last-super-admin rule (Roles PR A).
 *
 * No mutation endpoint ships in PR A, but the rule lives at the data-access
 * layer so PR C's platform console, a migration, and an ops one-liner all
 * inherit it.
 *
 * The property that matters is STRUCTURAL: the count check must be inside the
 * write's WHERE clause, not in a preceding read. A read-then-write would let
 * two concurrent "remove the other one" calls both succeed and lock everyone
 * out of the platform tier.
 *
 * registry.js has no query-injection seam and CI has no standing control DB, so
 * these assert on the SOURCE of the guarded statements — which is exactly where
 * that structural property lives. Execution against real Postgres is covered by
 * the CI staging gate.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('./registry');

const src = fs.readFileSync(path.join(__dirname, 'registry.js'), 'utf8');

/** Extract the body of a named async function from registry.js. */
function body(name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start !== -1, `registry.js has no ${name}()`);
  const next = src.indexOf('\nasync function ', start + 1);
  const alt = src.indexOf('\n/**', start + 1);
  const end = Math.min(...[next, alt, src.length].filter((n) => n > start));
  return src.slice(start, end);
}

test('setPlatformAdminDisabled: the count check is INSIDE the UPDATE, not a preceding read', () => {
  const fn = body('setPlatformAdminDisabled');
  assert.match(fn, /UPDATE platform_admin/);
  assert.match(fn, /SET status = 'disabled'/);
  assert.match(fn, /WHERE email = \$1/);
  assert.match(fn, /AND status = 'active'/);
  assert.match(
    fn,
    /\(SELECT count\(\*\) FROM platform_admin WHERE status = 'active'\) > 1/,
    'the last-admin guard must be part of the UPDATE, so check-and-write are atomic'
  );
  assert.match(fn, /RETURNING email/, 'the write must report whether it changed a row');
});

test('removePlatformAdmin: the same guard, allowing removal of an already-disabled row', () => {
  const fn = body('removePlatformAdmin');
  assert.match(fn, /DELETE FROM platform_admin/);
  assert.match(fn, /WHERE email = \$1/);
  assert.match(
    fn,
    /status <> 'active'\s*\n?\s*OR \(SELECT count\(\*\) FROM platform_admin WHERE status = 'active'\) > 1/,
    'a disabled row is always removable; an active one only if it is not the last'
  );
});

test('both guarded writes normalize the email to lowercase before matching', () => {
  for (const name of ['setPlatformAdminDisabled', 'removePlatformAdmin', 'addPlatformAdmin']) {
    assert.match(body(name), /\.trim\(\)\.toLowerCase\(\)/, `${name} must normalize the email`);
  }
});

test('addPlatformAdmin is an idempotent upsert that re-activates a disabled row', () => {
  const fn = body('addPlatformAdmin');
  assert.match(fn, /INSERT INTO platform_admin \(email, status\)/);
  assert.match(fn, /ON CONFLICT \(email\) DO UPDATE SET status = 'active'/);
});

test('reads name their columns explicitly — no SELECT *', () => {
  for (const name of ['getPlatformAdminByEmail', 'listPlatformAdmins']) {
    const fn = body(name);
    assert.doesNotMatch(fn, /SELECT \*/);
    assert.match(fn, /SELECT email, status, created_at/);
  }
});

test('getPlatformAdminByEmail matches on lower(email), never a raw comparison', () => {
  assert.match(body('getPlatformAdminByEmail'), /WHERE email = lower\(\$1\)/);
});

test('touchUserLogin is a single parameterized UPDATE on user_id', () => {
  const fn = body('touchUserLogin');
  assert.match(fn, /UPDATE app_user SET last_login_at = \$2 WHERE user_id = \$1/);
});

// --- the refusal path ------------------------------------------------------

test('assertNotLastActiveAdmin: absent row → false, disabled row → false, last active → throw', () => {
  // When a guarded write matches nothing, this decides WHY: the row was absent
  // (a truthful false) or the last-admin rule fired (a throw). There must be no
  // third, silent outcome.
  const fn = body('assertNotLastActiveAdmin');
  assert.match(fn, /if \(!existing\) return false;/);
  assert.match(fn, /if \(existing\.status !== 'active'\) return false;/);
  assert.match(fn, /throw new Error\(/);
  assert.match(fn, /last active super_admin/);
  assert.match(
    fn,
    /Grant super_admin to another account first/,
    'the refusal must tell the operator how to proceed'
  );
});

test('the guarded writes are exported (PR C consumes them; nothing may reach around them)', () => {
  for (const name of [
    'getPlatformAdminByEmail',
    'listPlatformAdmins',
    'addPlatformAdmin',
    'setPlatformAdminDisabled',
    'removePlatformAdmin',
    'touchUserLogin',
  ]) {
    assert.equal(typeof registry[name], 'function', `${name} must be exported`);
  }
  assert.equal(
    typeof registry.assertNotLastActiveAdmin,
    'undefined',
    'the internal disambiguator must NOT be exported — it is not a public entry point'
  );
});
