'use strict';

/**
 * EL-2: POST /api/tc/nurture/enrollments with a library procedure + tone, and
 * GET /enrollments?case_id= library availability, over the REAL assembled TC
 * router stack (bootTcApp). FakeTenantDb runs the routes' actual SQL.
 *
 * Every refusal code the brief names, on the real route:
 *   400 VALIDATION_FAILED                   procedure without variant (and the reverse)
 *   400 LIBRARY_TRACK_UNSUPPORTED           (a fifth track without a sequence)
 *   409 LIBRARY_NOT_APPROVED
 *   400 LIBRARY_PROCEDURE_UNKNOWN           unknown id, and an id the office switched off
 *   409 LIBRARY_OFFICE_IDENTITY_INCOMPLETE  naming what is missing
 *   409 NO_ADDRESS                          no email (a phone does not count)
 * plus: the office comes from the CASE (?office= is an assertion), the
 * intensity dial does not apply, and resume runs on the library's steps.
 *
 * Fixtures are the designated test patients only: roland "Test 2, Stedi"
 * (PatNum 12827) and valley "Stedi TestValley" (PatNum 7115). Phones are
 * 555-01xx numbers.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { bootTcApp, api } = require('./tcTestUtils');
const registry = require('../../platform/registry');
const library = require('../../services/tcEmailLibrary');
const contract = require('../../tc/contract.gen.cjs');

const PHONE_ENV = 'TC_EMAIL_PRACTICE_PHONE_ROLAND';
const OFFICE_PHONE = '(918) 555-0100';

function withEnv(t, key, value) {
  const prev = process.env[key];
  if (value === null) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

function seedCase(db, over = {}) {
  const row = {
    case_id: randomUUID(),
    office_id: 'roland',
    patient_name: 'Test 2, Stedi',
    phone: '(918) 555-0142',
    email: 'stedi.test2@example.com',
    od_patient_id: 12827,
    status: 'presented',
    nurture_unsubscribed: false,
    nurture_enrolled_at: null,
    status_changed_at: null,
    updated_at: new Date(),
    ...over,
  };
  db.table('tc_cases').push(row);
  return row;
}

const valleyCase = (db, over = {}) =>
  seedCase(db, {
    office_id: 'valley',
    patient_name: 'Stedi TestValley',
    od_patient_id: 7115,
    phone: '(479) 555-0177',
    email: 'stedi.testvalley@example.com',
    ...over,
  });

function seedProfile(db, office, answers) {
  db.table('tc_email_library_profile').push({
    office_id: office,
    answers,
    library_version: library.LIBRARY_VERSION,
    updated_by: 'admin@carein.ai',
    updated_at: new Date(),
  });
}

function switchNurture(t, value) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) => (key === 'tc_nurture_enabled' && value !== undefined ? { value } : null);
  t.after(() => {
    registry.getPlatformSetting = orig;
  });
}

/** Swap one export of the library module for the rest of the test. */
function patchLibrary(t, key, value) {
  const orig = library[key];
  library[key] = value;
  t.after(() => {
    library[key] = orig;
  });
}

async function boot(t) {
  const app = await bootTcApp();
  t.after(() => app.close());
  return app;
}

const enroll = (app, office, body) => api(app.baseUrl, 'POST', `/api/tc/nurture/enrollments?office=${office}`, body);
const libraryBody = (caseId, over = {}) => ({
  case_id: caseId,
  track_key: 'warm_followup',
  procedure_id: 'crown',
  variant: 'A',
  ...over,
});

test('library enroll: 201, procedure + tone stored, the library cadence (no dial), an event naming both, nothing drafted', async (t) => {
  switchNurture(t, { roland: true });
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  const app = await boot(t);
  // The office's dial for warm_followup is assertive; a library enrollment ignores it.
  app.db.table('tc_library_config').push({
    office_id: 'roland',
    section: 'nurture_config',
    value: { tracks: { warm_followup: { intensity: 'assertive' } } },
  });
  const c = seedCase(app.db);
  const r = await enroll(app, 'roland', libraryBody(c.case_id));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const e = r.body.enrollment;
  assert.equal(contract.TcNurtureEnrollment.safeParse(e).success, true);
  assert.equal(e.officeId, 'roland');
  assert.equal(e.libraryProcedureId, 'crown');
  assert.equal(e.libraryVariant, 'A');
  assert.equal(e.intensityAtEnroll, 'assertive', 'the dial is recorded');
  assert.equal(e.nextTouchKey, 'tp_recap', 'but the schedule is the library sequence');

  const row = app.db.table('tc_nurture_enrollments')[0];
  assert.equal(row.library_procedure_id, 'crown');
  assert.equal(row.library_variant, 'A');
  const ev = app.db.table('tc_case_events').find((x) => x.type === 'nurture_enrolled');
  assert.match(ev.description, /from the patient email library \(Dental Crown, warm and personal; office dial assertive, not applied\): 10 emails/);
  assert.equal(c.status, 'nurture');
  assert.equal(app.db.table('tc_messages').length, 0, 'enrolling drafts nothing');
});

test('library enroll: procedure and variant come together — either alone is 400', async (t) => {
  switchNurture(t, { roland: true });
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  const app = await boot(t);
  const c = seedCase(app.db);
  const a = await enroll(app, 'roland', { case_id: c.case_id, track_key: 'warm_followup', procedure_id: 'crown' });
  assert.equal(a.status, 400);
  assert.equal(a.body.code, 'VALIDATION_FAILED');
  const b = await enroll(app, 'roland', { case_id: c.case_id, track_key: 'warm_followup', variant: 'A' });
  assert.equal(b.status, 400);
  assert.equal(b.body.code, 'VALIDATION_FAILED');
  const d = await enroll(app, 'roland', libraryBody(c.case_id, { variant: 'D' }));
  assert.equal(d.status, 400);
  assert.equal(app.db.table('tc_nurture_enrollments').length, 0);
});

test('library enroll: 400 LIBRARY_TRACK_UNSUPPORTED for a track the library has no sequence for', async (t) => {
  switchNurture(t, { roland: true });
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  // Every track key has a sequence today, so stand in for a fifth track.
  assert.deepEqual([...contract.NurtureTrackKey.options].sort(), [...contract.LIBRARY_SEQUENCE_TRACKS].sort());
  patchLibrary(t, 'isLibraryTrack', (k) => k !== 'large_case');
  const app = await boot(t);
  const c = seedCase(app.db);
  const r = await enroll(app, 'roland', libraryBody(c.case_id, { track_key: 'large_case' }));
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'LIBRARY_TRACK_UNSUPPORTED');
  assert.equal(app.db.table('tc_nurture_enrollments').length, 0);
});

test('library enroll: 409 LIBRARY_NOT_APPROVED while the library is unapproved', async (t) => {
  switchNurture(t, { roland: true });
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  patchLibrary(t, 'LIBRARY_CLINICALLY_APPROVED', false);
  const app = await boot(t);
  const c = seedCase(app.db);
  const r = await enroll(app, 'roland', libraryBody(c.case_id));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'LIBRARY_NOT_APPROVED');
  // A hand-written enrollment is unaffected by the library's flag.
  const h = await enroll(app, 'roland', { case_id: c.case_id, track_key: 'warm_followup' });
  assert.equal(h.status, 201, JSON.stringify(h.body));
  assert.equal(h.body.enrollment.libraryProcedureId, null);
});

test('library enroll: 400 LIBRARY_PROCEDURE_UNKNOWN for an unknown id and for one the office switched off', async (t) => {
  switchNurture(t, { roland: true });
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  const app = await boot(t);
  seedProfile(app.db, 'roland', { services_off: ['crown'] });
  const c = seedCase(app.db);
  const unknown = await enroll(app, 'roland', libraryBody(c.case_id, { procedure_id: 'not_a_procedure' }));
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'LIBRARY_PROCEDURE_UNKNOWN');
  const off = await enroll(app, 'roland', libraryBody(c.case_id));
  assert.equal(off.status, 400);
  assert.equal(off.body.code, 'LIBRARY_PROCEDURE_UNKNOWN');
  const fine = await enroll(app, 'roland', libraryBody(c.case_id, { procedure_id: 'implant' }));
  assert.equal(fine.status, 201, JSON.stringify(fine.body));
});

test('library enroll: 409 EMAIL_LIBRARY_SAVED_ANSWERS_STALE when the saved wording no longer validates', async (t) => {
  switchNurture(t, { roland: true });
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  const app = await boot(t);
  seedProfile(app.db, 'roland', { a_question_this_library_dropped: true });
  const c = seedCase(app.db);
  const r = await enroll(app, 'roland', libraryBody(c.case_id));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EMAIL_LIBRARY_SAVED_ANSWERS_STALE');
});

test('library enroll: 409 LIBRARY_OFFICE_IDENTITY_INCOMPLETE names the missing office phone', async (t) => {
  switchNurture(t, { roland: true });
  withEnv(t, PHONE_ENV, null);
  const app = await boot(t);
  const c = seedCase(app.db);
  const r = await enroll(app, 'roland', libraryBody(c.case_id));
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'LIBRARY_OFFICE_IDENTITY_INCOMPLETE');
  assert.deepEqual(r.body.missing, ['office phone']);
  assert.match(r.body.error, /no office phone set/);
  assert.equal(app.db.table('tc_nurture_enrollments').length, 0);
});

test('library enroll: 409 NO_ADDRESS when the case has no email, even with a phone (library touches are email only)', async (t) => {
  switchNurture(t, { roland: true });
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  const app = await boot(t);
  const c = seedCase(app.db, { email: null });
  const r = await enroll(app, 'roland', libraryBody(c.case_id));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NO_ADDRESS');
  assert.match(r.body.error, /email only/);
  // The hand-written track (it has SMS touches) still reaches this case.
  const h = await enroll(app, 'roland', { case_id: c.case_id, track_key: 'warm_followup' });
  assert.equal(h.status, 201, JSON.stringify(h.body));
});

test('library enroll: the office comes from the CASE — a valley case under ?office=roland is 409, never redirected', async (t) => {
  switchNurture(t, { roland: true, valley: true });
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  withEnv(t, 'TC_EMAIL_PRACTICE_PHONE_VALLEY', '(479) 555-0100');
  const app = await boot(t);
  const v = valleyCase(app.db);
  const r = await enroll(app, 'roland', libraryBody(v.case_id));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'OFFICE_MISMATCH');
  assert.equal(app.db.table('tc_nurture_enrollments').length, 0);
  const ok = await enroll(app, 'valley', libraryBody(v.case_id, { variant: 'B' }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.enrollment.officeId, 'valley');
  // A body office is not part of the contract at all.
  const extra = await enroll(app, 'valley', { ...libraryBody(valleyCase(app.db).case_id), office: 'roland' });
  assert.equal(extra.status, 400);
});

test('GET /enrollments: libraryAvailable per track, with the server-side reason when it is not', async (t) => {
  switchNurture(t, { roland: true });
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  const app = await boot(t);
  const c = seedCase(app.db);
  const get = () => api(app.baseUrl, 'GET', `/api/tc/nurture/enrollments?office=roland&case_id=${c.case_id}`);

  const ok = await get();
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(contract.NurtureCaseResponse.safeParse(ok.body).success, true);
  for (const tr of ok.body.tracks) {
    assert.equal(tr.libraryAvailable, true, tr.trackKey);
    assert.equal(tr.libraryBlockedReason, null);
  }

  delete process.env[PHONE_ENV];
  const noPhone = await get();
  assert.ok(noPhone.body.tracks.every((x) => x.libraryAvailable === false));
  assert.match(noPhone.body.tracks[0].libraryBlockedReason, /office phone/);
  assert.ok(noPhone.body.tracks.every((x) => x.available), 'the hand-written tracks are unaffected');
  process.env[PHONE_ENV] = OFFICE_PHONE;

  c.email = null;
  const noEmail = await get();
  assert.match(noEmail.body.tracks[0].libraryBlockedReason, /no email address/);
  c.email = 'stedi.test2@example.com';

  library.LIBRARY_CLINICALLY_APPROVED = false;
  try {
    const unapproved = await get();
    assert.match(unapproved.body.tracks[0].libraryBlockedReason, /not doctor-approved/);
  } finally {
    library.LIBRARY_CLINICALLY_APPROVED = true;
  }
});

test('library enrollment: pause + resume recomputes the due date from the LIBRARY steps', async (t) => {
  switchNurture(t, { roland: true });
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  const app = await boot(t);
  const c = seedCase(app.db);
  const r = await enroll(app, 'roland', libraryBody(c.case_id, { track_key: 'reactivation' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.enrollment.enrollmentId;
  // reactivation's first library step is day 0: due on enrollment day.
  assert.equal(r.body.enrollment.nextTouchKey, 'reactivation');
  const p = await api(app.baseUrl, 'POST', `/api/tc/nurture/enrollments/${id}/pause?office=roland`, {});
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const s = await api(app.baseUrl, 'POST', `/api/tc/nurture/enrollments/${id}/resume?office=roland`, {});
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.enrollment.nextTouchKey, 'reactivation');
  assert.equal(s.body.enrollment.libraryProcedureId, 'crown');
});
