'use strict';

/**
 * CO-1 — same-day hygiene routing (Beau, 2026-10-29).
 *
 * A hygiene handoff for a patient with a SAME-DAY checkout entry is not a TC
 * Inbox item: its content is on the checkout card. Only where it SURFACES
 * changes. The case still exists, the checkout card still carries the visit,
 * and a checkout outcome still attaches to that same case.
 *
 * The surface enumeration (what lists hygiene intakes as Inbox items):
 *   GET /api/tc/hygiene-intakes/inbox   the TC Inbox page (TcHygieneInbox) —
 *                                       the ONLY Inbox reader; it changes here.
 * Not Inbox surfaces, unchanged by design: GET /hygiene-intakes (Submissions),
 * GET /hygiene-intakes/mine (My submissions), the Pipeline board's
 * hygiene_review column (GET /cases).
 *
 * Test patients only (roland 12827 / 12828, valley 7115); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const checkoutRoute = require('./checkout');
const checkoutStore = require('./checkoutStore');
const { bootTcApp, api } = require('./tcTestUtils');

const NOW = new Date('2026-10-29T15:00:00.000Z');
const TODAY = '2026-10-29';
const YESTERDAY = '2026-10-28';

const INTAKE = {
  diagnosingProvider: 'dr.example@carein.ai',
  category: 'single_tooth',
  urgency: 'medium',
  perioStatus: 'gingivitis',
  recallType: 'prophy',
  radiographs: ['BWX'],
  intraoralPhotosTaken: true,
  patientInterestLevel: 'warm',
  flagUrgent: false,
  chiefConcern: 'Staged at the hygiene visit',
};

const SNAPSHOT = {
  procedures: [
    { teeth: [3], code: 'Crown', category: 'Restorative', priority: 'urgent', status: 'proposed', surfaces: ['O'], scheduleNext: false, note: '' },
  ],
  priority: 'urgent',
  nextVisit: { type: null, intervalMonths: null, lengthMin: null, withDoctor: false, rtc: '' },
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

/** The queue JOIN (FakeTenantDb refuses JOINs): the inbox's projection, faithfully. */
function stubQueueJoin(db) {
  db.onQuery(/FROM tc_hygiene_intakes i JOIN tc_cases c/i, (text, params) => {
    const cases = new Map(db.table('tc_cases').map((c) => [c.case_id, c]));
    let intakes = db.table('tc_hygiene_intakes').filter((i) => i.office_id === params[0]);
    if (/c\.status = 'hygiene_review'/.test(text)) {
      intakes = intakes.filter((i) => cases.get(i.case_id).status === 'hygiene_review');
    }
    return {
      rows: intakes.map((i) => {
        const c = cases.get(i.case_id);
        return { ...i, patient_name: c.patient_name, patient_age: c.patient_age, phone: c.phone, category: c.category, urgency: c.urgency, diagnosing_provider: c.diagnosing_provider, od_patient_id: c.od_patient_id, case_status: c.status };
      }),
    };
  });
}

async function boot(t) {
  const app = await bootTcApp();
  t.after(() => app.close());
  stubQueueJoin(app.db);
  return app;
}

async function intake(baseUrl, { office = 'roland', patientName, odPatientId, visitDate }) {
  const r = await api(baseUrl, 'POST', `/api/tc/hygiene-intakes?office=${office}`, {
    ...INTAKE,
    patientName,
    odPatientId,
    ...(visitDate ? { visitDate } : {}),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.case;
}

function handoff(db, { office = 'roland', odPatientId, patientName, visitDate = TODAY, status = 'open', ...over }) {
  const row = {
    handoff_id: randomUUID(),
    office_id: office,
    source_key: `hyg-visit:${randomUUID()}:checkout`,
    od_patient_id: odPatientId,
    patient_name: patientName,
    provider: 'DOC1',
    provider_seen: 'HYG1',
    operatory: 'Hyg 1',
    visit_date: visitDate,
    payload: SNAPSHOT,
    is_final: true,
    revision: 1,
    submitted_by: 'hygienist@carein.ai',
    updated_by: 'hygienist@carein.ai',
    status,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
  db.table('tc_checkout_handoffs').push(row);
  return row;
}

const inboxNames = async (baseUrl, office = 'roland') => {
  const r = await api(baseUrl, 'GET', `/api/tc/hygiene-intakes/inbox?office=${office}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.inbox.map((i) => i.patient_name).sort();
};

test('a same-day hygiene intake is ABSENT from the Inbox and PRESENT on the checkout card; a non-same-day one stays in the Inbox', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  await intake(baseUrl, { patientName: 'Test 2, Stedi', odPatientId: 12827, visitDate: TODAY });
  await intake(baseUrl, { patientName: 'Test, MangoTest', odPatientId: 12828, visitDate: TODAY });
  const card = handoff(db, { odPatientId: 12827, patientName: 'Test 2, Stedi' });
  // 12828's checkout is for ANOTHER day: not same-day, so 12828 stays.
  handoff(db, { odPatientId: 12828, patientName: 'Test, MangoTest', visitDate: YESTERDAY, status: 'expired', expired_at: NOW, expired_by: 'system:checkout_expiry' });

  assert.deepEqual(await inboxNames(baseUrl), ['Test, MangoTest']);

  // The checkout card carries the visit.
  const waiting = await api(baseUrl, 'GET', '/api/tc/checkout?office=roland&view=waiting');
  assert.deepEqual(waiting.body.handoffs.map((h) => h.handoffId), [card.handoff_id]);
  assert.equal(waiting.body.handoffs[0].snapshot.procedures[0].code, 'Crown');

  // The case is untouched: still hygiene_review, still the patient's open case.
  const cases = db.table('tc_cases').filter((c) => Number(c.od_patient_id) === 12827);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].status, 'hygiene_review');
});

test('case-joining is unchanged: the checkout outcome still attaches to the same-day hygiene case', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const c = await intake(baseUrl, { patientName: 'Test 2, Stedi', odPatientId: 12827, visitDate: TODAY });
  const card = handoff(db, { odPatientId: 12827, patientName: 'Test 2, Stedi' });
  const r = await api(baseUrl, 'POST', `/api/tc/checkout/${card.handoff_id}/outcome?office=roland`, { outcome: 'not_scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attached, true);
  assert.equal(r.body.caseId, c.caseId);
});

test('every holding status keeps it on the card; dismissed and expired hand it back to the Inbox', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  await intake(baseUrl, { patientName: 'Test 2, Stedi', odPatientId: 12827, visitDate: TODAY });
  const h = handoff(db, { odPatientId: 12827, patientName: 'Test 2, Stedi' });
  for (const status of ['open', 'claimed', 'scheduled', 'not_scheduled', 'nothing_needed']) {
    h.status = status;
    assert.deepEqual(await inboxNames(baseUrl), [], status);
  }
  for (const status of checkoutStore.RELEASES_INBOX_STATUSES) {
    h.status = status;
    assert.deepEqual(await inboxNames(baseUrl), ['Test 2, Stedi'], status);
  }
});

test('office-scoped: a same-day checkout in ANOTHER office never hides this office\'s intake (PatNums restart per database)', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  // The same number in two databases is two different people.
  await intake(baseUrl, { office: 'roland', patientName: 'Roland Fixture', odPatientId: 7115, visitDate: TODAY });
  await intake(baseUrl, { office: 'valley', patientName: 'Stedi TestValley', odPatientId: 7115, visitDate: TODAY });
  handoff(db, { office: 'valley', odPatientId: 7115, patientName: 'Stedi TestValley' });
  assert.deepEqual(await inboxNames(baseUrl, 'roland'), ['Roland Fixture']);
  assert.deepEqual(await inboxNames(baseUrl, 'valley'), []);
  const read = db.log.find((l) => /FROM tc_checkout_handoffs WHERE office_id = \$1 AND od_patient_id = ANY/.test(l.sql));
  assert.ok(read, 'one office-scoped read');
  assert.doesNotMatch(read.sql, /SELECT \*/);
});

test('no PatNum, or no same day, means nothing to match on: the intake stays in the Inbox', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  await intake(baseUrl, { patientName: 'Unlinked Patient', odPatientId: null, visitDate: TODAY });
  await intake(baseUrl, { patientName: 'Test 2, Stedi', odPatientId: 12827, visitDate: YESTERDAY });
  handoff(db, { odPatientId: 12827, patientName: 'Test 2, Stedi', visitDate: TODAY });
  assert.deepEqual(await inboxNames(baseUrl), ['Test 2, Stedi', 'Unlinked Patient']);
});

test('an intake with no visit date matches on the office day it was submitted', () => {
  const claimed = checkoutStore.claimedBySameDayCheckout(
    [
      { od_patient_id: 12827, day: TODAY },
      { od_patient_id: 12827, day: null },
    ],
    [{ od_patient_id: '12827', visit_date: TODAY, status: 'open' }]
  );
  assert.deepEqual(claimed, [true, false]);
});
