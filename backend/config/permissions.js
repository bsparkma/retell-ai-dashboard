'use strict';

/**
 * The permission map — the ONE place a role is compared to an action.
 *
 * Rule: no route file anywhere contains a role literal. Routes name an ACTION;
 * this file decides which roles hold it. That is what makes "who can send a
 * chart note?" answerable by reading one table instead of grepping 40 files,
 * and what makes PR C's platform console able to render a role matrix without
 * re-deriving it.
 *
 * Tenant roles (app_user.role), locked 2026-08-11:
 *   admin    everything, including /api/admin
 *   office   everything except /api/admin
 *   tc       TC module + READ-ONLY voice
 *   hygiene  hygiene intake/submissions/inbox only
 *
 * Above them sits the PLATFORM tier: a super_admin (platform_admin row) acts as
 * tenant 'admin' everywhere and short-circuits every check below.
 *
 * 'staff' is the pre-roles app_user default. It appears in NO action, so a
 * legacy row that nobody has re-roled is denied everything rather than silently
 * inheriting a permission set that was never chosen for it.
 */

/** @typedef {'admin'|'office'|'tc'|'hygiene'} TenantRole */

/**
 * Action → roles that hold it. Frozen: this is configuration, and a route that
 * could mutate it at runtime would be an authorization bug.
 *
 * @type {Readonly<Record<string, ReadonlyArray<TenantRole>>>}
 */
const PERMISSIONS = Object.freeze({
  // --- voice ---------------------------------------------------------------
  /** Read the call worklist, call detail, stats, analytics, recordings. */
  'voice.read': Object.freeze(['admin', 'office', 'tc']),
  /** Worklist bookkeeping that stays inside the app: triage, notes, callbacks. */
  'voice.write': Object.freeze(['admin', 'office']),
  /** Pull from Mango/Retell (costs money and moves the ingestion watermark). */
  'voice.sync': Object.freeze(['admin', 'office']),
  /** On-demand transcription (costs money per call). */
  'voice.transcribe': Object.freeze(['admin', 'office']),
  /** Link a call to a patient and write the commlog — a PHI write to Open Dental. */
  'voice.chart_write': Object.freeze(['admin', 'office']),
  /** Hand a matched call to the TC module. */
  'voice.send_to_tc': Object.freeze(['admin', 'office']),

  // --- tc ------------------------------------------------------------------
  /** The full TC surface: pipeline, nurture, follow-ups, pre-auth, tools, OD reads. */
  'tc.full': Object.freeze(['admin', 'office', 'tc']),
  /** The hygiene handoff surface only — intake, my submissions, inbox. */
  'tc.hygiene': Object.freeze(['admin', 'office', 'tc', 'hygiene']),

  // --- rcm ------------------------------------------------------------------
  /** Read the RCM surface: claim/batch/queue counts, the claims list. */
  'rcm.read': Object.freeze(['admin', 'office']),
  /**
   * Any RCM mutation. NO route holds it yet — Slice 3 mounts reads only.
   *
   * It exists now so the mount can be requireReadWrite('rcm.read','rcm.write')
   * rather than a single read gate. Under a single gate the next POST added to
   * this module would inherit READ permission by omission; under this pair it
   * demands the stronger action the moment it exists. Same reasoning as the
   * voice surface, and the same reason routes/tc/index.js registers its
   * narrower mounts first.
   *
   * `tc` and `hygiene` hold neither: a treatment coordinator and a hygienist
   * have no business in claims, denials, or AR.
   */
  'rcm.write': Object.freeze(['admin', 'office']),

  // --- admin ---------------------------------------------------------------
  /** /api/admin/* — scheduler start/stop, costs, queues, config, connection tests. */
  'admin.all': Object.freeze(['admin']),
});

/** Every role that appears anywhere in the map, for validation and PR C's UI. */
const TENANT_ROLES = Object.freeze(['admin', 'office', 'tc', 'hygiene']);

/**
 * Does `role` hold `action`?
 *
 * FAIL CLOSED on every degenerate input: an unknown action, an unknown role, a
 * null role (no app_user row, or a disabled one) and a non-string all return
 * false. An action name typo therefore locks a route down rather than opening
 * it — the safe direction for a typo to fail in.
 *
 * @param {string|null|undefined} role
 * @param {string} action
 * @returns {boolean}
 */
function roleHasPermission(role, action) {
  if (typeof role !== 'string' || role.length === 0) return false;
  const allowed = Object.prototype.hasOwnProperty.call(PERMISSIONS, action)
    ? PERMISSIONS[action]
    : null;
  if (!allowed) return false;
  return allowed.includes(role);
}

/**
 * Every action a role holds, sorted. Used by /auth/me so the SPA can hide what
 * the caller cannot do — UI hiding only; the 403 below is the source of truth.
 * @param {string|null|undefined} role
 * @param {{ isSuperAdmin?: boolean }} [opts]
 * @returns {string[]}
 */
function permissionsForRole(role, { isSuperAdmin = false } = {}) {
  if (isSuperAdmin) return Object.keys(PERMISSIONS).sort();
  return Object.keys(PERMISSIONS)
    .filter((action) => roleHasPermission(role, action))
    .sort();
}

/**
 * Is this request an authenticated MACHINE caller (shared DASHBOARD_API_TOKEN,
 * no user identity)?
 *
 * EXPLICIT DECISION, not an oversight: a valid shared-token request is treated
 * as admin-equivalent for permission purposes. The token already grants full
 * API access today, it carries no email to map to a role, and narrowing it here
 * would break integrations without adding safety — anyone holding the token can
 * do anything the token can reach either way. The real fix is per-integration
 * identities, which is out of scope for PR A.
 *
 * In practice this branch is nearly unreachable on tenant-scoped routes:
 * tenantContext fails closed (403 TENANT_UNRESOLVED) on a request with no user
 * identity, so a token-only caller never gets as far as requirePermission
 * except on tenant-exempt paths. It is written anyway so that mounting a gate
 * on a tenant-exempt route later does not silently 403 the machine callers.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isMachineCaller(req) {
  return Boolean(req && req.authMethod === 'token' && !(req.user && req.user.email));
}

/**
 * Express guard factory: 403 unless the caller holds `action`.
 *
 * Mount AFTER tenantContext() (which attaches req.userRole / req.isSuperAdmin).
 * Order of allowance:
 *   1. super_admin       — platform tier, passes everything
 *   2. machine token     — see isMachineCaller above
 *   3. req.userRole ∈ PERMISSIONS[action]
 *
 * Denials are HONEST: a 403 with the action that failed, never a silent
 * redirect and never a 404 pretending the route does not exist. The SPA needs
 * to be able to tell "you may not" from "it is not there".
 *
 * `exempt` mirrors tenantContext()/requireModule(): mount-relative paths that
 * bypass the gate.
 *
 * @param {string} action key of PERMISSIONS
 * @param {{ exempt?: RegExp[] }} [opts]
 * @returns {import('express').RequestHandler}
 */
function requirePermission(action, { exempt = [] } = {}) {
  if (typeof action !== 'string' || action.length === 0) {
    throw new Error('requirePermission: a non-empty action name is required');
  }
  // Fail at BOOT, not at request time, if a route names an action that does not
  // exist. Otherwise the typo would present as a permanent 403 in production
  // and read like a role problem.
  if (!Object.prototype.hasOwnProperty.call(PERMISSIONS, action)) {
    throw new Error(
      `requirePermission: unknown action '${action}'. Add it to backend/config/permissions.js ` +
        `(known: ${Object.keys(PERMISSIONS).sort().join(', ')}).`
    );
  }

  return function requirePermissionMiddleware(req, res, next) {
    const subPath = req.path || '';
    for (const rx of exempt) {
      if (rx.test(subPath)) return next();
    }

    if (req.isSuperAdmin === true) return next();
    if (isMachineCaller(req)) return next();
    if (roleHasPermission(req.userRole, action)) return next();

    return res.status(403).json({
      success: false,
      error: 'You do not have permission to do that',
      code: 'FORBIDDEN',
      action,
    });
  };
}

/** HTTP methods that only read. Everything else counts as a write. */
const READ_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS']);

/**
 * Express guard factory: apply `readAction` to GET/HEAD/OPTIONS and
 * `writeAction` to everything else.
 *
 * This exists so a whole router mount can express "reads are one permission,
 * mutations are a stronger one" in a single line, instead of decorating forty
 * individual routes with near-identical guards. It is what makes the `tc` role
 * genuinely READ-ONLY across the voice surface rather than read-only on the
 * handful of routes someone remembered to decorate.
 *
 * Routes that need something stronger than `writeAction` (a chart write, a
 * paid transcription, a sync) still carry their own requirePermission() and it
 * runs after this one — the specific gate narrows the general one, never the
 * other way round.
 *
 * @param {string} readAction
 * @param {string} writeAction
 * @param {{ exempt?: RegExp[] }} [opts]
 * @returns {import('express').RequestHandler}
 */
function requireReadWrite(readAction, writeAction, { exempt = [] } = {}) {
  const readGate = requirePermission(readAction, { exempt });
  const writeGate = requirePermission(writeAction, { exempt });
  return function requireReadWriteMiddleware(req, res, next) {
    const gate = READ_METHODS.includes(req.method) ? readGate : writeGate;
    return gate(req, res, next);
  };
}

/**
 * Express guard factory: 403 unless the caller is a platform super_admin.
 *
 * For the future /api/platform/* console (PR C). Exported and tested now so the
 * platform tier is a real boundary from the first commit; NO platform routes
 * are mounted in PR A.
 *
 * Machine tokens do NOT pass this one. Tenant-level admin-equivalence is a
 * pragmatic call about an existing credential; handing a shared token the
 * ability to edit the tenant catalog is not.
 *
 * @returns {import('express').RequestHandler}
 */
function requireSuperAdmin() {
  return function requireSuperAdminMiddleware(req, res, next) {
    if (req.isSuperAdmin === true) return next();
    return res.status(403).json({
      success: false,
      error: 'Platform administrator access required',
      code: 'FORBIDDEN',
      action: 'platform.admin',
    });
  };
}

module.exports = {
  PERMISSIONS,
  TENANT_ROLES,
  roleHasPermission,
  permissionsForRole,
  requirePermission,
  requireReadWrite,
  requireSuperAdmin,
  isMachineCaller,
};
