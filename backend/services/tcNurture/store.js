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
const library = require('../tcEmailLibrary');

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
  'library_procedure_id',
  'library_variant',
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
 * THE schedule of one enrollment row, as [{ touch, day }] — the one place that
 * decides which kind it is, so the generator, the resume route and the entity
 * mapping can never disagree.
 *   hand-written  the frozen preset for its track at its intensity (item 47)
 *   library       (EL-2) the library sequence for its track, minus the stages
 *                 its procedure skips; `touch` is the library STAGE id. The
 *                 intensity dial does not apply: one cadence.
 * @param {{ track_key: string, intensity_at_enroll: string, library_procedure_id?: string|null }} r
 * @returns {ReadonlyArray<{ touch: string, day: number }>}
 */
function stepsOf(r) {
  if (r.library_procedure_id) {
    return library.sequenceFor(r.track_key, r.library_procedure_id).map((s) => ({ touch: s.stage, day: s.day }));
  }
  return cfg.schedule(r.track_key, r.intensity_at_enroll);
}

// ── EL-2c: a campaign's emails ──────────────────────────────────────────────

/** Message statuses that are still WAITING (nothing has happened to them yet). */
const WAITING_STATUSES = Object.freeze(['draft', 'scheduled']);
/** …plus 'sending': a send in flight. A campaign with any of these is not finished. */
const UNSETTLED_STATUSES = Object.freeze(['draft', 'scheduled', 'sending']);
/** Statuses that mean the message went out. */
const WENT_OUT_STATUSES = Object.freeze(['queued', 'sent', 'delivered']);

/** The tc_messages columns the nurture slice reads about a campaign's emails. No SELECT *. */
const CAMPAIGN_MESSAGE_COLS = [
  'message_id',
  'enrollment_id',
  'channel',
  'status',
  'touch_key',
  'scheduled_for',
  'sent_at',
  'created_at',
];

/**
 * Every message of these enrollments (any status), oldest first.
 * @param {{ query: Function }} q @param {string} office @param {string[]} enrollmentIds
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function messagesOfEnrollments(q, office, enrollmentIds) {
  if (!enrollmentIds.length) return [];
  const res = await q.query(
    `SELECT ${CAMPAIGN_MESSAGE_COLS.join(', ')} FROM tc_messages
      WHERE office_id = $1 AND enrollment_id = ANY($2) ORDER BY created_at`,
    [office, enrollmentIds]
  );
  return res.rows;
}

/** A Date from a timestamp column, or null. */
function dateOrNull(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The position of a message in its enrollment's sequence (by touch_key), or
 * -1 when it names no step of it.
 * @param {ReadonlyArray<{ touch: string }>} steps @param {string|null} touchKey
 */
function stepIndexOf(steps, touchKey) {
  return touchKey == null ? -1 : steps.findIndex((s) => s.touch === touchKey);
}

/**
 * The counts and the next waiting email of ONE enrollment, from its message
 * rows. `nextKey` is the stage of the first waiting email in sequence order.
 * @param {Record<string, any>} e the enrollment row
 * @param {Array<Record<string, any>>} rows its messages
 */
function campaignStats(e, rows) {
  const steps = stepsOf(e);
  let approved = 0;
  let sent = 0;
  let skipped = 0;
  /** @type {Date|null} */
  let nextSendAt = null;
  /** @type {{ index: number, key: string }|null} */
  let next = null;
  for (const m of rows) {
    if (m.status === 'scheduled') approved += 1;
    if (WENT_OUT_STATUSES.includes(m.status)) sent += 1;
    if (m.status === 'skipped') skipped += 1;
    if (WAITING_STATUSES.includes(m.status)) {
      const at = dateOrNull(m.scheduled_for);
      if (at && (!nextSendAt || at.getTime() < nextSendAt.getTime())) nextSendAt = at;
      const i = stepIndexOf(steps, m.touch_key);
      if (i >= 0 && (!next || i < next.index)) next = { index: i, key: m.touch_key };
    }
  }
  return { approved, sent, skipped, nextSendAt, nextKey: next ? next.key : null };
}

/**
 * DB row → contract entity. `touchCount` is how many touches it has queued.
 *
 * EL-2c: with `rows` (its tc_messages rows), the entity also carries the
 * approved / sent / skipped counts and the next planned send time; and for a
 * LIBRARY enrollment `nextTouchKey` is the stage of its next WAITING email —
 * a library campaign is written in full at Start, so "the next step to draft"
 * would always read as none.
 * @param {Record<string, any>} r
 * @param {number} touchCount
 * @param {Array<Record<string, any>>} [rows]
 */
function toEnrollment(r, touchCount, rows) {
  const steps = stepsOf(r);
  const index = Number(r.next_touch_index);
  const open = r.status === 'active' || r.status === 'paused';
  const stats = rows ? campaignStats(r, rows) : null;
  let nextTouchKey = index < steps.length && open ? steps[index].touch : null;
  if (r.library_procedure_id && stats && open && index >= steps.length) nextTouchKey = stats.nextKey;
  return contract.TcNurtureEnrollment.parse({
    enrollmentId: r.enrollment_id,
    caseId: r.case_id,
    officeId: r.office_id,
    trackKey: r.track_key,
    intensityAtEnroll: r.intensity_at_enroll,
    status: r.status,
    stopReason: r.stop_reason ?? null,
    nextTouchIndex: index,
    nextTouchDueAt: open ? iso(r.next_touch_due_at) : null,
    lastTouchAt: iso(r.last_touch_at),
    nextTouchKey,
    touchCount,
    createdBy: r.created_by ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    libraryProcedureId: r.library_procedure_id ?? null,
    libraryVariant: r.library_variant ?? null,
    stepCount: steps.length,
    approvedCount: stats ? stats.approved : 0,
    sentCount: stats ? stats.sent : 0,
    skippedCount: stats ? stats.skipped : 0,
    nextSendAt: stats && open && stats.nextSendAt ? stats.nextSendAt.toISOString() : null,
  });
}

/**
 * Rows → entities with their counts, in one read of their messages.
 * @param {{ query: Function }} q @param {string} office @param {Array<Record<string, any>>} rows
 */
async function toEnrollments(q, office, rows) {
  const msgs = await messagesOfEnrollments(
    q,
    office,
    rows.map((r) => r.enrollment_id)
  );
  return rows.map((r) => {
    const mine = msgs.filter((m) => m.enrollment_id === r.enrollment_id);
    return toEnrollment(r, mine.length, mine);
  });
}

/**
 * CANCEL WHAT IS WAITING (EL-2c): when an enrollment stops, for any reason,
 * every one of its 'draft' and 'scheduled' messages becomes 'skipped' with
 * `reason`, in the caller's transaction — a stopped campaign leaves nothing
 * behind that could still be sent (hand-written campaigns too). Conditional on
 * the status, so a message a person is sending right now ('sending') is left
 * to finish. Returns the ids it cancelled.
 * @param {{ query: Function }} q
 * @param {string} office
 * @param {string} enrollmentId
 * @param {{ reason: 'case_terminal'|'opted_out'|'stopped_by_user', actor: string }} input
 * @returns {Promise<string[]>}
 */
async function cancelWaiting(q, office, enrollmentId, { reason, actor }) {
  const res = await q.query(
    `UPDATE tc_messages SET status = 'skipped', skip_reason = $4, skipped_by = $5, skipped_at = now()
      WHERE office_id = $1 AND enrollment_id = $2 AND status = ANY($3)
      RETURNING message_id`,
    [office, enrollmentId, [...WAITING_STATUSES], reason, actor]
  );
  return res.rows.map((r) => r.message_id);
}

/** " — 3 waiting messages cancelled", or '' for none. For a stop event's description. */
function cancelledSuffix(n) {
  if (!n) return '';
  return ` — ${n} waiting ${n === 1 ? 'message' : 'messages'} cancelled`;
}

/**
 * EL-2c: a LIBRARY campaign is finished when every step is written and none of
 * its emails is still waiting or being sent (each was sent, skipped, or failed
 * — a failed send is terminal and never retried). Then it moves to
 * 'completed', with an event. Conditional on 'active', so a pause, a stop or a
 * second caller matches nothing. Returns whether it completed.
 * @param {{ query: Function }} q
 * @param {string} office
 * @param {string} enrollmentId
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<boolean>}
 */
async function completeIfFinished(q, office, enrollmentId, { now = new Date() } = {}) {
  const e = await loadEnrollment(q, office, enrollmentId);
  if (!e || e.status !== 'active' || !e.library_procedure_id) return false;
  if (Number(e.next_touch_index) < stepsOf(e).length) return false;
  const rows = await messagesOfEnrollments(q, office, [enrollmentId]);
  if (rows.some((m) => UNSETTLED_STATUSES.includes(m.status))) return false;
  const row = await transition(q, office, enrollmentId, {
    from: ['active'],
    to: 'completed',
    stopReason: null,
    nextTouchDueAt: null,
  });
  if (!row) return false;
  await insertEvent(q, {
    office,
    caseId: e.case_id,
    type: 'nurture_completed',
    description: `${trackLabel(e.track_key)} completed: every email was sent or skipped`,
    actor: SYSTEM_ACTOR,
    ts: now,
  });
  return true;
}

/** Active LIBRARY enrollments in this office (the nightly completion sweep). */
async function listActiveLibrary(q, office) {
  const res = await q.query(
    `SELECT ${ENROLLMENT_COLS.join(', ')} FROM tc_nurture_enrollments
      WHERE office_id = $1 AND status = 'active' AND library_procedure_id IS NOT NULL`,
    [office]
  );
  return res.rows;
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
       status, stop_reason, next_touch_index, next_touch_due_at, last_touch_at, created_by, created_at, updated_at,
     library_procedure_id, library_variant)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
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
      row.library_procedure_id ?? null,
      row.library_variant ?? null,
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

/**
 * "Crown, warm and personal" — the library procedure and tone of an
 * enrollment, for event descriptions. Wording choices, never PHI.
 * @param {string} procedureId @param {string} variant
 */
function libraryLabel(procedureId, variant) {
  const p = library.SOURCE.procedure_blocks.find((/** @type {any} */ b) => b.id === procedureId);
  const tone = library.SOURCE.variants[variant];
  return `${p ? p.name : procedureId}, ${tone ? String(tone).toLowerCase() : variant}`;
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
  stepsOf,
  libraryLabel,
  // EL-2c
  WAITING_STATUSES,
  UNSETTLED_STATUSES,
  WENT_OUT_STATUSES,
  CAMPAIGN_MESSAGE_COLS,
  messagesOfEnrollments,
  stepIndexOf,
  campaignStats,
  toEnrollments,
  cancelWaiting,
  cancelledSuffix,
  completeIfFinished,
  listActiveLibrary,
  dateOrNull,
};
