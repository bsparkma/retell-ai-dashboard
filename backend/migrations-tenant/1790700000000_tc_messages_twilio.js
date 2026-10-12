'use strict';

/**
 * TC messaging, item 39 (Twilio SMS): two columns and two indexes on
 * tc_messages. NO new table, no new vocabulary, no CHECK change.
 *
 *   seen_at, seen_by   when a person first looked at a RECEIVED text, and who.
 *                      Drives the TC nav's "new texts" count. NULL = unseen.
 *                      Only ever set on inbound rows (services/messaging
 *                      markSeen); an outbound row leaves them NULL forever.
 *
 *   tc_messages_provider_id_unique
 *                      UNIQUE (provider, provider_message_id) WHERE the id is
 *                      present. Twilio re-delivers webhooks; the service checks
 *                      for the id before inserting, and this makes a race
 *                      between two deliveries a refused INSERT rather than a
 *                      duplicate text in a patient's thread. It is also the
 *                      index a status callback's lookup rides. Partial, so
 *                      drafts (no provider id yet) are unconstrained.
 *
 *   tc_messages_unseen_idx
 *                      (office_id) WHERE inbound AND seen_at IS NULL — the
 *                      badge count, asked once a minute per open TC shell.
 *
 * The status lifecycle itself is UNCHANGED: Twilio's delivery reports map onto
 * the item-38 set (queued / sent / delivered / failed). The ordering rule lives
 * in services/messaging/twilio/status.js, not in the schema.
 *
 * Grants: ALTER TABLE ADD COLUMN inherits the table's existing carein_app grant
 * (1790300000000), so there is no grant block here.
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
    seen_at: { type: 'timestamptz' },
    seen_by: { type: 'text' },
  });

  pgm.createIndex('tc_messages', ['provider', 'provider_message_id'], {
    name: 'tc_messages_provider_id_unique',
    unique: true,
    where: 'provider_message_id IS NOT NULL',
  });

  pgm.createIndex('tc_messages', ['office_id'], {
    name: 'tc_messages_unseen_idx',
    where: "direction = 'inbound' AND seen_at IS NULL",
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropIndex('tc_messages', ['office_id'], { name: 'tc_messages_unseen_idx', ifExists: true });
  pgm.dropIndex('tc_messages', ['provider', 'provider_message_id'], {
    name: 'tc_messages_provider_id_unique',
    ifExists: true,
  });
  pgm.dropColumns('tc_messages', ['seen_at', 'seen_by'], { ifExists: true });
};
