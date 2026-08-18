'use strict';

/**
 * RCM Slice 5.5 — fidelity hardening.
 *
 * Slices 4 and 5 were correct against a 13-file synthetic corpus that shares one
 * authoring style. A PM audit against X12 005010X221A1 found a class of defect
 * worse than a crash: files that parse successfully, reconcile arithmetically,
 * and store the WRONG NUMBERS with no flag raised. Slice 6c posts those numbers
 * into a patient's ledger, so they are fixed before the first OD write.
 *
 * This migration is the half of that work the database owns:
 *
 *  1. `rcm_claims.needs_review_reasons` gets a CHECK. It had NONE — either
 *     ingestion path could have written prose into the column the review UI
 *     switches on, and nothing would have said so.
 *  2. `rcm_procedure_lines.flags` and the new `rcm_payment_batches.flags` get
 *     the 5.5 additions.
 *  3. New columns for facts we were previously dropping or fabricating:
 *     where an adjustment was reported, how an allowed amount was arrived at,
 *     the line-item control number, units paid, and remark codes.
 *  4. `rcm_eob_uploads` gets content-addressed dedupe and a machine-readable
 *     failure code.
 *
 * TIMESTAMPED 1787060000000, AFTER Slice 6a's 1787040000000. It was authored as
 * 1787020000000, which sorted BEFORE it; 6a merged to develop first, so on
 * staging and prod 1787040000000 is already run and node-pg-migrate's default
 * `checkOrder` refuses to insert an earlier migration behind it — the deploy's
 * migrate job would have failed before touching a table. Renaming was safe only
 * because this migration had never been applied anywhere; it is not a fix
 * available once a migration has shipped.
 *
 * `up` IS NON-DESTRUCTIVE. Every column is added nullable or with a default
 * that matches what the old code already meant, so existing staging rows keep
 * their meaning. The two CHECKs are the exception and are deliberately
 * VALIDATING: if a staging row already holds a reason outside the vocabulary,
 * this migration FAILS rather than quietly accepting it. That is the point —
 * an unknown reason in that column is exactly the defect the CHECK exists to
 * prevent, and discovering one is worth a failed migration.
 *
 * `down` REFUSES rather than deleting. An earlier revision dropped every
 * claim-level adjustment so the restored NOT NULL would hold — under a header
 * that claimed nothing here was destructive. A rollback that quietly deletes
 * financial rows is worse than one that stops and tells you what is in the way.
 *
 * ⚠ BACKUP/RESTORE ORDERING. `rcm_claims_review_reasons_check` calls the
 * user-defined function `rcm_is_review_reason`. `pg_dump` emits functions
 * before tables, so a plain `pg_restore` of a full dump is fine — but a
 * SELECTIVE restore (`-t rcm_claims`) or any restore that recreates the table
 * without the function FAILS, because the CHECK cannot resolve it. Restore the
 * whole schema, or create the two functions first. See docs/RCM_ERA_FIDELITY.md
 * §"Backup and restore".
 */

/** Mirrors rcmVocabulary.REVIEW_REASONS. The test asserts they cannot drift. */
const REVIEW_REASONS = [
  // ERA (eraParser.js / eraIngest.js)
  'reversal_not_postable',
  'claim_denied',
  'secondary_payer_adjudication',
  'prior_payer_payment_on_primary_claim',
  'unparseable_cas',
  'procedure_downcoded',
  'no_service_lines',
  'line_total_mismatch',
  'unstorable_adjustment_group',
  'claim_level_adjustments_present',
  'patient_resp_mismatch',
  'allowed_amount_mismatch',
  'unreadable_amount',
  'partial_adjustment_segment',
  'claim_line_allowed_mismatch',
  'totals_unreconciled',
  // EOB (eobExtraction.js)
  'low_confidence',
  'missing_npi',
  'missing_dob',
  'missing_check_number',
  'missing_subscriber_id',
  'missing_payer',
  'missing_claim_number',
  'missing_patient_name',
  'no_procedures_extracted',
  'paid_total_mismatch',
  'billed_total_mismatch',
  'invalid_service_date',
  'service_date_in_future',
  'negative_amount',
  'no_claims_extracted',
  'batch_paid_total_mismatch',
];

/** Mirrors rcmVocabulary.LINE_FLAGS. */
const LINE_FLAGS = [
  'downcode',
  'bundled',
  'denied',
  'partial_pay',
  'unexplained_adj',
  'frequency_limit',
  'not_covered',
  'pre_auth_required',
  'unreadable_amount',
  'partial_adjustment_segment',
  'allowed_mismatch',
];

/** Mirrors rcmVocabulary.REMITTANCE_FLAGS. */
const REMITTANCE_FLAGS = [
  'plb_adjustments_present',
  'negative_total_payment',
  'no_payment_made',
  'no_claims_in_remittance',
  'claim_total_mismatch',
  'envelope_counts_mismatch',
  'envelope_incomplete',
  'partial_adjustment_segment',
  'unreadable_amount',
  'multi_transaction_file',
];

/** Mirrors rcmVocabulary.EOB_FAILURE_CODES. */
const EOB_FAILURE_CODES = [
  'pdf_unreadable',
  'no_extractable_text',
  'document_too_large',
  'extraction_invalid',
  'budget_exhausted',
  'llm_unavailable',
  'extraction_failed',
];

/** Mirrors rcmVocabulary.ALLOWED_SOURCES. */
const ALLOWED_SOURCES = ['reported', 'derived'];

/** Mirrors rcmVocabulary.ADJUSTMENT_SCOPES. */
const ADJUSTMENT_SCOPES = ['claim', 'line'];

/** `'a','b','c'` — a SQL string list. */
function sqlList(values) {
  return values.map((v) => `'${v}'`).join(',');
}

/** `ARRAY['a','b']::text[]` */
function sqlArray(values) {
  return `ARRAY[${sqlList(values)}]::text[]`;
}

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ── 1. The review-reason vocabulary, enforced ────────────────────────────
  //
  // A plain `needs_review_reasons <@ ARRAY[…]` cannot express this vocabulary,
  // because one member is PARAMETERISED: `uncertain_line:3` carries the printed
  // line number with it (rcm_procedure_lines has no confidence column, so the
  // pointer lives on the claim). A CHECK expression may not contain a subquery
  // or a set-returning function, so the per-element test goes in an IMMUTABLE
  // function and the CHECK calls that.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION rcm_is_review_reason(reason text)
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $$
      SELECT reason = ANY (${sqlArray(REVIEW_REASONS)})
          OR reason ~ '^uncertain_line:[1-9][0-9]*$'
    $$;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION rcm_are_review_reasons(reasons text[])
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $$
      -- COALESCE so an EMPTY array passes: a clean claim has no reasons, and
      -- bool_and over zero rows is NULL.
      SELECT COALESCE(bool_and(rcm_is_review_reason(r)), true) FROM unnest(reasons) AS r
    $$;
  `);

  pgm.addConstraint('rcm_claims', 'rcm_claims_review_reasons_check', {
    check: 'rcm_are_review_reasons(needs_review_reasons)',
  });

  // ── 2. Line flags: the 5.5 additions ─────────────────────────────────────
  pgm.dropConstraint('rcm_procedure_lines', 'rcm_procedure_lines_flags_check');
  pgm.addConstraint('rcm_procedure_lines', 'rcm_procedure_lines_flags_check', {
    check: `flags <@ ${sqlArray(LINE_FLAGS)}`,
  });

  // ── 3. Remittance flags become structured data ───────────────────────────
  //
  // They were joined into `notes` as the prose string "Flagged: a, b". Prose in
  // a column the UI must switch on is the same mistake as an unconstrained
  // review reason. `notes` goes back to being for humans.
  pgm.addColumns('rcm_payment_batches', {
    flags: { type: 'text[]', notNull: true, default: '{}' },
  });
  pgm.addConstraint('rcm_payment_batches', 'rcm_payment_batches_flags_check', {
    check: `flags <@ ${sqlArray(REMITTANCE_FLAGS)}`,
  });

  // ── 4. Adjustments: claim-level CAS has no service line ──────────────────
  //
  // A1. A CAS between the CLP and the first SVC (loop 2100) applies to the whole
  // claim. It used to be DROPPED — silently, so a claim whose deductible was
  // reported at claim level stored total_deductible_cents = 0 while its own
  // CLP05 said otherwise. Storing it needs the FK to be nullable, because there
  // is no line to hang it on.
  pgm.alterColumn('rcm_procedure_adjustments', 'procedure_line_id', { notNull: false });
  pgm.addColumns('rcm_procedure_adjustments', {
    scope: { type: 'text', notNull: true, default: 'line' },
  });
  pgm.addConstraint('rcm_procedure_adjustments', 'rcm_procedure_adjustments_scope_check', {
    check: `scope IN (${sqlList(ADJUSTMENT_SCOPES)})`,
  });
  // The two must agree: a line-scoped adjustment has a line, a claim-scoped one
  // does not. Without this the nullable FK above would let a line-scoped row
  // lose its line and still look valid.
  pgm.addConstraint('rcm_procedure_adjustments', 'rcm_procedure_adjustments_scope_line_check', {
    check: `(scope = 'line' AND procedure_line_id IS NOT NULL)
         OR (scope = 'claim' AND procedure_line_id IS NULL)`,
  });

  // ── 5. Line fidelity: what we were deriving or dropping ──────────────────
  pgm.addColumns('rcm_procedure_lines', {
    /**
     * A3. How `allowed_cents` was arrived at. Defaulting to 'derived' is the
     * honest read of every row written before this migration: they all were.
     */
    allowed_source: { type: 'text', notNull: true, default: 'derived' },
    /** A3. The reported AMT*B6, when the payer sent one. NULL = not reported. */
    reported_allowed_cents: { type: 'bigint' },
    /**
     * B1. REF*6R — the line item control number. Present on every SVC in the
     * corpus and the only reliable key for matching a remitted line back to a
     * submitted claim line. Without it Slice 6's matcher is POSITIONAL, which
     * breaks the moment a payer reorders or splits lines.
     */
    line_item_control_number: { type: 'text' },
    /** B1. SVC05 — units actually paid. Fractional units are legal in X12. */
    units_paid: { type: 'numeric(12,3)' },
    /**
     * B2. The FULL RARC set for this line. Remark codes are reported per SERVICE
     * LINE (LQ*HE), not per adjustment — X12 gives no CAS↔LQ association at all.
     * Stamping remarkCodes[0] onto every adjustment stored the first RARC three
     * times on a three-CARC line: plausible, and wrong.
     */
    remark_codes: { type: 'text[]', notNull: true, default: '{}' },
  });
  pgm.addConstraint('rcm_procedure_lines', 'rcm_procedure_lines_allowed_source_check', {
    check: `allowed_source IN (${sqlList(ALLOWED_SOURCES)})`,
  });

  // B2 leaves `rcm_procedure_adjustments.remark_code` UNWRITTEN BY THE ERA PATH.
  // It is not dropped: the EOB extraction still populates it (its model returns
  // one remark per adjustment, which is a different and legitimate shape), and
  // dropping a NOT NULL DEFAULT '' column that another writer uses would be a
  // second change riding on this one. Said out loud in the database so a reader
  // of the schema alone is not misled into thinking the ERA path fills it.
  pgm.sql(`
    COMMENT ON COLUMN rcm_procedure_adjustments.remark_code IS
      'EOB path only. The ERA path leaves this NULL and stores the full RARC set '
      'on rcm_procedure_lines.remark_codes, because X12 associates LQ*HE remark '
      'codes with the SERVICE LINE and gives no CAS-to-LQ mapping at all.';
  `);

  // ── 6. Claim-level remark codes ──────────────────────────────────────────
  // B2. MOA / MIA carry claim-level remark codes and were not read at all.
  pgm.addColumns('rcm_claims', {
    remark_codes: { type: 'text[]', notNull: true, default: '{}' },
  });

  // ── 7. EOB dedupe + a machine-readable failure code ──────────────────────
  //
  // Part C. The ERA path has the reserve→finalize remittance-key protocol; the
  // EOB path had NO dedupe at all, so the same PDF uploaded twice created two
  // batches, two sets of claims, two sets of lines — a double-post waiting for
  // Slice 6c.
  //
  // The Slice 1 comment on the existing index said file_hash was deliberately
  // NOT unique "because a deliberate re-upload is legitimate". That was written
  // before there was anything to double-post INTO. It is superseded here, with
  // one carve-out: a FAILED upload does not reserve the hash, so a document that
  // failed extraction can be retried. Only rows that produced (or are producing)
  // a proposal hold the claim.
  // GUARD FIRST. Staging holds real uploaded remittances, and the pre-existing
  // read-then-write race this index closes is exactly what produces duplicate
  // (office_id, file_hash) rows — so the index creation can abort on live data.
  // Postgres' own error names one pair and stops; this names them all, with the
  // query an operator needs, before anything is attempted.
  pgm.sql(`
    DO $$
    DECLARE
      dupes text;
    BEGIN
      SELECT string_agg(format('%s/%s x%s', office_id, left(file_hash, 12), n), ', ')
        INTO dupes
        FROM (
          SELECT office_id, file_hash, count(*) AS n
            FROM rcm_eob_uploads
           WHERE status <> 'failed' AND file_hash IS NOT NULL
           GROUP BY office_id, file_hash
          HAVING count(*) > 1
        ) d;

      IF dupes IS NOT NULL THEN
        RAISE EXCEPTION
          'rcm_eob_uploads already holds duplicate (office_id, file_hash) rows: %. '
          'These are duplicate proposals from the read-then-write race this index closes. '
          'Resolve them before migrating — see docs/RCM_ERA_FIDELITY.md "Before you deploy".',
          dupes;
      END IF;
    END $$;
  `);

  pgm.createIndex('rcm_eob_uploads', ['office_id', 'file_hash'], {
    name: 'rcm_eob_uploads_office_hash_unique',
    unique: true,
    where: "status <> 'failed' AND file_hash IS NOT NULL",
  });

  pgm.addColumns('rcm_eob_uploads', {
    /** A6. What the UI switches on; `error_message` stays the human sentence. */
    failure_code: { type: 'text' },
  });
  pgm.addConstraint('rcm_eob_uploads', 'rcm_eob_uploads_failure_code_check', {
    check: `failure_code IS NULL OR failure_code IN (${sqlList(EOB_FAILURE_CODES)})`,
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('rcm_eob_uploads', 'rcm_eob_uploads_failure_code_check');
  pgm.dropColumns('rcm_eob_uploads', ['failure_code']);
  pgm.dropIndex('rcm_eob_uploads', ['office_id', 'file_hash'], {
    name: 'rcm_eob_uploads_office_hash_unique',
  });

  pgm.dropColumns('rcm_claims', ['remark_codes']);

  pgm.dropConstraint('rcm_procedure_lines', 'rcm_procedure_lines_allowed_source_check');
  pgm.dropColumns('rcm_procedure_lines', [
    'allowed_source',
    'reported_allowed_cents',
    'line_item_control_number',
    'units_paid',
    'remark_codes',
  ]);

  pgm.dropConstraint('rcm_procedure_adjustments', 'rcm_procedure_adjustments_scope_line_check');
  pgm.dropConstraint('rcm_procedure_adjustments', 'rcm_procedure_adjustments_scope_check');
  pgm.dropColumns('rcm_procedure_adjustments', ['scope']);

  // Claim-scoped adjustments have no service line and would violate the
  // restored NOT NULL. REFUSE rather than delete them: they are the money a
  // payer reported at claim level, and a rollback is not a mandate to discard
  // financial rows. The operator decides what happens to them.
  pgm.sql(`
    DO $$
    DECLARE
      n bigint;
    BEGIN
      SELECT count(*) INTO n FROM rcm_procedure_adjustments WHERE procedure_line_id IS NULL;
      IF n > 0 THEN
        RAISE EXCEPTION
          'Cannot roll back: % claim-level adjustment row(s) have no service line and '
          'would be destroyed by restoring procedure_line_id NOT NULL. Export or delete '
          'them deliberately first: SELECT * FROM rcm_procedure_adjustments '
          'WHERE procedure_line_id IS NULL;', n;
      END IF;
    END $$;
  `);
  pgm.alterColumn('rcm_procedure_adjustments', 'procedure_line_id', { notNull: true });

  pgm.dropConstraint('rcm_payment_batches', 'rcm_payment_batches_flags_check');
  pgm.dropColumns('rcm_payment_batches', ['flags']);

  pgm.dropConstraint('rcm_procedure_lines', 'rcm_procedure_lines_flags_check');
  pgm.addConstraint('rcm_procedure_lines', 'rcm_procedure_lines_flags_check', {
    check:
      "flags <@ ARRAY['downcode','bundled','denied','partial_pay','unexplained_adj','frequency_limit','not_covered','pre_auth_required']::text[]",
  });

  pgm.dropConstraint('rcm_claims', 'rcm_claims_review_reasons_check');
  pgm.sql('DROP FUNCTION IF EXISTS rcm_are_review_reasons(text[])');
  pgm.sql('DROP FUNCTION IF EXISTS rcm_is_review_reason(text)');
};
