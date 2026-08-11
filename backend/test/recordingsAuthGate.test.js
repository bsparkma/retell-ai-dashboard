'use strict';

/**
 * Regression tests: /api/mango/recordings/* must be authenticated.
 *
 * The static recordings mount was once registered ABOVE the /api auth gate in
 * server.js, which served Mango call recordings (PHI audio) unauthenticated on
 * the public hostname. These tests pin the fix in two layers, mirroring
 * moduleGateWiring.test.js:
 *
 *  1. SOURCE SCAN of server.js — the recordings mount must exist exactly once,
 *     appear AFTER both the requireDashboardAuth gate and the tenantContext
 *     mount, and carry the voice module guard like the rest of /api/mango.
 *  2. BEHAVIORAL — the real requireDashboardAuth mounted above a static dir in
 *     the same shape as server.js, over an ephemeral HTTP server: anonymous
 *     requests get 401 (never file bytes); the bearer token gets past the auth
 *     gate (downstream tenant/module gates are covered by their own tests).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterEach } = test;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const express = require('express');
const { requireDashboardAuth } = require('../middleware/auth');

// --- 1. source scan ---------------------------------------------------------

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Matches the whole app.use(...) CALL, not just its first line — the mount now
// carries a module guard AND a permission guard and is wrapped across lines.
const RECORDINGS_MOUNT_RX = /app\.use\(\s*'\/api\/mango\/recordings'[\s\S]*?\);/g;

test('server.js: recordings static mount exists exactly once', () => {
  const matches = serverSrc.match(RECORDINGS_MOUNT_RX) || [];
  assert.equal(
    matches.length,
    1,
    `expected exactly one /api/mango/recordings mount, found ${matches.length}`
  );
});

test('server.js: recordings mount is registered BELOW the auth gate and tenant context', () => {
  const mountIdx = serverSrc.search(RECORDINGS_MOUNT_RX);
  const authGateIdx = serverSrc.indexOf('requireDashboardAuth({');
  const tenantIdx = serverSrc.indexOf('tenantContext({');
  assert.ok(mountIdx !== -1, 'server.js has no /api/mango/recordings mount');
  assert.ok(authGateIdx !== -1, 'server.js has no requireDashboardAuth gate');
  assert.ok(tenantIdx !== -1, 'server.js has no tenantContext mount');
  assert.ok(
    mountIdx > authGateIdx,
    'recordings mount must be registered AFTER the /api auth gate — ' +
      'above the gate it serves PHI audio unauthenticated on the public hostname'
  );
  assert.ok(
    mountIdx > tenantIdx,
    'recordings mount must be registered AFTER tenantContext (fail-closed tenant scoping)'
  );
});

test('server.js: recordings mount carries the voice module guard', () => {
  const line = (serverSrc.match(RECORDINGS_MOUNT_RX) || [''])[0];
  assert.ok(
    /voiceModule|requireModule\(\s*'voice'/.test(line),
    `recordings mount must be guarded like the rest of /api/mango: ${line}`
  );
});

test('server.js: auth-gate exemptions never include recordings', () => {
  // The gate's exempt list is the other way this could silently reopen.
  const gateBlock = serverSrc.slice(
    serverSrc.indexOf('requireDashboardAuth({'),
    serverSrc.indexOf('tenantContext({')
  );
  assert.ok(
    !/recordings/.test(gateBlock),
    'the /api auth-gate exempt list must not exempt recordings'
  );
});

// --- 2. behavioral ----------------------------------------------------------

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** Mount the REAL auth gate above a static recordings dir, server.js-shaped. */
async function startAppWithRecording() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-gate-'));
  fs.writeFileSync(path.join(dir, 'call.mp3'), 'FAKE-MP3-BYTES');
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

  const app = express();
  app.use(
    '/api',
    requireDashboardAuth({
      exempt: [/^\/webhooks(\/|$)/, /^\/health$/, /^\/retell-tools(\/|$)/],
    })
  );
  app.use('/api/mango/recordings', express.static(dir));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

test('behavioral: anonymous request for a recording is rejected, no file bytes leak', async () => {
  const prev = process.env.DASHBOARD_API_TOKEN;
  process.env.DASHBOARD_API_TOKEN = 'test-token-rec-gate';
  cleanups.push(() => {
    if (prev === undefined) delete process.env.DASHBOARD_API_TOKEN;
    else process.env.DASHBOARD_API_TOKEN = prev;
  });

  const base = await startAppWithRecording();
  const res = await get(`${base}/api/mango/recordings/call.mp3`);
  assert.equal(res.status, 401, `expected 401 for anonymous request, got ${res.status}`);
  assert.ok(
    !res.body.includes('FAKE-MP3-BYTES'),
    'response body must not contain the recording bytes'
  );
});

test('behavioral: bearer token passes the auth gate and reaches the file', async () => {
  const prev = process.env.DASHBOARD_API_TOKEN;
  process.env.DASHBOARD_API_TOKEN = 'test-token-rec-gate';
  cleanups.push(() => {
    if (prev === undefined) delete process.env.DASHBOARD_API_TOKEN;
    else process.env.DASHBOARD_API_TOKEN = prev;
  });

  const base = await startAppWithRecording();
  const res = await get(`${base}/api/mango/recordings/call.mp3`, {
    Authorization: 'Bearer test-token-rec-gate',
  });
  assert.equal(res.status, 200, `expected 200 with bearer token, got ${res.status}`);
  assert.equal(res.body, 'FAKE-MP3-BYTES');
});
