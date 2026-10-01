'use strict';

/**
 * THE CONFIRM STEP for a check whose figures were read off a scan.
 *
 *   GET  /api/rcm/field-confirm/:batchId?office=…   what the screen renders
 *   POST /api/rcm/field-confirm/:batchId?office=…   confirm or correct fields
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SCREEN EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The first real scanned EOB was a category-subtotal layout. The read promoted
 * each line's COVERED amount into PAID and one line showed a fabricated
 * $1,229.00. The warnings fired and approve was blocked, so no money moved —
 * but a biller was looking at numbers that were not on the page, and a refusal
 * she cannot check against the document asks her to trust a reader she cannot
 * see.
 *
 * So: the page beside the figures, and one decision per field — that is what it
 * says, or here is what it actually says.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TYPING A FIGURE HERE IS TRANSCRIPTION, NOT A DECISION (owner ruling)
 * ─────────────────────────────────────────────────────────────────────────────
 * The module's no-amount-fields rule governs DECISIONS — writing an amount off,
 * billing a patient — where a typed number CREATES money movement out of
 * somebody's judgement. It is untouched.
 *
 * This is the opposite act: the figure already exists, printed on paper, and the
 * person is copying it across. Refusing her a text box would mean the only way
 * to fix a misread $1,229.00 is to re-upload and hope, which is how a review
 * step becomes something people route around. The ruling is scoped to THIS
 * screen and nothing else may read it as precedent.
 *
 * What makes it safe is the trail: every correction records who, when, and the
 * figure the machine produced, and the screen then says "corrected by <name>
 * from the page image" under that number for as long as it exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SERVER DECIDES WHAT WAS EXTRACTED. THE CLIENT ONLY SAYS WHAT IT READS.
 * ─────────────────────────────────────────────────────────────────────────────
 * A request carries a field and a figure — never the extracted value it is
 * being compared against. `extracted_cents` is read here, from the extraction
 * rows, inside the same transaction, and `state` is derived from the comparison.
 * A client that could supply both could file a correction as an agreement and
 * the "corrected by" line would never appear.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO OPEN DENTAL, AND NOTHING IS OVERWRITTEN
 * ─────────────────────────────────────────────────────────────────────────────
 * No OD module is in this file's require graph. Nothing here updates
 * `rcm_claims`, `rcm_procedure_lines` or `raw_extracted_json`: a confirmation is
 * a second opinion recorded beside the first.
 */

const express = require('express');

const tenantDb = require('../../platform/tenantDb');
const { audit } = require('../../platform/audit');
const confirmedFigures = require('../../services/rcm/confirmedFigures');
const rcmVocabulary = require('../../services/rcm/rcmVocabulary');
const { resolveRcmActor, describeActors } = require('../../services/rcm/rcmUserMap');
const { h, actorEmail, auditRcmRead, auditRcmDenial, num, iso } = require('./helpers');

const router = express.Router();

/** The most fields one request may confirm. A line is five; a claim is six. */
const MAX_FIELDS_PER_REQUEST = 200;

/**
 * Every query this route owns, hoisted for `scripts/rcm-verify-queries.js`.
 * Columns named explicitly, per the repo rule.
 */
const QUERIES = Object.freeze({
  batch: `
    SELECT batch_id, office_id, payer, check_number, deposit_date, total_amount_cents
      FROM rcm_payment_batches
     WHERE office_id = $1 AND batch_id = $2
  `,
  provenance: `
    SELECT upload_id, text_source, ocr_page_count, ocr_mean_confidence
      FROM rcm_eob_uploads
     WHERE office_id = $1 AND result_batch_id = $2
  `,
  /*
   * WHICH CLAIMS ARE ON THIS CHECK, AND THEN THE CLAIMS — two office-scoped
   * reads rather than one join.
   *
   * `approvalGate.loadForApproval` is shaped the same way and says why: every
   * read in this module is a flat office-scoped SELECT, and a join here would be
   * the only one. It also keeps the batch's own `position` as the ordering, so
   * the confirm screen lists claims in the order the remittance prints them.
   */
  batchClaims: `
    SELECT claim_id, position FROM rcm_batch_claim_payments
     WHERE office_id = $1 AND batch_id = $2
     ORDER BY position ASC
  `,
  claims: `
    SELECT claim_id, patient_name, claim_number, service_date, total_paid_cents
      FROM rcm_claims
     WHERE office_id = $1 AND claim_id = ANY($2::uuid[])
  `,
  lines: `
    SELECT line_id, claim_id, position, code, description,
           billed_cents, allowed_cents, deductible_cents, copay_cents, paid_cents
      FROM rcm_procedure_lines
     WHERE office_id = $1 AND claim_id = ANY($2::uuid[])
     ORDER BY claim_id, position ASC
  `,
  /**
   * THE UPSERT. One current answer per scope+field.
   *
   * `ON CONFLICT` names the unique index's columns; the index is
   * NULLS NOT DISTINCT, so a re-confirmation of the check total updates the one
   * row rather than inserting a second. History lives in `audit_log`, which is
   * append-only by grant.
   */
  upsert: `
    INSERT INTO rcm_eob_field_confirmations
      (office_id, batch_id, claim_id, line_id, field, state,
       extracted_cents, confirmed_cents, confirmed_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (office_id, batch_id, claim_id, line_id, field)
    DO UPDATE SET state = EXCLUDED.state,
                  extracted_cents = EXCLUDED.extracted_cents,
                  confirmed_cents = EXCLUDED.confirmed_cents,
                  confirmed_by = EXCLUDED.confirmed_by,
                  confirmed_at = now(),
                  updated_at = now()
    RETURNING confirmation_id, claim_id, line_id, field, state,
              extracted_cents, confirmed_cents, confirmed_by, confirmed_at
  `,
  /** A line a person read off the page and typed in. */
  insertAddedLine: `
    INSERT INTO rcm_eob_added_lines
      (office_id, batch_id, claim_id, code, description,
       billed_cents, allowed_cents, deductible_cents, copay_cents, paid_cents, added_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING added_line_id, claim_id, code, added_at
  `,
  /**
   * A line a person says is not on the page.
   *
   * Exactly one of `line_id` / `added_line_id` is non-null, which the table's own
   * `num_nonnulls` CHECK enforces. The route refuses the ambiguous request first,
   * so the constraint is a backstop and not the sentence a biller reads.
   */
  insertStrike: `
    INSERT INTO rcm_eob_line_strikes
      (office_id, batch_id, claim_id, line_id, added_line_id, reason, struck_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING strike_id, claim_id, line_id, added_line_id, reason, struck_by, struck_at
  `,
  /**
   * TAKING A STRIKE BACK — an UPDATE, never a DELETE.
   *
   * `withdrawn_at IS NULL` in the WHERE, so a withdrawal is one statement rather
   * than a read followed by a write: two people pressing it at once leaves one
   * row withdrawn once, and the second finds nothing to withdraw.
   */
  withdrawStrike: `
    UPDATE rcm_eob_line_strikes
       SET withdrawn_at = now(), withdrawn_by = $3, updated_at = now()
     WHERE office_id = $1 AND strike_id = $2 AND withdrawn_at IS NULL
    RETURNING strike_id, claim_id, line_id, added_line_id, withdrawn_at
  `,
});

/**
 * Read everything the confirm step needs for one check.
 *
 * Returns null when there is no such batch for this office — the row is read
 * with `office_id` IN THE WHERE, so another practice's check is NOT FOUND
 * rather than found and refused.
 */
async function loadForConfirm(client, office, batchId) {
  const batches = await client.query(QUERIES.batch, [office, batchId]);
  if (batches.rows.length === 0) return null;
  const batch = batches.rows[0];

  const [uploads, links, confirmations, addedLines, strikes] = await Promise.all([
    client.query(QUERIES.provenance, [office, batchId]),
    client.query(QUERIES.batchClaims, [office, batchId]),
    client.query(confirmedFigures.QUERIES.readForBatch, [office, batchId]),
    /*
     * The lines a person typed in off the page, and the ones she struck as not on
     * it. Both read here so `shapeState` can assemble a claim's REAL lines
     * through the one accessor, rather than the extraction's.
     */
    client.query(confirmedFigures.QUERIES.readAddedLinesForBatch, [office, batchId]),
    client.query(confirmedFigures.QUERIES.readStrikesForBatch, [office, batchId]),
  ]);

  // The batch's own order is the order the remittance prints its claims in, so
  // it is the order the screen works down.
  const claimIds = links.rows.map((r) => String(r.claim_id));
  const claimRows = claimIds.length
    ? (await client.query(QUERIES.claims, [office, claimIds])).rows
    : [];
  const byId = new Map(claimRows.map((c) => [String(c.claim_id), c]));
  const claims = claimIds.map((id) => byId.get(id)).filter(Boolean);
  const lines = claimIds.length
    ? (await client.query(QUERIES.lines, [office, claimIds])).rows
    : [];

  const linesByClaim = new Map(claimIds.map((id) => [id, []]));
  for (const line of lines) {
    const bucket = linesByClaim.get(String(line.claim_id));
    if (bucket) bucket.push(line);
  }

  const upload = uploads.rows[0] || null;
  return {
    batch,
    claims,
    linesByClaim,
    confirmations: confirmations.rows,
    addedLineRows: addedLines.rows,
    strikeRows: strikes.rows,
    provenance: upload
      ? {
          uploadId: String(upload.upload_id),
          textSource: upload.text_source || null,
          ocrPageCount: upload.ocr_page_count == null ? null : num(upload.ocr_page_count),
          ocrMeanConfidence:
            upload.ocr_mean_confidence == null ? null : Number(upload.ocr_mean_confidence),
        }
      : null,
  };
}

/**
 * One field, as the screen renders it.
 *
 * `figure()` decides which number is real; this only shapes it for the wire and
 * attaches the name the trail carries.
 */
function toWireField({ field, claimId, lineId, index, extracted, actorNames }) {
  const f = confirmedFigures.figure(index, { claimId, lineId, field }, extracted);
  return {
    field,
    cents: f.cents,
    stated: f.stated,
    source: f.source,
    confirmed: f.confirmed,
    extractedCents: f.extractedCents,
    confirmedAt: f.confirmedAt,
    /*
     * A NAME, not a crosswalk key. The screen prints "corrected by <name> from
     * the page image", and a key would make that sentence unreadable.
     * `describeActors` is the module's one key→name resolver; it returns a plain
     * object keyed by user_key, and an unknown key resolves to null rather than
     * to the key itself.
     */
    confirmedBy: f.confirmedByKey
      ? (actorNames[f.confirmedByKey] && actorNames[f.confirmedByKey].displayName) || null
      : null,
  };
}

/** The five line-scoped fields, in vocabulary order. */
const LINE_FIELDS = rcmVocabulary.CONFIRMABLE_FIELDS.filter(
  (f) => rcmVocabulary.fieldScope(f) === 'line'
);

/**
 * THE WHOLE SCREEN STATE, SHAPED ONCE — and the reason the GET and the POST
 * cannot drift apart.
 *
 * Both responses are built here. The POST returns the same payload the GET
 * would, recomputed after its writes, so a saving client has the server's own
 * answer about every derived thing — `state`, `outstanding`, `sums` — without a
 * second round trip.
 *
 * That is what makes an in-place save honest rather than a guess. The previous
 * shape returned only the rows it wrote, which left the screen two bad options:
 * re-fetch the page (which threw both panes back to the top, the defect this
 * slice fixes) or recompute the derived state in the browser (a second opinion
 * about which number is real, which is the thing the whole slice exists to
 * prevent). Neither is necessary once the server simply says what it now holds.
 */
function shapeState({ office, loaded, actorNames }) {
  const { batch, claims, linesByClaim, confirmations, provenance } = loaded;
  const index = confirmedFigures.indexConfirmations(confirmations);
  const addedLines = confirmedFigures.indexAddedLines(loaded.addedLineRows || []);
  const strikes = confirmedFigures.indexStrikes(loaded.strikeRows || []);

  /** A key the actor map may or may not know. A stranger resolves to null. */
  const nameOf = (key) =>
    key ? (actorNames[key] && actorNames[key].displayName) || null : null;

  const wireClaims = claims.map((claim) => {
    const claimId = String(claim.claim_id);
    const effective = confirmedFigures.effectiveLines({
      claimId,
      extracted: linesByClaim.get(claimId) || [],
      added: addedLines,
      strikes,
      index,
    });
    return {
      claimId,
      patientName: claim.patient_name || null,
      claimNumber: claim.claim_number || null,
      serviceDate: claim.service_date ? String(claim.service_date).slice(0, 10) : null,
      totalPaid: toWireField({
        field: 'claim_total_paid',
        claimId,
        lineId: null,
        index,
        extracted: confirmedFigures.extractedFor('claim_total_paid', claim),
        actorNames,
      }),
      /*
       * THE CLAIM'S REAL LINES, through the one accessor.
       *
       * What the read produced, minus what a person struck as not on the page,
       * plus what she typed in because the read missed it. The screen does not
       * assemble that itself and neither does the gate: `effectiveLines` is the
       * only thing that decides it, the way `figure()` is the only thing that
       * decides which figure is real.
       *
       * `region` comes back null for every line. The stored OCR result carries NO
       * geometry — `documentOcr.summarize` keeps text, page count, word count and
       * mean confidence and discards Azure's polygons — and re-running OCR to
       * recover a box would spend money to redraw it. An explicit null is the
       * honest "we do not know where on the page this came from", and the seam a
       * later slice fills.
       */
      lines: effective.map((line) => ({
        lineId: line.lineId,
        /** `extracted` or `added`. The screen marks a hand-entered line as one. */
        kind: line.kind,
        position: line.position,
        code: line.code,
        description: line.description,
        region: line.region,
        /**
         * NOT ON THE PAGE, said by a person, with a reason.
         *
         * A struck line is sent and rendered, not dropped. A line that silently
         * vanished would be a claim whose arithmetic changed with nothing on
         * screen to account for it — and the only way back from a mis-strike is to
         * be able to see the strike.
         */
        struck: line.struck
          ? {
              reason: line.struck.reason,
              struckBy: nameOf(line.struck.struckByKey),
              struckAt: line.struck.struckAt,
            }
          : null,
        fields: line.fields.map((f) => ({
          field: f.field,
          cents: f.cents,
          stated: f.stated,
          source: f.source,
          confirmed: f.confirmed,
          extractedCents: f.extractedCents,
          confirmedAt: f.confirmedAt,
          confirmedBy: nameOf(f.confirmedByKey),
        })),
      })),
      /**
       * DOES THIS CLAIM'S LINES ADD UP TO WHAT IT WAS PAID?
       *
       * The same `claimLineSum` the approval gate refuses on, rendered here as a
       * line a biller can read. It is the figure that goes from "does not add up"
       * to "adds up" when she types in the line the scan missed — which is the
       * whole reason adding a line is not a bypass.
       */
      lineSum: confirmedFigures.claimLineSum(index, {
        claimId,
        totalPaidCents: confirmedFigures.extractedFor('claim_total_paid', claim),
        lines: effective,
      }),
    };
  });

  /*
   * `kind` and `struck` travel into the count, because they change what is still
   * to do: a struck line asks for nothing, and an added line is already answered.
   * `requiredFields` reads them, and a shape that dropped them would count work
   * that can never be done.
   */
  const shape = wireClaims.map((c) => ({
    claimId: c.claimId,
    lines: c.lines.map((l) => ({ lineId: l.lineId, kind: l.kind, struck: l.struck })),
  }));

  return {
    office,
    batchId: String(batch.batch_id),
    payer: batch.payer || null,
    checkNumber: batch.check_number || null,
    depositDate: batch.deposit_date ? String(batch.deposit_date).slice(0, 10) : null,
    /**
     * THE ANCHOR, as its own top-level field rather than one of the claims'.
     * It is the screen's first line, and everything else reconciles to it.
     */
    checkTotal: toWireField({
      field: 'check_total',
      claimId: null,
      lineId: null,
      index,
      extracted: confirmedFigures.extractedFor('check_total', batch),
      actorNames,
    }),
    /**
     * Whether this check needs the step at all. An 835 and a text-layer PDF
     * return `false`, and the screen then says so rather than rendering an
     * empty confirm list that looks broken.
     */
    required: confirmedFigures.isOcrSourced(provenance),
    provenance,
    claims: wireClaims,
    outstanding: confirmedFigures.allConfirmed(index, shape),
    sums: confirmedFigures.sumsToCheck(index, {
      checkTotalCents: confirmedFigures.extractedFor('check_total', batch),
      claims: wireClaims.map((c) => ({
        claimId: c.claimId,
        totalPaidCents: c.totalPaid.extractedCents,
      })),
    }),
    /**
     * THE CHECK SNAPSHOT SLOT (addendum item 2).
     *
     * Reserved beside the anchor and rendered only when an image exists on the
     * record. Nothing in this slice uploads or captures one, so it is always
     * null — the slot renders nothing until that separate slice lands. It is
     * here now so the layout is built around it rather than retrofitted.
     */
    checkImage: null,
  };
}

/**
 * The names behind everything this screen attributes to a person.
 *
 * EVERY ACTOR KEY ON THE CHECK, not just the confirmations'. A line a person
 * added and a line she struck each carry their own author, and the screen prints
 * all three in sentences — "added by <name> from the page image", "struck by
 * <name>". Resolving only the confirmations left the mark on an added line with
 * no name on it, which is a trail that does not say who.
 *
 * `describeActors` is the module's one key→name resolver; an unknown key
 * resolves to null rather than to the key itself, so a stranger is anonymous
 * rather than rendered as a crosswalk id.
 */
function namesFor(req, loaded) {
  const keys = [
    ...(loaded.confirmations || []).map((c) => c.confirmed_by),
    ...(loaded.addedLineRows || []).map((r) => r.added_by),
    ...(loaded.strikeRows || []).flatMap((r) => [r.struck_by, r.withdrawn_by]),
  ].filter(Boolean);
  return tenantDb.withTenantDb(req, (pool) => describeActors(pool, keys));
}

// ─── GET — what the screen renders ───────────────────────────────────────────

router.get(
  '/:batchId',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.batchId || '');

    const loaded = await tenantDb.withTenantDb(req, (pool) =>
      loadForConfirm(pool, office, batchId)
    );
    if (!loaded) {
      await auditRcmDenial(req, 'rcm_eob_field_confirmation', batchId, { office });
      return res.status(404).json({
        success: false,
        error: 'No such check for this office.',
        code: 'BATCH_NOT_FOUND',
      });
    }

    // Patient names travel in this payload, so the read is a PHI read and
    // audits like one — before a byte of it is serialised.
    await auditRcmRead(req, 'rcm_eob_field_confirmation', { office, resourceId: batchId });

    const actorNames = await namesFor(req, loaded);
    return res.json({ success: true, ...shapeState({ office, loaded, actorNames }) });
  })
);

// ─── POST — confirm, or correct from the page ────────────────────────────────

/**
 * Validate one requested field against the vocabulary and the rows.
 *
 * Returns a refusal object or a normalised instruction. Every failure names the
 * field, because a request confirming a line's five figures must not fail with
 * a sentence that could be about any of them.
 */
function validateField(raw, { claimsById, linesById }) {
  const field = String((raw && raw.field) || '');
  const scope = rcmVocabulary.fieldScope(field);
  if (!scope) {
    return { error: `'${field}' is not a field this step can confirm.`, code: 'UNKNOWN_FIELD' };
  }

  const claimId = raw && raw.claimId ? String(raw.claimId) : null;
  const lineId = raw && raw.lineId ? String(raw.lineId) : null;

  // The scope rules, checked here so the DB CHECK is a backstop and not the
  // error message a biller sees.
  if (scope === 'check' && (claimId || lineId)) {
    return { error: `'${field}' is a field on the check, not on a claim or a line.`, code: 'FIELD_SCOPE' };
  }
  if (scope === 'claim' && (!claimId || lineId)) {
    return { error: `'${field}' is a field on a claim.`, code: 'FIELD_SCOPE' };
  }
  if (scope === 'line' && (!claimId || !lineId)) {
    return { error: `'${field}' is a field on a procedure line.`, code: 'FIELD_SCOPE' };
  }

  if (claimId && !claimsById.has(claimId)) {
    return { error: 'That claim is not on this check.', code: 'CLAIM_NOT_ON_CHECK' };
  }
  if (lineId) {
    const line = linesById.get(lineId);
    if (!line || String(line.claim_id) !== claimId) {
      return { error: 'That procedure line is not on that claim.', code: 'LINE_NOT_ON_CLAIM' };
    }
  }

  /*
   * THE FIGURE. `null` is a legal, meaningful value: "I read the page and it
   * genuinely does not state this."
   *
   * `undefined` is not — a request that omits the key is a client bug, and
   * treating it as null would silently record "the page says nothing" on a
   * field nobody looked at.
   */
  const hasValue = raw && Object.prototype.hasOwnProperty.call(raw, 'confirmedCents');
  if (!hasValue) {
    return {
      error: `'${field}' was sent with no figure. Send a number, or null for "not stated".`,
      code: 'FIGURE_MISSING',
    };
  }
  const value = raw.confirmedCents;
  if (value !== null && !Number.isInteger(value)) {
    return {
      error: `'${field}' must be a whole number of cents, or null.`,
      code: 'FIGURE_NOT_AN_INTEGER',
    };
  }
  if (value !== null && value < 0) {
    // A negative figure on an EOB is a takeback, which is a different lane with
    // its own confirmation. It is not something to transcribe here.
    return {
      error: `'${field}' cannot be negative. A takeback is handled from the takeback panel.`,
      code: 'FIGURE_NEGATIVE',
    };
  }

  return { field, scope, claimId, lineId, confirmedCents: value };
}

router.post(
  '/:batchId',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.batchId || '');
    const requested = req.body && Array.isArray(req.body.fields) ? req.body.fields : null;

    if (!requested || requested.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Send one or more fields to confirm.',
        code: 'NO_FIELDS',
      });
    }
    if (requested.length > MAX_FIELDS_PER_REQUEST) {
      return res.status(400).json({
        success: false,
        error: `That is more than ${MAX_FIELDS_PER_REQUEST} fields in one request.`,
        code: 'TOO_MANY_FIELDS',
      });
    }

    const result = await tenantDb.withTenantDb(req, async (pool) => {
      const client = pool;
      const loaded = await loadForConfirm(client, office, batchId);
      if (!loaded) return { notFound: true };

      /*
       * ONLY A SCANNED READ IS CONFIRMED.
       *
       * An 835's figures are delimited data — there is no page to check them
       * against, and a confirmation recorded against one would be a row
       * asserting that somebody verified something unverifiable.
       */
      if (!confirmedFigures.isOcrSourced(loaded.provenance)) {
        return { notConfirmable: true };
      }

      const claimsById = new Map(loaded.claims.map((c) => [String(c.claim_id), c]));
      const linesById = new Map();
      for (const lines of loaded.linesByClaim.values()) {
        for (const line of lines) linesById.set(String(line.line_id), line);
      }

      /** @type {Array<object>} */
      const instructions = [];
      for (const raw of requested) {
        const validated = validateField(raw, { claimsById, linesById });
        if (validated.error) return { refusal: validated };
        instructions.push(validated);
      }

      // A request naming the same field twice would upsert it twice in one
      // transaction — the second winning silently. Refuse instead: two figures
      // for one field is a client that does not know what it is asking.
      const seen = new Set();
      for (const i of instructions) {
        const key = confirmedFigures.scopeKey(i.claimId, i.lineId, i.field);
        if (seen.has(key)) {
          return {
            refusal: { error: `'${i.field}' was sent twice in one request.`, code: 'DUPLICATE_FIELD' },
          };
        }
        seen.add(key);
      }

      const confirmedBy = await resolveRcmActor(client, {
        email: actorEmail(req),
        displayName: (req.user && (req.user.name || req.user.displayName)) || '',
      });

      /** @type {Array<object>} */
      const written = [];
      for (const i of instructions) {
        /*
         * THE EXTRACTED FIGURE COMES FROM THE ROWS, NOT THE REQUEST. See the
         * header: a client that supplied both sides of the comparison could file
         * a correction as an agreement.
         */
        const row =
          i.scope === 'check'
            ? loaded.batch
            : i.scope === 'claim'
              ? claimsById.get(i.claimId)
              : linesById.get(i.lineId);
        const extracted = confirmedFigures.extractedFor(i.field, row);

        // `IS DISTINCT FROM`, in JavaScript: null and a number differ, and two
        // nulls do not. The migration's CHECK asserts the same comparison, so
        // disagreeing with it here is a rejected INSERT rather than a bad row.
        const state = extracted === i.confirmedCents ? 'confirmed' : 'corrected';

        const upserted = await client.query(QUERIES.upsert, [
          office,
          batchId,
          i.claimId,
          i.lineId,
          i.field,
          state,
          extracted === undefined ? null : extracted,
          i.confirmedCents,
          confirmedBy,
        ]);
        written.push(upserted.rows[0]);
      }

      /*
       * RE-READ THE CONFIRMATIONS, INSIDE THE SAME TRANSACTION.
       *
       * So the response can carry the whole screen state as it now stands —
       * which is what lets the client save in place instead of re-fetching the
       * page and throwing both panes back to the top.
       *
       * The rows just written are not simply merged in: a request may confirm
       * five fields of which two were already confirmed, and the upsert's
       * RETURNING gives the new state of those five only. One indexed read gives
       * the state of all of them, and it is the same query the GET uses, so the
       * two responses cannot describe the check differently.
       */
      const refreshed = await client.query(confirmedFigures.QUERIES.readForBatch, [
        office,
        batchId,
      ]);

      return { written, loaded: { ...loaded, confirmations: refreshed.rows } };
    });

    if (result.notFound) {
      await auditRcmDenial(req, 'rcm_eob_field_confirmation', batchId, { office });
      return res.status(404).json({
        success: false,
        error: 'No such check for this office.',
        code: 'BATCH_NOT_FOUND',
      });
    }
    if (result.notConfirmable) {
      return res.status(409).json({
        success: false,
        error:
          'This check was not read from a scan, so there is nothing to check against a page image.',
        code: 'NOT_A_SCANNED_CHECK',
      });
    }
    if (result.refusal) {
      return res.status(400).json({ success: false, ...result.refusal });
    }

    /*
     * ONE AUDIT ROW PER FIELD, written after the fact.
     *
     * Per field rather than per request, because the trail's unit has to be the
     * unit of the decision: "she confirmed this line's five figures" and "she
     * corrected the paid amount on line 3" are different events, and a single
     * row covering a request would flatten them.
     */
    for (const row of result.written) {
      await audit(req, {
        action: 'UPDATE',
        resourceType: 'rcm_eob_field_confirmation',
        resourceId: String(row.confirmation_id),
        result: 'SUCCESS',
        office,
        sourceRef: batchId,
      });
    }

    /*
     * THE WHOLE STATE BACK, NOT JUST THE ROWS WRITTEN.
     *
     * `state` is the identical payload a GET would return, recomputed here. The
     * screen replaces what it holds with it and re-renders in place: the
     * document viewer and the figure list keep their scroll positions because
     * neither unmounts, and nothing in the browser has to work out what the
     * outstanding count or the sum against the anchor now is.
     *
     * `confirmed` stays — it names exactly what THIS request changed, which is
     * what the screen needs to know where to move next and what to say it did.
     */
    const actorNames = await namesFor(req, result.loaded);

    return res.json({
      success: true,
      office,
      batchId,
      state: shapeState({ office, loaded: result.loaded, actorNames }),
      confirmed: result.written.map((row) => ({
        field: String(row.field),
        claimId: row.claim_id ? String(row.claim_id) : null,
        lineId: row.line_id ? String(row.line_id) : null,
        state: String(row.state),
        cents: row.confirmed_cents == null ? null : num(row.confirmed_cents),
        extractedCents: row.extracted_cents == null ? null : num(row.extracted_cents),
        confirmedAt: iso(row.confirmed_at),
      })),
    });
  })
);

// ─── POST — a line the scan missed, and a line it invented ───────────────────

/**
 * WHAT A LINE A PERSON TYPES IN HAS TO CARRY.
 *
 * The same five money fields the extraction stores and the confirm step
 * confirms, so an added line and a read line are the same shape to everything
 * downstream. Each key must be PRESENT in the request; `null` is legal and
 * means "the page does not state this for this line", which is the ordinary case
 * on a category-subtotal EOB. An OMITTED key is a client bug, and defaulting it
 * to null would record "the page says nothing" about a figure nobody looked at —
 * the same class of lie as inventing a number for it.
 */
const ADDED_LINE_FIGURES = Object.freeze([
  ['billedCents', 'line_billed'],
  ['allowedCents', 'line_allowed'],
  ['deductibleCents', 'line_deductible'],
  ['copayCents', 'line_copay'],
  ['paidCents', 'line_paid'],
]);

/** Longest procedure code and description this route will store. */
const MAX_CODE_LENGTH = 32;
const MAX_TEXT_LENGTH = 200;

/**
 * Validate the body of an add-a-line request.
 *
 * Returns a refusal or a normalised row. Every refusal names the field, because
 * a request carrying five figures must not fail with a sentence that could be
 * about any of them.
 */
function validateAddedLine(body) {
  const code = String((body && body.code) || '').trim();
  if (!code) {
    return { error: 'A line needs the procedure code printed beside it.', code: 'CODE_MISSING' };
  }
  if (code.length > MAX_CODE_LENGTH) {
    return { error: 'That procedure code is too long to be one.', code: 'CODE_TOO_LONG' };
  }

  const description = String((body && body.description) || '').trim();
  if (description.length > MAX_TEXT_LENGTH) {
    return { error: 'That description is too long.', code: 'DESCRIPTION_TOO_LONG' };
  }

  /** @type {Record<string, number|null>} */
  const figures = {};
  for (const [key, field] of ADDED_LINE_FIGURES) {
    if (!body || !Object.prototype.hasOwnProperty.call(body, key)) {
      return {
        error: `'${field}' was sent with no figure. Send a number, or null for "not stated".`,
        code: 'FIGURE_MISSING',
      };
    }
    const value = body[key];
    if (value === null) {
      figures[key] = null;
      continue;
    }
    if (!Number.isInteger(value)) {
      return {
        error: `'${field}' must be a whole number of cents, or null.`,
        code: 'FIGURE_NOT_AN_INTEGER',
      };
    }
    if (value < 0) {
      // Same rule as a correction: a negative figure on an EOB is a takeback,
      // which is its own lane with its own acknowledgement. It is not something
      // to transcribe here.
      return {
        error: `'${field}' cannot be negative. A takeback is handled from the takeback panel.`,
        code: 'FIGURE_NEGATIVE',
      };
    }
    figures[key] = value;
  }

  return { code, description: description || null, figures };
}

/**
 * ADD A LINE THE SCAN MISSED.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A BYPASS
 * ─────────────────────────────────────────────────────────────────────────────
 * A read that misses a line leaves a claim whose lines do not sum to its total,
 * and `CLAIM_TOTALS_AGREE` refuses it. That refusal is one a biller can do
 * nothing about: every figure on screen is right, and the missing one is not on
 * screen to correct. Typing it in is how an incomplete read becomes able to
 * reconcile — the added line counts in the sum exactly like a read one, so the
 * arithmetic goes from "does not add up" to "adds up" by becoming MORE complete,
 * never by being relaxed.
 *
 * And it does not open the posting path. A hand-entered line has no ClaimProcNum
 * and this slice does not extend the posting spine to give it one, so the gate's
 * `LINES_UNEDITED_BY_HAND` withholds the claim by name and says to post it in
 * Open Dental by hand. The arithmetic becoming honest and the money moving are
 * two different permissions.
 *
 * `rcm.write` through the mount's method gate, same tier as a correction.
 */
router.post(
  '/:batchId/claims/:claimId/lines',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.batchId || '');
    const claimId = String(req.params.claimId || '');

    const validated = validateAddedLine(req.body);
    if (validated.error) {
      return res.status(400).json({ success: false, ...validated });
    }

    const result = await tenantDb.withTenantDb(req, async (client) => {
      const loaded = await loadForConfirm(client, office, batchId);
      if (!loaded) return { notFound: true };

      /*
       * ONLY A SCANNED READ GETS A HAND-ENTERED LINE.
       *
       * An 835's service lines are delimited data — the file either carries a
       * line or it does not, and there is no page a person could be reading one
       * off. A row added against one would assert a line somebody transcribed
       * from a document that is not a document.
       */
      if (!confirmedFigures.isOcrSourced(loaded.provenance)) return { notConfirmable: true };

      if (!loaded.claims.some((c) => String(c.claim_id) === claimId)) {
        return {
          refusal: { error: 'That claim is not on this check.', code: 'CLAIM_NOT_ON_CHECK' },
        };
      }

      const addedBy = await resolveRcmActor(client, {
        email: actorEmail(req),
        displayName: (req.user && (req.user.name || req.user.displayName)) || '',
      });

      const inserted = await client.query(QUERIES.insertAddedLine, [
        office,
        batchId,
        claimId,
        validated.code,
        validated.description,
        validated.figures.billedCents,
        validated.figures.allowedCents,
        validated.figures.deductibleCents,
        validated.figures.copayCents,
        validated.figures.paidCents,
        addedBy,
      ]);

      return { row: inserted.rows[0], loaded: await loadForConfirm(client, office, batchId) };
    });

    if (result.notFound) {
      await auditRcmDenial(req, 'rcm_eob_added_line', batchId, { office });
      return res.status(404).json({
        success: false,
        error: 'No such check for this office.',
        code: 'BATCH_NOT_FOUND',
      });
    }
    if (result.notConfirmable) {
      return res.status(409).json({
        success: false,
        error:
          'This check was not read from a scan, so there is no page image to read a missing line off.',
        code: 'NOT_A_SCANNED_CHECK',
      });
    }
    if (result.refusal) {
      return res.status(400).json({ success: false, ...result.refusal });
    }

    /*
     * AUDITED AS A CREATE, one row per added line.
     *
     * The trail's unit is the unit of the act: she read a line off the page and
     * entered it. `sourceRef` is the check, which is how the trail joins back to
     * the document the line was read from.
     */
    await audit(req, {
      action: 'CREATE',
      resourceType: 'rcm_eob_added_line',
      resourceId: String(result.row.added_line_id),
      result: 'SUCCESS',
      office,
      sourceRef: batchId,
    });

    const actorNames = await namesFor(req, result.loaded);
    return res.json({
      success: true,
      office,
      batchId,
      addedLineId: String(result.row.added_line_id),
      state: shapeState({ office, loaded: result.loaded, actorNames }),
    });
  })
);

/**
 * STRIKE A LINE AS NOT ON THE PAGE — or take that back.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MIRROR OF ADDING ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * A scanned read can invent a line as easily as it can miss one: a subtotal row
 * read as a procedure, a carried-forward balance read as a payment. The line is
 * on the screen and is not on the page, and no correction to its figures makes it
 * true.
 *
 * NOTHING IS DELETED. The extraction row stays exactly as the read produced it,
 * and the strike is a row saying a person looked at the page and that line is not
 * there — with a reason, because a line leaving a claim's arithmetic with no
 * recorded reason is money that changed and cannot be accounted for.
 *
 * AND IT CAN BE TAKEN BACK. Striking a real line removes it from the sum, so a
 * strike pressed by mistake would otherwise leave a check that can never
 * reconcile and a biller with nothing to press. A withdrawal is an UPDATE, not a
 * DELETE: the trail says she struck it and then changed her mind, and both of
 * those are true.
 */
router.post(
  '/:batchId/strikes',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.batchId || '');
    const body = req.body || {};

    const claimId = body.claimId ? String(body.claimId) : null;
    const lineId = body.lineId ? String(body.lineId) : null;
    const addedLineId = body.addedLineId ? String(body.addedLineId) : null;
    /** Default true: a request that says nothing is striking, not withdrawing. */
    const striking = body.struck !== false;
    const reason = String(body.reason || '').trim();

    if (!claimId) {
      return res.status(400).json({
        success: false,
        error: 'Say which claim the line is on.',
        code: 'CLAIM_MISSING',
      });
    }
    if (Boolean(lineId) === Boolean(addedLineId)) {
      return res.status(400).json({
        success: false,
        error: 'Name exactly one line: one the scan read, or one that was added by hand.',
        code: 'ONE_LINE_ONLY',
      });
    }
    if (striking && !reason) {
      return res.status(400).json({
        success: false,
        error: 'Say why this is not a line on the page.',
        code: 'REASON_MISSING',
      });
    }
    if (reason.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({
        success: false,
        error: 'That reason is too long.',
        code: 'REASON_TOO_LONG',
      });
    }

    const result = await tenantDb.withTenantDb(req, async (client) => {
      const loaded = await loadForConfirm(client, office, batchId);
      if (!loaded) return { notFound: true };
      if (!confirmedFigures.isOcrSourced(loaded.provenance)) return { notConfirmable: true };

      if (!loaded.claims.some((c) => String(c.claim_id) === claimId)) {
        return {
          refusal: { error: 'That claim is not on this check.', code: 'CLAIM_NOT_ON_CHECK' },
        };
      }

      /*
       * THE LINE MUST BE ON THAT CLAIM, ON THIS CHECK.
       *
       * Checked against what the loader already read rather than with another
       * query: a strike whose line belongs to a different claim would remove money
       * from a sum that never contained it.
       */
      if (lineId) {
        const onClaim = [...loaded.linesByClaim.values()]
          .flat()
          .some((l) => String(l.line_id) === lineId && String(l.claim_id) === claimId);
        if (!onClaim) {
          return {
            refusal: { error: 'That procedure line is not on that claim.', code: 'LINE_NOT_ON_CLAIM' },
          };
        }
      } else {
        const onClaim = loaded.addedLineRows.some(
          (l) => String(l.added_line_id) === addedLineId && String(l.claim_id) === claimId
        );
        if (!onClaim) {
          return {
            refusal: {
              error: 'That added line is not on that claim.',
              code: 'ADDED_LINE_NOT_ON_CLAIM',
            },
          };
        }
      }

      /** The live strike on this line, if there is one. */
      const live = loaded.strikeRows.find(
        (row) =>
          !row.withdrawn_at &&
          (lineId
            ? String(row.line_id || '') === lineId
            : String(row.added_line_id || '') === addedLineId)
      );

      const actor = await resolveRcmActor(client, {
        email: actorEmail(req),
        displayName: (req.user && (req.user.name || req.user.displayName)) || '',
      });

      if (striking) {
        /*
         * ALREADY STRUCK IS A REFUSAL, not a second row.
         *
         * Two live strikes with two reasons would leave the accessor reading one
         * of them arbitrarily to tell a biller why a line stopped counting. The
         * partial unique index refuses it too; this is so the refusal is a
         * sentence rather than a 23505.
         */
        if (live) {
          return {
            refusal: {
              error: 'That line is already struck. Take the strike back first if the reason is wrong.',
              code: 'ALREADY_STRUCK',
            },
          };
        }
        const inserted = await client.query(QUERIES.insertStrike, [
          office,
          batchId,
          claimId,
          lineId,
          addedLineId,
          reason,
          actor,
        ]);
        return {
          row: inserted.rows[0],
          action: 'CREATE',
          loaded: await loadForConfirm(client, office, batchId),
        };
      }

      if (!live) {
        return {
          refusal: { error: 'That line is not struck.', code: 'NOT_STRUCK' },
        };
      }
      const withdrawn = await client.query(QUERIES.withdrawStrike, [
        office,
        String(live.strike_id),
        actor,
      ]);
      return {
        row: withdrawn.rows[0] || live,
        action: 'UPDATE',
        loaded: await loadForConfirm(client, office, batchId),
      };
    });

    if (result.notFound) {
      await auditRcmDenial(req, 'rcm_eob_line_strike', batchId, { office });
      return res.status(404).json({
        success: false,
        error: 'No such check for this office.',
        code: 'BATCH_NOT_FOUND',
      });
    }
    if (result.notConfirmable) {
      return res.status(409).json({
        success: false,
        error: 'This check was not read from a scan, so there is no page image to check a line against.',
        code: 'NOT_A_SCANNED_CHECK',
      });
    }
    if (result.refusal) {
      return res.status(400).json({ success: false, ...result.refusal });
    }

    await audit(req, {
      action: result.action,
      resourceType: 'rcm_eob_line_strike',
      resourceId: String(result.row.strike_id),
      result: 'SUCCESS',
      office,
      sourceRef: batchId,
    });

    const actorNames = await namesFor(req, result.loaded);
    return res.json({
      success: true,
      office,
      batchId,
      struck: striking,
      state: shapeState({ office, loaded: result.loaded, actorNames }),
    });
  })
);

module.exports = router;
module.exports.QUERIES = QUERIES;
module.exports.MAX_FIELDS_PER_REQUEST = MAX_FIELDS_PER_REQUEST;
module.exports.validateField = validateField;
module.exports.validateAddedLine = validateAddedLine;
module.exports.ADDED_LINE_FIGURES = ADDED_LINE_FIGURES;
