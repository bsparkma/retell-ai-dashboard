'use strict';

/**
 * Tenant-context middleware (Slice 2).
 *
 * Runs AFTER `requireDashboardAuth` on `/api/*`. Resolves the authenticated
 * user to a tenant via the control-plane registry and attaches a typed
 * `req.tenant`. Fails CLOSED: if no tenant resolves, the request gets 403 and
 * never proceeds — no API route may serve data without a resolved tenant
 * (COMPLY gate, PHASE1_PRD_PLATFORM_SPINE.md).
 *
 * Operational prerequisite: `carein_control` must be reachable (CONTROL_DB_URL
 * set in dev / `control-db-url` in Key Vault in prod, migrations applied). If
 * it is not, tenant resolution fails and protected routes return 503 — by
 * design we would rather fail closed than serve data without tenant scoping.
 *
 * @typedef {Object} TenantClinicRef
 * @property {number} clinic_num
 * @property {string} name
 *
 * @typedef {Object} RequestTenant
 * @property {string}            id       tenant_id (uuid)
 * @property {string}            slug
 * @property {string[]}          modules  enabled module names
 * @property {TenantClinicRef[]} clinics  this tenant's clinics (OD ClinicNum + name)
 */

const registry = require('../platform/registry');

/**
 * TEMPORARY Phase 1 bootstrap mapping.
 * careindent Entra tenant id — used only by the fallback below.
 */
const CAREIN_FALLBACK = Object.freeze({
  entraTenantId: 'fb0713b3-53e4-426a-8b0f-e444441bfc29', // careindent.onmicrosoft.com
  emailDomain: '@carein.ai',
  slug: 'carein',
});

/**
 * Build the typed req.tenant from a tenant row, loading its clinics + modules.
 * @param {{ tenant_id: string, slug: string }} tenant
 * @returns {Promise<RequestTenant>}
 */
async function buildRequestTenant(tenant) {
  const [clinics, modules] = await Promise.all([
    registry.getTenantClinics(tenant.tenant_id),
    registry.getEnabledModules(tenant.tenant_id),
  ]);
  return {
    id: tenant.tenant_id,
    slug: tenant.slug,
    modules,
    clinics: clinics.map((c) => ({ clinic_num: c.clinic_num, name: c.name })),
  };
}

/**
 * Express middleware factory.
 * @param {{ exempt?: RegExp[] }} [opts] paths (mount-relative) that bypass tenant resolution
 * @returns {import('express').RequestHandler}
 */
/**
 * Resolve the tenant row for an authenticated user (app_user mapping, then the
 * temporary careindent bootstrap fallback). Returns the tenant row or null.
 * Shared by the middleware and by /auth/me so the SPA can show the practice name.
 *
 * @param {{ email?: string, tenantId?: string, tid?: string }} user
 * @returns {Promise<{ tenant_id: string, slug: string, display_name?: string } | null>}
 */
async function resolveTenantForUser(user) {
  const email = user && user.email;
  if (!email) return null;

  const appUser = await registry.getUserByEmail(email);
  if (appUser) {
    const t = await registry.getTenantById(appUser.tenant_id);
    if (t) return t;
  }

  // --- TEMPORARY Phase 1 bootstrap fallback -----------------------------
  // TODO(phase-2): remove once Entra External ID + explicit app_user
  // provisioning lands. A careindent @carein.ai user with no app_user row is
  // mapped to tenant 'carein' so the existing deployment keeps working.
  const entraTid = String(user.tenantId || user.tid || '').toLowerCase();
  if (
    entraTid === CAREIN_FALLBACK.entraTenantId &&
    email.toLowerCase().endsWith(CAREIN_FALLBACK.emailDomain)
  ) {
    const t = await registry.getTenantBySlug(CAREIN_FALLBACK.slug);
    if (t) {
      console.warn(
        `[tenantContext] BOOTSTRAP FALLBACK: mapped ${email} (no app_user row) ` +
          `to tenant '${CAREIN_FALLBACK.slug}'. Remove after Entra External ID + ` +
          'app_user provisioning (Phase 2).'
      );
      return t;
    }
  }
  // --- end temporary fallback -------------------------------------------

  return null;
}

function tenantContext({ exempt = [] } = {}) {
  return async function tenantContextMiddleware(req, res, next) {
    const subPath = req.path || '';
    for (const rx of exempt) {
      if (rx.test(subPath)) return next();
    }

    const user = req.user;
    if (!user || !user.email) {
      // No authenticated user identity (e.g. shared-token auth carries none).
      // Fail closed — a tenant cannot be resolved without a user.
      return res.status(403).json({
        success: false,
        error: 'Tenant context required: no authenticated user identity',
        code: 'TENANT_UNRESOLVED',
      });
    }

    try {
      const tenant = await resolveTenantForUser(user);
      if (!tenant) {
        return res.status(403).json({
          success: false,
          error: 'No tenant is mapped to this account',
          code: 'TENANT_UNRESOLVED',
        });
      }

      req.tenant = await buildRequestTenant(tenant);
      return next();
    } catch (err) {
      // Registry/DB failure — still fail closed (never proceed without tenant).
      console.error(
        '[tenantContext] tenant resolution failed:',
        err && err.message ? err.message : err
      );
      return res.status(503).json({
        success: false,
        error: 'Tenant resolution unavailable',
        code: 'TENANT_RESOLUTION_ERROR',
      });
    }
  };
}

/**
 * Guard: is `clinicNum` one of the calling tenant's entitled clinics?
 *
 * Closes the discovery gap where slot-markers forwarded a client-supplied
 * clinicNum to the connector unchecked. Routes must validate the raw query
 * value against `req.tenant.clinics` before trusting it.
 *
 * @param {import('express').Request & { tenant?: RequestTenant }} req
 * @param {string|number} clinicNum
 * @returns {boolean} true if the tenant is entitled to this clinic
 */
function requireEntitledClinic(req, clinicNum) {
  const n = Number(clinicNum);
  if (!Number.isInteger(n)) return false;
  const clinics =
    req && req.tenant && Array.isArray(req.tenant.clinics) ? req.tenant.clinics : [];
  return clinics.some((c) => Number(c.clinic_num) === n);
}

module.exports = { tenantContext, resolveTenantForUser, requireEntitledClinic, CAREIN_FALLBACK };
