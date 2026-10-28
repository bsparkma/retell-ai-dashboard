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

/** Open Dental pages list reads at 100 rows. */
const PAGE_SIZE = 100;
/** 50 pages = 5,000 commlogs on one patient: far past any real chart. */
const MAX_PAGES = 50;
const READ_TIMEOUT_MS = 15000;

/**
 * An instant as the OFFICE's wall clock, "yyyy-MM-dd HH:mm:ss". Open Dental
 * reads CommDateTime as practice-local, and the writer's formatODDateTime keeps
 * an ISO string's clock digits verbatim — so a UTC instant handed over as-is
 * would date the note five or six hours off. OFFICE_TIMEZONE is the same
 * setting the voice note's header uses.
 * @param {string} iso
 * @returns {string}
 */
function officeWallClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`not a timestamp: ${iso}`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.OFFICE_TIMEZONE || 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** OD may hand a note back with CRLF line ends; the text is otherwise compared exactly. */
function sameText(a, b) {
  const norm = (s) => String(s ?? '').replace(/\r\n?/g, '\n').trim();
  return norm(a) === norm(b);
}

/**
 * Every commlog on one patient's chart in this office, read through the
 * office-bound client. Stops when a page is short or adds nothing new (an
 * Open Dental build that ignores Offset answers the same page again).
 * @param {import('../../config/odOffices').OdOfficeHandle} od
 * @param {number} patNum
 * @returns {Promise<{ ok: true, rows: Array<Record<string, unknown>> } | { ok: false, error: string }>}
 */
async function readPatientCommlogs(od, patNum) {
  const seen = new Map();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await od.client.apiGetRaw(
      '/commlogs',
      { PatNum: patNum, Offset: page * PAGE_SIZE },
      { timeoutMs: READ_TIMEOUT_MS, module: 'tc' }
    );
    if (!res.ok) return { ok: false, error: `Open Dental did not return the chart's notes (${res.status}): ${res.error || 'unknown'}` };
    if (!Array.isArray(res.data)) return { ok: false, error: "Open Dental returned the chart's notes in an unexpected shape" };
    let added = 0;
    for (const row of res.data) {
      const key = row && row.CommlogNum !== undefined ? String(row.CommlogNum) : `#${seen.size}`;
      if (!seen.has(key)) {
        seen.set(key, row);
        added += 1;
      }
    }
    if (res.data.length < PAGE_SIZE || added === 0) return { ok: true, rows: [...seen.values()] };
  }
  return { ok: false, error: 'This chart has more notes than can be checked in full' };
}

/** A row that is this note: same patient, same type, same text. */
function isThisNote(row, { patNum, commType, note }) {
  return (
    Number(row.PatNum) === Number(patNum) &&
    Number(row.CommType) === Number(commType) &&
    sameText(row.Note, note)
  );
}

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
