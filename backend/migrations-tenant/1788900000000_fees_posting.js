'use strict';

/**
 * Per-tenant data-plane: POSTING a parsed fee schedule into Open Dental
 * (Fee Schedule slice 3).
 *
 * Slice 1 stored what a file said. This migration adds the three things needed
 * to act on it: a decision per warned row, a state machine per batch, and the
 * snapshot a rollback restores from.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. THE STATE MACHINE, AND WHY `post_failed` CARRIES A NUMBER
 * ═════════════════════════════════════════════════════════════════════════════
 *     parsed ──► ready ──► posting ──► posted
 *                             └──────► post_failed ──► rolled_back
 *                                        posted ─────► rolled_back
 *
 * `failed` is slice 1's PARSE failure and is unrelated to any of these — a file
 * that never parsed can never be posted. It keeps its own columns
 * (`failure_reason`, `failure_code`); posting failures get `post_error`, and the
 * two are deliberately separate so "this file is unreadable" and "we got
 * halfway into your database" can never be confused for one another.
 *
 * `rows_written` IS NOT NULL WITH A DEFAULT OF 0, ON EVERY BATCH. This is the
 * W-21 lesson from RCM built in from the start rather than retrofitted: a run
 * that reports `post_failed` must never be readable as "nothing was written".
 * It writes fee by fee against a throttled credential, so a failure at row 300
 * of 500 leaves 299 fees in a real practice's database. A status column alone
 * says "failed"; a person then assumes the schedule is untouched and re-posts,
 * and now the practice has been written twice. Because the column is NOT NULL
 * with a default, there is no state in which the count is missing — the UI can
 * always say how far it got, and the rollback always knows there is something
 * to undo.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. A WARNED ROW BLOCKS POSTING UNTIL A HUMAN DECIDES
 * ═════════════════════════════════════════════════════════════════════════════
 * `decision` is `pending | accepted | excluded`, defaulting to `pending`.
 *
 * A CLEAN row needs no decision — the gate is a predicate, not a checklist:
 *
 *     blocking  ⟺  jsonb_array_length(parse_warnings) > 0 AND decision = 'pending'
 *
 * so a batch with no warnings is postable the moment it is parsed, and a
 * hundred-row file with two flagged rows needs exactly two clicks. Modelling it
 * the other way — every row must be approved — would make the common case
 * unusable and train people to click through the flagged ones.
 *
 * `accepted` means a human read the raw line and confirmed the parsed value is
 * the fee they hold. `excluded` means it is not, and the row must NOT be
 * written: the CHECK below makes an excluded row with a FeeNum unstorable, so
 * the promise is kept by the database rather than by a `filter()` somebody
 * might reorder.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. `od_fee_num` IS THE RESUME KEY
 * ═════════════════════════════════════════════════════════════════════════════
 * The post is a background job against a credential throttled to 1 req/sec and
 * SHARED with voice, RCM and hygiene. A 500-fee schedule is ~10 minutes, so a
 * container restart mid-run is not a hypothetical.
 *
 * A row that carries `od_fee_num` was written and is skipped on resume. A row
 * that does not is VERIFIED BY READ before it is re-written, because the crash
 * could have landed between Open Dental's commit and ours — that is the only
 * window in which a naive resume writes a second fee for the same code, and a
 * fee schedule with D2740 in it twice is a schedule Open Dental will pick from
 * arbitrarily.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 4. THE BACKUP IS TAKEN BEFORE THE FIRST WRITE, NOT AFTER THE DECISION
 * ═════════════════════════════════════════════════════════════════════════════
 * `fees_od_backup` holds what the target schedule contained BEFORE this batch
 * touched it, read back through the API. One row per batch (UNIQUE), taken in
 * the same job, before write number one.
 *
 * `is_new_schedule` records which kind of rollback is even possible, and it is
 * on the backup rather than derived at rollback time because the answer must
 * survive the job that knew it:
 *
 *   EXISTING schedule → the snapshot is the truth to restore to.
 *   NEW schedule      → there is nothing to restore. Rollback deletes the fees
 *                       this batch created and HIDES the schedule, because the
 *                       Open Dental API HAS NO DELETE FOR /feescheds (verified
 *                       against the published spec, 2026-09-23 — GET, POST and
 *                       PUT only). The shell remains. That is stated in the UI
 *                       and in docs/reports/feature-fees-posting.md rather than
 *                       papered over, because a rollback that claims to have
 *                       removed something it cannot remove is the same lie as a
 *                       failed post that claims nothing was written.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

// Least-privilege app role — the audit_log / rcm_schema / hyg_visit /
// fees_import mechanism. The repo's ONLY per-table grant path is an explicit
// role-guarded GRANT inside the migration; a table created without this block
// fails in production as a permission error rather than as a red migration.
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[fees_posting migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** Tables this migration CREATES. The two it alters are granted already. */
const NEW_TABLES = ['fees_od_backup'];

/** The frozen office keys. Mirrors config/officeAgents.js and the slice-1 migration. */
const OFFICE_CHECK = "office IN ('roland', 'valley')";

const STATUS_CONSTRAINT = 'fees_import_batch_status_check';
const PARSED_CLEAN_CONSTRAINT = 'fees_import_batch_parsed_clean_check';

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // ── fees_import_batch: the posting state machine ──────────────────────────

  pgm.addColumns('fees_import_batch', {
    /** The Open Dental FeeSchedNum this batch posts into. */
    od_feesched_num: { type: 'bigint' },
    /** Its Description at the time of posting — so a renamed schedule still reads. */
    od_feesched_desc: { type: 'text' },
    /** True when THIS batch created the schedule. Decides which rollback applies. */
    od_feesched_is_new: { type: 'boolean', notNull: true, default: false },
    /**
     * Fees actually written to Open Dental by this batch, so far.
     *
     * NOT NULL, DEFAULT 0. See note 1 — this is the column that stops
     * `post_failed` reading as "nothing happened".
     */
    rows_written: { type: 'integer', notNull: true, default: 0 },
    /** Why a post_failed batch failed, in words an office can act on. */
    post_error: { type: 'text' },
    posting_started_at: { type: 'timestamptz' },
    posted_at: { type: 'timestamptz' },
    posted_by: { type: 'text' },
    rolled_back_at: { type: 'timestamptz' },
    rolled_back_by: { type: 'text' },
  });

  // REPLACE, NOT ALTER — Postgres has no "widen a CHECK". Guarded DROP so this
  // is safe on a database that somehow never got the slice-1 constraint.
  pgm.sql(`ALTER TABLE fees_import_batch DROP CONSTRAINT IF EXISTS ${STATUS_CONSTRAINT};`);
  pgm.addConstraint('fees_import_batch', STATUS_CONSTRAINT, {
    check:
      "status IN ('parsed', 'failed', 'ready', 'posting', 'posted', 'post_failed', 'rolled_back')",
  });

  // Slice 1's constraint named 'parsed' explicitly; every new status would have
  // violated it. The rule it was expressing is "only a PARSE failure carries a
  // parse failure reason", which is what this says instead.
  pgm.sql(`ALTER TABLE fees_import_batch DROP CONSTRAINT IF EXISTS ${PARSED_CLEAN_CONSTRAINT};`);
  pgm.addConstraint('fees_import_batch', PARSED_CLEAN_CONSTRAINT, {
    check: "status = 'failed' OR (failure_reason IS NULL AND failure_code IS NULL)",
  });

  // A post failure nobody can read is a post failure nobody can act on — the
  // same argument slice 1 made for a parse failure. `status` is NOT NULL, so
  // this cannot evaluate to NULL and be accepted by default.
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_post_failed_reason_check', {
    check: "status <> 'post_failed' OR post_error IS NOT NULL",
  });
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_rows_written_check', {
    check: 'rows_written >= 0 AND rows_written <= row_count',
  });
  // Every state that has touched Open Dental knows WHICH schedule it touched.
  // Without this a post_failed batch could exist with no target, and the
  // rollback would have nothing to aim at.
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_target_check', {
    check:
      "status NOT IN ('posting', 'posted', 'post_failed', 'rolled_back') OR od_feesched_num IS NOT NULL",
  });
  // Half an attribution is worse than none: it looks like a whole one.
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_posted_pair_check', {
    check: '(posted_by IS NULL) = (posted_at IS NULL)',
  });
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_rolled_back_pair_check', {
    check: '(rolled_back_by IS NULL) = (rolled_back_at IS NULL)',
  });

  // ── fees_import_row: the per-row decision and the resume key ──────────────

  pgm.addColumns('fees_import_row', {
    /** pending | accepted | excluded. See note 2 — clean rows never need one. */
    decision: { type: 'text', notNull: true, default: 'pending' },
    decided_by: { type: 'text' },
    decided_at: { type: 'timestamptz' },
    /** The FeeNum Open Dental minted. Present ⇒ this row was written. See note 3. */
    od_fee_num: { type: 'bigint' },
    written_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('fees_import_row', 'fees_import_row_decision_check', {
    check: "decision IN ('pending', 'accepted', 'excluded')",
  });
  pgm.addConstraint('fees_import_row', 'fees_import_row_decided_pair_check', {
    check: '(decided_by IS NULL) = (decided_at IS NULL)',
  });
  // A decision that is not 'pending' was made BY somebody. Without this, a
  // decision could be recorded with no author and the audit trail would have a
  // hole exactly where the judgement was.
  pgm.addConstraint('fees_import_row', 'fees_import_row_decided_by_check', {
    check: "decision = 'pending' OR decided_by IS NOT NULL",
  });
  pgm.addConstraint('fees_import_row', 'fees_import_row_written_pair_check', {
    check: '(od_fee_num IS NULL) = (written_at IS NULL)',
  });
  // Note 2: an EXCLUDED row must never have been written. The promise is kept
  // by the database rather than by a filter() somebody might reorder.
  pgm.addConstraint('fees_import_row', 'fees_import_row_excluded_unwritten_check', {
    check: "decision <> 'excluded' OR od_fee_num IS NULL",
  });
  // The resume scan reads exactly this: which rows of a batch still need writing.
  pgm.createIndex('fees_import_row', ['batch_id', 'od_fee_num'], {
    name: 'fees_import_row_batch_written_idx',
  });

  // ── fees_od_backup ────────────────────────────────────────────────────────

  pgm.createTable('fees_od_backup', {
    backup_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    /**
     * NOT NULL with a CHECK, and carried even though it could be reached through
     * the batch — the same argument the slice-1 tables make. It means the
     * rollback's own lookup is office-scoped WITHOUT a join, so the scoping
     * cannot be forgotten in the one query somebody writes in a hurry. A
     * restore aimed at the wrong practice's database is the worst outcome this
     * module has.
     */
    office: { type: 'text', notNull: true },
    batch_id: { type: 'uuid', notNull: true },
    od_feesched_num: { type: 'bigint', notNull: true },
    /** See note 4: this decides which rollback is even possible. */
    is_new_schedule: { type: 'boolean', notNull: true, default: false },
    /**
     * What the schedule held before this batch touched it, read back through
     * GET /fees?FeeSched=. Each element is Open Dental's own shape —
     * { FeeNum, CodeNum, Amount, ClinicNum, ProvNum } — stored verbatim rather
     * than mapped, because a restore must put back exactly what was there and a
     * mapping is a place for a field to go missing.
     *
     * EMPTY IS A VALID SNAPSHOT and is not the same as no snapshot: an existing
     * schedule can legitimately be empty, and the difference between "we looked
     * and it was empty" and "we never looked" is the difference between a
     * rollback that is safe to run and one that is not. The row's existence is
     * what says we looked.
     */
    rows: { type: 'jsonb', notNull: true, default: '[]' },
    row_count: { type: 'integer', notNull: true, default: 0 },
    taken_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    taken_by: { type: 'text', notNull: true },
    restored_at: { type: 'timestamptz' },
    restored_by: { type: 'text' },
    /** What the restore actually managed, so a partial one is legible. */
    restore_note: { type: 'text' },
  });

  pgm.addConstraint('fees_od_backup', 'fees_od_backup_office_check', { check: OFFICE_CHECK });
  // The composite FK: a backup's office MUST equal its batch's. A backup filed
  // against another office's batch is a restore aimed at the wrong database.
  pgm.addConstraint('fees_od_backup', 'fees_od_backup_batch_fk', {
    foreignKeys: {
      columns: ['batch_id', 'office'],
      references: 'fees_import_batch(batch_id, office)',
      onDelete: 'CASCADE',
    },
  });
  // ONE backup per batch. It is taken once, before the first write; a second
  // one would necessarily be taken AFTER this batch had already changed the
  // schedule, and restoring from it would restore our own writes.
  pgm.addConstraint('fees_od_backup', 'fees_od_backup_batch_key', { unique: ['batch_id'] });
  pgm.addConstraint('fees_od_backup', 'fees_od_backup_feesched_check', {
    check: 'od_feesched_num > 0',
  });
  pgm.addConstraint('fees_od_backup', 'fees_od_backup_row_count_check', {
    check: 'row_count >= 0 AND row_count = jsonb_array_length(rows)',
  });
  pgm.addConstraint('fees_od_backup', 'fees_od_backup_restored_pair_check', {
    check: '(restored_by IS NULL) = (restored_at IS NULL)',
  });
  pgm.createIndex('fees_od_backup', ['office', 'od_feesched_num'], {
    name: 'fees_od_backup_office_feesched_idx',
  });

  // ── App-role grants (audit_log mechanism, CRUD scope) ──────────────────────
  // Only the NEW table needs one: fees_import_batch and fees_import_row were
  // granted by the slice-1 migration, and a grant follows the table, not its
  // columns. uuid PKs via gen_random_uuid() mean no sequence grants are needed.
  // down() needs no revoke: dropping a table drops its grants.
  const tableList = NEW_TABLES.map((t) => `'${t}'`).join(', ');
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
        RAISE NOTICE 'fees_posting: CRUD grants applied to role % on % table(s)', r, ${NEW_TABLES.length};
      ELSE
        RAISE NOTICE 'fees_posting: app role % absent - grants SKIPPED. Create the least-privilege role and re-run before posting.', r;
      END IF;
    END $$;
  `);
};

/**
 * Reverse of up().
 *
 * NOT SYMMETRIC, and deliberately so: narrowing the status CHECK back would
 * fail on any database that has since posted a batch, because Postgres
 * validates a new CHECK against existing rows. So the rows are moved back to a
 * status the old vocabulary admits FIRST. That discards the record of which
 * batches were posted, which is the honest cost of rolling back this migration
 * — and it does NOT undo the Open Dental writes themselves, which is the part
 * worth knowing before anybody runs it during an incident.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  for (const table of [...NEW_TABLES].reverse()) {
    pgm.dropTable(table, { ifExists: true, cascade: true });
  }

  pgm.dropConstraint('fees_import_row', 'fees_import_row_excluded_unwritten_check', {
    ifExists: true,
  });
  pgm.dropConstraint('fees_import_row', 'fees_import_row_written_pair_check', { ifExists: true });
  pgm.dropConstraint('fees_import_row', 'fees_import_row_decided_by_check', { ifExists: true });
  pgm.dropConstraint('fees_import_row', 'fees_import_row_decided_pair_check', { ifExists: true });
  pgm.dropConstraint('fees_import_row', 'fees_import_row_decision_check', { ifExists: true });
  pgm.dropIndex('fees_import_row', ['batch_id', 'od_fee_num'], {
    name: 'fees_import_row_batch_written_idx',
    ifExists: true,
  });
  pgm.dropColumns('fees_import_row', [
    'decision',
    'decided_by',
    'decided_at',
    'od_fee_num',
    'written_at',
  ]);

  pgm.dropConstraint('fees_import_batch', 'fees_import_batch_rolled_back_pair_check', {
    ifExists: true,
  });
  pgm.dropConstraint('fees_import_batch', 'fees_import_batch_posted_pair_check', {
    ifExists: true,
  });
  pgm.dropConstraint('fees_import_batch', 'fees_import_batch_target_check', { ifExists: true });
  pgm.dropConstraint('fees_import_batch', 'fees_import_batch_rows_written_check', {
    ifExists: true,
  });
  pgm.dropConstraint('fees_import_batch', 'fees_import_batch_post_failed_reason_check', {
    ifExists: true,
  });

  // Rows first — see the header. A batch that reached any of the new statuses
  // becomes 'parsed' again, which is the only truthful thing the old vocabulary
  // can say about it.
  pgm.sql(`
    UPDATE fees_import_batch
       SET status = 'parsed'
     WHERE status IN ('ready', 'posting', 'posted', 'post_failed', 'rolled_back');
  `);
  pgm.sql(`ALTER TABLE fees_import_batch DROP CONSTRAINT IF EXISTS ${STATUS_CONSTRAINT};`);
  pgm.addConstraint('fees_import_batch', STATUS_CONSTRAINT, {
    check: "status IN ('parsed', 'failed')",
  });
  pgm.sql(`ALTER TABLE fees_import_batch DROP CONSTRAINT IF EXISTS ${PARSED_CLEAN_CONSTRAINT};`);
  pgm.addConstraint('fees_import_batch', PARSED_CLEAN_CONSTRAINT, {
    check: "status <> 'parsed' OR (failure_reason IS NULL AND failure_code IS NULL)",
  });

  pgm.dropColumns('fees_import_batch', [
    'od_feesched_num',
    'od_feesched_desc',
    'od_feesched_is_new',
    'rows_written',
    'post_error',
    'posting_started_at',
    'posted_at',
    'posted_by',
    'rolled_back_at',
    'rolled_back_by',
  ]);
};

/** Exported for the tests that assert these against the service constants. */
exports.NEW_TABLES = NEW_TABLES;
exports.BATCH_STATUSES = [
  'parsed',
  'failed',
  'ready',
  'posting',
  'posted',
  'post_failed',
  'rolled_back',
];
exports.ROW_DECISIONS = ['pending', 'accepted', 'excluded'];
