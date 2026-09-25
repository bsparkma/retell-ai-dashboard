'use strict';

/**
 * Widen the tenant_module vocabulary to admit 'fees' — the Fee Schedule module.
 *
 * ADDING A MODULE IS A MIGRATION, NOT AN EDIT TO config/modules.js. The CHECK
 * constraint on tenant_module is the real gate: it decides which module ids the
 * control database will store, and therefore which entitlements the Platform
 * Console can actually turn on. config/modules.js decides which toggles that
 * console RENDERS. Let the two disagree and the console grows a switch that
 * 500s on click — which is what had happened to provisionTenant.js before the
 * catalog was centralised, and what 1788100000000 ('hyg') was written to avoid
 * repeating. This migration is that same shape, one module later.
 *
 * So this migration and the catalog edit ship in the SAME commit, and
 * config/modules.test.js reads this file's constraint back out of the migration
 * SOURCE and compares it to the catalog. Split them and that test goes red.
 *
 * REPLACE, NOT ALTER. Postgres has no "widen a CHECK" — the constraint is
 * dropped and re-added. The DROP is `IF EXISTS`-shaped via the guarded SQL
 * below rather than pgm.dropConstraint, so this migration is safe to run on a
 * database that somehow never got the earlier constraints (a very old
 * environment, or one restored from before them).
 *
 * DOWN IS NOT SYMMETRIC, AND THAT IS DELIBERATE. Narrowing the vocabulary back
 * would fail on any database that has since stored a 'fees' row — Postgres
 * validates a new CHECK against existing rows. So `down` deletes the 'fees'
 * entitlement rows first and then restores the five-name constraint. That
 * discards entitlement state, which is the honest cost of rolling back a module
 * registration; it is recorded here so nobody discovers it during an incident.
 *
 * NO TABLES. The fee-schedule module's own tables (fees_import_batch,
 * fees_import_row) land in the TENANT migration that ships beside this one,
 * with their own carein_app GRANT block — the call_record lesson: a table the
 * least-privilege app role cannot reach is a table the app cannot use, and the
 * failure surfaces as a permission error in production rather than as a red
 * migration.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const CONSTRAINT = 'tenant_module_module_check';

/*
 * THE TWO VOCABULARIES ARE WRITTEN INLINE BELOW, NOT HOISTED INTO CONSTANTS.
 *
 * config/modules.test.js derives the live vocabulary by scanning the up() half
 * of every migration source for `"module IN (...)"` and taking the last one.
 * That scan reads TEXT, so a hoisted `const CHECK_AFTER = ...` referenced by
 * name inside up() is invisible to it — the constraint would silently read as
 * the previous migration's, and the drift guard would pass while guarding
 * nothing. Keeping each literal at its own addConstraint call is what keeps the
 * guard honest, and it costs one repeated string.
 */

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE tenant_module DROP CONSTRAINT IF EXISTS ${CONSTRAINT};`);
  pgm.addConstraint('tenant_module', CONSTRAINT, {
    check: "module IN ('voice', 'rcm', 'tc', 'hyg', 'fees', 'scheduling')",
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE tenant_module DROP CONSTRAINT IF EXISTS ${CONSTRAINT};`);
  // Rows first: a narrowing CHECK is validated against what is already stored,
  // so leaving a 'fees' row here would make the rollback fail rather than roll back.
  pgm.sql(`DELETE FROM tenant_module WHERE module = 'fees';`);
  // The vocabulary as 1788100000000 left it.
  pgm.addConstraint('tenant_module', CONSTRAINT, {
    check: "module IN ('voice', 'rcm', 'tc', 'hyg', 'scheduling')",
  });
};
