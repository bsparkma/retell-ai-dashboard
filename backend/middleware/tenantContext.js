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
const userContext = require('../platform/userContext');

/**
 * Role the bootstrap fallback grants an authenticated @carein.ai user who has
 * no app_user row (Roles PR A).
 *
 * WHY 'office' and not null: the seed roster is a list of addresses typed from
 * memory. If a real teammate's address differs by a letter, failing closed
 * would lock them out of the product mid-shift; granting 'admin' would hand a
 * stranger the scheduler stop button. 'office' is everything except /api/admin —
 * inconvenienced if we guessed wrong, never silently privileged.
 */
const FALLBACK_ROLE = 'office';

/** Env var controlling the fallback. Absent = 'on' (PR A's behavior). */
const FALLBACK_ENV_KEY = 'ROLES_BOOTSTRAP_FALLBACK';

/**
 * Is the bootstrap fallback currently ON? (Roles PR B)
 *
 * Read PER REQUEST, not captured at module load. That is the whole point: the
 * lockdown is an env var Beau flips on the running app, not a code change that
 * needs a PR and a deploy. If somebody's address turns out to be wrong at 7am,
 * the fix is flipping the var back — not an emergency redeploy.
 *
 *   on  (default)  unseeded @carein.ai → FALLBACK_ROLE, warned once
 *   off            unseeded @carein.ai → role null; the tenant still resolves,
 *                  but they hold no permission and the SPA shows the
 *                  access-request screen
 *
 * Anything other than an explicit off-ish value reads as ON, so a typo
 * ('offf', 'no') leaves the team working rather than locking them out. The
 * lockdown is the deliberate state; it should take a deliberate value.
 *
 * @returns {boolean}
 */
function bootstrapFallbackEnabled() {
  const raw = String(process.env[FALLBACK_ENV_KEY] ?? '').trim().toLowerCase();
  if (raw === '') return true; // unset = on
  return !['off', 'false', '0', 'no', 'disabled'].includes(raw);
}

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
  const resolved = await resolveUserContext(user);
  return resolved.tenant;
}

/**
 * Resolve BOTH the tenant and the role for an authenticated user, from one
 * cached identity read.
 *
 * Tenant and role come from the same app_user row, so splitting them into two
 * lookups would mean two queries and a window in which they could disagree.
 * The identity read goes through userContext's 60s TTL cache, which is what
 * makes a role change take effect without re-login and without putting
 * anything role-related into the session JWT.
 *
 * Roles resolve as:
 *   app_user row, status 'active'    → its role
 *   app_user row, status 'disabled'  → null (denied everything; tenant still
 *                                      resolves so the user gets an honest 403
 *                                      per action rather than a confusing
 *                                      "no tenant" error)
 *   no app_user row, careindent fallback, flag ON  → FALLBACK_ROLE, logged once
 *   no app_user row, careindent fallback, flag OFF → null (the lockdown; the
 *                                      tenant still resolves so the SPA can
 *                                      show the access-request screen instead
 *                                      of a sign-in loop)
 *
 * `isSuperAdmin` is independent of all of that: it comes from platform_admin
 * and is true even for an email with no app_user row.
 *
 * @param {{ email?: string, tenantId?: string, tid?: string }} user
 * @returns {Promise<{
 *   tenant: { tenant_id: string, slug: string, display_name?: string } | null,
 *   role: string | null,
 *   isSuperAdmin: boolean,
 *   viaFallback: boolean
 * }>}
 */
async function resolveUserContext(user) {
  const empty = { tenant: null, role: null, isSuperAdmin: false, viaFallback: false };
  const email = user && user.email;
  if (!email) return empty;

  const { appUser, isSuperAdmin } = await userContext.getUserContext(email);

  if (appUser) {
    const t = await registry.getTenantById(appUser.tenant_id);
    if (t) {
      const active = appUser.status !== 'disabled';
      if (active) userContext.stampLoginIfDue(appUser);
      return {
        tenant: t,
        role: active ? appUser.role : null,
        isSuperAdmin,
        viaFallback: false,
      };
    }
  }

  // --- careindent bootstrap fallback (ROLES_BOOTSTRAP_FALLBACK) ---------
  // A careindent @carein.ai user with no app_user row is still mapped to the
  // 'carein' tenant. What they GET there depends on the flag, checked per
  // request:
  //
  //   on   FALLBACK_ROLE, warned once. The team keeps working while their
  //        addresses are verified against the seed roster.
  //   off  role null. They hold nothing, and the SPA shows the access-request
  //        screen. This is the lockdown — see bootstrapFallbackEnabled().
  //
  // The tenant resolves EITHER WAY. Returning no tenant would 403 them at the
  // middleware and strand the SPA in a sign-in loop with nothing to explain
  // itself; a resolved tenant with no role produces an honest, actionable
  // dead-end instead.
  const entraTid = String(user.tenantId || user.tid || '').toLowerCase();
  if (
    entraTid === CAREIN_FALLBACK.entraTenantId &&
    email.toLowerCase().endsWith(CAREIN_FALLBACK.emailDomain)
  ) {
    const t = await registry.getTenantBySlug(CAREIN_FALLBACK.slug);
    if (t) {
      if (!bootstrapFallbackEnabled()) {
        return { tenant: t, role: null, isSuperAdmin, viaFallback: false };
      }
      userContext.warnUnseededOnce(email);
      return { tenant: t, role: FALLBACK_ROLE, isSuperAdmin, viaFallback: true };
    }
  }
  // --- end bootstrap fallback -------------------------------------------

  return { ...empty, isSuperAdmin };
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
      const { tenant, role, isSuperAdmin } = await resolveUserContext(user);
      if (!tenant) {
        return res.status(403).json({
          success: false,
          error: 'No tenant is mapped to this account',
          code: 'TENANT_UNRESOLVED',
        });
      }

      req.tenant = await buildRequestTenant(tenant);
      // Role context for requirePermission(). `null` means "no role" — a
      // disabled account, or a legacy row with a role that holds nothing — and
      // requirePermission denies it everything.
      req.userRole = role;
      req.isSuperAdmin = isSuperAdmin;
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

/**
 * Predicate: is the calling tenant entitled to `name`?
 *
 * Mirrors requireEntitledClinic — a pure boolean over req.tenant, safe to call
 * from any route handler. Fails closed: no tenant context (or a malformed
 * modules array) reads as NOT entitled.
 *
 * @param {import('express').Request & { tenant?: RequestTenant }} req
 * @param {string} name module id ('voice' | 'rcm' | 'tc' | 'scheduling')
 * @returns {boolean} true if the tenant has this module enabled
 */
function isEntitledModule(req, name) {
  const modules =
    req && req.tenant && Array.isArray(req.tenant.modules) ? req.tenant.modules : [];
  return modules.includes(name);
}

/**
 * Express guard factory: 403 unless the resolved tenant is entitled to `name`.
 *
 * Mount AFTER tenantContext(). Fail-closed by construction: a missing
 * req.tenant (route mounted outside the tenant gate by mistake, or a future
 * refactor reordering middleware) is treated as unentitled — 403, never 500,
 * never pass-through. The response shape is the module-entitlement contract:
 * `{ error: 'MODULE_NOT_ENTITLED', module }`.
 *
 * `exempt` mirrors the tenantContext() factory: mount-relative paths that
 * bypass the guard (e.g. /dev/seed under /api/mango, which is tenant-exempt
 * upstream and would otherwise 403 here for lack of req.tenant).
 *
 * @param {string} name module id this route group belongs to
 * @param {{ exempt?: RegExp[] }} [opts]
 * @returns {import('express').RequestHandler}
 */
function requireModule(name, { exempt = [] } = {}) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('requireModule: a non-empty module name is required');
  }
  return function requireModuleMiddleware(req, res, next) {
    const subPath = req.path || '';
    for (const rx of exempt) {
      if (rx.test(subPath)) return next();
    }
    if (!isEntitledModule(req, name)) {
      return res.status(403).json({
        success: false,
        error: 'MODULE_NOT_ENTITLED',
        module: name,
        message: `This account is not entitled to the '${name}' module.`,
      });
    }
    return next();
  };
}

module.exports = {
  tenantContext,
  resolveTenantForUser,
  resolveUserContext,
  bootstrapFallbackEnabled,
  FALLBACK_ROLE,
  FALLBACK_ENV_KEY,
  requireEntitledClinic,
  isEntitledModule,
  requireModule,
  CAREIN_FALLBACK,
};
