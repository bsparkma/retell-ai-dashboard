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
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DATA IS INGESTED, NEVER TYPED
 * ─────────────────────────────────────────────────────────────────────────────
 * The tables live in `./x12Codes.generated.js`, produced by
 * `backend/scripts/fetch-x12-codes.mjs` from the published X12 lists, carrying
 * the source URL, the retrieval date and a content hash that
 * `adjustmentCodes.test.js` pins.
 *
 * This module originally shipped a HAND-WRITTEN table asserting it carried "the
 * published meaning". It did not, and the errors clustered on the codes a
 * dental biller acts on — CARC 22 said "care already paid" when it actually
 * means **coordination of benefits**, i.e. *bill the secondary carrier*. 50, 51,
 * 151 and B15 were wrong; 54 and 234 were swapped. A test even pinned one of the
 * wrong strings as correct, locking the bug in.
 *
 * Confidently wrong text in front of billing staff is worse than no text. That
 * is the same judgement the parser's D5 ruling made about inventing a CARC from
 * a malformed CAS, and this is that judgement applied to the render path.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AN UNKNOWN CODE RENDERS BARE
 * ─────────────────────────────────────────────────────────────────────────────
 * `describeCarc('9999')` returns `null` and the UI shows `CO-9999` with no
 * gloss. A biller can look up a code they do not recognize; they cannot un-read
 * one we made up.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DESCRIPTION vs USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 * Many published entries append operational guidance:
 *
 *   "Charge exceeds fee schedule/maximum allowable … Usage: This adjustment
 *    amount cannot equal the total service or claim charge amount; …"
 *
 * The meaning is the first sentence; the rest is instruction to the payer's
 * implementers. They are split at the literal " Usage: " marker — a mechanical,
 * lossless split of published text, not an edit of it — so a chip can show the
 * meaning and a tooltip can carry the rest. `describeCarcFull()` returns the
 * untouched published string for anyone who needs it.
 */

const { CARC, RARC, SOURCE } = require('./x12Codes.generated');

/**
 * CARC group codes — WHO the money moved to, which is the single most
 * consequential field on an adjustment and the one most often skimmed past.
 *
 * The distinction that matters for posting: CO is a contractual write-off the
 * practice absorbs, PR is money the PATIENT owes and must be billed for.
 * Rendering "CO" and "PR" as bare two-letter codes invites reading one as the
 * other.
 *
 * Hand-written on purpose, and safe to be: there are five, they are defined in
 * the X12 835 implementation guide rather than in a maintained code list, and
 * the schema's own CHECK constraint is the authority on which exist
 * (`group_code IN ('CO','PR','OA','PI','CR')`). A test asserts this map and
 * that constraint agree.
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
 * Split a published entry into its meaning and its implementer guidance.
 * @param {string} text
 * @returns {{ description: string, usage: string|null }}
 */
function splitUsage(text) {
  const at = text.indexOf(' Usage: ');
  if (at === -1) return { description: text, usage: null };
  return { description: text.slice(0, at).trim(), usage: text.slice(at + 1).trim() };
}

/**
 * Look one code up in an ingested table.
 * @param {Readonly<Record<string, {text: string, status: string}>>} table
 * @param {unknown} code
 * @returns {{ description: string, usage: string|null, status: string, published: string }|null}
 */
function lookup(table, code) {
  const key = normalize(code);
  const entry = key && table[key];
  if (!entry) return null;
  return { ...splitUsage(entry.text), status: entry.status, published: entry.text };
}

/**
 * The published meaning of a CARC, or null if it is not in the list.
 *
 * Returns the MEANING (the text before any " Usage: " guidance). Null is a real
 * answer — see the header.
 *
 * @param {unknown} code
 * @returns {string|null}
 */
function describeCarc(code) {
  const found = lookup(CARC, code);
  return found ? found.description : null;
}

/** The untouched published CARC string, guidance included, or null. */
function describeCarcFull(code) {
  const found = lookup(CARC, code);
  return found ? found.published : null;
}

/**
 * The published meaning of a RARC, or null.
 * @param {unknown} code
 * @returns {string|null}
 */
function describeRarc(code) {
  const found = lookup(RARC, code);
  return found ? found.description : null;
}

/** The untouched published RARC string, or null. */
function describeRarcFull(code) {
  const found = lookup(RARC, code);
  return found ? found.published : null;
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
 * file, and overwriting a carrier's wording with ours would make two uploads of
 * the same remittance read differently depending on when the code list was last
 * pulled. We fill in only what is blank.
 *
 * The one exception is the ERA parser's `Adjustment code <n>` placeholder — that
 * is a stand-in for a description it did not have, not a payer's words, so the
 * published text replaces it.
 *
 * `deactivated` is surfaced rather than hidden: an old denial being worked today
 * legitimately carries a retired code, and "this code is no longer in use" is
 * information a biller wants when a payer sends one.
 *
 * @param {{ groupCode?: unknown, reasonCode?: unknown, reasonDescription?: unknown,
 *           remarkCode?: unknown, remarkDescription?: unknown }} row
 */
function describeAdjustment(row) {
  const groupCode = normalize(row.groupCode);
  const reasonCode = normalize(row.reasonCode);
  const remarkCode = normalize(row.remarkCode) || null;

  const storedReason = typeof row.reasonDescription === 'string' ? row.reasonDescription.trim() : '';
  const storedRemark = typeof row.remarkDescription === 'string' ? row.remarkDescription.trim() : '';
  const reasonPlaceholder = /^Adjustment code /i.test(storedReason);

  const carc = lookup(CARC, reasonCode);
  const rarc = remarkCode ? lookup(RARC, remarkCode) : null;

  return {
    groupCode,
    groupLabel: labelGroup(groupCode),
    groupDescription: describeGroup(groupCode),

    reasonCode,
    reasonDescription:
      (!reasonPlaceholder && storedReason) || (carc && carc.description) || null,
    /** Implementer guidance from the published entry, for a tooltip. */
    reasonUsage: carc ? carc.usage : null,
    /** 'current' | 'tobe' | 'deactivated', or null when the code is unknown. */
    reasonStatus: carc ? carc.status : null,

    remarkCode,
    remarkDescription: remarkCode ? storedRemark || (rarc && rarc.description) || null : null,
    remarkUsage: rarc ? rarc.usage : null,
    remarkStatus: rarc ? rarc.status : null,
  };
}

module.exports = {
  /** Provenance: source URLs, retrieval date, content hash. */
  SOURCE,
  CARC,
  RARC,
  GROUP_DESCRIPTIONS,
  GROUP_LABELS,
  describeCarc,
  describeCarcFull,
  describeRarc,
  describeRarcFull,
  describeGroup,
  labelGroup,
  describeAdjustment,
  splitUsage,
  normalize,
};
