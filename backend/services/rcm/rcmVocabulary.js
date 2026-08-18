'use strict';

/**
 * THE frozen vocabularies for the RCM module (Slice 5.5).
 *
 * Before this file, three vocabularies lived in three places: `eraParser.js`
 * held the ERA review reasons, `eobExtraction.js` pushed EOB ones as string
 * literals at their call sites, and `rcm_claims.needs_review_reasons` had **no
 * CHECK constraint at all** — so either path could have written prose into a
 * column the review UI is supposed to switch on, and nothing would have said so
 * until a biller saw a raw slug in the workbench.
 *
 * Slice 5.5 makes these the single source, and the migration
 * `…_rcm_fidelity.js` mirrors every list below into a DB CHECK. Adding a reason
 * means editing this file AND that migration in the same commit — the
 * `rcmVocabulary.test.js` suite fails if they drift, which is the only thing
 * that keeps "frozen vocabulary" true rather than aspirational.
 *
 * WHY A DB CHECK AND NOT JUST THIS FILE. A constant can be bypassed by the next
 * caller who does not import it. A CHECK constraint cannot. The module's rule is
 * that a defect class ends as a flag in the vocabulary, never a `console.warn` —
 * and a vocabulary the database does not enforce is a warning with extra steps.
 */

// ─── Claim review reasons — rcm_claims.needs_review_reasons ─────────────────

/**
 * Reasons the ERA parser and ingest raise. Each is a fact about the FILE.
 */
const ERA_REVIEW_REASONS = Object.freeze({
  /** CLP02 = 22. A takeback: the negative-supplemental path, irreversible in OD. */
  REVERSAL: 'reversal_not_postable',
  /** CLP02 = 4. Nothing to post; the denial reasons are the product. */
  DENIED: 'claim_denied',
  /** CLP02 = 2/3/20/21, or a prior-payer AMT*D. Coordination of benefits. */
  SECONDARY: 'secondary_payer_adjudication',
  /** AMT*D present on a claim CLP02 calls primary — the file contradicts itself. */
  PRIOR_PAYER_ON_PRIMARY: 'prior_payer_payment_on_primary_claim',
  /** A CAS pair whose reason token cannot be a CARC. Money is unaccounted for. */
  UNPARSEABLE_CAS: 'unparseable_cas',
  /** The payer changed a procedure code. */
  DOWNCODE: 'procedure_downcoded',
  /** The claim carries no service lines at all. */
  NO_SERVICE_LINES: 'no_service_lines',
  /** Line paid amounts do not sum to CLP04. */
  LINE_TOTAL_MISMATCH: 'line_total_mismatch',
  /** An adjustment used a CARC group the schema cannot store. */
  UNSTORABLE_ADJUSTMENT_GROUP: 'unstorable_adjustment_group',

  // ── Slice 5.5 ──
  /**
   * A1. The claim reports adjustments at CLP level (loop 2100) rather than, or
   * as well as, per service line. Not a defect — payers do this routinely — but
   * the review UI must be able to say WHERE the deductible was reported, and
   * before 5.5 those segments were dropped entirely.
   */
  CLAIM_LEVEL_ADJUSTMENTS: 'claim_level_adjustments_present',
  /**
   * A1. Σ(claim-level PR) + Σ(line-level PR) does not equal CLP05. Two stored
   * numbers disagree about what the patient owes; a human picks.
   */
  PATIENT_RESP_MISMATCH: 'patient_resp_mismatch',
  /**
   * A3. A reported AMT*B6 allowed amount and the amount derived from the
   * adjustments disagree beyond tolerance. `write_off_cents` is a number Slice
   * 6c writes into Open Dental, so a disagreement here is money.
   */
  ALLOWED_AMOUNT_MISMATCH: 'allowed_amount_mismatch',
  /**
   * A4. A token where an amount belonged did not validate as a number. Nothing
   * was fabricated in its place.
   */
  UNREADABLE_AMOUNT: 'unreadable_amount',
  /**
   * A5. A repeating CAS/PLB segment was only partly consumed — a gap in the
   * middle, or a pair we could not read. Some of the money in that segment is
   * not represented anywhere.
   */
  PARTIAL_ADJUSTMENT_SEGMENT: 'partial_adjustment_segment',
});

/**
 * Reasons the EOB extraction raises. Each is a fact about the MODEL'S READING,
 * which is why so many of them are about absence and confidence — an 835 either
 * has an NPI or does not, but a model reading a PDF can be unsure.
 */
const EOB_REVIEW_REASONS = Object.freeze({
  LOW_CONFIDENCE: 'low_confidence',
  MISSING_NPI: 'missing_npi',
  MISSING_DOB: 'missing_dob',
  MISSING_CHECK_NUMBER: 'missing_check_number',
  MISSING_SUBSCRIBER_ID: 'missing_subscriber_id',
  MISSING_PAYER: 'missing_payer',
  MISSING_CLAIM_NUMBER: 'missing_claim_number',
  MISSING_PATIENT_NAME: 'missing_patient_name',
  NO_PROCEDURES_EXTRACTED: 'no_procedures_extracted',
  PAID_TOTAL_MISMATCH: 'paid_total_mismatch',
  BILLED_TOTAL_MISMATCH: 'billed_total_mismatch',
  INVALID_SERVICE_DATE: 'invalid_service_date',
  SERVICE_DATE_IN_FUTURE: 'service_date_in_future',
  NEGATIVE_AMOUNT: 'negative_amount',
  NO_CLAIMS_EXTRACTED: 'no_claims_extracted',
  BATCH_PAID_TOTAL_MISMATCH: 'batch_paid_total_mismatch',
});

/**
 * The one PARAMETERISED reason: `uncertain_line:3` points at a printed line.
 *
 * It exists because `rcm_procedure_lines` has no confidence column and its
 * `flags` CHECK has no slot for uncertainty, so the pointer lives on the claim.
 * The DB CHECK therefore cannot be a plain `<@ ARRAY[…]` — see the migration,
 * which validates each element through an IMMUTABLE function instead.
 */
const UNCERTAIN_LINE_PATTERN = /^uncertain_line:[1-9][0-9]*$/;

/** Every fixed review reason, both paths. The migration mirrors this exactly. */
const REVIEW_REASONS = Object.freeze([
  ...Object.values(ERA_REVIEW_REASONS),
  ...Object.values(EOB_REVIEW_REASONS),
]);

/**
 * Is `reason` something either path is allowed to store?
 * @param {unknown} reason
 * @returns {boolean}
 */
function isReviewReason(reason) {
  const value = String(reason == null ? '' : reason);
  return REVIEW_REASONS.includes(value) || UNCERTAIN_LINE_PATTERN.test(value);
}

// ─── Line flags — rcm_procedure_lines.flags ─────────────────────────────────

/**
 * The source's `procedure_flag` enum, plus what 5.5 needed. Kept as an array
 * CHECK (`flags <@ ARRAY[…]`) rather than an enum type, per the Slice 1
 * convention.
 */
const LINE_FLAGS = Object.freeze([
  'downcode',
  'bundled',
  'denied',
  'partial_pay',
  'unexplained_adj',
  'frequency_limit',
  'not_covered',
  'pre_auth_required',
  // ── Slice 5.5 ──
  /** A4. An amount on this line did not validate; no value was invented. */
  'unreadable_amount',
  /** A5. A CAS on this line was only partly consumed. */
  'partial_adjustment_segment',
  /** A3. A reported allowed amount disagrees with the derived one. */
  'allowed_mismatch',
]);

// ─── Remittance flags — rcm_payment_batches.flags ───────────────────────────

/**
 * Facts about a whole check that are not about any one claim.
 *
 * Before 5.5 these were joined into `rcm_payment_batches.notes` as the prose
 * string `"Flagged: a, b"`. Prose in a column the UI must switch on is the same
 * mistake as an unconstrained review reason, one layer up — so they are now a
 * CHECKed `text[]`, and `notes` goes back to being a place for a human to type.
 */
const REMITTANCE_FLAGS = Object.freeze([
  /** PLB present. Provider-level money belonging to no single claim. */
  'plb_adjustments_present',
  /** BPR02 is negative — the whole remittance is a takeback. */
  'negative_total_payment',
  /** BPR04 = NON. The payer says no funds moved. */
  'no_payment_made',
  /** No CLP at all — e.g. a PLB-only file. Nothing to propose. */
  'no_claims_in_remittance',
  /** Claim paid amounts + PLB do not sum to BPR02. */
  'claim_total_mismatch',
  // ── Slice 5.5 ──
  /**
   * B3. SE01 / GE01 / IEA01 disagree with what we actually counted. The most
   * likely cause is a TRUNCATED transmission — a file that still contains a
   * valid BPR and some CLPs, and parses as if complete.
   */
  'envelope_counts_mismatch',
  /** B3. A trailer segment (SE / GE / IEA) is missing outright. */
  'envelope_incomplete',
  /** A5. A repeating PLB segment was only partly consumed. */
  'partial_adjustment_segment',
  /** A4. A token where an amount belonged did not validate. */
  'unreadable_amount',
  /** B4. The file carried more than one ST/SE transaction set. */
  'multi_transaction_file',
]);

// ─── EOB upload failure codes — rcm_eob_uploads.failure_code ────────────────

/**
 * WHY a failed upload failed, as a code rather than by string-matching the
 * message.
 *
 * A6 is the reason this exists: "this document was too long and we refused it"
 * and "this PDF is encrypted" are different conversations with the user, and the
 * panel has to render them differently. `error_message` stays the human
 * sentence; this is what the UI switches on.
 */
const EOB_FAILURE_CODES = Object.freeze([
  /** The PDF is encrypted, corrupt, or otherwise unreadable by pdf-parse. */
  'pdf_unreadable',
  /** No text layer — almost always a scan. (OCR is a separate slice.) */
  'no_extractable_text',
  /**
   * A6. Over MAX_DOCUMENT_CHARS. We refuse rather than storing a knowingly
   * partial proposal, and the message tells the user to split the document.
   */
  'document_too_large',
  /** The model returned something that did not satisfy the extraction schema. */
  'extraction_invalid',
  /** The daily extraction cost cap is spent. */
  'budget_exhausted',
  /** Azure OpenAI is not configured in this environment. */
  'llm_unavailable',
  /** Anything else, with the message carrying what we know. */
  'extraction_failed',
]);

/**
 * How a line's allowed amount was arrived at — `rcm_procedure_lines.allowed_source`.
 *
 * A3. Before 5.5 the allowed amount was ALWAYS derived (`billed − Σ CO`) and
 * nothing recorded that. A payer who takes the contractual reduction under OA or
 * PI, or reports the allowed amount explicitly in AMT*B6, got an inflated
 * allowed and therefore a wrong `write_off_cents` — a number Slice 6c writes
 * into Open Dental.
 */
const ALLOWED_SOURCES = Object.freeze([
  /** Read from AMT*B6 on the service line. */
  'reported',
  /** Computed from billed minus the contractual adjustments. */
  'derived',
]);

/**
 * Where an adjustment was reported — `rcm_procedure_adjustments.scope`.
 *
 * A1. A CAS between the CLP and the first SVC applies to the whole claim. It
 * used to be dropped; now it is stored against the claim with no line, and this
 * column is how the review UI can say "the deductible was reported at claim
 * level, not on a procedure".
 */
const ADJUSTMENT_SCOPES = Object.freeze(['claim', 'line']);

module.exports = {
  ERA_REVIEW_REASONS,
  EOB_REVIEW_REASONS,
  REVIEW_REASONS,
  UNCERTAIN_LINE_PATTERN,
  isReviewReason,
  LINE_FLAGS,
  REMITTANCE_FLAGS,
  EOB_FAILURE_CODES,
  ALLOWED_SOURCES,
  ADJUSTMENT_SCOPES,
};
