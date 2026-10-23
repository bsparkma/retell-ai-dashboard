'use strict';

/**
 * (R5b) The patient's email address for a referral's notice — read from THAT
 * office's Open Dental, READ ONLY, at send time. Never from a request, never
 * from the referral row (which does not carry one), never from a TC case
 * (whose copy may be stale or typed by hand).
 *
 * This is the ONLY Open Dental access the referral send path has, and it is
 * one GET: /patients/{PatNum} through the office's own client
 * (assertOfficeMatch(office, getOdOffice(office))) — PatNum numbering restarts
 * in every database, so another practice's client would read another person.
 * Nothing here writes anywhere.
 *
 * Every outcome is a value, never a throw, so the caller can record an honest
 * skip and the specialist's send is unaffected:
 *
 *   { status: 'found', address }    a usable address on file
 *   { status: 'no_email' }          the patient has no usable email on file
 *   { status: 'not_found' }         no such patient (or deleted/deceased/…)
 *   { status: 'not_connected' }     this office's Open Dental is not connected
 *   { status: 'unreadable' }        Open Dental did not answer
 *
 * PHI: the address is returned to the caller only. No log line here carries
 * it, the PatNum or a name.
 */

const odOffices = require('../../config/odOffices');
const odReads = require('../../routes/tc/odReads');
const { normalizeEmail } = require('../messaging/address');

/** Something@something.something, no spaces — the same loose rule as the directory. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * @param {string} office
 * @param {number} patNum
 * @returns {Promise<{ status: 'found', address: string } | { status: 'no_email'|'not_found'|'not_connected'|'unreadable' }>}
 */
async function patientEmailFor(office, patNum) {
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
  if (!address || !EMAIL_RE.test(address)) return { status: 'no_email' };
  return { status: 'found', address };
}

module.exports = { patientEmailFor };
