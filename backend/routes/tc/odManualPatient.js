'use strict';

/**
 * The patient of a record started BY HAND, read from THIS office's Open Dental
 * (read only) — shared by the referrals hub's manual start (R6.2) and the
 * Checkout page's "Add patient" (CO-5a). Moved here unchanged from
 * routes/tc/referrals.js so both use the one check instead of two copies.
 *
 * The PatNum in a request body says only WHICH patient the person picked from
 * the patient search; existence and the name come from Open Dental, through the
 * office's own client (never another practice's: PatNum numbering restarts in
 * every database). Call it BEFORE any transaction opens, so no transaction is
 * held across a network call.
 *
 * READ-ONLY: the one Open Dental call is odReads.getPatient (GET /patients/:n).
 */

const odOffices = require('../../config/odOffices');
const odReads = require('./odReads');

/**
 * @param {string} office  the request's office (requireOffice)
 * @param {number} patNum  the PatNum the person picked
 * @param {string} [logTag]  the caller, for the PHI-free failure log line
 * @returns {Promise<{ patient: { odPatientId: number, patientName: string } } | { refusal: [number, string, string] }>}
 */
async function manualPatient(office, patNum, logTag = 'tc/manual-patient') {
  let od;
  try {
    od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  } catch (err) {
    return { refusal: [503, err.publicMessage || 'Open Dental is not connected for this office', 'OFFICE_NOT_CONNECTED'] };
  }
  const odGet = (path, params, opts) => od.client.apiGetRaw(path, params, { ...(opts || {}), module: 'tc' });
  let found;
  try {
    found = await odReads.getPatient(odGet, patNum);
  } catch {
    console.error(`[${logTag}] office=${office} manual start: patient read failed`);
    return { refusal: [502, 'Could not read that patient from Open Dental. Nothing was saved.', 'OD_READ_FAILED'] };
  }
  if (!found.patient || odReads.EXCLUDED_PAT_STATUS.has(found.patient.status)) {
    return { refusal: [404, "That patient is not in this office's Open Dental", 'PATIENT_NOT_FOUND'] };
  }
  return { patient: { odPatientId: found.patient.patNum, patientName: found.patient.displayName } };
}

module.exports = { manualPatient };
