'use strict';

/**
 * Cross-office chart target: record WHERE THE CALL CAME IN, next to which chart
 * we wrote.
 *
 * `office` (added by 1785900000000_audit_log_office.js) records the office whose
 * Open Dental database an audited action touched — the chart. Until now that was
 * always, necessarily, the call's own office: the target was derived from the
 * call and nothing could redirect it.
 *
 * A user may now deliberately aim a chart write at a DIFFERENT office than the
 * one the call came in on — the front desk at one practice taking a call for a
 * patient of the other. Once that is possible, `office` alone stops telling the
 * whole story: it says whose chart was written, but not whose call prompted it,
 * and "why is there a Roland chart note from a call that rang at Riley?" is
 * exactly the question an audit trail has to be able to answer.
 *
 *     office         = the chart that was written / searched   (the TARGET)
 *     origin_office  = the office the call itself belongs to   (the ORIGIN)
 *
 * A cross-office action is therefore `origin_office IS DISTINCT FROM office`,
 * answerable without joining anything.
 *
 * Nullable and with no backfill, for the same reason the office column carried
 * none: every row written before this slice came from a path where origin and
 * target could not differ, but writing that inference into the log as though it
 * had been observed is what an audit log must never do. NULL honestly means
 * "written before the origin was tracked".
 *
 * The append-only grant is table-level INSERT (see 1780453117650_audit_log.js),
 * so the app role can write the new column with no additional grant.
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
    // Frozen internal office key ('roland' | 'valley' | 'unknown'), never a
    // display name and never PHI — same class of value as `office`.
    origin_office: { type: 'text' },
  });

  // "Every cross-office chart action, newest first" without a full scan. Partial
  // on the cross-office rows only: same-office actions are the overwhelming
  // majority and are already served by audit_log_office_ts_idx.
  pgm.createIndex('audit_log', ['origin_office', 'office', 'ts'], {
    name: 'audit_log_cross_office_idx',
    where: 'origin_office IS NOT NULL AND origin_office IS DISTINCT FROM office',
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropIndex('audit_log', ['origin_office', 'office', 'ts'], {
    name: 'audit_log_cross_office_idx',
  });
  pgm.dropColumn('audit_log', 'origin_office');
};
