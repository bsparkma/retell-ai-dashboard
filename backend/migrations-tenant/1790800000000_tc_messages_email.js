'use strict';

/**
 * TC email over ACS (queue item 40): three columns and one index on
 * tc_messages, nothing else. No new table, no CHECK change.
 *
 *   email_blocks           jsonb   the library-template SNAPSHOT of an email
 *                                  draft (shared/tc/emailBlocks.ts shape, read
 *                                  leniently by shared/tc/emailRender.ts).
 *                                  NULL = a plain-text email. Taken when the
 *                                  draft is written, so what the TC previewed is
 *                                  what is sent even if the template changes.
 *                                  PHI (the patient's first name is filled in).
 *   email_preheader        text    the template's preheader, filled. PHI-adjacent.
 *   unsubscribe_token_hash text    SHA-256 (hex) of the one-time token in this
 *                                  email's unsubscribe link. The token itself is
 *                                  never stored. The ROW is the binding: its
 *                                  office_id and to_address are what a click
 *                                  opts out, so the link carries nothing else.
 *
 * The index is UNIQUE where present, so one token can never name two emails,
 * and the public unsubscribe endpoint's lookup is an index probe.
 *
 * tc_contact_consent.source already allows 'unsubscribe_link' (item 38's
 * CHECK, 1790300000000_tc_messaging.js), so the consent table is untouched.
 *
 * Sorts after item 39's 1790400000000.
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
  pgm.addColumns('tc_messages', {
    email_blocks: { type: 'jsonb' },
    email_preheader: { type: 'text' },
    unsubscribe_token_hash: { type: 'text' },
  });

  pgm.createIndex('tc_messages', ['unsubscribe_token_hash'], {
    name: 'tc_messages_unsubscribe_token_unique',
    unique: true,
    where: 'unsubscribe_token_hash IS NOT NULL',
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropIndex('tc_messages', ['unsubscribe_token_hash'], {
    name: 'tc_messages_unsubscribe_token_unique',
    ifExists: true,
  });
  pgm.dropColumns('tc_messages', ['email_blocks', 'email_preheader', 'unsubscribe_token_hash'], { ifExists: true });
};
