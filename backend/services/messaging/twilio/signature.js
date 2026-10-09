'use strict';

/**
 * X-Twilio-Signature validation, implemented here rather than by adding the
 * `twilio` npm package (queue item 39).
 *
 * Twilio's documented algorithm for a form-encoded webhook
 * (https://www.twilio.com/docs/usage/security#validating-requests):
 *
 *   1. Start with the FULL URL Twilio requested, query string included.
 *   2. Sort the POST parameters by name; append each name immediately followed
 *      by its value, no delimiters. (A repeated name contributes once per
 *      value, values in sorted order — what the official libraries do.)
 *   3. HMAC-SHA1 that string with the account AUTH TOKEN; base64 the digest.
 *   4. Compare with the X-Twilio-Signature header.
 *
 * The comparison is timing-safe, and a missing or malformed header is a
 * refusal, never a pass. The test vector in signature.test.js is the one from
 * Twilio's own documentation and SDK tests.
 */

const crypto = require('node:crypto');

/**
 * Parse an application/x-www-form-urlencoded body into [name, value] pairs,
 * preserving repeats. Using the RAW body (not express's parsed req.body) keeps
 * the signed bytes and the validated bytes the same thing.
 * @param {string} raw
 * @returns {Array<[string, string]>}
 */
function parseForm(raw) {
  if (typeof raw !== 'string' || raw === '') return [];
  return Array.from(new URLSearchParams(raw).entries());
}

/**
 * @param {string} authToken
 * @param {string} url the full URL Twilio requested
 * @param {Array<[string, string]>} pairs POST parameters
 * @returns {string} base64 HMAC-SHA1
 */
function computeSignature(authToken, url, pairs) {
  const sorted = pairs.slice().sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });
  let data = url;
  for (const [k, v] of sorted) data += k + v;
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/**
 * @param {{ authToken: string|null, signature: unknown, url: string|null, pairs: Array<[string, string]> }} input
 * @returns {boolean}
 */
function isValidSignature({ authToken, signature, url, pairs }) {
  if (!authToken || !url) return false;
  if (typeof signature !== 'string' || signature === '') return false;
  const expected = Buffer.from(computeSignature(authToken, url, pairs), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

module.exports = { parseForm, computeSignature, isValidSignature };
