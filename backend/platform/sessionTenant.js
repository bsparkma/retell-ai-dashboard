'use strict';

/**
 * THE tenant a request-path reader of the per-office settings is asked for
 * (MT-2b): the SESSION tenant, which middleware/tenantContext.js resolved from
 * the signed-in user and froze onto req.tenant.
 *
 * Never a query parameter, a header or a body field. A request cannot name the
 * tenant whose settings it is answered with, exactly as it cannot name the
 * office whose chart is written (CLAUDE.md, hard rule 2).
 * platform/officeSettingsTenantSource.test.js scans every route that reads a
 * per-office setting and fails if one takes a tenant from anywhere else.
 *
 * No tenant (a route mounted outside the tenant gate) => null, which every
 * reader answers as OFF.
 *
 * @param {{ tenant?: { slug?: unknown } | null } | null | undefined} req
 * @returns {string|null}
 */
function sessionTenantSlug(req) {
  const slug = req && req.tenant ? req.tenant.slug : null;
  return typeof slug === 'string' && slug !== '' ? slug : null;
}

module.exports = { sessionTenantSlug };
