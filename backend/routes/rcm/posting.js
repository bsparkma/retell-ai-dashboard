'use strict';

/**
 * /api/rcm/posting — the drain, and the queue it drains (Slice 6c).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE ROUTES, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE PERMISSION MODEL
 * ─────────────────────────────────────────────────────────────────────────────
 *   GET  /queue        the plans, their states, per-line progress   rcm.read
 *   GET  /queue/:id    one plan in full, with read-back evidence    rcm.read
 *   POST /drain        WRITE TO A PATIENT'S CHART                   rcm.write
 *
 * `POST /drain` is deliberately NOT in `routes/rcm/index.js` QUEUE_PATHS, so the
 * mount's `requireReadWrite('rcm.read','rcm.write')` demands `rcm.write` for it
 * by construction and a `reviewer` never reaches the handler. That is the same
 * ruling D-9 made for approve, and for a stronger reason: approving authorises
 * money to move, draining moves it.
 *
 * The two GETs run on `rcm.read`, which `reviewer` holds. Watching a plan post,
 * and reading why one is blocked, is not a posting act — and the person who did
 * the reviewing is the one best placed to see what her review produced. The
 * response says who CAN press it (`canDrain` / `drainRequires`) rather than
 * leaving a screen to infer it from a role name.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TRIGGER IS A HUMAN, AND ONLY A HUMAN
 * ─────────────────────────────────────────────────────────────────────────────
 * **No cron. No timer. No auto-drain on approve.** There is exactly one way a
 * chart gets written in this module: somebody presses this button.
 *
 * The startup sweep (`postingDrain.sweepInterruptedPostings`) is the single
 * automatic thing, and it does NOT drain — it re-homes rows a dead process left
 * mid-flight back to `approved` so a human can press the button again. A
 * container restart that posted payments by itself would be the opposite of
 * every rule in this module.
 *
 * Auto-drain on approve is a later decision, once the state machine has lived on
 * staging and Beau has watched it run. It is not a small change and it is not
 * this PR's to make.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BOUNDED, AND HONEST WHEN IT RUNS OUT
 * ─────────────────────────────────────────────────────────────────────────────
 * The drain is a held HTTP request, like the batch matcher, with a wall-clock
 * budget. At ≥1.2 s per Open Dental call (D-8 — the credential is shared with
 * the phones) a large plan is minutes, so the run stops cleanly BETWEEN rows and
 * returns `outOfTime: true` with how many are left. It never stops mid-claim:
 * that would deliberately open the failure window the whole queue exists to
 * survive.
 */

const express = require('express');

const tenantDb = require('../../platform/tenantDb');
const { audit } = require('../../platform/audit');
const { holdsPermission } = require('../../config/permissions');
const postingDrain = require('../../services/rcm/postingDrain');
const { SNAPSHOT_VERSION } = require('./matchService');
const { resolveRcmActor } = require('../../services/rcm/rcmUserMap');
const {
  h,
  isUuid,
  actorEmail,
  auditRcmRead,
  auditRcmDenial,
  num,
  iso,
  isoDate,
} = require('./helpers');

const router = express.Router();

/**
 * How many plans one page of the queue shows.
 *
 * Small, because this screen is watched rather than scanned: a practice has a
 * handful of checks in flight, not hundreds, and the per-line detail underneath
 * each row is what makes the page worth loading at all.
 */
const PAGE_SIZE = 50;

/**
 * Shape one queue row for the screen.
 *
 * `statusLabel` is the brief's vocabulary (`queued`, `running`) over the stored
 * one (`approved`, `posting`) — see `postingDrain.QUEUE_STATUS_LABEL` and the
 * migration header for why the stored words were not renamed. The raw `status`
 * ships alongside it so a client is never forced to reverse the mapping.
 */
function toQueueRow(row, label) {
  const status = String(row.status);
  const batch = label || {};
  return {
    queueId: String(row.queue_id),
    office: String(row.office_id),
    batchId: String(row.batch_id),
    status,
    statusLabel: postingDrain.QUEUE_STATUS_LABEL[status] || status,
    /** The machine reason, when blocked. The client renders copy from the slug. */
    blockedReason: row.blocked_reason == null ? null : String(row.blocked_reason),
    /** What the run was doing when it last persisted. */
    step: row.drain_step == null ? null : String(row.drain_step),
    isRecoupment: row.is_recoupment === true,
    carrierEobDate: isoDate(row.carrier_eob_date),
    intendedTotalCents: num(row.intended_total_cents),
    postedTotalCents: num(row.posted_total_cents),
    /** THE PROOF THE MONEY LANDED. Null until a check exists. */
    odClaimPaymentNum: row.od_claim_payment_num == null ? null : num(row.od_claim_payment_num),
    /**
     * When `GET /claimprocs?ClaimPaymentNum=` returned exactly this plan's
     * lines. A `posted` row cannot exist without it — the database refuses —
     * so the screen may say "verified by read-back at <time>" as a fact.
     */
    reconciledAt: iso(row.reconciled_at),
    approvedAt: iso(row.approved_at),
    approvedBy: row.approved_by == null ? null : String(row.approved_by),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    drainAttemptAt: iso(row.drain_attempt_at),
    drainedBy: row.drained_by == null ? null : String(row.drained_by),
    attemptCount: num(row.attempt_count),
    lastError: row.last_error == null ? null : String(row.last_error),
    checkNumber: batch.check_number == null ? null : String(batch.check_number),
    payer: batch.payer == null ? null : String(batch.payer),
  };
}

/**
 * Shape one line.
 *
 * The read-back verdict IS included. It is the evidence for the claim the row
 * makes — G2 means a 200 proves nothing, so "verified" is only meaningful next
 * to what was compared — and it carries money-shaped fields only: what we sent,
 * what Open Dental read back, and which fields disagreed. No patient identity
 * ever lands in that column and none is added here.
 */
function toLineRow(row) {
  return {
    queueLineId: String(row.queue_line_id),
    position: num(row.position),
    odClaimNum: row.od_claim_num == null ? null : num(row.od_claim_num),
    odClaimProcNum: num(row.od_claim_proc_num),
    status: String(row.status),
    skipReason: row.skip_reason == null ? null : String(row.skip_reason),
    intendedInsPayAmtCents: num(row.intended_ins_pay_amt_cents),
    intendedWriteOffCents: num(row.intended_write_off_cents),
    intendedDedAppliedCents: num(row.intended_ded_applied_cents),
    isSupplemental: row.is_supplemental === true,
    claimprocWrittenAt: iso(row.claimproc_written_at),
    claimReceivedAt: iso(row.claim_received_at),
    paidAt: iso(row.paid_at),
    odClaimPaymentNum: row.od_claim_payment_num == null ? null : num(row.od_claim_payment_num),
    readback: row.readback || null,
    readbackAt: iso(row.readback_at),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

/**
 * GET /queue — the plans for this office.
 *
 * Joined to the batch for the check number and payer, because a plan identified
 * only by a uuid is unrecognisable to the person who approved it. That join
 * brings no patient data: a payer name and a check number are the carrier's, not
 * the patient's.
 *
 * Counts per state come from the SAME query as the rows, over the whole office
 * rather than the page — the lesson `GET /remittances` learned when a client
 * filtered one page and called the result a total.
 */
router.get(
  '/queue',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const limit = Math.min(PAGE_SIZE, Math.max(1, Number(req.query.limit) || PAGE_SIZE));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    /*
     * TWO QUERIES RATHER THAN A JOIN — the module's idiom (see era.js's list),
     * and the reason is the same: the batch columns are a LABEL for the plan
     * (check number, payer) and joining them onto a paginated read makes the
     * page's shape depend on a second table's row existing. A plan whose batch
     * row is somehow missing must still list, unlabelled, rather than vanish.
     */
    const { rows, labels, counts, total } = await tenantDb.withTenantDb(req, async (pool) => {
      const page = await pool.query(
        `SELECT ${postingDrain.QUEUE_COLUMNS.join(', ')} FROM rcm_posting_queue ` +
          `WHERE office_id = $1 ORDER BY approved_at DESC LIMIT $2 OFFSET $3`,
        [office, limit, offset]
      );
      const batchIds = [...new Set(page.rows.map((r) => String(r.batch_id)))];
      const batches = batchIds.length
        ? await pool.query(
            `SELECT batch_id, check_number, payer FROM rcm_payment_batches ` +
              `WHERE office_id = $1 AND batch_id = ANY($2::uuid[])`,
            [office, batchIds]
          )
        : { rows: [] };
      const tally = await pool.query(
        `SELECT status, count(*)::int AS n FROM rcm_posting_queue WHERE office_id = $1 GROUP BY status`,
        [office]
      );
      return {
        rows: page.rows,
        labels: new Map(batches.rows.map((b) => [String(b.batch_id), b])),
        counts: tally.rows,
        total: tally.rows.reduce((a, r) => a + num(r.n), 0),
      };
    });

    /*
     * ZERO-FILLED over the CHECK's own vocabulary, so a state this office
     * happens to have no rows in reads as a measured 0 rather than as a missing
     * key a screen renders as "—".
     */
    const byStatus = {};
    for (const status of Object.keys(postingDrain.QUEUE_STATUS_LABEL)) byStatus[status] = 0;
    for (const row of counts) byStatus[String(row.status)] = num(row.n);

    // The list names no patient — payer, check number, amounts and states only —
    // so no PHI audit row is written for it. The DETAIL below is a different
    // question and audits.
    return res.json({
      success: true,
      office,
      rows: rows.map((r) => toQueueRow(r, labels.get(String(r.batch_id)))),
      byStatus,
      total,
      limit,
      offset,
      canDrain: holdsPermission(req, 'rcm.write'),
      drainRequires: 'rcm.write',
      /**
       * D-7, stated by the server rather than inferred by the client from an
       * office name. A screen that hardcoded "valley is off" would go stale the
       * day it is switched on.
       */
      postingEnabled: postingDrain.OFFICES_ENABLED_FOR_POSTING.includes(office),
    });
  })
);

/**
 * GET /queue/:id — one plan, with its lines and their read-back evidence.
 *
 * AUDITED, fail-closed. The lines name Open Dental claim and claimproc numbers
 * for one identified patient's chart, and the joined claim rows carry the
 * patient's name — that is a PHI read, and hard rule 5 says PHI is not served
 * without a recorded trail.
 */
router.get(
  '/queue/:id',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const queueId = String(req.params.id);
    if (!isUuid(queueId)) {
      await auditRcmDenial(req, 'rcm_posting_queue', queueId, { office });
      return res.status(404).json({ success: false, error: 'No such posting plan', code: 'QUEUE_NOT_FOUND' });
    }

    const found = await tenantDb.withTenantDb(req, async (pool) => {
      const q = await pool.query(
        `SELECT ${postingDrain.QUEUE_COLUMNS.join(', ')} FROM rcm_posting_queue ` +
          `WHERE queue_id = $1 AND office_id = $2`,
        [queueId, office]
      );
      if (q.rows.length === 0) return null;
      const batch = await pool.query(
        `SELECT batch_id, check_number, payer FROM rcm_payment_batches ` +
          `WHERE office_id = $1 AND batch_id = $2`,
        [office, String(q.rows[0].batch_id)]
      );
      const lines = await pool.query(
        `SELECT ${postingDrain.LINE_COLUMNS.join(', ')} FROM rcm_posting_queue_line ` +
          `WHERE queue_id = $1 AND office_id = $2 ORDER BY position`,
        [queueId, office]
      );
      const claims = await pool.query(
        `SELECT claim_id, claim_number, patient_name, od_claim_num FROM rcm_claims ` +
          `WHERE posting_queue_id = $1 AND office_id = $2`,
        [queueId, office]
      );
      return { row: q.rows[0], batch: batch.rows[0] || null, lines: lines.rows, claims: claims.rows };
    });

    if (!found) {
      await auditRcmDenial(req, 'rcm_posting_queue', queueId, { office });
      return res.status(404).json({ success: false, error: 'No such posting plan', code: 'QUEUE_NOT_FOUND' });
    }

    await auditRcmRead(req, 'rcm_posting_queue', { office, resourceId: queueId });

    return res.json({
      success: true,
      office,
      plan: toQueueRow(found.row, found.batch),
      lines: found.lines.map(toLineRow),
      claims: found.claims.map((c) => ({
        claimId: String(c.claim_id),
        claimNumber: c.claim_number == null ? null : String(c.claim_number),
        patientName: c.patient_name == null ? null : String(c.patient_name),
        odClaimNum: c.od_claim_num == null ? null : num(c.od_claim_num),
      })),
      canDrain: holdsPermission(req, 'rcm.write'),
      drainRequires: 'rcm.write',
      postingEnabled: postingDrain.OFFICES_ENABLED_FOR_POSTING.includes(office),
      /**
       * The seam 6d fills. Said out loud rather than omitted: a plan that is
       * `posted` with no EOB in the chart is a complete and honest description
       * of what happened, and a screen that showed nothing here would leave a
       * biller assuming the PDF was filed.
       */
      documentAttach: {
        implemented: false,
        note: 'The EOB PDF is not yet filed into the patient images — that is a later slice.',
      },
    });
  })
);

/**
 * POST /drain — write to Open Dental.
 *
 * The one route in this module that changes a patient's chart.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT TAKE
 * ─────────────────────────────────────────────────────────────────────────────
 * No claim list, no amounts, no `force`, no `office_id` in the body. The office
 * is the router-wide validated `?office=` param; everything else is read from
 * the plan the gate wrote. There is nothing a request can say that changes
 * WHICH chart is written or WHAT is written to it — the same property
 * `send-to-TC` has, for the same reason.
 *
 * `queueId` is accepted as an OPTIONAL narrowing: it drains that one plan
 * instead of the office's whole waiting set. It can only ever reduce what runs,
 * and a plan belonging to another office is simply not found.
 */
router.post(
  '/drain',
  h(async (req, res) => {
    const office = req.rcmOffice;

    /*
     * Defence in depth. The mount already demands `rcm.write` for this POST —
     * it is not in QUEUE_PATHS — so a `reviewer` never arrives here. This check
     * exists so a future remount, or this route copied to an exempt path, still
     * refuses, and so the refusal carries a sentence about posting rather than
     * the platform's generic one.
     */
    if (!holdsPermission(req, 'rcm.write')) {
      await auditRcmDenial(req, 'rcm_posting_drain', null, { office, result: 'UNAUTHORIZED' });
      return res.status(403).json({
        success: false,
        error: 'Posting to Open Dental needs posting permission — ask an approver to press it',
        code: 'DRAIN_REQUIRES_WRITE',
        action: 'rcm.write',
      });
    }

    const email = actorEmail(req);
    const displayName = (req.user && (req.user.name || req.user.displayName)) || email;

    /*
     * D-5 attribution, resolved BEFORE the run so `drained_by`'s FK is
     * satisfiable by the first statement the drain writes. Open Dental cannot
     * attribute an API write to a human at all (every row it writes logs
     * `UserNum 0`), so this crosswalk key plus one audit row per call is the
     * entire record that a person did this.
     */
    const drainedBy = await tenantDb.withTenantDb(req, (pool) =>
      resolveRcmActor(pool, { email, displayName })
    );

    let result;
    try {
      result = await tenantDb.withTenantDb(req, (pool) =>
        postingDrain.drainOffice({
          pool,
          req,
          office,
          operator: displayName,
          drainedBy,
          snapshotVersion: SNAPSHOT_VERSION,
          onlyQueueId: typeof req.body?.queueId === 'string' ? req.body.queueId : null,
        })
      );
    } catch (err) {
      if (err && err.code === 'DRAIN_ALREADY_RUNNING') {
        return res.status(409).json({
          success: false,
          error:
            'A posting run is already under way. Wait for it to finish — running two at once ' +
            'would re-issue writes the first is part-way through.',
          code: 'DRAIN_ALREADY_RUNNING',
        });
      }
      if (err && err.code && String(err.code).startsWith('OFFICE_')) {
        // The per-office registry refused: unknown office, not OD-connected, or
        // switched on with no customer key. None of these falls back to another
        // practice's client, and none of them is an internal error.
        return res.status(err.code === 'OFFICE_OD_KEY_MISSING' ? 503 : 409).json({
          success: false,
          error: err.userMessage || err.message,
          code: err.code,
        });
      }
      throw err;
    }

    /*
     * ONE `CREATE` ROW FOR THE RUN, on top of the per-call rows the drain
     * already wrote. The run is the thing a human did; the calls are what it
     * did. Written after the fact, like the approve audit, because what is being
     * recorded has already durably happened.
     */
    await audit(req, {
      action: 'CREATE',
      resourceType: 'rcm_posting_drain',
      resourceId: null,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({
      success: true,
      office,
      /** One entry per plan this run touched, in the order it touched them. */
      outcomes: result.outcomes,
      ran: result.ran,
      /**
       * The run hit its wall-clock budget and stopped BETWEEN rows. `remaining`
       * is how many plans are still waiting — press Drain again.
       */
      outOfTime: result.outOfTime,
      remaining: result.remaining,
      /**
       * Which per-office DefNums this run resolved from THIS practice's own
       * Open Dental. Configuration, not patient data, and the thing that makes
       * "the numbers never cross" checkable by the person who owns both
       * practices rather than merely asserted in a doc.
       */
      config: result.config || null,
      postingEnabled: postingDrain.OFFICES_ENABLED_FOR_POSTING.includes(office),
    });
  })
);

module.exports = router;
