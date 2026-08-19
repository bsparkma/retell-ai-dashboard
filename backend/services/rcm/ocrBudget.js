'use strict';

/**
 * The OCR cost breaker — Azure Document Intelligence pages, per day.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SECOND RAIL AND NOT A SHARE OF THE FIRST
 * ─────────────────────────────────────────────────────────────────────────────
 * `extractionBudget.js` guards ONE Azure OpenAI account's spend. This guards a
 * DIFFERENT resource, billed on a different meter, in a different unit. Putting
 * them on one counter would mean a morning of scanned faxes could silently eat
 * the money that reads the afternoon's digital EOBs — and the biller who got
 * stopped would be told "the daily cost cap is used up" without being able to
 * tell which cost, or what to do about it.
 *
 * So: two counters, two caps, two reset clocks, two `resetsAt` values, and two
 * distinct honest states. A stopped upload always names WHICH rail stopped it.
 *
 * Everything else is deliberately the SAME SHAPE as `extractionBudget.js`,
 * which is itself the shape of the voice transcription rail that closed a real
 * cost incident:
 *
 *   1. A PRIMARY GATE callers consult (`check()`) so they can stop cleanly.
 *   2. A HARD BACKSTOP at the point of spend (`assertAllowed()`), enforced even
 *      if a caller forgets.
 *   3. Accounting in the OFFICE'S LOCAL DAY, not UTC — DST-correct via Intl
 *      zone data, because a fixed -5/-6 offset is wrong half the year.
 *   4. PERSISTED, so a container restart cannot hand back a fresh cap.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT DIFFERS FROM THE LLM RAIL: PAGES ARE KNOWABLE IN ADVANCE
 * ─────────────────────────────────────────────────────────────────────────────
 * Tokens are only known from the response, so `extractionBudget` can gate
 * STARTING and must charge after the fact — one large document can overshoot.
 * A PDF's page count is known from the file itself before a single byte is sent
 * to Azure, so this rail refuses a document it cannot AFFORD IN FULL rather
 * than starting one and discovering the overrun. `check(pages)` is what makes
 * that possible; `check()` with no page count degrades to the same
 * start-gating the LLM rail does.
 *
 * The charge still lands from Document Intelligence's OWN reported page count,
 * not from the estimate — a PDF whose page tree lies, or an embedded multi-page
 * TIFF, must be billed for what actually ran.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CAP IS A SAFETY RAIL
 * ─────────────────────────────────────────────────────────────────────────────
 * There is no code path in this module that raises it, retries around it, or
 * splits a document to slip under it. Changing it is an env change made
 * deliberately by a person — the same do-not-raise culture as
 * MAX_TRANSCRIPTION_MINUTES_PER_DAY and RCM_EXTRACTION_MAX_CENTS_PER_DAY.
 *
 * SCOPE: process-wide and tenant-global, like the other two rails. It guards one
 * Document Intelligence resource's spend, and that resource is not per-office.
 *
 * Env:
 *   RCM_OCR_MAX_CENTS_PER_DAY   default 200 ($2.00). 0 = unlimited.
 *   RCM_OCR_BUDGET_TZ           default America/Chicago.
 *   RCM_OCR_CENTS_PER_KPAGE     default 150 — $1.50 per 1,000 pages, which is
 *                               the S0 list price of `prebuilt-read` in the
 *                               0–1M pages/month tier (verified against the
 *                               Azure retail price API, 2026-08-19). Per
 *                               THOUSAND pages, not per page, because a cent is
 *                               the smallest unit this module counts in and one
 *                               page costs a sixth of one.
 */

const { DurableState } = require('../durableState');

/**
 * $2.00/day, in integer cents.
 *
 * THE ARITHMETIC, so the number is arguable rather than arbitrary: at $1.50 per
 * 1,000 pages, $2.00 buys ~1,333 pages of OCR a day. Two dental offices posting
 * every scanned EOB they receive are nowhere near that — a heavy day is tens of
 * pages, not hundreds. The cap is sized to stop a RUNAWAY (a retry loop, a
 * mis-pointed queue, a 400-page PDF uploaded ten times), not to ration normal
 * work, which is the same brief the $10 extraction cap was written to.
 */
const DEFAULT_CAP_CENTS = 200;

/** The offices' local zone. Same default and same reason as the other rails. */
const DEFAULT_TIMEZONE = 'America/Chicago';

/**
 * `prebuilt-read`, S0, 0–1M pages/month: $1.50 per 1,000 pages.
 *
 * Env-tunable because switching the model changes it (`prebuilt-layout` is
 * $10.00 per 1,000 — see documentOcr.js for why we do not use it) and a wrong
 * rate here makes the breaker lie in one direction or the other.
 * Over-estimating is the safe direction: it trips early.
 */
const DEFAULT_CENTS_PER_KPAGE = 150;

/** Read a non-negative number from env, falling back rather than storing NaN. */
function envNumber(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

class OcrBudget {
  constructor() {
    /** Persisted across restarts — see the header. Its OWN document. */
    this._state = new DurableState('rcm_ocr_budget.json', { day_key: null, cents_used: 0 });
    this._loaded = false;
    /** @type {string|null} 'YYYY-MM-DD' in the budget timezone */
    this.dayKey = null;
    /** Integer cents spent so far today. */
    this.centsUsed = 0;
    /** Pages read today. Reported, never used as the accounting unit. */
    this.pagesRead = 0;
    /** Whether the "budget reached" line has been logged for this day. */
    this._trippedLogged = false;
  }

  /** Cap in cents. Read live so a restart-free env change is picked up in tests. */
  get capCents() {
    return Math.trunc(envNumber('RCM_OCR_MAX_CENTS_PER_DAY', DEFAULT_CAP_CENTS));
  }

  get timezone() {
    return process.env.RCM_OCR_BUDGET_TZ || DEFAULT_TIMEZONE;
  }

  /**
   * What `pages` pages cost, in integer cents, rounded UP.
   *
   * Rounded up for the same reason the LLM rail rounds up: fractions that round
   * DOWN accumulate into a budget that quietly outruns its cap, and the safe
   * direction for a rounding error in a cost rail is "trips slightly early".
   * A one-page document therefore costs 1¢ against a real price of 0.15¢ — the
   * cap is a rail, not an invoice, and it is documented as over-counting small
   * documents rather than pretending to be an accounting system.
   *
   * @param {number} pages
   * @returns {number} integer cents
   */
  costOfPages(pages) {
    const n = Number(pages);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const rate = envNumber('RCM_OCR_CENTS_PER_KPAGE', DEFAULT_CENTS_PER_KPAGE);
    return Math.ceil((Math.ceil(n) * rate) / 1000);
  }

  /**
   * Day key 'YYYY-MM-DD' in the budget timezone. DST-correct via Intl zone data
   * (en-CA formats as YYYY-MM-DD).
   * @param {Date} [now] injectable for tests
   */
  _todayKey(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }

  /** Load persisted accounting once per process (best-effort; never throws). */
  _load() {
    if (this._loaded) return;
    this._loaded = true;
    const doc = this._state.read();
    const key = typeof doc.day_key === 'string' ? doc.day_key : null;
    const used = Number(doc.cents_used);
    const pages = Number(doc.pages_read);
    if (key && Number.isFinite(used) && used >= 0) {
      this.dayKey = key;
      this.centsUsed = Math.trunc(used);
      this.pagesRead = Number.isFinite(pages) && pages >= 0 ? Math.trunc(pages) : 0;
    }
  }

  _save() {
    this._state.write({
      day_key: this.dayKey,
      cents_used: this.centsUsed,
      pages_read: this.pagesRead,
    });
  }

  /** Reset the counter when the LOCAL accounting day rolls over. */
  _rollIfNeeded(now = new Date()) {
    this._load();
    const today = this._todayKey(now);
    if (this.dayKey !== today) {
      this.dayKey = today;
      this.centsUsed = 0;
      this.pagesRead = 0;
      this._trippedLogged = false;
      this._save();
    }
  }

  /**
   * The instant the budget next rolls — the NEXT midnight in the budget zone.
   *
   * Same algorithm as `extractionBudget.nextResetIso`, itself ported from
   * `transcriptionService.nextBudgetResetIso`: jump by the remaining wall-clock
   * seconds of the local day, then re-read and correct, so a spring-forward /
   * fall-back day lands on midnight rather than 01:00 / 23:00.
   *
   * @param {Date} [now] injectable for tests
   * @returns {string} ISO-8601
   */
  nextResetIso(now = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.timezone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const localSeconds = (d) => {
      const [h, m, s] = fmt.format(d).split(':').map(Number);
      return h * 3600 + m * 60 + s;
    };
    const DAY = 24 * 3600;
    let ms = now.getTime() + (DAY - localSeconds(now)) * 1000;
    for (let i = 0; i < 3; i++) {
      const off = localSeconds(new Date(ms));
      if (off === 0) break;
      ms += (off > DAY / 2 ? DAY - off : -off) * 1000;
    }
    return new Date(ms).toISOString();
  }

  /**
   * THE PRIMARY GATE. Consulted before a document is sent to Azure, so a spent
   * budget costs zero round trips.
   *
   * Pass `pages` when you know how many the document has — the answer then means
   * "this WHOLE document fits in what is left today", which is the question a
   * per-page meter can actually answer. Without it the answer degrades to "there
   * is something left", which is all the token rail can ever say.
   *
   * @param {number|null} [pages] estimated page count, when known
   * @param {Date} [now] injectable for tests
   * @returns {{ allowed: boolean, usedCents: number, capCents: number,
   *             remainingCents: number, estimatedCents: number,
   *             resetsAt: string, dayKey: string }}
   */
  check(pages = null, now = new Date()) {
    this._rollIfNeeded(now);
    const cap = this.capCents;
    const estimatedCents = pages == null ? 0 : this.costOfPages(pages);
    const unlimited = cap <= 0;
    const allowed = unlimited
      ? true
      : pages == null
        ? this.centsUsed < cap
        : this.centsUsed + estimatedCents <= cap;
    return {
      allowed,
      usedCents: this.centsUsed,
      capCents: cap,
      remainingCents: unlimited ? Infinity : Math.max(0, cap - this.centsUsed),
      estimatedCents,
      resetsAt: this.nextResetIso(now),
      dayKey: this.dayKey,
    };
  }

  /**
   * THE HARD BACKSTOP. Throws `RCM_OCR_BUDGET_EXCEEDED` before a request is
   * built, even if a caller skipped `check()`. No code path spends without
   * passing through here.
   *
   * @param {number|null} [pages]
   * @param {Date} [now]
   */
  assertAllowed(pages = null, now = new Date()) {
    const state = this.check(pages, now);
    if (state.allowed) return state;
    if (!this._trippedLogged) {
      this._trippedLogged = true;
      console.warn(
        `⛔ RCM OCR daily budget reached ($${(state.usedCents / 100).toFixed(2)} of ` +
          `$${(state.capCents / 100).toFixed(2)} for ${state.dayKey} ${this.timezone}). ` +
          `Scanned documents are paused until ${state.resetsAt}; uploads still succeed and ` +
          'wait. Override with RCM_OCR_MAX_CENTS_PER_DAY. This is SEPARATE from the ' +
          'extraction cap (RCM_EXTRACTION_MAX_CENTS_PER_DAY).'
      );
    }
    const err = new Error(
      `Document reading (OCR) daily budget exceeded ($${(state.capCents / 100).toFixed(2)}/day)`
    );
    err.code = 'RCM_OCR_BUDGET_EXCEEDED';
    err.resetsAt = state.resetsAt;
    err.usedCents = state.usedCents;
    err.capCents = state.capCents;
    err.estimatedCents = state.estimatedCents;
    throw err;
  }

  /**
   * Charge a completed analysis by the page count DOCUMENT INTELLIGENCE
   * reported, not by whatever we estimated beforehand.
   *
   * @param {number} pages
   * @param {Date} [now]
   * @returns {{ chargedCents: number, usedCents: number, capCents: number, pages: number }}
   */
  charge(pages, now = new Date()) {
    this._rollIfNeeded(now);
    const n = Number.isFinite(Number(pages)) && Number(pages) > 0 ? Math.ceil(Number(pages)) : 0;
    const cents = this.costOfPages(n);
    this.centsUsed += cents;
    this.pagesRead += n;
    this._save();
    return { chargedCents: cents, usedCents: this.centsUsed, capCents: this.capCents, pages: n };
  }

  /**
   * Breaker state for the API to surface.
   *
   * `rail: 'ocr'` is in the payload deliberately: this object and the extraction
   * breaker's are the same SHAPE, they appear on the same screen, and a UI that
   * can only tell them apart by which key it read them from is one refactor away
   * from telling a biller the wrong cap stopped her.
   *
   * @param {Date} [now]
   */
  status(now = new Date()) {
    const s = this.check(null, now);
    return {
      rail: 'ocr',
      paused: !s.allowed,
      usedCents: s.usedCents,
      capCents: s.capCents,
      remainingCents: s.remainingCents === Infinity ? null : s.remainingCents,
      pagesRead: this.pagesRead,
      centsPerKPage: envNumber('RCM_OCR_CENTS_PER_KPAGE', DEFAULT_CENTS_PER_KPAGE),
      resetsAt: s.resetsAt,
      timezone: this.timezone,
      persisted: this._state.durable === true,
    };
  }

  /** Test seam — forget cached state so a suite can re-point CALLSTORE_DIR. */
  _resetForTests() {
    this._state.reset();
    this._loaded = false;
    this.dayKey = null;
    this.centsUsed = 0;
    this.pagesRead = 0;
    this._trippedLogged = false;
  }
}

/** One rail per process — see the SCOPE note in the header. */
module.exports = new OcrBudget();
module.exports.OcrBudget = OcrBudget;
module.exports.DEFAULT_CAP_CENTS = DEFAULT_CAP_CENTS;
module.exports.DEFAULT_CENTS_PER_KPAGE = DEFAULT_CENTS_PER_KPAGE;
