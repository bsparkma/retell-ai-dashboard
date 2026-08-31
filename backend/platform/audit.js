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
 * @param {{ action: AuditAction, resourceType: string, resourceId?: string|number|null,
 *           result: AuditResult, endpoint?: string, office?: string|null,
 *           originOffice?: string|null, sourceRef?: string|null,
 *           priorState?: string|null }} entry
 *   `office` is the frozen internal office key ('roland' | 'valley' | 'unknown')
 *   the action touched. Required in spirit on any Open Dental path once a tenant
 *   has more than one connected practice: PatNum numbering restarts per database,
 *   so resource_id alone does not identify a patient. Never a display name, never
 *   PHI. Omitted → NULL, meaning "not an office-scoped action".
 *
 *   `originOffice` is the office the ACTION CAME FROM, when that can differ from
 *   the office it touched — today, a chart write aimed at one practice from a
 *   call that rang at the other. `office` stays "whose chart", `originOffice` is
 *   "whose call", and a cross-office action is the two disagreeing. Same class of
 *   value as `office`: a frozen key, never a display name, never PHI. Omitted →
 *   NULL, meaning "the action had no origin distinct from what it touched".
 *
 *   `sourceRef` is the external identifier that CAUSED the action, when the cause
 *   lives outside the audited resource — today, the voice call id behind a TC
 *   handoff. An identifier, never a PHI value, same class as resource_id.
 *   Omitted → NULL, meaning "the action had no recorded external cause".
 *
 *   `priorState` is what the thing this action touched WAS immediately before
 *   it — for actions that REPLACE a decision somebody already made. A SLUG from
 *   that thing's own closed vocabulary, shaped `slug` or `slug:slug`, and the
 *   database refuses anything else (`audit_log_prior_state_check`,
 *   1788000000000). That CHECK is the safety argument, not a formality: this
 *   platform never copies free text a person typed into the trail, and a column
 *   that could hold a sentence would become that copy within two slices. Never
 *   prose, never a person's words, never PHI. Omitted → NULL, meaning "this
 *   action replaced nothing".
 * @returns {Promise<void>}
 */
async function audit(req, entry) {
  const tenantId = req && req.tenant && req.tenant.id;
  if (!tenantId) {
    // Without a tenant there is no per-tenant audit store to write to.
    throw new AuditError('cannot audit without req.tenant.id');
  }
  // Still routed through withTenantDb: it re-derives the id from the same req,
  // so a caller cannot pass one tenant's request and another tenant's id.
  return writeRow(req, tenantId, entry, (sql, params) =>
    tenantDb.withTenantDb(req, (pool) => pool.query(sql, params))
  );
}

/**
 * Write one audit row into a NAMED tenant's log, rather than the caller's own.
 *
 * For the platform console (PR C) and nothing else. A super_admin toggling a
 * module for Smith Dental is signed in under CareIN, so `req.tenant.id` is
 * CareIN — but the event belongs in Smith Dental's trail, because that is the
 * log Smith Dental's own admins read when they ask why TC vanished on Tuesday.
 * Filing it under the operator's tenant would make it invisible to the only
 * people it happened to.
 *
 * `tenantId` MUST be an id the registry returned, never one taken from a
 * request body — the route validates it against the tenant catalog before
 * calling this. That is the same rule `tenantDb.getTenantPool` documents, and
 * it is why this takes an id rather than accepting a hand-built `req` shim: a
 * shim would let a caller quietly redirect an audit row anywhere.
 *
 * Fail-closed exactly like audit(): a failed write throws.
 *
 * @param {import('express').Request & { user?: any }} req the ACTING request (actor, IP, endpoint)
 * @param {string} tenantId the tenant whose log to write to
 * @param {Parameters<typeof audit>[1]} entry
 * @returns {Promise<void>}
 */
async function auditForTenant(req, tenantId, entry) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new AuditError('auditForTenant requires a registry-resolved tenant id');
  }
  return writeRow(req, tenantId, entry, async (sql, params) => {
    const pool = await tenantDb.getTenantPool(tenantId);
    return pool.query(sql, params);
  });
}

/**
 * The shared row builder + insert. Split out so audit() and auditForTenant()
 * cannot drift in what they record — the only thing that differs between them
 * is WHICH log the row lands in.
 *
 * @param {import('express').Request & { user?: any }} req
 * @param {string} tenantId the tenant recorded in the row AND whose log it lands in
 * @param {Parameters<typeof audit>[1]} entry
 * @param {(sql: string, params: unknown[]) => Promise<unknown>} run how to reach that log
 * @returns {Promise<void>}
 */
async function writeRow(req, tenantId, entry, run) {
  // Actor + source — NOT patient PHI.
  const userId = (req.user && (req.user.email || req.user.oid || req.user.sub)) || null;
  const ip = (req.ip || (req.socket && req.socket.remoteAddress)) || null;
  const endpoint =
    entry.endpoint ||
    (req.originalUrl ? sanitizeUrlPath(req.originalUrl) : req.path ? sanitizeUrlPath(req.path) : null);

  // resource_id is stringified; callers must pass an ID, never a PHI value.
  const resourceId = entry.resourceId != null ? String(entry.resourceId) : null;

  // Office key ('roland' | 'valley' | 'unknown') — an identifier, not PHI.
  const office = entry.office != null ? String(entry.office) : null;

  // Where the action came from, when that differs from what it touched (a
  // cross-office chart write). An identifier, not PHI.
  const originOffice = entry.originOffice != null ? String(entry.originOffice) : null;

  // External cause (e.g. a voice call id) — an identifier, not PHI.
  const sourceRef = entry.sourceRef != null ? String(entry.sourceRef) : null;

  // What this action REPLACED, as a slug from the subject's own vocabulary.
  // A CHECK constraint refuses anything that is not slug-shaped, so a caller
  // that reached for a sentence gets a loud write failure rather than a trail
  // that has quietly become a copy of somebody's prose. See the header.
  const priorState = entry.priorState != null ? String(entry.priorState) : null;

  try {
    await run(
      `INSERT INTO audit_log
          (user_id, tenant_id, action, resource_type, resource_id, ip, result, endpoint, office, origin_office, source_ref, prior_state)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [userId, tenantId, entry.action, entry.resourceType, resourceId, ip, entry.result, endpoint, office, originOffice, sourceRef, priorState]
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

module.exports = { audit, auditForTenant, assertReady, AuditError };
