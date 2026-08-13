'use strict';

/**
 * The retention admin surface, and the honest refusal on a pruned call.
 *
 * Two boundaries are under test here:
 *   - the purge and the manual prune are SUPER-ADMIN only. /api/admin already
 *     requires the tenant 'admin' role; destroying records is a platform-tier
 *     action on top of that, and this is the first route in the app to mount
 *     requireSuperAdmin().
 *   - a mutation aimed at a pruned call answers 409 CALL_PRUNED, not 404. The
 *     SPA has to be able to tell "this call's content is gone" from "there is no
 *     such call" — they mean different things to the person at the front desk.
 *
 * All fixtures synthetic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { beforeEach, afterEach } = test;
const express = require('express');

const adminRouter = require('./admin');
const unifiedRouter = require('./unifiedCalls');
const store = require('../services/unifiedCallStore');
const legacyPurge = require('../services/legacyPurge');
const audit = require('../platform/audit');

const SESSION_USER = { name: 'Beau Platform', email: 'beau@carein.ai' };

let server;
let baseUrl;
let originalAudit;
let originalRequestPersist;
let originalPersist;
let auditRows;
let isSuperAdmin;

beforeEach(async () => {
  isSuperAdmin = true;
  auditRows = [];
  originalAudit = audit.audit;
  originalRequestPersist = store.requestPersist;
  originalPersist = store.persist;
  audit.audit = async (req, entry) => { auditRows.push({ ...entry, userId: req.user?.email ?? null }); };
  store.requestPersist = () => {};
  store.persist = async () => {};
  store.clear();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = SESSION_USER;
    req.userRole = 'admin';
    req.isSuperAdmin = isSuperAdmin;
    req.tenant = { id: 'tenant-test' };
    next();
  });
  app.use('/api/admin', adminRouter);
  app.use('/api/unified-calls', unifiedRouter);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  audit.audit = originalAudit;
  store.requestPersist = originalRequestPersist;
  store.persist = originalPersist;
  await new Promise((resolve) => server.close(resolve));
});

function seedUnknown(id) {
  return store.addCallInternal({
    id, external_id: id, source: 'mango',
    caller_number: `+1555010${id.slice(-4)}`,
    called_number: '+15550100000', // unmapped line → office 'unknown'
    call_date: '2026-01-05T15:00:00.000Z',
    summary: 'a synthetic summary',
  });
}

// --- the purge endpoint ----------------------------------------------------

test('the purge endpoint dry-runs by DEFAULT and deletes nothing', async () => {
  seedUnknown('mango_call_0001');
  seedUnknown('mango_call_0002');

  const res = await fetch(`${baseUrl}/api/admin/call-store/purge-legacy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.dryRun, true);
  assert.equal(body.count, 2);
  assert.equal(body.deleted, 0);
  assert.equal(store.calls.size, 2);
});

test('the dry run returns counts, never caller identities', async () => {
  seedUnknown('mango_call_0001');

  const res = await fetch(`${baseUrl}/api/admin/call-store/purge-legacy`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  const raw = await res.text();

  assert.equal(raw.includes('a synthetic summary'), false);
  assert.equal(raw.includes('5550100001'), false, 'a purge report must be safe to paste into a PR');
});

test('a non-super-admin cannot purge, even as tenant admin', async () => {
  isSuperAdmin = false;
  seedUnknown('mango_call_0001');
  // Rebuild the app with the flag flipped.
  await new Promise((resolve) => server.close(resolve));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = SESSION_USER; req.userRole = 'admin'; req.isSuperAdmin = false;
    req.tenant = { id: 'tenant-test' }; next();
  });
  app.use('/api/admin', adminRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });

  const res = await fetch(`${baseUrl}/api/admin/call-store/purge-legacy`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });

  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'FORBIDDEN');
});

test('a live purge without the confirmation token is refused, not performed', async () => {
  seedUnknown('mango_call_0001');

  const res = await fetch(`${baseUrl}/api/admin/call-store/purge-legacy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dryRun: false }),
  });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'PURGE_NOT_CONFIRMED');
  assert.equal(store.calls.size, 1);
});

test('a confirmed live purge deletes and writes ONE audit row for the action', async () => {
  seedUnknown('mango_call_0001');
  let purgeArgs = null;
  const originalRun = legacyPurge.runLegacyPurge;
  legacyPurge.runLegacyPurge = async (_store, opts) => {
    purgeArgs = opts;
    return { dryRun: false, count: 1, deleted: 1, ids: ['mango_call_0001'], skippedTwinned: [],
             bySource: { mango: 1 }, dateRange: { from: null, to: null }, backupPath: '/data/backup.json' };
  };

  const res = await fetch(`${baseUrl}/api/admin/call-store/purge-legacy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dryRun: false, confirm: 'DELETE' }),
  });
  legacyPurge.runLegacyPurge = originalRun;

  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted, 1);
  assert.equal(purgeArgs.dryRun, false);
  assert.equal(purgeArgs.confirm, 'DELETE');
  assert.equal(auditRows.length, 1);
  assert.deepEqual(
    { action: auditRows[0].action, resourceType: auditRows[0].resourceType, result: auditRows[0].result },
    { action: 'DELETE', resourceType: 'call_store', result: 'SUCCESS' }
  );
  assert.equal(auditRows[0].userId, 'beau@carein.ai');
});

test('a dry run is audited as a READ, not a DELETE', async () => {
  seedUnknown('mango_call_0001');

  await fetch(`${baseUrl}/api/admin/call-store/purge-legacy`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });

  assert.equal(auditRows[0].action, 'READ');
});

// --- retention status + manual prune ---------------------------------------

test('the retention status endpoint reports the policy and the store split', async () => {
  seedUnknown('mango_call_0001');
  seedUnknown('mango_call_0002');
  store.stubCalls(['mango_call_0002']);

  const res = await fetch(`${baseUrl}/api/admin/call-store/retention`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.retentionDays, 30);
  assert.equal(body.store.liveCalls, 1);
  assert.equal(body.store.prunedCalls, 1);
});

test('the manual prune is super-admin only', async () => {
  await new Promise((resolve) => server.close(resolve));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = SESSION_USER; req.userRole = 'admin'; req.isSuperAdmin = false;
    req.tenant = { id: 'tenant-test' }; next();
  });
  app.use('/api/admin', adminRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });

  const res = await fetch(`${baseUrl}/api/admin/call-store/prune`, { method: 'POST' });

  assert.equal(res.status, 403);
});

// --- the honest refusal on a pruned call -----------------------------------

test('a pruned call is still readable — it renders as pruned, not as missing', async () => {
  seedUnknown('mango_call_0001');
  store.stubCalls(['mango_call_0001']);

  const res = await fetch(`${baseUrl}/api/unified-calls/mango_call_0001`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.record_kind, 'stub');
  assert.equal(body.caller_name, undefined);
  assert.ok(Array.isArray(body.actions));
});

test('a triage write on a pruned call is 409 CALL_PRUNED, never 404', async () => {
  seedUnknown('mango_call_0001');
  store.stubCalls(['mango_call_0001']);

  const res = await fetch(`${baseUrl}/api/unified-calls/mango_call_0001/triage`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ triage_status: 'done', triage_outcome: 'called_back' }),
  });

  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'CALL_PRUNED');
});

test('a note on a pruned call is refused with the same code', async () => {
  seedUnknown('mango_call_0001');
  store.stubCalls(['mango_call_0001']);

  const res = await fetch(`${baseUrl}/api/unified-calls/mango_call_0001/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'a note' }),
  });

  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'CALL_PRUNED');
});

test('a disposition on a pruned call is refused with the same code', async () => {
  seedUnknown('mango_call_0001');
  store.stubCalls(['mango_call_0001']);

  const res = await fetch(`${baseUrl}/api/unified-calls/mango_call_0001/disposition`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disposition: 'lab' }),
  });

  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'CALL_PRUNED');
});

test('an unknown call id is still a 404 — the two answers stay distinct', async () => {
  const res = await fetch(`${baseUrl}/api/unified-calls/never_existed/triage`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ triage_status: 'done', triage_outcome: 'called_back' }),
  });

  assert.equal(res.status, 404);
});
