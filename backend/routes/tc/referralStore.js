'use strict';

/**
 * Referrals data access (queue item 52, R1): the specialist directory and the
 * two per-office referral policies. Every query is office-scoped; every column
 * is named (no SELECT *); every value is a parameter.
 */

const { randomUUID } = require('node:crypto');

const { iso } = require('./helpers');

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
};
