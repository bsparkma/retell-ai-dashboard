'use strict';

/**
 * POST /api/mango/calls/:callId/transcribe — the HTTP surface (Mango slice M4).
 *
 * The orchestration is covered by services/onDemandTranscription.test.js. What is pinned
 * HERE is what the route itself owns and what a service test cannot see:
 *
 *   - the typed outcome reaches the client with its intended status code, so the UI can
 *     tell "budget spent" from "recording gone" from "already running";
 *   - EVERY attempt writes a HIPAA audit row, refusals included — a click that served or
 *     refused PHI is still an access event;
 *   - a completed run is a CREATE (new PHI), everything else a READ;
 *   - the audit is FAIL-CLOSED: if the audit write throws, the client gets an error, never
 *     a success body;
 *   - a completed run nudges open dashboards over Socket.IO.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;
const http = require('node:http');
const express = require('express');

const audit = require('../platform/audit');
const onDemand = require('../services/onDemandTranscription');
const liveCallManager = require('../services/liveCallManager');
const mangoRouter = require('../routes/mango');

const saved = {};
let auditRows = [];
let emitted = [];

beforeEach(() => {
  saved.audit = audit.audit;
  saved.transcribeCall = onDemand.transcribeCall;
  saved.io = liveCallManager.io;

  auditRows = [];
  emitted = [];
  audit.audit = async (_req, entry) => { auditRows.push(entry); };
  liveCallManager.io = { emit: (event, payload) => emitted.push({ event, payload }) };
});

afterEach(() => {
  audit.audit = saved.audit;
  onDemand.transcribeCall = saved.transcribeCall;
  liveCallManager.io = saved.io;
});

const cleanups = [];
test.afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

/** The router mounted with a session/tenant already attached, as server.js does upstream. */
async function startApp({ role = 'office' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { name: 'Front Desk', email: 'desk@example.com' };
    req.tenant = { id: 'tenant-test' };
    // Roles PR A: tenantContext attaches this upstream in the real app.
    req.userRole = role;
    next();
  });
  app.use('/api/mango', mangoRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function post(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, body: json, raw: body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('a completed run returns 200, audits a CREATE, and emits call:updated', async () => {
  onDemand.transcribeCall = async () => ({
    httpStatus: 200,
    outcome: 'completed',
    call: { id: 'c1', transcript: 'hi' },
    body: { status: 'completed', transcript: 'hi', summary: 'A summary.', minutesUsed: 1.5 },
  });

  const base = await startApp();
  const res = await post(`${base}/api/mango/calls/c1/transcribe`);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'completed');
  assert.equal(res.body.minutesUsed, 1.5);

  assert.equal(auditRows.length, 1);
  assert.deepEqual(auditRows[0], {
    action: 'CREATE', resourceType: 'transcript', resourceId: 'c1', result: 'SUCCESS',
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'call:updated');
  assert.equal(emitted[0].payload.id, 'c1');
});

test('the acting SSO user is passed through for attribution', async () => {
  let seenActor;
  onDemand.transcribeCall = async (_id, opts) => {
    seenActor = opts.actor;
    return { httpStatus: 200, outcome: 'exists', body: { status: 'exists', transcript: 't', summary: null } };
  };

  const base = await startApp();
  await post(`${base}/api/mango/calls/c2/transcribe`);

  assert.deepEqual(seenActor, { name: 'Front Desk', email: 'desk@example.com' });
});

test('every refusal is still audited — as a READ, with result ERROR when it failed', async () => {
  const cases = [
    { outcome: 'exists', httpStatus: 200, status: 'exists', result: 'SUCCESS' },
    { outcome: 'in_progress', httpStatus: 409, status: 'in_progress', result: 'ERROR' },
    { outcome: 'budget_exhausted', httpStatus: 429, status: 'budget_exhausted', result: 'ERROR' },
    { outcome: 'recording_not_ready', httpStatus: 422, status: 'recording_not_ready', result: 'ERROR' },
    { outcome: 'recording_unavailable', httpStatus: 422, status: 'recording_unavailable', result: 'ERROR' },
    { outcome: 'not_found', httpStatus: 404, status: 'not_found', result: 'ERROR' },
    { outcome: 'error', httpStatus: 500, status: 'error', result: 'ERROR' },
  ];

  const base = await startApp();
  for (const c of cases) {
    auditRows = [];
    emitted = [];
    onDemand.transcribeCall = async () => ({
      httpStatus: c.httpStatus,
      outcome: c.outcome,
      body: { status: c.status },
    });

    const res = await post(`${base}/api/mango/calls/c3/transcribe`);
    assert.equal(res.status, c.httpStatus, `${c.outcome} must keep its status code`);
    assert.equal(res.body.status, c.status);
    assert.equal(auditRows.length, 1, `${c.outcome} must still be audited`);
    assert.equal(auditRows[0].action, 'READ', `${c.outcome} creates no new PHI`);
    assert.equal(auditRows[0].result, c.result);
    assert.equal(emitted.length, 0, `${c.outcome} must not announce a transcript`);
  }
});

test('the budget refusal carries resetsAt all the way to the client', async () => {
  const resetsAt = '2026-08-07T05:00:00.000Z';
  onDemand.transcribeCall = async () => ({
    httpStatus: 429,
    outcome: 'budget_exhausted',
    body: { status: 'budget_exhausted', error: 'Daily transcription budget is used up.', resetsAt, usedMinutes: 120, capMinutes: 120 },
  });

  const base = await startApp();
  const res = await post(`${base}/api/mango/calls/c4/transcribe`);

  assert.equal(res.status, 429);
  assert.equal(res.body.resetsAt, resetsAt, 'the UI needs this to say WHEN it resets');
});

test('a failed audit write is fail-closed — no success body is returned', async () => {
  onDemand.transcribeCall = async () => ({
    httpStatus: 200,
    outcome: 'completed',
    call: { id: 'c5' },
    body: { status: 'completed', transcript: 'hi', summary: null, minutesUsed: 1 },
  });
  audit.audit = async () => { throw new audit.AuditError('audit store unreachable'); };

  const base = await startApp();
  const res = await post(`${base}/api/mango/calls/c5/transcribe`);

  assert.equal(res.status, 500);
  assert.equal(res.body.status, 'error');
  assert.notEqual(res.body.status, 'completed');
});

test('an unexpected service throw becomes a 500 error state, never a partial success', async () => {
  onDemand.transcribeCall = async () => { throw new Error('kaboom'); };

  const base = await startApp();
  const res = await post(`${base}/api/mango/calls/c6/transcribe`);

  assert.equal(res.status, 500);
  assert.equal(res.body.status, 'error');
  assert.ok(res.body.error.includes('nothing was saved'));
});
