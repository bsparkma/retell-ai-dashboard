'use strict';

/**
 * Per-tenant data-plane: what an answered checkout card WAS, once a hygiene
 * visit arriving after the answer reopened it (CO-5a fix, PM ruling).
 *
 * `tc_checkout_handoffs.reopened_from` jsonb, NULLABLE, additive. NULL on every
 * card that was never reopened (all of them before this). Otherwise an OBJECT
 * shaped like shared/tc/checkout.ts TcCheckoutReopened: { outcome, outcomeBy,
 * outcomeAt, appointmentNote, caseId, reopenedAt } — the answer the reopen
 * cleared, kept so the card can show it as history. The audit trail carries
 * the same event; this column is what the card reads.
 *
 * Required as a column: the outcome fields themselves must be cleared (the
 * outcome CHECK ties them to an answered status), and neither the workup nor
 * the payload jsonb has room for it under their strict schemas.
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
    reopened_from: { type: 'jsonb' },
  });
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_reopened_from_object_check', {
    check: "reopened_from IS NULL OR jsonb_typeof(reopened_from) = 'object'",
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_reopened_from_object_check', { ifExists: true });
  pgm.dropColumns('tc_checkout_handoffs', ['reopened_from'], { ifExists: true });
};
