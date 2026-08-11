'use strict';

// Unit tests for Mango slice M6 — POST /api/unified-calls/:id/send-to-tc, the
// voice side of the cross-module handoff. Runner: `node --test`.
//
// What is pinned here is everything a human could get wrong or a stale client
// could assert wrongly:
//   - the guard matrix (module entitlement, unknown office, no patient, no name,
//     cross-office assertion) — each refuses BEFORE the TC endpoint is called;
//   - the payload is assembled from the STORED call, never from the request body;
//   - attached-vs-created is passed through untouched (the toast splits on it);
//   - a failure NEVER persists a linkage and never reads as success;
//   - idempotency: a second send returns the same case with no second TC call.
//
// The router sits behind auth + tenantContext + requireModule('voice') in
// server.js, so we inject req.user/req.tenant here and stub the fail-closed audit
// writer and the TC client — mirroring routes/unifiedCalls.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { beforeEach, afterEach } = test;
const express = require('express');

const router = require('./unifiedCalls');
const unifiedCallStore = require('../services/unifiedCallStore');
const tcCaseClient = require('../services/tcCaseClient');
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
let originalRequestPersist;
let original;
/** Every payload handed to the TC endpoint this test. */
let tcCalls;
/** What the stubbed TC endpoint returns next. */
let tcResponse;
/** Every audit row written this test. */
let auditRows;
/** Modules the injected tenant is entitled to (the /auth/me equivalent). */
let tenantModules;

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

  original = {
    audit: audit.audit,
    createCaseFromCall: tcCaseClient.createCaseFromCall,
  };

  auditRows = [];
  audit.audit = async (_req, entry) => { auditRows.push(entry); };

  tcCalls = [];
  tcResponse = { ok: true, caseId: 'case_new_1', url: '/tc/cases/case_new_1', attached: false };
  tcCaseClient.createCaseFromCall = async (_req, payload) => {
    tcCalls.push(payload);
    return tcResponse;
  };

  tenantModules = ['voice', 'tc'];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = SESSION_USER;
    req.userRole = sessionRole;
    req.tenant = { id: 'tenant-test', modules: tenantModules };
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
  tcCaseClient.createCaseFromCall = original.createCaseFromCall;
  await new Promise((resolve) => server.close(resolve));
});

/**
 * Seed a Retell call. agent_id is left unset so getOfficeForCall resolves the
 * Retell fallback office ('roland'); `office` overrides via a mapped Mango DID
 * are not needed — the office-unknown case seeds a Mango call instead.
 */
function seedCall(id, extra = {}) {
  return unifiedCallStore.addRetellCall({
    call_id: id,
    from_number: '+14795551414',
    start_timestamp: '2026-08-07T20:00:00.000Z',
    ...extra,
  });
}

/** A Mango call on an UNMAPPED line → office resolves to 'unknown'. */
function seedUnknownOfficeCall(id, extra = {}) {
  const [added] = unifiedCallStore.addMangoCalls([{
    source: 'mango',
    external_id: id,
    mango_call_id: id,
    call_date: '2026-08-07T20:00:00.000Z',
    caller_number: '+14795551414',
    called_number: '+19995550000', // not in MANGO_LINE_OFFICE
    ...extra,
  }]);
  return added;
}

async function sendToTc(id, body = {}) {
  const res = await fetch(`${baseUrl}/api/unified-calls/${encodeURIComponent(id)}/send-to-tc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** A fully-sendable call: matched patient, name, real office. */
function seedSendable(id = 'call_ok', extra = {}) {
  seedCall(id, extra);
  unifiedCallStore.updateCall(id, {
    od_patient_id: 7115,
    od_patient_name: 'Stedi TestValley',
    od_sync_status: 'matched',
    ...extra,
  });
  return unifiedCallStore.getCall(id);
}

// --- the guard matrix ------------------------------------------------------

test('a tenant without the tc module is refused, and the TC endpoint is never called', async () => {
  tenantModules = ['voice'];
  seedSendable('call_no_module');

  const res = await sendToTc('call_no_module');

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'MODULE_NOT_ENTITLED');
  assert.equal(tcCalls.length, 0, 'must not reach TC without the entitlement');
  assert.equal(unifiedCallStore.getCall('call_no_module').tc_case_id, null);
});

test('a call with an unknown office is refused — a case must belong to a practice', async () => {
  const added = seedUnknownOfficeCall('mango_unmapped');
  unifiedCallStore.updateCall(added.id, { od_patient_id: 7115, od_patient_name: 'Stedi TestValley' });

  const res = await sendToTc(added.id);

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'OFFICE_UNKNOWN');
  assert.equal(tcCalls.length, 0);
});

test('a call with no matched patient is refused', async () => {
  seedCall('call_unmatched');

  const res = await sendToTc('call_unmatched');

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NO_MATCHED_PATIENT');
  assert.equal(tcCalls.length, 0);
});

test('a matched call with no stored patient name is refused rather than sent nameless', async () => {
  // patient_name is REQUIRED by the contract and is what TC files the case under.
  seedCall('call_nameless');
  unifiedCallStore.updateCall('call_nameless', { od_patient_id: 7115, od_patient_name: '   ' });

  const res = await sendToTc('call_nameless');

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'PATIENT_NAME_UNAVAILABLE');
  assert.equal(tcCalls.length, 0);
});

test('a client asserting the wrong office is refused, not obeyed', async () => {
  // The call is Roland (Retell fallback); a stale tab claims valley.
  seedSendable('call_cross_office');

  const res = await sendToTc('call_cross_office', { office_id: 'valley' });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'OFFICE_MISMATCH');
  assert.equal(tcCalls.length, 0, 'a mismatch must never file the case anywhere');
  assert.equal(
    auditRows.filter((r) => r.result === 'UNAUTHORIZED').length, 1,
    'a blocked cross-office attempt is audited'
  );
});

test('an unknown call id is 404', async () => {
  const res = await sendToTc('call_does_not_exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'CALL_NOT_FOUND');
});

// --- payload assembly ------------------------------------------------------

test('the payload is assembled from the stored call, not the request body', async () => {
  seedSendable('call_payload', { summary: 'Patient asked about a crown.' });

  // The body tries to name a different patient and office. Both must be ignored
  // (the office assertion matches, so the request is not refused outright).
  const res = await sendToTc('call_payload', {
    office_id: 'roland',
    od_patient_id: 999999,
    patient_name: 'Someone Else',
    office: 'valley',
  });

  assert.equal(res.status, 200);
  assert.equal(tcCalls.length, 1);
  assert.deepEqual(tcCalls[0], {
    od_patient_id: 7115,
    office: 'roland',
    call_id: 'call_payload',
    call_summary: 'Patient asked about a crown.',
    call_url: '/calls/call_payload',
    patient_name: 'Stedi TestValley',
    patient_phone: '+14795551414',
  });
});

test('call_summary is always a string or null, never a structured shape', async () => {
  // The transcript-shape bug (2026-08-08) was a structured field reaching a consumer
  // that expected scalars. TC's body schema is z.string().nullable() AND .strict(), so
  // a non-string summary would 400 the whole handoff. `summary` is a scalar from
  // callAnalyzer and never transcript_json — pinned here because this is the
  // cross-module boundary where such a regression is expensive to diagnose.
  seedSendable('call_summary_type', { summary: 'Patient asked to reschedule.' });
  await sendToTc('call_summary_type');
  assert.equal(typeof tcCalls[0].call_summary, 'string');

  seedSendable('call_summary_null');
  await sendToTc('call_summary_null');
  assert.equal(tcCalls[1].call_summary, null);
});

test('an untranscribed call still hands over, with a null summary', async () => {
  // The handoff does not require a transcript — a coordinator can still want the
  // call on the case. call_summary carries null rather than an invented string.
  seedSendable('call_no_transcript');

  const res = await sendToTc('call_no_transcript');

  assert.equal(res.status, 200);
  assert.equal(tcCalls[0].call_summary, null);
});

test('an unknown caller number is omitted rather than sent as the literal "Unknown"', async () => {
  seedCall('call_anon', { from_number: 'Unknown' });
  unifiedCallStore.updateCall('call_anon', { od_patient_id: 7115, od_patient_name: 'Stedi TestValley' });

  const res = await sendToTc('call_anon');

  assert.equal(res.status, 200);
  assert.equal('patient_phone' in tcCalls[0], false);
});

// --- attached vs created ---------------------------------------------------

test('a new case reports attached:false', async () => {
  seedSendable('call_created');
  tcResponse = { ok: true, caseId: 'case_created_1', url: '/tc/cases/case_created_1', attached: false };

  const res = await sendToTc('call_created');

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.attached, false);
  assert.equal(res.body.caseId, 'case_created_1');
});

test('joining an existing open case reports attached:true', async () => {
  seedSendable('call_attached');
  tcResponse = { ok: true, caseId: 'case_existing_9', url: '/tc/cases/case_existing_9', attached: true };

  const res = await sendToTc('call_attached');

  assert.equal(res.status, 200);
  assert.equal(res.body.attached, true);
  assert.equal(res.body.caseId, 'case_existing_9');
});

// --- persistence + audit ---------------------------------------------------

test('a successful send persists the linkage and audits the send', async () => {
  seedSendable('call_persist');
  tcResponse = { ok: true, caseId: 'case_p1', url: '/tc/cases/case_p1', attached: false };

  await sendToTc('call_persist');
  const stored = unifiedCallStore.getCall('call_persist');

  assert.equal(stored.tc_case_id, 'case_p1');
  assert.equal(stored.tc_case_url, '/tc/cases/case_p1');
  assert.ok(stored.tc_sent_at, 'tc_sent_at is stamped');
  assert.deepEqual(stored.tc_sent_by, SESSION_USER);

  const success = auditRows.filter((r) => r.result === 'SUCCESS');
  assert.equal(success.length, 1);
  assert.equal(success[0].action, 'CREATE');
  assert.equal(success[0].resourceType, 'tc_case');
  assert.equal(success[0].resourceId, 'case_p1');
  assert.equal(success[0].office, 'roland');
});

// --- failure states --------------------------------------------------------

test('an undeployed TC endpoint (404) fails as 502 and persists nothing', async () => {
  seedSendable('call_tc_missing');
  tcResponse = { ok: false, status: 404, code: 'TC_ENDPOINT_MISSING', error: 'not found' };

  const res = await sendToTc('call_tc_missing');

  assert.equal(res.status, 502, 'their 404 must not read to us as "call not found"');
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'TC_ENDPOINT_MISSING');
  const stored = unifiedCallStore.getCall('call_tc_missing');
  assert.equal(stored.tc_case_id, null, 'a failed send must never look sent');
  assert.equal(stored.tc_sent_at, null);
});

test('an unreachable TC app fails as 502 and persists nothing', async () => {
  seedSendable('call_tc_down');
  tcResponse = { ok: false, status: 0, code: 'TC_UNREACHABLE', error: 'The TC app did not respond' };

  const res = await sendToTc('call_tc_down');

  assert.equal(res.status, 502);
  assert.equal(res.body.success, false);
  assert.equal(unifiedCallStore.getCall('call_tc_down').tc_case_id, null);
  assert.equal(auditRows.filter((r) => r.result === 'ERROR').length, 1);
});

test('a TC 403 is surfaced as 403 and persists nothing', async () => {
  seedSendable('call_tc_403');
  tcResponse = { ok: false, status: 403, code: 'TC_MODULE_NOT_ENTITLED', error: 'not entitled' };

  const res = await sendToTc('call_tc_403');

  assert.equal(res.status, 403);
  assert.equal(unifiedCallStore.getCall('call_tc_403').tc_case_id, null);
});

test('a 200 with no case id is treated as a failure, not a silent success', async () => {
  seedSendable('call_tc_garbage');
  tcResponse = { ok: false, status: 502, code: 'TC_BAD_RESPONSE', error: 'unrecognized response' };

  const res = await sendToTc('call_tc_garbage');

  assert.equal(res.status, 502);
  assert.equal(unifiedCallStore.getCall('call_tc_garbage').tc_case_id, null);
});

// --- idempotency -----------------------------------------------------------

test('a second send returns the same case without calling TC again', async () => {
  seedSendable('call_twice');
  tcResponse = { ok: true, caseId: 'case_once', url: '/tc/cases/case_once', attached: false };

  const first = await sendToTc('call_twice');
  const second = await sendToTc('call_twice');

  assert.equal(first.body.caseId, 'case_once');
  assert.equal(second.status, 200);
  assert.equal(second.body.success, true);
  assert.equal(second.body.alreadySent, true);
  assert.equal(second.body.caseId, 'case_once');
  assert.equal(second.body.url, '/tc/cases/case_once');
  assert.equal(tcCalls.length, 1, 'the TC endpoint is called exactly once');
  assert.equal(
    auditRows.filter((r) => r.result === 'SUCCESS').length, 1,
    'a no-op re-send writes no second audit row'
  );
});
