'use strict';

/**
 * The perio send, in Postgres — every statement it owns (H4 item 12).
 *
 * Same rules as visitStore.js, and `perioSendSchema.test.js` holds this file to
 * them: every function takes `office`, and every WHERE clause names it. A send
 * carries an exam for a PatNum, and a PatNum without an office identifies
 * nobody.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE LEASE IS THE CONCURRENCY CONTROL
 * ═════════════════════════════════════════════════════════════════════════════
 * A step CLAIMS the send before it reads Open Dental: `step_token` and
 * `step_claimed_at` are set in one UPDATE whose WHERE requires the send to be
 * unclaimed or its claim lapsed. Two tabs stepping the same send cannot both
 * hold it, so they cannot both read "row absent" and both post it. The holder
 * renews before every write, and the lease is longer than one write's timeout,
 * so a claim that lapses belongs to a step that is no longer writing.
 *
 * Every state move re-asserts the state it comes FROM, so a send that another
 * request already finished is not dragged back.
 */

const SEND_COLUMNS = `
  send_id, staged_write_id, visit_id, office, pat_num, exam_date, prov_num,
  preview_fingerprint, plan, state, exam_num, prior_exam_nums, rows_written,
  mismatches, error_message, step_token, step_claimed_at, created_by, created_at,
  updated_at, finished_at, deleted_by, deleted_at
`;

function num(value) {
  return value === null || value === undefined ? null : Number(value);
}

/** node-postgres hands back bigint as a string. */
function toSend(row) {
  if (!row) return null;
  return {
    ...row,
    pat_num: num(row.pat_num),
    prov_num: num(row.prov_num),
    exam_num: num(row.exam_num),
    rows_written: Number(row.rows_written),
  };
}

/** The most recent send of one staged chart, or null. */
async function getLatestSend(pool, { office, stagedWriteId }) {
  const res = await pool.query(
    `SELECT ${SEND_COLUMNS} FROM hyg_perio_send
      WHERE staged_write_id = $1 AND office = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [stagedWriteId, office]
  );
  return res.rowCount === 0 ? null : toSend(res.rows[0]);
}

/**
 * A confirmed send, in `posting`. Writes nothing to Open Dental.
 *
 * The unique index on (staged_write_id) WHERE posting/filling refuses a second
 * send in flight; that surfaces here as a thrown unique violation, which the
 * service reports rather than retries.
 */
async function createSend(
  pool,
  { office, visitId, stagedWriteId, patNum, examDate, provNum, previewFingerprint, plan, actor }
) {
  const res = await pool.query(
    `INSERT INTO hyg_perio_send
       (staged_write_id, visit_id, office, pat_num, exam_date, prov_num, preview_fingerprint,
        plan, state, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'posting', $9)
     RETURNING ${SEND_COLUMNS}`,
    [stagedWriteId, visitId, office, patNum, examDate, provNum, previewFingerprint, JSON.stringify(plan), actor]
  );
  return toSend(res.rows[0]);
}

/**
 * Claim the send for one step. True when THIS call holds it.
 * @param {Date} leaseCutoff a claim older than this has lapsed
 */
async function claimStep(pool, { office, sendId, token, leaseCutoff }) {
  const res = await pool.query(
    `UPDATE hyg_perio_send
        SET step_token = $3, step_claimed_at = now(), updated_at = now()
      WHERE send_id = $1 AND office = $2
        AND (step_token IS NULL OR step_claimed_at < $4)`,
    [sendId, office, token, leaseCutoff]
  );
  return res.rowCount === 1;
}

/** Renew before a write. False means the lease was lost, and the step must stop. */
async function renewStep(pool, { office, sendId, token }) {
  const res = await pool.query(
    `UPDATE hyg_perio_send SET step_claimed_at = now()
      WHERE send_id = $1 AND office = $2 AND step_token = $3`,
    [sendId, office, token]
  );
  return res.rowCount === 1;
}

async function releaseStep(pool, { office, sendId, token }) {
  await pool.query(
    `UPDATE hyg_perio_send SET step_token = NULL, step_claimed_at = NULL
      WHERE send_id = $1 AND office = $2 AND step_token = $3`,
    [sendId, office, token]
  );
}

/** The patient's exams just before the header is posted. Persisted BEFORE the POST. */
async function setPriorExamNums(pool, { office, sendId, priorExamNums }) {
  await pool.query(
    `UPDATE hyg_perio_send SET prior_exam_nums = $3::jsonb, updated_at = now()
      WHERE send_id = $1 AND office = $2 AND state = 'posting'`,
    [sendId, office, JSON.stringify(priorExamNums)]
  );
}

/** posting → filling: the exam exists and this send knows its number. */
async function markFilling(pool, { office, sendId, examNum }) {
  const res = await pool.query(
    `UPDATE hyg_perio_send SET state = 'filling', exam_num = $3, updated_at = now()
      WHERE send_id = $1 AND office = $2 AND state = 'posting'`,
    [sendId, office, examNum]
  );
  return res.rowCount === 1;
}

async function addRowsWritten(pool, { office, sendId, count }) {
  await pool.query(
    `UPDATE hyg_perio_send SET rows_written = rows_written + $3, updated_at = now()
      WHERE send_id = $1 AND office = $2`,
    [sendId, office, count]
  );
}

/**
 * posting/filling → written | incomplete | refused.
 *
 * `examNum` is only given for an incomplete send whose exam could not be named
 * (it stays null) — every other finish keeps the number already recorded.
 */
async function finishSend(pool, { office, sendId, state, errorMessage = null, mismatches = [] }) {
  const res = await pool.query(
    `UPDATE hyg_perio_send
        SET state = $3, error_message = $4, mismatches = $5::jsonb, finished_at = now(),
            updated_at = now()
      WHERE send_id = $1 AND office = $2 AND state IN ('posting', 'filling')`,
    [
      sendId,
      office,
      state,
      errorMessage === null ? null : String(errorMessage).slice(0, 2000),
      JSON.stringify(mismatches),
    ]
  );
  return res.rowCount === 1;
}

/** filling/incomplete → deleted. Only a send that knows its exam. */
async function markDeleted(pool, { office, sendId, actor }) {
  const res = await pool.query(
    `UPDATE hyg_perio_send
        SET state = 'deleted', deleted_by = $3, deleted_at = now(), finished_at = COALESCE(finished_at, now()),
            updated_at = now()
      WHERE send_id = $1 AND office = $2 AND state IN ('filling', 'incomplete') AND exam_num IS NOT NULL`,
    [sendId, office, actor]
  );
  return res.rowCount === 1;
}

/**
 * The staged chart back on the list — Sending/Failed → Staged, SAME preview.
 *
 * Only for a send that left nothing in Open Dental: its exam was deleted, it
 * was refused, or it never reached the exam POST at all.
 */
async function restageChart(pool, { office, visitId }) {
  const res = await pool.query(
    `UPDATE hyg_staged_write
        SET error_message = NULL, state = 'Staged', updated_at = now()
      WHERE visit_id = $1 AND office = $2 AND kind = 'perio' AND state IN ('Sending', 'Failed')`,
    [visitId, office]
  );
  return res.rowCount === 1;
}

module.exports = {
  getLatestSend,
  createSend,
  claimStep,
  renewStep,
  releaseStep,
  setPriorExamNums,
  markFilling,
  addRowsWritten,
  finishSend,
  markDeleted,
  restageChart,
  toSend,
};
