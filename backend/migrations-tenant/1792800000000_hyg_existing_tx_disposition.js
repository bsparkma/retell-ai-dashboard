'use strict';

/**
 * Per-tenant data-plane: EXISTING TREATMENT DISPOSITIONS (hygiene Slice 2a).
 *
 * One row per (office, visit, Open Dental ProcNum): what the hygienist recorded
 * about a procedure that was ALREADY treatment-planned in Open Dental before
 * this visit — "anything changed clinically?" and "what did the patient say?".
 *
 * CareIN ONLY. Nothing in this table is written to Open Dental, and a
 * `worse_urgent` answer changes a priority on CareIN's screens, never the
 * procedure's priority in the chart.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. `office` IS ON THE ROW, AND THE FK CARRIES IT
 * ═════════════════════════════════════════════════════════════════════════════
 * A ProcNum, like a PatNum, restarts in every Open Dental database. The same
 * ProcNum in roland and valley is two different procedures on two different
 * people, so `office` is NOT NULL with its own CHECK, and the composite FK back
 * to hyg_visit(visit_id, office) means a disposition whose office disagrees with
 * its visit's cannot be stored. UNIQUE (office, visit_id, proc_num) is what the
 * PUT upserts on.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. THE VOCABULARIES ARE INLINE LITERALS, PINNED TO THE CONTRACT BY A TEST
 * ═════════════════════════════════════════════════════════════════════════════
 * Same reasoning as 1788200000000_hyg_visit.js: a migration is a record of what
 * the database was told, so it does not read its CHECK out of today's source.
 * services/hyg/existingTxSchema.test.js asserts these lists equal
 * shared/hyg/existingTx.ts.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. THE CHECKS ARE WRITTEN THE LONG WAY
 * ═════════════════════════════════════════════════════════════════════════════
 * Postgres ACCEPTS a CHECK that evaluates to NULL. `wait_timeframe IN (…)` on a
 * NULL is NULL, and so is a naive "only with wants_to_wait" comparison, so every
 * nullable column below states its NULL case explicitly.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 4. `proc_snapshot` IS THE SERVER'S OWN READ, NEVER THE CLIENT'S
 * ═════════════════════════════════════════════════════════════════════════════
 * code, description, tooth, surface, date_tp, priority_name — taken from the
 * Open Dental read the route itself made for this office and PatNum when the row
 * was saved. It records what the procedure WAS when somebody answered about it,
 * so a later "Last discussed" line still names the right work after the plan
 * changes in Open Dental.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

// Least-privilege app role — the same role-guarded GRANT every table-creating
// migration in this repo carries. See 1788200000000_hyg_visit.js.
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[hyg_existing_tx_disposition migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

const TABLE = 'hyg_existing_tx_disposition';

/** The frozen office keys. Mirrors config/officeAgents.js and the contract. */
const OFFICE_CHECK = "office IN ('roland', 'valley')";

const CLINICAL = ['no_change', 'worse_urgent', 're_evaluate', 'no_longer_needed'];
const PATIENT = [
  'not_discussed',
  'ready_to_schedule',
  'wants_to_wait',
  'see_plan_again',
  'cost_questions',
  'declined',
];
const WAIT_TIMEFRAMES = ['1_month', '3_months', '6_months', 'next_recall'];
const NOTE_MAX = 500;

/** SQL list literal for a CHECK, from a JS array. */
const list = (values) => values.map((v) => `'${v}'`).join(', ');

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office: { type: 'text', notNull: true },
    visit_id: { type: 'uuid', notNull: true },
    pat_num: { type: 'bigint', notNull: true },
    proc_num: { type: 'bigint', notNull: true },
    clinical: { type: 'text' },
    patient: { type: 'text', notNull: true, default: 'not_discussed' },
    wait_timeframe: { type: 'text' },
    note: { type: 'text' },
    proc_snapshot: { type: 'jsonb', notNull: true },
    created_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_by: { type: 'text', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint(TABLE, `${TABLE}_office_check`, { check: OFFICE_CHECK });
  // Note 1: the child's office MUST equal its visit's.
  pgm.addConstraint(TABLE, `${TABLE}_visit_fk`, {
    foreignKeys: {
      columns: ['visit_id', 'office'],
      references: 'hyg_visit(visit_id, office)',
      onDelete: 'CASCADE',
    },
  });
  pgm.addConstraint(TABLE, `${TABLE}_key`, { unique: ['office', 'visit_id', 'proc_num'] });
  pgm.addConstraint(TABLE, `${TABLE}_pat_num_check`, { check: 'pat_num > 0' });
  pgm.addConstraint(TABLE, `${TABLE}_proc_num_check`, { check: 'proc_num > 0' });

  // Note 3: every nullable column states its NULL case.
  pgm.addConstraint(TABLE, `${TABLE}_clinical_check`, {
    check: `clinical IS NULL OR clinical IN (${list(CLINICAL)})`,
  });
  pgm.addConstraint(TABLE, `${TABLE}_patient_check`, {
    check: `patient IN (${list(PATIENT)})`,
  });
  pgm.addConstraint(TABLE, `${TABLE}_wait_timeframe_check`, {
    check: `wait_timeframe IS NULL OR wait_timeframe IN (${list(WAIT_TIMEFRAMES)})`,
  });
  // A timeframe only with "wants to wait". `patient` is NOT NULL, so the first
  // term is never NULL, and `IS NULL` never is either.
  pgm.addConstraint(TABLE, `${TABLE}_wait_only_when_waiting_check`, {
    check: "patient = 'wants_to_wait' OR wait_timeframe IS NULL",
  });
  pgm.addConstraint(TABLE, `${TABLE}_note_check`, {
    check: `note IS NULL OR char_length(note) <= ${NOTE_MAX}`,
  });
  pgm.addConstraint(TABLE, `${TABLE}_proc_snapshot_check`, {
    check: "jsonb_typeof(proc_snapshot) = 'object'",
  });

  // "Last discussed": the earlier visits' answers for this office, patient and
  // procedure.
  pgm.createIndex(TABLE, ['office', 'pat_num', 'proc_num'], {
    name: `${TABLE}_patient_proc_idx`,
  });

  // ── App-role grants (CRUD scope) ───────────────────────────────────────────
  // uuid PK via gen_random_uuid(), so no sequence grant. Absent role (local dev
  // on a superuser) → skipped with a NOTICE. down() needs no revoke.
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', '${TABLE}');
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', '${TABLE}', r);
        RAISE NOTICE '${TABLE}: CRUD grants applied to role %', r;
      ELSE
        RAISE NOTICE '${TABLE}: app role % absent - grants SKIPPED. Create the least-privilege role and re-run before serving PHI.', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable(TABLE, { ifExists: true, cascade: true });
};

/** Exported for the test that asserts these against shared/hyg/existingTx.ts. */
exports.TABLE = TABLE;
exports.CLINICAL = CLINICAL;
exports.PATIENT = PATIENT;
exports.WAIT_TIMEFRAMES = WAIT_TIMEFRAMES;
exports.NOTE_MAX = NOTE_MAX;
