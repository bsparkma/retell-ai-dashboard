'use strict';

/**
 * Tenant-aware data-plane access (Slice 3).
 *
 * Each tenant has its OWN Postgres database (carein_t_<...>). This module hands
 * out a per-tenant pg Pool resolved entirely from the control-plane registry +
 * Key Vault — there is deliberately NO global/default pool. A connection can
 * only be obtained for a specific tenantId, and the request-scoped helper pulls
 * that id from req.tenant.id (server-resolved by tenantContext), never from
 * client input. This makes a cross-tenant query structurally impossible
 * (COMPLY gate, PHASE1_PRD_PLATFORM_SPINE.md).
 *
 * Connection resolution:
 *   registry.getTenantDbRef(tenantId).kv_conn_secret
 *     -> secrets.getSecretValue(secretName)
 *          dev:  process.env[<SECRET_NAME>]   (e.g. TENANT_CAREIN_DB_URL)
 *          prod: Key Vault secret by that name
 */

const registry = require('./registry');
const secrets = require('../config/secrets');

/**
 * Cached pools, one per tenantId. Never a shared/default entry.
 * @type {Map<string, import('pg').Pool>}
 */
const pools = new Map();

/**
 * In-flight pool creations, so concurrent callers for the same tenant share one
 * creation instead of racing to build duplicate pools.
 * @type {Map<string, Promise<import('pg').Pool>>}
 */
const creating = new Map();

/**
 * Get (or lazily create) the cached pg Pool for a specific tenant.
 *
 * `tenantId` MUST be a server-resolved id (req.tenant.id) or a value from a
 * trusted provisioning/migration context — NEVER a raw value from client input.
 * Prefer {@link withTenantDb} in request handlers so the id can only come from
 * the resolved tenant context.
 *
 * @param {string} tenantId
 * @returns {Promise<import('pg').Pool>}
 */
async function getTenantPool(tenantId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error(
      '[tenantDb] getTenantPool requires a resolved tenantId (req.tenant.id). ' +
        'Refusing to create a pool without an explicit tenant.'
    );
  }

  const existing = pools.get(tenantId);
  if (existing) return existing;

  const inFlight = creating.get(tenantId);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const ref = await registry.getTenantDbRef(tenantId);
    if (!ref) {
      throw new Error(
        `[tenantDb] no tenant_database row for tenant ${tenantId} — cannot resolve a data-plane DB.`
      );
    }

    const connectionString = await secrets.getSecretValue(ref.kv_conn_secret);
    if (!connectionString) {
      const envKey = secrets.secretNameToEnvKey(ref.kv_conn_secret);
      throw new Error(
        `[tenantDb] connection string for tenant ${tenantId} is not available ` +
          `(secret '${ref.kv_conn_secret}'). Dev: set ${envKey} in backend/.env; ` +
          `Prod: create the '${ref.kv_conn_secret}' secret in Key Vault.`
      );
    }

    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', (err) => {
      console.error(
        `[tenantDb] idle client error (tenant ${tenantId}):`,
        err && err.message ? err.message : err
      );
    });

    pools.set(tenantId, pool);
    return pool;
  })();

  creating.set(tenantId, promise);
  try {
    return await promise;
  } finally {
    creating.delete(tenantId);
  }
}

/**
 * Request-scoped data access. Pulls the tenant id from the resolved
 * `req.tenant.id` (set by tenantContext) and hands the callback the correct
 * per-tenant pool. Fails closed if tenant context is missing — a query can
 * never run without a resolved tenant.
 *
 * @template T
 * @param {import('express').Request & { tenant?: { id?: string } }} req
 * @param {(pool: import('pg').Pool) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTenantDb(req, fn) {
  const tenantId = req && req.tenant && req.tenant.id;
  if (!tenantId) {
    throw new Error(
      '[tenantDb] withTenantDb called without req.tenant.id — tenant context ' +
        'unresolved. Ensure tenantContext middleware ran and resolved a tenant.'
    );
  }
  const pool = await getTenantPool(tenantId);
  return fn(pool);
}

/**
 * Close all cached pools (graceful shutdown / tests).
 * @returns {Promise<void>}
 */
async function closeAll() {
  const all = Array.from(pools.values());
  pools.clear();
  await Promise.all(all.map((p) => p.end().catch(() => {})));
}

module.exports = { getTenantPool, withTenantDb, closeAll };
