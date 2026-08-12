'use strict';

/**
 * /api/users — tenant user management (Roles PR B).
 *
 *   GET    /            list this tenant's app_user rows
 *   POST   /            pre-provision a user (email + role)
 *   PATCH  /:email      change role and/or status
 *
 * Every route is gated `admin.all` at the mount in server.js, so a super_admin
 * passes automatically and nobody below tenant 'admin' gets here at all.
 *
 * THE UI IS NOT THE GUARD. Every rule below is enforced here, server-side,
 * because the Users page is exactly the surface where a determined person will
 * try the API directly. Four rules:
 *
 *  1. LAST ADMIN. A tenant must keep at least one active admin. Enforced inside
 *     the UPDATE's WHERE clause (registry.updateTenantUser) so two admins
 *     demoting each other concurrently cannot both succeed.
 *  2. PLATFORM ADMIN. Only a super_admin may modify a row belonging to a
 *     platform_admin. A tenant admin must not be able to disable the account
 *     that administers the platform above them.
 *  3. SELF. Nobody changes their own role or deactivates themselves. Both are
 *     foot-guns with no legitimate use: a demotion you can perform is a
 *     demotion you cannot undo.
 *  4. TENANT SCOPE. Every read and write is scoped by req.tenant.id inside the
 *     SQL, not by a check afterwards. An admin of one tenant naming an email in
 *     another simply finds nothing.
 *
 * Audit: create and update write one row each (CREATE / UPDATE,
 * resource_type 'app_user', resource_id = the affected email). An email is an
 * identifier, not patient PHI — the same class of value as the actor column
 * every audit row already carries. The audit_log.action CHECK only admits
 * READ/CREATE/UPDATE/DELETE; nothing here invents a verb. Listing is a
 * config read and is not audited, consistent with the other admin reads.
 */

const express = require('express');

const registry = require('../platform/registry');
const userContext = require('../platform/userContext');
const { audit } = require('../platform/audit');
const { TENANT_ROLES } = require('../config/permissions');
const { getAllOfficeConfigs, UNMAPPED_OFFICE } = require('../config/officeAgents');

const router = express.Router();

/** app_user.status vocabulary (the CHECK constraint from PR A). */
const STATUSES = Object.freeze(['active', 'disabled']);

/**
 * The offices a person can be assigned a HOME OFFICE in.
 *
 * Read from config at call time, not frozen at module load, so opening an
 * office stays the one-line config change config/odOffices.js promises. The
 * 'unknown' bucket is excluded twice over — getAllOfficeConfigs already drops
 * it, and the filter below says so out loud: it is where Mango calls on an
 * unmapped phone line land, not a place anybody works, and a home office
 * pointing at it would resolve to no practice at all.
 *
 * This is also why home_office has no database CHECK — the valid set lives
 * here, with the roster, rather than in a migration.
 * @returns {Array<{ officeId: string, officeName: string }>}
 */
function assignableOffices() {
  return getAllOfficeConfigs()
    .filter((o) => o.officeId !== UNMAPPED_OFFICE)
    .map((o) => ({ officeId: o.officeId, officeName: o.officeName }));
}

/**
 * Deliberately permissive: one @, no whitespace, a dot in the domain. Real
 * address validity is proven by signing in, not by a regex, and a stricter
 * pattern here would reject valid addresses and block a legitimate invite.
 */
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Structured refusal, matching the platform's error shape. */
function fail(res, status, error, code, extra = {}) {
  return res.status(status).json({ success: false, error, code, ...extra });
}

/** The row shape the SPA renders. Named columns only — no row spreading. */
function toDto(row) {
  return {
    email: row.email,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    // A DEFAULT for their office picker, never a restriction — see the
    // home_office migration. null (or a blank column) means "no home office",
    // which is the right answer for a shared account like temp@.
    homeOffice: row.home_office || null,
  };
}

/** The acting user's email, lowercased. Guaranteed present under the gate. */
function actorEmail(req) {
  return String((req.user && req.user.email) || '').trim().toLowerCase();
}

/**
 * Rules 2 and 3, shared by every write path.
 * @returns {Promise<{ error: string, code: string, status: number } | null>}
 */
async function checkWriteAllowed(req, targetEmail, patch) {
  const actor = actorEmail(req);
  const target = String(targetEmail || '').trim().toLowerCase();

  // Rule 3 — self. Status changes to yourself are refused too: deactivating
  // yourself is strictly worse than demoting yourself, and the prompt's "no
  // self role change" would be a thin rule if the same lockout were reachable
  // through the status toggle.
  if (target === actor) {
    if (typeof patch.role === 'string') {
      return {
        status: 409,
        code: 'SELF_ROLE_CHANGE',
        error: 'You cannot change your own role. Ask another admin.',
      };
    }
    if (typeof patch.status === 'string' && patch.status !== 'active') {
      return {
        status: 409,
        code: 'SELF_DEACTIVATE',
        error: 'You cannot deactivate your own account. Ask another admin.',
      };
    }
  }

  // Rule 2 — platform admin rows are off-limits below the platform tier.
  if (req.isSuperAdmin !== true) {
    const platform = await registry.getPlatformAdminByEmail(target);
    if (platform && platform.status === 'active') {
      return {
        status: 403,
        code: 'PLATFORM_ADMIN_PROTECTED',
        error: 'That account is a platform administrator and can only be changed by one.',
      };
    }
  }

  return null;
}

// ── GET / ───────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const rows = await registry.listTenantUsers(req.tenant.id);
    return res.json({
      success: true,
      users: rows.map(toDto),
      // The SPA renders these as the role picker's options and marks the
      // caller's own row, so it never has to hardcode either.
      roles: TENANT_ROLES,
      // Same reasoning for the home-office picker: the page must not carry its
      // own copy of the office list.
      offices: assignableOffices(),
      actor: actorEmail(req),
    });
  } catch (err) {
    console.error('[users] list failed:', err && err.message ? err.message : err);
    return fail(res, 503, 'Could not load users', 'USERS_UNAVAILABLE');
  }
});

// ── POST / ──────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const role = String(body.role || '').trim();

  if (!EMAIL_RX.test(email)) {
    return fail(res, 400, 'Enter a valid email address', 'INVALID_EMAIL');
  }
  if (!TENANT_ROLES.includes(role)) {
    return fail(res, 400, `Role must be one of: ${TENANT_ROLES.join(', ')}`, 'INVALID_ROLE');
  }

  try {
    const created = await registry.createTenantUser(req.tenant.id, email, role);
    if (!created) {
      return fail(res, 409, 'That email already has a row in this practice', 'USER_EXISTS');
    }

    await audit(req, {
      action: 'CREATE',
      resourceType: 'app_user',
      resourceId: created.email,
      result: 'SUCCESS',
    });

    // The new row is not in anyone's cache yet, but an email that was ALREADY
    // being served by the bootstrap fallback has a cached miss. Drop it so the
    // person picks up their real role on their next request rather than at the
    // end of the TTL.
    userContext.clearCache();

    return res.status(201).json({ success: true, user: toDto(created) });
  } catch (err) {
    console.error('[users] create failed:', err && err.message ? err.message : err);
    return fail(res, 503, 'Could not add that user', 'USER_CREATE_FAILED');
  }
});

// ── PATCH /:email ───────────────────────────────────────────────────────────

router.patch('/:email', async (req, res) => {
  const target = String(req.params.email || '').trim().toLowerCase();
  const body = req.body || {};

  /** @type {{ role?: string, status?: string, home_office?: string|null }} */
  const patch = {};
  if (body.role !== undefined) {
    const role = String(body.role).trim();
    if (!TENANT_ROLES.includes(role)) {
      return fail(res, 400, `Role must be one of: ${TENANT_ROLES.join(', ')}`, 'INVALID_ROLE');
    }
    patch.role = role;
  }
  if (body.status !== undefined) {
    const status = String(body.status).trim();
    if (!STATUSES.includes(status)) {
      return fail(res, 400, `Status must be one of: ${STATUSES.join(', ')}`, 'INVALID_STATUS');
    }
    patch.status = status;
  }
  if (body.homeOffice !== undefined) {
    // null (or an empty string from a "—" select) CLEARS it. That is a real
    // choice, not a missing value: temp@ is meant to have no home office.
    if (body.homeOffice === null || body.homeOffice === '') {
      patch.home_office = null;
    } else {
      const office = String(body.homeOffice);
      const known = assignableOffices().map((o) => o.officeId);
      if (!known.includes(office)) {
        return fail(
          res,
          400,
          `Home office must be one of: ${known.join(', ')}`,
          'INVALID_HOME_OFFICE'
        );
      }
      patch.home_office = office;
    }
  }
  if (Object.keys(patch).length === 0) {
    return fail(res, 400, 'Nothing to change — send a role, a status or a home office', 'EMPTY_PATCH');
  }

  try {
    const existing = await registry.getTenantUser(req.tenant.id, target);
    if (!existing) {
      return fail(res, 404, 'No such user in this practice', 'USER_NOT_FOUND');
    }

    const refusal = await checkWriteAllowed(req, target, patch);
    if (refusal) {
      await audit(req, {
        action: 'UPDATE',
        resourceType: 'app_user',
        resourceId: existing.email,
        result: 'UNAUTHORIZED',
      });
      return fail(res, refusal.status, refusal.error, refusal.code);
    }

    const updated = await registry.updateTenantUser(req.tenant.id, target, patch);
    if (!updated) {
      // The row exists (checked above) and the write still matched nothing, so
      // the last-admin guard inside the UPDATE is the only thing that can have
      // refused it. Say so plainly rather than reporting a generic failure.
      const admins = await registry.countActiveTenantAdmins(req.tenant.id);
      await audit(req, {
        action: 'UPDATE',
        resourceType: 'app_user',
        resourceId: existing.email,
        result: 'UNAUTHORIZED',
      });
      return fail(
        res,
        409,
        'This is the last active admin for this practice. Give someone else the admin role first.',
        'LAST_ADMIN',
        { activeAdmins: admins }
      );
    }

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'app_user',
      resourceId: updated.email,
      result: 'SUCCESS',
    });

    // Same reasoning as create: the change is real now, so stop serving the
    // old role from the TTL cache. The UI still says "within a minute" because
    // OTHER replicas keep their own caches until their TTL expires.
    userContext.clearCache();

    return res.json({ success: true, user: toDto(updated) });
  } catch (err) {
    console.error('[users] update failed:', err && err.message ? err.message : err);
    return fail(res, 503, 'Could not update that user', 'USER_UPDATE_FAILED');
  }
});

module.exports = router;
