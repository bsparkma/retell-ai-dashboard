'use strict';

/**
 * /api/fees/imports/:batchId/… — deciding a preview and posting it.
 *
 *   GET   /feescheds                        the office's fee schedules (target picker)
 *   PATCH /imports/:id/rows/:rowId          accept | exclude | reset one warned row
 *   PUT   /imports/:id/target               choose the target schedule
 *   POST  /imports/:id/post                 THE HUMAN ACTION. Starts the job.
 *   GET   /imports/:id/progress             what the UI polls
 *   POST  /imports/:id/rollback             undo it
 *
 * `fees.write` is enforced one level up by the mount's
 * `requireReadWrite('fees.read','fees.write')` — every non-GET method under
 * /api/fees demands the write action. So none of the mutations below carries a
 * gate of its own, and `feesPosting.test.js` pins that rather than trusting
 * this comment.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * REVIEW-THEN-SEND, AND THE GATE IS SERVER-SIDE
 * ═════════════════════════════════════════════════════════════════════════════
 * NOTHING here posts automatically. There is no path from parsing a file to
 * writing a fee that does not pass through a human pressing Post. The upload
 * route does not call into this file, and there is no scheduler, no webhook and
 * no "auto-post when clean" flag — the platform's first hard rule, applied to
 * a different kind of write.
 *
 * And the warned-rows gate is enforced HERE, not by a disabled button:
 * `assertPostable` re-reads the rows and refuses a batch that still carries
 * warned-and-undecided ones. The job re-checks it a second time after claiming
 * the batch, because minutes can pass between the click and the first write.
 * `feesPostingGate.test.js` drives the endpoint directly, with no UI in the
 * way, to prove the refusal is real.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE POST RETURNS 202, NOT 200
 * ═════════════════════════════════════════════════════════════════════════════
 * It starts a job that runs for minutes against a throttled credential. A 200
 * would say "done"; 202 says "accepted, watch it", which is what actually
 * happened. The response carries the progress URL so the client does not have
 * to construct one.
 */

const express = require('express');

const tenantDb = require('../../platform/tenantDb');
const { audit } = require('../../platform/audit');
const { h, refuse, actorEmail, isUuid } = require('./helpers');
const od = require('../../services/fees/odFeesWrites');
const postJob = require('../../services/fees/postJob');

const router = express.Router();

/** Decisions a human may record on a row. `reset` returns it to undecided. */
const DECISIONS = Object.freeze(['accepted', 'excluded', 'reset']);

/**
 * Bind the tenant db to a runner the JOB can keep using after this request has
 * responded.
 *
 * The job outlives its request by minutes. `withTenantDb(req, …)` re-derives
 * the tenant id from `req` every call, which is what makes cross-tenant access
 * structurally impossible — so the id keeps working, but holding the whole
 * request object is still the wrong shape to hand a background task. This
 * closure is the seam: the job gets a function that runs a query for ONE
 * tenant and nothing else about the request.
 */
function boundDb(req) {
  return (fn) => tenantDb.withTenantDb(req, fn);
}

/**
 * Load a batch, or refuse.
 *
 * The office is in the WHERE, so another office's batch is indistinguishable
 * from one that does not exist — the correct answer, not a leak to paper over.
 */
async function loadBatch(req, batchId) {
  return tenantDb.withTenantDb(req, (pool) =>
    pool
      .query(
        `SELECT batch_id, office, filename, status, row_count, rows_written,
                od_feesched_num, od_feesched_desc, od_feesched_is_new, post_error
           FROM fees_import_batch
          WHERE office = $1 AND batch_id = $2`,
        [req.feesOffice, batchId]
      )
      .then((r) => (r.rows.length > 0 ? r.rows[0] : null))
  );
}

// ─── GET /api/fees/feescheds ────────────────────────────────────────────────

/**
 * The office's fee schedules, for the target picker.
 *
 * Read through the module's one allow-listed writer file, which owns the read
 * half too — a second file naming the Open Dental seam would be the same as no
 * allow-list.
 */
router.get(
  '/feescheds',
  h(async (req, res) => {
    const office = req.feesOffice;
    const result = await od.listFeeSchedules(office);
    if (!result.ok) {
      // Fail closed per office: an office with no key, or switched off, refuses
      // with its own code rather than falling back to another office's.
      const status = result.code === 'OFFICE_OD_KEY_MISSING' ? 503 : 409;
      return refuse(res, status, result.code, result.error);
    }
    return res.json({ success: true, office, schedules: result.schedules });
  })
);

// ─── PATCH /api/fees/imports/:batchId/rows/:rowId ───────────────────────────

/**
 * Record a human's decision about one warned row.
 *
 * `accepted` — they read the raw line and confirm the parsed value is the fee
 *              this office holds.
 * `excluded` — it is not, and the row must never be written. The database
 *              additionally refuses to store a FeeNum on an excluded row.
 * `reset`    — back to undecided, which re-blocks the post. Offered because a
 *              decision made by mistake must be undoable BEFORE the post, and
 *              after it the only remedy is a rollback.
 *
 * Refused once a batch has left `parsed`/`ready`: changing a decision while a
 * post is running, or after one finished, would make the stored decisions
 * disagree with what was actually written.
 */
router.patch(
  '/imports/:batchId/rows/:rowId',
  h(async (req, res) => {
    const office = req.feesOffice;
    const { batchId, rowId } = req.params;
    if (!isUuid(batchId) || !isUuid(rowId)) {
      return refuse(res, 404, 'ROW_NOT_FOUND', 'No such row.');
    }

    const decision = req.body && req.body.decision;
    if (!DECISIONS.includes(decision)) {
      return refuse(
        res,
        400,
        'BAD_DECISION',
        `decision must be one of: ${DECISIONS.join(', ')}`
      );
    }

    const batch = await loadBatch(req, batchId);
    if (!batch) return refuse(res, 404, 'BATCH_NOT_FOUND', 'No such import.');
    if (!['parsed', 'ready'].includes(batch.status)) {
      return refuse(
        res,
        409,
        'BATCH_NOT_EDITABLE',
        `This import is ${batch.status}; its rows can no longer be changed.`
      );
    }

    const actor = actorEmail(req);
    const stored = decision === 'reset' ? 'pending' : decision;

    const updated = await tenantDb.withTenantDb(req, (pool) =>
      pool
        .query(
          `UPDATE fees_import_row
              SET decision = $4,
                  decided_by = CASE WHEN $4 = 'pending' THEN NULL ELSE $5 END,
                  decided_at = CASE WHEN $4 = 'pending' THEN NULL ELSE now() END
            WHERE office = $1 AND batch_id = $2 AND row_id = $3
            RETURNING row_id, proc_code, fee_cents, decision, decided_by, decided_at`,
          [office, batchId, rowId, stored, actor]
        )
        .then((r) => (r.rows.length > 0 ? r.rows[0] : null))
    );
    if (!updated) return refuse(res, 404, 'ROW_NOT_FOUND', 'No such row.');

    // A batch whose last blocking row is decided becomes `ready`; one whose
    // decision is reset falls back to `parsed`. Derived from the rows rather
    // than set by the caller, so the status cannot claim a readiness the rows
    // do not support.
    const counts = await tenantDb.withTenantDb(req, (pool) =>
      postJob.summarise(pool, office, batchId)
    );
    const nextStatus = counts.blocking === 0 ? 'ready' : 'parsed';
    await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `UPDATE fees_import_batch
            SET status = $3, updated_at = now()
          WHERE office = $1 AND batch_id = $2 AND status IN ('parsed', 'ready')`,
        [office, batchId, nextStatus]
      )
    );

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'fees_import_row',
      resourceId: rowId,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({ success: true, row: updated, status: nextStatus, counts });
  })
);

// ─── PUT /api/fees/imports/:batchId/target ──────────────────────────────────

/**
 * Choose where this batch posts: an existing schedule, or a new one by name.
 *
 * A NEW schedule is NOT created here. It is created by the job, immediately
 * before the backup, so that pressing Post is the only act that changes
 * anything in Open Dental — choosing a target is a decision, and a decision
 * that silently created a fee schedule in a live practice would break
 * review-then-send while appearing not to.
 *
 * Refused once posting has started, for the reason the row decisions are:
 * retargeting a batch mid-run would leave fees in one schedule and a record
 * pointing at another.
 */
router.put(
  '/imports/:batchId/target',
  h(async (req, res) => {
    const office = req.feesOffice;
    const { batchId } = req.params;
    if (!isUuid(batchId)) return refuse(res, 404, 'BATCH_NOT_FOUND', 'No such import.');

    const batch = await loadBatch(req, batchId);
    if (!batch) return refuse(res, 404, 'BATCH_NOT_FOUND', 'No such import.');
    if (!['parsed', 'ready'].includes(batch.status)) {
      return refuse(
        res,
        409,
        'BATCH_NOT_EDITABLE',
        `This import is ${batch.status}; its target can no longer be changed.`
      );
    }

    const body = req.body || {};
    const hasExisting = body.feeSchedNum !== undefined && body.feeSchedNum !== null;
    const newName = typeof body.newScheduleName === 'string' ? body.newScheduleName.trim() : '';

    if (hasExisting === (newName !== '')) {
      // Both or neither. Guessing which one the caller meant is exactly the
      // kind of coin flip this platform refuses.
      return refuse(
        res,
        400,
        'BAD_TARGET',
        'Give either an existing feeSchedNum or a newScheduleName, not both and not neither.'
      );
    }

    let feeSchedNum = null;
    let description = null;
    let isNew = false;

    if (hasExisting) {
      feeSchedNum = Number(body.feeSchedNum);
      if (!Number.isInteger(feeSchedNum) || feeSchedNum <= 0) {
        return refuse(res, 400, 'BAD_TARGET', 'feeSchedNum must be a positive whole number.');
      }
      // VALIDATED AGAINST THE OFFICE'S OWN SCHEDULES, not taken on trust. A
      // FeeSchedNum from the other office's database would otherwise be
      // storable here and posted into later.
      const schedules = await od.listFeeSchedules(office);
      if (!schedules.ok) {
        const status = schedules.code === 'OFFICE_OD_KEY_MISSING' ? 503 : 409;
        return refuse(res, status, schedules.code, schedules.error);
      }
      const match = schedules.schedules.find((s) => s.feeSchedNum === feeSchedNum);
      if (!match) {
        return refuse(
          res,
          404,
          'FEESCHED_NOT_FOUND',
          'That fee schedule does not exist in this office.'
        );
      }
      description = match.description;
    } else {
      if (newName.length > 255) {
        return refuse(res, 400, 'BAD_TARGET', 'That fee schedule name is too long.');
      }
      description = newName;
      isNew = true;
    }

    await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `UPDATE fees_import_batch
            SET od_feesched_num = $3, od_feesched_desc = $4, od_feesched_is_new = $5,
                updated_at = now()
          WHERE office = $1 AND batch_id = $2`,
        [office, batchId, feeSchedNum, description, isNew]
      )
    );

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'fees_import_batch',
      resourceId: batchId,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({
      success: true,
      target: { feeSchedNum, description, isNew },
    });
  })
);

// ─── POST /api/fees/imports/:batchId/post ───────────────────────────────────

/**
 * THE HUMAN ACTION. Everything else in this module leads here.
 *
 * The gate is re-derived server-side from the rows, every time. A caller that
 * skips the UI entirely gets the same refusal the disabled button was only
 * hinting at.
 */
router.post(
  '/imports/:batchId/post',
  h(async (req, res) => {
    const office = req.feesOffice;
    const { batchId } = req.params;
    if (!isUuid(batchId)) return refuse(res, 404, 'BATCH_NOT_FOUND', 'No such import.');

    const batch = await loadBatch(req, batchId);
    if (!batch) return refuse(res, 404, 'BATCH_NOT_FOUND', 'No such import.');

    if (batch.status === 'posting') {
      return refuse(res, 409, 'POST_ALREADY_RUNNING', 'A post is already running for this import.');
    }
    // `parsed` is admitted here, and it is not a loophole. `ready` means "the
    // gate passes and a target is chosen", and a batch with NO warned rows is
    // in that condition the moment it is parsed — there is no click that could
    // have promoted it, because there was nothing to decide. The gate below is
    // what actually decides; the status is promoted from it a few lines later,
    // so `ready` is always something the server derived rather than a flag a
    // caller set.
    if (!['parsed', 'ready', 'post_failed'].includes(batch.status)) {
      return refuse(
        res,
        409,
        'BATCH_NOT_POSTABLE',
        batch.status === 'posted'
          ? 'This import has already been posted. Roll it back first if you need to post it again.'
          : `This import is ${batch.status} and cannot be posted.`
      );
    }

    const counts = await tenantDb.withTenantDb(req, (pool) =>
      postJob.summarise(pool, office, batchId)
    );

    // ── THE GATE. Server-side, from the rows, not from a flag anybody set.
    if (counts.blocking > 0) {
      return refuse(
        res,
        409,
        'UNRESOLVED_WARNINGS',
        `${counts.blocking} row${counts.blocking === 1 ? '' : 's'} still carry warnings nobody has accepted or excluded. Decide about them before posting.`,
        { blockingCount: counts.blocking }
      );
    }
    if (counts.writable === 0) {
      return refuse(
        res,
        409,
        'NOTHING_TO_POST',
        'Every row in this import is excluded, so there is nothing to write.'
      );
    }

    let target = {
      feeSchedNum: batch.od_feesched_num === null ? null : Number(batch.od_feesched_num),
      description: batch.od_feesched_desc,
      isNew: batch.od_feesched_is_new === true,
    };
    if (target.feeSchedNum === null && !target.isNew) {
      return refuse(
        res,
        409,
        'NO_TARGET',
        'Choose which fee schedule this import posts into before posting it.'
      );
    }

    // ── A NEW SCHEDULE IS CREATED HERE, on the click, not when it was named.
    //    This is the first Open Dental write of the whole slice and it happens
    //    after the human action, which is what makes review-then-send true
    //    rather than approximately true.
    if (target.isNew && target.feeSchedNum === null) {
      const created = await od.createFeeSchedule(office, target.description || '');
      if (!created.ok) {
        const status = created.code === 'OFFICE_OD_KEY_MISSING' ? 503 : 502;
        await audit(req, {
          action: 'CREATE',
          resourceType: 'fees_od_feesched',
          resourceId: batchId,
          result: 'ERROR',
          office,
          sourceRef: null,
        });
        return refuse(res, status, created.code, created.error);
      }
      target = { feeSchedNum: created.feeSchedNum, description: created.description, isNew: true };
      await tenantDb.withTenantDb(req, (pool) =>
        pool.query(
          `UPDATE fees_import_batch
              SET od_feesched_num = $3, od_feesched_desc = $4, updated_at = now()
            WHERE office = $1 AND batch_id = $2`,
          [office, batchId, target.feeSchedNum, target.description]
        )
      );
    }

    // ── Promote to `ready`. Derived from the gate that has just passed and the
    //    target that has just been resolved, never set by a caller. This is
    //    what `claimBatchForPosting` then moves out of, and doing it here means
    //    the claim's conditional UPDATE — the real concurrency guard — has a
    //    single, accurate starting state to match on.
    await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `UPDATE fees_import_batch
            SET status = 'ready', updated_at = now()
          WHERE office = $1 AND batch_id = $2 AND status = 'parsed'`,
        [office, batchId]
      )
    );

    const actor = actorEmail(req);

    // The audit row CARRIES THE VALUES, not just the fact: which schedule, how
    // many fees, what they total. "Who posted what into which schedule, and
    // what was it worth" has to be answerable from the trail alone.
    await audit(req, {
      action: 'CREATE',
      resourceType: 'fees_post',
      resourceId: batchId,
      result: 'SUCCESS',
      office,
      sourceRef: `feesched:${target.feeSchedNum}|rows:${counts.writable}|excluded:${counts.excluded}|cents:${counts.totalCents}`,
    });

    // Fire and DO NOT await — the job runs for minutes. Its own error handling
    // writes a terminal status, so nothing is lost by not watching it here.
    const withDb = boundDb(req);
    void postJob
      .runPost({ withDb, office, batchId, actor })
      .catch((err) => console.error('[fees] post job crashed:', (err && err.message) || err));

    return res.status(202).json({
      success: true,
      accepted: true,
      batchId,
      target,
      counts,
      progressUrl: `/api/fees/imports/${batchId}/progress?office=${encodeURIComponent(office)}`,
    });
  })
);

// ─── GET /api/fees/imports/:batchId/progress ────────────────────────────────

router.get(
  '/imports/:batchId/progress',
  h(async (req, res) => {
    const office = req.feesOffice;
    const { batchId } = req.params;
    if (!isUuid(batchId)) return refuse(res, 404, 'BATCH_NOT_FOUND', 'No such import.');

    const progress = await tenantDb.withTenantDb(req, (pool) =>
      postJob.getProgress(pool, office, batchId)
    );
    if (!progress) return refuse(res, 404, 'BATCH_NOT_FOUND', 'No such import.');

    return res.json({ success: true, progress });
  })
);

// ─── POST /api/fees/imports/:batchId/rollback ───────────────────────────────

/**
 * Undo a post.
 *
 * Synchronous, unlike the post: a rollback is bounded by what this batch
 * actually wrote, and a failed post that stopped at row 12 has twelve fees to
 * remove. A fully-posted 500-fee schedule is the slow case and the UI says so
 * before the confirm; making it a job too would double this slice's moving
 * parts for a path that is rare by construction.
 */
router.post(
  '/imports/:batchId/rollback',
  h(async (req, res) => {
    const office = req.feesOffice;
    const { batchId } = req.params;
    if (!isUuid(batchId)) return refuse(res, 404, 'BATCH_NOT_FOUND', 'No such import.');

    const actor = actorEmail(req);
    const withDb = boundDb(req);
    const result = await postJob.runRollback({ withDb, office, batchId, actor });

    if (!result.ok) {
      const status =
        result.code === 'BATCH_NOT_FOUND' ? 404 : result.code === 'NO_BACKUP' ? 409 : 409;
      return refuse(res, status, result.code, result.error);
    }

    await audit(req, {
      action: 'DELETE',
      resourceType: 'fees_post',
      resourceId: batchId,
      result: 'SUCCESS',
      office,
      sourceRef: `deleted:${result.deleted}|restored:${result.restored}|problems:${result.problems.length}`,
    });

    return res.json({
      success: true,
      deleted: result.deleted,
      restored: result.restored,
      problems: result.problems,
      // The honest sentence, including the bit about a new schedule's shell
      // surviving because Open Dental cannot delete one.
      note: result.note,
    });
  })
);

module.exports = router;
module.exports.DECISIONS = DECISIONS;
