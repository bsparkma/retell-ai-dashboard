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
const odOffices = require('../config/odOffices');
const { OFFICES, MANGO_LINE_OFFICE } = require("../config/officeAgents");
const audit = require('../platform/audit');
const { DISPOSITIONS, NOTE_MAX_LENGTH } = require('../utils/callDispositions');

// Since the per-location slice, resolve-patient refuses an OD write for an office
// with no credentials (fail closed, per office). These tests are about triage and
// idempotency rather than credential loading, so both offices get placeholder keys.
// The values are meaningless strings — nothing in this file reaches a real OD.
function giveOfficesTestCredentials() {
  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-valley-customer-key';
  odOffices.resetOdOfficeCache();
}

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
  sessionRole = 'admin';
  originalRequestPersist = unifiedCallStore.requestPersist;
  unifiedCallStore.requestPersist = () => {};
  clearStore();
  giveOfficesTestCredentials();

  original = {
    audit: audit.audit,
    linkCallToPatient: openDentalSync.linkCallToPatient,
    syncCallToCommLog: openDentalSync.syncCallToCommLog,
  };

  // Fail-closed audit needs a tenant Postgres — no-op it here.
  audit.audit = async () => {};

  // Stub the OD write path. link mirrors what the REAL linkCallToPatient persists;
  // sync writes ONE commlog and marks the call synced, honoring the 'synced' dedup
  // guard like the real one.
  commlogWrites = 0;
  openDentalSync.linkCallToPatient = async (callId, patientId, options = {}) => {
    if (!unifiedCallStore.getCall(callId)) return { success: false, error: 'Call not found' };
    // The real service also writes od_patient_name + od_patient_office
    // (openDentalSync.js). A stub that set only the id was quietly weaker than
    // production, and it hid the fact that the resolve RESPONSE has to carry the
    // matched name — without it "Send to TC" stays unusable until a page refresh.
    unifiedCallStore.updateCall(callId, {
      od_patient_id: patientId,
      od_patient_name: 'Stedi Test 2',
      od_patient_office: options.expectOfficeKey ?? null,
    });
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

// --- disposition + notes ---------------------------------------------------
//
// The third way to finish a call, and the only one that writes nowhere: no Open
// Dental call and no TC call happens anywhere in these paths. The OD stubs above
// count every write, so `commlogWrites === 0` is a real assertion here, not a
// hopeful one.

const setDisposition = (id, body) =>
  fetch(`${baseUrl}/api/unified-calls/${id}/disposition`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const addNote = (id, body) =>
  fetch(`${baseUrl}/api/unified-calls/${id}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const deleteNote = (id, noteId) =>
  fetch(`${baseUrl}/api/unified-calls/${id}/notes/${noteId}`, { method: 'DELETE' });

test('disposition rejects an unknown value', async () => {
  seedCall('d1');
  const res = await setDisposition('d1', { disposition: 'banana' });
  assert.equal(res.status, 400);
  assert.equal(unifiedCallStore.getCall('d1').disposition, null, 'nothing was written');
});

test('disposition 404s for an unknown call', async () => {
  const res = await setDisposition('nope', { disposition: 'lab' });
  assert.equal(res.status, 404);
});

test('disposition stamps the value + actor attribution from the SESSION', async () => {
  seedCall('d2');
  const res = await setDisposition('d2', { disposition: 'lab' });
  assert.equal(res.status, 200);
  const call = await res.json();
  assert.equal(call.disposition, 'lab');
  assert.deepEqual(call.disposition_by, SESSION_USER);
  assert.ok(call.disposition_at, 'disposition_at is stamped');
  assert.equal(commlogWrites, 0, 'a disposition writes nothing to Open Dental');
});

test('the body cannot forge who dispositioned a call', async () => {
  seedCall('d3');
  await setDisposition('d3', {
    disposition: 'vendor',
    disposition_by: { name: 'Somebody Else', email: 'somebody@example.com' },
  });
  assert.deepEqual(unifiedCallStore.getCall('d3').disposition_by, SESSION_USER);
});

test('every one of the seven dispositions is accepted', async () => {
  for (const disposition of DISPOSITIONS) {
    const id = `d-each-${disposition}`;
    seedCall(id);
    const res = await setDisposition(id, { disposition });
    assert.equal(res.status, 200, `${disposition} must be accepted`);
    assert.equal((await res.json()).disposition, disposition);
  }
});

test('disposition: null clears the value and its attribution', async () => {
  seedCall('d4');
  await setDisposition('d4', { disposition: 'pharmacy' });
  const res = await setDisposition('d4', { disposition: null });
  assert.equal(res.status, 200);
  const call = await res.json();
  assert.equal(call.disposition, null);
  assert.equal(call.disposition_by, null);
  assert.equal(call.disposition_at, null);
});

test('a note is appended with author + timestamp from the session', async () => {
  seedCall('n1');
  const res = await addNote('n1', { text: '  Lab called about the crown case  ' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.note.text, 'Lab called about the crown case', 'text is trimmed');
  assert.deepEqual(body.note.author, SESSION_USER);
  assert.ok(body.note.id);
  assert.ok(body.note.created_at);
  // The response carries the whole call so a row can re-render without a refetch.
  assert.equal(body.call.notes.length, 1);
  assert.equal(commlogWrites, 0, 'a note writes nothing to Open Dental');
});

test('notes append rather than replace, and the store agrees with the response', async () => {
  seedCall('n2');
  await addNote('n2', { text: 'first' });
  const second = await addNote('n2', { text: 'second' });
  const body = await second.json();
  assert.equal(body.call.notes.length, 2);
  assert.deepEqual(
    unifiedCallStore.getCall('n2').notes.map((n) => n.text),
    ['first', 'second'],
    'persisted in the order they were written',
  );
});

test('an empty or whitespace-only note is refused', async () => {
  seedCall('n3');
  assert.equal((await addNote('n3', { text: '' })).status, 400);
  assert.equal((await addNote('n3', { text: '   \n  ' })).status, 400);
  assert.equal((await addNote('n3', {})).status, 400);
  assert.equal((await addNote('n3', { text: 42 })).status, 400);
  assert.equal(unifiedCallStore.getCall('n3').notes.length, 0);
});

test('a note over the length cap is refused, and the cap itself is accepted', async () => {
  seedCall('n4');
  const tooLong = 'x'.repeat(NOTE_MAX_LENGTH + 1);
  assert.equal((await addNote('n4', { text: tooLong })).status, 400);
  const atCap = await addNote('n4', { text: 'y'.repeat(NOTE_MAX_LENGTH) });
  assert.equal(atCap.status, 201);
});

test('notes 404 for an unknown call', async () => {
  assert.equal((await addNote('nope', { text: 'hello' })).status, 404);
  assert.equal((await deleteNote('nope', 'whatever')).status, 404);
});

test('the author can delete their own note', async () => {
  seedCall('n5');
  const created = await (await addNote('n5', { text: 'mine to remove' })).json();
  const res = await deleteNote('n5', created.note.id);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).call.notes.length, 0);
});

test("a non-author, non-admin cannot delete someone else's note", async () => {
  seedCall('n6');
  // Written by somebody else entirely (straight into the store, as if by another user).
  const { note } = unifiedCallStore.addNote('n6', 'not yours', { name: 'Dana Desk', email: 'dana@carein.ai' });
  // The session user is 'office' here — full worklist rights, but not an admin.
  sessionRole = 'office';

  const res = await deleteNote('n6', note.id);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'NOTE_DELETE_FORBIDDEN');
  assert.equal(unifiedCallStore.getCall('n6').notes.length, 1, 'the note is untouched');
});

test("an admin can delete someone else's note", async () => {
  seedCall('n7');
  const { note } = unifiedCallStore.addNote('n7', 'not yours', { name: 'Dana Desk', email: 'dana@carein.ai' });
  sessionRole = 'admin';

  const res = await deleteNote('n7', note.id);
  assert.equal(res.status, 200);
  assert.equal(unifiedCallStore.getCall('n7').notes.length, 0);
});

test('deleting a note that does not exist is a 404, not a silent success', async () => {
  seedCall('n8');
  await addNote('n8', { text: 'still here' });
  const res = await deleteNote('n8', 'no-such-note-id');
  assert.equal(res.status, 404);
  assert.equal(unifiedCallStore.getCall('n8').notes.length, 1);
});

test('author matching is case-insensitive on the email, not the display name', async () => {
  seedCall('n9');
  // Same person, different casing + a different display name than the session's.
  const { note } = unifiedCallStore.addNote('n9', 'mine', { name: 'S. Front', email: 'SARAH@CareIN.ai' });
  sessionRole = 'office';
  const res = await deleteNote('n9', note.id);
  assert.equal(res.status, 200, 'the same email in different case is the same author');
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
  // Compact 4-field block (item 2): header + Caller/Reason/Action/Callback lines.
  assert.match(body.note, /^CareIN call - /m);
  assert.match(body.note, /^Caller: /m);
  assert.match(body.note, /^Reason: .*Caller asked to reschedule a cleaning\./m);
  assert.match(body.note, /^Action: /m);
  assert.match(body.note, /^Callback #: /m);
  assert.equal(body.patientId, 12827);
  assert.equal(body.patientName, 'Stedi Test 2');
});

test('preview shows the full summary, and it is byte-for-byte what lands in OD', async () => {
  // The whole point of the fix: what the confirm dialog shows and what the chart
  // gets are the same string, and both now carry the summary the call page shows.
  seedCall('c-full-summary', { call_analysis: {} });
  unifiedCallStore.updateCall('c-full-summary', {
    od_patient_id: 12827, od_patient_name: 'Stedi Test 2',
    call_reason: 'Reschedule cleaning',
    summary: 'Caller wants to move her Tuesday cleaning to the following week; '
      + 'mornings work best and she asked for a call back to confirm.',
  });

  const preview = await fetch(`${baseUrl}/api/unified-calls/c-full-summary/commlog-preview`);
  assert.equal(preview.status, 200);
  const { note } = await preview.json();
  assert.match(note, /^Reason: Reschedule cleaning$/m);
  assert.match(note, /^Summary:$/m);
  assert.match(note, /mornings work best and she asked for a call back to confirm\./);

  const res = await resolve('c-full-summary', { patientId: 12827 }); // unedited send
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(lastNoteOverride, note, 'OD receives exactly the previewed note');
  assert.equal(body.call.sent_note, note);
  assert.equal(body.call.note_edited, false);
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

test('commlog-preview: content_type=transcript returns the full-transcript note (item 4)', async () => {
  seedCall('c-ct', { call_analysis: { call_summary: 'Billing question.' } });
  unifiedCallStore.updateCall('c-ct', {
    od_patient_id: 12827, summary: 'Billing question.',
    transcript: 'Hi, I have a question about my statement balance.',
  });
  // Default (summary) — compact block, no transcript.
  const sres = await fetch(`${baseUrl}/api/unified-calls/c-ct/commlog-preview`);
  const sbody = await sres.json();
  assert.match(sbody.note, /^Caller: /m);
  assert.ok(!/Full transcript/.test(sbody.note));
  // content_type=transcript — appends the full transcript.
  const tres = await fetch(`${baseUrl}/api/unified-calls/c-ct/commlog-preview?content_type=transcript`);
  const tbody = await tres.json();
  assert.match(tbody.note, /--- Full transcript ---/);
  assert.match(tbody.note, /question about my statement balance/);
});

// --- per-location slice: office scoping + cross-office guards ---------------
//
// These exercise the HTTP surface: the worklist and Pick Patient modal talk to
// these endpoints, and the UI is not the control — a hand-rolled request must be
// refused just as firmly as a hidden button.

/** Store a Mango call on a real office DID so it attributes exactly as production does. */
function seedMangoCall(id, did, extra = {}) {
  unifiedCallStore.calls.set(id, {
    id,
    source: 'mango',
    called_number: did,
    caller_number: '+15551234567',
    caller_name: 'Stedi TestValley',
    call_date: '2026-08-07T15:00:00.000Z',
    summary: 'wants an appointment',
    ...extra,
  });
}

const VALLEY_DID = Object.keys(MANGO_LINE_OFFICE).find((d) => MANGO_LINE_OFFICE[d] === 'valley');
const ROLAND_DID = Object.keys(MANGO_LINE_OFFICE).find((d) => MANGO_LINE_OFFICE[d] === 'roland');
const UNMAPPED_DID = '+15550000000';

/** Run a body with valley switched on, then restore the shipped switch value. */
async function withValleyConnected(fn) {
  const prev = odOffices.OFFICE_OD_SETTINGS.valley.odEnabled;
  odOffices.OFFICE_OD_SETTINGS.valley.odEnabled = true;
  odOffices.resetOdOfficeCache();
  try { return await fn(); } finally {
    odOffices.OFFICE_OD_SETTINGS.valley.odEnabled = prev;
    odOffices.resetOdOfficeCache();
  }
}

test('resolve-patient REFUSES a valley call sent with a roland office param', async () => {
  await withValleyConnected(async () => {
    seedMangoCall('x-mismatch', VALLEY_DID);
    const res = await resolve('x-mismatch', { patientId: 7115, office_id: 'roland' });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'OFFICE_MISMATCH');
    assert.equal(commlogWrites, 0, 'a refused resolve must write nothing');
  });
});

test('resolve-patient REFUSES a roland call sent with a valley office param', async () => {
  await withValleyConnected(async () => {
    seedMangoCall('x-mismatch-2', ROLAND_DID);
    const res = await resolve('x-mismatch-2', { patientId: 7115, office_id: 'valley' });

    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'OFFICE_MISMATCH');
    assert.equal(commlogWrites, 0);
  });
});

test('resolve-patient accepts the call\'s OWN office named explicitly', async () => {
  await withValleyConnected(async () => {
    seedMangoCall('x-ok', VALLEY_DID);
    const res = await resolve('x-ok', { patientId: 7115, office_id: 'valley' });
    assert.equal(res.status, 200);
    assert.equal(commlogWrites, 1);
  });
});

test('an unknown-office call is locked out of resolve SERVER-SIDE', async () => {
  seedMangoCall('x-unknown', UNMAPPED_DID);
  const res = await resolve('x-unknown', { patientId: 7115 });

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'OFFICE_UNKNOWN');
  assert.match(body.error, /office is unknown/i);
  assert.equal(commlogWrites, 0, 'an unmapped line must never reach a chart');
});

test('an unknown-office call CAN still be closed out as not-a-patient (no OD write)', async () => {
  // The lockout is on chart writes, not on clearing the pile. Otherwise unmapped
  // calls would be stuck in the worklist forever.
  seedMangoCall('x-unknown-2', UNMAPPED_DID);
  const res = await resolve('x-unknown-2', { notAPatient: true, reason: 'spam' });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).call.not_a_patient, true);
  assert.equal(commlogWrites, 0);
});

test('an office with no credentials is refused at the HTTP boundary', async () => {
  await withValleyConnected(async () => {
    delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
    odOffices.resetOdOfficeCache();

    seedMangoCall('x-nokey', VALLEY_DID);
    const res = await resolve('x-nokey', { patientId: 7115 });

    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'OFFICE_OD_KEY_MISSING');
    assert.equal(commlogWrites, 0);
  });
});

test('patient-search is scoped to the call, and names the office it searched', async () => {
  await withValleyConnected(async () => {
    // Record which office's client the route reached. Patching the instance method
    // (not the frozen handle) leaves the real office→client wiring under test.
    const searched = [];
    for (const key of ['roland', 'valley']) {
      const c = odOffices.getOdOffice(key).client;
      c.searchPatients = async (q) => {
        searched.push({ office: key, q });
        return key === 'valley'
          ? [{ id: 7115, fullName: 'Stedi TestValley' }]
          : [{ id: 7115, fullName: 'Different RolandPatient' }];
      };
    }

    seedMangoCall('x-search', VALLEY_DID);
    const res = await fetch(`${baseUrl}/api/unified-calls/x-search/patient-search?q=TestValley`);
    const body = await res.json();

    assert.equal(res.status, 200);
    // Only Riley's patient list was consulted.
    assert.deepEqual(searched.map((s) => s.office), ['valley']);
    assert.equal(body.patients[0].fullName, 'Stedi TestValley');
    // The response states WHICH practice was searched — that is what lets an
    // operator catch a wrong-office moment before they pick a patient.
    assert.equal(body.office.officeId, 'valley');
    assert.equal(body.office.officeName, OFFICES.valley.officeName);
  });
});

test('patient-search on an unknown-office call searches nothing and says why', async () => {
  seedMangoCall('x-search-unknown', UNMAPPED_DID);
  const res = await fetch(`${baseUrl}/api/unified-calls/x-search-unknown/patient-search?q=Test`);

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'OFFICE_UNKNOWN');
  assert.deepEqual(body.patients, []);
});

test('the office roster reports EFFECTIVE connectivity, not just the flag', async () => {
  await withValleyConnected(async () => {
    delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
    odOffices.resetOdOfficeCache();

    const res = await fetch(`${baseUrl}/api/unified-calls/offices`);
    const { offices } = await res.json();
    const valley = offices.find((o) => o.officeId === 'valley');

    // Switched on but unkeyed → the UI must still show it as not connected.
    assert.equal(valley.odConnected, false);
    assert.match(valley.odBlockedReason, /credentials/i);
  });
});

test('a single call fetch carries its server-resolved office', async () => {
  seedMangoCall('x-detail', VALLEY_DID);
  const res = await fetch(`${baseUrl}/api/unified-calls/x-detail`);
  const call = await res.json();

  // Call detail renders the same OD actions as the worklist, so it needs the same
  // office truth to gate them.
  assert.equal(call.office_id, 'valley');
  assert.equal(call.office.officeId, 'valley');
});

test('resolve-patient returns the COMPLETE post-send call, office and matched name included', async () => {
  // The client renders the post-send state from this record instead of patching
  // the fields it assumes changed. If the office or the matched patient's name
  // is missing here, the "Send to TC" button silently stays hidden/disabled
  // until a page refresh — the bug this response shape exists to prevent.
  seedMangoCall('x-complete', VALLEY_DID);

  const res = await fetch(`${baseUrl}/api/unified-calls/x-complete/resolve-patient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 7115 }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.ok(body.call, 'the updated call record is returned');
  assert.equal(body.call.office_id, 'valley', 'office is stamped like GET /:id stamps it');
  assert.equal(body.call.office.officeId, 'valley');
  assert.equal(body.call.od_patient_id, 7115);
  assert.equal(body.call.od_sync_status, 'synced');
  // The name the TC handoff contract requires, and the button refuses to fire without.
  assert.ok(body.call.od_patient_name, 'the matched patient name is carried back');
});

test('an already-synced resolve also returns the complete record', async () => {
  seedMangoCall('x-complete-2', VALLEY_DID);
  const send = () => fetch(`${baseUrl}/api/unified-calls/x-complete-2/resolve-patient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 7115 }),
  });

  await send();
  const body = await (await send()).json();

  assert.equal(body.alreadySynced, true);
  assert.equal(body.call.office_id, 'valley', 'the no-op path must not return a less complete record');
  assert.ok(body.call.od_patient_name);
});

// --- link-only: establishing the match without filing a chart note ----------

test('linkOnly sets the match and writes NO commlog', async () => {
  // The whole point of the scope: identifying who called must not force a note
  // into their chart.
  seedMangoCall('x-link', VALLEY_DID);

  const res = await fetch(`${baseUrl}/api/unified-calls/x-link/resolve-patient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 7115, linkOnly: true }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.linked, true);
  assert.equal(commlogWrites, 0, 'linking must not write a chart note');

  const stored = unifiedCallStore.getCall('x-link');
  assert.equal(stored.od_patient_id, 7115);
  assert.ok(stored.od_patient_name, 'the matched name is stored');
  // 'matched' is the existing review-then-send state, so the UI needs no new vocabulary.
  assert.equal(stored.od_sync_status, 'matched');
  // Nothing was sent, so nothing may claim it was.
  assert.equal(stored.sent_at ?? null, null);
  assert.equal(stored.sent_by ?? null, null);
  assert.equal(stored.od_commlog_num ?? null, null);
  // But WHO established the match is recorded.
  assert.deepEqual(stored.resolved_by, SESSION_USER);
  assert.ok(stored.resolved_at);
});

test('linkOnly returns the complete record so the row updates without a refresh', async () => {
  seedMangoCall('x-link-2', VALLEY_DID);
  const res = await fetch(`${baseUrl}/api/unified-calls/x-link-2/resolve-patient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 7115, linkOnly: true }),
  });
  const body = await res.json();

  assert.equal(body.call.office_id, 'valley');
  assert.equal(body.call.od_sync_status, 'matched');
  assert.ok(body.call.od_patient_name, 'the name Send to TC needs is in the response');
});

test('after linkOnly, sending to chart still writes exactly one commlog', async () => {
  // Link and send are now separate actions; doing both must not double-write, and
  // the send must still work on an already-linked call.
  seedMangoCall('x-link-3', VALLEY_DID);
  await fetch(`${baseUrl}/api/unified-calls/x-link-3/resolve-patient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 7115, linkOnly: true }),
  });
  assert.equal(commlogWrites, 0);

  const send = await fetch(`${baseUrl}/api/unified-calls/x-link-3/resolve-patient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 7115 }),
  });
  assert.equal(send.status, 200);
  assert.equal(commlogWrites, 1);
  assert.equal(unifiedCallStore.getCall('x-link-3').od_sync_status, 'synced');
});

test('linkOnly on an already-sent call is refused for a DIFFERENT patient', async () => {
  // The commlog is already filed against someone. Re-pointing the linkage would
  // leave the stored record disagreeing with the chart.
  seedMangoCall('x-link-4', VALLEY_DID);
  await fetch(`${baseUrl}/api/unified-calls/x-link-4/resolve-patient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 7115 }),
  });

  const res = await fetch(`${baseUrl}/api/unified-calls/x-link-4/resolve-patient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 9999, linkOnly: true }),
  });
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.equal(body.code, 'ALREADY_SENT_TO_CHART');
  assert.equal(unifiedCallStore.getCall('x-link-4').od_patient_id, 7115, 'the original link is untouched');
});

test('linkOnly on an already-sent call is a no-op for the SAME patient', async () => {
  seedMangoCall('x-link-5', VALLEY_DID);
  await fetch(`${baseUrl}/api/unified-calls/x-link-5/resolve-patient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 7115 }),
  });
  const before = commlogWrites;

  const res = await fetch(`${baseUrl}/api/unified-calls/x-link-5/resolve-patient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 7115, linkOnly: true }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.alreadySynced, true);
  assert.equal(commlogWrites, before, 'no extra write');
  assert.equal(unifiedCallStore.getCall('x-link-5').od_sync_status, 'synced', 'status is not downgraded');
});

test('linkOnly obeys the same cross-office refusal as a chart write', async () => {
  seedMangoCall('x-link-6', VALLEY_DID);
  const res = await fetch(`${baseUrl}/api/unified-calls/x-link-6/resolve-patient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 7115, linkOnly: true, office_id: 'roland' }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'OFFICE_MISMATCH');
  assert.equal(unifiedCallStore.getCall('x-link-6').od_patient_id ?? null, null);
});
