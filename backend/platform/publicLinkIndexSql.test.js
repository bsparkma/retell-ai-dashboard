'use strict';

/**
 * MT-3 hotfix — the REAL SQL backend of platform/publicLinkIndex.js.
 *
 * Every other public-link test installs the in-memory backend
 * (setBackendForTests), so the SQL path never ran in a test and shipped
 * calling registry.query, which registry.js did not export: every email send
 * failed closed and every public link route answered 503. These tests never
 * call setBackendForTests. They swap only the control-plane POOL
 * (registry.setPoolForTests) for a fake that records each statement and
 * answers canned rows, so the whole path from publicLinkIndex through
 * registry.query to pool.query runs.
 *
 * No PHI: synthetic hashes, tenant 'carein' (T1).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const registry = require('./registry');
const publicLinkIndex = require('./publicLinkIndex');

/**
 * A fake pg Pool: records { text, params } per query and answers with
 * `respond(text, params)`, which may throw to simulate an unreachable DB.
 * @param {(text: string, params: unknown[]) => { rows: unknown[] }} respond
 */
function fakePool(respond) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
      return respond(text, params);
    },
    async end() {},
  };
}

const hash = () => crypto.randomBytes(32).toString('hex');
const SAVED_SLUG = process.env.TC_EMAIL_TENANT_SLUG;

test.beforeEach(() => {
  // The SQL backend, whatever another suite in this process last installed.
  publicLinkIndex.resetBackendForTests();
  // No legacy fallback in play: a lookup answer is the only tenant source.
  delete process.env.TC_EMAIL_TENANT_SLUG;
});

test.afterEach(() => {
  registry.setPoolForTests(null);
  if (SAVED_SLUG === undefined) delete process.env.TC_EMAIL_TENANT_SLUG;
  else process.env.TC_EMAIL_TENANT_SLUG = SAVED_SLUG;
});

test('registry exports query (the SQL backend calls it)', () => {
  assert.equal(typeof registry.query, 'function');
});

test('(a) register() issues exactly ONE INSERT INTO public_link_index with the right params', async () => {
  const pool = fakePool(() => ({ rows: [] }));
  registry.setPoolForTests(pool);
  const h = hash();
  await publicLinkIndex.register({ tenant: { id: 'T1' } }, [{ hash: h, kind: 'unsubscribe', expiresAt: null }]);
  assert.equal(pool.calls.length, 1);
  assert.equal(
    pool.calls[0].text,
    'INSERT INTO public_link_index (token_hash, tenant_id, kind, expires_at) VALUES ($1, $2, $3, $4)'
  );
  assert.deepEqual(pool.calls[0].params, [h, 'T1', 'unsubscribe', null]);
});

test("(a) one email's links are ONE multi-row statement, so all are registered or none is", async () => {
  const pool = fakePool(() => ({ rows: [] }));
  registry.setPoolForTests(pool);
  const [u, r1, r2] = [hash(), hash(), hash()];
  const exp = '2027-01-15T17:00:00.000Z';
  await publicLinkIndex.register({ tenant: { id: 'T1' } }, [
    { hash: u, kind: 'unsubscribe', expiresAt: null },
    { hash: r1, kind: 'referral_link', expiresAt: exp },
    { hash: r2, kind: 'referral_link', expiresAt: exp },
  ]);
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /^INSERT INTO public_link_index .* VALUES \(\$1, \$2, \$3, \$4\), \(\$5, \$6, \$7, \$8\), \(\$9, \$10, \$11, \$12\)$/);
  assert.deepEqual(pool.calls[0].params, [u, 'T1', 'unsubscribe', null, r1, 'T1', 'referral_link', exp, r2, 'T1', 'referral_link', exp]);
});

test('(b) attachLinkTenant() issues the lookup SELECT for the token hash and attaches the tenant from the row', async () => {
  const pool = fakePool(() => ({
    rows: [{ tenant_id: 'T1', slug: 'carein', status: 'active', kind: 'unsubscribe', live: true, modules: ['tc', 'voice'] }],
  }));
  registry.setPoolForTests(pool);
  const token = crypto.randomBytes(32).toString('base64url');
  /** @type {any} */
  const req = {};
  const out = await publicLinkIndex.attachLinkTenant(req, { token, kind: 'unsubscribe', actor: 'system:test', logTag: '[test]' });
  assert.equal(out, 'attached');
  assert.equal(pool.calls.length, 1, 'one control-plane query');
  assert.match(pool.calls[0].text, /^SELECT t\.tenant_id, t\.slug, t\.status, i\.kind, .* FROM public_link_index i JOIN tenant t ON t\.tenant_id = i\.tenant_id WHERE i\.token_hash = \$1$/);
  assert.deepEqual(pool.calls[0].params, [publicLinkIndex.hashToken(token)], 'the hash, never the token');
  assert.deepEqual(req.tenant, { id: 'T1', slug: 'carein', modules: ['tc', 'voice'], clinics: [] });
  assert.deepEqual(req.user, { email: 'system:test' });
});

test('(b) a lookup with no row, and no fallback set, is neutral after that one query', async () => {
  const pool = fakePool(() => ({ rows: [] }));
  registry.setPoolForTests(pool);
  /** @type {any} */
  const req = {};
  const out = await publicLinkIndex.attachLinkTenant(req, {
    token: crypto.randomBytes(32).toString('base64url'),
    kind: 'referral_link',
    actor: 'system:test',
    logTag: '[test]',
  });
  assert.equal(out, 'neutral');
  assert.equal(pool.calls.length, 1);
  assert.equal(req.tenant, undefined);
});

test("(c) a pool that throws → register() throws PublicLinkIndexError, attachLinkTenant() answers 'unavailable'", async () => {
  const pool = fakePool(() => {
    throw new Error('connection terminated unexpectedly');
  });
  registry.setPoolForTests(pool);
  await assert.rejects(
    publicLinkIndex.register({ tenant: { id: 'T1' } }, [{ hash: hash(), kind: 'unsubscribe', expiresAt: null }]),
    publicLinkIndex.PublicLinkIndexError
  );
  /** @type {any} */
  const req = {};
  const out = await publicLinkIndex.attachLinkTenant(req, {
    token: crypto.randomBytes(32).toString('base64url'),
    kind: 'unsubscribe',
    actor: 'system:test',
    logTag: '[test]',
  });
  assert.equal(out, 'unavailable');
  assert.equal(req.tenant, undefined);
  assert.equal(pool.calls.length, 2, 'both reached the pool (i.e. registry.query exists and was called)');
});
