'use strict';

/**
 * Control-plane registry data access (carein_control).
 *
 * Read layer over the tenant catalog. A lazily-created singleton pg Pool is
 * connected from CONTROL_DB_URL, resolved through the existing secrets loader
 * (Key Vault in prod, .env in dev) — identical to the rest of the backend.
 *
 * This module returns config + IDs + Key Vault secret NAMES only. It never
 * fetches or returns secret VALUES; resolving an actual connection string or OD
 * key from a secret name happens elsewhere (Slice 3 data layer), at request
 * time, against Key Vault.
 *
 * All queries name their columns explicitly (no SELECT *) and are parameterized.
 */

const { loadSecrets } = require('../config/secrets');

/**
 * @typedef {Object} Tenant
 * @property {string} tenant_id
 * @property {string} slug
 * @property {string} display_name
 * @property {string} status
 * @property {Date}   created_at
 */

/**
 * @typedef {Object} TenantConnector
 * @property {string} tenant_id
 * @property {'api'|'agent'} od_primary_mode
 * @property {string|null} od_api_base
 * @property {string|null} kv_od_dev_key      Key Vault secret NAME (OD developer key)
 * @property {string|null} kv_od_cust_key     Key Vault secret NAME (OD customer key)
 * @property {string|null} connector_url      On-prem CareIN connector base URL
 * @property {string|null} kv_connector_key   Key Vault secret NAME (connector API key)
 */

/**
 * @typedef {Object} TenantClinic
 * @property {string} tenant_id
 * @property {number} clinic_num
 * @property {string} name
 */

/**
 * @typedef {Object} TenantDbRef
 * @property {string} tenant_id
 * @property {string} kv_conn_secret  Key Vault secret NAME holding the per-tenant DB conn string
 * @property {string} db_name
 */

/**
 * @typedef {Object} AppUser
 * @property {string} user_id
 * @property {string} tenant_id
 * @property {string} email
 * @property {string} role            'admin' | 'office' | 'tc' | 'hygiene' (legacy rows may say 'staff')
 * @property {string} status          'active' | 'disabled'
 * @property {Date|null} last_login_at
 */

/**
 * @typedef {Object} PlatformAdmin
 * @property {string} email           lowercased
 * @property {string} status          'active' | 'disabled'
 * @property {Date}   created_at
 */

/** @type {import('pg').Pool | null} */
let pool = null;
/** @type {Promise<import('pg').Pool> | null} */
let poolInit = null;

/**
 * Get (or lazily create) the singleton pool to carein_control.
 * @returns {Promise<import('pg').Pool>}
 */
async function getPool() {
  if (pool) return pool;
  if (poolInit) return poolInit;

  poolInit = (async () => {
    // No-op in dev; in prod this populates process.env.CONTROL_DB_URL from
    // Key Vault. Safe to call repeatedly (guarded by a one-shot flag inside).
    await loadSecrets();

    const connectionString = process.env.CONTROL_DB_URL;
    if (!connectionString) {
      throw new Error(
        '[registry] CONTROL_DB_URL is not set — cannot reach carein_control. ' +
          "Set it in backend/.env (dev) or create the 'control-db-url' Key Vault secret (prod)."
      );
    }

    const { Pool } = require('pg');
    const created = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    // Don't let an idle-client error crash the process.
    created.on('error', (err) => {
      console.error('[registry] idle pool client error:', err && err.message ? err.message : err);
    });

    pool = created;
    return created;
  })();

  try {
    return await poolInit;
  } finally {
    poolInit = null;
  }
}

/**
 * Run a parameterized query against carein_control.
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<import('pg').QueryResult<any>>}
 */
async function query(text, params = []) {
  const p = await getPool();
  return p.query(text, params);
}

/**
 * Look up a tenant by its slug.
 * @param {string} slug
 * @returns {Promise<Tenant|null>}
 */
async function getTenantBySlug(slug) {
  const { rows } = await query(
    `SELECT tenant_id, slug, display_name, status, created_at
       FROM tenant
      WHERE slug = $1`,
    [slug]
  );
  return rows[0] || null;
}

/**
 * List all tenants (id + slug + status), ordered by slug. Used by provisioning
 * and the per-tenant migration runner's `--all` loop.
 * @returns {Promise<Array<{ tenant_id: string, slug: string, status: string }>>}
 */
async function listTenants() {
  const { rows } = await query(
    `SELECT tenant_id, slug, status
       FROM tenant
      ORDER BY slug`
  );
  return rows;
}

/**
 * Look up a tenant by id.
 * @param {string} tenantId
 * @returns {Promise<Tenant|null>}
 */
async function getTenantById(tenantId) {
  const { rows } = await query(
    `SELECT tenant_id, slug, display_name, status, created_at
       FROM tenant
      WHERE tenant_id = $1`,
    [tenantId]
  );
  return rows[0] || null;
}

/**
 * Get a tenant's OD connector routing config (secret NAMES, not values).
 * @param {string} tenantId
 * @returns {Promise<TenantConnector|null>}
 */
async function getTenantConnector(tenantId) {
  const { rows } = await query(
    `SELECT tenant_id, od_primary_mode, od_api_base,
            kv_od_dev_key, kv_od_cust_key, connector_url, kv_connector_key
       FROM tenant_connector
      WHERE tenant_id = $1`,
    [tenantId]
  );
  return rows[0] || null;
}

/**
 * List a tenant's clinics (OD ClinicNum + name), ordered by clinic_num.
 * @param {string} tenantId
 * @returns {Promise<TenantClinic[]>}
 */
async function getTenantClinics(tenantId) {
  const { rows } = await query(
    `SELECT tenant_id, clinic_num, name
       FROM tenant_clinic
      WHERE tenant_id = $1
      ORDER BY clinic_num`,
    [tenantId]
  );
  return rows;
}

/**
 * Get the list of enabled module names for a tenant.
 * @param {string} tenantId
 * @returns {Promise<string[]>}
 */
async function getEnabledModules(tenantId) {
  const { rows } = await query(
    `SELECT module
       FROM tenant_module
      WHERE tenant_id = $1 AND enabled = true
      ORDER BY module`,
    [tenantId]
  );
  return rows.map((r) => r.module);
}

/**
 * Get the per-tenant app DB reference (KV secret NAME + db name).
 * @param {string} tenantId
 * @returns {Promise<TenantDbRef|null>}
 */
async function getTenantDbRef(tenantId) {
  const { rows } = await query(
    `SELECT tenant_id, kv_conn_secret, db_name
       FROM tenant_database
      WHERE tenant_id = $1`,
    [tenantId]
  );
  return rows[0] || null;
}

/**
 * Look up an app user by email (case-insensitive).
 *
 * NOTE: email is unique only WITHIN a tenant. While CareIN is the only tenant
 * this is unambiguous; the multi-tenant disambiguation (which tenant a shared
 * email belongs to) is handled by the tenant-context middleware in a later
 * slice. Returns the first match.
 * @param {string} email
 * @returns {Promise<AppUser|null>}
 */
async function getUserByEmail(email) {
  const { rows } = await query(
    `SELECT user_id, tenant_id, email, role, status, last_login_at
       FROM app_user
      WHERE lower(email) = lower($1)
      LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

// --- platform tier (super_admin) --------------------------------------------

/**
 * Look up a platform admin by email (case-insensitive; the column is stored
 * lowercased and CHECK-constrained to stay that way).
 *
 * Returns the row whatever its status — callers decide what 'disabled' means.
 * The one caller that grants authority (tenantContext) requires status
 * 'active' explicitly, so a disabled row can never read as a super_admin by
 * omission.
 * @param {string} email
 * @returns {Promise<PlatformAdmin|null>}
 */
async function getPlatformAdminByEmail(email) {
  const { rows } = await query(
    `SELECT email, status, created_at
       FROM platform_admin
      WHERE email = lower($1)
      LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

/**
 * List every platform admin, ordered by email.
 * @returns {Promise<PlatformAdmin[]>}
 */
async function listPlatformAdmins() {
  const { rows } = await query(
    `SELECT email, status, created_at
       FROM platform_admin
      ORDER BY email`
  );
  return rows;
}

/**
 * Grant super_admin. Idempotent; re-granting a disabled admin re-activates it.
 * @param {string} email
 * @returns {Promise<PlatformAdmin>}
 */
async function addPlatformAdmin(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('[registry] addPlatformAdmin: email is required');
  const { rows } = await query(
    `INSERT INTO platform_admin (email, status)
          VALUES ($1, 'active')
     ON CONFLICT (email) DO UPDATE SET status = 'active'
       RETURNING email, status, created_at`,
    [normalized]
  );
  return rows[0];
}

/**
 * THE LAST-SUPER-ADMIN RULE, enforced here rather than in a route.
 *
 * The last remaining ACTIVE super_admin can never be disabled or removed —
 * doing so would lock every human out of the platform tier with no in-app way
 * back. No mutation endpoint ships in PR A, but the rule lives at the
 * data-access layer on purpose: PR C's platform console, a migration, and an
 * ops one-liner all go through these functions, and none of them can forget a
 * check they cannot reach around.
 *
 * Both statements are single UPDATE/DELETEs whose WHERE clause contains the
 * count subquery, so the check and the write are atomic — two concurrent
 * "remove the other one" calls cannot both succeed.
 *
 * @param {string} email
 * @returns {Promise<boolean>} true if the row changed; false if it did not exist
 * @throws {Error} if the write would leave zero active super_admins
 */
async function setPlatformAdminDisabled(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const { rows } = await query(
    `UPDATE platform_admin
        SET status = 'disabled'
      WHERE email = $1
        AND status = 'active'
        AND (SELECT count(*) FROM platform_admin WHERE status = 'active') > 1
      RETURNING email`,
    [normalized]
  );
  if (rows.length > 0) return true;
  return assertNotLastActiveAdmin(normalized, 'disable');
}

/**
 * Revoke super_admin entirely. Subject to the same last-admin rule.
 * @param {string} email
 * @returns {Promise<boolean>} true if a row was deleted; false if none existed
 * @throws {Error} if the delete would leave zero active super_admins
 */
async function removePlatformAdmin(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const { rows } = await query(
    `DELETE FROM platform_admin
      WHERE email = $1
        AND (status <> 'active'
             OR (SELECT count(*) FROM platform_admin WHERE status = 'active') > 1)
      RETURNING email`,
    [normalized]
  );
  if (rows.length > 0) return true;
  return assertNotLastActiveAdmin(normalized, 'remove');
}

/**
 * Shared no-op-vs-refusal disambiguation for the two guarded writes above.
 * The write's WHERE clause already refused; this decides which of the two
 * reasons it was, so the caller gets a truthful answer instead of a silent
 * false. Never invent a third outcome: either the row was absent (false) or
 * the last-admin rule fired (throw).
 * @param {string} normalizedEmail
 * @param {'disable'|'remove'} verb
 * @returns {Promise<false>}
 */
async function assertNotLastActiveAdmin(normalizedEmail, verb) {
  const existing = await getPlatformAdminByEmail(normalizedEmail);
  if (!existing) return false;
  if (existing.status !== 'active') return false; // already disabled — nothing to do
  throw new Error(
    `[registry] refusing to ${verb} ${normalizedEmail}: it is the last active super_admin. ` +
      'Grant super_admin to another account first.'
  );
}

/**
 * Stamp app_user.last_login_at. Best-effort by contract: the caller treats a
 * rejection as "not stamped this window" and serves the request anyway — a
 * bookkeeping column must never be able to fail a sign-in.
 * @param {string} userId
 * @param {Date} [at]
 * @returns {Promise<void>}
 */
async function touchUserLogin(userId, at = new Date()) {
  await query(`UPDATE app_user SET last_login_at = $2 WHERE user_id = $1`, [userId, at]);
}

/**
 * @typedef {Object} TenantSpec
 * @property {string} slug
 * @property {string} displayName
 * @property {string} status                       active|suspended|provisioning
 * @property {'api'|'agent'} odMode
 * @property {string|null} odApiBase
 * @property {string|null} connectorUrl            null if not yet known (pending)
 * @property {string} kvOdDevKey                   Key Vault secret NAME (OD developer key)
 * @property {string} kvOdCustKey                  Key Vault secret NAME (OD customer key)
 * @property {string} kvConnectorKey               Key Vault secret NAME (connector API key)
 * @property {string} kvDbSecret                   Key Vault secret NAME (per-tenant DB conn string)
 * @property {string} dbName                       per-tenant database name
 * @property {Array<{clinic_num:number, name:string}>} clinics
 * @property {Array<{module:string, enabled:boolean}>} modules
 */

/**
 * Idempotently create (or update) all control-plane rows for a tenant in one
 * transaction: tenant + tenant_database + tenant_connector + tenant_clinic(s) +
 * tenant_module(s). Stores Key Vault secret NAMES only — never values. Safe to
 * re-run (upserts by primary key / unique slug).
 * @param {TenantSpec} spec
 * @returns {Promise<Tenant>} the tenant row (with tenant_id)
 */
async function createTenant(spec) {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tenantRes = await client.query(
      `INSERT INTO tenant (slug, display_name, status)
            VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE
            SET display_name = EXCLUDED.display_name,
                status = EXCLUDED.status
       RETURNING tenant_id, slug, display_name, status, created_at`,
      [spec.slug, spec.displayName, spec.status]
    );
    const tenant = tenantRes.rows[0];
    const id = tenant.tenant_id;

    await client.query(
      `INSERT INTO tenant_database (tenant_id, kv_conn_secret, db_name)
            VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE
            SET kv_conn_secret = EXCLUDED.kv_conn_secret,
                db_name = EXCLUDED.db_name`,
      [id, spec.kvDbSecret, spec.dbName]
    );

    await client.query(
      `INSERT INTO tenant_connector
              (tenant_id, od_primary_mode, od_api_base, kv_od_dev_key,
               kv_od_cust_key, connector_url, kv_connector_key)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id) DO UPDATE
            SET od_primary_mode = EXCLUDED.od_primary_mode,
                od_api_base = EXCLUDED.od_api_base,
                kv_od_dev_key = EXCLUDED.kv_od_dev_key,
                kv_od_cust_key = EXCLUDED.kv_od_cust_key,
                connector_url = EXCLUDED.connector_url,
                kv_connector_key = EXCLUDED.kv_connector_key`,
      [id, spec.odMode, spec.odApiBase, spec.kvOdDevKey, spec.kvOdCustKey, spec.connectorUrl, spec.kvConnectorKey]
    );

    for (const c of spec.clinics) {
      await client.query(
        `INSERT INTO tenant_clinic (tenant_id, clinic_num, name)
              VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, clinic_num) DO UPDATE
              SET name = EXCLUDED.name`,
        [id, c.clinic_num, c.name]
      );
    }

    for (const m of spec.modules) {
      await client.query(
        `INSERT INTO tenant_module (tenant_id, module, enabled)
              VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, module) DO UPDATE
              SET enabled = EXCLUDED.enabled`,
        [id, m.module, m.enabled]
      );
    }

    await client.query('COMMIT');
    return tenant;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Close the pool (graceful shutdown / tests).
 * @returns {Promise<void>}
 */
async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = {
  getTenantBySlug,
  getTenantById,
  listTenants,
  createTenant,
  getTenantConnector,
  getTenantClinics,
  getEnabledModules,
  getTenantDbRef,
  getUserByEmail,
  getPlatformAdminByEmail,
  listPlatformAdmins,
  addPlatformAdmin,
  setPlatformAdminDisabled,
  removePlatformAdmin,
  touchUserLogin,
  close,
};
