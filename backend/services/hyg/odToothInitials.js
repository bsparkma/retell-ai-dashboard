'use strict';

/**
 * Which teeth Open Dental records as MISSING — READ ONLY (item 27).
 *
 * A hygienist should not have to skip four teeth by hand on a chart whose own
 * practice management system already knows they are not there. Open Dental keeps
 * that in `toothinitial`, one row per tooth per annotation, and this file reads
 * it so a fresh perio chart can open with those teeth already skipped.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * READ-ONLY BY CONSTRUCTION, THE SAME WAY odPerio.js IS
 * ═════════════════════════════════════════════════════════════════════════════
 * The only way to Open Dental is the `odGet(path, params, opts)` passed in.
 * There is no write counterpart in scope and this file must never grow one:
 * `routes/hyg/hygNoOdWrites.test.js` names it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY RULE BELOW IS A MEASUREMENT, NOT A READING OF THE DOCS
 * ═════════════════════════════════════════════════════════════════════════════
 * `backend/scripts/probe-hyg-tooth-initials.js` was run against staging on
 * 2026-10-01 (revision --0000206, roland, designated test patients only). Item
 * 18 shipped without this feature precisely because the docs could not settle
 * the first two of these. The capture is
 * `new-dashboard/tests/fixtures/od-toothinitials-measured.json`.
 *
 * 1. **ABSENCE IS `200` + `[]`.** A patient with no initials answered ok=true
 *    with an empty array — like `/perioexams`, and NOT like
 *    `/procedurelogs/GroupNotes?PatNum=`, which answers a 404 with a sentence
 *    (item 21). So "no missing teeth" and "could not read" are cleanly
 *    distinguishable here and neither has to be inferred: an empty array is an
 *    answer, and only a non-ok response is `unavailable`. This matters more than
 *    it looks — reading a refusal as an absence would pre-skip nothing forever,
 *    and reading an absence as a refusal would do the same, silently.
 *
 * 2. **`ToothNum` IS A STRING.** The five Missing rows measured came back
 *    `"1"`, `"16"`, `"9"`, `"32"`, `"17"` — typeof string, every one. So this
 *    file PARSES and never compares a tooth to a number with `===`. Open Dental
 *    also stores primary teeth as letters A–T in the same column, so any value
 *    that is not an integer 1–32 is IGNORED rather than treated as an error: a
 *    child's chart is not a failed read, and v1 charts permanent dentition only.
 *
 * 3. **ONLY `InitialType === 'Missing'` PRE-SKIPS.** That exact string is the
 *    value observed. `Hidden`, `Primary`, `ShiftM`, `ShiftO`, `ShiftB`,
 *    `Rotate`, `TipM` and `TipB` are the other documented types, and every one
 *    of them describes a tooth that IS there and DOES get probed. A rotated
 *    tooth that opened pre-skipped would be a reading quietly not taken.
 *
 * 4. 🔴 **UNFILTERED, THIS ENDPOINT IS THE WHOLE PRACTICE.** With no params it
 *    answered 100 rows across 28 distinct PatNums — the same hazard class as
 *    `/periomeasures/{id}` returning every row. So `PatNum` is ALWAYS passed,
 *    and every row is checked against the patient asked for even though the
 *    filter was honoured in the probe. A row for somebody else must not be one
 *    silently-ignored parameter away from skipping teeth on this chart. Rows
 *    that fail that check are dropped and COUNTED, never logged individually.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE REQUEST, AND WHAT THAT COSTS
 * ═════════════════════════════════════════════════════════════════════════════
 * This is deliberately NOT `pagedList`: the chart-open budget for item 27 is one
 * added request, and paging would spend a second on every patient whose first
 * page came back full. Open Dental caps a list at 100 rows, so a patient with
 * more than 100 tooth-initial rows is read short. That direction is safe — the
 * teeth we did see still pre-skip, the rest behave exactly as they do today and
 * she skips them herself — but it is reported as `truncated` so the log says so
 * rather than the under-skip looking like a complete answer.
 */

const { odInt } = require('./odDay');

/** Open Dental's list cap. A full page is the signal that there may be more. */
const OD_PAGE_SIZE = 100;

/** The one InitialType that means the tooth is not in the mouth. Exact case. */
const MISSING = 'Missing';

/** v1 charts permanent dentition. Primary letters A–T are not an error, just not ours. */
const FIRST_TOOTH = 1;
const LAST_TOOTH = 32;

/**
 * A permanent tooth number from whatever Open Dental put in `ToothNum`.
 *
 * Measured as a STRING, so this parses. A primary tooth's letter, an empty
 * string, a supernumerary beyond 32 and anything unparseable all answer null —
 * "not a tooth this chart has", which is not the same as a failure.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function permanentToothNum(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  // Whole digits only. `parseInt` would read "12B" as 12 and "A" as NaN, and the
  // first of those is a guess about a tooth.
  if (!/^\d{1,2}$/.test(text)) return null;
  const tooth = Number(text);
  return tooth >= FIRST_TOOTH && tooth <= LAST_TOOTH ? tooth : null;
}

/**
 * The teeth Open Dental records as missing for one patient. ONE request.
 *
 * @param {(path: string, params?: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ ok: boolean, status: number, data: unknown, error?: string|null }>} odGet
 * @param {{ patNum: number }} args
 * @returns {Promise<{
 *   preSkip: { status: 'ready', teeth: number[] } | { status: 'unavailable' },
 *   rows: number,
 *   missing: number,
 *   foreign: number,
 *   unparsed: number,
 *   truncated: boolean,
 *   error: string|null,
 * }>}
 */
async function readMissingTeeth(odGet, { patNum }) {
  const unavailable = (error) => ({
    preSkip: { status: 'unavailable' },
    rows: 0,
    missing: 0,
    foreign: 0,
    unparsed: 0,
    truncated: false,
    error,
  });

  // A pre-skip is worth exactly one request and no retry: it is a convenience,
  // and the chart behind it is already on screen.
  if (!Number.isSafeInteger(patNum) || patNum <= 0) return unavailable('no PatNum to ask about');

  // PATNUM IS NEVER OMITTED. Unfiltered, this endpoint answers with the practice.
  const res = await odGet('/toothinitials', { PatNum: patNum }, { module: 'hyg' });

  if (!res || !res.ok) {
    return unavailable((res && (res.error || 'HTTP ' + res.status)) || 'the tooth initials read threw');
  }
  // `200` with something that is not a list is not an absence — it is an answer
  // this code does not understand, and guessing "no missing teeth" from it would
  // be the exact failure the absence measurement exists to prevent.
  if (!Array.isArray(res.data)) return unavailable('the tooth initials read did not answer a list');

  const rows = res.data;
  const teeth = new Set();
  let foreign = 0;
  let unparsed = 0;

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      unparsed += 1;
      continue;
    }
    // Rule 4: the row has to say it is about the patient we asked about. A row
    // that does not say is dropped, not trusted.
    if (odInt(row.PatNum) !== patNum) {
      foreign += 1;
      continue;
    }
    // Rule 3: every other InitialType describes a tooth that is still there.
    if (row.InitialType !== MISSING) continue;
    // Rule 2: parse, never ===-compare. A primary letter is ignored, not an error.
    const tooth = permanentToothNum(row.ToothNum);
    if (tooth === null) {
      unparsed += 1;
      continue;
    }
    teeth.add(tooth);
  }

  return {
    preSkip: { status: 'ready', teeth: [...teeth].sort((a, b) => a - b) },
    rows: rows.length,
    missing: teeth.size,
    foreign,
    unparsed,
    // A full page may have been cut off mid-list. Under-skipping is safe; saying
    // nothing about it is what would not be.
    truncated: rows.length >= OD_PAGE_SIZE,
    error: null,
  };
}

module.exports = { readMissingTeeth, permanentToothNum, MISSING, OD_PAGE_SIZE };
