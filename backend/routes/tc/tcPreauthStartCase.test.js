'use strict';

/**
 * POST /api/tc/preauth/:id/start-case — put a pre-auth's patient on the
 * pipeline, by the attach-or-create rule the voice handoff, the Opportunities
 * claim and the checkout intake share.
 *
 *   - CREATE: no open case for the PatNum in this office → a pending_tc case
 *     built from the pre-auth ROW (name, phone, email, PatNum, doctor),
 *     assigned to the caller, linked back on the pre-auth
 *   - ATTACH: an open case exists → a timeline note on it, no second case
 *   - the body is the empty strict object: a PatNum, an office, a name or a
 *     case id in it is a 400 and nothing is written
 *   - refusals: unlinked to Open Dental (409 NO_OD_PATIENT), already linked
 *     (409 PREAUTH_ALREADY_LINKED with the case), another office's (404)
 *   - audited: the pre-auth UPDATE and the case CREATE / UPDATE
 *   - Postgres-only: no Open Dental call
 *
 * Test patients only (roland 12827, valley 7115).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const PA = (p = '', office = 'roland') => `/api/tc/preauth${p}?office=${office}`;

const LINKED = {
  patientName: 'Test 2, Stedi',
  preauthType: 'treatment',
  insuranceCarrier: 'Delta Dental',
  doctorName: 'Avery Roland, DDS',
  phone: '555-0100',
  odPatientId: 12827,
};

async function createPreauth(baseUrl, body = LINKED, office = 'roland') {
  const r = await api(baseUrl, 'POST', PA('', office), body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.preauthCase;
}

test('no open case: a new pending_tc case from the ROW, assigned to the caller, linked back, audited', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const pa = await createPreauth(baseUrl);

  const r = await api(baseUrl, 'POST', PA(`/${pa.preauthId}/start-case`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attached, false);
  assert.equal(r.body.url, `/tc/cases/${r.body.caseId}`);
  assert.equal(r.body.preauthCase.caseId, r.body.caseId);

  const cases = db.table('tc_cases');
  assert.equal(cases.length, 1);
  const c = cases[0];
  assert.deepEqual(
    [c.case_id, c.office_id, c.patient_name, Number(c.od_patient_id), c.phone, c.doctor_name, c.status, c.assigned_tc],
    [r.body.caseId, 'roland', 'Test 2, Stedi', 12827, '555-0100', 'Avery Roland, DDS', 'pending_tc', 'tc@carein.ai']
  );
  const events = db.table('tc_case_events').filter((e) => e.case_id === r.body.caseId);
  assert.deepEqual(events.map((e) => [e.type, e.description]), [
    ['case_created', 'Case started from a treatment pre-authorization (Delta Dental)'],
  ]);

  // The case is on the pipeline like any other.
  const listed = await api(baseUrl, 'GET', '/api/tc/cases?office=roland');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok(JSON.stringify(listed.body).includes(r.body.caseId));

  const audits = auditRows(db).map((a) => [a.action, a.resource_type, a.resource_id]);
  assert.ok(audits.some(([a, t2, id]) => a === 'UPDATE' && t2 === 'tc_preauth' && id === pa.preauthId));
  assert.ok(audits.some(([a, t2, id]) => a === 'CREATE' && t2 === 'tc_case' && id === r.body.caseId));
});

test('an open case for the patient: the pre-auth is ATTACHED to it — a note, no second case', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'office' });
  const open = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: 12827, status: 'presented', updated_at: new Date(), created_at: new Date() };
  db.table('tc_cases').push(open);
  // A closed case and another office's open case for the same PatNum never win.
  db.table('tc_cases').push({ case_id: randomUUID(), office_id: 'roland', od_patient_id: 12827, status: 'lost', updated_at: new Date(Date.now() + 1000), created_at: new Date() });
  db.table('tc_cases').push({ case_id: randomUUID(), office_id: 'valley', od_patient_id: 12827, status: 'presented', updated_at: new Date(Date.now() + 2000), created_at: new Date() });
  const pa = await createPreauth(baseUrl);

  const r = await api(baseUrl, 'POST', PA(`/${pa.preauthId}/start-case`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.attached, r.body.caseId], [true, open.case_id]);
  assert.equal(db.table('tc_cases').length, 3, 'no second case');
  const notes = db.table('tc_case_events').filter((e) => e.case_id === open.case_id).map((e) => [e.type, e.description]);
  assert.deepEqual(notes, [['note_added', 'Linked a treatment pre-authorization (Delta Dental) to this case']]);
  assert.equal(db.table('tc_preauth_cases')[0].case_id, open.case_id);
  assert.ok(auditRows(db).some((a) => a.action === 'UPDATE' && a.resource_type === 'tc_case' && a.resource_id === open.case_id));
});

test('strict body: a smuggled PatNum, office, name or case id is a 400 and nothing is written', async (t) => {
  const { baseUrl, db } = await boot(t);
  const pa = await createPreauth(baseUrl);
  for (const body of [
    { odPatientId: 7115 },
    { office: 'valley' },
    { patientName: 'Somebody Else' },
    { caseId: randomUUID() },
  ]) {
    const r = await api(baseUrl, 'POST', PA(`/${pa.preauthId}/start-case`), body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(db.table('tc_cases').length, 0);
  assert.equal(db.table('tc_preauth_cases')[0].case_id, null);
});

test('refusals: not linked to Open Dental, already linked, another office — honest codes, nothing written', async (t) => {
  const { baseUrl, db } = await boot(t);
  const unlinked = await createPreauth(baseUrl, { ...LINKED, odPatientId: undefined });
  const r1 = await api(baseUrl, 'POST', PA(`/${unlinked.preauthId}/start-case`), {});
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'NO_OD_PATIENT');
  assert.equal(db.table('tc_cases').length, 0);

  const pa = await createPreauth(baseUrl);
  const first = await api(baseUrl, 'POST', PA(`/${pa.preauthId}/start-case`), {});
  assert.equal(first.status, 200);
  const again = await api(baseUrl, 'POST', PA(`/${pa.preauthId}/start-case`), {});
  assert.equal(again.status, 409);
  assert.deepEqual([again.body.code, again.body.caseId], ['PREAUTH_ALREADY_LINKED', first.body.caseId]);
  assert.equal(db.table('tc_cases').length, 1, 'a second click makes no second case');

  const valley = await createPreauth(baseUrl, { ...LINKED, patientName: 'TestValley, Stedi', odPatientId: 7115 }, 'valley');
  const cross = await api(baseUrl, 'POST', PA(`/${valley.preauthId}/start-case`, 'roland'), {});
  assert.equal(cross.status, 404);
  assert.equal(db.table('tc_preauth_cases').find((p) => p.preauth_id === valley.preauthId).case_id, null);

  assert.equal((await api(baseUrl, 'POST', PA('/not-a-uuid/start-case'), {})).status, 404);
});

test('a race: the pre-auth was linked between the read and the write — refused, ours rolled back', async (t) => {
  const { baseUrl, db } = await boot(t);
  const pa = await createPreauth(baseUrl);
  const winner = randomUUID();
  // Roll back on ROLLBACK, as Postgres does — except the winner's link, which
  // committed in ITS transaction.
  let snapshot = null;
  db.onQuery(/^BEGIN$/, () => {
    snapshot = new Map([...db.tables].map(([k, rows]) => [k, rows.map((row) => ({ ...row }))]));
    return { rows: [], rowCount: 0 };
  });
  db.onQuery(/^ROLLBACK$/, () => {
    // Every live table, including ones first created after BEGIN (back to empty).
    for (const [k, live] of db.tables) {
      const rows = snapshot.get(k) || [];
      live.length = 0;
      live.push(...rows);
    }
    db.table('tc_preauth_cases')[0].case_id = winner;
    return { rows: [], rowCount: 0 };
  });
  // The other click commits first: the arbiter UPDATE finds case_id set.
  db.onQuery(/^UPDATE tc_preauth_cases SET case_id = \$3/, () => ({ rows: [], rowCount: 0 }));
  const r = await api(baseUrl, 'POST', PA(`/${pa.preauthId}/start-case`), {});
  assert.equal(r.status, 409);
  assert.deepEqual([r.body.code, r.body.caseId], ['PREAUTH_ALREADY_LINKED', winner]);
  assert.equal(db.table('tc_cases').length, 0, 'our case rolled back with the lost link');
  assert.equal(db.table('tc_case_events').length, 0);
});

test('a hygienist cannot start a case from a pre-auth (tc.full)', async (t) => {
  const admin = await boot(t);
  const pa = await createPreauth(admin.baseUrl);
  const hyg = await boot(t, { role: 'hygiene', db: admin.db });
  const r = await api(hyg.baseUrl, 'POST', PA(`/${pa.preauthId}/start-case`), {});
  assert.equal(r.status, 403);
  assert.equal(admin.db.table('tc_cases').length, 0);
});
