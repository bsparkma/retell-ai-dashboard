'use strict';

/**
 * Referral letter enrichment:
 *
 *   A  the patient contact block. At send time the patient's phone, email and
 *      date of birth are read from THAT office's Open Dental (one GET, read
 *      only) and appear ONLY in the specialist's letter: its date-of-birth
 *      line and a "Patient contact" section. A missing field is "not on
 *      file"; no read at all is said honestly. Never the patient email, never
 *      an event note or audit row, never a link page.
 *   B  the reason in plain words. Staff (hub) and the doctor (sign-off) can
 *      write it; the patient email uses it in place of the generic phrase,
 *      which stays when it is blank. The clinical reason never reaches the
 *      patient.
 *
 * Open Dental and ACS are mocked. Test patient only: roland 12827
 * "Test 2, Stedi"; every value below is synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const tcReferrals = require('../../config/tcReferrals');
const tcReferralEmail = require('../../config/tcReferralEmail');
const tcReferralPatientEmail = require('../../config/tcReferralPatientEmail');
const emailIdentity = require('../../config/emailIdentity');
const odOffices = require('../../config/odOffices');
const transitions = require('./referralTransitions');
const letterText = require('./referralLetterText');
const patientContact = require('../../services/tc/referralPatientContact');
const { bootEmailApp, resetEmailHarness, apiJson, messagesByRecipient } = require('../emailTestUtils');
const { auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-10-22T15:00:00.000Z');
const SPECIALIST = 'referrals@endo.example.test';
const PATIENT = 'stedi.test2@example.test';
/** Synthetic contact values, distinctive so a leak is easy to spot. */
const PHONE = '(918) 555-0142';
const DOB = '1980-01-01';
const DOB_TEXT = 'January 1, 1980';

const EXTRA_ENV = [
  'TC_REFERRALS_ENABLED_ROLAND',
  'TC_REFERRAL_EMAIL_ENABLED_ROLAND',
  'TC_REFERRAL_PATIENT_EMAIL_ENABLED_ROLAND',
  'TC_EMAIL_PRACTICE_NAME_ROLAND',
  'TC_EMAIL_PRACTICE_PHONE_ROLAND',
  'OPENDENTAL_CUSTOMER_KEY',
  'OPENDENTAL_CUSTOMER_KEY_VALLEY',
  'OPENDENTAL_ALLOW_MOCK',
  'OFFICE_TIMEZONE',
];
const SAVED = Object.fromEntries(EXTRA_ENV.map((k) => [k, process.env[k]]));

let odPatient;
let odAnswer = null;
let odCalls = [];
let patched = [];

test.afterEach(() => {
  resetEmailHarness();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const p of patched) p.client[p.method] = p.original;
  patched = [];
  odOffices.resetOdOfficeCache();
  tcReferrals.resetCacheForTests();
  tcReferralEmail.resetCacheForTests();
  tcReferralPatientEmail.resetCacheForTests();
  emailIdentity.resetCacheForTests();
  transitions.setClockForTests(null);
});

async function boot(t, { od = true, patientEmail = true } = {}) {
  for (const k of EXTRA_ENV) delete process.env[k];
  process.env.TC_REFERRALS_ENABLED_ROLAND = 'true';
  process.env.TC_REFERRAL_EMAIL_ENABLED_ROLAND = 'true';
  if (patientEmail) process.env.TC_REFERRAL_PATIENT_EMAIL_ENABLED_ROLAND = 'true';
  tcReferralPatientEmail.resetCacheForTests();
  process.env.TC_EMAIL_PRACTICE_NAME_ROLAND = 'Roland Family Dental';
  process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = '(918) 555-0100';
  if (od) {
    process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
    process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-valley-customer-key';
  }
  odOffices.resetOdOfficeCache();
  tcReferrals.resetCacheForTests();
  tcReferralEmail.resetCacheForTests();
  transitions.setClockForTests(() => NOW);

  odPatient = {
    PatNum: 12827,
    LName: 'Test 2',
    FName: 'Stedi',
    Birthdate: DOB,
    PatStatus: 'Patient',
    Email: 'Stedi.Test2@Example.test',
    WirelessPhone: PHONE,
  };
  odAnswer = null;
  odCalls = [];
  if (od) {
    for (const officeKey of ['roland', 'valley']) {
      const { client } = odOffices.getOdOffice(officeKey);
      for (const method of ['apiGetRaw', 'apiPost', 'apiPut', 'apiPatch', 'apiDelete', 'apiDeleteRaw']) {
        if (typeof client[method] !== 'function') continue;
        patched.push({ client, method, original: client[method] });
        client[method] = async (p, params) => {
          odCalls.push({ office: officeKey, method, path: p, params });
          if (method !== 'apiGetRaw') throw new Error(`Open Dental WRITE attempted: ${method} ${p}`);
          if (odAnswer) return odAnswer;
          const m = /^\/patients\/(\d+)$/.exec(p);
          return officeKey === 'roland' && m && Number(m[1]) === odPatient.PatNum
            ? { ok: true, status: 200, data: odPatient }
            : { ok: false, status: 404, data: null };
        };
      }
    }
  }
  const app = await bootEmailApp({ env: {} });
  t.after(() => app.close());
  return app;
}

const REF = (p = '') => `/api/tc/referrals${p}?office=roland`;
const SIGN = (p = '') => `/api/tc/referrals/signoff${p}?office=roland`;
const CLINICAL = 'Possible cracked tooth, needs endo eval';
const INPUT = { reason: CLINICAL, urgency: 'soon', teeth: [3], referringProvider: 'DOC1', narrative: 'Sensitive to biting on #3.' };

function seedEntry(db) {
  const row = {
    entry_id: randomUUID(),
    office_id: 'roland',
    practice_name: 'River Endodontics',
    specialist_name: 'Dr. Endo Example, DDS',
    specialty: 'Endodontics',
    email: 'Referrals@Endo.Example.test',
    phone: '(479) 555-0177',
    active: true,
  };
  db.table('tc_referral_directory').push(row);
  return row;
}

/** Walk a referral to pending sign-off; `edit` = the staff fields PATCH while it waits. */
async function pending(baseUrl, db) {
  const entry = seedEntry(db);
  const c = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: 12827, status: 'pending_tc' };
  db.table('tc_cases').push(c);
  const r = await apiJson(baseUrl, 'POST', REF(), { source: { caseId: c.case_id }, referral: { ...INPUT, directoryEntryId: entry.entry_id } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.referral.referralId;
  assert.equal((await apiJson(baseUrl, 'POST', REF(`/${id}/submit`), {})).status, 200);
  return id;
}

async function sendIt(baseUrl, db, acsCalls, { patientReason } = {}) {
  const id = await pending(baseUrl, db);
  if (patientReason !== undefined) {
    const e = await apiJson(baseUrl, 'PATCH', SIGN(`/${id}/fields`), { patientReason });
    assert.equal(e.status, 200, JSON.stringify(e.body));
  }
  assert.equal((await apiJson(baseUrl, 'POST', SIGN(`/${id}/approve`), {})).status, 200);
  const r = await apiJson(baseUrl, 'POST', REF(`/${id}/send-email`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const posts = acsCalls.filter((c) => c.method === 'POST');
  const letter = posts.find((c) => c.body.recipients.to[0].address === SPECIALIST).body;
  const noticeCall = posts.find((c) => c.body.recipients.to[0].address === PATIENT);
  return { id, r, letter, notice: noticeCall ? noticeCall.body : null };
}

const eventsOf = (db, id) => db.table('tc_referral_events').filter((e) => e.referral_id === id);
const whole = (msg) => `${msg.content.subject}\n${msg.content.plainText}\n${msg.content.html}`;
/** Every place a send writes words that are not the letter itself. */
function trailOf(db, id) {
  return JSON.stringify({ events: eventsOf(db, id), audits: auditRows(db), tokens: db.table('tc_referral_link_tokens') });
}

// ── A: the patient contact block ────────────────────────────────────────────

test('A: the letter carries the date of birth and a Patient contact section, from ONE read of this office', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { letter } = await sendIt(baseUrl, db, acsCalls);
  const text = letter.content.plainText;
  assert.ok(text.includes(`Patient: Stedi Test 2\nDate of birth: ${DOB_TEXT}`), 'the DOB slot fills from the read');
  assert.ok(text.includes(`Patient contact:\nPhone: ${PHONE}\nEmail: ${PATIENT}`), 'the contact section');
  assert.ok(!text.includes(letterText.DOB_LINE), 'the DOB line did not fall back');
  // The HTML form says the same.
  assert.ok(letter.content.html.includes(DOB_TEXT) && letter.content.html.includes(PHONE));
  // One contact GET for the whole send — the notice reused it — then the insurance read; roland's own client, read only.
  assert.deepEqual(odCalls.map((c) => [c.office, c.method, c.path]), [['roland', 'apiGetRaw', '/patients/12827'], ['roland', 'apiGetRaw', '/patplans']]);
  assert.deepEqual(messagesByRecipient(acsCalls), { [SPECIALIST]: 1, [PATIENT]: 1 });
  // The read is on the record, before it was made, with nothing of what it read.
  const lookups = auditRows(db).filter((a) => a.resource_type === 'tc_referral.letter_contact_lookup');
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].action, 'READ');
});

test('A: the contact goes ONLY into the letter — not the patient email, an event note, an audit row or a token', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, notice } = await sendIt(baseUrl, db, acsCalls);
  assert.ok(notice, 'the patient was emailed');
  for (const leak of [PHONE, '555-0142', DOB, DOB_TEXT, '1980']) {
    assert.ok(!whole(notice).includes(leak), `the patient email never carries ${leak}`);
    assert.ok(!trailOf(db, id).includes(leak), `no note, audit row or token carries ${leak}`);
  }
});

test('A: a field Open Dental has no value for reads "not on file" — never invented', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { patientEmail: false });
  odPatient.WirelessPhone = '';
  odPatient.Email = '';
  odPatient.Birthdate = '0001-01-01'; // Open Dental's null date
  const { letter } = await sendIt(baseUrl, db, acsCalls);
  const text = letter.content.plainText;
  assert.ok(text.includes('Date of birth: not on file'));
  assert.ok(text.includes('Patient contact:\nPhone: not on file\nEmail: not on file'));
  assert.doesNotMatch(text, /0001/);
});

test('A: the home phone stands in when there is no cell; a malformed email is "not on file"', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { patientEmail: false });
  odPatient.WirelessPhone = '';
  odPatient.HmPhone = '(918) 555-0199';
  odPatient.Email = 'not an address';
  const { letter } = await sendIt(baseUrl, db, acsCalls);
  assert.ok(letter.content.plainText.includes('Patient contact:\nPhone: (918) 555-0199\nEmail: not on file'));
});

for (const [name, setup, why] of [
  ['Open Dental not connected', { od: false }, null],
  ['Open Dental not answering', {}, { ok: false, status: 503, data: null }],
  ['the patient not found', {}, { ok: false, status: 404, data: null }],
]) {
  test(`A: ${name} → the letter still goes, and says honestly the contact could not be read`, async (t) => {
    const { baseUrl, db, acsCalls } = await boot(t, setup);
    if (why) odAnswer = why;
    const { r, letter } = await sendIt(baseUrl, db, acsCalls);
    assert.equal(r.body.referral.status, 'sent', 'the specialist send is unaffected');
    const text = letter.content.plainText;
    assert.ok(text.includes(`Patient: Stedi Test 2\n${letterText.DOB_LINE}`), 'the DOB line falls back');
    assert.ok(text.includes(letterText.CONTACT_UNAVAILABLE));
    assert.doesNotMatch(text, /not on file/, 'nothing claims a field is empty when it was never read');
    assert.ok(odCalls.filter((c) => c.path.startsWith('/patients/')).length <= 1, 'never more than one contact read');
  });
}

test('A: the read is audited first — a READ that cannot be recorded is not made, and the letter says so', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { patientEmail: false });
  db.onQuery(/^INSERT INTO audit_log \(/, (text, params) => {
    const cols = /^INSERT INTO audit_log \(([^)]+)\)/.exec(text)[1].split(',').map((s) => s.trim());
    const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
    if (row.resource_type === 'tc_referral.letter_contact_lookup') throw new Error('audit store down');
    db.table('audit_log').push(row);
    return { rows: [], rowCount: 1 };
  });
  const { r, letter } = await sendIt(baseUrl, db, acsCalls);
  assert.equal(r.body.referral.status, 'sent');
  assert.deepEqual(odCalls.map((c) => c.path), ['/patplans'], 'no trail, no contact read (the insurance read has its own trail)');
  assert.ok(letter.content.plainText.includes(letterText.CONTACT_UNAVAILABLE));
});

test('A: the contact module — every outcome a value, one GET, never a write', async (t) => {
  await boot(t);
  assert.deepEqual(await patientContact.patientContactFor('roland', 12827), {
    status: 'found',
    phone: PHONE,
    email: PATIENT,
    birthdate: DOB,
  });
  assert.deepEqual(await patientContact.patientContactFor('roland', 99999), { status: 'not_found' });
  odAnswer = { ok: false, status: 500, data: null };
  assert.deepEqual(await patientContact.patientContactFor('roland', 12827), { status: 'unreadable' });
  odAnswer = null;
  odPatient.PatStatus = 'Deceased';
  assert.deepEqual(await patientContact.patientContactFor('roland', 12827), { status: 'not_found' });
  assert.deepEqual(await patientContact.patientContactFor('unknown', 12827), { status: 'not_connected' });
  assert.ok(odCalls.every((c) => c.method === 'apiGetRaw' && c.office === 'roland'));
  // The R5b address read is the same read, narrowed.
  odPatient.PatStatus = 'Patient';
  assert.deepEqual(await patientContact.patientEmailFor('roland', 12827), { status: 'found', address: PATIENT });
  odPatient.Email = '';
  assert.deepEqual(await patientContact.patientEmailFor('roland', 12827), { status: 'no_email' });
});

// ── B: the reason in plain words ────────────────────────────────────────────

test('B: written at sign-off, the patient email says it in place of the generic phrase — never the clinical reason', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { notice } = await sendIt(baseUrl, db, acsCalls, { patientReason: 'an evaluation of a sore tooth.' });
  const text = notice.content.plainText;
  assert.match(text, /has referred you to River Endodontics for an evaluation of a sore tooth\. We've already sent them/);
  assert.doesNotMatch(text, /a specialist consultation/);
  for (const clinical of [/cracked/i, /endo eval/i, /Sensitive/]) assert.doesNotMatch(whole(notice), clinical);
});

test('B: blank (never written, or cleared) keeps the generic phrase', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { notice } = await sendIt(baseUrl, db, acsCalls, { patientReason: '   ' });
  assert.match(notice.content.plainText, /for a specialist consultation\./);
});

test('B: the letter never carries the reason in plain words', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { letter } = await sendIt(baseUrl, db, acsCalls, { patientReason: 'an evaluation of a sore tooth' });
  assert.doesNotMatch(whole(letter), /sore tooth/);
});

test('B: staff write it from the hub; the history names the field, never its words; blank stores null', async (t) => {
  const { baseUrl, db } = await boot(t);
  const id = await pending(baseUrl, db);
  const set = await apiJson(baseUrl, 'PATCH', REF(`/${id}/fields`), { patientReason: 'a check of your gums' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.referral.patientReason, 'a check of your gums');
  const edit = eventsOf(db, id).find((e) => e.verb === 'edit');
  assert.equal(edit.note, 'Changed reason in plain words');
  assert.ok(!JSON.stringify(auditRows(db)).includes('gums'), 'the audit row carries no words');
  const cleared = await apiJson(baseUrl, 'PATCH', REF(`/${id}/fields`), { patientReason: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.referral.patientReason, null);
  assert.equal(db.table('tc_referrals').find((r) => r.referral_id === id).patient_reason, null);
});

test('B: the doctor writes it at sign-off (doctor_edit); over 200 characters is a 400', async (t) => {
  const { baseUrl, db } = await boot(t);
  const id = await pending(baseUrl, db);
  const ok = await apiJson(baseUrl, 'PATCH', SIGN(`/${id}/fields`), { patientReason: 'an implant consultation' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(eventsOf(db, id).find((e) => e.verb === 'doctor_edit').note, 'Changed reason in plain words');
  const long = await apiJson(baseUrl, 'PATCH', SIGN(`/${id}/fields`), { patientReason: 'x'.repeat(201) });
  assert.equal(long.status, 400);
});

test('B (pure): composePatientNotice takes the plain reason, trims its full stop, and falls back when blank', () => {
  const base = {
    patientName: 'Test 2, Stedi',
    referringProvider: 'DOC1',
    entry: { practice_name: 'River Endodontics', phone: '(479) 555-0177' },
    office: { name: 'Roland Family Dental', phone: '(918) 555-0100' },
    withFiles: false,
    sourceKind: 'case',
  };
  assert.match(letterText.composePatientNotice({ ...base, patientReason: 'a root canal evaluation!' }).text, /for a root canal evaluation\. We've/);
  assert.match(letterText.composePatientNotice({ ...base, patientReason: null }).text, /for a specialist consultation\. We've/);
  assert.match(letterText.composePatientNotice(base).text, /for a specialist consultation\. We've/);
});
