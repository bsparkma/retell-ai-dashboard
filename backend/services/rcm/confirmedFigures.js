'use strict';

/**
 * CONFIRMED-ELSE-EXTRACTED, AND NOTHING ELSE DECIDES IT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ONE ACCESSOR
 * ─────────────────────────────────────────────────────────────────────────────
 * After the confirm step there are TWO numbers for every money field on a
 * scanned EOB: what the read produced, and what a person said the page actually
 * says. Four surfaces need the second one — the confirm screen, the match, the
 * workbench verdict, and the approval gate — and if each joined the two tables
 * itself, they would disagree the first time one of them was edited without the
 * others. Two screens disagreeing about a dollar figure is the failure this
 * module exists to make impossible, not merely unlikely.
 *
 * So there is exactly one function that decides, `figure()`, and everything
 * downstream calls it. `rcmFieldConfirmAccessor.test.js` asserts that no other
 * file in the module reads `rcm_eob_field_confirmations` directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE OUTCOMES, NOT TWO
 * ─────────────────────────────────────────────────────────────────────────────
 * A figure is `confirmed`, `corrected`, or `unconfirmed` — and SEPARATELY it is
 * either stated or not. Those are different axes and collapsing them is how the
 * original bug happened:
 *
 *   stated: false, source: 'extracted'    the read found no figure. Nobody has
 *                                         looked. The screen says "not stated".
 *   stated: false, source: 'confirmed'    a person READ THE PAGE and confirmed
 *                                         there is genuinely no figure there.
 *                                         This is a real answer and the gate
 *                                         accepts it. A category-subtotal EOB
 *                                         has no per-line payment to type, and
 *                                         demanding a number would force an
 *                                         invention.
 *   stated: true,  source: 'corrected'    a person typed a figure from the page
 *                                         that differs from the read.
 *
 * `cents` is `null` whenever `stated` is false. It is never 0-as-a-stand-in:
 * zero asserts the plan paid nothing, which is a claim about a patient's
 * balance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS MODULE DOES NO I/O
 * ─────────────────────────────────────────────────────────────────────────────
 * It is a pure mapping over rows a caller already read, so the gate can
 * re-evaluate inside its own transaction and a test can drive it with no
 * database. The one SQL string lives in `QUERIES` and is exported for
 * `scripts/rcm-verify-queries.js`, which sends every query in this module to a
 * real migrated Postgres in CI — so an unknown column is a pipeline failure
 * rather than a 500 on a walk night.
 *
 * NO OPEN DENTAL. Nothing here imports an OD module or knows a chart exists.
 */

const { CONFIRMABLE_FIELDS, fieldScope } = require('./rcmVocabulary');

/**
 * Every query this module owns, hoisted for `scripts/rcm-verify-queries.js` and
 * for `test/rcmQueryColumns.test.js`'s static scan.
 */
const QUERIES = Object.freeze({
  /** Every confirmation on one check. One index scan, one row per scope+field. */
  readForBatch: `
    SELECT confirmation_id, claim_id, line_id, field, state,
           extracted_cents, confirmed_cents, confirmed_by, confirmed_at
      FROM rcm_eob_field_confirmations
     WHERE office_id = $1 AND batch_id = $2
  `,
});

/**
 * WHICH EXTRACTION COLUMN EACH CONFIRMABLE FIELD IS ABOUT.
 *
 * Here rather than in the route, because the route and the gate must read the
 * SAME extracted figure for a field or they will disagree about whether a
 * confirmation is a correction. `state` is derived from
 * `confirmed_cents IS DISTINCT FROM extracted_cents`, so a route that read
 * `allowed_cents` where the gate read `paid_cents` would file agreements as
 * corrections and put "corrected by <name>" under a figure nobody changed.
 *
 * The scope says which ROW the column is on: `check` → the batch, `claim` → the
 * claim, `line` → the procedure line.
 */
const FIELD_COLUMNS = Object.freeze({
  check_total: 'total_amount_cents',
  claim_total_paid: 'total_paid_cents',
  line_paid: 'paid_cents',
  line_billed: 'billed_cents',
  line_allowed: 'allowed_cents',
  line_deductible: 'deductible_cents',
  line_copay: 'copay_cents',
});

/**
 * How a figure came to be what it is.
 * @typedef {'extracted'|'confirmed'|'corrected'} FigureSource
 */

/**
 * @typedef {object} Figure
 * @property {number|null} cents the figure to USE. null ⇔ `stated === false`.
 * @property {boolean} stated is there a figure at all?
 * @property {FigureSource} source
 * @property {boolean} confirmed has a person signed off on this field?
 * @property {number|null} extractedCents what the read said, always preserved.
 * @property {string|null} confirmedByKey D-5 crosswalk key, or null.
 * @property {string|null} confirmedAt ISO instant, or null.
 */

/**
 * A key that identifies one field's scope unambiguously.
 *
 * The empty string stands in for "no claim" / "no line" so a check-level field
 * and a claim-level field can never collide. It mirrors the migration's unique
 * index, which uses NULLS NOT DISTINCT for the same reason.
 *
 * @param {string|null} claimId
 * @param {string|null} lineId
 * @param {string} field
 */
function scopeKey(claimId, lineId, field) {
  return `${claimId || ''}|${lineId || ''}|${field}`;
}

/**
 * Index confirmation rows for lookup. Pass the result to `figure()`.
 *
 * A row whose `field` is outside the vocabulary is DROPPED rather than indexed.
 * The DB CHECK makes that unreachable through the route, so reaching it means
 * the constraint was bypassed — and in that case ignoring the row degrades to
 * "unconfirmed", which withholds the check. Trusting it would let an unknown
 * slug carry a dollar figure into posting.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Map<string, Record<string, unknown>>}
 */
function indexConfirmations(rows) {
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const field = String(row.field || '');
    if (!CONFIRMABLE_FIELDS.includes(field)) continue;
    index.set(
      scopeKey(row.claim_id ? String(row.claim_id) : null, row.line_id ? String(row.line_id) : null, field),
      row
    );
  }
  return index;
}

/** A bigint column comes back as a string from pg. null stays null. */
function centsOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** An ISO instant for a pg timestamptz. */
function isoOrNull(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * THE ONE DECISION: what is this field's real figure?
 *
 * @param {Map<string, Record<string, unknown>>} index from `indexConfirmations`
 * @param {{ claimId?: string|null, lineId?: string|null, field: string }} at
 * @param {number|null} extractedCents what the extraction stored, null = unstated
 * @returns {Figure}
 */
function figure(index, at, extractedCents) {
  const field = String(at && at.field);
  const extracted = centsOrNull(extractedCents);

  const row = index instanceof Map ? index.get(scopeKey(at.claimId || null, at.lineId || null, field)) : undefined;

  if (!row) {
    return {
      cents: extracted,
      stated: extracted !== null,
      source: 'extracted',
      confirmed: false,
      extractedCents: extracted,
      confirmedByKey: null,
      confirmedAt: null,
    };
  }

  const confirmed = centsOrNull(row.confirmed_cents);
  const source = row.state === 'corrected' ? 'corrected' : 'confirmed';
  return {
    cents: confirmed,
    stated: confirmed !== null,
    source,
    confirmed: true,
    /*
     * The row's OWN `extracted_cents`, not the caller's argument.
     *
     * They are normally the same, and when they differ the row is right: it was
     * pinned when the person looked, and a re-upload can have rewritten the
     * extraction rows since. "What did the machine say when she disagreed with
     * it" is the question the trail has to answer.
     */
    extractedCents: centsOrNull(row.extracted_cents),
    confirmedByKey: row.confirmed_by ? String(row.confirmed_by) : null,
    confirmedAt: isoOrNull(row.confirmed_at),
  };
}

/**
 * Which fields this check needs confirmed, derived from its own shape.
 *
 * Not a constant: a check's requirement is one `check_total`, one
 * `claim_total_paid` per claim, and the five line fields per line. Computing it
 * from the rows means a claim added by a re-extraction is covered without
 * anybody remembering to widen a list.
 *
 * @param {Array<{ claimId: string, lines: Array<{ lineId: string }> }>} claims
 * @returns {Array<{ claimId: string|null, lineId: string|null, field: string }>}
 */
function requiredFields(claims) {
  /** @type {Array<{ claimId: string|null, lineId: string|null, field: string }>} */
  const required = [{ claimId: null, lineId: null, field: 'check_total' }];
  for (const claim of Array.isArray(claims) ? claims : []) {
    required.push({ claimId: claim.claimId, lineId: null, field: 'claim_total_paid' });
    for (const line of Array.isArray(claim.lines) ? claim.lines : []) {
      for (const field of CONFIRMABLE_FIELDS) {
        if (fieldScope(field) !== 'line') continue;
        required.push({ claimId: claim.claimId, lineId: line.lineId, field });
      }
    }
  }
  return required;
}

/**
 * Is every money field on this check confirmed?
 *
 * @param {Map<string, Record<string, unknown>>} index
 * @param {Array<{ claimId: string, lines: Array<{ lineId: string }> }>} claims
 * @returns {{ ok: boolean, outstanding: number, first: { claimId: string|null, lineId: string|null, field: string }|null }}
 */
function allConfirmed(index, claims) {
  const required = requiredFields(claims);
  const missing = required.filter(
    (r) => !(index instanceof Map && index.has(scopeKey(r.claimId, r.lineId, r.field)))
  );
  return {
    ok: missing.length === 0,
    outstanding: missing.length,
    first: missing[0] || null,
  };
}

/**
 * DOES THE READ ADD UP TO THE CHECK? (owner ruling: the check is the anchor)
 *
 * The check total is the absolute. The biller is holding the physical cheque, so
 * that figure is the one thing in the whole document she can verify against
 * something other than the document — and every claim figure has to reconcile
 * to it.
 *
 * `Σ(confirmed claim_total_paid)` against `confirmed check_total`, using
 * `figure()` so the sum is over the same numbers the screen prints.
 *
 * AN UNSTATED CLAIM TOTAL MAKES THE SUM UNKNOWABLE, not zero — so the result is
 * `ok: false` with `comparable: false`, and the caller says "one claim's total
 * is not stated" rather than naming a difference it cannot compute. Treating it
 * as 0 would produce a dollar difference that is an artefact of our own
 * arithmetic and send a biller looking for it on the page.
 *
 * @param {Map<string, Record<string, unknown>>} index
 * @param {{ checkTotalCents: number|null, claims: Array<{ claimId: string, totalPaidCents: number|null }> }} extracted
 * @returns {{ ok: boolean, comparable: boolean, checkTotalCents: number|null, claimsTotalCents: number|null, differenceCents: number|null }}
 */
function sumsToCheck(index, extracted) {
  const check = figure(index, { field: 'check_total' }, extracted && extracted.checkTotalCents);
  const claims = Array.isArray(extracted && extracted.claims) ? extracted.claims : [];

  let sum = 0;
  let comparable = check.stated;
  for (const claim of claims) {
    const f = figure(
      index,
      { claimId: claim.claimId, field: 'claim_total_paid' },
      claim.totalPaidCents
    );
    if (!f.stated) {
      comparable = false;
      continue;
    }
    sum += /** @type {number} */ (f.cents);
  }

  if (!comparable) {
    return {
      ok: false,
      comparable: false,
      checkTotalCents: check.cents,
      claimsTotalCents: null,
      differenceCents: null,
    };
  }

  const checkCents = /** @type {number} */ (check.cents);
  const difference = sum - checkCents;
  return {
    /*
     * EXACT. No tolerance.
     *
     * The extraction path allows a few cents of slack between a sum and a total,
     * which is right for a read it is judging on its own. This is a person
     * holding the cheque and typing what is printed on it, so a cent of
     * disagreement is a cent somebody has to account for — and "close enough" is
     * how a rounding convention becomes a missing payment nobody can trace.
     */
    ok: difference === 0,
    comparable: true,
    checkTotalCents: checkCents,
    claimsTotalCents: sum,
    differenceCents: difference,
  };
}

/**
 * Was this check's figures READ from a scan?
 *
 * The confirm step and both new gate conditions apply to OCR-sourced checks
 * ONLY. An 835 is a machine-readable file whose numbers are delimited data, not
 * a picture of a table — there is nothing for a person to squint at, and adding
 * a confirm step to it would be ceremony that teaches billers the step is
 * ceremony.
 *
 * `text_source === 'ocr'` is the same column the provenance line renders from.
 * Null (not extracted, or an 835) is NOT ocr.
 *
 * @param {{ textSource?: string|null }|null|undefined} provenance
 */
function isOcrSourced(provenance) {
  return Boolean(provenance && provenance.textSource === 'ocr');
}

/**
 * The extracted figure for one field, read off the row its scope names.
 *
 * `undefined` when the field is outside the vocabulary or the row is missing —
 * distinguishable from `null`, which means the row exists and states nothing.
 *
 * @param {string} field
 * @param {Record<string, unknown>|null|undefined} row batch, claim or line row
 * @returns {number|null|undefined}
 */
function extractedFor(field, row) {
  const column = FIELD_COLUMNS[field];
  if (!column || !row) return undefined;
  if (!Object.prototype.hasOwnProperty.call(row, column)) return undefined;
  return centsOrNull(row[column]);
}

module.exports = {
  QUERIES,
  FIELD_COLUMNS,
  extractedFor,
  scopeKey,
  indexConfirmations,
  figure,
  requiredFields,
  allConfirmed,
  sumsToCheck,
  isOcrSourced,
};
