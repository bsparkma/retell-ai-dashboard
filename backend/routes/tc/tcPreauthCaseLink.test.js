'use strict';

/**
 * A pre-auth's "Linked case ID" must be a case in the pre-auth's OWN office.
 *
 *   - create and PUT: a case in this office links; another office's case and
 *     an unknown id are both 404 'Case not found' (NOT_FOUND), the referral
 *     routes' shape — identical bodies, so nothing leaks about the other
 *     office — and NOTHING is saved (no row, no change, no audit)
 *   - PUT caseId: null still clears the link
 *   - the store's cross-office count finds old rows, read only
 *
 * The office is the request's ?office= (requireOffice), as before.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');
const preauthStore = require('./preauthStore');

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const PA = (p = '', office = 'roland') => `/api/tc/preauth${p}?office=${office}`;
const BODY = { patientName: 'Test 2, Stedi', preauthType: 'treatment', insuranceCarrier: 'Delta Dental' };

function seedCase(db, office) {
  const row = { case_id: randomUUID(), office_id: office, patient_name: 'Fixture', status: 'pending_tc' };
  db.table('tc_cases').push(row);
  return row.case_id;
}

const preauthAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_preauth');

test('create: a case in this office links', async (t) => {
  const { baseUrl, db } = await boot(t);
  const mine = seedCase(db, 'roland');
  const r = await api(baseUrl, 'POST', PA(), { ...BODY, caseId: mine });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.preauthCase.caseId, mine);
});

test("create: another office's case and an unknown id are the same 404, and nothing is saved", async (t) => {
  const { baseUrl, db } = await boot(t);
  const theirs = seedCase(db, 'valley');
  const cross = await api(baseUrl, 'POST', PA(), { ...BODY, caseId: theirs });
  const unknown = await api(baseUrl, 'POST', PA(), { ...BODY, caseId: randomUUID() });
  for (const r of [cross, unknown]) {
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { success: false, error: 'Case not found', code: 'NOT_FOUND' });
  }
  assert.equal(db.table('tc_preauth_cases').length, 0);
  assert.equal(preauthAudits(db).length, 0);
});

test('PUT: same-office links; cross-office and unknown 404 and leave the row untouched; null clears', async (t) => {
  const { baseUrl, db } = await boot(t);
  const mine = seedCase(db, 'valley');
  const theirs = seedCase(db, 'roland');
  const created = await api(baseUrl, 'POST', PA('', 'valley'), BODY);
  assert.equal(created.status, 201);
  const id = created.body.preauthCase.preauthId;
  const auditsBefore = preauthAudits(db).length;

  for (const caseId of [theirs, randomUUID()]) {
    const r = await api(baseUrl, 'PUT', PA(`/${id}`, 'valley'), { caseId, notes: 'should not land' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { success: false, error: 'Case not found', code: 'NOT_FOUND' });
  }
  const row = db.table('tc_preauth_cases')[0];
  assert.deepEqual([row.case_id, row.notes], [null, '']);
  assert.equal(preauthAudits(db).length, auditsBefore, 'a refused write is not audited as a change');

  const ok = await api(baseUrl, 'PUT', PA(`/${id}`, 'valley'), { caseId: mine });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.preauthCase.caseId, mine);

  const cleared = await api(baseUrl, 'PUT', PA(`/${id}`, 'valley'), { caseId: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.preauthCase.caseId, null);
});

test('PUT without a caseId does not look one up (other fields unaffected)', async (t) => {
  const { baseUrl, db } = await boot(t);
  const created = await api(baseUrl, 'POST', PA(), BODY);
  const before = db.log.length;
  const r = await api(baseUrl, 'PUT', PA(`/${created.body.preauthCase.preauthId}`), { notes: 'hi' });
  assert.equal(r.status, 200);
  assert.ok(!db.log.slice(before).some((l) => /FROM tc_cases/.test(l.sql)));
});

test('the store counts existing cross-office links by office pair, read only', async () => {
  const seen = [];
  const q = {
    query: async (sql) => {
      seen.push(sql);
      return { rows: [{ preauth_office: 'roland', case_office: 'valley', n: '2' }] };
    },
  };
  const out = await preauthStore.countCrossOfficeCaseLinks(q);
  assert.deepEqual(out, { total: 2, pairs: [{ preauthOffice: 'roland', caseOffice: 'valley', count: 2 }] });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^SELECT /);
  assert.match(seen[0], /c\.office_id <> p\.office_id/);
  assert.doesNotMatch(seen[0], /\b(UPDATE|DELETE|INSERT)\b/i);
});
