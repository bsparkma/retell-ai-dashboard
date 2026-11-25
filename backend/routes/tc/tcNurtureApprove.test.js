'use strict';

/**
 * EL-2c — APPROVE UP FRONT, over the REAL assembled TC router stack
 * (bootTcApp). FakeTenantDb runs the routes' and services' actual SQL; the
 * real-Postgres proof of the CHECKs and the enroll-time pass is
 * scripts/tc-nurture-approve-verify-queries.js.
 *
 *   Start          a library campaign is written IN FULL, in the enrollment's
 *                  own transaction, every email a draft with a planned time;
 *                  a render failure writes nothing at all
 *   active → completed   only when its last email is sent or skipped
 *   approve / approve-all / unapprove / reschedule / skip / edit
 *                  each happy path, each refusal, and a doubled request
 *                  changes one row once
 *   Stop           cancels every waiting email (library AND hand-written),
 *                  with the right skip_reason; "Patient replied" pauses and
 *                  cancels nothing; Resume re-plans late emails forward
 *   NEVER SENDS    sendMessage is replaced with a function that THROWS in
 *                  every test here except the one proving that the real
 *                  sendMessage refuses an approved ('scheduled') email
 *
 * Fixtures are the designated test patients only: roland "Test 2, Stedi"
 * (PatNum 12827) and valley "Stedi TestValley" (PatNum 7115). Phones are
 * 555-01xx numbers; the staff name is synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');
const registry = require('../../platform/registry');
const library = require('../../services/tcEmailLibrary');
const messaging = require('../../services/messaging');
const adapters = require('../../services/messaging/adapters');
const engine = require('../../services/tcNurture/engine');
const hooks = require('../../services/tcNurture/hooks');
const generator = require('../../services/tcNurture/generator');
const contract = require('../../tc/contract.gen.cjs');

const TZ = 'America/Chicago';
const PHONE_ENV = 'TC_EMAIL_PRACTICE_PHONE_ROLAND';
const OFFICE_PHONE = '(918) 555-0100';
/** Tuesday 2026-12-01 09:00 America/Chicago — the clock the review actions read. */
const NOW = new Date('2026-12-01T15:00:00.000Z');

function withEnv(t, key, value) {
  const prev = process.env[key];
  if (value === null) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

function switchNurture(t, value) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) => (key === 'tc_nurture_enabled' && value !== undefined ? { value } : null);
  t.after(() => {
    registry.getPlatformSetting = orig;
  });
}

/** THE NEVER-SEND PIN: sendMessage and every adapter lookup throw if reached. */
function armNeverSend(t) {
  const origSend = messaging.sendMessage;
  const origGet = adapters.getAdapter;
  const hits = { sendMessage: 0, adapter: 0 };
  messaging.sendMessage = async () => {
    hits.sendMessage += 1;
    throw new Error('EL-2c must never send');
  };
  adapters.getAdapter = () => {
    hits.adapter += 1;
    throw new Error('EL-2c must never reach an adapter');
  };
  t.after(() => {
    messaging.sendMessage = origSend;
    adapters.getAdapter = origGet;
    assert.deepEqual(hits, { sendMessage: 0, adapter: 0 }, 'nothing was sent');
  });
  return hits;
}

function fixClock(t, at = NOW) {
  messaging.setClockForTests(() => new Date(at.getTime()));
  t.after(() => messaging.resetClock());
}

async function boot(t) {
  const app = await bootTcApp();
  t.after(() => app.close());
  return app;
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
    assigned_tc: 'Test Coordinator',
    updated_at: new Date(),
    ...over,
  };
  db.table('tc_cases').push(row);
  return row;
}

/**
 * A library campaign seeded straight into the store, as Start writes it: the
 * enrollment at the end of its sequence, every step an email draft planned by
 * the real planner from `enrolledAt`. Returns the rows (live references).
 */
function seedCampaign(db, tcCase, { track = 'reactivation', procedure = 'crown', enrolledAt = NOW, status = 'active' } = {}) {
  const steps = library.sequenceFor(track, procedure);
  const e = {
    enrollment_id: randomUUID(),
    case_id: tcCase.case_id,
    office_id: tcCase.office_id,
    track_key: track,
    intensity_at_enroll: 'standard',
    status,
    stop_reason: null,
    next_touch_index: steps.length,
    next_touch_due_at: null,
    last_touch_at: enrolledAt.toISOString(),
    created_by: 'tc@carein.ai',
    created_at: enrolledAt.toISOString(),
    updated_at: enrolledAt.toISOString(),
    library_procedure_id: procedure,
    library_variant: 'A',
  };
  db.table('tc_nurture_enrollments').push(e);
  const times = engine.planCampaign({ tz: TZ, enrolledAt, steps });
  const msgs = steps.map((s, i) => {
    const body = `Hi Stedi,\n\nStep ${i + 1} of the plan.\n\nThe team`;
    const m = {
      message_id: randomUUID(),
      office_id: tcCase.office_id,
      case_id: tcCase.case_id,
      direction: 'outbound',
      channel: 'email',
      to_address: tcCase.email,
      from_address: null,
      body,
      subject: `Subject ${i + 1}`,
      template_id: contract.libraryTemplateId(procedure, s.stage, 'A'),
      status: 'draft',
      provider: null,
      provider_message_id: null,
      error: null,
      created_by: 'system:nurture',
      sent_by: null,
      created_at: enrolledAt,
      sent_at: null,
      email_blocks: library.textToBlocks(body),
      email_preheader: 'A preheader',
      enrollment_id: e.enrollment_id,
      touch_key: s.stage,
      consent_blocked_hint: null,
      scheduled_for: times[i].toISOString(),
      approved_by: null,
      approved_at: null,
      skip_reason: null,
    };
    db.table('tc_messages').push(m);
    return m;
  });
  return { e, msgs, steps };
}

/** A hand-written (item-47) enrollment with one leftover draft. */
function seedHandWritten(db, tcCase) {
  const e = {
    enrollment_id: randomUUID(),
    case_id: tcCase.case_id,
    office_id: tcCase.office_id,
    track_key: 'warm_followup',
    intensity_at_enroll: 'standard',
    status: 'active',
    stop_reason: null,
    next_touch_index: 1,
    next_touch_due_at: '2026-12-05T06:00:00.000Z',
    last_touch_at: '2026-12-01T11:00:00.000Z',
    created_by: 'tc@carein.ai',
    created_at: '2026-11-30T15:00:00.000Z',
    updated_at: '2026-11-30T15:00:00.000Z',
  };
  db.table('tc_nurture_enrollments').push(e);
  const m = {
    message_id: randomUUID(),
    office_id: tcCase.office_id,
    case_id: tcCase.case_id,
    direction: 'outbound',
    channel: 'sms',
    to_address: '+19185550142',
    body: 'Hi Stedi, thanks for coming in. Reply STOP to opt out.',
    subject: null,
    template_id: 'nurture.warm_followup.wf1',
    status: 'draft',
    created_by: 'system:nurture',
    created_at: new Date('2026-12-01T11:00:00.000Z'),
    email_blocks: null,
    enrollment_id: e.enrollment_id,
    touch_key: 'wf1',
    consent_blocked_hint: null,
  };
  db.table('tc_messages').push(m);
  return { e, m };
}

const N = (p) => `/api/tc/nurture${p}`;
const audits = (app, type) => auditRows(app.db).filter((r) => (r.resource_type ?? r.resourceType) === type);

// ── Start: the whole campaign, in one transaction ──────────────────────────

test('Start writes EVERY step as a draft with a planned time, in the enrollment\'s own transaction; nothing is sent', async (t) => {
  switchNurture(t, { roland: true });
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  armNeverSend(t);
  const app = await boot(t);
  const c = seedCase(app.db);
  const before = app.db.log.length;
  const r = await api(app.baseUrl, 'POST', N('/enrollments?office=roland'), {
    case_id: c.case_id,
    track_key: 'warm_followup',
    procedure_id: 'crown',
    variant: 'B',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const e = r.body.enrollment;
  assert.equal(e.status, 'active', 'active, NOT completed, although every step is written');
  assert.equal(e.stepCount, 10);
  assert.equal(e.nextTouchIndex, 10, 'next_touch_index = steps written');
  assert.equal(e.approvedCount, 0);
  assert.equal(e.sentCount, 0);
  assert.equal(e.nextTouchKey, 'tp_recap', 'the next WAITING email');
  assert.ok(e.nextSendAt);

  const msgs = app.db.table('tc_messages');
  assert.equal(msgs.length, 10);
  const steps = library.sequenceFor('warm_followup', 'crown');
  assert.deepEqual(msgs.map((m) => m.touch_key), steps.map((s) => s.stage));
  const times = msgs.map((m) => new Date(m.scheduled_for));
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    assert.equal(m.status, 'draft');
    assert.equal(m.channel, 'email');
    assert.equal(m.to_address, 'stedi.test2@example.com');
    assert.equal(m.template_id, `library.crown.${steps[i].stage}.B`);
    assert.ok(!/\{\{/.test(m.subject + m.body + m.email_preheader));
    assert.ok(engine.isInSendWindow(TZ, times[i]), `#${i} inside the window`);
    if (i > 0) assert.ok(times[i] > times[i - 1], 'in sequence order');
  }
  assert.equal(engine.capViolation(TZ, times), null, 'the hard caps hold');
  assert.equal(e.nextSendAt, times[0].toISOString());

  // ONE transaction: one BEGIN … COMMIT around the enrollment and all ten INSERTs.
  const log = app.db.log.slice(before).map((x) => x.sql);
  const begins = log.flatMap((s, i) => (s === 'BEGIN' ? [i] : []));
  const commits = log.flatMap((s, i) => (s === 'COMMIT' ? [i] : []));
  assert.equal(begins.length, 1);
  assert.equal(commits.length, 1);
  const inserts = log.flatMap((s, i) => (/^INSERT INTO tc_messages /.test(s) ? [i] : []));
  const enrollInsert = log.findIndex((s) => /^INSERT INTO tc_nurture_enrollments /.test(s));
  assert.equal(inserts.length, 10);
  assert.ok(begins[0] < enrollInsert && inserts.every((i) => i > begins[0] && i < commits[0]));

  // ONE enrollment event, not ten.
  const ev = app.db.table('tc_case_events').filter((x) => x.type === 'nurture_enrolled');
  assert.equal(ev.length, 1);
  assert.match(ev[0].description, /10 emails written for review, the first planned \w{3} \d+\. Nothing sends until a person approves each one\./);
  assert.equal(app.db.table('tc_case_events').filter((x) => x.type === 'nurture_touch_queued').length, 0);

  // And the nightly pass has nothing to write for it.
  const out = await generator.runForOffice({ pool: app.db, tenantSlug: 'carein', office: 'roland', tz: TZ });
  assert.equal(out.due, 0);
  assert.equal(out.completed, 0, 'ten emails still waiting');
  assert.equal(app.db.table('tc_messages').length, 10);
});

test('Start: one step that cannot render refuses the whole campaign — no enrollment, no emails, no status change', async (t) => {
  switchNurture(t, { roland: true });
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  armNeverSend(t);
  const app = await boot(t);
  const c = seedCase(app.db);
  const orig = library.renderLibraryEmail;
  let calls = 0;
  library.renderLibraryEmail = (input) => {
    calls += 1;
    if (calls === 4) throw new library.LibraryRenderError('UNRESOLVED_MERGE', 'appointment_date', 'UNRESOLVED_MERGE: {{appointment_date}}');
    return orig(input);
  };
  t.after(() => {
    library.renderLibraryEmail = orig;
  });
  const r = await api(app.baseUrl, 'POST', N('/enrollments?office=roland'), {
    case_id: c.case_id,
    track_key: 'warm_followup',
    procedure_id: 'crown',
    variant: 'A',
  });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'UNRESOLVED_MERGE');
  assert.equal(r.body.token, 'appointment_date');
  assert.match(r.body.error, /Nothing was started/);
  assert.equal(app.db.table('tc_nurture_enrollments').length, 0, 'no enrollment row');
  assert.equal(app.db.table('tc_messages').length, 0, 'no messages');
  assert.equal(app.db.table('tc_case_events').length, 0, 'no events');
  assert.equal(c.status, 'presented', 'the case did not move');
});

test('Start (hand-written) is unchanged: no drafts at Start, the first touch due on its day', async (t) => {
  switchNurture(t, { roland: true });
  armNeverSend(t);
  const app = await boot(t);
  const c = seedCase(app.db);
  const r = await api(app.baseUrl, 'POST', N('/enrollments?office=roland'), { case_id: c.case_id, track_key: 'warm_followup' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.enrollment.nextTouchIndex, 0);
  assert.ok(r.body.enrollment.nextTouchDueAt);
  assert.equal(app.db.table('tc_messages').length, 0);
});

// ── approve ─────────────────────────────────────────────────────────────────

test('approve: draft → scheduled with who and when; audited; a double click changes the row once', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const { msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  const m = msgs[1];
  const plannedBefore = m.scheduled_for;
  const r = await api(app.baseUrl, 'POST', N(`/messages/${m.message_id}/approve?office=roland`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.status, 'scheduled');
  assert.equal(r.body.message.approvedBy, 'tc@carein.ai');
  assert.equal(r.body.message.approvedAt, NOW.toISOString());
  assert.equal(r.body.message.scheduledFor, plannedBefore, 'a future planned time is kept');
  assert.equal(r.body.replanned, 0);
  assert.equal(m.status, 'scheduled');
  assert.equal(audits(app, 'tc_message.approved').length, 1);

  const again = await api(app.baseUrl, 'POST', N(`/messages/${m.message_id}/approve?office=roland`), {});
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'MESSAGE_NOT_APPROVABLE');
  assert.match(again.body.error, /already approved/);
  assert.equal(m.approved_at, NOW.toISOString(), 'unchanged');
  assert.equal(audits(app, 'tc_message.approved').length, 1, 'one approval on the trail');
});

test('approve refusals: no address, no subject, a paused campaign, a hand-written draft, the other office, unknown id', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const c = seedCase(app.db, { status: 'nurture' });
  const { e, msgs } = seedCampaign(app.db, c);
  const approve = (id, office = 'roland') => api(app.baseUrl, 'POST', N(`/messages/${id}/approve?office=${office}`), {});

  msgs[0].to_address = null;
  let r = await approve(msgs[0].message_id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NO_ADDRESS');

  msgs[1].subject = '  ';
  r = await approve(msgs[1].message_id);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'SUBJECT_REQUIRED');

  e.status = 'paused';
  r = await approve(msgs[2].message_id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'ENROLLMENT_NOT_ACTIVE');
  e.status = 'active';

  const hand = seedHandWritten(app.db, seedCase(app.db, { status: 'nurture' }));
  r = await approve(hand.m.message_id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'MESSAGE_NOT_APPROVABLE');

  // The office comes from the ROW: ?office=valley for a roland email only refuses.
  r = await approve(msgs[2].message_id, 'valley');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'OFFICE_MISMATCH');

  r = await approve(randomUUID());
  assert.equal(r.status, 404);

  assert.ok(msgs.every((m) => m.status === 'draft'), 'nothing was approved');
  assert.equal(audits(app, 'tc_message.approved').length, 0);
});

test('approve: a planned time already past is moved forward from now (with the late ones after it) and returned', async (t) => {
  const later = new Date('2026-12-21T19:00:00.000Z'); // Monday 2026-12-21 13:00 CST
  fixClock(t, later);
  armNeverSend(t);
  const app = await boot(t);
  const { msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' })); // planned from 12-01
  // reactivation: day 0, 7, 16, 30, 50 → the first three are past on 12-21.
  assert.ok(new Date(msgs[2].scheduled_for) < later && new Date(msgs[3].scheduled_for) > later);
  const r = await api(app.baseUrl, 'POST', N(`/messages/${msgs[0].message_id}/approve?office=roland`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.scheduledFor, later.toISOString(), 'now (it is inside the window)');
  assert.ok(r.body.replanned >= 2, 'the other late emails moved too');
  const times = msgs.map((m) => new Date(m.scheduled_for));
  assert.ok(times.every((x) => x >= later), 'none left in the past');
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], 'order kept');
  assert.equal(engine.capViolation(TZ, times), null, 'caps hold');
  assert.ok(times.every((x) => engine.isInSendWindow(TZ, x)));
  assert.deepEqual(msgs.map((m) => m.status), ['scheduled', 'draft', 'draft', 'draft', 'draft'], 'only the one approved');
});

// ── approve-all ─────────────────────────────────────────────────────────────

test('approve-all: one transaction, one audit row per email, the count; a second click approves 0', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const { e, msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  await api(app.baseUrl, 'POST', N(`/messages/${msgs[0].message_id}/approve?office=roland`), {});
  const r = await api(app.baseUrl, 'POST', N(`/enrollments/${e.enrollment_id}/approve-all?office=roland`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.approved, 4, 'the four still drafts');
  assert.equal(r.body.enrollment.approvedCount, 5);
  assert.ok(msgs.every((m) => m.status === 'scheduled' && m.approved_by === 'tc@carein.ai'));
  assert.equal(audits(app, 'tc_message.approved').length, 5);

  const again = await api(app.baseUrl, 'POST', N(`/enrollments/${e.enrollment_id}/approve-all?office=roland`), {});
  assert.equal(again.status, 200);
  assert.equal(again.body.approved, 0);
  assert.equal(audits(app, 'tc_message.approved').length, 5, 'nothing new on the trail');
});

test('approve-all refusals: all or nothing on a draft missing its subject; paused; hand-written; other office', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const { e, msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  const all = (id, office = 'roland') => api(app.baseUrl, 'POST', N(`/enrollments/${id}/approve-all?office=${office}`), {});

  msgs[3].subject = null;
  let r = await all(e.enrollment_id);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'SUBJECT_REQUIRED');
  assert.match(r.body.error, /^Email 4 of 5: .*Nothing was approved\./);
  assert.ok(msgs.every((m) => m.status === 'draft'), 'all or nothing');
  msgs[3].subject = 'Subject 4';

  e.status = 'paused';
  r = await all(e.enrollment_id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'ENROLLMENT_NOT_ACTIVE');
  e.status = 'active';

  const hand = seedHandWritten(app.db, seedCase(app.db, { status: 'nurture' }));
  r = await all(hand.e.enrollment_id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'MESSAGE_NOT_APPROVABLE');

  r = await all(e.enrollment_id, 'valley');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'OFFICE_MISMATCH');
  r = await all(randomUUID());
  assert.equal(r.status, 404);
  assert.equal(audits(app, 'tc_message.approved').length, 0);
});

// ── unapprove ───────────────────────────────────────────────────────────────

test('unapprove: scheduled → draft, approval cleared, the planned time kept; a second click refuses', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const { msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  const m = msgs[2];
  await api(app.baseUrl, 'POST', N(`/messages/${m.message_id}/approve?office=roland`), {});
  const planned = m.scheduled_for;
  const r = await api(app.baseUrl, 'POST', N(`/messages/${m.message_id}/unapprove?office=roland`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.status, 'draft');
  assert.equal(r.body.message.approvedBy, null);
  assert.equal(r.body.message.approvedAt, null);
  assert.equal(r.body.message.scheduledFor, planned);
  const again = await api(app.baseUrl, 'POST', N(`/messages/${m.message_id}/unapprove?office=roland`), {});
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'MESSAGE_NOT_APPROVABLE');
  assert.equal(audits(app, 'tc_message.unapproved').length, 1);
  const other = await api(app.baseUrl, 'POST', N(`/messages/${m.message_id}/unapprove?office=valley`), {});
  assert.equal(other.body.code, 'OFFICE_MISMATCH');
});

// ── reschedule ──────────────────────────────────────────────────────────────

test('reschedule: inside the window, in order, within the caps; an approval is kept; the same time twice changes nothing', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const { msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  // reactivation from Tue 12-01: day 7 → Tue 12-08 10:00. Move it a day later.
  assert.equal(engine.localParts(TZ, new Date(msgs[1].scheduled_for)).ymd, '2026-12-08');
  await api(app.baseUrl, 'POST', N(`/messages/${msgs[1].message_id}/approve?office=roland`), {});
  const body = { date: '2026-12-09', time: '11:30' };
  const r = await api(app.baseUrl, 'POST', N(`/messages/${msgs[1].message_id}/reschedule?office=roland`), body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.scheduledFor, engine.localInstant(TZ, '2026-12-09', 11 * 60 + 30).toISOString());
  assert.equal(r.body.message.status, 'scheduled', 'approval kept');
  assert.equal(audits(app, 'tc_message.rescheduled').length, 1);
  const again = await api(app.baseUrl, 'POST', N(`/messages/${msgs[1].message_id}/reschedule?office=roland`), body);
  assert.equal(again.status, 200);
  assert.equal(audits(app, 'tc_message.rescheduled').length, 1, 'the second, identical request changed nothing');
});

test('reschedule refusals name the rule: past, outside the window, out of order, a cap', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const { msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  const move = (m, date, time) =>
    api(app.baseUrl, 'POST', N(`/messages/${m.message_id}/reschedule?office=roland`), { date, time });
  const before = msgs.map((m) => m.scheduled_for);

  let r = await move(msgs[1], '2026-11-30', '10:00');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'TIME_IN_PAST');

  r = await move(msgs[1], '2026-12-12', '10:00'); // Saturday
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'OUTSIDE_SEND_WINDOW');
  assert.match(r.body.error, /Monday to Friday, 9:00 AM to 4:00 PM office time/);
  r = await move(msgs[1], '2026-12-09', '17:30');
  assert.equal(r.body.code, 'OUTSIDE_SEND_WINDOW');

  // Email 2 after email 3 (reactivation day 16 → Thu 12-17).
  r = await move(msgs[1], '2026-12-18', '10:00');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'OUT_OF_ORDER');
  assert.match(r.body.error, /before email 3/);

  // Email 2 one day after email 1: the 48h rule.
  r = await move(msgs[1], '2026-12-02', '10:00');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'CAP_WOULD_EXCEED');
  assert.equal(r.body.rule, 'MIN_GAP');
  assert.match(r.body.error, /at least 48 hours between two emails/);

  r = await api(app.baseUrl, 'POST', N(`/messages/${msgs[1].message_id}/reschedule?office=roland`), { date: '12/09/2026', time: '10:00' });
  assert.equal(r.status, 400, 'a malformed date is a validation failure');

  assert.deepEqual(msgs.map((m) => m.scheduled_for), before, 'nothing moved');
  assert.equal(audits(app, 'tc_message.rescheduled').length, 0);
});

// ── skip ────────────────────────────────────────────────────────────────────

test('skip: an approved email can be skipped (reason manual); a double click refuses; the last one completes the campaign', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const { e, msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  await api(app.baseUrl, 'POST', N(`/messages/${msgs[0].message_id}/approve?office=roland`), {});
  const skip = (m) => api(app.baseUrl, 'POST', N(`/outbox/${m.message_id}/skip?office=roland`), {});
  const r = await skip(msgs[0]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.status, 'skipped');
  assert.equal(r.body.message.skipReason, 'manual');
  const again = await skip(msgs[0]);
  assert.equal(again.status, 409);
  assert.equal(e.status, 'active');

  // The other four: three go out (a person sent them by hand), the last is skipped.
  for (const m of msgs.slice(1, 4)) Object.assign(m, { status: 'sent', sent_at: new Date().toISOString() });
  const last = await skip(msgs[4]);
  assert.equal(last.status, 200);
  assert.equal(e.status, 'completed', 'completed only once its last email is sent or skipped');
  const done = app.db.table('tc_case_events').filter((x) => x.type === 'nurture_completed');
  assert.equal(done.length, 1);
  assert.match(done[0].description, /every email was sent or skipped/);
});

test('completion: active until the last email is SENT — after a hand send, and via the nightly sweep', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const a = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  for (const m of a.msgs.slice(0, 4)) Object.assign(m, { status: 'sent', sent_at: new Date().toISOString() });
  // One still waiting: the sweep leaves it running.
  let out = await generator.runForOffice({ pool: app.db, tenantSlug: 'carein', office: 'roland', tz: TZ });
  assert.equal(out.completed, 0);
  assert.equal(a.e.status, 'active');
  // The last one goes out by hand; the Send route then settles the campaign.
  Object.assign(a.msgs[4], { status: 'sent', sent_at: new Date().toISOString() });
  await messaging.settleNurtureAfterSend({ user: { email: 'tc@carein.ai' } }, 'roland', a.msgs[4].message_id);
  assert.equal(a.e.status, 'completed');

  // A second campaign finished without a hand send (e.g. a failed send): the sweep completes it.
  const b = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  for (const m of b.msgs) Object.assign(m, { status: m === b.msgs[0] ? 'failed' : 'sent' });
  out = await generator.runForOffice({ pool: app.db, tenantSlug: 'carein', office: 'roland', tz: TZ });
  assert.equal(out.completed, 1);
  assert.equal(b.e.status, 'completed');
});

// ── edit ────────────────────────────────────────────────────────────────────

test('edit: a library draft\'s BODY is editable and its blocks are re-derived by textToBlocks', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const { msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  const m = msgs[0];
  const text = 'Hi Stedi,\n\nWe changed this line.\nAnd this one.\n\nBring:\n- your card & ID\n\nThe team';
  const r = await api(app.baseUrl, 'PUT', `/api/tc/messages/${m.message_id}?office=roland`, { body: text, subject: 'A new subject' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.body, text);
  assert.equal(r.body.message.subject, 'A new subject');
  const blocks = typeof m.email_blocks === 'string' ? JSON.parse(m.email_blocks) : m.email_blocks;
  assert.deepEqual(blocks, library.textToBlocks(text));
  assert.equal(blocks[2].html, '<p>Bring:</p><ul><li>your card &amp; ID</li></ul>');
  assert.equal(m.status, 'draft');
});

test('edit refusals: "{{", bidi and control characters, too long; an APPROVED email refuses until unapproved', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const { msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  const edit = (m, body, subject) =>
    api(app.baseUrl, 'PUT', `/api/tc/messages/${m.message_id}?office=roland`, subject === undefined ? { body } : { body, subject });
  const original = msgs[0].body;
  for (const [bad, problem] of [
    ['Hi {{first_name}}, hello', 'MERGE_TOKEN'],
    ['Hi ‮olleh‬', 'FORBIDDEN_CHARACTER'],
    ['Hi​there', 'FORBIDDEN_CHARACTER'],
    ['Hi\u0007there', 'FORBIDDEN_CHARACTER'],
  ]) {
    const r = await edit(msgs[0], bad);
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.code, 'EMAIL_TEXT_INVALID');
    assert.equal(r.body.problem, problem);
  }
  const sub = await edit(msgs[0], original, 'Hello {{office_name}}');
  assert.equal(sub.body.code, 'EMAIL_TEXT_INVALID');
  assert.equal(sub.body.field, 'subject');
  const long = await edit(msgs[0], 'x'.repeat(8001));
  assert.equal(long.status, 400, 'the contract max (8000) refuses first');
  assert.equal(msgs[0].body, original, 'unchanged');

  await api(app.baseUrl, 'POST', N(`/messages/${msgs[1].message_id}/approve?office=roland`), {});
  const r = await edit(msgs[1], 'A changed text');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'MESSAGE_NOT_EDITABLE');
  assert.match(r.body.error, /Unapprove it first/);
  await api(app.baseUrl, 'POST', N(`/messages/${msgs[1].message_id}/unapprove?office=roland`), {});
  const ok = await edit(msgs[1], 'A changed text');
  assert.equal(ok.status, 200, 'editable again once it is a draft');
});

test('nurtureEmailTextProblem: the shared rule', () => {
  assert.equal(contract.nurtureEmailTextProblem('Hi\n\nthere'), null, 'newlines are paragraphs');
  assert.equal(contract.nurtureEmailTextProblem('a <b> [c]'), null, 'brackets are escaped into the blocks');
  assert.equal(contract.nurtureEmailTextProblem('  '), 'EMPTY');
  assert.equal(contract.nurtureEmailTextProblem('{{x}}'), 'MERGE_TOKEN');
  assert.equal(contract.nurtureEmailTextProblem('a\tb'), 'FORBIDDEN_CHARACTER');
  assert.equal(contract.nurtureEmailTextProblem('a\r\nb'), 'FORBIDDEN_CHARACTER', 'the service normalizes CRLF first');
  assert.equal(contract.nurtureEmailTextProblem('a﻿b'), 'FORBIDDEN_CHARACTER');
  assert.equal(contract.nurtureEmailTextProblem('x'.repeat(8001)), 'TOO_LONG');
});

// ── the real sendMessage refuses an approved email ─────────────────────────

test('the REAL sendMessage refuses a scheduled email (only a draft is sendable); it stays scheduled', async (t) => {
  fixClock(t);
  const app = await boot(t);
  const { msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  await api(app.baseUrl, 'POST', N(`/messages/${msgs[0].message_id}/approve?office=roland`), {});
  let adapterCalls = 0;
  const origGet = adapters.getAdapter;
  adapters.getAdapter = (...a) => {
    adapterCalls += 1;
    return origGet(...a);
  };
  t.after(() => {
    adapters.getAdapter = origGet;
  });
  const r = await api(app.baseUrl, 'POST', `/api/tc/messages/${msgs[0].message_id}/send?office=roland`, {});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'MESSAGE_NOT_SENDABLE');
  assert.equal(r.body.status, 'scheduled');
  assert.equal(msgs[0].status, 'scheduled');
  assert.equal(adapterCalls, 0, 'no adapter was even looked up');
  assert.deepEqual([...contract.SENDABLE_MESSAGE_STATUSES], ['draft']);
});

// ── stop, pause, replied, resume ────────────────────────────────────────────

test('Stop (by a person) cancels every waiting email — drafts AND approved — with stopped_by_user; sent ones stay', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const { e, msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  await api(app.baseUrl, 'POST', N(`/messages/${msgs[1].message_id}/approve?office=roland`), {});
  await api(app.baseUrl, 'POST', N(`/messages/${msgs[2].message_id}/approve?office=roland`), {});
  Object.assign(msgs[0], { status: 'sent', sent_at: NOW.toISOString() });
  const r = await api(app.baseUrl, 'POST', N(`/enrollments/${e.enrollment_id}/stop?office=roland`), { reason: 'patient called to schedule' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.enrollment.status, 'stopped');
  assert.equal(r.body.enrollment.skippedCount, 4);
  assert.equal(msgs[0].status, 'sent');
  for (const m of msgs.slice(1)) {
    assert.equal(m.status, 'skipped');
    assert.equal(m.skip_reason, 'stopped_by_user');
    assert.equal(m.skipped_by, 'tc@carein.ai');
  }
  const ev = app.db.table('tc_case_events').find((x) => x.type === 'nurture_stopped');
  assert.match(ev.description, /stopped by the TC: patient called to schedule — 4 waiting messages cancelled/);
  assert.equal(audits(app, 'tc_message.skipped').length, 4, 'each cancelled email on the trail');
});

test('Stop cancels a HAND-WRITTEN campaign\'s leftover draft too (it used to stay sendable)', async (t) => {
  armNeverSend(t);
  const app = await boot(t);
  const { e, m } = seedHandWritten(app.db, seedCase(app.db, { status: 'nurture' }));
  const r = await api(app.baseUrl, 'POST', N(`/enrollments/${e.enrollment_id}/stop?office=roland`), { reason: 'done' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(m.status, 'skipped');
  assert.equal(m.skip_reason, 'stopped_by_user');
});

test('the stop hooks cancel with the right reason: case_terminal, opted_out (opt-out, STOP), for both kinds', async (t) => {
  armNeverSend(t);
  const app = await boot(t);
  const db = app.db;
  // Terminal case: one library + one hand-written campaign on two cases.
  const c1 = seedCase(db, { status: 'nurture' });
  const lib1 = seedCampaign(db, c1);
  await hooks.stopForTerminalCase(db, { office: 'roland', caseId: c1.case_id, newStatus: 'accepted', actor: 'tc@carein.ai' });
  assert.equal(lib1.e.status, 'stopped');
  assert.ok(lib1.msgs.every((m) => m.status === 'skipped' && m.skip_reason === 'case_terminal'));
  assert.match(db.table('tc_case_events').at(-1).description, /case moved to accepted — 5 waiting messages cancelled/);
  const c2 = seedCase(db, { status: 'nurture', email: 'other.test2@example.com', phone: '(918) 555-0143' });
  const hw = seedHandWritten(db, c2);
  await hooks.stopForTerminalCase(db, { office: 'roland', caseId: c2.case_id, newStatus: 'lost', actor: 'tc@carein.ai' });
  assert.equal(hw.m.skip_reason, 'case_terminal');

  // An email opt-out (the unsubscribe link and a manual opt-out both call onOptOut).
  const c3 = seedCase(db, { status: 'nurture', email: 'optout.test2@example.com', phone: '(918) 555-0144' });
  const lib3 = seedCampaign(db, c3);
  await hooks.onOptOut(db, { office: 'roland', channel: 'email', address: 'optout.test2@example.com', actor: 'system:unsubscribe_link' });
  assert.ok(lib3.msgs.every((m) => m.status === 'skipped' && m.skip_reason === 'opted_out'));

  // A STOP text stops (and cancels); any other reply only PAUSES (and cancels nothing).
  const c4 = seedCase(db, { status: 'nurture', email: 'reply.test2@example.com', phone: '(918) 555-0145' });
  const hw4 = seedHandWritten(db, c4);
  const lib4 = seedCampaign(db, seedCase(db, { status: 'nurture', email: 'reply2.test2@example.com', phone: '(918) 555-0146' }));
  const out = await hooks.onInboundMessage(db, { office: 'roland', channel: 'sms', fromAddress: '+19185550146', stop: false });
  assert.deepEqual(out.paused, [lib4.e.enrollment_id]);
  assert.ok(lib4.msgs.every((m) => m.status === 'draft'), 'a pause cancels nothing');
  await hooks.onInboundMessage(db, { office: 'roland', channel: 'sms', fromAddress: '+19185550145', stop: true });
  assert.equal(hw4.e.status, 'stopped');
  assert.equal(hw4.m.skip_reason, 'opted_out');
});

test('"Patient replied" pauses (reason patient_replied, marked by the actor) and cancels nothing', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const { e, msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  await api(app.baseUrl, 'POST', N(`/messages/${msgs[0].message_id}/approve?office=roland`), {});
  const r = await api(app.baseUrl, 'POST', N(`/enrollments/${e.enrollment_id}/replied?office=roland`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.enrollment.status, 'paused');
  assert.equal(r.body.enrollment.stopReason, 'patient_replied');
  assert.deepEqual(msgs.map((m) => m.status), ['scheduled', 'draft', 'draft', 'draft', 'draft'], 'nothing cancelled');
  const ev = app.db.table('tc_case_events').find((x) => x.type === 'nurture_paused');
  assert.match(ev.description, /paused: the patient replied \(marked by tc@carein\.ai\)/);
  assert.equal(audits(app, 'tc_nurture_enrollment.replied').length, 1);
  const other = await api(app.baseUrl, 'POST', N(`/enrollments/${e.enrollment_id}/replied?office=valley`), {});
  assert.equal(other.body.code, 'OFFICE_MISMATCH');
});

test('Resume re-plans the late emails forward from now: order and gaps kept, caps hold, approvals kept, never bunched', async (t) => {
  armNeverSend(t);
  const app = await boot(t);
  // Planned 20 days ago, paused since: emails 1 and 2 are late.
  const enrolledAt = new Date(Date.now() - 20 * 24 * 3600 * 1000);
  const { e, msgs, steps } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }), { enrolledAt });
  msgs[1].status = 'scheduled';
  msgs[1].approved_by = 'tc@carein.ai';
  msgs[1].approved_at = enrolledAt.toISOString();
  e.status = 'paused';
  const start = Date.now();
  const r = await api(app.baseUrl, 'POST', N(`/enrollments/${e.enrollment_id}/resume?office=roland`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.enrollment.status, 'active');
  const times = msgs.map((m) => new Date(m.scheduled_for));
  assert.ok(times.every((x) => x.getTime() >= start - 1000), 'nothing left in the past');
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], 'order kept');
    const gapDays = engine.localDaysBetween(TZ, times[i - 1], times[i]);
    assert.ok(gapDays >= steps[i].day - steps[i - 1].day, `gap ${i} kept (${gapDays})`);
  }
  assert.equal(engine.capViolation(TZ, times), null);
  assert.ok(times.every((x) => engine.isInSendWindow(TZ, x)));
  assert.equal(msgs[1].status, 'scheduled', 'approval kept');
  const ev = app.db.table('tc_case_events').find((x) => x.type === 'nurture_resumed');
  assert.match(ev.description, /late emails? re-planned from today, in order and spaced as before \(approvals kept\)/);
  assert.ok(audits(app, 'tc_message.replanned').length >= 2);
});

// ── the nightly catch-up of a #359-era campaign ────────────────────────────

test('nightly catch-up: a #359-era campaign (one draft written, one sent) gets ALL remaining steps once; the old draft gets a time', async (t) => {
  withEnv(t, PHONE_ENV, OFFICE_PHONE);
  armNeverSend(t);
  const app = await boot(t);
  const db = app.db;
  const c = seedCase(db, { status: 'nurture' });
  const steps = library.sequenceFor('warm_followup', 'crown');
  // Under #359 the nightly pass had written steps 0 and 1 (one a night): step
  // 0 was sent by hand, step 1 is still a draft with no planned time.
  const e = {
    enrollment_id: randomUUID(),
    case_id: c.case_id,
    office_id: 'roland',
    track_key: 'warm_followup',
    intensity_at_enroll: 'standard',
    status: 'active',
    stop_reason: null,
    next_touch_index: 2,
    next_touch_due_at: '2026-11-20T11:00:00.000Z',
    last_touch_at: '2026-11-18T11:00:00.000Z',
    created_by: 'tc@carein.ai',
    created_at: '2026-11-15T15:00:00.000Z',
    updated_at: '2026-11-18T11:00:00.000Z',
    library_procedure_id: 'crown',
    library_variant: 'A',
  };
  db.table('tc_nurture_enrollments').push(e);
  const base = { office_id: 'roland', case_id: c.case_id, direction: 'outbound', channel: 'email', enrollment_id: e.enrollment_id };
  db.table('tc_messages').push(
    { ...base, message_id: randomUUID(), status: 'sent', touch_key: steps[0].stage, template_id: 'library.crown.tp_recap.A', created_at: new Date('2026-11-16T11:00:00.000Z'), sent_at: new Date('2026-11-16T16:00:00.000Z'), scheduled_for: null },
    { ...base, message_id: randomUUID(), status: 'draft', touch_key: steps[1].stage, template_id: `library.crown.${steps[1].stage}.A`, created_at: new Date('2026-11-18T11:00:00.000Z'), sent_at: null, scheduled_for: null, subject: 'x', to_address: c.email }
  );
  const now = new Date('2026-12-01T11:00:00.000Z'); // Tue 05:00 CST
  const out = await generator.runForOffice({ pool: db, tenantSlug: 'carein', office: 'roland', now, tz: TZ });
  assert.equal(out.queued, 1, JSON.stringify(out));
  assert.equal(out.errors, 0);
  const msgs = db.table('tc_messages');
  assert.equal(msgs.length, 10, '2 old + the 8 remaining');
  assert.deepEqual(msgs.slice(2).map((m) => m.touch_key), steps.slice(2).map((s) => s.stage));
  const waiting = msgs.filter((m) => m.status === 'draft');
  assert.equal(waiting.length, 9);
  assert.ok(waiting.every((m) => m.scheduled_for), 'the #359 draft got a planned time too');
  const times = waiting.map((m) => new Date(m.scheduled_for));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], 'in order');
  assert.ok(times.every((x) => x >= now && engine.isInSendWindow(TZ, x)));
  assert.equal(engine.capViolation(TZ, [new Date('2026-11-16T16:00:00.000Z'), ...times]), null, 'caps hold with the sent one');
  assert.equal(e.next_touch_index, 10);
  assert.equal(e.next_touch_due_at, null);
  assert.equal(e.status, 'active');
  const ev = db.table('tc_case_events').filter((x) => x.type === 'nurture_touch_queued');
  assert.equal(ev.length, 1);
  assert.match(ev[0].description, /8 emails written for review at once \(steps 3–10 of 10\)/);

  // Exactly once.
  const again = await generator.runForOffice({ pool: db, tenantSlug: 'carein', office: 'roland', now, tz: TZ });
  assert.equal(again.due, 0);
  assert.equal(db.table('tc_messages').length, 10);
});

// ── reads ───────────────────────────────────────────────────────────────────

test('GET /enrollments/:id/campaign: the emails in order with planned times; audited; office from the row', async (t) => {
  fixClock(t);
  armNeverSend(t);
  const app = await boot(t);
  const { e, msgs } = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }));
  await api(app.baseUrl, 'POST', N(`/messages/${msgs[2].message_id}/approve?office=roland`), {});
  const r = await api(app.baseUrl, 'GET', N(`/enrollments/${e.enrollment_id}/campaign?office=roland`));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(contract.NurtureCampaignResponse.safeParse(r.body).success, true);
  assert.equal(r.body.automaticSending, false, 'no sender in EL-2c');
  assert.deepEqual(r.body.emails.map((x) => x.stepIndex), [0, 1, 2, 3, 4]);
  assert.deepEqual(r.body.emails.map((x) => x.message.status), ['draft', 'draft', 'scheduled', 'draft', 'draft']);
  assert.equal(r.body.enrollment.approvedCount, 1);
  assert.equal(r.body.patientName, 'Test 2, Stedi');
  assert.equal(audits(app, 'tc_nurture_campaign').length, 1);
  const other = await api(app.baseUrl, 'GET', N(`/enrollments/${e.enrollment_id}/campaign?office=valley`));
  assert.equal(other.body.code, 'OFFICE_MISMATCH');
});

test('the outbox: library campaigns per case with a needs-approval count, by planned time; hand-written drafts stay in their groups', async (t) => {
  fixClock(t);
  armNeverSend(t);
  switchNurture(t, { roland: true });
  const app = await boot(t);
  const late = seedCampaign(app.db, seedCase(app.db, { status: 'nurture' }), { enrolledAt: new Date('2026-12-03T15:00:00.000Z') });
  const early = seedCampaign(app.db, seedCase(app.db, { status: 'nurture', email: 'b.test2@example.com' }));
  await api(app.baseUrl, 'POST', N(`/messages/${early.msgs[0].message_id}/approve?office=roland`), {});
  seedHandWritten(app.db, seedCase(app.db, { status: 'nurture', email: 'c.test2@example.com' }));
  const r = await api(app.baseUrl, 'GET', N('/outbox?office=roland'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.automaticSending, false);
  assert.deepEqual(r.body.campaigns.map((c) => c.enrollment.enrollmentId), [early.e.enrollment_id, late.e.enrollment_id]);
  assert.equal(r.body.campaigns[0].needsApproval, 4);
  assert.equal(r.body.campaigns[0].emails[0].message.status, 'scheduled');
  const planned = r.body.campaigns[0].emails.map((x) => Date.parse(x.message.scheduledFor));
  assert.deepEqual(planned, planned.slice().sort((a, b) => a - b), 'sorted by planned time');
  assert.equal(r.body.groups.length, 1);
  assert.equal(r.body.groups[0].drafts.length, 1, 'the hand-written draft');
  assert.ok(r.body.groups.every((g) => g.drafts.every((d) => !d.message.templateId.startsWith('library.'))));
});

test('no Open Dental and no send in the code this slice adds', () => {
  const FORBIDDEN = [/openDental|apiGetRaw|apiPostRaw|apiPutRaw|getOdOffice|assertOfficeMatch|odPatientCache|readOdTextConsent/i, /canMessage/, /getAdapter|adapter\.send|\.send\s*\(/, /sendMessage\s*\(/];
  for (const fn of [
    messaging.approveNurtureEmail,
    messaging.approveAllNurtureEmails,
    messaging.unapproveNurtureEmail,
    messaging.rescheduleNurtureEmail,
    messaging.replanLateEmails,
    messaging.settleNurtureAfterSend,
  ]) {
    const src = fn.toString();
    for (const re of FORBIDDEN) assert.ok(!re.test(src), `${fn.name} matches ${re}`);
  }
  const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations-tenant', '1795600000000_tc_messages_scheduled.js'), 'utf8');
  assert.doesNotMatch(migration, /\bGRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/, 'no new grants');
  assert.doesNotMatch(migration, /openDental/i);
  // The route file: the EL-2c handlers never call sendMessage (only the
  // messages route's Send click does, unchanged).
  const route = fs.readFileSync(path.join(__dirname, 'nurture.js'), 'utf8');
  assert.doesNotMatch(route, /sendMessage\s*\(/);
});
