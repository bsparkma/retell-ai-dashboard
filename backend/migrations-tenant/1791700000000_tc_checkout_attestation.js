'use strict';

/**
 * "Entered in Open Dental" attestations for a checkout's staged treatment
 * (queue item 50b, Checkout C2b, PM revision).
 *
 * Beau's requirement: the hygienist's diagnosed treatment stays visible on the
 * TC case until a HUMAN confirms it was entered into Open Dental. The staff
 * panel renders the handoff's stored snapshot (tc_checkout_handoffs.payload,
 * no new storage); this table is only the per-item confirmation.
 *
 *   - A row = "a person attests this item is in Open Dental". It is a manual
 *     attestation, NOT a sync: nothing here reads or writes Open Dental.
 *   - Keyed (office_id, handoff_id, item_index). `item_key` is the item it was
 *     made against (code + teeth + surfaces); a later visit Send that revises
 *     the snapshot leaves the row STALE (key mismatch), which reads as not
 *     entered, rather than silently carrying a confirmation to a different
 *     procedure.
 *   - Un-attesting deletes the row (admin-only, audited); audit_log holds the
 *     history, append-only.
 *   - Composite FK (office_id, handoff_id) → tc_checkout_handoffs: a row can
 *     never point at another office's handoff. That needs a UNIQUE over the
 *     pair on the parent (handoff_id is already the PK, so it always holds).
 *   - ON DELETE CASCADE: the attestation means nothing without its handoff.
 *
 * Also an index on tc_checkout_handoffs (office_id, case_id) for the panel and
 * the pipeline badge, which look handoffs up by case.
 *
 * Office CHECK literal written INLINE (house rule). carein_app grant in this
 * same migration.
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_checkout_attestation migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** The tables this migration creates — and grants. */
const TABLES = ['tc_checkout_attestations'];
exports.TABLES = TABLES;

exports.up = (pgm) => {
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_office_handoff_unique', {
    unique: ['office_id', 'handoff_id'],
  });
  pgm.createIndex('tc_checkout_handoffs', ['office_id', 'case_id'], {
    name: 'tc_checkout_handoffs_office_case_idx',
    where: 'case_id IS NOT NULL',
  });

  pgm.createTable('tc_checkout_attestations', {
    office_id: { type: 'text', notNull: true, primaryKey: true },
    handoff_id: { type: 'uuid', notNull: true, primaryKey: true },
    item_index: { type: 'integer', notNull: true, primaryKey: true },
    item_key: { type: 'text', notNull: true },
    attested_by: { type: 'text', notNull: true },
    attested_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('tc_checkout_attestations', 'tc_checkout_attestations_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint('tc_checkout_attestations', 'tc_checkout_attestations_index_check', {
    check: 'item_index >= 0 AND item_index < 100',
  });
  pgm.addConstraint('tc_checkout_attestations', 'tc_checkout_attestations_handoff_fk', {
    foreignKeys: {
      columns: ['office_id', 'handoff_id'],
      references: 'tc_checkout_handoffs(office_id, handoff_id)',
      onDelete: 'CASCADE',
    },
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
        RAISE NOTICE 'tc_checkout_attestation: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('tc_checkout_attestations', { ifExists: true });
  pgm.dropIndex('tc_checkout_handoffs', ['office_id', 'case_id'], {
    name: 'tc_checkout_handoffs_office_case_idx',
    ifExists: true,
  });
  pgm.dropConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_office_handoff_unique', {
    ifExists: true,
  });
};
