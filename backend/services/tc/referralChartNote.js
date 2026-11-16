'use strict';

/**
 * R6.10 — the Open Dental half of a referral chart note: ONE approved note to
 * ONE patient's chart, and the proof it is there.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE WRITER IS THE VOICE MODULE'S, NOT A COPY
 * ═════════════════════════════════════════════════════════════════════════════
 * The commlog is created by `openDentalSync.createCommLog` — the single entry
 * point every call note goes through (POST /commlogs on the office-bound
 * client, the sanitizer at the write boundary, the DefNum from the caller or
 * the office). This file builds no payload and holds no transport; it decides
 * nothing about WHETHER to write. That is routes/tc/referralChartNotes.js,
 * which reaches this only from a person's POST.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A 201 IS NOT THE CLAIM
 * ═════════════════════════════════════════════════════════════════════════════
 * Success is reported only after the patient's commlogs are READ BACK and the
 * one Open Dental minted is found, on that PatNum, with this office's referral
 * type and the exact text. A response with no CommlogNum, a read that fails,
 * or a row that differs is a failure the caller must not record as written
 * (`unconfirmed`, with the CommlogNum when Open Dental gave one, so staff can
 * look before trying again).
 *
 * Before writing, the same read looks for a note ALREADY on the chart with
 * this type and this exact text — what an earlier write that could not be
 * confirmed or recorded leaves behind. Found, nothing is written: a second
 * identical note is the one outcome worse than a refusal.
 *
 * API mode only. A direct-DB client could insert but could not be read back
 * through the API, so it is refused before anything is written.
 */

const openDentalSync = require('../openDentalSync');

// The read-back helpers live in ./chartCommlogReadBack (AT-2 shares them);
// same names, same behaviour, still exported from here.
const { officeWallClock, readPatientCommlogs, isThisNote, PAGE_SIZE, MAX_PAGES } = require('./chartCommlogReadBack');

/**
 * Write one approved chart note and confirm it.
 *
 * @param {import('../../config/odOffices').OdOfficeHandle} od the office-bound connection (already asserted)
 * @param {{ patNum: number, note: string, commType: number, at: string }} args
 *   `commType` is ALREADY validated against this office's own list; `at` dates the commlog.
 * @returns {Promise<
 *   | { ok: true, commLogNum: number }
 *   | { ok: false, code: 'CHART_NOTE_API_MODE_ONLY' | 'CHART_NOTE_UNVERIFIABLE' | 'CHART_NOTE_ALREADY_IN_CHART' | 'CHART_NOTE_WRITE_FAILED' | 'CHART_NOTE_UNCONFIRMED', error: string, commLogNum?: number|null, written: boolean }
 * >}
 */
async function writeChartNote(od, { patNum, note, commType, at }) {
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
      error: 'This exact note is already on the patient\'s chart, so it was not written again.',
      commLogNum: Number(existing.CommlogNum) || null,
      written: false,
    };
  }

  // 2. The voice module's writer — the one every call note goes through.
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

module.exports = { writeChartNote, readPatientCommlogs, officeWallClock, PAGE_SIZE, MAX_PAGES };
