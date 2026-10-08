'use strict';

/** ACS Email configuration (queue item 40): names in, fail-closed answers out. */

const assert = require('node:assert/strict');
const test = require('node:test');

const acs = require('./acsEmail');

const KEYS = [
  'ACS_EMAIL_AUTH_MODE',
  'ACS_EMAIL_ENDPOINT',
  'ACS_EMAIL_CONNECTION',
  'ACS_EMAIL_FROM',
  'ACS_EMAIL_FROM_ROLAND',
  'ACS_EMAIL_FROM_VALLEY',
  'ACS_EMAIL_REPLY_TO_ROLAND',
  'TC_EMAIL_PUBLIC_BASE_URL',
  'TC_EMAIL_TENANT_SLUG',
  'TC_EMAIL_PRACTICE_ADDRESS_ROLAND',
  'TC_EMAIL_PRACTICE_PHONE_ROLAND',
];
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
// A syntactically valid, obviously fake key (base64 of 32 zero-ish bytes).
const FAKE_KEY = Buffer.alloc(32, 7).toString('base64');

function env(values) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

test.afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

const BASE = {
  ACS_EMAIL_ENDPOINT: 'https://acs-carein-test.communication.azure.com',
  TC_EMAIL_PUBLIC_BASE_URL: 'https://dashboard.example.test',
  TC_EMAIL_TENANT_SLUG: 'carein',
};

test('nothing set: not configured, and every missing NAME is listed (never a value)', () => {
  env({});
  assert.equal(acs.accountConfigured(), false);
  assert.deepEqual(acs.missingAccountConfig(), ['ACS_EMAIL_ENDPOINT', 'TC_EMAIL_PUBLIC_BASE_URL', 'TC_EMAIL_TENANT_SLUG']);
});

test('managed identity is the default mode; endpoint must be an https origin', () => {
  env(BASE);
  assert.equal(acs.authMode(), 'managed_identity');
  assert.equal(acs.accountConfigured(), true);
  assert.equal(acs.accountConfig().endpoint, 'https://acs-carein-test.communication.azure.com');
  for (const bad of ['http://acs.example.test', 'https://acs.example.test/path', 'https://acs.example.test?x=1', 'not a url']) {
    env({ ...BASE, ACS_EMAIL_ENDPOINT: bad });
    assert.equal(acs.accountConfigured(), false, bad);
  }
});

test('an unknown auth mode is NOT a mode: not configured, no fallback', () => {
  env({ ...BASE, ACS_EMAIL_AUTH_MODE: 'api_key' });
  assert.equal(acs.authMode(), null);
  assert.equal(acs.accountConfigured(), false);
  assert.deepEqual(acs.missingAccountConfig(), ['ACS_EMAIL_AUTH_MODE']);
});

test('connection_string mode reads endpoint + key from ACS_EMAIL_CONNECTION, never ACS_EMAIL_ENDPOINT', () => {
  env({
    ...BASE,
    ACS_EMAIL_AUTH_MODE: 'connection_string',
    ACS_EMAIL_ENDPOINT: 'https://other.communication.azure.com',
    ACS_EMAIL_CONNECTION: `endpoint=https://acs-carein-test.communication.azure.com/;accesskey=${FAKE_KEY}`,
  });
  const c = acs.accountConfig();
  assert.equal(c.mode, 'connection_string');
  assert.equal(c.endpoint, 'https://acs-carein-test.communication.azure.com');
  assert.equal(c.accessKey, FAKE_KEY);
  assert.equal(acs.accountConfigured(), true);
  // A connection string without a key, or with an http endpoint, is not configured.
  for (const bad of ['endpoint=https://acs.example.test/', `endpoint=http://acs.example.test/;accesskey=${FAKE_KEY}`, 'accesskey=x']) {
    env({ ...BASE, ACS_EMAIL_AUTH_MODE: 'connection_string', ACS_EMAIL_CONNECTION: bad });
    assert.equal(acs.accountConfigured(), false, bad);
    assert.deepEqual(acs.missingAccountConfig(), ['ACS_EMAIL_CONNECTION']);
  }
});

test('sender: per office first, else the shared sender, else none; garbage is missing', () => {
  env({ ...BASE, ACS_EMAIL_FROM_ROLAND: 'DoNotReply@Roland.example.test' });
  assert.equal(acs.fromAddressFor('roland'), 'donotreply@roland.example.test');
  assert.equal(acs.fromAddressFor('valley'), null, 'valley never borrows roland');
  env({ ...BASE, ACS_EMAIL_FROM: 'donotreply@shared.example.test', ACS_EMAIL_FROM_ROLAND: 'roland@example.test' });
  assert.equal(acs.fromAddressFor('roland'), 'roland@example.test');
  assert.equal(acs.fromAddressFor('valley'), 'donotreply@shared.example.test');
  env({ ...BASE, ACS_EMAIL_FROM: 'donotreply@shared.example.test', ACS_EMAIL_FROM_ROLAND: 'Roland <x@example.test>' });
  assert.equal(acs.fromAddressFor('roland'), null, 'a set-but-invalid office sender is missing, not the shared one');
  assert.equal(acs.fromAddressFor('unknown'), null);
  assert.equal(acs.fromAddressFor('riley'), null);
});

test('the unsubscribe URL carries only the opaque token', () => {
  env(BASE);
  assert.equal(
    acs.unsubscribeUrl('abc_DEF-123'),
    'https://dashboard.example.test/api/webhooks/email/unsubscribe?t=abc_DEF-123'
  );
  env({ ...BASE, TC_EMAIL_PUBLIC_BASE_URL: 'http://dashboard.example.test' });
  assert.equal(acs.unsubscribeUrl('abc'), null, 'https only');
});

test('practice details and reply-to are optional and per office', () => {
  env({
    ...BASE,
    TC_EMAIL_PRACTICE_ADDRESS_ROLAND: '1 Example St, Roland OK',
    TC_EMAIL_PRACTICE_PHONE_ROLAND: '(918) 555-0100',
    ACS_EMAIL_REPLY_TO_ROLAND: 'Front@Roland.example.test',
  });
  assert.deepEqual(acs.practiceDetailsFor('roland'), { address: '1 Example St, Roland OK', phone: '(918) 555-0100' });
  assert.deepEqual(acs.practiceDetailsFor('valley'), { address: null, phone: null });
  assert.equal(acs.replyToFor('roland'), 'front@roland.example.test');
  assert.equal(acs.replyToFor('valley'), null);
});
