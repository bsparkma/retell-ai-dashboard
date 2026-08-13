'use strict';

/**
 * The commlog-type picker's HTTP surface.
 *
 * The catalogue and the validation itself are covered by
 * services/commlogTypes.test.js, and the cross-office write behaviour by
 * services/odOfficeRouting.test.js. What is pinned HERE is what only the route
 * owns:
 *
 *   - GET /:id/commlog-preview carries the CALL's office's list and default, so
 *     the confirm dialog cannot be handed some other practice's DefNums;
 *   - a DefNum that is not in that office's list is a 400 — including the OTHER
 *     office's perfectly valid one, tested in both directions;
 *   - the refusal happens BEFORE the patient is linked and before anything is
 *     written, and is recorded in the audit trail like every other refused
 *     chart write on this route;
 *   - omitting the field is byte-for-byte the pre-picker request;
 *   - an unverifiable choice is a 503, not a 400 — "we can't check" is not the
 *     same claim as "you're wrong".
 *
 * No PHI: roland 12827 / valley 7115 are the synthetic staging fixtures.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;
const http = require('node:http');
const express = require('express');

const audit = require('../platform/audit');
const odOffices = require('../config/odOffices');
const commlogTypes = require('../services/commlogTypes');
const openDentalSync = require('../services/openDentalSync');
const unifiedCallStore = require('../services/unifiedCallStore');
const { MANGO_LINE_OFFICE } = require('../config/officeAgents');
const unifiedCallsRouter = require('../routes/unifiedCalls');

const VALLEY_DID = Object.keys(MANGO_LINE_OFFICE).find((d) => MANGO_LINE_OFFICE[d] === 'valley');
const ROLAND_DID = Object.keys(MANGO_LINE_OFFICE).find((d) => MANGO_LINE_OFFICE[d] === 'roland');

/** The real per-office lists (live, 2026-08-13), trimmed to what is asserted. */
const OFFICE_DEFS = {
  roland: [[486, 'CareIN AI Call'], [401, 'ODHQ'], [227, 'Recall']],
  valley: [[451, 'CareIN AI Call'], [401, 'Crown by Moolah'], [238, 'Recall']],
};

const saved = {};
let auditRows = [];
/** Every POST /commlogs any office made. */
let writes = [];
let stubbed = [];
let definitionsDown = false;

function stubOfficeClients() {
  writes = [];
  stubbed = [];
  for (const officeKey of ['roland', 'valley']) {
    const c = odOffices.getOdOffice(officeKey).client;
    stubbed.push({
      c,
      original: {
        useDatabase: c.useDatabase, pool: c.pool, isEnabled: c.isEnabled,
        getPatientDetails: c.getPatientDetails, apiGetRaw: c.apiGetRaw, client: c.client,
      },
    });
    c.useDatabase = false;
    c.pool = null;
    c.isEnabled = () => true;
    c.getPatientDetails = async (id) => ({ id: Number(id), fullName: `Fixture ${id}` });
    c.apiGetRaw = async (path) => {
      if (path !== '/definitions') return { ok: false, status: 404, data: null, error: 'not stubbed' };
      if (definitionsDown) return { ok: false, status: 503, data: null, error: 'OD unreachable' };
      return {
        ok: true,
        status: 200,
        data: OFFICE_DEFS[officeKey].map(([DefNum, ItemName]) => ({
          DefNum, ItemName, Category: 27, category: 'CommLogTypes', isHidden: 'false',
        })),
      };
    };
    c.client = {
      post: async (url, body) => {
        writes.push({ office: officeKey, url, body });
        return { data: { CommlogNum: 1234 } };
      },
    };
  }
}

function clearStore() {
  unifiedCallStore.calls.clear();
  unifiedCallStore.bySource.retell.clear();
  unifiedCallStore.bySource.mango.clear();
  unifiedCallStore.byDate.clear();
  unifiedCallStore.byCallerNumber.clear();
}

/** A matched call on the given office's line, ready to send. */
function seedCall(id, did, patientId) {
  unifiedCallStore.calls.set(id, {
    id,
    source: 'mango',
    called_number: did,
    caller_number: '+15551234567',
    call_date: '2026-08-13T15:00:00.000Z',
    summary: 'wants an appointment',
    od_patient_id: patientId,
    od_patient_office: MANGO_LINE_OFFICE[did],
    od_sync_status: 'matched',
  });
  return id;
}

beforeEach(() => {
  saved.audit = audit.audit;
  saved.persist = unifiedCallStore.requestPersist;
  saved.roland = process.env.OPENDENTAL_CUSTOMER_KEY;
  saved.valley = process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  saved.valleyEnabled = odOffices.OFFICE_OD_SETTINGS.valley.odEnabled;

  auditRows = [];
  definitionsDown = false;
  audit.audit = async (_req, entry) => { auditRows.push(entry); };
  unifiedCallStore.requestPersist = () => {};
  clearStore();

  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-valley-customer-key';
  odOffices.OFFICE_OD_SETTINGS.valley.odEnabled = true;
  odOffices.resetOdOfficeCache();
  commlogTypes.resetCommlogTypeCache();
  stubOfficeClients();
});

afterEach(() => {
  for (const { c, original } of stubbed) Object.assign(c, original);
  stubbed = [];
  audit.audit = saved.audit;
  unifiedCallStore.requestPersist = saved.persist;
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('OPENDENTAL_CUSTOMER_KEY', saved.roland);
  set('OPENDENTAL_CUSTOMER_KEY_VALLEY', saved.valley);
  odOffices.OFFICE_OD_SETTINGS.valley.odEnabled = saved.valleyEnabled;
  odOffices.resetOdOfficeCache();
  commlogTypes.resetCommlogTypeCache();
  clearStore();
});

const cleanups = [];
test.afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

/** The router mounted with a session/tenant already attached, as server.js does upstream. */
async function startApp({ role = 'office' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { name: 'Front Desk', email: 'desk@example.com' };
    req.tenant = { id: 'tenant-test', modules: ['voice'] };
    req.userRole = role;
    next();
  });
  app.use('/api/unified-calls', unifiedCallsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function request(url, method, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request(
      url,
      { method, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode, body: json, raw });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const get = (url) => request(url, 'GET');
const post = (url, payload) => request(url, 'POST', payload);

// ── The list the dialog is handed ───────────────────────────────────────────

test('the preview carries the CALL office\'s own commlog types and default', async () => {
  seedCall('p1', ROLAND_DID, 12827);
  const base = await startApp();
  const res = await get(`${base}/api/unified-calls/p1/commlog-preview`);

  assert.equal(res.status, 200);
  assert.equal(res.body.commlogTypes.available, true);
  assert.equal(res.body.commlogTypes.defaultDefNum, 486);
  assert.equal(res.body.commlogTypes.defaultName, 'CareIN AI Call');
  assert.deepEqual(
    res.body.commlogTypes.options.map((o) => o.defNum).sort((a, b) => a - b),
    [227, 401, 486]
  );
});

test('a valley call is handed valley\'s list — never Roland\'s DefNums', async () => {
  seedCall('p2', VALLEY_DID, 7115);
  const base = await startApp();
  const res = await get(`${base}/api/unified-calls/p2/commlog-preview`);

  assert.equal(res.body.commlogTypes.defaultDefNum, 451);
  const defNums = res.body.commlogTypes.options.map((o) => o.defNum);
  assert.equal(defNums.includes(486), false);
  // 401 is in BOTH lists and names a different type in each — the reason the
  // list has to be served per office rather than shared.
  assert.equal(res.body.commlogTypes.options.find((o) => o.defNum === 401).name, 'Crown by Moolah');
});

test('an unavailable catalogue is a normal preview, not a failed one', async () => {
  definitionsDown = true;
  seedCall('p3', ROLAND_DID, 12827);
  const base = await startApp();
  const res = await get(`${base}/api/unified-calls/p3/commlog-preview`);

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.note, 'string');
  assert.equal(res.body.commlogTypes.available, false);
  assert.equal(res.body.commlogTypes.defaultDefNum, 486, 'the UI can still show what a send will write');
});

// ── The send ────────────────────────────────────────────────────────────────

test('a type from the office\'s own list is accepted and written', async () => {
  seedCall('s1', ROLAND_DID, 12827);
  const base = await startApp();
  const res = await post(`${base}/api/unified-calls/s1/resolve-patient`, {
    patientId: 12827, commTypeDefNum: 227,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.CommType, 227);
});

test('omitting commTypeDefNum writes the office default — the pre-picker request', async () => {
  seedCall('s2', ROLAND_DID, 12827);
  const base = await startApp();
  const res = await post(`${base}/api/unified-calls/s2/resolve-patient`, { patientId: 12827 });

  assert.equal(res.status, 200);
  assert.equal(writes[0].body.CommType, 486);
  // And the audit trail is the one CREATE it has always been.
  assert.deepEqual(
    auditRows.map((r) => [r.action, r.resourceType, r.result]),
    [['CREATE', 'commlog', 'SUCCESS']]
  );
});

test('451 on a roland call is a 400, and nothing is written or linked', async () => {
  seedCall('s3', ROLAND_DID, 12827);
  const base = await startApp();
  const res = await post(`${base}/api/unified-calls/s3/resolve-patient`, {
    patientId: 12827, commTypeDefNum: 451,
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'COMMLOG_TYPE_INVALID');
  assert.equal(writes.length, 0, 'a refused type must never reach a chart');

  const stored = unifiedCallStore.getCall('s3');
  assert.equal(stored.od_sync_status, 'matched', 'the call is left exactly as it was');
  assert.equal(stored.sent_at, undefined);

  // A refused chart write is still an attempted one.
  assert.deepEqual(
    auditRows.map((r) => [r.action, r.resourceType, r.office, r.result]),
    [['CREATE', 'commlog', 'roland', 'UNAUTHORIZED']]
  );
});

test('486 on a valley call is a 400 — the same rule, the other direction', async () => {
  seedCall('s4', VALLEY_DID, 7115);
  const base = await startApp();
  const res = await post(`${base}/api/unified-calls/s4/resolve-patient`, {
    patientId: 7115, commTypeDefNum: 486,
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'COMMLOG_TYPE_INVALID');
  assert.equal(writes.length, 0);
});

test('a DefNum in no list at all is a 400', async () => {
  seedCall('s5', ROLAND_DID, 12827);
  const base = await startApp();
  const res = await post(`${base}/api/unified-calls/s5/resolve-patient`, {
    patientId: 12827, commTypeDefNum: 999999,
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'COMMLOG_TYPE_INVALID');
  assert.equal(writes.length, 0);
});

test('an unverifiable choice is a 503, while the default still sends', async () => {
  definitionsDown = true;
  seedCall('s6', ROLAND_DID, 12827);
  seedCall('s7', ROLAND_DID, 12827);
  const base = await startApp();

  const refused = await post(`${base}/api/unified-calls/s6/resolve-patient`, {
    patientId: 12827, commTypeDefNum: 227,
  });
  assert.equal(refused.status, 503, "'we can't check' is not the same claim as 'you're wrong'");
  assert.equal(refused.body.code, 'COMMLOG_TYPE_UNVERIFIABLE');
  assert.equal(writes.length, 0);

  const sent = await post(`${base}/api/unified-calls/s7/resolve-patient`, {
    patientId: 12827, commTypeDefNum: 486,
  });
  assert.equal(sent.status, 200, 'a definitions outage must not block a default send');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.CommType, 486);
});

test('a link-only resolve ignores the field entirely — it writes no chart note', async () => {
  seedCall('s8', ROLAND_DID, null);
  unifiedCallStore.calls.get('s8').od_patient_id = null;
  unifiedCallStore.calls.get('s8').od_sync_status = 'needs_review';

  const base = await startApp();
  const res = await post(`${base}/api/unified-calls/s8/resolve-patient`, {
    patientId: 12827, linkOnly: true, commTypeDefNum: 451,
  });

  // Even Riley's DefNum is harmless here: link-only never reaches a commlog, so
  // there is nothing for a type to be wrong about.
  assert.equal(res.status, 200);
  assert.equal(res.body.linked, true);
  assert.equal(writes.length, 0);
});
