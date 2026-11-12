'use strict';

/**
 * CO-6 — "Route to…" from a checkout card (POST /api/tc/checkout/:id/route).
 *
 *   preauth   a pre-auth from the CARD's patient, PatNum and doctor (never the
 *             body's), its `created` history row, linked to the patient's open
 *             case when there is one (note_added on it, card linked) and to no
 *             case when there is none; the card stays Waiting
 *   pipeline  the open case (or a new pending_tc one) moved by the shared status
 *             transition: status_change in the funnel's format, F1 ownership,
 *             same status = a note; no terminal status offered
 *   followup  a pending tc_followups row on the case + a note_added; due date
 *             and talking point required
 *   inbox     a new unowned hygiene_review case WITH its intake, or the same
 *             visit's hygiene_review case; the card closes Dismissed with the
 *             Inbox reason; an open case already on the Pipeline is a 409 that
 *             writes nothing
 *   identity  another office's card is a 404 that writes nothing; a body naming
 *             a patient or an office is a 400; an answered card is a 409
 *   vocab     every event row is an existing type
 *
 * Test patients only (roland 12827, valley 7115); names synthetic. No Open
 * Dental client exists in this harness.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const checkoutRoute = require('./checkout');
const contract = require('../../tc/contract.gen.cjs');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-11-11T16:00:00.000Z'); // 10:00 America/Chicago
const TODAY = '2026-11-11';

const PROC = {
  teeth: [3],
  code: 'Crown',
  category: 'Restorative',
  priority: 'urgent',
  status: 'proposed',
  surfaces: ['O'],
  scheduleNext: true,
  note: '',
};

const SNAPSHOT = {
  procedures: [PROC],
  priority: 'urgent',
  nextVisit: { type: 'Prophy', intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: '6 mo' },
  notesPending: false,
  frontDeskNote: 'Wants afternoons',
  financialNote: '',
  collectAtCheckout: ['Fl2'],
};

function switchCheckout(t) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' ? { key, value: { roland: true, valley: true }, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  checkoutRoute.setClockForTests(() => NOW);
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
    checkoutRoute.setClockForTests(null);
  });
}

async function boot(t) {
  switchCheckout(t);
  const app = await bootTcApp();
  t.after(() => app.close());
  return app;
}

function seedCard(db, over = {}) {
  const row = {
    handoff_id: randomUUID(),
    office_id: 'roland',
    source_key: `hyg-visit:${randomUUID()}:checkout`,
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    provider: 'DOC1',
    provider_seen: 'HYG1',
    operatory: 'Hyg 1',
    visit_date: TODAY,
    payload: SNAPSHOT,
    is_final: true,
    revision: 1,
    submitted_by: 'hygienist@carein.ai',
    updated_by: 'hygienist@carein.ai',
    status: 'open',
    case_id: null,
    created_at: new Date(NOW.getTime() - 60000),
    updated_at: new Date(NOW.getTime() - 60000),
    ...over,
  };
  db.table('tc_checkout_handoffs').push(row);
  return row;
}

function seedCase(db, over = {}) {
  const row = {
    case_id: randomUUID(),
    office_id: 'roland',
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    status: 'pending_tc',
    assigned_tc: 'owner@carein.ai',
    nurture_enrolled_at: null,
    created_at: new Date(NOW.getTime() - 86400000),
    updated_at: new Date(NOW.getTime() - 86400000),
    ...over,
  };
  db.table('tc_cases').push(row);
  return row;
}

const route = (baseUrl, id, body, office = 'roland') => api(baseUrl, 'POST', `/api/tc/checkout/${id}/route?office=${office}`, body);

const card = (db, id) => db.table('tc_checkout_handoffs').find((r) => r.handoff_id === id);
const eventsFor = (db, caseId) => db.table('tc_case_events').filter((e) => e.case_id === caseId);

/** Every event the store holds is one of the contract's existing types. */
function assertExistingEventTypes(db) {
  const known = new Set(contract.CaseEventType.options);
  for (const e of db.table('tc_case_events')) assert.ok(known.has(e.type), `unknown event type ${e.type}`);
  for (const e of db.table('tc_preauth_events')) assert.ok(contract.PreauthEventType.options.includes(e.type));
}

// ── Pre-auth ────────────────────────────────────────────────────────────────

test('preauth with no case: the card patient, PatNum and doctor; prefilled; no case; card stays Waiting', async (t) => {
  const app = await boot(t);
  const c = seedCard(app.db);

  const res = await route(app.baseUrl, c.handoff_id, { destination: 'preauth', insuranceCarrier: 'Synthetic Dental' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.destination, 'preauth');
  assert.equal(res.body.caseId, null);
  assert.equal(res.body.resolved, false);
  assert.equal(res.body.handoff.status, 'open');

  const [pa] = app.db.table('tc_preauth_cases');
  assert.equal(pa.preauth_id, res.body.preauthId);
  assert.equal(pa.office_id, 'roland');
  assert.equal(Number(pa.od_patient_id), 12827);
  assert.equal(pa.patient_name, 'Test 2, Stedi');
  assert.equal(pa.doctor_name, 'DOC1');
  assert.equal(pa.status, 'pending');
  assert.equal(pa.case_id, null);
  assert.equal(pa.insurance_carrier, 'Synthetic Dental');
  assert.match(pa.description, /Crown \(urgent\)/);
  const hist = app.db.table('tc_preauth_events').filter((e) => e.preauth_id === pa.preauth_id);
  assert.deepEqual(hist.map((e) => e.type), ['created']);
  assert.equal(app.db.table('tc_cases').length, 0);
  assert.equal(card(app.db, c.handoff_id).case_id, null);

  const rows = auditRows(app.db);
  assert.ok(rows.some((r) => r.resource_type === 'tc_preauth' && r.action === 'CREATE' && r.resource_id === pa.preauth_id));
  assert.ok(
    rows.some((r) => r.resource_type === 'tc_checkout_handoff' && r.source_ref === 'checkout_route:preauth' && r.prior_state === 'open')
  );
  assertExistingEventTypes(app.db);
});

test("preauth with the patient's open case: linked to it, a note on it, and the card points at it", async (t) => {
  const app = await boot(t);
  const open = seedCase(app.db, { status: 'presented' });
  const c = seedCard(app.db);

  const res = await route(app.baseUrl, c.handoff_id, { destination: 'preauth', preauthType: 'perio' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.caseId, open.case_id);
  assert.equal(res.body.attached, true);
  const [pa] = app.db.table('tc_preauth_cases');
  assert.equal(pa.case_id, open.case_id);
  assert.equal(pa.preauth_type, 'perio');
  const notes = eventsFor(app.db, open.case_id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, 'note_added');
  assert.match(notes[0].description, /^From checkout: a perio pre-authorization was created/);
  assert.equal(card(app.db, c.handoff_id).case_id, open.case_id);
  assert.equal(res.body.handoff.caseId, open.case_id);
  assert.equal(res.body.handoff.status, 'open');
});

test('preauth: the body cannot name the patient, the PatNum or the office (strict → 400, nothing written)', async (t) => {
  const app = await boot(t);
  const c = seedCard(app.db);
  for (const extra of [{ odPatientId: 7115 }, { patientName: 'Someone Else' }, { office: 'valley' }, { caseId: randomUUID() }]) {
    const res = await route(app.baseUrl, c.handoff_id, { destination: 'preauth', ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra));
  }
  assert.equal(app.db.table('tc_preauth_cases').length, 0);
});

// ── Pipeline ────────────────────────────────────────────────────────────────

test('pipeline with no case: a pending_tc case created, then moved by the status transition; card linked, Waiting', async (t) => {
  const app = await boot(t);
  const c = seedCard(app.db);

  const res = await route(app.baseUrl, c.handoff_id, { destination: 'pipeline', status: 'presented', note: 'Reviewed at desk' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.attached, false);
  assert.equal(res.body.statusChanged, true);
  const [cs] = app.db.table('tc_cases');
  assert.equal(cs.case_id, res.body.caseId);
  assert.equal(cs.status, 'presented');
  assert.equal(Number(cs.od_patient_id), 12827);
  assert.equal(cs.assigned_tc, 'tc@carein.ai');
  const types = eventsFor(app.db, cs.case_id).map((e) => [e.type, e.description]);
  assert.deepEqual(types[0], ['case_created', 'Case created at checkout (routed to the Pipeline)']);
  assert.deepEqual(types[1], ['status_change', 'pending_tc → presented: Routed from checkout: Reviewed at desk']);
  assert.equal(card(app.db, c.handoff_id).case_id, cs.case_id);
  assert.equal(card(app.db, c.handoff_id).status, 'open');
  assert.ok(auditRows(app.db).some((r) => r.resource_type === 'tc_case' && r.action === 'CREATE' && r.resource_id === cs.case_id));
  assertExistingEventTypes(app.db);
});

test("pipeline attaches to the same visit's unowned hygiene_review case: moves it and assigns it (F1)", async (t) => {
  const app = await boot(t);
  const hyg = seedCase(app.db, { status: 'hygiene_review', assigned_tc: '' });
  const c = seedCard(app.db);

  const res = await route(app.baseUrl, c.handoff_id, { destination: 'pipeline', status: 'pending_tc' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.caseId, hyg.case_id);
  assert.equal(res.body.attached, true);
  assert.equal(hyg.status, 'pending_tc');
  assert.equal(hyg.assigned_tc, 'tc@carein.ai');
  const evs = eventsFor(app.db, hyg.case_id);
  assert.deepEqual(evs.map((e) => e.type), ['status_change', 'note_added']);
  assert.equal(evs[0].description, 'hygiene_review → pending_tc: Routed from checkout');
  assert.match(evs[1].description, /assigned to the person who routed it/);
  assert.equal(app.db.table('tc_cases').length, 1, 'never a second case');
});

test('pipeline to the status the case already has: no move, a note_added, statusChanged false', async (t) => {
  const app = await boot(t);
  const open = seedCase(app.db, { status: 'considering' });
  const c = seedCard(app.db);
  const res = await route(app.baseUrl, c.handoff_id, { destination: 'pipeline', status: 'considering' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.statusChanged, false);
  assert.equal(open.status, 'considering');
  assert.equal(open.assigned_tc, 'owner@carein.ai', 'an owned case keeps its owner');
  assert.deepEqual(eventsFor(app.db, open.case_id).map((e) => [e.type, e.description]), [['note_added', 'Routed from checkout']]);
});

test('pipeline never offers a terminal status or hygiene_review (no new vocabulary, no closing by routing)', async (t) => {
  const app = await boot(t);
  const c = seedCard(app.db);
  for (const status of ['scheduled', 'lost', 'completed', 'accepted', 'hygiene_review', 'made_up']) {
    const res = await route(app.baseUrl, c.handoff_id, { destination: 'pipeline', status });
    assert.equal(res.status, 400, status);
  }
  assert.equal(app.db.table('tc_cases').length, 0);
});

// ── Follow-up ───────────────────────────────────────────────────────────────

test('followup: a pending follow-up on the open case and a note_added; due date + talking point required', async (t) => {
  const app = await boot(t);
  const open = seedCase(app.db, { status: 'pending_pt' });
  const c = seedCard(app.db);

  assert.equal((await route(app.baseUrl, c.handoff_id, { destination: 'followup', talkingPoint: 'Call about crown' })).status, 400);
  assert.equal((await route(app.baseUrl, c.handoff_id, { destination: 'followup', dueDate: '2026-11-20', talkingPoint: '   ' })).status, 400);
  assert.equal(app.db.table('tc_followups').length, 0);

  const res = await route(app.baseUrl, c.handoff_id, {
    destination: 'followup',
    dueDate: '2026-11-20',
    talkingPoint: 'Call about crown',
    channel: 'text',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [f] = app.db.table('tc_followups');
  assert.equal(f.followup_id, res.body.followupId);
  assert.equal(f.case_id, open.case_id);
  assert.equal(f.office_id, 'roland');
  assert.equal(f.kind, 'followup');
  assert.equal(f.status, 'pending');
  assert.equal(f.due_date, '2026-11-20');
  assert.equal(f.channel, 'text');
  assert.equal(f.talking_point, 'Call about crown');
  assert.equal(f.source, 'manual');
  const [ev] = eventsFor(app.db, open.case_id);
  assert.equal(ev.type, 'note_added');
  assert.equal(ev.description, 'From checkout: follow-up due 2026-11-20 (text): Call about crown');
  assert.equal(card(app.db, c.handoff_id).case_id, open.case_id);
  assert.equal(card(app.db, c.handoff_id).status, 'open');
  assert.ok(auditRows(app.db).some((r) => r.resource_type === 'tc_followup' && r.action === 'CREATE'));
});

test('followup with no case opens one (pending_tc, the router owns it)', async (t) => {
  const app = await boot(t);
  const c = seedCard(app.db);
  const res = await route(app.baseUrl, c.handoff_id, { destination: 'followup', dueDate: '2026-11-20', talkingPoint: 'Check in' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [cs] = app.db.table('tc_cases');
  assert.equal(cs.status, 'pending_tc');
  assert.equal(cs.assigned_tc, 'tc@carein.ai');
  assert.equal(app.db.table('tc_followups')[0].case_id, cs.case_id);
  assert.deepEqual(eventsFor(app.db, cs.case_id).map((e) => e.type), ['case_created', 'note_added']);
});

// ── TC Inbox ────────────────────────────────────────────────────────────────

test('inbox with no case: an UNOWNED hygiene_review case with its intake; the card closes Dismissed', async (t) => {
  const app = await boot(t);
  const c = seedCard(app.db);

  const res = await route(app.baseUrl, c.handoff_id, { destination: 'inbox', note: 'Doctor wants TC to call' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.resolved, true);
  const [cs] = app.db.table('tc_cases');
  assert.equal(cs.status, 'hygiene_review');
  assert.equal(cs.assigned_tc, '');
  assert.equal(Number(cs.od_patient_id), 12827);
  const [intake] = app.db.table('tc_hygiene_intakes');
  assert.equal(intake.case_id, cs.case_id);
  assert.equal(intake.office_id, 'roland');
  assert.equal(intake.submitted_by, 'tc@carein.ai');
  assert.equal(intake.hygienist_name, 'HYG1', 'who did the visit is the card\'s hygiene provider, not the desk user');
  assert.match(intake.suspected_treatment, /Crown/);
  assert.equal(intake.flag_urgent, true);

  const now = card(app.db, c.handoff_id);
  assert.equal(now.status, 'dismissed');
  assert.equal(now.case_id, cs.case_id);
  assert.equal(now.dismissed_reason, `${contract.CHECKOUT_INBOX_DISMISS_REASON}: Doctor wants TC to call`);
  assert.equal(res.body.handoff.status, 'dismissed');
  // A dismissed card is one that hands a same-day intake back to the Inbox (CO-1).
  const claimed = require('./checkoutStore').claimedBySameDayCheckout(
    [{ od_patient_id: 12827, day: TODAY }],
    [{ od_patient_id: 12827, visit_date: TODAY, status: now.status }]
  );
  assert.deepEqual(claimed, [false]);
  assertExistingEventTypes(app.db);
});

test("inbox with the same visit's hygiene_review case: no second case, a note on it, the card closes", async (t) => {
  const app = await boot(t);
  const hyg = seedCase(app.db, { status: 'hygiene_review', assigned_tc: '' });
  app.db.table('tc_hygiene_intakes').push({ intake_id: randomUUID(), case_id: hyg.case_id, office_id: 'roland' });
  const c = seedCard(app.db);

  const res = await route(app.baseUrl, c.handoff_id, { destination: 'inbox' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.caseId, hyg.case_id);
  assert.equal(app.db.table('tc_cases').length, 1);
  assert.equal(hyg.status, 'hygiene_review');
  assert.equal(hyg.assigned_tc, '', 'still unowned: it is for a coordinator to claim');
  assert.deepEqual(eventsFor(app.db, hyg.case_id).map((e) => [e.type, e.description]), [['note_added', 'From checkout: sent to the TC Inbox']]);
  assert.equal(card(app.db, c.handoff_id).status, 'dismissed');
});

test('inbox when the patient already has a case on the Pipeline: 409, nothing written, the card still Waiting', async (t) => {
  const app = await boot(t);
  const open = seedCase(app.db, { status: 'presented' });
  const c = seedCard(app.db);
  const res = await route(app.baseUrl, c.handoff_id, { destination: 'inbox' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CASE_ALREADY_ON_PIPELINE');
  assert.equal(res.body.caseId, open.case_id);
  assert.equal(card(app.db, c.handoff_id).status, 'open');
  assert.equal(card(app.db, c.handoff_id).case_id, null);
  assert.equal(app.db.table('tc_case_events').length, 0);
  assert.equal(app.db.table('tc_cases').length, 1);
});

// ── Identity, state ─────────────────────────────────────────────────────────

test("another office's card is a 404 that writes nothing, for every destination", async (t) => {
  const app = await boot(t);
  const valley = seedCard(app.db, { office_id: 'valley', od_patient_id: 7115, patient_name: 'Stedi TestValley' });
  const bodies = [
    { destination: 'preauth' },
    { destination: 'pipeline', status: 'presented' },
    { destination: 'followup', dueDate: '2026-11-20', talkingPoint: 'x' },
    { destination: 'inbox' },
  ];
  for (const body of bodies) {
    const res = await route(app.baseUrl, valley.handoff_id, body, 'roland');
    assert.equal(res.status, 404, body.destination);
  }
  for (const table of ['tc_cases', 'tc_preauth_cases', 'tc_followups', 'tc_case_events', 'tc_hygiene_intakes']) {
    assert.equal(app.db.table(table).length, 0, table);
  }
  assert.equal(valley.status, 'open');
});

test('an answered card cannot be routed (409); a bad id is a 400', async (t) => {
  const app = await boot(t);
  const c = seedCard(app.db, { status: 'not_scheduled' });
  const res = await route(app.baseUrl, c.handoff_id, { destination: 'pipeline', status: 'presented' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CHECKOUT_NOT_ACTIONABLE');
  assert.equal(app.db.table('tc_cases').length, 0);
  assert.equal((await route(app.baseUrl, 'nope', { destination: 'inbox' })).status, 400);
  assert.equal((await route(app.baseUrl, c.handoff_id, { destination: 'somewhere' })).status, 400);
});

test('valley routes in valley: the case is valley PatNum 7115 — never roland 7115', async (t) => {
  const app = await boot(t);
  seedCase(app.db, { office_id: 'roland', od_patient_id: 7115, status: 'presented' }); // a different, real person in Roland
  const c = seedCard(app.db, { office_id: 'valley', od_patient_id: 7115, patient_name: 'Stedi TestValley' });
  const res = await route(app.baseUrl, c.handoff_id, { destination: 'pipeline', status: 'presented' }, 'valley');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const made = app.db.table('tc_cases').find((x) => x.case_id === res.body.caseId);
  assert.equal(made.office_id, 'valley');
  assert.equal(res.body.attached, false, 'the roland case is not this patient');
});
