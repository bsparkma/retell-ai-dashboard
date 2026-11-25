'use strict';

/**
 * tc_nurture_enrollments + the patient email library (EL-2).
 *
 * An enrollment MAY carry a library procedure and tone. When it does, the
 * nightly generator drafts the library's email sequence for its track (one
 * composed email per step) instead of the hand-written touches. When it does
 * not, nothing changes: the item-47 touches run exactly as before.
 *
 *   library_procedure_id  a procedure block id from
 *                         services/tcEmailLibrary/source.json ('crown', ...),
 *                         or NULL for a hand-written enrollment
 *   library_variant       the library tone: 'A' warm, 'B' direct,
 *                         'C' educational. Set exactly when the procedure is.
 *
 * Both are wording choices, not patient data.
 *
 * CHECK LITERAL INLINE (house rule): both-or-neither, and the tone is one of
 * the library's three. It is the brief's literal plus `library_variant IS NOT
 * NULL` (see up()). The procedure id is NOT listed in the CHECK: the
 * library's procedure set is versioned with source.json, and the route refuses
 * an id the office's catalog does not have (400 LIBRARY_PROCEDURE_UNKNOWN).
 *
 * NO NEW GRANTS: an ALTER on a table the app role can already read and write
 * (1791100000000_tc_nurture.js grants SELECT, INSERT, UPDATE on it).
 *
 * NUMBERING: the newest tenant migration on origin/develop at authoring time
 * was 1795400000000_tc_email_library_profile.js; 1795500000000 is the number
 * the EL-2 brief assigned and sorts after it.
 *
 * Proven against real Postgres by scripts/tc-nurture-library-verify-queries.js
 * (CI runs it after migrate).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const TABLE = 'tc_nurture_enrollments';
const CHECK_NAME = 'tc_nurture_enrollments_library_check';
exports.TABLE = TABLE;
exports.CHECK_NAME = CHECK_NAME;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns(TABLE, {
    library_procedure_id: { type: 'text', notNull: false },
    library_variant: { type: 'text', notNull: false },
  });
  // `library_variant IS NOT NULL` is load-bearing. Without it, a procedure
  // with a NULL tone makes `library_variant IN (...)` NULL, the whole
  // expression NULL, and a CHECK that evaluates to NULL PASSES — the row the
  // brief says must be refused would be accepted. (Same hole as CO-3's
  // NULL IN() CHECK.) The verify script inserts exactly that row.
  pgm.addConstraint(TABLE, CHECK_NAME, {
    check:
      "(library_procedure_id IS NULL AND library_variant IS NULL) OR (library_procedure_id IS NOT NULL AND library_variant IS NOT NULL AND library_variant IN ('A','B','C'))",
  });
};

/**
 * Drops the two columns (and with them the CHECK). A library enrollment that
 * exists at down() time loses its procedure and tone and would read as a
 * hand-written enrollment of the same track: stop such enrollments first.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint(TABLE, CHECK_NAME, { ifExists: true });
  pgm.dropColumns(TABLE, ['library_procedure_id', 'library_variant'], { ifExists: true });
};
