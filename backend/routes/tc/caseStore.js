'use strict';

/**
 * SQL + row-normalization layer for the TC case aggregate.
 *
 * The strict contract's row mappers (caseToRows / caseFromRows, bundled from
 * new-dashboard/shared/tc/rows.ts) are the single authority for the
 * aggregate ↔ row mapping; this module owns only (a) the explicit-column SQL
 * for each tc_* table and (b) normalizing pg driver types (bigint strings,
 * Date objects) into the contract's JSON types so caseFromRows can parse.
 *
 * Every SELECT and every WHERE here carries office_id — a record from the
 * other office is unreachable by construction. Used by cases.js, hygiene.js
 * and followups.js; `q` is anything with .query() (a Pool or a tx client).
 */

const { contract, iso, isoDate, num } = require('./helpers');

const { caseFromRows } = contract;

// ── Column lists (mirror migration 1785373200000_tc_schema.js, minus
//    created_at/updated_at bookkeeping and the importer-owned legacy_snapshot) ─

const CASE_COLS = [
  'case_id',
  'legacy_id',
  'office_id',
  'patient_name',
  'patient_age',
  'phone',
  'email',
  'od_patient_id',
  'case_type',
  'category',
  'status',
  'urgency',
  'doctor_name',
  'diagnosing_provider',
  'assigned_tc',
  'case_value_cents',
  'readiness_score',
  'financing_status',
  'preferred_financing_provider',
  'decision_makers',
  'financial_situation',
  'key_motivators',
  'contact_preference',
  'best_time_to_reach',
  'notes',
  'referral_source',
  'lost_reason',
  'diagnosed_date',
  'status_changed_at',
  'nurture_cadence',
  'in_long_tail_mode',
  'nurture_enrolled_at',
  'nurture_phase_changed_at',
  'nurture_phase1_days_override',
  'nurture_phase2_days_override',
  'nurture_unsubscribed',
];

const PHASE_COLS = ['phase_id', 'case_id', 'office_id', 'position', 'name', 'description'];

const ITEM_COLS = [
  'item_id',
  'phase_id',
  'case_id',
  'office_id',
  'position',
  'legacy_item_id',
  'od_proc_num',
  'tooth',
  'procedure_name',
  'patient_description',
  'fee_cents',
  'insurance_est_cents',
  'patient_portion_cents',
  'urgency',
  'time_estimate',
  'benefits',
  'risks_of_delay',
  'expected_outcome',
];

const OBJECTION_COLS = ['objection_id', 'case_id', 'office_id', 'category', 'note', 'patient_words', 'logged_at'];

const FOLLOWUP_COLS = [
  'followup_id',
  'case_id',
  'office_id',
  'kind',
  'due_date',
  'channel',
  'status',
  'talking_point',
  'outcome_note',
  'completed_at',
  'completed_by',
  'source',
  'patient_responded',
  'nurture_type',
  'legacy_id',
];

// source_call_id is null on every event type but voice_handoff; params() maps a
// missing key to null, so existing insertEventRow callers need no change.
const EVENT_COLS = [
  'event_id',
  'case_id',
  'office_id',
  'ts',
  'type',
  'description',
  'actor',
  'detail',
  'legacy_id',
  'source_call_id',
];

const INTAKE_COLS = [
  'intake_id',
  'case_id',
  'office_id',
  'submitted_by',
  'submitted_by_name',
  'submitted_at',
  'operatory',
  'visit_date',
  'provider_seen',
  'chief_concern',
  'perio_status',
  'recall_type',
  'radiographs',
  'intraoral_photos_taken',
  'areas_of_concern',
  'suspected_treatment',
  'hygienist_recommendation',
  'insurance_noted',
  'patient_interest_level',
  'flag_urgent',
];

/** `INSERT INTO t (a, b) VALUES ($1, $2)` for a column list. */
function insertSql(table, cols) {
  const params = cols.map((_, i) => `$${i + 1}`).join(', ');
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${params})`;
}

/** Ordered param array for a row object and column list. */
function params(row, cols) {
  return cols.map((c) => (row[c] === undefined ? null : row[c]));
}

// ── pg → contract type normalization ────────────────────────────────────────

function normalizeCaseRow(r) {
  return {
    ...r,
    od_patient_id: num(r.od_patient_id),
    case_value_cents: num(r.case_value_cents),
    diagnosed_date: isoDate(r.diagnosed_date),
    status_changed_at: iso(r.status_changed_at),
    nurture_enrolled_at: iso(r.nurture_enrolled_at),
    nurture_phase_changed_at: iso(r.nurture_phase_changed_at),
  };
}

function normalizeItemRow(r) {
  return {
    ...r,
    od_proc_num: num(r.od_proc_num),
    fee_cents: num(r.fee_cents),
    insurance_est_cents: num(r.insurance_est_cents),
    patient_portion_cents: num(r.patient_portion_cents),
  };
}

function normalizeObjectionRow(r) {
  return { ...r, logged_at: iso(r.logged_at) };
}

function normalizeFollowupRow(r) {
  return { ...r, due_date: isoDate(r.due_date), completed_at: iso(r.completed_at) };
}

function normalizeEventRow(r) {
  return { ...r, ts: iso(r.ts) };
}

function normalizeIntakeRow(r) {
  return { ...r, submitted_at: iso(r.submitted_at), visit_date: isoDate(r.visit_date) };
}

// ── Aggregate reads ─────────────────────────────────────────────────────────

/**
 * Load one case aggregate (case + all children), office-scoped.
 * @param {{ query: Function }} q
 * @param {string} office
 * @param {string} caseId
 * @returns {Promise<import('../../tc/contract.gen.cjs').TcCase | null>}
 */
async function loadCaseAggregate(q, office, caseId) {
  const caseRes = await q.query(
    `SELECT ${CASE_COLS.join(', ')} FROM tc_cases WHERE office_id = $1 AND case_id = $2`,
    [office, caseId]
  );
  if (caseRes.rows.length === 0) return null;

  const [phases, items, objections, followups, events, intake] = await Promise.all([
    q.query(`SELECT ${PHASE_COLS.join(', ')} FROM tc_case_phases WHERE office_id = $1 AND case_id = $2`, [office, caseId]),
    q.query(`SELECT ${ITEM_COLS.join(', ')} FROM tc_case_items WHERE office_id = $1 AND case_id = $2`, [office, caseId]),
    q.query(`SELECT ${OBJECTION_COLS.join(', ')} FROM tc_case_objections WHERE office_id = $1 AND case_id = $2 ORDER BY logged_at`, [office, caseId]),
    q.query(`SELECT ${FOLLOWUP_COLS.join(', ')} FROM tc_followups WHERE office_id = $1 AND case_id = $2 ORDER BY due_date`, [office, caseId]),
    q.query(`SELECT ${EVENT_COLS.join(', ')} FROM tc_case_events WHERE office_id = $1 AND case_id = $2 ORDER BY ts`, [office, caseId]),
    q.query(`SELECT ${INTAKE_COLS.join(', ')} FROM tc_hygiene_intakes WHERE office_id = $1 AND case_id = $2`, [office, caseId]),
  ]);

  return caseFromRows({
    caseRow: normalizeCaseRow(caseRes.rows[0]),
    phaseRows: phases.rows,
    itemRows: items.rows.map(normalizeItemRow),
    objectionRows: objections.rows.map(normalizeObjectionRow),
    followupRows: followups.rows.map(normalizeFollowupRow),
    eventRows: events.rows.map(normalizeEventRow),
    hygieneIntakeRow: intake.rows.length ? normalizeIntakeRow(intake.rows[0]) : null,
  });
}

// ── Row writers (explicit columns, parameterized, one row per call) ─────────

async function insertCaseRow(q, caseRow) {
  await q.query(insertSql('tc_cases', CASE_COLS), params(caseRow, CASE_COLS));
}

async function insertPhaseRow(q, row) {
  await q.query(insertSql('tc_case_phases', PHASE_COLS), params(row, PHASE_COLS));
}

async function insertItemRow(q, row) {
  await q.query(insertSql('tc_case_items', ITEM_COLS), params(row, ITEM_COLS));
}

async function insertObjectionRow(q, row) {
  await q.query(insertSql('tc_case_objections', OBJECTION_COLS), params(row, OBJECTION_COLS));
}

async function insertFollowupRow(q, row) {
  await q.query(insertSql('tc_followups', FOLLOWUP_COLS), params(row, FOLLOWUP_COLS));
}

async function insertEventRow(q, row) {
  await q.query(insertSql('tc_case_events', EVENT_COLS), params(row, EVENT_COLS));
}

async function insertIntakeRow(q, row) {
  await q.query(insertSql('tc_hygiene_intakes', INTAKE_COLS), params(row, INTAKE_COLS));
}

/**
 * Assert a case exists in this office; returns its current status row or null.
 * @param {{ query: Function }} q
 */
async function getCaseHeader(q, office, caseId) {
  const res = await q.query(
    `SELECT case_id, office_id, patient_name, status, assigned_tc, nurture_enrolled_at
       FROM tc_cases WHERE office_id = $1 AND case_id = $2`,
    [office, caseId]
  );
  return res.rows.length ? res.rows[0] : null;
}

module.exports = {
  CASE_COLS,
  PHASE_COLS,
  ITEM_COLS,
  OBJECTION_COLS,
  FOLLOWUP_COLS,
  EVENT_COLS,
  INTAKE_COLS,
  insertSql,
  params,
  normalizeCaseRow,
  normalizeItemRow,
  normalizeObjectionRow,
  normalizeFollowupRow,
  normalizeEventRow,
  normalizeIntakeRow,
  loadCaseAggregate,
  insertCaseRow,
  insertPhaseRow,
  insertItemRow,
  insertObjectionRow,
  insertFollowupRow,
  insertEventRow,
  insertIntakeRow,
  getCaseHeader,
};
