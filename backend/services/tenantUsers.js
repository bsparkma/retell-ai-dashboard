'use strict';

/**
 * Tenant user management — THE one rule set behind both doors.
 *
 *   routes/users.js     /api/users                                  a practice admin, own practice
 *   routes/platform.js  /api/platform/practices/:tenantId/users     a super_admin, any practice
 *
 * Both routes are thin: they decide WHICH tenant, WHO is acting and WHERE the
 * audit row goes, then hand those to the functions here. Nothing below reads a
 * request, so neither door can smuggle a tenant id, an actor or a privilege in
 * through a body. Four rules, enforced once:
 *
 *  1. LAST ADMIN. A tenant must keep at least one active admin. Enforced inside
 *     the UPDATE's WHERE clause (registry.updateTenantUser) so two admins
 *     demoting each other concurrently cannot both succeed.
 *  2. PLATFORM ADMIN. Only a super_admin may modify a row belonging to a
 *     platform_admin. A tenant admin must not be able to disable the account
 *     that administers the platform above them.
 *  3. SELF. Nobody changes their own role or deactivates themselves. Both are
 *     foot-guns with no legitimate use: a demotion you can perform is a
 *     demotion you cannot undo. This binds a super_admin too.
 *  4. TENANT SCOPE. Every read and write is scoped by the tenant id inside the
 *     SQL, not by a check afterwards. An admin of one tenant naming an email in
 *     another simply finds nothing.
 *
 * Audit: create and update write one row each (CREATE / UPDATE,
 * resource_type 'app_user', resource_id = the affected email), including the
 * refused updates. The door supplies the writer, because the door knows whose
 * log the row belongs in. A failed audit write THROWS out of here — fail closed.
 *
 * Every function returns an Outcome rather than writing a response, so the two
 * doors cannot drift on status codes or wording.
 */

const registry = require('../platform/registry');
const userContext = require('../platform/userContext');
const { TENANT_ROLES } = require('../config/permissions');
const { getAllOfficeConfigs, UNMAPPED_OFFICE } = require('../config/officeAgents');

/**
 * @typedef {{ email: string, isSuperAdmin: boolean }} Actor
 *   Who is acting. `email` is lowercased by the caller's door.
 * @typedef {(entry: { action: string, resourceType: string, resourceId: string, result: string }) => Promise<unknown>} AuditWriter
 *   Writes one row into the RIGHT tenant's audit_log. Must throw on failure.
 * @typedef {{ email: string, role: string, status: string, lastLoginAt: string|null, homeOffice: string|null }} UserDto
 * @typedef {{ ok: true, status: number, user: UserDto }
 *         | { ok: false, status: number, error: string, code: string, extra?: Record<string, unknown> }} Outcome
 */

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

/** @returns {Outcome} */
function refuse(status, error, code, extra) {
  return extra ? { ok: false, status, error, code, extra } : { ok: false, status, error, code };
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

/**
 * Parse a requested home office: null/'' clears, a known key sets, anything
 * else is refused.
 * @returns {{ value: string|null } | { refusal: Outcome }}
 */
function parseHomeOffice(raw) {
  // null (or an empty string from a "—" select) CLEARS it. That is a real
  // choice, not a missing value: temp@ is meant to have no home office.
  if (raw === null || raw === '') return { value: null };
  const office = String(raw);
  const known = assignableOffices().map((o) => o.officeId);
  if (!known.includes(office)) {
    return {
      refusal: refuse(400, `Home office must be one of: ${known.join(', ')}`, 'INVALID_HOME_OFFICE'),
    };
  }
  return { value: office };
}

/**
 * Rules 2 and 3, shared by every write path.
 * @param {Actor} actor
 * @returns {Promise<Outcome | null>}
 */
async function checkWriteAllowed(actor, targetEmail, patch) {
  const target = String(targetEmail || '').trim().toLowerCase();

  // Rule 3 — self. Status changes to yourself are refused too: deactivating
  // yourself is strictly worse than demoting yourself, and the prompt's "no
  // self role change" would be a thin rule if the same lockout were reachable
  // through the status toggle.
  if (target === actor.email) {
    if (typeof patch.role === 'string') {
      return refuse(409, 'You cannot change your own role. Ask another admin.', 'SELF_ROLE_CHANGE');
    }
    if (typeof patch.status === 'string' && patch.status !== 'active') {
      return refuse(
        409,
        'You cannot deactivate your own account. Ask another admin.',
        'SELF_DEACTIVATE'
      );
    }
  }

  // Rule 2 — platform admin rows are off-limits below the platform tier.
  if (actor.isSuperAdmin !== true) {
    const platform = await registry.getPlatformAdminByEmail(target);
    if (platform && platform.status === 'active') {
      return refuse(
        403,
        'That account is a platform administrator and can only be changed by one.',
        'PLATFORM_ADMIN_PROTECTED'
      );
    }
  }

  return null;
}

/**
 * One tenant's roster, plus the vocabularies the editor renders.
 *
 * Not audited: listing is a config read, consistent with the other admin reads.
 * @param {string} tenantId
 * @param {Actor} actor
 */
async function listUsers(tenantId, actor) {
  const rows = await registry.listTenantUsers(tenantId);
  return {
    users: rows.map(toDto),
    // The SPA renders these as the role picker's options and marks the
    // caller's own row, so it never has to hardcode either.
    roles: TENANT_ROLES,
    // Same reasoning for the home-office picker: the page must not carry its
    // own copy of the office list.
    offices: assignableOffices(),
    actor: actor.email,
  };
}

/**
 * Pre-provision a user.
 *
 * `homeOffice` is `undefined` when the door does not offer one at create time
 * (/api/users never has), which leaves the column null exactly as before.
 *
 * @param {{ tenantId: string, actor: Actor, audit: AuditWriter,
 *           email: unknown, role: unknown, homeOffice?: unknown }} input
 * @returns {Promise<Outcome>}
 */
async function createUser({ tenantId, audit, email: rawEmail, role: rawRole, homeOffice }) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const role = String(rawRole || '').trim();

  if (!EMAIL_RX.test(email)) {
    return refuse(400, 'Enter a valid email address', 'INVALID_EMAIL');
  }
  if (!TENANT_ROLES.includes(role)) {
    return refuse(400, `Role must be one of: ${TENANT_ROLES.join(', ')}`, 'INVALID_ROLE');
  }

  let office = null;
  if (homeOffice !== undefined) {
    const parsed = parseHomeOffice(homeOffice);
    if ('refusal' in parsed) return parsed.refusal;
    office = parsed.value;
  }

  const created =
    office === null
      ? await registry.createTenantUser(tenantId, email, role)
      : await registry.createTenantUser(tenantId, email, role, office);
  if (!created) {
    return refuse(409, 'That email already has a row in this practice', 'USER_EXISTS');
  }

  await audit({
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

  return { ok: true, status: 201, user: toDto(created) };
}

/**
 * Change a user's role, status and/or home office.
 *
 * @param {{ tenantId: string, actor: Actor, audit: AuditWriter,
 *           email: unknown, body: Record<string, unknown> }} input
 * @returns {Promise<Outcome>}
 */
async function updateUser({ tenantId, actor, audit, email: rawEmail, body }) {
  const target = String(rawEmail || '').trim().toLowerCase();

  /** @type {{ role?: string, status?: string, home_office?: string|null }} */
  const patch = {};
  if (body.role !== undefined) {
    const role = String(body.role).trim();
    if (!TENANT_ROLES.includes(role)) {
      return refuse(400, `Role must be one of: ${TENANT_ROLES.join(', ')}`, 'INVALID_ROLE');
    }
    patch.role = role;
  }
  if (body.status !== undefined) {
    const status = String(body.status).trim();
    if (!STATUSES.includes(status)) {
      return refuse(400, `Status must be one of: ${STATUSES.join(', ')}`, 'INVALID_STATUS');
    }
    patch.status = status;
  }
  if (body.homeOffice !== undefined) {
    const parsed = parseHomeOffice(body.homeOffice);
    if ('refusal' in parsed) return parsed.refusal;
    patch.home_office = parsed.value;
  }
  if (Object.keys(patch).length === 0) {
    return refuse(400, 'Nothing to change — send a role, a status or a home office', 'EMPTY_PATCH');
  }

  const existing = await registry.getTenantUser(tenantId, target);
  if (!existing) {
    return refuse(404, 'No such user in this practice', 'USER_NOT_FOUND');
  }

  const refusal = await checkWriteAllowed(actor, target, patch);
  if (refusal) {
    await audit({
      action: 'UPDATE',
      resourceType: 'app_user',
      resourceId: existing.email,
      result: 'UNAUTHORIZED',
    });
    return refusal;
  }

  const updated = await registry.updateTenantUser(tenantId, target, patch);
  if (!updated) {
    // The row exists (checked above) and the write still matched nothing, so
    // the last-admin guard inside the UPDATE is the only thing that can have
    // refused it. Say so plainly rather than reporting a generic failure.
    const admins = await registry.countActiveTenantAdmins(tenantId);
    await audit({
      action: 'UPDATE',
      resourceType: 'app_user',
      resourceId: existing.email,
      result: 'UNAUTHORIZED',
    });
    return refuse(
      409,
      'This is the last active admin for this practice. Give someone else the admin role first.',
      'LAST_ADMIN',
      { activeAdmins: admins }
    );
  }

  await audit({
    action: 'UPDATE',
    resourceType: 'app_user',
    resourceId: updated.email,
    result: 'SUCCESS',
  });

  // Same reasoning as create: the change is real now, so stop serving the
  // old role from the TTL cache. The UI still says "within a minute" because
  // OTHER replicas keep their own caches until their TTL expires.
  userContext.clearCache();

  return { ok: true, status: 200, user: toDto(updated) };
}

module.exports = {
  listUsers,
  createUser,
  updateUser,
  assignableOffices,
  STATUSES,
};
