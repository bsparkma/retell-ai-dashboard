'use strict';

/**
 * (R5) The ACS email adapter's attachments and size cap, over a FAKE ACS
 * transport: attachments go in exactly as given, a patient email's request is
 * unchanged (no `attachments` key), a malformed attachment or a request over
 * ACS's cap is refused before anything is sent, and requestBytes() measures
 * exactly the body that is POSTed.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../../platform/registry');
const adapter = require('./emailAdapter');
const client = require('../acs/client');
const tcEmail = require('../../../config/tcEmail');
const acsConfig = require('../../../config/acsEmail');

const ENV = {
  TC_EMAIL_ENABLED: 'true',
  ACS_EMAIL_AUTH_MODE: 'managed_identity',
  ACS_EMAIL_ENDPOINT: 'https://acs-carein-test.communication.azure.com',
  ACS_EMAIL_FROM_ROLAND: 'donotreply@roland.example.test',
  ACS_EMAIL_REPLY_TO_ROLAND: 'front@roland.example.test',
  TC_EMAIL_PUBLIC_BASE_URL: 'https://dashboard.example.test',
  TC_EMAIL_TENANT_SLUG: 'carein',
};
const KEYS = [...Object.keys(ENV), 'ACS_EMAIL_FROM'];
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const originalGet = registry.getPlatformSetting;

test.beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, ENV);
  registry.getPlatformSetting = async () => null;
  tcEmail.resetCacheForTests();
  client.setTokenProviderForTests(async () => 'fake-token');
  client.setWaitForTests(async () => undefined);
});

test.afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  registry.getPlatformSetting = originalGet;
  tcEmail.resetCacheForTests();
  client.resetForTests();
});

const MESSAGE = {
  messageId: '33333333-3333-4333-8333-333333333333',
  officeId: 'roland',
  caseId: null,
  channel: 'email',
  toAddress: 'referrals@endo.example.test',
  body: 'plain text',
  subject: 'Referral from Roland',
  templateId: null,
  html: '<!doctype html><p>letter</p>',
  unsubscribeUrl: 'https://dashboard.example.test/api/webhooks/email/unsubscribe?t=x',
};
const OFFICE = { officeKey: 'roland', officeName: 'Roland' };

function fakeAcs() {
  const calls = [];
  client.setFetchForTests(async (url, init) => {
    assert.ok(String(url).startsWith('https://acs-carein-test.communication.azure.com/'), `unexpected URL ${url}`);
    calls.push({ method: init.method, raw: init.body ? String(init.body) : '', body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 'op-1', status: 'Succeeded' }), { status: 202 });
  });
  return calls;
}

test('attachments go into the request exactly as given; a message without them has no attachments key', async () => {
  const calls = fakeAcs();
  const attachments = [
    { name: 'bitewing.png', contentType: 'image/png', contentInBase64: Buffer.from('a').toString('base64') },
    { name: 'pano.pdf', contentType: 'application/pdf', contentInBase64: Buffer.from('b').toString('base64') },
  ];
  await adapter.send({ ...MESSAGE, attachments }, OFFICE);
  await adapter.send(MESSAGE, OFFICE);
  assert.deepEqual(calls[0].body.attachments, attachments);
  assert.equal('attachments' in calls[1].body, false, 'patient email is unchanged');
});

test('requestBytes() is the size of exactly the body that is POSTed', async () => {
  const calls = fakeAcs();
  const message = {
    ...MESSAGE,
    subject: 'Referral — Stedi T., ünïcode',
    attachments: [{ name: 'x.png', contentType: 'image/png', contentInBase64: Buffer.alloc(5000, 7).toString('base64') }],
  };
  const predicted = adapter.requestBytes(message, 'roland');
  await adapter.send(message, OFFICE);
  assert.equal(predicted, Buffer.byteLength(calls[0].raw, 'utf8'));
});

test('a malformed attachment is refused before anything is sent', async () => {
  const calls = fakeAcs();
  for (const bad of [
    'not-a-list',
    [{ name: '', contentType: 'image/png', contentInBase64: 'AA==' }],
    [{ name: 'x.png', contentType: 'image png', contentInBase64: 'AA==' }],
    [{ name: 'x.png', contentType: 'image/png', contentInBase64: '' }],
  ]) {
    await assert.rejects(adapter.send({ ...MESSAGE, attachments: bad }, OFFICE), (err) => {
      assert.equal(err.code, 'SEND_FAILED');
      assert.equal(err.extra.providerCode, 'EMAIL_ATTACHMENT_INVALID');
      return true;
    });
  }
  assert.equal(calls.length, 0);
});

test("a request over ACS's 10 MB cap (base64 included) is refused before anything is sent", async () => {
  const calls = fakeAcs();
  assert.equal(acsConfig.ACS_MAX_REQUEST_BYTES, 10_000_000);
  const big = 'A'.repeat(acsConfig.ACS_MAX_REQUEST_BYTES);
  await assert.rejects(
    adapter.send({ ...MESSAGE, attachments: [{ name: 'big.png', contentType: 'image/png', contentInBase64: big }] }, OFFICE),
    (err) => {
      assert.equal(err.extra.providerCode, 'EMAIL_TOO_LARGE');
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test('ownFromAddressFor never falls back to the shared sender; fromAddressFor still does (patient email unchanged)', () => {
  delete process.env.ACS_EMAIL_FROM_ROLAND;
  process.env.ACS_EMAIL_FROM = 'shared@deployment.example.test';
  assert.equal(acsConfig.ownFromAddressFor('roland'), null);
  assert.equal(acsConfig.fromAddressFor('roland'), 'shared@deployment.example.test');
  process.env.ACS_EMAIL_FROM_ROLAND = 'Own@Roland.example.test';
  assert.equal(acsConfig.ownFromAddressFor('roland'), 'own@roland.example.test');
  assert.equal(acsConfig.ownFromAddressFor('unknown'), null);
});
