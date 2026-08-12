'use strict';

/**
 * app_user.home_office — the office a person usually works at.
 *
 * WHAT IT IS: a DEFAULT, not a restriction (Beau's explicit decision). It seeds
 * the office picker on sign-in and does nothing else — every office stays
 * reachable from every surface, because staff float between the two locations
 * and a hygienist covering at the other office must not be locked out of it.
 * No route, query or record is denied on the strength of this column.
 *
 * WHY IT IS NULLABLE AND UNDEFAULTED: "no home office" is a real answer, not a
 * gap to be filled. temp@carein.ai is one shared, rotated account for temp
 * hygienists; giving it a home office would be a guess, and the office picker
 * is the natural "which office are you at today?" prompt instead. Existing rows
 * therefore need no backfill and nobody's experience changes until an admin
 * sets a value.
 *
 * WHY THERE IS NO CHECK CONSTRAINT: offices are CONFIG, not schema
 * (config/officeAgents.js, config/odOffices.js — "adding an office is a config
 * change, not new code"). A CHECK listing 'roland' and 'valley' would make
 * opening a third office a migration, and would leave a stale value
 * unwritable-but-still-stored the day an office is renamed. /api/users
 * validates the value against the live office roster at write time, and
 * OfficeContext ignores a home office the roster no longer contains — so a
 * stale value degrades to "all offices" rather than stranding anyone.
 *
 * Additive and reversible: down() drops the column and touches nothing else.
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
  pgm.addColumns('app_user', {
    home_office: { type: 'text', notNull: false },
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('app_user', ['home_office']);
};
