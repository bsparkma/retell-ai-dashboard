'use strict';

/**
 * R5c: ONE email identity per office, read by EVERY renderer. A value saved in
 * the app (config/emailIdentity.js) reaches the TC patient email's footer, its
 * {{practice.*}} / {{sender.email}} tokens and its Reply-To header, and the
 * referral letter's footer and the referral gate — and the app setting still
 * answers when nothing is saved. Over a fake control plane and a fake ACS.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../platform/registry');
const emailIdentity = require('../../config/emailIdentity');
const tcEmail = require('../../config/tcEmail');
const emailContent = require('./emailContent');
const referralLetter = require('./referralLetter');
const adapter = require('./adapters/emailAdapter');
const client = require('./acs/client');

const ENV = {
  TC_EMAIL_ENABLED: 'true',
  ACS_EMAIL_AUTH_MODE: 'managed_identity',
  ACS_EMAIL_ENDPOINT: 'https://acs-carein-test.communication.azure.com',
  ACS_EMAIL_FROM_ROLAND: 'donotreply@roland.example.test',
  TC_EMAIL_PUBLIC_BASE_URL: 'https://dashboard.example.test',
  TC_EMAIL_TENANT_SLUG: 'carein',
};
const KEYS = [
  ...Object.keys(ENV),
  'ACS_EMAIL_FROM',
  'ACS_EMAIL_REPLY_TO_ROLAND',
  'TC_EMAIL_PRACTICE_NAME_ROLAND',
  'TC_EMAIL_PRACTICE_PHONE_ROLAND',
  'TC_EMAIL_PRACTICE_ADDRESS_ROLAND',
];
const SAVED_ENV = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const originalGet = registry.getPlatformSetting;

/** @type {unknown} */
let storedIdentity = null;

test.beforeEach(async () => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, ENV);
  storedIdentity = null;
  registry.getPlatformSetting = async (key) =>
    key === emailIdentity.SETTING_KEY && storedIdentity
      ? { key, value: storedIdentity, updated_at: new Date(), updated_by: 'office.manager@example.test' }
      : null;
  tcEmail.resetCacheForTests();
  emailIdentity.resetCacheForTests();
  client.setTokenProviderForTests(async () => 'fake-token');
  client.setWaitForTests(async () => undefined);
});

test.afterEach(() => {
  for (const k of KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  registry.getPlatformSetting = originalGet;
  tcEmail.resetCacheForTests();
  emailIdentity.resetCacheForTests();
  client.resetForTests();
});

/** Save an identity "in the app" and load it the way boot / the timer would. */
async function save(value) {
  storedIdentity = value;
  await emailIdentity.refreshFromDb();
}

const SAVED = {
  roland: {
    replyTo: 'frontdesk@roland.example.test',
    practiceName: 'Roland Example Dental',
    practicePhone: '(918) 555-0142',
  },
};

test('patient email: the footer and the practice tokens carry the SAVED identity', async () => {
  process.env.TC_EMAIL_PRACTICE_NAME_ROLAND = 'Env Name';
  process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = '(918) 555-0100';
  process.env.ACS_EMAIL_REPLY_TO_ROLAND = 'env@roland.example.test';
  await save(SAVED);

  const footer = emailContent.footerFor('roland', 'https://dashboard.example.test/u');
  assert.equal(footer.practiceName, 'Roland Example Dental');
  assert.equal(footer.practicePhone, '(918) 555-0142');
  const values = emailContent.practiceValues('roland');
  assert.equal(values['practice.name'], 'Roland Example Dental');
  assert.equal(values['practice.phone'], '(918) 555-0142');
  assert.equal(values['sender.email'], 'frontdesk@roland.example.test');

  const rendered = emailContent.renderRow(
    { subject: 'Hello', body: 'Call us at {{practice.phone}}.', email_blocks: null, email_preheader: '' },
    'roland',
    'https://dashboard.example.test/u'
  );
  assert.match(rendered.html, /Roland Example Dental/);
  assert.match(rendered.html, /\(918\) 555-0142/);
  assert.doesNotMatch(rendered.html, /Env Name|555-0100/, 'the app setting is shadowed, not mixed in');
});

test('patient email: nothing saved -> the app setting answers; nothing set -> the office label', async () => {
  await save(null);
  assert.equal(emailContent.footerFor('roland', null).practiceName, 'Roland', 'the office label, as before R5c');
  assert.equal(emailContent.practiceValues('roland')['sender.email'], null);
  process.env.TC_EMAIL_PRACTICE_NAME_ROLAND = 'Env Name';
  process.env.ACS_EMAIL_REPLY_TO_ROLAND = 'env@roland.example.test';
  assert.equal(emailContent.footerFor('roland', null).practiceName, 'Env Name');
  assert.equal(emailContent.practiceValues('roland')['sender.email'], 'env@roland.example.test');
});

test('patient email: the Reply-To header the adapter sends is the SAVED one', async () => {
  process.env.ACS_EMAIL_REPLY_TO_ROLAND = 'env@roland.example.test';
  await save(SAVED);
  const calls = [];
  client.setFetchForTests(async (url, init) => {
    calls.push({ method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 'op-1', status: 'Succeeded' }), { status: 202 });
  });
  await adapter.send(
    {
      messageId: '33333333-3333-4333-8333-333333333333',
      officeId: 'roland',
      caseId: null,
      channel: 'email',
      toAddress: 'patient.one@example.test',
      body: 'plain text',
      subject: 'Following up',
      templateId: null,
      html: '<!doctype html><p>hi</p>',
      unsubscribeUrl: 'https://dashboard.example.test/api/webhooks/email/unsubscribe?t=x',
    },
    { officeKey: 'roland', officeName: 'Roland' }
  );
  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body.replyTo, [{ address: 'frontdesk@roland.example.test' }]);
  assert.equal(post.body.senderAddress, 'donotreply@roland.example.test', 'From is never the saved identity');
});

test('referral letter: the footer signs with the SAVED name and phone', async () => {
  process.env.TC_EMAIL_PRACTICE_NAME_ROLAND = 'Env Name';
  await save(SAVED);
  const out = emailContent.renderReferralLetter({
    office: 'roland',
    subject: 'Referral',
    text: 'Please see the patient.',
    unsubscribeUrl: 'https://dashboard.example.test/u',
  });
  assert.match(out.html, /Roland Example Dental/);
  assert.match(out.html, /\(918\) 555-0142/);
  assert.doesNotMatch(out.html, /Env Name/);
});

test('referral gate: a SAVED reply-to satisfies it with no app setting; neither -> the honest refusal', async () => {
  delete process.env.ACS_EMAIL_REPLY_TO_ROLAND;
  await save(null);
  assert.equal(referralLetter.unavailableReason('roland'), 'office_not_configured');
  assert.throws(
    () => referralLetter.assertAvailable('roland'),
    (e) =>
      e.code === 'FEATURE_DISABLED' &&
      /no reply-to address for referral email yet/.test(e.message) &&
      /Settings, under Email identity/.test(e.message) &&
      e.extra.missing.includes('ACS_EMAIL_REPLY_TO_ROLAND')
  );

  await save(SAVED);
  assert.equal(referralLetter.unavailableReason('roland'), null);
  assert.doesNotThrow(() => referralLetter.assertAvailable('roland'));
});

test("referral gate: a missing SENDER says it is the platform's, never sends the office to Settings", async () => {
  delete process.env.ACS_EMAIL_FROM_ROLAND;
  await save(SAVED);
  assert.throws(
    () => referralLetter.assertAvailable('roland'),
    (e) => /no referral sending address set up yet \(the platform sets that up\)/.test(e.message) && !/Settings/.test(e.message)
  );
});
