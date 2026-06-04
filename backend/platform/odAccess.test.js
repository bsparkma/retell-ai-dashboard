'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterEach } = test;

const registry = require('./registry');
const secrets = require('../config/secrets');
const odCloud = require('../config/openDental');
const audit = require('./audit');
const odAccess = require('./odAccess');

const OD_API_BASE = 'https://api.opendental.com/api/v1';
const CONNECTOR_URL = 'https://connector.example';

// ---- mocks ----------------------------------------------------------------

const original = {
  getTenantConnector: registry.getTenantConnector,
  getSecretValue: secrets.getSecretValue,
  odApiUrl: odCloud.apiUrl,
  fetch: global.fetch,
  auditFn: audit.audit,
  cloudMethods: {},
};

// Default-stub the audit writer for every test so OD calls don't hit a DB.
// Tests that assert on auditing override this with a capturing stub.
test.beforeEach(() => {
  audit.audit = async () => {};
});

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

function apiConnector(extra = {}) {
  return {
    tenant_id: 'T1',
    od_primary_mode: 'api',
    od_api_base: OD_API_BASE,
    kv_od_dev_key: 'opendental-developer-key',
    kv_od_cust_key: 'opendental-customer-key',
    connector_url: CONNECTOR_URL,
    kv_connector_key: 'od-connector-api-key',
    ...extra,
  };
}

afterEach(() => {
  registry.getTenantConnector = original.getTenantConnector;
  secrets.getSecretValue = original.getSecretValue;
  odCloud.apiUrl = original.odApiUrl;
  global.fetch = original.fetch;
  audit.audit = original.auditFn;
  for (const [k, v] of Object.entries(original.cloudMethods)) odCloud[k] = v;
  original.cloudMethods = {};
});

function stubCloud(name, fn) {
  original.cloudMethods[name] = odCloud[name];
  odCloud[name] = fn;
}

const REQ = { tenant: { id: 'T1', clinics: [{ clinic_num: 1, name: 'Roland' }, { clinic_num: 2, name: 'Valley' }] } };

// ---- general reads: api mode delegates to the cloud client ----------------

test('api mode: searchPatients delegates to the wrapped OD cloud client', async () => {
  odCloud.apiUrl = OD_API_BASE;
  registry.getTenantConnector = async (id) => {
    assert.equal(id, 'T1');
    return apiConnector();
  };
  let seen = null;
  stubCloud('searchPatients', async (q) => { seen = q; return [{ id: 99 }]; });

  const out = await odAccess.searchPatients(REQ, '479-555-1212');
  assert.equal(seen, '479-555-1212');
  assert.deepEqual(out, [{ id: 99 }]);
});

test('agent mode: general reads are NotImplemented (Phase 2)', async () => {
  registry.getTenantConnector = async () => apiConnector({ od_primary_mode: 'agent' });
  await assert.rejects(
    () => odAccess.getProviders(REQ),
    (err) => err.code === 'OD_AGENT_NOT_IMPLEMENTED' && odAccess.httpStatusFor(err) === 501
  );
});

test('api mode: refuses a tenant whose od_api_base does not match the configured client', async () => {
  odCloud.apiUrl = OD_API_BASE;
  registry.getTenantConnector = async () => apiConnector({ od_api_base: 'https://other.example/api' });
  await assert.rejects(
    () => odAccess.getProviders(REQ),
    (err) => err.code === 'OD_CLOUD_MULTITENANT_NOT_IMPLEMENTED'
  );
});

test('fail closed: no req.tenant → TENANT_UNRESOLVED (403)', async () => {
  await assert.rejects(
    () => odAccess.searchPatients({}, 'x'),
    (err) => err.code === 'TENANT_UNRESOLVED' && odAccess.httpStatusFor(err) === 403
  );
});

// ---- connector service: slot markers --------------------------------------

test('getSlotMarkers rejects a clinicNum not entitled to the tenant (connector never called)', async () => {
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ data: [] }) }; };
  registry.getTenantConnector = async () => apiConnector();

  await assert.rejects(
    () => odAccess.getSlotMarkers(REQ, { startDate: '2026-04-01', endDate: '2026-04-30', clinicNum: '99' }),
    (err) => err.code === 'CLINIC_FORBIDDEN' && odAccess.httpStatusFor(err) === 403
  );
  assert.equal(fetchCalled, false);
});

test('getSlotMarkers forwards to the registry-resolved connector_url (no localhost), with bearer key', async () => {
  registry.getTenantConnector = async () => apiConnector();
  secrets.getSecretValue = async (name) => {
    assert.equal(name, 'od-connector-api-key');
    return 'connector-secret';
  };
  let calledUrl = null;
  let calledHeaders = null;
  global.fetch = async (url, opts) => {
    calledUrl = String(url);
    calledHeaders = opts.headers;
    return { ok: true, json: async () => ({ data: [{ marker: 'x' }] }) };
  };

  const data = await odAccess.getSlotMarkers(REQ, {
    startDate: '2026-04-01', endDate: '2026-04-30', clinicNum: '1', category: 'asap',
  });

  assert.deepEqual(data, [{ marker: 'x' }]);
  assert.ok(calledUrl.startsWith('https://connector.example/api/slot-markers'), `url was ${calledUrl}`);
  assert.ok(!calledUrl.includes('localhost:8444'), 'must not use the old localhost fallback');
  assert.ok(calledUrl.includes('clinicNum=1'));
  assert.ok(calledUrl.includes('category=asap'));
  assert.equal(calledHeaders.Authorization, 'Bearer connector-secret');
});

test('getSlotMarkers maps an upstream error to CONNECTOR_UPSTREAM_ERROR (502)', async () => {
  registry.getTenantConnector = async () => apiConnector();
  secrets.getSecretValue = async () => 'k';
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });

  await assert.rejects(
    () => odAccess.getSlotMarkers(REQ, { startDate: 'a', endDate: 'b', clinicNum: '1' }),
    (err) => err.code === 'CONNECTOR_UPSTREAM_ERROR' && odAccess.httpStatusFor(err) === 502
  );
});

test('getSlotMarkers maps an unreachable connector to CONNECTOR_UNREACHABLE (503)', async () => {
  registry.getTenantConnector = async () => apiConnector();
  secrets.getSecretValue = async () => 'k';
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };

  await assert.rejects(
    () => odAccess.getSlotMarkers(REQ, { startDate: 'a', endDate: 'b', clinicNum: '1' }),
    (err) => err.code === 'CONNECTOR_UNREACHABLE' && odAccess.httpStatusFor(err) === 503
  );
});

test('getSlotMarkers fails closed when the tenant has no connector_url (no localhost default)', async () => {
  registry.getTenantConnector = async () => apiConnector({ connector_url: null });
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ data: [] }) }; };

  await assert.rejects(
    () => odAccess.getSlotMarkers(REQ, { startDate: 'a', endDate: 'b', clinicNum: '1' }),
    (err) => err.code === 'CONNECTOR_URL_MISSING' && odAccess.httpStatusFor(err) === 503
  );
  assert.equal(fetchCalled, false);
});

// ---- slot-markers ROUTE delegates to odAccess -----------------------------

function getSlotMarkersHandler() {
  const router = require('../routes/slotMarkers');
  const layer = router.stack.find((l) => l.route && l.route.path === '/');
  return layer.route.stack[0].handle;
}

test('route: missing params → 400 (before any tenant/connector work)', async () => {
  const handler = getSlotMarkersHandler();
  const res = makeRes();
  await handler({ query: { startDate: '2026-04-01' }, tenant: REQ.tenant }, res);
  assert.equal(res.statusCode, 400);
});

test('route: unentitled clinicNum → 403, connector never called', async () => {
  registry.getTenantConnector = async () => apiConnector();
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ data: [] }) }; };

  const handler = getSlotMarkersHandler();
  const res = makeRes();
  await handler({ query: { startDate: 'a', endDate: 'b', clinicNum: '99' }, tenant: REQ.tenant }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'CLINIC_FORBIDDEN');
  assert.equal(fetchCalled, false);
});

test('route: valid clinicNum returns the connector data array', async () => {
  registry.getTenantConnector = async () => apiConnector();
  secrets.getSecretValue = async () => 'k';
  let calledUrl = null;
  global.fetch = async (url) => { calledUrl = String(url); return { ok: true, json: async () => ({ data: [{ marker: 'y' }] }) }; };

  const handler = getSlotMarkersHandler();
  const res = makeRes();
  await handler({ query: { startDate: 'a', endDate: 'b', clinicNum: '1' }, tenant: REQ.tenant }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [{ marker: 'y' }]);
  assert.ok(calledUrl.startsWith('https://connector.example/'));
});

// ---- general reads/writes used by the newly rerouted routes ---------------

test('getStatus reports OD service state without exposing the cloud singleton', async () => {
  registry.getTenantConnector = async () => apiConnector();
  odCloud.apiUrl = OD_API_BASE;
  const saved = {
    useDatabase: odCloud.useDatabase,
    lastSyncTime: odCloud.lastSyncTime,
    syncInterval: odCloud.syncInterval,
    conflicts: odCloud.conflicts,
  };
  stubCloud('isEnabled', () => true);
  odCloud.useDatabase = false;
  odCloud.lastSyncTime = '2026-06-02T00:00:00.000Z';
  odCloud.syncInterval = {}; // truthy → syncActive
  odCloud.conflicts = new Map([['k', 'v']]);

  try {
    const status = await odAccess.getStatus(REQ);
    assert.equal(status.enabled, true);
    assert.equal(status.useDatabase, false);
    assert.equal(status.apiBase, OD_API_BASE);
    assert.equal(status.lastSyncTime, '2026-06-02T00:00:00.000Z');
    assert.equal(status.syncActive, true);
    assert.deepEqual(status.conflicts, [['k', 'v']]);
    assert.equal(status.mode, 'api');
  } finally {
    odCloud.useDatabase = saved.useDatabase;
    odCloud.lastSyncTime = saved.lastSyncTime;
    odCloud.syncInterval = saved.syncInterval;
    odCloud.conflicts = saved.conflicts;
  }
});

test('api mode: bookAppointment (write) delegates to the cloud client', async () => {
  odCloud.apiUrl = OD_API_BASE;
  registry.getTenantConnector = async () => apiConnector();
  let seen = null;
  stubCloud('bookAppointment', async (data) => { seen = data; return { success: true, appointmentId: 7 }; });

  const out = await odAccess.bookAppointment(REQ, { patientId: 1, providerId: 2 });
  assert.deepEqual(seen, { patientId: 1, providerId: 2 });
  assert.deepEqual(out, { success: true, appointmentId: 7 });
});

test('api mode: cancelAppointment delegates (status change, never a delete)', async () => {
  odCloud.apiUrl = OD_API_BASE;
  registry.getTenantConnector = async () => apiConnector();
  let args = null;
  stubCloud('cancelAppointment', async (id, reason) => { args = [id, reason]; return { success: true }; });

  await odAccess.cancelAppointment(REQ, '42', 'patient request');
  assert.deepEqual(args, ['42', 'patient request']);
});

test('api mode: verifyPatientAppointments delegates with includeHistory', async () => {
  odCloud.apiUrl = OD_API_BASE;
  registry.getTenantConnector = async () => apiConnector();
  let args = null;
  stubCloud('verifyPatientAppointments', async (id, hist) => { args = [id, hist]; return { hasUpcoming: false, upcomingAppointments: [], recentAppointments: [] }; });

  await odAccess.verifyPatientAppointments(REQ, '99', false);
  assert.deepEqual(args, ['99', false]);
});

// ---- a rerouted openDental.js route end-to-end ----------------------------

function getOdRouteHandler(method, path) {
  const router = require('../routes/openDental');
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

test('route: GET /providers returns providers resolved through odAccess', async () => {
  odCloud.apiUrl = OD_API_BASE;
  registry.getTenantConnector = async () => apiConnector();
  stubCloud('getProviders', async () => [{ id: 1, name: 'Dr. A' }]);

  const handler = getOdRouteHandler('get', '/providers');
  const res = makeRes();
  await handler({ tenant: REQ.tenant, params: {}, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.providers, [{ id: 1, name: 'Dr. A' }]);
});

// ---- HIPAA audit instrumentation (Slice 6) --------------------------------

function captureAudit() {
  const calls = [];
  audit.audit = async (req, entry) => { calls.push(entry); };
  return calls;
}

test('audited read records a SUCCESS row with the resource id', async () => {
  odCloud.apiUrl = OD_API_BASE;
  registry.getTenantConnector = async () => apiConnector();
  stubCloud('getPatientDetails', async () => ({ id: 55 }));
  const calls = captureAudit();

  await odAccess.getPatientDetails(REQ, '55');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { action: 'READ', resourceType: 'patient', resourceId: '55', result: 'SUCCESS' });
});

test('searchPatients audits with a null resource id (the query may be PHI)', async () => {
  odCloud.apiUrl = OD_API_BASE;
  registry.getTenantConnector = async () => apiConnector();
  stubCloud('searchPatients', async () => []);
  const calls = captureAudit();

  await odAccess.searchPatients(REQ, '479-555-1212');

  assert.equal(calls[0].resourceType, 'patient');
  assert.equal(calls[0].resourceId, null);
});

test('a write (bookAppointment) audits action CREATE with the new appointment id', async () => {
  odCloud.apiUrl = OD_API_BASE;
  registry.getTenantConnector = async () => apiConnector();
  stubCloud('bookAppointment', async () => ({ success: true, appointmentId: 7 }));
  const calls = captureAudit();

  await odAccess.bookAppointment(REQ, { patientId: 1 });

  assert.deepEqual(calls[0], { action: 'CREATE', resourceType: 'appointment', resourceId: '7', result: 'SUCCESS' });
});

test('non-PHI reference reads (getProviders) are NOT audited', async () => {
  odCloud.apiUrl = OD_API_BASE;
  registry.getTenantConnector = async () => apiConnector();
  stubCloud('getProviders', async () => []);
  const calls = captureAudit();

  await odAccess.getProviders(REQ);
  assert.equal(calls.length, 0);
});

test('fail-closed: an audit write failure on success propagates (PHI not returned)', async () => {
  odCloud.apiUrl = OD_API_BASE;
  registry.getTenantConnector = async () => apiConnector();
  stubCloud('getPatientDetails', async () => ({ id: 1 }));
  audit.audit = async () => { throw new Error('audit store down'); };

  await assert.rejects(() => odAccess.getPatientDetails(REQ, '1'), /audit store down/);
});
