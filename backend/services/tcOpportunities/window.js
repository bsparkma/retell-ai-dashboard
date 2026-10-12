'use strict';

/**
 * The Opportunities inbox DISPLAY window (queue item 45) — pure date rules
 * plus the one read of the per-office setting.
 *
 * CAPTURE vs DISPLAY. The nightly sync (sync.js) captures 730 days of
 * treatment plans and is not touched by anything here. This file decides only
 * which captured rows the inbox SHOWS:
 *
 *   office window   tc_library_config section `opportunities_config`,
 *                   `opportunitiesWindowMonths` (1..24, default 18). The
 *                   shared contract's LibraryOpportunitiesConfig is the schema.
 *   maxAgeMonths    the inbox's chip (1..24) — narrows WITHIN the window,
 *                   never widens past it (see resolveWindow).
 *   age basis       the NEWEST planned date (DateTP) among a row's procedures:
 *                   a patient re-diagnosed last week is fresh, whatever older
 *                   work is also on the plan.
 *
 * DATE MATH is calendar-only on 'YYYY-MM-DD' strings — the lib/followups.ts
 * pattern (new-dashboard/client/src/features/tc/lib/followups.ts): no Date
 * object ever carries a time of day through the arithmetic, so the result
 * cannot shift with the server's zone. The only zone-aware step is "what is
 * today's date in the practice's zone", done once with Intl.
 *
 * Month subtraction CLAMPS to the end of the shorter month: Mar 31 minus one
 * month is Feb 28 (Feb 29 in a leap year), never "Mar 3". A plan dated exactly
 * N months ago is INSIDE an N-month window (the comparison is >=).
 */

const { LibrarySectionSchemas, OPPORTUNITIES_WINDOW_DEFAULT_MONTHS, OPPORTUNITIES_WINDOW_MIN_MONTHS, OPPORTUNITIES_WINDOW_MAX_MONTHS } =
  require('../../tc/contract.gen.cjs');

/** The library section that holds the window. */
const SECTION = 'opportunities_config';

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The clock the route reads "today" from. Real time in production; a test can
 * pin it (setClockForTests) so fixture dates do not age out of the window.
 * @type {() => number}
 */
let clock = () => Date.now();

/** @param {(() => number) | null} fn  null restores the real clock */
function setClockForTests(fn) {
  clock = fn || (() => Date.now());
}

/** @returns {Date} */
function now() {
  return new Date(clock());
}

/**
 * Today's calendar date in an IANA zone, 'YYYY-MM-DD'.
 * @param {Date} at
 * @param {string} timeZone
 */
function localToday(at, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Days in a 1-based month of a year (UTC calendar, no time of day). */
function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * 'YYYY-MM-DD' minus N calendar months, the day clamped to the target month's
 * length. Throws on a malformed date — a caller passing garbage is a bug.
 * @param {string} ymd
 * @param {number} months  non-negative integer
 * @returns {string}
 */
function subtractMonths(ymd, months) {
  const m = YMD.exec(String(ymd));
  if (!m) throw new Error(`subtractMonths: not a YYYY-MM-DD date: ${ymd}`);
  if (!Number.isInteger(months) || months < 0) throw new Error(`subtractMonths: bad month count: ${months}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const total = y * 12 + (mo - 1) - months;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const td = Math.min(d, daysInMonth(ty, tm));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(ty, 4)}-${p(tm)}-${p(td)}`;
}

/**
 * The oldest planned date still inside an N-month window, as of `at` in
 * `timeZone`. A row is shown when its newest planned date is >= this.
 * @param {number} months
 * @param {Date} at
 * @param {string} timeZone
 */
function windowCutoff(months, at, timeZone) {
  return subtractMonths(localToday(at, timeZone), months);
}

/**
 * The age basis: the newest planned date among a row's procedures, or null
 * when none is dated (OD's '0001-01-01' was already turned into null by the
 * sync).
 * @param {Array<{ plannedDate?: string|null }>} procedures
 * @returns {string|null}
 */
function newestPlannedDate(procedures) {
  let best = null;
  for (const p of procedures || []) {
    const d = p && typeof p.plannedDate === 'string' && YMD.test(p.plannedDate) ? p.plannedDate : null;
    if (d && (best === null || d > best)) best = d;
  }
  return best;
}

/**
 * Parse the route's `maxAgeMonths` query value.
 *   absent / ''          → { ok: true, value: null }  (use the office window)
 *   an integer 1..24     → { ok: true, value: n }
 *   anything else        → { ok: false }               (the route 400s)
 * Strict digits only: "3.5", "3abc", "-1", "0x3", " 3" with junk all refuse.
 * @param {unknown} raw
 * @returns {{ ok: true, value: number|null } | { ok: false }}
 */
function parseMaxAgeMonths(raw) {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const s = raw.trim();
  if (s === '') return { ok: true, value: null };
  if (!/^\d{1,3}$/.test(s)) return { ok: false };
  const n = Number(s);
  if (n < OPPORTUNITIES_WINDOW_MIN_MONTHS || n > OPPORTUNITIES_WINDOW_MAX_MONTHS) return { ok: false };
  return { ok: true, value: n };
}

/**
 * The months the inbox actually applies.
 *
 * The chip narrows WITHIN the office window and never widens past it: rows
 * between the window and the 730-day capture horizon are the future
 * reactivation pool, whose UI is a later slice (item 43+). So a request for
 * 24 months at an 18-month office gets 18, and the response says so.
 *
 * Undated rows (no planned date on any procedure) have no age. They are shown
 * only at the full window — the sync kept them on purpose, and hiding them
 * outright would lose work silently — and never under a narrower chip, which
 * promises "planned in the last N months" and cannot prove it for them.
 *
 * @param {number} officeMonths
 * @param {number|null} requested
 * @returns {{ officeMonths: number, appliedMonths: number, includeUndated: boolean }}
 */
function resolveWindow(officeMonths, requested) {
  const applied = requested == null ? officeMonths : Math.min(requested, officeMonths);
  return { officeMonths, appliedMonths: applied, includeUndated: applied === officeMonths };
}

/**
 * The office's window from tc_library_config. No row, or a row that does not
 * parse against the contract, reads as the default — the same thing "no
 * setting" has always meant for every library section.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} q
 * @param {string} office
 * @returns {Promise<number>}
 */
async function readOfficeWindowMonths(q, office) {
  const res = await q.query(
    `SELECT value FROM tc_library_config WHERE office_id = $1 AND section = $2`,
    [office, SECTION]
  );
  if (!res.rows.length) return OPPORTUNITIES_WINDOW_DEFAULT_MONTHS;
  let value = res.rows[0].value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return OPPORTUNITIES_WINDOW_DEFAULT_MONTHS;
    }
  }
  const parsed = LibrarySectionSchemas[SECTION].safeParse(value);
  return parsed.success ? parsed.data.opportunitiesWindowMonths : OPPORTUNITIES_WINDOW_DEFAULT_MONTHS;
}

module.exports = {
  SECTION,
  DEFAULT_MONTHS: OPPORTUNITIES_WINDOW_DEFAULT_MONTHS,
  MIN_MONTHS: OPPORTUNITIES_WINDOW_MIN_MONTHS,
  MAX_MONTHS: OPPORTUNITIES_WINDOW_MAX_MONTHS,
  setClockForTests,
  now,
  localToday,
  subtractMonths,
  windowCutoff,
  newestPlannedDate,
  parseMaxAgeMonths,
  resolveWindow,
  readOfficeWindowMonths,
};
