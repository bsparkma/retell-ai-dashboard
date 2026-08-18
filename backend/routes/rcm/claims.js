'use strict';

/**
 * /api/rcm/claims — the office's claims, and (Slice 6a) one claim's match panel.
 *
 *   GET  /                     the worklist, newest first, paginated
 *   GET  /:id                  one claim: lines, adjustments, match snapshot
 *   POST /:id/match            read Open Dental and rank candidates
 *   POST /:id/confirm-match    a human picks one          (attributed)
 *   POST /:id/review           mark reviewed + note        (attributed)
 *
 * The list returns minimal fields — enough for a worklist row, and nothing
 * more. Notably ABSENT: raw_extracted_json (the full PHI extraction payload),
 * subscriber_id, group_number, patient_dob. A list endpoint has no use for them
 * and shipping them "just in case" widens the PHI surface for free.
 *
 * patient_name IS returned — a claims worklist that cannot say whose claim it
 * is has no product in it. That is what makes this a PHI path, which is why
 * every read here is audited fail-closed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE MATCH IS A POST
 * ─────────────────────────────────────────────────────────────────────────────
 * It reads Open Dental and writes nothing to a chart — so on the face of it a
 * GET. It is a POST because it WRITES TO OUR ROWS: the snapshot, the match
 * status, and the instant we looked. That makes it non-idempotent, unsafe to
 * retry blindly, and unsafe to prefetch — three properties a GET promises the
 * opposite of. It also means the mount's `requireReadWrite` demands `rcm.write`
 * for it, which is right: recording an observation against a claim is a change
 * to the practice's record of that claim.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO POSTING, NO APPROVAL, NO QUEUE
 * ─────────────────────────────────────────────────────────────────────────────
 * There is deliberately no approve or enqueue endpoint in this slice.
 * `rcm_posting_queue` is untouched. The workbench renders its Approve button
 * DISABLED so the layout is right when Slice 6b lands, and there is no route
 * behind it to call.
 */

const express = require('express');

// Namespace import — see the note in summary.js.
const tenantDb = require('../../platform/tenantDb');
const odOffices = require('../../config/odOffices');
const { h, actorEmail, auditRcmRead, auditRcmDenial, num, iso, isoDate } = require('./helpers');
const { audit } = require('../../platform/audit');
const { requirePermission, holdsPermission } = require('../../config/permissions');
const { CLAIM_STATUSES } = require('./summary');
const { describeActors } = require('../../services/rcm/rcmUserMap');
const matchService = require('./matchService');
const claimMatch = require('../../services/rcm/claimMatch');
const { OdReadError } = require('../../services/rcm/odClaimReads');

const router = express.Router();

/** Page size ceiling. A caller asking for more gets DEFAULT_LIMIT, not a 400. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Columns this endpoint returns. Named explicitly — no SELECT * anywhere in
 * this repo, and here the list doubles as the PHI budget for the route.
 */
const COLUMNS = [
  'claim_id',
  'office_id',
  'claim_number',
  'check_number',
  'patient_name',
  'od_patient_id',
  'payer',
  'service_date',
  'received_date',
  'status',
  'payment_status',
  'insurance_type',
  'total_billed_cents',
  'total_paid_cents',
  'patient_balance_cents',
  'needs_review_reasons',
  'created_at',
].join(', ');

/**
 * Parse a positive-integer query param, falling back on anything unusable.
 * A garbage `?limit=banana` yields the default rather than a 400: pagination is
 * a display concern, and refusing to render a page over it helps nobody.
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} max
 */
function parseBound(raw, fallback, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

/** Map a DB row to the wire shape. camelCase out; cents stay integers. */
function toWire(row) {
  return {
    claimId: row.claim_id,
    officeId: row.office_id,
    claimNumber: row.claim_number,
    checkNumber: row.check_number || null,
    patientName: row.patient_name,
    odPatientId: row.od_patient_id == null ? null : num(row.od_patient_id),
    payer: row.payer,
    serviceDate: isoDate(row.service_date),
    receivedDate: isoDate(row.received_date),
    status: row.status,
    paymentStatus: row.payment_status,
    insuranceType: row.insurance_type,
    totalBilledCents: num(row.total_billed_cents),
    totalPaidCents: num(row.total_paid_cents),
    patientBalanceCents: num(row.patient_balance_cents),
    needsReviewReasons: Array.isArray(row.needs_review_reasons) ? row.needs_review_reasons : [],
    createdAt: iso(row.created_at),
  };
}

router.get(
  '/',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const limit = parseBound(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
    const offset = parseBound(req.query.offset, 0, Number.MAX_SAFE_INTEGER);

    // An unknown status is dropped rather than passed through: it could not
    // match a row anyway (CHECK constraint), and validating it here keeps the
    // filter from becoming a way to probe the column.
    const status =
      typeof req.query.status === 'string' && CLAIM_STATUSES.includes(req.query.status)
        ? req.query.status
        : null;

    // office_id is ALWAYS $1 and always present — there is no code path through
    // this handler that omits it, which is what makes a cross-office read
    // structurally impossible rather than merely unlikely.
    const where = status
      ? 'office_id = $1 AND archived_at IS NULL AND status = $2'
      : 'office_id = $1 AND archived_at IS NULL';
    const params = status ? [office, status] : [office];

    const { rows, total } = await tenantDb.withTenantDb(req, async (pool) => {
      const [page, count] = await Promise.all([
        pool.query(
          `SELECT ${COLUMNS} FROM rcm_claims WHERE ${where} ` +
            `ORDER BY received_date DESC NULLS LAST, created_at DESC ` +
            `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*)::int AS n FROM rcm_claims WHERE ${where}`, params),
      ]);
      return { rows: page.rows, total: num(count.rows[0] && count.rows[0].n) };
    });

    // PHI leaves the building only after the trail is recorded (hard rule 5).
    await auditRcmRead(req, 'rcm_claim', { office });

    return res.json({
      success: true,
      office,
      claims: rows.map(toWire),
      total,
      limit,
      offset,
    });
  })
);

// ─── The actor, and how failures are shaped ──────────────────────────────────

/**
 * The SSO identity, in the shape rcmUserMap wants.
 * `actorEmail` throws if the route were ever mounted outside the auth gate, so
 * an unattributed write is impossible rather than merely unlikely.
 * @param {import('express').Request} req
 */
function actorOf(req) {
  return {
    email: actorEmail(req),
    displayName: (req.user && (req.user.name || req.user.displayName)) || '',
  };
}

/**
 * Map the three families of refusal onto HTTP, without leaking internals.
 *
 * - `OdOfficeError` — this office has no usable Open Dental connection. 409 or
 *   503 per config/odOffices' own table; the UI renders it as the honest
 *   "Open Dental is not connected for this office" state rather than as a
 *   failed match, because those are different problems with different fixes.
 * - `OdReadError` — Open Dental answered badly. 502: the failure is theirs, and
 *   echoing it as a 404 would read as "no such claim".
 * - Anything carrying `httpStatus` — this module's own typed refusals.
 *
 * Returns true when it answered, so callers read as a guard clause.
 */
function respondToMatchError(res, office, err, { req, claimId, phiAudited = false } = {}) {
  /*
   * WHAT THE TRAIL SAYS DEPENDS ON WHAT ACTUALLY HAPPENED.
   *
   * This block used to write an UNAUTHORIZED row unconditionally, before
   * inspecting the error, which cost two things at once. Routine conflicts — a
   * 409 because somebody else confirmed first, a candidate that is no longer in
   * the snapshot — filed as refusals and diluted the one signal that means
   * "somebody was refused". And a match that genuinely READ PHI and then failed
   * downstream also filed as a refusal, under-counting real disclosures on the
   * report the trail exists to produce.
   *
   * So, in order:
   *  - `phiAudited` — onPhiRead already wrote the SUCCESS read row. The
   *    disclosure is on record; adding a second row for the same operation
   *    would double-count it.
   *  - `OdReadError` — Open Dental answered badly PART WAY THROUGH. /patients
   *    can return names and dates of birth and then /claims can 503, so PHI may
   *    well have crossed the wire. ERROR, not UNAUTHORIZED: a read happened and
   *    did not complete.
   *  - `CLAIM_NOT_FOUND` — an id that resolved to nothing for this office,
   *    which also covers "belongs to the other practice". That IS the probe
   *    worth recording. UNAUTHORIZED.
   *  - `FORCE_REQUIRES_WRITE` — somebody without posting permission tried to
   *    release a confirmed match. A refusal of access in the literal sense, and
   *    exactly what UNAUTHORIZED is for.
   *  - everything else (409 conflicts, an unconnected office) — no row. No PHI
   *    was read and nobody was refused access to anything.
   */
  if (req && claimId && !phiAudited) {
    if (err instanceof OdReadError) {
      void auditRcmDenial(req, 'rcm_claim_match', claimId, { office, result: 'ERROR' });
    } else if (err && err.code === 'CLAIM_NOT_FOUND') {
      void auditRcmDenial(req, 'rcm_claim', claimId, { office });
    } else if (err && err.code === 'FORCE_REQUIRES_WRITE') {
      void auditRcmDenial(req, 'rcm_claim_match', claimId, { office });
    }
  }

  if (err instanceof odOffices.OdOfficeError) {
    res.status(odOffices.httpStatusFor(err)).json({
      success: false,
      error: err.publicMessage || 'Open Dental is not connected for this office',
      code: 'OFFICE_NOT_CONNECTED',
      reason: err.code,
      office,
    });
    return true;
  }
  if (err instanceof OdReadError) {
    // Never logged with a patient name or a search term — the message is ours.
    console.error(`[rcm/match] office=${office} OD read failed (${err.status})`);
    res.status(502).json({
      success: false,
      error: 'Could not read Open Dental',
      code: 'OD_READ_FAILED',
      office,
    });
    return true;
  }
  if (err && typeof err.httpStatus === 'number') {
    res.status(err.httpStatus).json({
      success: false,
      error: err.message,
      code: err.code || 'REFUSED',
      office,
    });
    return true;
  }
  return false;
}

// ─── GET /:id — the claim detail / match panel ───────────────────────────────

router.get(
  '/:id',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const claimId = String(req.params.id);

    const loaded = await tenantDb.withTenantDb(req, async (pool) => {
      const claim = await matchService.loadClaimBundle(pool, office, claimId);
      if (!claim) return null;
      const actors = await describeActors(pool, [claim.odMatchedByKey, claim.reviewedByKey]);
      return { claim, actors };
    });

    if (!loaded) {
      // Audited: walking claim ids must not be a silent activity, and this
      // 404 also covers "belongs to the other office" (office_id is in the
      // WHERE), which is exactly the probe worth having a record of.
      await auditRcmDenial(req, 'rcm_claim', claimId, { office });
      return res
        .status(404)
        .json({ success: false, error: 'No such claim for this office', code: 'CLAIM_NOT_FOUND' });
    }

    await auditRcmRead(req, 'rcm_claim', { office });

    const { odMatchedByKey, reviewedByKey, ...claim } = loaded.claim;
    return res.json({
      success: true,
      office,
      claim: {
        ...claim,
        odMatchedBy: odMatchedByKey ? (loaded.actors[odMatchedByKey] || {}).displayName || odMatchedByKey : null,
        reviewedBy: reviewedByKey ? (loaded.actors[reviewedByKey] || {}).displayName || reviewedByKey : null,
      },
      /**
       * The tolerances and bands the scores were produced with, so the panel
       * explains itself with the numbers that actually ran rather than with
       * copy that can drift away from them.
       */
      matchRules: {
        amountNearCents: claimMatch.AMOUNT_NEAR_CENTS,
        dateNearDays: claimMatch.DATE_NEAR_DAYS,
        ambiguityMargin: claimMatch.AMBIGUITY_MARGIN,
        bands: claimMatch.CONFIDENCE_BANDS,
      },
    });
  })
);

// ─── POST /:id/match ─────────────────────────────────────────────────────────

/**
 * The queue tier (D-9). These two POSTs are exempt from the mount's
 * rcm.read/rcm.write pair and gated here instead, so a `reviewer` can
 * work the queue without holding the permission that commits a chart linkage.
 *
 * Named as an ACTION, never a role — the role list lives in one file
 * (config/permissions.js) and nowhere else.
 */
const requireQueue = requirePermission('rcm.queue');

router.post(
  '/:id/match',
  requireQueue,
  h(async (req, res) => {
    const office = req.rcmOffice;
    const claimId = String(req.params.id);
    // Re-running over a confirmed match is allowed but must be ASKED FOR. The
    // default refuses, so a stray double-click cannot discard somebody's
    // decision — "re-run allowed explicitly, never silent overwrite".
    const force = req.body && req.body.force === true;

    /*
     * …AND ASKING FOR IT IS THE WRITE TIER'S ACT (D-9).
     *
     * The route is gated on `rcm.queue` because running a match reads Open
     * Dental and changes no chart. `force` over a CONFIRMED claim is a
     * different act: it NULLs `od_claim_num`, the column 6c reads to pick a
     * chart. Evaluated here and enforced in runClaimMatch, which is where the
     * claim's status is actually known — a reviewer forcing an UNCONFIRMED
     * claim is still just a re-run and is allowed.
     */
    const mayReleaseConfirmed = holdsPermission(req, 'rcm.write');

    let result;
    // So a failure downstream knows the disclosure is already on record and
    // does not file the same operation a second time under a different result.
    let phiAudited = false;
    try {
      // ONE audit row per PHI read, whatever the fan-out cost — a match that
      // made fifteen Open Dental calls is one thing a human asked for, the same
      // granularity rule platform/odAccess applies to a 25-call treatment plan.
      //
      // Handed IN rather than written afterwards, so it lands BEFORE the
      // snapshot (which carries OD patient names) is persisted. Fail-closed:
      // auditRcmRead throws AuditError and h() answers 500 with nothing stored.
      result = await matchService.runClaimMatch(req, office, claimId, {
        force,
        mayReleaseConfirmed,
        onPhiRead: async (ctx) => {
          await auditRcmRead(req, 'rcm_claim_match', { office, resourceId: claimId });
          /*
           * A FORCED RE-RUN THAT DESTROYS A CONFIRMATION IS ITS OWN EVENT.
           *
           * Without this the audit row for a run that discarded a human's
           * decision is byte-identical to an ordinary match. It is an UPDATE —
           * something a person did to the practice's record — and it is written
           * BEFORE the overwrite, fail-closed, like every other row on this
           * path. The decision itself survives in the new snapshot's
           * `supersededConfirmation`.
           */
          if (ctx && ctx.supersedes) {
            await audit(req, {
              action: 'UPDATE',
              resourceType: 'rcm_claim_match_superseded',
              resourceId: claimId,
              result: 'SUCCESS',
              office,
              sourceRef: null,
            });
          }
          phiAudited = true;
        },
      });
    } catch (err) {
      if (respondToMatchError(res, office, err, { req, claimId, phiAudited })) return undefined;
      throw err;
    }

    return res.json({
      success: true,
      office,
      claimId,
      status: result.status,
      snapshot: result.snapshot,
    });
  })
);

// ─── POST /:id/confirm-match ─────────────────────────────────────────────────

// NO requireQueue here, deliberately: confirming writes `od_claim_num`, the
// column Slice 6c reads to decide which chart to post money into. It stays on
// the mount's `rcm.write`, which the queue tier does not hold.
router.post(
  '/:id/confirm-match',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const claimId = String(req.params.id);
    const odClaimNum = Number(req.body && req.body.odClaimNum);

    if (!Number.isFinite(odClaimNum) || odClaimNum <= 0) {
      return res.status(400).json({
        success: false,
        error: 'odClaimNum is required and must be a positive number',
        code: 'INVALID_CLAIM_NUM',
      });
    }

    let result;
    try {
      result = await matchService.confirmMatch(req, office, claimId, odClaimNum, actorOf(req));
    } catch (err) {
      if (respondToMatchError(res, office, err, { req, claimId })) return undefined;
      throw err;
    }

    // UPDATE, not READ: a chart linkage was recorded. `resourceId` is the claim
    // — an id we minted, never PHI — so unlike the list reads it is stamped.
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'rcm_claim_match',
      resourceId: claimId,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({ success: true, office, ...result });
  })
);

// ─── POST /:id/review ────────────────────────────────────────────────────────

/** A note is a person's sentence about a claim, not a document. */
const MAX_REVIEW_NOTE = 2000;

router.post(
  '/:id/review',
  requireQueue,
  h(async (req, res) => {
    const office = req.rcmOffice;
    const claimId = String(req.params.id);
    const raw = req.body && req.body.note;
    const note = typeof raw === 'string' ? raw.trim() : '';

    if (note.length > MAX_REVIEW_NOTE) {
      return res.status(400).json({
        success: false,
        error: `Note is too long (max ${MAX_REVIEW_NOTE} characters)`,
        code: 'NOTE_TOO_LONG',
      });
    }

    let result;
    try {
      result = await matchService.markReviewed(req, office, claimId, note || null, actorOf(req));
    } catch (err) {
      if (respondToMatchError(res, office, err, { req, claimId })) return undefined;
      throw err;
    }

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'rcm_claim_review',
      resourceId: claimId,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({ success: true, office, ...result });
  })
);

module.exports = router;
