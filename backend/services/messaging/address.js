'use strict';

/**
 * Address normalization for the messaging layer.
 *
 * An address is the key consent is stored under, so the same phone typed two
 * ways ("(479) 555-0100", "479.555.0100") MUST normalize to one string or an
 * opt-out recorded under one spelling would not stop a text to the other.
 *
 *   sms    E.164. US numbers only in this slice: 10 digits → +1XXXXXXXXXX,
 *          11 digits starting with 1 → +1XXXXXXXXXX. Anything else → null.
 *   email  trimmed and lower-cased, and shaped like an address. Else null.
 *
 * null means "no usable address" — a draft is refused (NO_ADDRESS), never sent
 * to a guess.
 */

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v.length > 320) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/**
 * @param {'sms'|'email'} channel
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeAddress(channel, raw) {
  if (channel === 'sms') return normalizePhone(raw);
  if (channel === 'email') return normalizeEmail(raw);
  return null;
}

/**
 * The address a case-linked message goes to, assembled from the CASE ROW —
 * never from a request body.
 * @param {'sms'|'email'} channel
 * @param {{ phone?: unknown, email?: unknown }} caseRow
 * @returns {string|null}
 */
function addressFromCase(channel, caseRow) {
  return normalizeAddress(channel, channel === 'sms' ? caseRow.phone : caseRow.email);
}

module.exports = { normalizePhone, normalizeEmail, normalizeAddress, addressFromCase };
