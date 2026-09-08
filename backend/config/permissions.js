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
 *   hygiene  hygiene intake/submissions/inbox, and the hyg module (day view,
 *            routing slip) once the practice is entitled to it
 *   reviewer RCM review workbench: read it and WORK it, but commit nothing
 *            (added by RCM Slice 6a, decision D-9 — see the rcm block below).
 *            Named for what it DOES: it cannot perform the billing act.
 *   rcm_biller RCM end to end EXCEPT the two acts that reach a chart or retire
 *            money, and except the shadow-gate switch (added by the RCM shadow
 *            gate — see the rcm block below).
 *
 * Above them sits the PLATFORM tier: a super_admin (platform_admin row) acts as
 * tenant 'admin' everywhere and short-circuits every check below.
 *
 * 'staff' is the pre-roles app_user default. It appears in NO action, so a
 * legacy row that nobody has re-roled is denied everything rather than silently
 * inheriting a permission set that was never chosen for it.
 */

/** @typedef {'admin'|'office'|'tc'|'hygiene'|'reviewer'|'rcm_biller'} TenantRole */

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

  // --- hyg ------------------------------------------------------------------
  /*
   * THE HYGIENE MODULE (H1 slice 1). Read is the whole surface today.
   *
   * `hygiene` is the role this module was built for and the only role that
   * gains anything new here. `admin` and `office` hold it for the same reason
   * they hold everything else: somebody has to be able to look at a screen a
   * hygienist says is wrong.
   *
   * `tc` deliberately does NOT hold it. A treatment coordinator receives the
   * handoff — that is `tc.hygiene`, which already exists and already includes
   * the hygiene role. Standing at a chair reading the day's schedule is the
   * other side of that exchange, and giving one role both would make the two
   * surfaces indistinguishable in the permission map.
   */

  /** Read the hygiene surface: the day view, a visit, the routing slip. */
  'hyg.read': Object.freeze(['admin', 'office', 'hygiene']),
  /**
   * Any hygiene MUTATION. Nothing under /api/hyg needs it in slice 1 — the day
   * view is read-only and there is not one non-GET route in the module.
   *
   * It exists ahead of its first use ON PURPOSE, and for the same reason
   * `rcm.write` did through Slice 3: the mount is
   * requireReadWrite('hyg.read', 'hyg.write'), applied by HTTP METHOD, so the
   * first POST slice 2 adds demands the strong action BY CONSTRUCTION rather
   * than by whoever adds it remembering to decorate it. Declaring it later,
   * alongside the route that needs it, is how a mutation quietly lands on the
   * read tier.
   */
  'hyg.write': Object.freeze(['admin', 'office', 'hygiene']),

  // --- rcm ------------------------------------------------------------------
  /*
   * THREE TIERS, NOT TWO (decision D-9).
   *
   * The workbench asks a person to look at a remittance and judge it, and that
   * is a different job from committing the judgement. A `reviewer` user can open
   * the workbench, read a remittance, download the source document, RUN A MATCH
   * (which reads Open Dental and changes nothing about a chart) and MARK A
   * CLAIM REVIEWED with a note (worklist hygiene, no Open Dental effect at
   * all). They cannot confirm a match — that writes `od_claim_num`, the column
   * Slice 6c reads to decide which chart to post money into — and when 6b
   * lands they will not be able to approve, enqueue or post either.
   *
   * That is why running a match and confirming one can no longer share a
   * permission.
   */

  /** Read the RCM surface: claim/batch/queue counts, the claims list, the workbench. */
  'rcm.read': Object.freeze(['admin', 'office', 'reviewer', 'rcm_biller']),
  /**
   * Work the queue: run a match, mark a claim reviewed.
   *
   * These are POSTs — they write to OUR rows (a match snapshot, a review stamp)
   * and are therefore not GETs — but neither touches a chart and neither
   * commits a linkage anything downstream acts on. A reviewer who cannot record
   * "the carrier owes a corrected EOB, there is nothing here to post" has no way
   * to clear their queue except by confirming matches they do not believe in.
   */
  'rcm.queue': Object.freeze(['admin', 'office', 'reviewer', 'rcm_biller']),
  /**
   * Any OTHER RCM mutation: uploading an EOB or an 835, confirming a match, and
   * (from 6b) approving and enqueueing. POSTING is `rcm.post` below — the
   * shadow gate split it out so a biller can reach `approved` and no further.
   *
   * The mount is requireReadWrite('rcm.read','rcm.write'), so this is what a
   * new POST inherits by omission — the strong action, not the queue one. The
   * two queue routes are the deliberate, enumerated exceptions and each carries
   * its own requirePermission('rcm.queue'); rcmGuard.test.js pins that list.
   *
   * `tc` and `hygiene` hold none of these: a treatment coordinator and a
   * hygienist have no business in claims, denials, or AR.
   */
  'rcm.write': Object.freeze(['admin', 'office', 'rcm_biller']),
  /**
   * THE THREE ACTS `rcm.write` NO LONGER COVERS: posting to a chart, filing a
   * document into one, and retiring a plan so it never posts.
   *
   * `POST /posting/drain` writes insurance payments onto real patients'
   * ledgers; `POST /posting/queue/:id/withdraw` permanently retires a
   * remittance (a plan is unique on `(office_id, remittance_key)`, so a
   * withdrawal is the end of that money's road through CareIN); and
   * `POST /posting/queue/:id/attach-document` files a PDF into a patient's
   * images. All three are Open Dental territory or its irreversible mirror, and
   * all three are exactly what the `rcm_biller` tier exists to stop short of.
   *
   * Split out rather than expressed by withholding `rcm.write`, because a
   * biller must be able to upload, match, confirm and APPROVE — which is most
   * of the write surface. Enumerating the three exceptions is smaller and more
   * legible than enumerating everything else, and a new POST under /api/rcm
   * still inherits `rcm.write` by omission rather than silently inheriting the
   * posting tier.
   */
  'rcm.post': Object.freeze(['admin', 'office']),
  /**
   * The shadow gate's switch (`PUT /api/rcm/office-settings/:office`), and
   * reading its current state.
   *
   * ADMIN ONLY, and deliberately narrower than `rcm.post`. Deciding that a
   * practice may post at all is a different authority from pressing Drain once
   * it may — an `office` user runs the day, an `admin` decides what the day is
   * allowed to do. Read is gated with it too: a switch whose state only an
   * admin may change should not present a control the rest of the practice can
   * see and not use.
   */
  'rcm.settings': Object.freeze(['admin']),

  // --- admin ---------------------------------------------------------------
  /** /api/admin/* — scheduler start/stop, costs, queues, config, connection tests. */
  'admin.all': Object.freeze(['admin']),
});

/** Every role that appears anywhere in the map, for validation and PR C's UI. */
const TENANT_ROLES = Object.freeze(['admin', 'office', 'tc', 'hygiene', 'reviewer', 'rcm_biller']);

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
 * Does THIS REQUEST hold `action`? The predicate behind the guard below.
 *
 * Exported because a permission is not always a whole route. RCM's match
 * endpoint is the case that forced it: running a match is the queue tier, but
 * running one with `force` over a CONFIRMED claim NULLs `od_claim_num` — it
 * releases a decision, which is the write tier's act. The route cannot know
 * which it is until it has read the claim, so the check has to happen inside
 * the handler, and it must allow exactly what the middleware allows or the two
 * would disagree about super_admins and machine tokens.
 *
 * Same order, same fail-closed behaviour, one implementation.
 *
 * @param {import('express').Request} req
 * @param {string} action
 * @returns {boolean}
 */
function holdsPermission(req, action) {
  if (!req) return false;
  if (req.isSuperAdmin === true) return true;
  if (isMachineCaller(req)) return true;
  return roleHasPermission(req.userRole, action);
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

  function requirePermissionMiddleware(req, res, next) {
    const subPath = req.path || '';
    for (const rx of exempt) {
      if (rx.test(subPath)) return next();
    }

    if (holdsPermission(req, action)) return next();

    return res.status(403).json({
      success: false,
      error: 'You do not have permission to do that',
      code: 'FORBIDDEN',
      action,
    });
  }

  /*
   * THE RETURNED MIDDLEWARE CARRIES ITS ACTION.
   *
   * Every gate is the same function under the same name, so a test walking a
   * router's stack could see that a route was gated but not by WHAT — which is
   * the half that matters when the question is "is this exempted path still
   * protected, and by the right tier?". routes/rcm/rcmGuard.test.js reads it.
   */
  requirePermissionMiddleware.permissionAction = action;
  return requirePermissionMiddleware;
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
 * `exempt` skips BOTH gates. `writeExempt` skips only the write one, so the
 * path still needs `readAction` to be read — which is what a caller wants when
 * a specific POST is being widened to a lower tier rather than opened up. RCM's
 * queue routes use it: exempting them from both would mean a `GET` later added
 * at one of those paths was readable by any module-entitled role, because the
 * exemption is matched on PATH and express would happily route it.
 *
 * @param {string} readAction
 * @param {string} writeAction
 * @param {{ exempt?: RegExp[], writeExempt?: RegExp[] }} [opts]
 * @returns {import('express').RequestHandler}
 */
function requireReadWrite(readAction, writeAction, { exempt = [], writeExempt = [] } = {}) {
  const readGate = requirePermission(readAction, { exempt });
  const writeGate = requirePermission(writeAction, { exempt: [...exempt, ...writeExempt] });
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
  holdsPermission,
  permissionsForRole,
  requirePermission,
  requireReadWrite,
  requireSuperAdmin,
  isMachineCaller,
};
