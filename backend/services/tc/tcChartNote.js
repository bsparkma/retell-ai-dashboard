'use strict';

/**
 * AT-2 — the Open Dental half of "Log to chart": ONE approved TC activity note
 * to ONE patient's chart, under that office's "CareIN TC" commlog type, and the
 * proof it is there.
 *
 * The R6.10 referral chart note (./referralChartNote.js) applied to the TC
 * feed, step for step:
 *
 *   1. API mode only — a direct-DB client could insert but never read back.
 *   2. READ the patient's commlogs: a note already there with this type and
 *      this exact text refuses (CHART_NOTE_ALREADY_IN_CHART). That is what an
 *      earlier write that landed but could not be confirmed or recorded leaves
 *      behind, and a second identical note is worse than a refusal.
 *   3. WRITE through the voice module's writer, openDentalSync.createCommLog —
 *      the one entry point every CareIN commlog goes through (office-bound
 *      client, the sanitizer at the write boundary). This file holds no
 *      transport of its own.
 *   4. READ BACK. Success is claimed only when the CommlogNum Open Dental
 *      minted is found on that PatNum with this type and the exact text.
 *      Anything else is CHART_NOTE_UNCONFIRMED (written: true when OD named a
 *      note), so staff look before trying again.
 *
 * It decides nothing about WHETHER to write. routes/tc/activityChart.js does,
 * and it reaches this only from a person's POST. routes/tc/tcActivityChart.test.js
 * fails the build if anything else requires this file.
 */

const openDentalSync = require('../openDentalSync');
const { officeWallClock, readPatientCommlogs, isThisNote } = require('./chartCommlogReadBack');

/**
 * Write one approved TC chart note and confirm it.
 *
 * @param {import('../../config/odOffices').OdOfficeHandle} od the office-bound connection (already asserted)
 * @param {{ patNum: number, note: string, commType: number, at: string }} args
 *   `commType` is ALREADY validated against this office's own list; `at` is
 *   the WRITE time (never backdated) and becomes CommDateTime as the office's
 *   wall clock.
 * @returns {Promise<
 *   | { ok: true, commLogNum: number }
 *   | { ok: false, code: 'CHART_NOTE_API_MODE_ONLY' | 'CHART_NOTE_UNVERIFIABLE' | 'CHART_NOTE_ALREADY_IN_CHART' | 'CHART_NOTE_WRITE_FAILED' | 'CHART_NOTE_UNCONFIRMED', error: string, commLogNum?: number|null, written: boolean }
 * >}
 */
async function writeTcChartNote(od, { patNum, note, commType, at }) {
  if (od.client.useDatabase) {
    return {
      ok: false,
      code: 'CHART_NOTE_API_MODE_ONLY',
      error: "This office's Open Dental connection cannot be read back, so nothing was written",
      written: false,
    };
  }

  // 1. Is this exact note already on the chart?
  const before = await readPatientCommlogs(od, patNum);
  if (!before.ok) {
    return { ok: false, code: 'CHART_NOTE_UNVERIFIABLE', error: `${before.error}. Nothing was written.`, written: false };
  }
  const existing = before.rows.find((r) => isThisNote(r, { patNum, commType, note }));
  if (existing) {
    return {
      ok: false,
      code: 'CHART_NOTE_ALREADY_IN_CHART',
      error: "This exact note is already on the patient's chart, so it was not written again.",
      commLogNum: Number(existing.CommlogNum) || null,
      written: false,
    };
  }

  // 2. The voice module's writer — the one every CareIN commlog goes through.
  const result = await openDentalSync.createCommLog(
    patNum,
    { CommDateTime: officeWallClock(at), Mode_: 'None', Note: note },
    od,
    { commTypeDefNum: commType, sentOrReceived: 'Neither' }
  );
  if (!result.success) {
    return {
      ok: false,
      code: 'CHART_NOTE_WRITE_FAILED',
      error: `Open Dental did not take the note: ${result.error || 'unknown error'}. Nothing was written.`,
      written: false,
    };
  }
  const minted = Number(result.commLogNum);
  if (!Number.isInteger(minted) || minted <= 0) {
    return {
      ok: false,
      code: 'CHART_NOTE_UNCONFIRMED',
      error: "Open Dental answered without naming the note it made. Check the patient's chart before trying again.",
      commLogNum: null,
      written: true,
    };
  }

  // 3. READ BACK. The claim is what Open Dental holds, not what it answered.
  const after = await readPatientCommlogs(od, patNum);
  const found = after.ok ? after.rows.find((r) => Number(r.CommlogNum) === minted) : null;
  if (!found || !isThisNote(found, { patNum, commType, note })) {
    return {
      ok: false,
      code: 'CHART_NOTE_UNCONFIRMED',
      error: `Open Dental made note ${minted}, but it could not be read back as written. Check the patient's chart before trying again.`,
      commLogNum: minted,
      written: true,
    };
  }
  return { ok: true, commLogNum: minted };
}

module.exports = { writeTcChartNote };
