'use strict';

/**
 * The voice lab's OWN daily minute budget.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SEPARATE FROM THE CALL-TRANSCRIPTION BREAKER, BY CONSTRUCTION
 * ═════════════════════════════════════════════════════════════════════════════
 * `services/transcriptionService.js` owns the 120-minute/day breaker for call
 * recordings, persisted in `transcription_budget.json` and sized by
 * `MAX_TRANSCRIPTION_MINUTES_PER_DAY`. This file never requires that service,
 * never reads that env var, and never opens that doc. Its counter lives in its
 * own doc, `voicelab_budget.json`, sized by its own env var. Spending the lab
 * cannot starve call transcription and call transcription cannot starve the lab.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HOW IT METERS: A FIXED RESERVATION PER TOKEN
 * ═════════════════════════════════════════════════════════════════════════════
 * The backend never sees the audio, so it cannot count real minutes. Instead
 * each token mint RESERVES `SESSION_MINUTES` (10) up front. An Azure Speech
 * authorization token lives 10 minutes, and the lab page disarms itself before
 * its token expires, so one token can never stream more than 10 minutes. The
 * reservation is an upper bound on what the token can spend, not an estimate.
 *
 * A reservation must fit WHOLE: with the default cap of 30, the 4th mint of the
 * day is refused rather than granted a part-session.
 *
 * If the mint itself fails, the reservation is released; nothing was spent.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FAIL CLOSED
 * ═════════════════════════════════════════════════════════════════════════════
 * `VOICE_LAB_DAILY_MINUTES` unset or blank → 30. A positive number → that cap.
 * ZERO, a negative, or anything non-numeric → 0, which refuses every mint.
 * Note this is the OPPOSITE of the call breaker, where 0 means unlimited: the
 * lab has no "unlimited" setting.
 *
 * The day rolls at midnight America/Chicago (services/localDayClock.js).
 */

const { DurableState } = require('../durableState');
const { localDayKey, nextLocalMidnightIso } = require('../localDayClock');

const CAP_ENV = 'VOICE_LAB_DAILY_MINUTES';
const DEFAULT_CAP_MINUTES = 30;
const SESSION_MINUTES = 10;
const BUDGET_TIMEZONE = 'America/Chicago';
const STATE_FILE = 'voicelab_budget.json';

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function resolveCapMinutes(env) {
  const raw = env[CAP_ENV];
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_CAP_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

class VoiceLabBudget {
  /**
   * @param {{ env?: NodeJS.ProcessEnv, state?: DurableState, now?: () => Date }} [opts]
   */
  constructor({ env = process.env, state, now = () => new Date() } = {}) {
    this.capMinutes = resolveCapMinutes(env);
    this.state = state || new DurableState(STATE_FILE, { day_key: null, minutes_reserved: 0 });
    this.now = now;
  }

  /** Today's {dayKey, reserved}, rolled to zero when the local day has changed. */
  _today() {
    const dayKey = localDayKey(BUDGET_TIMEZONE, this.now());
    const doc = this.state.read();
    const reserved = Number(doc.minutes_reserved);
    if (doc.day_key !== dayKey || !Number.isFinite(reserved) || reserved < 0) {
      return { dayKey, reserved: 0 };
    }
    return { dayKey, reserved };
  }

  /**
   * @returns {{ usedMinutes: number, capMinutes: number, remainingMinutes: number, sessionMinutes: number, resetsAt: string }}
   */
  snapshot() {
    const { reserved } = this._today();
    return {
      usedMinutes: reserved,
      capMinutes: this.capMinutes,
      remainingMinutes: Math.max(0, this.capMinutes - reserved),
      sessionMinutes: SESSION_MINUTES,
      resetsAt: nextLocalMidnightIso(BUDGET_TIMEZONE, this.now()),
    };
  }

  /**
   * Reserve one session's minutes, or refuse if a whole session does not fit.
   *
   * @returns {{ ok: true, usedMinutes: number, capMinutes: number } |
   *           { ok: false, usedMinutes: number, capMinutes: number, resetsAt: string }}
   */
  reserve() {
    const { dayKey, reserved } = this._today();
    if (reserved + SESSION_MINUTES > this.capMinutes) {
      return {
        ok: false,
        usedMinutes: reserved,
        capMinutes: this.capMinutes,
        resetsAt: nextLocalMidnightIso(BUDGET_TIMEZONE, this.now()),
      };
    }
    const next = reserved + SESSION_MINUTES;
    this.state.write({ day_key: dayKey, minutes_reserved: next });
    return { ok: true, usedMinutes: next, capMinutes: this.capMinutes };
  }

  /** Give one session back — the mint failed, so nothing was spent. */
  release() {
    const { dayKey, reserved } = this._today();
    this.state.write({ day_key: dayKey, minutes_reserved: Math.max(0, reserved - SESSION_MINUTES) });
  }
}

module.exports = {
  VoiceLabBudget,
  resolveCapMinutes,
  CAP_ENV,
  DEFAULT_CAP_MINUTES,
  SESSION_MINUTES,
  BUDGET_TIMEZONE,
  STATE_FILE,
};
