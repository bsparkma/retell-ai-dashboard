'use strict';

/**
 * Per-tenant data-plane: the hygiene VISIT — the routing slip, the treatment
 * items on it, and what is staged to be written (H1 slice 2).
 *
 * The hygiene module's first tables. Slice 1 created none, which is why it
 * correctly shipped no grant block; the moment one exists the block below is
 * mandatory. Nothing here writes to Open Dental and nothing here is read by
 * Open Dental: this is where a visit is COMPOSED. Slice 3 is what sends it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. `office` IS ON EVERY ROW AND IS NEVER OPTIONAL
 * ═════════════════════════════════════════════════════════════════════════════
 * PatNum numbering restarts in every Open Dental database: 7115 is the valley
 * test patient AND a different, real person in roland. A row that carries a
 * PatNum without the office beside it is a row that can be attached to the
 * wrong human being, which is the worst defect available in this codebase.
 *
 * So `office` is NOT NULL with a CHECK on both tables that carry a PatNum, and
 * on the child tables too — even though a child could reach its parent's office
 * through the FK. The duplicate is deliberate: it means every lookup can be
 * office-scoped WITHOUT a join, so the scoping cannot be forgotten in the one
 * query somebody writes in a hurry. The children carry a composite FK back to
 * (visit_id, office), so a child whose office disagrees with its parent's
 * cannot be stored at all — the denormalised copy cannot drift.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. `priority` AND `category` ARE SEPARATE COLUMNS WITH SEPARATE CHECKS
 * ═════════════════════════════════════════════════════════════════════════════
 * They are different axes that share the word "cosmetic":
 *
 *     priority  urgent | preventative | cosmetic       ← HOW SOON
 *     category  Restorative | Endo | Surgery | Perio |
 *               Prosth | Ortho | Cosmetic | Other      ← WHAT KIND
 *
 * A cosmetic veneer is a Cosmetic-CATEGORY item. A cosmetic PRIORITY is a
 * statement that the work can wait. One shared text column, one shared enum
 * type, or one case-insensitive comparison anywhere between them would let
 * somebody's choice of category print "this can wait" on a chart.
 *
 * shared/hyg/contract.ts already guards this in TypeScript and at runtime, and
 * `hyg-contract.test.ts` asserts the two vocabularies are disjoint
 * case-insensitively. This migration is the third guard, in the one place that
 * outlives every process that ever writes to it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. ONE VISIT PER APPOINTMENT — `UNIQUE (office, apt_num)`
 * ═════════════════════════════════════════════════════════════════════════════
 * A visit is per-appointment, and re-opening the same appointment must find the
 * visit that is already there rather than starting a second one beside it. The
 * alternative — a new row per open — would mean a hygienist who backgrounded
 * the app mid-visit came back to an empty slip with her work in a sibling row
 * nothing renders. So the route UPSERTs on this constraint and the database is
 * what makes that unambiguous rather than a convention in a service.
 *
 * `apt_num` rather than a surrogate visit key because the appointment is the
 * only identity both sides of this already agree on: Open Dental minted it, the
 * day view carries it, and the URL is /hyg/visit/:aptNum.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 4. THE STAGED-WRITE STATE MACHINE LIVES HERE, NOT IN A BROWSER
 * ═════════════════════════════════════════════════════════════════════════════
 * The prototype held staged writes in a Zustand store and simulated `sendAll`
 * with a setTimeout. Porting that shape reproduces RCM audit finding F3 —
 * "confirm gates client-side only; submit paths never re-check and record NO
 * user". So the rows live here, the transitions happen on the server, and the
 * client displays a state it never owns.
 *
 *     Draft → Staged → Sending → Written | Failed
 *
 * Slice 2 can reach `Draft` and `Staged` only. `Sending`, `Written` and
 * `Failed` are slice 3's, set by the server around a real Open Dental call —
 * which is why `payload`, `sent_by` and `sent_at` exist now rather than being
 * added later: slice 3 must be able to record WHO approved a write and WHAT was
 * sent without reshaping a table that by then holds real visits.
 *
 * Two CHECKs are written the long way on purpose, because Postgres ACCEPTS a
 * CHECK that evaluates to NULL (it only rejects an explicit false) — the trap
 * RCM's Stage B1 and C-2 constraints were both written around:
 *   - a `Failed` row must carry a reason. A failure nobody can read is a
 *     failure nobody can act on.
 *   - `sent_by` and `sent_at` are set together or not at all. Half an
 *     attribution is worse than none, because it looks like a whole one.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

// Least-privilege app role, exactly the audit_log / tc_schema / rcm_schema
// mechanism: the repo's ONLY per-table grant path is an explicit role-guarded
// GRANT inside the migration. There is no ALTER DEFAULT PRIVILEGES anywhere and
// provisioning grants schema USAGE only, so a table created without this block
// fails in production as a permission error rather than as a red migration.
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[hyg_visit migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/**
 * Every table this migration creates, parents before children. down() drops the
 * reverse. One list, so the grant block cannot drift from the tables.
 */
const HYG_TABLES = ['hyg_visit', 'hyg_treatment_item', 'hyg_staged_write'];

/** The frozen office keys. Mirrors config/officeAgents.js and the contract. */
const OFFICE_CHECK = "office IN ('roland', 'valley')";

/**
 * The four vocabularies below are INLINE LITERALS in the CHECK strings rather
 * than interpolated from a shared module, and that is deliberate: a migration
 * is a historical record of what the database was told, and one that reads its
 * constraint out of today's source code silently changes meaning when that
 * source changes. (backend/test/modules.test.js makes the same argument for the
 * module CHECK.) The tests below assert these lists against the contract, so a
 * divergence is a red build rather than a drift.
 */
const TREATMENT_PRIORITIES = ['urgent', 'preventative', 'cosmetic'];
const TREATMENT_CATEGORIES = [
  'Restorative',
  'Endo',
  'Surgery',
  'Perio',
  'Prosth',
  'Ortho',
  'Cosmetic',
  'Other',
];
const TREATMENT_STATUSES = ['proposed', 'watch', 'confirmed', 'scheduled'];
const STAGED_WRITE_KINDS = ['router', 'perio', 'note', 'tc-handoff'];
const STAGED_WRITE_STATES = ['Draft', 'Staged', 'Sending', 'Written', 'Failed'];

/** SQL list literal for a CHECK, from a JS array. */
const list = (values) => values.map((v) => `'${v}'`).join(', ');

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // gen_random_uuid() — the same extension rcm_schema requires. IF NOT EXISTS
  // so a database that already has it is untouched.
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // ── hyg_visit ─────────────────────────────────────────────────────────────
  pgm.createTable('hyg_visit', {
    visit_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office: { type: 'text', notNull: true },
    apt_num: { type: 'bigint', notNull: true },
    // NOT NULL: a visit with no patient is not a visit, and a null here would
    // make "we do not know who this is" storable on a row that later becomes a
    // chart note.
    pat_num: { type: 'bigint', notNull: true },
    // The Open Dental LOCAL calendar date, not a UTC instant — the same fact
    // the day view is keyed by.
    visit_date: { type: 'date' },
    // The routing slip. jsonb rather than forty columns because the slip is a
    // FORM whose fields change with the practice's paper, and every field on it
    // is free text, a chip list or a nullable enum that nothing joins on. The
    // shape is enforced by HygSlipSchema on both sides of the wire (the backend
    // runs it through backend/hyg/contract.gen.cjs), which is a stronger
    // guarantee than a nullable text column would carry.
    //
    // The two facts a database MUST guard — priority and category — are on the
    // treatment item, as real columns with real CHECKs. See note 2.
    slip: { type: 'jsonb', notNull: true, default: '{}' },
    created_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_by: { type: 'text' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('hyg_visit', 'hyg_visit_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('hyg_visit', 'hyg_visit_apt_num_check', { check: 'apt_num > 0' });
  pgm.addConstraint('hyg_visit', 'hyg_visit_pat_num_check', { check: 'pat_num > 0' });
  // Note 3: one visit per appointment, per office.
  pgm.addConstraint('hyg_visit', 'hyg_visit_office_apt_key', { unique: ['office', 'apt_num'] });
  // The children's composite FK target. Redundant with the PK for uniqueness,
  // and load-bearing for the office-must-match constraint below.
  pgm.addConstraint('hyg_visit', 'hyg_visit_id_office_key', { unique: ['visit_id', 'office'] });
  pgm.createIndex('hyg_visit', ['office', 'visit_date'], { name: 'hyg_visit_office_date_idx' });

  // ── hyg_treatment_item ────────────────────────────────────────────────────
  pgm.createTable('hyg_treatment_item', {
    item_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    visit_id: { type: 'uuid', notNull: true },
    office: { type: 'text', notNull: true },
    /**
     * Universal tooth numbers. jsonb array of integers, paired with
     * `whole_mouth` — see the CHECK. Modelling "whole mouth" as an EMPTY array
     * would make "no teeth picked yet" and "this is a whole-mouth item" the
     * same value, which is the distinction the contract already refuses to
     * collapse (`teeth: number[] | "mouth"`).
     */
    teeth: { type: 'jsonb', notNull: true, default: '[]' },
    whole_mouth: { type: 'boolean', notNull: true, default: false },
    /** The office's own shorthand ("Comp", "Crown", "IMP"). Free text by design. */
    code: { type: 'text', notNull: true },
    // ⚠️ TWO AXES, TWO COLUMNS, TWO CHECKS. See note 2 before touching either. ⚠️
    category: { type: 'text', notNull: true },
    priority: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'proposed' },
    surfaces: { type: 'jsonb', notNull: true, default: '[]' },
    dx: { type: 'jsonb', notNull: true, default: '[]' },
    dx_note: { type: 'text' },
    motivation: { type: 'jsonb', notNull: true, default: '[]' },
    motivation_note: { type: 'text' },
    crown_type: { type: 'text' },
    prosthesis: { type: 'jsonb' },
    schedule_next: { type: 'boolean', notNull: true, default: false },
    note: { type: 'text' },
    photos: { type: 'jsonb', notNull: true, default: '[]' },
    tags: { type: 'jsonb', notNull: true, default: '[]' },
    /** Display order, so a re-read does not reshuffle a hygienist's list. */
    item_order: { type: 'integer', notNull: true, default: 0 },
    created_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_by: { type: 'text' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('hyg_treatment_item', 'hyg_treatment_item_office_check', {
    check: OFFICE_CHECK,
  });
  // The composite FK: a child's office MUST equal its parent's. This is what
  // makes the denormalised copy safe — it cannot drift, and a cross-office
  // write is refused by the database rather than by a code path.
  pgm.addConstraint('hyg_treatment_item', 'hyg_treatment_item_visit_fk', {
    foreignKeys: {
      columns: ['visit_id', 'office'],
      references: 'hyg_visit(visit_id, office)',
      onDelete: 'CASCADE',
    },
  });
  pgm.addConstraint('hyg_treatment_item', 'hyg_treatment_item_category_check', {
    check: `category IN (${list(TREATMENT_CATEGORIES)})`,
  });
  pgm.addConstraint('hyg_treatment_item', 'hyg_treatment_item_priority_check', {
    check: `priority IN (${list(TREATMENT_PRIORITIES)})`,
  });
  pgm.addConstraint('hyg_treatment_item', 'hyg_treatment_item_status_check', {
    check: `status IN (${list(TREATMENT_STATUSES)})`,
  });
  pgm.addConstraint('hyg_treatment_item', 'hyg_treatment_item_code_check', {
    check: "length(btrim(code)) > 0",
  });
  pgm.addConstraint('hyg_treatment_item', 'hyg_treatment_item_crown_type_check', {
    check: "crown_type IS NULL OR crown_type IN ('initial', 'replacement')",
  });
  // A whole-mouth item names no teeth, and a tooth-level item names at least
  // one. Both columns are NOT NULL, so neither side of this can evaluate to
  // NULL and be accepted by default.
  pgm.addConstraint('hyg_treatment_item', 'hyg_treatment_item_teeth_check', {
    check:
      "(whole_mouth AND jsonb_array_length(teeth) = 0) OR " +
      "(NOT whole_mouth AND jsonb_array_length(teeth) >= 1)",
  });
  pgm.createIndex('hyg_treatment_item', ['visit_id', 'item_order'], {
    name: 'hyg_treatment_item_visit_idx',
  });

  // ── hyg_staged_write ──────────────────────────────────────────────────────
  pgm.createTable('hyg_staged_write', {
    staged_write_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    visit_id: { type: 'uuid', notNull: true },
    office: { type: 'text', notNull: true },
    kind: { type: 'text', notNull: true },
    state: { type: 'text', notNull: true, default: 'Draft' },
    title: { type: 'text', notNull: true, default: '' },
    summary: { type: 'text', notNull: true, default: '' },
    /** The lines a hygienist reads before confirming. Slice 3 sends these. */
    preview: { type: 'jsonb', notNull: true, default: '[]' },
    /**
     * What slice 3 will actually send, composed SERVER-SIDE from the stored
     * visit at stage time. It exists now so slice 3's rule — the preview IS the
     * write — is expressible without reshaping a table that by then holds real
     * visits.
     */
    payload: { type: 'jsonb', notNull: true, default: '{}' },
    error_message: { type: 'text' },
    staged_by: { type: 'text' },
    staged_at: { type: 'timestamptz' },
    /** WHO approved the send. Slice 3 records it at the moment of the write. */
    sent_by: { type: 'text' },
    sent_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('hyg_staged_write', 'hyg_staged_write_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('hyg_staged_write', 'hyg_staged_write_visit_fk', {
    foreignKeys: {
      columns: ['visit_id', 'office'],
      references: 'hyg_visit(visit_id, office)',
      onDelete: 'CASCADE',
    },
  });
  pgm.addConstraint('hyg_staged_write', 'hyg_staged_write_kind_check', {
    check: `kind IN (${list(STAGED_WRITE_KINDS)})`,
  });
  pgm.addConstraint('hyg_staged_write', 'hyg_staged_write_state_check', {
    check: `state IN (${list(STAGED_WRITE_STATES)})`,
  });
  // One staged write per kind per visit. Staging the router twice is an EDIT of
  // what is staged, not a second thing to send.
  pgm.addConstraint('hyg_staged_write', 'hyg_staged_write_visit_kind_key', {
    unique: ['visit_id', 'kind'],
  });
  // A failure nobody can read is a failure nobody can act on. `state` is NOT
  // NULL, so this cannot evaluate to NULL and be accepted.
  pgm.addConstraint('hyg_staged_write', 'hyg_staged_write_failed_reason_check', {
    check: "state <> 'Failed' OR error_message IS NOT NULL",
  });
  // Half an attribution is worse than none: it looks like a whole one. `IS
  // NULL` always yields true or false, so this is never NULL either.
  pgm.addConstraint('hyg_staged_write', 'hyg_staged_write_sent_pair_check', {
    check: '(sent_by IS NULL) = (sent_at IS NULL)',
  });
  pgm.createIndex('hyg_staged_write', ['visit_id'], { name: 'hyg_staged_write_visit_idx' });

  // ── App-role grants (audit_log mechanism, CRUD scope) ──────────────────────
  // uuid PKs via gen_random_uuid() mean no sequence grants are needed. If the
  // role is absent (local dev on a superuser) the grant is skipped with a
  // NOTICE — create the role and re-run before serving PHI. down() needs no
  // revoke: dropping a table drops its grants. audit_log is NOT in this list
  // and its append-only grants are untouched.
  const tableList = HYG_TABLES.map((t) => `'${t}'`).join(', ');
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
        RAISE NOTICE 'hyg_visit: CRUD grants applied to role % on % hyg_* tables', r, ${HYG_TABLES.length};
      ELSE
        RAISE NOTICE 'hyg_visit: app role % absent - grants SKIPPED. Create the least-privilege role and re-run before serving PHI.', r;
      END IF;
    END $$;
  `);
};

/**
 * Reverse of up(). Children before parents, the exact reverse of HYG_TABLES.
 * The pgcrypto extension is NOT dropped: other tables depend on it.
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  for (const table of [...HYG_TABLES].reverse()) {
    pgm.dropTable(table, { ifExists: true, cascade: true });
  }
};

/** Exported for the tests that assert these against shared/hyg/contract.ts. */
exports.HYG_TABLES = HYG_TABLES;
exports.TREATMENT_PRIORITIES = TREATMENT_PRIORITIES;
exports.TREATMENT_CATEGORIES = TREATMENT_CATEGORIES;
exports.TREATMENT_STATUSES = TREATMENT_STATUSES;
exports.STAGED_WRITE_KINDS = STAGED_WRITE_KINDS;
exports.STAGED_WRITE_STATES = STAGED_WRITE_STATES;
