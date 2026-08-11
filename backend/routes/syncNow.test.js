'use strict';

// Unit tests for the combined manual sync — POST /api/unified-calls/sync-now and the
// lightweight GET /api/unified-calls/sync-status the freshness caption polls.
// Runner: `node --test`. Covers:
//   - both sources succeed → merged 200;
//   - Mango ingestion off (staging) + Retell ok → 200, mango.status 'off', NOT an error;
//   - Mango autosync already running → 'already_running' passthrough, Retell still ok;
//   - one source throwing → 200 with that source's error only;
//   - BOTH sources failing → 502;
//   - the 60s cooldown → 429 with retryAfter, and no second sync run;
//   - an audit row written with the acting user;
//   - the sync-status shape.
//
// The router sits behind auth + tenantContext in server.js, so (as in
// unifiedCalls.test.js) we inject a fake req.user/req.tenant and stub the fail-closed
// audit writer. syncScheduler's two run methods are stubbed so nothing reaches Retell,
// Mango, or Azure Speech.

const test = require('node:test');
const assert = require('node:assert/strict');
const { beforeEach, afterEach } = test;
const express = require('express');

const router = require('./unifiedCalls');
const syncScheduler = require('../services/syncScheduler');
const manualSyncThrottle = require('../services/manualSyncThrottle');
const audit = require('../platform/audit');

const SESSION_USER = { name: 'Sarah Front', email: 'sarah@carein.ai' };

/**
 * The caller's app_user.role (Roles PR A). tenantContext attaches this upstream
 * in the real app; these harnesses mount the router directly, so they stamp it
 * themselves. Defaults to 'admin' and is reset per test; the role-gating tests
 * below reassign it to check a specific refusal.
 */
let sessionRole = 'admin';

let server;
let baseUrl;
let original;
let auditRows;
/** How many times each source was actually asked to sync. */
let calls;

beforeEach(async () => {
  sessionRole = 'admin';
  manualSyncThrottle.reset();
  auditRows = [];
  calls = { retell: 0, mango: 0 };

  original = {
    audit: audit.audit,
    runRetellSync: syncScheduler.runRetellSync,
    runSync: syncScheduler.runSync,
    getLastSyncedAt: syncScheduler.getLastSyncedAt,
    getNextAutoSync: syncScheduler.getNextAutoSync,
    getMangoMode: syncScheduler.getMangoMode,
  };

  // Fail-closed audit needs a tenant Postgres — capture instead of writing.
  audit.audit = async (_req, entry) => { auditRows.push({ ...entry, userId: _req.user?.email ?? null }); };

  // Defaults: both sources succeed. Individual tests override.
  syncScheduler.runRetellSync = async () => { calls.retell++; return { success: true, added: 1, fetched: 1000 }; };
  syncScheduler.runSync = async () => { calls.mango++; return mangoRun({ calls_found: 12, calls_imported: 3 }); };
  syncScheduler.getLastSyncedAt = () => '2026-08-11T17:19:00.000Z';
  syncScheduler.getNextAutoSync = () => '2026-08-11T18:15:00.000Z';
  syncScheduler.getMangoMode = () => 'api';

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = SESSION_USER;
    req.userRole = sessionRole;
    req.tenant = { id: 'tenant-test' };
    next();
  });
  app.use('/api/unified-calls', router);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  audit.audit = original.audit;
  syncScheduler.runRetellSync = original.runRetellSync;
  syncScheduler.runSync = original.runSync;
  syncScheduler.getLastSyncedAt = original.getLastSyncedAt;
  syncScheduler.getNextAutoSync = original.getNextAutoSync;
  syncScheduler.getMangoMode = original.getMangoMode;
  manualSyncThrottle.reset();
  await new Promise((resolve) => server.close(resolve));
});

/** A completed Mango history entry, the shape runSync really returns. */
const mangoRun = (over = {}) => ({
  id: 'sync_1',
  status: 'completed',
  trigger: 'manual',
  actor: SESSION_USER.email,
  calls_found: 0,
  calls_imported: 0,
  errors: [],
  ...over,
});

const syncNow = () => fetch(`${baseUrl}/api/unified-calls/sync-now`, { method: 'POST' });
const syncStatus = () => fetch(`${baseUrl}/api/unified-calls/sync-status`);

// --- happy path -------------------------------------------------------------

test('both sources succeed → 200 with per-source counts and freshness times', async () => {
  const res = await syncNow();
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(body.retell, { status: 'ok', added: 1, fetched: 1000 });
  assert.deepEqual(body.mango, { status: 'ok', found: 12, imported: 3 });
  assert.equal(body.lastSyncedAt, '2026-08-11T17:19:00.000Z');
  assert.equal(body.nextAutoSync, '2026-08-11T18:15:00.000Z');
  assert.deepEqual(calls, { retell: 1, mango: 1 });
});

test('the manual run is tagged trigger:manual with the acting user, for sync history', async () => {
  let seen = null;
  syncScheduler.runSync = async (options) => { seen = options; return mangoRun(); };

  await syncNow();

  assert.equal(seen.trigger, 'manual');
  assert.equal(seen.actor, SESSION_USER.email);
});

test('an audit row is written naming the actor and the per-source outcome', async () => {
  await syncNow();

  assert.equal(auditRows.length, 1);
  const row = auditRows[0];
  assert.equal(row.resourceType, 'voice.sync.manual');
  assert.equal(row.result, 'SUCCESS');
  assert.equal(row.userId, SESSION_USER.email);
  // Counts and status words only — never a caller name or number.
  assert.equal(row.resourceId, 'retell=ok:1;mango=ok:3');
});

// --- honest per-source states (NOT errors) ----------------------------------

test('Mango ingestion off (staging) + Retell ok → 200, mango off, no error state', async () => {
  syncScheduler.runSync = async () => ({
    success: false, code: syncScheduler.SYNC_SKIP_OFF, message: 'Mango ingestion is off (MANGO_INGEST_MODE=off)',
  });

  const res = await syncNow();
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(body.mango, { status: 'off' });
  assert.equal(body.retell.status, 'ok');
});

test('MANGO_SYNC_DISABLED reports the same honest "off", not a failure', async () => {
  syncScheduler.runSync = async () => ({
    success: false, code: syncScheduler.SYNC_SKIP_DISABLED, message: 'Mango sync disabled in this environment',
  });

  const res = await syncNow();
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).mango, { status: 'off' });
});

test('clicking during the :15 autosync passes "already_running" through, no double ingest', async () => {
  syncScheduler.runSync = async () => ({
    success: false, code: syncScheduler.SYNC_SKIP_RUNNING, message: 'Sync already in progress',
  });

  const res = await syncNow();
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(body.mango, { status: 'already_running' });
  assert.equal(body.retell.status, 'ok');
});

// --- failures ---------------------------------------------------------------

test('a thrown Retell sync is reported alone; a healthy Mango still returns 200', async () => {
  syncScheduler.runRetellSync = async () => { throw new Error('Retell 503'); };

  const res = await syncNow();
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.retell.status, 'error');
  assert.equal(body.retell.message, 'Retell 503');
  assert.equal(body.mango.status, 'ok');
});

test('a refusal with no recognized code is an error, never a silent zero-call success', async () => {
  syncScheduler.runSync = async () => ({ success: false, message: 'something new went wrong' });

  const body = await (await syncNow()).json();
  assert.deepEqual(body.mango, { status: 'error', message: 'something new went wrong' });
});

test("a Mango run that finished 'failed' is an error for Mango only", async () => {
  syncScheduler.runSync = async () => mangoRun({ status: 'failed', errors: ['token harvest failed'] });

  const res = await syncNow();
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(body.mango, { status: 'error', message: 'token harvest failed' });
  assert.equal(body.retell.status, 'ok');
});

test('both sources failing → 502, and the audit row records ERROR', async () => {
  syncScheduler.runRetellSync = async () => { throw new Error('Retell 503'); };
  syncScheduler.runSync = async () => { throw new Error('Mango unreachable'); };

  const res = await syncNow();
  assert.equal(res.status, 502);
  const body = await res.json();

  assert.equal(body.retell.status, 'error');
  assert.equal(body.mango.status, 'error');
  assert.equal(auditRows[0].result, 'ERROR');
});

// --- cooldown ---------------------------------------------------------------

test('a second click inside the cooldown → 429 with retryAfter, and NO second sync', async () => {
  const first = await syncNow();
  assert.equal(first.status, 200);
  assert.deepEqual(calls, { retell: 1, mango: 1 });

  const second = await syncNow();
  assert.equal(second.status, 429);
  const body = await second.json();

  assert.equal(body.code, 'SYNC_COOLDOWN');
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 60, `retryAfter was ${body.retryAfter}`);
  assert.equal(body.lastSyncedAt, '2026-08-11T17:19:00.000Z');
  assert.equal(second.headers.get('retry-after'), String(body.retryAfter));
  // The point of the throttle: the sources were not walked a second time.
  assert.deepEqual(calls, { retell: 1, mango: 1 });
});

test('button-mash while the first sync is still working → one run, the rest 429', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  syncScheduler.runRetellSync = async () => { calls.retell++; await gate; return { success: true, added: 0, fetched: 0 }; };

  const inFlight = syncNow();
  const mashed = await Promise.all([syncNow(), syncNow()]);
  release();

  assert.equal((await inFlight).status, 200);
  for (const res of mashed) {
    assert.equal(res.status, 429);
    assert.equal((await res.json()).code, 'SYNC_COOLDOWN');
  }
  assert.equal(calls.retell, 1);
});

test('a failed sync still starts the cooldown rather than wedging the button', async () => {
  syncScheduler.runRetellSync = async () => { throw new Error('Retell 503'); };
  syncScheduler.runSync = async () => { throw new Error('Mango unreachable'); };

  assert.equal((await syncNow()).status, 502);
  assert.equal((await syncNow()).status, 429); // cooldown, not a wedged in-flight flag
});

// --- status -----------------------------------------------------------------

test('GET /sync-status returns the caption fields without touching a sync', async () => {
  const res = await syncStatus();
  assert.equal(res.status, 200);

  assert.deepEqual(await res.json(), {
    lastSyncedAt: '2026-08-11T17:19:00.000Z',
    nextAutoSync: '2026-08-11T18:15:00.000Z',
    mangoMode: 'api',
  });
  assert.deepEqual(calls, { retell: 0, mango: 0 });
});

test('GET /sync-status is not captured by the /:id route', async () => {
  // A regression guard: registered after /:id it would 404 as a missing call.
  const body = await (await syncStatus()).json();
  assert.ok('mangoMode' in body, 'sync-status was shadowed by GET /:id');
});
