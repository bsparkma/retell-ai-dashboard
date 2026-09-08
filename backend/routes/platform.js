'use strict';

/**
 * /api/platform — the Platform Console (PR C).
 *
 *   GET    /practices                            the tenant catalog
 *   GET    /practices/:tenantId/modules          entitlement state, all four
 *   PUT    /practices/:tenantId/modules/:module  the kill switch
 *   GET    /practices/:tenantId/users            roster, READ-ONLY
 *   GET    /practices/:tenantId/audit            paginated audit_log read
 *   GET    /retention                            the call-store window + policy source
 *   PUT    /retention                            change it (30 | 60 | 90)
 *   GET    /retention/impact?days=N              how much shortening would cost
 *   GET    /hyg-offices                          the hygiene pilot switch, per office
 *   PUT    /hyg-offices/:office                  turn one office's hygiene on or off
 *
 * THE GATE. Every route here sits behind `requireSuperAdmin()`, applied once at
 * the mount in server.js. There is deliberately no module guard: entitlement
 * answers "did this practice buy the product?", and the console is the thing
 * that ANSWERS that question — gating it on a module would be circular.
 *
 * WHAT IS NOT HERE, and why:
 *
 *   - CREATING A TENANT. Provisioning a practice means a database, Key Vault
 *     secrets and migrations; it stays the `platform/provisionTenant.js`
 *     runbook. A button that half-provisions is worse than no button.
 *   - EDITING USERS. Deliberate scope call: this console LISTS a practice's
 *     roster and nothing more. Role and status changes stay on /admin/users,
 *     where the last-admin, platform-admin and self-change rules already live
 *     and are already tested. Two write paths into app_user would mean two
 *     places for those rules to be enforced, and the second one is where they
 *     would eventually not be.
 *   - PRUNE / PURGE. Those already exist at POST /api/admin/call-store/prune
 *     and /purge-legacy, already behind requireSuperAdmin(). The console calls
 *     them where they are rather than growing a second copy of a job that
 *     destroys records.
 *
 * THE TENANT ID IS VALIDATED, NEVER TRUSTED. `:tenantId` is resolved against
 * the registry by `loadPractice` below before any route touches a tenant
 * database. That is what makes the audit reader and the audit writer safe to
 * hand an id that arrived in a URL.
 */

const express = require('express');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const { auditForTenant, audit } = require('../platform/audit');
const retentionConfig = require('../config/retention');
const hygPilot = require('../config/hygPilot');
const odOffices = require('../config/odOffices');
const retentionScheduler = require('../services/retentionScheduler');
const unifiedCallStore = require('../services/unifiedCallStore');
const callRetention = require('../services/callRetention');
const { MODULE_CATALOG, isKnownModule } = require('../config/modules');
const { TENANT_ROLES } = require('../config/permissions');

const router = express.Router();

/** Structured refusal, matching the platform's error shape. */
function fail(res, status, error, code, extra = {}) {
  return res.status(status).json({ success: false, error, code, ...extra });
}

/** The acting super_admin's email, lowercased. Guaranteed present under the gate. */
function actorEmail(req) {
  return String((req.user && req.user.email) || '').trim().toLowerCase();
}

/**
 * Resolve `:tenantId` against the tenant catalog, or 404.
 *
 * The console picks from what GET /practices returned, so a miss here is either
 * a stale tab or somebody typing ids by hand. Both get the same honest 404 —
 * and, more importantly, neither gets as far as `tenantDb.getTenantPool`, which
 * is the call that would otherwise turn an arbitrary string into a database
 * connection attempt.
 *
 * @type {import('express').RequestHandler}
 */
async function loadPractice(req, res, next) {
  try {
    const practice = await registry.getTenantById(String(req.params.tenantId || ''));
    if (!practice) {
      return fail(res, 404, 'No such practice', 'PRACTICE_NOT_FOUND');
    }
    // @ts-expect-error — request augmentation, same pattern as req.tenant.
    req.practice = practice;
    return next();
  } catch (err) {
    console.error('[platform] practice lookup failed:', err && err.message ? err.message : err);
    return fail(res, 503, 'Could not reach the control plane', 'CONTROL_PLANE_UNAVAILABLE');
  }
}

// ── practices ───────────────────────────────────────────────────────────────

/**
 * GET /practices
 *
 * Identity + entitlements + roster size for every tenant, in one call, because
 * the list is the console's landing view and an N+1 of module lookups behind it
 * would be a request per practice for data that is four rows wide.
 *
 * Not audited: this is a config read over the control plane and contains no
 * PHI, consistent with how /api/users treats listing.
 */
router.get('/practices', async (req, res) => {
  try {
    const tenants = await registry.listTenantsWithUserCounts();

    const practices = await Promise.all(
      tenants.map(async (t) => {
        const rows = await registry.listTenantModules(t.tenant_id);
        const byName = new Map(rows.map((r) => [r.module, r.enabled]));
        return {
          tenantId: t.tenant_id,
          slug: t.slug,
          displayName: t.display_name,
          status: t.status,
          createdAt: t.created_at ? new Date(t.created_at).toISOString() : null,
          userCount: t.user_count,
          // Composed against the catalog, not read off the table: a practice
          // that has never had RCM has no RCM row, and "absent" must render as
          // off rather than as a missing toggle.
          modules: MODULE_CATALOG.map((m) => ({
            module: m.module,
            label: m.label,
            blurb: m.blurb,
            enabled: byName.get(m.module) === true,
          })),
        };
      })
    );

    return res.json({ success: true, practices });
  } catch (err) {
    console.error('[platform] practices failed:', err && err.message ? err.message : err);
    return fail(res, 503, 'Could not load practices', 'CONTROL_PLANE_UNAVAILABLE');
  }
});

// ── module entitlements ─────────────────────────────────────────────────────

/**
 * GET /practices/:tenantId/modules
 *
 * The same composition as above for one practice — what the console re-reads
 * after a toggle so the switch reflects the database rather than the click.
 */
router.get('/practices/:tenantId/modules', loadPractice, async (req, res) => {
  try {
    const rows = await registry.listTenantModules(req.practice.tenant_id);
    const byName = new Map(rows.map((r) => [r.module, r.enabled]));
    return res.json({
      success: true,
      modules: MODULE_CATALOG.map((m) => ({
        module: m.module,
        label: m.label,
        blurb: m.blurb,
        enabled: byName.get(m.module) === true,
      })),
    });
  } catch (err) {
    console.error('[platform] modules read failed:', err && err.message ? err.message : err);
    return fail(res, 503, 'Could not load modules', 'CONTROL_PLANE_UNAVAILABLE');
  }
});

/**
 * PUT /practices/:tenantId/modules/:module   { enabled: boolean }
 *
 * The entitlement kill switch. Turning `tc` off hides the TC module for every
 * user at that practice on their next request — tenantContext rebuilds
 * `req.tenant.modules` per request, so there is no cache to wait out and no
 * deploy to schedule.
 *
 * THREE THINGS IN ORDER, and the order is the honesty:
 *   1. write,
 *   2. audit into the TARGET practice's log (not the operator's — see
 *      auditForTenant),
 *   3. re-read from the database and return THAT.
 *
 * A failed audit propagates and the response is a 500. The write has already
 * landed at that point, which is deliberate: an entitlement change nobody can
 * see in the trail should look like a failure to the person who made it, so
 * they go and check. Silently reporting success would be the worse lie.
 */
router.put('/practices/:tenantId/modules/:module', loadPractice, async (req, res) => {
  const moduleName = String(req.params.module || '');
  const enabled = req.body ? req.body.enabled : undefined;

  if (!isKnownModule(moduleName)) {
    return fail(res, 400, `Unknown module '${moduleName}'`, 'UNKNOWN_MODULE');
  }
  if (typeof enabled !== 'boolean') {
    return fail(res, 400, 'enabled must be true or false', 'INVALID_ENABLED');
  }

  const tenantId = req.practice.tenant_id;

  try {
    const written = await registry.setTenantModule(tenantId, moduleName, enabled);
    if (!written) {
      return fail(res, 500, 'The change did not take', 'MODULE_WRITE_FAILED');
    }

    await auditForTenant(req, tenantId, {
      action: 'UPDATE',
      resourceType: 'tenant_module',
      resourceId: moduleName,
      result: 'SUCCESS',
    });

    // Read back rather than echo. `written` came from RETURNING so it is
    // already the database's answer, but re-reading the whole set is what the
    // console renders, and it costs one indexed query.
    const rows = await registry.listTenantModules(tenantId);
    const byName = new Map(rows.map((r) => [r.module, r.enabled]));

    return res.json({
      success: true,
      modules: MODULE_CATALOG.map((m) => ({
        module: m.module,
        label: m.label,
        blurb: m.blurb,
        enabled: byName.get(m.module) === true,
      })),
    });
  } catch (err) {
    console.error('[platform] module toggle failed:', err && err.message ? err.message : err);
    return fail(res, 500, 'Could not change that module', 'MODULE_TOGGLE_FAILED');
  }
});

// ── users (read-only) ───────────────────────────────────────────────────────

/**
 * GET /practices/:tenantId/users
 *
 * READ-ONLY BY DESIGN — see the header. Shape deliberately mirrors
 * GET /api/users so the console can reuse the same row rendering, minus every
 * control that would write.
 */
router.get('/practices/:tenantId/users', loadPractice, async (req, res) => {
  try {
    const rows = await registry.listTenantUsers(req.practice.tenant_id);
    return res.json({
      success: true,
      users: rows.map((r) => ({
        email: r.email,
        role: r.role,
        status: r.status,
        lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
        homeOffice: r.home_office || null,
      })),
      roles: TENANT_ROLES,
      // Where the writes actually live, so the console can link there instead
      // of growing its own editor.
      manageAt: '/admin/users',
    });
  } catch (err) {
    console.error('[platform] users read failed:', err && err.message ? err.message : err);
    return fail(res, 503, 'Could not load users', 'USERS_UNAVAILABLE');
  }
});

// ── audit ───────────────────────────────────────────────────────────────────

/** Page size ceiling. A console filter must not be able to ask for the table. */
const AUDIT_MAX_LIMIT = 100;
const AUDIT_DEFAULT_LIMIT = 50;

/** The vocabularies audit_log's CHECK constraints allow. */
const AUDIT_ACTIONS = Object.freeze(['READ', 'CREATE', 'UPDATE', 'DELETE']);
const AUDIT_RESULTS = Object.freeze(['SUCCESS', 'UNAUTHORIZED', 'ERROR']);

/** Parse a bounded non-negative integer from a query string. */
function intParam(raw, fallback, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return max === undefined ? n : Math.min(n, max);
}

/** An ISO-ish date from the client, or null. Rejected rather than coerced. */
function dateParam(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * GET /practices/:tenantId/audit
 *
 * Server-side paginated read of one practice's append-only audit_log, newest
 * first. Filters: action, result, resourceType, resourceId (exact), from, to.
 *
 * READ-ONLY, AND STRUCTURALLY SO. The application connects as the
 * least-privilege `carein_app` role, which holds INSERT and SELECT on this
 * table and nothing else (migrations-tenant/1780453117650_audit_log.js). There
 * is no UPDATE or DELETE to write here even if somebody wanted one — the grant
 * would refuse it.
 *
 * The tiebreak on audit_id is load-bearing: `ts` defaults to now() and a busy
 * moment produces rows sharing a timestamp, which an ORDER BY ts alone would
 * page through non-deterministically — the same row twice, another never.
 *
 * Not itself audited. It is a read of identifiers (no PHI values are ever in
 * this table), and a trail that recorded every look at itself would bury the
 * events it exists to preserve.
 */
router.get('/practices/:tenantId/audit', loadPractice, async (req, res) => {
  const limit = Math.max(1, intParam(req.query.limit, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT));
  const offset = intParam(req.query.offset, 0);

  const action = String(req.query.action ?? '').trim().toUpperCase();
  const result = String(req.query.result ?? '').trim().toUpperCase();
  const resourceType = String(req.query.resourceType ?? '').trim();
  const resourceId = String(req.query.resourceId ?? '').trim();
  const from = dateParam(req.query.from);
  const to = dateParam(req.query.to);

  if (action && !AUDIT_ACTIONS.includes(action)) {
    return fail(res, 400, `action must be one of: ${AUDIT_ACTIONS.join(', ')}`, 'INVALID_ACTION');
  }
  if (result && !AUDIT_RESULTS.includes(result)) {
    return fail(res, 400, `result must be one of: ${AUDIT_RESULTS.join(', ')}`, 'INVALID_RESULT');
  }
  if (req.query.from && !from) {
    return fail(res, 400, 'from is not a date', 'INVALID_FROM');
  }
  if (req.query.to && !to) {
    return fail(res, 400, 'to is not a date', 'INVALID_TO');
  }

  // Built as a parallel array of clauses + params so every filter is
  // parameterized. No value from the request is ever concatenated into SQL.
  const where = ['tenant_id = $1'];
  const params = [req.practice.tenant_id];
  const add = (clause, value) => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };

  if (action) add('action = $?', action);
  if (result) add('result = $?', result);
  if (resourceType) add('resource_type = $?', resourceType);
  if (resourceId) add('resource_id = $?', resourceId);
  if (from) add('ts >= $?', from.toISOString());
  if (to) add('ts <= $?', to.toISOString());

  const whereSql = where.join(' AND ');

  try {
    const pool = await tenantDb.getTenantPool(req.practice.tenant_id);

    const [page, total] = await Promise.all([
      pool.query(
        `SELECT audit_id, ts, user_id, action, resource_type, resource_id,
                ip, result, endpoint, office, source_ref
           FROM audit_log
          WHERE ${whereSql}
          ORDER BY ts DESC, audit_id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT count(*) AS n FROM audit_log WHERE ${whereSql}`, params),
    ]);

    return res.json({
      success: true,
      limit,
      offset,
      total: Number(total.rows[0].n),
      entries: page.rows.map((r) => ({
        auditId: r.audit_id,
        ts: r.ts ? new Date(r.ts).toISOString() : null,
        actor: r.user_id,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        ip: r.ip,
        result: r.result,
        endpoint: r.endpoint,
        office: r.office,
        sourceRef: r.source_ref,
      })),
    });
  } catch (err) {
    console.error('[platform] audit read failed:', err && err.message ? err.message : err);
    return fail(res, 503, 'Could not read the audit log', 'AUDIT_UNAVAILABLE');
  }
});

// ── retention ───────────────────────────────────────────────────────────────

/**
 * The retention panel's view of the world.
 *
 * `policy` carries the SOURCE, not just the number, because "30 because nobody
 * has chosen" and "30 because somebody chose it on Tuesday" are different
 * facts and the operator is about to make a decision on the difference.
 */
function retentionPayload() {
  const stats = unifiedCallStore.getStats();
  return {
    policy: retentionConfig.policyState(),
    scheduler: retentionScheduler.getStatus(),
    store: {
      totalCalls: stats.totalCalls,
      liveCalls: stats.liveCalls,
      prunedCalls: stats.prunedCalls,
    },
  };
}

/**
 * GET /retention
 *
 * Refreshes from the control plane before answering. This is the settings page
 * — showing a cached number here is exactly where a stale read would mislead
 * someone into "setting" a value it already had, or worse, into thinking their
 * last change did not take.
 */
router.get('/retention', async (req, res) => {
  const refreshed = await retentionConfig.refreshFromDb();
  const payload = retentionPayload();
  // Reported, not thrown. The panel is still useful when the control plane is
  // down — it just has to say so rather than present the fallback as the policy.
  return res.json({ success: true, ...payload, controlPlaneError: refreshed.error });
});

/**
 * PUT /retention   { days: 30 | 60 | 90 }
 *
 * Takes effect at the NEXT scheduled run, not now — `runNow` is a separate,
 * explicit button. What changes immediately is the number the next prune will
 * read.
 *
 * The audit row goes to the ACTING super_admin's own tenant, unlike the module
 * toggle above. The call store is one JSON file for the whole process (see the
 * platform_setting migration), so this change belongs to no single practice and
 * filing it under one would misrepresent its blast radius.
 */
router.put('/retention', async (req, res) => {
  const days = req.body ? req.body.days : undefined;

  if (!retentionConfig.isAllowedConsoleDays(days)) {
    return fail(
      res,
      400,
      `Retention must be one of: ${retentionConfig.CONSOLE_RETENTION_DAYS.join(', ')} days`,
      'INVALID_RETENTION_DAYS'
    );
  }

  try {
    await retentionConfig.persistRetentionDays(days, actorEmail(req));

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'platform_setting',
      resourceId: retentionConfig.SETTING_KEY,
      result: 'SUCCESS',
    });

    // A stored window can switch retention ON in an environment whose
    // CALL_RETENTION_DAYS was 0, and start() is only consulted at boot — so the
    // job would stay unarmed until the next deploy. start() is a no-op when a
    // job is already scheduled or retention is off, so calling it is safe.
    if (retentionConfig.isEnabled()) retentionScheduler.start();

    return res.json({ success: true, ...retentionPayload() });
  } catch (err) {
    const code = err && err.code ? err.code : 'RETENTION_WRITE_FAILED';
    console.error('[platform] retention write failed:', err && err.message ? err.message : err);
    const status = code === 'INVALID_RETENTION_DAYS' ? 400 : 500;
    return fail(res, status, 'Could not save the retention window', code);
  }
});

/**
 * GET /retention/impact?days=N
 *
 * How many LIVE calls would fall outside a proposed window — the number behind
 * "shortening to 30 days will prune 412 calls at the next run".
 *
 * Computed server-side with `callRetention.selectExpired`, the very function
 * the pruner uses to choose its victims. Not a re-implementation: a count the
 * console showed that disagreed with what the pruner then did would be worse
 * than no count at all.
 *
 * Reads the store; destroys nothing.
 */
router.get('/retention/impact', (req, res) => {
  const days = Number.parseInt(String(req.query.days ?? ''), 10);
  if (!Number.isInteger(days) || days < 0) {
    return fail(res, 400, 'days must be a non-negative whole number', 'INVALID_DAYS');
  }

  const current = retentionConfig.retentionDays();
  const now = new Date();
  const wouldPrune = callRetention.selectExpired(unifiedCallStore, {
    now,
    retentionDays: days,
  }).length;

  return res.json({
    success: true,
    days,
    currentDays: current,
    // A shorter window reaches further back, so only shortening has a cost.
    // Extending is reported as 0 and paired with the warning below, because the
    // honest answer to "what does extending do for the calls already gone?" is
    // nothing — a stub cannot be un-stubbed.
    shortening: days < current,
    wouldPrune,
    alreadyPruned: unifiedCallStore.getStats().prunedCalls,
  });
});

// ── the hygiene pilot switch ────────────────────────────────────────────────
//
// PER OFFICE, and that is a DIFFERENT AXIS from the module entitlement above.
//
//   entitlement (PUT /practices/:tenantId/modules/hyg) — did this PRACTICE buy
//     the hygiene product? One answer per tenant.
//   this switch  (PUT /hyg-offices/:office)            — is hygiene live at this
//     LOCATION? One answer per office, inside a practice that has bought it.
//
// Both must be on for a hygienist to load a day. Confusing them is the failure
// this pair of endpoints and the panel above them are shaped to prevent, which
// is why they are separate routes with separate payloads rather than one
// combined toggle that would have to explain itself in a tooltip.

/** The switch panel's whole view, freshly composed. */
function hygOfficesPayload() {
  return {
    offices: odOffices.hygSwitchState(),
    setting: hygPilot.settingMeta(),
  };
}

/**
 * GET /hyg-offices
 *
 * Refreshes from the control plane before answering, for the same reason
 * GET /retention does: this is the settings page, and a cached value here is
 * exactly where a stale read would tell somebody their change did not take.
 */
router.get('/hyg-offices', async (req, res) => {
  const refreshed = await hygPilot.refreshFromDb();
  // Reported, not thrown. The panel is still useful when the control plane is
  // down — it just has to say so rather than present the fallback as the policy.
  return res.json({ success: true, ...hygOfficesPayload(), controlPlaneError: refreshed.error });
});

/**
 * PUT /hyg-offices/:office   { enabled: boolean }
 *
 * TAKES EFFECT IMMEDIATELY, not at some next tick. `maxReplicas` is 1, so the
 * console write and the request path are the same process: `persistHygEnabled`
 * refreshes this module's cache inline, and `odOffices.hygOdBlockReason()` reads
 * that cache synchronously on the very next `/api/hyg` request. A switch whose
 * OFF direction waited for a refresh interval would not be a kill switch.
 * `routes/hygPilotSwitch.test.js` pins exactly that, with no restart, sleep or
 * cache reset between the write and the refused request.
 *
 * The audit row goes to the ACTING super_admin's own tenant, like the retention
 * write and unlike the module toggle — the office registry is platform-wide and
 * has no tenant dimension, so filing it under one practice would misrepresent
 * its blast radius. `office` names which location moved, and `priorState` says
 * what it moved FROM: "turned off at 09:14" and "was already off" are different
 * facts, and only one of them explains an incident.
 */
router.put('/hyg-offices/:office', async (req, res) => {
  const office = String(req.params.office || '');
  const enabled = req.body ? req.body.enabled : undefined;

  if (typeof enabled !== 'boolean') {
    return fail(res, 400, 'enabled must be true or false', 'INVALID_HYG_ENABLED');
  }

  // Read BEFORE the write, so the audit row can say what it replaced.
  const before = odOffices.hygSwitchState().find((o) => o.officeKey === office);
  if (!before) {
    return fail(res, 404, 'No such office', 'INVALID_OFFICE');
  }

  try {
    await hygPilot.persistHygEnabled(office, enabled, actorEmail(req));

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'platform_setting',
      resourceId: hygPilot.SETTING_KEY,
      result: 'SUCCESS',
      office,
      // A slug from the switch's own two-value vocabulary — the column refuses
      // anything that is not slug-shaped, which is what keeps the trail from
      // becoming a copy of somebody's prose.
      priorState: before.enabled ? 'on' : 'off',
    });

    return res.json({ success: true, ...hygOfficesPayload() });
  } catch (err) {
    const code = err && err.code ? err.code : 'HYG_SWITCH_WRITE_FAILED';
    console.error('[platform] hygiene switch write failed:', err && err.message ? err.message : err);
    const status = code === 'INVALID_OFFICE' || code === 'INVALID_HYG_ENABLED' ? 400 : 500;
    return fail(res, status, 'Could not save the hygiene switch', code);
  }
});

module.exports = router;
