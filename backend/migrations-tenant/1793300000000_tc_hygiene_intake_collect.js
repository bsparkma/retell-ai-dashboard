'use strict';

/**
 * Per-tenant data-plane: what the front desk takes payment for, carried on a
 * hygiene handoff (checkout v2).
 *
 * `tc_hygiene_intakes.collect_at_checkout` jsonb, NULLABLE, additive — the same
 * shape of change as 1793000000000_tc_hygiene_intake_existing_tx. NULL for every
 * intake before this one and for every intake with nothing to collect; a jsonb
 * ARRAY of label strings ("Fl2", "Mouthwash", …) otherwise.
 *
 * And `records_needed`, the same shape of column: the records the handoff's
 * treatment needs and where each stands ({ record, status }), exactly the list
 * its staged preview showed. NULL when none is needed.
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
    collect_at_checkout: { type: 'jsonb' },
    records_needed: { type: 'jsonb' },
  });
  // An array, or absent. An object or a string here is a row no renderer reads.
  pgm.addConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_collect_at_checkout_array_check', {
    check: "collect_at_checkout IS NULL OR jsonb_typeof(collect_at_checkout) = 'array'",
  });
  pgm.addConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_records_needed_array_check', {
    check: "records_needed IS NULL OR jsonb_typeof(records_needed) = 'array'",
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_records_needed_array_check', {
    ifExists: true,
  });
  pgm.dropConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_collect_at_checkout_array_check', {
    ifExists: true,
  });
  pgm.dropColumns('tc_hygiene_intakes', ['collect_at_checkout', 'records_needed'], { ifExists: true });
};
