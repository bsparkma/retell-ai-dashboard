'use strict';

/**
 * AT-0 item 2: the referral send event carries what the recipient read.
 *
 * At send time referralSend.js (the only writer) freezes onto the row that
 * records the email going out:
 *   - `send`               the specialist letter: { audience: 'specialist', subject, text, withheld }
 *   - `patient_email_sent` the patient notice:    { audience: 'patient', subject, text, after }
 *
 * What the snapshot must NOT hold:
 *   - a link token or the unsubscribe URL (R5b: a token is in the email and
 *     nowhere else; only hashes are stored);
 *   - the blocks read from Open Dental at send time — date of birth, Patient
 *     contact, Insurance on file — which R5c pins to "the letter and nowhere
 *     else". Each is replaced by a marker and named in `withheld`.
 * Everything else is the letter's own text, verbatim. Send behavior, gating
 * and recipients are unchanged (the existing referral suites pin those).
 *
 * Open Dental and ACS are mocked (read-only GETs; a write throws). Test
 * patient only: roland 12827 "Test 2, Stedi"; every value is synthetic.
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
const { bootEmailApp, resetEmailHarness, apiJson } = require('../emailTestUtils');

const NOW = new Date('2026-10-22T15:00:00.000Z');
const SPECIALIST = 'referrals@endo.example.test';
const PATIENT = 'stedi.test2@example.test';
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

  const odPatient = {
    PatNum: 12827,
    LName: 'Test 2',
    FName: 'Stedi',
    Birthdate: DOB,
    PatStatus: 'Patient',
    Email: 'Stedi.Test2@Example.test',
    WirelessPhone: PHONE,
  };
  if (od) {
    for (const officeKey of ['roland', 'valley']) {
      const { client } = odOffices.getOdOffice(officeKey);
      for (const method of ['apiGetRaw', 'apiPost', 'apiPut', 'apiPatch', 'apiDelete', 'apiDeleteRaw']) {
        if (typeof client[method] !== 'function') continue;
        patched.push({ client, method, original: client[method] });
        client[method] = async (p) => {
          if (method !== 'apiGetRaw') throw new Error(`Open Dental WRITE attempted: ${method} ${p}`);
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
const INPUT = {
  reason: 'Possible cracked tooth, needs endo eval',
  urgency: 'soon',
  teeth: [3],
  referringProvider: 'DOC1',
  narrative: 'Sensitive to biting on #3.',
};

async function sendIt(baseUrl, db, acsCalls) {
  const entry = {
    entry_id: randomUUID(),
    office_id: 'roland',
    practice_name: 'River Endodontics',
    specialist_name: 'Dr. Endo Example, DDS',
    specialty: 'Endodontics',
    email: 'Referrals@Endo.Example.test',
    phone: '(479) 555-0177',
    active: true,
  };
  db.table('tc_referral_directory').push(entry);
  const c = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: 12827, status: 'pending_tc' };
  db.table('tc_cases').push(c);
  const created = await apiJson(baseUrl, 'POST', REF(), { source: { caseId: c.case_id }, referral: { ...INPUT, directoryEntryId: entry.entry_id } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.referral.referralId;
  assert.equal((await apiJson(baseUrl, 'POST', REF(`/${id}/submit`), {})).status, 200);
  assert.equal((await apiJson(baseUrl, 'POST', SIGN(`/${id}/approve`), {})).status, 200);
  const r = await apiJson(baseUrl, 'POST', REF(`/${id}/send-email`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const posts = acsCalls.filter((x) => x.method === 'POST');
  const letter = posts.find((x) => x.body.recipients.to[0].address === SPECIALIST).body;
  const noticeCall = posts.find((x) => x.body.recipients.to[0].address === PATIENT);
  return { id, letter, notice: noticeCall ? noticeCall.body : null };
}

const eventsOf = (db, id) => db.table('tc_referral_events').filter((e) => e.referral_id === id);
const snapshotOf = (row) => (typeof row.letter_snapshot === 'string' ? JSON.parse(row.letter_snapshot) : row.letter_snapshot);

/** Every URL in an email body — the link buttons and the unsubscribe link carry tokens. */
function urlsIn(msg) {
  return `${msg.content.plainText}\n${msg.content.html}`.match(/https?:\/\/[^\s"'<>)]+/g) || [];
}

test('the `send` row carries the specialist letter: subject and text exactly as composed into the email', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { od: false, patientEmail: false });
  const { id, letter } = await sendIt(baseUrl, db, acsCalls);

  const send = eventsOf(db, id).find((e) => e.verb === 'send');
  assert.ok(send, 'the send row exists');
  const snap = snapshotOf(send);
  assert.equal(snap.audience, 'specialist');
  assert.equal(snap.subject, letter.content.subject, 'the subject the specialist saw');
  assert.ok(snap.text.length > 0);
  assert.ok(letter.content.plainText.includes(snap.text), 'the snapshot IS the letter text the email carried');
  assert.ok(snap.text.includes('Sensitive to biting on #3.'), 'the referral\'s own words are verbatim');
  assert.deepEqual(snap.withheld, [], 'no Open Dental read, nothing withheld');

  // Every other row that is not an email going out carries none.
  for (const e of eventsOf(db, id).filter((x) => x.verb !== 'send')) assert.equal(e.letter_snapshot ?? null, null, e.verb);
});

test('no link token and no unsubscribe URL ever lands in a snapshot', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, letter, notice } = await sendIt(baseUrl, db, acsCalls);
  assert.ok(notice, 'the patient was emailed');
  const urls = [...urlsIn(letter), ...urlsIn(notice)];
  assert.ok(urls.length >= 3, 'the emails did carry token links (two letter buttons + unsubscribe, at least)');
  const stored = JSON.stringify(eventsOf(db, id).map(snapshotOf));
  for (const u of urls) assert.ok(!stored.includes(u), `stored no ${u.slice(0, 40)}…`);
  assert.doesNotMatch(stored, /[?&]t=/, 'no token query string');
});

test('the Open Dental blocks (DOB, Patient contact) are WITHHELD from the snapshot and named; the rest is verbatim', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { patientEmail: false });
  const { id, letter } = await sendIt(baseUrl, db, acsCalls);
  assert.ok(letter.content.plainText.includes(PHONE) && letter.content.plainText.includes(DOB_TEXT), 'the LETTER carried them');

  const snap = snapshotOf(eventsOf(db, id).find((e) => e.verb === 'send'));
  for (const leak of [PHONE, '555-0142', DOB_TEXT, DOB, PATIENT]) {
    assert.ok(!JSON.stringify(snap).includes(leak), `the snapshot never carries ${leak}`);
  }
  assert.ok(snap.withheld.includes('date_of_birth') && snap.withheld.includes('patient_contact'), JSON.stringify(snap.withheld));
  assert.match(snap.text, /\[Date of birth from Open Dental: in the letter as sent, not kept in this history\]/);
  assert.match(snap.text, /\[Patient contact from Open Dental: in the letter as sent, not kept in this history\]/);
  // Every stretch between markers is the letter's own text.
  for (const piece of snap.text.split(/\[[^\]]+ from Open Dental: in the letter as sent, not kept in this history\]/)) {
    assert.ok(letter.content.plainText.includes(piece), `verbatim: ${piece.slice(0, 40)}`);
  }
});

test('the `patient_email_sent` row carries the patient notice: subject, text and closing words', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, notice } = await sendIt(baseUrl, db, acsCalls);
  assert.ok(notice);
  const row = eventsOf(db, id).find((e) => e.verb === 'patient_email_sent');
  assert.ok(row);
  const snap = snapshotOf(row);
  assert.equal(snap.audience, 'patient');
  assert.equal(snap.subject, notice.content.subject);
  assert.ok(notice.content.plainText.includes(snap.text), 'the notice text as sent');
  assert.equal(typeof snap.after, 'string');
  if (snap.after) assert.ok(notice.content.plainText.includes(snap.after));
  // The specialist letter's row is still its own, separate snapshot.
  assert.equal(snapshotOf(eventsOf(db, id).find((e) => e.verb === 'send')).audience, 'specialist');
});
