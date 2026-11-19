'use strict';

/**
 * THE office validity layer for request paths (MT-2b3).
 *
 * Before MT-2b3, four route modules (tc, hyg, fees, rcm) and two messaging
 * paths each checked an office key against their own hard-coded list of the
 * two offices, and 23 shared/ schemas did the same with a two-value z.enum.
 * Since MT-2b2 the database checks only the
 * FORMAT of an office key (^[a-z][a-z0-9_-]{1,31}$), and since this slice the
 * shared schemas check only the format as well. So the gates in THIS file are
 * the one place that decides whether a key names an office of the practice
 * making the request. backend/test/officeGateWiring.test.js pins that every
 * route that reads an office from a request goes through one of them.
 *
 * THE RULE: officeRegistry.isTenantOffice(sessionTenant, key).
 *   - sessionTenant comes ONLY from req.tenant (platform/sessionTenant.js),
 *     never from a query, header or body. No tenant means no offices.
 *   - 'unknown' is never an office.
 *
 * WHAT HAPPENS DURING A REGISTRY BLIP (pinned by platform/officeGate.test.js):
 *   - tenant 'carein' (the code-map tenant): when the registry is unread, its
 *     last read failed, or that read is stale, isTenantOffice answers from the
 *     CODE maps (roland, valley), exactly as the office getters already fall
 *     back. roland and valley pass and everything else is refused, both before
 *     and during a blip. A blip changes nothing for carein's two offices.
 *     (A THIRD carein office that lives only in the registry is refused during
 *     the blip, because the code maps do not know it. Nobody has one today.)
 *   - any other tenant: NO offices during a blip, so every key is refused
 *     (fail closed). Before MT-2b3, every tenant's gate accepted roland and
 *     valley whatever the registry said. That was right for carein only.
 *   - THE ONE EXCEPTION (ruling): recording an email unsubscribe checks the
 *     office's FORMAT only (isOfficeKeyFormat below), so a blip never drops a
 *     patient's opt-out.
 *
 * FRESHNESS. carein's registry read is kept fresh by officeRegistry's own
 * timer, so its gate answers synchronously, exactly as the old literal gates
 * did. Any other tenant's registry is read on demand (ensureFresh, which shares
 * one in-flight read and never throws) before the gate answers.
 *
 * ORACLE-FREE. A refusal never depends on WHICH key was asked for: a made-up
 * office, 'unknown', and another tenant's real office get byte-identical
 * bodies. The only list a refusal names is the session tenant's OWN offices,
 * which for carein is exactly the old "roland, valley".
 */

const officeRegistry = require('./officeRegistry');
const { sessionTenantSlug } = require('./sessionTenant');

/**
 * The session tenant's office keys, in registry order. Synchronous, never
 * reads, never throws. See officeRegistry.tenantOfficeKeys.
 * @param {{ tenant?: { slug?: unknown } | null } | null | undefined} req
 * @returns {string[]}
 */
function sessionOfficeKeys(req) {
  return officeRegistry.tenantOfficeKeys(sessionTenantSlug(req));
}

/**
 * Is `officeKey` one of the session tenant's offices? Synchronous.
 * @param {{ tenant?: { slug?: unknown } | null } | null | undefined} req
 * @param {unknown} officeKey
 * @returns {boolean}
 */
function isSessionOffice(req, officeKey) {
  return officeRegistry.isTenantOffice(sessionTenantSlug(req), officeKey);
}

/**
 * Does this request's tenant need its registry read before a gate answers?
 * carein's is kept fresh by the registry's own timer; no tenant has no
 * registry to read.
 * @param {string|null} slug
 * @returns {boolean}
 */
function needsOnDemandRead(slug) {
  return slug !== null && slug !== officeRegistry.CODE_MAP_TENANT_SLUG;
}

/**
 * Read the session tenant's registry if it is stale (non-carein tenants only).
 * Never throws: a failed read leaves the tenant with no offices, which every
 * gate refuses.
 * @param {{ tenant?: { slug?: unknown } | null } | null | undefined} req
 * @returns {Promise<void>}
 */
async function ensureSessionOffices(req) {
  const slug = sessionTenantSlug(req);
  if (!needsOnDemandRead(slug)) return;
  try {
    await officeRegistry.ensureFresh(/** @type {string} */ (slug));
  } catch {
    // Fail closed: isTenantOffice answers false for an unread tenant.
  }
}

/**
 * The async form of isSessionOffice, for service code that is already async.
 * @param {{ tenant?: { slug?: unknown } | null } | null | undefined} req
 * @param {unknown} officeKey
 * @returns {Promise<boolean>}
 */
async function isSessionOfficeFresh(req, officeKey) {
  await ensureSessionOffices(req);
  return isSessionOffice(req, officeKey);
}

/**
 * The list a refusal names: the session tenant's own offices, comma-joined.
 * For carein this is exactly "roland, valley", the bytes every gate sent
 * before MT-2b3.
 * @param {{ tenant?: { slug?: unknown } | null } | null | undefined} req
 * @returns {string}
 */
function officeListText(req) {
  return sessionOfficeKeys(req).join(', ');
}

/**
 * Build a module's `requireOffice` middleware: validate `?office=` against the
 * session tenant's offices and attach it as req[reqField].
 *
 * 400 INVALID_OFFICE, not 403: a missing or unknown office is a malformed
 * request, not an entitlement failure (that is the mount-level requireModule).
 * Anything that is not a string naming one of the tenant's offices is refused:
 * 'unknown', '', an array (`?office=a&office=b`), any casing variant.
 *
 * For carein this answers synchronously (next() or the 400 runs before
 * requireOffice returns), exactly as the literal gates did.
 *
 * @param {string} reqField  e.g. 'tcOffice'
 * @returns {import('express').RequestHandler}
 */
function makeRequireOffice(reqField) {
  /** @type {import('express').RequestHandler} */
  function requireOffice(req, res, next) {
    const decide = () => {
      const office = req.query.office;
      if (typeof office !== 'string' || !isSessionOffice(req, office)) {
        return res.status(400).json({
          success: false,
          error: `office query param is required and must be one of: ${officeListText(req)}`,
          code: 'INVALID_OFFICE',
        });
      }
      /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (req))[reqField] = office;
      return next();
    };
    if (!needsOnDemandRead(sessionTenantSlug(req))) return decide();
    return ensureSessionOffices(req).then(decide, next);
  }
  return requireOffice;
}

/**
 * The office key FORMAT, exactly the tenant tables' CHECK since MT-2b2
 * (migrations-tenant/1795000000000_office_format_checks.js).
 */
const OFFICE_KEY_FORMAT = /^[a-z][a-z0-9_-]{1,31}$/;

/**
 * Is `officeKey` well-formed? FORMAT ONLY: it says nothing about whose
 * office it is, and it is NOT a gate.
 *
 * THE ONE PATH THAT USES IT INSTEAD OF isSessionOffice (ruling, MT-2b3):
 * RECORDING an email unsubscribe (messaging.recordUnsubscribeLink). There:
 *   - the tenant was resolved authoritatively from the link token
 *     (platform/publicLinkIndex.js), not from the request;
 *   - the office comes from that tenant's OWN sent-message or referral-event
 *     row, never from client input.
 * A registry blip must not drop a patient's opt-out (a silently lost opt-out
 * is a dishonest state), so this path checks the format alone. Every other
 * request path stays registry-backed. platform/officeGate.test.js and
 * routes/publicLinkTenant.test.js pin both halves.
 *
 * @param {unknown} officeKey
 * @returns {boolean}
 */
function isOfficeKeyFormat(officeKey) {
  return typeof officeKey === 'string' && OFFICE_KEY_FORMAT.test(officeKey);
}

module.exports = {
  OFFICE_KEY_FORMAT,
  isOfficeKeyFormat,
  sessionOfficeKeys,
  isSessionOffice,
  ensureSessionOffices,
  isSessionOfficeFresh,
  officeListText,
  makeRequireOffice,
};
