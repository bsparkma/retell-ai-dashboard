'use strict';

/**
 * EL-2: the nightly generator drafting from the patient email library.
 *
 *   - a library enrollment writes ONE email draft whose subject, preheader and
 *     body are exactly what compose() produces for the office's SAVED answers,
 *     merged; template_id library.<procedure>.<stage>.<variant>, touch_key the
 *     stage; nothing is sent (sendMessage THROWS if reached)
 *   - a second pass writes no second draft (the claim)
 *   - an unresolved merge field (the office phone unset after enrolling) writes
 *     no draft and does not advance; it is counted in `errors`
 *   - the boot cap check passes for the four library sequences and throws for a
 *     fixture that breaks the 48h gap
 *   - neither tcNurture nor tcEmailLibrary reaches Open Dental
 *
 * Hand-written enrollments are covered, unchanged, by tcNurtureGenerator.test.js
 * (its fixtures carry no library columns, and every one of its tests still
 * passes as written).
 *
 * Runs the generator's real SQL against FakeTenantDb. Fixtures are the
 * designated test patients only: roland "Test 2, Stedi" (PatNum 12827) and
 * valley "Stedi TestValley" (PatNum 7115). Phones are 555-01xx numbers; the
 * staff name is synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { FakeTenantDb } = require('../../routes/tc/tcTestUtils');
const generator = require('./generator');
const store = require('./store');
const adapters = require('../messaging/adapters');
const messaging = require('../messaging');
const library = require('../tcEmailLibrary');
const { compose } = require('../tcEmailLibrary/compose');
const contract = require('../../tc/contract.gen.cjs');

const TZ = 'America/Chicago';
const PHONE_ENV = { roland: 'TC_EMAIL_PRACTICE_PHONE_ROLAND', valley: 'TC_EMAIL_PRACTICE_PHONE_VALLEY' };
const OFFICE_PHONE = '(918) 555-0100';

/** 05:00 CDT/CST on a date. */
const fiveAm = (ymd) => new Date(`${ymd}T10:00:00.000Z`);

/** Set (or clear, with null) an env var for the rest of the test. */
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
    status: 'nurture',
    nurture_unsubscribed: false,
    nurture_enrolled_at: null,
    assigned_tc: 'Test Coordinator',
    ...over,
  };
  db.table('tc_cases').push(row);
  return row;
}

function seedLibraryEnrollment(db, tcCase, over = {}) {
  const row = {
    enrollment_id: randomUUID(),
    case_id: tcCase.case_id,
    office_id: tcCase.office_id,
    track_key: 'warm_followup',
    intensity_at_enroll: 'standard',
    status: 'active',
    stop_reason: null,
    next_touch_index: 0,
    next_touch_due_at: '2026-10-14T05:00:00.000Z',
    last_touch_at: null,
    created_by: 'tc@carein.ai',
    created_at: '2026-10-13T15:00:00.000Z',
    updated_at: '2026-10-13T15:00:00.000Z',
    library_procedure_id: 'crown',
    library_variant: 'A',
    ...over,
  };
  db.table('tc_nurture_enrollments').push(row);
  return row;
}

/** An office's saved wording answers, as PUT /api/tc/email-library/profile stores them. */
function seedProfile(db, office, answers) {
  const v = contract.validateEmailLibraryAnswers(answers);
  assert.ok(v.ok, JSON.stringify(v));
  db.table('tc_email_library_profile').push({
    office_id: office,
    answers: v.answers,
    library_version: library.LIBRARY_VERSION,
    updated_by: 'admin@carein.ai',
    updated_at: new Date(),
  });
  return v.answers;
}

/** Trip-wires: if anything reached a send, these flip (and sendMessage throws). */
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

/**
 * The email compose() itself produces for `answers`, merged with the values a
 * draft has — the expectation the generator must match byte for byte.
 */
function expectedEmail(answers, id, merge) {
  const email = compose(library.SOURCE, answers).find((x) => x.id === id);
  assert.ok(email, `compose() has ${id}`);
  const fill = (text) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in merge ? merge[k] : m));
  return { subject: fill(email.subject), preheader: fill(email.preheader), body: fill(email.body_text) };
}

const ANSWERS = { same_day_crowns: true, same_day_length: 'about two hours', insurance_mode: 'in_network' };

test('a library enrollment writes ONE email draft, exactly compose() for the saved answers — and nothing is sent', async (t) => {
  withEnv(t, PHONE_ENV.roland, OFFICE_PHONE);
  const hits = armSendTripwires(t);
  const db = new FakeTenantDb();
  const saved = seedProfile(db, 'roland', ANSWERS);
  const c = seedCase(db);
  const e = seedLibraryEnrollment(db, c);
  const now = fiveAm('2026-10-14');

  const out = await generator.runForOffice({ pool: db, tenantSlug: 'carein', office: 'roland', now, tz: TZ });
  assert.equal(out.due, 1);
  assert.equal(out.queued, 1);
  assert.equal(out.errors, 0);
  assert.deepEqual(hits, { adapter: 0, sendMessage: 0 });

  const msgs = db.table('tc_messages');
  assert.equal(msgs.length, 1);
  const m = msgs[0];
  const officeName = require('../../config/odOffices').describeOffice('roland').officeName;
  const want = expectedEmail(saved, 'crown.tp_recap.A', {
    first_name: 'Stedi',
    office_name: officeName,
    office_phone: OFFICE_PHONE,
    sender_name: 'Test Coordinator',
  });
  assert.equal(m.status, 'draft');
  assert.equal(m.channel, 'email');
  assert.equal(m.direction, 'outbound');
  assert.equal(m.to_address, 'stedi.test2@example.com');
  assert.equal(m.subject, want.subject);
  assert.equal(m.email_preheader, want.preheader);
  assert.ok(m.email_preheader.length > 0, 'preheader set');
  assert.equal(m.body, want.body);
  assert.equal(m.template_id, 'library.crown.tp_recap.A');
  assert.equal(m.touch_key, 'tp_recap');
  assert.equal(m.enrollment_id, e.enrollment_id);
  assert.equal(m.created_by, 'system:nurture');
  assert.equal(m.consent_blocked_hint, null);
  for (const text of [m.subject, m.email_preheader, m.body]) assert.ok(!text.includes('{{'), text);

  // Blocks: text only (no button), escaped, the signature paragraph intact.
  const blocks = typeof m.email_blocks === 'string' ? JSON.parse(m.email_blocks) : m.email_blocks;
  assert.ok(blocks.length >= 2);
  assert.ok(blocks.every((b) => b.type === 'text'), 'no button block');
  assert.ok(blocks.every((b) => contract.EmailBlock.safeParse(b).success));
  assert.match(blocks[blocks.length - 1].html, /Test Coordinator<br>/);

  // The enrollment advanced on the library's cadence: why_it_matters is day 3, tp_recap day 1.
  assert.equal(e.next_touch_index, 1);
  assert.equal(e.last_touch_at, now.toISOString());
  assert.equal(require('./engine').localDaysBetween(TZ, now, new Date(e.next_touch_due_at)), 2);
  const ev = db.table('tc_case_events');
  assert.deepEqual(ev.map((x) => x.type), ['nurture_touch_queued']);
  assert.match(ev[0].description, /email draft queued for review \(tp_recap, 1 of 10\)/);
  // No audit rows from a 05:00 system pass.
  assert.equal(db.table('audit_log').length, 0);
});

test('a second pass over the same enrollment writes no second draft (the claim)', async (t) => {
  withEnv(t, PHONE_ENV.roland, OFFICE_PHONE);
  const db = new FakeTenantDb();
  seedProfile(db, 'roland', ANSWERS);
  seedLibraryEnrollment(db, seedCase(db));
  const now = fiveAm('2026-10-14');
  await generator.runForOffice({ pool: db, tenantSlug: 'carein', office: 'roland', now, tz: TZ });
  const again = await generator.runForOffice({ pool: db, tenantSlug: 'carein', office: 'roland', now, tz: TZ });
  assert.equal(again.due, 0);
  assert.equal(db.table('tc_messages').length, 1);

  // And a stale read of the same row (the race the claim exists for) loses it.
  const due = await store.listDue(db, 'roland', fiveAm('2026-10-20').toISOString());
  const stale = { ...due[0], next_touch_index: 0 };
  const outcome = await generator.processEnrollment(db, 'roland', stale, {
    tz: TZ,
    now: fiveAm('2026-10-20'),
    merge: require('../../config/tcNurture').officeMergeValues('carein', 'roland'),
  });
  assert.equal(outcome, 'lost_claim');
  assert.equal(db.table('tc_messages').length, 1);
});

test('UNRESOLVED_MERGE: the office phone unset after enrolling ⇒ no draft, no advance, counts.errors = 1', async (t) => {
  withEnv(t, PHONE_ENV.roland, OFFICE_PHONE);
  const db = new FakeTenantDb();
  seedProfile(db, 'roland', ANSWERS);
  const e = seedLibraryEnrollment(db, seedCase(db));
  await generator.runForOffice({ pool: db, tenantSlug: 'carein', office: 'roland', now: fiveAm('2026-10-14'), tz: TZ });
  assert.equal(db.table('tc_messages').length, 1);
  const before = { index: e.next_touch_index, due: e.next_touch_due_at, last: e.last_touch_at, status: e.status };

  // Mid-stream: the office's phone is cleared, and the next touch comes due.
  delete process.env[PHONE_ENV.roland];
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let out;
  try {
    out = await generator.runForOffice({ pool: db, tenantSlug: 'carein', office: 'roland', now: fiveAm('2026-10-20'), tz: TZ });
  } finally {
    console.error = origError;
  }
  assert.equal(out.due, 1);
  assert.equal(out.errors, 1);
  assert.equal(out.queued, 0);
  assert.equal(db.table('tc_messages').length, 1, 'no second draft');
  assert.deepEqual({ index: e.next_touch_index, due: e.next_touch_due_at, last: e.last_touch_at, status: e.status }, before);
  assert.deepEqual(db.table('tc_case_events').map((x) => x.type), ['nurture_touch_queued'], 'no new event type, no new event');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /UNRESOLVED_MERGE: \{\{office_phone\}\}/);
  assert.ok(!errors[0].includes('Stedi'), 'the log line carries no patient name');
});

test('renderLibraryEmail throws LibraryRenderError UNRESOLVED_MERGE for any token left, never a blank', () => {
  const base = { first_name: 'Stedi', office_name: 'Roland Family Dental', office_phone: OFFICE_PHONE, sender_name: 'Test Coordinator' };
  const ok = library.renderLibraryEmail({ office: 'roland', answers: {}, procedureId: 'crown', stage: 'tp_recap', variant: 'B', merge: base });
  assert.ok(!/\{\{/.test(ok.subject + ok.preheader + ok.bodyText));
  for (const field of ['office_phone', 'office_name', 'sender_name', 'first_name']) {
    assert.throws(
      () =>
        library.renderLibraryEmail({
          office: 'roland',
          answers: {},
          procedureId: 'crown',
          stage: 'tp_recap',
          variant: 'B',
          merge: { ...base, [field]: field === 'first_name' ? '  ' : null },
        }),
      (err) => err instanceof library.LibraryRenderError && err.code === 'UNRESOLVED_MERGE' && err.token === field
    );
  }
});

test('a procedure that skips a stage leaves that step out, so every remaining step is one email', async (t) => {
  withEnv(t, PHONE_ENV.roland, OFFICE_PHONE);
  // recare skips cost_of_waiting (source.json); warm_followup has it at index 7.
  const steps = library.sequenceFor('warm_followup', 'recare');
  assert.equal(steps.length, 9);
  assert.ok(!steps.some((s) => s.stage === 'cost_of_waiting'));
  assert.equal(library.sequenceFor('warm_followup').length, 10);

  const db = new FakeTenantDb();
  const e = seedLibraryEnrollment(db, seedCase(db), { library_procedure_id: 'recare', next_touch_index: 7 });
  await generator.runForOffice({ pool: db, tenantSlug: 'carein', office: 'roland', now: fiveAm('2026-10-14'), tz: TZ });
  const m = db.table('tc_messages')[0];
  assert.equal(m.touch_key, 'objection_time', 'index 7 of the recare sequence is objection_time');
  assert.equal(m.template_id, 'library.recare.objection_time.A');
  assert.equal(store.toEnrollment(e, 1).nextTouchKey, 'last_touch');
});

test('the sender line: a name-shaped assigned TC signs; an SSO email or blank signs as the office team', async (t) => {
  withEnv(t, PHONE_ENV.valley, '(479) 555-0100');
  const db = new FakeTenantDb();
  const v = seedCase(db, {
    office_id: 'valley',
    patient_name: 'Stedi TestValley',
    od_patient_id: 7115,
    phone: '(479) 555-0177',
    email: 'stedi.testvalley@example.com',
    assigned_tc: 'tc@carein.ai',
  });
  seedLibraryEnrollment(db, v, { library_variant: 'C' });
  const out = await generator.runForOffice({ pool: db, tenantSlug: 'carein', office: 'valley', now: fiveAm('2026-10-14'), tz: TZ });
  assert.equal(out.queued, 1);
  const m = db.table('tc_messages')[0];
  const officeName = require('../../config/odOffices').describeOffice('valley').officeName;
  assert.equal(m.office_id, 'valley');
  assert.ok(m.body.includes(`The team at ${officeName}\n${officeName}\n(479) 555-0100`), m.body);
  assert.ok(!m.body.includes('carein.ai'), 'a staff email never signs a patient email');
  assert.equal(m.template_id, 'library.crown.tp_recap.C');
  const r = await generator.runForOffice({ pool: db, tenantSlug: 'carein', office: 'roland', now: fiveAm('2026-10-15'), tz: TZ });
  assert.equal(r.due, 0);

  assert.equal(generator.senderNameFor('Test Coordinator', 'X'), 'Test Coordinator');
  assert.equal(generator.senderNameFor('', 'X'), 'The team at X');
  assert.equal(generator.senderNameFor('{{office_phone}}', 'X'), 'The team at X');
  assert.equal(generator.senderNameFor('A <b>', 'X'), 'The team at X');
  assert.equal(generator.senderNameFor(null, null), null);
});

test('consent: an opted-out email address is still drafted, with the advisory hint (same rule as hand-written)', async (t) => {
  withEnv(t, PHONE_ENV.roland, OFFICE_PHONE);
  const db = new FakeTenantDb();
  const c = seedCase(db, { nurture_unsubscribed: true });
  seedLibraryEnrollment(db, c);
  await generator.runForOffice({ pool: db, tenantSlug: 'carein', office: 'roland', now: fiveAm('2026-10-14'), tz: TZ });
  const m = db.table('tc_messages')[0];
  assert.equal(m.status, 'draft');
  assert.equal(m.consent_blocked_hint, 'email_unsubscribed');
});

test('boot cap check: the four library sequences pass; a fixture breaking the 48h gap throws', () => {
  assert.deepEqual(library.librarySequenceViolations(), []);
  assert.doesNotThrow(() => library.assertLibrarySequencesWithinCaps());
  // It runs at require time, like assertPresetsWithinCaps (source pin).
  const src = fs.readFileSync(path.join(__dirname, '..', 'tcEmailLibrary', 'index.js'), 'utf8');
  assert.match(src, /^assertLibrarySequencesWithinCaps\(\);$/m);

  const bad = library.SOURCE.sequences.map((q) =>
    q.id === 'large_case'
      ? { ...q, steps: [{ stage: 'tp_recap', when: 'day 1' }, { stage: 'what_to_expect', when: 'day 2' }, ...q.steps.slice(2)] }
      : q
  );
  assert.throws(() => library.assertLibrarySequencesWithinCaps(bad), /library\/large_case: tp_recap@1 → what_to_expect@2 is under 48h/);

  const crowded = library.SOURCE.sequences.map((q) =>
    q.id === 'reactivation'
      ? { ...q, steps: ['day 0', 'day 2', 'day 4', 'day 6'].map((when, i) => ({ stage: q.steps[i].stage, when })).concat(q.steps.slice(4)) }
      : q
  );
  assert.throws(() => library.assertLibrarySequencesWithinCaps(crowded), /4 touches in the 7 days from day 0/);

  const missing = library.SOURCE.sequences.filter((q) => q.id !== 'no_show_recovery');
  assert.throws(() => library.assertLibrarySequencesWithinCaps(missing), /no sequence with id 'no_show_recovery'/);
});

test('textToBlocks: one text block per paragraph, a run of "- " lines becomes a <ul>, everything escaped', () => {
  const blocks = library.textToBlocks('Hi Stedi,\n\nBring:\n- your card & ID\n- a list <of> meds\nThanks\n\nTeam\nOffice');
  assert.deepEqual(
    blocks.map((b) => b.html),
    [
      '<p>Hi Stedi,</p>',
      '<p>Bring:</p><ul><li>your card &amp; ID</li><li>a list &lt;of&gt; meds</li></ul><p>Thanks</p>',
      '<p>Team<br>Office</p>',
    ]
  );
  assert.deepEqual(blocks.map((b) => b.id), ['library-1', 'library-2', 'library-3']);
  // The renderer reduces it to the text a patient reads, bullets included.
  assert.equal(contract.htmlToPlainText(blocks[1].html), 'Bring:\n• your card & ID\n• a list <of> meds\nThanks');
});

test('neither the nurture service nor the email library reaches Open Dental, a send, or an AI model', () => {
  const FORBIDDEN = [
    /require\(['"]\.\.\/messaging['"]\)/,
    /require\(['"]\.\.\/messaging\/index/,
    /require\(['"]\.\.\/messaging\/adapters/,
    /sendMessage\s*\(/,
    /apiGetRaw|apiPostRaw|apiPutRaw|apiDeleteRaw/,
    /getOdOffice|assertOfficeMatch|odPatientCache|readOdTextConsent|canMessage/,
    /require\(['"][^'"]*openDental/i,
    /require\(['"][^'"]*(openai|azureOpenAi|anthropic)/i,
  ];
  const dirs = [__dirname, path.join(__dirname, '..', 'tcEmailLibrary')];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const re of FORBIDDEN) assert.ok(!re.test(src), `${path.basename(dir)}/${f} matches ${re}`);
    }
  }
});
