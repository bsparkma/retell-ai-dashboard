'use strict';

/**
 * Item 48: the provider switch (TC_SMS_PROVIDER), the ACS SMS config, and the
 * ACS SMS adapter — per-office senders with no fallback, fail-closed on an
 * unknown provider, and the Twilio adapter untouched and unselected under acs.
 * Fake transports only; no network.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const adapters = require('./index');
const acsAdapter = require('./acsSmsAdapter');
const twilioAdapter = require('./smsAdapter');
const tcSmsProvider = require('../../../config/tcSmsProvider');
const acsSms = require('../../../config/acsSms');
const tcSms = require('../../../config/tcSms');
const acsClient = require('../acs/smsClient');
const twilioClient = require('../twilio/client');
const { hmacHeaders } = require('../acs/client');

const ACCESS_KEY = Buffer.from('a-32-byte-test-key-not-a-real-1!').toString('base64');
const ENV = {
  TC_SMS_ENABLED: 'true',
  TC_SMS_PROVIDER: undefined,
  TC_SMS_ACS_AUTH_MODE: undefined,
  TC_SMS_ACS_ENDPOINT: 'https://carein-test.communication.azure.com',
  TC_SMS_ACS_CONNECTION: undefined,
  TC_SMS_ACS_FROM_ROLAND: '+14795550150',
  TC_SMS_ACS_FROM_VALLEY: undefined,
  TC_SMS_ACS_WEBHOOK_TOKEN: undefined,
  TC_SMS_ACS_TENANT_SLUG: undefined,
  // Twilio fully configured for both offices, to prove it is never consulted under acs.
  TWILIO_ACCOUNT_SID: 'ACtest0000',
  TWILIO_API_KEY_SID: 'SKtest0000',
  TWILIO_API_KEY_SECRET: 'not-a-real-secret',
  TWILIO_MESSAGING_SERVICE_SID: 'MGtest0000',
  TWILIO_WEBHOOK_BASE_URL: 'https://dashboard.example.test',
  TWILIO_FROM_ROLAND: '+14795550150',
  TWILIO_FROM_VALLEY: '+14795550160',
};
const SAVED = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));

function setEnv(over = {}) {
  for (const [k, v] of Object.entries({ ...ENV, ...over })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test.beforeEach(() => {
  setEnv();
  tcSms.resetCacheForTests();
});
test.afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  adapters.resetAdapters();
  acsClient.resetForTests();
  twilioClient.resetFetch();
  tcSms.resetCacheForTests();
});

const MESSAGE = {
  messageId: '33333333-3333-4333-8333-333333333333',
  officeId: 'roland',
  caseId: '11111111-1111-4111-8111-111111111111',
  channel: 'sms',
  toAddress: '+14795550101',
  body: 'Hi, this is the office following up on your recent visit.',
  subject: null,
  templateId: null,
};
const ROLAND = { officeKey: 'roland', officeName: 'Roland Family Dental' };
const VALLEY = { officeKey: 'valley', officeName: 'Valley Family Dental' };

function acceptAll(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return new Response(
      JSON.stringify({ value: [{ to: MESSAGE.toAddress, messageId: 'Outgoing_1', httpStatusCode: 202, successful: true }] }),
      { status: 202, headers: { 'Content-Type': 'application/json' } }
    );
  };
}

// ── the provider switch ─────────────────────────────────────────────────────

test('TC_SMS_PROVIDER: unset/blank → acs (the default); acs/twilio as named (case-insensitive)', () => {
  for (const v of [undefined, '', '   ']) {
    setEnv({ TC_SMS_PROVIDER: v });
    assert.equal(tcSmsProvider.smsProvider(), 'acs', JSON.stringify(v));
  }
  setEnv({ TC_SMS_PROVIDER: ' ACS ' });
  assert.equal(tcSmsProvider.smsProvider(), 'acs');
  setEnv({ TC_SMS_PROVIDER: 'Twilio' });
  assert.equal(tcSmsProvider.smsProvider(), 'twilio');
});

test('TC_SMS_PROVIDER: an unknown value names NO provider — never the default, never the closest match', () => {
  for (const v of ['acss', 'twillio', 'azure', 'none', 'acs,twilio', 'true']) {
    setEnv({ TC_SMS_PROVIDER: v });
    assert.equal(tcSmsProvider.smsProvider(), null, v);
    assert.equal(tcSmsProvider.state().invalidValue, v);
  }
});

test('selection: default → the ACS adapter; twilio → the Twilio adapter; exactly one per call', () => {
  setEnv({ TC_SMS_PROVIDER: undefined });
  assert.equal(adapters.getAdapter('sms'), acsAdapter);
  assert.equal(adapters.getAdapter('sms').provider, 'acs');
  setEnv({ TC_SMS_PROVIDER: 'twilio' });
  assert.equal(adapters.getAdapter('sms'), twilioAdapter);
  assert.equal(adapters.getAdapter('sms').provider, 'twilio');
  // email is unaffected by the SMS switch
  assert.equal(adapters.getAdapter('email').channel, 'email');
});

test('selection: an UNKNOWN provider fails closed — not connected for any office, honest reason, send refuses', async () => {
  setEnv({ TC_SMS_PROVIDER: 'twillio' });
  const a = adapters.getAdapter('sms');
  assert.equal(a, adapters.UNSELECTED_SMS_ADAPTER);
  assert.equal(a.provider, null);
  for (const office of ['roland', 'valley']) {
    assert.equal(adapters.isChannelEnabled('sms', office), false, office);
    assert.equal(adapters.channelUnavailableReason('sms', office), 'not_configured');
  }
  const acsCalls = [];
  const twilioCalls = [];
  acsClient.setFetchForTests(acceptAll(acsCalls));
  twilioClient.setFetchForTests(async (u) => {
    twilioCalls.push(u);
    throw new Error('never');
  });
  await assert.rejects(a.send(MESSAGE, ROLAND), (err) => {
    assert.equal(err.code, 'FEATURE_DISABLED');
    assert.match(err.message, /TC_SMS_PROVIDER names no texting provider/);
    return true;
  });
  assert.equal(acsCalls.length + twilioCalls.length, 0, 'neither provider was asked');
});

test('Twilio adapter is untouched and UNSELECTED under acs: never handed out, never called, even fully configured', async () => {
  setEnv({ TC_SMS_PROVIDER: 'acs' });
  // Twilio, asked directly, still says it is connected (its own config is intact)…
  assert.equal(twilioAdapter.provider, 'twilio');
  assert.equal(twilioAdapter.enabledFor('valley'), true);
  // …but it is not what the registry hands out, so valley (no ACS number) is OFF
  // and never "falls back" to Twilio's valley number.
  assert.notEqual(adapters.getAdapter('sms'), twilioAdapter);
  assert.equal(adapters.isChannelEnabled('sms', 'valley'), false);
  assert.equal(adapters.channelUnavailableReason('sms', 'valley'), 'office_not_configured');

  const twilioCalls = [];
  twilioClient.setFetchForTests(async (u) => {
    twilioCalls.push(u);
    throw new Error('Twilio must never be called under acs');
  });
  const acsCalls = [];
  acsClient.setTokenProviderForTests(async () => 'tok');
  acsClient.setFetchForTests(acceptAll(acsCalls));
  const r = await adapters.getAdapter('sms').send(MESSAGE, ROLAND);
  assert.equal(r.provider, 'acs');
  assert.equal(acsCalls.length, 1);
  assert.equal(twilioCalls.length, 0);
});

// ── ACS config ──────────────────────────────────────────────────────────────

test('ACS senders are per office with NO fallback and NO shared sender; non-E.164 is missing', () => {
  setEnv({ TC_SMS_ACS_FROM_VALLEY: undefined });
  assert.equal(acsSms.fromNumberFor('roland'), '+14795550150');
  assert.equal(acsSms.fromNumberFor('valley'), null, 'valley never borrows roland’s number');
  assert.equal(acsSms.fromNumberFor('unknown'), null);
  assert.equal(acsSms.fromNumberFor('nowhere'), null);
  for (const bad of ['4795550160', '(479) 555-0160', '+0479555016', 'tel:+14795550160']) {
    setEnv({ TC_SMS_ACS_FROM_VALLEY: bad });
    assert.equal(acsSms.fromNumberFor('valley'), null, bad);
  }
  assert.deepEqual(acsSms.missingFor('valley'), ['TC_SMS_ACS_FROM_VALLEY']);
  assert.deepEqual(acsSms.missingFor('roland'), []);
});

test('officeForReceivingNumber: with or without +, 10 or 11 digits; unknown → null; two offices claiming one number → null', () => {
  setEnv({ TC_SMS_ACS_FROM_VALLEY: '+14795550160' });
  assert.equal(acsSms.officeForReceivingNumber('+14795550150'), 'roland');
  assert.equal(acsSms.officeForReceivingNumber('14795550150'), 'roland');
  assert.equal(acsSms.officeForReceivingNumber('4795550160'), 'valley');
  assert.equal(acsSms.officeForReceivingNumber('+14795550199'), null);
  assert.equal(acsSms.officeForReceivingNumber(''), null);
  assert.equal(acsSms.officeForReceivingNumber(null), null);
  setEnv({ TC_SMS_ACS_FROM_VALLEY: '+14795550150' }); // misconfigured: both offices claim it
  assert.equal(acsSms.officeForReceivingNumber('+14795550150'), null, 'ambiguity is a refusal, not a pick');
});

test('auth modes: managed_identity needs the endpoint; connection_string needs a parseable string; a typo is no mode', () => {
  setEnv({ TC_SMS_ACS_ENDPOINT: undefined });
  assert.deepEqual(acsSms.missingAccountConfig(), ['TC_SMS_ACS_ENDPOINT']);
  setEnv({ TC_SMS_ACS_ENDPOINT: 'http://insecure.example.test' });
  assert.deepEqual(acsSms.missingAccountConfig(), ['TC_SMS_ACS_ENDPOINT'], 'https only');
  setEnv({ TC_SMS_ACS_AUTH_MODE: 'connection_string', TC_SMS_ACS_ENDPOINT: undefined });
  assert.deepEqual(acsSms.missingAccountConfig(), ['TC_SMS_ACS_CONNECTION']);
  setEnv({
    TC_SMS_ACS_AUTH_MODE: 'connection_string',
    TC_SMS_ACS_CONNECTION: `endpoint=https://carein-test.communication.azure.com/;accesskey=${ACCESS_KEY}`,
  });
  assert.deepEqual(acsSms.missingAccountConfig(), []);
  assert.equal(acsSms.accountConfig().endpoint, 'https://carein-test.communication.azure.com');
  setEnv({ TC_SMS_ACS_AUTH_MODE: 'api_key' });
  assert.deepEqual(acsSms.missingAccountConfig(), ['TC_SMS_ACS_AUTH_MODE']);
  // SMS never reads the EMAIL variables.
  setEnv({ TC_SMS_ACS_ENDPOINT: undefined });
  process.env.ACS_EMAIL_ENDPOINT = 'https://carein-test.communication.azure.com';
  try {
    assert.equal(acsSms.accountConfigured(), false);
  } finally {
    delete process.env.ACS_EMAIL_ENDPOINT;
  }
});

test('webhook token: unset or shorter than 32 characters is no token', () => {
  setEnv({ TC_SMS_ACS_WEBHOOK_TOKEN: undefined });
  assert.equal(acsSms.webhookToken(), null);
  setEnv({ TC_SMS_ACS_WEBHOOK_TOKEN: 'x'.repeat(31) });
  assert.equal(acsSms.webhookToken(), null);
  setEnv({ TC_SMS_ACS_WEBHOOK_TOKEN: 'x'.repeat(32) });
  assert.equal(acsSms.webhookToken(), 'x'.repeat(32));
});

// ── the adapter ─────────────────────────────────────────────────────────────

test('readiness: switched off → switched_off; no account → not_configured; no office number → office_not_configured', () => {
  setEnv({ TC_SMS_ENABLED: 'false' });
  assert.equal(acsAdapter.unavailableReason('roland'), 'switched_off');
  setEnv({ TC_SMS_ACS_ENDPOINT: undefined });
  assert.equal(acsAdapter.unavailableReason('roland'), 'not_configured');
  setEnv();
  assert.equal(acsAdapter.unavailableReason('valley'), 'office_not_configured');
  assert.equal(acsAdapter.enabledFor('roland'), true);
  assert.equal(acsAdapter.enabledFor('valley'), false);
});

test('send: re-checks per office at send time and names the missing sender; ACS is never called', async () => {
  const calls = [];
  acsClient.setFetchForTests(acceptAll(calls));
  await assert.rejects(acsAdapter.send({ ...MESSAGE, officeId: 'valley' }, VALLEY), (err) => {
    assert.equal(err.code, 'FEATURE_DISABLED');
    assert.match(err.message, /No ACS sender is configured for this office \(TC_SMS_ACS_FROM_VALLEY\)/);
    assert.deepEqual(err.extra.missing, ['TC_SMS_ACS_FROM_VALLEY']);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('send: 202 + successful → queued with ACS’s id (never sent/delivered); request shape and MI bearer', async () => {
  const calls = [];
  acsClient.setTokenProviderForTests(async () => 'fake-entra-token');
  acsClient.setFetchForTests(acceptAll(calls));
  const r = await acsAdapter.send(MESSAGE, ROLAND);
  assert.deepEqual(r, { provider: 'acs', providerMessageId: 'Outgoing_1', status: 'queued', fromAddress: '+14795550150' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://carein-test.communication.azure.com/sms?api-version=2021-03-07');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fake-entra-token');
  assert.deepEqual(calls[0].body.smsSendOptions, { enableDeliveryReport: true, tag: 'roland' });
  assert.equal(calls[0].body.message, MESSAGE.body);
  assert.equal(calls[0].body.smsRecipients[0].repeatabilityRequestId, MESSAGE.messageId);
  assert.match(calls[0].body.smsRecipients[0].repeatabilityFirstSent, /GMT$/);
});

test('send (connection_string): signed with the SAME HMAC signer as ACS email', async () => {
  setEnv({
    TC_SMS_ACS_AUTH_MODE: 'connection_string',
    TC_SMS_ACS_ENDPOINT: undefined,
    TC_SMS_ACS_CONNECTION: `endpoint=https://carein-test.communication.azure.com;accesskey=${ACCESS_KEY}`,
  });
  const calls = [];
  acsClient.setFetchForTests(acceptAll(calls));
  await acsAdapter.send(MESSAGE, ROLAND);
  const h = calls[0].init.headers;
  const body = String(calls[0].init.body);
  const expected = hmacHeaders({
    method: 'POST',
    url: calls[0].url,
    body,
    accessKey: ACCESS_KEY,
    date: new Date(h['x-ms-date']),
  });
  assert.equal(h['x-ms-content-sha256'], crypto.createHash('sha256').update(body, 'utf8').digest('base64'));
  assert.equal(h.Authorization, expected.Authorization);
  assert.match(h.Authorization, /^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=/);
});

test('send: a non-202, a refused recipient, an empty result, a timeout → all throw SEND_FAILED; no number in the text', async () => {
  acsClient.setTokenProviderForTests(async () => 'tok');
  const scenarios = [
    [
      new Response(JSON.stringify({ error: { code: 'Unauthorized', message: 'Denied for +14795550150' } }), { status: 401 }),
      'ACS_Unauthorized',
    ],
    [
      new Response(
        JSON.stringify({ value: [{ to: MESSAGE.toAddress, httpStatusCode: 400, successful: false, errorMessage: 'Bad To 14795550101' }] }),
        { status: 202 }
      ),
      'ACS_RECIPIENT_400',
    ],
    [new Response(JSON.stringify({ value: [] }), { status: 202 }), 'ACS_BAD_RESPONSE'],
    [
      new Response(JSON.stringify({ value: [{ to: MESSAGE.toAddress, httpStatusCode: 202, successful: true }] }), { status: 202 }),
      'ACS_RECIPIENT_202',
    ],
  ];
  for (const [response, providerCode] of scenarios) {
    acsClient.setFetchForTests(async () => response);
    await assert.rejects(acsAdapter.send(MESSAGE, ROLAND), (err) => {
      assert.equal(err.code, 'SEND_FAILED');
      assert.equal(err.extra.providerCode, providerCode);
      assert.doesNotMatch(err.message, /555/);
      return true;
    });
  }
  acsClient.setFetchForTests(async () => {
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    throw e;
  });
  await assert.rejects(acsAdapter.send(MESSAGE, ROLAND), (err) => err.extra.providerCode === 'ACS_TIMEOUT');
});

test('send: a managed-identity token failure is SEND_FAILED naming the mode (never a silent key fallback)', async () => {
  acsClient.setTokenProviderForTests(async () => {
    throw new Error('no identity');
  });
  const calls = [];
  acsClient.setFetchForTests(acceptAll(calls));
  await assert.rejects(acsAdapter.send(MESSAGE, ROLAND), (err) => {
    assert.equal(err.extra.providerCode, 'ACS_AUTH_FAILED');
    assert.match(err.message, /managed_identity/);
    return true;
  });
  assert.equal(calls.length, 0);
});
