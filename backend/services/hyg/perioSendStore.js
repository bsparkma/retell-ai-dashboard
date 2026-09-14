'use strict';

/**
 * The perio send queue, in Postgres — every statement it owns (H4 slice 11).
 *
 * Same rules as visitStore.js, and `perioSendSchema.test.js` holds this file to
 * them: every function takes `office`, and every WHERE clause names it. A queue
 * row carries a tooth for a PatNum, and a PatNum without an office identifies
 * nobody.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CLAIM IS THE CONCURRENCY CONTROL
 * ═════════════════════════════════════════════════════════════════════════════
 * Before a row is posted it is CLAIMED: `pending` → `sending`, with `claimed_at`
 * stamped, in one UPDATE whose WHERE re-asserts the state. Two tabs stepping the
 * same send cannot both claim a row — the loser updates nothing and moves on.
 *
 * A `sending` row whose claim is older than the lease may be claimed again, and
 * only by a step that has just READ Open Dental and not found it. The lease is
 * longer than a write's timeout, so the POST it covers has either answered or
 * given up before anybody else looks.
 */

const ROW_COLUMNS = `
  send_row_id, staged_write_id, visit_id, office, seq, target, tooth, sequence_type, body,
  state, od_ref, error_message, attempts, claimed_at, confirmed_at, prior_exam_nums,
  created_by, created_at, updated_at
`;

/** node-postgres hands back bigint as a string. */
function toRow(row) {
  return {
    ...row,
    od_ref: row.od_ref === null || row.od_ref === undefined ? null : Number(row.od_ref),
    tooth: row.tooth === null || row.tooth === undefined ? null : Number(row.tooth),
    seq: Number(row.seq),
    attempts: Number(row.attempts),
  };
}

/** Every row of one send, in order. */
async function getRows(pool, { office, stagedWriteId }) {
  const res = await pool.query(
    `SELECT ${ROW_COLUMNS} FROM hyg_perio_send_row
      WHERE staged_write_id = $1 AND office = $2
      ORDER BY seq ASC`,
    [stagedWriteId, office]
  );
  return res.rows.map(toRow);
}

/**
 * Throw away a queue nothing has been attempted from.
 *
 * Only rows that are still `pending` with zero attempts. A queue built by a
 * start that then lost the race to a second tab is safe to rebuild; a queue
 * with a single attempted row is a record of something that may be in a chart
 * and is never touched here.
 *
 * @returns {Promise<number>} rows removed
 */
async function discardUnattempted(pool, { office, stagedWriteId }) {
  const res = await pool.query(
    `DELETE FROM hyg_perio_send_row
      WHERE staged_write_id = $1 AND office = $2 AND state = 'pending' AND attempts = 0`,
    [stagedWriteId, office]
  );
  return res.rowCount;
}

/**
 * Plan the send: the exam header at seq 0, one row per measurement after it.
 * Idempotent on (staged_write_id, seq).
 */
async function createQueue(pool, { office, visitId, stagedWriteId, examBody, measures, actor }) {
  await pool.query(
    `INSERT INTO hyg_perio_send_row
       (staged_write_id, visit_id, office, seq, target, tooth, sequence_type, body, created_by)
     VALUES ($1, $2, $3, 0, 'exam', NULL, NULL, $4::jsonb, $5)
     ON CONFLICT (staged_write_id, seq) DO NOTHING`,
    [stagedWriteId, visitId, office, JSON.stringify(examBody), actor]
  );
  for (const m of measures) {
    await pool.query(
      `INSERT INTO hyg_perio_send_row
         (staged_write_id, visit_id, office, seq, target, tooth, sequence_type, body, created_by)
       VALUES ($1, $2, $3, $4, 'measure', $5, $6, $7::jsonb, $8)
       ON CONFLICT (staged_write_id, seq) DO NOTHING`,
      [stagedWriteId, visitId, office, m.seq, m.tooth, m.sequenceType, JSON.stringify(m.body), actor]
    );
  }
  return getRows(pool, { office, stagedWriteId });
}

/**
 * pending (or a lapsed sending) → sending. Returns the row when THIS call
 * claimed it, null when somebody else holds it or it has moved on.
 *
 * @param {Date} leaseCutoff a `sending` row claimed before this may be re-claimed
 */
async function claimRow(pool, { office, sendRowId, leaseCutoff }) {
  const res = await pool.query(
    `UPDATE hyg_perio_send_row
        SET state = 'sending', claimed_at = now(), attempts = attempts + 1,
            error_message = NULL, updated_at = now()
      WHERE send_row_id = $1 AND office = $2
        AND (state = 'pending' OR (state = 'sending' AND claimed_at < $3))
      RETURNING ${ROW_COLUMNS}`,
    [sendRowId, office, leaseCutoff]
  );
  return res.rowCount === 1 ? toRow(res.rows[0]) : null;
}

/**
 * Settle a row. `odRef` is kept when not given, so a confirm cannot erase the
 * number a `sent` recorded.
 */
async function markRow(pool, { office, sendRowId, state, odRef = null, errorMessage = null }) {
  await pool.query(
    `UPDATE hyg_perio_send_row
        SET state = $3, od_ref = COALESCE($4, od_ref), error_message = $5,
            confirmed_at = CASE WHEN $3 = 'confirmed' THEN now() ELSE NULL END,
            updated_at = now()
      WHERE send_row_id = $1 AND office = $2`,
    [sendRowId, office, state, odRef, errorMessage === null ? null : String(errorMessage).slice(0, 2000)]
  );
}

/** The exams the patient already had, recorded just before the header is posted. */
async function setPriorExamNums(pool, { office, sendRowId, priorExamNums }) {
  await pool.query(
    `UPDATE hyg_perio_send_row SET prior_exam_nums = $3::jsonb, updated_at = now()
      WHERE send_row_id = $1 AND office = $2`,
    [sendRowId, office, JSON.stringify(priorExamNums)]
  );
}

/** Resume: failed rows go back to pending, and are READ before they are posted. */
async function resetFailed(pool, { office, stagedWriteId }) {
  const res = await pool.query(
    `UPDATE hyg_perio_send_row
        SET state = 'pending', error_message = NULL, updated_at = now()
      WHERE staged_write_id = $1 AND office = $2 AND state = 'failed'`,
    [stagedWriteId, office]
  );
  return res.rowCount;
}

/**
 * The staged chart → Sending, from Staged (a start) or Failed (a resume).
 * @returns {Promise<boolean>} whether this call moved it
 */
async function markPerioSending(pool, { office, visitId, from }) {
  const res = await pool.query(
    `UPDATE hyg_staged_write
        SET state = 'Sending', error_message = NULL, updated_at = now()
      WHERE visit_id = $1 AND office = $2 AND kind = 'perio' AND state = $3`,
    [visitId, office, from]
  );
  return res.rowCount === 1;
}

module.exports = {
  getRows,
  discardUnattempted,
  createQueue,
  claimRow,
  markRow,
  setPriorExamNums,
  resetFailed,
  markPerioSending,
  toRow,
};
