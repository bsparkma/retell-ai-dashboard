/**
 * The RCM vocabulary, in words a biller reads.
 *
 * `backend/services/rcm/rcmVocabulary.js` says the vocabulary exists so nobody
 * ever sees a raw slug. That promise is only kept HERE — a reason with no entry
 * in these maps renders as `partial_adjustment_segment`, and it renders that way
 * on a proposal it is also BLOCKING, so the biller is stopped by a string they
 * cannot read.
 *
 * Slice 5.5 shipped ten new vocabulary members without touching this file and
 * did exactly that. `rcm-labels.test.ts` now reads the backend vocabulary and
 * fails if any member is unlabelled, so the two cannot drift again.
 *
 * Shared by the ERA upload panel and the Slice 6 workbench: one wording for one
 * concept, wherever a biller meets it.
 */

/**
 * Claim-level review reasons — `rcm_claims.needs_review_reasons`.
 *
 * Both ingestion doors write into this column, so both vocabularies are here.
 * The wording says what a HUMAN must do or know, not what the parser noticed.
 */
export const REVIEW_LABELS: Record<string, string> = {
  // ── ERA (the 835 parser and ingest) ──
  reversal_not_postable: "Reversal / takeback — cannot be posted",
  claim_denied: "Denied by the carrier",
  secondary_payer_adjudication: "Secondary payer (coordination of benefits)",
  prior_payer_payment_on_primary_claim: "Prior payer's payment on a claim marked primary",
  unparseable_cas: "An adjustment could not be read",
  unstorable_adjustment_group: "An adjustment used an unknown group code",
  procedure_downcoded: "The carrier changed a procedure code",
  no_service_lines: "No service lines",
  line_total_mismatch: "Line payments do not sum to the claim total",
  claim_level_adjustments_present: "Deductible or coinsurance was reported for the whole claim, not per procedure",
  patient_resp_mismatch: "The patient responsibility on the lines does not match the claim total",
  allowed_amount_mismatch: "The carrier's stated allowed amount disagrees with its own adjustments",
  unreadable_amount: "An amount on this claim could not be read",
  partial_adjustment_segment: "Part of an adjustment could not be read — some money is unaccounted for",
  claim_line_allowed_mismatch: "The claim's allowed total does not match the sum of its lines",
  totals_unreconciled: "Totals could not be reconciled — check every amount before posting",

  // ── EOB (the PDF extraction) ──
  low_confidence: "The reader was not confident about this document",
  missing_npi: "No provider NPI was found",
  missing_dob: "No date of birth was found",
  missing_check_number: "No check number was found",
  missing_subscriber_id: "No subscriber ID was found",
  missing_payer: "No payer was found",
  missing_claim_number: "No claim number was found",
  missing_patient_name: "No patient name was found",
  no_procedures_extracted: "No procedures were read from this claim",
  paid_total_mismatch: "The procedure payments do not sum to the claim total",
  billed_total_mismatch: "The procedure charges do not sum to the claim total",
  invalid_service_date: "The service date could not be read",
  service_date_in_future: "The service date is in the future",
  negative_amount: "A negative amount was read — most often a misread column",
  no_claims_extracted: "No claims were read from this document",
  batch_paid_total_mismatch: "The claim payments do not sum to the check total",

  // ── OCR ──
  // Says what the biller must DO, not what the reader noticed: check the amounts
  // against the document, which is the one action this reason implies.
  ocr_low_confidence:
    "This document was scanned — check the amounts against the image before approving",
};

/**
 * Remittance-level flags — `rcm_payment_batches.flags`.
 *
 * Facts about a whole check. Written by BOTH doors since Slice 5.5: an EOB
 * extraction reaches the ones it can establish, an 835 reaches all of them.
 */
export const FLAG_LABELS: Record<string, string> = {
  plb_adjustments_present: "Provider-level adjustments (PLB) — not attached to any claim",
  negative_total_payment: "Negative total — this remittance is a takeback",
  no_payment_made: "The payer reports no payment made",
  no_claims_in_remittance: "No claims in this remittance",
  claim_total_mismatch: "Claim payments do not sum to the check total",
  envelope_counts_mismatch: "The file disagrees with its own segment counts — it may be truncated",
  envelope_incomplete: "The file is missing a closing segment — it may be truncated",
  partial_adjustment_segment: "Part of a provider-level adjustment could not be read",
  unreadable_amount: "An amount on this remittance could not be read",
  multi_transaction_file: "This file contained more than one check",
};

/**
 * Why an EOB upload failed — `rcm_eob_uploads.failure_code`.
 *
 * `error_message` already carries the server's own sentence, which is usually
 * the better thing to show. These are the short forms for a chip or a heading.
 */
export const FAILURE_LABELS: Record<string, string> = {
  pdf_unreadable: "This PDF could not be opened",
  no_extractable_text: "This PDF has no text layer — most likely a scan",
  document_too_large: "This document is too long to read in one pass",
  extraction_invalid: "The reader returned an unusable answer",
  budget_exhausted: "The daily extraction cost cap is used up",
  llm_unavailable: "Document reading is not configured in this environment",
  extraction_failed: "Extraction failed",
  // ── OCR ──
  // Three codes rather than one because they are three different conversations:
  // rescan the paper, try again later, or wait for the cap to reset.
  ocr_unreadable: "This scan is too faint or too low-resolution to read",
  ocr_failed: "The document reader could not open this file",
  ocr_budget_exhausted: "The daily cap for reading scanned documents is used up",
};


/**
 * Line flags — `rcm_procedure_lines.flags`.
 *
 * The workbench had its own copy of this in `format.ts`, three flags out of
 * date since Slice 5.5. One map, here, beside the others.
 */
export const LINE_FLAG_LABELS: Record<string, string> = {
  downcode: "Downcoded",
  bundled: "Bundled",
  denied: "Denied",
  partial_pay: "Partial payment",
  unexplained_adj: "Unexplained adjustment",
  frequency_limit: "Frequency limit",
  not_covered: "Not covered",
  pre_auth_required: "Pre-auth required",
  // ── Slice 5.5 ──
  unreadable_amount: "An amount on this line could not be read",
  partial_adjustment_segment: "Part of an adjustment on this line could not be read",
  allowed_mismatch: "The stated allowed amount disagrees with the adjustments",
};

/**
 * D-11: which reasons BLOCK an approval, and which merely annotate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A MIRROR, AND THE TEST IS WHAT MAKES IT ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * The authority is `backend/services/rcm/rcmVocabulary.js` REASON_GATE, and the
 * gate that actually withholds a claim reads it there. This copy exists so a
 * chip can be coloured without a round trip, and `rcm-labels.test.ts` reads the
 * backend source and fails if the two disagree about a single slug.
 *
 * A screen showing a reason in amber while the gate lets it through — or the
 * reverse — is the honest-states rule failing in the most expensive place there
 * is, so "these must not drift" is enforced rather than hoped for.
 *
 * FAIL CLOSED, like the backend: anything not named here reads as blocking.
 */
export const REASON_GATE: Record<string, "blocking" | "annotating"> = {
  // ── ERA claim review reasons ──
  reversal_not_postable: "blocking",
  claim_denied: "annotating",
  secondary_payer_adjudication: "blocking",
  prior_payer_payment_on_primary_claim: "blocking",
  unparseable_cas: "blocking",
  procedure_downcoded: "annotating",
  no_service_lines: "blocking",
  line_total_mismatch: "blocking",
  unstorable_adjustment_group: "blocking",
  claim_level_adjustments_present: "annotating",
  patient_resp_mismatch: "blocking",
  allowed_amount_mismatch: "annotating",
  unreadable_amount: "blocking",
  partial_adjustment_segment: "blocking",
  claim_line_allowed_mismatch: "blocking",
  totals_unreconciled: "blocking",

  // ── EOB claim review reasons ──
  low_confidence: "blocking",
  missing_npi: "annotating",
  missing_dob: "annotating",
  missing_check_number: "annotating",
  missing_subscriber_id: "annotating",
  missing_payer: "annotating",
  missing_claim_number: "annotating",
  missing_patient_name: "annotating",
  no_procedures_extracted: "blocking",
  paid_total_mismatch: "blocking",
  billed_total_mismatch: "blocking",
  invalid_service_date: "annotating",
  service_date_in_future: "annotating",
  negative_amount: "blocking",
  no_claims_extracted: "blocking",
  batch_paid_total_mismatch: "blocking",
  // Annotating: a fact about how confidently the document was READ, not a claim
  // that any stored amount is wrong. The arithmetic checks above are the ones
  // that catch a misreading which actually moved a number, and they all block.
  ocr_low_confidence: "annotating",

  // ── Remittance flags ──
  plb_adjustments_present: "annotating",
  negative_total_payment: "blocking",
  no_payment_made: "annotating",
  no_claims_in_remittance: "blocking",
  claim_total_mismatch: "blocking",
  envelope_counts_mismatch: "blocking",
  envelope_incomplete: "blocking",
  multi_transaction_file: "annotating",

  // ── Line flags ──
  downcode: "annotating",
  bundled: "annotating",
  denied: "annotating",
  partial_pay: "annotating",
  unexplained_adj: "annotating",
  frequency_limit: "annotating",
  not_covered: "annotating",
  pre_auth_required: "annotating",
  allowed_mismatch: "annotating",
};

/**
 * Does this reason stop a claim being approved?
 *
 * FAIL CLOSED — anything not in the map reads as BLOCKING, exactly as the
 * backend's `isBlockingReason` does.
 *
 * This was a Set of blocking reasons first, which failed OPEN: an unmapped slug
 * came back `false` and would have rendered a grey chip beside a claim the gate
 * silently withheld — a screen quietly disagreeing with the server about what
 * stops a posting. The mirror test caught it on its first run, which is the
 * argument for having written it.
 *
 * `uncertain_line:<N>` is handled explicitly: the parameterised reason can never
 * live in a lookup, and reaching the fail-closed branch for it would be an
 * accident that happened to be right.
 */
export function isBlockingReason(reason: string): boolean {
  if (/^uncertain_line:[1-9][0-9]*$/.test(reason)) return true;
  return REASON_GATE[reason] !== "annotating";
}

/**
 * Chip colours for a review reason or a remittance flag.
 *
 * AMBER means this will withhold the claim; GREY means it is true and does not
 * change what to post. BOTH ARE ALWAYS SHOWN — the split decides the weight, it
 * never decides visibility. A reason that vanished would make a proposal look
 * cleaner than it is, which is the failure the whole vocabulary exists to
 * prevent.
 */
export function reasonTone(reason: string): string {
  return isBlockingReason(reason)
    ? "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
    : "bg-muted text-muted-foreground";
}
/**
 * A vocabulary member in words, falling back to the slug.
 *
 * The fallback is deliberate and stays: an unmapped value must render as an
 * ugly string rather than vanish, because a review reason that disappears is a
 * proposal that looks cleaner than it is. The test is what keeps the fallback
 * from ever being reached in practice.
 */
export function label(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

/**
 * `uncertain_line:3` → "Line 3 was read with low confidence".
 *
 * The one PARAMETERISED reason, so it cannot live in a lookup table.
 */
export function reviewLabel(reason: string): string {
  const uncertain = /^uncertain_line:([1-9][0-9]*)$/.exec(reason);
  if (uncertain) return `Line ${uncertain[1]} was read with low confidence`;
  return label(REVIEW_LABELS, reason);
}

/**
 * "Read from the PDF text layer" / "Read by OCR (3 pages, 94% confidence)".
 *
 * ONE WORDING, THREE SCREENS. The remittance detail, the claim detail and the
 * upload panel all answer the same question, and a biller who saw it phrased
 * three ways would reasonably wonder whether they meant three different things.
 *
 * Returns null when the provenance is unknown — an 835 (parsed, never read) or
 * anything extracted before the OCR slice. The caller renders NOTHING in that
 * case. Filling the gap with "text layer" would be the screen asserting
 * something nobody recorded, which is the failure this whole field exists to
 * prevent.
 */
export function provenanceLabel(
  provenance: {
    textSource: "text_layer" | "ocr" | null;
    ocrPageCount: number | null;
    ocrMeanConfidence: number | null;
  } | null,
): string | null {
  if (!provenance || !provenance.textSource) return null;
  if (provenance.textSource === "text_layer") return "Read from the PDF text layer";

  const pages =
    provenance.ocrPageCount == null
      ? null
      : `${provenance.ocrPageCount} page${provenance.ocrPageCount === 1 ? "" : "s"}`;
  // "confidence not reported" rather than a number we do not have. A 100% badge
  // on a document nobody measured is worse than an admission.
  const confidence =
    provenance.ocrMeanConfidence == null
      ? "confidence not reported"
      : `${Math.round(provenance.ocrMeanConfidence * 100)}% confidence`;
  const detail = [pages, confidence].filter(Boolean).join(", ");
  return `Read by OCR (${detail})`;
}

/**
 * The one-line reason a reader should care, shown beside the label above.
 *
 * Only on the OCR path: a text layer is exact, and saying so at length would
 * make the ordinary case look like it needed explaining.
 */
export function provenanceNote(
  provenance: { textSource: "text_layer" | "ocr" | null } | null,
): string | null {
  if (!provenance || provenance.textSource !== "ocr") return null;
  return "These figures were read off a page image, not parsed from the file.";
}
