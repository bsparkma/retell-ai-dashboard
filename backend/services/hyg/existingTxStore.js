'use strict';

/**
 * Existing treatment dispositions (hygiene Slice 2a) — every statement this
 * slice owns against `hyg_existing_tx_disposition`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * OFFICE IS IN EVERY WHERE CLAUSE
 * ═════════════════════════════════════════════════════════════════════════════
 * A ProcNum restarts in every Open Dental database, so the same number in
 * roland and valley is two procedures on two people. Every lookup here filters
 * on office as well as on the visit or patient, the same rule visitStore.js
 * keeps, and `hygExistingTx.test.js` proves a valley request cannot reach a
 * roland row.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FROZEN ONCE THE VISIT IS SENT — IN THE SAME STATEMENT AS THE WRITE
 * ═════════════════════════════════════════════════════════════════════════════
 * The rule is the slip's: once the visit's `router` or `note` write has left
 * Draft/Staged (Sending, Written or Failed — visitStore's CLIENT_MUTABLE_STATES
 * read the other way), what was recorded at this visit is the record and is no
 * longer edited here. The guard is a NOT EXISTS inside the upsert itself, so
 * there is no read-then-write window in which a send could start between the
 * check and the save.
 */

/** Staged-write kinds whose send freezes the dispositions. */
const FREEZING_KINDS = Object.freeze(['router', 'note']);
/** The states a staged write is in once it has left the client's hands. */
const FROZEN_STATES = Object.freeze(['Sending', 'Written', 'Failed']);

const COLUMNS = `
  proc_num, clinical, patient, wait_timeframe, note, proc_snapshot,
  created_by, created_at, updated_by, updated_at
`;

/** An ISO string, or null. Postgres hands back Date objects. */
function iso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** 'YYYY-MM-DD' for a Postgres `date` (a Date at local midnight, or a string). */
function isoDate(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

/** A row → the contract's ExistingTxDisposition. */
function toDisposition(row) {
  return {
    clinical: row.clinical ?? null,
    patient: row.patient,
    waitTimeframe: row.wait_timeframe ?? null,
    note: row.note ?? null,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  };
}

/**
 * Whether this visit's answers are frozen.
 * @returns {Promise<boolean>}
 */
async function isFrozen(pool, { office, visitId }) {
  const res = await pool.query(
    `SELECT 1 FROM hyg_staged_write
      WHERE office = $1 AND visit_id = $2
        AND kind = ANY($3::text[]) AND state = ANY($4::text[])
      LIMIT 1`,
    [office, visitId, FREEZING_KINDS, FROZEN_STATES]
  );
  return res.rowCount > 0;
}

/**
 * This visit's dispositions, keyed by ProcNum.
 * @returns {Promise<Map<number, ReturnType<typeof toDisposition>>>}
 */
async function listForVisit(pool, { office, visitId }) {
  const res = await pool.query(
    `SELECT ${COLUMNS} FROM hyg_existing_tx_disposition
      WHERE office = $1 AND visit_id = $2`,
    [office, visitId]
  );
  return new Map(res.rows.map((r) => [Number(r.proc_num), toDisposition(r)]));
}

/**
 * "Last discussed": for each ProcNum, the most recent answer from an EARLIER
 * visit — same office, same patient, same procedure — where the patient's
 * answer was something other than `not_discussed`.
 *
 * EARLIER means an earlier visit DATE than this one. This visit is excluded by
 * id as well, and a visit with no date has no "earlier" and gets no lines:
 * guessing an order would put a later answer under "last discussed".
 *
 * @returns {Promise<Map<number, { visitDate: string, patient: string, waitTimeframe: string|null, clinical: string|null }>>}
 */
async function lastDiscussed(pool, { office, patNum, visitId, visitDate, procNums }) {
  if (!visitDate || procNums.length === 0) return new Map();
  const res = await pool.query(
    `SELECT DISTINCT ON (d.proc_num)
            d.proc_num, d.patient, d.wait_timeframe, d.clinical, v.visit_date
       FROM hyg_existing_tx_disposition d
       JOIN hyg_visit v ON v.visit_id = d.visit_id AND v.office = d.office
      WHERE d.office = $1 AND d.pat_num = $2 AND d.proc_num = ANY($3::bigint[])
        AND d.visit_id <> $4 AND d.patient <> 'not_discussed'
        AND v.visit_date < $5::date
      ORDER BY d.proc_num, v.visit_date DESC, d.updated_at DESC`,
    [office, patNum, procNums, visitId, visitDate]
  );
  return new Map(
    res.rows.map((r) => [
      Number(r.proc_num),
      {
        visitDate: isoDate(r.visit_date),
        patient: r.patient,
        waitTimeframe: r.wait_timeframe ?? null,
        clinical: r.clinical ?? null,
      },
    ])
  );
}

/**
 * Store one disposition, unless the visit is frozen.
 *
 * The WHOLE disposition, replaced, as the slip is. `snapshot` is the SERVER's
 * own Open Dental read of the procedure; nothing in it came from the request.
 *
 * @returns {Promise<{ ok: true, disposition: ReturnType<typeof toDisposition> } | { ok: false, code: 'EXISTING_TX_FROZEN' }>}
 */
async function saveDisposition(pool, { office, visit, procNum, input, snapshot, actor }) {
  const res = await pool.query(
    `INSERT INTO hyg_existing_tx_disposition
       (office, visit_id, pat_num, proc_num, clinical, patient, wait_timeframe, note,
        proc_snapshot, created_by, updated_by)
     SELECT $1::text, $2::uuid, $3::bigint, $4::bigint, $5::text, $6::text, $7::text,
            $8::text, $9::jsonb, $10::text, $10::text
      WHERE NOT EXISTS (
        SELECT 1 FROM hyg_staged_write
         WHERE office = $1::text AND visit_id = $2::uuid
           AND kind = ANY($11::text[]) AND state = ANY($12::text[])
      )
     ON CONFLICT (office, visit_id, proc_num) DO UPDATE
       SET clinical = EXCLUDED.clinical,
           patient = EXCLUDED.patient,
           wait_timeframe = EXCLUDED.wait_timeframe,
           note = EXCLUDED.note,
           proc_snapshot = EXCLUDED.proc_snapshot,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
     RETURNING ${COLUMNS}`,
    [
      office,
      visit.visitId,
      visit.patNum,
      procNum,
      input.clinical,
      input.patient,
      input.waitTimeframe,
      input.note,
      JSON.stringify(snapshot),
      actor,
      FREEZING_KINDS,
      FROZEN_STATES,
    ]
  );
  if (res.rowCount === 0) return { ok: false, code: 'EXISTING_TX_FROZEN' };
  return { ok: true, disposition: toDisposition(res.rows[0]) };
}

module.exports = {
  isFrozen,
  listForVisit,
  lastDiscussed,
  saveDisposition,
  FREEZING_KINDS,
  FROZEN_STATES,
};
