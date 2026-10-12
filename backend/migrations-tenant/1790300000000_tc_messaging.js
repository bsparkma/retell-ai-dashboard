'use strict';

/**
 * TC messaging foundation (queue item 38): patient messages and contact consent.
 *
 * TWO NEW TABLES, NOTHING ELSE TOUCHED.
 *
 *   tc_messages          one row per patient message, outbound or inbound
 *   tc_contact_consent   one row per (office, channel, address): opted in/out
 *
 * REVIEW-THEN-SEND. A row is born `draft` and only a human clicking Send on
 * that row moves it on (services/messaging/index.js). Nothing in this schema
 * schedules, batches, or queues a send on its own.
 *
 * OFFICE. Both tables key on `office_id`, NOT NULL, CHECK ('roland','valley') —
 * the same column name and the same frozen keys every other tc_* table uses
 * (1785373200000_tc_schema.js). An address means nothing without its office:
 * the consent UNIQUE is (office_id, channel, address), and both message indexes
 * lead with office_id. The item-38 spec wrote the column as `office`; it is
 * `office_id` here so a TC query never has to remember which tc_* table spells
 * it which way.
 *
 * CHECK LITERALS ARE INLINE, at the addConstraint call. A migration is a record
 * of what a database was told; one that read its vocabulary out of today's
 * contract would silently change meaning when the contract did. The drift that
 * choice creates is paid by backend/test/tcMessagingMigration.test.js, which
 * asserts every literal below against the shared/tc/messaging.ts zod enums.
 *
 * template_id is TEXT with no foreign key: this slice's follow-up templates are
 * keys in code (services/messaging/templates.js), not tc_email_templates rows.
 * A uuid from that table fits in the same column when email lands (item 40).
 *
 * PHI: to_address, from_address, body, subject (messages) and address, note
 * (consent) are PHI. Same handling as every tc_* PHI column.
 *
 * GRANTS. Each new table gets the carein_app CRUD grant, role-guarded exactly
 * like tc_schema's block. A table the least-privilege role cannot reach fails
 * as a permission error in production, not as a red migration.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_messaging migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** The tables this migration creates — and grants — in creation order. */
const TABLES = ['tc_messages', 'tc_contact_consent'];
exports.TABLES = TABLES;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // gen_random_uuid() — tc_schema already created this; IF NOT EXISTS keeps a
  // replay on a fresh database honest.
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // ── tc_messages ──────────────────────────────────────────────────────────
  pgm.createTable('tc_messages', {
    message_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    // Nullable: an inbound message nobody has matched to a case yet. A case
    // deleted later keeps its message history, unlinked, rather than losing it.
    case_id: { type: 'uuid', references: 'tc_cases', onDelete: 'SET NULL' },
    direction: { type: 'text', notNull: true },
    channel: { type: 'text', notNull: true },
    to_address: { type: 'text' }, // PHI — server-assembled from the case, never client-supplied
    from_address: { type: 'text' }, // PHI on inbound; the practice's sender on outbound
    body: { type: 'text', notNull: true, default: '' }, // PHI
    subject: { type: 'text' }, // email only; PHI
    template_id: { type: 'text' },
    status: { type: 'text', notNull: true },
    provider: { type: 'text' },
    provider_message_id: { type: 'text' },
    error: { type: 'text' }, // the provider's refusal, preserved verbatim on `failed`
    created_by: { type: 'text' },
    sent_by: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    sent_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('tc_messages', 'tc_messages_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint('tc_messages', 'tc_messages_direction_check', {
    check: "direction IN ('outbound', 'inbound')",
  });
  pgm.addConstraint('tc_messages', 'tc_messages_channel_check', {
    check: "channel IN ('sms', 'email')",
  });
  pgm.addConstraint('tc_messages', 'tc_messages_status_check', {
    check: "status IN ('draft', 'queued', 'sending', 'sent', 'delivered', 'failed', 'received')",
  });

  pgm.createIndex('tc_messages', ['office_id', 'case_id'], { name: 'tc_messages_office_case_idx' });
  pgm.createIndex('tc_messages', ['office_id', 'to_address'], { name: 'tc_messages_office_to_idx' });

  // ── tc_contact_consent ───────────────────────────────────────────────────
  pgm.createTable('tc_contact_consent', {
    consent_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    channel: { type: 'text', notNull: true },
    address: { type: 'text', notNull: true }, // PHI — E.164 phone or lower-cased email
    state: { type: 'text', notNull: true },
    source: { type: 'text', notNull: true },
    note: { type: 'text' }, // PHI-adjacent free text; never copied into the audit trail
    updated_by: { type: 'text' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('tc_contact_consent', 'tc_contact_consent_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint('tc_contact_consent', 'tc_contact_consent_channel_check', {
    check: "channel IN ('sms', 'email')",
  });
  pgm.addConstraint('tc_contact_consent', 'tc_contact_consent_state_check', {
    check: "state IN ('opted_in', 'opted_out', 'unknown')",
  });
  pgm.addConstraint('tc_contact_consent', 'tc_contact_consent_source_check', {
    check: "source IN ('od', 'stop_keyword', 'manual', 'unsubscribe_link')",
  });
  pgm.addConstraint('tc_contact_consent', 'tc_contact_consent_address_unique', {
    unique: ['office_id', 'channel', 'address'],
  });

  // ── carein_app grants (tc_schema's mechanism, CRUD scope) ────────────────
  const tableList = TABLES.map((t) => `'${t}'`).join(', ');
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
            t text;
    BEGIN
      FOREACH t IN ARRAY ARRAY[${tableList}] LOOP
        EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
      END LOOP;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        FOREACH t IN ARRAY ARRAY[${tableList}] LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', t, r);
        END LOOP;
      ELSE
        RAISE NOTICE 'tc_messaging: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  // Dropping a table drops its constraints, indexes and grants with it.
  pgm.dropTable('tc_contact_consent', { ifExists: true });
  pgm.dropTable('tc_messages', { ifExists: true });
};
