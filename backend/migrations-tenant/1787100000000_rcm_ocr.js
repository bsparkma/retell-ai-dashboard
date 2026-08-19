'use strict';

/**
 * RCM — OCR for scanned EOBs.
 *
 * `eobDocumentText.extractPdfText` was text-layer only, so a faxed or
 * photographed EOB failed honestly with `no_extractable_text` and bounced. Azure
 * Document Intelligence now reads those pages as a PRE-STEP feeding the same
 * extraction engine. This migration is the half of that work the database owns:
 *
 *  1. `rcm_eob_uploads` records HOW a document was read — text layer or OCR —
 *     plus the OCR page count and mean confidence.
 *  2. The failure-code vocabulary gains the three ways OCR can go wrong.
 *  3. The review-reason vocabulary gains `ocr_low_confidence`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY PROVENANCE IS A COLUMN AND NOT AN INFERENCE
 * ─────────────────────────────────────────────────────────────────────────────
 * A biller checking a $4,000 check needs to know whether she is looking at
 * numbers PARSED out of a text layer or numbers a model READ off a picture.
 * Nothing else in the row can tell her: the file is a PDF either way, the claims
 * look the same either way, and `confidence` on `rcm_claims` is the extraction
 * model's confidence in its own reading of a string — a different number about a
 * different step. So it is recorded at the moment it is known, in the same
 * transaction as the proposal it describes.
 *
 * NULL `text_source` means "not extracted (yet)", which is the honest reading of
 * every row written before this migration and of every row still waiting. It is
 * NOT defaulted to 'text_layer': that would assert something about historical
 * rows that happens to be true today and would silently become a lie the moment
 * anyone backfills.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDITIVE, AND VALIDATING WHERE IT MATTERS
 * ─────────────────────────────────────────────────────────────────────────────
 * Every column is added nullable. The two vocabularies only GROW — no existing
 * value is removed — so the re-added CHECK cannot reject a row that was legal
 * before. `up` is safe to run against staging and prod with live data.
 *
 * ⚠ `CREATE OR REPLACE FUNCTION` does NOT re-validate existing rows against the
 * CHECK that calls it. That is harmless in `up` (the vocabulary only widens) and
 * is exactly why `down` REFUSES rather than silently leaving rows that violate
 * the narrower constraint — see the guard there.
 *
 * GRANTS: none are needed. Table-level privileges cover columns added later, so
 * the least-privilege app role can read and write these without a new GRANT, and
 * the two vocabulary functions are `EXECUTE` to PUBLIC as functions are by
 * default. The role-guarded re-assert below is a no-op on an existing database
 * and exists so a database provisioned from this migration forward is right
 * without depending on a reader noticing that it inherits.
 */

/**
 * Mirrors rcmVocabulary.REVIEW_REASONS, in full.
 *
 * The whole list, not a delta: `rcm_is_review_reason` is replaced wholesale, so
 * a partial list here would silently REVOKE every reason it omitted. The drift
 * test (`rcmVocabulary.test.js`) reads the LAST migration to declare each list,
 * which is this one for `REVIEW_REASONS` and `EOB_FAILURE_CODES`.
 */
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
  // OCR — the reading, not the file
  'ocr_low_confidence',
];

/** Mirrors rcmVocabulary.EOB_FAILURE_CODES, in full. */
const EOB_FAILURE_CODES = [
  'pdf_unreadable',
  'no_extractable_text',
  'document_too_large',
  'extraction_invalid',
  'budget_exhausted',
  'llm_unavailable',
  'extraction_failed',
  // OCR
  'ocr_unreadable',
  'ocr_failed',
  'ocr_budget_exhausted',
  'ocr_document_exceeds_cap',
];

/** How a document's text was obtained — `rcm_eob_uploads.text_source`. */
const TEXT_SOURCES = ['text_layer', 'ocr'];

/** The failure codes that only the OCR path can produce; `down` refuses on these. */
const OCR_ONLY_FAILURE_CODES = [
  'ocr_unreadable',
  'ocr_failed',
  'ocr_budget_exhausted',
  'ocr_document_exceeds_cap',
];

/**
 * The least-privilege application role, resolved exactly as every other
 * migration in this repo resolves it. Validated rather than interpolated blind:
 * this string reaches `DO $$ DECLARE r text := '…'` and a role name with a quote
 * in it would be a SQL injection through an environment variable.
 */
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[rcm_ocr migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

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
  // ── 1. Provenance on the upload ──────────────────────────────────────────
  pgm.addColumns('rcm_eob_uploads', {
    /**
     * 'text_layer' | 'ocr'. NULL = this document has not been read yet.
     * Written INSIDE the proposal transaction, so a row that says how it was
     * read is a row whose claims exist.
     */
    text_source: { type: 'text' },
    /**
     * Pages Azure Document Intelligence actually processed — the BILLED unit,
     * which is why it is stored separately from anything the PDF declares about
     * itself. NULL on the text-layer path: no pages were OCR'd, and 0 would read
     * as "OCR ran and found nothing".
     */
    ocr_page_count: { type: 'integer' },
    /**
     * Word-count-weighted mean confidence, 0.000–1.000. NULL means the reader
     * did not report one — which is a different fact from "the reader was
     * certain", and the screen says so.
     */
    ocr_mean_confidence: { type: 'numeric(4,3)' },
  });

  pgm.addConstraint('rcm_eob_uploads', 'rcm_eob_uploads_text_source_check', {
    check: `text_source IS NULL OR text_source IN (${sqlList(TEXT_SOURCES)})`,
  });

  // The three columns must tell ONE story. Without this, a row could claim it
  // was read from a text layer while carrying an OCR page count, or claim OCR
  // with no page count at all — provenance that contradicts itself is worse than
  // none, because it looks authoritative.
  pgm.addConstraint('rcm_eob_uploads', 'rcm_eob_uploads_ocr_provenance_check', {
    check: `(text_source = 'ocr' AND ocr_page_count IS NOT NULL AND ocr_page_count > 0)
         OR (text_source IS DISTINCT FROM 'ocr' AND ocr_page_count IS NULL AND ocr_mean_confidence IS NULL)`,
  });

  pgm.sql(`
    COMMENT ON COLUMN rcm_eob_uploads.text_source IS
      'How this document became text: ''text_layer'' (pdf-parse) or ''ocr'' (Azure '
      'Document Intelligence). NULL = not extracted yet. Shown to the biller on the '
      'remittance and claim screens, because numbers read off a picture warrant '
      'different scrutiny from numbers parsed out of a text layer.';
  `);

  // ── 2. The failure-code vocabulary gains the OCR outcomes ────────────────
  pgm.dropConstraint('rcm_eob_uploads', 'rcm_eob_uploads_failure_code_check');
  pgm.addConstraint('rcm_eob_uploads', 'rcm_eob_uploads_failure_code_check', {
    check: `failure_code IS NULL OR failure_code IN (${sqlList(EOB_FAILURE_CODES)})`,
  });

  // ── 3. The review-reason vocabulary gains ocr_low_confidence ─────────────
  //
  // `rcm_claims_review_reasons_check` calls this function by name, so replacing
  // the function is the whole change — the constraint does not need to be
  // dropped and re-added, and dropping it would mean re-validating every claim
  // row for no reason.
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

  // ── 4. Grants ────────────────────────────────────────────────────────────
  // A no-op where the role already holds them (the Slice 1 schema granted this
  // table), and correct where it does not. Same role-guarded mechanism as
  // audit_log and tc_schema: if the least-privilege role is absent — a local
  // superuser database — the grant is SKIPPED with a NOTICE rather than failing
  // the migration.
  pgm.sql(`
    DO $$
    DECLARE
      r text := '${APP_ROLE}';
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE rcm_eob_uploads TO %I', r);
        RAISE NOTICE 'rcm_ocr: CRUD grants re-asserted on rcm_eob_uploads for role %', r;
      ELSE
        RAISE NOTICE 'rcm_ocr: app role % absent — grants SKIPPED (local superuser database).', r;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  // REFUSE rather than leave the database quietly inconsistent.
  //
  // `CREATE OR REPLACE FUNCTION` does not re-validate existing rows, so
  // restoring the narrower `rcm_is_review_reason` over claims that already hold
  // 'ocr_low_confidence' would leave rows the CHECK forbids and nothing would
  // say so until the next UPDATE of an unrelated column failed. The same applies
  // to the failure-code CHECK, which IS validating and would fail with a
  // Postgres error naming one row — this names the count and the query.
  pgm.sql(`
    DO $$
    DECLARE
      n_reasons bigint;
      n_codes bigint;
    BEGIN
      SELECT count(*) INTO n_reasons FROM rcm_claims
       WHERE 'ocr_low_confidence' = ANY (needs_review_reasons);
      SELECT count(*) INTO n_codes FROM rcm_eob_uploads
       WHERE failure_code IN (${sqlList(OCR_ONLY_FAILURE_CODES)});

      IF n_reasons > 0 OR n_codes > 0 THEN
        RAISE EXCEPTION
          'Cannot roll back the OCR slice: % claim(s) carry the ocr_low_confidence review '
          'reason and % upload(s) carry an OCR failure code. Rolling back would leave rows '
          'the restored constraints forbid. Resolve them deliberately first: '
          'SELECT claim_id FROM rcm_claims WHERE ''ocr_low_confidence'' = ANY (needs_review_reasons); '
          'SELECT upload_id FROM rcm_eob_uploads WHERE failure_code IN (${sqlList(
            OCR_ONLY_FAILURE_CODES
          ).replace(/'/g, "''")});',
          n_reasons, n_codes;
      END IF;
    END $$;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION rcm_is_review_reason(reason text)
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $$
      SELECT reason = ANY (${sqlArray(REVIEW_REASONS.filter((r) => r !== 'ocr_low_confidence'))})
          OR reason ~ '^uncertain_line:[1-9][0-9]*$'
    $$;
  `);

  pgm.dropConstraint('rcm_eob_uploads', 'rcm_eob_uploads_failure_code_check');
  pgm.addConstraint('rcm_eob_uploads', 'rcm_eob_uploads_failure_code_check', {
    check: `failure_code IS NULL OR failure_code IN (${sqlList(
      EOB_FAILURE_CODES.filter((c) => !OCR_ONLY_FAILURE_CODES.includes(c))
    )})`,
  });

  pgm.dropConstraint('rcm_eob_uploads', 'rcm_eob_uploads_ocr_provenance_check');
  pgm.dropConstraint('rcm_eob_uploads', 'rcm_eob_uploads_text_source_check');
  pgm.dropColumns('rcm_eob_uploads', ['text_source', 'ocr_page_count', 'ocr_mean_confidence']);
};
