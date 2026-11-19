'use strict';

/**
 * MT-2b2 — replace every hard-coded office CHECK with a FORMAT check, so a
 * tenant can hold an office key other than 'roland' / 'valley'.
 *
 * WHY. 70 tenant tables carried `<col> IN ('roland', 'valley')` (inventoried
 * from the live catalog of a fully-migrated Postgres 16, 2026-11-18). The
 * office registry (MT-1, control plane) is now where office keys come from,
 * and no tenant could ever have had a third one while the data plane pinned
 * the pair.
 *
 * WHAT THE DATABASE NOW GUARANTEES — and what it no longer does:
 *   - office_id / office is still NOT NULL (every one of the 70 columns already
 *     was; this migration does not touch nullability).
 *   - it matches ^[a-z][a-z0-9_-]{1,31}$ — a lowercase key, 2–32 chars, that
 *     starts with a letter. Same shape on every table.
 *   - it does NOT say the key is a REAL office. Tenant DBs cannot FK to the
 *     control plane, so validity stays server-side: the module gates
 *     (routes/{tc,hyg,fees,rcm}/helpers.js requireOffice, the messaging
 *     office checks, the shared/ zod contracts) are the refusal layer, and
 *     this PR changes none of them. 'unknown' passes the format; the server
 *     gates are what keep it out. Accepted deliberately (MT-2b2 brief).
 *
 * CONSTRAINT NAMES ARE KEPT. Each format check reuses `<table>_office_check`,
 * so nothing that names a constraint has to change, and down() restores the
 * original expression under the same name.
 *
 * down() RESTORES THE ORIGINALS VERBATIM — the exact text every source
 * migration used (`office_id IN ('roland', 'valley')` / `office IN (...)`).
 * It REFUSES (raises, before changing anything) if any row holds an office
 * other than roland/valley: re-pinning the pair over a third office's rows
 * would fail on the first such table anyway, and deleting or rewriting a
 * practice's rows to make a rollback pass is not a call a migration makes.
 * Move or remove those rows by hand first.
 *
 * Proven against real Postgres by scripts/office-format-checks-verify-queries.js
 * (CI runs it after migrate): new key inserts, garbage refused, real down()
 * and up() with rows present.
 */

/** The format every office column must match. Inline literals, not templates. */
const FORMAT_CHECK_OFFICE_ID = "office_id ~ '^[a-z][a-z0-9_-]{1,31}$'";
const FORMAT_CHECK_OFFICE = "office ~ '^[a-z][a-z0-9_-]{1,31}$'";

/** The originals, verbatim as every source migration wrote them. */
const ORIGINAL_CHECK_OFFICE_ID = "office_id IN ('roland', 'valley')";
const ORIGINAL_CHECK_OFFICE = "office IN ('roland', 'valley')";

/**
 * Every tenant table whose office column was pinned to the pair, with that
 * column's name, in constraint-creation order. 61 `office_id`, 9 `office`.
 * Pinned by test/officeFormatChecksMigration.test.js against the source of
 * every earlier tenant migration.
 */
const OFFICE_TABLES = Object.freeze([
  Object.freeze(['tc_cases', 'office_id']),
  Object.freeze(['tc_case_phases', 'office_id']),
  Object.freeze(['tc_case_items', 'office_id']),
  Object.freeze(['tc_case_objections', 'office_id']),
  Object.freeze(['tc_followups', 'office_id']),
  Object.freeze(['tc_case_events', 'office_id']),
  Object.freeze(['tc_hygiene_intakes', 'office_id']),
  Object.freeze(['tc_preauth_cases', 'office_id']),
  Object.freeze(['tc_email_templates', 'office_id']),
  Object.freeze(['tc_communications', 'office_id']),
  Object.freeze(['tc_gallery_cases', 'office_id']),
  Object.freeze(['tc_smile_simulations', 'office_id']),
  Object.freeze(['tc_library_config', 'office_id']),
  Object.freeze(['rcm_payer_rules', 'office_id']),
  Object.freeze(['rcm_office_settings', 'office_id']),
  Object.freeze(['rcm_vcc_processor_patterns', 'office_id']),
  Object.freeze(['rcm_stedi_events', 'office_id']),
  Object.freeze(['rcm_stedi_transactions', 'office_id']),
  Object.freeze(['rcm_bank_transactions', 'office_id']),
  Object.freeze(['rcm_claims', 'office_id']),
  Object.freeze(['rcm_procedure_lines', 'office_id']),
  Object.freeze(['rcm_procedure_adjustments', 'office_id']),
  Object.freeze(['rcm_activity_events', 'office_id']),
  Object.freeze(['rcm_payment_batches', 'office_id']),
  Object.freeze(['rcm_batch_claim_payments', 'office_id']),
  Object.freeze(['rcm_claim_payment_history', 'office_id']),
  Object.freeze(['rcm_eob_uploads', 'office_id']),
  Object.freeze(['rcm_posting_audits', 'office_id']),
  Object.freeze(['rcm_remittance_keys', 'office_id']),
  Object.freeze(['rcm_handoff_tasks', 'office_id']),
  Object.freeze(['rcm_deposit_audit_events', 'office_id']),
  Object.freeze(['rcm_approval_requests', 'office_id']),
  Object.freeze(['rcm_recon_runs', 'office_id']),
  Object.freeze(['rcm_posting_queue', 'office_id']),
  Object.freeze(['rcm_posting_queue_line', 'office_id']),
  Object.freeze(['rcm_posting_document', 'office_id']),
  Object.freeze(['hyg_visit', 'office']),
  Object.freeze(['hyg_treatment_item', 'office']),
  Object.freeze(['hyg_staged_write', 'office']),
  Object.freeze(['hyg_perio_send', 'office']),
  Object.freeze(['fees_import_batch', 'office']),
  Object.freeze(['fees_import_row', 'office']),
  Object.freeze(['fees_od_backup', 'office']),
  Object.freeze(['rcm_eob_field_confirmations', 'office_id']),
  Object.freeze(['rcm_eob_added_lines', 'office_id']),
  Object.freeze(['rcm_eob_line_strikes', 'office_id']),
  Object.freeze(['tc_messages', 'office_id']),
  Object.freeze(['tc_contact_consent', 'office_id']),
  Object.freeze(['tc_opportunities', 'office_id']),
  Object.freeze(['tc_opportunity_sync', 'office_id']),
  Object.freeze(['tc_nurture_enrollments', 'office_id']),
  Object.freeze(['tc_checkout_handoffs', 'office_id']),
  Object.freeze(['tc_notification_defaults', 'office_id']),
  Object.freeze(['tc_checkout_attestations', 'office_id']),
  Object.freeze(['tc_referral_directory', 'office_id']),
  Object.freeze(['tc_referrals', 'office_id']),
  Object.freeze(['tc_referral_events', 'office_id']),
  Object.freeze(['tc_referral_attachments', 'office_id']),
  Object.freeze(['tc_referral_settings', 'office_id']),
  Object.freeze(['tc_email_identity_changes', 'office_id']),
  Object.freeze(['tc_referral_link_tokens', 'office_id']),
  Object.freeze(['tc_provider_directory', 'office_id']),
  Object.freeze(['hyg_existing_tx_disposition', 'office']),
  Object.freeze(['hyg_staff', 'office']),
  Object.freeze(['tc_od_sync_runs', 'office_id']),
  Object.freeze(['tc_print_templates', 'office_id']),
  Object.freeze(['tc_preauth_events', 'office_id']),
  Object.freeze(['tc_checkout_questions', 'office_id']),
  Object.freeze(['tc_referral_templates', 'office_id']),
  Object.freeze(['tc_chart_writes', 'office_id']),
]);

const formatCheckFor = (column) => (column === 'office_id' ? FORMAT_CHECK_OFFICE_ID : FORMAT_CHECK_OFFICE);
const originalCheckFor = (column) => (column === 'office_id' ? ORIGINAL_CHECK_OFFICE_ID : ORIGINAL_CHECK_OFFICE);

exports.up = (pgm) => {
  for (const [table, column] of OFFICE_TABLES) {
    const name = `${table}_office_check`;
    pgm.dropConstraint(table, name);
    pgm.addConstraint(table, name, { check: formatCheckFor(column) });
  }
};

/**
 * One guard statement, then the restore. The guard names the first table that
 * holds a non-pair office so the operator knows where to look.
 */
const DOWN_GUARD = `DO $$
DECLARE
  t record;
  n bigint;
BEGIN
  FOR t IN SELECT * FROM (VALUES
${OFFICE_TABLES.map(([table, column]) => `    ('${table}', '${column}')`).join(',\n')}
  ) AS v(tbl, col) LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I NOT IN (''roland'', ''valley'')', t.tbl, t.col) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'MT-2b2 down(): % row(s) in % hold an office other than roland/valley; move or remove them before rolling back', n, t.tbl;
    END IF;
  END LOOP;
END
$$;`;

exports.down = (pgm) => {
  pgm.sql(DOWN_GUARD);
  for (const [table, column] of OFFICE_TABLES) {
    const name = `${table}_office_check`;
    pgm.dropConstraint(table, name);
    pgm.addConstraint(table, name, { check: originalCheckFor(column) });
  }
};

exports.OFFICE_TABLES = OFFICE_TABLES;
exports.FORMAT_CHECK_OFFICE_ID = FORMAT_CHECK_OFFICE_ID;
exports.FORMAT_CHECK_OFFICE = FORMAT_CHECK_OFFICE;
exports.ORIGINAL_CHECK_OFFICE_ID = ORIGINAL_CHECK_OFFICE_ID;
exports.ORIGINAL_CHECK_OFFICE = ORIGINAL_CHECK_OFFICE;
exports.DOWN_GUARD = DOWN_GUARD;
