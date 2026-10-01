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
  /**
   * Every line a person added to this check, in the order she added them.
   *
   * Ordered here rather than by the caller so every surface lists a claim's
   * hand-entered lines the same way. There is no `position` to order by: an added
   * line sits after the read ones because that is where it was typed, and
   * inventing a printed position for it would assert something about the page.
   */
  readAddedLinesForBatch: `
    SELECT added_line_id, claim_id, code, description,
           billed_cents, allowed_cents, deductible_cents, copay_cents, paid_cents,
           added_by, added_at
      FROM rcm_eob_added_lines
     WHERE office_id = $1 AND batch_id = $2
     ORDER BY added_at ASC, added_line_id ASC
  `,
  /**
   * Every strike on this check, withdrawn ones included.
   *
   * Read whole rather than filtered in SQL so `indexStrikes` is the one place
   * that decides what "struck" means. A WHERE here and a predicate there would be
   * two answers to that question.
   */
  readStrikesForBatch: `
    SELECT strike_id, claim_id, line_id, added_line_id, reason,
           struck_by, struck_at, withdrawn_at, withdrawn_by
      FROM rcm_eob_line_strikes
     WHERE office_id = $1 AND batch_id = $2
  `,
  /*
   * THE SAME TWO READS, FOR ONE CLAIM.
   *
   * The workbench opens a claim, not a check, and it must show the same lines
   * the confirm screen does or the two screens disagree about what was paid. The
   * `(office_id, claim_id)` index exists for exactly these two.
   */
  readAddedLinesForClaim: `
    SELECT added_line_id, claim_id, code, description,
           billed_cents, allowed_cents, deductible_cents, copay_cents, paid_cents,
           added_by, added_at
      FROM rcm_eob_added_lines
     WHERE office_id = $1 AND claim_id = $2
     ORDER BY added_at ASC, added_line_id ASC
  `,
  readStrikesForClaim: `
    SELECT strike_id, claim_id, line_id, added_line_id, reason,
           struck_by, struck_at, withdrawn_at, withdrawn_by
      FROM rcm_eob_line_strikes
     WHERE office_id = $1 AND claim_id = $2
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
      /*
       * A STRUCK LINE ASKS FOR NOTHING. A person read the page and said this line
       * is not on it; demanding she then check its five figures against the page
       * would be asking her to confirm figures she has just said do not exist,
       * and the count would never reach zero.
       */
      if (line.struck) continue;
      /*
       * AN ADDED LINE IS ALREADY ANSWERED. She typed every figure on it off the
       * page, which is the same act the confirm step records for a read figure.
       * Asking her to confirm her own transcription would be ceremony, and a
       * review step that teaches billers it is ceremony is worse than none.
       */
      if (line.kind === 'added') continue;
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
  if (Object.prototype.hasOwnProperty.call(row, column)) return centsOrNull(row[column]);
  /*
   * THE SAME MAPPING, IN THE OTHER SPELLING.
   *
   * The confirm route hands in raw `pg` rows (`paid_cents`); the approval gate
   * hands in rows it has already mapped to its own wire shape (`paidCents`). Both
   * ask this function which figure a field is about, and the alternative to
   * accepting both spellings is a second FIELD_COLUMNS keyed by camelCase — which
   * is the drift this function exists to prevent. One mapping, read two ways.
   */
  const property = column.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
  if (Object.prototype.hasOwnProperty.call(row, property)) return centsOrNull(row[property]);
  return undefined;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A CLAIM'S LINES ARE
 * ─────────────────────────────────────────────────────────────────────────────
 * After the add-a-line slice there are three facts to combine, not one:
 *
 *   · what the read produced            `rcm_procedure_lines`
 *   · what a person added from the page `rcm_eob_added_lines`
 *   · what a person says is not there   `rcm_eob_line_strikes`
 *
 * Four surfaces need the answer — the confirm screen, the check detail, the
 * workbench, and the approval gate — and the first time one of them combined
 * them itself they would disagree about how much a claim was paid. So
 * `effectiveLines()` is the one function that combines them, the way `figure()`
 * is the one function that decides which figure is real.
 *
 * A STRUCK LINE IS RETURNED, NOT DROPPED. The screen has to show that a line was
 * struck, who struck it and why — a line that silently vanished would be a claim
 * whose arithmetic changed with nothing on screen to explain it. Arithmetic uses
 * `countableLines()`, which is the one predicate for "counts towards the sum".
 */

/** How a line came to be on the claim. */
/** @typedef {'extracted'|'added'} LineKind */

/** `extracted:<uuid>` / `added:<uuid>` — one id space for two tables. */
function strikeKey(kind, id) {
  return `${kind}:${id || ''}`;
}

/**
 * Lines a person added, by claim.
 *
 * @param {Array<Record<string, unknown>>} rows from `QUERIES.readAddedLinesForBatch`
 * @returns {Map<string, Array<Record<string, unknown>>>}
 */
function indexAddedLines(rows) {
  const byClaim = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const claimId = row.claim_id ? String(row.claim_id) : '';
    if (!claimId) continue;
    if (!byClaim.has(claimId)) byClaim.set(claimId, []);
    byClaim.get(claimId).push(row);
  }
  return byClaim;
}

/**
 * LIVE strikes, by the line each is about.
 *
 * A withdrawn strike is dropped here and nowhere else. The row stays in the
 * table — "she struck it, then changed her mind" is two true statements and the
 * trail keeps both — but a withdrawn strike says nothing about the line now, and
 * one predicate deciding that is what stops the gate and the screen disagreeing
 * about whether a line counts.
 *
 * A strike naming neither target, or both, is dropped. The CHECK makes that
 * unreachable through the route, so reaching it means the constraint was
 * bypassed — and in that case ignoring the row leaves the line COUNTING, which
 * is the safe direction: a line nobody can account for keeps the claim from
 * reconciling, where trusting a malformed strike would quietly remove money from
 * a sum.
 *
 * @param {Array<Record<string, unknown>>} rows from `QUERIES.readStrikesForBatch`
 * @returns {Map<string, Record<string, unknown>>}
 */
function indexStrikes(rows) {
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.withdrawn_at) continue;
    const onExtracted = row.line_id ? String(row.line_id) : null;
    const onAdded = row.added_line_id ? String(row.added_line_id) : null;
    if (Boolean(onExtracted) === Boolean(onAdded)) continue;
    index.set(
      onExtracted ? strikeKey('extracted', onExtracted) : strikeKey('added', onAdded),
      row
    );
  }
  return index;
}

/**
 * One figure on a line a PERSON typed in.
 *
 * There is no extraction behind it, so there is nothing to fall back to and
 * nothing to compare against: `extractedCents` is null because the read produced
 * no figure, not because it produced a blank one. `confirmed` is true because the
 * act of typing it from the page IS the confirmation — the same act the confirm
 * step records for a read figure, which is why an added line does not then have
 * to be confirmed a second time.
 *
 * `source: 'added'` is its own value rather than 'corrected'. A correction is a
 * person disagreeing with the machine about a figure; this is a person supplying
 * one the machine never offered, and the screen says so differently.
 *
 * @param {Record<string, unknown>} row an `rcm_eob_added_lines` row
 * @param {string} field
 * @returns {Figure}
 */
function addedFigure(row, field) {
  const cents = centsOrNull(extractedFor(field, row));
  return {
    cents,
    stated: cents !== null,
    source: 'added',
    confirmed: true,
    extractedCents: null,
    confirmedByKey: row && row.added_by ? String(row.added_by) : null,
    confirmedAt: isoOrNull(row && row.added_at),
  };
}

/** The five line-scoped fields, in vocabulary order. */
const LINE_SCOPED_FIELDS = Object.freeze(
  CONFIRMABLE_FIELDS.filter((f) => fieldScope(f) === 'line')
);

/**
 * A claim's lines as they really are.
 *
 * @param {object} args
 * @param {string} args.claimId
 * @param {Array<Record<string, unknown>>} args.extracted `rcm_procedure_lines` rows
 * @param {Map<string, Array<Record<string, unknown>>>} [args.added] from `indexAddedLines`
 * @param {Map<string, Record<string, unknown>>} [args.strikes] from `indexStrikes`
 * @param {Map<string, Record<string, unknown>>} [args.index] from `indexConfirmations`
 * @returns {Array<object>}
 */
function effectiveLines({ claimId, extracted, added, strikes, index }) {
  const strikeOf = (kind, id) => {
    const row = strikes instanceof Map ? strikes.get(strikeKey(kind, id)) : undefined;
    if (!row) return null;
    return {
      reason: String(row.reason || ''),
      struckByKey: row.struck_by ? String(row.struck_by) : null,
      struckAt: isoOrNull(row.struck_at),
    };
  };

  const fromRead = (Array.isArray(extracted) ? extracted : []).map((line, i) => {
    const lineId = String(line.line_id != null ? line.line_id : line.lineId);
    return {
      lineId,
      kind: /** @type {LineKind} */ ('extracted'),
      position: Number(line.position != null ? line.position : i),
      code: String(line.code || ''),
      description: String(line.description || ''),
      /*
       * Where on the page this line was read from. Always null today: the stored
       * OCR result keeps text, page count, word count and mean confidence and
       * discards Azure's polygons, and re-running OCR to recover a box would
       * spend money to redraw it. The seam a later slice fills.
       */
      region: null,
      struck: strikeOf('extracted', lineId),
      fields: LINE_SCOPED_FIELDS.map((field) => ({
        field,
        ...figure(index, { claimId, lineId, field }, extractedFor(field, line)),
      })),
    };
  });

  const typed = ((added instanceof Map ? added.get(String(claimId)) : null) || []).map(
    (row, i) => {
      const lineId = String(row.added_line_id);
      return {
        lineId,
        kind: /** @type {LineKind} */ ('added'),
        /*
         * AFTER THE READ LINES, in the order she typed them.
         *
         * Not a printed position: nobody knows where on the page this line sits,
         * and a number here would assert that somebody did.
         */
        position: fromRead.length + i,
        code: String(row.code || ''),
        description: String(row.description || ''),
        region: null,
        struck: strikeOf('added', lineId),
        fields: LINE_SCOPED_FIELDS.map((field) => ({ field, ...addedFigure(row, field) })),
      };
    }
  );

  return [...fromRead, ...typed];
}

/**
 * THE LINES THAT COUNT TOWARDS A SUM.
 *
 * One predicate, so the gate, the confirm screen and the workbench cannot
 * disagree about whether a struck line is money. A line a person read the page
 * for and said is not there contributes nothing; an added line contributes
 * exactly like a read one, because adding lines is how an incomplete read becomes
 * able to reconcile.
 *
 * @param {Array<{ struck: unknown }>} lines
 */
function countableLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter((l) => l && !l.struck);
}

/** Does this claim carry a line a person typed in, and not since struck? */
function hasAddedLine(lines) {
  return countableLines(lines).some((l) => l.kind === 'added');
}

/**
 * DO A CLAIM'S LINES ADD UP TO WHAT IT WAS PAID?
 *
 * Lifted out of the approval gate so the confirm screen can render the same
 * arithmetic the gate refuses on. ONE arithmetic, two renderers: a green line on
 * the confirm screen beside a red check at the gate is not a bug that can be
 * introduced, which is the same guarantee `lineDecisions` gives the workbench.
 *
 * AN UNSTATED LINE PAYMENT MAKES THE SUM UNKNOWABLE, NOT ZERO. A
 * category-subtotal EOB states payment at a benefit-type subtotal and never per
 * line; summing those nulls as zeroes would report "claim 139100, lines 0" and
 * send a biller looking for a column error that is not there.
 *
 * A CONFIRMED absence passes, and an UNCONFIRMED one does not. Once a person has
 * read the page and confirmed those lines genuinely state nothing, Σ(lines) is
 * not a number anybody printed and asserting it would withhold the check for
 * ever — she would work every field on the confirm screen and meet a refusal she
 * has already done everything about. What protects the money on such a document
 * is the anchor: the claim total IS printed, and it reconciles to the cheque
 * exactly, with no tolerance.
 *
 * @param {Map<string, Record<string, unknown>>} index from `indexConfirmations`
 * @param {{ claimId: string, totalPaidCents: number|null, lines: Array<object> }} claim
 *   with `lines` from `effectiveLines`
 */
function claimLineSum(index, claim) {
  const lines = countableLines(claim && claim.lines);
  const claimTotalCents = centsOrNull(claim && claim.totalPaidCents);

  const paid = lines.map((line) => {
    const found = (line.fields || []).find((f) => f.field === 'line_paid');
    return found || { cents: null, stated: false, confirmed: false };
  });
  const unstated = paid.filter((p) => !p.stated);
  const unstatedAndUnconfirmed = unstated.filter((p) => !p.confirmed);

  const lineSumCents =
    lines.length === 0 || unstated.length > 0
      ? null
      : paid.reduce((n, p) => n + /** @type {number} */ (p.cents), 0);

  if (lineSumCents === null) {
    return {
      lineCount: lines.length,
      comparable: false,
      lineSumCents: null,
      claimTotalCents,
      differenceCents: null,
      unstatedCount: unstated.length,
      unconfirmedUnstatedCount: unstatedAndUnconfirmed.length,
      /*
       * A claim with NO countable lines at all cannot pass this way. Every line
       * struck, or none read, leaves nothing that was checked against a page —
       * and "the claim total stands on its own" is a statement about a document
       * that states payment by category, not about one with no lines.
       */
      ok: lines.length > 0 && unstatedAndUnconfirmed.length === 0,
    };
  }

  if (claimTotalCents === null) {
    return {
      lineCount: lines.length,
      comparable: false,
      lineSumCents,
      claimTotalCents: null,
      differenceCents: null,
      unstatedCount: 0,
      unconfirmedUnstatedCount: 0,
      ok: false,
    };
  }

  const differenceCents = lineSumCents - claimTotalCents;
  return {
    lineCount: lines.length,
    comparable: true,
    lineSumCents,
    claimTotalCents,
    differenceCents,
    unstatedCount: 0,
    unconfirmedUnstatedCount: 0,
    /** EXACT. A cent of disagreement is a cent somebody has to account for. */
    ok: differenceCents === 0,
  };
}

module.exports = {
  QUERIES,
  FIELD_COLUMNS,
  LINE_SCOPED_FIELDS,
  extractedFor,
  scopeKey,
  indexConfirmations,
  figure,
  requiredFields,
  allConfirmed,
  sumsToCheck,
  isOcrSourced,
  // ── lines a person added, and lines a person struck ──
  strikeKey,
  indexAddedLines,
  indexStrikes,
  addedFigure,
  effectiveLines,
  countableLines,
  hasAddedLine,
  claimLineSum,
};
