'use strict';

/**
 * Per-tenant transaction helper for the TC routes.
 *
 * withTenantDb hands out the tenant's pg Pool; multi-row writes (case + child
 * rows, phase-tree replacement, hygiene submit) must be atomic, so this wraps
 * a dedicated client in BEGIN/COMMIT with a guaranteed ROLLBACK + release on
 * failure. Kept local to routes/tc (not platform/) so the parallel Slice 2
 * branch doesn't collide on platform files.
 */

const tenantDb = require('../../platform/tenantDb');

/**
 * Run `fn(client)` inside a transaction on the calling tenant's database.
 * @template T
 * @param {import('express').Request} req
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTenantTx(req, fn) {
  return tenantDb.withTenantDb(req, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[tc/tx] rollback failed:', rollbackErr && rollbackErr.message);
      }
      throw err;
    } finally {
      client.release();
    }
  });
}

module.exports = { withTenantTx };
