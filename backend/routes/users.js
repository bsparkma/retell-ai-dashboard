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
 * THE UI IS NOT THE GUARD — and neither is this file. The four rules (last
 * admin, platform admin, self, tenant scope) live once in
 * services/tenantUsers.js, which the Developer Console's per-practice routes in
 * routes/platform.js call too. One rule set, two doors. This door supplies:
 *
 *   - the tenant:  req.tenant.id, from tenantContext — never from the body;
 *   - the actor:   req.user.email and req.isSuperAdmin;
 *   - the audit:   audit(req, …), i.e. this practice's own log.
 *
 * Audit: create and update write one row each (CREATE / UPDATE,
 * resource_type 'app_user', resource_id = the affected email). An email is an
 * identifier, not patient PHI — the same class of value as the actor column
 * every audit row already carries. The audit_log.action CHECK only admits
 * READ/CREATE/UPDATE/DELETE; nothing here invents a verb. Listing is a
 * config read and is not audited, consistent with the other admin reads.
 */

const express = require('express');

const tenantUsers = require('../services/tenantUsers');
const { audit } = require('../platform/audit');

const router = express.Router();

/** Structured refusal, matching the platform's error shape. */
function fail(res, status, error, code, extra = {}) {
  return res.status(status).json({ success: false, error, code, ...extra });
}

/** Write a service Outcome as the response. */
function send(res, outcome) {
  if (!outcome.ok) {
    return fail(res, outcome.status, outcome.error, outcome.code, outcome.extra);
  }
  return res.status(outcome.status).json({ success: true, user: outcome.user });
}

/** Who is acting, as the service needs it. Guaranteed present under the gate. */
function actorOf(req) {
  return {
    email: String((req.user && req.user.email) || '').trim().toLowerCase(),
    isSuperAdmin: req.isSuperAdmin === true,
  };
}

// ── GET / ───────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const roster = await tenantUsers.listUsers(req.tenant.id, actorOf(req));
    return res.json({ success: true, ...roster });
  } catch (err) {
    console.error('[users] list failed:', err && err.message ? err.message : err);
    return fail(res, 503, 'Could not load users', 'USERS_UNAVAILABLE');
  }
});

// ── POST / ──────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const body = req.body || {};
  try {
    const outcome = await tenantUsers.createUser({
      tenantId: req.tenant.id,
      actor: actorOf(req),
      audit: (entry) => audit(req, entry),
      email: body.email,
      role: body.role,
      // homeOffice deliberately not passed: this door has never set one at
      // create time, and it stays that way — practice admins see no change.
    });
    return send(res, outcome);
  } catch (err) {
    console.error('[users] create failed:', err && err.message ? err.message : err);
    return fail(res, 503, 'Could not add that user', 'USER_CREATE_FAILED');
  }
});

// ── PATCH /:email ───────────────────────────────────────────────────────────

router.patch('/:email', async (req, res) => {
  try {
    const outcome = await tenantUsers.updateUser({
      tenantId: req.tenant.id,
      actor: actorOf(req),
      audit: (entry) => audit(req, entry),
      email: req.params.email,
      body: req.body || {},
    });
    return send(res, outcome);
  } catch (err) {
    console.error('[users] update failed:', err && err.message ? err.message : err);
    return fail(res, 503, 'Could not update that user', 'USER_UPDATE_FAILED');
  }
});

module.exports = router;
