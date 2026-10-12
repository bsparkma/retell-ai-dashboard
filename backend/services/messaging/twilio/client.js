'use strict';

/**
 * A minimal Twilio REST client: ONE call, "create a Message" (queue item 39).
 *
 * Deliberately not the `twilio` npm package — one POST does not justify a large
 * dependency tree on a PHI path, and every byte this sends is visible below.
 *
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *   Authorization: Basic base64(apiKeySid:apiKeySecret)
 *   Content-Type: application/x-www-form-urlencoded
 *   To, From, MessagingServiceSid, Body, StatusCallback
 *
 * A single request, no retry (the messaging service never retries a send; see
 * adapters/index.js). The timeout is AbortSignal.timeout — this directory may
 * not contain a timer (messagingGuards.test.js).
 *
 * The transport is injectable: tests replace `fetchImpl` and nothing in CI ever
 * reaches the network.
 *
 * PHI: the body and the destination travel in the request and are never
 * logged. Errors carry Twilio's code and a scrubbed message — no phone number
 * survives into the text (Twilio's messages sometimes quote the To).
 */

const { MessagingError } = require('../errors');

const API_BASE = 'https://api.twilio.com';
const TIMEOUT_MS = 10_000;

/** @type {typeof fetch} */
let fetchImpl = (...args) => fetch(...args);

/** TESTS ONLY: swap the transport. */
function setFetchForTests(fn) {
  fetchImpl = fn;
}
/** TESTS ONLY. */
function resetFetch() {
  fetchImpl = (...args) => fetch(...args);
}

/**
 * Remove anything shaped like a phone number from provider text before it is
 * stored or shown. Belt and braces: the column is PHI-safe, the log is not.
 * @param {unknown} text
 * @returns {string}
 */
function scrubNumbers(text) {
  return String(text ?? '')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .slice(0, 500);
}

/**
 * @param {{ accountSid: string, apiKeySid: string, apiKeySecret: string,
 *           messagingServiceSid: string, from: string, to: string, body: string,
 *           statusCallback: string }} input
 * @returns {Promise<{ sid: string, status: string }>}
 */
async function createMessage(input) {
  const url = `${API_BASE}/2010-04-01/Accounts/${encodeURIComponent(input.accountSid)}/Messages.json`;
  const form = new URLSearchParams();
  form.set('To', input.to);
  form.set('From', input.from);
  form.set('MessagingServiceSid', input.messagingServiceSid);
  form.set('Body', input.body);
  form.set('StatusCallback', input.statusCallback);

  const auth = Buffer.from(`${input.apiKeySid}:${input.apiKeySecret}`, 'utf8').toString('base64');

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    // Honest about what we do NOT know: a timeout may still have been accepted
    // upstream. The row is marked failed (no retry), and the text says so.
    throw new MessagingError(
      'SEND_FAILED',
      timedOut
        ? 'Twilio did not answer within 10 seconds. The text may or may not have gone out — check before drafting again.'
        : 'Could not reach Twilio. Nothing was confirmed as sent.',
      { providerCode: timedOut ? 'TWILIO_TIMEOUT' : 'TWILIO_UNREACHABLE' }
    );
  }

  /** @type {Record<string, unknown>|null} */
  let json = null;
  try {
    json = /** @type {Record<string, unknown>} */ (await res.json());
  } catch {
    json = null;
  }

  if (!res.ok) {
    const code = json && json.code != null ? String(json.code) : String(res.status);
    const msg = json && json.message ? scrubNumbers(json.message) : `HTTP ${res.status}`;
    const err = new MessagingError('SEND_FAILED', `Twilio refused the text (error ${code}): ${msg}`, {
      providerCode: `TWILIO_${code}`,
    });
    throw err;
  }

  const sid = json && typeof json.sid === 'string' ? json.sid : '';
  const status = json && typeof json.status === 'string' ? json.status : '';
  if (!sid || !status) {
    throw new MessagingError('SEND_FAILED', 'Twilio answered without a message id, so the send is not confirmed.', {
      providerCode: 'TWILIO_BAD_RESPONSE',
    });
  }
  return { sid, status };
}

module.exports = { createMessage, scrubNumbers, setFetchForTests, resetFetch, API_BASE };
