'use strict';

/**
 * Hygienist attribution on hygiene intakes (Roles PR B).
 *
 * WHY THIS COLUMN EXISTS
 * ----------------------
 * Before this, a submission's only attribution was `submitted_by` (the SSO
 * email) and `submitted_by_name` (the SSO display name), both stamped from the
 * session by the route. That is a faithful AUDIT record — it says who was
 * signed in — but it is not a clinical one.
 *
 * temp@carein.ai is one deliberately shared, rotated account for temp
 * hygienists (Roles PR A). Every temp's work therefore lands under one identity
 * and one display name. "Show me Raegan's handoffs" cannot be answered, and
 * neither can "who saw this patient?" — which is the clinical question.
 *
 * `hygienist_name` separates the two: submitted_by stays the audit identity,
 * hygienist_name is who did the visit. It is a NAME SNAPSHOT, not a foreign
 * key — the name as of the visit, unaffected by a later roster change, matching
 * how this schema already snapshots patient and provider names.
 *
 * BACKFILL: existing rows take submitted_by_name, which is the best
 * attribution that has ever existed for them. Rows whose submitted_by_name is
 * empty fall back to submitted_by so nothing is attributed to nobody.
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
    hygienist_name: { type: 'text', notNull: true, default: '' },
  });

  // Backfill in one statement — NOT NULL with a '' default already made every
  // existing row valid, so this is about making them USEFUL, not about
  // satisfying the constraint.
  pgm.sql(`
    UPDATE tc_hygiene_intakes
       SET hygienist_name = CASE
             WHEN submitted_by_name <> '' THEN submitted_by_name
             ELSE submitted_by
           END
     WHERE hygienist_name = '';
  `);

  // The submissions view filters by hygienist within an office. Index the pair
  // in that order: office_id is always present, hygienist_name only sometimes.
  pgm.createIndex('tc_hygiene_intakes', ['office_id', 'hygienist_name'], {
    name: 'tc_hygiene_intakes_office_hygienist_idx',
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropIndex('tc_hygiene_intakes', ['office_id', 'hygienist_name'], {
    name: 'tc_hygiene_intakes_office_hygienist_idx',
  });
  pgm.dropColumns('tc_hygiene_intakes', ['hygienist_name']);
};
