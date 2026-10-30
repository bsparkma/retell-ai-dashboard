'use strict';

/**
 * CO-4b — the Open Dental-driven pipeline sync.
 *
 *   signals    Complete → completed; Broken / UnschedList → pending_pt (anchor
 *              kept); a new date/time → the anchor follows, a note, no move;
 *              404, another patient's PatNum, any other status, two anchors →
 *              a FLAG and nothing else
 *   undo       reverts the case (or the anchor's time), audited; the engine
 *              does not redo the same move until Open Dental's state changes
 *   switch     OFF writes NOTHING — no read, no run row, no flag, no audit row —
 *              by Sync now, by the engine, and by the nightly pass
 *   cap        at most 200 reads per office per run, each paced ≥ 1200 ms with
 *              a timeout (call count pinned)
 *   isolation  the same AptNum in the other office is never read or touched
 *   fail closed one failed read → the office's run is `failed`, nothing applied
 *   trail      badge state, an audit row per change with its prior state, the
 *              run row; unanchored Scheduled cases are counted
 *
 * Open Dental is faked on each office's REAL client (apiGetRaw patched), so the
 * calls show which database was asked. Test patients only (roland 12827 /
 * 12828, valley 7115); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const odOffices = require('../../config/odOffices');
const tcOdSync = require('../../config/tcOdSync');
const engine = require('../../services/tc/odPipelineSync');
const odSyncRoute = require('./odSync');
const { TcOpportunitiesScheduler } = require('../../services/tcOpportunities/scheduler');
const contract = require('../../tc/contract.gen.cjs');
const { bootTcApp, api, auditRows, FakeTenantDb } = require('./tcTestUtils');

const OD_KEY_ENV = { roland: 'OPENDENTAL_CUSTOMER_KEY', valley: 'OPENDENTAL_CUSTOMER_KEY_VALLEY' };
const SWITCH_ENV = ['TC_OD_SYNC_ENABLED_ROLAND', 'TC_OD_SYNC_ENABLED_VALLEY', 'TC_OD_SYNC_MAX_PER_RUN'];
const savedEnv = {};
let savedGetPlatformSetting;

test.before(() => {
  for (const k of [...Object.values(OD_KEY_ENV), 'OPENDENTAL_ALLOW_MOCK', ...SWITCH_ENV]) savedEnv[k] = process.env[k];
  process.env[OD_KEY_ENV.roland] = 'test-roland-customer-key';
  process.env[OD_KEY_ENV.valley] = 'test-valley-customer-key';
  delete process.env.OPENDENTAL_ALLOW_MOCK;
  odOffices.resetOdOfficeCache();
  // No control plane in tests: no stored row, so the env fallback (or OFF) answers.
  savedGetPlatformSetting = registry.getPlatformSetting;
  registry.getPlatformSetting = async () => null;
});
test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  registry.getPlatformSetting = savedGetPlatformSetting;
  odOffices.resetOdOfficeCache();
  tcOdSync.resetCacheForTests();
});
test.beforeEach(() => {
  for (const k of SWITCH_ENV) delete process.env[k];
  tcOdSync.resetCacheForTests();
});

/** Switch the sync on for these offices (the env fallback; no stored row). */
function switchOn(...offices) {
  for (const o of offices) process.env[`TC_OD_SYNC_ENABLED_${o.toUpperCase()}`] = 'true';
  tcOdSync.resetCacheForTests();
}

/** An OD appointment, as GET /appointments/{AptNum} returns it. */
function apt(over) {
  return { AptNum: 5001, PatNum: 12827, AptStatus: 'Scheduled', AptDateTime: '2026-11-04 09:00:00', Note: 'never leaves OD', ...over };
}

/**
 * Patch each office's own client. `od[office]` maps AptNum → row (absent = 404).
 * `fail[office]` = an AptNum whose read fails with a 500. Every call is recorded.
 */
async function withOd(od, fn, { fail = {} } = {}) {
  const calls = [];
  const patched = [];
  for (const office of Object.keys(OD_KEY_ENV)) {
    const { client } = odOffices.getOdOffice(office);
    patched.push({ client, original: client.apiGetRaw });
    client.apiGetRaw = async (p, params = {}, opts = {}) => {
      calls.push({ office, path: p, params, opts });
      const m = /^\/appointments\/(\d+)$/.exec(p);
      if (!m) return { ok: false, status: 404, data: null, error: 'not a valid resource' };
      const n = Number(m[1]);
      if (fail[office] === n) return { ok: false, status: 500, data: null, error: 'boom' };
      const row = (od[office] || {})[n];
      return row ? { ok: true, status: 200, data: row } : { ok: false, status: 404, data: null, error: 'Appointment not found' };
    };
  }
  try {
    return await fn({ calls });
  } finally {
    for (const { client, original } of patched) client.apiGetRaw = original;
  }
}

/** Scalars for a seeded case (the same shape a checkout opens one with). */
const CASE_DEFAULTS = {
  legacyId: null,
  patientAge: null,
  phone: null,
  email: null,
  caseType: 'Checkout',
  category: 'single_tooth',
  readinessScore: 0,
  caseValueCents: 0,
  financingStatus: '',
  preferredFinancingProvider: null,
  decisionMakers: '',
  financialSituation: [],
  keyMotivators: [],
  contactPreference: null,
  bestTimeToReach: '',
  referralSource: 'hygiene',
  lostReason: null,
  diagnosedDate: null,
  nurtureCadence: 'standard',
  inLongTailMode: false,
  nurtureEnrolledAt: null,
  nurturePhaseChangedAt: null,
  nurturePhase1DaysOverride: null,
  nurturePhase2DaysOverride: null,
  nurtureUnsubscribed: false,
  phases: [],
  objections: [],
  followups: [],
  events: [],
  hygieneIntake: null,
  urgency: 'medium',
  doctorName: '',
  diagnosingProvider: null,
  assignedTc: 'desk@carein.ai',
  notes: '',
  statusChangedAt: '2026-10-30T15:00:00.000Z',
};

/** A Scheduled case with (optionally) an anchored Scheduled checkout, straight into the store. */
function seedCase(db, { office = 'roland', aptNum = 5001, patNum = 12827, at = '2026-11-04 09:00:00', anchored = true, name = 'Test 2, Stedi', caseId = randomUUID() } = {}) {
  const aggregate = contract.TcCase.parse({ ...CASE_DEFAULTS, caseId, officeId: office, patientName: name, odPatientId: patNum, status: 'scheduled' });
  const { caseRow: row } = contract.caseToRows(aggregate, randomUUID);
  db.table('tc_cases').push({
    ...row,
    od_sync_action: null,
    od_sync_flag: null,
    od_sync_undone: null,
    od_sync_checked_at: null,
    created_at: new Date('2026-10-30T15:00:00Z'),
    updated_at: new Date('2026-10-30T15:00:00Z'),
  });
  const handoffId = randomUUID();
  db.table('tc_checkout_handoffs').push({
    handoff_id: handoffId,
    office_id: office,
    case_id: caseId,
    status: 'scheduled',
    od_patient_id: patNum,
    appt_num: anchored ? aptNum : null,
    appt_at_local: anchored ? at : null,
    appt_snapshot: anchored ? { provider: 'DOC1', appointmentType: 'Crown prep', operatory: 'Op 4' } : null,
    appt_linked_by: anchored ? 'desk@carein.ai' : null,
    appt_linked_at: anchored ? '2026-10-30T15:05:00.000Z' : null,
  });
  return { caseId, handoffId };
}

const caseRow = (db, id) => db.table('tc_cases').find((r) => r.case_id === id);
const handoffRow = (db, id) => db.table('tc_checkout_handoffs').find((r) => r.handoff_id === id);
const obj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const writes = (db) => db.log.filter((l) => /^(INSERT|UPDATE|DELETE)/i.test(l.sql));

/** Run the engine directly (the nightly path), auditing into a list. */
async function runEngine(db, office = 'roland', trigger = 'nightly') {
  const audited = [];
  const out = await engine.syncOffice({ office, pool: db, trigger, audit: async (e) => audited.push(...e) });
  return { out, audited };
}

/** Sync now through the real route, then wait for the sweep it started. */
async function syncNow(baseUrl, office = 'roland') {
  const res = await api(baseUrl, 'POST', `/api/tc/od-sync/run?office=${office}`);
  await odSyncRoute.waitForRunsForTests();
  return res;
}

// ── 1. The signal map, pure ─────────────────────────────────────────────────

test('decide(): every Open Dental signal maps to exactly one action; the ambiguous ones flag', () => {
  const anchor = { aptNum: 5001, patNum: 12827, atLocal: '2026-11-04 09:00' };
  const kase = { undone: null };
  const read = (over) => ({ missing: false, appointment: { aptNum: 5001, patNum: 12827, aptStatus: 'Scheduled', dateTime: '2026-11-04 09:00:00', ...over } });

  assert.equal(engine.decide(kase, anchor, read({ aptStatus: 'Complete' })).kind, 'completed');
  assert.equal(engine.decide(kase, anchor, read({ aptStatus: 'Complete' })).toStatus, 'completed');
  assert.equal(engine.decide(kase, anchor, read({ aptStatus: 'Broken' })).toStatus, 'pending_pt');
  assert.equal(engine.decide(kase, anchor, read({ aptStatus: 'UnschedList' })).toStatus, 'pending_pt');
  // Same minute (seconds differ in shape only) → nothing.
  assert.equal(engine.decide(kase, anchor, read({})).kind, 'none');
  const moved = engine.decide(kase, anchor, read({ dateTime: '2026-11-06 13:30:00' }));
  assert.equal(moved.kind, 'rescheduled');
  assert.equal(moved.toDateTime, '2026-11-06 13:30:00');

  // Ambiguous → flag, never a move.
  assert.deepEqual(
    { kind: engine.decide(kase, anchor, { missing: true }).kind, reason: engine.decide(kase, anchor, { missing: true }).reason },
    { kind: 'flag', reason: 'missing' }
  );
  for (const s of ['Planned', 'PtNote', 'PtNoteCompleted', 'ASAP', '', 'SomethingNew']) {
    const d = engine.decide(kase, anchor, read({ aptStatus: s }));
    assert.equal(d.kind, 'flag', `status '${s}' must flag`);
    assert.equal(d.reason, 'status');
  }
  const other = engine.decide(kase, anchor, read({ aptStatus: 'Complete', patNum: 12828 }));
  assert.equal(other.kind, 'flag', "another patient's appointment is never acted on");
  assert.equal(other.reason, 'patient');
});

test('decide(): an undone move is held while Open Dental shows the same state, and acts on a new one', () => {
  const anchor = { aptNum: 5001, patNum: 12827, atLocal: '2026-11-04 09:00' };
  const complete = { missing: false, appointment: { aptNum: 5001, patNum: 12827, aptStatus: 'Complete', dateTime: '2026-11-04 09:00:00' } };
  const fp = engine.decide({ undone: null }, anchor, complete).fingerprint;
  assert.equal(engine.decide({ undone: { fingerprint: fp } }, anchor, complete).kind, 'held');
  const broken = { missing: false, appointment: { ...complete.appointment, aptStatus: 'Broken' } };
  assert.equal(engine.decide({ undone: { fingerprint: fp } }, anchor, broken).kind, 'unscheduled');
});

// ── 2. Switch OFF writes nothing ────────────────────────────────────────────

test('switch OFF (the default): Sync now refuses, the engine and the nightly pass write NOTHING and read nothing', async () => {
  const db = new FakeTenantDb();
  const { caseId } = seedCase(db);
  seedCase(db, { office: 'valley', aptNum: 7001, patNum: 7115 });
  const { baseUrl, close } = await bootTcApp({ db });
  try {
    await withOd({ roland: { 5001: apt({ AptStatus: 'Complete' }) } }, async ({ calls }) => {
      const before = db.log.length;

      const res = await api(baseUrl, 'POST', '/api/tc/od-sync/run?office=roland');
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'OD_SYNC_OFF');

      const direct = await runEngine(db);
      assert.deepEqual(direct.out, { status: 'skipped', reason: 'SWITCH_OFF' });
      assert.deepEqual(direct.audited, []);

      const nightly = new TcOpportunitiesScheduler({
        registry: { listTenants: async () => [], getEnabledModules: async () => [] },
      });
      const pass = await nightly.runPipelineSync();
      assert.equal(pass.skipped, 'NO_OFFICE_SWITCHED_ON');

      assert.equal(calls.length, 0, 'no Open Dental read for a switched-off office');
      const wrote = db.log.slice(before).filter((l) => /^(INSERT|UPDATE|DELETE)/i.test(l.sql));
      assert.deepEqual(wrote, [], 'not a run row, not a flag, not a case');
      assert.equal(db.table('tc_od_sync_runs').length, 0);
      assert.equal(caseRow(db, caseId).status, 'scheduled');
      assert.equal(auditRows(db).filter((r) => String(r.resource_type).includes('od_sync')).length, 0);
    });
  } finally {
    await close();
  }
});

test('env =false beats a stored true (break-glass supreme); the floor is OFF', async () => {
  registry.getPlatformSetting = async () => ({ key: 'tc_od_sync_enabled', value: { roland: true }, updated_at: new Date(), updated_by: 'x' });
  try {
    tcOdSync.resetCacheForTests();
    assert.equal(await tcOdSync.isEnabled('roland'), true);
    assert.equal(await tcOdSync.isEnabled('valley'), false, 'an office the row does not name is OFF');
    process.env.TC_OD_SYNC_ENABLED_ROLAND = 'false';
    assert.equal(await tcOdSync.isEnabled('roland'), false);
  } finally {
    registry.getPlatformSetting = async () => null;
    delete process.env.TC_OD_SYNC_ENABLED_ROLAND;
    tcOdSync.resetCacheForTests();
  }
});

// ── 3. Each signal, end to end ──────────────────────────────────────────────

test('Complete → the case moves to completed: badge state, timeline event, audit with prior state, run summary', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const { caseId, handoffId } = seedCase(db);
  const { baseUrl, close } = await bootTcApp({ db });
  try {
    await withOd({ roland: { 5001: apt({ AptStatus: 'Complete' }) } }, async ({ calls }) => {
      const res = await syncNow(baseUrl);
      assert.equal(res.status, 202);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].office, 'roland');
      assert.equal(calls[0].path, '/appointments/5001');

      const kase = caseRow(db, caseId);
      assert.equal(kase.status, 'completed');
      const action = obj(kase.od_sync_action);
      assert.equal(action.kind, 'completed');
      assert.equal(action.fromStatus, 'scheduled');
      assert.equal(action.toStatus, 'completed');
      assert.equal(handoffRow(db, handoffId).appt_num, 5001, 'the anchor stays');

      const ev = db.table('tc_case_events').find((e) => e.case_id === caseId && e.type === 'status_change');
      assert.match(ev.description, /^scheduled → completed: /);
      assert.equal(ev.actor, engine.SYNC_ACTOR);

      const trail = auditRows(db);
      const read = trail.find((r) => r.resource_type === 'od_appointment');
      assert.equal(read.action, 'READ');
      assert.equal(read.resource_id, '5001');
      assert.equal(read.office, 'roland');
      const move = trail.find((r) => r.resource_type === 'tc_case.od_sync_completed');
      assert.equal(move.resource_id, caseId);
      assert.equal(move.prior_state, 'scheduled');
      assert.equal(move.user_id, engine.SYNC_ACTOR, 'the system made the change');
      assert.ok(trail.find((r) => r.resource_type === 'tc_od_sync_run' && r.action === 'CREATE' && r.user_id === 'tc@carein.ai'),
        'the person who pressed Sync now is on the trail');

      const run = db.table('tc_od_sync_runs')[0];
      assert.equal(run.status, 'ok');
      assert.equal(run.trigger, 'manual');
      assert.equal(run.requested_by, 'tc@carein.ai');
      assert.equal(obj(run.summary).completed, 1);

      // The status endpoint and the case list both carry the badge.
      const status = await api(baseUrl, 'GET', '/api/tc/od-sync/status?office=roland');
      assert.equal(status.body.lastRun.status, 'ok');
      assert.equal(status.body.lastRun.summary.completed, 1);
      assert.equal(status.body.changes.length, 1);
      assert.equal(status.body.changes[0].action.kind, 'completed');
      assert.equal(status.body.changes[0].action.fingerprint, undefined, 'no internals leave');
      const list = await api(baseUrl, 'GET', '/api/tc/cases?office=roland');
      const card = list.body.cases.find((c) => c.caseId === caseId);
      assert.equal(card.odSync.action.kind, 'completed');
    });
  } finally {
    await close();
  }
});

test('Broken and UnschedList → pending_pt, the anchor kept as history', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const broken = seedCase(db, { aptNum: 5001 });
  const unsched = seedCase(db, { aptNum: 5002 });
  await withOd(
    { roland: { 5001: apt({ AptStatus: 'Broken' }), 5002: apt({ AptNum: 5002, AptStatus: 'UnschedList' }) } },
    async () => {
      const { out } = await runEngine(db);
      assert.equal(out.summary.unscheduled, 2);
    }
  );
  for (const s of [broken, unsched]) {
    assert.equal(caseRow(db, s.caseId).status, 'pending_pt');
    assert.equal(obj(caseRow(db, s.caseId).od_sync_action).kind, 'unscheduled');
    assert.ok(handoffRow(db, s.handoffId).appt_num, 'anchor kept');
  }
});

test('a new date/time in Open Dental → the anchor follows, a note, NO column move', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const { caseId, handoffId } = seedCase(db);
  await withOd({ roland: { 5001: apt({ AptDateTime: '2026-11-06 13:30:00' }) } }, async () => {
    const { out, audited } = await runEngine(db);
    assert.equal(out.summary.rescheduled, 1);
    assert.ok(audited.find((a) => a.resourceType === 'tc_case.od_sync_rescheduled' && a.priorState === 'scheduled'));
  });
  assert.equal(caseRow(db, caseId).status, 'scheduled');
  assert.equal(handoffRow(db, handoffId).appt_at_local, '2026-11-06 13:30:00');
  const note = db.table('tc_case_events').find((e) => e.case_id === caseId && e.type === 'note_added');
  assert.match(note.description, /^Rescheduled in Open Dental: 2026-11-04 09:00 → 2026-11-06 13:30/);
});

test('ambiguous signals FLAG and touch nothing else: 404, another status, another patient, two anchors', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const gone = seedCase(db, { aptNum: 5001 });
  const planned = seedCase(db, { aptNum: 5002 });
  const otherPatient = seedCase(db, { aptNum: 5003 });
  const two = seedCase(db, { aptNum: 5004 });
  // A second anchored Scheduled checkout on the same case, another AptNum.
  db.table('tc_checkout_handoffs').push({
    ...handoffRow(db, two.handoffId),
    handoff_id: randomUUID(),
    appt_num: 5005,
  });
  const before = (s) => ({ status: caseRow(db, s.caseId).status, at: handoffRow(db, s.handoffId).appt_at_local });
  const snap = [gone, planned, otherPatient, two].map(before);

  await withOd(
    { roland: { 5002: apt({ AptNum: 5002, AptStatus: 'Planned' }), 5003: apt({ AptNum: 5003, PatNum: 12828, AptStatus: 'Complete' }) } },
    async ({ calls }) => {
      const { out, audited } = await runEngine(db);
      assert.equal(out.summary.flagged, 4);
      assert.equal(out.summary.completed + out.summary.unscheduled + out.summary.rescheduled, 0);
      assert.ok(!calls.find((c) => /5004|5005/.test(c.path)), 'two anchors: not even read — no guess');
      assert.equal(audited.filter((a) => a.resourceType === 'tc_case.od_sync_flagged').length, 4);
    }
  );
  const reasons = [gone, planned, otherPatient, two].map((s) => obj(caseRow(db, s.caseId).od_sync_flag).reason);
  assert.deepEqual(reasons, ['missing', 'status', 'patient', 'multiple']);
  assert.deepEqual([gone, planned, otherPatient, two].map(before), snap, 'no status, no anchor changed');
  for (const s of [gone, planned, otherPatient, two]) assert.equal(caseRow(db, s.caseId).od_sync_action, null);
});

test('a person who moves the case while the sweep is reading wins: the sync does not overwrite it', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const { caseId } = seedCase(db);
  // Open Dental answers "Complete" — and while it does, somebody marks the case lost.
  const odGet = async () => {
    caseRow(db, caseId).status = 'lost';
    return { ok: true, status: 200, data: apt({ AptStatus: 'Complete' }) };
  };
  const audited = [];
  const out = await engine.syncOffice({ office: 'roland', pool: db, trigger: 'nightly', odGet, audit: async (e) => audited.push(...e) });
  assert.equal(out.summary.raced, 1);
  assert.equal(out.summary.completed, 0);
  assert.equal(caseRow(db, caseId).status, 'lost');
  assert.equal(caseRow(db, caseId).od_sync_action, null, 'no badge for a move that did not happen');
  assert.equal(db.table('tc_case_events').filter((e) => e.case_id === caseId).length, 0);
  assert.ok(!audited.find((a) => a.resourceType === 'tc_case.od_sync_completed'));
});

// ── 3b. Review round 1 ──────────────────────────────────────────────────────

test('REVIEW: a re-link during the sweep wins — the old appointment\'s signal does not move the case', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const { caseId, handoffId } = seedCase(db);
  // Open Dental says the OLD appointment is Complete; meanwhile the desk links a new one.
  const odGet = async () => {
    handoffRow(db, handoffId).appt_num = 6001;
    return { ok: true, status: 200, data: apt({ AptStatus: 'Complete' }) };
  };
  const out = await engine.syncOffice({ office: 'roland', pool: db, trigger: 'nightly', odGet, audit: async () => {} });
  assert.equal(out.summary.raced, 1);
  assert.equal(caseRow(db, caseId).status, 'scheduled');
  assert.equal(caseRow(db, caseId).od_sync_action, null);
});

test('REVIEW: an audit write that fails rolls the change back, and the run says it failed', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const { caseId } = seedCase(db);
  await withOd({ roland: { 5001: apt({ AptStatus: 'Complete' }) } }, async () => {
    const audit = async (entries) => {
      if (entries.some((e) => e.action === 'UPDATE')) throw new Error('audit store down');
    };
    // The fake store has no real transactions: emulate ROLLBACK by snapshotting at BEGIN.
    const realConnect = db.connect.bind(db);
    db.connect = async () => {
      const c = await realConnect();
      let snap = null;
      return {
        release() {},
        query: async (sql, params) => {
          const t = String(sql).trim();
          if (t === 'BEGIN') snap = JSON.stringify([...db.tables]);
          if (t === 'ROLLBACK' && snap) db.tables = new Map(JSON.parse(snap));
          return c.query(sql, params);
        },
      };
    };
    await assert.rejects(engine.syncOffice({ office: 'roland', pool: db, trigger: 'nightly', audit }), /audit store down/);
  });
  assert.equal(caseRow(db, caseId).status, 'scheduled', 'no change stands without its audit row');
  assert.equal(caseRow(db, caseId).od_sync_action, null);
  assert.equal(db.table('tc_od_sync_runs')[0].status, 'failed');
  assert.equal(db.table('tc_od_sync_runs')[0].error_code, 'RUN_ERRORED');
});

test('REVIEW: a 200 that is not the appointment, or a 404 saying the key cannot reach /appointments, fails the office closed', async () => {
  switchOn('roland');
  for (const res of [
    { ok: true, status: 200, data: {} },
    { ok: true, status: 200, data: [] },
    { ok: true, status: 200, data: apt({ AptNum: 9999 }) },
    { ok: false, status: 404, data: null, error: "'appointments' is not a valid resource" },
  ]) {
    const db = new FakeTenantDb();
    const { caseId } = seedCase(db);
    const out = await engine.syncOffice({ office: 'roland', pool: db, trigger: 'nightly', odGet: async () => res, audit: async () => {} });
    assert.equal(out.status, 'failed', JSON.stringify(res));
    assert.equal(caseRow(db, caseId).od_sync_flag, null, 'not read as "gone from Open Dental"');
  }
});

test('REVIEW: switched off while the sweep is reading → nothing is applied', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const { caseId } = seedCase(db);
  const odGet = async () => {
    process.env.TC_OD_SYNC_ENABLED_ROLAND = 'false';
    return { ok: true, status: 200, data: apt({ AptStatus: 'Complete' }) };
  };
  const out = await engine.syncOffice({ office: 'roland', pool: db, trigger: 'nightly', odGet, audit: async () => {} });
  assert.equal(out.status, 'skipped');
  assert.equal(out.reason, 'SWITCH_OFF');
  assert.equal(caseRow(db, caseId).status, 'scheduled');
  assert.equal(db.table('tc_od_sync_runs')[0].error_code, 'SWITCHED_OFF');
});

test('REVIEW: an Undo whose audit write fails does not stand', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const { caseId } = seedCase(db);
  await withOd({ roland: { 5001: apt({ AptStatus: 'Complete' }) } }, async () => {
    await runEngine(db);
  });
  const before = JSON.stringify(caseRow(db, caseId));
  const realConnect = db.connect.bind(db);
  db.connect = async () => {
    const c = await realConnect();
    let snap = null;
    return {
      release() {},
      query: async (sql, params) => {
        const t = String(sql).trim();
        if (t === 'BEGIN') snap = JSON.stringify([...db.tables]);
        if (t === 'ROLLBACK' && snap) db.tables = new Map(JSON.parse(snap));
        return c.query(sql, params);
      },
    };
  };
  await assert.rejects(
    engine.undoChange(db, { office: 'roland', caseId, actor: 'tc@carein.ai', at: new Date().toISOString(), audit: async () => { throw new Error('audit store down'); } }),
    /audit store down/
  );
  assert.equal(caseRow(db, caseId).status, 'completed');
  assert.equal(JSON.stringify(caseRow(db, caseId)), before);
});

test('REVIEW: the undo hold is released once Open Dental shows another state', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const { caseId } = seedCase(db);
  await withOd({ roland: { 5001: apt({ AptStatus: 'Complete' }) } }, async () => {
    await runEngine(db);
    await engine.undoChange(db, { office: 'roland', caseId, actor: 'tc@carein.ai', at: new Date().toISOString() });
  });
  // OD goes back to Scheduled at the same time: a different state, the hold is released.
  await withOd({ roland: { 5001: apt({}) } }, async () => {
    await runEngine(db);
  });
  assert.equal(caseRow(db, caseId).od_sync_undone, null);
  // ...so a later Complete is a new signal.
  await withOd({ roland: { 5001: apt({ AptStatus: 'Complete' }) } }, async () => {
    const { out } = await runEngine(db);
    assert.equal(out.summary.completed, 1);
  });
});

// ── 4. Undo, and no redo until Open Dental changes ──────────────────────────

test('Undo a move: back to scheduled, audited with the prior state; the engine holds until OD changes', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const { caseId } = seedCase(db);
  const { baseUrl, close } = await bootTcApp({ db });
  try {
    await withOd({ roland: { 5001: apt({ AptStatus: 'Complete' }) } }, async () => {
      await runEngine(db);
      assert.equal(caseRow(db, caseId).status, 'completed');

      const undo = await api(baseUrl, 'POST', `/api/tc/od-sync/cases/${caseId}/undo?office=roland`);
      assert.equal(undo.status, 200, JSON.stringify(undo.body));
      assert.equal(undo.body.undone, 'completed');
      assert.equal(caseRow(db, caseId).status, 'scheduled');
      assert.equal(caseRow(db, caseId).od_sync_action, null, 'the badge is gone');
      const trail = auditRows(db).find((r) => r.resource_type === 'tc_case.od_sync_undo');
      assert.equal(trail.prior_state, 'completed');
      assert.equal(trail.user_id, 'tc@carein.ai');
      const ev = db.table('tc_case_events').filter((e) => e.case_id === caseId && e.type === 'status_change').pop();
      assert.match(ev.description, /^completed → scheduled: /);

      // Same Open Dental state → NOT redone.
      const again = await runEngine(db);
      assert.equal(again.out.summary.heldByUndo, 1);
      assert.equal(caseRow(db, caseId).status, 'scheduled');

      // A second Undo has nothing to undo.
      const twice = await api(baseUrl, 'POST', `/api/tc/od-sync/cases/${caseId}/undo?office=roland`);
      assert.equal(twice.status, 409);
      assert.equal(twice.body.code, 'OD_SYNC_NOTHING_TO_UNDO');
    });
    // Open Dental changes (now Broken) → a new signal, acted on.
    await withOd({ roland: { 5001: apt({ AptStatus: 'Broken' }) } }, async () => {
      const third = await runEngine(db);
      assert.equal(third.out.summary.unscheduled, 1);
      assert.equal(caseRow(db, caseId).status, 'pending_pt');
    });
  } finally {
    await close();
  }
});

test('Undo a reschedule restores the anchor time and is not redone; Undo after a human moved the case is refused', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const a = seedCase(db, { aptNum: 5001 });
  const b = seedCase(db, { aptNum: 5002 });
  const { baseUrl, close } = await bootTcApp({ db });
  try {
    await withOd(
      { roland: { 5001: apt({ AptDateTime: '2026-11-06 13:30:00' }), 5002: apt({ AptNum: 5002, AptStatus: 'Complete' }) } },
      async () => {
        await runEngine(db);
        const undo = await api(baseUrl, 'POST', `/api/tc/od-sync/cases/${a.caseId}/undo?office=roland`);
        assert.equal(undo.status, 200);
        assert.equal(handoffRow(db, a.handoffId).appt_at_local, '2026-11-04 09:00:00');
        const again = await runEngine(db);
        assert.equal(again.out.summary.rescheduled, 0, 'not redone');
        assert.equal(handoffRow(db, a.handoffId).appt_at_local, '2026-11-04 09:00:00');

        // A person moved b on after the sync did: the sync's move is not theirs to take back here.
        caseRow(db, b.caseId).status = 'lost';
        const stale = await api(baseUrl, 'POST', `/api/tc/od-sync/cases/${b.caseId}/undo?office=roland`);
        assert.equal(stale.status, 409);
        assert.equal(stale.body.code, 'OD_SYNC_UNDO_STALE');
        assert.equal(caseRow(db, b.caseId).status, 'lost');
      }
    );
  } finally {
    await close();
  }
});

// ── 5. Cap and throttle ─────────────────────────────────────────────────────

test('cap: 205 anchored cases → exactly 200 reads this run, each paced ≥ 1200 ms with a timeout; the rest next run', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const od = {};
  for (let i = 0; i < 205; i += 1) {
    seedCase(db, { aptNum: 10000 + i });
    od[10000 + i] = apt({ AptNum: 10000 + i });
  }
  await withOd({ roland: od }, async ({ calls }) => {
    const { out } = await runEngine(db);
    assert.equal(calls.length, 200, 'call count pinned');
    assert.equal(out.summary.checked, 200);
    assert.equal(out.summary.deferred, 5);
    for (const c of calls) {
      assert.ok(c.opts.minIntervalMs >= 1200, 'the shared OD pacer, never faster than the floor');
      assert.ok(c.opts.timeoutMs > 0);
      assert.equal(c.opts.module, 'tc');
    }
    // The next run starts with the five the first run did not reach.
    const firstRun = new Set(calls.map((c) => c.path));
    const notReached = Object.keys(od).map((n) => `/appointments/${n}`).filter((p) => !firstRun.has(p));
    assert.equal(notReached.length, 5);
    calls.length = 0;
    await runEngine(db);
    assert.deepEqual(new Set(calls.slice(0, 5).map((c) => c.path)), new Set(notReached));
  });
});

test('Sync now is rate-limited per office (429 with retryAfterSeconds), and the other office is not', async () => {
  switchOn('roland', 'valley');
  const db = new FakeTenantDb();
  seedCase(db);
  const { baseUrl, close } = await bootTcApp({ db });
  try {
    await withOd({ roland: { 5001: apt({}) } }, async () => {
      assert.equal((await syncNow(baseUrl)).status, 202);
      const again = await syncNow(baseUrl);
      assert.equal(again.status, 429);
      assert.equal(again.body.code, 'OD_SYNC_RATE_LIMITED');
      assert.ok(again.body.retryAfterSeconds > 0 && again.body.retryAfterSeconds <= 300);
      assert.equal((await syncNow(baseUrl, 'valley')).status, 202);
      const status = await api(baseUrl, 'GET', '/api/tc/od-sync/status?office=roland');
      assert.ok(status.body.nextAllowedAt);
    });
  } finally {
    await close();
  }
});

// ── 6. Office isolation ─────────────────────────────────────────────────────

test('office isolation: the same AptNum in the other office is never read or touched', async () => {
  switchOn('roland', 'valley');
  const db = new FakeTenantDb();
  const roland = seedCase(db, { aptNum: 5001 });
  const valley = seedCase(db, { office: 'valley', aptNum: 5001, patNum: 7115 });
  await withOd(
    { roland: { 5001: apt({ AptStatus: 'Complete' }) }, valley: { 5001: apt({ PatNum: 7115, AptStatus: 'Broken' }) } },
    async ({ calls }) => {
      await runEngine(db, 'roland');
      assert.deepEqual(calls.map((c) => c.office), ['roland']);
      assert.equal(caseRow(db, roland.caseId).status, 'completed');
      assert.equal(caseRow(db, valley.caseId).status, 'scheduled', "valley's case is not roland's to move");
      assert.equal(caseRow(db, valley.caseId).od_sync_checked_at, null);
    }
  );
});

// ── 7. Fail closed, per office ──────────────────────────────────────────────

test('fail closed: one failed read → the run is failed and NOTHING is applied, not even the reads that succeeded', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  // Read order is least-recently-checked, then case id: 5001, then 5002 (fails), then 5003.
  const first = seedCase(db, { aptNum: 5001, caseId: '00000000-0000-4000-8000-000000000001' });
  const second = seedCase(db, { aptNum: 5002, caseId: '00000000-0000-4000-8000-000000000002' });
  const third = seedCase(db, { aptNum: 5003, caseId: '00000000-0000-4000-8000-000000000003' });

  await withOd(
    { roland: { 5001: apt({ AptStatus: 'Complete' }), 5003: apt({ AptNum: 5003, AptStatus: 'Broken' }) } },
    async ({ calls }) => {
      const { out, audited } = await runEngine(db);
      assert.equal(out.status, 'failed');
      assert.equal(out.errorCode, 'OD_UNAVAILABLE');
      assert.equal(calls.length, 2, 'stops at the failure');
      // The successful read is on the trail; no change row is.
      assert.deepEqual(audited.map((a) => a.resourceType), ['od_appointment']);
    },
    { fail: { roland: 5002 } }
  );
  for (const s of [first, second, third]) {
    assert.equal(caseRow(db, s.caseId).status, 'scheduled');
    assert.equal(caseRow(db, s.caseId).od_sync_action, null);
    assert.equal(caseRow(db, s.caseId).od_sync_flag, null);
  }
  assert.equal(db.table('tc_od_sync_runs')[0].status, 'failed');
});

test('fail closed: an office that is not Open Dental-ready fails its run and touches nothing', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const s = seedCase(db);
  const saved = process.env[OD_KEY_ENV.roland];
  delete process.env[OD_KEY_ENV.roland];
  odOffices.resetOdOfficeCache();
  try {
    const { out } = await runEngine(db);
    assert.equal(out.status, 'failed');
    assert.equal(caseRow(db, s.caseId).status, 'scheduled');
  } finally {
    process.env[OD_KEY_ENV.roland] = saved;
    odOffices.resetOdOfficeCache();
  }
});

// ── 8. Unanchored, and the nightly path ─────────────────────────────────────

test('unanchored Scheduled cases are counted, never read, never guessed', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  seedCase(db, { anchored: false });
  seedCase(db, { anchored: false, name: 'Test, MangoTest' });
  seedCase(db, { aptNum: 5001 });
  const { baseUrl, close } = await bootTcApp({ db });
  try {
    await withOd({ roland: { 5001: apt({}) } }, async ({ calls }) => {
      const { out } = await runEngine(db);
      assert.equal(out.summary.unanchored, 2);
      assert.equal(calls.length, 1);
      const status = await api(baseUrl, 'GET', '/api/tc/od-sync/status?office=roland');
      assert.equal(status.body.unanchoredCount, 2);
    });
  } finally {
    await close();
  }
});

test('nightly: the scheduler runs the sweep for switched-on offices only, audited to the TC tenant', async () => {
  switchOn('roland');
  const db = new FakeTenantDb();
  const s = seedCase(db);
  const audited = [];
  const nightly = new TcOpportunitiesScheduler({
    registry: {
      listTenants: async () => [{ tenant_id: 'T1', slug: 'carein', status: 'active' }],
      getEnabledModules: async () => ['tc'],
    },
    tenantDb: { getTenantPool: async () => db },
    audit: { auditForTenant: async (req, tenantId, entry) => audited.push({ user: req.user.email, tenantId, ...entry }) },
  });
  await withOd({ roland: { 5001: apt({ AptStatus: 'Complete' }) } }, async ({ calls }) => {
    const pass = await nightly.runPipelineSync();
    assert.deepEqual(pass.offices.map((o) => [o.office, o.status]), [['roland', 'ok']]);
    assert.ok(calls.every((c) => c.office === 'roland'));
  });
  assert.equal(caseRow(db, s.caseId).status, 'completed');
  assert.equal(db.table('tc_od_sync_runs')[0].trigger, 'nightly');
  assert.ok(audited.find((a) => a.resourceType === 'tc_case.od_sync_completed' && a.tenantId === 'T1' && a.user === engine.SYNC_ACTOR));
});

// ── 9. GET only, by construction ────────────────────────────────────────────

test('the sync never reaches an Open Dental write: no client access, no write verb, in the engine or its routes', () => {
  for (const file of [path.join(__dirname, '../../services/tc/odPipelineSync.js'), path.join(__dirname, 'odSync.js')]) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!/\.client\b/.test(src), `${path.basename(file)} must not touch an Open Dental client`);
    assert.ok(
      !/(bookAppointment|updateAppointment|cancelAppointment|breakAppointment|createCommLog|apiPost|apiPut|apiDelete|apiPatch)/.test(src),
      `${path.basename(file)} must not name an Open Dental write method`
    );
  }
});
