'use strict';

/**
 * Opportunities inbox window (queue item 45): one more tc_library_config
 * section, `opportunities_config`, and nothing else.
 *
 * The per-office TC settings seam is tc_library_config — one row per
 * (office, section), each section's jsonb validated by the shared contract's
 * LibrarySectionSchemas (new-dashboard/shared/tc/contract.ts). The section
 * list is ALSO a CHECK on the table (1785373200000_tc_schema.js), so a new
 * section is a CHECK change: drop the constraint, add it back with one more
 * literal. The literals stay INLINE (repo rule: a CHECK is read where it is
 * declared, not assembled from an import).
 *
 *   opportunities_config  { opportunitiesWindowMonths: int 1..24, default 18 }
 *                         How far back the Opportunities inbox SHOWS plans, by
 *                         the newest planned procedure on a row. Display only:
 *                         the nightly sync's 730-day capture is untouched.
 *
 * No row is written. An office with no row reads the contract default (18).
 *
 * The CHECK and the contract are pinned equal by
 * test/tcLibraryOpportunitiesConfigMigration.test.js.
 *
 * Sorts after item 40's 1790800000000.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const CONSTRAINT = 'tc_library_config_section_check';

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.dropConstraint('tc_library_config', CONSTRAINT, { ifExists: true });
  pgm.addConstraint('tc_library_config', CONSTRAINT, {
    check:
      "section IN ('stages','objections','motivators','lost_reasons','referral_sources','treatment_categories','financing_providers','crown_pricing','financing_config','cadence_config','financing_settings','opportunities_config')",
  });
};

/**
 * Back to the eleven sections of 1785373200000. A stored opportunities_config
 * row would violate the narrower CHECK, so it is removed first — the offices
 * then read the default window again, which is what "no row" has always meant.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.sql("DELETE FROM tc_library_config WHERE section = 'opportunities_config'");
  pgm.dropConstraint('tc_library_config', CONSTRAINT, { ifExists: true });
  pgm.addConstraint('tc_library_config', CONSTRAINT, {
    check:
      "section IN ('stages','objections','motivators','lost_reasons','referral_sources','treatment_categories','financing_providers','crown_pricing','financing_config','cadence_config','financing_settings')",
  });
};
