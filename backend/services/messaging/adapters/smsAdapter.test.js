'use strict';

/**
 * The Twilio SMS adapter against a FAKE transport (queue item 39). Nothing in
 * this file reaches the network: client.setFetchForTests replaces fetch, and a
 * request to anywhere else fails the test.
 *
 * Phones are fictional 555-01xx numbers.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../../platform/registry');
const tcSms = require('../../../config/tcSms');
const client = require('../twilio/client');
const adapters = require('./index');
const sms = require('./smsAdapter');

const ENV = {
  TC_SMS_ENABLED: 'true',
  TWILIO_ACCOUNT_SID: 'ACtest0000',
  TWILIO_API_KEY_SID: 'SKtest0000',
  TWILIO_API_KEY_SECRET: 'not-a-real-secret',
  TWILIO_MESSAGING_SERVICE_SID: 'MGtest0000',
  TWILIO_WEBHOOK_BASE_URL: 'https://dashboard.example.test',
  TWILIO_FROM_ROLAND: '+14795550150',
};
const ALL_KEYS = [...Object.keys(ENV), 'TWILIO_FROM_VALLEY'];
const saved = Object.fromEntries(ALL_KEYS.map((k) => [k, process.env[k]]));
const originalGet = registry.getPlatformSetting;

function configure(overrides = {}) {
  for (const k of ALL_KEYS) delete process.env[k];
  Object.assign(process.env, ENV, overrides);
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete process.env[k];
  // No stored row: the env fallback answers. Never the real control DB.
  registry.getPlatformSetting = async () => null;
  tcSms.resetCacheForTests();
}

test.afterEach(() => {
  for (const k of ALL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  registry.getPlatformSetting = originalGet;
  tcSms.resetCacheForTests();
  client.resetFetch();
});

/** A fake Twilio that records each request and answers with `reply`. */
function fakeTwilio(reply) {
  const calls = [];
  client.setFetchForTests(async (url, init) => {
    assert.ok(String(url).startsWith('https://api.twilio.com/2010-04-01/Accounts/'), `unexpected URL ${url}`);
    calls.push({ url: String(url), init, form: new URLSearchParams(String(init.body)) });
    const r = typeof reply === 'function' ? reply() : reply;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 201, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}

const MESSAGE = {
  messageId: '00000000-0000-4000-8000-000000000001',
  officeId: 'roland',
  caseId: null,
  channel: 'sms',
  toAddress: '+14795550101',
  body: 'Hi MangoTest, following up from Roland.',
  subject: null,
  templateId: null,
};
const ROLAND = { officeKey: 'roland', officeName: 'Roland' };
const VALLEY = { officeKey: 'valley', officeName: 'Valley Fort Smith' };

test('fully configured for roland: enabled, enabledFor(roland) true, enabledFor(valley) FALSE', () => {
  configure();
  assert.equal(sms.enabled(), true);
  assert.equal(sms.enabledFor('roland'), true);
  assert.equal(sms.enabledFor('valley'), false);
  assert.equal(sms.unavailableReason('valley'), 'office_not_configured');
  assert.equal(adapters.isChannelEnabled('sms', 'valley'), false);
  assert.equal(adapters.channelUnavailableReason('sms', 'valley'), 'office_not_configured');
  assert.equal(adapters.channelUnavailableReason('sms', 'roland'), null);
});

test('kill switch off → switched_off everywhere, even fully configured', () => {
  configure({ TC_SMS_ENABLED: 'false' });
  assert.equal(sms.enabled(), false);
  assert.equal(sms.unavailableReason('roland'), 'switched_off');
  assert.equal(adapters.channelUnavailableReason('sms', 'roland'), 'switched_off');
});

test('kill switch floor: TC_SMS_ENABLED unset and no row → OFF', () => {
  configure({ TC_SMS_ENABLED: undefined });
  assert.equal(sms.enabled(), false);
});

test('account incomplete → not_configured', () => {
  configure({ TWILIO_API_KEY_SECRET: undefined });
  assert.equal(sms.unavailableReason('roland'), 'not_configured');
});

test('send: one POST with the office From, the Messaging Service, the status callback, Basic auth; resolves on confirmation', async () => {
  configure();
  const calls = fakeTwilio({ body: { sid: 'SMfake0001', status: 'accepted' } });
  const r = await sms.send(MESSAGE, ROLAND);
  assert.deepEqual(r, { provider: 'twilio', providerMessageId: 'SMfake0001', status: 'queued', fromAddress: '+14795550150' });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, 'https://api.twilio.com/2010-04-01/Accounts/ACtest0000/Messages.json');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'Basic ' + Buffer.from('SKtest0000:not-a-real-secret').toString('base64'));
  assert.equal(c.form.get('To'), '+14795550101');
  assert.equal(c.form.get('From'), '+14795550150');
  assert.equal(c.form.get('MessagingServiceSid'), 'MGtest0000');
  assert.equal(c.form.get('Body'), MESSAGE.body);
  assert.equal(c.form.get('StatusCallback'), 'https://dashboard.example.test/api/webhooks/twilio/status/roland');
  assert.deepEqual([...c.form.keys()].sort(), ['Body', 'From', 'MessagingServiceSid', 'StatusCallback', 'To']);
});

test('send for an office with no sender throws FEATURE_DISABLED and never calls Twilio', async () => {
  configure();
  const calls = fakeTwilio({ body: { sid: 'SMx', status: 'queued' } });
  await assert.rejects(() => sms.send({ ...MESSAGE, officeId: 'valley' }, VALLEY), (e) => e.code === 'FEATURE_DISABLED');
  assert.equal(calls.length, 0);
});

test('send re-reads the kill switch first: a row written since the last refresh stops THIS send', async () => {
  configure();
  assert.equal(sms.enabledFor('roland'), true);
  registry.getPlatformSetting = async (key) => ({ key, value: false, updated_at: new Date(), updated_by: 'beau@carein.ai' });
  const calls = fakeTwilio({ body: { sid: 'SMx', status: 'queued' } });
  await assert.rejects(() => sms.send(MESSAGE, ROLAND), (e) => e.code === 'FEATURE_DISABLED' && /switched off/.test(e.message));
  assert.equal(calls.length, 0);
});

test('Twilio refusal → SEND_FAILED with the code, and no phone number survives into the text', async () => {
  configure();
  fakeTwilio({
    status: 400,
    body: { code: 21211, message: "The 'To' number +14795550101 is not a valid phone number.", status: 400 },
  });
  await assert.rejects(
    () => sms.send(MESSAGE, ROLAND),
    (e) => {
      assert.equal(e.code, 'SEND_FAILED');
      assert.equal(e.extra.providerCode, 'TWILIO_21211');
      assert.match(e.message, /error 21211/);
      assert.doesNotMatch(e.message, /555|4795550101/);
      assert.doesNotMatch(e.message, /following up/, 'never the body');
      return true;
    }
  );
});

test('an answer without a sid, or with a non-hand-off status, is not a send', async () => {
  configure();
  fakeTwilio({ body: { status: 'queued' } });
  await assert.rejects(() => sms.send(MESSAGE, ROLAND), (e) => e.extra.providerCode === 'TWILIO_BAD_RESPONSE');
  fakeTwilio({ body: { sid: 'SMx', status: 'failed' } });
  await assert.rejects(() => sms.send(MESSAGE, ROLAND), (e) => e.extra.providerCode === 'TWILIO_UNEXPECTED_STATUS');
});

test('transport failure / timeout → SEND_FAILED, honest about not knowing', async () => {
  configure();
  client.setFetchForTests(async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  });
  await assert.rejects(() => sms.send(MESSAGE, ROLAND), (e) => e.extra.providerCode === 'TWILIO_TIMEOUT' && /may or may not/.test(e.message));
  client.setFetchForTests(async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(() => sms.send(MESSAGE, ROLAND), (e) => e.extra.providerCode === 'TWILIO_UNREACHABLE');
});

test('scrubNumbers removes phone-shaped runs', () => {
  assert.equal(client.scrubNumbers('To +1 (479) 555-0101 bad'), 'To [number] bad');
  assert.equal(client.scrubNumbers('code 21211'), 'code 21211');
});
