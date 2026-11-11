'use strict';

/**
 * AT-0: the patient paper trail stops losing data. ADDITIVE ONLY — one new
 * table, one new nullable column, one CHECK widened to a strict superset.
 *
 *   tc_case_events      type CHECK + 'notes_updated'
 *                       PUT /api/tc/cases/:id overwrites tc_cases.notes; it
 *                       now ALSO appends one of these rows (full new text in
 *                       `detail`, the acting user in `actor`) in the same
 *                       transaction. The column stays the current value.
 *
 *   tc_referral_events  + letter_snapshot jsonb                write-once
 *                       What the recipient read, frozen at send time, on the
 *                       `send` / `send_conflict` (specialist letter) and
 *                       `patient_email_sent` (patient notice) rows. Written
 *                       only by routes/tc/referralSend.js via
 *                       referralStore.insertSendEvent. Shape:
 *                         { audience: 'specialist'|'patient',
 *                           subject: string, text: string, after?: string }
 *                       THE ONE-TIME LINKS AND THE UNSUBSCRIBE URL ARE NOT IN
 *                       IT: they carry live tokens, and the R5b rule is that a
 *                       token is in the email and nowhere else (only hashes are
 *                       stored). The snapshot is the composed letter text the
 *                       renderer wrapped, not the rendered HTML around it.
 *                       Write-once is a trigger: an UPDATE that changes a
 *                       snapshot raises, whoever runs it.
 *
 *   tc_preauth_events   NEW, append-only. One row per mutation of
 *                       tc_preauth_cases (created / updated / status_change /
 *                       deleted), written in the mutation's own transaction.
 *                       `changes` is { <contract field>: { from, to } } — prior
 *                       values included — so a `deleted` row holds everything
 *                       the deleted pre-auth held. NO FOREIGN KEY to
 *                       tc_preauth_cases ON PURPOSE: the history must outlive
 *                       the row it describes. Append-only the way audit_log is:
 *                       carein_app gets SELECT + INSERT and nothing else.
 *
 * CHECK LITERALS ARE INLINE (house rule). backend/test/at0NoteHistoryMigration
 * .test.js pins them to the shared contract (CaseEventType, PreauthEventType,
 * OfficeId), and scripts/at0-note-history-verify-queries.js runs this file's
 * real up() and down() against a migrated Postgres in CI.
 *
 * NUMBERING: the newest tenant migration on origin/develop at authoring time
 * was 1794200000000_tc_print_styling.js; this sorts strictly after it.
 *
 * NO OPEN DENTAL. Nothing here sends, gates, or changes who may do what.
 *
 * PHI: notes text, letter bodies and pre-auth field values are PHI, stored in
 * the tenant database beside the rows they came from — never in audit rows,
 * never in logs.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[at0_note_history migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // ── tc_case_events: the notes revision ───────────────────────────────────
  pgm.dropConstraint('tc_case_events', 'tc_case_events_type_check');
  pgm.addConstraint('tc_case_events', 'tc_case_events_type_check', {
    check:
      "type IN ('status_change','follow_up_completed','objection_logged','note_added','case_created','nurture_enrolled','contact_attempt','voice_handoff','nurture_paused','nurture_resumed','nurture_stopped','nurture_completed','nurture_touch_queued','notes_updated')",
  });

  // ── tc_referral_events: what the email said ──────────────────────────────
  pgm.addColumns('tc_referral_events', {
    letter_snapshot: { type: 'jsonb' },
  });
  // Only an email that went out carries one. Older send rows carry none.
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_letter_snapshot_verb_check', {
    check: "letter_snapshot IS NULL OR verb IN ('send', 'send_conflict', 'patient_email_sent')",
  });
  // COALESCE(…, false): a missing key makes jsonb_typeof NULL, and a CHECK
  // that evaluates to NULL PASSES — the shape must be false, not unknown.
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_letter_snapshot_shape_check', {
    check:
      "letter_snapshot IS NULL OR COALESCE(jsonb_typeof(letter_snapshot) = 'object' AND (letter_snapshot->>'audience') IN ('specialist', 'patient') AND jsonb_typeof(letter_snapshot->'subject') = 'string' AND jsonb_typeof(letter_snapshot->'text') = 'string', false)",
  });
  pgm.sql(`
    CREATE OR REPLACE FUNCTION tc_referral_events_letter_snapshot_write_once() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.letter_snapshot IS DISTINCT FROM OLD.letter_snapshot THEN
        RAISE EXCEPTION 'tc_referral_events.letter_snapshot is write-once'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$;
  `);
  pgm.sql(`
    CREATE TRIGGER tc_referral_events_letter_snapshot_write_once
      BEFORE UPDATE OF letter_snapshot ON tc_referral_events
      FOR EACH ROW EXECUTE FUNCTION tc_referral_events_letter_snapshot_write_once();
  `);

  // ── tc_preauth_events: the pre-auth history ──────────────────────────────
  pgm.createTable('tc_preauth_events', {
    event_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    // Deliberately no FK: a `deleted` row outlives its pre-auth.
    preauth_id: { type: 'uuid', notNull: true },
    ts: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    actor: { type: 'text' }, // staff identity — never patient identity
    type: { type: 'text', notNull: true },
    changes: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
  });
  pgm.addConstraint('tc_preauth_events', 'tc_preauth_events_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint('tc_preauth_events', 'tc_preauth_events_type_check', {
    check: "type IN ('created', 'updated', 'status_change', 'deleted')",
  });
  pgm.addConstraint('tc_preauth_events', 'tc_preauth_events_changes_check', {
    check: "jsonb_typeof(changes) = 'object'",
  });
  pgm.createIndex('tc_preauth_events', ['office_id', 'preauth_id', 'ts'], {
    name: 'tc_preauth_events_preauth_ts_idx',
  });

  // ── carein_app grants: append-only (SELECT + INSERT, no UPDATE/DELETE) ───
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      EXECUTE 'REVOKE ALL ON TABLE tc_preauth_events FROM PUBLIC';
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT ON TABLE tc_preauth_events TO %I', r);
      ELSE
        RAISE NOTICE 'at0_note_history: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

/**
 * Removes the slice WITHOUT stranding a row in a CHECK-violating state:
 *
 *  - notes_updated rows are KEPT as `note_added` rows (detail cleared, the text
 *    folded into the description, capped at the contract's 8000) — a rollback
 *    must not erase what the notes said;
 *  - the letter snapshots and the pre-auth history leave with their column and
 *    table (nothing else references them).
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('tc_preauth_events', { ifExists: true });

  pgm.sql('DROP TRIGGER IF EXISTS tc_referral_events_letter_snapshot_write_once ON tc_referral_events;');
  pgm.sql('DROP FUNCTION IF EXISTS tc_referral_events_letter_snapshot_write_once();');
  pgm.dropConstraint('tc_referral_events', 'tc_referral_events_letter_snapshot_shape_check', { ifExists: true });
  pgm.dropConstraint('tc_referral_events', 'tc_referral_events_letter_snapshot_verb_check', { ifExists: true });
  pgm.dropColumns('tc_referral_events', ['letter_snapshot'], { ifExists: true });

  pgm.sql(`
    UPDATE tc_case_events
       SET type = 'note_added',
           description = left(
             CASE WHEN COALESCE(detail->>'notes', '') = '' THEN 'Case notes cleared'
                  ELSE 'Case notes edited: ' || (detail->>'notes') END,
             8000),
           detail = NULL
     WHERE type = 'notes_updated';
  `);
  pgm.dropConstraint('tc_case_events', 'tc_case_events_type_check');
  pgm.addConstraint('tc_case_events', 'tc_case_events_type_check', {
    check:
      "type IN ('status_change','follow_up_completed','objection_logged','note_added','case_created','nurture_enrolled','contact_attempt','voice_handoff','nurture_paused','nurture_resumed','nurture_stopped','nurture_completed','nurture_touch_queued')",
  });
};
