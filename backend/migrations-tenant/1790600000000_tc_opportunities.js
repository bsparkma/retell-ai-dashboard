'use strict';

/**
 * TC Opportunities inbox (queue item 41): diagnosed-but-unscheduled treatment
 * surfaces itself as CANDIDATES a human claims.
 *
 * TWO NEW TABLES, NOTHING ELSE TOUCHED.
 *
 *   tc_opportunities         one row per (office, Open Dental patient) with
 *                            treatment planned in Open Dental and not on an
 *                            appointment — a SNAPSHOT, never a reference
 *   tc_opportunity_sync      one row per office: the nightly sync's honest
 *                            last-synced / last-attempt state
 *
 * OFFICE. Both tables key on `office_id`, NOT NULL, CHECK ('roland','valley') —
 * the column name and frozen keys every other tc_* table uses
 * (1785373200000_tc_schema.js). The item-41 spec wrote the column as `office`;
 * it is `office_id` here for the same reason item 38's tables spell it that
 * way: a TC query never has to remember which tc_* table spells it which.
 *
 * A PatNum MEANS NOTHING WITHOUT ITS OFFICE. PatNum numbering restarts in every
 * Open Dental database (7115 is a synthetic test patient in valley and a
 * different, real person in roland). The UNIQUE is therefore
 * (office_id, od_patient_id), never od_patient_id alone.
 *
 * SNAPSHOTS. patient_name / patient_phone / procedures are copied out of Open
 * Dental by the nightly sync and nothing here dereferences Open Dental to show
 * them. That is what makes the inbox a Postgres-only read (no on-demand OD
 * fan-out from a UI route) and what keeps a claimed or dismissed row readable
 * after the treatment is completed, deleted, or re-planned in Open Dental.
 *
 * MONEY IS INTEGER CENTS, like every tc_* money column.
 *
 * CHECK LITERALS ARE INLINE, at each addConstraint call. A migration is a
 * record of what a database was told; one that read its vocabulary out of a
 * module would silently change meaning when the module did. The drift that
 * choice creates is paid by backend/test/tcOpportunitiesMigration.test.js,
 * which asserts every literal below against services/tcOpportunities/core.js.
 *
 * GRANTS. Each new table gets the carein_app CRUD grant, role-guarded exactly
 * like tc_schema's block.
 *
 * PHI: patient_name, patient_phone and procedures are PHI. Same handling as
 * every tc_* PHI column.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_opportunities migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** The tables this migration creates — and grants — in creation order. */
const TABLES = ['tc_opportunities', 'tc_opportunity_sync'];
exports.TABLES = TABLES;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // ── tc_opportunities ─────────────────────────────────────────────────────
  pgm.createTable('tc_opportunities', {
    opportunity_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    // bigint, like tc_cases.od_patient_id: Open Dental PatNums are Long.
    od_patient_id: { type: 'bigint', notNull: true },
    // Snapshots. NULL until the sync's name pass reaches this patient (the
    // name read is budgeted per night; see services/tcOpportunities/sync.js).
    patient_name: { type: 'text' }, // PHI
    patient_phone: { type: 'text' }, // PHI
    // Open Dental's PatStatus string ("Patient", "Inactive", …) as last read.
    // The inbox hides a patient Open Dental says is not active.
    patient_status: { type: 'text' },
    // [{ procNum, code, description, feeCents, tooth, surf, plannedDate }] — PHI.
    procedures: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    value_cents: { type: 'bigint', notNull: true, default: 0 },
    // The EARLIEST treatment-plan date among the procedures (how long it has
    // been sitting). NULL only if Open Dental carried no usable DateTP.
    planned_date: { type: 'date' },
    status: { type: 'text', notNull: true, default: 'new' },
    claimed_case_id: { type: 'uuid', references: 'tc_cases', onDelete: 'SET NULL' },
    claimed_by: { type: 'text' },
    claimed_at: { type: 'timestamptz' },
    dismissed_reason: { type: 'text' },
    dismissed_by: { type: 'text' },
    dismissed_at: { type: 'timestamptz' },
    // Set when a dismissed row came back because a NEW procedure appeared.
    resurrected_at: { type: 'timestamptz' },
    // Set when a complete sweep found NO qualifying planned procedure for this
    // patient any more (scheduled, completed, deleted). Cleared if it returns.
    // The status vocabulary is the spec's four values; "gone from Open Dental"
    // is a fact about the source, not a decision anybody made, so it is a
    // timestamp rather than a fifth status.
    cleared_at: { type: 'timestamptz' },
    first_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('tc_opportunities', 'tc_opportunities_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint('tc_opportunities', 'tc_opportunities_status_check', {
    check: "status IN ('new', 'claimed', 'dismissed', 'existing_case')",
  });
  pgm.addConstraint('tc_opportunities', 'tc_opportunities_patient_positive_check', {
    check: 'od_patient_id > 0',
  });
  pgm.addConstraint('tc_opportunities', 'tc_opportunities_value_nonneg_check', {
    check: 'value_cents >= 0',
  });
  pgm.addConstraint('tc_opportunities', 'tc_opportunities_procedures_array_check', {
    check: "jsonb_typeof(procedures) = 'array'",
  });
  // A dismissal always says why. A row that is not dismissed carries no reason.
  pgm.addConstraint('tc_opportunities', 'tc_opportunities_dismissed_reason_check', {
    check:
      "(status = 'dismissed') = (dismissed_reason IS NOT NULL AND length(btrim(dismissed_reason)) > 0)",
  });
  // A claim always names the case it landed on.
  pgm.addConstraint('tc_opportunities', 'tc_opportunities_claimed_case_check', {
    check: "status <> 'claimed' OR claimed_case_id IS NOT NULL",
  });
  pgm.addConstraint('tc_opportunities', 'tc_opportunities_office_patient_unique', {
    unique: ['office_id', 'od_patient_id'],
  });

  pgm.createIndex('tc_opportunities', ['office_id', 'status'], {
    name: 'tc_opportunities_office_status_idx',
  });

  // ── tc_opportunity_sync ──────────────────────────────────────────────────
  pgm.createTable('tc_opportunity_sync', {
    office_id: { type: 'text', primaryKey: true },
    // When a sweep last COMPLETED and was applied. Never moved by a failure.
    last_synced_at: { type: 'timestamptz' },
    // Open Dental's own serverDateTime as of that completed sweep — the
    // DateTStamp watermark a future incremental pass would resume from.
    watermark: { type: 'text' },
    last_attempt_at: { type: 'timestamptz' },
    last_status: { type: 'text' },
    last_error: { type: 'text' },
    procedures_scanned: { type: 'integer' },
    pages: { type: 'integer' },
    patients: { type: 'integer' },
    name_reads: { type: 'integer' },
    names_pending: { type: 'integer' },
    duration_ms: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('tc_opportunity_sync', 'tc_opportunity_sync_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint('tc_opportunity_sync', 'tc_opportunity_sync_status_check', {
    check: "last_status IS NULL OR last_status IN ('ok', 'partial', 'failed')",
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
        RAISE NOTICE 'tc_opportunities: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('tc_opportunity_sync', { ifExists: true });
  pgm.dropTable('tc_opportunities', { ifExists: true });
};
