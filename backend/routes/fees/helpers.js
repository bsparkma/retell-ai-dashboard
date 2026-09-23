'use strict';

/**
 * Shared plumbing for the /api/fees route modules (Fee Schedule slice 1).
 *
 * Deliberately a near-copy of routes/rcm/helpers.js rather than a shared
 * import, for the reason that file already records about its own relationship
 * to routes/tc/helpers.js: the conventions are what must not diverge, and the
 * modules' dependencies are not the same. RCM's helper drags in a money
 * coercion, a status zero-filler and a denial auditor this module has no use
 * for; sharing would mean either importing all of it or gutting RCM's.
 *
 * Conventions enforced here (platform law):
 *  - Office context comes ONLY from the validated `?office=` query param
 *    ('roland' | 'valley'), never from the body and never from a header. Every
 *    query filters by it, so a valley row is structurally unreachable in a
 *    roland context. See index.js for why the guard is router-wide.
 *  - Acting identity is the SSO session user (req.user.email), guaranteed by
 *    the auth gate + tenantContext's fail-closed 403 upstream.
 *  - Errors are structured: { success: false, error, code }. No internals.
 */

const { audit, AuditError } = require('../../platform/audit');

/**
 * Frozen internal office keys — the same two the fees_* CHECK constraints
 * accept (`office IN ('roland','valley')`, migrations-tenant/…_fees_import).
 * A third office is a migration, not an edit here.
 *
 * 'unknown' is NOT here and must never be. config/officeAgents.js carries it as
 * a bucket for Mango calls whose line is unmapped; it has no Open Dental
 * settings entry and it names no real practice. A fee schedule imported against
 * it would be a payer contract filed under no office at all.
 */
const OFFICES = Object.freeze(['roland', 'valley']);

/**
 * Middleware: validate `?office=` and attach it as req.feesOffice.
 *
 * 400, not 403 — a missing or unknown office is a malformed request, not an
 * entitlement failure. Entitlement is the mount-level requireModule('fees').
 *
 * FAIL CLOSED: anything that is not one of the two frozen keys is refused,
 * including 'unknown', the empty string, an array (`?office=a&office=b` arrives
 * as one in Express) and any casing variant. There is no default and no
 * fallback — the RCM and HYG modules both learned that an office that can be
 * omitted is an office that gets omitted.
 *
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
  req.feesOffice = office;
  return next();
}

/**
 * The acting user's SSO email. Always present under the /api auth gate +
 * tenantContext; the throw only fires if a route is mounted outside them, and
 * exists so that fails loudly instead of stamping '' into a created_by column.
 * @param {import('express').Request} req
 * @returns {string}
 */
function actorEmail(req) {
  const email = req.user && req.user.email;
  if (!email) {
    throw new Error('[fees] no SSO identity on request — route mounted outside the auth gate?');
  }
  return email;
}

/**
 * Wrap an async handler: AuditError → 500 AUDIT_FAILED, everything else → a
 * structured 500 with no internals leaked.
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} fn
 * @returns {import('express').RequestHandler}
 */
function h(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`[fees] ${req.method} ${req.originalUrl} failed:`, msg);
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
 * A structured refusal, in the shape the rest of the platform uses.
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} code
 * @param {string} error
 * @param {Record<string, unknown>} [extra]
 */
function refuse(res, status, code, error, extra) {
  return res.status(status).json({ success: false, error, code, ...(extra || {}) });
}

/**
 * Audit the creation of an import batch. Fail-closed — throws AuditError, which
 * h() turns into a 500 BEFORE the response is written.
 *
 * WHY CREATION IS AUDITED AND READS ARE NOT, which is a departure from the RCM
 * habit and therefore worth stating: RCM audits reads because its rows carry
 * patient names, and hard rule 5 says PHI is never served without a recorded
 * trail. A fee schedule carries procedure codes and money — a payer contract,
 * not a chart. There is no PHI on any route in this module to leave a trail
 * for. What there IS is an act with consequences: an import batch is what a
 * later slice posts into Open Dental's `fee` table, so "who uploaded the
 * schedule that changed what a crown is worth" must be answerable. That is a
 * CREATE, and it is audited on both outcomes — a file that failed to parse is
 * still a file somebody uploaded.
 *
 * @param {import('express').Request} req
 * @param {{ office: string, resourceId: string, result: 'SUCCESS'|'ERROR' }} entry
 */
async function auditBatchCreate(req, entry) {
  await audit(req, {
    action: 'CREATE',
    resourceType: 'fees_import_batch',
    resourceId: entry.resourceId,
    result: entry.result,
    office: entry.office,
    sourceRef: null,
  });
}

/** ISO string for a pg timestamptz value (Date | string | null). */
function iso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Coerce a pg integer/bigint (node-postgres returns bigint as a string) to a
 * number. Fees here are integer CENTS and counts are row counts, so every value
 * stays far inside Number's exact integer range.
 * @param {unknown} v
 * @returns {number}
 */
function num(v) {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v);
}

/**
 * A uuid, or nothing.
 *
 * Every `:id` in this module is a uuid we minted. Postgres refuses a non-uuid
 * literal in a `uuid` comparison with `invalid input syntax for type uuid`,
 * which h() would turn into a 500 INTERNAL_ERROR — so probing
 * `/api/fees/imports/../../etc` and probing a real-looking id that does not
 * exist would produce two DIFFERENT answers, and the shape of the error would
 * tell the prober which was which. RCM's helper carries the same note and the
 * same regex for the same reason.
 *
 * A malformed id is simply not found.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** RFC 4122 shape, any version — Postgres accepts the same set. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = {
  OFFICES,
  requireOffice,
  actorEmail,
  h,
  refuse,
  auditBatchCreate,
  iso,
  num,
  isUuid,
};
