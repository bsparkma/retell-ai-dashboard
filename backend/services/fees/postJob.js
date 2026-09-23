'use strict';

/**
 * The posting job: an approved preview becomes fees in a practice's Open Dental
 * database, one throttled write at a time.
 *
 * This file owns the SEQUENCE and the STATE. It reaches Open Dental only
 * through `odFeesWrites.js`, which is the module's one allow-listed writer;
 * there is no client here, no transport verb, and no MySQL.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY IT IS A BACKGROUND JOB AT ALL
 * ═════════════════════════════════════════════════════════════════════════════
 * The Open Dental credential is throttled to 1 request per second and is SHARED
 * across every module — voice's chart notes, RCM's posting drain, hygiene's day
 * view. A fee costs two requests (write, then read back), so a 500-fee schedule
 * is about twenty minutes during which that office's other Open Dental work
 * queues behind it.
 *
 * That is not something to hide inside a request. It is a job with persisted
 * per-row progress and an endpoint the UI polls, so an operator can watch it,
 * and so a container restart at minute twelve is survivable.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ORDER IS LOAD-BEARING
 * ═════════════════════════════════════════════════════════════════════════════
 *   1. Re-read the batch and RE-CHECK THE GATE. The button was disabled, but a
 *      disabled button is not a guard — see `assertPostable` in the route.
 *   2. Resolve the target: an existing FeeSchedNum, or create one.
 *   3. BACK UP, before write number one. For an existing schedule that means
 *      reading every fee it holds; for a new one it is an empty snapshot whose
 *      EXISTENCE records that we looked.
 *   4. Fetch the ProcCode → CodeNum map once (the API has no ProcCode filter).
 *   5. Write, row by row, reading each one back, persisting the FeeNum as we go.
 *
 * Backup before write is the whole reason rollback can be honest. A backup
 * taken afterwards would contain our own writes.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * RESUME WITHOUT DOUBLE-WRITING
 * ═════════════════════════════════════════════════════════════════════════════
 * A row carrying `od_fee_num` was written and is skipped outright.
 *
 * A row WITHOUT one is not assumed unwritten. The crash could have landed
 * between Open Dental's commit and ours, so the job asks Open Dental whether the
 * fee is there before writing it — `verify-by-read`. If it is there at the right
 * amount, the FeeNum is adopted and no write is issued.
 *
 * This costs one read per unwritten row on a resume and nothing at all on a
 * first run. Skipping it would let a resume create a second fee for a code that
 * already has one, and a schedule holding D2740 twice is one Open Dental picks
 * from arbitrarily — a wrong price with no error anywhere.
 *
 * `writeFee` is itself create-or-update, so even a missed verification degrades
 * to an update rather than a duplicate. The verification is the belt; that is
 * the braces.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FAILURE IS A STATE, NOT AN ABSENCE
 * ═════════════════════════════════════════════════════════════════════════════
 * Any failure leaves `status: 'post_failed'`, `post_error` set, and
 * `rows_written` at whatever it had actually reached. That last one is the
 * point: a post that dies at row 300 of 500 has put 299 fees into a real
 * practice's database, and a status that merely says "failed" invites somebody
 * to assume nothing happened and press Post again.
 */

const tenantDb = require('../../platform/tenantDb');
const od = require('./odFeesWrites');

/**
 * In-process registry of running jobs, keyed by batchId.
 *
 * ADVISORY ONLY — it stops this process starting the same post twice, which is
 * the common case (an impatient second click). It is NOT the guard against two
 * containers posting the same batch: that is the conditional UPDATE in
 * `claimBatchForPosting`, which moves the row to 'posting' only from a status
 * that permits it and reports whether it won. A Map cannot be the guard because
 * a Map is per-process, and prod runs one replica today but is not promised to
 * forever.
 *
 * @type {Map<string, { startedAt: number }>}
 */
const running = new Map();

/** Columns the job reads. Named explicitly — no SELECT *. */
const BATCH_COLUMNS = [
  'batch_id',
  'office',
  'filename',
  'status',
  'row_count',
  'rows_written',
  'od_feesched_num',
  'od_feesched_desc',
  'od_feesched_is_new',
  'post_error',
  'posting_started_at',
  'posted_at',
  'posted_by',
  'rolled_back_at',
  'rolled_back_by',
].join(', ');

const ROW_COLUMNS = [
  'row_id',
  'proc_code',
  'fee_cents',
  'decision',
  'od_fee_num',
  'row_order',
].join(', ');

/**
 * Rows this batch will actually write: everything not excluded.
 *
 * A clean row and an ACCEPTED row are both written; only `excluded` is held
 * back, and the database additionally refuses to store a FeeNum on an excluded
 * row (`fees_import_row_excluded_unwritten_check`), so the promise survives a
 * reordered filter.
 */
const WRITABLE = "decision <> 'excluded'";

/**
 * The rows that BLOCK posting: warned and undecided.
 *
 * One predicate, used by the route's gate and by the job's re-check, so the two
 * cannot disagree about what "resolved" means. A clean row is postable without
 * anybody clicking anything.
 */
const BLOCKING =
  "jsonb_array_length(parse_warnings) > 0 AND decision = 'pending'";

/** A structured failure, matching odFeesWrites' shape. */
function fail(code, error, extra) {
  return { ok: false, code, error, ...(extra || {}) };
}

/**
 * How many warned-and-undecided rows a batch still has.
 *
 * @param {import('pg').Pool} pool
 * @param {string} office
 * @param {string} batchId
 * @returns {Promise<number>}
 */
async function countBlockingRows(pool, office, batchId) {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM fees_import_row
      WHERE office = $1 AND batch_id = $2 AND ${BLOCKING}`,
    [office, batchId]
  );
  return res.rows.length > 0 ? Number(res.rows[0].n) : 0;
}

/**
 * The totals the confirm dialog states and the audit row records.
 *
 * @param {import('pg').Pool} pool
 * @param {string} office
 * @param {string} batchId
 */
async function summarise(pool, office, batchId) {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ${WRITABLE})::int AS writable,
            COUNT(*) FILTER (WHERE decision = 'excluded')::int AS excluded,
            COUNT(*) FILTER (WHERE decision = 'accepted')::int AS accepted,
            COUNT(*) FILTER (WHERE ${BLOCKING})::int AS blocking,
            COALESCE(SUM(fee_cents) FILTER (WHERE ${WRITABLE}), 0)::bigint AS total_cents
       FROM fees_import_row
      WHERE office = $1 AND batch_id = $2`,
    [office, batchId]
  );
  const r = res.rows[0] || {};
  return {
    total: Number(r.total || 0),
    writable: Number(r.writable || 0),
    excluded: Number(r.excluded || 0),
    accepted: Number(r.accepted || 0),
    blocking: Number(r.blocking || 0),
    totalCents: Number(r.total_cents || 0),
  };
}

/**
 * Move a batch into 'posting', but only from a status that permits it.
 *
 * THE CONDITIONAL UPDATE IS THE REAL CONCURRENCY GUARD. Two containers, or two
 * clicks racing the in-process Map, both run this; exactly one matches a row and
 * the other gets zero and is told the batch is already going. Checking the
 * status with a SELECT and then updating would leave the window between them
 * wide open, which for a job that writes to a live practice database is the
 * expensive kind of race.
 *
 * `post_failed` is a permitted starting point — that IS the resume. `posted` is
 * not: re-posting a finished batch would rewrite every fee for no reason.
 *
 * @returns {Promise<{ ok: true, batch: Record<string, unknown> } | { ok: false, code: string, error: string }>}
 */
async function claimBatchForPosting(pool, office, batchId, actor) {
  const res = await pool.query(
    `UPDATE fees_import_batch
        SET status = 'posting',
            posting_started_at = now(),
            post_error = NULL,
            updated_at = now()
      WHERE office = $1
        AND batch_id = $2
        AND status IN ('ready', 'post_failed')
      RETURNING ${BATCH_COLUMNS}`,
    [office, batchId]
  );
  if (res.rows.length === 0) {
    return fail(
      'BATCH_NOT_POSTABLE',
      'This import is not ready to post, or a post is already running for it.'
    );
  }
  // Attribution is stamped only on the FIRST claim, so a resume does not
  // overwrite who authorised the post with whoever happened to retry it.
  await pool.query(
    `UPDATE fees_import_batch
        SET posted_by = COALESCE(posted_by, $3)
      WHERE office = $1 AND batch_id = $2 AND posted_at IS NULL`,
    [office, batchId, actor]
  );
  return { ok: true, batch: res.rows[0] };
}

/**
 * Take the backup, unless this batch already has one.
 *
 * Idempotent by the table's UNIQUE (batch_id): a resume finds the snapshot the
 * first run took and does NOT take a second, which would necessarily capture
 * our own partial writes and make the rollback restore them.
 *
 * @returns {Promise<{ ok: true, taken: boolean } | { ok: false, code: string, error: string }>}
 */
async function ensureBackup(pool, office, batchId, feeSchedNum, isNew, actor) {
  const existing = await pool.query(
    'SELECT backup_id FROM fees_od_backup WHERE office = $1 AND batch_id = $2',
    [office, batchId]
  );
  if (existing.rows.length > 0) return { ok: true, taken: false };

  /** @type {object[]} */
  let rows = [];
  if (!isNew) {
    // An EXISTING schedule's current contents are the truth a rollback restores
    // to. This is the one read that must not be skipped or approximated.
    const read = await od.listFeesInSchedule(office, feeSchedNum);
    if (!read.ok) return read;
    rows = read.fees;
  }

  await pool.query(
    `INSERT INTO fees_od_backup
       (office, batch_id, od_feesched_num, is_new_schedule, rows, row_count, taken_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [office, batchId, feeSchedNum, isNew, JSON.stringify(rows), rows.length, actor]
  );
  return { ok: true, taken: true };
}

/**
 * Run (or resume) the post for one batch.
 *
 * Called WITHOUT await by the route — it returns immediately and the UI polls
 * `getProgress`. Every exit path writes a terminal status, so a caller that
 * never looks again still leaves the batch in a state that describes itself.
 *
 * @param {object} deps
 * @param {(fn: (pool: import('pg').Pool) => Promise<unknown>) => Promise<unknown>} deps.withDb
 *   A bound tenant-db runner. Passed in rather than taking `req`, because the
 *   job outlives the request that started it and holding a request object after
 *   its response is sent is how a job ends up reading a closed context.
 * @param {string} office
 * @param {string} batchId
 * @param {string} actor
 */
async function runPost({ withDb, office, batchId, actor }) {
  if (running.has(batchId)) {
    return fail('POST_ALREADY_RUNNING', 'A post is already running for this import.');
  }
  running.set(batchId, { startedAt: Date.now() });

  try {
    // ── 1. Claim, and RE-CHECK THE GATE. A disabled button is not a guard, and
    //    the click that started this may be minutes old.
    const claimed = await withDb((pool) => claimBatchForPosting(pool, office, batchId, actor));
    if (!claimed.ok) return claimed;
    const batch = claimed.batch;

    const blocking = await withDb((pool) => countBlockingRows(pool, office, batchId));
    if (blocking > 0) {
      await withDb((pool) =>
        markFailed(
          pool,
          office,
          batchId,
          `${blocking} row${blocking === 1 ? '' : 's'} still carry unresolved warnings.`
        )
      );
      return fail('UNRESOLVED_WARNINGS', 'This import still has rows nobody has decided about.');
    }

    const feeSchedNum = Number(batch.od_feesched_num);
    if (!Number.isInteger(feeSchedNum) || feeSchedNum <= 0) {
      await withDb((pool) => markFailed(pool, office, batchId, 'No target fee schedule was set.'));
      return fail('NO_TARGET', 'This import has no target fee schedule.');
    }

    // ── 2. Back up BEFORE the first write.
    const backup = await withDb((pool) =>
      ensureBackup(pool, office, batchId, feeSchedNum, batch.od_feesched_is_new === true, actor)
    );
    if (!backup.ok) {
      await withDb((pool) =>
        markFailed(pool, office, batchId, `Could not back up the fee schedule: ${backup.error}`)
      );
      return backup;
    }

    // ── 3. The code map, once. The API offers no ProcCode filter, so this is a
    //    paged sweep of the whole table — ~13 requests, paid once rather than
    //    once per fee.
    const codes = await od.fetchProcedureCodeMap(office);
    if (!codes.ok) {
      await withDb((pool) =>
        markFailed(pool, office, batchId, `Could not read procedure codes: ${codes.error}`)
      );
      return codes;
    }

    // ── 4. Write, row by row.
    const pending = await withDb((pool) =>
      pool
        .query(
          `SELECT ${ROW_COLUMNS}
             FROM fees_import_row
            WHERE office = $1 AND batch_id = $2 AND ${WRITABLE}
            ORDER BY row_order ASC`,
          [office, batchId]
        )
        .then((r) => r.rows)
    );

    /** @type {string[]} */
    const skipped = [];

    for (const row of pending) {
      // Already written by an earlier run. Nothing to verify: the FeeNum IS the
      // evidence, and it was only stored after a read-back.
      if (row.od_fee_num !== null && row.od_fee_num !== undefined) continue;

      const codeNum = codes.codeNums[String(row.proc_code).toUpperCase()];
      if (codeNum === undefined) {
        // A code this practice does not have. NOT a failure of the run — the
        // schedule can legitimately list procedures an office never performs —
        // but it is recorded so the total reconciles and nobody wonders where
        // the missing fees went.
        skipped.push(row.proc_code);
        continue;
      }

      // ── VERIFY BY READ. See the header: a row with no stored FeeNum may
      //    still have been written, if a crash landed between Open Dental's
      //    commit and ours.
      const already = await od.findFee(office, feeSchedNum, codeNum);
      if (!already.ok) {
        await withDb((pool) => markFailed(pool, office, batchId, already.error));
        return already;
      }
      if (already.fee && Math.round(Number(already.fee.Amount) * 100) === Number(row.fee_cents)) {
        // It is there, at the right amount. Adopt the FeeNum and issue NO write.
        await withDb((pool) =>
          recordWritten(pool, office, batchId, row.row_id, Number(already.fee.FeeNum))
        );
        continue;
      }

      const written = await od.writeFee(office, {
        feeSchedNum,
        codeNum,
        amountCents: Number(row.fee_cents),
      });
      if (!written.ok) {
        await withDb((pool) =>
          markFailed(
            pool,
            office,
            batchId,
            `Stopped at ${row.proc_code}: ${written.error}`
          )
        );
        return written;
      }

      await withDb((pool) => recordWritten(pool, office, batchId, row.row_id, written.feeNum));
    }

    // ── 5. Done. `rows_written` is recomputed FROM THE ROWS rather than from a
    //    counter this loop kept, so the number the UI shows is the number of
    //    rows that actually carry a FeeNum.
    const finished = await withDb((pool) => markPosted(pool, office, batchId, skipped));
    return { ok: true, ...finished };
  } catch (err) {
    const message = (err && err.message) || String(err);
    // An unexpected throw must still land in a terminal state. A job that dies
    // leaving 'posting' forever is a batch nobody can post or roll back.
    await withDb((pool) => markFailed(pool, office, batchId, `Unexpected failure: ${message}`)).catch(
      () => {}
    );
    return fail('POST_FAILED', message);
  } finally {
    running.delete(batchId);
  }
}

/** Record one written row and bump the batch's count, in one statement each. */
async function recordWritten(pool, office, batchId, rowId, feeNum) {
  await pool.query(
    `UPDATE fees_import_row
        SET od_fee_num = $4, written_at = now()
      WHERE office = $1 AND batch_id = $2 AND row_id = $3 AND od_fee_num IS NULL`,
    [office, batchId, rowId, feeNum]
  );
  // Derived, not incremented. A counter can drift from the rows it counts; this
  // cannot, and it is the number a failed run is judged by.
  await pool.query(
    `UPDATE fees_import_batch b
        SET rows_written = (
              SELECT COUNT(*) FROM fees_import_row r
               WHERE r.office = b.office AND r.batch_id = b.batch_id AND r.od_fee_num IS NOT NULL
            ),
            updated_at = now()
      WHERE b.office = $1 AND b.batch_id = $2`,
    [office, batchId]
  );
}

async function markFailed(pool, office, batchId, error) {
  await pool.query(
    `UPDATE fees_import_batch
        SET status = 'post_failed', post_error = $3, updated_at = now()
      WHERE office = $1 AND batch_id = $2`,
    [office, batchId, String(error).slice(0, 2000)]
  );
}

async function markPosted(pool, office, batchId, skipped) {
  const note =
    skipped.length > 0
      ? `${skipped.length} code${skipped.length === 1 ? '' : 's'} not in this practice's procedure list: ${skipped.slice(0, 20).join(', ')}${skipped.length > 20 ? '…' : ''}`
      : null;
  const res = await pool.query(
    `UPDATE fees_import_batch
        SET status = 'posted',
            posted_at = now(),
            posted_by = COALESCE(posted_by, 'unknown'),
            post_error = NULL,
            updated_at = now()
      WHERE office = $1 AND batch_id = $2
      RETURNING rows_written, row_count`,
    [office, batchId]
  );
  const r = res.rows[0] || {};
  return { rowsWritten: Number(r.rows_written || 0), skipped, skippedNote: note };
}

/**
 * What the UI polls.
 *
 * Returns the batch's own state plus a live count of written rows, so a poll
 * during a run shows movement rather than a number frozen at the last commit.
 */
async function getProgress(pool, office, batchId) {
  const res = await pool.query(
    `SELECT ${BATCH_COLUMNS} FROM fees_import_batch WHERE office = $1 AND batch_id = $2`,
    [office, batchId]
  );
  if (res.rows.length === 0) return null;
  const b = res.rows[0];

  const counts = await summarise(pool, office, batchId);
  const backup = await pool.query(
    `SELECT backup_id, od_feesched_num, is_new_schedule, row_count, taken_at, restored_at, restore_note
       FROM fees_od_backup WHERE office = $1 AND batch_id = $2`,
    [office, batchId]
  );

  return {
    batchId: b.batch_id,
    office: b.office,
    filename: b.filename,
    status: b.status,
    rowCount: Number(b.row_count || 0),
    // THE HONEST NUMBER. Present in every state, including post_failed.
    rowsWritten: Number(b.rows_written || 0),
    writableCount: counts.writable,
    excludedCount: counts.excluded,
    blockingCount: counts.blocking,
    totalCents: counts.totalCents,
    target:
      b.od_feesched_num === null || b.od_feesched_num === undefined
        ? null
        : {
            feeSchedNum: Number(b.od_feesched_num),
            description: b.od_feesched_desc,
            isNew: b.od_feesched_is_new === true,
          },
    postError: b.post_error ?? null,
    postingStartedAt: b.posting_started_at ? new Date(b.posting_started_at).toISOString() : null,
    postedAt: b.posted_at ? new Date(b.posted_at).toISOString() : null,
    postedBy: b.posted_by ?? null,
    rolledBackAt: b.rolled_back_at ? new Date(b.rolled_back_at).toISOString() : null,
    rolledBackBy: b.rolled_back_by ?? null,
    backup:
      backup.rows.length === 0
        ? null
        : {
            odFeeSchedNum: Number(backup.rows[0].od_feesched_num),
            isNewSchedule: backup.rows[0].is_new_schedule === true,
            rowCount: Number(backup.rows[0].row_count || 0),
            takenAt: new Date(backup.rows[0].taken_at).toISOString(),
            restoredAt: backup.rows[0].restored_at
              ? new Date(backup.rows[0].restored_at).toISOString()
              : null,
            restoreNote: backup.rows[0].restore_note ?? null,
          },
    // Advisory: this process is working on it right now.
    running: running.has(batchId),
  };
}

/**
 * Roll a posted (or half-posted) batch back.
 *
 * TWO SHAPES, and which one applies was decided when the backup was taken:
 *
 *   EXISTING schedule — delete every fee this batch wrote, then restore the
 *                       snapshot's amounts for the codes that had one. A code
 *                       the batch ADDED (absent from the snapshot) is simply
 *                       deleted; a code it CHANGED is put back to its old
 *                       amount.
 *   NEW schedule      — delete every fee this batch wrote, then HIDE the
 *                       schedule. The shell remains, because Open Dental offers
 *                       no DELETE for /feescheds. The result says so, and the
 *                       UI repeats it. Pretending otherwise would be the same
 *                       lie as a failed post that claims nothing was written.
 *
 * Fees the batch did not write are never touched.
 */
async function runRollback({ withDb, office, batchId, actor }) {
  const state = await withDb((pool) => getProgress(pool, office, batchId));
  if (!state) return fail('BATCH_NOT_FOUND', 'No such import.');
  if (!['posted', 'post_failed'].includes(state.status)) {
    return fail(
      'NOT_ROLLBACK_ABLE',
      'Only an import that has been posted, or failed partway through posting, can be rolled back.'
    );
  }
  if (!state.backup) {
    return fail(
      'NO_BACKUP',
      'There is no snapshot for this import, so there is nothing to restore it to.'
    );
  }

  const written = await withDb((pool) =>
    pool
      .query(
        `SELECT row_id, proc_code, od_fee_num
           FROM fees_import_row
          WHERE office = $1 AND batch_id = $2 AND od_fee_num IS NOT NULL
          ORDER BY row_order ASC`,
        [office, batchId]
      )
      .then((r) => r.rows)
  );

  const snapshot = await withDb((pool) =>
    pool
      .query('SELECT rows FROM fees_od_backup WHERE office = $1 AND batch_id = $2', [
        office,
        batchId,
      ])
      .then((r) => (r.rows[0] && Array.isArray(r.rows[0].rows) ? r.rows[0].rows : []))
  );

  /** CodeNum → the amount it held before this batch. */
  const before = new Map();
  for (const fee of snapshot) before.set(Number(fee.CodeNum), Number(fee.Amount));

  let deleted = 0;
  let restored = 0;
  const problems = [];

  for (const row of written) {
    const del = await od.deleteFee(office, Number(row.od_fee_num));
    if (!del.ok) {
      // Recorded and continued rather than aborted: stopping at the first
      // refusal would leave the rest of this batch's writes in place with no
      // record of which ones, and a FeeSchedGroup refusal applies to one fee,
      // not to the run.
      problems.push(`${row.proc_code}: ${del.error}`);
      continue;
    }
    deleted += 1;
    await withDb((pool) =>
      pool.query(
        `UPDATE fees_import_row
            SET od_fee_num = NULL, written_at = NULL
          WHERE office = $1 AND batch_id = $2 AND row_id = $3`,
        [office, batchId, row.row_id]
      )
    );
  }

  // Put back what the snapshot held for codes this batch overwrote. A code the
  // batch ADDED is not in the snapshot and stays deleted, which is correct.
  if (!state.backup.isNewSchedule) {
    const codes = await od.fetchProcedureCodeMap(office);
    if (!codes.ok) {
      problems.push(`Could not read procedure codes to restore: ${codes.error}`);
    } else {
      const byNum = new Map();
      for (const [proc, num] of Object.entries(codes.codeNums)) byNum.set(num, proc);
      for (const [codeNum, amount] of before) {
        if (!byNum.has(codeNum)) continue;
        const put = await od.writeFee(office, {
          feeSchedNum: state.backup.odFeeSchedNum,
          codeNum,
          amountCents: Math.round(amount * 100),
        });
        if (put.ok) restored += 1;
        else problems.push(`CodeNum ${codeNum}: ${put.error}`);
      }
    }
  }

  let note;
  if (state.backup.isNewSchedule) {
    const hidden = await od.hideFeeSchedule(office, state.backup.odFeeSchedNum);
    note = hidden.ok
      ? `Deleted ${deleted} fee${deleted === 1 ? '' : 's'} and hid the schedule. Open Dental cannot delete a fee schedule, so the empty schedule remains.`
      : `Deleted ${deleted} fee${deleted === 1 ? '' : 's'}, but could not hide the schedule: ${hidden.error}`;
  } else {
    note = `Deleted ${deleted} fee${deleted === 1 ? '' : 's'} and restored ${restored} previous amount${restored === 1 ? '' : 's'}.`;
  }
  if (problems.length > 0) {
    note += ` ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems.slice(0, 10).join('; ')}`;
  }

  await withDb((pool) =>
    pool.query(
      `UPDATE fees_import_batch b
          SET status = 'rolled_back',
              rolled_back_at = now(),
              rolled_back_by = $3,
              rows_written = (
                SELECT COUNT(*) FROM fees_import_row r
                 WHERE r.office = b.office AND r.batch_id = b.batch_id AND r.od_fee_num IS NOT NULL
              ),
              updated_at = now()
        WHERE b.office = $1 AND b.batch_id = $2`,
      [office, batchId, actor]
    )
  );
  await withDb((pool) =>
    pool.query(
      `UPDATE fees_od_backup
          SET restored_at = now(), restored_by = $3, restore_note = $4
        WHERE office = $1 AND batch_id = $2`,
      [office, batchId, actor, note.slice(0, 2000)]
    )
  );

  return { ok: true, deleted, restored, problems, note };
}

module.exports = {
  BLOCKING,
  WRITABLE,
  countBlockingRows,
  summarise,
  claimBatchForPosting,
  ensureBackup,
  runPost,
  runRollback,
  getProgress,
  _running: running,
};
