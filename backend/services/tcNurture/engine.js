'use strict';

/**
 * The nurture engine's PURE half (queue item 47): calendar math, the runtime
 * cap check, and rendering one touch into draft content. No database, no
 * clock of its own, no I/O — every function takes `now` and the zone.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DAYS, NOT MILLISECONDS
 * ═════════════════════════════════════════════════════════════════════════════
 * Schedules are day offsets ("ns2 on day 4"), and the generator runs once a
 * day (05:00 America/Chicago). So every due date is a LOCAL MIDNIGHT, reached
 * by stepping whole local days (DST-safe: services/localDayClock), and the
 * hard caps are counted in local days too:
 *
 *   48 hours apart      ⇔ the next touch is at least 2 local days after the last
 *   3 per rolling 7 days ⇔ at most 3 touches in any 7 consecutive local days
 *
 * Counting in days is what keeps a nightly run that starts at 05:00:40 one
 * night and 05:00:05 two nights later from deferring a lawful touch by a whole
 * day for being 35 seconds short of 48 hours.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO BACK-FILL, EVER
 * ═════════════════════════════════════════════════════════════════════════════
 * The next due date is always measured from when the LAST touch was actually
 * queued (or, on resume, from today), using the gap the preset intends between
 * those two touches. A night the generator did not run, a pause, a deferral by
 * a cap — none of them produces a burst of catch-up drafts later.
 */

const { localDayKey, nextLocalMidnightIso } = require('../localDayClock');
const cfg = require('../../config/tcNurture');
const contract = require('../../tc/contract.gen.cjs');
const { firstNameOf } = require('../messaging/templates');

const DAY_MS = 24 * 3600 * 1000;

/**
 * The instant `n` local days after `from`, at local midnight. n = 0 is `from`
 * itself (due immediately).
 * @param {string} tz
 * @param {Date} from
 * @param {number} n
 * @returns {Date}
 */
function addLocalDays(tz, from, n) {
  let at = new Date(from.getTime());
  for (let i = 0; i < n; i++) at = new Date(nextLocalMidnightIso(tz, at));
  return at;
}

/**
 * Whole local days from `a` to `b` (b − a), by calendar date in `tz`.
 * @param {string} tz
 * @param {Date} a
 * @param {Date} b
 */
function localDaysBetween(tz, a, b) {
  const ka = Date.parse(`${localDayKey(tz, a)}T00:00:00Z`);
  const kb = Date.parse(`${localDayKey(tz, b)}T00:00:00Z`);
  return Math.round((kb - ka) / DAY_MS);
}

/**
 * The preset gap, in days, between step `i - 1` and step `i` (step 0 counts
 * from enrollment day 0).
 * @param {readonly { day: number }[]} steps
 * @param {number} i
 */
function gapBefore(steps, i) {
  if (i < 0 || i >= steps.length) return null;
  return steps[i].day - (i > 0 ? steps[i - 1].day : 0);
}

/**
 * When the FIRST touch of a new enrollment is due.
 * @param {string} tz @param {Date} enrolledAt @param {readonly { day: number }[]} steps
 * @returns {Date|null}
 */
function firstDueAt(tz, enrolledAt, steps) {
  if (!steps.length) return null;
  return addLocalDays(tz, enrolledAt, steps[0].day);
}

/**
 * When step `nextIndex` is due, measured from `from` (the instant the
 * previous touch was queued, or "now" on resume). null = nothing left.
 * @param {string} tz @param {Date} from @param {readonly { day: number }[]} steps @param {number} nextIndex
 * @returns {Date|null}
 */
function dueAfter(tz, from, steps, nextIndex) {
  const gap = gapBefore(steps, nextIndex);
  if (gap == null) return null;
  return addLocalDays(tz, from, gap);
}

/**
 * THE RUNTIME CAP CHECK — defence in depth behind the boot assertion. Given
 * the instants this enrollment's touches were already queued, may one more be
 * queued `now`?
 *
 * @param {{ tz: string, now: Date, priorTouches: Date[] }} input
 * @returns {{ ok: true } | { ok: false, code: 'MAX_PER_ENROLLMENT' } |
 *           { ok: false, code: 'MIN_GAP'|'MAX_PER_7_DAYS', deferUntil: Date }}
 */
function capCheck({ tz, now, priorTouches }) {
  const caps = cfg.CAPS;
  if (priorTouches.length >= caps.maxTouchesPerEnrollment) return { ok: false, code: 'MAX_PER_ENROLLMENT' };
  const minDays = caps.minHoursBetweenTouches / 24;
  const sorted = priorTouches.slice().sort((a, b) => a.getTime() - b.getTime());
  const last = sorted[sorted.length - 1];
  if (last && localDaysBetween(tz, last, now) < minDays) {
    return { ok: false, code: 'MIN_GAP', deferUntil: addLocalDays(tz, last, minDays) };
  }
  // The 7 local days ending today: today and the six before it.
  const inWindow = sorted.filter((t) => localDaysBetween(tz, t, now) <= 6);
  if (inWindow.length >= caps.maxTouchesPer7Days) {
    // The window opens again the day the oldest of them falls out of it.
    return { ok: false, code: 'MAX_PER_7_DAYS', deferUntil: addLocalDays(tz, inWindow[0], 7) };
  }
  return { ok: true };
}

/** HTML-escape plain copy for an email text block. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render one touch into draft content. Only the patient's FIRST name, the
 * office's display name and the office's phone are filled in — from the case
 * row and config, never from Open Dental.
 *
 * SMS: `withStopSuffix` appends "Reply STOP to opt out." when the copy does not
 * already end with it. The generator passes true for every SMS until one from
 * this enrollment has actually gone out, so the FIRST text a patient receives
 * always carries it — even when the first SMS in the schedule is a touch whose
 * approved copy has no suffix (warm_followup/gentle opens with wf3), and even
 * when an earlier SMS draft was skipped rather than sent.
 *
 * Email: a two-block snapshot (the copy as a text block, the CTA as a button
 * that dials the office) in the item-40 email_blocks shape, so the CTA renders
 * as a real button inside #231's compliant shell. With no office phone
 * configured there is nothing honest for the button to do, so it is left out
 * and the copy (which already says to call or reply) stands alone.
 *
 * @param {{ trackKey: string, touchKey: string, patientName: string|null,
 *           merge: { officeName: string, officePhone: string, telHref: string|null },
 *           withStopSuffix: boolean }} input
 * @returns {{ channel: 'sms'|'email', body: string, subject: string|null,
 *             emailBlocks: object[]|null, ctaOmitted: boolean }}
 */
function renderTouch({ trackKey, touchKey, patientName, merge, withStopSuffix }) {
  const touch = cfg.touch(trackKey, touchKey);
  const values = {
    firstName: firstNameOf(patientName) || 'there',
    officeName: merge.officeName,
    officePhone: merge.officePhone,
  };
  const body = contract.fillNurtureCopy(touch.body, values);
  if (touch.channel === 'sms') {
    const suffix = cfg.SMS_STOP_SUFFIX;
    const needs = withStopSuffix && !body.trimEnd().endsWith(suffix);
    return {
      channel: 'sms',
      body: needs ? `${body.trimEnd()} ${suffix}` : body,
      subject: null,
      emailBlocks: null,
      ctaOmitted: false,
    };
  }
  const subject = contract.fillNurtureCopy(touch.subject, values).slice(0, 300);
  const blocks = [
    contract.EmailBlock.parse({
      id: 'nurture-copy',
      type: 'text',
      html: `<p>${escapeHtml(body)}</p>`,
    }),
  ];
  const ctaOmitted = !merge.telHref;
  if (merge.telHref) {
    blocks.push(
      contract.EmailBlock.parse({
        id: 'nurture-cta',
        type: 'button',
        label: touch.cta.slice(0, 60),
        href: merge.telHref,
      })
    );
  }
  const text = ctaOmitted ? body : `${body}\n\n${touch.cta}: ${merge.officePhone}`;
  return { channel: 'email', body: text.slice(0, 8000), subject, emailBlocks: blocks, ctaOmitted };
}

// ── EL-2c: planned send times for a library campaign ───────────────────────
//
// A library campaign is written IN FULL at Start (and #359-era campaigns are
// caught up by the nightly pass), so every email gets a planned send time:
//
//   1. enrollment day + the step's day, at 10:00 office time — and, for every
//      email after the first, never earlier than the PLACED local day of the
//      email before it plus the sequence's gap (day_j − day_(j−1)), at 10:00.
//      So when the window or a cap pushes one email later, every later email
//      moves with it: a gap is never SHORTER than the sequence's gap in local
//      days (it may be longer).
//   2. outside Mon–Fri 09:00–16:00 office time → the next opening of the window
//   3. the hard caps, re-checked with capCheck above (the existing cap logic,
//      counted in local days) against every email already placed; a violation
//      moves the email to the day capCheck names (at 10:00, then step 2 again),
//      and every later email is placed after it — so later steps only ever
//      move LATER. Nothing is planned earlier than the sequence says.
//
// Pure: no database, no clock of its own. Nothing here sends; a planned time
// is a date on a draft, and EL-2c has no sender.

const WINDOW = contract.NURTURE_SEND_WINDOW;
const MINUTE_MS = 60 * 1000;

/** @type {Map<string, Intl.DateTimeFormat>} */
const partsFormatters = new Map();
const WEEKDAY = Object.freeze({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 });

/**
 * The wall clock of an instant in `tz`.
 * @param {string} tz @param {Date} d
 * @returns {{ ymd: string, minute: number, second: number, weekday: number }}
 */
function localParts(tz, d) {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsFormatters.set(tz, f);
  }
  /** @type {Record<string, string>} */
  const p = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAY[/** @type {keyof typeof WEEKDAY} */ (p.weekday)],
  };
}

/** 'YYYY-MM-DD' + n calendar days. @param {string} ymd @param {number} n */
function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** ISO weekday (1 = Mon … 7 = Sun) of a calendar date. @param {string} ymd */
function weekdayOfYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

/**
 * The instant a local wall-clock time names in `tz` (DST-safe: the offset is
 * found by asking Intl, then corrected once more for a boundary).
 * @param {string} tz @param {string} ymd @param {number} minute minutes after local midnight
 * @returns {Date}
 */
function localInstant(tz, ymd, minute) {
  const [y, m, d] = ymd.split('-').map(Number);
  const want = Date.UTC(y, m - 1, d, 0, minute);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(tz, new Date(guess));
    const [gy, gm, gd] = p.ymd.split('-').map(Number);
    const got = Date.UTC(gy, gm - 1, gd, 0, p.minute);
    if (got === want) break;
    guess += want - got;
  }
  return new Date(guess);
}

/** 10:00 office time on a local calendar date. @param {string} tz @param {string} ymd */
function plannedAtOn(tz, ymd) {
  return localInstant(tz, ymd, WINDOW.plannedMinute);
}

/** Is `t` inside Mon–Fri 09:00–16:00 office time (both ends allowed)? @param {string} tz @param {Date} t */
function isInSendWindow(tz, t) {
  const p = localParts(tz, t);
  if (!WINDOW.weekdays.includes(/** @type {any} */ (p.weekday))) return false;
  const at = p.minute + p.second / 60;
  return at >= WINDOW.startMinute && at <= WINDOW.endMinute;
}

/**
 * The earliest allowed instant at or after `t`: `t` itself when it is inside
 * the window, otherwise the next 09:00 on a weekday.
 * @param {string} tz @param {Date} t
 * @returns {Date}
 */
function nextAllowedSlot(tz, t) {
  if (isInSendWindow(tz, t)) return t;
  const p = localParts(tz, t);
  if (WINDOW.weekdays.includes(/** @type {any} */ (p.weekday)) && p.minute < WINDOW.startMinute) {
    return localInstant(tz, p.ymd, WINDOW.startMinute);
  }
  let ymd = addDaysYmd(p.ymd, 1);
  while (!WINDOW.weekdays.includes(/** @type {any} */ (weekdayOfYmd(ymd)))) ymd = addDaysYmd(ymd, 1);
  return localInstant(tz, ymd, WINDOW.startMinute);
}

class PlanError extends Error {
  /** @param {'MAX_PER_ENROLLMENT'} code */
  constructor(code) {
    super(`[tcNurture] cannot plan: ${code}`);
    this.name = 'PlanError';
    this.code = code;
  }
}

/**
 * Place emails in SEQUENCE order. Each starts from its `base` (never earlier
 * than `notBefore`, never at or before the email placed just before it). When
 * `days` (the step day of each base) is given, email j is also never earlier
 * than the placed local day of email j−1 plus (days[j] − days[j−1]) days, at
 * 10:00 — THE SEQUENCE-GAP RULE: a gap is never shorter than the sequence's
 * gap in local days. Then the send window, then the hard caps — `fixed`
 * (emails already out or already placed elsewhere) plus every email placed so
 * far — moving later until capCheck passes. Emails only ever move later.
 *
 * The rule lives HERE rather than in planCampaign/replanForward because it
 * depends on where the previous email was actually PLACED (after its window
 * and cap moves), which only this loop knows. Both production callers pass
 * `days`; only the direct cap-logic unit tests call it without.
 * @param {{ tz: string, bases: Date[], days?: readonly number[]|null, fixed?: Date[], notBefore?: Date|null }} input
 * @returns {Date[]} one planned time per base, strictly increasing
 */
function planTimes({ tz, bases, days = null, fixed = [], notBefore = null }) {
  if (days && days.length !== bases.length) throw new Error('[tcNurture] planTimes: days and bases differ in length');
  /** @type {Date[]} */
  const placed = [];
  for (let j = 0; j < bases.length; j++) {
    let cand = bases[j];
    if (notBefore && cand.getTime() < notBefore.getTime()) cand = notBefore;
    const prev = placed[placed.length - 1];
    if (prev && days) {
      const gap = Math.max(0, days[j] - days[j - 1]);
      const floor = plannedAtOn(tz, addDaysYmd(localDayKey(tz, prev), gap));
      if (cand.getTime() < floor.getTime()) cand = floor;
    }
    if (prev && cand.getTime() <= prev.getTime()) cand = new Date(prev.getTime() + MINUTE_MS);
    cand = nextAllowedSlot(tz, cand);
    // Each pass moves at least one local day later; 400 days is far beyond any
    // lawful sequence, so hitting the guard is a bug, not a schedule.
    for (let guard = 0; ; guard++) {
      if (guard > 400) throw new Error('[tcNurture] planTimes did not converge');
      const r = capCheck({ tz, now: cand, priorTouches: [...fixed, ...placed] });
      if (r.ok) break;
      if (r.code === 'MAX_PER_ENROLLMENT') throw new PlanError('MAX_PER_ENROLLMENT');
      cand = nextAllowedSlot(tz, plannedAtOn(tz, localDayKey(tz, r.deferUntil)));
    }
    placed.push(cand);
  }
  return placed;
}

/**
 * The planned times for a campaign written in full at Start: step i at
 * `enrolledAt`'s local day + steps[i].day, 10:00, then the window and caps.
 * Nothing before `enrolledAt` itself.
 * @param {{ tz: string, enrolledAt: Date, steps: readonly { day: number }[] }} input
 * @returns {Date[]}
 */
function planCampaign({ tz, enrolledAt, steps }) {
  const day0 = localDayKey(tz, enrolledAt);
  return planTimes({
    tz,
    bases: steps.map((s) => plannedAtOn(tz, addDaysYmd(day0, s.day))),
    days: steps.map((s) => s.day),
    notBefore: enrolledAt,
  });
}

/**
 * RE-PLAN FORWARD (Resume, a late approval, the #359 catch-up). `pending` are a
 * campaign's waiting emails in SEQUENCE order, each with its step `day` and its
 * planned `time` (null = never planned). When the first one's time is past (or
 * null), all of them are re-anchored on today: email j at today + (day_j −
 * day_0), 10:00, never earlier than its current planned time and never before
 * `now`; planTimes then chains each email on the PLACED day of the one before
 * (the sequence-gap rule), so when the first is pushed past tonight or the
 * weekend the rest move with it — their order and gaps are kept and nothing is
 * bunched — and the window and caps place them, counted against `fixed` (what
 * already went out). Returns null when nothing is late (nothing moves).
 * @param {{ tz: string, now: Date, pending: Array<{ day: number, time: Date|null }>, fixed?: Date[] }} input
 * @returns {Date[]|null}
 */
function replanForward({ tz, now, pending, fixed = [] }) {
  if (!pending.length) return null;
  const first = pending[0];
  if (first.time && first.time.getTime() >= now.getTime()) return null;
  const today = localDayKey(tz, now);
  const bases = pending.map((p) => {
    const anchored = plannedAtOn(tz, addDaysYmd(today, p.day - first.day));
    return p.time && p.time.getTime() > anchored.getTime() ? p.time : anchored;
  });
  return planTimes({ tz, bases, days: pending.map((p) => p.day), fixed, notBefore: now });
}

/** The rule a cap code names, in words a person reads. */
const CAP_RULE = Object.freeze({
  MIN_GAP: `at least ${cfg.CAPS.minHoursBetweenTouches} hours between two emails of a campaign`,
  MAX_PER_7_DAYS: `at most ${cfg.CAPS.maxTouchesPer7Days} emails in any 7 days`,
  MAX_PER_ENROLLMENT: `at most ${cfg.CAPS.maxTouchesPerEnrollment} emails in one campaign`,
});

/**
 * The first hard-cap violation in a set of send times, by the existing cap
 * logic (capCheck at each time against the ones before it), or null.
 * @param {string} tz @param {Date[]} times
 * @returns {{ code: 'MIN_GAP'|'MAX_PER_7_DAYS'|'MAX_PER_ENROLLMENT', rule: string } | null}
 */
function capViolation(tz, times) {
  const sorted = times.slice().sort((a, b) => a.getTime() - b.getTime());
  for (let i = 0; i < sorted.length; i++) {
    const r = capCheck({ tz, now: sorted[i], priorTouches: sorted.slice(0, i) });
    if (!r.ok) return { code: r.code, rule: CAP_RULE[r.code] };
  }
  return null;
}

module.exports = {
  addLocalDays,
  localDaysBetween,
  gapBefore,
  firstDueAt,
  dueAfter,
  capCheck,
  renderTouch,
  // EL-2c
  localParts,
  localInstant,
  addDaysYmd,
  plannedAtOn,
  isInSendWindow,
  nextAllowedSlot,
  planTimes,
  planCampaign,
  replanForward,
  capViolation,
  CAP_RULE,
  PlanError,
};
