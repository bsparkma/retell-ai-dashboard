'use strict';

/**
 * tc_checkout_handoffs — reads and writes (queue item 49).
 *
 * Explicit columns, parameterized, office in every WHERE. No Open Dental
 * anywhere: a handoff is a snapshot the hygiene module sent.
 */

const { iso, num, isoDate } = require('./helpers');

const COLS = [
  'handoff_id',
  'office_id',
  'source_key',
  'od_patient_id',
  'patient_name',
  'provider',
  'provider_seen',
  'operatory',
  'visit_date',
  'payload',
  'is_final',
  'revision',
  'submitted_by',
  'updated_by',
  'created_at',
  'updated_at',
];

/** Postgres's unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

/** A jsonb cell as an object (pg returns objects; a fake may store strings). */
function obj(v) {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}

/** One row → the contract's TcCheckoutHandoff. */
function toHandoff(row) {
  return {
    handoffId: String(row.handoff_id),
    officeId: row.office_id,
    odPatientId: num(row.od_patient_id),
    patientName: row.patient_name,
    provider: row.provider ?? '',
    providerSeen: row.provider_seen ?? '',
    operatory: row.operatory ?? '',
    visitDate: isoDate(row.visit_date),
    snapshot: obj(row.payload),
    final: row.is_final === true,
    revision: Number(row.revision),
    submittedBy: row.submitted_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** The handoff for one source key in one office, or null. */
async function findBySourceKey(q, office, sourceKey) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_checkout_handoffs WHERE office_id = $1 AND source_key = $2`,
    [office, sourceKey]
  );
  return res.rows[0] || null;
}

/** Insert a new handoff. Throws the pg error on a duplicate key (23505). */
async function insertHandoff(q, row) {
  const cols = [
    'handoff_id',
    'office_id',
    'source_key',
    'od_patient_id',
    'patient_name',
    'provider',
    'provider_seen',
    'operatory',
    'visit_date',
    'payload',
    'is_final',
    'revision',
    'submitted_by',
    'updated_by',
  ];
  const placeholders = cols.map((c, i) => (c === 'payload' ? `$${i + 1}::jsonb` : `$${i + 1}`));
  await q.query(
    `INSERT INTO tc_checkout_handoffs (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    cols.map((c) => (c === 'payload' ? JSON.stringify(row[c]) : row[c]))
  );
}

/**
 * Replace a handoff's snapshot — conditional on the revision the caller read,
 * so two racing updates cannot both apply (the loser sees rowCount 0).
 *
 * @returns {Promise<boolean>} whether THIS call's update applied
 */
async function updatePayload(q, { office, handoffId, expectRevision, row }) {
  const res = await q.query(
    `UPDATE tc_checkout_handoffs
        SET payload = $3::jsonb, is_final = $4, revision = $5, patient_name = $6,
            provider = $7, provider_seen = $8, operatory = $9, updated_by = $10,
            updated_at = now()
      WHERE office_id = $1 AND handoff_id = $2 AND revision = $11`,
    [
      office,
      handoffId,
      JSON.stringify(row.payload),
      row.is_final,
      expectRevision + 1,
      row.patient_name,
      row.provider,
      row.provider_seen,
      row.operatory,
      row.updated_by,
      expectRevision,
    ]
  );
  return res.rowCount === 1;
}

module.exports = {
  COLS,
  PG_UNIQUE_VIOLATION,
  toHandoff,
  findBySourceKey,
  insertHandoff,
  updatePayload,
};
