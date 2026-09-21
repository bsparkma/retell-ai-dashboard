'use strict';

/**
 * Per-tenant data-plane: the perio SEND — one row per attempt to put a staged
 * chart into Open Dental (H4 item 12).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE ROW PER SEND, NOT ONE ROW PER WRITE
 * ═════════════════════════════════════════════════════════════════════════════
 * The arch-string probe found that `POST /perioexams` carries a whole chart in
 * one request, and that a refused body creates nothing. So most of a chart is
 * one atomic write, and the queue-row-per-measurement design of the unmerged
 * PR #177 is not needed. What remains to remember is small and exactly this:
 *
 *   plan              the strings and rows planned from the STAGED chart, frozen
 *                     at confirm, so a resumed send writes what was confirmed.
 *   prior_exam_nums   the patient's exams just before the header was posted —
 *                     how a resumed send adopts the exam it created instead of
 *                     posting a second one.
 *   exam_num          the exam this send created. The ONLY exam the undo may
 *                     delete.
 *   step_token /      a lease: one step at a time per send, so two tabs cannot
 *   step_claimed_at   both read "absent" and both post the same permanent row.
 *
 *   posting → filling → written
 *      ↘ refused   ↘ incomplete → deleted
 *                  ↘ deleted
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CHECKS ARE WRITTEN THE LONG WAY
 * ═════════════════════════════════════════════════════════════════════════════
 * Postgres ACCEPTS a CHECK that evaluates to NULL, so a nullable column is
 * tested with IS [NOT] NULL before anything else is asserted about it.
 *
 * `exam_date` is TEXT with a shape CHECK rather than `date`: node-postgres turns
 * a `date` into a JS Date at LOCAL midnight, and a date that crosses a timezone
 * on its way to Open Dental is an exam filed on the wrong day.
 *
 * Office is on the row and in a composite FK back to the visit, as in
 * 1788200000000_hyg_visit.js: PatNum numbering restarts in every Open Dental
 * database.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[hyg_perio_send migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** Every table this migration creates. One list, so the grant block cannot drift. */
const HYG_PERIO_TABLES = ['hyg_perio_send'];

/**
 * Inline literals, asserted against shared/hyg/perioSend.ts by
 * services/hyg/perioSendSchema.test.js. A migration is a historical record; one
 * that read its vocabulary from today's source would change meaning later.
 */
const PERIO_SEND_STATES = ['posting', 'filling', 'written', 'incomplete', 'refused', 'deleted'];

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.createTable('hyg_perio_send', {
    send_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // No ON DELETE CASCADE: a send that created an exam is a record of something
    // in a patient's chart and must outlive anything tidying the staged row.
    staged_write_id: {
      type: 'uuid',
      notNull: true,
      references: 'hyg_staged_write(staged_write_id)',
    },
    visit_id: { type: 'uuid', notNull: true },
    office: { type: 'text', notNull: true },
    pat_num: { type: 'bigint', notNull: true },
    exam_date: { type: 'text', notNull: true },
    prov_num: { type: 'bigint', notNull: true },
    preview_fingerprint: { type: 'text', notNull: true },
    plan: { type: 'jsonb', notNull: true },
    state: { type: 'text', notNull: true, default: 'posting' },
    exam_num: { type: 'bigint' },
    prior_exam_nums: { type: 'jsonb' },
    rows_written: { type: 'integer', notNull: true, default: 0 },
    mismatches: { type: 'jsonb', notNull: true, default: '[]' },
    error_message: { type: 'text' },
    step_token: { type: 'uuid' },
    step_claimed_at: { type: 'timestamptz' },
    created_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    finished_at: { type: 'timestamptz' },
    deleted_by: { type: 'text' },
    deleted_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_office_check', {
    check: "office IN ('roland', 'valley')",
  });
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_visit_fk', {
    foreignKeys: {
      columns: ['visit_id', 'office'],
      references: 'hyg_visit(visit_id, office)',
    },
  });
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_state_check', {
    check: "state IN ('posting', 'filling', 'written', 'incomplete', 'refused', 'deleted')",
  });
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_exam_date_check', {
    check: "exam_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'",
  });
  // An exam that is being filled, was written, or was deleted is a KNOWN exam.
  // A refused send created nothing, so it can hold no exam number.
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_exam_num_check', {
    check:
      "(state NOT IN ('filling', 'written', 'deleted') OR exam_num IS NOT NULL) AND " +
      "(state <> 'refused' OR exam_num IS NULL)",
  });
  // A failure nobody can read is a failure nobody can act on.
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_reason_check', {
    check: "state NOT IN ('incomplete', 'refused') OR error_message IS NOT NULL",
  });
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_deleted_check', {
    check: "state <> 'deleted' OR (deleted_by IS NOT NULL AND deleted_at IS NOT NULL)",
  });
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_written_check', {
    check: "state <> 'written' OR finished_at IS NOT NULL",
  });
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_rows_check', {
    check: 'rows_written >= 0',
  });
  // A lease is a token AND a time, or neither.
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_lease_check', {
    check: '(step_token IS NULL AND step_claimed_at IS NULL) OR (step_token IS NOT NULL AND step_claimed_at IS NOT NULL)',
  });
  pgm.createIndex('hyg_perio_send', ['visit_id'], { name: 'hyg_perio_send_visit_idx' });
  // ONE send in flight per staged chart. A second confirm while one is posting
  // or filling is refused by the database, not only by the service above it.
  pgm.sql(
    `CREATE UNIQUE INDEX hyg_perio_send_in_flight_key
       ON hyg_perio_send (staged_write_id)
      WHERE state IN ('posting', 'filling');`
  );

  const tableList = HYG_PERIO_TABLES.map((t) => `'${t}'`).join(', ');
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
          EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I', t, r);
        END LOOP;
        RAISE NOTICE 'hyg_perio_send: grants applied to role % on % table(s)', r, ${HYG_PERIO_TABLES.length};
      ELSE
        RAISE NOTICE 'hyg_perio_send: app role % absent - grants SKIPPED. Create the least-privilege role and re-run before serving PHI.', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  for (const table of [...HYG_PERIO_TABLES].reverse()) {
    pgm.dropTable(table, { ifExists: true, cascade: true });
  }
};

exports.HYG_PERIO_TABLES = HYG_PERIO_TABLES;
exports.PERIO_SEND_STATES = PERIO_SEND_STATES;
