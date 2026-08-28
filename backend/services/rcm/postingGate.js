'use strict';

/**
 * The shadow gate — read at drain time, never cached, fails closed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO CONDITIONS, AND BOTH ARE REQUIRED
 * ─────────────────────────────────────────────────────────────────────────────
 * An Open Dental write in this module needs BOTH of:
 *
 *   1. `postingDrain.OFFICES_ENABLED_FOR_POSTING.includes(office)` — the CODE
 *      ceiling (D-7, §9). A statement that this practice has been validated:
 *      its DefNums read from its own database, its key's write groups proven,
 *      its end-to-end run. Changing it is a code change with the evidence in
 *      the same commit, and this file cannot open it.
 *
 *   2. `drain_enabled` on this office's `rcm_office_settings` row — the
 *      OPERATOR's decision. A statement about today.
 *
 * Neither substitutes for the other. Roland clears the ceiling and still goes
 * to production switched OFF, so a biller can work real EOBs all the way to
 * `approved` while a chart write remains impossible.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ AT DRAIN TIME. NEVER CACHED ACROSS REQUESTS.
 * ─────────────────────────────────────────────────────────────────────────────
 * `odOfficeConfig` caches a practice's DefNums for an hour, and that is right —
 * definitions change about once a year and each read costs a paced Open Dental
 * call. This is the opposite kind of value. It is a switch a human flips
 * BECAUSE they want the next press of Drain to behave differently, and a cached
 * answer would mean the flip did not take for up to an hour with nothing on
 * screen saying so. One local Postgres SELECT per press is not a cost worth
 * trading an honest state for.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A MISSING ROW IS `false`
 * ─────────────────────────────────────────────────────────────────────────────
 * The migration seeds both offices, so an absent row means either a database
 * this migration has not reached or a row somebody removed. Neither is a
 * licence to write to a chart: the only honest reading of "there is no record
 * of anyone switching this on" is that nobody did. Logged ONCE per office —
 * loudly enough to be found, quietly enough that a shadow-mode practice does not
 * fill its logs with one line per press.
 */

/** The refusal slug the drain route answers with. A slug, never a sentence. */
const DRAIN_DISABLED = 'drain_disabled_for_office';

/**
 * Offices whose missing row has already been logged, so the warning is once per
 * process rather than once per press.
 * @type {Set<string>}
 */
const warnedMissing = new Set();

/**
 * THE TWO STATEMENTS THIS TABLE EVER SEES, as constants rather than inline
 * strings.
 *
 * Hoisted for the same reason `postingDrain.PLAN_QUERIES` is:
 * `scripts/rcm-verify-queries.js` sends every one of them to a REAL migrated
 * Postgres in CI, so an unknown column is a parse error in the pipeline rather
 * than a 500 on a walk night. The static scan in `test/rcmQueryColumns.test.js`
 * reads them too.
 *
 * There is no INSERT here on purpose. The migration seeds one row per office,
 * and the office set is a migration everywhere else in this schema — a route
 * that could mint a settings row could mint one for an office the CHECK
 * constraints refuse.
 *
 * The UPDATE moves the row's own `updated_at` alongside the switch's
 * `drain_updated_at`. They answer different questions — "when did this row last
 * change" and "when was posting last switched" — and Slice 1's merchant-fee
 * editor moves only the first, which is exactly why the switch needed its own.
 */
const QUERIES = Object.freeze({
  read:
    `SELECT office_id, drain_enabled, drain_updated_at, drain_updated_by FROM rcm_office_settings ` +
    `WHERE office_id = $1 LIMIT 1`,
  setDrainEnabled:
    `UPDATE rcm_office_settings SET drain_enabled = $1, drain_updated_at = now(), ` +
    `drain_updated_by = $2, updated_at = now() WHERE office_id = $3 ` +
    `RETURNING office_id, drain_enabled, drain_updated_at, drain_updated_by`,
});

/**
 * Is this office switched on for posting, right now?
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }} pool
 * @param {string} office validated office key ('roland' | 'valley')
 * @returns {Promise<{ drainEnabled: boolean, updatedAt: Date|null, updatedBy: string|null, rowMissing: boolean }>}
 */
async function readOfficeSettings(pool, office) {
  const { rows } = await pool.query(QUERIES.read, [office]);

  const row = rows[0];
  if (!row) {
    if (!warnedMissing.has(office)) {
      warnedMissing.add(office);
      console.warn(
        `[rcm] no rcm_office_settings row for '${office}' — posting is treated as SWITCHED OFF. ` +
          'The tenant migration seeds one row per office; run migrations.'
      );
    }
    return { drainEnabled: false, updatedAt: null, updatedBy: null, rowMissing: true };
  }

  return {
    // `=== true` rather than a truthy test: a NULL that slipped past the NOT NULL
    // is not a licence to write to a chart either.
    drainEnabled: row.drain_enabled === true,
    updatedAt: row.drain_updated_at == null ? null : row.drain_updated_at,
    updatedBy: row.drain_updated_by == null ? null : String(row.drain_updated_by),
    rowMissing: false,
  };
}

/**
 * The predicate the drain route asks. Sugar over the above, so a caller that
 * only needs the answer cannot accidentally read a field instead of the switch.
 *
 * @param {Parameters<typeof readOfficeSettings>[0]} pool
 * @param {string} office
 * @returns {Promise<boolean>}
 */
async function isDrainEnabled(pool, office) {
  const settings = await readOfficeSettings(pool, office);
  return settings.drainEnabled;
}

/** Test seam: forget which offices have had their missing row logged. */
function _resetForTests() {
  warnedMissing.clear();
}

module.exports = {
  DRAIN_DISABLED,
  QUERIES,
  readOfficeSettings,
  isDrainEnabled,
  _resetForTests,
};
