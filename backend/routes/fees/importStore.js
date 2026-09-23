'use strict';

/**
 * Every SQL statement the fee-schedule module runs, in one file.
 *
 * Kept out of the route handlers so the office-scoping rule is checkable by
 * reading one file instead of three: EVERY statement below takes `office` and
 * puts it in the WHERE or the INSERT. There is no query here that can be called
 * without one, which is what makes "a valley row is structurally unreachable in
 * a roland context" a property of the code rather than a habit.
 *
 * NO `SELECT *`. Columns are named by the two frozen lists below, used to build
 * both the SELECT and the row mapper, so the statement and the mapping cannot
 * drift in what they read.
 *
 * Every statement is parameterised. There is no string interpolation of a value
 * anywhere in this file — the only interpolation is of the column lists, which
 * are compile-time constants.
 */

const { iso, num } = require('./helpers');

/** Columns of fees_import_batch, in one place. No SELECT *. */
const BATCH_COLUMNS = [
  'batch_id',
  'office',
  'filename',
  'file_sha256',
  'file_size_bytes',
  'source_type',
  'status',
  'row_count',
  'warning_count',
  'parse_warnings',
  'failure_reason',
  'failure_code',
  'created_by',
  'created_at',
  'updated_at',
].join(', ');

/** Columns of fees_import_row, in one place. No SELECT *. */
const ROW_COLUMNS = [
  'row_id',
  'batch_id',
  'office',
  'proc_code',
  'fee_cents',
  'raw_line',
  'parse_warnings',
  'row_order',
  // Slice 3. The preview has to show what a human already decided about a
  // warned row, and by whom — a decision the reader cannot see is one they
  // make twice.
  'decision',
  'decided_by',
  'decided_at',
  'od_fee_num',
].join(', ');

/**
 * A stored batch, in the shape the API returns.
 *
 * `failureReason`/`failureCode` are present and null on a parsed batch rather
 * than omitted, so a client switching on them never has to distinguish "absent"
 * from "null" — the honest-states rule applied to a JSON shape.
 *
 * @param {Record<string, unknown>} r
 */
function toBatch(r) {
  return {
    batchId: r.batch_id,
    office: r.office,
    filename: r.filename,
    fileSha256: r.file_sha256,
    fileSizeBytes: num(r.file_size_bytes),
    sourceType: r.source_type,
    status: r.status,
    rowCount: num(r.row_count),
    warningCount: num(r.warning_count),
    warnings: Array.isArray(r.parse_warnings) ? r.parse_warnings : [],
    failureReason: r.failure_reason === undefined ? null : r.failure_reason,
    failureCode: r.failure_code === undefined ? null : r.failure_code,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** A stored row, in the shape the API returns. */
function toRow(r) {
  return {
    rowId: r.row_id,
    procCode: r.proc_code,
    feeCents: num(r.fee_cents),
    rawLine: r.raw_line,
    warnings: Array.isArray(r.parse_warnings) ? r.parse_warnings : [],
    rowOrder: num(r.row_order),
    // `pending` rather than null when the column is absent, so a client never
    // has to distinguish "no decision" from "this backend is older".
    decision: typeof r.decision === 'string' ? r.decision : 'pending',
    decidedBy: r.decided_by === undefined ? null : r.decided_by,
    decidedAt: iso(r.decided_at),
    // Present ⇒ this row is in Open Dental. The resume key, and what the
    // rollback deletes.
    odFeeNum: r.od_fee_num === null || r.od_fee_num === undefined ? null : num(r.od_fee_num),
  };
}

/**
 * Write one batch and, when the parse succeeded, all of its rows — in ONE
 * transaction.
 *
 * ATOMIC ON PURPOSE. A committed batch that says `row_count: 412` beside 300
 * stored rows is the dishonest state this module exists to not have: a preview
 * an office scrolls to the bottom of and believes they have seen. Either the
 * batch and every row land, or nothing does and the upload can simply be
 * re-sent — nothing was reserved and no money moved, so a retry is free.
 *
 * The rows go in as ONE multi-row INSERT rather than a loop. A 400-row schedule
 * is 400 round trips otherwise, inside a transaction holding a connection.
 *
 * @param {import('pg').Pool} pool
 * @param {object} batch
 * @param {string} batch.office
 * @param {string} batch.filename
 * @param {string} batch.fileSha256
 * @param {number} batch.fileSizeBytes
 * @param {string} batch.sourceType
 * @param {'parsed'|'failed'} batch.status
 * @param {number} batch.warningCount
 * @param {Array<{code: string, message: string}>} batch.warnings
 * @param {string|null} batch.failureReason
 * @param {string|null} batch.failureCode
 * @param {string} batch.createdBy
 * @param {Array<{procCode: string, feeCents: number, rawLine: string, warnings: Array}>} rows
 * @returns {Promise<{ batch: ReturnType<typeof toBatch>, rows: ReturnType<typeof toRow>[] }>}
 */
async function insertBatch(pool, batch, rows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO fees_import_batch
         (office, filename, file_sha256, file_size_bytes, source_type, status,
          row_count, warning_count, parse_warnings, failure_reason, failure_code, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
       RETURNING ${BATCH_COLUMNS}`,
      [
        batch.office,
        batch.filename,
        batch.fileSha256,
        batch.fileSizeBytes,
        batch.sourceType,
        batch.status,
        rows.length,
        batch.warningCount,
        JSON.stringify(batch.warnings || []),
        batch.failureReason,
        batch.failureCode,
        batch.createdBy,
      ]
    );
    const stored = inserted.rows[0];

    /** @type {Array<Record<string, unknown>>} */
    let storedRows = [];
    if (rows.length > 0) {
      // Six parameters per row, numbered $1..$6, $7..$12, … — built by index so
      // the placeholder list and the value list cannot fall out of step.
      const values = [];
      const placeholders = rows.map((row, i) => {
        const base = i * 6;
        values.push(
          stored.batch_id,
          // The batch's OWN office, not the request's. They are the same value
          // today; taking it from the stored row means a future caller cannot
          // make them differ, and the composite FK would refuse it if they did.
          stored.office,
          row.procCode,
          row.feeCents,
          row.rawLine,
          JSON.stringify(row.warnings || [])
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, ${i})`;
      });
      const result = await client.query(
        `INSERT INTO fees_import_row
           (batch_id, office, proc_code, fee_cents, raw_line, parse_warnings, row_order)
         VALUES ${placeholders.join(', ')}
         RETURNING ${ROW_COLUMNS}`,
        values
      );
      storedRows = result.rows;
    }

    await client.query('COMMIT');
    return { batch: toBatch(stored), rows: storedRows.map(toRow) };
  } catch (err) {
    // Best-effort rollback: if the connection itself is the problem the
    // transaction is already dead, and the original error is the useful one.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One office's import batches, newest first. Rows are NOT included — a list of
 * fifty schedules at four hundred rows each is twenty thousand rows nobody
 * asked for.
 *
 * @param {import('pg').Pool} pool
 * @param {string} office
 * @param {{ limit: number, offset: number }} page
 */
async function listBatches(pool, office, page) {
  const result = await pool.query(
    `SELECT ${BATCH_COLUMNS}
       FROM fees_import_batch
      WHERE office = $1
      ORDER BY created_at DESC, batch_id DESC
      LIMIT $2 OFFSET $3`,
    [office, page.limit, page.offset]
  );
  return result.rows.map(toBatch);
}

/**
 * One batch, or null.
 *
 * The office is in the WHERE, not checked afterwards in JavaScript. A row
 * belonging to the other office is not fetched-then-rejected; it is never
 * fetched, so there is no branch that could forget to reject it.
 *
 * @param {import('pg').Pool} pool
 * @param {string} office
 * @param {string} batchId
 */
async function getBatch(pool, office, batchId) {
  const result = await pool.query(
    `SELECT ${BATCH_COLUMNS} FROM fees_import_batch WHERE office = $1 AND batch_id = $2`,
    [office, batchId]
  );
  return result.rows.length > 0 ? toBatch(result.rows[0]) : null;
}

/**
 * One batch's rows, in the file's own order.
 *
 * Scoped by office AND batch_id, even though batch_id alone is a uuid and
 * therefore already unambiguous. The composite filter is the point: it means
 * this statement matches the composite index and cannot return another office's
 * rows even if a batch id leaked.
 *
 * @param {import('pg').Pool} pool
 * @param {string} office
 * @param {string} batchId
 */
async function getBatchRows(pool, office, batchId) {
  const result = await pool.query(
    `SELECT ${ROW_COLUMNS}
       FROM fees_import_row
      WHERE office = $1 AND batch_id = $2
      ORDER BY row_order ASC`,
    [office, batchId]
  );
  return result.rows.map(toRow);
}

module.exports = {
  BATCH_COLUMNS,
  ROW_COLUMNS,
  insertBatch,
  listBatches,
  getBatch,
  getBatchRows,
  toBatch,
  toRow,
};
