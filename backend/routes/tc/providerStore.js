'use strict';

/**
 * Provider directory data access. Every query is office-scoped; every column
 * is named (no SELECT *); every value is a parameter. There is no delete: the
 * app role holds no DELETE grant on this table (1792700000000).
 */

const { randomUUID } = require('node:crypto');

const { iso } = require('./helpers');

const COLS = [
  'provider_id',
  'office_id',
  'name',
  'credential_suffix',
  'active',
  'od_prov_num',
  'created_by',
  'created_at',
  'updated_by',
  'updated_at',
];

/** One row → the contract's TcProviderEntry. pg returns a bigint as a string. */
function toEntry(r) {
  const n = r.od_prov_num == null ? null : Number(r.od_prov_num);
  return {
    providerId: String(r.provider_id),
    officeId: r.office_id,
    name: r.name,
    credentialSuffix: r.credential_suffix ?? '',
    active: r.active === true,
    odProvNum: Number.isSafeInteger(n) && n > 0 ? n : null,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedBy: r.updated_by,
    updatedAt: iso(r.updated_at),
  };
}

/** The office's providers, A→Z. Inactive ones only when asked. */
async function listProviders(q, office, { includeInactive }) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_provider_directory
      WHERE office_id = $1${includeInactive ? '' : ' AND active = $2'}
      ORDER BY name ASC LIMIT 500`,
    includeInactive ? [office] : [office, true]
  );
  return res.rows;
}

async function findProvider(q, office, providerId) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_provider_directory WHERE office_id = $1 AND provider_id = $2`,
    [office, providerId]
  );
  return res.rows[0] || null;
}

/**
 * Insert, then READ IT BACK: what is reported is what persisted.
 * `odProvNum` only from an import; a hand-added row has none.
 */
async function insertProvider(q, office, { name, credentialSuffix, active, odProvNum = null }, actor) {
  const providerId = randomUUID();
  await q.query(
    `INSERT INTO tc_provider_directory (provider_id, office_id, name, credential_suffix, active, od_prov_num, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [providerId, office, name, credentialSuffix, active, odProvNum, actor, actor]
  );
  return findProvider(q, office, providerId);
}

/** Name, suffix and active (the Settings form); null when it is not this office's. */
async function updateProvider(q, office, providerId, { name, credentialSuffix, active }, actor) {
  const res = await q.query(
    `UPDATE tc_provider_directory SET name = $3, credential_suffix = $4, active = $5, updated_by = $6, updated_at = now()
      WHERE office_id = $1 AND provider_id = $2 RETURNING ${COLS.join(', ')}`,
    [office, providerId, name, credentialSuffix, active, actor]
  );
  return res.rows[0] || null;
}

/** An import's update: the name and suffix only — never `active`. */
async function updateProviderName(q, office, providerId, { name, credentialSuffix }, actor) {
  const res = await q.query(
    `UPDATE tc_provider_directory SET name = $3, credential_suffix = $4, updated_by = $5, updated_at = now()
      WHERE office_id = $1 AND provider_id = $2 RETURNING ${COLS.join(', ')}`,
    [office, providerId, name, credentialSuffix, actor]
  );
  return res.rows[0] || null;
}

module.exports = {
  COLS,
  toEntry,
  listProviders,
  findProvider,
  insertProvider,
  updateProvider,
  updateProviderName,
};
