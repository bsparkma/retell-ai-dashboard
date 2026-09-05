'use strict';

/**
 * Per-tenant data-plane: where a staged write actually LANDED (H1 slice 3).
 *
 * ADDITIVE ONLY. One nullable column on `hyg_staged_write`. No new table, so no
 * GRANT block is needed — an added column inherits the table's existing grants
 * (see 1788200000000_hyg_visit.js for the per-table path). `audit_log` is not
 * mentioned by this migration and its append-only grants are untouched.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY "IT WAS SENT" IS NOT ENOUGH
 * ═════════════════════════════════════════════════════════════════════════════
 * Slice 2 gave a staged write `state`, `sent_by` and `sent_at`. Those answer
 * *whether* and *by whom* — and leave "so where is it?" to somebody clicking
 * through Open Dental hoping to recognise a document. `written_ref` is the
 * identifier the OTHER system minted: `Document 4711`, `Case 8f3c…`, the
 * ProcNums a GroupNote landed on.
 *
 * It is the difference between a record that a write happened and a record that
 * can be followed, and the day it matters is the day somebody asks whether a
 * slip from three weeks ago is really in the chart.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CHECK, WRITTEN THE LONG WAY
 * ═════════════════════════════════════════════════════════════════════════════
 * A `Written` row must carry a reference, and a row that is not `Written` must
 * not — a pointer to something that was never sent is worse than no pointer,
 * because it looks like evidence.
 *
 * Postgres ACCEPTS a CHECK that evaluates to NULL (it only rejects an explicit
 * false), which is the trap RCM's Stage B1 and C-2 constraints were both
 * written around. `state` is NOT NULL and both sides here are `IS NULL` tests,
 * so neither branch can evaluate to NULL and be waved through.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('hyg_staged_write', {
    written_ref: { type: 'text' },
  });

  pgm.addConstraint('hyg_staged_write', 'hyg_staged_write_written_ref_check', {
    check: "(state = 'Written') = (written_ref IS NOT NULL)",
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  // CONSTRAINT BEFORE COLUMN: Postgres drops a CHECK silently with the column
  // it depends on, and a down() that relied on that would leave the two
  // migrations' rollbacks in a different order than their applications.
  pgm.dropConstraint('hyg_staged_write', 'hyg_staged_write_written_ref_check', { ifExists: true });
  pgm.dropColumns('hyg_staged_write', ['written_ref'], { ifExists: true });
};
