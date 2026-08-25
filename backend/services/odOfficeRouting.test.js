'use strict';

// Cross-office routing + contamination tests for the voice path (per-location slice).
// Runner: `node --test`.
//
// WHY THIS FILE EXISTS. Verified live against both practices on 2026-08-07:
//
//     PatNum 7115 in Riley/valley = "Stedi TestValley"  (the test patient)
//     PatNum 7115 in Roland       = a different, REAL patient (not named here)
//     "CareIN AI Call" CommType   = DefNum 486 in Roland, DefNum 451 in Riley
//
// So a valley call that reached Roland's client would put a chart note on an
// unrelated real person, stamped with a CommType that does not exist in the
// database it landed in. Every test below is a specific way that must not happen.
//
// One test per OD call site on the voice/Mango path (the migration inventory):
// the matcher and its three strategies, matchAndSetStatus, Pick Patient's link,
// and the commlog send. Each asserts WHICH practice's database was touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const { beforeEach, afterEach } = test;

const sync = require('./openDentalSync');
const unifiedCallStore = require('./unifiedCallStore');
const odOffices = require('../config/odOffices');
const commlogTypes = require('./commlogTypes');
const { MANGO_LINE_OFFICE } = require('../config/officeAgents');

/**
 * Each practice's commlog-type list, as `GET /definitions?Category=27` really
 * answered on 2026-08-13. Same twelve concepts, twelve different DefNums —
 * "CareIN AI Call" is 486 in Roland and 451 in Riley, and neither number exists
 * in the other's database. That is what makes a picked type a cross-office
 * question and not just a dropdown.
 */
const OFFICE_COMMLOG_DEFS = {
  roland: [
    [224, 'ApptRelated'], [225, 'Insurance'], [226, 'Financial'], [478, 'Treatment Coordinator'],
    [228, 'Misc'], [476, 'Lab Cases'], [401, 'ODHQ'], [465, 'Crown by Moolah'],
    [227, 'Recall'], [441, 'Text'], [427, 'FHIR'], [486, 'CareIN AI Call'],
  ],
  valley: [
    [235, 'ApptRelated'], [236, 'Insurance'], [237, 'Financial'], [436, 'Treatment Coordinator'],
    [239, 'Misc'], [437, 'Lab Cases'], [298, 'ODHQ'], [401, 'Crown by Moolah'],
    [238, 'Recall'], [375, 'Text'], [360, 'FHIR'], [451, 'CareIN AI Call'],
  ],
};

const defsFor = (officeKey) => (OFFICE_COMMLOG_DEFS[officeKey] || []).map(
  ([DefNum, ItemName]) => ({ DefNum, ItemName, Category: 27, category: 'CommLogTypes', isHidden: 'false' })
);

// Real DIDs from the line map, so these calls attribute exactly the way production
// attributes them rather than through a test-only shortcut.
const VALLEY_DID = Object.keys(MANGO_LINE_OFFICE).find((d) => MANGO_LINE_OFFICE[d] === 'valley');
const ROLAND_DID = Object.keys(MANGO_LINE_OFFICE).find((d) => MANGO_LINE_OFFICE[d] === 'roland');

/**
 * The SAME PatNum, as each practice's OD would answer for it.
 *
 * The Roland side is a STAND-IN. PatNum 7115 really is a different, real patient
 * in Roland's database — that collision is the point of these tests — but naming
 * them would put a real patient's name, tied to their practice, in a fixture. The
 * assertions only need the two answers to differ.
 */
const VALLEY_PATIENT = { id: 7115, firstName: 'Stedi', lastName: 'TestValley', fullName: 'Stedi TestValley' };
const ROLAND_PATIENT = { id: 7115, firstName: 'Different', lastName: 'RolandPatient', fullName: 'Different RolandPatient' };

let saved;
/** Every OD interaction any office made, in order: {office, op, arg}. */
let odCalls;
/** Flip inside a test to take the definitions read away from every office. */
let odDefinitionsDown = false;
/** Instance methods we overwrote, so afterEach can put them back. */
let stubbedClients;

/**
 * Make each office's OD client record what it was asked to do, so a test can see
 * exactly which practice's database an operation reached.
 *
 * The handle itself is frozen on purpose — an office must not be re-pointed at
 * another practice at runtime — so this patches METHODS on the client instance
 * the registry built, leaving the real office→client wiring under test.
 */
function stubOfficeClients() {
  odCalls = [];
  stubbedClients = [];

  for (const [officeKey, patient] of [['roland', ROLAND_PATIENT], ['valley', VALLEY_PATIENT]]) {
    let handle;
    try {
      handle = odOffices.getOdOffice(officeKey);
    } catch {
      continue; // office intentionally unavailable in this test
    }

    const c = handle.client;
    stubbedClients.push({
      c,
      original: {
        useDatabase: c.useDatabase,
        pool: c.pool,
        isEnabled: c.isEnabled,
        searchPatients: c.searchPatients,
        getPatientDetails: c.getPatientDetails,
        apiGetRaw: c.apiGetRaw,
        client: c.client,
      },
    });

    c.useDatabase = false;
    c.pool = null;
    c.isEnabled = () => true;
    c.searchPatients = async (q) => {
      odCalls.push({ office: officeKey, op: 'searchPatients', arg: q });
      return [patient];
    };
    c.getPatientDetails = async (id) => {
      odCalls.push({ office: officeKey, op: 'getPatientDetails', arg: id });
      return Number(id) === patient.id ? patient : null;
    };
    // The commlog-type catalogue read. Each office answers with ITS OWN list, so
    // a picked DefNum is checked against the practice it is headed for.
    c.apiGetRaw = async (path, params) => {
      odCalls.push({ office: officeKey, op: 'GET ' + path, arg: params });
      if (path !== '/definitions') return { ok: false, status: 404, data: null, error: 'not stubbed' };
      if (odDefinitionsDown) return { ok: false, status: 503, data: null, error: 'OD unreachable' };
      return { ok: true, status: 200, data: defsFor(officeKey) };
    };
    c.client = {
      post: async (url, body) => {
        odCalls.push({ office: officeKey, op: 'POST ' + url, arg: body });
        return { data: { CommlogNum: officeKey === 'valley' ? 451451 : 486486 } };
      },
    };
  }
}

/** Undo stubOfficeClients — required because 'roland' may resolve to the singleton. */
function restoreOfficeClients() {
  for (const { c, original } of stubbedClients || []) Object.assign(c, original);
  stubbedClients = [];
}

function clearStore() {
  unifiedCallStore.calls.clear();
  unifiedCallStore.bySource.retell.clear();
  unifiedCallStore.bySource.mango.clear();
  unifiedCallStore.byDate.clear();
  unifiedCallStore.byCallerNumber.clear();
}

/** Store a Mango call on the given office's line and return its stored id. */
function seedCall(id, did, over = {}) {
  const call = {
    id,
    source: 'mango',
    called_number: did,
    caller_number: '+15551234567',
    caller_name: 'Stedi TestValley',
    call_date: '2026-08-07T15:00:00.000Z',
    summary: 'wants an appointment',
    ...over,
  };
  unifiedCallStore.calls.set(id, call);
  return call;
}

beforeEach(() => {
  saved = {
    persist: unifiedCallStore.requestPersist,
    roland: process.env.OPENDENTAL_CUSTOMER_KEY,
    valley: process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY,
    valleyEnabled: odOffices.OFFICE_OD_SETTINGS.valley.odEnabled,
  };
  unifiedCallStore.requestPersist = () => {};
  clearStore();

  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-valley-customer-key';
  // Assert the machinery, not whichever value the switch currently ships with.
  odOffices.OFFICE_OD_SETTINGS.valley.odEnabled = true;
  odOffices.resetOdOfficeCache();
  odDefinitionsDown = false;
  // Per-office catalogues are cached across calls in the app; a test must not
  // inherit the previous test's list (or its absence).
  commlogTypes.resetCommlogTypeCache();
  stubOfficeClients();
});

afterEach(() => {
  restoreOfficeClients();
  unifiedCallStore.requestPersist = saved.persist;
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('OPENDENTAL_CUSTOMER_KEY', saved.roland);
  set('OPENDENTAL_CUSTOMER_KEY_VALLEY', saved.valley);
  odOffices.OFFICE_OD_SETTINGS.valley.odEnabled = saved.valleyEnabled;
  odOffices.resetOdOfficeCache();
  commlogTypes.resetCommlogTypeCache();
  clearStore();
});

/** Offices that were touched at all during the test. */
const touchedOffices = () => [...new Set(odCalls.map((c) => c.office))];

// ── Call site: odForCall (the seam every other site goes through) ────────────

test('odForCall resolves a call to ITS OWN office', () => {
  assert.equal(sync.odForCall(seedCall('c1', VALLEY_DID)).officeKey, 'valley');
  assert.equal(sync.odForCall(seedCall('c2', ROLAND_DID)).officeKey, 'roland');
});

test('odForCall refuses a call on an unmapped line', () => {
  assert.throws(
    () => sync.odForCall(seedCall('c3', '+15550000000')),
    (err) => { assert.equal(err.code, 'OFFICE_UNKNOWN'); return true; }
  );
});

// ── Call site: matchCallToPatient + its three strategies ────────────────────

test('matcher searches the OD of the call it was given — valley', async () => {
  const call = seedCall('m1', VALLEY_DID);
  const result = await sync.matchCallToPatient(call);

  assert.deepEqual(touchedOffices(), ['valley']);
  assert.equal(result.patient.fullName, 'Stedi TestValley');
});

test('matcher searches the OD of the call it was given — roland', async () => {
  const call = seedCall('m2', ROLAND_DID);
  const result = await sync.matchCallToPatient(call);

  assert.deepEqual(touchedOffices(), ['roland']);
  assert.equal(result.patient.fullName, 'Different RolandPatient');
});

test('each match strategy searches only the office it was handed', async () => {
  const valley = odOffices.getOdOffice('valley');
  await sync.matchByPhoneExact('5551234567', valley);
  await sync.matchByNameAndPhone('Stedi TestValley', '5551234567', valley);
  await sync.matchByNameFuzzy('Stedi TestValley', valley);

  assert.deepEqual(touchedOffices(), ['valley'], 'no strategy may fall back to another practice');
});

// ── Call site: matchAndSetStatus (Retell webhook, Mango ingest, on-demand) ──

test('matchAndSetStatus matches a valley call in valley and records the office', async () => {
  seedCall('s1', VALLEY_DID);
  const outcome = await sync.matchAndSetStatus('s1', {
    caller_number: '+15551234567', caller_name: 'Stedi TestValley',
  });

  assert.equal(outcome.status, 'matched');
  assert.deepEqual(touchedOffices(), ['valley']);

  const stored = unifiedCallStore.getCall('s1');
  assert.equal(stored.od_patient_id, 7115);
  // Without this the stored 7115 would be indistinguishable from Roland's 7115.
  assert.equal(stored.od_patient_office, 'valley');
});

test('matchAndSetStatus does NOT match a call whose office has no OD', async () => {
  seedCall('s2', '+15550000000'); // unmapped line -> 'unknown'
  const outcome = await sync.matchAndSetStatus('s2', {
    caller_number: '+15551234567', caller_name: 'Stedi TestValley',
  });

  assert.equal(outcome.status, 'office_not_connected');
  assert.equal(odCalls.length, 0, 'an unknown-office call must not search ANY practice');

  const stored = unifiedCallStore.getCall('s2');
  assert.equal(stored.od_sync_status, 'office_not_connected');
  assert.equal(stored.od_patient_id, undefined);
  assert.match(stored.od_office_blocked_reason, /office is unknown/i);
});

// ── Call site: linkCallToPatient (Pick Patient) ─────────────────────────────

test('linking verifies the PatNum in the CALL\'s office, and records that office', async () => {
  seedCall('l1', VALLEY_DID);
  const result = await sync.linkCallToPatient('l1', 7115, {});

  assert.equal(result.success, true);
  assert.deepEqual(touchedOffices(), ['valley']);
  // Riley's 7115 — NOT Roland's person of the same number.
  assert.equal(result.patient.fullName, 'Stedi TestValley');
  assert.equal(unifiedCallStore.getCall('l1').od_patient_office, 'valley');
});

test('linking refuses when the caller names the wrong office', async () => {
  seedCall('l2', VALLEY_DID);
  const result = await sync.linkCallToPatient('l2', 7115, { expectOfficeKey: 'roland' });

  assert.equal(result.success, false);
  assert.equal(result.code, 'OFFICE_MISMATCH');
  assert.equal(odCalls.length, 0, 'a refused link must not touch any OD');
});

test('linking is blocked entirely for an unknown-office call', async () => {
  seedCall('l3', '+15550000000');
  const result = await sync.linkCallToPatient('l3', 7115, {});

  assert.equal(result.success, false);
  assert.equal(result.code, 'OFFICE_UNKNOWN');
  assert.equal(odCalls.length, 0);
});

// ── Call site: syncCallToCommLog (send to chart) ────────────────────────────

test('a valley call writes to valley, with valley\'s DefNum — never 486', async () => {
  seedCall('w1', VALLEY_DID, { od_patient_id: 7115, od_patient_office: 'valley', od_sync_status: 'matched' });
  const result = await sync.syncCallToCommLog('w1', {});

  assert.equal(result.success, true);
  const write = odCalls.find((c) => c.op === 'POST /commlogs');
  assert.equal(write.office, 'valley');
  assert.equal(write.arg.PatNum, 7115);
  assert.equal(write.arg.CommType, 451, "valley writes Riley's CareIN AI Call DefNum");
  assert.notEqual(write.arg.CommType, 486, 'Roland\'s DefNum must NEVER reach Riley');
  assert.equal(unifiedCallStore.getCall('w1').od_patient_office, 'valley');
});

test('a roland call writes to roland, with roland\'s DefNum — never 451', async () => {
  seedCall('w2', ROLAND_DID, { od_patient_id: 7115, od_patient_office: 'roland', od_sync_status: 'matched' });
  const result = await sync.syncCallToCommLog('w2', {});

  assert.equal(result.success, true);
  const write = odCalls.find((c) => c.op === 'POST /commlogs');
  assert.equal(write.office, 'roland');
  assert.equal(write.arg.CommType, 486);
  assert.notEqual(write.arg.CommType, 451);
});

// ── Call site: syncCallToCommLog with a PICKED chart-note type ──────────────
//
// The picker lets a user choose the commlog type instead of always getting the
// office default. That turns "which DefNum?" into a question a request can now
// influence, so the same rule that governs the office governs the type: the
// value is checked against the CALL's own practice, and a number from the other
// practice is refused rather than written.

const commlogWrites = () => odCalls.filter((c) => c.op === 'POST /commlogs');

test("a picked type from the office's own list is what gets written", async () => {
  seedCall('t1', ROLAND_DID, { od_patient_id: 7115, od_patient_office: 'roland', od_sync_status: 'matched' });
  // 227 = "Recall" in Roland's definitions.
  const result = await sync.syncCallToCommLog('t1', { commTypeDefNum: 227 });

  assert.equal(result.success, true);
  const write = commlogWrites()[0];
  assert.equal(write.office, 'roland');
  assert.equal(write.arg.CommType, 227);
});

test("valley picks from valley's list — 238 Recall, not Roland's 227", async () => {
  seedCall('t2', VALLEY_DID, { od_patient_id: 7115, od_patient_office: 'valley', od_sync_status: 'matched' });
  const result = await sync.syncCallToCommLog('t2', { commTypeDefNum: 238 });

  assert.equal(result.success, true);
  assert.equal(commlogWrites()[0].arg.CommType, 238);
  assert.deepEqual(touchedOffices(), ['valley'], "Roland's definitions are never consulted for a valley call");
});

test("Riley's CareIN DefNum (451) is refused on a roland call, before any write", async () => {
  seedCall('t3', ROLAND_DID, { od_patient_id: 7115, od_patient_office: 'roland', od_sync_status: 'matched' });
  const result = await sync.syncCallToCommLog('t3', { commTypeDefNum: 451 });

  assert.equal(result.success, false);
  assert.equal(result.code, 'COMMLOG_TYPE_INVALID');
  assert.equal(commlogWrites().length, 0, 'a refused type must not reach a chart');
  assert.equal(unifiedCallStore.getCall('t3').od_sync_status, 'matched', 'and must not mark the call sent');
});

test("Roland's CareIN DefNum (486) is refused on a valley call, before any write", async () => {
  seedCall('t4', VALLEY_DID, { od_patient_id: 7115, od_patient_office: 'valley', od_sync_status: 'matched' });
  const result = await sync.syncCallToCommLog('t4', { commTypeDefNum: 486 });

  assert.equal(result.success, false);
  assert.equal(result.code, 'COMMLOG_TYPE_INVALID');
  assert.equal(commlogWrites().length, 0);
});

test('DefNum 401 is accepted by BOTH offices — and means something different in each', async () => {
  // The case a naive "is this number one of ours?" check gets wrong in both
  // directions: 401 is "ODHQ" in Roland and "Crown by Moolah" in Riley. Each
  // office may legitimately pick it; neither is picking the other's type.
  seedCall('t5', ROLAND_DID, { od_patient_id: 7115, od_patient_office: 'roland', od_sync_status: 'matched' });
  seedCall('t6', VALLEY_DID, { od_patient_id: 7115, od_patient_office: 'valley', od_sync_status: 'matched' });

  assert.equal((await sync.syncCallToCommLog('t5', { commTypeDefNum: 401 })).success, true);
  assert.equal((await sync.syncCallToCommLog('t6', { commTypeDefNum: 401 })).success, true);

  const writes = commlogWrites();
  assert.deepEqual(writes.map((w) => w.office), ['roland', 'valley']);
  assert.deepEqual(writes.map((w) => w.arg.CommType), [401, 401]);
});

test('omitting the type writes the office default — unchanged from before the picker', async () => {
  seedCall('t7', VALLEY_DID, { od_patient_id: 7115, od_patient_office: 'valley', od_sync_status: 'matched' });
  const result = await sync.syncCallToCommLog('t7', {});

  assert.equal(result.success, true);
  assert.equal(commlogWrites()[0].arg.CommType, 451);
  assert.equal(
    odCalls.some((c) => c.op === 'GET /definitions'), false,
    'a send with no pick must not add a definitions read to the write path'
  );
});

test('with definitions unreadable, the default still sends and a pick fails closed', async () => {
  odDefinitionsDown = true;
  seedCall('t8', ROLAND_DID, { od_patient_id: 7115, od_patient_office: 'roland', od_sync_status: 'matched' });
  seedCall('t9', ROLAND_DID, { od_patient_id: 7115, od_patient_office: 'roland', od_sync_status: 'matched' });

  // Naming the office's own default never needs the catalogue.
  const withDefault = await sync.syncCallToCommLog('t8', { commTypeDefNum: 486 });
  assert.equal(withDefault.success, true);
  assert.equal(commlogWrites()[0].arg.CommType, 486);

  // A different type cannot be checked, so it is refused honestly rather than
  // written on a guess — and NOT reported as an invalid choice.
  const withPick = await sync.syncCallToCommLog('t9', { commTypeDefNum: 227 });
  assert.equal(withPick.success, false);
  assert.equal(withPick.code, 'COMMLOG_TYPE_UNVERIFIABLE');
  assert.equal(commlogWrites().length, 1, 'only the default send reached a chart');
});

test('a send that names the wrong office is refused before any write', async () => {
  seedCall('w3', VALLEY_DID, { od_patient_id: 7115, od_patient_office: 'valley', od_sync_status: 'matched' });
  const result = await sync.syncCallToCommLog('w3', { expectOfficeKey: 'roland' });

  assert.equal(result.success, false);
  assert.equal(result.code, 'OFFICE_MISMATCH');
  assert.equal(odCalls.filter((c) => c.op === 'POST /commlogs').length, 0);
  assert.notEqual(unifiedCallStore.getCall('w3').od_sync_status, 'synced');
});

test('an unknown-office call can never be sent to a chart', async () => {
  seedCall('w4', '+15550000000', { od_patient_id: 7115, od_sync_status: 'matched' });
  const result = await sync.syncCallToCommLog('w4', {});

  assert.equal(result.success, false);
  assert.equal(result.officeBlocked, true);
  assert.equal(odCalls.length, 0);
});

test('an office with no credentials cannot be sent to, even switched on', async () => {
  restoreOfficeClients();
  delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  odOffices.resetOdOfficeCache();
  stubOfficeClients(); // roland only — valley is now unresolvable by design

  seedCall('w5', VALLEY_DID, { od_patient_id: 7115, od_sync_status: 'matched' });
  const result = await sync.syncCallToCommLog('w5', {});

  assert.equal(result.success, false);
  assert.equal(result.code, 'OFFICE_OD_KEY_MISSING');
});

// ── The stale-match guard (pre-slice rows) ──────────────────────────────────
//
// Two shapes used to be indistinguishable here, and the cross-office chart target
// is what separated them:
//
//   LEGACY CORRUPTION — a valley call auto-matched while valley had no OD of its
//     own, so its stored PatNum is really a ROLAND PatNum. These rows predate the
//     od_patient_office field entirely, so the field is ABSENT and patientOfficeOf()
//     reads it as 'roland' by stated assumption.
//   DELIBERATE LINK — a human at one practice linked a call to the other practice's
//     patient. The office is RECORDED, and it is true.
//
// The old guard treated both as corruption and re-matched by phone. That is now the
// wrong answer for the second shape (it throws away what a person said) and, it
// turns out, a worse answer than refusing for the first: re-matching lands the note
// on whoever happens to share the caller's phone number in the resolved office.

test('a PatNum banked against another office with NO recorded office is refused, not written', async () => {
  // The legacy-corruption shape: no od_patient_office, so nothing here is trustworthy
  // enough to write from. Sending it as-is would chart a note on whoever holds that
  // number in Riley; re-matching would chart it on whoever shares the caller's phone.
  // Neither is a thing to guess at, so nothing is written at all.
  seedCall('x1', VALLEY_DID, {
    od_patient_id: 999999,          // really a Roland PatNum, from before offices existed
    od_sync_status: 'matched',
  });

  const result = await sync.syncCallToCommLog('x1', {});

  assert.equal(result.success, false);
  assert.equal(result.code, 'PATIENT_OFFICE_MISMATCH');
  assert.equal(result.officeBlocked, true);
  const write = odCalls.find((c) => c.op === 'POST /commlogs');
  assert.equal(write, undefined, 'a foreign PatNum must never be written');
});

test('a PatNum with a RECORDED other-practice office is a deliberate link and is honoured', async () => {
  // Same call, but the office is recorded — which only happens when someone said so.
  // The write follows the patient into their own practice's database, because that
  // is the only database that PatNum means anything in.
  seedCall('x1b', VALLEY_DID, {
    od_patient_id: 7115,
    od_patient_office: 'roland',
    od_sync_status: 'matched',
  });

  const result = await sync.syncCallToCommLog('x1b', {});

  assert.equal(result.success, true);
  const write = odCalls.find((c) => c.op === 'POST /commlogs');
  assert.equal(write.office, 'roland');
  assert.equal(write.arg.PatNum, 7115);
});

test('legacy rows with no recorded office are read as roland', async () => {
  // Everything matched before this slice came from the single Roland-bound client.
  // Stating that assumption is what makes the guard fire on valley rows.
  assert.equal(sync.patientOfficeOf({ od_patient_id: 12 }), 'roland');
  assert.equal(sync.patientOfficeMatches({ od_patient_id: 12 }, 'roland'), true);
  assert.equal(sync.patientOfficeMatches({ od_patient_id: 12 }, 'valley'), false);
  // A call with no stored PatNum has nothing to disagree about.
  assert.equal(sync.patientOfficeMatches({}, 'valley'), true);
});

// ── The blunt end: no valley operation ever touches roland, or vice versa ───

test('a full valley flow never touches Roland at any point', async () => {
  seedCall('f1', VALLEY_DID);
  await sync.matchAndSetStatus('f1', { caller_number: '+15551234567', caller_name: 'Stedi TestValley' });
  await sync.linkCallToPatient('f1', 7115, {});
  await sync.syncCallToCommLog('f1', {});

  assert.deepEqual(touchedOffices(), ['valley'], 'Roland must appear nowhere in a valley flow');
});

test('a full roland flow never touches valley at any point', async () => {
  seedCall('f2', ROLAND_DID);
  await sync.matchAndSetStatus('f2', { caller_number: '+15551234567', caller_name: 'Different RolandPatient' });
  await sync.linkCallToPatient('f2', 7115, {});
  await sync.syncCallToCommLog('f2', {});

  assert.deepEqual(touchedOffices(), ['roland'], 'Riley must appear nowhere in a Roland flow');
});
