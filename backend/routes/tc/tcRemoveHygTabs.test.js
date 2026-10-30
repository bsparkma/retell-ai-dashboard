'use strict';

/**
 * CO-2 — the TC app's Hygiene tabs are gone; the plumbing behind them is not.
 *
 * Beau's ruling (2026-10-29) removes SCREENS: the TC app's handoff form and
 * its Submissions list. The hygiene app keeps sending to TC exactly as today,
 * through the same POST /api/tc/hygiene-intakes, and the TC Inbox keeps listing
 * what it listed. This file pins that from the server's side:
 *
 *  - the routes only those screens called (GET / and GET /hygienists) answer
 *    404; POST /, /mine, /inbox and the claim still answer
 *  - the Inbox still lists a hygiene treatment handoff and an ortho screening
 *    that have no same-day checkout, and a TC can still claim one
 *  - a call sent to TC still opens its case as before. It goes to the Pipeline
 *    (pending_tc), as it did before CO-2 — the Inbox has only ever listed
 *    hygiene_review cases, so no non-hygiene source feeds it (see the report)
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const hygContract = require('../../hyg/contract.gen.cjs');
const { bootTcApp, api } = require('./tcTestUtils');

const INTAKE = {
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
};

/** The Inbox JOIN (FakeTenantDb refuses JOINs): its projection, faithfully. */
function stubQueueJoin(db) {
  db.onQuery(/FROM tc_hygiene_intakes i\s+JOIN tc_cases c/i, (text, params) => {
    const cases = new Map(db.table('tc_cases').map((c) => [c.case_id, c]));
    let intakes = db.table('tc_hygiene_intakes').filter((i) => i.office_id === params[0]);
    if (/c\.status = 'hygiene_review'/.test(text)) {
      intakes = intakes.filter((i) => cases.get(i.case_id).status === 'hygiene_review');
    }
    if (/i\.submitted_by = \$2/.test(text)) intakes = intakes.filter((i) => i.submitted_by === params[1]);
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

test('CO-2: only the removed screens\' routes are gone; the handoff, /mine, /inbox and the claim still answer', async (t) => {
  const { baseUrl } = await boot(t);
  const posted = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', {
    ...INTAKE, patientName: 'Test 2, Stedi', odPatientId: 12827,
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));

  assert.equal((await api(baseUrl, 'GET', '/api/tc/hygiene-intakes?office=roland')).status, 404);
  assert.equal((await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/hygienists?office=roland')).status, 404);

  assert.equal((await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/mine?office=roland')).status, 200);
  assert.equal((await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/inbox?office=roland')).status, 200);
  const claimed = await api(baseUrl, 'POST', `/api/tc/hygiene-intakes/${posted.body.case.caseId}/claim?office=roland`);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.case.status, 'pending_tc');
});

test('CO-2: the Inbox still lists a hygiene treatment handoff and an ortho screening with no same-day checkout', async (t) => {
  const { baseUrl } = await boot(t);
  for (const body of [
    { ...INTAKE, patientName: 'Test 2, Stedi', odPatientId: 12827, visitDate: '2026-10-20' },
    {
      ...INTAKE,
      patientName: 'Test, MangoTest',
      odPatientId: 12828,
      category: 'ortho',
      urgency: 'elective',
      caseType: 'Ortho screening',
      orthoScreening: { ...hygContract.emptyOrthoScreening(), interest: 'yes', concerns: ['crowding'], months: [12] },
    },
  ]) {
    const r = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const inbox = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/inbox?office=roland');
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  assert.deepEqual(inbox.body.inbox.map((i) => i.patient_name).sort(), ['Test 2, Stedi', 'Test, MangoTest']);
});

test('CO-2: a call sent to TC still opens its case, in the Pipeline, exactly as before', async (t) => {
  const { baseUrl, db } = await boot(t);
  const res = await api(baseUrl, 'POST', '/api/tc/cases/from-call', {
    od_patient_id: 12827,
    office: 'roland',
    call_id: 'mango_call_co2',
    patient_name: 'Test 2, Stedi',
    call_summary: 'Caller asked about a crown estimate.',
    call_url: '/calls/mango_call_co2',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [row] = db.table('tc_cases');
  assert.equal(row.status, 'pending_tc');
  const inbox = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/inbox?office=roland');
  assert.deepEqual(inbox.body.inbox, [], 'a call was never an Inbox item; CO-2 does not change that');
});
