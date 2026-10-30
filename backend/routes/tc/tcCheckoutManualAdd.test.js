'use strict';

/**
 * CO-5a — "Add patient" on the Checkout page: POST /api/tc/checkout/manual.
 *
 *   create     a card for the picked patient: source manual, Waiting, who added
 *              it, the name re-read from THIS office's Open Dental (a GET, the
 *              referrals hub's check), one CREATE audit row
 *   dedupe     one card per patient per day per office, server-side: a second
 *              add opens the first; two adds racing make one card (the partial
 *              unique index is the arbiter, emulated here — the fake has no
 *              indexes); an existing hygiene card is opened, not doubled; a
 *              dismissed card releases the day
 *   merge      a hygiene handoff for the same patient and day that arrives
 *              AFTER merges onto the manual card (same id, the visit's data,
 *              later revisions follow it); the CO-1 Inbox routing holds too
 *   workup     a manual card counts only referrals; the hygiene boxes refuse;
 *              referrals and the outcomes work; its case does not claim hygiene
 *   identity   tc.full only; the office is the request's; a body naming an
 *              office or a name is a 400 that never reaches Open Dental
 *   old rows   a record with no source reads as hygiene
 *
 * Test patients only (roland 12827, valley 7115); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const odOffices = require('../../config/odOffices');
const checkoutRoute = require('./checkout');
const checkoutStore = require('./checkoutStore');
const contract = require('../../tc/contract.gen.cjs');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

// 2026-10-30 10:00 in America/Chicago.
const NOW = new Date('2026-10-30T15:00:00.000Z');
const TODAY = '2026-10-30';

const OD_PATIENTS = {
  roland: {
    12827: { PatNum: 12827, LName: 'Test 2', FName: 'Stedi', Birthdate: '1980-01-01', PatStatus: 'Patient' },
    12828: { PatNum: 12828, LName: 'Test', FName: 'MangoTest', Birthdate: '1981-01-01', PatStatus: 'Patient' },
  },
  valley: {
    7115: { PatNum: 7115, LName: 'TestValley', FName: 'Stedi', Birthdate: '1985-02-02', PatStatus: 'Patient' },
  },
};

const savedEnv = {};
let odCalls = [];
let patched = [];

before(() => {
  for (const k of ['OPENDENTAL_CUSTOMER_KEY', 'OPENDENTAL_CUSTOMER_KEY_VALLEY', 'OPENDENTAL_ALLOW_MOCK']) savedEnv[k] = process.env[k];
  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-valley-customer-key';
  delete process.env.OPENDENTAL_ALLOW_MOCK;
  odOffices.resetOdOfficeCache();
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  odOffices.resetOdOfficeCache();
});

beforeEach(() => {
  odCalls = [];
  patched = [];
  for (const officeKey of ['roland', 'valley']) {
    const { client } = odOffices.getOdOffice(officeKey);
    patched.push({ client, original: client.apiGetRaw });
    client.apiGetRaw = async (path, params) => {
      odCalls.push({ office: officeKey, path, params });
      const m = /^\/patients\/(\d+)$/.exec(path);
      const row = m ? OD_PATIENTS[officeKey][m[1]] : null;
      return row ? { ok: true, status: 200, data: row } : { ok: false, status: 404, data: null };
    };
  }
});

afterEach(() => {
  for (const { client, original } of patched) client.apiGetRaw = original;
  patched = [];
});

function switchCheckout(t, byOffice = { roland: true, valley: true }) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' ? { key, value: byOffice, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  checkoutRoute.setClockForTests(() => NOW);
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
    checkoutRoute.setClockForTests(null);
  });
}

/**
 * The partial unique index the migration creates —
 * UNIQUE (office_id, od_patient_id, visit_date) WHERE source = 'manual' AND
 * status NOT IN ('dismissed','expired') — on the fake, which has none.
 * Returns the count of inserts it refused.
 */
function emulateManualIndex(db) {
  const refused = { count: 0 };
  db.onQuery(/^INSERT INTO tc_checkout_handoffs \(/, (text, params) => {
    const cols = text.match(/^INSERT INTO tc_checkout_handoffs \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
    const row = {};
    cols.forEach((c, i) => {
      row[c] = c === 'payload' && typeof params[i] === 'string' ? JSON.parse(params[i]) : params[i];
    });
    const holds = (r) => r.source === 'manual' && !['dismissed', 'expired'].includes(r.status);
    if (
      holds(row) &&
      db.table('tc_checkout_handoffs').some(
        (r) => holds(r) && r.office_id === row.office_id && r.od_patient_id === row.od_patient_id && r.visit_date === row.visit_date
      )
    ) {
      refused.count += 1;
      const err = new Error('duplicate key value violates unique constraint "tc_checkout_handoffs_manual_patient_day_key"');
      err.code = '23505';
      throw err;
    }
    row.created_at = new Date();
    row.updated_at = new Date();
    db.table('tc_checkout_handoffs').push(row);
    return { rows: [], rowCount: 1 };
  });
  return refused;
}

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const ADD = (office = 'roland') => `/api/tc/checkout/manual?office=${office}`;
const manualAudits = (db) => auditRows(db).filter((a) => a.source_ref === 'checkout_manual_add');

/** A hygiene checkout handoff, as the visit Send files it. */
function hygieneSubmit(over = {}) {
  return {
    kind: 'checkout',
    sourceKey: `hyg-visit:${randomUUID()}:checkout`,
    final: false,
    patientName: 'Test 2, Stedi',
    odPatientId: 12827,
    provider: 'DOC1',
    providerSeen: 'HYG1',
    operatory: 'Hyg 1',
    visitDate: TODAY,
    snapshot: {
      procedures: [
        { teeth: [3], code: 'Crown', category: 'Restorative', priority: 'urgent', status: 'proposed', surfaces: ['O'], scheduleNext: false, note: '' },
      ],
      priority: 'urgent',
      nextVisit: { type: 'Prophy', intervalMonths: 6, lengthMin: 60, withDoctor: false, rtc: '6 mo' },
      notesPending: true,
      frontDeskNote: '',
      financialNote: '',
      collectAtCheckout: ['Fl2'],
    },
    ...over,
  };
}

// ── create ──────────────────────────────────────────────────────────────────

test('Add patient: a manual, Waiting card for the picked patient, named from THIS office\'s OD, with its audit row', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const r = await api(baseUrl, 'POST', ADD(), { patNum: 12827 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  const h = contract.TcCheckoutHandoff.parse(r.body.handoff);
  assert.deepEqual(
    [h.source, h.status, h.officeId, h.odPatientId, h.patientName, h.visitDate, h.submittedBy, h.hygieneMergedAt],
    ['manual', 'open', 'roland', 12827, 'Test 2, Stedi', TODAY, 'tc@carein.ai', null]
  );
  assert.equal(contract.checkoutHasHygieneData(h), false);
  assert.deepEqual(h.snapshot, contract.emptyCheckoutSnapshot(), 'no fake hygiene data, only the empty snapshot');
  assert.deepEqual(odCalls.map((c) => [c.office, c.path]), [['roland', '/patients/12827']], "only roland's OD, only a GET");

  const [row] = db.table('tc_checkout_handoffs');
  assert.equal(row.source, 'manual');
  assert.equal(row.submitted_by, 'tc@carein.ai');
  assert.match(row.source_key, /^manual:[0-9a-f-]{36}$/);

  const audits = manualAudits(db);
  assert.deepEqual(
    audits.map((a) => [a.action, a.resource_type, a.resource_id]),
    [['CREATE', 'tc_checkout_handoff', h.handoffId]]
  );

  // It is on today's Waiting list like any other card.
  const list = await api(baseUrl, 'GET', '/api/tc/checkout?office=roland&view=waiting');
  assert.deepEqual(list.body.handoffs.map((x) => x.handoffId), [h.handoffId]);
});

// ── dedupe ──────────────────────────────────────────────────────────────────

test('dedupe: adding the same patient again opens the first card — one row, one audit row', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const first = await api(baseUrl, 'POST', ADD(), { patNum: 12827 });
  const again = await api(baseUrl, 'POST', ADD(), { patNum: 12827 });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.created, false);
  assert.equal(again.body.handoff.handoffId, first.body.handoff.handoffId);
  assert.equal(db.table('tc_checkout_handoffs').length, 1);
  assert.equal(manualAudits(db).length, 1);
});

test('dedupe under concurrency: two adds racing past the check make ONE card; the loser opens the winner', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const refused = emulateManualIndex(db);
  // Hold each transaction's "does a card exist?" read until BOTH requests have
  // made it, so both see none and both insert: the race the lock exists for,
  // forced here because the fake's lock is a no-op. Only the index decides.
  let waiting = 0;
  let release;
  const barrier = new Promise((r) => (release = r));
  db.onQuery(/FROM tc_checkout_handoffs WHERE office_id = \$1 AND od_patient_id = \$2 AND visit_date = \$3 AND status = ANY\(\$4\) ORDER BY/, async (text, params) => {
    waiting += 1;
    if (waiting === 2) release();
    if (waiting <= 2) await barrier;
    const rows = db
      .table('tc_checkout_handoffs')
      .filter((r) => r.office_id === params[0] && r.od_patient_id === params[1] && r.visit_date === params[2] && params[3].includes(r.status))
      .sort((a, b) => b.created_at - a.created_at);
    return { rows: rows.slice(0, 1).map((r) => ({ ...r })) };
  });

  const [a, b] = await Promise.all([
    api(baseUrl, 'POST', ADD(), { patNum: 12827 }),
    api(baseUrl, 'POST', ADD(), { patNum: 12827 }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.body, b.body]));
  assert.equal(a.body.handoff.handoffId, b.body.handoff.handoffId, 'both clicks land on the same card');
  assert.equal(refused.count, 1, 'the index refused the second insert');
  assert.equal(db.table('tc_checkout_handoffs').length, 1);
  assert.equal(manualAudits(db).length, 1, 'one card, one CREATE audit row');
});

test('dedupe: a hygiene card already holding the patient today is opened, not doubled', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const hyg = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', hygieneSubmit());
  assert.equal(hyg.status, 201, JSON.stringify(hyg.body));
  const r = await api(baseUrl, 'POST', ADD(), { patNum: 12827 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, false);
  assert.equal(r.body.handoff.handoffId, hyg.body.handoff.handoffId);
  assert.equal(r.body.handoff.source, 'hygiene');
  assert.equal(db.table('tc_checkout_handoffs').length, 1);
  assert.equal(manualAudits(db).length, 0);
});

test('dedupe: an ANSWERED card today still holds the patient; a DISMISSED one releases the day', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const first = (await api(baseUrl, 'POST', ADD(), { patNum: 12827 })).body.handoff;
  const done = await api(baseUrl, 'POST', `/api/tc/checkout/${first.handoffId}/outcome?office=roland`, { outcome: 'nothing_needed' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const reopen = await api(baseUrl, 'POST', ADD(), { patNum: 12827 });
  assert.equal(reopen.body.created, false);
  assert.equal(reopen.body.handoff.handoffId, first.handoffId);

  const other = (await api(baseUrl, 'POST', ADD(), { patNum: 12828 })).body.handoff;
  const dismissed = await api(baseUrl, 'POST', `/api/tc/checkout/${other.handoffId}/dismiss?office=roland`, { reason: 'Added by mistake' });
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
  const fresh = await api(baseUrl, 'POST', ADD(), { patNum: 12828 });
  assert.equal(fresh.status, 201);
  assert.notEqual(fresh.body.handoff.handoffId, other.handoffId);
  assert.equal(db.table('tc_checkout_handoffs').length, 3);
});

// ── merge on a later hygiene handoff ────────────────────────────────────────

test('merge: a hygiene handoff for the same patient and day, arriving AFTER, lands on the manual card', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  const manual = (await api(baseUrl, 'POST', ADD(), { patNum: 12827 })).body.handoff;
  const tick = await api(baseUrl, 'POST', `/api/tc/checkout/${manual.handoffId}/workup?office=roland`, { section: 'referrals', done: true });
  assert.equal(tick.status, 200, JSON.stringify(tick.body));

  const body = hygieneSubmit();
  const sent = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', body);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const merged = contract.TcCheckoutHandoff.parse(sent.body.handoff);
  assert.equal(merged.handoffId, manual.handoffId, 'the same card, not a second one');
  assert.equal(db.table('tc_checkout_handoffs').length, 1);
  assert.equal(merged.source, 'manual', 'it was still added by hand');
  assert.ok(merged.hygieneMergedAt, 'and now carries the visit');
  assert.equal(contract.checkoutHasHygieneData(merged), true);
  assert.deepEqual(merged.snapshot.procedures.map((p) => p.code), ['Crown']);
  assert.equal(merged.submittedBy, manual.submittedBy, 'who added it is kept');
  assert.ok(merged.workup.referrals, 'the desk\'s ticks are kept');
  assert.deepEqual(
    auditRows(db).filter((a) => a.source_ref === 'checkout_manual_merge').map((a) => [a.action, a.resource_id]),
    [['UPDATE', manual.handoffId]]
  );

  // The visit's later revisions follow the card by its key.
  const final = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', {
    ...body,
    final: true,
    snapshot: { ...body.snapshot, notesPending: false },
  });
  assert.equal(final.status, 200, JSON.stringify(final.body));
  assert.equal(final.body.handoff.handoffId, manual.handoffId);
  assert.equal(final.body.handoff.final, true);
  assert.equal(db.table('tc_checkout_handoffs').length, 1);

  // The progress count now covers the hygiene sections the visit brought.
  const progress = contract.checkoutWorkupProgress(final.body.handoff);
  assert.equal(progress.total, 3, 'work up, collect, referrals');

  // RULING (CO-5a fix): a card still Waiting merges exactly as before — it is
  // not "reopened", it was never answered.
  assert.equal(merged.status, 'open');
  assert.equal(merged.reopenedFrom, null);
  assert.equal(auditRows(db).filter((a) => a.source_ref === 'checkout_reopened_by_hygiene').length, 0);
});

// ── RULING (CO-5a fix): a visit arriving after the card was ANSWERED reopens it ──

for (const outcome of ['nothing_needed', 'not_scheduled', 'scheduled']) {
  test(`reopen: a manual card answered "${outcome}" goes back to Waiting when the visit arrives; the answer is kept as history and audited`, async (t) => {
    switchCheckout(t);
    const { baseUrl, db } = await boot(t, { role: 'tc' });
    const manual = (await api(baseUrl, 'POST', ADD(), { patNum: 12827 })).body.handoff;
    const tick = await api(baseUrl, 'POST', `/api/tc/checkout/${manual.handoffId}/workup?office=roland`, { section: 'referrals', done: true });
    assert.equal(tick.status, 200);
    const answered = await api(baseUrl, 'POST', `/api/tc/checkout/${manual.handoffId}/outcome?office=roland`, {
      outcome,
      appointmentNote: outcome === 'scheduled' ? 'Tue 9am' : '',
    });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    const before = answered.body.handoff;
    const casesBefore = db.table('tc_cases').map((c) => ({ ...c }));

    const sent = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', hygieneSubmit());
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const h = contract.TcCheckoutHandoff.parse(sent.body.handoff);
    assert.equal(h.handoffId, manual.handoffId, 'the same card');
    assert.equal(db.table('tc_checkout_handoffs').length, 1);

    // Back in Waiting, the answer cleared...
    assert.equal(h.status, 'open');
    assert.deepEqual([h.outcomeBy, h.outcomeAt, h.appointmentNote, h.caseId, h.claimedBy], [null, null, null, null, null]);
    // ...and kept, as history on the card.
    assert.deepEqual(
      { ...h.reopenedFrom, reopenedAt: undefined },
      {
        outcome,
        outcomeBy: 'tc@carein.ai',
        outcomeAt: before.outcomeAt,
        appointmentNote: before.appointmentNote,
        caseId: before.caseId,
        reopenedAt: undefined,
        // RULING (CO-4a): the history also carries the appointment anchor the
        // answer had; these answers were given without one.
        appointment: null,
      }
    );
    assert.ok(h.reopenedFrom.reopenedAt);
    assert.equal(contract.checkoutHasHygieneData(h), true);
    assert.ok(h.workup.referrals, 'the checklist keeps its ticks');

    // It is on the Waiting list again, and its checklist is editable again.
    const list = await api(baseUrl, 'GET', '/api/tc/checkout?office=roland&view=waiting');
    assert.deepEqual(list.body.handoffs.map((x) => x.handoffId), [manual.handoffId]);
    const retick = await api(baseUrl, 'POST', `/api/tc/checkout/${manual.handoffId}/workup?office=roland`, { section: 'collect', done: true });
    assert.equal(retick.status, 200, JSON.stringify(retick.body));

    // Its own audit event, the cleared answer as the prior state — besides the merge's.
    const reopenAudits = auditRows(db).filter((a) => a.source_ref === 'checkout_reopened_by_hygiene');
    assert.deepEqual(reopenAudits.map((a) => [a.action, a.resource_id, a.prior_state]), [['UPDATE', manual.handoffId, outcome]]);
    assert.equal(auditRows(db).filter((a) => a.source_ref === 'checkout_manual_merge').length, 1);

    // The case the answer made or moved is left exactly as it was.
    assert.deepEqual(db.table('tc_cases'), casesBefore);

    // And it can be answered again.
    const again = await api(baseUrl, 'POST', `/api/tc/checkout/${manual.handoffId}/outcome?office=roland`, { outcome: 'nothing_needed' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.handoff.reopenedFrom.outcome, outcome, 'the history survives the next answer');
  });
}

test('reopen: the store refuses to reopen a card that is not answered (Waiting, dismissed, expired)', async () => {
  for (const status of ['open', 'claimed', 'dismissed', 'expired']) {
    const calls = [];
    const q = { query: async (...a) => (calls.push(a), { rowCount: 1, rows: [] }) };
    const r = await checkoutStore.reopenAnswered(q, { office: 'roland', handoffId: randomUUID(), row: { status }, at: NOW.toISOString() });
    assert.equal(r, null, status);
    assert.equal(calls.length, 0, `${status}: nothing written`);
  }
});

test('merge: a hygiene handoff for ANOTHER patient, another day, or another office does not touch the manual card', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  const manual = (await api(baseUrl, 'POST', ADD(), { patNum: 12827 })).body.handoff;
  for (const [office, over] of [
    ['roland', { odPatientId: 12828, patientName: 'Test, MangoTest' }],
    ['roland', { visitDate: '2026-10-29' }],
    ['valley', { odPatientId: 12827 }],
  ]) {
    const r = await api(baseUrl, 'POST', `/api/tc/hygiene-intakes?office=${office}`, hygieneSubmit(over));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.notEqual(r.body.handoff.handoffId, manual.handoffId);
  }
  const row = db.table('tc_checkout_handoffs').find((x) => x.handoff_id === manual.handoffId);
  assert.equal(row.hygiene_merged_at ?? null, null);
  assert.deepEqual(row.payload, contract.emptyCheckoutSnapshot());
});

test('merge: a dismissed manual card does not take the visit — the visit makes its own card', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  const manual = (await api(baseUrl, 'POST', ADD(), { patNum: 12827 })).body.handoff;
  await api(baseUrl, 'POST', `/api/tc/checkout/${manual.handoffId}/dismiss?office=roland`, { reason: 'Wrong patient' });
  const r = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', hygieneSubmit());
  assert.equal(r.status, 201);
  assert.notEqual(r.body.handoff.handoffId, manual.handoffId);
  assert.equal(r.body.handoff.source, 'hygiene');
  assert.equal(db.table('tc_checkout_handoffs').length, 2);
});

test('CO-1 routing holds for a manual card: a same-day hygiene treatment intake is not an Inbox item', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  db.onQuery(/FROM tc_hygiene_intakes i\s+JOIN tc_cases c/i, (text, params) => {
    const cases = new Map(db.table('tc_cases').map((c) => [c.case_id, c]));
    const rows = db
      .table('tc_hygiene_intakes')
      .filter((i) => i.office_id === params[0] && cases.get(i.case_id).status === 'hygiene_review')
      .map((i) => ({ ...i, patient_name: cases.get(i.case_id).patient_name, od_patient_id: cases.get(i.case_id).od_patient_id, case_status: 'hygiene_review' }));
    return { rows };
  });
  await api(baseUrl, 'POST', ADD(), { patNum: 12827 });
  const intake = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', {
    diagnosingProvider: 'DOC1',
    category: 'single_tooth',
    urgency: 'medium',
    perioStatus: 'gingivitis',
    recallType: 'prophy',
    radiographs: ['BWX'],
    intraoralPhotosTaken: false,
    patientInterestLevel: 'warm',
    flagUrgent: false,
    chiefConcern: 'Staged at the hygiene visit',
    patientName: 'Test 2, Stedi',
    odPatientId: 12827,
    visitDate: TODAY,
  });
  assert.equal(intake.status, 201, JSON.stringify(intake.body));
  const inbox = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/inbox?office=roland');
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  assert.deepEqual(inbox.body.inbox, [], 'the manual card holds the patient, exactly as a hygiene card would');
});

// ── the workup on a card with no hygiene data ───────────────────────────────

test('workup: a manual card counts only referrals; the hygiene boxes refuse; the outcome\'s case does not claim hygiene', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const h = (await api(baseUrl, 'POST', ADD(), { patNum: 12827 })).body.handoff;
  assert.deepEqual(contract.checkoutWorkupProgress(h), {
    sections: [
      { section: 'workup', applies: false, done: false },
      { section: 'present', applies: false, done: false },
      { section: 'collect', applies: false, done: false },
      { section: 'referrals', applies: true, done: false },
    ],
    done: 0,
    total: 1,
  });
  for (const body of [{ section: 'workup', index: 0, done: true }, { section: 'collect', done: true }, { section: 'present', group: 'ready_to_schedule', done: true }]) {
    const r = await api(baseUrl, 'POST', `/api/tc/checkout/${h.handoffId}/workup?office=roland`, body);
    assert.ok(r.status >= 400 && r.status < 500, `${body.section}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const ref = await api(baseUrl, 'POST', `/api/tc/checkout/${h.handoffId}/workup?office=roland`, { section: 'referrals', done: true });
  assert.equal(ref.status, 200, JSON.stringify(ref.body));
  assert.equal(contract.checkoutWorkupProgressLabel(contract.checkoutWorkupProgress(ref.body.handoff)), '1 of 1 section done');

  const out = await api(baseUrl, 'POST', `/api/tc/checkout/${h.handoffId}/outcome?office=roland`, { outcome: 'not_scheduled' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const [c] = db.table('tc_cases');
  assert.equal(c.referral_source, 'other', 'a hand-added checkout is not a hygiene referral');
  assert.equal(db.table('tc_case_phases').length, 0, 'nothing staged, no phase');
});

// ── identity ────────────────────────────────────────────────────────────────

test('role gate: tc.full only — a hygienist is refused before Open Dental is asked, and nothing is stored', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  const r = await api(baseUrl, 'POST', ADD(), { patNum: 12827 });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.deepEqual(odCalls, []);
  assert.equal(db.table('tc_checkout_handoffs').length, 0);
  assert.equal(manualAudits(db).length, 0);
});

test('office isolation: the card, the OD read and the dedupe all belong to the request\'s office', async (t) => {
  switchCheckout(t);
  const { baseUrl } = await boot(t, { role: 'tc' });
  const v = await api(baseUrl, 'POST', ADD('valley'), { patNum: 7115 });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.deepEqual([v.body.handoff.officeId, v.body.handoff.patientName], ['valley', 'TestValley, Stedi']);
  assert.deepEqual(odCalls.map((c) => [c.office, c.path]), [['valley', '/patients/7115']]);

  // Roland's Open Dental is a different database: PatNum 7115 there is not ours to open.
  odCalls = [];
  const r = await api(baseUrl, 'POST', ADD('roland'), { patNum: 7115 });
  assert.equal(r.status, 404, JSON.stringify(r.body));
  assert.equal(r.body.code, 'PATIENT_NOT_FOUND');
  assert.deepEqual(odCalls.map((c) => c.office), ['roland']);

  // Roland's list and Roland's id lookup never see Valley's card.
  const list = await api(baseUrl, 'GET', '/api/tc/checkout?office=roland&view=waiting');
  assert.deepEqual(list.body.handoffs, []);
  const cross = await api(baseUrl, 'GET', `/api/tc/checkout/${v.body.handoff.handoffId}?office=roland`);
  assert.equal(cross.status, 404);

  // The same patient in Valley again is Valley's own dedupe.
  const again = await api(baseUrl, 'POST', ADD('valley'), { patNum: 7115 });
  assert.equal(again.body.created, false);
});

test('strict body: an office, a name, or a day in the body is a 400 that never reaches Open Dental', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  for (const body of [{ patNum: 12827, office: 'valley' }, { patNum: 12827, patientName: 'Someone' }, { patNum: 12827, visitDate: '2026-10-01' }, {}, { patNum: 0 }]) {
    const r = await api(baseUrl, 'POST', ADD(), body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(odCalls, []);
  assert.equal(db.table('tc_checkout_handoffs').length, 0);
});

test('honest refusals: checkout off (403), a patient not in this OD (404) — nothing stored, no audit', async (t) => {
  switchCheckout(t, { roland: false, valley: true });
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const off = await api(baseUrl, 'POST', ADD(), { patNum: 12827 });
  assert.equal(off.status, 403);
  assert.equal(off.body.code, 'CHECKOUT_DISABLED');
  assert.deepEqual(odCalls, []);
  const missing = await api(baseUrl, 'POST', ADD('valley'), { patNum: 99999 });
  assert.equal(missing.status, 404);
  assert.equal(db.table('tc_checkout_handoffs').length, 0);
  assert.equal(manualAudits(db).length, 0);
});

// ── old rows ────────────────────────────────────────────────────────────────

test('old records: a row with no source (every row before CO-5a) reads as a hygiene card with its data', () => {
  const row = {
    handoff_id: randomUUID(),
    office_id: 'roland',
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    visit_date: TODAY,
    payload: contract.emptyCheckoutSnapshot(),
    is_final: true,
    revision: 1,
    submitted_by: 'hygienist@carein.ai',
    created_at: NOW,
    updated_at: NOW,
    status: 'open',
  };
  const h = contract.TcCheckoutHandoff.parse(checkoutStore.toHandoff(row));
  assert.deepEqual([h.source, h.hygieneMergedAt, contract.checkoutHasHygieneData(h)], ['hygiene', null, true]);
  // And the contract defaults a reader that predates the fields the same way.
  const { source, hygieneMergedAt, ...legacy } = h;
  assert.deepEqual(
    [contract.TcCheckoutHandoff.parse(legacy).source, contract.TcCheckoutHandoff.parse(legacy).hygieneMergedAt],
    ['hygiene', null]
  );
  assert.ok(source && hygieneMergedAt === null);
});
