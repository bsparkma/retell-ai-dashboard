'use strict';

/**
 * Configuration for the hygiene morning warm (services/hygDayWarm.js).
 *
 * WHY A WARM EXISTS AT ALL. services/odPatientCache.js removes the cost of the
 * SECOND look at a day. It does nothing for the first one — and the first one
 * is a hygienist at 8am opening today's schedule, which is the load that
 * matters. Against a cold cache that is still one `GET /patients/{PatNum}` per
 * distinct patient at Open Dental's one-request-per-second-per-credential
 * throttle: forty-odd seconds of somebody standing at a chair waiting.
 *
 * So the warm pays that cost at an hour when nobody is waiting and the
 * credential is idle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SCHEDULE AND THE TTL ARE COUPLED, AND THE COUPLING IS TIGHT
 * ─────────────────────────────────────────────────────────────────────────────
 * The patient cache holds a record for five minutes (see §2 of
 * services/odPatientCache.js — it is short because a medical alert added
 * mid-morning must not be invisible on a chairside screen). A warm at time T
 * therefore helps loads in roughly [T, T + 5 minutes], and nothing after.
 *
 * That is why the default is 07:45 rather than the 6am a "morning warm" sounds
 * like: it is as close to the practice opening as "before it opens" allows. It
 * is also why this is a full cron expression rather than an hour — an operator
 * who needs a wider window can set HYG_WARM_SCHEDULE to a repeating one (a
 * step expression across hour 7 gives a pass every five minutes through the
 * pre-open hour), at the cost of re-reading every patient on every pass.
 *
 * **Do not close this gap by raising the cache TTL.** The TTL is a clinical
 * safety bound, not a performance knob. If a cold first load is still too slow
 * at a chair, the honest next lever is returning the schedule immediately and
 * filling names in progressively.
 */

const cron = require('node-cron');

/**
 * 07:45 in the office's own timezone — before an 8am open, and inside the
 * cache's five-minute window for the first person through the door. See the
 * header for why this is not 6am.
 */
const DEFAULT_SCHEDULE = '45 7 * * *';

/** Matches every other office-clock job in this codebase. */
const DEFAULT_TIMEZONE = 'America/Chicago';

/**
 * Cron expression for the warm.
 *
 * An unparseable override falls back to the default rather than leaving the job
 * unscheduled — the odHealth rule, not the `MANGO_SYNC_SCHEDULE` one. A typo
 * that silently disables a monitor is bad; a typo that silently disables a
 * performance warm is merely invisible, which is worse in a different way: the
 * screen would just be slow again and nobody would know why.
 *
 * @returns {string}
 */
function schedule() {
  const raw = String(process.env.HYG_WARM_SCHEDULE ?? '').trim();
  if (raw && cron.validate(raw)) return raw;
  if (raw) {
    console.warn(
      `[hygwarm] HYG_WARM_SCHEDULE '${raw}' is not a valid cron expression — using '${DEFAULT_SCHEDULE}'`
    );
  }
  return DEFAULT_SCHEDULE;
}

/**
 * The timezone the schedule is read in — the OFFICE's, not the container's.
 * Reuses `OFFICE_TIMEZONE` rather than inventing a second variable: this job's
 * whole point is to land before a practice opens its doors, which is a
 * wall-clock fact about that practice.
 * @returns {string}
 */
function timezone() {
  const raw = String(process.env.OFFICE_TIMEZONE ?? '').trim();
  return raw || DEFAULT_TIMEZONE;
}

/**
 * Is the warm switched on?
 *
 * Only the literal 'true' disables it, matching every other kill switch here
 * (`MANGO_SYNC_DISABLED`, `OPENDENTAL_WRITE_DISABLED`, `OD_HEALTH_CHECK_DISABLED`).
 *
 * Note that this switch is the SECOND gate, not the first: the warm only ever
 * touches offices whose `hygOdEnabled` flag is on, and that flag ships FALSE
 * everywhere. Leaving this unset on a dev box still warms nothing.
 *
 * @returns {boolean}
 */
function isEnabled() {
  return String(process.env.HYG_WARM_DISABLED ?? '').trim().toLowerCase() !== 'true';
}

module.exports = {
  DEFAULT_SCHEDULE,
  DEFAULT_TIMEZONE,
  schedule,
  timezone,
  isEnabled,
};
