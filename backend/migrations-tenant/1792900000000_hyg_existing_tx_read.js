'use strict';

/**
 * Per-tenant data-plane: what the visit's existing-treatment read LAST SAID
 * (hygiene Slice 2b).
 *
 * `hyg_visit.existing_tx_read` jsonb, NULLABLE, additive:
 *
 *   NULL                                   the plan was never loaded for this visit
 *   { status: 'loaded', readAt, items }    the server's last successful Open Dental
 *                                          read: every planned procedure's snapshot
 *   { status: 'failed', at }               every read so far failed
 *
 * WHY IT EXISTS. The Router lists EVERY existing item, including the ones
 * nobody answered — and an unanswered item has no disposition row. So the
 * server keeps the plan it read, and the Router composes from that plus the
 * dispositions. It is also what lets the Router tell three different facts
 * apart: never loaded (no section), failed ("could not be loaded"), and loaded
 * with nothing planned. An empty section is never printed for the first two.
 *
 * Written only by the server's own read, never by a request, and not once the
 * visit is frozen. A failure never overwrites a plan that did load.
 *
 * The column rides hyg_visit's existing carein_app grant — no new table, so
 * no new grant block.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const STATUSES = ['loaded', 'failed'];

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('hyg_visit', {
    existing_tx_read: { type: 'jsonb' },
  });
  // An object with a known status, or absent. Written the long way: a NULL
  // column must pass, and a non-object must not.
  pgm.addConstraint('hyg_visit', 'hyg_visit_existing_tx_read_check', {
    check:
      'existing_tx_read IS NULL OR (' +
      "jsonb_typeof(existing_tx_read) = 'object' AND " +
      `COALESCE(existing_tx_read->>'status', '') IN (${STATUSES.map((s) => `'${s}'`).join(', ')})` +
      ')',
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('hyg_visit', 'hyg_visit_existing_tx_read_check', { ifExists: true });
  pgm.dropColumns('hyg_visit', ['existing_tx_read'], { ifExists: true });
};

exports.STATUSES = STATUSES;
