'use strict';

/**
 * The checkout handoff, and an idempotency key for every hygiene intake
 * (queue item 49).
 *
 * TWO CHANGES, BOTH ADDITIVE.
 *
 *   tc_checkout_handoffs        NEW. One row per checkout alert: "this patient
 *                               is headed to the front desk, here is what was
 *                               staged". NO case — whether a case follows is
 *                               the front desk's decision (item 50).
 *   tc_hygiene_intakes          + source_key text NULL, unique per office when
 *                                 set. A resend after a lost response returns
 *                                 the case it already made instead of opening a
 *                                 second one — closing the gap item 33 recorded
 *                                 ("TC has no idempotency key"). NULL for every
 *                                 existing row and for any caller that sends no
 *                                 key, so nothing that exists changes meaning.
 *
 * OFFICE. `office_id` NOT NULL, CHECK ('roland','valley') — the column name and
 * frozen keys every other tc_* table uses. A PatNum means nothing without its
 * office, so od_patient_id is never unique on its own here either.
 *
 * SNAPSHOTS. patient_name, provider and the payload are copied in at send
 * time; nothing that renders a handoff reads Open Dental or the hygiene visit.
 * They are PHI, handled like every tc_* PHI column.
 *
 * ONE ROW PER SOURCE KEY. UNIQUE (office_id, source_key) is the concurrency
 * arbiter: two racing submits with the same key produce one row, and the loser
 * re-reads the winner. `revision` counts accepted payload updates (the visit
 * Send's final update supersedes the early alert's snapshot); `is_final` marks
 * that the visit Send has spoken, after which a late non-final payload is
 * refused by the route rather than allowed to roll the snapshot back.
 *
 * CHECK LITERALS ARE INLINE. GRANTS: the new table gets the carein_app CRUD
 * grant, role-guarded exactly like tc_opportunities' block. The new column on
 * tc_hygiene_intakes inherits that table's existing grant.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_checkout_handoff migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** The tables this migration creates — and grants. */
const TABLES = ['tc_checkout_handoffs'];
exports.TABLES = TABLES;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // ── tc_hygiene_intakes.source_key ────────────────────────────────────────
  pgm.addColumns('tc_hygiene_intakes', {
    source_key: { type: 'text' },
  });
  pgm.addConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_source_key_shape_check', {
    check: "source_key IS NULL OR source_key ~ '^[A-Za-z0-9:_-]{8,200}$'",
  });
  pgm.createIndex('tc_hygiene_intakes', ['office_id', 'source_key'], {
    name: 'tc_hygiene_intakes_office_source_key_key',
    unique: true,
    where: 'source_key IS NOT NULL',
  });

  // ── tc_checkout_handoffs ─────────────────────────────────────────────────
  pgm.createTable('tc_checkout_handoffs', {
    handoff_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    source_key: { type: 'text', notNull: true },
    // bigint, like tc_cases.od_patient_id: Open Dental PatNums are Long.
    od_patient_id: { type: 'bigint', notNull: true },
    patient_name: { type: 'text', notNull: true }, // PHI snapshot
    provider: { type: 'text', notNull: true, default: '' },
    provider_seen: { type: 'text', notNull: true, default: '' },
    operatory: { type: 'text', notNull: true, default: '' },
    visit_date: { type: 'date', notNull: true },
    // { procedures, priority, nextVisit, notesPending, frontDeskNote,
    //   financialNote } — TcCheckoutSnapshot. PHI.
    payload: { type: 'jsonb', notNull: true },
    is_final: { type: 'boolean', notNull: true, default: false },
    revision: { type: 'integer', notNull: true, default: 1 },
    submitted_by: { type: 'text', notNull: true },
    updated_by: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_patient_positive_check', {
    check: 'od_patient_id > 0',
  });
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_payload_object_check', {
    check: "jsonb_typeof(payload) = 'object'",
  });
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_revision_positive_check', {
    check: 'revision >= 1',
  });
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_source_key_shape_check', {
    check: "source_key ~ '^[A-Za-z0-9:_-]{8,200}$'",
  });
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_office_source_key_unique', {
    unique: ['office_id', 'source_key'],
  });

  // The Checkout page (item 50) reads "today's handoffs, newest first".
  pgm.createIndex('tc_checkout_handoffs', ['office_id', 'visit_date', 'created_at'], {
    name: 'tc_checkout_handoffs_office_day_idx',
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
        RAISE NOTICE 'tc_checkout_handoff: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('tc_checkout_handoffs', { ifExists: true });
  pgm.dropIndex('tc_hygiene_intakes', ['office_id', 'source_key'], {
    name: 'tc_hygiene_intakes_office_source_key_key',
    ifExists: true,
  });
  pgm.dropConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_source_key_shape_check', {
    ifExists: true,
  });
  pgm.dropColumns('tc_hygiene_intakes', ['source_key'], { ifExists: true });
};
