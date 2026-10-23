'use strict';

/**
 * A minimal Azure Communication Services SMS REST client (queue item 48): ONE
 * call, "send this text to this one number".
 *
 *   POST {endpoint}/sms?api-version=2021-03-07                      -> 202
 *     { from, smsRecipients: [{ to, repeatabilityRequestId, repeatabilityFirstSent }],
 *       message, smsSendOptions: { enableDeliveryReport: true, tag } }
 *   <- { value: [{ to, messageId, httpStatusCode, repeatabilityResult, successful, errorMessage }] }
 *
 * Deliberately not `@azure/communication-sms`, for the reasons
 * ./client.js gives for email: one request does not justify a new dependency
 * on a PHI path, and every byte sent is visible below.
 *
 * AUTH — the SAME mechanism as ACS email (#231), not a copy of it:
 *   connection_string  ./client.js `hmacHeaders` (the one ACS HMAC-SHA256
 *                      signer in this codebase) keyed with the access key.
 *   managed_identity   the same ManagedIdentityCredential shape and the same
 *                      scope (config/acsEmail.js ACS_SCOPE) as email's
 *                      bearerToken. Kept as its own small function so the two
 *                      channels' test seams do not share state.
 *
 * A 202 IS NOT DELIVERY. ACS answers 202 for the whole request and gives a
 * per-recipient verdict inside it. `successful: true` means ACS QUEUED the
 * text; the carrier outcome arrives later as an Event Grid delivery report.
 * A recipient that is not `successful` is a refusal, whatever the outer 202.
 *
 * Repeatability: the recipient carries `repeatabilityRequestId` = our
 * tc_messages id, so the same message id can never become two texts at ACS
 * even if a request were repeated. This client still sends ONCE — no retry
 * (the messaging service never retries a send; see adapters/index.js).
 *
 * PHI: both numbers and the body travel in the request and are never logged.
 * Errors carry ACS's code and a message with digit runs removed.
 */

const { MessagingError } = require('../errors');
const acsEmail = require('../../../config/acsEmail');
const { hmacHeaders } = require('./client');

const API_VERSION = '2021-03-07';
const TIMEOUT_MS = 10_000;

/** @type {typeof fetch} */
let fetchImpl = (...args) => fetch(...args);
/** @type {(() => Promise<string>) | null} */
let tokenProviderOverride = null;
/** @type {(() => Promise<string>) | null} */
let tokenProvider = null;
/** @type {string|null} */
let tokenProviderKey = null;

/** TESTS ONLY: swap the transport. */
function setFetchForTests(fn) {
  fetchImpl = fn;
}
/** TESTS ONLY: swap the managed-identity token source. */
function setTokenProviderForTests(fn) {
  tokenProviderOverride = fn;
}
/** TESTS ONLY. */
function resetForTests() {
  fetchImpl = (...args) => fetch(...args);
  tokenProviderOverride = null;
  tokenProvider = null;
  tokenProviderKey = null;
}

/**
 * Remove phone-number-shaped digit runs (and email addresses) from provider
 * text before it is stored or shown.
 * @param {unknown} text
 * @returns {string}
 */
function scrubNumbers(text) {
  return String(text ?? '')
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+/g, '[address]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .slice(0, 500);
}

async function bearerToken() {
  if (tokenProviderOverride) return tokenProviderOverride();
  const clientId = process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID || '';
  if (!tokenProvider || tokenProviderKey !== clientId) {
    const identity = require('@azure/identity');
    const credential = new identity.ManagedIdentityCredential(clientId ? { clientId } : {});
    const get = identity.getBearerTokenProvider(credential, acsEmail.ACS_SCOPE);
    tokenProvider = () => get();
    tokenProviderKey = clientId;
  }
  return tokenProvider();
}

/**
 * @param {{ mode: 'managed_identity'|'connection_string', accessKey: string|null }} cfg
 * @param {string} url
 * @param {string} body
 * @returns {Promise<Record<string, string>>}
 */
async function authHeaders(cfg, url, body) {
  if (cfg.mode === 'connection_string') {
    if (!cfg.accessKey) {
      throw new MessagingError('FEATURE_DISABLED', 'Text messaging is not connected yet. Nothing was sent.', {
        feature: 'tc_sms_send',
      });
    }
    return hmacHeaders({ method: 'POST', url, body, accessKey: cfg.accessKey });
  }
  let token;
  try {
    token = await bearerToken();
  } catch (err) {
    throw new MessagingError(
      'SEND_FAILED',
      `Could not get an Azure sign-in token for texting (managed_identity): ${scrubNumbers(err && err.message ? err.message : err)}`,
      { providerCode: 'ACS_AUTH_FAILED' }
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/** @param {Response} res */
async function jsonOf(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Send ONE text. Resolves only when ACS accepted it for this recipient.
 * @param {{ cfg: { mode: 'managed_identity'|'connection_string', endpoint: string, accessKey: string|null },
 *           from: string, to: string, message: string, repeatabilityRequestId: string, tag?: string|null,
 *           now?: Date }} input
 * @returns {Promise<{ messageId: string }>}
 */
async function sendSms({ cfg, from, to, message, repeatabilityRequestId, tag = null, now = new Date() }) {
  const url = `${cfg.endpoint}/sms?api-version=${API_VERSION}`;
  /** @type {Record<string, unknown>} */
  const smsSendOptions = { enableDeliveryReport: true };
  if (tag) smsSendOptions.tag = String(tag).slice(0, 100);
  const body = JSON.stringify({
    from,
    smsRecipients: [{ to, repeatabilityRequestId, repeatabilityFirstSent: now.toUTCString() }],
    message,
    smsSendOptions,
  });
  const auth = await authHeaders(cfg, url, body);

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new MessagingError(
      'SEND_FAILED',
      timedOut ? 'The texting service did not answer in time.' : 'The texting service could not be reached.',
      { providerCode: timedOut ? 'ACS_TIMEOUT' : 'ACS_UNREACHABLE' }
    );
  }

  const json = await jsonOf(res);
  const o = json && typeof json === 'object' ? /** @type {Record<string, unknown>} */ (json) : {};
  if (res.status !== 202) {
    const e = o.error && typeof o.error === 'object' ? /** @type {Record<string, unknown>} */ (o.error) : {};
    const code = typeof e.code === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(e.code) ? e.code : `HTTP_${res.status}`;
    const why = typeof e.message === 'string' ? scrubNumbers(e.message) : `HTTP ${res.status}`;
    throw new MessagingError('SEND_FAILED', `The texting service refused the text (${code}): ${why}`, {
      providerCode: `ACS_${code}`,
    });
  }

  const items = Array.isArray(o.value) ? o.value : [];
  const item = items.length === 1 && items[0] && typeof items[0] === 'object' ? /** @type {Record<string, unknown>} */ (items[0]) : null;
  if (!item) {
    throw new MessagingError('SEND_FAILED', 'The texting service answered without a result for the recipient.', {
      providerCode: 'ACS_BAD_RESPONSE',
    });
  }
  const messageId = typeof item.messageId === 'string' && item.messageId ? item.messageId : null;
  if (item.successful !== true || !messageId) {
    const status = Number.isInteger(item.httpStatusCode) ? Number(item.httpStatusCode) : null;
    const why = typeof item.errorMessage === 'string' ? scrubNumbers(item.errorMessage) : 'no reason given';
    throw new MessagingError(
      'SEND_FAILED',
      `The texting service refused the text${status ? ` (HTTP ${status})` : ''}: ${why}`,
      { providerCode: status ? `ACS_RECIPIENT_${status}` : 'ACS_RECIPIENT_REFUSED' }
    );
  }
  return { messageId };
}

module.exports = {
  API_VERSION,
  sendSms,
  scrubNumbers,
  setFetchForTests,
  setTokenProviderForTests,
  resetForTests,
};
