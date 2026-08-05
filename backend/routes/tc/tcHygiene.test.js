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
            case_status: c.status,
          };
        }),
      };
    });

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
