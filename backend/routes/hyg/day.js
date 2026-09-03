'use strict';

/**
 * GET /api/hyg/day?office=<key>&date=YYYY-MM-DD — one office's hygiene day.
 *
 * The whole schedule for one day, in one pull, shaped for a screen a hygienist
 * reads standing at a chair. Read-only: there is no non-GET route in this
 * module and no write transport in reach of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ENDPOINT REFUSES TO DO
 * ─────────────────────────────────────────────────────────────────────────────
 * It never returns an empty day it is not sure about. Four different things can
 * go wrong before there is a day to show — the office is not one of ours, the
 * office is not switched on for hygiene, its Open Dental credentials are
 * missing, or Open Dental did not answer — and every one of them is a non-2xx
 * with a distinct code. `{ appointments: [] }` means, and only means, that
 * nobody is booked.
 *
 * That is not a stylistic preference. This screen's whole job is to tell
 * somebody what is about to happen to them all day; a blank one that means "we
 * could not reach your practice" is the single worst thing it could show.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OFFICE, AND WHY IT IS A QUERY PARAM HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * Platform law is "office comes from the call, never from a parameter" — but
 * that rule is about work that ORIGINATED somewhere (a phone call arrived on a
 * line; the line names the office). A day view has no origin: a hygienist is
 * asking to see a schedule. So office is an INPUT, validated server-side
 * against the frozen office list before anything else runs, and then used to
 * resolve that office's own Open Dental client through the registry. It is the
 * same shape /api/rcm and /api/tc use, for the same reason.
 *
 * What the caller may ASK for is bounded by entitlement and permission upstream;
 * what they may REACH is bounded by the registry. There is no value of `office`
 * that reads a database it does not name.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUDIT: ONE ROW PER PATIENT, NOT ONE PER REQUEST
 * ─────────────────────────────────────────────────────────────────────────────
 * Serving this endpoint discloses every patient on the day. A single
 * "somebody opened Tuesday" row cannot answer "whose chart was read on
 * Tuesday", which is the only question a HIPAA trail is ever asked. So the
 * successful path writes one `hyg_day_patient` row per PatNum served, plus one
 * `hyg_day` row for the request itself.
 *
 * Fail-closed: the audit writes happen BEFORE the response is sent, and an
 * audit failure 500s the request rather than serving PHI with no trail. Note
 * the ordering — the day is fetched from Open Dental first, so a failure to
 * audit does not also mean a failure to know what would have been disclosed.
 */

const express = require('express');

const { h, resolveHygOd, auditHygRead, auditHygDenial } = require('./helpers');
const odDay = require('../../services/hyg/odDay');

const router = express.Router();

/** Strict calendar-date shape. Open Dental takes `date=YYYY-MM-DD` and nothing else. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is `value` a real calendar date, not merely a well-shaped string?
 *
 * `2026-02-31` matches the regex and is not a day. Round-tripping through Date
 * is what catches it: JavaScript rolls the overflow forward to March 3rd, so
 * the formatted result differs from the input. Sending a rolled-over date to
 * Open Dental would return a DIFFERENT day's schedule under the heading the
 * caller asked for, which is worse than a refusal in the way that matters here.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isRealDate(value) {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}

router.get(
  '/',
  h(async (req, res) => {
    const office = req.hygOffice;

    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (!isRealDate(date)) {
      return res.status(400).json({
        success: false,
        error: 'date query param is required and must be a real calendar date (YYYY-MM-DD)',
        code: 'INVALID_DATE',
        office,
      });
    }

    // Office readiness BEFORE anything else. Unknown office, hygiene not
    // switched on here, switch on but no customer key — each has its own
    // `reason`, and none of them falls back to another practice's client.
    const resolved = resolveHygOd(office);
    if (!resolved.ok) {
      // Best effort, and UNAUTHORIZED rather than ERROR: the caller was refused
      // access to this office's day, and nothing was read.
      await auditHygDenial(req, 'hyg_day', date, { office, result: 'UNAUTHORIZED' });
      return res.status(resolved.status).json(resolved.body);
    }
    const od = resolved.od;

    // The ONLY transport this route can reach. apiGetRaw is a GET with no write
    // counterpart on the instance; `module: 'hyg'` is attribution only and buys
    // no priority on the shared per-credential throttle slot.
    const odGet = (path, params, opts) =>
      od.client.apiGetRaw(path, params, { ...(opts || {}), module: 'hyg' });

    let day;
    try {
      day = await odDay.readDay(odGet, { date });
    } catch (err) {
      console.error('[hyg/day] office=' + office + ' date=' + date + ' read threw');
      await auditHygDenial(req, 'hyg_day', date, { office, result: 'ERROR' });
      return res.status(502).json({
        success: false,
        error: 'Could not read the schedule from Open Dental',
        code: 'OD_READ_FAILED',
        office,
        date,
      });
    }

    if (!day.ok) {
      // Open Dental answered, and the answer was not a day. NOT an empty day.
      await auditHygDenial(req, 'hyg_day', date, { office, result: 'ERROR' });
      return res.status(502).json({
        success: false,
        error: 'Could not read the schedule from Open Dental',
        code: 'OD_READ_FAILED',
        office,
        date,
      });
    }

    // One row for the request, then one per patient disclosed. Both fail-closed:
    // an AuditError propagates to h() and becomes a 500 before anything is sent.
    await auditHygRead(req, 'hyg_day', { office, resourceId: date });
    for (const patNum of new Set(
      day.appointments.map((a) => a.patNum).filter((p) => p !== null)
    )) {
      await auditHygRead(req, 'hyg_day_patient', { office, resourceId: patNum });
    }

    return res.json({
      success: true,
      office,
      officeName: od.officeName,
      date,
      operatories: day.operatories,
      appointments: day.appointments,
      // What we could not fetch, in the caller's words. Empty means the day is
      // whole — which is a claim, not an absence of one.
      warnings: day.warnings,
      // Per flag: did we ask Open Dental, or does this slice not read it yet?
      // A null flag means "unknown" either way; this says which kind.
      flagSources: day.flagSources,
      // Appointments Open Dental returned for this date that are not visits:
      // broken, unscheduled, planned, patient notes. Reported rather than
      // silently dropped, so "my 2pm is missing" has an answer.
      excludedByStatus: day.excludedByStatus,
      // The SCHEDULE is incomplete: an appointment is missing and the screen
      // must say so. Distinct from patientNamesTruncated, which means every
      // appointment is here and some carry no name — see services/hyg/odDay.js.
      truncated: day.truncated,
      patientNamesTruncated: day.patientNamesTruncated,
    });
  })
);

module.exports = router;
