'use strict';

/**
 * Shared plumbing for the /api/hyg route modules (H1 slice 1).
 *
 * A near-copy of routes/rcm/helpers.js, for the same reason that one is a
 * near-copy of routes/tc/helpers.js: TC's version is welded to the TC zod
 * contract bundle, and hyg has none. The CONVENTIONS are what must not diverge,
 * and they are these:
 *
 *  - Office context comes ONLY from the validated `?office=` query param,
 *    never from a body and never from a header. `requireOffice` is registered
 *    router-wide in index.js, so every route added later inherits it.
 *  - Acting identity is the SSO session user (req.user.email), guaranteed by
 *    the auth gate + tenantContext's fail-closed 403 upstream.
 *  - Reads that can return PHI write an audit row, fail-closed: an audit
 *    failure 500s the request rather than serving PHI with no recorded trail
 *    (hard rule 5).
 *
 * One thing here is NOT copied from RCM: `resolveHygOd` below adds the hygiene
 * module's own per-office readiness gate on top of the office validation. See
 * config/odOffices.js `hygOdBlockReason` for why that switch exists and why it
 * can only ever narrow what the voice path already allows.
 */

const { audit, auditMany, AuditError } = require('../../platform/audit');
const odOffices = require('../../config/odOffices');

/**
 * Frozen internal office keys — the same two the rest of the platform uses. A
 * third office is a config change in config/officeAgents.js, not an edit here.
 * `unknown` is deliberately absent: it has no Open Dental database, so it is
 * not somewhere a hygiene day can be read from.
 */
const OFFICES = Object.freeze(['roland', 'valley']);

/**
 * Middleware: validate `?office=` and attach it as req.hygOffice.
 *
 * 400, not 403 — a missing or unknown office is a malformed request, not an
 * entitlement failure. Entitlement is the mount-level requireModule('hyg') and
 * permission is the mount-level requireReadWrite; both have already run.
 *
 * @type {import('express').RequestHandler}
 */
function requireOffice(req, res, next) {
  const office = req.query.office;
  if (typeof office !== 'string' || !OFFICES.includes(office)) {
    return res.status(400).json({
      success: false,
      error: 'office query param is required and must be one of: ' + OFFICES.join(', '),
      code: 'INVALID_OFFICE',
    });
  }
  req.hygOffice = office;
  return next();
}

/**
 * Resolve this office's Open Dental handle for the HYGIENE module, or return
 * the honest refusal.
 *
 * FAILS CLOSED PER OFFICE, AND NEVER FABRICATES A DAY. Every refusal below is a
 * non-2xx carrying a code. An office that is switched off, unkeyed, unknown, or
 * simply not enabled for hygiene yet must never be answered with an empty
 * appointment list, because a hygienist reading an empty grid has no way to
 * tell "nobody is booked" from "we are not talking to your practice's
 * database". That is the most damaging thing this endpoint could do, so it is
 * refused here rather than left to each route to remember.
 *
 * Returns `{ ok: true, od }` or `{ ok: false, status, body }`; callers send the
 * body verbatim. Not a middleware, so a route can audit the refusal with its
 * own resource type before answering.
 *
 * @param {string} office
 * @returns {{ ok: true, od: { officeKey: string, officeName: string, client: any } }
 *          | { ok: false, status: number, body: Record<string, unknown> }}
 */
function resolveHygOd(office) {
  // The hygiene module's own per-office switch, asked FIRST because it is the
  // narrower question: it defers to odBlockReason internally, so a switched-off
  // or unkeyed office still comes back with its own precise code.
  const blocked = odOffices.hygOdBlockReason(office);
  if (blocked) {
    return {
      ok: false,
      status: odOffices.httpStatusFor({ code: blocked.code }),
      body: {
        success: false,
        error: blocked.message,
        code: 'OFFICE_NOT_READY',
        reason: blocked.code,
        office,
      },
    };
  }

  try {
    // assertOfficeMatch is not ceremony: PatNum numbering restarts in every OD
    // database (7115 is the valley test patient AND a different real person in
    // roland), so a handle bound to the wrong practice must be refused rather
    // than used. It returns the same handle, which is why this reads as one call.
    const od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
    return { ok: true, od };
  } catch (err) {
    return {
      ok: false,
      status: odOffices.httpStatusFor(err),
      body: {
        success: false,
        error: err.publicMessage || 'Open Dental is not available for this office',
        code: 'OFFICE_NOT_READY',
        reason: err.code || 'UNKNOWN',
        office,
      },
    };
  }
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
    throw new Error('[hyg] no SSO identity on request - route mounted outside the auth gate?');
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
      console.error('[hyg] ' + req.method + ' ' + req.originalUrl + ' failed:', msg);
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
 * Audit a hygiene PHI read. Fail-closed — throws AuditError, which h() turns
 * into a 500 BEFORE the response is written.
 *
 * ONE ROW PER PATIENT READ, not one per request. A day view is a disclosure of
 * every patient on it, and a trail that records "somebody opened Tuesday"
 * cannot answer "whose chart was read on Tuesday" — which is the question the
 * trail exists to answer. `resourceId` is therefore the PatNum, an identifier
 * Open Dental minted, never a name.
 *
 * Office IS stamped: a PatNum is meaningless without it.
 *
 * @param {import('express').Request} req
 * @param {string} resourceType
 * @param {{ office: string, resourceId?: string|number|null }} extra
 */
async function auditHygRead(req, resourceType, extra) {
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
 * Audit a SET of hygiene PHI reads as one statement.
 *
 * Same rows `auditHygRead` writes, same fail-closed contract — one INSERT
 * instead of one per patient. A day view discloses everybody on it, and forty
 * sequential round trips to the control plane sat in front of a response the
 * user was already waiting on.
 *
 * **The set comes from what is about to be SENT, never from what was read.**
 * services/odPatientCache.js means a second load of the same day fetches
 * nothing from Open Dental and discloses exactly as many patients as the first
 * — so a trail built from fetches would go quiet precisely when the cache
 * started working. Callers pass the response's patients; the cache has no audit
 * call in it and must never grow one.
 *
 * An empty list writes nothing, which is correct: a day with nobody on it
 * disclosed nobody. The `hyg_day` row for the request itself is separate and
 * always written.
 *
 * @param {import('express').Request} req
 * @param {Array<{ resourceType: string, office: string, resourceId: string|number|null }>} reads
 */
async function auditHygReads(req, reads) {
  if (!Array.isArray(reads) || reads.length === 0) return;
  await auditMany(
    req,
    reads.map((r) => ({
      action: 'READ',
      resourceType: r.resourceType,
      resourceId: r.resourceId === undefined ? null : r.resourceId,
      result: 'SUCCESS',
      office: r.office,
      sourceRef: null,
    }))
  );
}

/**
 * Audit a REFUSED or FAILED hygiene read.
 *
 * BEST EFFORT, unlike auditHygRead, and for the same reason RCM's denial helper
 * is: the request is already being refused, and turning a 409 into a 500
 * because the trail could not be written converts a clean refusal into an
 * outage. The fail-CLOSED rule applies where it matters — on the path that
 * actually serves PHI.
 *
 * `result` is a parameter because over-using UNAUTHORIZED costs the trail its
 * meaning. A refusal is UNAUTHORIZED; a read that reached Open Dental and then
 * failed is ERROR.
 *
 * @param {import('express').Request} req
 * @param {string} resourceType
 * @param {string|number|null} resourceId an id we or Open Dental minted — never PHI
 * @param {{ office: string, result?: 'UNAUTHORIZED'|'ERROR' }} extra
 */
async function auditHygDenial(req, resourceType, resourceId, extra) {
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
      '[hyg] could not record a ' + result + ' ' + resourceType + ' read:',
      (err && err.message) || err
    );
  }
}

module.exports = {
  OFFICES,
  requireOffice,
  resolveHygOd,
  actorEmail,
  h,
  auditHygRead,
  auditHygReads,
  auditHygDenial,
};
