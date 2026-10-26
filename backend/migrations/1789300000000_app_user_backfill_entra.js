'use strict';

/**
 * Mark every EXISTING app_user row auth_provider = 'entra' (S2b round 2).
 *
 * WHY: 1789200000000 added auth_provider with no backfill, so every staff row
 * read NULL — "unbound" — and the external sign-in door (Google or an email
 * one-time code) would bind any of them for whoever controlled the mailbox.
 * The door already refuses an 'entra' row; this migration makes every row
 * that predates the door one.
 *
 * Every row present when this runs is a Microsoft-staff row: the external door
 * ships dark and binds nothing until it is configured, and it binds by setting
 * auth_provider itself. So after this migration the external door can bind
 * ONLY a row added later whose auth_provider is still NULL.
 *
 * REVERSIBLE WITHOUT GUESSING. up() records the user_id of every row it
 * changed in app_user_entra_backfill; down() resets exactly those rows (and
 * only while they still read 'entra' with no external_sub) and drops the
 * ledger. A row marked 'entra' by anything else is left alone.
 *
 * The ledger is migration bookkeeping only. The app never reads it, so it gets
 * no carein_app GRANT. ON DELETE CASCADE keeps it from blocking a user delete.
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
  pgm.createTable('app_user_entra_backfill', {
    user_id: { type: 'uuid', primaryKey: true, references: 'app_user', onDelete: 'CASCADE' },
    backfilled_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    WITH marked AS (
      UPDATE app_user
         SET auth_provider = 'entra'
       WHERE auth_provider IS NULL
      RETURNING user_id
    )
    INSERT INTO app_user_entra_backfill (user_id)
    SELECT user_id FROM marked
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE app_user u
       SET auth_provider = NULL
      FROM app_user_entra_backfill b
     WHERE u.user_id = b.user_id
       AND u.auth_provider = 'entra'
       AND u.external_sub IS NULL
  `);
  pgm.dropTable('app_user_entra_backfill');
};
