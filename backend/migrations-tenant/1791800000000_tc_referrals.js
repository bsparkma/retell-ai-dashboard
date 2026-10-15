'use strict';

/**
 * Referrals foundations (queue item 52, R1): the specialist directory, the
 * referral record and its transition log, attachment METADATA, and the two
 * per-office referral policies.
 *
 * NOTHING SENDS and nothing here touches Open Dental. R1 ships the tables, the
 * directory CRUD and the settings; R2 creates and moves referrals; R4 wires
 * attachment storage.
 *
 *   tc_referral_directory      the office's specialists (front desk enters them)
 *   tc_referrals               one referral: the patient (office + PatNum,
 *                              server-derived, with a name snapshot), an
 *                              optional linked TC case, the directory entry,
 *                              specialty / reason / teeth / urgency /
 *                              narrative, and its status
 *   tc_referral_events         every status transition: from, to, actor, when
 *                              (the audit_log row per transition is written by
 *                              the route, in R2)
 *   tc_referral_attachments    metadata only (R4 stores the bytes)
 *   tc_referral_settings       per office: sign-off required (default ON),
 *                              auto-send on approval (default OFF)
 *
 * THE STATUS VOCABULARY, inline and exact (house rule: CHECK literals inline):
 *   draft, pending_signoff, approved, sent, acknowledged, patient_seen,
 *   closed, declined, cancelled
 * shared/tc/referrals.ts carries the same nine; a test pins them equal.
 *
 * OFFICE SCOPING IS STRUCTURAL. Every table carries office_id NOT NULL, and
 * every child points at its parent through a COMPOSITE (office_id, id) foreign
 * key, so no row can reference another office's row. That needs UNIQUE
 * (office_id, id) on each parent; tc_cases gains one here (its PK is case_id
 * alone, so the pair is unique already — this only lets a FK name it).
 *
 *   referral → case        ON DELETE RESTRICT: a case with referrals cannot be
 *                          deleted out from under them. (SET NULL on a
 *                          composite key would null office_id too, which is
 *                          NOT NULL; and a referral is a record of care that
 *                          should not lose its case silently.)
 *   referral → directory   ON DELETE RESTRICT: the directory route refuses to
 *                          delete an entry that is referenced (deactivate it).
 *   event / attachment     ON DELETE CASCADE with their referral.
 *
 * carein_app grants in this same migration.
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_referrals migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** The tables this migration creates — and grants. */
const TABLES = [
  'tc_referral_directory',
  'tc_referrals',
  'tc_referral_events',
  'tc_referral_attachments',
  'tc_referral_settings',
];
exports.TABLES = TABLES;

const OFFICE_CHECK = "office_id IN ('roland', 'valley')";
const STATUS_CHECK =
  "status IN ('draft', 'pending_signoff', 'approved', 'sent', 'acknowledged', 'patient_seen', 'closed', 'declined', 'cancelled')";

exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  pgm.addConstraint('tc_cases', 'tc_cases_office_case_unique', { unique: ['office_id', 'case_id'] });

  // ── tc_referral_directory ────────────────────────────────────────────────
  pgm.createTable('tc_referral_directory', {
    entry_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    practice_name: { type: 'text', notNull: true },
    specialist_name: { type: 'text', notNull: true, default: '' },
    specialty: { type: 'text', notNull: true, default: '' },
    contact_person: { type: 'text', notNull: true, default: '' },
    email: { type: 'text', notNull: true, default: '' },
    phone: { type: 'text', notNull: true, default: '' },
    fax: { type: 'text', notNull: true, default: '' },
    notes: { type: 'text', notNull: true, default: '' },
    preferred_format_notes: { type: 'text', notNull: true, default: '' },
    active: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_by: { type: 'text', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('tc_referral_directory', 'tc_referral_directory_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('tc_referral_directory', 'tc_referral_directory_practice_check', {
    check: "length(btrim(practice_name)) BETWEEN 1 AND 200",
  });
  pgm.addConstraint('tc_referral_directory', 'tc_referral_directory_email_check', {
    check: "email = '' OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'",
  });
  pgm.addConstraint('tc_referral_directory', 'tc_referral_directory_office_entry_unique', {
    unique: ['office_id', 'entry_id'],
  });
  pgm.createIndex('tc_referral_directory', ['office_id', 'practice_name'], {
    name: 'tc_referral_directory_office_name_idx',
  });

  // ── tc_referrals ─────────────────────────────────────────────────────────
  pgm.createTable('tc_referrals', {
    referral_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    // bigint like every PatNum. Server-derived, never from a request.
    od_patient_id: { type: 'bigint', notNull: true },
    patient_name: { type: 'text', notNull: true }, // PHI snapshot
    tc_case_id: { type: 'uuid' },
    referring_provider: { type: 'text', notNull: true, default: '' },
    directory_entry_id: { type: 'uuid' },
    specialty: { type: 'text', notNull: true, default: '' },
    reason: { type: 'text', notNull: true, default: '' },
    // [3, 14] or "mouth" — the same shape as a checkout procedure's teeth.
    teeth: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    urgency: { type: 'text', notNull: true, default: 'routine' },
    narrative: { type: 'text', notNull: true, default: '' }, // PHI
    status: { type: 'text', notNull: true, default: 'draft' },
    status_changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    status_changed_by: { type: 'text', notNull: true },
    created_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('tc_referrals', 'tc_referrals_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('tc_referrals', 'tc_referrals_status_check', { check: STATUS_CHECK });
  pgm.addConstraint('tc_referrals', 'tc_referrals_urgency_check', {
    check: "urgency IN ('routine', 'soon', 'urgent')",
  });
  pgm.addConstraint('tc_referrals', 'tc_referrals_patient_positive_check', { check: 'od_patient_id > 0' });
  pgm.addConstraint('tc_referrals', 'tc_referrals_teeth_shape_check', {
    check: "jsonb_typeof(teeth) = 'array' OR teeth = '\"mouth\"'::jsonb",
  });
  pgm.addConstraint('tc_referrals', 'tc_referrals_office_referral_unique', {
    unique: ['office_id', 'referral_id'],
  });
  pgm.addConstraint('tc_referrals', 'tc_referrals_case_fk', {
    foreignKeys: {
      columns: ['office_id', 'tc_case_id'],
      references: 'tc_cases(office_id, case_id)',
      onDelete: 'RESTRICT',
    },
  });
  pgm.addConstraint('tc_referrals', 'tc_referrals_directory_fk', {
    foreignKeys: {
      columns: ['office_id', 'directory_entry_id'],
      references: 'tc_referral_directory(office_id, entry_id)',
      onDelete: 'RESTRICT',
    },
  });
  pgm.createIndex('tc_referrals', ['office_id', 'status'], { name: 'tc_referrals_office_status_idx' });
  pgm.createIndex('tc_referrals', ['office_id', 'od_patient_id'], { name: 'tc_referrals_office_patient_idx' });
  pgm.createIndex('tc_referrals', ['office_id', 'tc_case_id'], {
    name: 'tc_referrals_office_case_idx',
    where: 'tc_case_id IS NOT NULL',
  });
  pgm.createIndex('tc_referrals', ['office_id', 'directory_entry_id'], {
    name: 'tc_referrals_office_directory_idx',
    where: 'directory_entry_id IS NOT NULL',
  });

  // ── tc_referral_events (the transition log) ──────────────────────────────
  pgm.createTable('tc_referral_events', {
    event_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    referral_id: { type: 'uuid', notNull: true },
    // NULL only for the creating event.
    from_status: { type: 'text' },
    to_status: { type: 'text', notNull: true },
    actor: { type: 'text', notNull: true },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    note: { type: 'text', notNull: true, default: '' },
  });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_to_status_check', {
    check: STATUS_CHECK.replace(/^status /, 'to_status '),
  });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_from_status_check', {
    check: `from_status IS NULL OR ${STATUS_CHECK.replace(/^status /, 'from_status ')}`,
  });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_referral_fk', {
    foreignKeys: {
      columns: ['office_id', 'referral_id'],
      references: 'tc_referrals(office_id, referral_id)',
      onDelete: 'CASCADE',
    },
  });
  pgm.createIndex('tc_referral_events', ['office_id', 'referral_id', 'at'], {
    name: 'tc_referral_events_referral_idx',
  });

  // ── tc_referral_attachments (metadata only; R4 stores the bytes) ─────────
  pgm.createTable('tc_referral_attachments', {
    attachment_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    referral_id: { type: 'uuid', notNull: true },
    file_name: { type: 'text', notNull: true }, // sanitized at upload (R4)
    content_type: { type: 'text', notNull: true },
    size_bytes: { type: 'integer', notNull: true },
    blob_key: { type: 'text', notNull: true },
    uploaded_by: { type: 'text', notNull: true },
    uploaded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('tc_referral_attachments', 'tc_referral_attachments_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('tc_referral_attachments', 'tc_referral_attachments_type_check', {
    check: "content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf')",
  });
  pgm.addConstraint('tc_referral_attachments', 'tc_referral_attachments_size_check', {
    check: 'size_bytes > 0 AND size_bytes <= 10485760',
  });
  pgm.addConstraint('tc_referral_attachments', 'tc_referral_attachments_name_check', {
    check: 'length(file_name) BETWEEN 1 AND 200',
  });
  pgm.addConstraint('tc_referral_attachments', 'tc_referral_attachments_referral_fk', {
    foreignKeys: {
      columns: ['office_id', 'referral_id'],
      references: 'tc_referrals(office_id, referral_id)',
      onDelete: 'CASCADE',
    },
  });
  pgm.createIndex('tc_referral_attachments', ['office_id', 'referral_id'], {
    name: 'tc_referral_attachments_referral_idx',
  });

  // ── tc_referral_settings (one row per office; absent = the defaults) ─────
  pgm.createTable('tc_referral_settings', {
    office_id: { type: 'text', primaryKey: true },
    signoff_required: { type: 'boolean', notNull: true, default: true },
    autosend_on_approval: { type: 'boolean', notNull: true, default: false },
    updated_by: { type: 'text', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('tc_referral_settings', 'tc_referral_settings_office_check', { check: OFFICE_CHECK });

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
        RAISE NOTICE 'tc_referrals: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('tc_referral_settings', { ifExists: true });
  pgm.dropTable('tc_referral_attachments', { ifExists: true });
  pgm.dropTable('tc_referral_events', { ifExists: true });
  pgm.dropTable('tc_referrals', { ifExists: true });
  pgm.dropTable('tc_referral_directory', { ifExists: true });
  pgm.dropConstraint('tc_cases', 'tc_cases_office_case_unique', { ifExists: true });
};
