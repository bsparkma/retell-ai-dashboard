'use strict';

/**
 * FIELD CONFIRM — the review step for a scanned EOB.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The first real scanned EOB was a category-subtotal layout: it stated payment
 * ONLY at benefit-type subtotals, never per line. The read promoted each line's
 * COVERED amount into PAID, and one line rendered a fabricated $1,229.00 paid —
 * a number that was nowhere on the page, and one that understated what the
 * patient owed. Claim-level totals were read correctly, the existing non-summing
 * warnings fired, and approve was blocked. So no money moved: the refusal
 * worked. The numbers on screen were still wrong.
 *
 * A refusal is not the same as a correct read. This migration carries the
 * storage for the step that makes an OCR-sourced read into something a person
 * has actually checked against the page.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE CHANGES, AND WHY THEY ARE ONE MIGRATION
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. `rcm_procedure_lines.paid_cents` becomes NULLABLE, so "this document
 *      states no payment for this line" is storable at all.
 *   2. `rcm_eob_field_confirmations` — what a human confirmed or corrected,
 *      BESIDE the extraction, never over it.
 *   3. The review-reason vocabulary gains `line_paid_not_stated`.
 *
 * They ship together because (1) without (3) turns a silent zero into a silent
 * null, and (1) without (2) leaves a figure nobody can supply. Splitting them
 * would put a deploy window between "the read stops inventing numbers" and
 * "a person can say what the number is", and in that window a scanned EOB is
 * less useful than it was before.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXTRACTION IS IMMUTABLE. THIS TABLE IS BESIDE IT.
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing here updates `rcm_procedure_lines`, `rcm_claims` or
 * `rcm_claims.raw_extracted_json`. A confirmation is a SECOND opinion recorded
 * next to the first, and `extracted_cents` on every row pins what the read said
 * at the moment a person disagreed with it — so "what did the machine think"
 * survives even if the extraction rows were later re-written by a re-upload.
 *
 * Downstream readers do not join these two by hand. They go through
 * `services/rcm/confirmedFigures.js`, which is the only thing in the codebase
 * that decides confirmed-else-extracted, so no two screens can disagree about
 * which number is real.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO OPEN DENTAL ANYTHING
 * ─────────────────────────────────────────────────────────────────────────────
 * This slice writes nothing to a chart and calls no OD endpoint. Confirming a
 * figure is a statement about what the paper says, not an instruction to post.
 */

/** Frozen internal office keys — matches every other RCM table. */
const OFFICE_CHECK = "office_id IN ('roland', 'valley')";

/**
 * Mirrors `rcmVocabulary.REVIEW_REASONS`, IN FULL.
 *
 * The whole list rather than a delta, because `rcm_is_review_reason` is replaced
 * wholesale by `CREATE OR REPLACE` — and because `rcmVocabulary.test.js` reads
 * the LAST migration that declares `const REVIEW_REASONS = [...]` and compares
 * it against the code. A delta here would make that test compare the code
 * against a fragment and pass over a real drift.
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
  // Field confirm — the LAYOUT, not the reading and not the file
  'line_paid_not_stated',
];

/**
 * Mirrors `rcmVocabulary.CONFIRMABLE_FIELDS`, in full.
 *
 * Slugs, frozen: these are machine values and the constitution freezes them.
 * New members are additive only. Each one names a money field a person can
 * confirm against the page image, and the scope it belongs to is implied by the
 * prefix — `check_`, `claim_`, `line_` — which is also what the CHECK below
 * uses to refuse a row whose scope columns do not match its field.
 */
const CONFIRMABLE_FIELDS = [
  'check_total',
  'claim_total_paid',
  'line_paid',
  'line_billed',
  'line_allowed',
  'line_deductible',
  'line_copay',
];

/** What a row records: a figure agreed with, or one typed from the page. */
const CONFIRM_STATES = ['confirmed', 'corrected'];

/** `'a','b'` */
function sqlList(values) {
  return values.map((v) => `'${v}'`).join(',');
}

/** `ARRAY['a','b']::text[]` */
function sqlArray(values) {
  return `ARRAY[${sqlList(values)}]::text[]`;
}

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ── 1. A per-line payment can be UNSTATED ─────────────────────────────────
  //
  // NOT NULL DEFAULT 0 left no way to store "the document does not say". Zero
  // asserts the plan paid nothing for this line, which is a claim about a
  // patient's balance; null says nobody printed it. Those are different facts.
  //
  // The DEFAULT 0 STAYS. The ERA path always supplies a per-line payment — an
  // 835 states one by construction — and `eraIngest` inserts explicitly, so the
  // default only serves a caller that omits the column entirely. Dropping it
  // would turn such a caller's row into a null that means "unstated" when it
  // really means "not supplied", which is the ambiguity this whole slice is
  // about.
  pgm.alterColumn('rcm_procedure_lines', 'paid_cents', { notNull: false });

  // ── 2. What a person confirmed, beside what the machine read ──────────────
  //
  // PHI: `extracted_cents` and `confirmed_cents` are amounts on a patient's
  // claim, and the row points at a claim. Treated as PHI throughout.
  pgm.createTable('rcm_eob_field_confirmations', {
    confirmation_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    /*
     * THE CHECK IS THE ANCHOR, so the batch is the row's home.
     *
     * A confirmation belongs to the remittance being reviewed even when the
     * field it names is a line on a claim, because the thing being established
     * is "this check has been read correctly" and the gate asks that question of
     * the batch. It also means the whole confirm state for a check is one
     * indexed read.
     */
    batch_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_payment_batches',
      onDelete: 'CASCADE',
    },
    /** NULL for a check-level field. */
    claim_id: { type: 'uuid', references: 'rcm_claims', onDelete: 'CASCADE' },
    /** NULL for a check-level or claim-level field. */
    line_id: { type: 'uuid', references: 'rcm_procedure_lines', onDelete: 'CASCADE' },
    field: { type: 'text', notNull: true },
    state: { type: 'text', notNull: true },
    /**
     * WHAT THE READ SAID, pinned at the moment a person looked at it.
     *
     * NULL is meaningful: it records that the extraction stated nothing for this
     * field, which is the category-subtotal case. So "the machine said nothing
     * and a person typed 0" and "the machine said 0 and a person agreed" are
     * distinguishable rows, and they are different stories about the same money.
     *
     * Pinned rather than looked up, because a re-upload rewrites the extraction
     * rows and this column is the only place the original survives.
     */
    extracted_cents: { type: 'bigint' },
    /**
     * WHAT THE PERSON SAYS IT IS.
     *
     * NULL means a person looked at the page and confirmed that the document
     * genuinely does not state this figure. That is a real answer and the gate
     * accepts it: a category-subtotal EOB has no per-line payment to type, and
     * demanding a number would force an invention — the exact failure this slice
     * exists to stop.
     */
    confirmed_cents: { type: 'bigint' },
    /** D-5 crosswalk key. NOT NULL: a confirmation with no author is not one. */
    confirmed_by: {
      type: 'text',
      notNull: true,
      references: 'rcm_user_map',
      onDelete: 'RESTRICT',
    },
    confirmed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('rcm_eob_field_confirmations', 'rcm_eob_field_confirmations_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_eob_field_confirmations', 'rcm_eob_field_confirmations_field_check', {
    check: `field IN (${sqlList(CONFIRMABLE_FIELDS)})`,
  });
  pgm.addConstraint('rcm_eob_field_confirmations', 'rcm_eob_field_confirmations_state_check', {
    check: `state IN (${sqlList(CONFIRM_STATES)})`,
  });

  /*
   * THE SCOPE COLUMNS MUST MATCH THE FIELD.
   *
   * Without this, `('check_total', claim_id: <some claim>)` is storable, and the
   * accessor would then have to decide which of two plausible readings it meant.
   * A row that cannot be interpreted one way is worse than a rejected INSERT,
   * because it is permanent and it concerns money.
   */
  pgm.addConstraint('rcm_eob_field_confirmations', 'rcm_eob_field_confirmations_scope_check', {
    check: `
      (field = 'check_total'      AND claim_id IS NULL     AND line_id IS NULL)
      OR (field LIKE 'claim\\_%'  AND claim_id IS NOT NULL AND line_id IS NULL)
      OR (field LIKE 'line\\_%'   AND claim_id IS NOT NULL AND line_id IS NOT NULL)
    `,
  });

  /*
   * A CORRECTION MUST CHANGE SOMETHING, AND A CONFIRMATION MUST NOT.
   *
   * `state` is not decoration — the screen renders "corrected by <name> from the
   * page image" off it, and the gate counts confirmations. A 'corrected' row
   * whose confirmed value equals the extracted one would put that sentence under
   * a figure nobody changed; a 'confirmed' row that differs would hide a
   * correction from the person reading the trail.
   *
   * `IS DISTINCT FROM` rather than `<>`, so a null on either side compares the
   * way the rest of this table treats null: as a value, not as unknown.
   */
  pgm.addConstraint('rcm_eob_field_confirmations', 'rcm_eob_field_confirmations_state_agrees_check', {
    check: `
      (state = 'confirmed' AND confirmed_cents IS NOT DISTINCT FROM extracted_cents)
      OR (state = 'corrected' AND confirmed_cents IS DISTINCT FROM extracted_cents)
    `,
  });

  /*
   * ONE CURRENT ANSWER PER FIELD.
   *
   * NULLS NOT DISTINCT is load-bearing (PG15+). Under the default NULLS
   * DISTINCT, `(batch, NULL, NULL, 'check_total')` does not conflict with
   * itself, so every confirmation of the check total would insert a new row and
   * the accessor would be reading one of N answers arbitrarily.
   *
   * The table holds CURRENT state and is upserted. History is `audit_log`, which
   * is append-only by grant and already the tenant's durable trail — a second
   * history here would be a second thing to keep honest.
   */
  pgm.sql(`
    CREATE UNIQUE INDEX rcm_eob_field_confirmations_scope_field_unique
      ON rcm_eob_field_confirmations (office_id, batch_id, claim_id, line_id, field)
      NULLS NOT DISTINCT
  `);

  /** The gate's read: every confirmation on this check, in one index scan. */
  pgm.createIndex('rcm_eob_field_confirmations', ['office_id', 'batch_id'], {
    name: 'rcm_eob_field_confirmations_office_batch_idx',
  });

  // ── 3. The review-reason vocabulary gains line_paid_not_stated ────────────
  //
  // `rcm_claims_review_reasons_check` calls this function by name, so replacing
  // the function is the whole change. The constraint is not dropped and re-added
  // — doing so would re-validate every existing claim row for nothing.
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

  // ── 4. Grants ─────────────────────────────────────────────────────────────
  // Same role-guarded mechanism as audit_log, tc_schema and rcm_ocr: if the
  // least-privilege role is absent — a local superuser database — the grant is
  // SKIPPED with a NOTICE rather than failing the migration.
  //
  // No DELETE. A confirmation is never withdrawn, only superseded by an upsert
  // of the same scope+field, so the role has no reason to hold it. The
  // ON DELETE CASCADE from the batch is enforced by the referential action, not
  // by the app role's privileges.
  pgm.sql(`
    DO $$
    DECLARE
      r text := '${APP_ROLE}';
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE rcm_eob_field_confirmations TO %I', r);
        RAISE NOTICE 'rcm_eob_field_confirm: grants applied on rcm_eob_field_confirmations for role %', r;
      ELSE
        RAISE NOTICE 'rcm_eob_field_confirm: app role % absent — grants SKIPPED (local superuser database).', r;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('rcm_eob_field_confirmations');

  /*
   * THE VOCABULARY NARROWS BACK, AND THAT CAN FAIL — deliberately.
   *
   * Restoring the narrower `rcm_is_review_reason` over claims that already carry
   * `line_paid_not_stated` would leave rows violating a CHECK that Postgres will
   * not re-validate on a function replacement. So this refuses instead of
   * quietly creating an inconsistent database, the same way the OCR migration's
   * down() does.
   */
  pgm.sql(`
    DO $$
    DECLARE
      offending bigint;
    BEGIN
      SELECT count(*) INTO offending
        FROM rcm_claims
       WHERE 'line_paid_not_stated' = ANY (needs_review_reasons);
      IF offending > 0 THEN
        RAISE EXCEPTION
          'refusing to narrow rcm_is_review_reason: % claim(s) carry line_paid_not_stated. Clear them first.',
          offending;
      END IF;
    END $$;
  `);

  const WITHOUT_FIELD_CONFIRM = REVIEW_REASONS.filter((r) => r !== 'line_paid_not_stated');
  pgm.sql(`
    CREATE OR REPLACE FUNCTION rcm_is_review_reason(reason text)
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $$
      SELECT reason = ANY (${sqlArray(WITHOUT_FIELD_CONFIRM)})
          OR reason ~ '^uncertain_line:[1-9][0-9]*$'
    $$;
  `);

  /*
   * REFUSE to restore NOT NULL over rows that legitimately hold null, for the
   * same reason: a scanned EOB read after this migration may carry unstated
   * per-line payments, and `SET NOT NULL` would either fail opaquely mid-way or
   * — worse, if somebody "fixed" it with a COALESCE — turn every one of them
   * into a $0.00 payment that nobody printed.
   */
  pgm.sql(`
    DO $$
    DECLARE
      offending bigint;
    BEGIN
      SELECT count(*) INTO offending FROM rcm_procedure_lines WHERE paid_cents IS NULL;
      IF offending > 0 THEN
        RAISE EXCEPTION
          'refusing to restore NOT NULL on rcm_procedure_lines.paid_cents: % line(s) have an unstated payment.',
          offending;
      END IF;
    END $$;
  `);
  pgm.alterColumn('rcm_procedure_lines', 'paid_cents', { notNull: true });
};
