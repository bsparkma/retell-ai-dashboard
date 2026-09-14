'use strict';

/**
 * Per-tenant data-plane: the perio SEND queue — one row per Open Dental write
 * (H4 slice 11).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A QUEUE, AND WHY PER ROW
 * ═════════════════════════════════════════════════════════════════════════════
 * A perio chart goes into Open Dental as ONE `POST /perioexams` and then one
 * `POST /periomeasures` per (tooth, SequenceType). There is no bulk measurement
 * write, and Open Dental serves one request a second on a credential three
 * modules share, so a full chart is minutes of writes, not one request.
 *
 * And a stray Probing row is PERMANENT — `DELETE /periomeasures` accepts only
 * Mobility and SkipTooth. A send that died half way and could not tell what had
 * landed would either stop forever or write a second copy of rows nobody can
 * take out. So every write is a row here, with its own state, persisted BEFORE
 * the call and settled only by READING Open Dental back:
 *
 *     pending → sending → sent → confirmed
 *                  ↘ failed (with Open Dental's own words)
 *
 *   sending    claimed, the POST is going out or its answer never came. Nobody
 *              re-sends it until its lease has expired, and then only after a
 *              read shows it did not land.
 *   sent       Open Dental answered OK. Not the claim yet.
 *   confirmed  read back out of the exam, values equal. `od_ref` holds the
 *              number Open Dental minted, and the CHECK below refuses a
 *              confirmed row without one.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CHECKS ARE WRITTEN THE LONG WAY
 * ═════════════════════════════════════════════════════════════════════════════
 * Postgres ACCEPTS a CHECK that evaluates to NULL. `tooth BETWEEN 1 AND 32` on
 * a NULL tooth is NULL, and an OR of NULL and false is NULL — accepted. So every
 * nullable column in a CHECK here is tested with IS [NOT] NULL first, the trap
 * RCM's Stage B1 and C-2 constraints were written around.
 *
 * Office is on the row and in a composite FK back to the visit, exactly as in
 * 1788200000000_hyg_visit.js and for the same reason: PatNum numbering restarts
 * in every Open Dental database.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[hyg_perio_send migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** Every table this migration creates. One list, so the grant block cannot drift. */
const HYG_PERIO_TABLES = ['hyg_perio_send_row'];

/**
 * Inline literals, asserted against shared/hyg/perio.ts by
 * services/hyg/perioSendSchema.test.js. A migration is a historical record; one
 * that read its vocabulary from today's source would change meaning later.
 */
const PERIO_SEND_ROW_STATES = ['pending', 'sending', 'sent', 'confirmed', 'failed'];
const PERIO_SEND_SEQUENCE_TYPES = ['Probing', 'BleedSupPlaqCalc', 'SkipTooth'];

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.createTable('hyg_perio_send_row', {
    send_row_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    staged_write_id: {
      type: 'uuid',
      notNull: true,
      references: 'hyg_staged_write(staged_write_id)',
      onDelete: 'CASCADE',
    },
    visit_id: { type: 'uuid', notNull: true },
    office: { type: 'text', notNull: true },
    /** 0 is the exam header; measurements follow in tooth order. */
    seq: { type: 'integer', notNull: true },
    target: { type: 'text', notNull: true },
    tooth: { type: 'integer' },
    sequence_type: { type: 'text' },
    /** The exact body posted, minus the PerioExamNum a measurement learns later. */
    body: { type: 'jsonb', notNull: true },
    state: { type: 'text', notNull: true, default: 'pending' },
    /** PerioExamNum for the exam row, PerioMeasureNum for a measurement. */
    od_ref: { type: 'bigint' },
    error_message: { type: 'text' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    claimed_at: { type: 'timestamptz' },
    confirmed_at: { type: 'timestamptz' },
    /**
     * Exam row only: the patient's PerioExamNums that existed JUST BEFORE the
     * header was posted. How a resumed send tells the exam it created from one
     * that was already there, without posting a second header.
     */
    prior_exam_nums: { type: 'jsonb' },
    /** Who confirmed the send. The staged write's sent_by comes from here. */
    created_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('hyg_perio_send_row', 'hyg_perio_send_row_office_check', {
    check: "office IN ('roland', 'valley')",
  });
  pgm.addConstraint('hyg_perio_send_row', 'hyg_perio_send_row_visit_fk', {
    foreignKeys: {
      columns: ['visit_id', 'office'],
      references: 'hyg_visit(visit_id, office)',
      onDelete: 'CASCADE',
    },
  });
  pgm.addConstraint('hyg_perio_send_row', 'hyg_perio_send_row_state_check', {
    check: "state IN ('pending', 'sending', 'sent', 'confirmed', 'failed')",
  });
  // The exam header names no tooth; a measurement names a permanent tooth and one
  // of the three sequence types v1 writes. CAL is not among them — Open Dental
  // derives it and never stores it.
  pgm.addConstraint('hyg_perio_send_row', 'hyg_perio_send_row_shape_check', {
    check:
      "(target = 'exam' AND seq = 0 AND tooth IS NULL AND sequence_type IS NULL) OR " +
      "(target = 'measure' AND seq > 0 AND tooth IS NOT NULL AND tooth BETWEEN 1 AND 32 " +
      "AND sequence_type IS NOT NULL AND sequence_type IN ('Probing', 'BleedSupPlaqCalc', 'SkipTooth'))",
  });
  pgm.addConstraint('hyg_perio_send_row', 'hyg_perio_send_row_failed_reason_check', {
    check: "state <> 'failed' OR error_message IS NOT NULL",
  });
  // "It is in the chart" is only a claim with the number Open Dental minted.
  pgm.addConstraint('hyg_perio_send_row', 'hyg_perio_send_row_confirmed_ref_check', {
    check: "state <> 'confirmed' OR (od_ref IS NOT NULL AND confirmed_at IS NOT NULL)",
  });
  pgm.addConstraint('hyg_perio_send_row', 'hyg_perio_send_row_seq_key', {
    unique: ['staged_write_id', 'seq'],
  });
  pgm.createIndex('hyg_perio_send_row', ['staged_write_id'], {
    name: 'hyg_perio_send_row_staged_idx',
  });
  // One row per (tooth, SequenceType) per send — the same uniqueness Open Dental
  // has, so a queue can never plan the same measurement twice.
  pgm.sql(
    `CREATE UNIQUE INDEX hyg_perio_send_row_measure_key
       ON hyg_perio_send_row (staged_write_id, tooth, sequence_type)
      WHERE target = 'measure';`
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
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', t, r);
        END LOOP;
        RAISE NOTICE 'hyg_perio_send: CRUD grants applied to role % on % table(s)', r, ${HYG_PERIO_TABLES.length};
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
exports.PERIO_SEND_ROW_STATES = PERIO_SEND_ROW_STATES;
exports.PERIO_SEND_SEQUENCE_TYPES = PERIO_SEND_SEQUENCE_TYPES;
