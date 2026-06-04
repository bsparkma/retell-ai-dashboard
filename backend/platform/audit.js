'use strict';

/**
 * Per-tenant HIPAA audit writer (Slice 6, COMPLY hard gate).
 *
 * `audit(req, {...})` writes ONE row to the calling tenant's append-only
 * audit_log (resolved from req.tenant.id via the tenant pool). It records the
 * acting user, source IP, action, resource type + ID, and result — and NEVER a
 * PHI value (callers pass resource IDs only).
 *
 * Fail-closed: a failed audit write throws (AuditError). Callers on a PHI path
 * must let that propagate so PHI is not served without a recorded trail.
 */

const tenantDb = require('./tenantDb');
const registry = require('./registry');
const { sanitizeUrlPath } = require('../utils/scrub');

/** @typedef {'READ'|'CREATE'|'UPDATE'|'DELETE'} AuditAction */
/** @typedef {'SUCCESS'|'UNAUTHORIZED'|'ERROR'} AuditResult */

class AuditError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AuditError';
  }
}

/**
 * Write one audit row to the tenant's append-only audit_log.
 *
 * @param {import('express').Request & { user?: any, tenant?: { id?: string } }} req
 * @param {{ action: AuditAction, resourceType: string, resourceId?: string|number|null, result: AuditResult, endpoint?: string }} entry
 * @returns {Promise<void>}
 */
async function audit(req, entry) {
  const tenantId = req && req.tenant && req.tenant.id;
  if (!tenantId) {
    // Without a tenant there is no per-tenant audit store to write to.
    throw new AuditError('cannot audit without req.tenant.id');
  }

  // Actor + source — NOT patient PHI.
  const userId = (req.user && (req.user.email || req.user.oid || req.user.sub)) || null;
  const ip = (req.ip || (req.socket && req.socket.remoteAddress)) || null;
  const endpoint =
    entry.endpoint ||
    (req.originalUrl ? sanitizeUrlPath(req.originalUrl) : req.path ? sanitizeUrlPath(req.path) : null);

  // resource_id is stringified; callers must pass an ID, never a PHI value.
  const resourceId = entry.resourceId != null ? String(entry.resourceId) : null;

  try {
    await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `INSERT INTO audit_log
            (user_id, tenant_id, action, resource_type, resource_id, ip, result, endpoint)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, tenantId, entry.action, entry.resourceType, resourceId, ip, entry.result, endpoint]
      )
    );
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error('[audit] write FAILED (fail-closed):', msg);
    throw new AuditError(`audit write failed: ${msg}`);
  }
}

/**
 * Startup readiness check (fail-closed). In production, verifies the per-tenant
 * audit store is reachable for every ACTIVE tenant; throws (aborting startup) if
 * any is unreachable. In non-production this is a no-op so local dev isn't
 * blocked on a provisioned audit store.
 * @returns {Promise<void>}
 */
async function assertReady() {
  if (process.env.NODE_ENV !== 'production') return;

  const tenants = await registry.listTenants();
  const active = tenants.filter((t) => t.status === 'active');
  for (const t of active) {
    const probeReq = { tenant: { id: t.tenant_id } };
    try {
      await tenantDb.withTenantDb(probeReq, (pool) => pool.query('SELECT 1 FROM audit_log LIMIT 1'));
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      throw new Error(
        `[audit] audit store unreachable for active tenant '${t.slug}' (${t.tenant_id}): ${msg}. ` +
          'Refusing to start — PHI must not be served without a working audit trail.'
      );
    }
  }
  console.log(`[audit] audit store reachable for ${active.length} active tenant(s)`);
}

module.exports = { audit, assertReady, AuditError };
