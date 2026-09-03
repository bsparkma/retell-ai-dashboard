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
/**
 * The two ways an office books a write-off it CHOSE to make (Stage B1).
 *
 *   writeoff_field      into the claimproc's own WriteOff, beside the
 *                       contractual figure. Roland's way, and the default.
 *   adjustment_by_name  as a ledger adjustment of the named type.
 *
 * Declared here rather than imported from the migration — a service must not
 * take a migration file as a runtime dependency. `officeSettings.test.js` reads
 * the migration and fails if the two lists drift, which is the same shape
 * `rcm-labels.test.ts` uses for the line statuses.
 */
const WRITEOFF_MODES = Object.freeze(['writeoff_field', 'adjustment_by_name']);

/** Roland's way, and the behaviour the drain already has. */
const DEFAULT_WRITEOFF_MODE = 'writeoff_field';

const QUERIES = Object.freeze({
  read:
    `SELECT office_id, drain_enabled, drain_updated_at, drain_updated_by, ` +
    `writeoff_mode, writeoff_adjtype_name FROM rcm_office_settings ` +
    `WHERE office_id = $1 LIMIT 1`,
  /*
   * HOW THIS OFFICE BOOKS A WRITE-OFF IT CHOSE TO MAKE (Stage B1).
   *
   * A SEPARATE statement from `setDrainEnabled`, not a wider one. They are two
   * different authorisations that happen to share a table: one decides whether a
   * practice may write to a chart at all, the other decides the shape of one
   * field when it does. Folding them into a single UPDATE would mean an edit to
   * either could move the other, and `drain_updated_at` — the switch's own
   * timestamp, which exists precisely so it is not the row's — would start
   * dating the gate to whenever somebody last renamed an adjustment type.
   *
   * `updated_at` moves; `drain_updated_at` deliberately does not.
   */
  setWriteoffMode:
    `UPDATE rcm_office_settings SET writeoff_mode = $1, writeoff_adjtype_name = $2, ` +
    `updated_at = now() WHERE office_id = $3 ` +
    `RETURNING office_id, drain_enabled, drain_updated_at, drain_updated_by, ` +
    `writeoff_mode, writeoff_adjtype_name`,
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
    return {
      drainEnabled: false,
      updatedAt: null,
      updatedBy: null,
      /*
       * The DEFAULT mode, not null — a missing row must not make the drain's
       * write-off arithmetic undefined on top of everything else. It cannot
       * post anyway: `drainEnabled` is false above.
       */
      writeoffMode: DEFAULT_WRITEOFF_MODE,
      writeoffAdjTypeName: null,
      rowMissing: true,
    };
  }

  return {
    // `=== true` rather than a truthy test: a NULL that slipped past the NOT NULL
    // is not a licence to write to a chart either.
    drainEnabled: row.drain_enabled === true,
    updatedAt: row.drain_updated_at == null ? null : row.drain_updated_at,
    updatedBy: row.drain_updated_by == null ? null : String(row.drain_updated_by),
    /**
     * How this office books a write-off it CHOSE to make (Stage B1). An
     * unrecognised value reads as the default rather than throwing — the CHECK
     * constraint is what makes one unstorable, and `writeoff_field` is the mode
     * whose write the drain already makes.
     */
    writeoffMode: WRITEOFF_MODES.includes(row.writeoff_mode)
      ? String(row.writeoff_mode)
      : DEFAULT_WRITEOFF_MODE,
    /** The AdjType NAME, never a DefNum (D-13). Null under `writeoff_field`. */
    writeoffAdjTypeName:
      row.writeoff_adjtype_name == null ? null : String(row.writeoff_adjtype_name),
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
  WRITEOFF_MODES,
  DEFAULT_WRITEOFF_MODE,
  QUERIES,
  readOfficeSettings,
  isDrainEnabled,
  _resetForTests,
};
