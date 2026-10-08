'use strict';

/**
 * tc_opportunities / tc_opportunity_sync — the statements, in one place.
 *
 * Every statement is parameterized and office-scoped, and every SELECT names
 * its columns. Both the nightly sync (services/tcOpportunities/sync.js) and the
 * inbox routes (routes/tc/opportunities.js) go through here, so the two can
 * never disagree about which columns a row has.
 *
 * jsonb is written as `$n::jsonb` from a JSON string: node-pg would otherwise
 * serialise a JS array as a Postgres ARRAY literal, not JSON. It is read back
 * through `parseProcedures`, which also accepts a string (the TC test harness
 * stores what it was given).
 */

const { OPEN_CASE_STATUSES } = require('../../tc/contract.gen.cjs');
const core = require('./core');

/** tc_opportunities columns every read returns. */
const OPP_COLS = Object.freeze([
  'opportunity_id',
  'office_id',
  'od_patient_id',
  'patient_name',
  'patient_phone',
  'patient_status',
  'procedures',
  'value_cents',
  'planned_date',
  'status',
  'claimed_case_id',
  'claimed_by',
  'claimed_at',
  'dismissed_reason',
  'dismissed_by',
  'dismissed_at',
  'resurrected_at',
  'cleared_at',
  'first_seen_at',
  'last_seen_at',
]);

/** tc_opportunity_sync columns. */
const SYNC_COLS = Object.freeze([
  'office_id',
  'last_synced_at',
  'watermark',
  'last_attempt_at',
  'last_status',
  'last_error',
  'procedures_scanned',
  'pages',
  'patients',
  'name_reads',
  'names_pending',
  'duration_ms',
]);

/** @param {unknown} v @returns {import('./core').OpportunityProcedure[]} */
function parseProcedures(v) {
  let value = v;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

/** ISO string for a pg timestamptz (Date | string | null). */
function iso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * 'YYYY-MM-DD' for a pg DATE.
 *
 * node-pg parses a DATE as LOCAL midnight, so the calendar day is read from
 * the LOCAL components. `toISOString()` would shift it a day in any zone east
 * of UTC, and `String(date)` is "Sat Aug 15 2026 …" — neither is a date.
 */
function isoDate(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * A raw row with procedures parsed and numbers coerced (pg returns bigint as a
 * string). Kept snake_case — this is the store's shape, not the wire's.
 * @param {Record<string, unknown>} r
 */
function normalizeRow(r) {
  return {
    ...r,
    od_patient_id: Number(r.od_patient_id),
    value_cents: Number(r.value_cents || 0),
    procedures: parseProcedures(r.procedures),
  };
}

/**
 * The wire shape the inbox page reads (camelCase). PatNum travels WITH its
 * office, always — a PatNum alone names a different person in each database.
 * @param {ReturnType<typeof normalizeRow>} r
 */
function toWire(r) {
  return {
    opportunityId: String(r.opportunity_id),
    officeId: String(r.office_id),
    odPatientId: r.od_patient_id,
    patientName: r.patient_name == null ? null : String(r.patient_name),
    patientPhone: r.patient_phone == null ? null : String(r.patient_phone),
    procedures: r.procedures,
    valueCents: r.value_cents,
    plannedDate: isoDate(r.planned_date),
    status: String(r.status),
    claimedCaseId: r.claimed_case_id == null ? null : String(r.claimed_case_id),
    claimedBy: r.claimed_by == null ? null : String(r.claimed_by),
    claimedAt: iso(r.claimed_at),
    dismissedReason: r.dismissed_reason == null ? null : String(r.dismissed_reason),
    dismissedBy: r.dismissed_by == null ? null : String(r.dismissed_by),
    dismissedAt: iso(r.dismissed_at),
    resurrectedAt: iso(r.resurrected_at),
    firstSeenAt: iso(r.first_seen_at),
    lastSeenAt: iso(r.last_seen_at),
  };
}

/** @param {Record<string, unknown>|null|undefined} r */
function syncToWire(r) {
  if (!r) return null;
  return {
    lastSyncedAt: iso(r.last_synced_at),
    lastAttemptAt: iso(r.last_attempt_at),
    lastStatus: r.last_status == null ? null : String(r.last_status),
    lastError: r.last_error == null ? null : String(r.last_error),
    proceduresScanned: r.procedures_scanned == null ? null : Number(r.procedures_scanned),
    patients: r.patients == null ? null : Number(r.patients),
    namesPending: r.names_pending == null ? null : Number(r.names_pending),
  };
}

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number }> }} Q */

/** Every row for an office. @param {Q} q @param {string} office */
async function listForOffice(q, office) {
  const res = await q.query(
    `SELECT ${OPP_COLS.join(', ')} FROM tc_opportunities
      WHERE office_id = $1
      ORDER BY value_cents DESC, od_patient_id`,
    [office]
  );
  return res.rows.map(normalizeRow);
}

/** One row, office-scoped. @param {Q} q */
async function getOne(q, office, opportunityId) {
  const res = await q.query(
    `SELECT ${OPP_COLS.join(', ')} FROM tc_opportunities
      WHERE office_id = $1 AND opportunity_id = $2`,
    [office, opportunityId]
  );
  return res.rows.length ? normalizeRow(res.rows[0]) : null;
}

/** @param {Q} q @param {string} office @param {import('./core').PatientCandidate} c */
async function insertCandidate(q, office, c, id, seenAt = new Date()) {
  await q.query(
    `INSERT INTO tc_opportunities (opportunity_id, office_id, od_patient_id, procedures, value_cents, planned_date, status,
                                   first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
    [id, office, c.patNum, JSON.stringify(c.procedures), c.valueCents, c.plannedDate, 'new', seenAt, seenAt]
  );
}

/**
 * Open row: snapshot replaced. Guarded on the status the sync READ, so a claim
 * or dismissal that landed while the sweep ran is never overwritten.
 * @param {Q} q
 */
async function refreshOpen(q, office, row, c) {
  const res = await q.query(
    `UPDATE tc_opportunities
        SET procedures = $4::jsonb, value_cents = $5, planned_date = $6, cleared_at = $7,
            last_seen_at = now(), updated_at = now()
      WHERE office_id = $1 AND opportunity_id = $2 AND status = $3`,
    [office, row.opportunity_id, row.status, JSON.stringify(c.procedures), c.valueCents, c.plannedDate, null]
  );
  return res.rowCount || 0;
}

/** Frozen/dismissed row still present: last_seen moves, snapshot untouched. @param {Q} q */
async function touch(q, office, row) {
  const res = await q.query(
    `UPDATE tc_opportunities
        SET cleared_at = $4, last_seen_at = now(), updated_at = now()
      WHERE office_id = $1 AND opportunity_id = $2 AND status = $3`,
    [office, row.opportunity_id, row.status, null]
  );
  return res.rowCount || 0;
}

/** Dismissed + a new ProcNum → back to new. @param {Q} q */
async function resurrect(q, office, row, c) {
  const res = await q.query(
    `UPDATE tc_opportunities
        SET status = $4, dismissed_reason = $5, dismissed_by = $6, dismissed_at = $7,
            procedures = $8::jsonb, value_cents = $9, planned_date = $10, cleared_at = $11,
            resurrected_at = now(), last_seen_at = now(), updated_at = now()
      WHERE office_id = $1 AND opportunity_id = $2 AND status = $3`,
    [
      office,
      row.opportunity_id,
      'dismissed',
      'new',
      null,
      null,
      null,
      JSON.stringify(c.procedures),
      c.valueCents,
      c.plannedDate,
      null,
    ]
  );
  return res.rowCount || 0;
}

/** Nothing qualifying any more. @param {Q} q */
async function clear(q, office, row) {
  const res = await q.query(
    `UPDATE tc_opportunities
        SET cleared_at = now(), updated_at = now()
      WHERE office_id = $1 AND opportunity_id = $2 AND status = $3`,
    [office, row.opportunity_id, row.status]
  );
  return res.rowCount || 0;
}

/** Name pass result. @param {Q} q */
async function setPatientSnapshot(q, office, opportunityId, snap) {
  await q.query(
    `UPDATE tc_opportunities
        SET patient_name = $3, patient_phone = $4, patient_status = $5, updated_at = now()
      WHERE office_id = $1 AND opportunity_id = $2`,
    [office, opportunityId, snap.name, snap.phone, snap.status]
  );
}

/**
 * Patients in this office with an OPEN TC case, most recently active case
 * first per patient. @param {Q} q
 * @returns {Promise<Map<number, string>>} PatNum → case_id
 */
async function openCasesByPatient(q, office) {
  const res = await q.query(
    `SELECT case_id, od_patient_id FROM tc_cases
      WHERE office_id = $1 AND status = ANY($2) AND od_patient_id IS NOT NULL
      ORDER BY updated_at DESC`,
    [office, [...OPEN_CASE_STATUSES]]
  );
  /** @type {Map<number, string>} */
  const out = new Map();
  for (const r of res.rows) {
    const pat = Number(r.od_patient_id);
    if (!out.has(pat)) out.set(pat, String(r.case_id));
  }
  return out;
}

/**
 * Apply existing_case marking, both directions. Each flip is guarded on the
 * status it was planned from. @param {Q} q
 * @returns {Promise<number>} rows flipped
 */
async function reconcileExistingCases(q, office) {
  const rows = await listForOffice(q, office);
  const open = await openCasesByPatient(q, office);
  const flips = core.planExistingCaseFlips(rows, new Set(open.keys()));
  let n = 0;
  for (const f of flips) {
    const res = await q.query(
      `UPDATE tc_opportunities
          SET status = $4, updated_at = now()
        WHERE office_id = $1 AND opportunity_id = $2 AND status = $3 AND claimed_case_id IS NULL`,
      [office, f.opportunityId, f.from, f.to]
    );
    n += res.rowCount || 0;
  }
  return n;
}

/** @param {Q} q */
async function getSyncState(q, office) {
  const res = await q.query(
    `SELECT ${SYNC_COLS.join(', ')} FROM tc_opportunity_sync WHERE office_id = $1`,
    [office]
  );
  return res.rows[0] || null;
}

/**
 * Record a sync attempt. `ok` moves last_synced_at + watermark; anything else
 * leaves them exactly where the last COMPLETED sweep put them — the honest
 * "last synced" is the last one that worked.
 * @param {Q} q
 * @param {string} office
 * @param {{ status: 'ok'|'partial'|'failed', error: string|null, watermark: string|null,
 *           proceduresScanned: number, pages: number, patients: number|null,
 *           nameReads: number, namesPending: number|null, durationMs: number }} s
 */
async function recordSync(q, office, s) {
  const prev = await getSyncState(q, office);
  const ok = s.status === 'ok';
  const now = new Date();
  await q.query(
    `INSERT INTO tc_opportunity_sync (office_id, last_synced_at, watermark, last_attempt_at, last_status, last_error,
                                      procedures_scanned, pages, patients, name_reads, names_pending, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (office_id) DO UPDATE
        SET last_synced_at = EXCLUDED.last_synced_at, watermark = EXCLUDED.watermark,
            last_attempt_at = EXCLUDED.last_attempt_at, last_status = EXCLUDED.last_status,
            last_error = EXCLUDED.last_error, procedures_scanned = EXCLUDED.procedures_scanned,
            pages = EXCLUDED.pages, patients = EXCLUDED.patients, name_reads = EXCLUDED.name_reads,
            names_pending = EXCLUDED.names_pending, duration_ms = EXCLUDED.duration_ms,
            updated_at = now()`,
    [
      office,
      ok ? now : (prev && prev.last_synced_at) || null,
      ok ? s.watermark : (prev && prev.watermark) || null,
      now,
      s.status,
      s.error,
      s.proceduresScanned,
      s.pages,
      s.patients == null ? (prev && prev.patients) ?? null : s.patients,
      s.nameReads,
      s.namesPending == null ? (prev && prev.names_pending) ?? null : s.namesPending,
      s.durationMs,
    ]
  );
}

module.exports = {
  isoDate,
  OPP_COLS,
  SYNC_COLS,
  parseProcedures,
  normalizeRow,
  toWire,
  syncToWire,
  listForOffice,
  getOne,
  insertCandidate,
  refreshOpen,
  touch,
  resurrect,
  clear,
  setPatientSnapshot,
  openCasesByPatient,
  reconcileExistingCases,
  getSyncState,
  recordSync,
};
