'use strict';

/**
 * The responses a referral collects, on the LIST reads (the hub and the case /
 * checkout list), so a card shows them without opening the detail:
 *
 *   received       the specialist confirmed receipt (mark_acknowledged), via
 *                  the email link or marked by staff
 *   patientEmail   the patient email's outcome since the latest send
 *   scheduledDate  already on the row (R5b)
 *
 * Read only: these tests write events straight into the fake to stand for
 * what the link routes and the send record; nothing here sends or moves.
 *
 * Fixture: the Roland test patient (PatNum 12827).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const transitions = require('./referralTransitions');
const contract = require('../../tc/contract.gen.cjs');
const { bootTcApp, api } = require('./tcTestUtils');

const NOW = new Date('2026-10-20T15:00:00.000Z');

function switchReferrals(t) {
  const orig = registry.getPlatformSetting;
  const keep = {
    a: process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND,
    b: process.env.TC_REFERRALS_ENABLED_ROLAND,
  };
  delete process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND;
  delete process.env.TC_REFERRALS_ENABLED_ROLAND;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' ? { key, value: { roland: true }, updated_at: new Date(), updated_by: null } : null;
  tcReferrals.resetCacheForTests();
  transitions.setClockForTests(() => NOW);
  t.after(() => {
    registry.getPlatformSetting = orig;
    if (keep.a === undefined) delete process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND;
    else process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND = keep.a;
    if (keep.b === undefined) delete process.env.TC_REFERRALS_ENABLED_ROLAND;
    else process.env.TC_REFERRALS_ENABLED_ROLAND = keep.b;
    tcReferrals.resetCacheForTests();
    transitions.setClockForTests(null);
  });
}

async function boot(t) {
  const app = await bootTcApp();
  t.after(() => app.close());
  return app;
}

const REF = (p = '', qs = '') => `/api/tc/referrals${p}?office=roland${qs}`;
const SIGN = (p = '') => `/api/tc/referrals/signoff${p}?office=roland`;

async function sentReferral(baseUrl, db) {
  const caseRow = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: 12827, status: 'pending_tc' };
  db.table('tc_cases').push(caseRow);
  const r = await api(baseUrl, 'POST', REF(), {
    source: { caseId: caseRow.case_id },
    referral: { reason: 'Possible cracked tooth', urgency: 'soon', teeth: [3] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.referral.referralId;
  for (const [base, p, body] of [
    [REF, '/submit'],
    [SIGN, '/approve'],
    [REF, '/mark-sent', { how: 'Faxed to the front desk' }],
  ]) {
    const res = await api(baseUrl, 'POST', base(`/${id}${p}`), body ?? {});
    assert.equal(res.status, 200, `${p}: ${JSON.stringify(res.body)}`);
  }
  return { id, caseId: caseRow.case_id };
}

let tick = 0;
/** One history row, as the link routes and the send write them. */
function event(db, referralId, over) {
  tick += 1;
  db.table('tc_referral_events').push({
    event_id: randomUUID(),
    office_id: 'roland',
    referral_id: referralId,
    from_status: 'sent',
    to_status: 'sent',
    actor: 'tc@carein.ai',
    at: new Date(NOW.getTime() + tick * 60_000).toISOString(),
    note: '',
    verb: null,
    ...over,
  });
}

function setRow(db, referralId, fields) {
  const row = db.table('tc_referrals').find((r) => r.referral_id === referralId);
  Object.assign(row, fields);
}

async function hubRow(baseUrl, id) {
  const r = await api(baseUrl, 'GET', REF('/hub'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = r.body.referrals.find((x) => x.referralId === id);
  assert.ok(row, 'the referral is on the hub');
  // The client parses every list row with the shared schema: the fields must pass it.
  assert.equal(contract.TcReferral.safeParse(row).success, true, JSON.stringify(contract.TcReferral.safeParse(row).error));
  return row;
}

test('a sent referral with no responses yet: received null, patientEmail null', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const { id } = await sentReferral(baseUrl, db);
  const row = await hubRow(baseUrl, id);
  assert.equal(row.status, 'sent');
  assert.equal(row.received, null);
  assert.equal(row.patientEmail, null);
});

test('marked received by staff (the real route): received via staff', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const { id } = await sentReferral(baseUrl, db);
  assert.equal((await api(baseUrl, 'POST', REF(`/${id}/mark-acknowledged`), {})).status, 200);
  const row = await hubRow(baseUrl, id);
  assert.equal(row.status, 'acknowledged');
  assert.equal(row.received.via, 'staff');
  assert.equal(typeof row.received.at, 'string');
});

test("confirmed from the specialist's link: received via link, plus the scheduled date and the patient email line", async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const { id } = await sentReferral(baseUrl, db);
  event(db, id, {
    verb: 'patient_email_skipped',
    note: 'Patient not emailed: the patient has no email on file in Open Dental.',
  });
  event(db, id, { verb: 'mark_acknowledged', to_status: 'acknowledged', actor: contract.REFERRAL_LINK_ACTORS.specialist });
  event(db, id, { verb: 'patient_scheduled', from_status: 'acknowledged', to_status: 'acknowledged', actor: contract.REFERRAL_LINK_ACTORS.specialist });
  setRow(db, id, { status: 'acknowledged', scheduled_date: '2026-11-03' });

  const row = await hubRow(baseUrl, id);
  assert.equal(row.received.via, 'link');
  assert.equal(row.scheduledDate, '2026-11-03');
  assert.deepEqual(
    { status: row.patientEmail.status, note: row.patientEmail.note },
    { status: 'skipped', note: 'Patient not emailed: the patient has no email on file in Open Dental.' },
  );
});

test('the case list (GET /?caseId=) carries the same fields, for the case and checkout chip', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const { id, caseId } = await sentReferral(baseUrl, db);
  event(db, id, { verb: 'patient_email_sent', note: 'Patient emailed at the address on file in Open Dental.' });
  const r = await api(baseUrl, 'GET', REF('', `&caseId=${caseId}`));
  assert.equal(r.status, 200);
  const row = r.body.referrals.find((x) => x.referralId === id);
  assert.equal(row.patientEmail.status, 'sent');
  assert.equal(row.received, null);
});

test('a referral not yet sent never carries responses', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const caseRow = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: 12827, status: 'pending_tc' };
  db.table('tc_cases').push(caseRow);
  const created = await api(baseUrl, 'POST', REF(), {
    source: { caseId: caseRow.case_id },
    referral: { reason: 'Perio evaluation', urgency: 'routine', teeth: 'mouth' },
  });
  const id = created.body.referral.referralId;
  // Even a stray event cannot make a draft look received.
  event(db, id, { verb: 'mark_acknowledged', from_status: 'draft', to_status: 'draft' });
  const row = await hubRow(baseUrl, id);
  assert.equal(row.status, 'draft');
  assert.equal(row.received, null);
  assert.equal(row.patientEmail, null);
});

test('office-scoped: another office never sees these referrals', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  await sentReferral(baseUrl, db);
  const r = await api(baseUrl, 'GET', '/api/tc/referrals/hub?office=valley');
  // Valley has referrals off in this test, or simply none: either way, no Roland row.
  assert.ok(r.status !== 200 || r.body.referrals.every((x) => x.officeId === 'valley'));
});
