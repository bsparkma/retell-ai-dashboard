'use strict';

/**
 * Referral letter insurance: at send time the patient's insurance on file is
 * read from THAT office's Open Dental (read only, audited first) and appears
 * ONLY in the specialist's letter, in an "Insurance on file" section —
 * carrier, plan/group name, group number and subscriber ID, primary and any
 * secondary (labeled), and the subscriber's name and relationship when the
 * subscriber is not the patient. A missing field is "not on file"; a failed
 * read is the honest "available from our office on request" and the letter
 * still goes. Never the patient email, an event note, an audit row or a
 * token. No SSN, ever.
 *
 * Open Dental and ACS are mocked. Test patient only: roland 12827
 * "Test 2, Stedi"; the subscriber, carriers, groups and IDs are synthetic.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const tcReferrals = require('../../config/tcReferrals');
const tcReferralEmail = require('../../config/tcReferralEmail');
const tcReferralPatientEmail = require('../../config/tcReferralPatientEmail');
const emailIdentity = require('../../config/emailIdentity');
const odOffices = require('../../config/odOffices');
const transitions = require('./referralTransitions');
const letterText = require('./referralLetterText');
const patientInsurance = require('../../services/tc/referralPatientInsurance');
const { bootEmailApp, resetEmailHarness, apiJson } = require('../emailTestUtils');
const { auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-10-22T15:00:00.000Z');
const SPECIALIST = 'referrals@endo.example.test';
const PATIENT = 'stedi.test2@example.test';
const PAT_NUM = 12827;
/** A synthetic subscriber record (the patient's spouse) in the mocked database. */
const SUBSCRIBER_NUM = 990001;
const SUBSCRIBER_NAME = 'Jordan Example';
/** Synthetic values, distinctive so a leak is easy to spot. */
const SSN = '123-45-6789';
const PRI = { carrier: 'Example Dental Mutual', group: 'ACME WIDGETS PPO', groupNum: 'GRP-40417', subId: 'XQZ7781234' };
const SEC = { carrier: 'Sample Benefit Co', group: 'SPOUSE PLAN PREMIER', groupNum: 'G-88213', subId: 'SBC-55102' };

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

/** The mocked roland database. */
let od;
/** [RegExp, answer] — a path matching one answers with that instead. */
let odFail = [];
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

function freshOd() {
  return {
    patients: {
      [PAT_NUM]: {
        PatNum: PAT_NUM,
        LName: 'Test 2',
        FName: 'Stedi',
        Birthdate: '1980-01-01',
        PatStatus: 'Patient',
        Email: 'Stedi.Test2@Example.test',
        WirelessPhone: '(918) 555-0142',
        SSN,
      },
      [SUBSCRIBER_NUM]: { PatNum: SUBSCRIBER_NUM, LName: 'Example', FName: 'Jordan', PatStatus: 'Patient', SSN, Birthdate: '1978-03-04' },
    },
    patplans: [
      { PatPlanNum: 501, PatNum: PAT_NUM, Ordinal: 1, InsSubNum: 701, Relationship: 'Self' },
      { PatPlanNum: 502, PatNum: PAT_NUM, Ordinal: 2, InsSubNum: 702, Relationship: 'Spouse' },
    ],
    inssubs: {
      701: { InsSubNum: 701, PlanNum: 801, Subscriber: PAT_NUM, SubscriberID: PRI.subId },
      702: { InsSubNum: 702, PlanNum: 802, Subscriber: SUBSCRIBER_NUM, SubscriberID: SEC.subId },
    },
    insplans: {
      801: { PlanNum: 801, CarrierNum: 901, GroupName: PRI.group, GroupNum: PRI.groupNum },
      802: { PlanNum: 802, CarrierNum: 902, GroupName: SEC.group, GroupNum: SEC.groupNum },
    },
    carriers: {
      901: { CarrierNum: 901, CarrierName: PRI.carrier },
      902: { CarrierNum: 902, CarrierName: SEC.carrier },
    },
  };
}

const ok = (data) => ({ ok: true, status: 200, data });
const NOT_FOUND = { ok: false, status: 404, data: null };

async function boot(t, { od: connected = true, patientEmail = true } = {}) {
  for (const k of EXTRA_ENV) delete process.env[k];
  process.env.TC_REFERRALS_ENABLED_ROLAND = 'true';
  process.env.TC_REFERRAL_EMAIL_ENABLED_ROLAND = 'true';
  if (patientEmail) process.env.TC_REFERRAL_PATIENT_EMAIL_ENABLED_ROLAND = 'true';
  tcReferralPatientEmail.resetCacheForTests();
  process.env.TC_EMAIL_PRACTICE_NAME_ROLAND = 'Roland Family Dental';
  process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = '(918) 555-0100';
  if (connected) {
    process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
    process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-valley-customer-key';
  }
  odOffices.resetOdOfficeCache();
  tcReferrals.resetCacheForTests();
  tcReferralEmail.resetCacheForTests();
  transitions.setClockForTests(() => NOW);

  od = freshOd();
  odFail = [];
  odCalls = [];
  if (connected) {
    for (const officeKey of ['roland', 'valley']) {
      const { client } = odOffices.getOdOffice(officeKey);
      for (const method of ['apiGetRaw', 'apiPost', 'apiPut', 'apiPatch', 'apiDelete', 'apiDeleteRaw']) {
        if (typeof client[method] !== 'function') continue;
        patched.push({ client, method, original: client[method] });
        client[method] = async (p, params) => {
          odCalls.push({ office: officeKey, method, path: p, params });
          if (method !== 'apiGetRaw') throw new Error(`Open Dental WRITE attempted: ${method} ${p}`);
          for (const [re, answer] of odFail) if (re.test(p)) return answer;
          if (officeKey !== 'roland') return NOT_FOUND;
          // Deliberately ignores the PatNum filter: the reader must filter for itself.
          if (p === '/patplans') return ok(od.patplans);
          const m = /^\/(patients|inssubs|insplans|carriers)\/(\d+)$/.exec(p);
          const row = m && od[m[1]][m[2]];
          return row ? ok(row) : NOT_FOUND;
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
const INPUT = { reason: 'Possible cracked tooth', urgency: 'soon', teeth: [3], referringProvider: 'DOC1', narrative: 'Sensitive to biting on #3.' };

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
  const c = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: PAT_NUM, status: 'pending_tc' };
  db.table('tc_cases').push(c);
  const created = await apiJson(baseUrl, 'POST', REF(), { source: { caseId: c.case_id }, referral: { ...INPUT, directoryEntryId: entry.entry_id } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.referral.referralId;
  assert.equal((await apiJson(baseUrl, 'POST', REF(`/${id}/submit`), {})).status, 200);
  assert.equal((await apiJson(baseUrl, 'POST', SIGN(`/${id}/approve`), {})).status, 200);
  const r = await apiJson(baseUrl, 'POST', REF(`/${id}/send-email`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.referral.status, 'sent', 'the specialist send is unaffected');
  const posts = acsCalls.filter((x) => x.method === 'POST');
  const letter = posts.find((x) => x.body.recipients.to[0].address === SPECIALIST).body;
  const noticeCall = posts.find((x) => x.body.recipients.to[0].address === PATIENT);
  return { id, letter, notice: noticeCall ? noticeCall.body : null };
}

const eventsOf = (db, id) => db.table('tc_referral_events').filter((e) => e.referral_id === id);
const whole = (msg) => `${msg.content.subject}\n${msg.content.plainText}\n${msg.content.html}`;
function trailOf(db, id) {
  return JSON.stringify({ events: eventsOf(db, id), audits: auditRows(db), tokens: db.table('tc_referral_link_tokens') });
}

const FULL_BLOCK = [
  'Insurance on file:',
  'Primary insurance:',
  `Carrier: ${PRI.carrier}`,
  `Plan/group name: ${PRI.group}`,
  `Group number: ${PRI.groupNum}`,
  `Subscriber ID: ${PRI.subId}`,
  'Secondary insurance:',
  `Carrier: ${SEC.carrier}`,
  `Plan/group name: ${SEC.group}`,
  `Group number: ${SEC.groupNum}`,
  `Subscriber ID: ${SEC.subId}`,
  `Subscriber: ${SUBSCRIBER_NAME} (relationship to patient: spouse)`,
].join('\n');

// ── The block ───────────────────────────────────────────────────────────────

test('the letter carries Insurance on file — primary and secondary, labeled; the subscriber only when it is not the patient', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { letter } = await sendIt(baseUrl, db, acsCalls);
  const text = letter.content.plainText;
  assert.ok(text.includes(`Patient contact:\nPhone: (918) 555-0142\nEmail: ${PATIENT}\n\n${FULL_BLOCK}\n\nWe are referring`), text);
  // The HTML twin says the same.
  for (const v of [PRI.carrier, PRI.groupNum, SEC.subId, SUBSCRIBER_NAME, 'Secondary insurance:']) assert.ok(letter.content.html.includes(v), v);
  // Only roland's client, only GETs: the contact read, then the insurance chain.
  assert.ok(odCalls.every((c) => c.office === 'roland' && c.method === 'apiGetRaw'));
  assert.deepEqual(
    odCalls.map((c) => c.path),
    ['/patients/12827', '/patplans', '/inssubs/701', '/insplans/801', '/carriers/901', '/inssubs/702', '/insplans/802', '/carriers/902', `/patients/${SUBSCRIBER_NUM}`],
  );
  assert.deepEqual(odCalls[1].params, { PatNum: PAT_NUM });
  // Audited as its own READ, recording nothing of what it read.
  const lookups = auditRows(db).filter((a) => a.resource_type === 'tc_referral.letter_insurance_lookup');
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].action, 'READ');
});

test('insurance goes ONLY into the letter — never the patient email, an event note, an audit row or a token; no SSN anywhere', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, letter, notice } = await sendIt(baseUrl, db, acsCalls);
  assert.ok(notice, 'the patient was emailed');
  for (const leak of [PRI.carrier, PRI.group, PRI.groupNum, PRI.subId, SEC.carrier, SEC.subId, SUBSCRIBER_NAME, 'Jordan', 'Insurance']) {
    assert.ok(!whole(notice).includes(leak), `the patient email never carries ${leak}`);
    assert.ok(!trailOf(db, id).includes(leak), `no note, audit row or token carries ${leak}`);
  }
  for (const ssn of [SSN, '123456789', '6789']) {
    assert.ok(!whole(letter).includes(ssn), `the letter never carries ${ssn}`);
    assert.ok(!whole(notice).includes(ssn) && !trailOf(db, id).includes(ssn));
  }
});

test('a subscriber ID shaped like an SSN is withheld, never printed', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { patientEmail: false });
  od.inssubs[701].SubscriberID = '123-45-6789';
  od.inssubs[702].SubscriberID = '987 65 4321';
  const { letter } = await sendIt(baseUrl, db, acsCalls);
  const text = whole(letter);
  assert.equal(text.split(`Subscriber ID: ${letterText.SUBSCRIBER_ID_WITHHELD}`).length - 1, 2 * 2, 'both plans, in the text and the HTML');
  for (const digits of ['123-45-6789', '987 65 4321', '6789', '4321']) assert.ok(!text.includes(digits), digits);
});

test('a missing field reads "not on file"; a patient who is their own subscriber gets no subscriber line', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { patientEmail: false });
  od.patplans = [od.patplans[0]];
  od.inssubs[701].SubscriberID = '';
  od.insplans[801].GroupName = '';
  od.insplans[801].GroupNum = '  ';
  od.carriers[901].CarrierName = '';
  const { letter } = await sendIt(baseUrl, db, acsCalls);
  assert.ok(
    letter.content.plainText.includes(
      'Insurance on file:\nPrimary insurance:\nCarrier: not on file\nPlan/group name: not on file\nGroup number: not on file\nSubscriber ID: not on file\n\nWe are referring',
    ),
  );
  assert.doesNotMatch(letter.content.plainText, /Secondary insurance|Subscriber: /);
});

test('a subscriber record Open Dental does not have names "not on file"; an unknown relationship too', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { patientEmail: false });
  delete od.patients[SUBSCRIBER_NUM];
  od.patplans[1].Relationship = 'Martian';
  const { letter } = await sendIt(baseUrl, db, acsCalls);
  assert.ok(letter.content.plainText.includes('Subscriber: not on file (relationship to patient: not on file)'));
});

test('no plan on file → "Insurance on file: none."', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { patientEmail: false });
  od.patplans = [];
  const { letter } = await sendIt(baseUrl, db, acsCalls);
  assert.ok(letter.content.plainText.includes(`\n\n${letterText.INSURANCE_NONE}\n\n`));
});

test("another patient's plan, returned because Open Dental ignored the filter, never reaches the letter", async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { patientEmail: false });
  od.patplans = od.patplans.map((pp) => ({ ...pp, PatNum: 55555 }));
  const { letter } = await sendIt(baseUrl, db, acsCalls);
  assert.ok(letter.content.plainText.includes(letterText.INSURANCE_NONE));
  assert.ok(!odCalls.some((c) => c.path.startsWith('/inssubs/')), 'the other patient\'s subscription is never even read');
});

// ── Failed reads: honest, fail closed, the letter still goes ────────────────

for (const [name, setup, fail] of [
  ['Open Dental not connected', { od: false }, null],
  ['the plan list not answering', {}, [/^\/patplans$/, { ok: false, status: 503, data: null }]],
  ['one subscription unreadable', {}, [/^\/inssubs\/702$/, { ok: false, status: 500, data: null }]],
  ['a carrier unreadable', {}, [/^\/carriers\/901$/, { ok: false, status: 404, data: null }]],
  ["the subscriber's record unreadable", {}, [new RegExp(`^/patients/${SUBSCRIBER_NUM}$`), { ok: false, status: 503, data: null }]],
]) {
  test(`${name} → the whole section falls back honestly, never half a plan; the contact block is unaffected`, async (t) => {
    const { baseUrl, db, acsCalls } = await boot(t, { ...setup, patientEmail: false });
    if (fail) odFail.push(fail);
    const { letter } = await sendIt(baseUrl, db, acsCalls);
    const text = letter.content.plainText;
    assert.ok(text.includes(`\n\n${letterText.INSURANCE_UNAVAILABLE}\n\n`), text);
    assert.doesNotMatch(text, /Primary insurance|Carrier:|Subscriber ID/, 'nothing partial');
    if (setup.od !== false) assert.ok(text.includes('Patient contact:\nPhone: (918) 555-0142'));
  });
}

test('the insurance read is audited first — a READ that cannot be recorded is not made; the contact read still is', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { patientEmail: false });
  db.onQuery(/^INSERT INTO audit_log \(/, (text, params) => {
    const cols = /^INSERT INTO audit_log \(([^)]+)\)/.exec(text)[1].split(',').map((s) => s.trim());
    const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
    if (row.resource_type === 'tc_referral.letter_insurance_lookup') throw new Error('audit store down');
    db.table('audit_log').push(row);
    return { rows: [], rowCount: 1 };
  });
  const { letter } = await sendIt(baseUrl, db, acsCalls);
  assert.deepEqual(odCalls.map((c) => c.path), ['/patients/12827'], 'no trail, no insurance read');
  assert.ok(letter.content.plainText.includes(letterText.INSURANCE_UNAVAILABLE));
  assert.ok(letter.content.plainText.includes('Patient contact:\nPhone: (918) 555-0142'));
});

// ── The module ──────────────────────────────────────────────────────────────

test('the module — every outcome a value, office-derived, only GETs, names only from the subscriber record', async (t) => {
  await boot(t);
  const found = await patientInsurance.patientInsuranceFor('roland', PAT_NUM);
  assert.deepEqual(found, {
    status: 'found',
    plans: [
      { ordinal: 1, carrier: PRI.carrier, groupName: PRI.group, groupNum: PRI.groupNum, subscriberId: PRI.subId, subscriberIdWithheld: false, subscriber: null },
      {
        ordinal: 2,
        carrier: SEC.carrier,
        groupName: SEC.group,
        groupNum: SEC.groupNum,
        subscriberId: SEC.subId,
        subscriberIdWithheld: false,
        subscriber: { name: SUBSCRIBER_NAME, relationship: 'spouse' },
      },
    ],
  });
  assert.ok(!JSON.stringify(found).includes(SSN) && !JSON.stringify(found).includes('1978'), 'nothing else from the subscriber record');
  // A tertiary plan is not part of the letter.
  od.patplans.push({ PatPlanNum: 503, PatNum: PAT_NUM, Ordinal: 3, InsSubNum: 701, Relationship: 'Self' });
  assert.equal((await patientInsurance.patientInsuranceFor('roland', PAT_NUM)).plans.length, 2);
  // Valley's client for valley — never roland's database.
  odCalls = [];
  assert.deepEqual(await patientInsurance.patientInsuranceFor('valley', PAT_NUM), { status: 'unreadable' });
  assert.deepEqual([...new Set(odCalls.map((c) => c.office))], ['valley']);
  assert.deepEqual(await patientInsurance.patientInsuranceFor('unknown', PAT_NUM), { status: 'not_connected' });
  // An Open Dental that answers with nonsense is unreadable, not a throw.
  odFail.push([/^\/inssubs\//, ok(null)]);
  assert.deepEqual(await patientInsurance.patientInsuranceFor('roland', PAT_NUM), { status: 'unreadable' });
  assert.ok(odCalls.every((c) => c.method === 'apiGetRaw'));
  // Relationship words: the enum name or the DB integer; anything else is null.
  assert.equal(patientInsurance.relationshipOf('Child'), 'child');
  assert.equal(patientInsurance.relationshipOf('5'), 'significant other');
  assert.equal(patientInsurance.relationshipOf('constructor'), null);
  assert.equal(patientInsurance.relationshipOf(''), null);
  // The SSN shape.
  for (const yes of ['123456789', '123-45-6789', '123 45 6789']) assert.ok(patientInsurance.SSN_SHAPE.test(yes), yes);
  for (const no of ['W123456789', '12345678', '1234567890', 'XQZ7781234']) assert.ok(!patientInsurance.SSN_SHAPE.test(no), no);
});

test('the composer — directly', () => {
  assert.equal(letterText.insuranceSection(null), letterText.INSURANCE_UNAVAILABLE);
  assert.equal(letterText.insuranceSection({ status: 'unaudited' }), letterText.INSURANCE_UNAVAILABLE);
  assert.equal(letterText.insuranceSection({ status: 'none' }), letterText.INSURANCE_NONE);
  assert.equal(letterText.insuranceSection({ status: 'found', plans: [] }), letterText.INSURANCE_NONE);
  // A CR/LF in an Open Dental value can never start a new line of the letter.
  const s = letterText.insuranceSection({
    status: 'found',
    plans: [{ ordinal: 1, carrier: 'A\r\nSubscriber ID: forged', groupName: null, groupNum: null, subscriberId: null, subscriberIdWithheld: false, subscriber: null }],
  });
  assert.ok(s.includes('Carrier: A Subscriber ID: forged\n'));
});

// ── Guards ──────────────────────────────────────────────────────────────────

test('guard: the insurance module is read only, never touches an SSN field, and only the letter receives its result', () => {
  const backend = path.join(__dirname, '..', '..');
  const read = (rel) => fs.readFileSync(path.join(backend, rel), 'utf8');
  const mod = read('services/tc/referralPatientInsurance.js');
  assert.match(mod, /apiGetRaw/);
  assert.doesNotMatch(mod, /apiPost|apiPut|apiPatch|apiDelete|odPatientCache|commlog/i, 'no write of any kind');
  assert.doesNotMatch(mod, /\.SSN\b|\[['"]SSN['"]\]|SSN:/, 'the SSN field is never read');
  const send = read('routes/tc/referralSend.js');
  assert.match(send, /require\('\.\.\/\.\.\/services\/tc\/referralPatientInsurance'\)/);
  const notify = /notifyPatient\(req, \{[^}]*\}\)/.exec(send);
  assert.ok(notify && !/insurance/.test(notify[0]), 'the patient notice is never handed the insurance');
  for (const rel of ['routes/referralLinkWebhooks.js', 'routes/emailWebhooks.js', 'services/messaging/referralLetter.js']) {
    assert.doesNotMatch(read(rel), /referralPatientInsurance|insuranceSection/, `${rel} never sees it`);
  }
});
