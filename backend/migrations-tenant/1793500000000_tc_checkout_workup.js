'use strict';

/**
 * Per-tenant data-plane: the front desk's workup checklist on a checkout
 * handoff (CO-1).
 *
 * `tc_checkout_handoffs.workup` jsonb, NULLABLE, additive. NULL for every
 * handoff before this one and for every handoff nobody has ticked anything on;
 * otherwise an OBJECT shaped like shared/tc/checkout.ts TcCheckoutWorkup
 * ({ workedUp, present, collected, referrals }). The reader treats NULL as the
 * empty checklist, so no backfill is needed.
 *
 * The column rides tc_checkout_handoffs' existing carein_app grant.
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
  pgm.addColumns('tc_checkout_handoffs', {
    workup: { type: 'jsonb' },
  });
  // An object, or absent. An array or a string here is a checklist no reader parses.
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_workup_object_check', {
    check: "workup IS NULL OR jsonb_typeof(workup) = 'object'",
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_workup_object_check', { ifExists: true });
  pgm.dropColumns('tc_checkout_handoffs', ['workup'], { ifExists: true });
};
