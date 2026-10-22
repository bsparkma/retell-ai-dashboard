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

module.exports = {
  addLocalDays,
  localDaysBetween,
  gapBefore,
  firstDueAt,
  dueAfter,
  capCheck,
  renderTouch,
};
