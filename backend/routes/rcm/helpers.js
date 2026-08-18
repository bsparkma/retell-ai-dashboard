'use strict';

/**
 * Shared plumbing for the /api/rcm route modules (Slice 3).
 *
 * Deliberately a near-copy of routes/tc/helpers.js rather than a shared import:
 * the TC version is welded to the TC zod contract bundle (tc/contract.gen.cjs),
 * and RCM has no contract bundle. Sharing would mean either dragging zod+TC
 * schemas into RCM or gutting the TC helper — both worse than 60 duplicated
 * lines. The CONVENTIONS below are the thing that must not diverge.
 *
 * Conventions enforced here (platform law):
 *  - Office context comes ONLY from the validated `?office=` query param
 *    ('roland' | 'valley'), never from the body and never from a header. Every
 *    query filters by it, so a valley row is structurally unreachable in a
 *    roland context. See index.js for why the guard is router-wide.
 *  - Acting identity is the SSO session user (req.user.email), guaranteed by
 *    the auth gate + tenantContext's fail-closed 403 upstream.
 *  - Reads that can return PHI write an audit row, fail-closed: an audit
 *    failure 500s the request rather than serving PHI with no recorded trail
 *    (hard rule 5).
 */

const { audit, AuditError } = require('../../platform/audit');

/**
 * Frozen internal office keys — the same two the rcm_* CHECK constraints
 * accept (`office_id IN ('roland','valley')`, migrations-tenant/…_rcm_schema).
 * A third office is a migration, not an edit here.
 */
const OFFICES = Object.freeze(['roland', 'valley']);

/**
 * Middleware: validate `?office=` and attach it as req.rcmOffice.
 *
 * 400, not 403 — a missing or unknown office is a malformed request, not an
 * entitlement failure. Entitlement is the mount-level requireModule('rcm').
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
  req.rcmOffice = office;
  return next();
}

/**
 * The acting user's SSO email. Always present under the /api auth gate +
 * tenantContext; the throw only fires if a route is mounted outside them, and
 * exists so that fails loudly instead of stamping '' into an audit row.
 * @param {import('express').Request} req
 * @returns {string}
 */
function actorEmail(req) {
  const email = req.user && req.user.email;
  if (!email) {
    throw new Error('[rcm] no SSO identity on request — route mounted outside the auth gate?');
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
      console.error(`[rcm] ${req.method} ${req.originalUrl} failed:`, msg);
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
 * Audit an RCM read. Fail-closed — throws AuditError, which h() turns into a
 * 500 BEFORE the response is written.
 *
 * `resourceId` defaults to null for list/aggregate reads: the thing read is
 * "the office's claims", which has no single id, and stamping a query string
 * there could record PHI. Where the read DOES have one id we minted — a claim,
 * a document — pass it. The denial helper always stamped one, and a trail that
 * can say which id was probed but not which id was read answers the wrong half
 * of "whose chart was read on Tuesday".
 *
 * Office IS stamped — it is an identifier, not patient data.
 *
 * @param {import('express').Request} req
 * @param {string} resourceType
 * @param {{ office: string, resourceId?: string|number|null }} extra
 */
async function auditRcmRead(req, resourceType, extra) {
  await audit(req, {
    action: 'READ',
    resourceType,
    resourceId: extra.resourceId === undefined ? null : extra.resourceId,
    result: 'SUCCESS',
    office: extra.office,
    sourceRef: null,
  });
}

/**
 * Coerce a pg bigint (returned as a string by node-postgres) to a number.
 * Money here is integer CENTS, so the values stay far inside Number's exact
 * integer range; a claim would need to be worth $90 trillion to lose precision.
 * @param {unknown} v
 * @returns {number}
 */
function num(v) {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v);
}

/** ISO string for a pg timestamptz value (Date | string | null). */
function iso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** 'YYYY-MM-DD' for a pg date value (Date | string | null). */
function isoDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/**
 * Turn `[{ status, n }, …]` into a zero-filled map over `vocabulary`.
 *
 * Zero-filling is the point: a status the office happens to have no rows for
 * must read as a measured 0, not as a missing key the UI renders as "—". The
 * vocabularies are the CHECK constraints from the rcm_schema migration, so a
 * status the database can store always has a slot here.
 *
 * @param {ReadonlyArray<string>} vocabulary
 * @param {ReadonlyArray<{ status: string, n: unknown }>} rows
 * @returns {Record<string, number>}
 */
function countsByStatus(vocabulary, rows) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const status of vocabulary) out[status] = 0;
  for (const row of rows) {
    // A status outside the vocabulary means the CHECK constraint changed and
    // this file did not. Count it rather than dropping it — a visible unknown
    // key is a bug report; a silently dropped row is a wrong number.
    out[row.status] = (out[row.status] || 0) + num(row.n);
  }
  return out;
}

/** Sum of a counts map — the honest total, derived from the same rows. */
function totalOf(counts) {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/**
 * Audit a REFUSED read on a PHI path.
 *
 * Auditing only successes means somebody walking ids — probing for another
 * office's document, or for one that does not exist — leaves nothing in the
 * tenant's trail at all. The attempt is precisely what a HIPAA trail most needs
 * recorded, and an audit-on-success-only design discards it silently.
 *
 * BEST EFFORT, unlike `auditRcmRead`. The request is already being refused;
 * turning a 404 into a 500 because the trail could not be written would hand a
 * prober a way to distinguish "no such id" from "audit is down", and would
 * convert a clean refusal into an outage. The fail-CLOSED rule applies where it
 * matters: on the path that actually serves PHI.
 *
 * `result` is a parameter because UNAUTHORIZED is not the only best-effort
 * outcome, and over-using it costs the trail its meaning. A refusal is
 * UNAUTHORIZED; an operation that READ PHI and then failed downstream is
 * ERROR — filing that as a refusal under-counts real disclosures on exactly the
 * report the trail exists to produce. A routine conflict (someone else already
 * confirmed) writes NEITHER: it is not a refusal of access, and diluting
 * UNAUTHORIZED with it is how the one signal that means "somebody was refused"
 * stops being readable.
 *
 * @param {import('express').Request} req
 * @param {string} resourceType
 * @param {string|number|null} resourceId an id WE minted — never PHI
 * @param {{ office: string, result?: 'UNAUTHORIZED'|'ERROR' }} extra
 */
async function auditRcmDenial(req, resourceType, resourceId, extra) {
  const result = extra.result || 'UNAUTHORIZED';
  try {
    await audit(req, {
      action: 'READ',
      resourceType,
      resourceId,
      result,
      office: extra.office,
      sourceRef: null,
    });
  } catch (err) {
    console.error(
      `[rcm] could not record a ${result} ${resourceType} read:`,
      (err && err.message) || err
    );
  }
}

module.exports = {
  OFFICES,
  requireOffice,
  auditRcmDenial,
  actorEmail,
  h,
  auditRcmRead,
  num,
  iso,
  isoDate,
  countsByStatus,
  totalOf,
};
