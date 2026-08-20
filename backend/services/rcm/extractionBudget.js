'use strict';

/**
 * The EOB extraction cost breaker (decision D-4) — $10 of Azure OpenAI per day.
 *
 * Deliberately the same shape as the voice transcription rail
 * (services/transcriptionService.js), because that rail was built after a real
 * cost incident and its shape is what closed it:
 *
 *   1. A PRIMARY GATE callers consult (`check()`) so they can stop cleanly.
 *   2. A HARD BACKSTOP at the point of spend (`assertAllowed()`), enforced even
 *      if a caller forgets — the transcription version says "even if a caller
 *      forgets", and the same sentence applies here.
 *   3. Accounting in the OFFICE'S LOCAL DAY, not UTC. UTC midnight is early
 *      evening in Central, so a UTC day rolls the budget mid-shift and spends
 *      tomorrow's money on tonight's uploads.
 *   4. PERSISTED, so a container restart cannot hand back a fresh $10. This is
 *      the exact failure the transcription counter had (diagnosis H11).
 *
 * WHAT DIFFERS: transcription bills by audio-minutes, which are known BEFORE the
 * call (you can measure the file). Tokens are not — they are only known from the
 * response. So the cap gates STARTING an extraction, and the charge lands after
 * the fact. One large document can therefore overshoot the cap by its own cost,
 * exactly as one long recording can. That is a stated property, not a bug: the
 * alternative is refusing every document we cannot price in advance, which is
 * all of them.
 *
 * THE CAP IS A SAFETY RAIL. There is no code path anywhere in this module that
 * raises it, retries around it, or splits a job to slip under it. Changing it is
 * an env change made deliberately by a person, with the same do-not-raise
 * culture as MAX_TRANSCRIPTION_MINUTES_PER_DAY.
 *
 * SCOPE: process-wide and tenant-global, like the transcription budget and the
 * Stedi poll cursor (RCM_SCHEMA §"Stedi poll cursor is TENANT-GLOBAL"). It
 * guards ONE Azure OpenAI account's spend, and that account is not per-office
 * or per-tenant. Splitting the rail per office would let two offices spend $20.
 *
 * Env:
 *   RCM_EXTRACTION_MAX_CENTS_PER_DAY   default 1000 ($10.00). 0 = unlimited.
 *   RCM_EXTRACTION_BUDGET_TZ           default America/Chicago.
 *   RCM_LLM_INPUT_CENTS_PER_MTOK       default 25  ($0.25 / 1M input tokens)
 *   RCM_LLM_OUTPUT_CENTS_PER_MTOK      default 200 ($2.00 / 1M output tokens)
 */

const { DurableState } = require('../durableState');
const { localDayKey, nextLocalMidnightIso } = require('../localDayClock');

/** $10.00, in integer cents. Money in this module is ALWAYS integer cents. */
const DEFAULT_CAP_CENTS = 1000;

/** The offices' local zone. Same default and same reason as the voice rail. */
const DEFAULT_TIMEZONE = 'America/Chicago';

/**
 * Price of the platform's Azure OpenAI deployment, in cents per MILLION tokens.
 * Defaults are the list price of the small GPT-class deployment the platform
 * runs (oai-carein-*); they are env-tunable because a deployment swap changes
 * them and a wrong rate here makes the breaker lie in one direction or the
 * other. Over-estimating is the safe direction — it trips early.
 */
const DEFAULT_INPUT_CENTS_PER_MTOK = 25;
const DEFAULT_OUTPUT_CENTS_PER_MTOK = 200;

/** Read a non-negative number from env, falling back rather than storing NaN. */
function envNumber(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

class ExtractionBudget {
  constructor() {
    /** Persisted across restarts — see the header. */
    this._state = new DurableState('rcm_extraction_budget.json', { day_key: null, cents_used: 0 });
    this._loaded = false;
    /** @type {string|null} 'YYYY-MM-DD' in the budget timezone */
    this.dayKey = null;
    /** Integer cents spent so far today. */
    this.centsUsed = 0;
    /** Whether the "budget reached" line has been logged for this day. */
    this._trippedLogged = false;
  }

  /** Cap in cents. Read live so a restart-free env change is picked up in tests. */
  get capCents() {
    return Math.trunc(envNumber('RCM_EXTRACTION_MAX_CENTS_PER_DAY', DEFAULT_CAP_CENTS));
  }

  get timezone() {
    return process.env.RCM_EXTRACTION_BUDGET_TZ || DEFAULT_TIMEZONE;
  }

  /**
   * Day key 'YYYY-MM-DD' in the budget timezone.
   *
   * The clock itself lives in `services/localDayClock.js` — three rails were
   * carrying three copies of it, so a DST fix had three places to land. This
   * rail keeps its own counters and cap; only the calendar is shared.
   *
   * @param {Date} [now] injectable for tests
   */
  _todayKey(now = new Date()) {
    return localDayKey(this.timezone, now);
  }

  /** Load persisted accounting once per process (best-effort; never throws). */
  _load() {
    if (this._loaded) return;
    this._loaded = true;
    const doc = this._state.read();
    const key = typeof doc.day_key === 'string' ? doc.day_key : null;
    const used = Number(doc.cents_used);
    if (key && Number.isFinite(used) && used >= 0) {
      this.dayKey = key;
      this.centsUsed = Math.trunc(used);
    }
  }

  _save() {
    this._state.write({ day_key: this.dayKey, cents_used: this.centsUsed });
  }

  /** Reset the counter when the LOCAL accounting day rolls over. */
  _rollIfNeeded(now = new Date()) {
    this._load();
    const today = this._todayKey(now);
    if (this.dayKey !== today) {
      this.dayKey = today;
      this.centsUsed = 0;
      this._trippedLogged = false;
      this._save();
    }
  }

  /**
   * The instant the budget next rolls — the NEXT midnight in the budget zone.
   * DST-correct; see `services/localDayClock.js` for why it iterates.
   * @param {Date} [now] injectable for tests
   * @returns {string} ISO-8601
   */
  nextResetIso(now = new Date()) {
    return nextLocalMidnightIso(this.timezone, now);
  }

  /**
   * THE PRIMARY GATE. Callers consult this before starting an extraction so a
   * spent budget costs zero round trips — the same reason the on-demand
   * transcription route checks before asking Mango for a recording.
   *
   * @param {Date} [now] injectable for tests
   * @returns {{ allowed: boolean, usedCents: number, capCents: number,
   *             remainingCents: number, resetsAt: string, dayKey: string }}
   */
  check(now = new Date()) {
    this._rollIfNeeded(now);
    const cap = this.capCents;
    const allowed = cap <= 0 || this.centsUsed < cap; // cap <= 0 => unlimited
    return {
      allowed,
      usedCents: this.centsUsed,
      capCents: cap,
      remainingCents: cap <= 0 ? Infinity : Math.max(0, cap - this.centsUsed),
      resetsAt: this.nextResetIso(now),
      dayKey: this.dayKey,
    };
  }

  /**
   * THE HARD BACKSTOP. Throws `RCM_EXTRACTION_BUDGET_EXCEEDED` before a request
   * is built, even if a caller skipped `check()`. No code path spends without
   * passing through here.
   * @param {Date} [now]
   */
  assertAllowed(now = new Date()) {
    const state = this.check(now);
    if (state.allowed) return state;
    if (!this._trippedLogged) {
      this._trippedLogged = true;
      console.warn(
        `⛔ RCM extraction daily budget reached ($${(state.usedCents / 100).toFixed(2)} of ` +
          `$${(state.capCents / 100).toFixed(2)} for ${state.dayKey} ${this.timezone}). ` +
          `Extraction is paused until ${state.resetsAt}; uploads still succeed and wait. ` +
          'Override with RCM_EXTRACTION_MAX_CENTS_PER_DAY.'
      );
    }
    const err = new Error(
      `EOB extraction daily budget exceeded ($${(state.capCents / 100).toFixed(2)}/day)`
    );
    err.code = 'RCM_EXTRACTION_BUDGET_EXCEEDED';
    err.resetsAt = state.resetsAt;
    err.usedCents = state.usedCents;
    err.capCents = state.capCents;
    throw err;
  }

  /**
   * Price a completed call and add it to the day's spend.
   *
   * Rounded UP to the cent: fractions of a cent that round DOWN accumulate into
   * a budget that quietly outruns its cap over hundreds of calls, and the safe
   * direction for a rounding error in a cost rail is "trips slightly early".
   *
   * @param {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }|null|undefined} usage
   * @param {Date} [now]
   * @returns {{ chargedCents: number, usedCents: number, capCents: number }}
   */
  charge(usage, now = new Date()) {
    this._rollIfNeeded(now);
    const inTok = Number(usage && usage.prompt_tokens) || 0;
    const outTok = Number(usage && usage.completion_tokens) || 0;
    const inRate = envNumber('RCM_LLM_INPUT_CENTS_PER_MTOK', DEFAULT_INPUT_CENTS_PER_MTOK);
    const outRate = envNumber('RCM_LLM_OUTPUT_CENTS_PER_MTOK', DEFAULT_OUTPUT_CENTS_PER_MTOK);
    const cents = Math.ceil((inTok * inRate + outTok * outRate) / 1_000_000);
    this.centsUsed += cents;
    this._save();
    return { chargedCents: cents, usedCents: this.centsUsed, capCents: this.capCents };
  }

  /**
   * Breaker state for the API to surface. `paused` is the honest word for what
   * a tripped breaker means to a user who just uploaded something: their file
   * is safe, extraction has not happened yet, and here is when it will.
   * @param {Date} [now]
   */
  status(now = new Date()) {
    const s = this.check(now);
    return {
      paused: !s.allowed,
      usedCents: s.usedCents,
      capCents: s.capCents,
      remainingCents: s.remainingCents === Infinity ? null : s.remainingCents,
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
    this._trippedLogged = false;
  }
}

/** One rail per process — see the SCOPE note in the header. */
module.exports = new ExtractionBudget();
module.exports.ExtractionBudget = ExtractionBudget;
module.exports.DEFAULT_CAP_CENTS = DEFAULT_CAP_CENTS;
