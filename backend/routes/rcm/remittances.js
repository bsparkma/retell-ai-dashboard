'use strict';

/**
 * /api/rcm/remittances — the review workbench's list and detail (Slice 6a).
 *
 *   GET  /api/rcm/remittances?office=…        every payment batch, needs-attention first
 *   GET  /api/rcm/remittances/:id?office=…    one batch: claims, lines, adjustments
 *   POST /api/rcm/remittances/:id/match?office=…  run the OD match over its claims
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS ROUTE EXISTS BEFORE ANY POSTING CODE
 * ─────────────────────────────────────────────────────────────────────────────
 * Slices 4 and 5 proved intake: an EOB extracts in seconds, an 835 parses into
 * a batch with claims and lines, duplicates are refused. But the only visible
 * evidence was a counter on an office card. A real 835 was uploaded to staging
 * and there was nowhere to look at what it contained.
 *
 * A module whose data can only be inspected with `psql` is not shippable, and
 * building the posting path on top of an invisible one would mean a biller's
 * first look at a remittance and their first irreversible action on it arriving
 * in the same release.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEEDS ATTENTION IS THE DEFAULT VIEW
 * ─────────────────────────────────────────────────────────────────────────────
 * Same philosophy as the voice worklist: the default is the work, not the
 * archive — and "the work" means an ACTION a human still owes, never a fact the
 * file happens to carry. A batch needs attention while any claim on it has not
 * been dispositioned (marked reviewed). Flags, an honest `no_candidate` and a
 * batch held `open` are shown beside it as observations and hold nothing.
 * See `attentionFor` below for why, and for what it cost to learn.
 *
 * That predicate is computed HERE, server-side, from the same rows the detail
 * renders, so the list, the count and the detail cannot disagree about whether
 * something is done.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO OPEN DENTAL WRITES, AND NO POSTING
 * ─────────────────────────────────────────────────────────────────────────────
 * The only Open Dental traffic anywhere under this mount is GET, through the
 * office's own client (see ./claims.js). There is no approve, no enqueue, no
 * post: `rcm_posting_queue` is untouched by this slice, and the workbench's
 * Approve button is rendered DISABLED so the layout is right when 6b lands.
 */

const express = require('express');

// Namespace import — see the note in summary.js.
const tenantDb = require('../../platform/tenantDb');
const { h, auditRcmRead, auditRcmDenial, num, iso, isoDate } = require('./helpers');
const { describeActors } = require('../../services/rcm/rcmUserMap');
const { requirePermission } = require('../../config/permissions');
const { toClaimSummary, loadClaimBundle, runBatchMatch, CLAIM_LIST_COLUMNS } = require('./matchService');

const router = express.Router();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Batch columns the list and detail read. Named explicitly (no SELECT * in this
 * repo), and the list doubles as the response's PHI budget — a payment batch
 * carries no patient data itself, which is why the batch list is cheap and the
 * claim list under it is not.
 */
const BATCH_COLUMNS = [
  'batch_id',
  'office_id',
  'payer',
  'check_number',
  'eft_number',
  'trace_number',
  'payment_method',
  'deposit_date',
  'total_amount_cents',
  'posted_amount_cents',
  'plb_total_cents',
  'plb_adjustments',
  'claim_count',
  'status',
  'era_file_key',
  'notes',
  'created_by',
  'created_at',
].join(', ');

/** @param {unknown} raw @param {number} fallback @param {number} max */
function parseBound(raw, fallback, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

/**
 * Does this batch still owe a human an ACTION?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OBLIGATIONS, NOT FACTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The first version of this counted four things and needed attention if any of
 * them held: the batch was not `ready`, some claim carried a review reason,
 * some claim was not `confirmed`, some claim was not reviewed. Three of those
 * are PERMANENT FACTS ABOUT THE FILE that no action available in this slice can
 * change.
 *
 * A biller on staging did everything the screen lets her do — ran the match on
 * both claims (honest `no_candidate`; the fixture PatNums do not exist in that
 * database), read the flags, marked both claims reviewed with a note — and the
 * batch stayed in the needs-attention view. It stayed because Slice 5 held the
 * batch `open` over a downcode and an unreadable CAS (correct, and it stays
 * open until posting exists), because the claims carry their review reasons
 * forever, and because `no_candidate` is not `confirmed`. Reviewing cleared
 * exactly one of four reasons, so the review action was a no-op against the
 * filter and the list was not a worklist at all — it was "not yet posted".
 *
 * Telling somebody who has finished that they still owe something is the
 * honest-states rule failing by crying wolf, which costs the same thing every
 * false alarm costs: the true ones stop being read.
 *
 * So: **needs attention means a human still owes an action.** A claim is
 * DISPOSITIONED when a human marked it reviewed. What they saw — flags, no
 * candidate, ambiguity — stays visible as an observation and is recorded in
 * their note; that is evidence of work done, not an outstanding obligation.
 *
 * `observations` ride alongside so the screen still says WHY a remittance was
 * worth looking at, and so Slice 6b can add its own obligations (approvable,
 * awaiting posting) without having to re-litigate which of these is which.
 *
 * NO AUTO-REVIEW. A claim with no flags, matched and confirmed, still owes an
 * explicit disposition: a biller marking "looked, nothing to do" is real work
 * and the audit row is what proves it happened.
 *
 * @param {{ status: string }} batch
 * @param {ReadonlyArray<{ needsReviewReasons: string[], odMatchStatus: string, reviewedAt: string|null }>} claims
 * @returns {{ needsAttention: boolean, reasons: string[], observations: string[] }}
 */
function attentionFor(batch, claims) {
  /** Outstanding ACTIONS. These, and only these, decide `needsAttention`. */
  const reasons = [];
  /** FACTS worth showing. They never make a remittance need attention. */
  const observations = [];

  // ── The obligations ───────────────────────────────────────────────────────

  const unreviewed = claims.filter((c) => !c.reviewedAt).length;
  if (unreviewed) reasons.push('claims_unreviewed');

  /*
   * A batch with NO claims is not finished, it is unworkable.
   *
   * "Every claim is reviewed" is vacuously true of an empty list, so without
   * this an 835 that produced a payment batch and no claim rows — a parse
   * problem, or a check naming payments whose claims were never created —
   * would read as done the moment it landed. That is the same failure as the
   * one above, pointing the other way: silence where somebody should look.
   * It cannot be dispositioned by reviewing claims, so it is its own reason.
   */
  if (claims.length === 0) reasons.push('batch_no_claims');

  // ── The observations ──────────────────────────────────────────────────────

  // Slice 5's contract: a batch is held `open` when ANYTHING on it was flagged
  // — a reversal, a PLB, a downcode, an unreadable adjustment, a total that
  // does not reconcile. Nearly every real 835 carries one of those, so on its
  // own it can never be the thing that holds a remittance in the queue: if it
  // were, nothing would ever leave. `ready` means "a person could act on this
  // now", and posting is what will move it — in 6b.
  if (batch.status !== 'ready' && batch.status !== 'posted') {
    observations.push(`batch_${batch.status}`);
  }

  const flagged = claims.filter((c) => c.needsReviewReasons.length > 0).length;
  if (flagged) observations.push('claims_flagged');

  // `no_candidate` is a finished search with a real, negative answer. It is not
  // an unfinished task, and there is no action in this slice that turns it into
  // `confirmed` when Open Dental genuinely has no such claim.
  const unmatched = claims.filter((c) => c.odMatchStatus !== 'confirmed').length;
  if (unmatched) observations.push('claims_unmatched');

  return { needsAttention: reasons.length > 0, reasons, observations };
}

/** Map a batch row + its claims to the list/detail wire shape. */
function toBatchWire(batch, claims, source, actors) {
  const attention = attentionFor({ status: batch.status }, claims);
  const claimTotalCents = claims.reduce((sum, c) => sum + c.totalPaidCents, 0);
  const createdBy = batch.created_by ? actors[batch.created_by] : null;

  return {
    batchId: batch.batch_id,
    officeId: batch.office_id,
    payer: batch.payer,
    checkNumber: batch.check_number || null,
    eftNumber: batch.eft_number || null,
    traceNumber: batch.trace_number || null,
    paymentMethod: batch.payment_method || null,
    depositDate: isoDate(batch.deposit_date),
    totalAmountCents: num(batch.total_amount_cents),
    postedAmountCents: num(batch.posted_amount_cents),
    plbTotalCents: num(batch.plb_total_cents),
    claimCount: num(batch.claim_count),
    status: batch.status,
    /** '835' when an ERA produced it, 'eob' when a PDF extraction did. */
    source,
    notes: batch.notes || '',
    createdAt: iso(batch.created_at),
    createdBy: createdBy ? createdBy.displayName : null,

    /**
     * THE BALANCE CHECK, computed rather than stored.
     *
     * `balanced` is the batch's own total against the sum of what its claims
     * were paid. They should agree; when they do not, the difference is the
     * number a biller chases, so it is returned rather than a boolean alone.
     * A PLB moves money at the provider level rather than on any claim, so it
     * is a legitimate reason for the two to differ and is surfaced beside it.
     */
    balance: {
      batchTotalCents: num(batch.total_amount_cents),
      claimTotalCents,
      differenceCents: num(batch.total_amount_cents) - claimTotalCents,
      plbTotalCents: num(batch.plb_total_cents),
      balanced: num(batch.total_amount_cents) - claimTotalCents - num(batch.plb_total_cents) === 0,
    },

    needsAttention: attention.needsAttention,
    /** Outstanding ACTIONS — the ones that put this row in the queue. */
    attentionReasons: attention.reasons,
    /** FACTS worth reading. Shown, but never a reason to hold a remittance. */
    attentionObservations: attention.observations,
    reviewReasonCount: claims.reduce((n, c) => n + c.needsReviewReasons.length, 0),
    unmatchedClaimCount: claims.filter((c) => c.odMatchStatus !== 'confirmed').length,
  };
}

/**
 * Load the claims belonging to a set of batches, via the join table.
 *
 * Two statements rather than a JOIN, matching the module's existing style: the
 * link rows carry the batch↔claim relationship and the claim rows carry
 * everything else. `claim_id` is nullable on a link (a batch can name a payment
 * whose claim row was never created), so the nulls are dropped before the
 * second read rather than producing a `= ANY(NULL)`.
 *
 * @returns {Promise<Map<string, any[]>>} batch_id → claim summaries
 */
async function claimsByBatch(pool, office, batchIds) {
  if (batchIds.length === 0) return new Map();

  const links = await pool.query(
    `SELECT batch_id, claim_id, position FROM rcm_batch_claim_payments ` +
      `WHERE office_id = $1 AND batch_id = ANY($2::uuid[]) ORDER BY position ASC`,
    [office, batchIds]
  );

  const claimIds = [...new Set(links.rows.map((r) => r.claim_id).filter(Boolean))];
  if (claimIds.length === 0) return new Map();

  const claims = await pool.query(
    `SELECT ${CLAIM_LIST_COLUMNS} FROM rcm_claims ` +
      `WHERE office_id = $1 AND claim_id = ANY($2::uuid[])`,
    [office, claimIds]
  );
  const byId = new Map(claims.rows.map((r) => [r.claim_id, r]));

  /** @type {Map<string, any[]>} */
  const out = new Map();
  for (const link of links.rows) {
    const row = link.claim_id ? byId.get(link.claim_id) : null;
    if (!row) continue;
    if (!out.has(link.batch_id)) out.set(link.batch_id, []);
    out.get(link.batch_id).push(toClaimSummary(row));
  }
  return out;
}

/**
 * Which uploads produced these batches, so the list can say whether a
 * remittance came from a machine-readable 835 or from a model reading a PDF.
 *
 * That distinction is not cosmetic. An 835 is PARSED and can only be malformed;
 * an EOB PDF is READ by a model and can be WRONG. A biller deciding how hard to
 * scrutinise a line needs to know which they are looking at.
 *
 * @returns {Promise<Map<string, { source: '835'|'eob', uploadId: string, filename: string,
 *                                 uploadedAt: string|null, uploadedBy: string|null }>>}
 */
async function uploadsByBatch(pool, office, batches) {
  /** @type {Map<string, any>} */
  const out = new Map();
  if (batches.length === 0) return out;

  const eraKeys = batches.map((b) => b.era_file_key).filter(Boolean);
  const batchIds = batches.map((b) => b.batch_id);

  const [byKey, byResult] = await Promise.all([
    eraKeys.length
      ? pool.query(
          `SELECT upload_id, filename, file_key, uploaded_at, uploaded_by FROM rcm_eob_uploads ` +
            `WHERE office_id = $1 AND file_key = ANY($2::text[])`,
          [office, eraKeys]
        )
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT upload_id, filename, result_batch_id, uploaded_at, uploaded_by FROM rcm_eob_uploads ` +
        `WHERE office_id = $1 AND result_batch_id = ANY($2::uuid[])`,
      [office, batchIds]
    ),
  ]);

  const uploadByKey = new Map(byKey.rows.map((r) => [r.file_key, r]));
  for (const batch of batches) {
    const era = batch.era_file_key ? uploadByKey.get(batch.era_file_key) : null;
    const eob = era ? null : byResult.rows.find((r) => r.result_batch_id === batch.batch_id);
    const upload = era || eob;
    if (!upload) continue;
    out.set(batch.batch_id, {
      source: era ? '835' : 'eob',
      uploadId: upload.upload_id,
      filename: upload.filename,
      uploadedAt: iso(upload.uploaded_at),
      uploadedByKey: upload.uploaded_by || null,
    });
  }
  return out;
}

// ─── GET / — the remittance list ─────────────────────────────────────────────

router.get(
  '/',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const limit = parseBound(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
    const offset = parseBound(req.query.offset, 0, Number.MAX_SAFE_INTEGER);

    const loaded = await tenantDb.withTenantDb(req, async (pool) => {
      const [page, count] = await Promise.all([
        pool.query(
          `SELECT ${BATCH_COLUMNS} FROM rcm_payment_batches WHERE office_id = $1 ` +
            `ORDER BY deposit_date DESC NULLS LAST, created_at DESC LIMIT $2 OFFSET $3`,
          [office, limit, offset]
        ),
        pool.query(`SELECT COUNT(*)::int AS n FROM rcm_payment_batches WHERE office_id = $1`, [
          office,
        ]),
      ]);

      const batchIds = page.rows.map((r) => r.batch_id);
      const [claims, uploads] = await Promise.all([
        claimsByBatch(pool, office, batchIds),
        uploadsByBatch(pool, office, page.rows),
      ]);
      const actors = await describeActors(pool, [
        ...page.rows.map((b) => b.created_by),
        ...[...uploads.values()].map((u) => u.uploadedByKey),
      ]);

      return { batches: page.rows, total: num(count.rows[0] && count.rows[0].n), claims, uploads, actors };
    });

    // A remittance list names patients one level down, and the batch rows carry
    // payer and check identifiers. PHI leaves the building only after the trail
    // is recorded (hard rule 5).
    await auditRcmRead(req, 'rcm_remittance', { office });

    const remittances = loaded.batches.map((batch) => {
      const claims = loaded.claims.get(batch.batch_id) || [];
      const upload = loaded.uploads.get(batch.batch_id) || null;
      const wire = toBatchWire(batch, claims, upload ? upload.source : null, loaded.actors);
      return {
        ...wire,
        upload: upload
          ? {
              uploadId: upload.uploadId,
              filename: upload.filename,
              uploadedAt: upload.uploadedAt,
              // Null is the honest answer for anything uploaded before D-5
              // landed. The screen says "not recorded", never "system".
              uploadedBy: upload.uploadedByKey
                ? (loaded.actors[upload.uploadedByKey] || {}).displayName || upload.uploadedByKey
                : null,
            }
          : null,
      };
    });

    return res.json({
      success: true,
      office,
      remittances,
      total: loaded.total,
      limit,
      offset,
      /** So the client's default filter and the server's predicate agree. */
      needsAttentionCount: remittances.filter((r) => r.needsAttention).length,
    });
  })
);

// ─── GET /:id — one remittance, in full ──────────────────────────────────────

router.get(
  '/:id',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);

    const loaded = await tenantDb.withTenantDb(req, async (pool) => {
      // office_id is in the WHERE, not merely checked afterwards: a batch that
      // belongs to the other practice is not found, rather than found and then
      // refused. There is no code path through this handler that omits it.
      const batches = await pool.query(
        `SELECT ${BATCH_COLUMNS} FROM rcm_payment_batches WHERE office_id = $1 AND batch_id = $2`,
        [office, batchId]
      );
      if (batches.rows.length === 0) return null;
      const batch = batches.rows[0];

      const claims = (await claimsByBatch(pool, office, [batchId])).get(batchId) || [];
      const uploads = await uploadsByBatch(pool, office, [batch]);
      const upload = uploads.get(batchId) || null;

      // The lines and adjustments beneath every claim on this batch — this is
      // the screen where the Slice 4 and Slice 5 flags finally get seen.
      const details = await Promise.all(
        claims.map((c) => loadClaimBundle(pool, office, c.claimId, { includeSnapshot: false }))
      );

      const actors = await describeActors(pool, [
        batch.created_by,
        upload && upload.uploadedByKey,
        ...claims.map((c) => c.odMatchedByKey),
        ...claims.map((c) => c.reviewedByKey),
      ]);

      return { batch, claims, details, upload, actors };
    });

    if (!loaded) {
      await auditRcmDenial(req, 'rcm_remittance', batchId, { office });
      return res.status(404).json({
        success: false,
        error: 'No such remittance for this office',
        code: 'REMITTANCE_NOT_FOUND',
      });
    }

    await auditRcmRead(req, 'rcm_remittance', { office });

    const wire = toBatchWire(loaded.batch, loaded.claims, loaded.upload ? loaded.upload.source : null, loaded.actors);

    return res.json({
      success: true,
      office,
      remittance: {
        ...wire,
        /**
         * Provider Level Balance adjustments — money moved at the provider
         * level rather than on any claim, which is exactly why they make the
         * batch's total disagree with the sum of its claims. Returned verbatim
         * from what the parser stored, because a PLB is detect-and-flag: there
         * is no action on one in this slice, only a link to the manual SOP.
         */
        plbAdjustments: Array.isArray(loaded.batch.plb_adjustments)
          ? loaded.batch.plb_adjustments
          : [],
        upload: loaded.upload
          ? {
              uploadId: loaded.upload.uploadId,
              filename: loaded.upload.filename,
              uploadedAt: loaded.upload.uploadedAt,
              uploadedBy: loaded.upload.uploadedByKey
                ? (loaded.actors[loaded.upload.uploadedByKey] || {}).displayName ||
                  loaded.upload.uploadedByKey
                : null,
              /** The authorised download; the blob key itself never ships. */
              documentUrl: `/api/rcm/uploads/${loaded.upload.uploadId}/document?office=${office}`,
            }
          : null,
      },
      claims: loaded.details,
    });
  })
);

// ─── POST /:id/match — run the match over every claim on the batch ───────────

router.post(
  '/:id/match',
  // The queue tier (D-9) — see routes/rcm/index.js QUEUE_PATHS. Batch matching
  // reads Open Dental and changes no chart, so a read-tier reviewer may run it.
  requirePermission('rcm.queue'),
  h(async (req, res) => {
    const office = req.rcmOffice;
    const batchId = String(req.params.id);

    // The claim SUMMARIES, not just their ids: runBatchMatch orders unmatched
    // claims first so that pressing the button again after a budgeted run makes
    // forward progress instead of redoing the front of the list.
    const claims = await tenantDb.withTenantDb(req, async (pool) => {
      const batches = await pool.query(
        `SELECT batch_id FROM rcm_payment_batches WHERE office_id = $1 AND batch_id = $2`,
        [office, batchId]
      );
      if (batches.rows.length === 0) return null;
      const rows = (await claimsByBatch(pool, office, [batchId])).get(batchId) || [];
      return rows.map((c) => ({ claimId: c.claimId, odMatchStatus: c.odMatchStatus }));
    });

    if (claims === null) {
      await auditRcmDenial(req, 'rcm_remittance', batchId, { office });
      return res.status(404).json({
        success: false,
        error: 'No such remittance for this office',
        code: 'REMITTANCE_NOT_FOUND',
      });
    }

    /*
     * SEQUENTIAL, WITH PACING. Never a request-scoped fan-out.
     *
     * Each claim's match is itself a handful of Open Dental calls, and the OD
     * chain is throttled and ~10 network hops deep (TC_OD_READS.md's cost
     * note). Matching a twelve-claim remittance in parallel would be sixty-odd
     * concurrent calls into an API that rate-limits — and the client's own 429
     * backoff would then serialise them anyway, slower and noisier than doing
     * it deliberately. Every call is paced by services/rcm/odPacer.
     */

    /*
     * TWO KINDS OF ROW, AND BOTH ARE NEEDED.
     *
     * The RUN is recorded here, unconditionally and before any claim is
     * touched, so a run in which every claim fails still leaves a trail — the
     * previous shape hung the whole batch's audit on claim zero succeeding, and
     * a remittance whose first claim was already confirmed read charts and
     * recorded nothing.
     *
     * Then one row PER CLAIM below, stamped with the claim id. A claim is one
     * patient's chart, not one Open Dental call, so N charts is N rows —
     * anything coarser cannot answer "whose chart was read on Tuesday", which
     * is the only question this log exists to answer.
     */
    await auditRcmRead(req, 'rcm_remittance_match', { office, resourceId: batchId });

    const result = await runBatchMatch(req, office, claims, {
      // Fail-closed per claim: a claim whose read cannot be recorded is
      // reported as failed rather than matched, and its snapshot is not stored.
      onPhiRead: (ctx) => auditRcmRead(req, 'rcm_claim_match', { office, resourceId: ctx.claimId }),
      // A read that got names off the wire and then failed is a disclosure that
      // did not complete — ERROR, not a refusal, and never silence.
      onReadFailed: (ctx) =>
        auditRcmDenial(req, 'rcm_claim_match', ctx.claimId, { office, result: 'ERROR' }),
    });

    return res.json({ success: true, office, batchId, ...result });
  })
);

module.exports = router;
module.exports.attentionFor = attentionFor;
module.exports.BATCH_COLUMNS = BATCH_COLUMNS;
