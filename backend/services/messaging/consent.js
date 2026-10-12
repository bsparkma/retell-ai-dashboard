'use strict';

/**
 * The consent gate. Server-side, FAILS CLOSED, and consulted by every send.
 *
 *   canMessage(q, { office, channel, address, odPatientId, now })
 *
 * evaluates, in this order, and the FIRST rule that refuses wins:
 *
 *   1. tc_contact_consent says opted_out for (office, channel, address)
 *      → CONSENT_OPTED_OUT. Always. No override, no role, no flag. An opt-out
 *      beats everything below, including an Open Dental "Yes".
 *
 *   2. SMS to a case linked to an Open Dental patient: read that patient's
 *      TxtMsgOk (office-keyed client, through services/odPatientCache.js — the
 *      shared five-minute identity-class cache, keyed office + PatNum).
 *        No           → OD_TEXT_CONSENT_NO
 *        unreadable   → OD_CONSENT_UNAVAILABLE (fail closed: an office that is
 *                       not connected, a read that failed, or a value we do not
 *                       recognise is NOT permission)
 *        Yes          → passes
 *        ?? (unknown) → passes in v1, surfaced as a badge ("no OD text consent
 *                       on file") so the TC sees it before clicking Send
 *      A case with no linked patient has nothing to read: `not_linked`, passes,
 *      and the badge says so.
 *
 *   3. SMS inside quiet hours (21:00–08:00 America/Chicago) → QUIET_HOURS.
 *      Email is exempt.
 *
 * Email consults rule 1, plus (item 40) rule 1b:
 *
 *   1b. EMAIL to a case whose tc_cases.nurture_unsubscribed is true →
 *       CONSENT_OPTED_OUT. That flag is the legacy TC app's "patient
 *       unsubscribed from nurture emails" and the Nurture workspace's
 *       Unsubscribe button. Item 38 left open whether it counts as an email
 *       opt-out; item 40 takes the STRICTER answer: it blocks every email to
 *       that case. It is case-level, so it does not follow an address to
 *       another case, and it does not touch SMS. The unsubscribe LINK records
 *       a real tc_contact_consent row (rule 1) instead.
 *
 * The OFFICE is always the caller's server-derived office (the case's office),
 * never a request value — and the OD read re-asserts it at the transport
 * (assertOfficeMatch), because PatNum numbering restarts in every Open Dental
 * database: 7115 is the valley test patient AND a different, real person in
 * roland.
 *
 * This file never writes to Open Dental: its only OD verb is a GET.
 */

const odOffices = require('../../config/odOffices');
const odPatientCache = require('../odPatientCache');
const { isQuietHours, QUIET_HOURS_MESSAGE } = require('./quietHours');

const OD_READ_TIMEOUT_MS = 15000;

/**
 * Open Dental's patient.TxtMsgOk is a YN: Unknown ("??", 0), Yes ("Yes", 1),
 * No ("No", 2). The API returns the string form; the numeric form is accepted
 * in case a build answers with the enum value. Anything else — including a
 * missing field — is `unavailable`, which BLOCKS. Unmeasured against a live
 * record in this slice; see the report's open questions.
 * @param {unknown} raw
 * @returns {'yes'|'no'|'unknown'|'unavailable'}
 */
function parseTxtMsgOk(raw) {
  if (raw === 1 || raw === true) return 'yes';
  if (raw === 2 || raw === false) return 'no';
  if (raw === 0) return 'unknown';
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'yes' || v === 'y') return 'yes';
    if (v === 'no' || v === 'n') return 'no';
    if (v === '??' || v === 'unknown' || v === '') return 'unknown';
  }
  return 'unavailable';
}

/**
 * Default Open Dental reader: office-keyed client, shared patient cache.
 * Returns the raw patient record, or null when it cannot be read for ANY
 * reason (office not connected, OD error, not found). Never throws.
 * @param {string} office
 * @param {number} patNum
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function defaultReadOdPatient(office, patNum) {
  let handle;
  try {
    handle = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  } catch (err) {
    console.warn(`[messaging/consent] office=${office} OD unavailable: ${(err && err.code) || 'error'}`);
    return null;
  }
  const got = await odPatientCache.getPatient(office, patNum, async (n) => {
    const res = await odOffices
      .assertOfficeMatch(office, handle)
      .client.apiGetRaw(`/patients/${n}`, {}, { timeoutMs: OD_READ_TIMEOUT_MS, module: 'tc' });
    if (!res || !res.ok) return { ok: false, record: null };
    const raw = Array.isArray(res.data) ? res.data[0] : res.data;
    return raw && typeof raw === 'object' && raw.PatNum ? { ok: true, record: raw } : { ok: false, record: null };
  });
  return got.ok ? got.record : null;
}

/** @type {(office: string, patNum: number) => Promise<Record<string, unknown>|null>} */
let readOdPatient = defaultReadOdPatient;

/** TESTS ONLY: substitute the Open Dental reader. */
function setOdPatientReaderForTests(fn) {
  readOdPatient = fn;
}
/** TESTS ONLY: restore the real reader. */
function resetOdPatientReader() {
  readOdPatient = defaultReadOdPatient;
}

/**
 * The stored consent row for (office, channel, address), or null.
 * @param {{ query: Function }} q
 */
async function getConsentRow(q, office, channel, address) {
  const res = await q.query(
    `SELECT consent_id, office_id, channel, address, state, source, note, updated_by, updated_at
       FROM tc_contact_consent WHERE office_id = $1 AND channel = $2 AND address = $3`,
    [office, channel, address]
  );
  return res.rows.length ? res.rows[0] : null;
}

/**
 * Read OD TxtMsgOk for a linked patient.
 * @returns {Promise<'yes'|'no'|'unknown'|'unavailable'|'not_linked'>}
 */
async function readOdTextConsent(office, odPatientId) {
  const patNum = odPatientId == null ? null : Number(odPatientId);
  if (patNum == null || !Number.isSafeInteger(patNum) || patNum <= 0) return 'not_linked';
  let record;
  try {
    record = await readOdPatient(office, patNum);
  } catch (err) {
    console.warn(`[messaging/consent] office=${office} OD read threw: ${(err && err.message) || err}`);
    record = null;
  }
  if (!record) return 'unavailable';
  return parseTxtMsgOk(record.TxtMsgOk);
}

const BLOCK_MESSAGES = Object.freeze({
  CONSENT_OPTED_OUT: 'This contact has opted out of messages on this channel. It cannot be sent.',
  OD_TEXT_CONSENT_NO: 'Open Dental says this patient does not accept text messages.',
  OD_CONSENT_UNAVAILABLE:
    "Open Dental's text-message consent could not be read for this patient, so the text was not sent.",
  QUIET_HOURS: QUIET_HOURS_MESSAGE,
});

/**
 * @typedef {{
 *   allowed: boolean,
 *   code: null | 'CONSENT_OPTED_OUT' | 'OD_TEXT_CONSENT_NO' | 'OD_CONSENT_UNAVAILABLE' | 'QUIET_HOURS',
 *   message: string | null,
 *   consentState: 'opted_in' | 'opted_out' | 'unknown',
 *   odTextConsent: 'yes'|'no'|'unknown'|'unavailable'|'not_linked'|'not_checked',
 *   quietHours: boolean,
 * }} ConsentDecision
 */

/**
 * The gate. See the header for the rule order.
 * @param {{ query: Function }} q tenant DB
 * @param {{ office: string, channel: 'sms'|'email', address: string,
 *           odPatientId?: number|string|null, now?: Date, caseEmailUnsubscribed?: boolean }} input
 * @returns {Promise<ConsentDecision>}
 */
async function canMessage(
  q,
  { office, channel, address, odPatientId = null, now = new Date(), caseEmailUnsubscribed = false }
) {
  const quiet = channel === 'sms' ? isQuietHours(now) : false;

  // 1. Opt-out beats everything.
  const row = await getConsentRow(q, office, channel, address);
  const consentState = row ? row.state : 'unknown';
  if (consentState === 'opted_out') {
    return decision('CONSENT_OPTED_OUT', consentState, 'not_checked', quiet);
  }
  // 1b. (item 40) The case's legacy nurture unsubscribe blocks email. Strict
  // `=== true`: only a flag that is really set shrinks what may be sent.
  if (channel === 'email' && caseEmailUnsubscribed === true) {
    return decision('CONSENT_OPTED_OUT', 'opted_out', 'not_checked', quiet);
  }

  // 2. Open Dental text consent (SMS only).
  let odTextConsent = 'not_checked';
  if (channel === 'sms') {
    odTextConsent = await readOdTextConsent(office, odPatientId);
    if (odTextConsent === 'no') return decision('OD_TEXT_CONSENT_NO', consentState, odTextConsent, quiet);
    if (odTextConsent === 'unavailable') {
      return decision('OD_CONSENT_UNAVAILABLE', consentState, odTextConsent, quiet);
    }
  }

  // 3. Quiet hours (SMS only).
  if (quiet) return decision('QUIET_HOURS', consentState, odTextConsent, quiet);

  return { allowed: true, code: null, message: null, consentState, odTextConsent, quietHours: quiet };
}

function decision(code, consentState, odTextConsent, quietHours) {
  return { allowed: false, code, message: BLOCK_MESSAGES[code], consentState, odTextConsent, quietHours };
}

module.exports = {
  canMessage,
  parseTxtMsgOk,
  getConsentRow,
  readOdTextConsent,
  BLOCK_MESSAGES,
  setOdPatientReaderForTests,
  resetOdPatientReader,
};
