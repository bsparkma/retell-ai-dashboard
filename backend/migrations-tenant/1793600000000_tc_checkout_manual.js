'use strict';

/**
 * Per-tenant data-plane: a checkout entry the front desk adds BY HAND (CO-5a).
 *
 * TWO NULLABLE COLUMNS AND ONE PARTIAL UNIQUE INDEX on tc_checkout_handoffs,
 * all additive:
 *
 *   source             'hygiene' | 'manual', NULLABLE. NULL is every record
 *                      before this one, and reads as 'hygiene' — that is what
 *                      they all were. The "Add patient" button writes 'manual'.
 *                      Who added it is the row's existing submitted_by.
 *   hygiene_merged_at  timestamptz, NULLABLE. Set when a hygiene checkout
 *                      handoff for the same patient and day arrived AFTER the
 *                      card was added by hand and merged onto it (CO-1's
 *                      same-patient, same-day, same-office rule). NULL on a
 *                      manual card means it carries no hygiene visit data.
 *
 *   tc_checkout_handoffs_manual_patient_day_key
 *                      UNIQUE (office_id, od_patient_id, visit_date) WHERE
 *                      source = 'manual' AND the card still holds the patient
 *                      (not dismissed, not expired). The arbiter for two
 *                      racing "Add patient" clicks: one row, and the loser
 *                      re-reads the winner. A dismissed manual card releases
 *                      the slot, so the patient can be added again.
 *
 * The columns ride tc_checkout_handoffs' existing carein_app grant.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const MANUAL_INDEX = 'tc_checkout_handoffs_manual_patient_day_key';
exports.MANUAL_INDEX = MANUAL_INDEX;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('tc_checkout_handoffs', {
    source: { type: 'text' },
    hygiene_merged_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_source_check', {
    check: "source IS NULL OR source IN ('hygiene', 'manual')",
  });
  pgm.createIndex('tc_checkout_handoffs', ['office_id', 'od_patient_id', 'visit_date'], {
    name: MANUAL_INDEX,
    unique: true,
    where: "source = 'manual' AND status NOT IN ('dismissed', 'expired')",
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropIndex('tc_checkout_handoffs', ['office_id', 'od_patient_id', 'visit_date'], {
    name: MANUAL_INDEX,
    ifExists: true,
  });
  pgm.dropConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_source_check', { ifExists: true });
  pgm.dropColumns('tc_checkout_handoffs', ['source', 'hygiene_merged_at'], { ifExists: true });
};
