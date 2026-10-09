'use strict';

/**
 * The ACS email adapter (queue item 40) over a FAKE ACS transport: per-office
 * readiness, the payload, and the honest status ladder (never "delivered").
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../../platform/registry');
const adapter = require('./emailAdapter');
const adapters = require('./index');
const client = require('../acs/client');
const tcEmail = require('../../../config/tcEmail');

const ENV = {
  TC_EMAIL_ENABLED: 'true',
  ACS_EMAIL_AUTH_MODE: 'managed_identity',
  ACS_EMAIL_ENDPOINT: 'https://acs-carein-test.communication.azure.com',
  ACS_EMAIL_FROM_ROLAND: 'donotreply@roland.example.test',
  TC_EMAIL_PUBLIC_BASE_URL: 'https://dashboard.example.test',
  TC_EMAIL_TENANT_SLUG: 'carein',
};
const KEYS = [...Object.keys(ENV), 'ACS_EMAIL_FROM', 'ACS_EMAIL_FROM_VALLEY', 'ACS_EMAIL_REPLY_TO_ROLAND'];
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const originalGet = registry.getPlatformSetting;

function setEnv(over = {}) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, ENV);
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test.beforeEach(() => {
  setEnv();
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
  messageId: '22222222-2222-4222-8222-222222222222',
  officeId: 'roland',
  caseId: null,
  channel: 'email',
  toAddress: 'patient.one@example.test',
  body: 'plain text',
  subject: 'Following up from Roland',
  templateId: null,
  html: '<!doctype html><p>hi</p>',
  unsubscribeUrl: 'https://dashboard.example.test/api/webhooks/email/unsubscribe?t=x',
};
const OFFICE = { officeKey: 'roland', officeName: 'Roland' };

/** A fake ACS: POST answers 202 + `first`; each GET answers the next of `polls`. */
function fakeAcs(first, polls = []) {
  const calls = [];
  client.setFetchForTests(async (url, init) => {
    assert.ok(String(url).startsWith('https://acs-carein-test.communication.azure.com/'), `unexpected URL ${url}`);
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'POST') return new Response(JSON.stringify({ id: 'op-1', status: first }), { status: 202 });
    const next = polls.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next || { id: 'op-1', status: 'Running' }), { status: 200 });
  });
  return calls;
}

test('readiness is per office and gives the closed reasons', () => {
  assert.equal(adapter.enabled(), true);
  assert.equal(adapter.enabledFor('roland'), true);
  assert.equal(adapter.enabledFor('valley'), false);
  assert.equal(adapters.channelUnavailableReason('email', 'valley'), 'office_not_configured');
  setEnv({ TC_EMAIL_ENABLED: undefined });
  assert.equal(adapters.channelUnavailableReason('email', 'roland'), 'switched_off', 'floor is OFF');
  setEnv({ ACS_EMAIL_ENDPOINT: undefined });
  assert.equal(adapters.channelUnavailableReason('email', 'roland'), 'not_configured');
  setEnv({ TC_EMAIL_PUBLIC_BASE_URL: undefined });
  assert.equal(adapters.channelUnavailableReason('email', 'roland'), 'not_configured', 'no unsubscribe link, no email');
  setEnv({ TC_EMAIL_TENANT_SLUG: undefined });
  assert.equal(adapters.channelUnavailableReason('email', 'roland'), 'not_configured');
  setEnv({ ACS_EMAIL_FROM: 'donotreply@shared.example.test' });
  assert.equal(adapter.enabledFor('valley'), true, 'the shared sender serves an office with none of its own');
});

test('send: the payload — one recipient, our sender, html + text, List-Unsubscribe, no tracking', async () => {
  setEnv({ ACS_EMAIL_REPLY_TO_ROLAND: 'front@roland.example.test' });
  const calls = fakeAcs('Running', [{ id: 'op-1', status: 'Succeeded' }]);
  const r = await adapter.send(MESSAGE, OFFICE);
  assert.deepEqual(r, { provider: 'acs', providerMessageId: 'op-1', status: 'sent', fromAddress: 'donotreply@roland.example.test' });
  const post = calls[0];
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['Operation-Id'], MESSAGE.messageId, 'our id: ACS cannot make it two emails');
  assert.equal(post.headers.Authorization, 'Bearer fake-token');
  assert.deepEqual(post.body.recipients, { to: [{ address: 'patient.one@example.test' }] });
  assert.equal(post.body.senderAddress, 'donotreply@roland.example.test');
  assert.deepEqual(post.body.content, { subject: MESSAGE.subject, plainText: 'plain text', html: MESSAGE.html });
  assert.deepEqual(post.body.replyTo, [{ address: 'front@roland.example.test' }]);
  assert.equal(post.body.headers['List-Unsubscribe'], `<${MESSAGE.unsubscribeUrl}>`);
  assert.equal(post.body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(post.body.userEngagementTrackingDisabled, true);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'never re-sent');
});

test('status ladder: Succeeded → sent, still Running → queued, a failed read → queued, Failed → throws', async () => {
  fakeAcs('Running', [{ status: 'Running' }, { status: 'Running' }, { status: 'Running' }]);
  assert.equal((await adapter.send(MESSAGE, OFFICE)).status, 'queued', 'bounded: three reads, then stop');

  const calls = fakeAcs('Running', [new TypeError('fetch failed')]);
  assert.equal((await adapter.send(MESSAGE, OFFICE)).status, 'queued', 'ACS accepted it; an unreadable status is not a failure');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);

  fakeAcs('Running', [{ status: 'NotStarted' }, { status: 'Failed', error: { code: 'EmailDroppedAllRecipientsSuppressed', message: 'x' } }]);
  await assert.rejects(adapter.send(MESSAGE, OFFICE), (e) => e.code === 'SEND_FAILED' && e.extra.providerCode === 'ACS_EmailDroppedAllRecipientsSuppressed');

  fakeAcs('Succeeded');
  assert.equal((await adapter.send(MESSAGE, OFFICE)).status, 'sent', 'already done in the 202: no reads needed');

  fakeAcs('Canceled');
  await assert.rejects(adapter.send(MESSAGE, OFFICE), (e) => e.code === 'SEND_FAILED');
});

test('the pauses are bounded and come from POLL_DELAYS_MS', async () => {
  const waits = [];
  client.setWaitForTests(async (ms) => {
    waits.push(ms);
  });
  fakeAcs('Running', [{ status: 'Running' }, { status: 'Running' }, { status: 'Running' }, { status: 'Succeeded' }]);
  const r = await adapter.send(MESSAGE, OFFICE);
  assert.deepEqual(waits, [...adapter.POLL_DELAYS_MS]);
  assert.equal(r.status, 'queued', 'a 4th read never happens');
});

test('send refuses an email without html, subject or unsubscribe link (nothing reaches ACS)', async () => {
  const calls = fakeAcs('Succeeded');
  for (const missing of ['html', 'unsubscribeUrl', 'subject']) {
    await assert.rejects(
      adapter.send({ ...MESSAGE, [missing]: null }, OFFICE),
      (e) => e.code === 'SEND_FAILED' && e.extra.providerCode === 'EMAIL_CONTENT_MISSING',
      missing
    );
  }
  assert.equal(calls.length, 0);
});

test('send re-reads the kill switch: a stored false stops this send', async () => {
  const calls = fakeAcs('Succeeded');
  registry.getPlatformSetting = async () => ({ key: 'tc_email_enabled', value: false });
  await assert.rejects(adapter.send(MESSAGE, OFFICE), (e) => e.code === 'FEATURE_DISABLED' && e.extra.reason === 'switched_off');
  assert.equal(calls.length, 0);
});

test('valley with no sender is refused inside send too (never borrows roland)', async () => {
  const calls = fakeAcs('Succeeded');
  await assert.rejects(
    adapter.send({ ...MESSAGE, officeId: 'valley' }, { officeKey: 'valley', officeName: 'Valley Fort Smith' }),
    (e) => e.code === 'FEATURE_DISABLED' && e.extra.reason === 'office_not_configured'
  );
  assert.equal(calls.length, 0);
});
