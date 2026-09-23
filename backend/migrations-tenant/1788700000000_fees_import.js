'use strict';

/**
 * Per-tenant data-plane: a fee schedule IMPORT — the file somebody uploaded and
 * the rows parsed out of it (Fee Schedule slice 1).
 *
 * The fee-schedule module's first tables. The control-plane migration that
 * registers the module (migrations/1788700000000_module_fees.js) creates none,
 * which is why it correctly ships no grant block; the moment one exists the
 * block at the bottom of this file is mandatory.
 *
 * Nothing here is written to Open Dental and nothing here is read from Open
 * Dental. This is where an uploaded payer schedule is PARSED and held so a
 * human can look at it. A later slice is what posts it, through the
 * office-keyed OD cloud API — never MySQL, which is exactly what the reference
 * implementation did and exactly what is not being ported.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. `office` IS ON EVERY ROW AND IS NEVER OPTIONAL
 * ═════════════════════════════════════════════════════════════════════════════
 * Both tables carry it, NOT NULL, with a CHECK — the child too, even though it
 * could reach its parent's office through the FK. The duplicate is deliberate
 * and is the same argument hyg_visit makes: it means every lookup can be
 * office-scoped WITHOUT a join, so the scoping cannot be forgotten in the one
 * query somebody writes in a hurry. The child carries a COMPOSITE FK back to
 * (batch_id, office), so a row whose office disagrees with its batch's cannot
 * be stored at all — the denormalised copy cannot drift.
 *
 * A fee schedule carries no PatNum, so this is not the "7115 is two different
 * people" argument. It is a narrower one that matters just as much: Roland and
 * Riley have different contracts with the same payers. A schedule imported for
 * one office and posted into the other's database would reprice every
 * procedure in that practice against terms it never agreed to.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. FEES ARE INTEGER CENTS. THERE IS NO NUMERIC COLUMN HERE.
 * ═════════════════════════════════════════════════════════════════════════════
 * The reference stored `parseFloat` dollars. $18.20 has no exact binary
 * floating-point representation, so a schedule round-tripped through a float
 * comes back as 18.199999999999999 — and RCM, which is the module that will
 * read these numbers to answer "did the payer allow what they contracted to
 * allow?", compares cents for equality. `fee_cents` is an `integer`: a single
 * procedure would have to be worth $21 million to overflow it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. A FAILED PARSE IS A ROW, NOT A DROPPED REQUEST
 * ═════════════════════════════════════════════════════════════════════════════
 * `status` is 'parsed' or 'failed', and a 'failed' batch is STORED — with the
 * reason, the filename, the hash and who uploaded it. An import that vanished
 * because the file would not parse is an import nobody can ask about later, and
 * "I uploaded it and nothing happened" is the support ticket that follows.
 *
 * Three CHECKs are written the long way on purpose, because Postgres ACCEPTS a
 * CHECK that evaluates to NULL (it only rejects an explicit false) — the trap
 * RCM's Stage B1 and C-2 constraints and hyg_staged_write's were all written
 * around:
 *   - a 'failed' batch must carry a reason. A failure nobody can read is a
 *     failure nobody can act on.
 *   - a 'parsed' batch must NOT carry one. A success that also carries a
 *     failure reason is a state the UI has to guess at.
 *   - a 'failed' batch has NO rows. Half a parse presented as a preview is the
 *     dishonest state this whole module exists downstream of: somebody would
 *     post it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 4. DUPLICATE PROCEDURE CODES ARE KEPT, DELIBERATELY — NO UNIQUE (batch, code)
 * ═════════════════════════════════════════════════════════════════════════════
 * A payer PDF really does list D2740 twice, at two different fees, on two pages
 * (a base rate and a network rate, or an amendment the office never noticed).
 * The reference silently kept the FIRST one and discarded the second with no
 * record that it existed. This schema stores both and the parser flags them, so
 * the preview shows an office the thing it most needs to see before posting.
 * A UNIQUE constraint here would re-create the reference's defect in the
 * database, where no parser change could fix it.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

// Least-privilege app role, exactly the audit_log / tc_schema / rcm_schema /
// hyg_visit mechanism: the repo's ONLY per-table grant path is an explicit
// role-guarded GRANT inside the migration. There is no ALTER DEFAULT PRIVILEGES
// anywhere and provisioning grants schema USAGE only, so a table created
// without this block fails in production as a permission error rather than as a
// red migration.
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[fees_import migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/**
 * Every table this migration creates, parents before children. down() drops the
 * reverse. One list, so the grant block cannot drift from the tables.
 */
const FEES_TABLES = ['fees_import_batch', 'fees_import_row'];

/** The frozen office keys. Mirrors config/officeAgents.js and routes/fees/helpers.js. */
const OFFICE_CHECK = "office IN ('roland', 'valley')";

/*
 * The vocabularies below are INLINE LITERALS in the CHECK strings rather than
 * interpolated from a shared module, and that is deliberate: a migration is a
 * historical record of what the database was told, and one that reads its
 * constraint out of today's source code silently changes meaning when that
 * source changes. (backend/config/modules.test.js makes the same argument for
 * the module CHECK; hyg_visit makes it for the treatment vocabularies.) The
 * tests assert these lists against the service constants, so a divergence is a
 * red build rather than a drift.
 */
const SOURCE_TYPES = ['pdf', 'csv'];
const BATCH_STATUSES = ['parsed', 'failed'];

/** SQL list literal for a CHECK, from a JS array. */
const list = (values) => values.map((v) => `'${v}'`).join(', ');

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // gen_random_uuid() — the same extension rcm_schema and hyg_visit require.
  // IF NOT EXISTS so a database that already has it is untouched.
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // ── fees_import_batch ─────────────────────────────────────────────────────
  pgm.createTable('fees_import_batch', {
    batch_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office: { type: 'text', notNull: true },
    /**
     * The uploaded name, reduced to something safe to store (path separators
     * stripped, control characters dropped, 255 chars). NOT PHI — a fee
     * schedule filename names a payer and a year, not a patient — but it is
     * attacker-controlled text, so it is sanitised at the route and never
     * interpolated into a path or a log line.
     */
    filename: { type: 'text', notNull: true },
    /**
     * SHA-256 of the exact bytes uploaded. This is the only durable link back to
     * the file: the bytes themselves are NOT stored. A fee schedule PDF is a
     * payer contract document, the container filesystem is ephemeral, and the
     * one mounted volume in prod is the AzureFile share the call store lives
     * on — spooling uploads to either creates a pile nobody scheduled for
     * deletion. Bytes go buffer → parser → out of scope.
     *
     * Deliberately NOT unique: re-uploading the same schedule is a legitimate
     * act (a parser fix, a second office, a retry after a failed parse), and
     * this module has no dedupe rule of the kind RCM's remittance key enforces
     * — an 835 posts money exactly once, a fee schedule preview posts nothing.
     */
    file_sha256: { type: 'text', notNull: true },
    file_size_bytes: { type: 'integer', notNull: true },
    source_type: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    /** Rows actually parsed and stored. Zero on a failure — see note 3. */
    row_count: { type: 'integer', notNull: true, default: 0 },
    /**
     * Every warning raised anywhere in this parse: the file-level ones in
     * `parse_warnings` below PLUS every row's own. One number an office can
     * look at to decide whether this preview needs reading line by line.
     */
    warning_count: { type: 'integer', notNull: true, default: 0 },
    /**
     * FILE-level warnings — things that are true of the upload rather than of
     * one row (`line 42 names no procedure code`, `the header row is missing`).
     * Row-level warnings live on the row that earned them.
     */
    parse_warnings: { type: 'jsonb', notNull: true, default: '[]' },
    /** Why a 'failed' batch failed, in words an office can act on. */
    failure_reason: { type: 'text' },
    /** The machine half of the same fact, e.g. 'CSV_AMBIGUOUS_COLUMNS'. */
    failure_code: { type: 'text' },
    created_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_source_type_check', {
    check: `source_type IN (${list(SOURCE_TYPES)})`,
  });
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_status_check', {
    check: `status IN (${list(BATCH_STATUSES)})`,
  });
  // A 64-character lowercase hex digest, or nothing. A truncated or
  // upper-cased hash compares unequal to the same file's real one, which makes
  // the column worse than absent.
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_sha256_check', {
    check: "file_sha256 ~ '^[0-9a-f]{64}$'",
  });
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_filename_check', {
    check: 'length(btrim(filename)) > 0',
  });
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_sizes_check', {
    check: 'file_size_bytes > 0 AND row_count >= 0 AND warning_count >= 0',
  });
  // Note 3. `status` is NOT NULL, so none of these can evaluate to NULL and be
  // accepted by default.
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_failed_reason_check', {
    check: "status <> 'failed' OR failure_reason IS NOT NULL",
  });
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_parsed_clean_check', {
    check: "status <> 'parsed' OR (failure_reason IS NULL AND failure_code IS NULL)",
  });
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_failed_no_rows_check', {
    check: "status <> 'failed' OR row_count = 0",
  });
  // The child's composite FK target. Redundant with the PK for uniqueness, and
  // load-bearing for the office-must-match constraint below.
  pgm.addConstraint('fees_import_batch', 'fees_import_batch_id_office_key', {
    unique: ['batch_id', 'office'],
  });
  // The list endpoint's only ordering: one office's imports, newest first.
  pgm.createIndex('fees_import_batch', ['office', 'created_at'], {
    name: 'fees_import_batch_office_created_idx',
  });

  // ── fees_import_row ───────────────────────────────────────────────────────
  pgm.createTable('fees_import_row', {
    row_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    batch_id: { type: 'uuid', notNull: true },
    office: { type: 'text', notNull: true },
    /**
     * A CDT procedure code, normalised: upper case, exactly D + four digits.
     * A code carrying a payer's own suffix (D2740A) is stripped to its base by
     * the parser AND flagged on the row, because stripping one changes which
     * procedure the fee lands on.
     */
    proc_code: { type: 'text', notNull: true },
    /** Integer cents. See note 2 — there is no numeric column here. */
    fee_cents: { type: 'integer', notNull: true },
    /**
     * The source line this row was read out of, verbatim. What makes a warned
     * row reviewable: an office looking at `D2740 = $1,234.00 (2 amounts on
     * this line)` needs to see the line to judge which column was right.
     * A fee schedule line carries procedure codes and money — never a patient.
     */
    raw_line: { type: 'text', notNull: true, default: '' },
    /** This row's own warnings. File-level ones live on the batch. */
    parse_warnings: { type: 'jsonb', notNull: true, default: '[]' },
    /** Source order, so a re-read shows the schedule in the file's own order. */
    row_order: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('fees_import_row', 'fees_import_row_office_check', { check: OFFICE_CHECK });
  // Note 1: a child's office MUST equal its parent's. This is what makes the
  // denormalised copy safe — it cannot drift, and a cross-office write is
  // refused by the database rather than by a code path.
  pgm.addConstraint('fees_import_row', 'fees_import_row_batch_fk', {
    foreignKeys: {
      columns: ['batch_id', 'office'],
      references: 'fees_import_batch(batch_id, office)',
      onDelete: 'CASCADE',
    },
  });
  // The normalisation rule, enforced where it outlives every process that
  // writes to it. A suffixed or lower-cased code stored here would not join to
  // Open Dental's procedurecode table, and the failure would surface at post
  // time rather than at import time.
  pgm.addConstraint('fees_import_row', 'fees_import_row_proc_code_check', {
    check: "proc_code ~ '^D[0-9]{4}$'",
  });
  // $0.00 is a REAL fee-schedule value — "not covered", "bundled", "no fee" —
  // and the reference dropped every one of them with a `> 0` guard, so an
  // office never saw that the payer had said so. Zero is admitted; negative is
  // not, because a fee schedule has no concept of one and a minus sign in a
  // parsed amount means the parser read the wrong column.
  pgm.addConstraint('fees_import_row', 'fees_import_row_fee_cents_check', {
    check: 'fee_cents >= 0',
  });
  // Note 4: NO unique on (batch_id, proc_code). Duplicates are kept on purpose.
  pgm.createIndex('fees_import_row', ['batch_id', 'row_order'], {
    name: 'fees_import_row_batch_order_idx',
  });
  pgm.createIndex('fees_import_row', ['office', 'proc_code'], {
    name: 'fees_import_row_office_code_idx',
  });

  // ── App-role grants (audit_log mechanism, CRUD scope) ──────────────────────
  // uuid PKs via gen_random_uuid() mean no sequence grants are needed. If the
  // role is absent (local dev on a superuser) the grant is skipped with a
  // NOTICE — create the role and re-run before serving real data. down() needs
  // no revoke: dropping a table drops its grants. audit_log is NOT in this list
  // and its append-only grants are untouched.
  const tableList = FEES_TABLES.map((t) => `'${t}'`).join(', ');
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
        RAISE NOTICE 'fees_import: CRUD grants applied to role % on % fees_* tables', r, ${FEES_TABLES.length};
      ELSE
        RAISE NOTICE 'fees_import: app role % absent - grants SKIPPED. Create the least-privilege role and re-run before serving real data.', r;
      END IF;
    END $$;
  `);
};

/**
 * Reverse of up(). Children before parents, the exact reverse of FEES_TABLES.
 * The pgcrypto extension is NOT dropped: other tables depend on it.
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  for (const table of [...FEES_TABLES].reverse()) {
    pgm.dropTable(table, { ifExists: true, cascade: true });
  }
};

/** Exported for the tests that assert these against the service constants. */
exports.FEES_TABLES = FEES_TABLES;
exports.SOURCE_TYPES = SOURCE_TYPES;
exports.BATCH_STATUSES = BATCH_STATUSES;
