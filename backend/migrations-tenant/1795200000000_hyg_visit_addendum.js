'use strict';

/**
 * hyg_visit_addendum — the after-Send addendum (hyg-pa-details-addendum).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT HOLDS
 * ═════════════════════════════════════════════════════════════════════════════
 * One row per addendum a team member adds to a visit AFTER its note reached the
 * chart. Additive: the original note is never edited (Open Dental cannot edit
 * one anyway — "No existing procnote can EVER be edited or deleted", H0). An
 * addendum reaches the chart only through its own human-pressed "Send
 * addendum", as its own unsigned GroupNote, following the staged-write pattern:
 *
 *     Staged → Sending → Written | Failed        (Failed → Sending on re-send)
 *
 *   body / author / created_at   what was added, by whom, when
 *   preview                      the exact lines "Send addendum" files,
 *                                composed server-side at add time
 *                                (stagedWriteComposer.composeAddendum)
 *   state, error_message,        the send's honest state, as hyg_staged_write
 *   written_ref, sent_by,        carries it
 *   sent_at
 *
 * The same-day window ("same calendar day, office local time; read-only
 * forever after") is enforced by the route, which owns the clock. The DATABASE
 * guarantees the part a clock cannot: what an addendum SAYS never changes.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * APPEND-ONLY, BY THE DATABASE
 * ═════════════════════════════════════════════════════════════════════════════
 *   - The app role gets SELECT, INSERT, UPDATE — never DELETE.
 *   - A trigger makes body, author, created_at, preview, visit_id, office and
 *     the id WRITE-ONCE, and makes `Written` TERMINAL. Only the send columns
 *     move, and only until the addendum is in the chart.
 *   - The FK to hyg_visit is NO ACTION (not CASCADE like the visit's other
 *     children): a visit with addenda cannot be deleted out from under them.
 *
 * CHECK LITERALS ARE INLINE (house rule). The office CHECK is the MT-2b2 format
 * check (1795000000000), not the old two-office list.
 *
 * down() REFUSES while any addendum exists — the append-only house pattern
 * (cf. 1795000000000's refusal): an addendum is a clinical record, and a
 * rollback that silently dropped one would be the only way this table could
 * ever lose a row. Move the rows out by hand first if a rollback is truly
 * needed. On an empty table it removes everything cleanly.
 *
 * NUMBERING: newest tenant migration on origin/develop at authoring time was
 * 1795100000000_tc_referral_signoff_mode.js; this sorts strictly after it.
 *
 * PHI: the addendum text is PHI, stored beside the visit it belongs to — never
 * in audit rows, never in logs.
 *
 * Proven against real Postgres by scripts/hyg-visit-addendum-verify-queries.js
 * (CI runs it after migrate).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[hyg_visit_addendum migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

const TABLE = 'hyg_visit_addendum';

/** The states, in lifecycle order. Pinned to the contract by this migration's test. */
const ADDENDUM_STATES = Object.freeze(['Staged', 'Sending', 'Written', 'Failed']);
/** The cap the contract's ADDENDUM_TEXT_MAX states. Pinned by the test. */
const BODY_MAX = 4000;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  pgm.createTable(TABLE, {
    addendum_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    visit_id: { type: 'uuid', notNull: true },
    office: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    /** The signed-in user who added it. Staff identity, never patient identity. */
    author: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    preview: { type: 'jsonb', notNull: true },
    state: { type: 'text', notNull: true, default: 'Staged' },
    error_message: { type: 'text' },
    written_ref: { type: 'text' },
    /** WHO approved the send — recorded at the moment of the write. */
    sent_by: { type: 'text' },
    sent_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint(TABLE, 'hyg_visit_addendum_office_check', {
    check: "office ~ '^[a-z][a-z0-9_-]{1,31}$'",
  });
  pgm.addConstraint(TABLE, 'hyg_visit_addendum_visit_fk', {
    foreignKeys: {
      columns: ['visit_id', 'office'],
      references: 'hyg_visit(visit_id, office)',
      onDelete: 'NO ACTION',
    },
  });
  pgm.addConstraint(TABLE, 'hyg_visit_addendum_body_check', {
    check: 'char_length(btrim(body)) BETWEEN 1 AND 4000',
  });
  pgm.addConstraint(TABLE, 'hyg_visit_addendum_author_check', {
    check: 'char_length(btrim(author)) BETWEEN 1 AND 320',
  });
  // CASE, not AND: Postgres does not promise to short-circuit, and
  // jsonb_array_length on a non-array RAISES rather than answering false.
  // Three lines at least: the heading, the words, the typed-name block.
  pgm.addConstraint(TABLE, 'hyg_visit_addendum_preview_check', {
    check: "CASE WHEN jsonb_typeof(preview) = 'array' THEN jsonb_array_length(preview) >= 3 ELSE false END",
  });
  pgm.addConstraint(TABLE, 'hyg_visit_addendum_state_check', {
    check: "state IN ('Staged', 'Sending', 'Written', 'Failed')",
  });
  // Honest states, as hyg_staged_write keeps them: Written carries where it
  // went and who approved it, and nothing else does; Failed carries why.
  pgm.addConstraint(TABLE, 'hyg_visit_addendum_written_check', {
    check:
      "(state = 'Written') = (written_ref IS NOT NULL AND sent_by IS NOT NULL AND sent_at IS NOT NULL)",
  });
  pgm.addConstraint(TABLE, 'hyg_visit_addendum_error_check', {
    check: "(state = 'Failed') = (error_message IS NOT NULL)",
  });

  pgm.createIndex(TABLE, ['visit_id', 'office', 'created_at'], {
    name: 'hyg_visit_addendum_visit_idx',
  });

  // ── Write-once content; Written is terminal ────────────────────────────────
  pgm.sql(`
    CREATE FUNCTION hyg_visit_addendum_write_once() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.addendum_id IS DISTINCT FROM OLD.addendum_id
         OR NEW.visit_id IS DISTINCT FROM OLD.visit_id
         OR NEW.office IS DISTINCT FROM OLD.office
         OR NEW.body IS DISTINCT FROM OLD.body
         OR NEW.author IS DISTINCT FROM OLD.author
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.preview IS DISTINCT FROM OLD.preview THEN
        RAISE EXCEPTION 'hyg_visit_addendum: what an addendum says is write-once'
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.state = 'Written' AND (NEW.state, NEW.written_ref, NEW.sent_by, NEW.sent_at, NEW.error_message)
           IS DISTINCT FROM (OLD.state, OLD.written_ref, OLD.sent_by, OLD.sent_at, OLD.error_message) THEN
        RAISE EXCEPTION 'hyg_visit_addendum: a Written addendum is final'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END
    $fn$;
  `);
  pgm.sql(`
    CREATE TRIGGER hyg_visit_addendum_write_once
      BEFORE UPDATE ON ${TABLE}
      FOR EACH ROW EXECUTE FUNCTION hyg_visit_addendum_write_once();
  `);

  // ── App-role grants: no DELETE ─────────────────────────────────────────────
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', '${TABLE}');
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I', '${TABLE}', r);
        RAISE NOTICE '${TABLE}: SELECT/INSERT/UPDATE (no DELETE) granted to role %', r;
      ELSE
        RAISE NOTICE '${TABLE}: app role % absent - grants SKIPPED. Create the least-privilege role and re-run.', r;
      END IF;
    END $$;
  `);
};

/**
 * Refuses while any addendum exists (see the header), then removes the slice.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF to_regclass('public.${TABLE}') IS NOT NULL AND EXISTS (SELECT 1 FROM ${TABLE}) THEN
        RAISE EXCEPTION '${TABLE} holds addenda: an addendum is a clinical record and a rollback will not drop it. Move the rows out by hand first.'
          USING ERRCODE = 'restrict_violation';
      END IF;
    END $$;
  `);
  // The trigger leaves with its table; then the function it called.
  pgm.dropTable(TABLE, { ifExists: true });
  pgm.sql('DROP FUNCTION IF EXISTS hyg_visit_addendum_write_once();');
};

exports.ADDENDUM_STATES = ADDENDUM_STATES;
exports.BODY_MAX = BODY_MAX;
