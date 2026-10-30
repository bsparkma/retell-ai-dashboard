'use strict';

/**
 * The "Scheduled" anchor's Open Dental read (CO-4a): a checkout's patient's
 * UPCOMING appointments, labelled for the picker.
 *
 * WHOSE, AND WHERE. The office is the checkout record's office (the request's,
 * through requireOffice, matched against the row) and the PatNum is the STORED
 * record's — never a request's. The office's own client is resolved here and
 * checked with assertOfficeMatch, so an AptNum is only ever read from — and
 * so only ever anchored in — the practice it belongs to.
 *
 * WHAT. One GET /appointments request (odReads.listUpcomingAppointments). The
 * visit-type and chair names come from the practice-configuration lists the
 * hygiene day view already reads, through the same hour-long per-office cache
 * (services/odConfigCache.js), so a warm cache costs no Open Dental request at
 * all. A label that cannot be read is shown plainly (the procedure summary, or
 * "Op 3"); it never fails the picker. The APPOINTMENT read failing does, and
 * says so — never an empty list that looks like "no appointments".
 *
 * What leaves this file: AptNum, the date and time, the provider, the visit
 * type, the operatory. No notes, no other patient.
 *
 * READ-ONLY BY CONSTRUCTION: the only transport is apiGetRaw.
 */

const odOffices = require('../../config/odOffices');
const odReads = require('./odReads');
const odDay = require('../../services/hyg/odDay');

/** A failed appointment read, as the routes report it. */
class AppointmentsUnavailable extends Error {
  constructor(cause) {
    super('Could not read appointments from Open Dental');
    this.name = 'AppointmentsUnavailable';
    this.cause = cause;
  }
}

/** The office's own read-only transport, office-checked. Throws OdOfficeError. */
function odGetForOffice(office) {
  const handle = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  return (path, params, opts) =>
    odOffices.assertOfficeMatch(office, handle).client.apiGetRaw(path, params, { ...(opts || {}), module: 'tc' });
}

/** Labels from the cached config lists; an unreadable list is an empty map, never a failure. */
async function labelsFor(odGet, office) {
  const [types, ops] = await Promise.all([
    odDay.readAppointmentTypeLabels(odGet, { office }).catch(() => ({ byNum: new Map() })),
    odDay.readOperatories(odGet, { office }).catch(() => ({ operatories: [] })),
  ]);
  const opName = new Map((ops.operatories || []).map((o) => [o.opNum, o.name || o.abbrev || null]));
  return { typeName: types.byNum || new Map(), opName };
}

/**
 * The checkout's patient's upcoming appointments, soonest first, labelled.
 *
 * @param {string} office  the record's office
 * @param {number} odPatientId  the record's PatNum
 * @param {string} from  the office's today, 'YYYY-MM-DD'
 * @returns {Promise<Array<{ aptNum: number, dateTime: string, provider: string, appointmentType: string, operatory: string }>>}
 * @throws {AppointmentsUnavailable | Error & { name: 'OdOfficeError' }}
 */
async function upcomingForPatient(office, odPatientId, from) {
  const odGet = odGetForOffice(office);
  let rows;
  try {
    rows = await odReads.listUpcomingAppointments(odGet, odPatientId, { from });
  } catch (err) {
    console.error(`[tc/checkout] office=${office} upcoming appointments read failed (OD status ${(err && err.odStatus) || 'n/a'})`);
    throw new AppointmentsUnavailable(err);
  }
  if (rows.length === 0) return [];
  const { typeName, opName } = await labelsFor(odGet, office);
  return rows.map((a) => ({
    aptNum: a.aptNum,
    dateTime: a.dateTime,
    provider: a.provAbbr,
    appointmentType: (a.appointmentTypeNum !== null && typeName.get(a.appointmentTypeNum)) || a.procDescript || '',
    operatory: a.op === null ? '' : opName.get(a.op) || `Op ${a.op}`,
  }));
}

module.exports = { upcomingForPatient, AppointmentsUnavailable };
