'use strict';

/**
 * app_user.auth_provider + app_user.external_sub — which door a person's row
 * is bound to, and (for the external door) WHICH external identity owns it.
 *
 * WHY: the external sign-in door (Entra External ID: Google or an email
 * one-time code, config/extSso.js) admits anybody who can prove they control a
 * mailbox. The app_user row is the only gate on that door, so the FIRST
 * external identity to sign in as an address binds to it (external_sub = the
 * token's `sub`) and every later sign-in must present the same one. A second
 * Google account that happens to claim the same address is refused rather
 * than quietly handed the first person's role.
 *
 *   auth_provider  NULL       unbound — no door has claimed this row yet
 *                  'entra'    staff Microsoft account; the external door refuses it
 *                  'external' bound by the external door to `external_sub`
 *   external_sub   the External ID token `sub` this row is bound to, or NULL
 *
 * NO BACKFILL HERE. Existing rows keep NULL in both columns and the staff sign-in
 * path never writes either in this slice, so nobody's sign-in changes until a
 * row is bound by an external sign-in.
 *
 * UNIQUE on external_sub (partial, NOT NULL only): one external identity can
 * own at most one row. Partial because every unbound row is NULL.
 *
 * Additive and reversible: down() drops the index, the constraint and both
 * columns, and touches nothing else.
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
    auth_provider: { type: 'text', notNull: false },
    external_sub: { type: 'text', notNull: false },
  });
  pgm.addConstraint('app_user', 'app_user_auth_provider_check', {
    check: "auth_provider IN ('entra', 'external')",
  });
  pgm.createIndex('app_user', 'external_sub', {
    name: 'app_user_external_sub_key',
    unique: true,
    where: 'external_sub IS NOT NULL',
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropIndex('app_user', 'external_sub', { name: 'app_user_external_sub_key' });
  pgm.dropConstraint('app_user', 'app_user_auth_provider_check');
  pgm.dropColumns('app_user', ['auth_provider', 'external_sub']);
};
