'use strict';

/**
 * Per-tenant data-plane: print template styling (CO-3b).
 *
 * ONE NULLABLE COLUMN on the existing tc_print_templates:
 *
 *   styling  jsonb  the template's curated style — accent colour, font pair,
 *                   logo placement and size, layout — validated against the
 *                   CLOSED schema in shared/tc/printStyling.ts before it is
 *                   written (unknown keys refused, a too-light colour refused)
 *
 * NULL IS THE DEFAULTS, and the defaults are the printout as it was before this
 * column existed: every existing row reads as NULL and keeps printing byte for
 * byte what it printed. A save that equals the defaults is stored as NULL, so
 * "never styled" and "styled back to the defaults" are one state.
 *
 * Additive only: no default, no backfill, no rewrite of the table. The CHECK is
 * two-valued (RCM_POSTING §15): NULL, or a JSON object — the shape inside is
 * the contract's to police, where the error can be named.
 *
 * The table's grant (SELECT, INSERT, UPDATE; no DELETE) already covers a new
 * column.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const TABLE = 'tc_print_templates';
exports.TABLE = TABLE;

const CHECK_NAME = 'tc_print_templates_styling_check';
const CHECK = "styling IS NULL OR jsonb_typeof(styling) = 'object'";
exports.CHECK_NAME = CHECK_NAME;
exports.CHECK = CHECK;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns(TABLE, { styling: { type: 'jsonb' } });
  pgm.addConstraint(TABLE, CHECK_NAME, { check: CHECK });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint(TABLE, CHECK_NAME, { ifExists: true });
  pgm.dropColumns(TABLE, ['styling'], { ifExists: true });
};
