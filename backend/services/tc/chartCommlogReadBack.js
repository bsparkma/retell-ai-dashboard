'use strict';

/**
 * Read-back helpers for a person-approved chart note: what Open Dental HOLDS on
 * one patient's chart, read through an office-bound client.
 *
 * Moved verbatim out of services/tc/referralChartNote.js (R6.10) when AT-2's
 * TC chart note needed the same proof, so there is ONE implementation of "is
 * this note on the chart" rather than two that can drift. referralChartNote.js
 * re-exports these names unchanged.
 *
 * Read-only. Nothing here writes, and it holds no transport of its own beyond
 * the office handle's apiGetRaw.
 */

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

module.exports = { officeWallClock, sameText, readPatientCommlogs, isThisNote, PAGE_SIZE, MAX_PAGES };
