'use strict';

/**
 * TC nurture campaigns v1 (queue item 47): enrollments, and what a nurture
 * draft needs on tc_messages. ADDITIVE ONLY — one new table, new nullable
 * columns, and four CHECKs widened to strict supersets.
 *
 *   tc_nurture_enrollments   one row per (case, track) enrollment
 *   tc_messages              + enrollment_id, touch_key        which touch a draft is
 *                            + consent_blocked_hint            draft-time advisory
 *                            + skipped_by, skipped_at          the outbox's Skip
 *                            status CHECK + 'skipped'
 *   tc_case_events           type CHECK + the five nurture lifecycle types
 *   tc_library_config        section CHECK + 'nurture_config'
 *
 * NOTHING HERE SENDS, SCHEDULES A SEND, OR READS OPEN DENTAL. An enrollment
 * makes the nightly generator write DRAFTS into tc_messages; a human still
 * clicks Send on each one (services/messaging sendMessage), which is still
 * where consent and quiet hours are enforced.
 *
 * NAMING. The item-47 spec wrote the enrollment columns as `id` and `office`.
 * They are `enrollment_id` and `office_id` here: every tc_* table names its
 * key `<entity>_id` and its office `office_id` (1785373200000_tc_schema.js,
 * 1790300000000_tc_messaging.js), so a TC query never has to remember which
 * table spells it which way.
 *
 * ONE ACTIVE ENROLLMENT PER CASE is a partial UNIQUE index on (case_id) WHERE
 * status = 'active'. The route refuses a second one first (409); the index is
 * the guarantee two simultaneous clicks cannot both get past that check.
 *
 * tc_messages has no meta jsonb column (its only jsonb is email_blocks, the
 * email template snapshot), so the touch identity is two real columns, per the
 * spec's fallback. enrollment_id is ON DELETE SET NULL: a message is history
 * and outlives the enrollment that drafted it, as it outlives its case.
 *
 * CHECK LITERALS ARE INLINE, at each addConstraint call (repo rule: a CHECK is
 * read where it is declared). The drift that costs is paid by
 * backend/test/tcNurtureMigration.test.js, which pins every literal below to
 * the shared contract (shared/tc/nurture.ts, contract.ts, messaging.ts).
 *
 * NUMBERING. The spec said "start at 1791000000000", but open PR #238 (RCM
 * W-21) already claims 1791000000000_rcm_posting_intent.js. This sorts after
 * it and after everything applied on staging (latest 1790900000000).
 *
 * GRANTS. The new table gets the carein_app CRUD grant, role-guarded exactly
 * like tc_messaging's block. ALTER TABLE ADD COLUMN inherits the existing
 * table grants, so the altered tables need none.
 *
 * PHI: tc_nurture_enrollments.stop_reason may hold a TC's free-text reason.
 * It is never copied into an audit row (audit rows carry the enrollment id).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_nurture migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** The table this migration creates — and grants. */
const TABLES = ['tc_nurture_enrollments'];
exports.TABLES = TABLES;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // ── tc_nurture_enrollments ───────────────────────────────────────────────
  pgm.createTable('tc_nurture_enrollments', {
    enrollment_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // A case deleted takes its enrollments with it; the drafts they wrote keep
    // their history (tc_messages.enrollment_id SET NULL below).
    case_id: { type: 'uuid', notNull: true, references: 'tc_cases', onDelete: 'CASCADE' },
    office_id: { type: 'text', notNull: true },
    track_key: { type: 'text', notNull: true },
    // The dial in force WHEN ENROLLED. Changing the office's dial later does
    // not re-cadence an enrollment already running.
    intensity_at_enroll: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'active' },
    // 'case_terminal' / 'opted_out' (system), or the reason a TC typed.
    stop_reason: { type: 'text' },
    // Index into the preset schedule of the NEXT touch to draft.
    next_touch_index: { type: 'integer', notNull: true, default: 0 },
    // When the next touch becomes due. NULL once nothing is left to draft.
    next_touch_due_at: { type: 'timestamptz' },
    last_touch_at: { type: 'timestamptz' },
    created_by: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('tc_nurture_enrollments', 'tc_nurture_enrollments_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint('tc_nurture_enrollments', 'tc_nurture_enrollments_track_check', {
    check: "track_key IN ('no_show_recovery', 'warm_followup', 'reactivation', 'large_case')",
  });
  pgm.addConstraint('tc_nurture_enrollments', 'tc_nurture_enrollments_intensity_check', {
    check: "intensity_at_enroll IN ('gentle', 'standard', 'assertive')",
  });
  pgm.addConstraint('tc_nurture_enrollments', 'tc_nurture_enrollments_status_check', {
    check: "status IN ('active', 'paused', 'completed', 'stopped')",
  });
  pgm.addConstraint('tc_nurture_enrollments', 'tc_nurture_enrollments_index_check', {
    check: 'next_touch_index >= 0 AND next_touch_index <= 12',
  });
  // A stop always says why.
  pgm.addConstraint('tc_nurture_enrollments', 'tc_nurture_enrollments_stop_reason_check', {
    check: "status <> 'stopped' OR (stop_reason IS NOT NULL AND length(btrim(stop_reason)) > 0)",
  });

  pgm.createIndex('tc_nurture_enrollments', ['case_id'], {
    name: 'tc_nurture_enrollments_one_active_per_case',
    unique: true,
    where: "status = 'active'",
  });
  // The nightly generator's scan: this office's active enrollments by due date.
  pgm.createIndex('tc_nurture_enrollments', ['office_id', 'status', 'next_touch_due_at'], {
    name: 'tc_nurture_enrollments_due_idx',
  });

  // ── tc_messages: which touch a draft is, and the outbox's states ─────────
  pgm.addColumns('tc_messages', {
    enrollment_id: { type: 'uuid', references: 'tc_nurture_enrollments', onDelete: 'SET NULL' },
    touch_key: { type: 'text' },
    consent_blocked_hint: { type: 'text' },
    skipped_by: { type: 'text' },
    skipped_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('tc_messages', 'tc_messages_consent_blocked_hint_check', {
    check: "consent_blocked_hint IS NULL OR consent_blocked_hint IN ('opted_out', 'email_unsubscribed', 'no_address')",
  });
  // A touch key only ever rides with the enrollment that drafted it.
  pgm.addConstraint('tc_messages', 'tc_messages_touch_key_check', {
    check: 'touch_key IS NULL OR enrollment_id IS NOT NULL',
  });
  pgm.dropConstraint('tc_messages', 'tc_messages_status_check', { ifExists: true });
  pgm.addConstraint('tc_messages', 'tc_messages_status_check', {
    check: "status IN ('draft', 'queued', 'sending', 'sent', 'delivered', 'failed', 'received', 'skipped')",
  });
  pgm.createIndex('tc_messages', ['enrollment_id'], {
    name: 'tc_messages_enrollment_idx',
    where: 'enrollment_id IS NOT NULL',
  });

  // ── tc_case_events: the nurture lifecycle ────────────────────────────────
  pgm.dropConstraint('tc_case_events', 'tc_case_events_type_check');
  pgm.addConstraint('tc_case_events', 'tc_case_events_type_check', {
    check:
      "type IN ('status_change','follow_up_completed','objection_logged','note_added','case_created','nurture_enrolled','contact_attempt','voice_handoff','nurture_paused','nurture_resumed','nurture_stopped','nurture_completed','nurture_touch_queued')",
  });

  // ── tc_library_config: the per-office dial ───────────────────────────────
  pgm.dropConstraint('tc_library_config', 'tc_library_config_section_check', { ifExists: true });
  pgm.addConstraint('tc_library_config', 'tc_library_config_section_check', {
    check:
      "section IN ('stages','objections','motivators','lost_reasons','referral_sources','treatment_categories','financing_providers','crown_pricing','financing_config','cadence_config','financing_settings','opportunities_config','nurture_config')",
  });

  // ── carein_app grants (tc_messaging's mechanism, CRUD scope) ─────────────
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
        RAISE NOTICE 'tc_nurture: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

/**
 * Removes the slice. Rows that would violate a narrowed CHECK go first:
 * nurture events, skipped drafts (back to draft would resurrect a decision a
 * human made, so they are removed with the feature), and the dial rows.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.sql(
    "DELETE FROM tc_case_events WHERE type IN ('nurture_paused','nurture_resumed','nurture_stopped','nurture_completed','nurture_touch_queued')"
  );
  pgm.sql("DELETE FROM tc_messages WHERE status = 'skipped'");
  pgm.sql("DELETE FROM tc_library_config WHERE section = 'nurture_config'");

  pgm.dropConstraint('tc_library_config', 'tc_library_config_section_check', { ifExists: true });
  pgm.addConstraint('tc_library_config', 'tc_library_config_section_check', {
    check:
      "section IN ('stages','objections','motivators','lost_reasons','referral_sources','treatment_categories','financing_providers','crown_pricing','financing_config','cadence_config','financing_settings','opportunities_config')",
  });

  pgm.dropConstraint('tc_case_events', 'tc_case_events_type_check');
  pgm.addConstraint('tc_case_events', 'tc_case_events_type_check', {
    check:
      "type IN ('status_change','follow_up_completed','objection_logged','note_added','case_created','nurture_enrolled','contact_attempt','voice_handoff')",
  });

  pgm.dropIndex('tc_messages', ['enrollment_id'], { name: 'tc_messages_enrollment_idx', ifExists: true });
  pgm.dropConstraint('tc_messages', 'tc_messages_status_check', { ifExists: true });
  pgm.addConstraint('tc_messages', 'tc_messages_status_check', {
    check: "status IN ('draft', 'queued', 'sending', 'sent', 'delivered', 'failed', 'received')",
  });
  pgm.dropConstraint('tc_messages', 'tc_messages_touch_key_check', { ifExists: true });
  pgm.dropConstraint('tc_messages', 'tc_messages_consent_blocked_hint_check', { ifExists: true });
  pgm.dropColumns('tc_messages', ['enrollment_id', 'touch_key', 'consent_blocked_hint', 'skipped_by', 'skipped_at'], {
    ifExists: true,
  });

  pgm.dropTable('tc_nurture_enrollments', { ifExists: true });
};
