'use strict';

/**
 * EOB extraction engine — the PURE half of Slice 4.
 *
 * Everything here is a function of its arguments: the JSON schema handed to the
 * model, the prompt, and the derivation/normalization that turns a model answer
 * into rows we are willing to store. No HTTP, no Blob, no Postgres, no clock
 * except the one you pass in. That is what makes it unit-testable without an
 * LLM, and it is the half worth porting from `rcm-posting`
 * (server/routers/eobExtraction.ts @ 9cebfc2) — the transport around it was
 * tRPC + Drizzle + S3 and does not survive the move.
 *
 * WHAT COMES OUT IS A PROPOSAL. Nothing in this file, and nothing downstream of
 * it in this slice, touches Open Dental. An extraction produces rcm_claims rows
 * in 'pending_review' with rcm_procedure_lines and rcm_procedure_adjustments
 * beneath them, and a human decides in Slice 7 whether any of it is true.
 *
 * PORTED, with the source's reasoning intact:
 *  - the {payment, claims[]} shape: ONE remittance (check/EFT) can pay MANY
 *    patients. A single-patient EOB is the array-of-one case, so there is no
 *    separate single-claim path to keep in sync.
 *  - placeholder sentinels (NPI 0000000000, DOB 1900-01-01, check UNKNOWN). The
 *    model is told to emit them rather than invent a value, and every one of
 *    them becomes a review reason. A placeholder that did NOT raise a flag would
 *    be a guess wearing a real value's clothes.
 *  - the math reconciliation: Σ(procedure paid) vs claim total, Σ(claim paid) vs
 *    check total, both within a small tolerance for source rounding noise.
 *
 * ADDED here, because the platform schema has somewhere to put it and the
 * source did not:
 *  - structured CARC/RARC per procedure line (rcm_procedure_adjustments). The
 *    source carried only a free-text `adjustmentReason`; Open Dental's
 *    ClaimAdjReasonCodes is read-only over the API (RCM_OD_WRITES G3), so this
 *    table is the only structured home those codes will ever have.
 *  - per-line confidence, and the uncertain-line flags derived from it.
 *
 * LOW CONFIDENCE WIDENS REVIEW; IT NEVER RESOLVES ANYTHING. An uncertain line
 * is flagged and left as the model read it — there is no branch here that
 * "corrects" a number the model was unsure about, because a confident-looking
 * wrong number in a claim is worse than a flagged uncertain one.
 */

// ─── Tunables ────────────────────────────────────────────────────────────────

/** Sentinels the model is INSTRUCTED to emit rather than invent a value. */
const { EOB_REVIEW_REASONS } = require('./rcmVocabulary');

const PLACEHOLDER_NPI = '0000000000';
const PLACEHOLDER_DOB = '1900-01-01';
const PLACEHOLDER_CHECK = 'UNKNOWN';

/** Document-level confidence at or below which the whole claim is flagged. */
const LOW_CONFIDENCE_THRESHOLD = 85;

/** Per-line confidence at or below which THAT line is flagged as uncertain. */
const LOW_LINE_CONFIDENCE_THRESHOLD = 80;

/**
 * Cents of slack allowed between a sum and the total it should equal. Source
 * EOBs really do carry rounding noise; a 1¢ disagreement is not a misread.
 * Ported from the source's TOTAL_RECONCILIATION_TOLERANCE_CENTS.
 */
const TOTAL_TOLERANCE_CENTS = 5;

/**
 * The flag vocabulary rcm_procedure_lines will accept. Copied from the CHECK
 * constraint in migrations-tenant/1786622400000_rcm_schema.js — a flag outside
 * this list is dropped here rather than rejected by Postgres mid-transaction,
 * because losing one annotation is better than losing the whole extraction.
 */
const PROCEDURE_FLAGS = Object.freeze([
  'downcode',
  'bundled',
  'denied',
  'partial_pay',
  'unexplained_adj',
  'frequency_limit',
  'not_covered',
  'pre_auth_required',
]);

/** CARC group codes rcm_procedure_adjustments accepts (same CHECK constraint). */
const CARC_GROUPS = Object.freeze(['CO', 'PR', 'OA', 'PI', 'CR']);

/** rcm_payment_batches.payment_method CHECK — 'check' | 'eft' | NULL. */
const PAYMENT_METHODS = Object.freeze(['check', 'eft']);

// ─── The structured-output schema ────────────────────────────────────────────

const ADJUSTMENT_SCHEMA = {
  type: 'object',
  properties: {
    groupCode: {
      type: 'string',
      description: 'CARC group code: CO (contractual), PR (patient responsibility), OA, PI, or CR',
    },
    reasonCode: { type: 'string', description: 'CARC reason code, e.g. 45, 2, 96' },
    reasonDescription: { type: 'string', description: 'The printed wording for that reason, if any' },
    amountCents: { type: 'integer', description: 'Amount adjusted under this code, in cents' },
    remarkCode: { type: 'string', description: 'RARC remark code if printed, e.g. N130. Empty string if none.' },
    remarkDescription: { type: 'string', description: 'The printed wording for the remark, if any' },
  },
  required: [
    'groupCode',
    'reasonCode',
    'reasonDescription',
    'amountCents',
    'remarkCode',
    'remarkDescription',
  ],
  additionalProperties: false,
};

const PROCEDURE_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'ADA/CDT procedure code (e.g. D2750, D0120)' },
    description: { type: 'string', description: 'Procedure description as printed' },
    billedCents: { type: 'integer', description: 'Amount billed for this procedure, in cents' },
    allowedCents: { type: 'integer', description: 'Allowed/contracted amount for this procedure, in cents' },
    deductibleCents: { type: 'integer', description: 'Deductible applied to this procedure, in cents' },
    copayCents: { type: 'integer', description: 'Patient copay/coinsurance for this procedure, in cents' },
    paidCents: { type: 'integer', description: 'Insurance payment for this procedure, in cents' },
    confidence: {
      type: 'integer',
      description:
        'How sure you are of THIS line specifically, 0-100. Lower it when the row is faint, ' +
        'the columns are ambiguous, or you had to infer a number rather than read it.',
    },
    flags: {
      type: 'array',
      description:
        'Zero or more of: downcode, bundled, denied, partial_pay, unexplained_adj, ' +
        'frequency_limit, not_covered, pre_auth_required. Only what the document states.',
      items: { type: 'string' },
    },
    adjustments: {
      type: 'array',
      description:
        'Structured CARC/RARC adjustments printed for this line. Empty array when the ' +
        'document prints no reason codes — do NOT invent codes to explain a difference.',
      items: ADJUSTMENT_SCHEMA,
    },
  },
  required: [
    'code',
    'description',
    'billedCents',
    'allowedCents',
    'deductibleCents',
    'copayCents',
    'paidCents',
    'confidence',
    'flags',
    'adjustments',
  ],
  additionalProperties: false,
};

const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    patientName: { type: 'string', description: 'Full name of the patient for THIS claim' },
    patientDOB: { type: 'string', description: `Patient DOB as YYYY-MM-DD, or "${PLACEHOLDER_DOB}" if absent` },
    subscriberId: { type: 'string', description: 'Insurance subscriber/member ID' },
    groupNumber: { type: 'string', description: 'Insurance group number' },
    claimNumber: { type: 'string', description: 'Claim number the payer assigned to THIS claim' },
    serviceDate: { type: 'string', description: 'Date of service as YYYY-MM-DD' },
    providerNPI: { type: 'string', description: `Rendering provider NPI, or "${PLACEHOLDER_NPI}" if absent` },
    renderingProvider: { type: 'string', description: 'Rendering provider full name' },
    totalBilledCents: { type: 'integer', description: 'Total billed for THIS claim, in cents ($150.00 = 15000)' },
    totalAllowedCents: { type: 'integer', description: 'Total allowed for this claim, in cents' },
    totalDeductibleCents: { type: 'integer', description: 'Total deductible applied to this claim, in cents' },
    totalCopayCents: { type: 'integer', description: 'Total patient copay/coinsurance for this claim, in cents' },
    totalPaidCents: { type: 'integer', description: 'Total insurance payment for THIS claim, in cents' },
    procedures: {
      type: 'array',
      description: 'EVERY procedure line for this claim, in printed order',
      items: PROCEDURE_SCHEMA,
    },
  },
  required: [
    'patientName',
    'patientDOB',
    'subscriberId',
    'groupNumber',
    'claimNumber',
    'serviceDate',
    'providerNPI',
    'renderingProvider',
    'totalBilledCents',
    'totalAllowedCents',
    'totalDeductibleCents',
    'totalCopayCents',
    'totalPaidCents',
    'procedures',
  ],
  additionalProperties: false,
};

/** The json_schema block handed to Azure OpenAI's structured-output mode. */
const EOB_EXTRACTION_SCHEMA = Object.freeze({
  name: 'eob_extraction',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      payment: {
        type: 'object',
        description: 'Check/EFT-level information shared by EVERY claim on this remittance',
        properties: {
          payer: { type: 'string', description: 'Insurance company name (e.g. Delta Dental, Cigna)' },
          checkNumber: {
            type: 'string',
            description: `Check or EFT reference/trace number for the whole remittance, or "${PLACEHOLDER_CHECK}"`,
          },
          checkDate: { type: 'string', description: 'Check/EFT date as YYYY-MM-DD' },
          paymentMethod: {
            type: 'string',
            description: 'How the payer sent the money: exactly "check" or "eft". Use "check" if unclear.',
          },
          totalPaidCents: {
            type: 'integer',
            description:
              'TOTAL insurance payment for the ENTIRE check/EFT across ALL claims, in cents ' +
              '(a $651.00 check = 65100)',
          },
        },
        required: ['payer', 'checkNumber', 'checkDate', 'paymentMethod', 'totalPaidCents'],
        additionalProperties: false,
      },
      confidence: {
        type: 'integer',
        description: 'Confidence 0-100 in the extraction overall, based on document clarity and completeness',
      },
      claims: {
        type: 'array',
        description:
          'EVERY claim/patient on this EOB. A single-patient EOB has exactly ONE entry. ' +
          'A bulk paper check lists many patients — extract them ALL, one entry per claim.',
        items: CLAIM_SCHEMA,
      },
    },
    required: ['payment', 'confidence', 'claims'],
    additionalProperties: false,
  },
});

/**
 * The system prompt. Ported nearly verbatim — its reconcile-before-returning
 * paragraph is the thing that made the source's numbers trustworthy, and the
 * two additions (CARC/RARC, per-line confidence) are appended rather than
 * rewritten so the ported wording stays recognizable against the source.
 */
const SYSTEM_PROMPT = `You are a dental billing specialist AI that extracts structured data from dental EOB (Explanation of Benefits) and ERA (Electronic Remittance Advice) documents.

One remittance (check/EFT) may cover MULTIPLE patients/claims (a "bulk" paper check). Return { payment, confidence, claims[] }:
- payment: the check/EFT-level information shared by all claims — payer, checkNumber, checkDate, paymentMethod, and totalPaidCents = the TOTAL paid for the WHOLE check across all claims.
- claims: ONE entry per claim/patient on the document. A single-patient EOB has exactly one claim in the array. A bulk check lists many patients — you MUST extract EVERY claim, never just the first.

For monetary amounts, always convert to cents (integer). If a field is not present, use these exact placeholders rather than inventing a value:
- Missing NPI: "${PLACEHOLDER_NPI}"
- Missing check number: "${PLACEHOLDER_CHECK}"
- Missing group number: "UNKNOWN"
- Missing DOB: "${PLACEHOLDER_DOB}"
- Set confidence based on document quality: 90-100 for clear digital PDFs, 70-89 for scanned documents, 50-69 for poor quality.

Rules that MUST hold — read amounts digit-by-digit and RECONCILE before returning:
- Extract ALL procedure lines for EACH claim. Read each procedure's PLAN PAID amount carefully, then set that claim's totalPaidCents to the exact SUM of its procedure paidCents.
- Patient responsibility (deductible, copay, coinsurance such as PR-2) belongs in each claim's totalCopayCents/totalDeductibleCents and the matching procedure fields — never drop it.
- Then verify: the sum of every claim's totalPaidCents MUST equal payment.totalPaidCents (the printed check/EFT total). If they do NOT match, you have misread a procedure or claim amount — RE-READ the document and correct the figures before returning.

Adjustment reason codes (CARC/RARC): when the document prints them, put them in that procedure's adjustments array as structured entries — groupCode is the CARC group (CO, PR, OA, PI, CR), reasonCode is the numeric CARC, remarkCode is the RARC (e.g. N130) when one is printed. If the document prints NO reason codes for a line, return an empty adjustments array. Never invent a code to explain a difference you cannot account for; flag the line "unexplained_adj" instead.

Per-line confidence: every procedure carries its own confidence 0-100. Lower it whenever the row is faint, the column headings are ambiguous, or you had to infer a number rather than read it. A low per-line confidence is useful and safe — it sends that line to a human. Guessing with high confidence is not. Do not raise a line's confidence to make a total reconcile.`;

/** The user turn wrapped around the document text. */
function buildUserPrompt(documentText) {
  return `EOB document text:\n\n${documentText}\n\nExtract all claim data from this dental EOB.`;
}

// ─── Coercion helpers ────────────────────────────────────────────────────────

/** An integer, or `fallback` for anything that is not one. Never NaN. */
function int(v, fallback = 0) {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** A trimmed string, or '' — never null, never "null", never an object. */
function str(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** Clamp to 0..100 — a confidence outside that range is a model slip, not data. */
function pct(v, fallback = 0) {
  return Math.max(0, Math.min(100, int(v, fallback)));
}

/** `YYYY-MM-DD` if it looks like one, else null. Postgres `date` takes nothing else. */
function isoDateOrNull(v) {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

class EobExtractionError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'EobExtractionError';
    this.code = code;
  }
}

// ─── Normalization ───────────────────────────────────────────────────────────

/**
 * Turn whatever the model returned into the canonical shape, or refuse.
 *
 * Defensive even though the request used strict structured output: `strict`
 * constrains the model, it does not constrain a proxy, a truncated response, or
 * a future api-version that quietly stops honoring it. Everything below either
 * coerces to a storable value or throws — nothing is passed through unexamined
 * on its way to a claim row.
 *
 * @param {unknown} raw parsed JSON from the model
 * @returns {ExtractedEob}
 */
function normalizeExtraction(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new EobExtractionError('extraction result was not a JSON object', 'EXTRACTION_MALFORMED');
  }
  const doc = /** @type {Record<string, unknown>} */ (raw);
  const rawPayment = doc.payment && typeof doc.payment === 'object' ? doc.payment : {};
  const p = /** @type {Record<string, unknown>} */ (rawPayment);

  const method = str(p.paymentMethod).toLowerCase();

  const payment = {
    payer: str(p.payer),
    checkNumber: str(p.checkNumber),
    checkDate: isoDateOrNull(p.checkDate),
    // NULL rather than a guess: the CHECK constraint takes 'check' | 'eft' |
    // NULL, and NULL honestly means "the document did not say".
    paymentMethod: PAYMENT_METHODS.includes(method) ? method : null,
    totalPaidCents: int(p.totalPaidCents),
  };

  const claimsIn = Array.isArray(doc.claims) ? doc.claims : [];
  const claims = claimsIn.map((c) => normalizeClaim(c));

  return { payment, confidence: pct(doc.confidence), claims };
}

/** @param {unknown} rawClaim */
function normalizeClaim(rawClaim) {
  const c = rawClaim && typeof rawClaim === 'object' ? /** @type {Record<string, unknown>} */ (rawClaim) : {};
  const proceduresIn = Array.isArray(c.procedures) ? c.procedures : [];

  return {
    patientName: str(c.patientName),
    patientDOB: isoDateOrNull(c.patientDOB),
    subscriberId: str(c.subscriberId),
    groupNumber: str(c.groupNumber),
    claimNumber: str(c.claimNumber),
    serviceDate: isoDateOrNull(c.serviceDate),
    providerNPI: str(c.providerNPI),
    renderingProvider: str(c.renderingProvider),
    totalBilledCents: int(c.totalBilledCents),
    totalAllowedCents: int(c.totalAllowedCents),
    totalDeductibleCents: int(c.totalDeductibleCents),
    totalCopayCents: int(c.totalCopayCents),
    totalPaidCents: int(c.totalPaidCents),
    procedures: proceduresIn.map((p, i) => normalizeProcedure(p, i)),
  };
}

/**
 * @param {unknown} rawProc
 * @param {number} index zero-based printed order; becomes rcm_procedure_lines.position
 */
function normalizeProcedure(rawProc, index) {
  const p = rawProc && typeof rawProc === 'object' ? /** @type {Record<string, unknown>} */ (rawProc) : {};
  const billed = int(p.billedCents);
  const allowed = int(p.allowedCents);
  const deductible = int(p.deductibleCents);
  const copay = int(p.copayCents);

  const flagsIn = Array.isArray(p.flags) ? p.flags : [];
  // Dedupe + drop anything outside the CHECK vocabulary. A flag Postgres would
  // reject must not be able to abort the whole extraction transaction.
  const flags = [...new Set(flagsIn.map((f) => str(f).toLowerCase()))].filter((f) =>
    PROCEDURE_FLAGS.includes(f)
  );

  const adjustmentsIn = Array.isArray(p.adjustments) ? p.adjustments : [];
  const adjustments = adjustmentsIn
    .map((a) => normalizeAdjustment(a))
    // An adjustment with no CARC group is not a CARC adjustment. Dropping it
    // beats storing 'CO' we made up: rcm_procedure_adjustments is the only
    // structured home these codes have, so a fabricated one is permanent.
    .filter((a) => a !== null);

  return {
    position: index,
    code: str(p.code),
    description: str(p.description),
    billedCents: billed,
    allowedCents: allowed,
    deductibleCents: deductible,
    copayCents: copay,
    paidCents: int(p.paidCents),
    // Derived, not asked for — the source derived them the same way, and a
    // model-supplied "write-off" that disagreed with billed − allowed would be
    // a third number nobody could reconcile.
    adjustmentCents: billed - allowed,
    writeOffCents: billed - allowed,
    patientRespCents: deductible + copay,
    // A model that omits per-line confidence should not silently read as 0 (=
    // "flag everything") or 100 (= "trust everything"). 0 is the safe default:
    // it over-flags, and over-flagging costs a human glance, not a wrong claim.
    confidence: pct(p.confidence),
    flags,
    adjustments,
  };
}

/** @param {unknown} rawAdj @returns {ExtractedAdjustment|null} */
function normalizeAdjustment(rawAdj) {
  const a = rawAdj && typeof rawAdj === 'object' ? /** @type {Record<string, unknown>} */ (rawAdj) : {};
  const group = str(a.groupCode).toUpperCase();
  if (!CARC_GROUPS.includes(group)) return null;
  const reason = str(a.reasonCode);
  if (!reason) return null;
  return {
    groupCode: group,
    reasonCode: reason,
    reasonDescription: str(a.reasonDescription),
    amountCents: int(a.amountCents),
    remarkCode: str(a.remarkCode) || null,
    remarkDescription: str(a.remarkDescription),
  };
}

// ─── Review-reason derivation ────────────────────────────────────────────────

/**
 * The EOB half of the frozen vocabulary. Aliased to `R` so the derivation below
 * reads as closely as possible to the bare literals it replaced — the point is
 * that a typo is now a load-time crash instead of a rejected INSERT in prod.
 */
const R = EOB_REVIEW_REASONS;

/**
 * Per-claim reasons a human must look at this. Ported from the source's
 * `deriveClaimReviewReasons`, plus the uncertain-line reasons.
 *
 * These land in rcm_claims.needs_review_reasons, which SINCE SLICE 5.5 CARRIES A
 * CHECK CONSTRAINT — every value below must be a member of
 * `rcmVocabulary.REVIEW_REASONS`, or the INSERT is rejected and a whole
 * extraction rolls back. They are referenced through `R` rather than written as
 * bare literals for exactly that reason.
 *
 * `uncertain_line:N` carries a line number with it because rcm_procedure_lines
 * has no confidence column and its `flags` CHECK has no slot for uncertainty, so
 * the pointer lives on the claim. That is the one PARAMETERISED member, and the
 * CHECK validates it through an IMMUTABLE function rather than a plain array
 * containment test. Slice 7 reads the per-line confidence itself out of
 * rcm_claims.raw_extracted_json.
 *
 * @param {ExtractedClaim} claim
 * @param {number} confidence document-level confidence
 * @param {ExtractedPayment} payment shared remittance context
 * @param {{ today?: string }} [opts] `today` as YYYY-MM-DD; injectable for tests
 * @returns {string[]}
 */
function deriveClaimReviewReasons(claim, confidence, payment, opts = {}) {
  /** @type {string[]} */
  const reasons = [];

  if (confidence < LOW_CONFIDENCE_THRESHOLD) reasons.push(R.LOW_CONFIDENCE);
  if (!claim.providerNPI || claim.providerNPI === PLACEHOLDER_NPI) reasons.push(R.MISSING_NPI);
  if (!claim.patientDOB || claim.patientDOB === PLACEHOLDER_DOB) reasons.push(R.MISSING_DOB);
  if (!payment.checkNumber || payment.checkNumber === PLACEHOLDER_CHECK) reasons.push(R.MISSING_CHECK_NUMBER);
  if (!claim.subscriberId) reasons.push(R.MISSING_SUBSCRIBER_ID);
  if (!payment.payer) reasons.push(R.MISSING_PAYER);
  if (!claim.claimNumber) reasons.push(R.MISSING_CLAIM_NUMBER);
  if (!claim.patientName) reasons.push(R.MISSING_PATIENT_NAME);
  if (claim.procedures.length === 0) reasons.push(R.NO_PROCEDURES_EXTRACTED);

  // Math sanity: the per-procedure sums should reach the claim totals.
  if (claim.procedures.length > 0) {
    const paidSum = claim.procedures.reduce((acc, p) => acc + p.paidCents, 0);
    if (Math.abs(paidSum - claim.totalPaidCents) > TOTAL_TOLERANCE_CENTS) {
      reasons.push(R.PAID_TOTAL_MISMATCH);
    }
    const billedSum = claim.procedures.reduce((acc, p) => acc + p.billedCents, 0);
    if (Math.abs(billedSum - claim.totalBilledCents) > TOTAL_TOLERANCE_CENTS) {
      reasons.push(R.BILLED_TOTAL_MISMATCH);
    }
  }

  // Date sanity: a real ISO date, not in the future.
  const today = opts.today || new Date().toISOString().slice(0, 10);
  if (!claim.serviceDate) {
    reasons.push(R.INVALID_SERVICE_DATE);
  } else if (claim.serviceDate > today) {
    reasons.push(R.SERVICE_DATE_IN_FUTURE);
  }

  // Negative amounts on an EOB almost always mean a misread column. A genuine
  // takeback arrives as a recoupment on the ERA path (Slice 5), not here.
  if (
    claim.totalPaidCents < 0 ||
    claim.totalBilledCents < 0 ||
    claim.procedures.some((p) => p.paidCents < 0 || p.billedCents < 0)
  ) {
    reasons.push(R.NEGATIVE_AMOUNT);
  }

  // Uncertain lines, by printed position (1-based — it is a human pointer).
  for (const p of claim.procedures) {
    if (p.confidence < LOW_LINE_CONFIDENCE_THRESHOLD) {
      reasons.push(`uncertain_line:${p.position + 1}`);
    }
  }

  return reasons;
}

/**
 * Whole-check reasons. Ported from `deriveBatchReviewReasons`; the source's
 * env-tunable `isWithinTolerance` is inlined as the same fixed tolerance used
 * everywhere else here, because two different tolerances in one extraction is
 * a bug waiting to be argued about.
 *
 * @param {ExtractedEob} extracted
 * @returns {string[]}
 */
function deriveBatchReviewReasons(extracted) {
  if (extracted.claims.length === 0) return [R.NO_CLAIMS_EXTRACTED];
  const claimsPaidSum = extracted.claims.reduce((acc, c) => acc + c.totalPaidCents, 0);
  return Math.abs(claimsPaidSum - extracted.payment.totalPaidCents) > TOTAL_TOLERANCE_CENTS
    ? [R.BATCH_PAID_TOTAL_MISMATCH]
    : [];
}

/** Σ of every claim's paid amount — the figure the check total is checked against. */
function claimsPaidSum(extracted) {
  return extracted.claims.reduce((acc, c) => acc + c.totalPaidCents, 0);
}

module.exports = {
  // schema + prompt
  EOB_EXTRACTION_SCHEMA,
  SYSTEM_PROMPT,
  buildUserPrompt,
  // normalization
  normalizeExtraction,
  EobExtractionError,
  // derivation
  deriveClaimReviewReasons,
  deriveBatchReviewReasons,
  claimsPaidSum,
  // constants worth asserting against
  PLACEHOLDER_NPI,
  PLACEHOLDER_DOB,
  PLACEHOLDER_CHECK,
  LOW_CONFIDENCE_THRESHOLD,
  LOW_LINE_CONFIDENCE_THRESHOLD,
  TOTAL_TOLERANCE_CENTS,
  PROCEDURE_FLAGS,
  CARC_GROUPS,
  PAYMENT_METHODS,
};

/**
 * @typedef {Object} ExtractedAdjustment
 * @property {string} groupCode
 * @property {string} reasonCode
 * @property {string} reasonDescription
 * @property {number} amountCents
 * @property {string|null} remarkCode
 * @property {string} remarkDescription
 *
 * @typedef {Object} ExtractedProcedure
 * @property {number} position
 * @property {string} code
 * @property {string} description
 * @property {number} billedCents
 * @property {number} allowedCents
 * @property {number} deductibleCents
 * @property {number} copayCents
 * @property {number} paidCents
 * @property {number} adjustmentCents
 * @property {number} writeOffCents
 * @property {number} patientRespCents
 * @property {number} confidence
 * @property {string[]} flags
 * @property {ExtractedAdjustment[]} adjustments
 *
 * @typedef {Object} ExtractedClaim
 * @property {string} patientName
 * @property {string|null} patientDOB
 * @property {string} subscriberId
 * @property {string} groupNumber
 * @property {string} claimNumber
 * @property {string|null} serviceDate
 * @property {string} providerNPI
 * @property {string} renderingProvider
 * @property {number} totalBilledCents
 * @property {number} totalAllowedCents
 * @property {number} totalDeductibleCents
 * @property {number} totalCopayCents
 * @property {number} totalPaidCents
 * @property {ExtractedProcedure[]} procedures
 *
 * @typedef {Object} ExtractedPayment
 * @property {string} payer
 * @property {string} checkNumber
 * @property {string|null} checkDate
 * @property {'check'|'eft'|null} paymentMethod
 * @property {number} totalPaidCents
 *
 * @typedef {Object} ExtractedEob
 * @property {ExtractedPayment} payment
 * @property {number} confidence
 * @property {ExtractedClaim[]} claims
 */
