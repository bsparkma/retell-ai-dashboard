'use strict';

/**
 * Pre-IA fix F1 (docs/reports/feature-tc-incoming-work-ia.md §4 O2, §7):
 * no case is ever left ownerless by a checkout outcome.
 *
 * "Scheduled" / "Not scheduled" attach to the patient's open case — usually
 * the same visit's UNCLAIMED hygiene_review case — and move it out of the TC
 * Inbox. Before F1 the move set `status` only, so the case landed on the
 * board with nobody on it. Now the person who answered the checkout becomes
 * its owner; an owned case keeps its owner.
 *
 * Fixture: the Roland test patient (PatNum 12827, "Test 2, Stedi").
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const checkoutRoute = require('./checkout');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-09-08T15:00:00.000Z');
const TODAY = '2026-09-08';
const ANSWERER = 'frontdesk@carein.ai';

const SNAPSHOT = {
  procedures: [],
  priority: 'urgent',
  nextVisit: { type: 'Prophy', intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: '6 mo' },
  notesPending: false,
  frontDeskNote: '',
  financialNote: '',
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

async function boot(t, opts = {}) {
  const app = await bootTcApp({ user: { email: ANSWERER, name: 'Front Desk', tenantId: 'x' }, role: 'office', ...opts });
  t.after(() => app.close());
  return app;
}

let seq = 0;
function seedHandoff(db, over = {}) {
  seq += 1;
  const row = {
    handoff_id: randomUUID(),
    office_id: 'roland',
    source_key: `hyg-visit:owner-${seq}:checkout`,
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
    created_at: new Date(NOW.getTime() - 60000),
    updated_at: new Date(NOW.getTime() - 60000),
    ...over,
  };
  db.table('tc_checkout_handoffs').push(row);
  return row;
}

/** The same visit's treatment handoff, still in the TC Inbox: hygiene_review, nobody on it. */
function seedInboxCase(db, over = {}) {
  const row = {
    case_id: randomUUID(),
    legacy_id: null,
    office_id: 'roland',
    patient_name: 'Test 2, Stedi',
    patient_age: null,
    phone: null,
    email: null,
    od_patient_id: 12827,
    case_type: '',
    category: 'single_tooth',
    status: 'hygiene_review',
    urgency: 'medium',
    doctor_name: '',
    diagnosing_provider: null,
    assigned_tc: '',
    case_value_cents: 0,
    readiness_score: 0,
    financing_status: '',
    preferred_financing_provider: null,
    decision_makers: '',
    financial_situation: [],
    key_motivators: [],
    contact_preference: null,
    best_time_to_reach: '',
    notes: '',
    referral_source: 'hygiene',
    lost_reason: null,
    diagnosed_date: null,
    status_changed_at: new Date(NOW.getTime() - 3600000),
    nurture_cadence: 'standard',
    in_long_tail_mode: false,
    nurture_enrolled_at: null,
    nurture_phase_changed_at: null,
    nurture_phase1_days_override: null,
    nurture_phase2_days_override: null,
    nurture_unsubscribed: false,
    created_at: new Date(NOW.getTime() - 3600000),
    updated_at: new Date(NOW.getTime() - 3600000),
    ...over,
  };
  db.table('tc_cases').push(row);
  return row;
}

const OUTCOME = (id) => `/api/tc/checkout/${id}/outcome?office=roland`;
const caseRow = (db, id) => db.table('tc_cases').find((c) => c.case_id === id);
const assignNotes = (db, id) =>
  db.table('tc_case_events').filter((e) => e.case_id === id && /^Checkout: assigned to/.test(e.description));

for (const [outcome, to] of [
  ['scheduled', 'scheduled'],
  ['not_scheduled', 'pending_pt'],
]) {
  test(`F1: ${outcome} on an UNCLAIMED hygiene_review case assigns it to the person who answered`, async (t) => {
    switchCheckout(t);
    const { baseUrl, db } = await boot(t);
    const c = seedInboxCase(db);
    const h = seedHandoff(db);

    const r = await api(baseUrl, 'POST', OUTCOME(h.handoff_id), { outcome });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.attached, true);
    assert.equal(r.body.caseId, c.case_id);
    assert.equal(db.table('tc_cases').length, 1, 'no second case');

    const after = caseRow(db, c.case_id);
    assert.equal(after.status, to, 'left the Inbox');
    assert.equal(after.assigned_tc, ANSWERER, 'and has an owner: whoever answered');

    const notes = assignNotes(db, c.case_id);
    assert.equal(notes.length, 1, 'the assignment is on the timeline, once');
    assert.equal(notes[0].actor, ANSWERER);
    assert.equal(notes[0].type, 'note_added');
    // The funnel's status_change stays in its exact `from → to` format.
    const change = db.table('tc_case_events').find((e) => e.case_id === c.case_id && e.type === 'status_change');
    assert.match(change.description, new RegExp(`^hygiene_review → ${to}: `));
    assert.ok(auditRows(db).some((a) => a.resource_type === 'tc_case' && a.action === 'UPDATE' && a.resource_id === c.case_id));
  });
}

test('F1: a case that already has an owner keeps it, and gets no assignment note', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const c = seedInboxCase(db, { status: 'pending_tc', assigned_tc: 'coordinator@carein.ai' });
  const h = seedHandoff(db);

  const r = await api(baseUrl, 'POST', OUTCOME(h.handoff_id), { outcome: 'scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(caseRow(db, c.case_id).assigned_tc, 'coordinator@carein.ai');
  assert.equal(assignNotes(db, c.case_id).length, 0);
});

test('F1: an unowned case outside the Inbox (e.g. considering) gets an owner too — no case is left ownerless', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const c = seedInboxCase(db, { status: 'considering' });
  const h = seedHandoff(db);

  const r = await api(baseUrl, 'POST', OUTCOME(h.handoff_id), { outcome: 'not_scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = caseRow(db, c.case_id);
  assert.equal(after.status, 'considering', 'not moved backwards');
  assert.equal(after.assigned_tc, ANSWERER);
});

test('F1: a case CREATED at checkout is owned by the answerer (unchanged)', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const h = seedHandoff(db);
  const r = await api(baseUrl, 'POST', OUTCOME(h.handoff_id), { outcome: 'scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attached, false);
  assert.equal(caseRow(db, r.body.caseId).assigned_tc, ANSWERER);
});

test('F1: Nothing needed touches no case, so it assigns nothing', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const c = seedInboxCase(db);
  const h = seedHandoff(db);
  const r = await api(baseUrl, 'POST', OUTCOME(h.handoff_id), { outcome: 'nothing_needed' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = caseRow(db, c.case_id);
  assert.equal(after.status, 'hygiene_review', 'still in the Inbox for a TC to claim');
  assert.equal(after.assigned_tc, '');
});

test("F1: office-scoped — the other office's unowned case is never assigned", async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const other = seedInboxCase(db, { office_id: 'valley' });
  const h = seedHandoff(db);
  const r = await api(baseUrl, 'POST', OUTCOME(h.handoff_id), { outcome: 'scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attached, false, 'no open case in roland, so one is created');
  assert.equal(caseRow(db, other.case_id).assigned_tc, '');
  assert.equal(caseRow(db, other.case_id).status, 'hygiene_review');
});

test('F1: a lost race rolls the assignment back with everything else', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const c = seedInboxCase(db);
  const h = seedHandoff(db);
  const first = await api(baseUrl, 'POST', OUTCOME(h.handoff_id), { outcome: 'scheduled' });
  assert.equal(first.status, 200);
  // Second answer on the same handoff: refused, and changes nothing more.
  const before = assignNotes(db, c.case_id).length;
  const second = await api(baseUrl, 'POST', OUTCOME(h.handoff_id), { outcome: 'not_scheduled' });
  assert.equal(second.status, 409);
  assert.equal(assignNotes(db, c.case_id).length, before);
  assert.equal(caseRow(db, c.case_id).assigned_tc, ANSWERER);
});
