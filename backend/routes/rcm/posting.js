'use strict';

/**
 * /api/rcm/posting — the drain, and the queue it drains (Slice 6c).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE ROUTES, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE PERMISSION MODEL
 * ─────────────────────────────────────────────────────────────────────────────
 *   GET  /queue        the plans, their states, per-line progress   rcm.read
 *   GET  /queue/:id    one plan in full, with read-back evidence    rcm.read
 *   POST /drain        WRITE TO A PATIENT'S CHART                   rcm.post
 *
 * `POST /drain` is deliberately NOT in `routes/rcm/index.js` QUEUE_PATHS, so the
 * mount's `requireReadWrite('rcm.read','rcm.write')` demands `rcm.write` for it
 * by construction and a `reviewer` never reaches the handler. That is the same
 * ruling D-9 made for approve, and for a stronger reason: approving authorises
 * money to move, draining moves it.
 *
 * ON TOP OF THAT, the three routes that reach a chart or retire a plan carry an
 * explicit `requirePermission('rcm.post')` — the "a specific gate narrows the
 * general one" idiom. `rcm_biller` holds `rcm.write` and NOT `rcm.post`, so a
 * biller works a remittance all the way to `approved` and stops there.
 *
 * The two GETs run on `rcm.read`, which `reviewer` holds. Watching a plan post,
 * and reading why one is blocked, is not a posting act — and the person who did
 * the reviewing is the one best placed to see what her review produced. The
 * response says who CAN press it (`canDrain` / `drainRequires`) rather than
 * leaving a screen to infer it from a role name.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SHADOW GATE
 * ─────────────────────────────────────────────────────────────────────────────
 * A press of Drain needs BOTH conditions (see services/rcm/postingGate.js): the
 * office is in the code-level ceiling `OFFICES_ENABLED_FOR_POSTING`, AND its
 * `rcm_office_settings` row says `drain_enabled`. The second is read HERE, per
 * press, and never cached — a switch a human flips so the NEXT press behaves
 * differently is worthless if the answer is an hour old.
 *
 * The refusal is the ROUTE's, and it leaves the plans exactly where they are.
 * That is the difference from D-7, which blocks each row: valley is refused
 * because posting there has never been validated, and a blocked row per plan is
 * how the queue says so. Shadow mode is a switch somebody will flip this week,
 * and marking twenty approved plans `blocked` on the way would make the biller
 * re-press each one afterwards to clear a state that was never about them.
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
const { holdsPermission, requirePermission } = require('../../config/permissions');
const postingDrain = require('../../services/rcm/postingDrain');
const postingGate = require('../../services/rcm/postingGate');
/*
 * READ-ONLY USES, both of them, for `POST /:id/recheck`.
 *
 * `odPostingWrites` is the one file allowed to reach an Open Dental write verb
 * (§13). What is named here are its two GET helpers — `readClaimProcsForClaim`
 * and `readAdjustmentsForPatient` — plus the transport factory. The static scan
 * in `rcmNoOdWrites.test.js` forbids naming a WRITE verb anywhere outside that
 * file, and this route names none.
 */
const odPostingWrites = require('../../services/rcm/odPostingWrites');
const lineDecisions = require('../../services/rcm/lineDecisions');
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
    /**
     * The withdrawal, when there is one. A slug the client renders copy from,
     * and — separately — the sentence a human typed. Kept apart because a
     * biller withdrawing a plan knows something the machine does not, and
     * folding her words into the slug would make the slug unusable.
     */
    withdrawnReason: row.withdrawn_reason == null ? null : String(row.withdrawn_reason),
    withdrawnNote: row.withdrawn_note == null ? null : String(row.withdrawn_note),
    withdrawnAt: iso(row.withdrawn_at),
    /** What the run was doing when it last persisted. */
    step: row.drain_step == null ? null : String(row.drain_step),
    isRecoupment: row.is_recoupment === true,
    /** 6d: the EOB filing, on its own axis. Null = not attempted. */
    documentAttachStatus:
      row.document_attach_status == null ? null : String(row.document_attach_status),
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
    /**
     * 6d. Which takeback path this line was AUTHORISED for, and what it left in
     * the chart. The two ids are separate because one can be undone and one
     * cannot, and "is this reversible" is the only question that matters about
     * a takeback after the fact.
     */
    recoupmentPath: row.recoupment_path == null ? null : String(row.recoupment_path),
    odAdjustmentNum: row.od_adjustment_num == null ? null : num(row.od_adjustment_num),
    odSupplementalClaimProcNum:
      row.od_supplemental_claim_proc_num == null
        ? null
        : num(row.od_supplemental_claim_proc_num),
    claimprocWrittenAt: iso(row.claimproc_written_at),
    claimReceivedAt: iso(row.claim_received_at),
    paidAt: iso(row.paid_at),
    odClaimPaymentNum: row.od_claim_payment_num == null ? null : num(row.od_claim_payment_num),
    readback: row.readback || null,
    readbackAt: iso(row.readback_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    /*
     * ── WHAT THE OFFICE ITSELF DECIDED, AND WHAT THE CHECK PROMISED ──────────
     *
     * Already selected by `LINE_COLUMNS` and, until Stage C, never rendered.
     * The finished screen has to be able to say what LANDED in Open Dental —
     * the carrier's contractual write-off is one number and the office's own
     * concession is another, and a screen that showed only their sum would be
     * showing a figure nobody decided.
     *
     * `decidedWriteOffCents` is NULL — never 0 — when nobody decided anything,
     * and the three decision fields are frozen together or not at all.
     * `intendedPatientCents` is what the approve PROMISED, which is the figure
     * the confirmation measures against; NULL on a plan approved before B2, and
     * the screen states the weaker guarantee rather than hiding it.
     */
    decidedWriteOffCents:
      row.decided_write_off_cents == null ? null : num(row.decided_write_off_cents),
    decidedReason: row.decided_reason == null ? null : String(row.decided_reason),
    decidedBy: row.decided_by == null ? null : String(row.decided_by),
    intendedPatientCents:
      row.intended_patient_cents == null ? null : num(row.intended_patient_cents),
    odWriteoffAdjustmentNum:
      row.od_writeoff_adjustment_num == null ? null : num(row.od_writeoff_adjustment_num),
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
    const { rows, labels, counts, total, settings } = await tenantDb.withTenantDb(req, async (pool) => {
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
        // The shadow gate, so the screen renders the SERVER's answer rather than
        // discovering it by pressing a button and being refused.
        settings: await postingGate.readOfficeSettings(pool, office),
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
      canDrain: holdsPermission(req, 'rcm.post'),
      drainRequires: 'rcm.post',
      /**
       * D-7, stated by the server rather than inferred by the client from an
       * office name. A screen that hardcoded "valley is off" would go stale the
       * day it is switched on.
       */
      postingEnabled: postingDrain.OFFICES_ENABLED_FOR_POSTING.includes(office),
      /**
       * THE SHADOW GATE, on its own axis and deliberately not folded into
       * `postingEnabled`.
       *
       * They are different facts with different remedies. `postingEnabled:
       * false` means this practice has never been validated and the fix is a
       * code change with the evidence in the same commit; `drainEnabled: false`
       * means an admin has not switched it on yet and the fix is one toggle. A
       * screen that showed one sentence for both would send a biller to the
       * wrong person.
       */
      drainEnabled: settings.drainEnabled,
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
      // 6d: one row per patient the EOB was filed into. Ordered so a screen
      // showing three patients shows them the same way twice running.
      const documents = await pool.query(
        `SELECT od_patient_id, od_doc_num, description, status, error, attached_at ` +
          `FROM rcm_posting_document WHERE queue_id = $1 AND office_id = $2 ` +
          `ORDER BY od_patient_id`,
        [queueId, office]
      );
      return {
        row: q.rows[0],
        batch: batch.rows[0] || null,
        lines: lines.rows,
        claims: claims.rows,
        documents: documents.rows,
        settings: await postingGate.readOfficeSettings(pool, office),
      };
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
      canDrain: holdsPermission(req, 'rcm.post'),
      drainRequires: 'rcm.post',
      postingEnabled: postingDrain.OFFICES_ENABLED_FOR_POSTING.includes(office),
      /** The shadow gate — see GET /queue for why it is on its own axis. */
      drainEnabled: found.settings.drainEnabled,
      /**
       * THE EOB FILING — 6d FILLED THIS SEAM, so it no longer says "not yet".
       *
       * It is reported on its OWN axis rather than folded into `plan.status`,
       * because §8 puts the document last precisely on the grounds that *"a
       * document failure is retryable and never a financial error"*. A plan
       * whose money is correct and proven stays `posted` whether or not a PDF
       * reached the chart.
       *
       * `null` AND `none` ARE DIFFERENT, and the difference is outstanding work.
       *
       *   `null`  not attempted, and ONLY that. On a plan that has not posted
       *           yet it is simply too early; on a POSTED plan it means the
       *           attach never ran — most likely the process died between the
       *           two — so the screen offers the retry, exactly as for `failed`.
       *   `none`  examined, and there is genuinely nothing to file: an 835 that
       *           arrived with no document. No retry; nothing is behind it.
       *
       * An earlier draft used `null` for both, which let a plan sit green with
       * an EOB silently missing from a chart.
       */
      documentAttach: {
        implemented: true,
        status: found.row.document_attach_status == null
          ? null
          : String(found.row.document_attach_status),
        error: found.row.document_attach_error == null
          ? null
          : String(found.row.document_attach_error),
        at: iso(found.row.document_attach_at),
        /** One row per patient on the plan. The DocNum is the read-back proof. */
        documents: found.documents.map((d) => ({
          odPatientId: num(d.od_patient_id),
          odDocNum: d.od_doc_num == null ? null : num(d.od_doc_num),
          description: d.description == null ? null : String(d.description),
          status: String(d.status),
          error: d.error == null ? null : String(d.error),
          attachedAt: iso(d.attached_at),
        })),
        canRetry: holdsPermission(req, 'rcm.post'),
        retryRequires: 'rcm.post',
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
  /*
   * THE NARROWING GATE. The mount already demands `rcm.write` for this POST —
   * it is not in QUEUE_PATHS — which keeps a `reviewer` out. `rcm.post` is the
   * narrower tier on top, and it is what keeps an `rcm_biller` out: a biller
   * works a remittance to `approved` and stops. Named here as middleware rather
   * than only in the handler so `rcmGuard.test.js` can walk the router and SEE
   * which tier each route carries.
   */
  requirePermission('rcm.post'),
  h(async (req, res) => {
    const office = req.rcmOffice;

    /*
     * Defence in depth, behind the gate above. This check exists so a future
     * remount, or this route copied to an exempt path, still refuses, and so
     * the refusal carries a sentence about posting rather than the platform's
     * generic one.
     */
    if (!holdsPermission(req, 'rcm.post')) {
      await auditRcmDenial(req, 'rcm_posting_drain', null, { office, result: 'UNAUTHORIZED' });
      return res.status(403).json({
        success: false,
        error: 'Posting to Open Dental needs posting permission — ask an approver to press it',
        code: 'DRAIN_REQUIRES_WRITE',
        action: 'rcm.post',
      });
    }

    /*
     * ─────────────────────────────────────────────────────────────────────────
     * THE SHADOW GATE — BEFORE ANY OPEN DENTAL CALL, AND BEFORE ANY WRITE OF
     * OURS
     * ─────────────────────────────────────────────────────────────────────────
     * Read here, per press, never cached. It runs BEFORE `resolveRcmActor` on
     * purpose: that call upserts a crosswalk row, and a refused press should
     * leave nothing behind but its audit line.
     *
     * The plans are NOT touched. No row is claimed, no row is blocked, no
     * `attempt_count` moves — a plan sitting at `approved` in shadow mode is
     * exactly what it says it is, and the biller who approved it should find it
     * unchanged tomorrow when an admin flips the switch.
     *
     * ONE AUDIT ROW PER PRESS, not per plan. What happened is that a person
     * pressed a button and was refused; twenty rows would describe twenty
     * refusals that never happened.
     */
    const settings = await tenantDb.withTenantDb(req, (pool) =>
      postingGate.readOfficeSettings(pool, office)
    );
    if (!settings.drainEnabled) {
      /*
       * `ERROR`, and there is no better member to reach for.
       *
       * `audit_log.result` is closed at three by a DB CHECK
       * (`1780453117650_audit_log.js`): SUCCESS | UNAUTHORIZED | ERROR. This
       * refusal is neither of the first two — the actor HELD `rcm.post`; the
       * practice is switched off — so `UNAUTHORIZED` would libel the biller in
       * the one record that outlives the screen. `ERROR` is the established
       * shape for "refused, and not the actor's fault" (`claims.js` uses it the
       * same way). If the vocabulary ever gains a REFUSED member, this line and
       * that one move together.
       */
      await auditRcmDenial(req, 'rcm_posting_drain', null, { office, result: 'ERROR' });
      return res.status(409).json({
        success: false,
        error:
          `Posting is switched off for this practice (shadow mode). Approved plans wait here ` +
          `until an administrator switches posting on. Nothing was sent to Open Dental.`,
        code: 'DRAIN_DISABLED_FOR_OFFICE',
        /*
         * The slug, in the field the queue's own refusals use. It is NOT a
         * `blocked_reason`: no plan moved to `blocked`, and nothing in
         * `BLOCK_REASONS` can hold it. The client renders copy from it exactly
         * as it does for a blocked plan.
         */
        blocked: postingGate.DRAIN_DISABLED,
        office,
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
      /*
       * ANYTHING ELSE IS A DEFECT, AND THE OPERATOR IS OWED THE SENTENCE.
       *
       * `h()` turns an unhandled throw into a flat `Internal error`, which is
       * what the first staging walk showed a biller when the drain hit
       * `column "od_patient_office" does not exist`. That banner cost an hour:
       * the one fact that named the bug in seconds was discarded one layer
       * above the code that had it.
       *
       * Safe here, and only here: this is the same text the drain already
       * writes into `last_error` and the queue screen already renders, shown to
       * the same authenticated, tenant-scoped, `rcm.write`-holding person. It
       * is not a new audience for anything, and the generic handler stays
       * generic for every other route.
       *
       * The plan itself is not left mid-flight — `drainRow` hands a row back to
       * `approved` before the exception escapes it.
       */
      return res.status(500).json({
        success: false,
        error: err && err.message ? err.message : String(err),
        code: 'DRAIN_FAILED',
      });
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
      /**
       * Non-zero only when `RCM_DRAIN_STEP_DELAY_MS` is set AND the environment
       * could prove it is not production. Reported so a staging run that took
       * minutes reads as deliberate rather than as the drain having hung —
       * the same honest-states reasoning as `outOfTime`.
       */
      stepDelayMs: result.stepDelayMs || 0,
      postingEnabled: postingDrain.OFFICES_ENABLED_FOR_POSTING.includes(office),
    });
  })
);

/**
 * POST /queue/:id/withdraw — retire a plan that must never run.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE THING IN THIS MODULE THAT TAKES A PLAN OFF THE BOARD
 * ─────────────────────────────────────────────────────────────────────────────
 * A plan can be approved for money that is never going to post through CareIN.
 * Its Open Dental claim was deleted; the remittance was re-keyed by hand; the
 * biller posted it in the desktop and only then found the queue. Until now the
 * only honest thing the queue could do was keep offering to drain it.
 *
 * `withdrawn` is terminal and is NOT in `DRAINABLE_STATUSES`, so a withdrawn
 * plan cannot be pressed at all. That is the difference from `blocked`, which
 * §2.2.1 defines by the promise that it HAS a way out.
 *
 * **It is not a delete.** The plan, its lines, its approval and its audit trail
 * stay. `rcm_posting_queue` is unique on `(office_id, remittance_key)` — a
 * remittance gets exactly one plan, ever (§15.1) — so deleting the row would
 * silently make a second plan enqueueable for the same money.
 *
 * **A note is required.** Every other refusal in this module is the machine's,
 * and carries a slug the UI renders copy from. This one is a person's, and the
 * only record of why is what she types. A `withdrawn` plan with no account of
 * itself would be the queue quietly losing money nobody can later explain, so
 * the note is a 400 rather than an optional field. (The drain's own automatic
 * withdrawal carries `target_removed` instead and writes no note — there is no
 * human in that path, and making the machine invent prose is the habit
 * `blocked_reason` exists to avoid.)
 *
 * `rcm.post`, alongside the drain. D-9 splits reading from writing; retiring a
 * plan does not write to a chart, but it does decide that money will NEVER be
 * posted, which is the same authority as deciding it will — and it is the one
 * decision here that cannot be taken back, since `withdrawn` is terminal. A
 * biller who believes a plan must never run escalates rather than retiring it.
 */
router.post(
  '/queue/:id/withdraw',
  requirePermission('rcm.post'),
  h(async (req, res) => {
    const office = req.rcmOffice;
    const queueId = String(req.params.id);

    if (!holdsPermission(req, 'rcm.post')) {
      await auditRcmDenial(req, 'rcm_posting_withdrawal', queueId, {
        office,
        result: 'UNAUTHORIZED',
      });
      return res.status(403).json({
        success: false,
        error: 'Retiring a posting plan needs posting permission — ask an approver',
        code: 'WITHDRAW_REQUIRES_WRITE',
        action: 'rcm.post',
      });
    }

    if (!isUuid(queueId)) {
      await auditRcmDenial(req, 'rcm_posting_queue', queueId, { office });
      return res
        .status(404)
        .json({ success: false, error: 'No such posting plan', code: 'QUEUE_NOT_FOUND' });
    }

    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (note.length < 3) {
      await auditRcmDenial(req, 'rcm_posting_withdrawal', queueId, { office });
      return res.status(400).json({
        success: false,
        error:
          'Say why this plan is being retired. It is the only record of the decision — ' +
          'the plan stays in the queue forever, and nothing else will explain it.',
        code: 'WITHDRAW_NOTE_REQUIRED',
      });
    }

    const email = actorEmail(req);
    const displayName = (req.user && (req.user.name || req.user.displayName)) || email;

    const outcome = await tenantDb.withTenantDb(req, async (pool) => {
      // D-5 attribution, resolved first so the FK on `withdrawn_by` is
      // satisfiable by the statement that sets it.
      const withdrawnBy = await resolveRcmActor(pool, { email, displayName });
      return postingDrain.withdrawRow(pool, office, queueId, {
        reason: postingDrain.WITHDRAW_REASONS.MANUAL,
        note,
        by: withdrawnBy,
      });
    });

    if (!outcome.withdrawn && outcome.status === undefined) {
      await auditRcmDenial(req, 'rcm_posting_queue', queueId, { office });
      return res
        .status(404)
        .json({ success: false, error: 'No such posting plan', code: 'QUEUE_NOT_FOUND' });
    }

    if (!outcome.withdrawn) {
      /*
       * The status is named back, because "you cannot withdraw this" is useless
       * without "because it is already posted". The two families read very
       * differently to a biller and the message says which one she is in.
       */
      await auditRcmDenial(req, 'rcm_posting_withdrawal', queueId, { office });
      const posted = ['posted', 'partially_posted'].includes(outcome.status);
      return res.status(409).json({
        success: false,
        error: posted
          ? 'This plan has already put money in the chart. Retiring it would make the ' +
            'queue disagree with Open Dental — reverse it in Open Dental instead.'
          : outcome.status === 'posting'
            ? 'A run holds this plan right now. Wait for it to finish.'
            : `A plan in '${outcome.status}' cannot be retired.`,
        code: 'WITHDRAW_NOT_ALLOWED',
        status: outcome.status,
      });
    }

    /*
     * Audited as a CREATE of a withdrawal rather than an UPDATE of a plan. The
     * thing that happened is a decision a person made, and `resource_type` is
     * where this platform expresses which decision — the same reasoning that
     * kept `rcm_recoupment_approval` out of `audit_log`'s action vocabulary.
     *
     * The NOTE IS NOT COPIED INTO THE AUDIT ROW. It is free text a biller typed
     * and may name a patient; the audit trail records that a withdrawal happened,
     * by whom, on which plan, and the plan row itself carries the words.
     */
    await audit(req, {
      action: 'CREATE',
      resourceType: 'rcm_posting_withdrawal',
      resourceId: queueId,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({
      success: true,
      queueId,
      status: 'withdrawn',
      withdrawnReason: postingDrain.WITHDRAW_REASONS.MANUAL,
    });
  })
);

/**
 * POST /queue/:id/attach-document — re-file an EOB that did not file (6d).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A FAILED ATTACH GETS ITS OWN BUTTON RATHER THAN "DRAIN AGAIN"
 * ─────────────────────────────────────────────────────────────────────────────
 * `posted` is the only terminal plan state, and a plan whose EOB failed to file
 * IS posted — the money is correct and proven. Re-draining it would be pressing
 * the money button to fix a document, and the drain would correctly find nothing
 * to do. So the retry acts on the document axis alone and cannot move a cent:
 * `retryDocumentAttach` refuses any plan that is not already `posted`, and the
 * only Open Dental verb it can reach is the document upload.
 *
 * It is `rcm.post` all the same. D-9's split is about what a role may put IN a
 * patient's chart, not about how much money is involved — and a PDF filed into
 * somebody's images is a chart write. The shadow gate applies for the same
 * reason: "no Open Dental write while posting is switched off" is a claim about
 * the CHART, not about money, so a plan that posted before the switch was
 * turned off cannot file its EOB afterwards either.
 *
 * Pressing it twice is safe by construction: the attach lists the patient's own
 * documents first and adopts one already carrying this plan's description,
 * rather than filing a second copy of the same EOB.
 */
router.post(
  '/queue/:id/attach-document',
  requirePermission('rcm.post'),
  h(async (req, res) => {
    const office = req.rcmOffice;
    const queueId = String(req.params.id);

    if (!holdsPermission(req, 'rcm.post')) {
      await auditRcmDenial(req, 'rcm_od_document', queueId, { office, result: 'UNAUTHORIZED' });
      return res.status(403).json({
        success: false,
        error: 'Filing a document into a patient chart needs posting permission',
        code: 'ATTACH_REQUIRES_WRITE',
        action: 'rcm.post',
      });
    }

    // The shadow gate, before the transport is resolved — same refusal, same
    // slug, same "nothing was touched" as the drain.
    const settings = await tenantDb.withTenantDb(req, (pool) =>
      postingGate.readOfficeSettings(pool, office)
    );
    if (!settings.drainEnabled) {
      await auditRcmDenial(req, 'rcm_od_document', queueId, { office, result: 'ERROR' });
      return res.status(409).json({
        success: false,
        error:
          'Posting is switched off for this practice (shadow mode). Nothing was sent to ' +
          'Open Dental.',
        code: 'DRAIN_DISABLED_FOR_OFFICE',
        blocked: postingGate.DRAIN_DISABLED,
        office,
      });
    }

    if (!isUuid(queueId)) {
      await auditRcmDenial(req, 'rcm_posting_queue', queueId, { office });
      return res
        .status(404)
        .json({ success: false, error: 'No such posting plan', code: 'QUEUE_NOT_FOUND' });
    }

    let outcome;
    try {
      outcome = await tenantDb.withTenantDb(req, (pool) =>
        postingDrain.retryDocumentAttach({ pool, req, office }, queueId)
      );
    } catch (err) {
      if (err && err.code && String(err.code).startsWith('OFFICE_')) {
        // The per-office registry refused. Never falls back to another
        // practice's client, and never an internal error.
        return res.status(err.code === 'OFFICE_OD_KEY_MISSING' ? 503 : 409).json({
          success: false,
          error: err.userMessage || err.message,
          code: err.code,
        });
      }
      throw err;
    }

    if (outcome.code === 'QUEUE_NOT_FOUND') {
      await auditRcmDenial(req, 'rcm_posting_queue', queueId, { office });
      return res
        .status(404)
        .json({ success: false, error: 'No such posting plan', code: 'QUEUE_NOT_FOUND' });
    }
    if (outcome.code === 'PLAN_NOT_POSTED') {
      return res.status(409).json({
        success: false,
        error:
          'This plan has not posted yet, so there is no payment for an EOB to document. ' +
          'The EOB files itself when the plan posts.',
        code: 'PLAN_NOT_POSTED',
        queueStatus: outcome.status,
      });
    }

    return res.json({ success: true, office, queueId, documentAttach: outcome.result });
  })
);

/**
 * POST /:id/recheck — ASK OPEN DENTAL AGAIN, AND WRITE NOTHING.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS ROUTE EXISTS
 * ═════════════════════════════════════════════════════════════════════════════
 * A plan that came back `partially_posted` is stuck on ONE thing: Open Dental
 * does not say about the patient's balance what the check promised. Money moved,
 * every carrier-side proof passed, and the patient's own number is wrong.
 *
 * The remedy is a person going into Open Dental and correcting whatever the
 * sentence names. Then she wants to ask one question — *is it right now?* —
 * and until this route existed the only way to ask it was to press Post again,
 * because the confirmation ran inside the post.
 *
 * "Press Post again to find out whether it posted" is the kind of sentence this
 * project keeps deleting. Pressing the one button that writes to a chart, in
 * order to READ, is a shape nobody should have to reason about at 6pm.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT CANNOT WRITE. THAT IS THE WHOLE POINT, AND IT IS STRUCTURAL.
 * ─────────────────────────────────────────────────────────────────────────────
 *   · It calls exactly two Open Dental verbs, both GETs:
 *     `readClaimProcsForClaim` and `readAdjustmentsForPatient`.
 *   · It reaches no write verb — `rcmNoOdWrites.test.js`'s static scan already
 *     forbids naming one outside `odPostingWrites.js`, and the drive-it test
 *     asserts a recheck yields no write.
 *   · It writes nothing to CareIN's own database either — not the plan's status,
 *     not `rcm_claims.confirmed_verdict`, not an attempt stamp. It ANSWERS a
 *     question; the answer is not a state change, and persisting one from a read
 *     would make a look identical to a post in the record.
 *   · Every Open Dental read it makes is audited as a READ, per claim and per
 *     patient, exactly as the drain audits the same two calls.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT IS THE SAME ARITHMETIC, FROM THE SAME FUNCTION
 * ─────────────────────────────────────────────────────────────────────────────
 * `postingDrain.confirmLineFor` assembles each line and `verdictFor`'s CONFIRMED
 * register judges it — the identical pair the drain's `confirm_patient` step
 * uses. A second implementation would drift, and the drift would be invisible:
 * both screens would print a confident sentence and one would be measuring the
 * wrong thing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS A POST AND NOT A GET
 * ─────────────────────────────────────────────────────────────────────────────
 * It spends real Open Dental calls against a rate-limited credential the voice
 * side shares. A GET is a thing browsers, prefetchers and link previews fire
 * without being asked; this is a thing a person presses. The method says which.
 * It is still a READ in every sense the audit log cares about, and it is audited
 * as one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH PLANS IT WILL ANSWER FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Only ones that have actually posted — `posted` and `partially_posted`. On
 * anything else there is no check in Open Dental to read back, and a
 * "confirmation" over a plan that never wrote would be a projection wearing a
 * confirmation's words. `NOTHING_POSTED_YET` says so.
 */
router.post(
  '/:id/recheck',
  /*
   * `rcm.queue` — THE REVIEWING TIER, and an EXPLICIT gate rather than the
   * mount's default.
   *
   * The mount demands `rcm.write` for every POST not enumerated in
   * `QUEUE_PATHS`. This one is enumerated, because what it does is READ —
   * demanding write authority to look would put the person best placed to
   * notice a wrong balance behind a permission she does not need.
   *
   * But `rcmGuard.test.js` holds a rule that is worth more than the
   * convenience: EVERY path the write exemption opens must carry a gate of its
   * own, or a route added at one of those paths later is reachable by anyone the
   * module guard let through. So this names its tier out loud.
   *
   * `rcm.queue` is the tier that marks a claim reviewed and that parks and sets
   * aside a check — reviewer, rcm_biller, office and admin all hold it. Asking
   * Open Dental a question about a check somebody already posted is the same
   * class of act, and it is strictly narrower: it writes nothing at all.
   */
  requirePermission('rcm.queue'),
  h(async (req, res) => {
    const office = req.rcmOffice;
    const queueId = String(req.params.id);
    if (!isUuid(queueId)) {
      await auditRcmDenial(req, 'rcm_posting_queue', queueId, { office });
      return res
        .status(404)
        .json({ success: false, error: 'No such posting plan', code: 'QUEUE_NOT_FOUND' });
    }

    const plan = await tenantDb.withTenantDb(req, (pool) =>
      postingDrain.loadPlan(pool, office, queueId)
    );
    if (!plan) {
      await auditRcmDenial(req, 'rcm_posting_queue', queueId, { office });
      return res
        .status(404)
        .json({ success: false, error: 'No such posting plan', code: 'QUEUE_NOT_FOUND' });
    }

    const status = String(plan.queue.status);
    if (status !== 'posted' && status !== 'partially_posted') {
      return res.status(409).json({
        success: false,
        error:
          'Nothing has been posted for this check yet, so there is nothing in Open Dental to read back.',
        code: 'NOTHING_POSTED_YET',
        status,
      });
    }

    /*
     * ORDINARY LINES ONLY. A takeback line writes a supplemental or an
     * adjustment and has no patient remainder to confirm — the drain's own
     * confirmation skips them for the same reason.
     */
    const lines = plan.lines.filter((l) => !l.isSupplemental && l.odClaimProcNum != null);
    if (lines.length === 0) {
      return res.status(409).json({
        success: false,
        error: 'This check has no ordinary claim lines to read back.',
        code: 'NOTHING_TO_CONFIRM',
      });
    }

    const claimById = new Map(plan.claims.map((c) => [c.claimId, c]));
    const grouped = postingDrain.groupByClaim(lines);
    const od = odPostingWrites.postingTransportFor(office);

    /*
     * THE LEDGER CONCESSIONS, read back by AdjNum rather than assumed. One list
     * read per patient, and only for lines that actually booked one — a plan
     * that booked none never asks the question at all.
     */
    const concessionByLine = new Map();
    const ledgerByPatient = new Map();
    for (const line of lines) {
      const adjNum = line.odWriteoffAdjustmentNum;
      if (!adjNum) continue;
      const claim = claimById.get(line.claimId);
      const patNum = claim && claim.odPatientId;
      if (!patNum) continue;
      if (!ledgerByPatient.has(patNum)) {
        ledgerByPatient.set(patNum, await odPostingWrites.readAdjustmentsForPatient(od, patNum));
        await audit(req, {
          action: 'READ',
          resourceType: 'rcm_od_adjustment',
          resourceId: String(patNum),
          office,
        });
      }
      const found = (ledgerByPatient.get(patNum) || []).find(
        (r) => Number(r.AdjNum) === Number(adjNum)
      );
      // Stored NEGATIVE in the ledger, subtracted as a positive here. One we
      // cannot find is left unset, so the line reads as still owing the whole
      // remainder — which is what the chart would tell the patient, and the
      // disagreement is the point.
      if (found) {
        concessionByLine.set(line.queueLineId, -odPostingWrites.dollarsToCents(found.AdjAmt));
      }
    }

    const claims = [];
    for (const group of grouped) {
      const rows = await odPostingWrites.readClaimProcsForClaim(od, group.odClaimNum);
      await audit(req, {
        action: 'READ',
        resourceType: 'rcm_od_claimproc',
        resourceId: String(group.odClaimNum),
        office,
      });

      const verdict = lineDecisions.verdictFor({
        register: 'confirmed',
        lines: group.lines.map((line) =>
          postingDrain.confirmLineFor(
            line,
            rows.find((r) => Number(r.ClaimProcNum) === line.odClaimProcNum) || null,
            concessionByLine.get(line.queueLineId) || 0
          )
        ),
      });

      /*
       * NO PATIENT NAME IN THIS RESPONSE, deliberately.
       *
       * `loadPlan`'s claim rows do not carry one, and the screen that reads this
       * already has every name from `GET /queue/:id`. Adding a second PHI-
       * carrying payload to join on an id the client already holds would be
       * spending a patient's name to save a `Map` lookup.
       */
      claims.push({
        claimId: group.lines[0] ? group.lines[0].claimId : null,
        odClaimNum: num(group.odClaimNum),
        verdict,
      });
    }

    await auditRcmRead(req, 'rcm_posting_queue', { office, resourceId: queueId });

    const agreed = claims.every((c) => c.verdict.state !== 'red');
    return res.json({
      success: true,
      office,
      queueId,
      /** The plan's status is UNCHANGED by this call — see the header. */
      status,
      claims,
      /**
       * True when every claim's read-back now matches what this check promised.
       *
       * It does NOT move the plan. A person who has corrected the chart still
       * presses Post to Open Dental to finish the plan off; this only tells her
       * whether that press will land, without spending a chart write to find
       * out.
       */
      agreed,
      checkedAt: new Date().toISOString(),
    });
  })
);

module.exports = router;
