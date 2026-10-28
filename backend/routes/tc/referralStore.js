'use strict';

/**
 * Referrals data access (queue item 52, R1): the specialist directory and the
 * two per-office referral policies. Every query is office-scoped; every column
 * is named (no SELECT *); every value is a parameter.
 */

const { randomUUID } = require('node:crypto');

const { iso, isoDate, contract } = require('./helpers');

const DIRECTORY_COLS = [
  'entry_id',
  'office_id',
  'practice_name',
  'specialist_name',
  'specialty',
  'contact_person',
  'email',
  'phone',
  'fax',
  'notes',
  'preferred_format_notes',
  'active',
  'created_by',
  'created_at',
  'updated_by',
  'updated_at',
];

/** The form's fields → their columns, in one place for INSERT and UPDATE. */
const INPUT_COLUMNS = [
  ['practiceName', 'practice_name'],
  ['specialistName', 'specialist_name'],
  ['specialty', 'specialty'],
  ['contactPerson', 'contact_person'],
  ['email', 'email'],
  ['phone', 'phone'],
  ['fax', 'fax'],
  ['notes', 'notes'],
  ['preferredFormatNotes', 'preferred_format_notes'],
  ['active', 'active'],
];

/** One row → the contract's TcReferralDirectoryEntry. */
function toEntry(r) {
  return {
    entryId: String(r.entry_id),
    officeId: r.office_id,
    practiceName: r.practice_name,
    specialistName: r.specialist_name ?? '',
    specialty: r.specialty ?? '',
    contactPerson: r.contact_person ?? '',
    email: r.email ?? '',
    phone: r.phone ?? '',
    fax: r.fax ?? '',
    notes: r.notes ?? '',
    preferredFormatNotes: r.preferred_format_notes ?? '',
    active: r.active === true,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedBy: r.updated_by,
    updatedAt: iso(r.updated_at),
  };
}

/** The office's directory, A→Z by practice. Inactive entries only when asked. */
async function listDirectory(q, office, { includeInactive }) {
  const res = await q.query(
    `SELECT ${DIRECTORY_COLS.join(', ')} FROM tc_referral_directory
      WHERE office_id = $1${includeInactive ? '' : ' AND active = $2'}
      ORDER BY practice_name ASC LIMIT 500`,
    includeInactive ? [office] : [office, true]
  );
  return res.rows;
}

async function findEntry(q, office, entryId) {
  const res = await q.query(
    `SELECT ${DIRECTORY_COLS.join(', ')} FROM tc_referral_directory WHERE office_id = $1 AND entry_id = $2`,
    [office, entryId]
  );
  return res.rows[0] || null;
}

/**
 * Insert, then READ IT BACK: what is reported is what persisted. The id is
 * minted here so the read-back can name it.
 */
async function insertEntry(q, office, input, actor) {
  const entryId = randomUUID();
  const cols = ['entry_id', 'office_id', ...INPUT_COLUMNS.map(([, c]) => c), 'created_by', 'updated_by'];
  const vals = [entryId, office, ...INPUT_COLUMNS.map(([k]) => input[k]), actor, actor];
  await q.query(
    `INSERT INTO tc_referral_directory (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals
  );
  return findEntry(q, office, entryId);
}

/** Full update of one entry; null when it is not this office's. */
async function updateEntry(q, office, entryId, input, actor) {
  const sets = INPUT_COLUMNS.map(([, c], i) => `${c} = $${i + 3}`);
  const res = await q.query(
    `UPDATE tc_referral_directory SET ${sets.join(', ')}, updated_by = $${INPUT_COLUMNS.length + 3}, updated_at = now() WHERE office_id = $1 AND entry_id = $2 RETURNING ${DIRECTORY_COLS.join(', ')}`,
    [office, entryId, ...INPUT_COLUMNS.map(([k]) => input[k]), actor]
  );
  return res.rows[0] || null;
}

/** Is this entry named on any referral? (A referenced entry is deactivated, not deleted.) */
async function entryInUse(q, office, entryId) {
  const res = await q.query(
    'SELECT referral_id FROM tc_referrals WHERE office_id = $1 AND directory_entry_id = $2 LIMIT 1',
    [office, entryId]
  );
  return res.rows.length > 0;
}

async function deleteEntry(q, office, entryId) {
  const res = await q.query(
    `DELETE FROM tc_referral_directory WHERE office_id = $1 AND entry_id = $2 RETURNING ${DIRECTORY_COLS.join(', ')}`,
    [office, entryId]
  );
  return res.rows[0] || null;
}

// ── The two policies ────────────────────────────────────────────────────────

/**
 * Each policy's DEFAULT and its SAFE value, and the env var that can pin it to
 * the safe value. Like config/tcOfficeSwitch.js, a safety override may only
 * push toward safe, never away from it:
 *
 *   REFERRAL_SIGNOFF_REQUIRED_<OFFICE>=true        pins sign-off ON
 *   REFERRAL_AUTOSEND_ON_APPROVAL_<OFFICE>=false   pins auto-send OFF
 *
 * Any other value of those vars is ignored. Then the office's stored choice,
 * then the default.
 */
const POLICIES = Object.freeze({
  signoffRequired: { column: 'signoff_required', defaultValue: true, safe: true, envPrefix: 'REFERRAL_SIGNOFF_REQUIRED_' },
  autosendOnApproval: {
    column: 'autosend_on_approval',
    defaultValue: false,
    safe: false,
    envPrefix: 'REFERRAL_AUTOSEND_ON_APPROVAL_',
  },
});

function envPins(policy, office) {
  const raw = process.env[policy.envPrefix + String(office).toUpperCase()];
  if (raw === undefined || raw === null) return false;
  return String(raw).trim().toLowerCase() === String(policy.safe);
}

async function readSettingsRow(q, office) {
  const res = await q.query(
    'SELECT office_id, signoff_required, autosend_on_approval, updated_by, updated_at FROM tc_referral_settings WHERE office_id = $1',
    [office]
  );
  return res.rows[0] || null;
}

/** What is in force for one office, and why. */
function resolvePolicies(office, row) {
  const out = {};
  for (const [key, policy] of Object.entries(POLICIES)) {
    if (envPins(policy, office)) out[key] = { value: policy.safe, source: 'env' };
    else if (row && typeof row[policy.column] === 'boolean') out[key] = { value: row[policy.column], source: 'office' };
    else out[key] = { value: policy.defaultValue, source: 'default' };
  }
  return out;
}

/** The effective policies for an office — what R2's transitions will consult. */
async function effectivePolicies(q, office) {
  return resolvePolicies(office, await readSettingsRow(q, office));
}

/**
 * (R5) Does this office email a referral the moment a doctor approves it?
 * The policy is read here and only here (the routes ask this, not the column).
 * Whether email is switched on at all is the caller's separate question.
 */
async function sendsOnApproval(q, office) {
  const policies = await effectivePolicies(q, office);
  return policies.autosendOnApproval.value === true;
}

/** Upsert the office's stored choice; returns the stored row. */
async function upsertSettings(q, office, next, actor) {
  const res = await q.query(
    `INSERT INTO tc_referral_settings (office_id, signoff_required, autosend_on_approval, updated_by) VALUES ($1, $2, $3, $4) ON CONFLICT (office_id) DO UPDATE SET signoff_required = EXCLUDED.signoff_required, autosend_on_approval = EXCLUDED.autosend_on_approval, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING office_id, signoff_required, autosend_on_approval, updated_by, updated_at`,
    [office, next.signoffRequired, next.autosendOnApproval, actor]
  );
  return res.rows[0] || null;
}

// ── R2 (item 53): referral records and their transitions ────────────────────

const REFERRAL_COLS = [
  'referral_id',
  'office_id',
  'od_patient_id',
  'patient_name',
  'tc_case_id',
  'source_kind',
  'source_ref',
  'referring_provider',
  'directory_entry_id',
  'specialty',
  'reason',
  'teeth',
  'urgency',
  'narrative',
  'status',
  'status_changed_at',
  'status_changed_by',
  'created_by',
  'created_at',
  'updated_at',
  // R6 (item 56, 1792000000000)
  'doctor_note',
  // R5b (1792500000000)
  'scheduled_date',
  // The reason in plain words, for the patient's email only (1792600000000)
  'patient_reason',
];

const EVENT_COLS = [
  'event_id',
  'office_id',
  'referral_id',
  'from_status',
  'to_status',
  'actor',
  'at',
  'note',
  'verb',
  // R6.9 (1793100000000): set only on a `correspondence` row.
  'correspondence_direction',
  'correspondence_party',
  'correspondence_channel',
];

/** jsonb teeth: pg returns the value; a fake may hold the JSON text. */
function teethOf(v) {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return [];
    }
  }
  return v ?? [];
}

/** One row → the contract's TcReferral. `practiceName` from the directory, for display. */
function toReferral(r, practiceName = null, events = undefined) {
  const out = {
    referralId: String(r.referral_id),
    officeId: r.office_id,
    odPatientId: Number(r.od_patient_id),
    patientName: r.patient_name,
    tcCaseId: r.tc_case_id ? String(r.tc_case_id) : null,
    sourceKind: r.source_kind,
    sourceRef: r.source_ref ?? '',
    referringProvider: r.referring_provider ?? '',
    directoryEntryId: r.directory_entry_id ? String(r.directory_entry_id) : null,
    practiceName,
    specialty: r.specialty ?? '',
    reason: r.reason ?? '',
    teeth: teethOf(r.teeth),
    urgency: r.urgency,
    narrative: r.narrative ?? '',
    status: r.status,
    statusChangedAt: iso(r.status_changed_at),
    statusChangedBy: r.status_changed_by,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    doctorNote: r.doctor_note ?? null,
    scheduledDate: isoDate(r.scheduled_date),
    patientReason: r.patient_reason ?? null,
  };
  if (events) {
    out.events = events;
    out.returned = contract.referralLastReturn(events);
    // R5: only an approved referral can be (re)sent, so only it carries one.
    out.sendProblem = r.status === 'approved' ? contract.referralLastSendProblem(events) : null;
  }
  return out;
}

function toEvent(e) {
  return {
    eventId: String(e.event_id),
    fromStatus: e.from_status ?? null,
    toStatus: e.to_status,
    actor: e.actor,
    at: iso(e.at),
    note: e.note ?? '',
    verb: e.verb ?? null,
    correspondence:
      e.verb === 'correspondence' && e.correspondence_direction && e.correspondence_party && e.correspondence_channel
        ? { direction: e.correspondence_direction, party: e.correspondence_party, channel: e.correspondence_channel }
        : null,
  };
}

async function findReferral(q, office, referralId) {
  const res = await q.query(
    `SELECT ${REFERRAL_COLS.join(', ')} FROM tc_referrals WHERE office_id = $1 AND referral_id = $2`,
    [office, referralId]
  );
  return res.rows[0] || null;
}

/**
 * The office's referrals, newest first, narrowed by any of: a case, a source
 * (kind + ref), a status. Every filter is a parameter.
 */
async function listReferrals(q, office, { caseId = null, sourceKind = null, sourceRef = null, status = null, oldestFirst = false } = {}) {
  const where = ['office_id = $1'];
  const values = [office];
  if (caseId) {
    values.push(caseId);
    where.push(`tc_case_id = $${values.length}`);
  }
  if (sourceKind) {
    values.push(sourceKind);
    where.push(`source_kind = $${values.length}`);
  }
  if (sourceRef) {
    values.push(sourceRef);
    where.push(`source_ref = $${values.length}`);
  }
  if (status) {
    values.push(status);
    where.push(`status = $${values.length}`);
  }
  const res = await q.query(
    `SELECT ${REFERRAL_COLS.join(', ')} FROM tc_referrals WHERE ${where.join(' AND ')} ORDER BY created_at ${oldestFirst ? 'ASC' : 'DESC'} LIMIT 200`,
    values
  );
  return res.rows;
}

/** practice_name for each directory entry id named by these rows (one query, no JOIN). */
async function practiceNames(q, office, rows) {
  const ids = [...new Set(rows.map((r) => r.directory_entry_id).filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();
  const res = await q.query(
    'SELECT entry_id, practice_name FROM tc_referral_directory WHERE office_id = $1 AND entry_id = ANY($2)',
    [office, ids]
  );
  return new Map(res.rows.map((r) => [String(r.entry_id), r.practice_name]));
}

async function listEvents(q, office, referralId) {
  const res = await q.query(
    `SELECT ${EVENT_COLS.join(', ')} FROM tc_referral_events WHERE office_id = $1 AND referral_id = $2 ORDER BY at ASC`,
    [office, referralId]
  );
  return res.rows.map(toEvent);
}

/** Insert a draft, then READ IT BACK. The id is minted here so the read can name it. */
async function insertReferral(q, f) {
  const referralId = randomUUID();
  const cols = [
    'referral_id',
    'office_id',
    'od_patient_id',
    'patient_name',
    'tc_case_id',
    'source_kind',
    'source_ref',
    'referring_provider',
    'directory_entry_id',
    'specialty',
    'reason',
    'teeth',
    'urgency',
    'narrative',
    'status',
    'status_changed_at',
    'status_changed_by',
    'created_by',
  ];
  const vals = [
    referralId,
    f.office,
    f.odPatientId,
    f.patientName,
    f.tcCaseId,
    f.sourceKind,
    f.sourceRef,
    f.input.referringProvider,
    f.input.directoryEntryId,
    f.input.specialty,
    f.input.reason,
    JSON.stringify(f.input.teeth),
    f.input.urgency,
    f.input.narrative,
    'draft',
    f.at,
    f.actor,
    f.actor,
  ];
  await q.query(
    `INSERT INTO tc_referrals (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals
  );
  return findReferral(q, f.office, referralId);
}

/** Edit a DRAFT's fields; null when it is not a draft (any more). */
async function updateDraft(q, office, referralId, input) {
  const res = await q.query(
    `UPDATE tc_referrals SET referring_provider = $4, directory_entry_id = $5, specialty = $6, reason = $7, teeth = $8, urgency = $9, narrative = $10, updated_at = now() WHERE office_id = $1 AND referral_id = $2 AND status = $3 RETURNING ${REFERRAL_COLS.join(', ')}`,
    [
      office,
      referralId,
      'draft',
      input.referringProvider,
      input.directoryEntryId,
      input.specialty,
      input.reason,
      JSON.stringify(input.teeth),
      input.urgency,
      input.narrative,
    ]
  );
  return res.rows[0] || null;
}

/**
 * Move a referral from `from` to `to`, CONDITIONAL on it still being `from`:
 * two people acting on one referral cannot both win. null = it was not `from`.
 */
async function casStatus(q, { office, referralId, from, to, actor, at }) {
  const res = await q.query(
    `UPDATE tc_referrals SET status = $4, status_changed_at = $5, status_changed_by = $6, updated_at = now() WHERE office_id = $1 AND referral_id = $2 AND status = $3 RETURNING ${REFERRAL_COLS.join(', ')}`,
    [office, referralId, from, to, at, actor]
  );
  return res.rows[0] || null;
}

async function insertEvent(q, { office, referralId, from, to, actor, at, note, verb = null }) {
  await q.query(
    `INSERT INTO tc_referral_events (event_id, office_id, referral_id, from_status, to_status, actor, at, note, verb) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), office, referralId, from, to, actor, at, note || '', verb]
  );
}

/**
 * R6.9: a correspondence row — staff's record of a contact outside the app.
 * The status does not move (from = to = `status`, which the caller read under
 * the row lock); the database pins that, the vocabulary and the note's length.
 */
async function insertCorrespondenceEvent(q, { office, referralId, status, actor, at, note, direction, party, channel }) {
  await q.query(
    'INSERT INTO tc_referral_events (event_id, office_id, referral_id, from_status, to_status, actor, at, note, verb, correspondence_direction, correspondence_party, correspondence_channel) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
    [randomUUID(), office, referralId, status, status, actor, at, note, 'correspondence', direction, party, channel]
  );
}

// ── R6 (item 56): field edits, the hub ──────────────────────────────────────

/** The fields the two R6 edit surfaces may change → their columns. */
const FIELD_COLUMNS = [
  ['directoryEntryId', 'directory_entry_id'],
  // Provider directory: a pick (its display name) or "Other" free text.
  ['referringProvider', 'referring_provider'],
  ['urgency', 'urgency'],
  ['reason', 'reason'],
  ['teeth', 'teeth'],
  ['doctorNote', 'doctor_note'],
  ['patientReason', 'patient_reason'],
];

/**
 * Change some of a referral's fields, CONDITIONAL on its status still being
 * `status` — an edit cannot race a transition (the loser of the race gets
 * null and a 409). Only the fields present in `fields` are written.
 */
async function updateFields(q, { office, referralId, status, fields }) {
  const sets = [];
  const values = [office, referralId, status];
  for (const [key, col] of FIELD_COLUMNS) {
    if (fields[key] === undefined) continue;
    values.push(key === 'teeth' ? JSON.stringify(fields[key]) : fields[key]);
    sets.push(`${col} = $${values.length}`);
  }
  if (sets.length === 0) throw new Error('updateFields: nothing to write');
  const res = await q.query(
    `UPDATE tc_referrals SET ${sets.join(', ')}, updated_at = now() WHERE office_id = $1 AND referral_id = $2 AND status = $3 RETURNING ${REFERRAL_COLS.join(', ')}`,
    values
  );
  return res.rows[0] || null;
}

/**
 * The hub: every referral for the office, newest status change first,
 * narrowed by any of status / specialist / source / "sat at least N days".
 * Every filter is a parameter. `before` is an ISO instant (now − N days).
 */
async function listHub(q, office, { status = null, directoryEntryId = null, sourceKind = null, before = null } = {}) {
  const where = ['office_id = $1'];
  const values = [office];
  if (status) {
    values.push(status);
    where.push(`status = $${values.length}`);
  }
  if (directoryEntryId) {
    values.push(directoryEntryId);
    where.push(`directory_entry_id = $${values.length}`);
  }
  if (sourceKind) {
    values.push(sourceKind);
    where.push(`source_kind = $${values.length}`);
  }
  if (before) {
    values.push(before);
    where.push(`status_changed_at <= $${values.length}`);
  }
  const res = await q.query(
    `SELECT ${REFERRAL_COLS.join(', ')} FROM tc_referrals WHERE ${where.join(' AND ')} ORDER BY status_changed_at DESC LIMIT 500`,
    values
  );
  return res.rows;
}

/** referral id → how many files it carries (one query, counted here; no GROUP BY). */
async function attachmentCounts(q, office, referralIds) {
  const ids = [...new Set(referralIds.map(String))];
  if (ids.length === 0) return new Map();
  const res = await q.query(
    'SELECT referral_id FROM tc_referral_attachments WHERE office_id = $1 AND referral_id = ANY($2)',
    [office, ids]
  );
  const out = new Map();
  for (const r of res.rows) out.set(String(r.referral_id), (out.get(String(r.referral_id)) || 0) + 1);
  return out;
}

/**
 * referral id → the doctor's open question, for the DRAFTS among `rows` (only
 * a draft can carry one). One query over their events, oldest first.
 */
async function openReturns(q, office, rows) {
  const ids = rows.filter((r) => r.status === 'draft').map((r) => String(r.referral_id));
  if (ids.length === 0) return new Map();
  const res = await q.query(
    `SELECT ${EVENT_COLS.join(', ')} FROM tc_referral_events WHERE office_id = $1 AND referral_id = ANY($2) ORDER BY at ASC`,
    [office, ids]
  );
  const byId = new Map();
  for (const e of res.rows) {
    const k = String(e.referral_id);
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(toEvent(e));
  }
  const out = new Map();
  for (const [k, events] of byId) {
    const ret = contract.referralLastReturn(events);
    if (ret) out.set(k, ret);
  }
  return out;
}

// ── R5: the email send ──────────────────────────────────────────────────────

/**
 * entry id → its email, for the directory entries these rows name, when the
 * stored value is usable (the directory's own rule). One query, no JOIN.
 */
async function directoryEmails(q, office, rows) {
  const ids = [...new Set(rows.map((r) => r.directory_entry_id).filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();
  const res = await q.query(
    'SELECT entry_id, email FROM tc_referral_directory WHERE office_id = $1 AND entry_id = ANY($2)',
    [office, ids]
  );
  const out = new Map();
  for (const r of res.rows) {
    const email = typeof r.email === 'string' ? r.email.trim() : '';
    if (email && contract.DIRECTORY_EMAIL_RE.test(email)) out.set(String(r.entry_id), email);
  }
  return out;
}

/**
 * referral id → its email trouble (failed / conflict), for the APPROVED
 * referrals among `rows`. One query over their events, oldest first.
 */
async function openSendProblems(q, office, rows) {
  const ids = rows.filter((r) => r.status === 'approved').map((r) => String(r.referral_id));
  if (ids.length === 0) return new Map();
  const res = await q.query(
    `SELECT ${EVENT_COLS.join(', ')} FROM tc_referral_events WHERE office_id = $1 AND referral_id = ANY($2) ORDER BY at ASC`,
    [office, ids]
  );
  const byId = new Map();
  for (const e of res.rows) {
    const k = String(e.referral_id);
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(toEvent(e));
  }
  const out = new Map();
  for (const [k, events] of byId) {
    const problem = contract.referralLastSendProblem(events);
    if (problem) out.set(k, problem);
  }
  return out;
}

/** The statuses a referral can have collected a response in: it has been sent. */
const RESPONDED_STATUSES = Object.freeze(['sent', 'acknowledged', 'patient_seen', 'closed']);

/**
 * referral id → { received, patientEmail, lastCorrespondence }:
 *   - for the rows that have been sent, the specialist's receipt and the
 *     patient email's outcome since the latest send (contract.referralResponses);
 *   - (R6.9) for every row, the latest correspondence staff logged
 *     (contract.referralLastCorrespondence) — it can be logged at any status
 *     but a draft, and a referral sent back to draft keeps what was logged.
 * Read only, ONE query over the rows' events, for the hub's and the case /
 * checkout lists' cards.
 */
async function responseSignals(q, office, rows) {
  const ids = rows.map((r) => String(r.referral_id));
  if (ids.length === 0) return new Map();
  const responded = new Set(rows.filter((r) => RESPONDED_STATUSES.includes(r.status)).map((r) => String(r.referral_id)));
  const res = await q.query(
    `SELECT ${EVENT_COLS.join(', ')} FROM tc_referral_events WHERE office_id = $1 AND referral_id = ANY($2) ORDER BY at ASC`,
    [office, ids]
  );
  const byId = new Map();
  for (const e of res.rows) {
    const k = String(e.referral_id);
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(toEvent(e));
  }
  const out = new Map();
  for (const [k, events] of byId) {
    const responses = responded.has(k) ? contract.referralResponses(events) : { received: null, patientEmail: null };
    out.set(k, { ...responses, lastCorrespondence: contract.referralLastCorrespondence(events) });
  }
  return out;
}

/**
 * Forget a claim older than `staleBefore` (an ISO instant): the request that
 * took it died without releasing it. A live send never runs that long.
 */
async function releaseStaleSendClaim(q, { office, referralId, staleBefore }) {
  const res = await q.query(
    'UPDATE tc_referrals SET send_attempt_id = $3, send_attempt_at = $4 WHERE office_id = $1 AND referral_id = $2 AND send_attempt_at < $5',
    [office, referralId, null, null, staleBefore]
  );
  return res.rowCount || 0;
}

/**
 * CLAIM the referral for one email attempt, conditional on it being approved
 * and unclaimed: of two clicks (or a click and an auto-send), exactly one
 * UPDATE matches. true = this attempt holds it.
 */
async function claimSend(q, { office, referralId, attemptId, at }) {
  const res = await q.query(
    'UPDATE tc_referrals SET send_attempt_id = $4, send_attempt_at = $5 WHERE office_id = $1 AND referral_id = $2 AND status = $3 AND send_attempt_id IS NULL RETURNING referral_id',
    [office, referralId, 'approved', attemptId, at]
  );
  return res.rows.length === 1;
}

/** Let go of THIS attempt's claim (a no-op if it is no longer ours). */
async function releaseSendClaim(q, { office, referralId, attemptId }) {
  await q.query(
    'UPDATE tc_referrals SET send_attempt_id = $4, send_attempt_at = $5 WHERE office_id = $1 AND referral_id = $2 AND send_attempt_id = $3',
    [office, referralId, attemptId, null, null]
  );
}

/**
 * approved → sent, and the claim released in the same statement, CONDITIONAL
 * on the referral still being approved AND still held by this attempt. null =
 * it moved (or lost the claim) while the email was going out.
 */
async function finishSend(q, { office, referralId, attemptId, to, actor, at }) {
  const res = await q.query(
    `UPDATE tc_referrals SET status = $5, status_changed_at = $6, status_changed_by = $7, send_attempt_id = $8, send_attempt_at = $9, updated_at = now() WHERE office_id = $1 AND referral_id = $2 AND status = $3 AND send_attempt_id = $4 RETURNING ${REFERRAL_COLS.join(', ')}`,
    [office, referralId, 'approved', attemptId, to, at, actor, null, null]
  );
  return res.rows[0] || null;
}

/**
 * A history row for an email: `send` and `send_conflict` carry which email
 * (ACS id), to whom, and its unsubscribe link's hash; `send_failed` carries
 * none of them (the database pins this).
 */
async function insertSendEvent(
  q,
  { office, referralId, from, to, actor, at, note, verb, acsMessageId = null, recipientAddress = null, unsubscribeTokenHash = null }
) {
  await q.query(
    'INSERT INTO tc_referral_events (event_id, office_id, referral_id, from_status, to_status, actor, at, note, verb, acs_message_id, recipient_address, unsubscribe_token_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
    [randomUUID(), office, referralId, from, to, actor, at, note || '', verb, acsMessageId, recipientAddress, unsubscribeTokenHash]
  );
}

// ── R5b: the links in a sent email ──────────────────────────────────────────

const LINK_TOKEN_COLS = ['token_hash', 'office_id', 'referral_id', 'audience', 'purpose', 'created_at', 'expires_at', 'used_at'];

/**
 * Store the links of ONE sent email, by hash only (the tokens are in the
 * email and nowhere else). Called inside the transaction that records the
 * email, so a link exists exactly when its email is on the record.
 * @param {{ query: Function }} q
 * @param {{ office: string, referralId: string, audience: 'specialist'|'patient',
 *           links: Array<{ hash: string, purpose: 'received'|'scheduled' }>, at: string, expiresAt: string }} input
 */
async function insertLinkTokens(q, { office, referralId, audience, links, at, expiresAt }) {
  for (const link of links) {
    await q.query(
      'INSERT INTO tc_referral_link_tokens (token_hash, office_id, referral_id, audience, purpose, created_at, expires_at, used_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [link.hash, office, referralId, audience, link.purpose, at, expiresAt, null]
    );
  }
}

/** The token row for a hash, whatever its state, or null. */
async function findLinkToken(q, hash) {
  const res = await q.query(`SELECT ${LINK_TOKEN_COLS.join(', ')} FROM tc_referral_link_tokens WHERE token_hash = $1`, [hash]);
  return res.rows.length === 1 ? res.rows[0] : null;
}

/**
 * USE a token: conditional on it being unused and unexpired at `at`. Of two
 * clicks exactly one UPDATE matches. null = unknown, used or expired (the
 * caller cannot tell which, and does not need to).
 */
async function consumeLinkToken(q, { hash, at }) {
  const res = await q.query(
    `UPDATE tc_referral_link_tokens SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $3 RETURNING ${LINK_TOKEN_COLS.join(', ')}`,
    [hash, at, at]
  );
  return res.rows.length === 1 ? res.rows[0] : null;
}

/** Record the appointment date someone gave from a link ('YYYY-MM-DD'). */
async function setScheduledDate(q, { office, referralId, date }) {
  await q.query('UPDATE tc_referrals SET scheduled_date = $3, updated_at = now() WHERE office_id = $1 AND referral_id = $2', [
    office,
    referralId,
    date,
  ]);
}

module.exports = {
  insertLinkTokens,
  findLinkToken,
  consumeLinkToken,
  setScheduledDate,
  DIRECTORY_COLS,
  POLICIES,
  sendsOnApproval,
  directoryEmails,
  openSendProblems,
  responseSignals,
  releaseStaleSendClaim,
  claimSend,
  releaseSendClaim,
  finishSend,
  insertSendEvent,
  toEntry,
  listDirectory,
  findEntry,
  insertEntry,
  updateEntry,
  entryInUse,
  deleteEntry,
  readSettingsRow,
  resolvePolicies,
  effectivePolicies,
  upsertSettings,
  REFERRAL_COLS,
  EVENT_COLS,
  toReferral,
  findReferral,
  listReferrals,
  practiceNames,
  listEvents,
  insertReferral,
  updateDraft,
  casStatus,
  insertEvent,
  insertCorrespondenceEvent,
  FIELD_COLUMNS,
  updateFields,
  listHub,
  attachmentCounts,
  openReturns,
};
