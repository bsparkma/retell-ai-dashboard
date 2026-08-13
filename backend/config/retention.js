'use strict';

/**
 * Call-store retention configuration.
 *
 * WHERE THE WINDOW LIVES (Platform Console, PR C). Three sources, in strict
 * precedence order:
 *
 *     platform_setting['call_retention_days']   ← the console writes this
 *       ↓ (no row)
 *     CALL_RETENTION_DAYS                       ← the environment
 *       ↓ (unset or malformed)
 *     30                                        ← DEFAULT_RETENTION_DAYS
 *
 * The environment variable did NOT become dead when the DB setting arrived: the
 * migration deliberately seeds no row, so an environment the console has never
 * touched behaves exactly as it did before. That is also why the absence of a
 * row is a value here rather than an error.
 *
 * WHY THE PUBLIC API IS STILL SYNCHRONOUS. `retentionDays()` is read from
 * scheduler start-up, from getStatus(), and from inside the prune. Making it
 * async would thread a promise through all of that for a number that changes
 * roughly never. Instead the DB value is cached in this module and refreshed
 * EXPLICITLY — at boot, immediately before every prune (scheduled or manual),
 * and after every console write. So the pruner reads the current policy at run
 * time rather than a boot-time snapshot, which is the whole point.
 *
 * THE TWO FAILURE DIRECTIONS ARE DIFFERENT, ON PURPOSE:
 *
 *   - Control DB unreachable, but a value WAS loaded earlier → keep using it.
 *     A database blip must not change what gets destroyed tonight.
 *   - Control DB never reachable since boot → `policyKnown()` is false and the
 *     scheduler REFUSES TO PRUNE. We cannot rule out a stored row saying 90
 *     while the environment says 30, and the difference is 60 days of records.
 *     A job that destroys data does not get to guess its own policy.
 *
 * Everything else still fails toward the safe direction: a typo in the day
 * count keeps the default rather than pruning everything, and a typo in the
 * cron keeps the default rather than silently never running.
 * (`MANGO_SYNC_SCHEDULE` has the opposite behaviour — an invalid cron there
 * makes the sync quietly never fire — and that is precisely the trap not to
 * repeat for a job that deletes data.)
 */

const cron = require('node-cron');
const registry = require('../platform/registry');

/** Days a call keeps its full record before being reduced to an audit stub. */
const DEFAULT_RETENTION_DAYS = 30;
/** 3:30am on office time — after the late-evening calls, before the morning huddle. */
const DEFAULT_SCHEDULE = '30 3 * * *';
/** Office day boundaries. Distinct from TRANSCRIPTION_BUDGET_TZ by design. */
const DEFAULT_TIMEZONE = 'America/Chicago';

/** The platform_setting key the window is stored under. */
const SETTING_KEY = 'call_retention_days';

/**
 * The windows the CONSOLE offers. Deliberately a short list of round numbers: a
 * retention policy is a decision somebody has to be able to state in a
 * sentence, and a freeform box invites 31 and 45 and 29.
 *
 * This constrains the API and the UI, NOT the database. A runbook writing 45 —
 * or 0, the kill switch — directly into platform_setting is honoured by
 * `retentionDays()` below, because the stored row is the policy and this list
 * is only what a click may choose. `isAllowedConsoleDays()` is what the route
 * enforces.
 *
 * @type {ReadonlyArray<number>}
 */
const CONSOLE_RETENTION_DAYS = Object.freeze([30, 60, 90]);

/**
 * The cached view of the database row.
 *
 * `loaded` records whether we have EVER read the control DB successfully, which
 * is a different question from whether a row exists — `{loaded: true, days: null}`
 * means "asked, and nobody has chosen", the state that hands control to the
 * environment.
 *
 * @type {{ loaded: boolean, days: number|null, updatedAt: string|null, updatedBy: string|null }}
 */
let cache = { loaded: false, days: null, updatedAt: null, updatedBy: null };

/**
 * Parse a stored or environment day count.
 *
 * Accepts a non-negative integer, as a number or a digit string, and nothing
 * else. `0` is a real value meaning "never prune" — the kill switch. A NaN here
 * would make every comparison false and turn retention off without saying so,
 * which is why anything else answers null and lets the caller fall through to
 * the next source.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseDays(raw) {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
  }
  return null;
}

/**
 * The window the ENVIRONMENT asks for, ignoring the database entirely.
 *
 * Exported so the console can show the precedence honestly — "the database says
 * 60, and CALL_RETENTION_DAYS says 30" is the kind of thing an operator needs
 * to see before concluding the setting did not take.
 *
 * @returns {number}
 */
function envRetentionDays() {
  const parsed = parseDays(process.env.CALL_RETENTION_DAYS);
  return parsed === null ? DEFAULT_RETENTION_DAYS : parsed;
}

/** Is CALL_RETENTION_DAYS set to something this module could use? @returns {boolean} */
function envRetentionDaysIsSet() {
  return parseDays(process.env.CALL_RETENTION_DAYS) !== null;
}

/**
 * How many days a call keeps its content, under the precedence above.
 * @returns {number}
 */
function retentionDays() {
  if (cache.loaded && cache.days !== null) return cache.days;
  return envRetentionDays();
}

/** Which source `retentionDays()` just answered from. @returns {'db'|'env'|'default'} */
function retentionSource() {
  if (cache.loaded && cache.days !== null) return 'db';
  return envRetentionDaysIsSet() ? 'env' : 'default';
}

/**
 * Has the control DB been read successfully at least once since boot?
 *
 * The scheduler's licence to destroy records. False means we do not know
 * whether a stored policy disagrees with the environment, and the honest
 * response to that is to do nothing.
 *
 * @returns {boolean}
 */
function policyKnown() {
  return cache.loaded;
}

/**
 * Re-read the stored window from the control DB.
 *
 * NEVER THROWS. It is called from a cron handler and from request paths that
 * have their own error reporting; an exception here would either take down a
 * scheduled job or turn a settings page into a 500 over a transient blip. A
 * failed refresh leaves the previous cache in place — see the two failure
 * directions in the header.
 *
 * A row holding a value this module cannot parse is treated as ABSENT and
 * logged loudly: falling through to the environment is defined behaviour,
 * whereas pruning on a value we did not understand is not.
 *
 * @returns {Promise<{ ok: boolean, days: number|null, source: string, error: string|null }>}
 */
async function refreshFromDb() {
  try {
    const row = await registry.getPlatformSetting(SETTING_KEY);
    if (!row) {
      cache = { loaded: true, days: null, updatedAt: null, updatedBy: null };
      return { ok: true, days: null, source: retentionSource(), error: null };
    }

    const days = parseDays(row.value);
    if (days === null) {
      console.warn(
        `[retention] platform_setting['${SETTING_KEY}'] holds an unusable value ` +
          `(${JSON.stringify(row.value)}) — ignoring it and falling back to the environment`
      );
      cache = { loaded: true, days: null, updatedAt: null, updatedBy: null };
      return { ok: true, days: null, source: retentionSource(), error: null };
    }

    cache = {
      loaded: true,
      days,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row.updated_by || null,
    };
    return { ok: true, days, source: 'db', error: null };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`[retention] could not read the stored window: ${message}`);
    return { ok: false, days: cache.days, source: retentionSource(), error: message };
  }
}

/** May the console store this value? @param {unknown} days @returns {boolean} */
function isAllowedConsoleDays(days) {
  return typeof days === 'number' && CONSOLE_RETENTION_DAYS.includes(days);
}

/**
 * Store a new window and adopt it immediately.
 *
 * The cache is refreshed FROM THE DATABASE rather than set from the argument,
 * so what the console reports back is what was actually persisted. A write that
 * succeeded and a write we merely believe succeeded must not look the same.
 *
 * @param {number} days one of CONSOLE_RETENTION_DAYS
 * @param {string|null} [updatedBy] actor email
 * @returns {Promise<{ days: number, updatedAt: string|null, updatedBy: string|null }>}
 * @throws {Error & { code?: string }} when `days` is not an offered window, or the write fails
 */
async function persistRetentionDays(days, updatedBy = null) {
  if (!isAllowedConsoleDays(days)) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`retention window must be one of: ${CONSOLE_RETENTION_DAYS.join(', ')}`)
    );
    err.code = 'INVALID_RETENTION_DAYS';
    throw err;
  }

  await registry.setPlatformSetting(SETTING_KEY, days, updatedBy);

  const refreshed = await refreshFromDb();
  if (!refreshed.ok) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`stored the window but could not read it back: ${refreshed.error}`)
    );
    err.code = 'RETENTION_READBACK_FAILED';
    throw err;
  }

  return { days: retentionDays(), updatedAt: cache.updatedAt, updatedBy: cache.updatedBy };
}

/** Is pruning switched on at all? @returns {boolean} */
function isEnabled() {
  return retentionDays() > 0;
}

/**
 * Everything the console needs to render the panel honestly, including WHY the
 * effective value is what it is.
 *
 * @returns {{ days: number, source: 'db'|'env'|'default', enabled: boolean,
 *             policyKnown: boolean, dbDays: number|null, envDays: number,
 *             envDaysIsSet: boolean, options: ReadonlyArray<number>,
 *             updatedAt: string|null, updatedBy: string|null }}
 */
function policyState() {
  return {
    days: retentionDays(),
    source: retentionSource(),
    enabled: isEnabled(),
    policyKnown: policyKnown(),
    dbDays: cache.loaded ? cache.days : null,
    envDays: envRetentionDays(),
    envDaysIsSet: envRetentionDaysIsSet(),
    options: CONSOLE_RETENTION_DAYS,
    updatedAt: cache.updatedAt,
    updatedBy: cache.updatedBy,
  };
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

/**
 * Drop the cached database view, returning this module to its never-loaded
 * state. FOR TESTS — nothing in the running app should want to forget the
 * policy, and `policyKnown()` going back to false stops the pruner.
 * @returns {void}
 */
function resetCacheForTests() {
  cache = { loaded: false, days: null, updatedAt: null, updatedBy: null };
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SCHEDULE,
  DEFAULT_TIMEZONE,
  CONSOLE_RETENTION_DAYS,
  SETTING_KEY,
  retentionDays,
  retentionSource,
  envRetentionDays,
  isAllowedConsoleDays,
  policyKnown,
  policyState,
  refreshFromDb,
  persistRetentionDays,
  isEnabled,
  schedule,
  timezone,
  resetCacheForTests,
};
