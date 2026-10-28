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
 * The rule is the slip's: once the visit's `router`, `note` or `tc-handoff`
 * write has left Draft/Staged (Sending, Written or Failed), what was recorded at
 * this visit is the record and is no longer edited here. `Amending` freezes
 * too: it is only ever reached FROM Written, so a visit being amended is a
 * visit that was sent.
 *
 * `tc-handoff` joined in Slice 2b, when the handoff began to CARRY these
 * answers: anything that sends them freezes them, so what TC holds and what
 * this visit says can never disagree. A sent perio chart still does not.
 *
 * The guard is inside the upsert itself, and it LOCKS: the CTE takes FOR SHARE
 * on every router/note row of the visit, whatever its state. A send that has
 * moved a row to `Sending` but not yet committed holds that row's lock, so the
 * upsert waits for it and then re-reads the committed state (READ COMMITTED
 * re-checks a row it waited on) — it cannot see `Staged` and write past a send.
 * `count(*)` rather than EXISTS so every matching row is read, and so locked.
 */

/** Staged-write kinds whose send freezes the dispositions. */
const FREEZING_KINDS = Object.freeze(['router', 'note', 'tc-handoff']);
/** The states a staged write is in once it has left the client's hands. */
const FROZEN_STATES = Object.freeze(['Sending', 'Written', 'Failed', 'Amending']);

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
    `WITH writes AS (
       SELECT state FROM hyg_staged_write
        WHERE office = $1::text AND visit_id = $2::uuid AND kind = ANY($11::text[])
        FOR SHARE
     )
     INSERT INTO hyg_existing_tx_disposition
       (office, visit_id, pat_num, proc_num, clinical, patient, wait_timeframe, note,
        proc_snapshot, created_by, updated_by)
     SELECT $1::text, $2::uuid, $3::bigint, $4::bigint, $5::text, $6::text, $7::text,
            $8::text, $9::jsonb, $10::text, $10::text
      WHERE (SELECT count(*) FROM writes WHERE state = ANY($12::text[])) = 0
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

/**
 * Store MANY procedures' answers — the "Select" bulk answer — all or nothing.
 *
 * ONE STATEMENT, so it is atomic without a transaction: the rows arrive as one
 * jsonb array, `jsonb_to_recordset` turns it into rows, and the upsert and its
 * freeze guard are the single-row statement's, unchanged. A frozen visit writes
 * none of them; a CHECK refusal on any row refuses the statement, so it writes
 * none of them either. Never part of a batch, never half of one.
 *
 * @param {import('pg').Pool} pool
 * @param {{ office: string, visit: { visitId: string, patNum: number },
 *           entries: { procNum: number, input: Record<string, any>, snapshot: Record<string, any> }[],
 *           actor: string }} args
 * @returns {Promise<{ ok: true, dispositions: Map<number, Record<string, any>> } | { ok: false, code: 'EXISTING_TX_FROZEN' }>}
 */
async function saveDispositions(pool, { office, visit, entries, actor }) {
  const rows = entries.map((e) => ({
    proc_num: e.procNum,
    clinical: e.input.clinical,
    patient: e.input.patient,
    wait_timeframe: e.input.waitTimeframe,
    note: e.input.note,
    proc_snapshot: e.snapshot,
  }));
  const res = await pool.query(
    `WITH writes AS (
       SELECT state FROM hyg_staged_write
        WHERE office = $1::text AND visit_id = $2::uuid AND kind = ANY($6::text[])
        FOR SHARE
     )
     INSERT INTO hyg_existing_tx_disposition
       (office, visit_id, pat_num, proc_num, clinical, patient, wait_timeframe, note,
        proc_snapshot, created_by, updated_by)
     SELECT $1::text, $2::uuid, $3::bigint, x.proc_num, x.clinical, x.patient, x.wait_timeframe,
            x.note, x.proc_snapshot, $5::text, $5::text
       FROM jsonb_to_recordset($4::jsonb)
         AS x(proc_num bigint, clinical text, patient text, wait_timeframe text, note text,
              proc_snapshot jsonb)
      WHERE (SELECT count(*) FROM writes WHERE state = ANY($7::text[])) = 0
     ON CONFLICT (office, visit_id, proc_num) DO UPDATE
       SET clinical = EXCLUDED.clinical,
           patient = EXCLUDED.patient,
           wait_timeframe = EXCLUDED.wait_timeframe,
           note = EXCLUDED.note,
           proc_snapshot = EXCLUDED.proc_snapshot,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
     RETURNING ${COLUMNS}`,
    [office, visit.visitId, visit.patNum, JSON.stringify(rows), actor, FREEZING_KINDS, FROZEN_STATES]
  );
  // The guard is all-or-nothing: either every row was written or none was.
  if (res.rowCount === 0) return { ok: false, code: 'EXISTING_TX_FROZEN' };
  return {
    ok: true,
    dispositions: new Map(res.rows.map((r) => [Number(r.proc_num), toDisposition(r)])),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice 2b: the plan the server last read, and what leaves the module
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remember a SUCCESSFUL read: every planned procedure's snapshot, so the Router
 * can list the ones nobody answered. Skipped when the stored read already has
 * this `readAt` (a cache hit), and never once the visit is frozen — the sent
 * record does not move. The frozen guard LOCKS, exactly as saveDisposition's
 * does, so a read racing a send cannot rewrite the plan the handoff reads. See migrations-tenant/1792900000000_hyg_existing_tx_read.js.
 */
async function recordLoaded(pool, { office, visitId, readAt, items }) {
  const value = {
    status: 'loaded',
    readAt,
    items: items.map((i) => ({
      procNum: i.procNum,
      code: i.code,
      description: i.description,
      tooth: i.tooth,
      surface: i.surface,
      dateTp: i.dateTp,
      priorityName: i.priorityName,
      scheduled: i.scheduled,
    })),
  };
  await pool.query(
    `WITH writes AS (
       SELECT state FROM hyg_staged_write
        WHERE office = $1 AND visit_id = $2 AND kind = ANY($5::text[])
        FOR SHARE
     )
     UPDATE hyg_visit SET existing_tx_read = $3::jsonb
      WHERE office = $1 AND visit_id = $2
        AND (existing_tx_read IS NULL OR existing_tx_read->>'readAt' IS DISTINCT FROM $4::text)
        AND (SELECT count(*) FROM writes WHERE state = ANY($6::text[])) = 0`,
    [office, visitId, JSON.stringify(value), readAt, FREEZING_KINDS, FROZEN_STATES]
  );
}

/**
 * Remember a FAILED read — only when nothing has ever loaded. A failure after a
 * success leaves the loaded plan in place: it WAS loaded, and the Router says so.
 */
async function recordFailed(pool, { office, visitId, at }) {
  await pool.query(
    `WITH writes AS (
       SELECT state FROM hyg_staged_write
        WHERE office = $1 AND visit_id = $2 AND kind = ANY($4::text[])
        FOR SHARE
     )
     UPDATE hyg_visit SET existing_tx_read = $3::jsonb
      WHERE office = $1 AND visit_id = $2 AND existing_tx_read IS NULL
        AND (SELECT count(*) FROM writes WHERE state = ANY($5::text[])) = 0`,
    [office, visitId, JSON.stringify({ status: 'failed', at }), FREEZING_KINDS, FROZEN_STATES]
  );
}

/** A string clamped to the handoff schema's bound, so a long OD value never makes TC refuse. */
function clamp(value, max) {
  const s = typeof value === 'string' ? value : '';
  return s.length > max ? s.slice(0, max) : s;
}

/** 'YYYY-MM-DD' or null — the only date shape the handoff schema accepts. */
function dateOrNull(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** A procedure snapshot in the handoff's shape, from a plan item or a stored proc_snapshot. */
function snapshotOf(procNum, s, scheduled) {
  return {
    procNum,
    code: clamp(s.code, 40),
    description: clamp(s.description, 300),
    tooth: clamp(s.tooth, 40),
    surface: clamp(s.surface, 20),
    dateTp: dateOrNull(s.dateTp ?? s.date_tp),
    priorityName: (() => {
      const p = s.priorityName ?? s.priority_name;
      return typeof p === 'string' && p !== '' ? clamp(p, 100) : null;
    })(),
    scheduled: scheduled === true,
  };
}

/** Newest planned date first, unknown last, ties by ProcNum — the screen's own order. */
function byNewest(a, b) {
  if (a.dateTp !== b.dateTp) {
    if (a.dateTp === null) return 1;
    if (b.dateTp === null) return -1;
    return a.dateTp < b.dateTp ? 1 : -1;
  }
  return b.procNum - a.procNum;
}

/**
 * The visit's existing treatment as it LEAVES the module — PURE.
 *
 * `read` is hyg_visit.existing_tx_read; `rows` the visit's dispositions. An
 * ANSWERED item is described by its own `proc_snapshot`, taken when it was
 * answered — so a later Open Dental edit does not rewrite what was discussed.
 * An unanswered item is described by the plan the server last read. Answered
 * items the latest plan no longer lists are kept: what was said is still what
 * was said. "Already scheduled" follows the latest plan when it has the item.
 *
 * @returns {{ status: 'not_loaded'|'failed'|'loaded', items: object[] }}
 */
function buildExistingTx(read, rows) {
  const plan =
    read && read.status === 'loaded' && Array.isArray(read.items) ? read.items : null;
  const status = plan ? 'loaded' : read && read.status === 'failed' ? 'failed' : 'not_loaded';
  const byProc = new Map(rows.map((r) => [Number(r.proc_num), r]));

  const answer = (snapshot, row) => ({
    ...snapshot,
    clinical: row ? row.clinical ?? null : null,
    patient: row ? row.patient : 'not_discussed',
    waitTimeframe: row ? row.wait_timeframe ?? null : null,
    note: row ? clamp(row.note, 500) || null : null,
  });

  const items = [];
  const seen = new Set();
  for (const p of plan || []) {
    const procNum = Number(p.procNum);
    if (!Number.isSafeInteger(procNum) || procNum <= 0 || seen.has(procNum)) continue;
    seen.add(procNum);
    const row = byProc.get(procNum) || null;
    const source = row && row.proc_snapshot ? row.proc_snapshot : p;
    items.push(answer(snapshotOf(procNum, source, p.scheduled), row));
  }
  const extra = rows
    .filter((r) => !seen.has(Number(r.proc_num)))
    .map((r) => {
      const s = r.proc_snapshot || {};
      return answer(snapshotOf(Number(r.proc_num), s, s.scheduled), r);
    })
    .sort(byNewest);
  return { status, items: [...items, ...extra] };
}

/**
 * Load the visit's existing treatment for composing or sending — office-keyed,
 * from CareIN's own tables only. No Open Dental request.
 */
async function loadForSend(pool, { office, visitId }) {
  const [visitRes, rowsRes] = await Promise.all([
    pool.query(
      `SELECT existing_tx_read FROM hyg_visit WHERE office = $1 AND visit_id = $2`,
      [office, visitId]
    ),
    pool.query(
      `SELECT ${COLUMNS} FROM hyg_existing_tx_disposition
        WHERE office = $1 AND visit_id = $2`,
      [office, visitId]
    ),
  ]);
  const read = visitRes.rowCount > 0 ? visitRes.rows[0].existing_tx_read : null;
  return buildExistingTx(read || null, rowsRes.rows);
}

module.exports = {
  isFrozen,
  listForVisit,
  lastDiscussed,
  saveDisposition,
  saveDispositions,
  recordLoaded,
  recordFailed,
  buildExistingTx,
  loadForSend,
  FREEZING_KINDS,
  FROZEN_STATES,
};
