'use strict';

/**
 * Per-tenant data-plane: who owns a follow-up (next-touch slice).
 *
 * Every OPEN TC case carries exactly one visible NEXT TOUCH: a date and an
 * owner. The next touch is the case's earliest pending tc_followups row
 * (shared/tc/nextTouch.ts). There is no separate "next touch" table or column.
 * The row already had its date (due_date). It had no owner, so this adds one:
 *
 *   owner   text, NULL allowed. The identity string of the person on the hook,
 *           the same convention as completed_by and the signed-in actor's
 *           email. NULL on every row written before this column existed
 *           (legacy imports and pre-slice rows). It is shown as "no owner" and
 *           NOT backfilled from tc_cases.assigned_tc, because that would print
 *           a guess as though someone had chosen it.
 *
 * Additive, nullable, no default: an instant ALTER on Postgres, and every
 * existing writer (which names its columns explicitly) keeps working.
 *
 * GRANTS. Nothing to do: the app role's grant on tc_followups is table-level
 * (1785373200000_tc_schema.js, SELECT/INSERT/UPDATE/DELETE), so it covers a new
 * column. No column-level grant on this table exists anywhere.
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
  pgm.addColumn('tc_followups', {
    owner: { type: 'text' },
  });
  pgm.addConstraint('tc_followups', 'tc_followups_owner_len_check', {
    check: 'owner IS NULL OR (length(owner) BETWEEN 1 AND 200)',
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('tc_followups', 'tc_followups_owner_len_check', { ifExists: true });
  pgm.dropColumn('tc_followups', 'owner', { ifExists: true });
};
