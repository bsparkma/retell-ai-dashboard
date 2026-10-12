'use strict';

/**
 * The ACS Email REST client (queue item 40), over a FAKE transport. No network.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const client = require('./client');
const { MessagingError } = require('../errors');

const ENDPOINT = 'https://acs-carein-test.communication.azure.com';
const KEY = Buffer.alloc(32, 9).toString('base64');

test.afterEach(() => client.resetForTests());

test('HMAC: the documented string-to-sign, keyed with the decoded access key', () => {
  const date = new Date('2026-10-08T17:00:00Z');
  const url = `${ENDPOINT}/emails:send?api-version=2023-03-31`;
  const body = '{"a":1}';
  const h = client.hmacHeaders({ method: 'post', url, body, accessKey: KEY, date });
  const hash = crypto.createHash('sha256').update(body).digest('base64');
  assert.equal(h['x-ms-date'], 'Thu, 08 Oct 2026 17:00:00 GMT');
  assert.equal(h['x-ms-content-sha256'], hash);
  const expected = crypto
    .createHmac('sha256', Buffer.from(KEY, 'base64'))
    .update(`POST\n/emails:send?api-version=2023-03-31\n${h['x-ms-date']};acs-carein-test.communication.azure.com;${hash}`)
    .digest('base64');
  assert.equal(
    h.Authorization,
    `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${expected}`
  );
});

test('sendEmail (connection string): one signed POST, Operation-Id set, 202 → accepted', async () => {
  const calls = [];
  client.setFetchForTests(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'op-1', status: 'Running' }), { status: 202 });
  });
  const r = await client.sendEmail({
    cfg: { mode: 'connection_string', endpoint: ENDPOINT, accessKey: KEY },
    operationId: '11111111-1111-4111-8111-111111111111',
    payload: { senderAddress: 'x@example.test' },
  });
  assert.deepEqual(r, { operationId: 'op-1', status: 'Running' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ENDPOINT}/emails:send?api-version=2023-03-31`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Operation-Id'], '11111111-1111-4111-8111-111111111111');
  assert.match(calls[0].init.headers.Authorization, /^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=/);
  assert.ok(calls[0].init.signal, 'every request has a timeout signal');
});

test('sendEmail (managed identity): Bearer token, never the HMAC header', async () => {
  client.setTokenProviderForTests(async () => 'fake-entra-token');
  let auth = null;
  client.setFetchForTests(async (_url, init) => {
    auth = init.headers.Authorization;
    return new Response('{}', { status: 202, headers: { 'operation-id': 'op-h' } });
  });
  const r = await client.sendEmail({
    cfg: { mode: 'managed_identity', endpoint: ENDPOINT, accessKey: null },
    operationId: 'm1',
    payload: {},
  });
  assert.equal(auth, 'Bearer fake-entra-token');
  assert.equal(r.operationId, 'op-h', 'operation id from the header when the body has none');
});

test('a token failure is an honest SEND_FAILED naming the mode', async () => {
  client.setTokenProviderForTests(async () => {
    throw new Error('no identity endpoint');
  });
  await assert.rejects(
    client.sendEmail({ cfg: { mode: 'managed_identity', endpoint: ENDPOINT, accessKey: null }, operationId: 'm', payload: {} }),
    (e) => e instanceof MessagingError && e.code === 'SEND_FAILED' && e.extra.providerCode === 'ACS_AUTH_FAILED' && /managed_identity/.test(e.message)
  );
});

test('a refusal carries ACS\'s code and NO email address', async () => {
  client.setFetchForTests(
    async () =>
      new Response(JSON.stringify({ error: { code: 'InvalidRecipient', message: 'Recipient patient.one@example.test is invalid' } }), {
        status: 400,
      })
  );
  await assert.rejects(
    client.sendEmail({ cfg: { mode: 'connection_string', endpoint: ENDPOINT, accessKey: KEY }, operationId: 'm', payload: {} }),
    (e) =>
      e.code === 'SEND_FAILED' &&
      e.extra.providerCode === 'ACS_InvalidRecipient' &&
      !/@/.test(e.message) &&
      /\[address\]/.test(e.message)
  );
});

test('timeouts and unreachable hosts are distinct codes', async () => {
  client.setFetchForTests(async () => {
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    throw e;
  });
  await assert.rejects(
    client.sendEmail({ cfg: { mode: 'connection_string', endpoint: ENDPOINT, accessKey: KEY }, operationId: 'm', payload: {} }),
    (e) => e.extra.providerCode === 'ACS_TIMEOUT'
  );
  client.setFetchForTests(async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(
    client.sendEmail({ cfg: { mode: 'connection_string', endpoint: ENDPOINT, accessKey: KEY }, operationId: 'm', payload: {} }),
    (e) => e.extra.providerCode === 'ACS_UNREACHABLE'
  );
});

test('getOperation: one GET of the operation, status and error read', async () => {
  const urls = [];
  client.setFetchForTests(async (url, init) => {
    urls.push([url, init.method]);
    return new Response(JSON.stringify({ id: 'op-1', status: 'Failed', error: { code: 'EmailDroppedAllRecipientsSuppressed', message: 'to a@b.test' } }), {
      status: 200,
    });
  });
  const r = await client.getOperation({ cfg: { mode: 'connection_string', endpoint: ENDPOINT, accessKey: KEY }, operationId: 'op-1' });
  assert.deepEqual(urls, [[`${ENDPOINT}/emails/operations/op-1?api-version=2023-03-31`, 'GET']]);
  assert.equal(r.status, 'Failed');
  assert.equal(r.errorCode, 'EmailDroppedAllRecipientsSuppressed');
  assert.ok(!/@/.test(r.errorMessage));
});
