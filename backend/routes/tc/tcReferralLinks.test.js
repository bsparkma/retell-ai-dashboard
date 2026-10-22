'use strict';

/**
 * Referrals R5b: closing the loop after a referral email goes out — end to
 * end over HTTP with a FAKE ACS (routes/emailTestUtils.js: every request is
 * recorded; nothing reaches a network) and the REAL per-office Open Dental
 * clients with apiGetRaw patched (read only; every call recorded).
 *
 *   N  the patient's notice: a second message per send, one per recipient
 *      class; its address from THAT office's Open Dental (read only); no
 *      email / unreadable / not connected / opted out → an honest named skip;
 *      ACS refusing it never touches the letter; no BCC; minimum PHI; its own
 *      unsubscribe link works
 *   K  the links: hashed at rest, stored with the send, dead after a conflict
 *   V  the public landing pages: GET never acts, minimum PHI, audited
 *   R  "We received this referral" → the existing mark_acknowledged move,
 *      attributed to the specialist's link
 *   D  "scheduled" + a date: patient_scheduled + scheduled_date; date rules
 *   X  replay, expiry, unknown / malformed / missing, cross-referral reuse,
 *      purpose binding, a concurrent double click: the neutral page, byte for
 *      byte, and nothing written
 *   L  rate limits, per client and for everyone, the first throttled hit
 *      audited once
 *   F  fail closed: a failed audit rolls the use back; no tenant → 503
 *   G  guards: the send path's only Open Dental access is one read-only
 *      module; the public route takes office and referral from the token
 *
 * Test patients only: roland 12827 "Test 2, Stedi". Addresses @example.test.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const contract = require('../../tc/contract.gen.cjs');
const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const tcReferralEmail = require('../../config/tcReferralEmail');
const emailIdentity = require('../../config/emailIdentity');
const odOffices = require('../../config/odOffices');
const acsClient = require('../../services/messaging/acs/client');
const transitions = require('./referralTransitions');
const letterText = require('./referralLetterText');
const referralLetter = require('../../services/messaging/referralLetter');
const linkRouter = require('../referralLinkWebhooks');
const { bootEmailApp, resetEmailHarness, apiJson, messagesByRecipient, PUBLIC_BASE } = require('../emailTestUtils');
const { auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-10-22T15:00:00.000Z'); // 10:00 CDT, Thursday
const DAY_MS = 24 * 60 * 60 * 1000;
const SPECIALIST = 'referrals@endo.example.test';
const PATIENT = 'stedi.test2@example.test';
const COPY = 'referral-copies@roland.example.test';

const EXTRA_ENV = [
  'TC_REFERRALS_ENABLED_ROLAND',
  'TC_REFERRAL_EMAIL_ENABLED_ROLAND',
  'TC_EMAIL_PRACTICE_NAME_ROLAND',
  'TC_EMAIL_PRACTICE_PHONE_ROLAND',
  'OPENDENTAL_CUSTOMER_KEY',
  'OPENDENTAL_CUSTOMER_KEY_VALLEY',
  'OPENDENTAL_ALLOW_MOCK',
  'OFFICE_TIMEZONE',
];
const SAVED = Object.fromEntries(EXTRA_ENV.map((k) => [k, process.env[k]]));

/** Roland's Open Dental, as the patched client answers it. */
let odPatient;
/** Override the whole answer: { ok, status, data }. */
let odAnswer = null;
/** Every call the patched clients saw, by method. */
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
  emailIdentity.resetCacheForTests();
  transitions.setClockForTests(null);
});

/** Move the shared clock (the send, the links and the public route all read it). */
let clockAt = NOW;
const setNow = (d) => {
  clockAt = d;
};

/**
 * Boot with referrals + referral email ON for roland, the transport
 * configured, and roland's Open Dental connected (patched client).
 */
async function boot(t, { od = true, bcc = null, linkLimits = {}, ...opts } = {}) {
  for (const k of EXTRA_ENV) delete process.env[k];
  process.env.TC_REFERRALS_ENABLED_ROLAND = 'true';
  process.env.TC_REFERRAL_EMAIL_ENABLED_ROLAND = 'true';
  process.env.TC_EMAIL_PRACTICE_NAME_ROLAND = 'Roland Family Dental';
  process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = '(918) 555-0100';
  if (od) {
    process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
    process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-valley-customer-key';
  }
  odOffices.resetOdOfficeCache();
  tcReferrals.resetCacheForTests();
  tcReferralEmail.resetCacheForTests();
  clockAt = NOW;
  transitions.setClockForTests(() => clockAt);

  odPatient = { PatNum: 12827, LName: 'Test 2', FName: 'Stedi', Birthdate: '1980-01-01', PatStatus: 'Patient', Email: 'Stedi.Test2@Example.test' };
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

  const app = await bootEmailApp({ env: {}, linkLimits, ...opts });
  if (bcc) {
    registry.getPlatformSetting = async (key) =>
      key === emailIdentity.SETTING_KEY ? { key, value: { roland: { referralBcc: bcc } }, updated_at: NOW, updated_by: 'office@carein.ai' } : null;
    emailIdentity.resetCacheForTests();
    await emailIdentity.refreshFromDb();
  }
  t.after(() => app.close());
  return app;
}

const REF = (p = '', office = 'roland') => `/api/tc/referrals${p}?office=${office}`;
const SIGN = (p = '') => `/api/tc/referrals/signoff${p}?office=roland`;
const INPUT = {
  reason: 'Possible cracked tooth, needs endo eval',
  urgency: 'soon',
  teeth: [3],
  referringProvider: 'DOC1',
  narrative: 'Sensitive to biting on #3 for two weeks.',
};

function seedEntry(db, over = {}) {
  const row = {
    entry_id: randomUUID(),
    office_id: 'roland',
    practice_name: 'River Endodontics',
    specialist_name: 'Dr. Endo Example, DDS',
    specialty: 'Endodontics',
    email: 'Referrals@Endo.Example.test',
    phone: '(479) 555-0177',
    active: true,
    ...over,
  };
  db.table('tc_referral_directory').push(row);
  return row;
}

/** A referral walked to approved through the real routes. */
async function approved(baseUrl, db, { entry = seedEntry(db) } = {}) {
  const c = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: 12827, status: 'pending_tc' };
  db.table('tc_cases').push(c);
  const r = await apiJson(baseUrl, 'POST', REF(), { source: { caseId: c.case_id }, referral: { ...INPUT, directoryEntryId: entry.entry_id } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.referral.referralId;
  assert.equal((await apiJson(baseUrl, 'POST', REF(`/${id}/submit`), {})).status, 200);
  assert.equal((await apiJson(baseUrl, 'PATCH', SIGN(`/${id}/fields`), { doctorNote: 'Please assess #3 for a crack.' })).status, 200);
  assert.equal((await apiJson(baseUrl, 'POST', SIGN(`/${id}/approve`), {})).status, 200);
  return { id, entry };
}

/** Approve and send; returns the links ACS was handed, by name. */
async function sent(baseUrl, db, acsCalls, opts) {
  const before = acsCalls.filter((c) => c.method === 'POST').length;
  const { id, entry } = await approved(baseUrl, db, opts);
  const r = await apiJson(baseUrl, 'POST', REF(`/${id}/send-email`), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const fresh = acsCalls.filter((c) => c.method === 'POST').slice(before);
  const letter = fresh.find((c) => c.body.recipients.to[0].address === SPECIALIST);
  const notice = fresh.find((c) => c.body.recipients.to[0].address === PATIENT) || null;
  return { id, entry, r, letter, notice, links: { ...linksOf(letter.body), ...(notice ? { patient: linksOf(notice.body).patient } : {}) } };
}

/** The one-time links in a message's HTML, keyed by what they are. */
function linksOf(body) {
  const out = {};
  for (const m of body.content.html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)) {
    const [href, label] = [m[1].replace(/&amp;/g, '&'), m[2].replace(/&#39;/g, "'")];
    if (label === letterText.SPECIALIST_LINK_LABELS.received) out.received = href;
    if (label === letterText.SPECIALIST_LINK_LABELS.scheduled) out.scheduled = href;
    if (label === letterText.PATIENT_LINK_LABEL) out.patient = href;
  }
  return out;
}

const tokenOf = (url) => new URL(url).searchParams.get('t');
const local = (baseUrl, url) => `${baseUrl}${new URL(url).pathname}${new URL(url).search}`;

async function getPage(baseUrl, url) {
  const res = await fetch(local(baseUrl, url));
  return { status: res.status, html: await res.text(), headers: res.headers };
}

async function postPage(baseUrl, fields) {
  const res = await fetch(`${baseUrl}/api/webhooks/referral-link/r`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, html: await res.text() };
}

const referralRow = (db, id) => db.table('tc_referrals').find((r) => r.referral_id === id);
const eventsOf = (db, id) => db.table('tc_referral_events').filter((e) => e.referral_id === id);
const tokensOf = (db, id) => db.table('tc_referral_link_tokens').filter((x) => x.referral_id === id);
const linkAudits = (db) => auditRows(db).filter((a) => String(a.resource_type).startsWith('tc_referral.link'));

// ── N: the patient's notice ─────────────────────────────────────────────────

test('N: one message per recipient class — the letter to the specialist, the notice to the patient', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { bcc: COPY });
  const { id, r, letter, notice } = await sent(baseUrl, db, acsCalls);

  assert.deepEqual(messagesByRecipient(acsCalls), { [SPECIALIST]: 1, [PATIENT]: 1 });
  assert.equal(acsCalls.filter((c) => c.method === 'POST').length, 2, 'exactly two messages');
  assert.equal(r.body.referral.status, 'sent', 'the letter is the send');
  assert.deepEqual(r.body.outcome.patientEmail, {
    status: 'sent',
    message: 'The patient was emailed who they are referred to and how to schedule.',
  });

  // The BCC rides on the letter only.
  assert.deepEqual(letter.body.recipients.bcc, [{ address: COPY }]);
  assert.equal('bcc' in notice.body.recipients, false, 'the patient notice never carries the copy inbox');
  assert.deepEqual(notice.body.recipients.to, [{ address: PATIENT }], "the address from Open Dental, lowercased");
  assert.equal(notice.body.senderAddress, 'donotreply@roland.example.test', "the office's own sender");
  assert.deepEqual(notice.body.replyTo, [{ address: 'front@roland.example.test' }]);

  // What it says — and what it never says.
  const text = notice.body.content.plainText;
  assert.equal(notice.body.content.subject, 'Your referral from Roland Family Dental to River Endodontics');
  for (const line of [
    'Hi Stedi,',
    'Roland Family Dental has referred you to Dr. Endo Example, DDS at River Endodontics. We have sent them your referral.',
    'Please call River Endodontics to schedule your appointment: (479) 555-0177',
    'Questions? Call us at (918) 555-0100.',
    'You are receiving this email because you are a patient of Roland Family Dental.',
  ]) {
    assert.ok(text.includes(line), `notice has: ${line}`);
  }
  const all = notice.body.content.plainText + notice.body.content.html + notice.body.content.subject;
  // #3 not preceded by & — an escaped apostrophe (&#39;) is not a tooth.
  for (const phi of [/Test 2/, /cracked/i, /endo eval/i, /(^|[^&])#3(?!\d)/, /Sensitive/, /assess/, /1980/, /Urgency|Soon/, /bitewing|pano/i]) {
    assert.doesNotMatch(all, phi, `minimum necessary: no ${phi}`);
  }
  assert.equal(notice.body.attachments, undefined, 'no files');
  const anchors = [...notice.body.content.html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => m[2].replace(/&#39;/g, "'"));
  assert.deepEqual(anchors, ["I've scheduled my appointment", 'Unsubscribe from these emails']);

  // On the record: the letter's move, then the notice's row with its email's facts.
  const ev = eventsOf(db, id);
  const send = ev.find((e) => e.verb === 'send');
  const notified = ev.find((e) => e.verb === 'patient_email_sent');
  assert.ok(send && notified);
  assert.deepEqual([notified.from_status, notified.to_status], ['sent', 'sent'], 'moves nothing');
  assert.equal(notified.recipient_address, PATIENT);
  assert.equal(notified.acs_message_id, 'op-2');
  assert.match(notified.unsubscribe_token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(notified.unsubscribe_token_hash, send.unsubscribe_token_hash);
  assert.match(notified.note, /^Patient emailed at the address on file in Open Dental/);
  assert.doesNotMatch(notified.note, /@/, 'the address lives in recipient_address, not in the free-text note');

  // Open Dental: exactly one read, of THIS office's patient, and nothing else.
  assert.deepEqual(odCalls.map((c) => [c.office, c.method, c.path]), [['roland', 'apiGetRaw', '/patients/12827']]);

  const audits = auditRows(db).map((a) => [a.resource_type, a.action, a.result, a.office]);
  assert.ok(audits.some((a) => a[0] === 'tc_referral.patient_email_lookup' && a[1] === 'READ' && a[3] === 'roland'));
  const sendAudit = auditRows(db).find((a) => a.resource_type === 'tc_referral.patient_email_send');
  assert.equal(sendAudit.source_ref, 'acs_operation:op-2');
  for (const a of auditRows(db)) assert.doesNotMatch(JSON.stringify(a), /example\.test|Stedi/i, 'no address or name in the trail');
});

test('N: no email on file → the letter goes, the patient is skipped by name, one message', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  odPatient.Email = '';
  const { id, r } = await sent(baseUrl, db, acsCalls);
  assert.deepEqual(messagesByRecipient(acsCalls), { [SPECIALIST]: 1 });
  assert.equal(r.body.referral.status, 'sent');
  assert.deepEqual(r.body.outcome.patientEmail, {
    status: 'skipped',
    message: 'The patient has no email on file, so no patient email was sent.',
  });
  const skipped = eventsOf(db, id).filter((e) => e.verb === 'patient_email_skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].note, 'Patient not emailed: the patient has no email on file in Open Dental.');
  assert.deepEqual([skipped[0].from_status, skipped[0].to_status], ['sent', 'sent']);
  assert.equal(skipped[0].acs_message_id ?? null, null);
  assert.equal(tokensOf(db, id).filter((x) => x.audience === 'patient').length, 0, 'no patient link without a patient email');

  // Not an address at all → the same skip.
  odPatient.Email = 'not an address';
  const second = await sent(baseUrl, db, acsCalls);
  assert.equal(second.r.body.outcome.patientEmail.status, 'skipped');
  assert.equal(second.notice, null);
});

test('N: Open Dental unreadable, not connected, or the patient gone → skipped honestly; the letter is unaffected', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  odAnswer = { ok: false, status: 500, data: null };
  const a = await sent(baseUrl, db, acsCalls);
  assert.equal(a.r.body.referral.status, 'sent');
  assert.match(a.r.body.outcome.patientEmail.message, /Open Dental couldn't be read/);
  assert.match(eventsOf(db, a.id).at(-1).note, /Open Dental could not be read/);

  odAnswer = { ok: false, status: 404, data: null };
  const b = await sent(baseUrl, db, acsCalls);
  assert.match(eventsOf(db, b.id).at(-1).note, /not found in this office's Open Dental/);
  assert.deepEqual(messagesByRecipient(acsCalls), { [SPECIALIST]: 2 });
});

test('N: the office has no Open Dental connection → skipped, and no Open Dental call is attempted', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { od: false });
  const { id, r } = await sent(baseUrl, db, acsCalls);
  assert.equal(r.body.referral.status, 'sent');
  assert.equal(r.body.outcome.patientEmail.status, 'skipped');
  assert.match(eventsOf(db, id).at(-1).note, /Open Dental isn't connected for this office/);
  assert.equal(odCalls.length, 0);
});

test("N: the patient's address unsubscribed → skipped, no message to it", async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  db.table('tc_contact_consent').push({ consent_id: randomUUID(), office_id: 'roland', channel: 'email', address: PATIENT, state: 'opted_out' });
  const { id, r } = await sent(baseUrl, db, acsCalls);
  assert.deepEqual(messagesByRecipient(acsCalls), { [SPECIALIST]: 1 });
  assert.equal(r.body.outcome.patientEmail.status, 'skipped');
  assert.equal(eventsOf(db, id).at(-1).note, 'Patient not emailed: that email address unsubscribed from our emails.');
});

test('N: ACS refuses the notice → the letter still reads sent; patient_email_failed; nothing retried', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  acsClient.setFetchForTests(async (url, init) => {
    const body = JSON.parse(String(init.body || 'null'));
    acsCalls.push({ method: init.method, url: String(url), body });
    if (body.recipients.to[0].address === PATIENT) {
      return new Response(JSON.stringify({ error: { code: 'InvalidRecipient', message: 'nope' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ id: 'op-letter', status: 'Succeeded' }), { status: 202 });
  });
  const { id, r } = await sent(baseUrl, db, acsCalls);
  assert.equal(r.status, 200);
  assert.equal(r.body.referral.status, 'sent');
  assert.equal(r.body.outcome.status, 'sent');
  assert.equal(r.body.outcome.patientEmail.status, 'failed');
  assert.match(r.body.outcome.patientEmail.message, /^The patient email could not be sent: /);
  const failed = eventsOf(db, id).filter((e) => e.verb === 'patient_email_failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].note, /^Patient email not sent: The email service refused the email/);
  assert.deepEqual(messagesByRecipient(acsCalls), { [SPECIALIST]: 1, [PATIENT]: 1 }, 'one attempt each');
  assert.equal(tokensOf(db, id).filter((x) => x.audience === 'patient').length, 0, 'no live link for an email that never went');
});

test("N: the notice's unsubscribe link opts the PATIENT's address out", async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { notice } = await sent(baseUrl, db, acsCalls);
  const token = new URL(notice.body.headers['List-Unsubscribe'].slice(1, -1)).searchParams.get('t');
  const res = await fetch(`${baseUrl}/api/webhooks/email/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `t=${encodeURIComponent(token)}`,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    db.table('tc_contact_consent').map((r) => [r.office_id, r.channel, r.address, r.state]),
    [['roland', 'email', PATIENT, 'opted_out']]
  );
});

test('N: a letter that ends in send_conflict sends no notice and leaves no live link', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db);
  db.onQuery(/^INSERT INTO audit_log \(/, (text, params) => {
    const cols = /^INSERT INTO audit_log \(([^)]+)\)/.exec(text)[1].split(',').map((s) => s.trim());
    const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
    if (row.resource_type === 'tc_referral.email_send') throw new Error('audit store down');
    db.table('audit_log').push(row);
    return { rows: [], rowCount: 1 };
  });
  realTransactions(db);
  const r = await apiJson(baseUrl, 'POST', REF(`/${id}/send-email`), {});
  assert.equal(r.status, 409);
  assert.deepEqual(messagesByRecipient(acsCalls), { [SPECIALIST]: 1 });
  assert.equal(tokensOf(db, id).length, 0, 'the links rolled back with the send');
  const letter = acsCalls.find((c) => c.method === 'POST').body;
  const page = await getPage(baseUrl, linksOf(letter).received);
  assert.equal(page.html, linkRouter.NEUTRAL_PAGE, 'its links land on the neutral page');
  assert.equal(odCalls.length, 0, 'no patient lookup for a letter not on the record');
});

/**
 * Make the fake roll back on ROLLBACK, as Postgres does — including a table
 * the transaction wrote first (the fake creates tables on first insert, so a
 * table absent at BEGIN is emptied, not left holding the rolled-back rows).
 */
function realTransactions(db) {
  let snapshot = null;
  db.onQuery(/^BEGIN$/, () => {
    snapshot = new Map([...db.tables].map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
    return { rows: [], rowCount: 0 };
  });
  db.onQuery(/^ROLLBACK$/, () => {
    if (snapshot) {
      for (const [k, live] of db.tables) {
        live.length = 0;
        live.push(...(snapshot.get(k) || []));
      }
    }
    return { rows: [], rowCount: 0 };
  });
}

// ── K: the links at rest ────────────────────────────────────────────────────

test('K: three links per send, unique to the referral and recipient, stored by hash only, 60 days', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, links } = await sent(baseUrl, db, acsCalls);
  const rows = tokensOf(db, id);
  assert.deepEqual(rows.map((x) => [x.audience, x.purpose]).sort(), [
    ['patient', 'scheduled'],
    ['specialist', 'received'],
    ['specialist', 'scheduled'],
  ]);
  const tokens = [links.received, links.scheduled, links.patient].map(tokenOf);
  assert.equal(new Set(tokens).size, 3);
  for (const tok of tokens) {
    assert.match(tok, /^[A-Za-z0-9_-]{43}$/, '32 random bytes');
    assert.ok(rows.some((x) => x.token_hash === referralLetter.hashLinkToken(tok)));
  }
  // A database leak yields no usable link: no token anywhere in any table.
  const everything = JSON.stringify([...db.tables.values()]);
  for (const tok of tokens) assert.equal(everything.includes(tok), false);
  for (const x of rows) {
    assert.match(x.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(x.office_id, 'roland');
    assert.equal(x.used_at, null);
    assert.equal(new Date(x.expires_at).getTime() - new Date(x.created_at).getTime(), 60 * DAY_MS);
  }
  // Nothing about the referral, office or person is in a URL.
  for (const url of [links.received, links.scheduled, links.patient]) {
    assert.ok(url.startsWith(`${PUBLIC_BASE}/api/webhooks/referral-link/r?t=`));
    for (const bit of [id, 'roland', '12827', 'Stedi', '@']) assert.equal(url.includes(bit), false, bit);
  }
  // A second referral gets its own.
  const other = await sent(baseUrl, db, acsCalls);
  assert.notEqual(tokenOf(other.links.received), tokenOf(links.received));
});

// ── V: the landing pages ────────────────────────────────────────────────────

test('V: GET shows the landing page — first name and practice names only — and changes nothing', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, links } = await sent(baseUrl, db, acsCalls);
  const before = JSON.stringify([referralRow(db, id), eventsOf(db, id), tokensOf(db, id)]);

  const received = await getPage(baseUrl, links.received);
  assert.equal(received.status, 200);
  assert.match(received.html, /Confirm you received this referral/);
  assert.match(received.html, /Roland Family Dental sent your office a referral for Stedi\./);
  assert.match(received.html, /<form method="post" action="r">/);
  assert.match(received.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(received.headers.get('cache-control'), 'no-store');
  assert.equal(received.headers.get('referrer-policy'), 'no-referrer');

  const scheduled = await getPage(baseUrl, links.scheduled);
  assert.match(scheduled.html, /Let Roland Family Dental know the patient is scheduled/);
  assert.match(scheduled.html, /<input type="date" id="date" name="date" min="2026-09-22" max="2027-10-22">/);

  const patient = await getPage(baseUrl, links.patient);
  assert.match(patient.html, /Hi Stedi — thanks for letting us know/);
  assert.match(patient.html, /scheduled your appointment with River Endodontics/);

  for (const p of [received, scheduled, patient]) {
    for (const phi of [/Test 2/, /cracked/i, /endo eval/i, /(^|[^&])#3(?!\d)/, /Sensitive/, /1980/, /Soon|Urgency/, /assess/, /example\.test/]) {
      assert.doesNotMatch(p.html, phi, `minimum PHI on the page: no ${phi}`);
    }
  }
  assert.equal(JSON.stringify([referralRow(db, id), eventsOf(db, id), tokensOf(db, id)]), before, 'a GET writes nothing');
  assert.deepEqual(linkAudits(db).map((a) => [a.resource_type, a.action, a.result, a.office, a.resource_id]), [
    ['tc_referral.link_view', 'READ', 'SUCCESS', 'roland', id],
    ['tc_referral.link_view', 'READ', 'SUCCESS', 'roland', id],
    ['tc_referral.link_view', 'READ', 'SUCCESS', 'roland', id],
  ]);
  for (const a of linkAudits(db)) {
    assert.equal(a.endpoint, '/api/webhooks/referral-link/r', 'no token in the trail');
    assert.equal(a.user_id, 'system:referral-link');
  }
});

// ── R: received → mark_acknowledged ─────────────────────────────────────────

test('R: "We received this referral" → the existing mark_acknowledged move, attributed to the link', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, links } = await sent(baseUrl, db, acsCalls);
  const res = await postPage(baseUrl, { t: tokenOf(links.received) });
  assert.equal(res.status, 200);
  assert.match(res.html, /Roland Family Dental now knows the referral arrived/);

  assert.equal(referralRow(db, id).status, 'acknowledged');
  assert.equal(referralRow(db, id).status_changed_by, 'system:specialist-link');
  const ack = eventsOf(db, id).find((e) => e.verb === 'mark_acknowledged');
  assert.deepEqual([ack.from_status, ack.to_status, ack.actor], ['sent', 'acknowledged', 'system:specialist-link']);
  assert.equal(ack.note, "The specialist's office confirmed it received the referral, from the link in the referral email.");
  assert.notEqual(tokensOf(db, id).find((x) => x.purpose === 'received' && x.audience === 'specialist').used_at, null);

  // The same path's audit (prior state sent) plus the link's own.
  const audits = auditRows(db).filter((a) => a.user_id === 'system:specialist-link');
  assert.deepEqual(audits.map((a) => [a.resource_type, a.action, a.result, a.prior_state]), [
    ['tc_referral', 'UPDATE', 'SUCCESS', 'sent'],
    ['tc_referral.link_use', 'UPDATE', 'SUCCESS', 'sent'],
  ]);
  // No new status exists.
  assert.equal(contract.TcReferralStatus.options.length, 9);

  // The hub shows it the way the timeline labels a link's acknowledgment.
  const detail = await apiJson(baseUrl, 'GET', REF(`/${id}`));
  assert.equal(detail.body.referral.status, 'acknowledged');
  assert.ok(contract.TcReferral.safeParse(detail.body.referral).success);
});

test('R: already acknowledged (by a person) → nothing moves, the click is still used up', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, links } = await sent(baseUrl, db, acsCalls);
  assert.equal((await apiJson(baseUrl, 'POST', REF(`/${id}/mark-acknowledged`), { note: 'They called' })).status, 200);
  const res = await postPage(baseUrl, { t: tokenOf(links.received) });
  assert.equal(res.status, 200);
  assert.match(res.html, /already had this referral marked as received/);
  assert.equal(eventsOf(db, id).filter((e) => e.verb === 'mark_acknowledged').length, 1, 'no second move');
  assert.equal((await postPage(baseUrl, { t: tokenOf(links.received) })).html, linkRouter.NEUTRAL_PAGE);
});

// ── D: scheduled, with or without a date ────────────────────────────────────

test('D: the specialist says scheduled with a date → patient_scheduled + scheduled_date, no move', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, links } = await sent(baseUrl, db, acsCalls);
  const res = await postPage(baseUrl, { t: tokenOf(links.scheduled), date: '2026-11-03' });
  assert.equal(res.status, 200);
  assert.match(res.html, /now knows the appointment is scheduled for Tuesday, November 3, 2026/);
  assert.equal(referralRow(db, id).status, 'sent', 'no status moves');
  assert.equal(referralRow(db, id).scheduled_date, '2026-11-03');
  const ev = eventsOf(db, id).find((e) => e.verb === 'patient_scheduled');
  assert.deepEqual([ev.from_status, ev.to_status, ev.actor], ['sent', 'sent', 'system:specialist-link']);
  assert.equal(ev.note, "The specialist's office said the patient is scheduled for Tuesday, November 3, 2026, from the link in the referral email.");
  const detail = await apiJson(baseUrl, 'GET', REF(`/${id}`));
  assert.equal(detail.body.referral.scheduledDate, '2026-11-03');
  assert.ok(contract.TcReferral.safeParse(detail.body.referral).success);
  // A non-move: the send problem / return readers see through it.
  assert.equal(contract.referralLastReturn(detail.body.referral.events), null);
});

test("D: the patient's link, with no date → patient_scheduled by the patient's link, no date stored", async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, links } = await sent(baseUrl, db, acsCalls);
  const res = await postPage(baseUrl, { t: tokenOf(links.patient), date: '' });
  assert.equal(res.status, 200);
  assert.match(res.html, /now knows the appointment is scheduled\./);
  const ev = eventsOf(db, id).find((e) => e.verb === 'patient_scheduled');
  assert.equal(ev.actor, 'system:patient-link');
  assert.equal(ev.note, 'The patient said the patient is scheduled, from the link in the email we sent them.');
  assert.equal(referralRow(db, id).scheduled_date ?? null, null);
});

test('D: a date must be real and from 30 days ago to a year ahead — otherwise re-ask, use nothing up', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, links } = await sent(baseUrl, db, acsCalls);
  const t1 = tokenOf(links.scheduled);
  for (const date of ['2026-02-30', '2026-13-01', '11/03/2026', 'tomorrow', '2026-09-21', '2027-10-23', '0001-01-01']) {
    const res = await postPage(baseUrl, { t: t1, date });
    assert.equal(res.status, 422, date);
    assert.match(res.html, /Please enter a date between Tuesday, September 22, 2026 and Friday, October 22, 2027, or leave it blank\./);
    assert.match(res.html, /name="t" value="[A-Za-z0-9_-]{43}"/, 'the form is offered again');
  }
  assert.equal(eventsOf(db, id).some((e) => e.verb === 'patient_scheduled'), false, 'nothing written');
  assert.equal(tokensOf(db, id).find((x) => x.purpose === 'scheduled' && x.audience === 'specialist').used_at, null, 'not used up');
  assert.ok(linkAudits(db).some((a) => a.resource_type === 'tc_referral.link_use' && a.result === 'ERROR'));
  // The edges are inside.
  assert.equal(linkRouter.readDate('2026-09-22', NOW), '2026-09-22');
  assert.equal(linkRouter.readDate('2027-10-22', NOW), '2027-10-22');
  assert.equal(linkRouter.readDate(['2026-11-03'], NOW), 'invalid', 'one value, a string');
  // And then a good one works.
  assert.equal((await postPage(baseUrl, { t: t1, date: '2026-10-22' })).status, 200);
  assert.equal(referralRow(db, id).scheduled_date, '2026-10-22');
});

// ── X: replay, expiry, unknown, cross-referral, purpose, races ──────────────

test('X: replay — a used link answers the neutral page on GET and POST, byte for byte, and writes nothing', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, links } = await sent(baseUrl, db, acsCalls);
  assert.equal((await postPage(baseUrl, { t: tokenOf(links.scheduled), date: '2026-11-03' })).status, 200);
  const snapshot = JSON.stringify([referralRow(db, id), eventsOf(db, id)]);

  const again = await postPage(baseUrl, { t: tokenOf(links.scheduled), date: '2026-12-01' });
  assert.equal(again.status, 200);
  assert.equal(again.html, linkRouter.NEUTRAL_PAGE);
  const view = await getPage(baseUrl, links.scheduled);
  assert.equal(view.html, linkRouter.NEUTRAL_PAGE);
  assert.equal(JSON.stringify([referralRow(db, id), eventsOf(db, id)]), snapshot);
  assert.equal(referralRow(db, id).scheduled_date, '2026-11-03', 'the replayed date did not land');
  const last = linkAudits(db).slice(-2).map((a) => [a.resource_type, a.result, a.resource_id, a.office]);
  assert.deepEqual(last, [
    ['tc_referral.link_use', 'UNAUTHORIZED', null, null],
    ['tc_referral.link_view', 'UNAUTHORIZED', null, null],
  ]);
});

test('X: expiry — live at day 59, the neutral page at day 61, for every kind of link', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, links } = await sent(baseUrl, db, acsCalls);
  setNow(new Date(NOW.getTime() + 59 * DAY_MS));
  assert.match((await getPage(baseUrl, links.received)).html, /Confirm you received/);
  setNow(new Date(NOW.getTime() + 61 * DAY_MS));
  for (const url of [links.received, links.scheduled, links.patient]) {
    assert.equal((await getPage(baseUrl, url)).html, linkRouter.NEUTRAL_PAGE);
    assert.equal((await postPage(baseUrl, { t: tokenOf(url), date: '' })).html, linkRouter.NEUTRAL_PAGE);
  }
  assert.equal(referralRow(db, id).status, 'sent');
  assert.equal(eventsOf(db, id).some((e) => e.verb === 'patient_scheduled' || e.verb === 'mark_acknowledged'), false);
});

test('X: unknown, malformed, missing and oversized tokens — the same neutral page, GET and POST', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { links } = await sent(baseUrl, db, acsCalls);
  const real = tokenOf(links.received);
  const flipped = (real[0] === 'A' ? 'B' : 'A') + real.slice(1);
  const pages = [];
  for (const t1 of [flipped, 'x', '', 'a'.repeat(500), `${real}=`, "<script>'"]) {
    pages.push((await getPage(baseUrl, `${PUBLIC_BASE}/api/webhooks/referral-link/r?t=${encodeURIComponent(t1)}`)).html);
    pages.push((await postPage(baseUrl, { t: t1 })).html);
  }
  pages.push((await getPage(baseUrl, `${PUBLIC_BASE}/api/webhooks/referral-link/r`)).html);
  for (const p of pages) assert.equal(p, linkRouter.NEUTRAL_PAGE);
  assert.doesNotMatch(linkRouter.NEUTRAL_PAGE, /Stedi|Roland|River|Endo/, 'names nobody');
  for (const a of linkAudits(db)) {
    assert.equal(a.result, 'UNAUTHORIZED');
    assert.equal(a.resource_id, null);
  }
  assert.equal(linkAudits(db).length, 13, 'every hit audited');
});

test("X: cross-referral reuse — a token acts only on ITS referral; a smuggled id or office is ignored", async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const a = await sent(baseUrl, db, acsCalls);
  const b = await sent(baseUrl, db, acsCalls);
  const res = await postPage(baseUrl, {
    t: tokenOf(a.links.scheduled),
    date: '2026-11-03',
    referralId: b.id,
    referral_id: b.id,
    office: 'valley',
    office_id: 'valley',
  });
  assert.equal(res.status, 200);
  assert.equal(referralRow(db, a.id).scheduled_date, '2026-11-03');
  assert.equal(referralRow(db, b.id).scheduled_date ?? null, null, 'the other referral is untouched');
  assert.equal(eventsOf(db, b.id).some((e) => e.verb === 'patient_scheduled'), false);
  assert.equal(eventsOf(db, a.id).find((e) => e.verb === 'patient_scheduled').office_id, 'roland');
  // A's used token cannot then be pointed at B either.
  const reuse = await postPage(baseUrl, { t: tokenOf(a.links.scheduled), referralId: b.id });
  assert.equal(reuse.html, linkRouter.NEUTRAL_PAGE);
  assert.equal(eventsOf(db, b.id).some((e) => e.verb === 'patient_scheduled'), false);
  // Query-string smuggling on GET changes nothing either.
  const view = await getPage(baseUrl, `${b.links.received}&referralId=${a.id}&office=valley`);
  assert.match(view.html, /Confirm you received/);
  assert.equal(linkAudits(db).at(-1).resource_id, b.id, 'the page is the token\'s referral');
});

test('X: purpose is bound to the token — "received" with a date acknowledges only; "scheduled" never acknowledges', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, links } = await sent(baseUrl, db, acsCalls);
  await postPage(baseUrl, { t: tokenOf(links.received), date: '2026-11-03' });
  assert.equal(referralRow(db, id).status, 'acknowledged');
  assert.equal(referralRow(db, id).scheduled_date ?? null, null, 'the date on a received link is ignored');
  assert.equal(eventsOf(db, id).some((e) => e.verb === 'patient_scheduled'), false);

  const other = await sent(baseUrl, db, acsCalls);
  await postPage(baseUrl, { t: tokenOf(other.links.scheduled) });
  assert.equal(referralRow(db, other.id).status, 'sent', 'scheduled does not acknowledge');
});

test('X: a concurrent double click → exactly one acts', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, links } = await sent(baseUrl, db, acsCalls);
  const tok = tokenOf(links.received);
  const results = await Promise.all([postPage(baseUrl, { t: tok }), postPage(baseUrl, { t: tok }), postPage(baseUrl, { t: tok })]);
  assert.equal(results.filter((r) => r.html === linkRouter.NEUTRAL_PAGE).length, 2);
  assert.equal(eventsOf(db, id).filter((e) => e.verb === 'mark_acknowledged').length, 1);
});

// ── L: rate limits ──────────────────────────────────────────────────────────

test('L: per client — past the limit a 429 page, valid token or not; the first throttled hit audited once', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { linkLimits: { perClientMax: 4 } });
  const { id, links } = await sent(baseUrl, db, acsCalls);
  for (let i = 0; i < 4; i += 1) assert.equal((await getPage(baseUrl, `${PUBLIC_BASE}/api/webhooks/referral-link/r?t=nope${i}`)).status, 200);
  const blocked = await postPage(baseUrl, { t: tokenOf(links.received) });
  assert.equal(blocked.status, 429);
  assert.match(blocked.html, /Too many requests/);
  assert.doesNotMatch(blocked.html, /Stedi|Roland/);
  assert.equal((await getPage(baseUrl, links.received)).status, 429);
  assert.equal(referralRow(db, id).status, 'sent', 'a throttled click acts on nothing');
  assert.equal(tokensOf(db, id).find((x) => x.purpose === 'received').used_at, null);
  const throttled = auditRows(db).filter((a) => a.resource_type === 'tc_referral.link_throttled');
  assert.equal(throttled.length, 1, 'once per client per window, not once per hit');
  assert.deepEqual([throttled[0].result, throttled[0].resource_id, throttled[0].office], ['UNAUTHORIZED', null, null]);
  assert.equal(linkAudits(db).filter((a) => a.resource_type !== 'tc_referral.link_throttled').length, 4, 'the four that got through');
});

test('L: a ceiling for all clients together', async (t) => {
  const { baseUrl } = await boot(t, { linkLimits: { perClientMax: 100, allClientsMax: 3 } });
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await postPage(baseUrl, { t: `x${i}` })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test('L: the ceiling counts only misses — live links (and scanners prefetching them) never fill it', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { linkLimits: { perClientMax: 100, allClientsMax: 3 } });
  const { id, links } = await sent(baseUrl, db, acsCalls);
  for (let i = 0; i < 6; i += 1) assert.equal((await getPage(baseUrl, links.received)).status, 200, `live view ${i}`);
  assert.equal((await postPage(baseUrl, { t: tokenOf(links.received) })).status, 200);
  assert.equal(referralRow(db, id).status, 'acknowledged');
  // Now dead: the misses count again.
  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await postPage(baseUrl, { t: `x${i}` })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});

test('L: the defaults are real ceilings', () => {
  assert.ok(linkRouter.PER_CLIENT_MAX >= 5 && linkRouter.PER_CLIENT_MAX <= 50);
  assert.ok(linkRouter.ALL_CLIENTS_MAX > linkRouter.PER_CLIENT_MAX && linkRouter.ALL_CLIENTS_MAX <= 2000);
});

// ── F: fail closed ──────────────────────────────────────────────────────────

test("F: the use's audit fails → 503, and the event, the date and the token's use all roll back", async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id, links } = await sent(baseUrl, db, acsCalls);
  realTransactions(db);
  db.onQuery(/^INSERT INTO audit_log \(/, (text, params) => {
    const cols = /^INSERT INTO audit_log \(([^)]+)\)/.exec(text)[1].split(',').map((s) => s.trim());
    const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
    if (row.resource_type === 'tc_referral.link_use' && row.result === 'SUCCESS') throw new Error('audit store down');
    db.table('audit_log').push(row);
    return { rows: [], rowCount: 1 };
  });
  const res = await postPage(baseUrl, { t: tokenOf(links.scheduled), date: '2026-11-03' });
  assert.equal(res.status, 503);
  assert.equal(referralRow(db, id).scheduled_date ?? null, null);
  assert.equal(eventsOf(db, id).some((e) => e.verb === 'patient_scheduled'), false);
  assert.equal(tokensOf(db, id).find((x) => x.purpose === 'scheduled' && x.audience === 'specialist').used_at, null, 'still usable');

  const ack = await postPage(baseUrl, { t: tokenOf(links.received) });
  assert.equal(ack.status, 503);
  assert.equal(referralRow(db, id).status, 'sent', 'the mark_acknowledged move rolled back too');
});

test('F: a failed view audit → 503 and no names shown', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { links } = await sent(baseUrl, db, acsCalls);
  db.onQuery(/^INSERT INTO audit_log \(/, () => {
    throw new Error('audit store down');
  });
  const res = await getPage(baseUrl, links.received);
  assert.equal(res.status, 503);
  assert.doesNotMatch(res.html, /Stedi/);
});

test('F: no tenant configured, or not entitled to tc → 503 before any token is looked at', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { links } = await sent(baseUrl, db, acsCalls);
  const reads = () => db.log.filter((l) => /tc_referral_link_tokens/.test(l.sql)).length;
  const before = reads();
  delete process.env.TC_EMAIL_TENANT_SLUG;
  assert.equal((await getPage(baseUrl, links.received)).status, 503);
  assert.equal((await postPage(baseUrl, { t: tokenOf(links.received) })).status, 503);
  process.env.TC_EMAIL_TENANT_SLUG = 'carein';
  registry.getEnabledModules = async () => ['voice'];
  assert.equal((await postPage(baseUrl, { t: tokenOf(links.received) })).status, 503);
  assert.equal(reads(), before);
});

// ── G: guards ───────────────────────────────────────────────────────────────

test('G: the send path reaches Open Dental only through one READ-ONLY module', () => {
  const backend = path.join(__dirname, '..', '..');
  const read = (rel) => fs.readFileSync(path.join(backend, rel), 'utf8');
  const contact = read('services/tc/referralPatientContact.js');
  assert.match(contact, /apiGetRaw/);
  assert.doesNotMatch(contact, /apiPost|apiPut|apiPatch|apiDelete|odPatientCache|commlog/i, 'no write of any kind');
  assert.match(read('routes/tc/referralSend.js'), /require\('\.\.\/\.\.\/services\/tc\/referralPatientContact'\)/);
  for (const rel of ['routes/tc/referralSend.js', 'routes/tc/referralLetterText.js', 'services/messaging/referralLetter.js', 'routes/referralLinkWebhooks.js']) {
    assert.doesNotMatch(read(rel), /getOdOffice|apiGetRaw|apiPost|apiPut|apiPatch|apiDelete/, rel);
  }
});

test('G: the public route sends nothing and takes office and referral only from the token row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'referralLinkWebhooks.js'), 'utf8');
  assert.doesNotMatch(src, /\btransport\(|acs\/client|adapters|sendReferral|notifyPatient/, 'no send from a link');
  // The only request fields read: the token and the date.
  const reads = [...src.matchAll(/req\.(?:body|query)\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(reads)].sort(), ['date', 't']);
  assert.doesNotMatch(src, /req\.params/);
  assert.match(src, /const office = link\.office_id;/);
  assert.match(src, /const referralId = String\(link\.referral_id\);/);
});

test('G: the notice never gets a BCC — bccAddress stays on the letter path only', () => {
  const src = fs.readFileSync(path.join(__dirname, 'referralSend.js'), 'utf8');
  const at = src.indexOf('async function notifyPatient(');
  const end = src.indexOf('\nmodule.exports', at);
  assert.ok(at > -1 && end > at);
  const body = src.slice(at, end);
  assert.doesNotMatch(body, /bccAddress\s*:|bccFor\(|\bbcc\s*[,}]/, 'no BCC is set on the notice');
  assert.match(body, /referralLetter\.messageOf\(\{\s*office,\s*attemptId: randomUUID\(\),\s*toAddress: address,\s*rendered,\s*unsubscribeUrl: unsubscribe\.url,\s*\}\)/);
});
