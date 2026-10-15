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
