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
 *  8. The follow-the-patient default is a SERVICE invariant, not a route
 *     convenience. syncCallToCommLog is reachable from the legacy sync route and
 *     from the batch drain, neither of which names a target — and a link the
 *     service does not honour is a link the service will silently re-match away.
 *  9. A stored link that disagrees with the resolved office is REFUSED, never
 *     routed around.
 *
 * Written against the failure they describe: (8) and (9) both fail on the code as
 * it stood before this round — (8) by writing to the wrong practice, (9) by
 * writing to the wrong patient.
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
const openDentalSyncRouter = require('../routes/openDentalSync');
const openDentalSyncService = require('../services/openDentalSync');

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
const CALLER_NUMBER = '+15551234567';
/** What cleanPhoneNumber() makes of CALLER_NUMBER — what the matcher actually searches. */
const CALLER_DIGITS = '5551234567';

/**
 * Each office's patient list. PatNum 7115 appears in BOTH and is a different person
 * in each — the entire reason a PatNum may not travel between practices.
 *
 * `valley/9001` is load-bearing for the round-2 tests: it holds the CALLER'S phone
 * number, so a phone re-match in the call's own office lands on it at 0.95
 * confidence. Without someone here for the matcher to find, "never re-matches"
 * would pass because there was nothing to find rather than because nothing was
 * attempted — and the defect being pinned is precisely a note landing on this
 * person's chart instead of the linked patient's.
 */
const OFFICE_PATIENTS = {
  roland: [
    { id: 12827, fullName: 'Test 2, Stedi', phone: '9185550100' },
    { id: 7115, fullName: 'Roland Seven One One Five', phone: '9185550101' },
  ],
  valley: [
    { id: 7115, fullName: 'Stedi TestValley', phone: '4795550199' },
    { id: 9001, fullName: 'Valley Someone Else', phone: CALLER_DIGITS },
  ],
};

const saved = {};
let auditRows = [];
/** Every POST /commlogs, tagged with the office whose client made it. */
let writes = [];
/** Every patient search, tagged the same way. */
let searches = [];
/** Every getPatientDetails, tagged the same way — the other way to reach OD. */
let lookups = [];
let stubbed = [];

function stubOfficeClients() {
  writes = [];
  searches = [];
  lookups = [];
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
      lookups.push({ office: officeKey, id: String(id) });
      const found = OFFICE_PATIENTS[officeKey].find((p) => String(p.id) === String(id));
      return found ? { id: Number(id), fullName: found.fullName } : null;
    };
    // Name OR phone, because that is what the real dual-lane OD search does — and
    // because the matcher's first strategy searches by DIGITS, so a name-only stub
    // would make every re-match silently find nothing.
    c.searchPatients = async (q) => {
      searches.push({ office: officeKey, q });
      const needle = String(q).toLowerCase();
      return OFFICE_PATIENTS[officeKey].filter(
        (p) => p.fullName.toLowerCase().includes(needle) || (p.phone && p.phone.includes(needle))
      );
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
    caller_number: CALLER_NUMBER,
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
  // The LEGACY sync route, mounted as server.js mounts it minus the permission
  // gate (which is a mount-level concern this file does not test). It is here
  // because it is one of the two callers that reaches the service with no target.
  app.use('/api/opendental-sync', openDentalSyncRouter);

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

// ── 8. The default is a SERVICE invariant, not a route convenience ─────────
//
// syncCallToCommLog is reachable from two callers that name no target and know
// nothing about the follow-the-patient rule. Before this round both resolved the
// CALL's office, hit the stale-match branch, discarded the human's cross-office
// link and re-matched by phone — landing the note on valley/9001, who merely
// shares the caller's number.

test('a cross-office-linked call synced through the LEGACY sync route writes to the LINKED office and never re-matches', async () => {
  // Riley took the call; a human linked it to a Roland patient.
  seedCall('y1', VALLEY_DID, [12827, 'roland']);
  const base = await startApp();

  const res = await post(`${base}/api/opendental-sync/calls/y1/sync`, {});

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(writes.length, 1);
  // The linked office, not the call's.
  assert.equal(writes[0].office, 'roland');
  assert.equal(writes[0].body.CommType, 486);
  assert.equal(String(res.body.patientId), '12827');
  // Zero searches: the human already said who this is. A single search here would
  // mean the link was thrown away, and valley/9001 holds this caller's number.
  assert.equal(searches.length, 0);
  assert.equal(unifiedCallStore.getCall('y1').od_patient_office, 'roland');
});

test('a cross-office-linked call driven the way the batch drain drives one writes to the linked office', async () => {
  // od_sync_status is absent, which is the shape the batch drain selects on.
  // Reachable: a call that never went through the matcher, linked cross-office,
  // whose send then failed — the link is stored, the status was never advanced.
  unifiedCallStore.calls.set('y2', {
    id: 'y2',
    source: 'mango',
    called_number: VALLEY_DID,
    caller_number: CALLER_NUMBER,
    call_date: '2026-08-24T15:00:00.000Z',
    summary: 'wants an appointment',
    od_patient_id: 12827,
    od_patient_office: 'roland',
  });

  // Deliberately NOT through syncAllPendingCalls. That method's first line calls
  // unifiedCallStore.getAllCalls(), which does not exist — the batch drain has been
  // dead since the store was refactored and throws a TypeError before it reads a
  // call (its route, POST /api/opendental-sync/sync-all, 500s). Reviving it is not
  // this PR's business: it auto-writes chart notes with no human pressing Send,
  // which is the rule the whole review-then-send design rests on.
  //
  // So this drives the per-call step the loop performs — syncCallToCommLog with the
  // batch's options and no target — which is where the defect lived either way.
  const result = await openDentalSyncService.syncCallToCommLog('y2', { includeTranscript: true });

  assert.equal(result.success, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].office, 'roland');
  assert.equal(writes[0].body.CommType, 486);
  assert.equal(searches.length, 0);
});

// ── 9. A link that disagrees with the resolved office is REFUSED ───────────

test('a stored link whose office disagrees with the resolved target is REFUSED and makes zero OD calls', async () => {
  seedCall('y3', VALLEY_DID, [12827, 'roland']);
  writes = []; searches = []; lookups = [];

  // Naming valley explicitly contradicts the stored roland link. Which of the two
  // is wrong is a question for a person; the service refuses rather than picking.
  const result = await openDentalSyncService.syncCallToCommLog('y3', { targetOfficeKey: 'valley' });

  assert.equal(result.success, false);
  assert.equal(result.code, 'PATIENT_OFFICE_MISMATCH');
  assert.equal(result.officeBlocked, true);
  // Nothing written, nothing re-matched, nothing even looked up.
  assert.equal(writes.length, 0);
  assert.equal(searches.length, 0);
  assert.equal(lookups.length, 0);
  // And the call is untouched — a refusal is not a state change.
  const stored = unifiedCallStore.getCall('y3');
  assert.equal(String(stored.od_patient_id), '12827');
  assert.equal(stored.od_patient_office, 'roland');
  assert.notEqual(stored.od_sync_status, 'synced');
});

test('a link stamped with an office we no longer recognise refuses rather than re-matching', async () => {
  // The other way the guard is reached, and the one that survives a config change:
  // defaultTargetOfficeFor ignores a stored office that is not in the registry —
  // it will not trust a key it cannot identify — so the write resolves to the
  // call's own office and finds a link that disagrees with it.
  unifiedCallStore.calls.set('y4', {
    id: 'y4',
    source: 'mango',
    called_number: VALLEY_DID,
    caller_number: CALLER_NUMBER,
    call_date: '2026-08-24T15:00:00.000Z',
    summary: 'wants an appointment',
    od_patient_id: 12827,
    od_patient_office: 'springfield',
    od_sync_status: 'matched',
  });
  const base = await startApp();

  const res = await post(`${base}/api/opendental-sync/calls/y4/sync`, {});

  // The legacy route flattens every service refusal to 400; the code travels in
  // the service result, which the direct-call test above pins.
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  // Nothing written and — the part that matters — nothing re-matched onto
  // valley/9001, who merely shares the caller's phone number.
  assert.equal(writes.length, 0);
  assert.equal(searches.length, 0);
  const stored = unifiedCallStore.getCall('y4');
  assert.equal(stored.od_patient_office, 'springfield');
  assert.notEqual(stored.od_sync_status, 'synced');
});

// ── The matcher never overwrites a link a human made ───────────────────────

test('matchAndSetStatus leaves an already-linked call alone instead of re-matching it', async () => {
  seedCall('y5', VALLEY_DID, [12827, 'roland']);

  const outcome = await openDentalSyncService.matchAndSetStatus('y5', {
    caller_number: CALLER_NUMBER,
    caller_name: 'Unknown',
  });

  assert.equal(outcome.status, 'already_linked');
  assert.equal(outcome.officeKey, 'roland');
  // The hourly Mango sync calls this for every non-'synced' call. Without the skip
  // it would re-match in valley, find 9001 on the caller's number at 0.95, and
  // silently re-point the link within the hour.
  assert.equal(searches.length, 0);
  const stored = unifiedCallStore.getCall('y5');
  assert.equal(String(stored.od_patient_id), '12827');
  assert.equal(stored.od_patient_office, 'roland');
});

// ── linkOnly compares (PatNum, office), never PatNum alone ─────────────────

test('re-linking a synced call to the SAME PatNum at a DIFFERENT office is refused', async () => {
  // Sent to Roland's chart already, on PatNum 7115.
  unifiedCallStore.calls.set('y6', {
    id: 'y6',
    source: 'mango',
    called_number: ROLAND_DID,
    caller_number: CALLER_NUMBER,
    call_date: '2026-08-24T15:00:00.000Z',
    od_patient_id: 7115,
    od_patient_office: 'roland',
    od_commlog_num: 486486,
    od_sync_status: 'synced',
  });
  const base = await startApp();

  const res = await post(`${base}/api/unified-calls/y6/resolve-patient`, {
    patientId: 7115,
    target_office: 'valley',
    office_id: 'valley',
    linkOnly: true,
  });

  // 7115 in Roland and 7115 in Riley are two different people. Comparing the number
  // alone would read this as "same patient, harmless no-op" and accept it.
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ALREADY_SENT_TO_CHART');
  const stored = unifiedCallStore.getCall('y6');
  assert.equal(stored.od_patient_office, 'roland');
  assert.equal(stored.od_commlog_num, 486486);
});

test('re-linking a synced call to the same PatNum at the SAME office is still a no-op', async () => {
  unifiedCallStore.calls.set('y7', {
    id: 'y7',
    source: 'mango',
    called_number: ROLAND_DID,
    caller_number: CALLER_NUMBER,
    call_date: '2026-08-24T15:00:00.000Z',
    od_patient_id: 7115,
    od_patient_office: 'roland',
    od_commlog_num: 486486,
    od_sync_status: 'synced',
  });
  const base = await startApp();

  const res = await post(`${base}/api/unified-calls/y7/resolve-patient`, {
    patientId: 7115,
    linkOnly: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.alreadySynced, true);
  assert.equal(writes.length, 0);
});

// ── Cross-office SEARCH takes the permission that writing takes ────────────

test('a role without voice.chart_write cannot search the OTHER office', async () => {
  seedCall('y8', VALLEY_DID);
  // `tc` holds voice.read but not voice.chart_write — a treatment coordinator
  // looking up who called, which is exactly the caller this gate is about.
  const base = await startApp({ role: 'tc' });

  const res = await get(`${base}/api/unified-calls/y8/patient-search?q=Stedi&target_office=roland`);

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CROSS_OFFICE_SEARCH_FORBIDDEN');
  assert.deepEqual(res.body.patients, []);
  // Refused BEFORE any PHI is read.
  assert.equal(searches.length, 0);
  // And recorded, with both offices — a refused attempt to page through another
  // practice's records is exactly what the trail is for.
  const refused = auditRows.filter((r) => r.result === 'UNAUTHORIZED');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].action, 'READ');
  assert.equal(refused[0].office, 'roland');
  assert.equal(refused[0].originOffice, 'valley');
});

test('the same role can still search its OWN office', async () => {
  seedCall('y9', VALLEY_DID);
  const base = await startApp({ role: 'tc' });

  const res = await get(`${base}/api/unified-calls/y9/patient-search?q=Stedi`);

  // Answering "who called?" in this practice's own records is triage, not a chart
  // write, and stays open to every voice role.
  assert.equal(res.status, 200);
  assert.equal(searches.length, 1);
  assert.equal(searches[0].office, 'valley');
});
