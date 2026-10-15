'use strict';

/**
 * The hygiene visit's checkout alert (queue item 49): where its handoff went.
 *
 * Mirrors 1790200000000_hyg_ortho_send.js column for column, for the same
 * reasons: one handoff per visit, a conditional claim so two presses cannot
 * both reach TC, and a record written ONLY after TC answered.
 *
 *   checkout_handoff_id       TC's handoff id, once TC answered with one
 *   checkout_sent_at / _by    when, and who pressed it (or ran the visit Send)
 *   checkout_send_claimed_at  the in-flight claim; stale after two minutes
 *   checkout_final_at         when the visit Send's FINAL snapshot landed —
 *                             null while only the early alert has
 *
 * All nullable, all additive; a visit before this deploy reads "not alerted".
 * The columns ride hyg_visit's existing carein_app grant — no new table, so no
 * new grant block.
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
  pgm.addColumns('hyg_visit', {
    checkout_handoff_id: { type: 'text' },
    checkout_sent_at: { type: 'timestamptz' },
    checkout_sent_by: { type: 'text' },
    checkout_send_claimed_at: { type: 'timestamptz' },
    checkout_final_at: { type: 'timestamptz' },
  });

  // Written the long way, like hyg_visit_ortho_sent_check: Postgres accepts a
  // CHECK that evaluates to NULL, so "all set or all null" needs equalities.
  pgm.addConstraint('hyg_visit', 'hyg_visit_checkout_sent_check', {
    check:
      '(checkout_handoff_id IS NULL) = (checkout_sent_at IS NULL) AND ' +
      '(checkout_sent_at IS NULL) = (checkout_sent_by IS NULL)',
  });
  // A final update is an update OF a handoff that exists.
  pgm.addConstraint('hyg_visit', 'hyg_visit_checkout_final_check', {
    check: 'checkout_final_at IS NULL OR checkout_handoff_id IS NOT NULL',
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('hyg_visit', 'hyg_visit_checkout_final_check', { ifExists: true });
  pgm.dropConstraint('hyg_visit', 'hyg_visit_checkout_sent_check', { ifExists: true });
  pgm.dropColumns(
    'hyg_visit',
    [
      'checkout_handoff_id',
      'checkout_sent_at',
      'checkout_sent_by',
      'checkout_send_claimed_at',
      'checkout_final_at',
    ],
    { ifExists: true }
  );
};
