'use strict';

/**
 * The TC Opportunities nightly sync — its switch and its tunables.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SHIPS DARK. THREE GATES, ALL READ AT RUN TIME, ALL FAIL CLOSED.
 * ═════════════════════════════════════════════════════════════════════════════
 *   1. TC_OPPS_SYNC_DISABLED=true            break-glass: nothing runs. Can only
 *                                            ever turn the sync OFF.
 *   2. office_setting(tenant, office, 'tc_opportunities_sync')
 *                                            MT-2b: the served layer, per TENANT.
 *                                            NO ROW = OFF. A non-boolean is OFF.
 *                                            Only the tenant's own offices count.
 *                                            An unreachable control plane is OFF
 *                                            (a nightly job that skips one night
 *                                            costs nothing; one that reads a
 *                                            practice nobody switched on costs a
 *                                            lot). platform_setting is still
 *                                            written alongside, for rollback.
 *   3. The tenant must be entitled to `tc` and the office must be
 *      `odOffices.isOdReady` — checked by the scheduler, per pass.
 *
 * Shaped after config/hygPilot.js's map-keyed-by-office row, minus its sync
 * cache: nothing on a request path asks this module anything, so it simply
 * reads the control plane at the start of every pass and never holds a copy.
 *
 * Nothing in this slice WRITES the row. Turning an office on is a deliberate
 * control-plane write (a runbook INSERT, or a later Platform Console toggle).
 */

const { OFFICES } = require('./officeAgents');
const officeSettings = require('../platform/officeSettings');

/** The `platform_setting` key. */
const SETTING_KEY = 'tc_opportunities_sync';

/** Default cron: 02:30 in the practice's zone. See scheduleSlot() below. */
const DEFAULT_SCHEDULE = '30 2 * * *';

/**
 * Open Dental's documented rate is one request per second per credential, and
 * the slot is shared with voice, TC, hygiene and RCM. The sync is a batch and
 * holds the slot at RCM's D-8 spacing (1200 ms) — never less. It is a floor:
 * an env value below it is raised to it.
 */
const MIN_INTERVAL_FLOOR_MS = 1200;

/** @param {string} name @param {number} fallback @param {{ min?: number }} [o] */
function intEnv(name, fallback, o = {}) {
  const raw = Number(String(process.env[name] ?? '').trim());
  if (!Number.isFinite(raw) || String(process.env[name] ?? '').trim() === '') return fallback;
  const n = Math.floor(raw);
  if (o.min !== undefined && n < o.min) return fallback;
  return n;
}

/** Break-glass. Only the literal 'true' (case/space-insensitive) disables. */
function isKilled() {
  return String(process.env.TC_OPPS_SYNC_DISABLED ?? '').trim().toLowerCase() === 'true';
}

/** Cron expression for the nightly pass. */
function schedule() {
  const s = String(process.env.TC_OPPS_SYNC_SCHEDULE ?? '').trim();
  return s || DEFAULT_SCHEDULE;
}

/** The zone the cron and the look-back cutoff are evaluated in. */
function timezone() {
  return (
    String(process.env.TC_OPPS_SYNC_TZ ?? '').trim() ||
    String(process.env.OFFICE_TIMEZONE ?? '').trim() ||
    'America/Chicago'
  );
}

/** Spacing per Open Dental request, never below the floor. */
function minIntervalMs() {
  return Math.max(MIN_INTERVAL_FLOOR_MS, intEnv('TC_OPPS_MIN_INTERVAL_MS', MIN_INTERVAL_FLOOR_MS, { min: 0 }));
}

/** Page cap for the ProcStatus=TP sweep (100 rows/page). 600 → 60,000 procedures. */
function maxPages() {
  return intEnv('TC_OPPS_MAX_PAGES', 600, { min: 1 });
}

/** Only procedures treatment-planned within this many days. 0 = no limit. */
function lookbackDays() {
  return intEnv('TC_OPPS_LOOKBACK_DAYS', 730, { min: 0 });
}

/**
 * Wall-clock budget for one office's pass, sweep + names. The sweep is never
 * cut by it (a cut sweep is a partial sweep, which applies nothing); the name
 * pass stops when it runs out and resumes the next night.
 */
function budgetMs() {
  return intEnv('TC_OPPS_SYNC_BUDGET_MS', 14 * 60 * 1000, { min: 1000 });
}

/** Hard cap on patient-name reads per office per night. */
function maxNameReads() {
  return intEnv('TC_OPPS_MAX_NAME_READS', 500, { min: 0 });
}

/** Per-request timeout. */
function callTimeoutMs() {
  return intEnv('TC_OPPS_CALL_TIMEOUT_MS', 30000, { min: 1000 });
}

/**
 * Parse the stored row into the offices it switches ON. Anything that is not a
 * known office mapped to the literal `true` is OFF.
 * @param {unknown} value
 * @returns {string[]}
 */
function officesOnIn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(/** @type {Record<string, unknown>} */ (value))
    .filter(([k, v]) => Object.prototype.hasOwnProperty.call(OFFICES, k) && v === true)
    .map(([k]) => k)
    .sort();
}

/**
 * The offices of ONE TENANT switched ON right now, read fresh from
 * office_setting (MT-2b; platform/officeSettings.switchedOnFromDb). Never
 * throws: an unreadable control plane is "nothing is on".
 *
 * The tenant is the session tenant on a request path, or the one TC tenant a
 * scheduler resolved from registry.listTenants() — never client input.
 *
 * @param {{ listOfficeSettings?: (slug: string) => Promise<Array<{ office_key: string, setting_key: string, value: unknown }>> }} registry
 *        the control-plane registry (injectable for tests)
 * @param {string} tenantSlug
 * @returns {Promise<{ offices: string[], reason: string|null }>}
 */
async function switchedOnOffices(registry, tenantSlug) {
  if (isKilled()) return { offices: [], reason: 'KILLED_BY_ENV' };
  return officeSettings.switchedOnFromDb(tenantSlug, SETTING_KEY, registry);
}

module.exports = {
  SETTING_KEY,
  DEFAULT_SCHEDULE,
  MIN_INTERVAL_FLOOR_MS,
  isKilled,
  schedule,
  timezone,
  minIntervalMs,
  maxPages,
  lookbackDays,
  budgetMs,
  maxNameReads,
  callTimeoutMs,
  officesOnIn,
  switchedOnOffices,
};
