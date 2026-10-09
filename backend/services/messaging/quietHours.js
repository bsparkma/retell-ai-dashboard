'use strict';

/**
 * SMS quiet hours: the server REFUSES a text between 21:00 and 08:00
 * America/Chicago (TCPA). A hard block with no override — there is no flag, no
 * env var, and no role that turns it off. Email is exempt.
 *
 * THE ZONE IS FIXED, NOT CONFIGURED. Both practices are in Central time, and a
 * timezone knob is exactly the kind of setting that gets "temporarily" pointed
 * somewhere convenient. If a practice outside Central ever joins, the honest
 * change is a per-office zone in the office registry, reviewed — not an env var.
 *
 * DST is handled by Intl, which knows the zone's rules; nothing here does
 * offset arithmetic. The boundary tests in quietHours.test.js run on both 2026
 * transition days.
 */

const QUIET_TZ = 'America/Chicago';
/** First quiet hour (inclusive), local. 21 = 9:00 PM. */
const QUIET_START_HOUR = 21;
/** First allowed hour (inclusive), local. 8 = 8:00 AM. */
const QUIET_END_HOUR = 8;

const HOUR_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: QUIET_TZ,
  hour: 'numeric',
  hourCycle: 'h23',
});

/**
 * The local hour (0-23) in America/Chicago at `now`.
 * @param {Date} now
 * @returns {number}
 */
function localHour(now) {
  let parts;
  try {
    parts = HOUR_FORMAT.formatToParts(now);
  } catch {
    return NaN; // an invalid Date throws RangeError; the caller fails closed
  }
  const part = parts.find((p) => p.type === 'hour');
  const h = part ? Number(part.value) : NaN;
  // Some ICU builds render midnight as "24" under h23; normalize defensively.
  return h === 24 ? 0 : h;
}

/**
 * Is `now` inside SMS quiet hours? 21:00:00 is quiet; 08:00:00 is not.
 * @param {Date} [now]
 * @returns {boolean}
 */
function isQuietHours(now = new Date()) {
  const h = localHour(now);
  if (!Number.isFinite(h)) return true; // cannot tell the time → fail closed
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/** The sentence the UI and the 403 both show. */
const QUIET_HOURS_MESSAGE =
  'Texts cannot be sent between 9:00 PM and 8:00 AM Central. Try again after 8:00 AM.';

module.exports = { QUIET_TZ, QUIET_START_HOUR, QUIET_END_HOUR, QUIET_HOURS_MESSAGE, localHour, isQuietHours };
