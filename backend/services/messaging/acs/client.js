'use strict';

/**
 * A minimal Azure Communication Services Email REST client (queue item 40):
 * TWO calls, "send an email" and "read that send's operation status".
 *
 *   POST {endpoint}/emails:send?api-version=2023-03-31            -> 202 + Operation-Location
 *   GET  {endpoint}/emails/operations/{operationId}?api-version=2023-03-31
 *
 * Deliberately not `@azure/communication-email`: two requests do not justify a
 * new dependency on a PHI path, every byte sent is visible below, and
 * package.json / the lockfile stay unchanged. `@azure/identity` (already a
 * dependency) supplies the managed-identity token.
 *
 * AUTH (config/acsEmail.js picks exactly one):
 *   managed_identity   Authorization: Bearer <Entra token, scope
 *                      https://communication.azure.com/.default>
 *   connection_string  ACS HMAC-SHA256 request signing:
 *                        x-ms-date, x-ms-content-sha256 = base64(sha256(body)),
 *                        StringToSign = METHOD \n path?query \n date;host;contentHash
 *                        Authorization: HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=<base64 HMAC>
 *                      keyed with the base64-decoded access key.
 *
 * Idempotency: the send carries `Operation-Id: <our tc_messages id>`, so the
 * same message id can never become two emails at ACS even if a request is
 * repeated. This client still sends it ONCE: no retry (the messaging service
 * never retries a send; see adapters/index.js).
 *
 * WAITING: `waitMs` is the ONE place in services/messaging that waits. It is
 * an awaited pause INSIDE the human's Send request, between two status READS
 * of a send that already happened. It cannot start a send, it never outlives
 * the request, and nothing here schedules anything
 * (messagingGuards.test.js pins exactly this, and only this, file).
 *
 * Every timeout is AbortSignal.timeout. The transport, the token and the wait
 * are injectable, so nothing in CI reaches the network or sleeps.
 *
 * PHI: the address, subject and body travel in the request and are never
 * logged. Errors carry ACS's error code and a scrubbed message: no email
 * address survives into the text.
 */

const crypto = require('node:crypto');
const timers = require('node:timers/promises');

const { MessagingError } = require('../errors');
const acsConfig = require('../../../config/acsEmail');

const API_VERSION = '2023-03-31';
const TIMEOUT_MS = 10_000;

/** @type {typeof fetch} */
let fetchImpl = (...args) => fetch(...args);
/** @type {(() => Promise<string>) | null} */
let tokenProviderOverride = null;
/** The real pause: an awaited promise, never a callback timer. @param {number} ms */
async function defaultWait(ms) {
  await timers.setTimeout(ms);
}
/** @type {(ms: number) => Promise<void>} */
let waitImpl = defaultWait;

/** TESTS ONLY: swap the transport. */
function setFetchForTests(fn) {
  fetchImpl = fn;
}
/** TESTS ONLY: swap the managed-identity token source. */
function setTokenProviderForTests(fn) {
  tokenProviderOverride = fn;
}
/** TESTS ONLY: make the between-polls pause instant (or observable). */
function setWaitForTests(fn) {
  waitImpl = fn;
}
/** TESTS ONLY. */
function resetForTests() {
  fetchImpl = (...args) => fetch(...args);
  tokenProviderOverride = null;
  waitImpl = defaultWait;
  tokenProvider = null;
  tokenProviderKey = null;
}

/** Pause between two status reads. See WAITING in the header. */
function waitMs(ms) {
  return waitImpl(ms);
}

/**
 * Remove anything shaped like an email address from provider text before it
 * is stored or shown.
 * @param {unknown} text
 * @returns {string}
 */
function scrubAddresses(text) {
  return String(text ?? '')
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+/g, '[address]')
    .slice(0, 500);
}

// ── auth ────────────────────────────────────────────────────────────────────

/** @type {(() => Promise<string>) | null} */
let tokenProvider = null;
/** @type {string|null} */
let tokenProviderKey = null;

async function bearerToken() {
  if (tokenProviderOverride) return tokenProviderOverride();
  const clientId = process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID || '';
  if (!tokenProvider || tokenProviderKey !== clientId) {
    const identity = require('@azure/identity');
    const credential = new identity.ManagedIdentityCredential(clientId ? { clientId } : {});
    const get = identity.getBearerTokenProvider(credential, acsConfig.ACS_SCOPE);
    tokenProvider = () => get();
    tokenProviderKey = clientId;
  }
  return tokenProvider();
}

/**
 * The ACS HMAC headers for one request. Exported for the signing test.
 * @param {{ method: string, url: string, body: string, accessKey: string, date?: Date }} input
 * @returns {Record<string, string>}
 */
function hmacHeaders({ method, url, body, accessKey, date = new Date() }) {
  const u = new URL(url);
  const pathAndQuery = u.pathname + u.search;
  const xmsDate = date.toUTCString();
  const contentHash = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
  const stringToSign = `${method.toUpperCase()}\n${pathAndQuery}\n${xmsDate};${u.host};${contentHash}`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(accessKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');
  return {
    'x-ms-date': xmsDate,
    'x-ms-content-sha256': contentHash,
    Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
  };
}

/**
 * @param {{ mode: 'managed_identity'|'connection_string', accessKey: string|null }} cfg
 * @param {string} method
 * @param {string} url
 * @param {string} body
 * @returns {Promise<Record<string, string>>}
 */
async function authHeaders(cfg, method, url, body) {
  if (cfg.mode === 'connection_string') {
    if (!cfg.accessKey) {
      throw new MessagingError('FEATURE_DISABLED', 'Email sending is not connected yet. Nothing was sent.', {
        feature: 'tc_email_send',
      });
    }
    return hmacHeaders({ method, url, body, accessKey: cfg.accessKey });
  }
  let token;
  try {
    token = await bearerToken();
  } catch (err) {
    throw new MessagingError(
      'SEND_FAILED',
      `Could not get an Azure sign-in token for email (managed_identity): ${scrubAddresses(err && err.message ? err.message : err)}`,
      { providerCode: 'ACS_AUTH_FAILED' }
    );
  }
  return { Authorization: `Bearer ${token}` };
}

// ── the two calls ───────────────────────────────────────────────────────────

/**
 * Read an ACS error body into a code + scrubbed sentence.
 * @param {Response} res
 */
async function errorOf(res) {
  /** @type {unknown} */
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const err = json && typeof json === 'object' ? /** @type {Record<string, unknown>} */ (json).error : null;
  const e = err && typeof err === 'object' ? /** @type {Record<string, unknown>} */ (err) : {};
  const code = typeof e.code === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(e.code) ? e.code : `HTTP_${res.status}`;
  const message = typeof e.message === 'string' ? scrubAddresses(e.message) : `HTTP ${res.status}`;
  return { code, message };
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {string} what   'send' | 'status' (for the error sentence)
 */
async function request(url, init, what) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new MessagingError(
      'SEND_FAILED',
      timedOut
        ? `The email service did not answer the ${what} request in time.`
        : `The email service could not be reached for the ${what} request.`,
      { providerCode: timedOut ? 'ACS_TIMEOUT' : 'ACS_UNREACHABLE' }
    );
  }
}

/**
 * Send ONE email. Resolves only on ACS's 202 (accepted).
 * @param {{ cfg: { mode: 'managed_identity'|'connection_string', endpoint: string, accessKey: string|null },
 *           operationId: string, payload: Record<string, unknown> }} input
 * @returns {Promise<{ operationId: string, status: string }>}
 */
async function sendEmail({ cfg, operationId, payload }) {
  const url = `${cfg.endpoint}/emails:send?api-version=${API_VERSION}`;
  const body = JSON.stringify(payload);
  const auth = await authHeaders(cfg, 'POST', url, body);
  const res = await request(
    url,
    {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Operation-Id': operationId,
      },
      body,
    },
    'send'
  );
  if (res.status !== 202) {
    const { code, message } = await errorOf(res);
    throw new MessagingError('SEND_FAILED', `The email service refused the email (${code}): ${message}`, {
      providerCode: `ACS_${code}`,
    });
  }
  /** @type {unknown} */
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const o = json && typeof json === 'object' ? /** @type {Record<string, unknown>} */ (json) : {};
  const id =
    (typeof o.id === 'string' && o.id) || res.headers.get('operation-id') || operationId;
  const status = typeof o.status === 'string' ? o.status : 'Running';
  return { operationId: id, status };
}

/**
 * Read the send's operation status ONCE.
 * @param {{ cfg: { mode: 'managed_identity'|'connection_string', endpoint: string, accessKey: string|null },
 *           operationId: string }} input
 * @returns {Promise<{ status: string, errorCode: string|null, errorMessage: string|null, retryAfterMs: number|null }>}
 */
async function getOperation({ cfg, operationId }) {
  const url = `${cfg.endpoint}/emails/operations/${encodeURIComponent(operationId)}?api-version=${API_VERSION}`;
  const auth = await authHeaders(cfg, 'GET', url, '');
  const res = await request(url, { method: 'GET', headers: { ...auth, Accept: 'application/json' } }, 'status');
  if (res.status !== 200) {
    const { code, message } = await errorOf(res);
    throw new MessagingError('SEND_FAILED', `The email service could not report the send (${code}): ${message}`, {
      providerCode: `ACS_${code}`,
    });
  }
  /** @type {unknown} */
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const o = json && typeof json === 'object' ? /** @type {Record<string, unknown>} */ (json) : {};
  const e = o.error && typeof o.error === 'object' ? /** @type {Record<string, unknown>} */ (o.error) : null;
  const retryAfter = Number(res.headers.get('retry-after'));
  return {
    status: typeof o.status === 'string' ? o.status : 'Unknown',
    errorCode: e && typeof e.code === 'string' ? e.code.slice(0, 60) : null,
    errorMessage: e && typeof e.message === 'string' ? scrubAddresses(e.message) : null,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
  };
}

module.exports = {
  API_VERSION,
  sendEmail,
  getOperation,
  hmacHeaders,
  scrubAddresses,
  waitMs,
  setFetchForTests,
  setTokenProviderForTests,
  setWaitForTests,
  resetForTests,
};
