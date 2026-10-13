'use strict';

/**
 * The nightly nurture generator (item 47): it writes DRAFTS and never sends,
 * never reads Open Dental, respects the caps at run time, flags (never skips)
 * a touch consent would block, and completes an exhausted track.
 *
 * Runs the generator's real SQL against FakeTenantDb (routes/tc/tcTestUtils),
 * the same in-memory store the TC route tests use.
 *
 * Fixtures are the designated test patients only: roland "Test 2, Stedi"
 * (PatNum 12827) and valley "Stedi TestValley" (PatNum 7115). Phones are
 * 555-01xx numbers.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { FakeTenantDb } = require('../../routes/tc/tcTestUtils');
const generator = require('./generator');
const engine = require('./engine');
const cfg = require('../../config/tcNurture');
const adapters = require('../messaging/adapters');
const messaging = require('../messaging');
const { TcNurtureScheduler } = require('./scheduler');

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
    ...over,
  };
  db.table('tc_cases').push(row);
  return row;
}

function seedEnrollment(db, tcCase, over = {}) {
  const row = {
    enrollment_id: randomUUID(),
    case_id: tcCase.case_id,
    office_id: tcCase.office_id,
    track_key: 'no_show_recovery',
    intensity_at_enroll: 'standard',
    status: 'active',
    stop_reason: null,
    next_touch_index: 0,
    next_touch_due_at: '2026-10-14T05:00:00.000Z',
    last_touch_at: null,
    created_by: 'tc@carein.ai',
    created_at: '2026-10-13T15:00:00.000Z',
    updated_at: '2026-10-13T15:00:00.000Z',
    ...over,
  };
  db.table('tc_nurture_enrollments').push(row);
  return row;
}

/** 05:00 CDT on a date. */
const fiveAm = (ymd) => new Date(`${ymd}T10:00:00.000Z`);

/** Trip-wires: if anything reached a send, these flip. */
function armSendTripwires(t) {
  const hits = { adapter: 0, sendMessage: 0 };
  const origGet = adapters.getAdapter;
  const origSend = messaging.sendMessage;
  adapters.getAdapter = (...a) => {
    hits.adapter += 1;
    return origGet(...a);
  };
  messaging.sendMessage = async () => {
    hits.sendMessage += 1;
    throw new Error('the generator must never send');
  };
  t.after(() => {
    adapters.getAdapter = origGet;
    messaging.sendMessage = origSend;
  });
  return hits;
}

test('a due touch becomes ONE draft, the enrollment advances, an event is written — and nothing is sent', async (t) => {
  const hits = armSendTripwires(t);
  const db = new FakeTenantDb();
  const c = seedCase(db);
  const e = seedEnrollment(db, c);
  const now = fiveAm('2026-10-14');
  const out = await generator.runForOffice({ pool: db, office: 'roland', now, tz: TZ });
  assert.equal(out.due, 1);
  assert.equal(out.queued, 1);
  assert.deepEqual(hits, { adapter: 0, sendMessage: 0 });

  const msgs = db.table('tc_messages');
  assert.equal(msgs.length, 1);
  const m = msgs[0];
  assert.equal(m.status, 'draft');
  assert.equal(m.direction, 'outbound');
  assert.equal(m.channel, 'sms');
  assert.equal(m.to_address, '+19185550142');
  assert.equal(m.enrollment_id, e.enrollment_id);
  assert.equal(m.touch_key, 'ns1');
  assert.equal(m.template_id, 'nurture.no_show_recovery.ns1');
  assert.equal(m.created_by, 'system:nurture');
  assert.equal(m.consent_blocked_hint, null);
  assert.equal(m.provider, undefined);
  assert.ok(m.body.endsWith('Reply STOP to opt out.'));
  assert.match(m.body, /^Hi Stedi,/);

  const enr = db.table('tc_nurture_enrollments')[0];
  assert.equal(enr.next_touch_index, 1);
  assert.equal(enr.last_touch_at, now.toISOString());
  // ns2 is @4, ns1 @1 ⇒ 3 local days after the touch.
  assert.equal(engine.localDaysBetween(TZ, now, new Date(enr.next_touch_due_at)), 3);
  const ev = db.table('tc_case_events');
  assert.deepEqual(ev.map((x) => x.type), ['nurture_touch_queued']);
  assert.match(ev[0].description, /text draft queued for review/);
  // No audit rows from a 05:00 system pass.
  assert.equal(db.table('audit_log').length, 0);
});

test('a second pass the same night drafts nothing more (the claim is index-conditional)', async () => {
  const db = new FakeTenantDb();
  seedEnrollment(db, seedCase(db));
  const now = fiveAm('2026-10-14');
  await generator.runForOffice({ pool: db, office: 'roland', now, tz: TZ });
  const again = await generator.runForOffice({ pool: db, office: 'roland', now, tz: TZ });
  assert.equal(again.due, 0);
  assert.equal(db.table('tc_messages').length, 1);
});

test('a lost claim (stopped between read and write) writes no draft', async () => {
  const db = new FakeTenantDb();
  const c = seedCase(db);
  const e = seedEnrollment(db, c);
  // Simulate a TC's stop landing after the generator read the row.
  const due = await require('./store').listDue(db, 'roland', fiveAm('2026-10-14').toISOString());
  db.table('tc_nurture_enrollments')[0].status = 'stopped';
  db.table('tc_nurture_enrollments')[0].stop_reason = 'patient called';
  const outcome = await generator.processEnrollment(db, 'roland', due[0], {
    tz: TZ,
    now: fiveAm('2026-10-14'),
    merge: cfg.officeMergeValues('roland'),
  });
  assert.equal(outcome, 'lost_claim');
  assert.equal(db.table('tc_messages').length, 0);
  assert.equal(e.status, 'stopped');
});

test('consent blocked at draft time ⇒ STILL drafted, with the advisory hint (no silent skip)', async () => {
  const db = new FakeTenantDb();
  const c = seedCase(db);
  seedEnrollment(db, c);
  db.table('tc_contact_consent').push({
    consent_id: randomUUID(),
    office_id: 'roland',
    channel: 'sms',
    address: '+19185550142',
    state: 'opted_out',
    source: 'stop_keyword',
    note: null,
    updated_by: 'system:inbound',
    updated_at: new Date(),
  });
  await generator.runForOffice({ pool: db, office: 'roland', now: fiveAm('2026-10-14'), tz: TZ });
  const m = db.table('tc_messages')[0];
  assert.equal(m.status, 'draft');
  assert.equal(m.consent_blocked_hint, 'opted_out');
  assert.match(db.table('tc_case_events')[0].description, /flagged: opted out/);
});

test('no usable address ⇒ drafted with no to_address and hint no_address; the send path refuses it', async () => {
  const db = new FakeTenantDb();
  const c = seedCase(db, { phone: null });
  seedEnrollment(db, c);
  await generator.runForOffice({ pool: db, office: 'roland', now: fiveAm('2026-10-14'), tz: TZ });
  const m = db.table('tc_messages')[0];
  assert.equal(m.to_address, null);
  assert.equal(m.consent_blocked_hint, 'no_address');
  // sendMessage refuses a draft with no address before anything else.
  const src = fs.readFileSync(path.join(__dirname, '..', 'messaging', 'index.js'), 'utf8');
  assert.match(src, /if \(!existing\.to_address\) \{\s*throw noAddressError\(existing\.channel\);/);
});

test('email touch: the case nurture_unsubscribed flag is flagged; blocks + CTA snapshot is stored', async () => {
  const db = new FakeTenantDb();
  const c = seedCase(db, { nurture_unsubscribed: true });
  seedEnrollment(db, c, { track_key: 'large_case', intensity_at_enroll: 'gentle' }); // lc1 @5, email
  const prev = process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND;
  process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = '(918) 555-0100';
  try {
    await generator.runForOffice({ pool: db, office: 'roland', now: fiveAm('2026-10-14'), tz: TZ });
  } finally {
    if (prev === undefined) delete process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND;
    else process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = prev;
  }
  const m = db.table('tc_messages')[0];
  assert.equal(m.channel, 'email');
  assert.equal(m.to_address, 'stedi.test2@example.com');
  assert.equal(m.subject, 'The smile you talked about, step by step');
  assert.equal(m.consent_blocked_hint, 'email_unsubscribed');
  assert.deepEqual(m.email_blocks.map((b) => b.type), ['text', 'button']);
  assert.equal(m.email_blocks[1].href, 'tel:+19185550100');
});

test('caps at run time: a touch inside 48h of the last one is DEFERRED, not drafted', async () => {
  const db = new FakeTenantDb();
  const c = seedCase(db);
  const e = seedEnrollment(db, c, { next_touch_index: 1, next_touch_due_at: '2026-10-14T05:00:00.000Z' });
  // A touch was queued yesterday (e.g. the schedule was resumed oddly).
  db.table('tc_messages').push({
    message_id: randomUUID(),
    office_id: 'roland',
    case_id: c.case_id,
    direction: 'outbound',
    channel: 'sms',
    status: 'sent',
    enrollment_id: e.enrollment_id,
    touch_key: 'ns1',
    created_at: fiveAm('2026-10-13').toISOString(),
  });
  const out = await generator.runForOffice({ pool: db, office: 'roland', now: fiveAm('2026-10-14'), tz: TZ });
  assert.equal(out.deferred, 1);
  assert.equal(db.table('tc_messages').length, 1);
  assert.equal(e.next_touch_index, 1);
  assert.equal(e.next_touch_due_at, '2026-10-15T05:00:00.000Z');
});

test('the STOP suffix rides every SMS until one has actually gone out; then it stops', async () => {
  const db = new FakeTenantDb();
  const c = seedCase(db);
  // warm_followup/gentle: wf2 E @3, wf3 S @10 (no suffix in its copy), …
  const e = seedEnrollment(db, c, {
    track_key: 'warm_followup',
    intensity_at_enroll: 'gentle',
    next_touch_index: 1,
    next_touch_due_at: '2026-10-14T05:00:00.000Z',
  });
  await generator.runForOffice({ pool: db, office: 'roland', now: fiveAm('2026-10-14'), tz: TZ });
  const wf3 = db.table('tc_messages').find((m) => m.touch_key === 'wf3');
  assert.ok(wf3.body.endsWith('Reply STOP to opt out.'), 'first SMS carries it');

  // Mark it sent, then run wf8 (index 3) — no suffix now.
  wf3.status = 'sent';
  e.next_touch_index = 3;
  e.next_touch_due_at = '2026-11-20T06:00:00.000Z';
  await generator.runForOffice({ pool: db, office: 'roland', now: fiveAm('2026-11-20'), tz: TZ });
  const wf8 = db.table('tc_messages').find((m) => m.touch_key === 'wf8');
  assert.ok(!wf8.body.includes('Reply STOP'), wf8.body);
});

test('the last touch completes the enrollment (no auto-chaining)', async () => {
  const db = new FakeTenantDb();
  const c = seedCase(db);
  const e = seedEnrollment(db, c, { next_touch_index: 2 }); // ns3 is the last of standard
  await generator.runForOffice({ pool: db, office: 'roland', now: fiveAm('2026-10-14'), tz: TZ });
  assert.equal(e.status, 'completed');
  assert.equal(e.next_touch_due_at, null);
  assert.deepEqual(db.table('tc_case_events').map((x) => x.type), ['nurture_touch_queued', 'nurture_completed']);
  assert.equal(db.table('tc_nurture_enrollments').length, 1, 'no new enrollment was chained on');
});

test('a case that went terminal behind the hook is stopped, not drafted for', async () => {
  const db = new FakeTenantDb();
  const c = seedCase(db, { status: 'scheduled' });
  const e = seedEnrollment(db, c);
  const out = await generator.runForOffice({ pool: db, office: 'roland', now: fiveAm('2026-10-14'), tz: TZ });
  assert.equal(out.stopped, 1);
  assert.equal(e.status, 'stopped');
  assert.equal(e.stop_reason, 'case_terminal');
  assert.equal(db.table('tc_messages').length, 0);
});

test('office scoping: a valley enrollment is invisible to a roland pass', async () => {
  const db = new FakeTenantDb();
  const v = seedCase(db, { office_id: 'valley', patient_name: 'Stedi TestValley', od_patient_id: 7115, phone: '(479) 555-0177' });
  seedEnrollment(db, v);
  const out = await generator.runForOffice({ pool: db, office: 'roland', now: fiveAm('2026-10-14'), tz: TZ });
  assert.equal(out.due, 0);
  const vout = await generator.runForOffice({ pool: db, office: 'valley', now: fiveAm('2026-10-14'), tz: TZ });
  assert.equal(vout.queued, 1);
  assert.equal(db.table('tc_messages')[0].office_id, 'valley');
});

test('the nurture service files never reach a send path or Open Dental', () => {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  assert.deepEqual(files.sort(), ['engine.js', 'generator.js', 'hooks.js', 'scheduler.js', 'store.js']);
  const FORBIDDEN = [
    /require\(['"]\.\.\/messaging['"]\)/, // the messaging service (sendMessage)
    /require\(['"]\.\.\/messaging\/index/,
    /require\(['"]\.\.\/messaging\/adapters/,
    /require\(['"][^'"]*twilio/i,
    /require\(['"][^'"]*acs\//i,
    /sendMessage\s*\(/,
    /\.send\s*\(/,
    /apiGetRaw|apiPostRaw|apiPutRaw|apiDeleteRaw/,
    /getOdOffice|assertOfficeMatch|odPatientCache|readOdTextConsent|canMessage/,
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const re of FORBIDDEN) assert.ok(!re.test(src), `${f} matches ${re}`);
  }
});

test('scheduler: dark with no row; runs only switched-on offices; refuses an ambiguous tenant', async () => {
  const calls = [];
  const mk = (setting, tenants = [{ tenant_id: 'T1', status: 'active' }]) =>
    new TcNurtureScheduler({
      now: () => fiveAm('2026-10-14'),
      registry: {
        getPlatformSetting: async () => setting,
        listTenants: async () => tenants,
        getEnabledModules: async () => ['tc'],
      },
      tenantDb: { getTenantPool: async () => ({}) },
      runForOffice: async ({ office }) => {
        calls.push(office);
        return { office, due: 0, queued: 0, completed: 0, deferred: 0, stopped: 0, lost_claim: 0, errors: 0, phoneConfigured: false, durationMs: 0 };
      },
    });
  assert.equal((await mk(null).runNow()).skipped, 'NO_SETTING_ROW');
  assert.deepEqual(calls, []);
  await mk({ value: { valley: true, roland: false } }).runNow();
  assert.deepEqual(calls, ['valley']);
  const amb = await mk({ value: { roland: true } }, [
    { tenant_id: 'T1', status: 'active' },
    { tenant_id: 'T2', status: 'active' },
  ]).runNow();
  assert.equal(amb.skipped, 'AMBIGUOUS_TC_TENANT');
  assert.deepEqual(calls, ['valley']);
});

test('scheduler arms 05:00 America/Chicago by default and not at all when killed', () => {
  const s = new TcNurtureScheduler();
  let armed = null;
  s.createJob = (schedule, tz) => {
    armed = { schedule, tz };
    return { stop() {} };
  };
  const prev = process.env.TC_NURTURE_ENABLED;
  try {
    delete process.env.TC_NURTURE_ENABLED;
    assert.equal(s.start(), true);
    assert.deepEqual(armed, { schedule: '0 5 * * *', tz: cfg.timezone() });
    s.stop();
    process.env.TC_NURTURE_ENABLED = 'false';
    armed = null;
    assert.equal(s.start(), false);
    assert.equal(armed, null);
  } finally {
    if (prev === undefined) delete process.env.TC_NURTURE_ENABLED;
    else process.env.TC_NURTURE_ENABLED = prev;
  }
});
