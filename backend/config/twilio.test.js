'use strict';

/** Twilio configuration: per-office senders, fail closed (queue item 39). */

const assert = require('node:assert/strict');
const test = require('node:test');

const twilio = require('./twilio');

const KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_MESSAGING_SERVICE_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WEBHOOK_BASE_URL',
  'TWILIO_TENANT_SLUG',
  'TWILIO_FROM_ROLAND',
  'TWILIO_FROM_VALLEY',
];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

test.afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function clear() {
  for (const k of KEYS) delete process.env[k];
}

function configureAccount() {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_API_KEY_SID = 'SKtest';
  process.env.TWILIO_API_KEY_SECRET = 'secret';
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGtest';
  process.env.TWILIO_WEBHOOK_BASE_URL = 'https://dashboard.example.test/';
}

test('nothing configured: not configured, names every missing var (names only)', () => {
  clear();
  assert.equal(twilio.accountConfigured(), false);
  assert.deepEqual(twilio.missingAccountConfig(), [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_API_KEY_SID',
    'TWILIO_API_KEY_SECRET',
    'TWILIO_MESSAGING_SERVICE_SID',
    'TWILIO_WEBHOOK_BASE_URL',
  ]);
});

test('per-office senders: only roland configured → valley has none, and never borrows roland’s', () => {
  clear();
  configureAccount();
  process.env.TWILIO_FROM_ROLAND = '+14795550150';
  assert.equal(twilio.accountConfigured(), true);
  assert.equal(twilio.fromNumberFor('roland'), '+14795550150');
  assert.equal(twilio.fromNumberFor('valley'), null);
  assert.equal(twilio.fromNumberFor('unknown'), null);
  assert.equal(twilio.fromNumberFor('ROLAND'), null);
});

test('a from-number that is not strict E.164 is MISSING, not fixed up', () => {
  clear();
  for (const bad of ['4795550150', '(479) 555-0150', '+0123456789', 'tel:+14795550150', '+1 479 555 0150']) {
    process.env.TWILIO_FROM_VALLEY = bad;
    assert.equal(twilio.fromNumberFor('valley'), null, bad);
  }
});

test('receiving number → office; unknown → null; the same number on two offices → null (never pick one)', () => {
  clear();
  process.env.TWILIO_FROM_ROLAND = '+14795550150';
  process.env.TWILIO_FROM_VALLEY = '+14795550160';
  assert.equal(twilio.officeForReceivingNumber('+14795550150'), 'roland');
  assert.equal(twilio.officeForReceivingNumber('+14795550160'), 'valley');
  assert.equal(twilio.officeForReceivingNumber('+14795550199'), null);
  assert.equal(twilio.officeForReceivingNumber(null), null);
  process.env.TWILIO_FROM_VALLEY = '+14795550150';
  assert.equal(twilio.officeForReceivingNumber('+14795550150'), null);
});

test('webhook base URL: https only, no query/hash, trailing slash dropped', () => {
  clear();
  process.env.TWILIO_WEBHOOK_BASE_URL = 'https://dashboard.example.test/';
  assert.equal(twilio.webhookBaseUrl(), 'https://dashboard.example.test');
  assert.equal(twilio.statusCallbackUrl('valley'), 'https://dashboard.example.test/api/webhooks/twilio/status/valley');
  assert.equal(twilio.statusCallbackUrl('riley'), null);
  for (const bad of ['http://dashboard.example.test', 'https://x.test/?a=1', 'not a url', '']) {
    process.env.TWILIO_WEBHOOK_BASE_URL = bad;
    assert.equal(twilio.webhookBaseUrl(), null, bad);
  }
});
