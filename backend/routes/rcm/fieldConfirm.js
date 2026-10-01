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

  const [uploads, links, confirmations] = await Promise.all([
    client.query(QUERIES.provenance, [office, batchId]),
    client.query(QUERIES.batchClaims, [office, batchId]),
    client.query(confirmedFigures.QUERIES.readForBatch, [office, batchId]),
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

  const wireClaims = claims.map((claim) => {
    const claimId = String(claim.claim_id);
    const lines = linesByClaim.get(claimId) || [];
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
      lines: lines.map((line) => ({
        lineId: String(line.line_id),
        position: num(line.position),
        code: line.code || '',
        description: line.description || '',
        /*
         * PER-LINE GEOMETRY, for the cropped strip of the page beside each
         * line (addendum item 1).
         *
         * Always null today, and deliberately so rather than omitted. The
         * stored OCR result carries NO geometry: `documentOcr.summarize` keeps
         * text, page count, word count and mean confidence, and discards the
         * polygons Azure returns. Re-running OCR to recover them would spend
         * money to redraw a box, which the addendum rules out.
         *
         * So the screen falls back to the whole page, scroll-synced to the
         * selected row, and this field is the seam that a later slice fills
         * once extraction STORES the regions. A null here is the honest "we do
         * not know where on the page this came from".
         */
        region: null,
        fields: LINE_FIELDS.map((field) =>
          toWireField({
            field,
            claimId,
            lineId: String(line.line_id),
            index,
            extracted: confirmedFigures.extractedFor(field, line),
            actorNames,
          })
        ),
      })),
    };
  });

  const shape = wireClaims.map((c) => ({
    claimId: c.claimId,
    lines: c.lines.map((l) => ({ lineId: l.lineId })),
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
 * The names behind a set of confirmation rows, for the trail sentences.
 *
 * Its own read because `describeActors` is the module's one key→name resolver,
 * and both the GET and the POST need it over whatever rows they are about to
 * shape.
 */
function namesFor(req, confirmations) {
  return tenantDb.withTenantDb(req, (pool) =>
    describeActors(
      pool,
      confirmations.map((c) => c.confirmed_by).filter(Boolean)
    )
  );
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

    const actorNames = await namesFor(req, loaded.confirmations);
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
    const actorNames = await namesFor(req, result.loaded.confirmations);

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

module.exports = router;
module.exports.QUERIES = QUERIES;
module.exports.MAX_FIELDS_PER_REQUEST = MAX_FIELDS_PER_REQUEST;
module.exports.validateField = validateField;
