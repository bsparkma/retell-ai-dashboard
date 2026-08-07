'use strict';

/**
 * Per-location slice: record WHICH OFFICE each audited Open Dental action touched.
 *
 * Once a tenant has more than one connected Open Dental database, `resource_id`
 * alone stops identifying anything: PatNum numbering restarts per database, so a
 * row saying "CREATE commlog for PatNum 7115" is genuinely ambiguous — 7115 is
 * "Stedi TestValley" in Riley and a different real patient in Roland. The office
 * key is what disambiguates it, which makes this column part of the audit trail's
 * correctness, not decoration.
 *
 * Nullable and with no backfill: rows written before this slice came from the
 * single Roland-bound client, but recording an assumption as if it were observed
 * fact is exactly what an audit log must not do. NULL honestly means "written
 * before offices were tracked".
 *
 * The append-only grant is table-level INSERT (see 1780453117650_audit_log.js), so
 * the app role can write the new column with no additional grant.
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
  pgm.addColumn('audit_log', {
    // Frozen internal office key ('roland' | 'valley' | 'unknown'), never a display
    // name and never PHI.
    office: { type: 'text' },
  });

  // Answers "everything we did in Riley's chart system" without a full scan.
  pgm.createIndex('audit_log', ['office', 'ts'], { name: 'audit_log_office_ts_idx' });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropIndex('audit_log', ['office', 'ts'], { name: 'audit_log_office_ts_idx' });
  pgm.dropColumn('audit_log', 'office');
};
