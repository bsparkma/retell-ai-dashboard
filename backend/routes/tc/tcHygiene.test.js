'use strict';

/**
 * /api/tc/hygiene-intakes — submit creates case + intake atomically with
 * diagnosing_provider captured; claim assigns the SSO identity and moves the
 * case to pending_tc exactly once.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const INTAKE = {
  patientName: 'Hygiene Patient',
  diagnosingProvider: 'dr.sparkman@carein.ai',
  category: 'single_tooth',
  urgency: 'medium',
  perioStatus: 'gingivitis',
  recallType: 'prophy',
  radiographs: ['BWX'],
  intraoralPhotosTaken: true,
  patientInterestLevel: 'warm',
  flagUrgent: false,
  chiefConcern: 'Cracked tooth #14',
};

test('submit creates the case (hygiene_review) + intake in one transaction', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const res = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', INTAKE);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const c = res.body.case;

    assert.equal(c.status, 'hygiene_review');
    assert.equal(c.officeId, 'valley');
    assert.equal(c.diagnosingProvider, 'dr.sparkman@carein.ai');
    assert.equal(c.doctorName, 'dr.sparkman@carein.ai');
    assert.equal(c.referralSource, 'hygiene');
    assert.equal(c.assignedTc, '');
    // Intake identity is the SSO session, not client input.
    assert.equal(c.hygieneIntake.submittedBy, 'tc@carein.ai');
    assert.equal(c.hygieneIntake.perioStatus, 'gingivitis');

    assert.equal(db.table('tc_cases').length, 1);
    assert.equal(db.table('tc_hygiene_intakes').length, 1);
    assert.ok(auditRows(db).some((r) => r.action === 'CREATE' && r.resource_type === 'tc_hygiene_intake'));
  } finally {
    await close();
  }
});

/**
 * FakeTenantDb refuses JOINs without an override — a harness that silently
 * faked one would pass tests the real database fails. This is the queue join
 * the three list routes share: it must project every column they select,
 * including od_patient_id.
 */
function stubQueueJoin(db) {
  db.onQuery(/FROM tc_hygiene_intakes i JOIN tc_cases c/i, (text, params) => {
    const cases = new Map(db.table('tc_cases').map((c) => [c.case_id, c]));
    let intakes = db.table('tc_hygiene_intakes').filter((i) => i.office_id === params[0]);
    if (/i\.submitted_by = \$2/.test(text)) intakes = intakes.filter((i) => i.submitted_by === params[1]);
    if (/c\.status = 'hygiene_review'/.test(text)) {
      intakes = intakes.filter((i) => cases.get(i.case_id).status === 'hygiene_review');
    }
    return {
      rows: intakes.map((i) => {
        const c = cases.get(i.case_id);
        return {
          ...i,
          patient_name: c.patient_name,
          patient_age: c.patient_age,
          phone: c.phone,
          category: c.category,
          urgency: c.urgency,
          diagnosing_provider: c.diagnosing_provider,
          od_patient_id: c.od_patient_id,
          case_status: c.status,
        };
      }),
    };
  });
}

test('an attached Open Dental patient is stored WITH its office, and surfaces on the queues', async () => {
  // A PatNum is meaningless without the database it came from — 7115 is the
  // Riley test patient and a different, real person in Roland. The case's
  // office_id IS that qualifier: od_patient_id and office_id are written in the
  // same row, by the same insert, from the validated ?office=. The name is
  // snapshotted alongside so the case still reads correctly when nobody can
  // reach Open Dental.
  const { baseUrl, db, close } = await bootTcApp();
  try {
    stubQueueJoin(db);
    const res = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', {
      ...INTAKE,
      patientName: 'Stedi TestValley',
      odPatientId: 7115,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.case.odPatientId, 7115);
    assert.equal(res.body.case.officeId, 'valley');

    const [row] = db.table('tc_cases');
    assert.equal(row.od_patient_id, 7115);
    assert.equal(row.office_id, 'valley', 'the PatNum is only meaningful with its office');
    assert.equal(row.patient_name, 'Stedi TestValley');

    // The TC has to be able to SEE the link before claiming, or they will look
    // the patient up a second time.
    const inbox = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/inbox?office=valley');
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    assert.equal(inbox.body.inbox[0].od_patient_id, 7115);

    const mine = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/mine?office=valley');
    assert.equal(mine.body.intakes[0].od_patient_id, 7115);

    const all = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes?office=valley');
    assert.equal(all.body.intakes[0].od_patient_id, 7115);
  } finally {
    await close();
  }
});

test('an intake with NO Open Dental patient still submits — a new patient is not in OD yet', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const res = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', {
      ...INTAKE,
      patientName: 'Walk In',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.case.odPatientId, null);
    assert.equal(db.table('tc_cases')[0].patient_name, 'Walk In');
  } finally {
    await close();
  }
});

test('submit rejects missing diagnosingProvider and bad clinical enums', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const { diagnosingProvider, ...withoutProvider } = INTAKE;
    const missing = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', withoutProvider);
    assert.equal(missing.status, 400);

    const badPerio = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', {
      ...INTAKE,
      perioStatus: 'terrible',
    });
    assert.equal(badPerio.status, 400);

    assert.equal(db.table('tc_cases').length, 0, 'no case shell on rejection');
    assert.equal(db.table('tc_hygiene_intakes').length, 0);
  } finally {
    await close();
  }
});

test('claim assigns the SSO identity, moves to pending_tc, and works only once', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const submitted = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', INTAKE);
    const caseId = submitted.body.case.caseId;

    const claimed = await api(baseUrl, 'POST', `/api/tc/hygiene-intakes/${caseId}/claim?office=valley`);
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.equal(claimed.body.case.status, 'pending_tc');
    assert.equal(claimed.body.case.assignedTc, 'tc@carein.ai');
    assert.ok(
      claimed.body.case.events.some(
        (e) => e.type === 'status_change' && /hygiene_review → pending_tc/.test(e.description)
      )
    );

    const again = await api(baseUrl, 'POST', `/api/tc/hygiene-intakes/${caseId}/claim?office=valley`);
    assert.equal(again.status, 404, 'a claimed case cannot be claimed again');

    const crossOffice = await api(baseUrl, 'POST', `/api/tc/hygiene-intakes/${caseId}/claim?office=roland`);
    assert.equal(crossOffice.status, 404, 'claim is office-scoped');

    assert.ok(auditRows(db).some((r) => r.action === 'UPDATE' && r.resource_type === 'tc_case'));
  } finally {
    await close();
  }
});

test('mine and inbox are office-scoped queue reads (joined to tc_cases)', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    stubQueueJoin(db);

    const first = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', INTAKE);
    await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', {
      ...INTAKE,
      patientName: 'Second Patient',
    });
    // Claim the first — it should leave the inbox but stay in "mine".
    await api(baseUrl, 'POST', `/api/tc/hygiene-intakes/${first.body.case.caseId}/claim?office=valley`);

    const mine = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/mine?office=valley');
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.intakes.length, 2);

    const inbox = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/inbox?office=valley');
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.inbox.length, 1);
    assert.equal(inbox.body.inbox[0].patient_name, 'Second Patient');

    const rolandInbox = await api(baseUrl, 'GET', '/api/tc/hygiene-intakes/inbox?office=roland');
    assert.equal(rolandInbox.body.inbox.length, 0);
  } finally {
    await close();
  }
});
