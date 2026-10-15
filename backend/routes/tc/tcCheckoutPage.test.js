'use strict';

/**
 * /api/tc/checkout — the front desk's Checkout inbox (queue item 50, C2).
 *
 * By acceptance row:
 *   1  each outcome lands the case in the right column — Scheduled → a case at
 *      `scheduled` (created, or the open case moved there with a funnel-format
 *      status_change); Not scheduled → a case at `pending_pt` (created), or a
 *      note on the open case WITHOUT moving it; Nothing needed → NO case.
 *   2  a handoff leaves the inbox once answered; claim/dismiss behave like the
 *      opportunities inbox (conditional, a reason to dismiss, 409 on a race).
 *   3  office-scoped: another office's handoffs are invisible and unactionable.
 *   4  switched off → every route refuses, /summary says enabled:false.
 *   +  day-scoped expiry: yesterday's waiting handoffs close as `expired` on the
 *      next request, never show, cannot be answered, and each is audited with
 *      the status it had.
 *   +  zero Open Dental: this harness has no OD client at all.
 *
 * Test patients only (roland 12827 / 12828, valley 7115); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const checkoutRoute = require('./checkout');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

// 2026-09-08 10:00 in America/Chicago.
const NOW = new Date('2026-09-08T15:00:00.000Z');
const TODAY = '2026-09-08';
const YESTERDAY = '2026-09-07';

const SNAPSHOT = {
  procedures: [
    {
      teeth: [3],
      code: 'Crown',
      category: 'Restorative',
      priority: 'urgent',
      status: 'proposed',
      surfaces: ['O'],
      scheduleNext: true,
      note: '',
    },
  ],
  priority: 'urgent',
  nextVisit: { type: 'Prophy', intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: '6 mo' },
  notesPending: false,
  frontDeskNote: 'Prefers afternoons.',
  financialNote: '',
};

function switchCheckout(t, byOffice) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' && byOffice ? { key, value: byOffice, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  checkoutRoute.setClockForTests(() => NOW);
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
    checkoutRoute.setClockForTests(null);
  });
}

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

let seq = 0;
/** A handoff row, as item 49's submit stores it. */
function seed(db, over = {}) {
  seq += 1;
  const row = {
    handoff_id: randomUUID(),
    office_id: 'roland',
    source_key: `hyg-visit:visit-${String(seq).padStart(4, '0')}:checkout`,
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    provider: 'DOC1',
    provider_seen: 'HYG1',
    operatory: 'Hyg 1',
    visit_date: TODAY,
    payload: SNAPSHOT,
    is_final: true,
    revision: 2,
    submitted_by: 'hygienist@carein.ai',
    updated_by: 'hygienist@carein.ai',
    status: 'open',
    created_at: new Date(NOW.getTime() - (100 - seq) * 1000),
    updated_at: new Date(NOW.getTime() - (100 - seq) * 1000),
    ...over,
  };
  db.table('tc_checkout_handoffs').push(row);
  return row;
}

/** An open case for a patient, as the pipeline holds it. */
function seedCase(db, over = {}) {
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
    status: 'pending_tc',
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
    status_changed_at: new Date(NOW.getTime() - 86400000),
    nurture_cadence: 'standard',
    in_long_tail_mode: false,
    nurture_enrolled_at: null,
    nurture_phase_changed_at: null,
    nurture_phase1_days_override: null,
    nurture_phase2_days_override: null,
    nurture_unsubscribed: false,
    created_at: new Date(NOW.getTime() - 86400000),
    updated_at: new Date(NOW.getTime() - 86400000),
    ...over,
  };
  db.table('tc_cases').push(row);
  return row;
}

const LIST = (office, view = 'waiting') => `/api/tc/checkout?office=${office}&view=${view}`;
const ACT = (office, id, verb) => `/api/tc/checkout/${id}/${verb}?office=${office}`;

// ── 4: dark ─────────────────────────────────────────────────────────────────

test('4: switched off for the office → every route refuses; /summary says enabled:false', async (t) => {
  switchCheckout(t, { roland: false, valley: true });
  const { baseUrl, db } = await boot(t);
  const h = seed(db);
  assert.equal((await api(baseUrl, 'GET', LIST('roland'))).status, 403);
  assert.equal((await api(baseUrl, 'GET', `/api/tc/checkout/${h.handoff_id}?office=roland`)).status, 403);
  for (const verb of ['claim', 'dismiss', 'outcome']) {
    const body = verb === 'dismiss' ? { reason: 'x' } : verb === 'outcome' ? { outcome: 'nothing_needed' } : {};
    const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, verb), body);
    assert.equal(r.status, 403, verb);
    assert.equal(r.body.code, 'CHECKOUT_DISABLED');
  }
  const s = await api(baseUrl, 'GET', '/api/tc/checkout/summary?office=roland');
  assert.equal(s.status, 200);
  assert.deepEqual(s.body, { success: true, office: 'roland', enabled: false, today: null, waiting: 0, newest: null });
  assert.equal(db.table('tc_checkout_handoffs')[0].status, 'open', 'nothing changed');
});

test('4: no stored row at all is OFF (the floor)', async (t) => {
  switchCheckout(t, null);
  const { baseUrl } = await boot(t);
  assert.equal((await api(baseUrl, 'GET', LIST('roland'))).status, 403);
});

test('a hygienist (tc.hygiene only) cannot open the Checkout inbox', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl } = await boot(t, { role: 'hygiene' });
  assert.equal((await api(baseUrl, 'GET', LIST('roland'))).status, 403);
});

// ── 2, 3: the list ──────────────────────────────────────────────────────────

test("2/3: today's waiting handoffs, newest first, this office only", async (t) => {
  switchCheckout(t, { roland: true, valley: true });
  const { baseUrl, db } = await boot(t);
  const older = seed(db);
  const newer = seed(db, { od_patient_id: 12828, patient_name: 'Test, MangoTest' });
  seed(db, { office_id: 'valley', od_patient_id: 7115, patient_name: 'Stedi TestValley' });

  const r = await api(baseUrl, 'GET', LIST('roland'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.today, TODAY);
  assert.deepEqual(
    r.body.handoffs.map((x) => x.handoffId),
    [newer.handoff_id, older.handoff_id],
    'newest first, valley invisible'
  );
  assert.equal(r.body.handoffs[0].snapshot.procedures[0].code, 'Crown', 'renders the snapshot');

  const s = await api(baseUrl, 'GET', '/api/tc/checkout/summary?office=roland');
  assert.equal(s.body.enabled, true);
  assert.equal(s.body.waiting, 2);
  assert.equal(s.body.newest.handoffId, newer.handoff_id);
});

test('3: another office cannot read or act on a handoff (404)', async (t) => {
  switchCheckout(t, { roland: true, valley: true });
  const { baseUrl, db } = await boot(t);
  const h = seed(db);
  assert.equal((await api(baseUrl, 'GET', `/api/tc/checkout/${h.handoff_id}?office=valley`)).status, 404);
  const r = await api(baseUrl, 'POST', ACT('valley', h.handoff_id, 'outcome'), { outcome: 'scheduled' });
  assert.equal(r.status, 404);
  assert.equal(db.table('tc_cases').length, 0);
  assert.equal(db.table('tc_checkout_handoffs')[0].status, 'open');
});

// ── 2: claim / dismiss ──────────────────────────────────────────────────────

test('2: claim is conditional — the second claim is a 409; the handoff stays in the inbox', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const h = seed(db);
  const first = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'claim'), {});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.handoff.status, 'claimed');
  assert.equal(first.body.handoff.claimedBy, 'tc@carein.ai');
  const second = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'claim'), {});
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'CHECKOUT_NOT_ACTIONABLE');
  const list = await api(baseUrl, 'GET', LIST('roland'));
  assert.equal(list.body.handoffs.length, 1, 'a claimed handoff still waits for an outcome');
  const audit = auditRows(db).filter((r) => r.resource_type === 'tc_checkout_handoff');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].prior_state, 'open');
});

test('2: dismiss needs a reason, leaves the inbox, shows in Done, and audits no prose', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const h = seed(db);
  assert.equal((await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'dismiss'), {})).status, 400);
  assert.equal((await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'dismiss'), { reason: '   ' })).status, 400);
  const ok = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'dismiss'), { reason: 'Seen by the doctor only' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.handoff.status, 'dismissed');
  assert.equal(ok.body.handoff.dismissedReason, 'Seen by the doctor only');
  assert.equal((await api(baseUrl, 'GET', LIST('roland'))).body.handoffs.length, 0);
  assert.equal((await api(baseUrl, 'GET', LIST('roland', 'done'))).body.handoffs.length, 1);
  const row = auditRows(db).find((r) => r.resource_type === 'tc_checkout_handoff');
  assert.equal(row.prior_state, 'open');
  assert.ok(!JSON.stringify(row).includes('Seen by the doctor'), 'the reason is not copied to the audit trail');
  assert.equal(db.table('tc_cases').length, 0);
});

// ── 1: the three outcomes ───────────────────────────────────────────────────

test('1: Scheduled with no open case CREATES a case at scheduled, with the appointment note', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const h = seed(db);
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), {
    outcome: 'scheduled',
    appointmentNote: 'Tue 10/14 9am',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attached, false);
  assert.equal(r.body.handoff.status, 'scheduled');
  assert.equal(r.body.handoff.outcomeBy, 'tc@carein.ai');
  assert.ok(r.body.handoff.outcomeAt);
  assert.equal(r.body.handoff.appointmentNote, 'Tue 10/14 9am');
  assert.equal(r.body.handoff.caseId, r.body.caseId);
  assert.equal(r.body.url, `/tc/cases/${r.body.caseId}`);

  const cases = db.table('tc_cases');
  assert.equal(cases.length, 1);
  assert.equal(cases[0].status, 'scheduled', 'the Scheduled column');
  assert.equal(cases[0].office_id, 'roland');
  assert.equal(cases[0].od_patient_id, 12827, "the HANDOFF's patient");
  assert.equal(cases[0].referral_source, 'hygiene');
  assert.equal(cases[0].urgency, 'high', 'urgent priority → high urgency');
  assert.match(cases[0].notes, /#3 Crown \(urgent\)/);
  const events = db.table('tc_case_events').filter((e) => e.case_id === r.body.caseId);
  assert.ok(events.some((e) => e.type === 'case_created'));
  assert.ok(events.some((e) => e.type === 'note_added' && /Tue 10\/14 9am/.test(e.description)));

  // It leaves the inbox and shows in Done.
  assert.equal((await api(baseUrl, 'GET', LIST('roland'))).body.handoffs.length, 0);
  assert.equal((await api(baseUrl, 'GET', LIST('roland', 'done'))).body.handoffs[0].status, 'scheduled');

  const audits = auditRows(db);
  assert.ok(audits.some((a) => a.resource_type === 'tc_checkout_handoff' && a.prior_state === 'open'));
  assert.ok(audits.some((a) => a.resource_type === 'tc_case' && a.action === 'CREATE'));
});

test("1: Scheduled with an OPEN case MOVES it to scheduled, in the funnel's `from → to` format", async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db, { status: 'presented' });
  const h = seed(db);
  // Claimed first: an outcome may be given from claimed too.
  assert.equal((await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'claim'), {})).status, 200);
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attached, true);
  assert.equal(r.body.caseId, c.case_id);
  assert.equal(db.table('tc_cases').length, 1, 'no second case');
  assert.equal(db.table('tc_cases')[0].status, 'scheduled');
  const change = db.table('tc_case_events').find((e) => e.case_id === c.case_id && e.type === 'status_change');
  assert.match(change.description, /^presented → scheduled: Scheduled at checkout$/);
  const handoffAudit = auditRows(db).filter((a) => a.resource_type === 'tc_checkout_handoff');
  assert.equal(handoffAudit.at(-1).prior_state, 'claimed');
  assert.ok(auditRows(db).some((a) => a.resource_type === 'tc_case' && a.action === 'UPDATE'));
});

test('1: Not scheduled with no open case CREATES a case waiting on the patient (pending_pt)', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const h = seed(db);
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'not_scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.handoff.status, 'not_scheduled');
  assert.equal(db.table('tc_cases').length, 1);
  assert.equal(db.table('tc_cases')[0].status, 'pending_pt');
});

test('1: Not scheduled with an OPEN case notes it and does NOT move it backwards', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db, { status: 'considering' });
  const h = seed(db);
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'not_scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.caseId, c.case_id);
  assert.equal(db.table('tc_cases')[0].status, 'considering', 'unchanged');
  const note = db.table('tc_case_events').find((e) => e.case_id === c.case_id && e.type === 'note_added');
  assert.equal(note.description, 'Checkout: Not scheduled');
  assert.ok(!db.table('tc_case_events').some((e) => e.type === 'status_change'));
});

test('1: Nothing needed closes the handoff and creates NO case', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  seedCase(db); // even with an open case, nothing is touched
  const h = seed(db);
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'nothing_needed' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.handoff.status, 'nothing_needed');
  assert.equal(r.body.caseId, null);
  assert.equal(r.body.handoff.caseId, null);
  assert.equal(db.table('tc_cases').length, 1, 'no new case');
  assert.equal(db.table('tc_case_events').length, 0, 'the existing case is not touched');
  assert.equal((await api(baseUrl, 'GET', LIST('roland'))).body.handoffs.length, 0);
});

test('2: an answered checkout cannot be answered again (409), and no second case appears', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const h = seed(db);
  assert.equal((await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'not_scheduled' })).status, 200);
  const again = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'scheduled' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'CHECKOUT_NOT_ACTIONABLE');
  assert.equal(db.table('tc_cases').length, 1);
  assert.equal(db.table('tc_cases')[0].status, 'pending_pt');
});

test('2: a racing answer that loses the conditional update rolls back its case and 409s', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const h = seed(db);
  // Somebody else answered between this request's read and its write.
  db.onQuery(/^UPDATE tc_checkout_handoffs SET status = \$4/, () => ({ rows: [], rowCount: 0 }));
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'scheduled' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'CHECKOUT_NOT_ACTIONABLE');
  // (The fake does not roll back; the real transaction does. What matters
  // here is the honest refusal: nothing is reported as answered.)
  assert.equal(db.table('tc_checkout_handoffs')[0].status, 'open');
});

test('an unknown outcome or a long note is a 400', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const h = seed(db);
  assert.equal((await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'lost' })).status, 400);
  assert.equal(
    (await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'scheduled', appointmentNote: 'x'.repeat(501) })).status,
    400
  );
  assert.equal(db.table('tc_cases').length, 0);
});

// ── day-scoped expiry ───────────────────────────────────────────────────────

test("expiry: yesterday's waiting handoffs close as expired, never show, and are audited", async (t) => {
  switchCheckout(t, { roland: true, valley: true });
  const { baseUrl, db } = await boot(t);
  const staleOpen = seed(db, { visit_date: YESTERDAY });
  const staleClaimed = seed(db, {
    visit_date: YESTERDAY,
    status: 'claimed',
    claimed_by: 'tc@carein.ai',
    claimed_at: new Date(NOW.getTime() - 86400000),
  });
  const staleDone = seed(db, {
    visit_date: YESTERDAY,
    status: 'nothing_needed',
    outcome_by: 'tc@carein.ai',
    outcome_at: new Date(NOW.getTime() - 86400000),
  });
  const otherOffice = seed(db, { office_id: 'valley', od_patient_id: 7115, visit_date: YESTERDAY });
  const fresh = seed(db);

  const r = await api(baseUrl, 'GET', LIST('roland'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.handoffs.map((x) => x.handoffId), [fresh.handoff_id], "only today's");

  const byId = new Map(db.table('tc_checkout_handoffs').map((x) => [x.handoff_id, x]));
  assert.equal(byId.get(staleOpen.handoff_id).status, 'expired');
  assert.ok(byId.get(staleOpen.handoff_id).expired_at);
  assert.equal(byId.get(staleClaimed.handoff_id).status, 'expired');
  assert.equal(byId.get(staleDone.handoff_id).status, 'nothing_needed', 'an answered one is never overwritten');
  assert.equal(byId.get(otherOffice.handoff_id).status, 'open', "the sweep is this office's only");

  const expiries = auditRows(db).filter((a) => a.source_ref === 'checkout_day_expiry');
  assert.equal(expiries.length, 2);
  assert.deepEqual(expiries.map((a) => a.prior_state).sort(), ['claimed', 'open']);
  assert.ok(expiries.every((a) => a.office === 'roland' && a.action === 'UPDATE'));

  // Done today does not show yesterday's expiries either.
  assert.equal((await api(baseUrl, 'GET', LIST('roland', 'done'))).body.handoffs.length, 0);
  // And an expired handoff cannot be answered.
  const late = await api(baseUrl, 'POST', ACT('roland', staleOpen.handoff_id, 'outcome'), { outcome: 'scheduled' });
  assert.equal(late.status, 409);
  assert.equal(db.table('tc_cases').length, 0);

  // A second request finds nothing more to expire: no duplicate audit rows.
  await api(baseUrl, 'GET', LIST('roland'));
  assert.equal(auditRows(db).filter((a) => a.source_ref === 'checkout_day_expiry').length, 2);
});

test('expiry also runs before an action, so a stale handoff can never be answered', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const stale = seed(db, { visit_date: YESTERDAY });
  const r = await api(baseUrl, 'POST', ACT('roland', stale.handoff_id, 'outcome'), { outcome: 'not_scheduled' });
  assert.equal(r.status, 409);
  assert.equal(r.body.handoff.status, 'expired');
  assert.equal(db.table('tc_cases').length, 0);
});

test('the summary sweeps too: the badge never counts a stale day', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  seed(db, { visit_date: YESTERDAY });
  const s = await api(baseUrl, 'GET', '/api/tc/checkout/summary?office=roland');
  assert.equal(s.body.waiting, 0);
  assert.equal(s.body.newest, null);
});

// ── item 49's submit still works, and a new handoff starts open ─────────────

test("item 49's submit stores a handoff the inbox then shows as open", async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl } = await boot(t, { role: 'hygiene' });
  const sub = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', {
    kind: 'checkout',
    sourceKey: 'hyg-visit:visit-9001:checkout',
    final: false,
    patientName: 'Test 2, Stedi',
    odPatientId: 12827,
    provider: 'DOC1',
    providerSeen: 'HYG1',
    operatory: 'Hyg 1',
    visitDate: TODAY,
    snapshot: SNAPSHOT,
  });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.body.handoff.status, 'open');
});

// ── review round 1 ──────────────────────────────────────────────────────────

for (const from of ['hygiene_review', 'diagnosed', 'pending_tc']) {
  test(`Not scheduled moves an open ${from} case FORWARD to pending_pt (funnel format)`, async (t) => {
    switchCheckout(t, { roland: true });
    const { baseUrl, db } = await boot(t);
    const c = seedCase(db, { status: from });
    const h = seed(db);
    const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'not_scheduled' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.caseId, c.case_id);
    assert.equal(db.table('tc_cases').length, 1, 'no second case');
    assert.equal(db.table('tc_cases')[0].status, 'pending_pt', 'now in a pipeline column');
    const change = db.table('tc_case_events').find((e) => e.case_id === c.case_id && e.type === 'status_change');
    assert.equal(change.description, `${from} → pending_pt: Not scheduled at checkout`);
    assert.ok(auditRows(db).some((a) => a.resource_type === 'tc_case' && a.action === 'UPDATE'));
  });
}

test('expiry is the SYSTEM\'s act: expired_by and the audit actor are system:checkout_expiry', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const stale = seed(db, { visit_date: YESTERDAY });
  await api(baseUrl, 'GET', '/api/tc/checkout/summary?office=roland');
  const row = db.table('tc_checkout_handoffs').find((x) => x.handoff_id === stale.handoff_id);
  assert.equal(row.status, 'expired');
  assert.equal(row.expired_by, 'system:checkout_expiry');
  const audit = auditRows(db).find((a) => a.source_ref === 'checkout_day_expiry');
  assert.equal(audit.user_id, 'system:checkout_expiry', 'never the person whose poll ran the sweep');
  assert.equal(audit.tenant_id, 'T1', 'still filed in the tenant');
  const read = await api(baseUrl, 'GET', `/api/tc/checkout/${stale.handoff_id}?office=roland`);
  assert.equal(read.body.handoff.expiredBy, 'system:checkout_expiry');
});

test('dismiss audits the status the DATABASE matched (claimed), not a pre-read', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const h = seed(db, { status: 'claimed', claimed_by: 'tc2@carein.ai', claimed_at: NOW });
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'dismiss'), { reason: 'Not a checkout' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const audit = auditRows(db).find((a) => a.resource_type === 'tc_checkout_handoff');
  assert.equal(audit.prior_state, 'claimed');
});

// ── C2b (queue 50b): the treatment persists on the case ─────────────────────

const TWO_PROCS = {
  ...SNAPSHOT,
  procedures: [
    { ...SNAPSHOT.procedures[0], note: 'Fractured cusp' },
    {
      teeth: 'mouth',
      code: 'SRP',
      category: 'Perio',
      priority: 'preventative',
      status: 'proposed',
      surfaces: [],
      scheduleNext: false,
      note: '',
    },
  ],
};

/** A plan phase (+ one item) already on a case. */
function seedPhase(db, caseRow, position, name = `Phase ${position + 1}`) {
  const phaseId = randomUUID();
  db.table('tc_case_phases').push({
    phase_id: phaseId,
    case_id: caseRow.case_id,
    office_id: caseRow.office_id,
    position,
    name,
    description: '',
  });
  db.table('tc_case_items').push({
    item_id: randomUUID(),
    phase_id: phaseId,
    case_id: caseRow.case_id,
    office_id: caseRow.office_id,
    position: 0,
    legacy_item_id: null,
    od_proc_num: null,
    tooth: '#14',
    procedure_name: 'Implant',
    patient_description: '',
    fee_cents: 450000,
    insurance_est_cents: 0,
    patient_portion_cents: 450000,
    urgency: 'medium',
    time_estimate: '',
    benefits: [],
    risks_of_delay: [],
    expected_outcome: '',
  });
  return phaseId;
}

const CASE = (office, id) => `/api/tc/cases/${id}?office=${office}`;

test('C2b-1: a case CREATED at checkout carries every staged item on its Treatment plan', async (t) => {
  for (const outcome of ['scheduled', 'not_scheduled']) {
    await t.test(outcome, async (tt) => {
      switchCheckout(tt, { roland: true });
      const { baseUrl, db } = await boot(tt);
      const h = seed(db, { payload: TWO_PROCS });
      const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome });
      assert.equal(r.status, 200, JSON.stringify(r.body));

      // Read back through the case route the Treatment tab loads from.
      const got = await api(baseUrl, 'GET', CASE('roland', r.body.caseId));
      assert.equal(got.status, 200, JSON.stringify(got.body));
      const phases = got.body.case.phases;
      assert.equal(phases.length, 1);
      assert.equal(phases[0].name, `Hygiene visit ${TODAY}`);
      assert.equal(phases[0].position, 0);
      const items = [...phases[0].items].sort((a, b) => a.position - b.position);
      assert.deepEqual(
        items.map((i) => [i.tooth, i.procedureName, i.urgency, i.feeCents]),
        [
          ['#3 O', 'Crown', 'high', 0],
          ['Whole mouth', 'SRP', 'medium', 0],
        ]
      );
      // The plan is patient-facing (presentation slides): nothing staff-only
      // lands in the fields a patient sees.
      assert.equal(phases[0].description, '');
      for (const i of items) {
        assert.equal(i.patientDescription, '');
        assert.equal(i.timeEstimate, '');
      }
      // The staff detail goes on the case timeline instead.
      const staff = got.body.case.events.find((e) => /Checkout treatment added to the plan/.test(e.description));
      assert.ok(staff, 'a staff-only timeline line');
      assert.equal(
        staff.description,
        `Checkout treatment added to the plan as "Hygiene visit ${TODAY}" (provider DOC1). ` +
          'Fees are not known at checkout: set them before presenting.\n' +
          '#3 Crown (urgent): schedule at next visit; note: Fractured cusp\n' +
          'Whole mouth SRP (preventative)'
      );
      // The notes text from item 50 is unchanged.
      assert.match(db.table('tc_cases')[0].notes, /^Staged at the hygiene visit:\n#3 Crown \(urgent\)\nWhole mouth SRP \(preventative\)/);
    });
  }
});

test('C2b-2: ATTACHING to an open case appends a phase after its plan and leaves the plan alone', async (t) => {
  for (const [outcome, status] of [['scheduled', 'presented'], ['not_scheduled', 'considering']]) {
    await t.test(outcome, async (tt) => {
      switchCheckout(tt, { roland: true });
      const { baseUrl, db } = await boot(tt);
      const c = seedCase(db, { status });
      seedPhase(db, c, 0, 'Implant phase');
      seedPhase(db, c, 3, 'Later phase');
      const h = seed(db);
      const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.attached, true);

      const got = await api(baseUrl, 'GET', CASE('roland', c.case_id));
      assert.equal(got.status, 200, JSON.stringify(got.body));
      const phases = [...got.body.case.phases].sort((a, b) => a.position - b.position);
      assert.deepEqual(phases.map((p) => [p.position, p.name]), [
        [0, 'Implant phase'],
        [3, 'Later phase'],
        [4, `Hygiene visit ${TODAY}`],
      ]);
      assert.deepEqual(phases[0].items.map((i) => [i.procedureName, i.feeCents]), [['Implant', 450000]], 'untouched');
      assert.deepEqual(phases[2].items.map((i) => [i.tooth, i.procedureName, i.urgency]), [['#3 O', 'Crown', 'high']]);
      assert.ok(
        got.body.case.events.some((e) => /^Checkout treatment added to the plan as "Hygiene visit /.test(e.description)),
        'the staff-only timeline line'
      );
      for (const row of db.table('tc_case_items')) assert.equal(row.office_id, 'roland');
    });
  }
});

test('C2b-3: Nothing needed, or a checkout with nothing staged, puts no phase anywhere', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db, { status: 'presented' });
  const none = seed(db);
  let r = await api(baseUrl, 'POST', ACT('roland', none.handoff_id, 'outcome'), { outcome: 'nothing_needed' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.table('tc_case_phases').length, 0);

  const empty = seed(db, { payload: { ...SNAPSHOT, procedures: [], priority: null } });
  r = await api(baseUrl, 'POST', ACT('roland', empty.handoff_id, 'outcome'), { outcome: 'not_scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.caseId, c.case_id);
  assert.equal(db.table('tc_case_phases').length, 0);
  assert.equal(db.table('tc_case_items').length, 0);
});

test('C2b-3: a lost race refuses before any phase is reported (the transaction rolls it back)', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const h = seed(db);
  db.onQuery(/^UPDATE tc_checkout_handoffs SET status = \$4/, () => ({ rows: [], rowCount: 0 }));
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'scheduled' });
  assert.equal(r.status, 409);
  assert.equal(r.body.caseId, undefined, 'no case or plan is reported');
});

test('C2b-4: a plan already at 20 phases gets no phase; the event lists the items instead', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db, { status: 'presented' });
  for (let i = 0; i < 20; i += 1) seedPhase(db, c, i);
  const h = seed(db, { payload: TWO_PROCS });
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.table('tc_case_phases').length, 20);
  const note = db.table('tc_case_events').find((e) => e.type === 'note_added' && /not added to the plan/.test(e.description));
  assert.ok(note, 'the items are not silently dropped');
  assert.match(
    note.description,
    /^Checkout treatment not added to the plan \(it already has 20 phases\) \(provider DOC1\):\n#3 Crown \(urgent\): schedule at next visit; note: Fractured cusp\nWhole mouth SRP \(preventative\)$/
  );
  // The case still loads: the contract's 20-phase cap holds.
  assert.equal((await api(baseUrl, 'GET', CASE('roland', c.case_id))).status, 200);
});

test("C2b-6: office-scoped — the other office's case and plan are never touched", async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  // Valley holds an open case under the SAME PatNum the roland handoff
  // carries. PatNums restart per office, so that is a different person.
  const valley = seedCase(db, { office_id: 'valley', od_patient_id: 12827, status: 'presented' });
  seedPhase(db, valley, 0);
  const h = seed(db);
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attached, false, "valley's case is not roland's open case");
  assert.notEqual(r.body.caseId, valley.case_id);
  assert.equal(db.table('tc_case_phases').filter((p) => p.case_id === valley.case_id).length, 1);
  const rolandPhases = db.table('tc_case_phases').filter((p) => p.case_id === r.body.caseId);
  assert.equal(rolandPhases.length, 1);
  assert.equal(rolandPhases[0].office_id, 'roland');
  assert.equal((await api(baseUrl, 'GET', CASE('roland', valley.case_id))).status, 404);
});

test('C2b-3: attaching locks the case row before reading the plan (no position collision under a race)', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db, { status: 'considering' });
  const h = seed(db);
  const order = [];
  db.onQuery(/^UPDATE tc_cases SET updated_at = now\(\) WHERE office_id = \$1 AND case_id = \$2$/, (_text, params) => {
    order.push(['lock', ...params]);
    return { rows: [], rowCount: 1 };
  });
  db.onQuery(/^SELECT position FROM tc_case_phases/, () => {
    order.push(['read']);
    return { rows: [] };
  });
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'not_scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(order, [['lock', 'roland', c.case_id], ['read']], 'lock, then read');
});

test('C2b-3: a plan rewritten mid-answer (unique position clash) is an honest 409, not a 500', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  seedCase(db, { status: 'considering' });
  const h = seed(db);
  db.onQuery(/^INSERT INTO tc_case_phases/, () => {
    const err = new Error('duplicate key value violates unique constraint "tc_case_phases_case_position_unique"');
    Object.assign(err, { code: '23505', constraint: 'tc_case_phases_case_position_unique' });
    throw err;
  });
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome: 'not_scheduled' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'CHECKOUT_PLAN_CHANGED');
  assert.ok(!auditRows(db).some((a) => a.resource_type === 'tc_checkout_handoff'), 'nothing audited as answered');
});

// ── C2b PM revision: the staff panel, "entered in Open Dental", the badge ────

const PANEL = (office, caseId) => `/api/tc/checkout/by-case/${caseId}?office=${office}`;
const ENTERED = (office, id, index) => `/api/tc/checkout/${id}/items/${index}/entered?office=${office}`;
const CASES = (office) => `/api/tc/cases?office=${office}`;

/** A roland case created at checkout from a two-item visit; returns its ids. */
async function answered(baseUrl, db, outcome = 'not_scheduled', payload = TWO_PROCS) {
  const h = seed(db, { payload });
  const r = await api(baseUrl, 'POST', ACT('roland', h.handoff_id, 'outcome'), { outcome });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { handoffId: h.handoff_id, caseId: r.body.caseId };
}

test('C2b-7: the staff panel lists the handoff snapshot, and survives the plan being replaced', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const { handoffId, caseId } = await answered(baseUrl, db);

  // The coordinator replaces the whole plan (Edit plan / Pull from Open Dental).
  const replaced = await api(baseUrl, 'PUT', `/api/tc/cases/${caseId}/phases?office=roland`, [
    { position: 0, name: 'Re-planned', items: [] },
  ]);
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.ok(!db.table('tc_case_phases').some((p) => /^Hygiene visit/.test(p.name)), 'the plan phase is gone');

  const r = await api(baseUrl, 'GET', PANEL('roland', caseId));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.visits.length, 1);
  const visit = r.body.visits[0];
  assert.equal(visit.handoff.handoffId, handoffId);
  assert.equal(visit.handoff.visitDate, TODAY);
  assert.equal(visit.handoff.snapshot.nextVisit.type, 'Prophy');
  assert.deepEqual(
    visit.items.map((i) => [i.index, i.procedure.code, i.procedure.priority, i.procedure.note, i.enteredBy, i.stale]),
    [
      [0, 'Crown', 'urgent', 'Fractured cusp', null, false],
      [1, 'SRP', 'preventative', '', null, false],
    ]
  );
  assert.equal(r.body.canUnattest, true, 'the default test user is an admin');
  assert.ok(
    auditRows(db).some((a) => a.action === 'READ' && a.resource_type === 'tc_checkout_handoff' && a.source_ref === `case:${caseId}`),
    'reading the staged treatment is audited'
  );
});

test('C2b-7: the panel is office-scoped and dark when checkout is off', async (t) => {
  switchCheckout(t, { roland: true, valley: true });
  const { baseUrl, db } = await boot(t);
  const { caseId } = await answered(baseUrl, db);
  const other = await api(baseUrl, 'GET', PANEL('valley', caseId));
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.visits, [], "valley sees nothing of roland's case");

  tcCheckout.resetCacheForTests();
  registry.getPlatformSetting = async () => null; // the floor: OFF
  const off = await api(baseUrl, 'GET', PANEL('roland', caseId));
  assert.equal(off.status, 403);
  assert.equal(off.body.code, 'CHECKOUT_DISABLED');
});

test('C2b-8: "entered in Open Dental" records who and when, audits once, and is idempotent', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const { handoffId, caseId } = await answered(baseUrl, db);

  const r = await api(baseUrl, 'POST', ENTERED('roland', handoffId, 0), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.item.enteredBy, 'tc@carein.ai');
  assert.equal(r.body.item.enteredAt, NOW.toISOString());
  assert.equal(r.body.alreadyEntered, false);
  const rows = db.table('tc_checkout_attestations');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].office_id, 'roland');
  assert.equal(rows[0].attested_by, 'tc@carein.ai');

  const audits = () => auditRows(db).filter((a) => a.resource_type === 'tc_checkout_item_attestation');
  assert.equal(audits().length, 1);
  assert.equal(audits()[0].action, 'CREATE');
  assert.equal(audits()[0].resource_id, `${handoffId}:0`);
  assert.equal(audits()[0].prior_state, 'unattested');

  const again = await api(baseUrl, 'POST', ENTERED('roland', handoffId, 0), {});
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyEntered, true);
  assert.equal(audits().length, 1, 'no second audit row for a no-op');

  const panel = await api(baseUrl, 'GET', PANEL('roland', caseId));
  assert.deepEqual(panel.body.visits[0].items.map((i) => i.enteredBy), ['tc@carein.ai', null]);
});

test('C2b-8: nothing is reported as entered unless it persisted', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const { handoffId } = await answered(baseUrl, db);
  db.onQuery(/^INSERT INTO tc_checkout_attestations/, () => ({ rows: [], rowCount: 0 }));
  const r = await api(baseUrl, 'POST', ENTERED('roland', handoffId, 0), {});
  assert.equal(r.status, 500);
  assert.equal(r.body.success, false);
  assert.ok(!auditRows(db).some((a) => a.resource_type === 'tc_checkout_item_attestation'));
});

test('C2b-8: a tc user can mark entered but cannot undo it (admin only)', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const { handoffId, caseId } = await answered(baseUrl, db);
  assert.equal((await api(baseUrl, 'POST', ENTERED('roland', handoffId, 1), {})).status, 200);
  const refused = await api(baseUrl, 'DELETE', ENTERED('roland', handoffId, 1));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'UNATTEST_ADMIN_ONLY');
  assert.equal(db.table('tc_checkout_attestations').length, 1, 'the attestation stays');
  assert.ok(!auditRows(db).some((a) => a.resource_type === 'tc_checkout_item_attestation' && a.action === 'DELETE'));
  assert.equal((await api(baseUrl, 'GET', PANEL('roland', caseId))).body.canUnattest, false);
});

test('C2b-8: an admin undoes it, audited with what it was', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const { handoffId } = await answered(baseUrl, db);
  assert.equal((await api(baseUrl, 'POST', ENTERED('roland', handoffId, 1), {})).status, 200);
  const undone = await api(baseUrl, 'DELETE', ENTERED('roland', handoffId, 1));
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.item.enteredBy, null);
  assert.equal(db.table('tc_checkout_attestations').length, 0);
  const del = auditRows(db).find((a) => a.resource_type === 'tc_checkout_item_attestation' && a.action === 'DELETE');
  assert.ok(del);
  assert.equal(del.resource_id, `${handoffId}:1`);
  assert.equal(del.prior_state, 'attested');
  assert.equal((await api(baseUrl, 'DELETE', ENTERED('roland', handoffId, 1))).status, 404, 'nothing left to undo');
});

test('C2b-8: a revised item makes its attestation stale; marking it again records over it', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const { handoffId, caseId } = await answered(baseUrl, db);
  assert.equal((await api(baseUrl, 'POST', ENTERED('roland', handoffId, 0), {})).status, 200);

  // The hygienist's later Send revised item 0 (a different tooth).
  const row = db.table('tc_checkout_handoffs').find((x) => x.handoff_id === handoffId);
  row.payload = { ...TWO_PROCS, procedures: [{ ...TWO_PROCS.procedures[0], teeth: [4] }, TWO_PROCS.procedures[1]] };

  const panel = await api(baseUrl, 'GET', PANEL('roland', caseId));
  assert.deepEqual(panel.body.visits[0].items[0].enteredBy, null);
  assert.equal(panel.body.visits[0].items[0].stale, true);

  const again = await api(baseUrl, 'POST', ENTERED('roland', handoffId, 0), {});
  assert.equal(again.status, 200);
  const audit = auditRows(db).filter((a) => a.resource_type === 'tc_checkout_item_attestation').at(-1);
  assert.equal(audit.action, 'UPDATE');
  assert.equal(audit.prior_state, 'stale');
});

test('C2b-8: refusals — other office, no case, no such item, switched off', async (t) => {
  switchCheckout(t, { roland: true, valley: true });
  const { baseUrl, db } = await boot(t);
  const { handoffId } = await answered(baseUrl, db);
  assert.equal((await api(baseUrl, 'POST', ENTERED('valley', handoffId, 0), {})).status, 404);
  assert.equal((await api(baseUrl, 'POST', ENTERED('roland', handoffId, 2), {})).status, 404);
  assert.equal((await api(baseUrl, 'POST', ENTERED('roland', handoffId, 'x'), {})).status, 400);

  const none = seed(db);
  assert.equal((await api(baseUrl, 'POST', ACT('roland', none.handoff_id, 'outcome'), { outcome: 'nothing_needed' })).status, 200);
  const notOnCase = await api(baseUrl, 'POST', ENTERED('roland', none.handoff_id, 0), {});
  assert.equal(notOnCase.status, 409);
  assert.equal(notOnCase.body.code, 'CHECKOUT_NOT_ON_CASE');

  tcCheckout.resetCacheForTests();
  registry.getPlatformSetting = async () => null;
  assert.equal((await api(baseUrl, 'POST', ENTERED('roland', handoffId, 0), {})).status, 403);
  assert.equal(db.table('tc_checkout_attestations').length, 0);
});

test('C2b-9: the card says "Tx not in OD" until every item is entered; never for no treatment', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const { handoffId, caseId } = await answered(baseUrl, db);
  const flag = async (id) => (await api(baseUrl, 'GET', CASES('roland'))).body.cases.find((c) => c.caseId === id).txNotInOd;

  assert.equal(await flag(caseId), true);
  assert.equal((await api(baseUrl, 'POST', ENTERED('roland', handoffId, 0), {})).status, 200);
  assert.equal(await flag(caseId), true, 'one of two entered');
  assert.equal((await api(baseUrl, 'POST', ENTERED('roland', handoffId, 1), {})).status, 200);
  assert.equal(await flag(caseId), false, 'all entered');

  // A case whose checkout staged nothing carries no badge.
  db.table('tc_cases').length = 0;
  const empty = await answered(baseUrl, db, 'not_scheduled', { ...SNAPSHOT, procedures: [], priority: null });
  assert.equal(await flag(empty.caseId), false);
  // An ordinary case with no checkout at all carries none either.
  const plain = seedCase(db, { od_patient_id: 12828 });
  assert.equal(await flag(plain.case_id), false);
});

test('C2b-9: the badge is dark when checkout is switched off', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const { caseId } = await answered(baseUrl, db);
  tcCheckout.resetCacheForTests();
  registry.getPlatformSetting = async () => null;
  const list = await api(baseUrl, 'GET', CASES('roland'));
  assert.equal(list.body.cases.find((c) => c.caseId === caseId).txNotInOd, false);
});
