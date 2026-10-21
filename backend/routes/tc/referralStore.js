'use strict';

/**
 * Referrals data access (queue item 52, R1): the specialist directory and the
 * two per-office referral policies. Every query is office-scoped; every column
 * is named (no SELECT *); every value is a parameter.
 */

const { randomUUID } = require('node:crypto');

const { iso, contract } = require('./helpers');

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
];

const EVENT_COLS = ['event_id', 'office_id', 'referral_id', 'from_status', 'to_status', 'actor', 'at', 'note', 'verb'];

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
  };
  if (events) {
    out.events = events;
    out.returned = contract.referralLastReturn(events);
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

// ── R6 (item 56): field edits, the hub ──────────────────────────────────────

/** The fields the two R6 edit surfaces may change → their columns. */
const FIELD_COLUMNS = [
  ['directoryEntryId', 'directory_entry_id'],
  ['urgency', 'urgency'],
  ['reason', 'reason'],
  ['teeth', 'teeth'],
  ['doctorNote', 'doctor_note'],
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

module.exports = {
  DIRECTORY_COLS,
  POLICIES,
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
  FIELD_COLUMNS,
  updateFields,
  listHub,
  attachmentCounts,
  openReturns,
};
