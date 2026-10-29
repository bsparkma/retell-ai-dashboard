'use strict';

/**
 * Per-tenant data-plane: the existing-treatment answers a hygiene handoff
 * carries (hygiene Slice 2b).
 *
 * `tc_hygiene_intakes.existing_tx` jsonb, NULLABLE, additive — the same shape
 * of change item 33 made with `ortho_screening`. NULL for every intake before
 * this one and for every intake that carried none; a jsonb ARRAY of
 * ExistingTxHandoffItem (shared/hyg/existingTx.ts) otherwise.
 *
 * The column rides tc_hygiene_intakes' existing carein_app grant.
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
  pgm.addColumns('tc_hygiene_intakes', {
    existing_tx: { type: 'jsonb' },
  });
  // An array, or absent. An object or a string here is a row no renderer reads.
  pgm.addConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_existing_tx_array_check', {
    check: "existing_tx IS NULL OR jsonb_typeof(existing_tx) = 'array'",
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_existing_tx_array_check', {
    ifExists: true,
  });
  pgm.dropColumns('tc_hygiene_intakes', ['existing_tx'], { ifExists: true });
};
