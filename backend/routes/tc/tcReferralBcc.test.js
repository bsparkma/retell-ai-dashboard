'use strict';

/**
 * R6.3 — every referral letter is blind-copied to the office's saved copy
 * inbox, over HTTP with a FAKE ACS (routes/emailTestUtils.js records every
 * request; nothing reaches a network) and a fake blob store.
 *
 *   - EXACTLY ONE message per send, copy inbox set or not: the copy rides the
 *     same request as a `bcc` recipient, never a second send
 *   - BCC present when configured, absent when not; never in `to`, never in
 *     the letter's words or headers (the specialist cannot see it)
 *   - the copy never changes the result: ACS accepted → sent; failed → the
 *     referral stays approved; a conflict is a conflict
 *   - the history row says what happened to the copy, honestly, either way
 *   - the auto-send on approval copies the same way
 *   - only the referral letter can carry a BCC: a source scan finds
 *     `bccAddress` only in the send, the letter transport and the adapter's
 *     payload builder
 *
 * Test patient only: roland 12827 "Test 2, Stedi". Addresses @example.test.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const tcReferralEmail = require('../../config/tcReferralEmail');
const emailIdentity = require('../../config/emailIdentity');
const consent = require('../../services/messaging/consent');
const blob = require('../../services/tc/referralAttachmentStore');
const transitions = require('./referralTransitions');
const { bootEmailApp, resetEmailHarness, apiJson } = require('../emailTestUtils');

const NOW = new Date('2026-10-22T15:00:00.000Z');
const SPECIALIST = 'referrals@endo.example.test';
const COPY = 'referral-copies@roland.example.test';

const EXTRA_ENV = [
  'TC_REFERRALS_ENABLED_ROLAND',
  'TC_REFERRAL_EMAIL_ENABLED_ROLAND',
  'REFERRAL_SIGNOFF_REQUIRED_ROLAND',
  'REFERRAL_AUTOSEND_ON_APPROVAL_ROLAND',
  'TC_BLOB_ACCOUNT_URL',
];
const SAVED = Object.fromEntries(EXTRA_ENV.map((k) => [k, process.env[k]]));

test.afterEach(() => {
  resetEmailHarness();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  tcReferrals.resetCacheForTests();
  tcReferralEmail.resetCacheForTests();
  emailIdentity.resetCacheForTests();
  transitions.setClockForTests(null);
});

/**
 * Boot with referrals + referral email ON for roland, and the office's saved
 * copy inbox set to `bcc` (null = none saved). Other platform settings answer
 * nothing, so every switch falls back to env as in R5's tests.
 */
async function boot(t, { bcc = null, env = {}, ...opts } = {}) {
  for (const k of EXTRA_ENV) delete process.env[k];
  process.env.TC_REFERRALS_ENABLED_ROLAND = 'true';
  process.env.TC_REFERRAL_EMAIL_ENABLED_ROLAND = 'true';
  process.env.TC_BLOB_ACCOUNT_URL = 'https://blob.example.test';
  Object.assign(process.env, env);
  tcReferrals.resetCacheForTests();
  tcReferralEmail.resetCacheForTests();
  transitions.setClockForTests(() => NOW);
  const app = await bootEmailApp({ env: {}, ...opts });
  // After boot (it installs its own registry fakes and restores them on close).
  registry.getPlatformSetting = async (key) =>
    key === emailIdentity.SETTING_KEY && bcc
      ? { key, value: { roland: { referralBcc: bcc } }, updated_at: NOW, updated_by: 'office@carein.ai' }
      : null;
  emailIdentity.resetCacheForTests();
  await emailIdentity.refreshFromDb();
  consent.setOdPatientReaderForTests(async () => null);
  t.after(() => app.close());
  return app;
}

const REF = (p = '') => `/api/tc/referrals${p}?office=roland`;
const SIGN = (p = '') => `/api/tc/referrals/signoff${p}?office=roland`;
const INPUT = { reason: 'Possible cracked tooth, needs endo eval', urgency: 'soon', teeth: [3] };

function seed(db, { email = 'Referrals@Endo.Example.test' } = {}) {
  const c = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: 12827, status: 'pending_tc' };
  db.table('tc_cases').push(c);
  const entry = { entry_id: randomUUID(), office_id: 'roland', practice_name: 'River Endodontics', specialty: 'Endodontics', email, active: true };
  db.table('tc_referral_directory').push(entry);
  return { c, entry };
}

/** Walk one to pending sign-off through the real routes. */
async function pending(baseUrl, db, seedOpts) {
  const { c, entry } = seed(db, seedOpts);
  const r = await apiJson(baseUrl, 'POST', REF(), { source: { caseId: c.case_id }, referral: { ...INPUT, directoryEntryId: entry.entry_id } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.referral.referralId;
  assert.equal((await apiJson(baseUrl, 'POST', REF(`/${id}/submit`), {})).status, 200);
  return id;
}

async function approved(baseUrl, db, seedOpts) {
  const id = await pending(baseUrl, db, seedOpts);
  assert.equal((await apiJson(baseUrl, 'POST', SIGN(`/${id}/approve`), {})).status, 200);
  return id;
}

const send = (baseUrl, id) => apiJson(baseUrl, 'POST', REF(`/${id}/send-email`), {});
const posts = (acsCalls) => acsCalls.filter((c) => c.method === 'POST');
const eventsOf = (db, id) => db.table('tc_referral_events').filter((e) => e.referral_id === id);
const lastEvent = (db, id, verb) => eventsOf(db, id).filter((e) => e.verb === verb).pop();

/** Everything the specialist can see of the message: to, headers, subject, bodies. */
function visibleToRecipient(body) {
  return JSON.stringify({ to: body.recipients.to, replyTo: body.replyTo, headers: body.headers, content: body.content, sender: body.senderAddress });
}

test('no copy inbox saved: exactly one message, no BCC anywhere, and the history says nothing of a copy', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const id = await approved(baseUrl, db);
  const r = await send(baseUrl, id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(posts(acsCalls).length, 1, 'exactly one message');
  const body = posts(acsCalls)[0].body;
  assert.deepEqual(body.recipients, { to: [{ address: SPECIALIST }] });
  assert.equal('bcc' in body.recipients, false);
  assert.doesNotMatch(lastEvent(db, id, 'send').note, /copy|BCC/i);
});

test('a copy inbox saved: exactly one message, BCC on it, invisible to the specialist; the send is a plain success', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { bcc: COPY });
  const id = await approved(baseUrl, db);
  const r = await send(baseUrl, id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.referral.status, 'sent');
  assert.equal(posts(acsCalls).length, 1, 'one message — the copy is not a second send');
  const body = posts(acsCalls)[0].body;
  assert.deepEqual(body.recipients.to, [{ address: SPECIALIST }]);
  assert.deepEqual(body.recipients.bcc, [{ address: COPY }]);
  assert.equal(body.recipients.cc, undefined);
  assert.ok(!visibleToRecipient(body).includes(COPY), 'the copy inbox appears nowhere the specialist can see');
  // The From and the reply-to are what they were.
  assert.equal(body.senderAddress, 'donotreply@roland.example.test');
  assert.ok(Array.isArray(body.replyTo) && body.replyTo.length === 1);
  // The outcome the person sees is unchanged by the copy; the history records it.
  assert.doesNotMatch(r.body.outcome.message, /copy|BCC/i);
  assert.match(lastEvent(db, id, 'send').note, new RegExp(`blind copy \\(BCC\\) to ${COPY.replace(/\./g, '\\.')} was on the same message`));
  assert.equal(lastEvent(db, id, 'send').recipient_address, SPECIALIST, 'the history recipient is the specialist');
});

test('the copy inbox IS the specialist: no BCC (one mailbox, one copy)', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { bcc: SPECIALIST });
  const id = await approved(baseUrl, db);
  assert.equal((await send(baseUrl, id)).status, 200);
  assert.equal(posts(acsCalls).length, 1);
  assert.equal('bcc' in posts(acsCalls)[0].body.recipients, false);
});

test('ACS fails it: still one attempt, the referral stays approved, and the history says no copy went out either', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { bcc: COPY, acsStatus: 'Running', acsPolls: [{ status: 'Failed', error: { code: 'Bounced' } }] });
  const id = await approved(baseUrl, db);
  const r = await send(baseUrl, id);
  assert.notEqual(r.status, 200);
  assert.equal(posts(acsCalls).length, 1, 'no retry, no copy-only send');
  assert.deepEqual(posts(acsCalls)[0].body.recipients.bcc, [{ address: COPY }]);
  assert.equal(db.table('tc_referrals').find((x) => x.referral_id === id).status, 'approved');
  assert.match(lastEvent(db, id, 'send_failed').note, /No blind copy went out either\.$/);
});

test('ACS accepted but the referral cannot be marked sent: the conflict row records the copy too', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { bcc: COPY });
  const id = await approved(baseUrl, db);
  // Fail the in-transaction audit of the send, which rolls the move back.
  db.onQuery(/^INSERT INTO audit_log \(/, (text, params) => {
    const cols = /^INSERT INTO audit_log \(([^)]+)\)/.exec(text)[1].split(',').map((s) => s.trim());
    const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
    if (row.resource_type === 'tc_referral.email_send') throw new Error('audit store down');
    db.table('audit_log').push(row);
    return { rows: [], rowCount: 1 };
  });
  const r = await send(baseUrl, id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERRAL_EMAIL_CONFLICT');
  assert.equal(posts(acsCalls).length, 1);
  assert.match(lastEvent(db, id, 'send_conflict').note, /blind copy \(BCC\) to .* was on the same message\.$/);
});

test('the auto-send on approval copies the same way: one message, BCC present', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { bcc: COPY });
  // The office's own policy row, as R5's auto-send tests set it (the env can only pin the safe value).
  db.table('tc_referral_settings').push({ office_id: 'roland', signoff_required: true, autosend_on_approval: true, updated_by: 'boss@carein.ai' });
  const id = await pending(baseUrl, db);
  const a = await apiJson(baseUrl, 'POST', SIGN(`/${id}/approve`), {});
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.referral.status, 'sent', JSON.stringify(a.body.autoSend));
  assert.equal(posts(acsCalls).length, 1);
  assert.deepEqual(posts(acsCalls)[0].body.recipients.bcc, [{ address: COPY }]);
});

test('only the referral letter can carry a BCC: bccAddress appears only in the send, its transport and the payload builder', () => {
  const root = path.join(__dirname, '..', '..');
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c?js)$/.test(e.name) && !/\.test\.js$/.test(e.name) && !/contract\.gen\.cjs$/.test(e.name)) {
        if (fs.readFileSync(p, 'utf8').includes('bccAddress')) hits.push(path.relative(root, p).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  assert.deepEqual(hits.sort(), [
    'routes/tc/referralSend.js',
    'services/messaging/adapters/emailAdapter.js',
    'services/messaging/referralLetter.js',
  ]);
});
