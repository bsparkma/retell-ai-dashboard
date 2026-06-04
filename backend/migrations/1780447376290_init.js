'use strict';

/**
 * Initial (empty) migration for the `carein_control` control-plane database.
 *
 * Intentionally a no-op: it exists so the migration tooling, the `pgmigrations`
 * bookkeeping table, and the CI/build path are all exercised before any real
 * schema lands. Add the first real control-plane tables (clinics / practices,
 * user→clinic mapping, connector registry, etc.) in a NEW migration created
 * with:  npm run migrate:create -- <name>
 *
 * node-pg-migrate API: https://salsita.github.io/node-pg-migrate/
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // No-op: first real schema goes in a subsequent migration.
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  // No-op.
};
