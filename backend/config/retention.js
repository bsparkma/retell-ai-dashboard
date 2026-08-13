'use strict';

/**
 * Call-store retention configuration.
 *
 * Read LAZILY (functions, not a frozen object literal) so a test — and an ops
 * change on a running container — sees the current environment rather than
 * whatever it was at require time. Same reason middleware/envGuards.js is shaped
 * this way.
 *
 * Every knob fails toward the SAFE direction: a typo in the day count keeps the
 * default rather than pruning everything, and a typo in the cron keeps the
 * default rather than silently never running. (`MANGO_SYNC_SCHEDULE` has the
 * opposite behaviour — an invalid cron there makes the sync quietly never fire —
 * and that is precisely the trap not to repeat for a job that deletes data.)
 */

const cron = require('node-cron');

/** Days a call keeps its full record before being reduced to an audit stub. */
const DEFAULT_RETENTION_DAYS = 30;
/** 3:30am on office time — after the late-evening calls, before the morning huddle. */
const DEFAULT_SCHEDULE = '30 3 * * *';
/** Office day boundaries. Distinct from TRANSCRIPTION_BUDGET_TZ by design. */
const DEFAULT_TIMEZONE = 'America/Chicago';

/**
 * How many days a call keeps its content.
 *
 * `0` is a real value meaning "never prune" — the kill switch. Anything that is
 * not a non-negative integer (a typo, an empty string, '30d') falls back to the
 * default, because a NaN here would make every comparison false and turn
 * retention off without saying so.
 *
 * @returns {number}
 */
function retentionDays() {
  const raw = String(process.env.CALL_RETENTION_DAYS ?? '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_RETENTION_DAYS;
  return Number.parseInt(raw, 10);
}

/** Is pruning switched on at all? @returns {boolean} */
function isEnabled() {
  return retentionDays() > 0;
}

/**
 * Cron expression for the nightly prune. An unparseable override falls back to
 * the default rather than leaving the job unscheduled.
 * @returns {string}
 */
function schedule() {
  const raw = String(process.env.CALL_RETENTION_SCHEDULE ?? '').trim();
  if (raw && cron.validate(raw)) return raw;
  return DEFAULT_SCHEDULE;
}

/**
 * The timezone the schedule is interpreted in — the OFFICE's, not the
 * container's. Passed explicitly to node-cron so the job does not depend on a
 * container-level TZ app setting being present.
 * @returns {string}
 */
function timezone() {
  const raw = String(process.env.OFFICE_TIMEZONE ?? '').trim();
  return raw || DEFAULT_TIMEZONE;
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SCHEDULE,
  DEFAULT_TIMEZONE,
  retentionDays,
  isEnabled,
  schedule,
  timezone,
};
