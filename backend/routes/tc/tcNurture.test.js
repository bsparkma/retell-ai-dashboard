'use strict';

/**
 * /api/tc/nurture (item 47) end to end over the real TC router stack, plus the
 * exit hooks it shares with the case-status route and the inbound-message
 * path. FakeTenantDb runs the routes' actual SQL.
 *
 * Fixtures are the designated test patients only: roland "Test 2, Stedi"
 * (PatNum 12827) and valley "Stedi TestValley" (PatNum 7115). Phones are
 * 555-01xx numbers.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');
const registry = require('../../platform/registry');
const messaging = require('../../services/messaging');
const generator = require('../../services/tcNurture/generator');
const engine = require('../../services/tcNurture/engine');

const TZ = 'America/Chicago';

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

/**
 * A FULL case through the real create route — for tests that go through the
 * status route, which loads and parses the whole aggregate.
 */
async function createCase(app, office = 'roland') {
  const r = await api(app.baseUrl, 'POST', `/api/tc/cases?office=${office}`, {
    patientName: 'Test 2, Stedi',
    phone: '(918) 555-0142',
    email: 'stedi.test2@example.com',
    category: 'implant',
    status: 'presented',
    urgency: 'medium',
    caseValueCents: 450000,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return app.db.table('tc_cases').find((x) => x.case_id === r.body.case.caseId);
}

/** Switch nurture on (or off) for the duration of a test. */
function switchNurture(t, value) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) => (key === 'tc_nurture_enabled' && value !== undefined ? { value } : null);
  t.after(() => {
    registry.getPlatformSetting = orig;
  });
}

async function boot(t) {
  const app = await bootTcApp();
  t.after(() => app.close());
  return app;
}

const enroll = (app, office, caseId, track = 'no_show_recovery') =>
  api(app.baseUrl, 'POST', `/api/tc/nurture/enrollments?office=${office}`, { case_id: caseId, track_key: track });

// ── enrollment + office derivation ──────────────────────────────────────────

test('enroll: office comes from the CASE, the case moves to nurture, events + audit are written', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const c = seedCase(app.db);
  const r = await enroll(app, 'roland', c.case_id);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const e = r.body.enrollment;
  assert.equal(e.officeId, 'roland');
  assert.equal(e.trackKey, 'no_show_recovery');
  assert.equal(e.intensityAtEnroll, 'standard');
  assert.equal(e.status, 'active');
  assert.equal(e.nextTouchKey, 'ns1');
  // ns1 is day 1: due at the next local midnight.
  assert.equal(engine.localDaysBetween(TZ, new Date(), new Date(e.nextTouchDueAt)), 1);

  assert.equal(c.status, 'nurture');
  assert.ok(c.nurture_enrolled_at);
  const types = app.db.table('tc_case_events').map((x) => x.type);
  assert.deepEqual(types, ['status_change', 'nurture_enrolled']);
  assert.ok(auditRows(app.db).some((a) => a.resource_type === 'tc_nurture_enrollment' && a.action === 'CREATE' && a.office === 'roland'));
  // Nothing was drafted, and nothing was sent.
  assert.equal(app.db.table('tc_messages').length, 0);
});

test('enroll: ?office= is an ASSERTION — a valley case under ?office=roland is 409, never redirected', async (t) => {
  switchNurture(t, { roland: true, valley: true });
  const app = await boot(t);
  const v = valleyCase(app.db);
  const r = await enroll(app, 'roland', v.case_id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'OFFICE_MISMATCH');
  assert.equal(app.db.table('tc_nurture_enrollments').length, 0);
  // The right office works, and the enrollment is valley's.
  const ok = await enroll(app, 'valley', v.case_id);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.enrollment.officeId, 'valley');
});

test('enroll: the body cannot name an office (strict body)', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const c = seedCase(app.db);
  const r = await api(app.baseUrl, 'POST', '/api/tc/nurture/enrollments?office=roland', {
    case_id: c.case_id,
    track_key: 'warm_followup',
    office: 'valley',
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'VALIDATION_FAILED');
});

test('enroll: switched off (no row) ⇒ 501 FEATURE_DISABLED; another office being on does not help', async (t) => {
  switchNurture(t, { valley: true });
  const app = await boot(t);
  const c = seedCase(app.db);
  const r = await enroll(app, 'roland', c.case_id);
  assert.equal(r.status, 501);
  assert.equal(r.body.code, 'FEATURE_DISABLED');
});

test('ONE active enrollment per case: a second start is 409 ALREADY_ENROLLED, paused counts too', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const c = seedCase(app.db);
  const first = await enroll(app, 'roland', c.case_id);
  assert.equal(first.status, 201);
  const second = await enroll(app, 'roland', c.case_id, 'warm_followup');
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'ALREADY_ENROLLED');
  // Paused still blocks.
  await api(app.baseUrl, 'POST', `/api/tc/nurture/enrollments/${first.body.enrollment.enrollmentId}/pause?office=roland`, {});
  const third = await enroll(app, 'roland', c.case_id, 'warm_followup');
  assert.equal(third.status, 409);
  // A unique violation from the database (the partial index) is the same 409.
  app.db.onQuery(/^INSERT INTO tc_nurture_enrollments/, () => {
    const err = new Error('duplicate key value violates unique constraint "tc_nurture_enrollments_one_active_per_case"');
    err.code = '23505';
    throw err;
  });
  const c2 = seedCase(app.db);
  const raced = await enroll(app, 'roland', c2.case_id);
  assert.equal(raced.status, 409);
  assert.equal(raced.body.code, 'ALREADY_ENROLLED');
});

test('enroll: a terminal case is refused; a case with no reachable channel is refused', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const done = seedCase(app.db, { status: 'scheduled' });
  const r = await enroll(app, 'roland', done.case_id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'CASE_TERMINAL');
  // no_show_recovery/gentle is all email; no email ⇒ nothing can reach them.
  await api(app.baseUrl, 'PUT', '/api/tc/nurture/config?office=roland', { tracks: { no_show_recovery: { intensity: 'gentle' } } });
  const noEmail = seedCase(app.db, { email: null });
  const r2 = await enroll(app, 'roland', noEmail.case_id);
  assert.equal(r2.status, 409);
  assert.equal(r2.body.code, 'NO_ADDRESS');
});

// ── exits ───────────────────────────────────────────────────────────────────

test('terminal status STOPS the active enrollment (case_terminal) in the same transaction', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const c = await createCase(app);
  const e = (await enroll(app, 'roland', c.case_id)).body.enrollment;
  const r = await api(app.baseUrl, 'POST', `/api/tc/cases/${c.case_id}/status?office=roland`, { status: 'scheduled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = app.db.table('tc_nurture_enrollments').find((x) => x.enrollment_id === e.enrollmentId);
  assert.equal(row.status, 'stopped');
  assert.equal(row.stop_reason, 'case_terminal');
  assert.equal(row.next_touch_due_at, null);
  assert.ok(r.body.case.events.some((x) => x.type === 'nurture_stopped'));
  assert.ok(auditRows(app.db).some((a) => a.resource_type === 'tc_nurture_enrollment.stopped' && a.resource_id === e.enrollmentId));
});

test('a NON-terminal status change leaves the enrollment running', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const c = await createCase(app);
  const e = (await enroll(app, 'roland', c.case_id)).body.enrollment;
  const r = await api(app.baseUrl, 'POST', `/api/tc/cases/${c.case_id}/status?office=roland`, { status: 'considering' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(app.db.table('tc_nurture_enrollments').find((x) => x.enrollment_id === e.enrollmentId).status, 'active');
});

/** A request shaped like the Twilio webhook's (tenant resolved, no SSO user). */
const webhookReq = () => ({ tenant: { id: 'T1' }, headers: {}, originalUrl: '/api/webhooks/twilio/inbound' });

test('an inbound text from the enrolled patient PAUSES the enrollment (same office only); nothing is sent', async (t) => {
  switchNurture(t, { roland: true, valley: true });
  const app = await boot(t);
  const c = seedCase(app.db);
  const e = (await enroll(app, 'roland', c.case_id)).body.enrollment;
  // A valley case with the SAME number must not be touched by a roland text.
  const v = valleyCase(app.db, { phone: '(918) 555-0142' });
  const ve = (await enroll(app, 'valley', v.case_id)).body.enrollment;

  const before = app.db.table('tc_messages').length;
  const r = await messaging.recordInbound(webhookReq(), {
    office: 'roland',
    channel: 'sms',
    fromAddress: '+19185550142',
    toAddress: '+19185550100',
    body: 'Can I come Thursday?',
    provider: 'twilio',
    providerMessageId: 'SMtest0001',
    linkOpenCase: true,
  });
  assert.equal(r.duplicate, false);
  const row = app.db.table('tc_nurture_enrollments').find((x) => x.enrollment_id === e.enrollmentId);
  assert.equal(row.status, 'paused');
  assert.equal(row.stop_reason, null);
  assert.equal(app.db.table('tc_nurture_enrollments').find((x) => x.enrollment_id === ve.enrollmentId).status, 'active');
  // Exactly one new row: the inbound message itself. No reply was drafted or sent.
  const added = app.db.table('tc_messages').slice(before);
  assert.deepEqual(added.map((m) => m.direction), ['inbound']);
  assert.ok(app.db.table('tc_case_events').some((x) => x.type === 'nurture_paused' && x.case_id === c.case_id));
  assert.ok(auditRows(app.db).some((a) => a.resource_type === 'tc_nurture_enrollment.paused' && a.resource_id === e.enrollmentId));
});

test('an inbound STOP stops the enrollment (opted_out) as well as recording the opt-out', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const c = seedCase(app.db);
  const e = (await enroll(app, 'roland', c.case_id)).body.enrollment;
  const r = await messaging.recordInbound(webhookReq(), {
    office: 'roland',
    channel: 'sms',
    fromAddress: '+19185550142',
    body: 'STOP',
    provider: 'twilio',
    providerMessageId: 'SMtest0002',
    linkOpenCase: true,
  });
  assert.equal(r.optedOut, true);
  const row = app.db.table('tc_nurture_enrollments').find((x) => x.enrollment_id === e.enrollmentId);
  assert.equal(row.status, 'stopped');
  assert.equal(row.stop_reason, 'opted_out');
});

test('a TC manual opt-out stops the enrollment too', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const c = seedCase(app.db);
  const e = (await enroll(app, 'roland', c.case_id)).body.enrollment;
  const r = await api(app.baseUrl, 'POST', '/api/tc/messages/consent?office=roland', { caseId: c.case_id, channel: 'email' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = app.db.table('tc_nurture_enrollments').find((x) => x.enrollment_id === e.enrollmentId);
  assert.equal(row.status, 'stopped');
  assert.equal(row.stop_reason, 'opted_out');
});

// ── pause / resume / stop ───────────────────────────────────────────────────

test('pause → resume recomputes the due date from TODAY and never back-fills missed touches', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const c = seedCase(app.db);
  const e = (await enroll(app, 'roland', c.case_id, 'warm_followup')).body.enrollment; // standard: 2,5,9,…
  const row = app.db.table('tc_nurture_enrollments').find((x) => x.enrollment_id === e.enrollmentId);
  // Pretend two touches went out long ago and the next (wf3 @9) was due weeks back.
  row.next_touch_index = 2;
  row.next_touch_due_at = '2026-01-01T06:00:00.000Z';
  const base = `/api/tc/nurture/enrollments/${e.enrollmentId}`;
  assert.equal((await api(app.baseUrl, 'POST', `${base}/pause?office=roland`, {})).status, 200);
  const resumed = await api(app.baseUrl, 'POST', `${base}/resume?office=roland`, {});
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  const due = new Date(resumed.body.enrollment.nextTouchDueAt);
  // wf2 @5 → wf3 @9: four local days from today, not "now, plus everything missed".
  assert.equal(engine.localDaysBetween(TZ, new Date(), due), 4);
  assert.equal(resumed.body.enrollment.nextTouchIndex, 2, 'no touch skipped, none doubled');
  assert.equal(resumed.body.enrollment.nextTouchKey, 'wf3');
  // A generator pass right now drafts nothing (the touch is not due yet).
  const out = await generator.runForOffice({ pool: app.db, office: 'roland', now: new Date(), tz: TZ });
  assert.equal(out.queued, 0);
  // Resume of an active one is refused.
  const again = await api(app.baseUrl, 'POST', `${base}/resume?office=roland`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ENROLLMENT_NOT_IN_STATE');
});

test('stop needs a reason, records it, and is final; another office cannot act on it', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const c = seedCase(app.db);
  const e = (await enroll(app, 'roland', c.case_id)).body.enrollment;
  const base = `/api/tc/nurture/enrollments/${e.enrollmentId}`;
  assert.equal((await api(app.baseUrl, 'POST', `${base}/stop?office=roland`, {})).status, 400);
  const wrongOffice = await api(app.baseUrl, 'POST', `${base}/stop?office=valley`, { reason: 'x' });
  assert.equal(wrongOffice.status, 409);
  assert.equal(wrongOffice.body.code, 'OFFICE_MISMATCH');
  const r = await api(app.baseUrl, 'POST', `${base}/stop?office=roland`, { reason: 'Patient called to schedule' });
  assert.equal(r.status, 200);
  assert.equal(r.body.enrollment.status, 'stopped');
  assert.equal(r.body.enrollment.stopReason, 'Patient called to schedule');
  assert.equal(r.body.enrollment.nextTouchDueAt, null);
  // The free-text reason never reaches the audit trail.
  assert.ok(!JSON.stringify(auditRows(app.db)).includes('Patient called'));
  const resume = await api(app.baseUrl, 'POST', `${base}/resume?office=roland`, {});
  assert.equal(resume.status, 409);
  // A stopped enrollment no longer blocks a new one.
  assert.equal((await enroll(app, 'roland', c.case_id, 'warm_followup')).status, 201);
});

test('GET /enrollments?case_id= lists history and greys tracks with a reason', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const c = seedCase(app.db, { email: null });
  let r = await api(app.baseUrl, 'GET', `/api/tc/nurture/enrollments?office=roland&case_id=${c.case_id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true);
  assert.deepEqual(r.body.enrollments, []);
  const byKey = Object.fromEntries(r.body.tracks.map((x) => [x.trackKey, x]));
  assert.equal(byKey.no_show_recovery.available, true);
  // large_case/standard is mostly email but has lc6 (SMS) — reachable by phone.
  assert.equal(byKey.large_case.available, true);
  await enroll(app, 'roland', c.case_id);
  r = await api(app.baseUrl, 'GET', `/api/tc/nurture/enrollments?office=roland&case_id=${c.case_id}`);
  assert.equal(r.body.enrollments.length, 1);
  assert.ok(r.body.tracks.every((x) => !x.available && x.reason === 'already_enrolled'));
  // Off ⇒ every track says so.
  registry.getPlatformSetting = async () => null;
  r = await api(app.baseUrl, 'GET', `/api/tc/nurture/enrollments?office=roland&case_id=${c.case_id}`);
  assert.equal(r.body.enabled, false);
  assert.ok(r.body.tracks.every((x) => x.reason === 'switched_off'));
  // Another office's case is a 404 here.
  const v = valleyCase(app.db);
  assert.equal((await api(app.baseUrl, 'GET', `/api/tc/nurture/enrollments?office=roland&case_id=${v.case_id}`)).status, 404);
});

// ── config ──────────────────────────────────────────────────────────────────

test('config: defaults to standard; INVALID_TRACK / INVALID_INTENSITY; the stored dial is used at enroll', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  let r = await api(app.baseUrl, 'GET', '/api/tc/nurture/config?office=roland');
  assert.equal(r.status, 200);
  assert.ok(r.body.tracks.every((x) => x.intensity === 'standard' && x.stored === false));

  r = await api(app.baseUrl, 'PUT', '/api/tc/nurture/config?office=roland', { tracks: { reengage: { intensity: 'gentle' } } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_TRACK');
  r = await api(app.baseUrl, 'PUT', '/api/tc/nurture/config?office=roland', { tracks: { reactivation: { intensity: 'max' } } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_INTENSITY');
  // Cadence is not editable: anything beyond the dial is refused.
  r = await api(app.baseUrl, 'PUT', '/api/tc/nurture/config?office=roland', {
    tracks: { reactivation: { intensity: 'gentle', days: [1, 2, 3] } },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_INTENSITY');

  r = await api(app.baseUrl, 'PUT', '/api/tc/nurture/config?office=roland', { tracks: { reactivation: { intensity: 'assertive' } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.tracks.find((x) => x.trackKey === 'reactivation').intensity, 'assertive');
  assert.ok(auditRows(app.db).some((a) => a.resource_type === 'tc_library_config' && a.resource_id === 'roland/nurture_config'));
  // Per office: valley is still standard.
  const v = await api(app.baseUrl, 'GET', '/api/tc/nurture/config?office=valley');
  assert.equal(v.body.tracks.find((x) => x.trackKey === 'reactivation').intensity, 'standard');

  const c = seedCase(app.db);
  const e = await enroll(app, 'roland', c.case_id, 'reactivation');
  assert.equal(e.body.enrollment.intensityAtEnroll, 'assertive');
});

// ── outbox + skip ───────────────────────────────────────────────────────────

test('outbox: the generator drafts land grouped by track; Skip moves one draft to skipped and nothing else', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const a = seedCase(app.db);
  const b = seedCase(app.db, { patient_name: 'Test, MangoTest', phone: '(918) 555-0143', od_patient_id: 12828 });
  await enroll(app, 'roland', a.case_id, 'no_show_recovery');
  await enroll(app, 'roland', b.case_id, 'warm_followup');
  // Run the generator as if it were tomorrow's 05:00 (both first touches are due by then… wf1 is @2).
  const in3 = engine.addLocalDays(TZ, new Date(), 3);
  const out = await generator.runForOffice({ pool: app.db, office: 'roland', now: new Date(in3.getTime() + 5 * 3600e3), tz: TZ });
  assert.equal(out.queued, 2);

  let r = await api(app.baseUrl, 'GET', '/api/tc/nurture/outbox?office=roland');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.enabled, true);
  assert.deepEqual(r.body.groups.map((g) => g.trackKey), ['no_show_recovery', 'warm_followup']);
  assert.deepEqual(r.body.channels.map((c) => c.channel), ['sms', 'email']);
  const d = r.body.groups[0].drafts[0];
  assert.equal(d.message.status, 'draft');
  assert.equal(d.touchKey, 'ns1');
  assert.equal(d.patientName, 'Test 2, Stedi');
  assert.ok(auditRows(app.db).some((x) => x.resource_type === 'tc_nurture_outbox' && x.action === 'READ'));

  const enrBefore = JSON.stringify(app.db.table('tc_nurture_enrollments'));
  const s = await api(app.baseUrl, 'POST', `/api/tc/nurture/outbox/${d.message.messageId}/skip?office=roland`, {});
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.message.status, 'skipped');
  assert.equal(JSON.stringify(app.db.table('tc_nurture_enrollments')), enrBefore, 'Skip advances nothing');
  assert.ok(auditRows(app.db).some((x) => x.resource_type === 'tc_message.skipped'));
  r = await api(app.baseUrl, 'GET', '/api/tc/nurture/outbox?office=roland');
  assert.deepEqual(r.body.groups.map((g) => g.trackKey), ['warm_followup']);
  // A skipped draft cannot be sent; a second skip is refused.
  const send = await api(app.baseUrl, 'POST', `/api/tc/messages/${d.message.messageId}/send?office=roland`, {});
  assert.equal(send.body.code, 'MESSAGE_NOT_SENDABLE');
  const again = await api(app.baseUrl, 'POST', `/api/tc/nurture/outbox/${d.message.messageId}/skip?office=roland`, {});
  assert.equal(again.body.code, 'MESSAGE_NOT_EDITABLE');
});

test('Skip refuses a TC-written draft (that is Discard), and another office’s draft is a 404', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const c = seedCase(app.db);
  const drafted = await api(app.baseUrl, 'POST', '/api/tc/messages/draft?office=roland', {
    caseId: c.case_id,
    channel: 'sms',
    body: 'Hello from the office',
  });
  assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
  const id = drafted.body.message.messageId;
  const s = await api(app.baseUrl, 'POST', `/api/tc/nurture/outbox/${id}/skip?office=roland`, {});
  assert.equal(s.body.code, 'MESSAGE_NOT_EDITABLE');
  const other = await api(app.baseUrl, 'POST', `/api/tc/nurture/outbox/${id}/skip?office=valley`, {});
  assert.equal(other.status, 404);
});

test('outbox while switched off: an honest enabled:false and no fabricated groups', async (t) => {
  switchNurture(t, undefined);
  const app = await boot(t);
  const r = await api(app.baseUrl, 'GET', '/api/tc/nurture/outbox?office=roland');
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, false);
  assert.deepEqual(r.body.groups, []);
});

test('the nurture routes need tc.full (a hygienist cannot reach them)', async (t) => {
  switchNurture(t, { roland: true });
  const app = await bootTcApp({ role: 'hygiene' });
  t.after(() => app.close());
  const r = await api(app.baseUrl, 'GET', '/api/tc/nurture/outbox?office=roland');
  assert.equal(r.status, 403);
});

test('an email unsubscribe-link click stops the enrollment on that address too', async (t) => {
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const c = seedCase(app.db);
  const e = (await enroll(app, 'roland', c.case_id, 'large_case')).body.enrollment;
  const token = require('node:crypto').randomBytes(32).toString('base64url');
  app.db.table('tc_messages').push({
    message_id: randomUUID(),
    office_id: 'roland',
    case_id: c.case_id,
    direction: 'outbound',
    channel: 'email',
    to_address: 'stedi.test2@example.com',
    status: 'sent',
    unsubscribe_token_hash: messaging.hashUnsubscribeToken(token),
    created_at: new Date(),
  });
  const outcome = await messaging.recordUnsubscribeLink(webhookReq(), token);
  assert.equal(outcome, 'recorded');
  const row = app.db.table('tc_nurture_enrollments').find((x) => x.enrollment_id === e.enrollmentId);
  assert.equal(row.status, 'stopped');
  assert.equal(row.stop_reason, 'opted_out');
});
