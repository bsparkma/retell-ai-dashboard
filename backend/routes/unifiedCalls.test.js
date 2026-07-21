'use strict';

// Unit tests for Slice B — triage worklist + patient review queue endpoints.
// Runner: `node --test`. Covers:
//   - PATCH /:id/triage validation (status enum, outcome-required-when-done,
//     outcome-only-when-done) + attribution stamping from the session user;
//   - POST /:id/resolve-patient idempotency: a second resolve of an already
//     'synced' call writes NO second commlog;
//   - POST /:id/resolve-patient "not a patient" close-out (no OD write).
//
// The router sits behind auth + tenantContext in server.js, so here we inject a
// fake req.user/req.tenant and stub the fail-closed audit writer + the OD sync
// singleton — mirroring routes/webhooks.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { beforeEach, afterEach } = test;
const http = require('node:http');
const express = require('express');

const router = require('./unifiedCalls');
const unifiedCallStore = require('../services/unifiedCallStore');
const openDentalSync = require('../services/openDentalSync');
const audit = require('../platform/audit');

const SESSION_USER = { name: 'Sarah Front', email: 'sarah@carein.ai' };

let server;
let baseUrl;
let originalRequestPersist;
let original;
let commlogWrites;
let lastNoteOverride; // what the endpoint handed the OD write boundary

function clearStore() {
  unifiedCallStore.calls.clear();
  unifiedCallStore.bySource.retell.clear();
  unifiedCallStore.bySource.mango.clear();
  unifiedCallStore.byDate.clear();
  unifiedCallStore.byCallerNumber.clear();
}

beforeEach(async () => {
  originalRequestPersist = unifiedCallStore.requestPersist;
  unifiedCallStore.requestPersist = () => {};
  clearStore();

  original = {
    audit: audit.audit,
    linkCallToPatient: openDentalSync.linkCallToPatient,
    syncCallToCommLog: openDentalSync.syncCallToCommLog,
  };

  // Fail-closed audit needs a tenant Postgres — no-op it here.
  audit.audit = async () => {};

  // Stub the OD write path. link just sets od_patient_id; sync writes ONE commlog
  // and marks the call synced, honoring the 'synced' dedup guard like the real one.
  commlogWrites = 0;
  openDentalSync.linkCallToPatient = async (callId, patientId) => {
    if (!unifiedCallStore.getCall(callId)) return { success: false, error: 'Call not found' };
    unifiedCallStore.updateCall(callId, { od_patient_id: patientId });
    return { success: true, patient: { id: patientId, fullName: 'Stedi Test 2' } };
  };
  commlogWrites = 0;
  lastNoteOverride = undefined;
  openDentalSync.syncCallToCommLog = async (callId, options = {}) => {
    const call = unifiedCallStore.getCall(callId);
    if (call.od_sync_status === 'synced') return { success: true, skipped: true, message: 'Already synced' };
    lastNoteOverride = options.noteOverride; // the note that would be written to OD
    commlogWrites += 1;
    const commLogNum = 9000 + commlogWrites;
    unifiedCallStore.updateCall(callId, { od_sync_status: 'synced', od_commlog_num: commLogNum });
    return { success: true, commLogNum };
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = SESSION_USER;
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
  unifiedCallStore.requestPersist = originalRequestPersist;
  audit.audit = original.audit;
  openDentalSync.linkCallToPatient = original.linkCallToPatient;
  openDentalSync.syncCallToCommLog = original.syncCallToCommLog;
  await new Promise((resolve) => server.close(resolve));
});

function seedCall(id, extra = {}) {
  unifiedCallStore.addRetellCall({
    call_id: id,
    from_number: '+15551234567',
    start_timestamp: '2026-06-06T20:00:00.000Z',
    ...extra,
  });
}

const patch = (id, body) =>
  fetch(`${baseUrl}/api/unified-calls/${id}/triage`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const resolve = (id, body) =>
  fetch(`${baseUrl}/api/unified-calls/${id}/resolve-patient`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// --- triage validation -----------------------------------------------------

test('triage rejects an invalid status', async () => {
  seedCall('c1');
  const res = await patch('c1', { triage_status: 'bogus' });
  assert.equal(res.status, 400);
});

test("triage 'done' requires an outcome", async () => {
  seedCall('c2');
  const res = await patch('c2', { triage_status: 'done' });
  assert.equal(res.status, 400);
});

test('triage rejects an outcome when status is not done', async () => {
  seedCall('c3');
  const res = await patch('c3', { triage_status: 'needs_action', triage_outcome: 'scheduled' });
  assert.equal(res.status, 400);
});

test('triage 404s for an unknown call', async () => {
  const res = await patch('nope', { triage_status: 'needs_action' });
  assert.equal(res.status, 404);
});

test('triage done+scheduled stamps outcome + actor attribution', async () => {
  seedCall('c4');
  const res = await patch('c4', { triage_status: 'done', triage_outcome: 'scheduled', triage_note: 'Booked hygiene' });
  assert.equal(res.status, 200);
  const call = await res.json();
  assert.equal(call.triage_status, 'done');
  assert.equal(call.triage_outcome, 'scheduled');
  assert.equal(call.triage_note, 'Booked hygiene');
  assert.deepEqual(call.triage_by, SESSION_USER);
  assert.ok(call.triage_at, 'triage_at is stamped');
});

// --- resolve-patient idempotency + not-a-patient ---------------------------

test('resolve-patient requires a patientId (or notAPatient)', async () => {
  seedCall('c5');
  const res = await resolve('c5', {});
  assert.equal(res.status, 400);
});

test('resolve-patient writes ONE commlog; a second resolve writes none', async () => {
  seedCall('c6');

  const first = await resolve('c6', { patientId: 12827 });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.success, true);
  assert.equal(firstBody.commLogNum, 9001);
  assert.equal(commlogWrites, 1);

  const second = await resolve('c6', { patientId: 12827 });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.alreadySynced, true);
  assert.equal(commlogWrites, 1, 'no second commlog was written');
});

test('resolve-patient stamps resolve + send attribution', async () => {
  seedCall('c7');
  const res = await resolve('c7', { patientId: 12827 });
  const body = await res.json();
  assert.deepEqual(body.call.resolved_by, SESSION_USER);
  assert.ok(body.call.resolved_at);
  // Writing the commlog IS "send to chart" → sent_by/sent_at stamped (Slice B.1).
  assert.deepEqual(body.call.sent_by, SESSION_USER);
  assert.ok(body.call.sent_at);
  assert.equal(body.call.od_patient_id, 12827);
});

test('send a matched call → one commlog, sent attribution (review-then-send)', async () => {
  // A call already auto-matched (flag off) carries od_patient_id + status 'matched'.
  seedCall('c-matched', { call_analysis: {} });
  unifiedCallStore.updateCall('c-matched', {
    od_sync_status: 'matched', od_patient_id: 12827, od_patient_name: 'Stedi Test 2',
  });
  const res = await resolve('c-matched', { patientId: 12827 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(commlogWrites, 1, 'send writes exactly one commlog');
  assert.deepEqual(body.call.sent_by, SESSION_USER);
  assert.equal(body.call.od_sync_status, 'synced');
});

test('commlog-preview returns the exact note the send will write', async () => {
  seedCall('c-preview', {
    call_analysis: { call_summary: 'Caller asked to reschedule a cleaning.' },
  });
  unifiedCallStore.updateCall('c-preview', { od_patient_id: 12827, od_patient_name: 'Stedi Test 2', summary: 'Caller asked to reschedule a cleaning.' });
  const res = await fetch(`${baseUrl}/api/unified-calls/c-preview/commlog-preview`);
  assert.equal(res.status, 200);
  const body = await res.json();
  // Matches the real formatter (formatCommLogEntry) — same note the send path writes.
  const expected = openDentalSync.formatCommLogEntry(unifiedCallStore.getCall('c-preview'), {});
  assert.equal(body.note, expected.Note);
  assert.match(body.note, /CALL SUMMARY/);
  assert.match(body.note, /Caller asked to reschedule a cleaning\./);
  assert.equal(body.patientId, 12827);
  assert.equal(body.patientName, 'Stedi Test 2');
});

test('edited note is sanitized and is exactly what lands; note_edited=true', async () => {
  seedCall('c-edit', { call_analysis: { call_summary: 'Reschedule cleaning.' } });
  unifiedCallStore.updateCall('c-edit', { od_patient_id: 12827, summary: 'Reschedule cleaning.' });
  // Smart quotes + em-dash + ellipsis from a copy-paste.
  const edited = 'Front desk: called back, all set — see ‘chart’…';
  const res = await resolve('c-edit', { patientId: 12827, note: edited });
  assert.equal(res.status, 200);
  const body = await res.json();
  const expected = "Front desk: called back, all set -- see 'chart'...";
  assert.equal(lastNoteOverride, expected, 'OD receives the sanitized edited text');
  assert.equal(body.call.sent_note, expected);
  assert.equal(body.call.note_edited, true);
});

test('unedited send persists the generated note; note_edited=false', async () => {
  seedCall('c-unedited', { call_analysis: { call_summary: 'Billing question.' } });
  unifiedCallStore.updateCall('c-unedited', { od_patient_id: 12827, summary: 'Billing question.' });
  const res = await resolve('c-unedited', { patientId: 12827 }); // no note field
  const body = await res.json();
  const generated = openDentalSync.formatCommLogEntry(unifiedCallStore.getCall('c-unedited'), {}).Note;
  assert.equal(body.call.sent_note, generated);
  assert.equal(body.call.note_edited, false);
  assert.equal(lastNoteOverride, generated);
});

test('sending the generated note back (reset) is not flagged edited', async () => {
  seedCall('c-reset', { call_analysis: { call_summary: 'Lost item.' } });
  unifiedCallStore.updateCall('c-reset', { od_patient_id: 12827, summary: 'Lost item.' });
  const generated = openDentalSync.formatCommLogEntry(unifiedCallStore.getCall('c-reset'), {}).Note;
  const res = await resolve('c-reset', { patientId: 12827, note: generated });
  const body = await res.json();
  assert.equal(body.call.note_edited, false);
});

test('resolve-patient not-a-patient close-out writes no commlog', async () => {
  seedCall('c8');
  const res = await resolve('c8', { notAPatient: true, reason: 'spam' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.notAPatient, true);
  assert.equal(body.call.not_a_patient, true);
  assert.equal(body.call.not_a_patient_reason, 'spam');
  assert.deepEqual(body.call.resolved_by, SESSION_USER);
  assert.equal(commlogWrites, 0);
});

test('resolve-patient rejects an invalid not-a-patient reason', async () => {
  seedCall('c9');
  const res = await resolve('c9', { notAPatient: true, reason: 'nonsense' });
  assert.equal(res.status, 400);
});

test('resolve-patient accepts the vendor + lab close-out reasons', async () => {
  for (const [id, reason] of [['c10', 'vendor'], ['c11', 'lab']]) {
    seedCall(id);
    const res = await resolve(id, { notAPatient: true, reason });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.call.not_a_patient_reason, reason);
  }
});
