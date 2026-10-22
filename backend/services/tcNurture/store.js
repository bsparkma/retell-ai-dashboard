'use strict';

/**
 * tc_nurture_enrollments — every statement the nurture slice runs (item 47).
 *
 * Every function takes a query handle `q` (a pool, or a transaction client)
 * and an office, and every statement is office_id-scoped: another practice's
 * enrollment is unreachable, not merely filtered later. No SELECT *.
 *
 * Postgres only. Nothing here, or anywhere in services/tcNurture, reads or
 * writes Open Dental (backend/services/tcNurture/tcNurtureNoOd.test.js scans
 * for it).
 */

const { randomUUID } = require('node:crypto');

const caseStore = require('../../routes/tc/caseStore');
const contract = require('../../tc/contract.gen.cjs');
const cfg = require('../../config/tcNurture');

const ENROLLMENT_COLS = [
  'enrollment_id',
  'case_id',
  'office_id',
  'track_key',
  'intensity_at_enroll',
  'status',
  'stop_reason',
  'next_touch_index',
  'next_touch_due_at',
  'last_touch_at',
  'created_by',
  'created_at',
  'updated_at',
];

/** The actor stamped on everything the engine itself does. Not a person. */
const SYSTEM_ACTOR = 'system:nurture';

function iso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/**
 * DB row → contract entity. `touchCount` is how many touches it has queued.
 * @param {Record<string, any>} r
 * @param {number} touchCount
 */
function toEnrollment(r, touchCount) {
  const steps = cfg.schedule(r.track_key, r.intensity_at_enroll);
  const index = Number(r.next_touch_index);
  return contract.TcNurtureEnrollment.parse({
    enrollmentId: r.enrollment_id,
    caseId: r.case_id,
    officeId: r.office_id,
    trackKey: r.track_key,
    intensityAtEnroll: r.intensity_at_enroll,
    status: r.status,
    stopReason: r.stop_reason ?? null,
    nextTouchIndex: index,
    nextTouchDueAt: r.status === 'active' || r.status === 'paused' ? iso(r.next_touch_due_at) : null,
    lastTouchAt: iso(r.last_touch_at),
    nextTouchKey: index < steps.length && (r.status === 'active' || r.status === 'paused') ? steps[index].touch : null,
    touchCount,
    createdBy: r.created_by ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  });
}

async function loadEnrollment(q, office, enrollmentId) {
  const res = await q.query(
    `SELECT ${ENROLLMENT_COLS.join(', ')} FROM tc_nurture_enrollments
      WHERE office_id = $1 AND enrollment_id = $2`,
    [office, enrollmentId]
  );
  return res.rows.length ? res.rows[0] : null;
}

/** A case's enrollments, newest first (history included). */
async function listForCase(q, office, caseId) {
  const res = await q.query(
    `SELECT ${ENROLLMENT_COLS.join(', ')} FROM tc_nurture_enrollments
      WHERE office_id = $1 AND case_id = $2 ORDER BY created_at DESC`,
    [office, caseId]
  );
  return res.rows;
}

/** A case's enrollments that are still running (active or paused). */
async function openForCase(q, office, caseId) {
  const res = await q.query(
    `SELECT ${ENROLLMENT_COLS.join(', ')} FROM tc_nurture_enrollments
      WHERE office_id = $1 AND case_id = $2 AND status = ANY($3)`,
    [office, caseId, ['active', 'paused']]
  );
  return res.rows;
}

/** Active enrollments in this office whose next touch is due by `now`. */
async function listDue(q, office, now) {
  const res = await q.query(
    `SELECT ${ENROLLMENT_COLS.join(', ')} FROM tc_nurture_enrollments
      WHERE office_id = $1 AND status = 'active' AND next_touch_due_at <= $2
      ORDER BY next_touch_due_at`,
    [office, now]
  );
  return res.rows;
}

/** The touches an enrollment has queued, as tc_messages rows (any status). */
async function touchesOf(q, office, enrollmentId) {
  const res = await q.query(
    `SELECT message_id, channel, status, touch_key, created_at FROM tc_messages
      WHERE office_id = $1 AND enrollment_id = $2 ORDER BY created_at`,
    [office, enrollmentId]
  );
  return res.rows;
}

/** How many touches each enrollment has queued, keyed by enrollment id. */
async function touchCounts(q, office, enrollmentIds) {
  /** @type {Map<string, number>} */
  const out = new Map();
  if (!enrollmentIds.length) return out;
  const res = await q.query(
    `SELECT enrollment_id FROM tc_messages WHERE office_id = $1 AND enrollment_id = ANY($2)`,
    [office, enrollmentIds]
  );
  for (const r of res.rows) out.set(r.enrollment_id, (out.get(r.enrollment_id) || 0) + 1);
  return out;
}

async function insertEnrollment(q, row) {
  await q.query(
    `INSERT INTO tc_nurture_enrollments (enrollment_id, case_id, office_id, track_key, intensity_at_enroll,
       status, stop_reason, next_touch_index, next_touch_due_at, last_touch_at, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      row.enrollment_id,
      row.case_id,
      row.office_id,
      row.track_key,
      row.intensity_at_enroll,
      row.status,
      row.stop_reason ?? null,
      row.next_touch_index,
      row.next_touch_due_at,
      row.last_touch_at ?? null,
      row.created_by,
      row.created_at,
      row.created_at,
    ]
  );
}

/**
 * Move an enrollment between statuses, conditional on where it is now — a
 * second click, or the generator racing a stop, matches nothing.
 * @returns {Promise<Record<string, any>|null>} the updated row, or null if it was not in `from`
 */
async function transition(q, office, enrollmentId, { from, to, stopReason = null, nextTouchDueAt }) {
  const res = await q.query(
    `UPDATE tc_nurture_enrollments SET status = $4, stop_reason = $5, next_touch_due_at = $6, updated_at = now()
      WHERE office_id = $1 AND enrollment_id = $2 AND status = ANY($3)
      RETURNING ${ENROLLMENT_COLS.join(', ')}`,
    [office, enrollmentId, from, to, stopReason, nextTouchDueAt]
  );
  return res.rows.length ? res.rows[0] : null;
}

/**
 * CLAIM a touch: advance the index, stamp the touch, set the next due date —
 * conditional on the enrollment still being active AND still pointing at
 * `expectIndex`. A TC's stop or pause landing mid-pass, or a second pass over
 * the same row, matches nothing, and the caller writes no draft.
 */
async function advance(q, office, enrollmentId, { expectIndex, nextIndex, lastTouchAt, nextTouchDueAt, status }) {
  const res = await q.query(
    `UPDATE tc_nurture_enrollments SET next_touch_index = $3, last_touch_at = $4, next_touch_due_at = $5,
       status = $6, updated_at = now()
      WHERE office_id = $1 AND enrollment_id = $2 AND status = 'active' AND next_touch_index = $7
      RETURNING ${ENROLLMENT_COLS.join(', ')}`,
    [office, enrollmentId, nextIndex, lastTouchAt, nextTouchDueAt, status, expectIndex]
  );
  return res.rows.length ? res.rows[0] : null;
}

/** A cap deferred the touch: only the due date moves. */
async function defer(q, office, enrollmentId, nextTouchDueAt) {
  await q.query(
    `UPDATE tc_nurture_enrollments SET next_touch_due_at = $3, updated_at = now()
      WHERE office_id = $1 AND enrollment_id = $2 AND status = 'active'`,
    [office, enrollmentId, nextTouchDueAt]
  );
}

/**
 * One tc_case_events row for a nurture lifecycle step. `detail` stays null:
 * TcCaseEventDetail is a closed union (contact_attempt, voice_handoff), and the
 * description carries what happened in words the timeline shows.
 */
async function insertEvent(q, { office, caseId, type, description, actor, ts }) {
  await caseStore.insertEventRow(q, {
    event_id: randomUUID(),
    case_id: caseId,
    office_id: office,
    ts: iso(ts) || new Date().toISOString(),
    type,
    description,
    actor,
    detail: null,
    legacy_id: null,
  });
}

/** "No-Show Recovery" — for event descriptions. Never PHI. */
function trackLabel(trackKey) {
  const t = cfg.TRACKS[trackKey];
  return t ? t.label : trackKey;
}

module.exports = {
  ENROLLMENT_COLS,
  SYSTEM_ACTOR,
  toEnrollment,
  loadEnrollment,
  listForCase,
  openForCase,
  listDue,
  touchesOf,
  touchCounts,
  insertEnrollment,
  transition,
  advance,
  defer,
  insertEvent,
  trackLabel,
};
