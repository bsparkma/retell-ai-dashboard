'use strict';

/**
 * Shared plumbing for the /api/tc route modules (Slice 3).
 *
 * Conventions enforced here (platform law — see PHASE1_PRD_PLATFORM_SPINE.md
 * and the tc_schema migration):
 *  - Office context comes ONLY from the validated `?office=` query param
 *    ('roland' | 'valley'), never from the body. Every query filters by it, so
 *    a valley record is structurally unreachable in a roland context.
 *  - Request bodies parse against the strict shared/tc contract (bundled at
 *    tc/contract.gen.cjs). Zod failures → 400, never a partial write.
 *  - Acting identity is the SSO session user (req.user.email, attached by the
 *    auth middleware and guaranteed by tenantContext's fail-closed gate). No
 *    PIN, no legacy user slugs.
 *  - Every mutation writes a per-tenant audit row (fail-closed: audit failure
 *    throws AuditError and the request 500s — PHI paths never respond without
 *    a recorded trail).
 */

const { audit, AuditError } = require('../../platform/audit');
const contract = require('../../tc/contract.gen.cjs');

/** Frozen internal office keys (tc_* CHECK constraints). */
const OFFICES = Object.freeze(['roland', 'valley']);

/**
 * Middleware: validate `?office=` and attach it as req.tcOffice.
 * 400 (not 403) — a missing/unknown office is a malformed request, not an
 * entitlement failure; entitlement is the mount-level requireModule('tc').
 * @type {import('express').RequestHandler}
 */
function requireOffice(req, res, next) {
  const office = req.query.office;
  if (typeof office !== 'string' || !OFFICES.includes(office)) {
    return res.status(400).json({
      success: false,
      error: `office query param is required and must be one of: ${OFFICES.join(', ')}`,
      code: 'INVALID_OFFICE',
    });
  }
  req.tcOffice = office;
  return next();
}

/**
 * The acting user's SSO email. Under the /api auth gate + tenantContext this
 * is always present (tenantContext fails closed without it); the null branch
 * only exists so a mis-mounted route fails loudly instead of stamping ''.
 * @param {import('express').Request} req
 * @returns {string}
 */
function actorEmail(req) {
  const email = req.user && req.user.email;
  if (!email) {
    throw new Error('[tc] no SSO identity on request — route mounted outside the auth gate?');
  }
  return email;
}

/** Display name for the acting user, falling back to their email. */
function actorName(req) {
  return (req.user && req.user.name) || actorEmail(req);
}

/**
 * Map a zod failure to the structured 400 the platform uses. Issue objects are
 * trimmed to path/code/message — never echo the submitted values (PHI).
 * @param {import('express').Response} res
 * @param {{ issues: Array<{ path: Array<string|number>, code: string, message: string }> }} zodError
 */
function sendValidationError(res, zodError) {
  const issues = (zodError.issues || []).slice(0, 10).map((i) => ({
    path: Array.isArray(i.path) ? i.path.join('.') : String(i.path || ''),
    code: i.code,
    message: i.message,
  }));
  return res.status(400).json({
    success: false,
    error: issues.length ? `${issues[0].path || '(root)'}: ${issues[0].message}` : 'Invalid payload',
    code: 'VALIDATION_FAILED',
    issues,
  });
}

/**
 * Parse `body` with a strict schema or respond 400. Returns the parsed value,
 * or null after the response has been sent.
 * @template T
 * @param {import('express').Response} res
 * @param {{ safeParse: (v: unknown) => { success: boolean, data?: T, error?: any } }} schema
 * @param {unknown} body
 * @returns {T | null}
 */
function parseBody(res, schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return null;
  }
  return parsed.data;
}

/**
 * Handler for endpoints that exist but are disabled in this slice (email send
 * → Slice 7 ACS; smile-sim generate → Slice 7 AI). 501 + structured error so
 * the SPA can distinguish "not yet" from "broken".
 * @param {string} feature
 * @returns {import('express').RequestHandler}
 */
function featureDisabled(feature) {
  return (_req, res) =>
    res.status(501).json({
      success: false,
      error: `Feature '${feature}' is not enabled in this deployment`,
      code: 'FEATURE_DISABLED',
      feature,
    });
}

/**
 * Wrap an async handler: zod errors → 400, AuditError → 500 (fail-closed),
 * everything else → structured 500 with no internals leaked.
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} fn
 * @returns {import('express').RequestHandler}
 */
function h(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err && err.name === 'ZodError' && Array.isArray(err.issues)) {
        if (!res.headersSent) sendValidationError(res, err);
        return;
      }
      const msg = err && err.message ? err.message : String(err);
      console.error(`[tc] ${req.method} ${req.originalUrl} failed:`, msg);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: err instanceof AuditError ? 'Audit trail write failed' : 'Internal error',
          code: err instanceof AuditError ? 'AUDIT_FAILED' : 'INTERNAL_ERROR',
        });
      }
    }
  };
}

/**
 * Audit a TC mutation (fail-closed — throws AuditError on failure, which h()
 * turns into a 500 AFTER the transaction committed; the write stands, the
 * caller retries the read).
 * @param {import('express').Request} req
 * @param {'CREATE'|'UPDATE'|'DELETE'|'READ'} action
 * @param {string} resourceType
 * @param {string|number|null} resourceId
 * @param {{ office?: string|null, sourceRef?: string|null }} [extra]
 *   `office` stamps which practice the action touched; `sourceRef` the external
 *   identifier that caused it (see platform/audit.js). Both are identifiers,
 *   never PHI. Omitted on the routes that predate them — an unstamped row means
 *   "not recorded", which is the honest value.
 */
async function auditTc(req, action, resourceType, resourceId, extra = {}) {
  await audit(req, {
    action,
    resourceType,
    resourceId,
    result: 'SUCCESS',
    office: extra.office ?? null,
    sourceRef: extra.sourceRef ?? null,
  });
}

/** ISO string for a pg timestamptz value (Date | string | null). */
function iso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Number for a pg bigint value (string | number | null). */
function num(v) {
  if (v == null) return null;
  return typeof v === 'number' ? v : Number(v);
}

/** 'YYYY-MM-DD' for a pg date value (Date | string | null). */
function isoDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Structured 404. */
function notFound(res, what) {
  return res.status(404).json({ success: false, error: `${what} not found`, code: 'NOT_FOUND' });
}

module.exports = {
  contract,
  OFFICES,
  requireOffice,
  actorEmail,
  actorName,
  sendValidationError,
  parseBody,
  featureDisabled,
  h,
  auditTc,
  iso,
  num,
  isoDate,
  notFound,
};
