'use strict';

/**
 * What Open Dental last said about a visit's appointment, as the ortho send
 * needs it (item 33).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO OPEN DENTAL REQUEST, EVER
 * ═════════════════════════════════════════════════════════════════════════════
 * The name, provider and chair come off the appointment object the calling
 * route ALREADY resolved from Open Dental. Birthdate and phone come off the
 * shared patient cache (services/odPatientCache.js), asked with a reader that
 * refuses — so a cache miss is a null, never a fetch. The day route and the
 * visit page warm that cache as a matter of course, so on the visit a
 * hygienist is looking at, the answer is nearly always there.
 *
 * A missing age or phone is an honest null on the TC case. Inventing either, or
 * spending a throttled Open Dental second on it from a module this slice keeps
 * read-free, would both be worse.
 */

const odPatientCache = require('../odPatientCache');
const odDay = require('./odDay');

/** The reader handed to the cache: it never reaches Open Dental. */
async function refuseToFetch() {
  return { ok: false, record: null };
}

/**
 * The transport handed to the providers list: a refusal, never a request. The
 * list comes from services/odConfigCache.js, which the day read inside this
 * same request has just filled; on a miss the doctor's name is simply null.
 */
async function refuseOdGet() {
  return { ok: false, status: 0, data: null, error: 'cache only' };
}

/** A raw Open Dental string field, trimmed, or ''. */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {string} office
 * @param {{ patNum: number|null, patientName: string|null, providerName: string|null,
 *           provNum: number|null, opName: string|null }} appointment the route's own
 *           resolved appointment
 * @param {{ now?: () => Date }} [opts]
 * @returns {Promise<{ patientName: string|null, providerName: string|null,
 *                     doctorName: string|null, opName: string|null, birthdate: string|null,
 *                     phone: string|null, capturedAt: string }>}
 */
async function snapshotFromAppointment(office, appointment, { now = () => new Date() } = {}) {
  let birthdate = null;
  let phone = null;
  if (appointment.patNum !== null && appointment.patNum !== undefined) {
    const cached = await odPatientCache.getPatient(office, appointment.patNum, refuseToFetch);
    if (cached.ok && cached.record) {
      const raw = cached.record;
      const b = str(raw.Birthdate).slice(0, 10);
      // 0001-01-01 is Open Dental's "no date", never a birthday.
      birthdate = /^\d{4}-\d{2}-\d{2}$/.test(b) && !b.startsWith('0001') ? b : null;
      phone = str(raw.WirelessPhone) || str(raw.HmPhone) || str(raw.WkPhone) || null;
    }
  }
  /*
   * THE DOCTOR, by the appointment's own ProvNum. `providerName` on the
   * appointment prefers the HYGIENIST (ProvHyg) because that is who a day card
   * should name; a TC case's diagnosing provider is the appointment's provider,
   * the doctor who examined. Both are kept: providerName is who was seen.
   */
  let doctorName = null;
  if (appointment.provNum !== null && appointment.provNum !== undefined) {
    try {
      const labels = await odDay.readProviderLabels(refuseOdGet, { office });
      doctorName = labels.byNum.get(appointment.provNum) ?? null;
    } catch {
      doctorName = null;
    }
  }

  return {
    patientName: appointment.patientName ?? null,
    providerName: appointment.providerName ?? null,
    doctorName,
    opName: appointment.opName ?? null,
    birthdate,
    phone,
    capturedAt: now().toISOString(),
  };
}

module.exports = { snapshotFromAppointment };
