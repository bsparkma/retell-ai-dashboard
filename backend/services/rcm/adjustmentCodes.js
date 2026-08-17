'use strict';

/**
 * CARC / RARC / adjustment-group vocabularies — the plain-English layer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * Open Dental's `ClaimAdjReasonCodes` is returned on GET and **absent from
 * PUT** (docs/RCM_OD_WRITES.md G3): denial and adjustment reason codes are
 * read-only over the API, and 0 of 100 sampled Received claimprocs on Roland
 * carried one. Structured denial reasons therefore exist ONLY in our schema
 * (docs/RCM_SCHEMA.md §6), which makes rendering them legibly not a nicety but
 * the product.
 *
 * `rcm_procedure_adjustments` stores `reason_code` (CARC) and `remark_code`
 * (RARC) as typed columns with paired `*_description` text. The ERA parser
 * fills the CARC description from this table at parse time; RARC descriptions
 * had **no source of data at all** before this file (parser deviation D9 reads
 * the LQ*HE code, but there was nothing to look it up in), so every
 * `remark_description` written by Slice 5 is the empty string. The workbench
 * therefore resolves descriptions at RENDER time from here rather than trusting
 * the stored text — a row imported before a code was in the table still reads
 * correctly, and a stored description always wins if it is non-empty, so a
 * payer's own wording is never overwritten by ours.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS DATA, NOT FREE TEXT
 * ─────────────────────────────────────────────────────────────────────────────
 * Every string below is the published X12/WPC meaning of a code, abbreviated to
 * fit a chip. Nothing here is invented, and an unknown code renders as the code
 * itself — never as a guess. `describeCarc('9999')` returns null, and the UI
 * shows `CO-9999` with no gloss, because a fabricated description in front of
 * billing staff is exactly the failure the parser's D5 ruling refused to make
 * at parse time. It would be no better made at render time.
 *
 * The CARC map is the one the ERA parser has always used (including its D10
 * correction: 97 is the bundling text, not "Benefit maximum reached", which is
 * 119) — moved here so there is one table rather than two, and extended with
 * the codes a dental remittance actually carries. `eraParser.js` requires its
 * map from this module and re-exports it, so existing callers are unaffected.
 */

/**
 * CARC — Claim Adjustment Reason Codes.
 *
 * Numeric keys are JS string keys ('1', '45'); alphanumeric ones (B15) are
 * their own. Look up through describeCarc(), which normalizes.
 */
const CARC_DESCRIPTIONS = Object.freeze({
  1: 'Deductible amount',
  2: 'Coinsurance amount',
  3: 'Copayment amount',
  4: 'Procedure code inconsistent with modifier',
  5: 'Procedure code/modifier combination invalid',
  6: 'Procedure/revenue code inconsistent with the patient age',
  9: 'Diagnosis inconsistent with the patient age',
  11: 'Diagnosis inconsistent with the procedure',
  15: 'Authorization number missing, invalid, or does not apply',
  16: 'Claim lacks information for adjudication',
  18: 'Duplicate claim/service',
  19: 'Work-related injury — liability of the workers compensation carrier',
  20: 'Injury covered by the liability carrier',
  22: 'Reimbursement adjusted - care already paid',
  23: 'Impact of prior payer adjudication',
  24: 'Charges are covered under capitation',
  26: 'Expenses incurred prior to coverage',
  27: 'Expenses incurred after coverage terminated',
  29: 'Time limit for filing has expired',
  31: 'Patient cannot be identified as our insured',
  32: 'Patient is not an eligible dependent',
  33: 'Insured has no dependent coverage',
  35: 'Lifetime benefit maximum has been reached',
  39: 'Services denied at the time authorization was requested',
  40: 'Charges do not meet qualifications for emergent/urgent care',
  45: 'Charge exceeds fee schedule/maximum allowable',
  49: 'Not covered unless emergency',
  50: 'Non-covered service',
  51: 'Services delivered to patient in different location',
  54: 'Procedure not separately payable',
  55: 'Procedure is experimental/investigational',
  58: 'Treatment was deemed by the payer to have been rendered in an inappropriate setting',
  59: 'Processed based on multiple procedure rules',
  95: 'Plan procedures not followed',
  96: 'Non-covered charge',
  // D10 (parser): the source table said "Benefit maximum reached" here, which
  // is CARC 119. That string lands in front of billing staff, so it matters.
  97: 'Payment is included in the allowance for another service',
  109: 'Claim not covered by this payer/contractor',
  119: 'Benefit maximum reached for this time period',
  122: 'Psychiatric reduction',
  125: 'Submission/billing error',
  140: 'Patient/insured health identification number and name do not match',
  151: 'Payment adjusted - automatic pre-payment review',
  167: 'Diagnosis is not covered',
  169: 'Alternate benefit has been provided',
  170: 'Payment denied when performed by this type of provider',
  177: 'Patient has not met the required eligibility requirements',
  181: 'Procedure code was invalid on the date of service',
  185: 'The rendering provider is not eligible to perform the service billed',
  187: 'Consumer spending account payment',
  192: 'Non-standard adjustment code from paper remittance',
  197: 'Precertification/authorization absent',
  204: 'Service not covered under the patient current benefit plan',
  234: 'Additional patient information required',
  242: 'Services not provided by network/primary care providers',
  243: 'Services not authorized by network/primary care providers',
  251: 'The attachment/document content received did not support this claim',
  252: 'An attachment/other documentation is required to adjudicate',
  253: 'Sequestration - reduction in federal payment',
  256: 'Service not payable per managed care contract',
  B7: 'Provider was not certified/eligible to be paid for this procedure on this date',
  B9: 'Patient is enrolled in a hospice',
  B13: 'Previously paid — payment for this claim/service may have been provided in a previous payment',
  B15: 'Procedure has been combined with another procedure',
  B16: 'New patient qualifications not met',
  P12: 'Workers compensation jurisdictional fee schedule adjustment',
});

/**
 * RARC — Remittance Advice Remark Codes, read from `LQ*HE` (parser D9).
 *
 * Before this table there was nowhere to resolve one, so every
 * `rcm_procedure_adjustments.remark_description` written by Slice 5 is `''`.
 * Rendering resolves them from here.
 */
const RARC_DESCRIPTIONS = Object.freeze({
  M15: 'Separately billed services/tests have been bundled — they cannot be paid separately',
  M20: 'Missing/incomplete/invalid HCPCS',
  M39: 'The patient is not liable for the charge for this service',
  M53: 'Missing/incomplete/invalid days or units of service',
  M54: 'Missing/incomplete/invalid total charge',
  M76: 'Missing/incomplete/invalid diagnosis or condition',
  M80: 'Not covered when performed during the same session/date as a previously processed service',
  M86: 'Service denied because payment already made for a same/similar service within a set time frame',
  M97: 'Not paid separately when the patient is an inpatient',
  M115: 'This item is denied when provided to this patient by a non-contract supplier',
  M119: 'Missing/incomplete/invalid national drug code',
  M127: 'Missing patient medical record for this service',
  MA01: 'If you do not agree with what was approved, you may appeal this decision',
  MA04: 'Secondary payment cannot be considered without the primary payer information',
  MA13: 'Alert: you may be subject to penalties if you bill the patient for amounts not reported with this code',
  MA15: 'Alert: your claim has been separated to expedite handling',
  MA27: 'Missing/incomplete/invalid entitlement number or name shown on the claim',
  MA61: 'Missing/incomplete/invalid social security number or health insurance claim number',
  MA83: 'Did not indicate whether this payer is the primary or secondary payer',
  MA130: 'Your claim contains incomplete and/or invalid information — no appeal rights',
  N4: 'Missing/incomplete/invalid prior insurance carrier EOB',
  N19: 'Procedure code incidental to primary procedure',
  N20: 'Service not payable with other service rendered on the same date',
  N30: 'Patient ineligible for this service',
  N54: 'Claim information is inconsistent with pre-certified/authorized services',
  N56: 'Procedure code billed is not correct/valid for the services billed or the date of service billed',
  N61: 'Rebill services on separate claims',
  N95: 'This provider type/provider specialty may not bill this service',
  N115: 'This decision was based on a local coverage determination',
  N130: 'Consult plan benefit documents/guidelines for information about restrictions',
  N178: 'Missing pre-operative photos or visual field results',
  N179: 'Additional information has been requested from the member',
  N192: 'Patient is a Medicaid/Qualified Medicare Beneficiary',
  N193: 'Alert: specific federal/state/local program may cover this service',
  N290: 'Missing/incomplete/invalid rendering provider primary identifier',
  N362: 'The number of days or units of service exceeds our acceptable maximum',
  N381: 'Consult our contractual agreement for restrictions/billing/payment information',
  N386: 'This decision was based on a national coverage determination',
  N418: 'Misrouted claim — see the payer contact information',
  N517: 'Resubmit a new claim with the requested information',
  N522: 'Duplicate of a claim processed or in process as a crossover/coordination of benefits claim',
  N657: 'This should be billed with the appropriate code for these services',
  N674: 'Not covered unless a pre-authorization is approved',
  N702: 'Decision based on review of previously adjudicated claims or claims identified as related',
});

/**
 * CARC group codes — WHO the money moved to, which is the single most
 * consequential field on an adjustment and the one most often skimmed past.
 *
 * The distinction that matters for posting: CO is a contractual write-off the
 * practice absorbs, PR is money the PATIENT owes and must be billed for.
 * Rendering "CO" and "PR" as bare two-letter codes invites reading one as the
 * other.
 */
const GROUP_DESCRIPTIONS = Object.freeze({
  CO: 'Contractual obligation — the practice writes this off, the patient is not billed',
  PR: 'Patient responsibility — the patient owes this',
  OA: 'Other adjustment',
  PI: 'Payer initiated reduction — the patient is not billed',
  CR: 'Correction or reversal of a prior decision',
});

/** Short labels for a chip, where the full sentence will not fit. */
const GROUP_LABELS = Object.freeze({
  CO: 'Contractual',
  PR: 'Patient resp.',
  OA: 'Other',
  PI: 'Payer initiated',
  CR: 'Correction',
});

/**
 * Normalize a code token for lookup: trim, uppercase. Nothing else — a token
 * that needs more than that to match is not the code it claims to be, and
 * coercing it would be the invention this module refuses to make.
 * @param {unknown} code
 * @returns {string}
 */
function normalize(code) {
  return typeof code === 'string' || typeof code === 'number'
    ? String(code).trim().toUpperCase()
    : '';
}

/**
 * The published meaning of a CARC, or null if we do not know it.
 *
 * Null is a real answer. The caller renders the bare code, which is honest and
 * still actionable — a biller can look up a code they do not recognize; they
 * cannot un-read a description we made up.
 *
 * @param {unknown} code
 * @returns {string|null}
 */
function describeCarc(code) {
  const key = normalize(code);
  return (key && CARC_DESCRIPTIONS[key]) || null;
}

/**
 * The published meaning of a RARC, or null.
 * @param {unknown} code
 * @returns {string|null}
 */
function describeRarc(code) {
  const key = normalize(code);
  return (key && RARC_DESCRIPTIONS[key]) || null;
}

/**
 * The meaning of a CARC group code, or null.
 * @param {unknown} code
 * @returns {string|null}
 */
function describeGroup(code) {
  const key = normalize(code);
  return (key && GROUP_DESCRIPTIONS[key]) || null;
}

/**
 * A short label for a CARC group, falling back to the code itself.
 * @param {unknown} code
 * @returns {string}
 */
function labelGroup(code) {
  const key = normalize(code);
  return (key && GROUP_LABELS[key]) || key;
}

/**
 * Resolve one stored adjustment row into what the workbench renders.
 *
 * A STORED description WINS when it is non-empty: it came from the payer's own
 * file (or from this table at parse time), and overwriting a carrier's wording
 * with ours would make two uploads of the same remittance read differently
 * depending on when the table last changed. We fill in only what is blank.
 *
 * @param {{ groupCode?: unknown, reasonCode?: unknown, reasonDescription?: unknown,
 *           remarkCode?: unknown, remarkDescription?: unknown }} row
 * @returns {{ groupCode: string, groupLabel: string, groupDescription: string|null,
 *             reasonCode: string, reasonDescription: string|null,
 *             remarkCode: string|null, remarkDescription: string|null }}
 */
function describeAdjustment(row) {
  const groupCode = normalize(row.groupCode);
  const reasonCode = normalize(row.reasonCode);
  const remarkCode = normalize(row.remarkCode) || null;

  const storedReason = typeof row.reasonDescription === 'string' ? row.reasonDescription.trim() : '';
  const storedRemark = typeof row.remarkDescription === 'string' ? row.remarkDescription.trim() : '';

  // The parser writes `Adjustment code <n>` when it has no description — a
  // placeholder, not a payer's words. Treat it as blank so this table can
  // improve it, which is the whole reason RARC descriptions exist now.
  const reasonPlaceholder = /^Adjustment code /i.test(storedReason);

  return {
    groupCode,
    groupLabel: labelGroup(groupCode),
    groupDescription: describeGroup(groupCode),
    reasonCode,
    reasonDescription:
      (!reasonPlaceholder && storedReason) || describeCarc(reasonCode) || null,
    remarkCode,
    remarkDescription: remarkCode ? storedRemark || describeRarc(remarkCode) || null : null,
  };
}

module.exports = {
  CARC_DESCRIPTIONS,
  RARC_DESCRIPTIONS,
  GROUP_DESCRIPTIONS,
  GROUP_LABELS,
  describeCarc,
  describeRarc,
  describeGroup,
  labelGroup,
  describeAdjustment,
};
