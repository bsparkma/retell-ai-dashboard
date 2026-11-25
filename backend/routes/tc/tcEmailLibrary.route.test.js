'use strict';

/**
 * /api/tc/email-library (EL-1): catalog, profile, preview. DARK.
 *
 *   W  who: reads are tc.full (admin, office, tc); PUT /profile also needs
 *      admin.all, so office and tc are refused 403 and nothing is saved
 *   O  the office is ?office= (requireOffice); a missing / foreign office is a 400
 *   P  PUT replaces the whole object, reads back, audits one row; GET returns it
 *   V  refusals carry the validator's code and save nothing; office_name and
 *      office_phone are refused
 *   M  GET /profile: `missing` only for a setting some email still prints as a
 *      {{token}} (none in 1.2.0); `blankOptional` names the blank optional ones
 *   R  a saved row carrying a RETIRED key (review_link) reads back without it
 *      and without the STALE 409, the row untouched; a PUT sending it is
 *      refused; any other unknown saved key is still STALE
 *   C  the catalog drops office_name / office_phone, follows services_off, and
 *      says clinicallyApproved: true (EL-2)
 *   X  preview: saved or unsaved answers, never persisted; unset merge values
 *      are returned unresolved and listed; office name + phone come from the
 *      email identity; first_name is the sample; sender is the signed-in user
 *   L  the generic PUT /api/tc/library/:section cannot reach the profile table
 *   N  nothing writes a tc_messages row
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../platform/registry');
const emailIdentity = require('../../config/emailIdentity');
const contract = require('../../tc/contract.gen.cjs');
const { FakeTenantDb, bootTcApp, api, auditRows } = require('./tcTestUtils');

const BASE = '/api/tc/email-library';
const q = (path, office = 'roland') => `${BASE}${path}?office=${office}`;
const ENV_KEYS = ['TC_EMAIL_PRACTICE_PHONE_ROLAND', 'TC_EMAIL_PRACTICE_PHONE_VALLEY', 'TC_EMAIL_PRACTICE_NAME_ROLAND'];

/**
 * The fake store keeps a jsonb column it does not know about as the JSON text it
 * was given; real pg hands back an object. Parse on the way out so the route
 * sees what it would see in production.
 */
class ProfileDb extends FakeTenantDb {
  async query(sql, params) {
    const out = await super.query(sql, params);
    for (const r of out.rows || []) if (typeof r.answers === 'string') r.answers = JSON.parse(r.answers);
    return out;
  }
}

async function boot(t, { role = 'admin', db = new ProfileDb(), env = {}, user } = {}) {
  const originals = { get: registry.getPlatformSetting, env: Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) };
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  registry.getPlatformSetting = async () => null;
  emailIdentity.resetCacheForTests();
  const app = await bootTcApp({ db, role, ...(user ? { user } : {}) });
  t.after(async () => {
    await app.close();
    registry.getPlatformSetting = originals.get;
    for (const k of ENV_KEYS) {
      if (originals.env[k] === undefined) delete process.env[k];
      else process.env[k] = originals.env[k];
    }
    emailIdentity.resetCacheForTests();
  });
  return app;
}

const profiles = (db) => db.table('tc_email_library_profile');
const libAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_email_library_profile');

const SAMPLE = {
  same_day_crowns: true,
  same_day_length: 'about two hours',
  sedation: ['nitrous'],
  doctor_name: 'Dr. Sample',
  schedule_link: 'https://book.example.test/sample',
  services_off: ['braces'],
};

test('W: reads are open to tc.full; PUT needs admin.all and refuses office and tc', async (t) => {
  for (const role of ['admin', 'office', 'tc']) {
    const { baseUrl } = await boot(t, { role });
    for (const path of ['/catalog', '/profile']) {
      const r = await api(baseUrl, 'GET', q(path));
      assert.equal(r.status, 200, `${role} GET ${path}`);
    }
    const p = await api(baseUrl, 'POST', q('/preview'), { procedure_id: 'crown', stage: 'tp_recap', variant: 'A' });
    assert.equal(p.status, 200, `${role} preview`);
  }
  for (const role of ['office', 'tc']) {
    const db = new ProfileDb();
    const { baseUrl } = await boot(t, { role, db });
    const r = await api(baseUrl, 'PUT', q('/profile'), { answers: SAMPLE });
    assert.equal(r.status, 403, role);
    assert.equal(r.body.code, 'FORBIDDEN');
    assert.equal(r.body.action, 'admin.all');
    assert.equal(profiles(db).length, 0, `${role}: nothing saved`);
    const g = await api(baseUrl, 'GET', q('/profile'));
    assert.equal(g.body.canEdit, false, `${role} sees it read-only`);
  }
  for (const role of ['hygiene', 'doctor', 'reviewer']) {
    const { baseUrl } = await boot(t, { role });
    const r = await api(baseUrl, 'GET', q('/catalog'));
    assert.equal(r.status, 403, `${role} has no tc.full`);
  }
});

test('O: the office is ?office=, required and one of the tenant offices', async (t) => {
  const { baseUrl } = await boot(t);
  assert.equal((await api(baseUrl, 'GET', `${BASE}/catalog`)).status, 400);
  assert.equal((await api(baseUrl, 'GET', q('/catalog', 'unknown'))).status, 400);
  assert.equal((await api(baseUrl, 'GET', q('/catalog', 'elsewhere'))).status, 400);
  // A body office is not a key the strict request knows.
  const r = await api(baseUrl, 'PUT', q('/profile'), { answers: {}, office: 'valley' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'VALIDATION_FAILED');
});

test('P: PUT replaces the whole object, reads back, audits; GET returns it; offices stay apart', async (t) => {
  const db = new ProfileDb();
  const { baseUrl } = await boot(t, { db });

  const before = await api(baseUrl, 'GET', q('/profile'));
  assert.equal(before.status, 200);
  assert.equal(before.body.saved, false);
  assert.deepEqual(before.body.answers, {});
  assert.equal(before.body.canEdit, true);

  const put = await api(baseUrl, 'PUT', q('/profile'), { answers: { ...SAMPLE, doctor_name: '  Dr. Sample  ' } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(contract.EmailLibraryProfileResponse.safeParse(put.body).success, true, 'the answer matches its contract');
  assert.equal(put.body.saved, true);
  assert.equal(put.body.answers.doctor_name, 'Dr. Sample', 'trimmed');
  assert.equal(put.body.libraryVersion, '1.3.0');
  assert.equal(put.body.updatedBy, 'tc@carein.ai');
  assert.ok(put.body.updatedAt);

  const rows = profiles(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].office_id, 'roland');
  assert.equal(rows[0].office_name, undefined);

  const audits = libAudits(db);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'UPDATE');
  assert.equal(audits[0].resource_id, 'roland');
  assert.equal(audits[0].prior_state, 'unset');

  // Whole-object replace: a key left out is gone, not kept.
  const second = await api(baseUrl, 'PUT', q('/profile'), { answers: { cbct: true } });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.answers, { cbct: true });
  assert.equal(libAudits(db).length, 2);
  assert.equal(libAudits(db)[1].prior_state, 'stored');

  const got = await api(baseUrl, 'GET', q('/profile'));
  assert.deepEqual(got.body.answers, { cbct: true });

  // The other office has its own (empty) profile.
  const valley = await api(baseUrl, 'GET', q('/profile', 'valley'));
  assert.equal(valley.body.saved, false);
  assert.deepEqual(valley.body.answers, {});
});

test('P: a read-back that disagrees is a 500, nothing is audited', async (t) => {
  class Tamper extends ProfileDb {
    async query(sql, params) {
      const out = await super.query(sql, params);
      if (/^SELECT office_id, answers/.test(String(sql).trim())) for (const r of out.rows) r.answers = { cbct: false };
      return out;
    }
  }
  const db = new Tamper();
  const { baseUrl } = await boot(t, { db });
  const r = await api(baseUrl, 'PUT', q('/profile'), { answers: { cbct: true } });
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'EMAIL_LIBRARY_READBACK_MISMATCH');
  assert.equal(libAudits(db).length, 0);
});

test('V: refusals carry the validator code and save nothing', async (t) => {
  const db = new ProfileDb();
  const { baseUrl } = await boot(t, { db });
  const C = contract.EMAIL_LIBRARY_ANSWER_CODES;
  const cases = [
    [{ office_name: 'Sample Dental' }, C.OFFICE_FIELD, 'office_name'],
    [{ office_phone: '(555) 555-0100' }, C.OFFICE_FIELD, 'office_phone'],
    [{ favorite_color: 'blue' }, C.UNKNOWN_KEY, 'favorite_color'],
    [{ laser: 'yes' }, C.NOT_BOOLEAN, 'laser'],
    [{ whitening_type: 'glow' }, C.BAD_OPTION, 'whitening_type'],
    [{ services_off: ['moon_landing'] }, C.BAD_PROCEDURE, 'services_off'],
    [{ amenities: 'warm {blankets}' }, C.TEXT_FORBIDDEN_CHARACTER, 'amenities'],
    [{ doctor_name: 'x'.repeat(121) }, C.TEXT_TOO_LONG, 'doctor_name'],
    [{ cancel_hours: '200' }, C.CANCEL_HOURS, 'cancel_hours'],
    [{ schedule_link: 'http://book.example.test' }, C.LINK, 'schedule_link'],
    // Retired in 1.2.0: refused as an unknown key, never stored.
    [{ review_link: 'https://review.example.test' }, C.UNKNOWN_KEY, 'review_link'],
  ];
  for (const [answers, code, field] of cases) {
    const r = await api(baseUrl, 'PUT', q('/profile'), { answers });
    assert.equal(r.status, 400, JSON.stringify(answers));
    assert.equal(r.body.code, code, JSON.stringify(answers));
    assert.equal(r.body.field, field);
  }
  // The same validator guards unsaved preview answers.
  const p = await api(baseUrl, 'POST', q('/preview'), {
    procedure_id: 'crown',
    stage: 'tp_recap',
    variant: 'A',
    answers: { office_phone: '(555) 555-0100' },
  });
  assert.equal(p.status, 400);
  assert.equal(p.body.code, C.OFFICE_FIELD);
  assert.equal(profiles(db).length, 0);
  assert.equal(libAudits(db).length, 0);
});

test('M: GET /profile with blank answers: nothing missing, both optional settings blank', async (t) => {
  const { baseUrl } = await boot(t);
  const empty = await api(baseUrl, 'GET', q('/profile'));
  assert.equal(empty.status, 200);
  assert.equal(contract.EmailLibraryProfileResponse.safeParse(empty.body).success, true);
  assert.deepEqual(empty.body.missing, []);
  assert.deepEqual(empty.body.blankOptional, ['schedule_link', 'doctor_name']);

  await api(baseUrl, 'PUT', q('/profile'), { answers: { doctor_name: 'Dr. Sample' } });
  const half = await api(baseUrl, 'GET', q('/profile'));
  assert.deepEqual(half.body.missing, []);
  assert.deepEqual(half.body.blankOptional, ['schedule_link']);

  const put = await api(baseUrl, 'PUT', q('/profile'), { answers: SAMPLE });
  assert.deepEqual(put.body.blankOptional, [], 'the PUT read-back carries it too');
  const after = await api(baseUrl, 'GET', q('/profile'));
  assert.deepEqual(after.body.missing, []);
  assert.deepEqual(after.body.blankOptional, []);
});

/** A row as an office saved it under library 1.1.0, written straight into the fake store. */
function seedStoredRow(db, answers, office = 'roland') {
  profiles(db).push({
    office_id: office,
    answers: JSON.stringify(answers),
    library_version: '1.1.0',
    updated_by: 'admin@example.test',
    updated_at: new Date('2026-11-19T15:00:00.000Z'),
  });
}
const storedAnswers = (row) => (typeof row.answers === 'string' ? JSON.parse(row.answers) : row.answers);

test('R: a stored 1.1.0 row carrying review_link reads back without it, with no 409, and is not rewritten', async (t) => {
  assert.deepEqual([...contract.EMAIL_LIBRARY_RETIRED_SAVED_KEYS], ['review_link']);
  const db = new ProfileDb();
  seedStoredRow(db, { cbct: true, schedule_link: 'https://book.example.test/sample', review_link: 'https://review.example.test/sample' });
  const { baseUrl } = await boot(t, { db });

  const prof = await api(baseUrl, 'GET', q('/profile'));
  assert.equal(prof.status, 200, JSON.stringify(prof.body));
  assert.equal(contract.EmailLibraryProfileResponse.safeParse(prof.body).success, true, 'the answer matches its strict contract');
  assert.deepEqual(prof.body.answers, { cbct: true, schedule_link: 'https://book.example.test/sample' });
  assert.equal(prof.body.saved, true);
  assert.equal(prof.body.libraryVersion, '1.1.0', 'reported as saved');
  assert.deepEqual(prof.body.missing, []);
  assert.deepEqual(prof.body.blankOptional, ['doctor_name']);

  const cat = await api(baseUrl, 'GET', q('/catalog'));
  assert.equal(cat.status, 200, JSON.stringify(cat.body));

  const prev = await api(baseUrl, 'POST', q('/preview'), { procedure_id: 'crown', stage: 'tp_recap', variant: 'A' });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.answersSource, 'saved');
  assert.match(prev.body.bodyText, /https:\/\/book\.example\.test\/sample/);
  assert.ok(!prev.body.bodyText.includes('review.example.test'));

  // Reads never write: the row still holds the retired key until the next save.
  assert.equal(profiles(db).length, 1);
  assert.equal(storedAnswers(profiles(db)[0]).review_link, 'https://review.example.test/sample');
  assert.equal(libAudits(db).length, 0);

  // The office's next save drops it.
  const put = await api(baseUrl, 'PUT', q('/profile'), { answers: prof.body.answers });
  assert.equal(put.status, 200);
  assert.equal(storedAnswers(profiles(db)[0]).review_link, undefined);
});

test('R: a PUT sending review_link is refused and saves nothing', async (t) => {
  const db = new ProfileDb();
  const { baseUrl } = await boot(t, { db });
  const r = await api(baseUrl, 'PUT', q('/profile'), { answers: { cbct: true, review_link: 'https://review.example.test' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, contract.EMAIL_LIBRARY_ANSWER_CODES.UNKNOWN_KEY);
  assert.equal(r.body.field, 'review_link');
  const p = await api(baseUrl, 'POST', q('/preview'), {
    procedure_id: 'crown',
    stage: 'tp_recap',
    variant: 'A',
    answers: { review_link: 'https://review.example.test' },
  });
  assert.equal(p.status, 400, 'unsaved preview answers are not tolerated either');
  assert.equal(p.body.code, contract.EMAIL_LIBRARY_ANSWER_CODES.UNKNOWN_KEY);
  assert.equal(profiles(db).length, 0);
});

test('R: any other unknown saved key is still the STALE 409', async (t) => {
  const db = new ProfileDb();
  seedStoredRow(db, { cbct: true, review_link: 'https://review.example.test', favorite_color: 'blue' });
  const { baseUrl } = await boot(t, { db });
  const calls = [
    ['GET', '/profile', undefined],
    ['GET', '/catalog', undefined],
    ['POST', '/preview', { procedure_id: 'crown', stage: 'tp_recap', variant: 'A' }],
  ];
  for (const [method, path, body] of calls) {
    const r = await api(baseUrl, method, q(path), body);
    assert.equal(r.status, 409, method + ' ' + path);
    assert.equal(r.body.code, 'EMAIL_LIBRARY_SAVED_ANSWERS_STALE');
    assert.equal(r.body.field, 'favorite_color');
  }
});

test('C: the catalog drops the office fields, follows services_off, and is approved', async (t) => {
  const { baseUrl } = await boot(t);
  const before = await api(baseUrl, 'GET', q('/catalog'));
  assert.equal(before.status, 200);
  assert.equal(contract.EmailLibraryCatalogResponse.safeParse(before.body).success, true);
  assert.equal(before.body.clinicallyApproved, true);
  assert.equal(before.body.libraryVersion, '1.3.0');
  assert.equal(before.body.procedures.length, 36);
  assert.equal(before.body.emailCount, 1872);
  const ids = before.body.questions.map((x) => x.id);
  assert.ok(!ids.includes('office_name') && !ids.includes('office_phone'));
  assert.ok(!ids.includes('review_link'), 'the review-link question is gone');
  assert.ok(!before.body.stages.some((s) => s.id === 'review_referral'), 'the review stage is gone');
  assert.equal(ids.length, 25, 'the source has 27 questions; two are the office fields');

  await api(baseUrl, 'PUT', q('/profile'), { answers: { services_off: ['braces', 'full_arch'], insurance_mode: 'no_insurance' } });
  const after = await api(baseUrl, 'GET', q('/catalog'));
  assert.equal(after.body.procedures.length, 34);
  assert.ok(!after.body.procedures.some((p) => p.id === 'braces'));
  assert.equal(after.body.allProcedures.length, 36);
  assert.equal(after.body.stages.find((s) => s.id === 'benefits_deadline').inUse, false);
});

test('X: preview with unset values returns them unresolved and lists them', async (t) => {
  const db = new ProfileDb();
  const { baseUrl } = await boot(t, { db });
  const r = await api(baseUrl, 'POST', q('/preview'), { procedure_id: 'crown', stage: 'tp_recap', variant: 'A' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(contract.EmailLibraryPreviewResponse.safeParse(r.body).success, true);
  assert.equal(r.body.answersSource, 'saved');
  assert.equal(r.body.clinicallyApproved, true);
  assert.match(r.body.subject, /Jordan/, 'first_name is the sample');
  // No phone configured: it stays a token. No scheduling link saved: since
  // 1.2.0 the booking sentence is simply absent, never a {{schedule_link}} hole.
  assert.ok(r.body.unresolved.includes('office_phone'));
  assert.ok(!r.body.unresolved.includes('schedule_link'));
  assert.ok(!r.body.bodyText.includes('{{schedule_link}}'));
  assert.match(r.body.bodyText, /\{\{office_phone\}\}/);
  assert.ok(!r.body.bodyText.includes('the office\n'), 'never the send-time "the office" filler');
  // The signed-in user's display name signs it.
  assert.match(r.body.bodyText, /TC User/);
  assert.ok(!r.body.unresolved.includes('sender_name'));
  assert.equal(profiles(db).length, 0, 'a preview persists nothing');
});

test('X: unsaved answers fill what they set; the identity phone fills office_phone; nothing is persisted', async (t) => {
  const db = new ProfileDb();
  const { baseUrl } = await boot(t, { db, env: { TC_EMAIL_PRACTICE_PHONE_ROLAND: '(555) 555-0142' } });
  const r = await api(baseUrl, 'POST', q('/preview'), {
    procedure_id: 'crown',
    stage: 'tp_recap',
    variant: 'A',
    answers: { schedule_link: 'https://book.example.test/sample' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.answersSource, 'unsaved');
  assert.match(r.body.bodyText, /https:\/\/book\.example\.test\/sample/);
  assert.match(r.body.bodyText, /\(555\) 555-0142/);
  assert.deepEqual(r.body.unresolved, []);
  assert.equal(profiles(db).length, 0);
  assert.equal(libAudits(db).length, 0);
});

test('X: a user with no display name leaves sender_name unresolved', async (t) => {
  const { baseUrl } = await boot(t, { user: { email: 'tc@carein.ai', tenantId: 'x' } });
  const r = await api(baseUrl, 'POST', q('/preview'), { procedure_id: 'filling', stage: 'check_in', variant: 'B' });
  assert.equal(r.status, 200);
  assert.ok(r.body.unresolved.includes('sender_name'));
});

test('X: preview refuses unknown picks and emails that are not in this office library', async (t) => {
  const { baseUrl } = await boot(t);
  const pick = (over) => api(baseUrl, 'POST', q('/preview'), { procedure_id: 'crown', stage: 'tp_recap', variant: 'A', ...over });
  assert.equal((await pick({ procedure_id: 'nope' })).body.code, 'EMAIL_LIBRARY_UNKNOWN_PROCEDURE');
  assert.equal((await pick({ stage: 'nope' })).body.code, 'EMAIL_LIBRARY_UNKNOWN_STAGE');
  assert.equal((await pick({ variant: 'Z' })).body.code, 'EMAIL_LIBRARY_UNKNOWN_VARIANT');
  const off = await pick({ procedure_id: 'braces', answers: { services_off: ['braces'] } });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, 'EMAIL_LIBRARY_SERVICE_OFF');
  const strict = await api(baseUrl, 'POST', q('/preview'), { procedure_id: 'crown', stage: 'tp_recap', variant: 'A', case_id: 'x' });
  assert.equal(strict.status, 400, 'no case id is accepted');
});

test('L: the generic library route cannot reach the profile table', async (t) => {
  assert.ok(!Object.keys(contract.LibrarySectionSchemas).some((k) => /email|profile/i.test(k)), 'not a library section');
  const db = new ProfileDb();
  const { baseUrl } = await boot(t, { db });
  for (const section of ['tc_email_library_profile', 'email_library', 'email_library_profile']) {
    const r = await api(baseUrl, 'PUT', `/api/tc/library/${section}?office=roland`, { answers: SAMPLE });
    assert.equal(r.status, 400, section);
    assert.equal(r.body.code, 'UNKNOWN_SECTION');
  }
  assert.equal(profiles(db).length, 0);
});

test('N: the whole surface writes no tc_messages row', async (t) => {
  const db = new ProfileDb();
  const { baseUrl } = await boot(t, { db });
  await api(baseUrl, 'GET', q('/catalog'));
  await api(baseUrl, 'PUT', q('/profile'), { answers: SAMPLE });
  await api(baseUrl, 'GET', q('/profile'));
  for (const stage of ['tp_recap', 'scheduled_confirm', 'post_op_checkin']) {
    await api(baseUrl, 'POST', q('/preview'), { procedure_id: 'crown', stage, variant: 'C' });
  }
  assert.equal(db.table('tc_messages').length, 0);
  assert.equal(db.table('tc_communications').length, 0);
});

test('EL-1c: PUT /profile round-trips all six 1.3.0 answers; the catalog lists 25 questions', async (t) => {
  const db = new ProfileDb();
  const { baseUrl } = await boot(t, { db });
  const answers = {
    surgical_guides: true,
    immediate_implants: true,
    new_patient_welcome: ['xrays', 'meet_doctor', 'coffee'],
    sedation_kids: ['nitrous'],
    parent_in_room: 'child_first',
    sleep_test: 'home_test',
  };
  const put = await api(baseUrl, 'PUT', q('/profile'), { answers });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(contract.EmailLibraryProfileResponse.safeParse(put.body).success, true);
  assert.deepEqual(put.body.answers, answers);
  assert.equal(put.body.libraryVersion, '1.3.0');
  const got = await api(baseUrl, 'GET', q('/profile'));
  assert.deepEqual(got.body.answers, answers);

  const cat = await api(baseUrl, 'GET', q('/catalog'));
  assert.equal(cat.status, 200);
  assert.equal(contract.EmailLibraryCatalogResponse.safeParse(cat.body).success, true);
  const ids = cat.body.questions.map((x) => x.id);
  assert.equal(ids.length, 25);
  assert.ok(!ids.includes('office_name') && !ids.includes('office_phone'));
  for (const k of Object.keys(answers)) assert.ok(ids.includes(k), k);
  const byId = Object.fromEntries(cat.body.questions.map((x) => [x.id, x]));
  assert.equal(byId.surgical_guides.show_if, 'implant_surgery=in_house', 'show_if reaches the client');
  assert.equal(byId.immediate_implants.show_if, 'implant_surgery=in_house');

  const bad = await api(baseUrl, 'PUT', q('/profile'), { answers: { parent_in_room: 'maybe' } });
  assert.equal(bad.status, 400);
  const after = await api(baseUrl, 'GET', q('/profile'));
  assert.deepEqual(after.body.answers, answers, 'a refused PUT saves nothing');
  assert.equal(db.table('tc_messages').length, 0, 'nothing is drafted or sent');
});
