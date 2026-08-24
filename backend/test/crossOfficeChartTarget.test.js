'use strict';

/**
 * The cross-office chart target.
 *
 * A call belongs to the office it rang at. A chart note belongs to the practice
 * whose patient it is about. Those were the same thing until now, and welding them
 * together had a cost that only showed up at the front desk: the person at one
 * practice takes a call about the other practice's patient, Pick Patient searches
 * only their own Open Dental, the patient is not there, and the call cannot be
 * charted anywhere at all.
 *
 * So the target is now a choice. What is pinned here is everything that has to hold
 * for that choice to be safe, in order of what would actually hurt if it broke:
 *
 *  1. A cross-office write uses the TARGET office's Open Dental client and the
 *     TARGET office's CommType DefNum. Roland's 486 must never reach Riley's
 *     database (it is not a CommLogType there at all) and Riley's 451 must never
 *     reach Roland's.
 *  2. An unrecognised office is a 400 and NOTHING is written. Not a fallback to the
 *     call's office, not a fallback to a default — a refusal.
 *  3. Omitting the target is byte-for-byte the pre-feature request: same office,
 *     same DefNum, same everything.
 *  4. The stored PatNum carries the office it came from. A PatNum without its
 *     database does not identify a person, and this is the field that says which.
 *  5. The audit row records BOTH offices — the chart that was written and the call
 *     it came from — so "why is there a Roland note from a call that rang at Riley?"
 *     is answerable from the row.
 *  6. The patient search follows the target too, which is the half that makes the
 *     motivating case possible at all.
 *  7. The call's own office attribution is untouched by any of it.
 *
 * No PHI: roland 12827 / valley 7115 are the synthetic staging fixtures. 7115 is
 * deliberately the one that exists in BOTH databases as different people.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;
const http = require('node:http');
const express = require('express');

const audit = require('../platform/audit');
const odOffices = require('../config/odOffices');
const commlogTypes = require('../services/commlogTypes');
const unifiedCallStore = require('../services/unifiedCallStore');
const { MANGO_LINE_OFFICE } = require('../config/officeAgents');
const unifiedCallsRouter = require('../routes/unifiedCalls');

const VALLEY_DID = Object.keys(MANGO_LINE_OFFICE).find((d) => MANGO_LINE_OFFICE[d] === 'valley');
const ROLAND_DID = Object.keys(MANGO_LINE_OFFICE).find((d) => MANGO_LINE_OFFICE[d] === 'roland');

/** The real per-office commlog types (live, 2026-08-13), trimmed to what is asserted. */
const OFFICE_DEFS = {
  roland: [[486, 'CareIN AI Call'], [401, 'ODHQ']],
  valley: [[451, 'CareIN AI Call'], [401, 'Crown by Moolah']],
};

/**
 * Each office's patient list. PatNum 7115 appears in BOTH and is a different person
 * in each — the entire reason a PatNum may not travel between practices.
 */
const OFFICE_PATIENTS = {
  roland: [{ id: 12827, fullName: 'Test 2, Stedi' }, { id: 7115, fullName: 'Roland Seven One One Five' }],
  valley: [{ id: 7115, fullName: 'Stedi TestValley' }],
};

const saved = {};
let auditRows = [];
/** Every POST /commlogs, tagged with the office whose client made it. */
let writes = [];
/** Every patient search, tagged the same way. */
let searches = [];
let stubbed = [];

function stubOfficeClients() {
  writes = [];
  searches = [];
  stubbed = [];
  for (const officeKey of ['roland', 'valley']) {
    const c = odOffices.getOdOffice(officeKey).client;
    stubbed.push({
      c,
      original: {
        useDatabase: c.useDatabase, pool: c.pool, isEnabled: c.isEnabled,
        getPatientDetails: c.getPatientDetails, searchPatients: c.searchPatients,
        apiGetRaw: c.apiGetRaw, client: c.client,
      },
    });
    c.useDatabase = false;
    c.pool = null;
    c.isEnabled = () => true;
    // A PatNum resolves ONLY in the database that holds it. This is what makes a
    // wrong-office write fail loudly here instead of silently linking a stranger.
    c.getPatientDetails = async (id) => {
      const found = OFFICE_PATIENTS[officeKey].find((p) => String(p.id) === String(id));
      return found ? { id: Number(id), fullName: found.fullName } : null;
    };
    c.searchPatients = async (q) => {
      searches.push({ office: officeKey, q });
      return OFFICE_PATIENTS[officeKey].filter((p) => p.fullName.toLowerCase().includes(q.toLowerCase()));
    };
    c.apiGetRaw = async (path) => {
      if (path !== '/definitions') return { ok: false, status: 404, data: null, error: 'not stubbed' };
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
        return { data: { CommlogNum: officeKey === 'roland' ? 486486 : 451451 } };
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

/** A call on the given office's line. `patient` is [PatNum, officeKey] or null. */
function seedCall(id, did, patient = null) {
  unifiedCallStore.calls.set(id, {
    id,
    source: 'mango',
    called_number: did,
    caller_number: '+15551234567',
    call_date: '2026-08-24T15:00:00.000Z',
    summary: 'wants an appointment',
    od_patient_id: patient ? patient[0] : null,
    od_patient_office: patient ? patient[1] : null,
    od_sync_status: patient ? 'matched' : 'needs_review',
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

// ── 1. The write follows the target, client AND DefNum ─────────────────────

test('a valley call sent to a roland chart uses ROLAND\'s client and ROLAND\'s DefNum', async () => {
  // The motivating case: the call rang at Riley, the patient is Roland's.
  seedCall('x1', VALLEY_DID);
  const base = await startApp();

  const res = await post(`${base}/api/unified-calls/x1/resolve-patient`, {
    patientId: 12827,
    target_office: 'roland',
    office_id: 'roland',
    note: 'Patient called about a cleaning.',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(writes.length, 1);
  // The client that made the write is the TARGET office's, not the call's.
  assert.equal(writes[0].office, 'roland');
  // 486 is "CareIN AI Call" in Roland. Riley's 451 is not a CommLogType there at
  // all, so getting this wrong is not a mislabelled note — it is a broken write.
  assert.equal(writes[0].body.CommType, 486);
  // The call's own office attribution is untouched: it still rang at Riley.
  assert.equal(res.body.call.office_id, 'valley');
  assert.equal(res.body.callOffice.officeId, 'valley');
  assert.equal(res.body.office.officeId, 'roland');
  assert.equal(res.body.crossOffice, true);
});

test('the mirror direction gets valley\'s DefNum, never Roland\'s', async () => {
  seedCall('x2', ROLAND_DID);
  const base = await startApp();

  const res = await post(`${base}/api/unified-calls/x2/resolve-patient`, {
    patientId: 7115,
    target_office: 'valley',
    office_id: 'valley',
  });

  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].office, 'valley');
  assert.equal(writes[0].body.CommType, 451);
  assert.notEqual(writes[0].body.CommType, 486);
});

// ── 2. An office we do not recognise is a refusal, never a fallback ────────

test('an unknown target office is a 400 and writes nothing', async () => {
  seedCall('x3', VALLEY_DID);
  const base = await startApp();

  const res = await post(`${base}/api/unified-calls/x3/resolve-patient`, {
    patientId: 7115,
    target_office: 'springfield',
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TARGET_OFFICE_UNKNOWN');
  // The refusal is the whole point: NOT a quiet fall back to the call's office,
  // which would write the note somewhere nobody asked for.
  assert.equal(writes.length, 0);
  assert.equal(res.body.callOffice.officeId, 'valley');
});

test('the "unknown" bucket is not an office you can chart to', async () => {
  seedCall('x4', VALLEY_DID);
  const base = await startApp();

  const res = await post(`${base}/api/unified-calls/x4/resolve-patient`, {
    patientId: 7115,
    target_office: 'unknown',
  });

  // 'unknown' is where unattributed lines land. It has no Open Dental database, so
  // it is not a target — and it must refuse as an unknown office rather than being
  // accepted and then failing somewhere deeper.
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TARGET_OFFICE_UNKNOWN');
  assert.equal(writes.length, 0);
});

test('a target office with no Open Dental refuses per-office, fail closed', async () => {
  odOffices.OFFICE_OD_SETTINGS.valley.odEnabled = false;
  odOffices.resetOdOfficeCache();
  seedCall('x5', ROLAND_DID);
  const base = await startApp();

  const res = await post(`${base}/api/unified-calls/x5/resolve-patient`, {
    patientId: 7115,
    target_office: 'valley',
  });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'OFFICE_NOT_OD_CONNECTED');
  assert.equal(writes.length, 0);
});

// ── 3. Omitting the target changes nothing ─────────────────────────────────

test('omitting target_office is byte-for-byte the pre-feature send', async () => {
  seedCall('x6', VALLEY_DID);
  const base = await startApp();

  const res = await post(`${base}/api/unified-calls/x6/resolve-patient`, { patientId: 7115 });

  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].office, 'valley');
  assert.equal(writes[0].body.CommType, 451);
  assert.equal(res.body.crossOffice, false);
});

test('a stale screen naming the wrong office is still refused', async () => {
  seedCall('x7', VALLEY_DID);
  const base = await startApp();

  // office_id asserts; it never selects. Without a target_office to go with it,
  // naming Roland is a disagreement with the resolved target, not a redirect.
  const res = await post(`${base}/api/unified-calls/x7/resolve-patient`, {
    patientId: 7115,
    office_id: 'roland',
  });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'OFFICE_MISMATCH');
  assert.equal(writes.length, 0);
});

// ── 4. A PatNum is stored with the database it came from ───────────────────

test('a cross-office link stores the PatNum WITH its office', async () => {
  seedCall('x8', VALLEY_DID);
  const base = await startApp();

  const res = await post(`${base}/api/unified-calls/x8/resolve-patient`, {
    patientId: 12827,
    target_office: 'roland',
    linkOnly: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.linked, true);
  const stored = unifiedCallStore.getCall('x8');
  assert.equal(String(stored.od_patient_id), '12827');
  // Without this, the stored PatNum reads as Roland's by default in one place and
  // as the call's office in another — and 12827 in Riley is somebody else entirely.
  assert.equal(stored.od_patient_office, 'roland');
  // Linking writes NOTHING to any chart, cross-office or not.
  assert.equal(writes.length, 0);
});

test('a PatNum that does not exist in the TARGET office is a 404, not a wrong link', async () => {
  seedCall('x9', VALLEY_DID);
  const base = await startApp();

  // 12827 is a Roland PatNum. Aimed at Riley's database, where it does not exist,
  // it must fail — this is the check that stops a pasted number linking to whoever
  // happens to hold it over there.
  const res = await post(`${base}/api/unified-calls/x9/resolve-patient`, {
    patientId: 12827,
    target_office: 'valley',
    linkOnly: true,
  });

  assert.equal(res.status, 404);
  assert.equal(unifiedCallStore.getCall('x9').od_patient_office, null);
});

test('a call already linked cross-office defaults its send to THAT office', async () => {
  // The Pick Patient step linked a Roland patient to a call that rang at Riley.
  seedCall('x10', VALLEY_DID, [12827, 'roland']);
  const base = await startApp();

  // No target named. The default must follow the PATIENT, not the call: 12827 only
  // means anything in Roland's database.
  const res = await post(`${base}/api/unified-calls/x10/resolve-patient`, { patientId: 12827 });

  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].office, 'roland');
  assert.equal(writes[0].body.CommType, 486);
});

// ── 5. Both offices land in the audit trail ────────────────────────────────

test('the audit row records the chart written AND the call it came from', async () => {
  seedCall('x11', VALLEY_DID);
  const base = await startApp();

  await post(`${base}/api/unified-calls/x11/resolve-patient`, {
    patientId: 12827,
    target_office: 'roland',
  });

  const created = auditRows.filter((r) => r.action === 'CREATE' && r.result === 'SUCCESS');
  assert.equal(created.length, 1);
  // office = whose chart. originOffice = whose call. The pair is what makes
  // "why is there a Roland note from a Riley call?" answerable from the row alone.
  assert.equal(created[0].office, 'roland');
  assert.equal(created[0].originOffice, 'valley');
});

test('a refused target is recorded too — the attempt is part of the trail', async () => {
  seedCall('x12', VALLEY_DID);
  const base = await startApp();

  await post(`${base}/api/unified-calls/x12/resolve-patient`, {
    patientId: 7115,
    target_office: 'springfield',
  });

  const refused = auditRows.filter((r) => r.result === 'UNAUTHORIZED');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].originOffice, 'valley');
});

// ── 6. The search follows the target ───────────────────────────────────────

test('patient search hits the TARGET office\'s Open Dental', async () => {
  seedCall('x13', VALLEY_DID);
  const base = await startApp();

  const res = await get(`${base}/api/unified-calls/x13/patient-search?q=Stedi&target_office=roland`);

  assert.equal(res.status, 200);
  assert.equal(searches.length, 1);
  assert.equal(searches[0].office, 'roland');
  assert.deepEqual(res.body.patients.map((p) => p.id), [12827]);
  assert.equal(res.body.office.officeId, 'roland');
  assert.equal(res.body.callOffice.officeId, 'valley');
  assert.equal(res.body.crossOffice, true);
});

test('patient search with no target searches the CALL\'s office', async () => {
  seedCall('x14', VALLEY_DID);
  const base = await startApp();

  const res = await get(`${base}/api/unified-calls/x14/patient-search?q=Stedi`);

  assert.equal(searches.length, 1);
  assert.equal(searches[0].office, 'valley');
  assert.equal(res.body.crossOffice, false);
});

test('patient search refuses an unknown target rather than searching anywhere', async () => {
  seedCall('x15', VALLEY_DID);
  const base = await startApp();

  const res = await get(`${base}/api/unified-calls/x15/patient-search?q=Stedi&target_office=springfield`);

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TARGET_OFFICE_UNKNOWN');
  assert.equal(searches.length, 0);
  assert.deepEqual(res.body.patients, []);
});

test('the preview carries the TARGET office\'s note types, not the call\'s', async () => {
  seedCall('x16', VALLEY_DID);
  const base = await startApp();

  const res = await get(`${base}/api/unified-calls/x16/commlog-preview?target_office=roland`);

  assert.equal(res.status, 200);
  assert.equal(res.body.office.officeId, 'roland');
  assert.equal(res.body.callOffice.officeId, 'valley');
  assert.equal(res.body.crossOffice, true);
  assert.equal(res.body.commlogTypes.defaultDefNum, 486);
  // 401 is a valid DefNum in BOTH practices and names a different type in each —
  // which is exactly why the list has to follow the chart, not the call.
  assert.equal(res.body.commlogTypes.options.find((o) => o.defNum === 401).name, 'ODHQ');
});

// ── 7. The call's identity is not a routing decision ───────────────────────

test('a cross-office send never re-attributes the call itself', async () => {
  seedCall('x17', VALLEY_DID);
  const base = await startApp();

  await post(`${base}/api/unified-calls/x17/resolve-patient`, {
    patientId: 12827,
    target_office: 'roland',
  });

  const stored = unifiedCallStore.getCall('x17');
  // The line it rang on is the call's identity — the worklists, the filters and the
  // analytics all read it. Writing a note elsewhere is not a reason to move the call.
  assert.equal(stored.called_number, VALLEY_DID);
  assert.equal(stored.office, undefined);
  const fetched = await get(`${base}/api/unified-calls/x17`);
  assert.equal(fetched.body.office_id, 'valley');
});
