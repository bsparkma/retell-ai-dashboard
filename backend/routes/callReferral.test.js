'use strict';

/**
 * POST /api/unified-calls/:id/referral — start a referral from a call (queue
 * item 54, R3, path b). Send-to-TC's producer shape:
 *
 *   2  the office is the CALL's (getOfficeForCall); a body office_id can only
 *      409; the patient is the stored match, never the body
 *   3  a call with no matched patient (or no name, or a match from another
 *      office) is an honest refusal, and nothing is created
 *   +  links the case the call was sent to when it is this office's; dark
 *      unless TC + referrals; voice.send_to_tc only
 *   +  NO call-store field is written: the call record is byte-for-byte the
 *      same after a referral (the referral carries `call` + the id instead)
 *   4  zero Open Dental (no OD client is reachable from this route)
 *
 * Test patient 12827 (roland) only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { beforeEach, afterEach } = test;
const express = require('express');
const { randomUUID } = require('node:crypto');

const router = require('./unifiedCalls');
const unifiedCallStore = require('../services/unifiedCallStore');
const tenantDb = require('../platform/tenantDb');
const registry = require('../platform/registry');
const tcReferrals = require('../config/tcReferrals');
const { FakeTenantDb, auditRows } = require('./tc/tcTestUtils');

let server;
let baseUrl;
let db;
let tenantModules;
let sessionRole;
const original = {};

function clearStore() {
  unifiedCallStore.calls.clear();
  unifiedCallStore.bySource.retell.clear();
  unifiedCallStore.bySource.mango.clear();
  unifiedCallStore.byDate.clear();
  unifiedCallStore.byCallerNumber.clear();
}

function enable(byOffice) {
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' && byOffice ? { key, value: byOffice, updated_at: new Date(), updated_by: null } : null;
  tcReferrals.resetCacheForTests();
}

beforeEach(async () => {
  sessionRole = 'office';
  tenantModules = ['voice', 'tc'];
  original.requestPersist = unifiedCallStore.requestPersist;
  original.withTenantDb = tenantDb.withTenantDb;
  original.getPlatformSetting = registry.getPlatformSetting;
  unifiedCallStore.requestPersist = () => {};
  clearStore();
  db = new FakeTenantDb();
  tenantDb.withTenantDb = async (_req, fn) => fn(db);
  enable({ roland: true });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { name: 'Front Desk', email: 'front@carein.ai' };
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
  unifiedCallStore.requestPersist = original.requestPersist;
  tenantDb.withTenantDb = original.withTenantDb;
  registry.getPlatformSetting = original.getPlatformSetting;
  tcReferrals.resetCacheForTests();
  await new Promise((resolve) => server.close(resolve));
});

/** A Retell call (unmapped agent → roland), matched to test patient 12827. */
function seedCall(id, extra = {}) {
  return unifiedCallStore.addRetellCall({
    call_id: id,
    from_number: '+14795551414',
    start_timestamp: '2026-10-16T15:00:00.000Z',
    od_patient_id: 12827,
    od_patient_name: 'Test 2, Stedi',
    od_patient_office: 'roland',
    ...extra,
  });
}

async function post(id, body) {
  const res = await fetch(`${baseUrl}/api/unified-calls/${id}/referral`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const REFERRAL = { reason: 'Possible fractured cusp, endo eval', teeth: [19], urgency: 'soon' };

test('2: a referral from a call: office from the call, patient from the stored match, a draft', async () => {
  seedCall('call-ref-1');
  const before = JSON.stringify(unifiedCallStore.getCall('call-ref-1'));
  const r = await post('call-ref-1', { referral: REFERRAL });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ref = r.body.referral;
  assert.deepEqual(
    [ref.status, ref.officeId, ref.odPatientId, ref.patientName, ref.sourceKind, ref.sourceRef, ref.tcCaseId],
    ['draft', 'roland', 12827, 'Test 2, Stedi', 'call', 'call-ref-1', null]
  );
  assert.equal(ref.createdBy, 'front@carein.ai');
  const audits = auditRows(db).filter((a) => a.resource_type === 'tc_referral');
  assert.deepEqual(audits.map((a) => [a.action, a.source_ref]), [['CREATE', 'call:call-ref-1']]);
  // No call-store field was written: the record is unchanged.
  assert.equal(JSON.stringify(unifiedCallStore.getCall('call-ref-1')), before);
});

test('2: a body office_id that disagrees with the call can only 409 — nothing is created', async () => {
  seedCall('call-ref-2');
  const r = await post('call-ref-2', { referral: REFERRAL, office_id: 'valley' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'OFFICE_MISMATCH');
  assert.equal(db.table('tc_referrals').length, 0);
  // An agreeing assertion is fine.
  assert.equal((await post('call-ref-2', { referral: REFERRAL, office_id: 'roland' })).status, 201);
});

test('2: the body can never name the patient', async () => {
  seedCall('call-ref-3');
  for (const extra of [{ odPatientId: 7115 }, { patientName: 'Somebody' }]) {
    assert.equal((await post('call-ref-3', { referral: { ...REFERRAL, ...extra } })).status, 400);
  }
  assert.equal((await post('call-ref-3', { referral: REFERRAL, od_patient_id: 7115 })).status, 400);
  assert.equal(db.table('tc_referrals').length, 0);
});

test('3: no matched patient, no name, or a match from another office — honest refusals, nothing created', async () => {
  seedCall('call-none', { od_patient_id: null, od_patient_name: null, od_patient_office: null });
  let r = await post('call-none', { referral: REFERRAL });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NO_MATCHED_PATIENT');

  seedCall('call-noname', { od_patient_name: '' });
  r = await post('call-noname', { referral: REFERRAL });
  assert.equal(r.body.code, 'PATIENT_NAME_UNAVAILABLE');

  seedCall('call-cross', { od_patient_office: 'valley' });
  r = await post('call-cross', { referral: REFERRAL });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'PATIENT_OFFICE_MISMATCH');

  assert.equal((await post('no-such-call', { referral: REFERRAL })).status, 404);
  assert.equal(db.table('tc_referrals').length, 0);
});

test('links the case the call was sent to — only when that case is this office\'s', async () => {
  const caseId = randomUUID();
  db.table('tc_cases').push({ case_id: caseId, office_id: 'roland', od_patient_id: 12827 });
  seedCall('call-case', { tc_case_id: caseId });
  const r = await post('call-case', { referral: REFERRAL });
  assert.equal(r.body.referral.tcCaseId, caseId);

  const valleyCase = randomUUID();
  db.table('tc_cases').push({ case_id: valleyCase, office_id: 'valley', od_patient_id: 12827 });
  seedCall('call-other-case', { tc_case_id: valleyCase });
  assert.equal((await post('call-other-case', { referral: REFERRAL })).body.referral.tcCaseId, null);
});

test('dark: referrals off for the office, or no TC → refused, nothing created', async () => {
  seedCall('call-dark');
  enable(null);
  let r = await post('call-dark', { referral: REFERRAL });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'REFERRALS_DISABLED');
  enable({ roland: true });
  tenantModules = ['voice'];
  r = await post('call-dark', { referral: REFERRAL });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'MODULE_NOT_ENTITLED');
  assert.equal(db.table('tc_referrals').length, 0);
});

test('voice.send_to_tc only: a tc user (read-only voice) is refused', async () => {
  seedCall('call-perm');
  sessionRole = 'tc';
  const r = await post('call-perm', { referral: REFERRAL });
  assert.equal(r.status, 403);
  assert.equal(db.table('tc_referrals').length, 0);
});
