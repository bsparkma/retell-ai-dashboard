'use strict';

/**
 * The patient's contact details for a referral's send — read from THAT
 * office's Open Dental, READ ONLY, at send time. Never from a request, never
 * from the referral row (which does not carry them), never from a TC case
 * (whose copy may be stale or typed by hand).
 *
 * This is the ONLY Open Dental access the referral send path has, and it is
 * ONE GET per send: /patients/{PatNum} through the office's own client
 * (assertOfficeMatch(office, getOdOffice(office))) — PatNum numbering restarts
 * in every database, so another practice's client would read another person.
 * Nothing here writes anywhere.
 *
 * WHO USES WHAT (the send decides; this module only reads):
 *   the specialist's letter   phone, email and date of birth — its "Patient
 *                             contact" section and its date-of-birth line
 *                             (letter enrichment). The letter ONLY.
 *   the patient's notice (R5b) the email address, to send it to
 *
 * Every outcome is a value, never a throw, so the caller can render or skip
 * honestly and the specialist's send is unaffected:
 *
 *   patientContactFor
 *     { status: 'found', phone, email, birthdate }
 *          each field a usable value or null ("not on file"); `email` is
 *          normalized and shape-checked, `birthdate` 'YYYY-MM-DD'
 *     { status: 'not_found' }       no such patient (or deleted/deceased/…)
 *     { status: 'not_connected' }   this office's Open Dental is not connected
 *     { status: 'unreadable' }      Open Dental did not answer
 *
 *   patientEmailFor (R5b), from the same read
 *     { status: 'found', address } | { status: 'no_email' } | the three above
 *
 * PHI: the values are returned to the caller only. No log line here carries
 * them, the PatNum or a name.
 */

const odOffices = require('../../config/odOffices');
const odReads = require('../../routes/tc/odReads');
const { normalizeEmail } = require('../messaging/address');

/** Something@something.something, no spaces — the same loose rule as the directory. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A calendar date, as odReads returns one ('' for Open Dental's 0001-01-01). */
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {unknown} v */
function textOrNull(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

/**
 * @param {string} office
 * @param {number} patNum
 * @returns {Promise<{ status: 'found', phone: string|null, email: string|null, birthdate: string|null }
 *   | { status: 'not_found'|'not_connected'|'unreadable' }>}
 */
async function patientContactFor(office, patNum) {
  let od;
  try {
    od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  } catch {
    return { status: 'not_connected' };
  }
  const odGet = (path, params, opts) => od.client.apiGetRaw(path, params, { ...(opts || {}), module: 'tc' });
  let found;
  try {
    found = await odReads.getPatient(odGet, patNum);
  } catch {
    console.error(`[tc/referralPatientContact] office=${office} Open Dental read failed`);
    return { status: 'unreadable' };
  }
  if (!found.patient || odReads.EXCLUDED_PAT_STATUS.has(found.patient.status)) return { status: 'not_found' };
  const address = normalizeEmail(found.patient.email);
  const birthdate = textOrNull(found.patient.birthdate);
  return {
    status: 'found',
    phone: textOrNull(found.patient.phone),
    email: address && EMAIL_RE.test(address) ? address : null,
    birthdate: birthdate && YMD_RE.test(birthdate) ? birthdate : null,
  };
}

/**
 * (R5b) The address for the patient's notice, from a contact read already
 * made (so a send reads Open Dental once).
 * @param {Awaited<ReturnType<typeof patientContactFor>>} contact
 * @returns {{ status: 'found', address: string } | { status: 'no_email'|'not_found'|'not_connected'|'unreadable' }}
 */
function emailOf(contact) {
  if (contact.status !== 'found') return contact;
  const found = /** @type {{ email: string|null }} */ (contact);
  return found.email ? { status: 'found', address: found.email } : { status: 'no_email' };
}

/**
 * (R5b) The patient's email address alone — one read. Kept for callers that
 * want only the address.
 * @param {string} office
 * @param {number} patNum
 */
async function patientEmailFor(office, patNum) {
  return emailOf(await patientContactFor(office, patNum));
}

module.exports = { patientContactFor, patientEmailFor, emailOf };
