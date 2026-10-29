'use strict';

/**
 * /api/platform/hyg-staff — the Practice staff page (hygienists).
 *
 *   GET    /?office=                  this office's hygienists, active first
 *   POST   /?office=                  add one
 *   PUT    /:id?office=               change name, licence, sign-ins
 *   POST   /:id/deactivate?office=    active = false (there is no delete)
 *   POST   /:id/reactivate?office=    active = true
 *
 * THE GATE is the Users page's: `requirePermission('admin.all')`, applied at
 * the mount in server.js — ABOVE the /api/platform super_admin mount, so the
 * office manager reaches this and nothing else under /api/platform. A
 * hygienist is refused (403) before any handler runs: the people whose names
 * and licences print on a chart note do not edit them.
 *
 * THE OFFICE is `?office=`, validated against the frozen keys by the hygiene
 * module's own `requireOffice`, and it is in every WHERE clause. A body never
 * names an office, and an id from the other office reads as not found.
 *
 * AUDIT: one row per write, success and refusal alike, in this practice's own
 * log — resource_type 'hyg_staff', resource_id the row's id, the office, and
 * `prior_state` saying what the write replaced, from a closed vocabulary:
 *
 *   create      NULL                       nothing replaced
 *   edit        edited:<fields>            fields ∈ name, licence, sign_ins, joined
 *                                          by '_' in that order; edited:none when
 *                                          the save changed nothing
 *   deactivate  active                     it was active
 *   reactivate  inactive                   it was inactive
 *
 * Never the name, licence or sign-in itself: the audit CHECK admits slugs only,
 * and this platform never copies typed text into the trail. Listing is a
 * config read and is not audited, like the Users page's.
 *
 * HONEST STATES: every write answers with the row AS READ BACK. A write whose
 * row cannot be read back answers 500 SAVE_NOT_CONFIRMED, never success.
 *
 * Staff, not patients: nothing here is PHI. No Open Dental call anywhere.
 */

const express = require('express');

const contract = require('../hyg/contract.gen.cjs');
const tenantDb = require('../platform/tenantDb');
const { audit, AuditError } = require('../platform/audit');
const { requireOffice } = require('./hyg/helpers');
const staffStore = require('../services/hyg/staffStore');

const router = express.Router();

const IdSchema = contract.z.string().uuid();

function fail(res, status, error, code, extra = {}) {
  return res.status(status).json({ success: false, error, code, ...extra });
}

function actorEmail(req) {
  return String((req.user && req.user.email) || '').trim().toLowerCase();
}

/** Async handler with the platform's error shape. */
function h(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error('[hygstaff] ' + req.method + ' failed:', err && err.message ? err.message : err);
      if (!res.headersSent) {
        if (err instanceof AuditError) fail(res, 500, 'Audit trail write failed', 'AUDIT_FAILED');
        else fail(res, 500, 'Could not save the practice staff change', 'INTERNAL_ERROR');
      }
    }
  };
}

/** The body, parsed by the shared schema, or a 400 naming the field. */
function parseInput(res, body) {
  const parsed = contract.HygStaffInputSchema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.join('.') : 'body';
  fail(res, 400, `${field}: ${issue ? issue.message : 'is not valid'}`, 'INVALID_BODY', { field });
  return null;
}

/** `:id` as a uuid, or a 404 (a malformed id names no row). */
function idFrom(req, res) {
  const parsed = IdSchema.safeParse(req.params.id);
  if (parsed.success) return parsed.data;
  fail(res, 404, 'No such staff member in this office', 'STAFF_NOT_FOUND');
  return null;
}

function writeAudit(req, { action, resourceId, result, priorState = null }) {
  return audit(req, {
    action,
    resourceType: 'hyg_staff',
    resourceId: resourceId || null,
    result,
    office: req.hygOffice,
    sourceRef: null,
    priorState,
  });
}

/**
 * The SUCCESS audit row for a write that has already landed. Fail-closed like
 * every audit, but a refusal here must not read as "nothing was saved": the row
 * IS saved, so the answer says that, and what to do.
 */
async function auditSaved(req, res, entry) {
  try {
    await writeAudit(req, { ...entry, result: 'SUCCESS' });
    return true;
  } catch (err) {
    if (!(err instanceof AuditError)) throw err;
    console.error('[hygstaff] saved, but the audit write failed:', err.message);
    fail(
      res,
      500,
      'The change was saved, but its audit entry could not be written. Reload to see it, and tell your administrator.',
      'SAVED_AUDIT_FAILED'
    );
    return false;
  }
}

/** Which fields an edit replaced, as the prior_state slug. */
function editedSlug(prior, next) {
  const fields = [];
  if (prior.fullName !== next.fullName) fields.push('name');
  if ((prior.license || null) !== (next.license || null)) fields.push('licence');
  if (JSON.stringify(prior.signInIds) !== JSON.stringify(next.signInIds)) fields.push('sign_ins');
  return 'edited:' + (fields.length > 0 ? fields.join('_') : 'none');
}

/** A store refusal as the response, after its audit row. */
async function refuse(req, res, { action, resourceId, outcome }) {
  await writeAudit(req, { action, resourceId, result: 'ERROR' });
  if (outcome.code === 'NOT_FOUND') {
    return fail(res, 404, 'No such staff member in this office', 'STAFF_NOT_FOUND');
  }
  if (outcome.code === 'SIGN_IN_TAKEN') {
    return fail(
      res,
      409,
      'Another person in this office already signs in as ' + outcome.taken.join(', ') +
        '. Each sign-in can belong to one person only.',
      'SIGN_IN_TAKEN',
      { taken: outcome.taken }
    );
  }
  return fail(
    res,
    500,
    'The change was sent but could not be read back, so it is not confirmed. Reload to see what was saved.',
    'SAVE_NOT_CONFIRMED'
  );
}

router.use(requireOffice);

router.get(
  '/',
  h(async (req, res) => {
    const office = req.hygOffice;
    const staff = await tenantDb.withTenantDb(req, (pool) => staffStore.listForOffice(pool, office));
    return res.json({ success: true, office, staff, usingBuiltInList: staff.length === 0 });
  })
);

router.post(
  '/',
  h(async (req, res) => {
    const input = parseInput(res, req.body);
    if (!input) return undefined;
    const office = req.hygOffice;
    const outcome = await tenantDb.withTenantDb(req, (pool) =>
      staffStore.create(pool, { office, input, actor: actorEmail(req) })
    );
    if (!outcome.ok) return refuse(req, res, { action: 'CREATE', resourceId: null, outcome });
    if (!(await auditSaved(req, res, { action: 'CREATE', resourceId: outcome.staff.id }))) return undefined;
    return res.status(201).json({ success: true, staff: outcome.staff });
  })
);

router.put(
  '/:id',
  h(async (req, res) => {
    const id = idFrom(req, res);
    if (!id) return undefined;
    const input = parseInput(res, req.body);
    if (!input) return undefined;
    const office = req.hygOffice;
    const outcome = await tenantDb.withTenantDb(req, (pool) =>
      staffStore.update(pool, { office, id, input, actor: actorEmail(req) })
    );
    if (!outcome.ok) return refuse(req, res, { action: 'UPDATE', resourceId: id, outcome });
    const audited = await auditSaved(req, res, {
      action: 'UPDATE',
      resourceId: id,
      priorState: editedSlug(outcome.prior, outcome.staff),
    });
    if (!audited) return undefined;
    return res.json({ success: true, staff: outcome.staff });
  })
);

for (const [verb, active] of [['deactivate', false], ['reactivate', true]]) {
  router.post(
    `/:id/${verb}`,
    h(async (req, res) => {
      const id = idFrom(req, res);
      if (!id) return undefined;
      const office = req.hygOffice;
      const outcome = await tenantDb.withTenantDb(req, (pool) =>
        staffStore.setActive(pool, { office, id, active, actor: actorEmail(req) })
      );
      if (!outcome.ok) return refuse(req, res, { action: 'UPDATE', resourceId: id, outcome });
      const audited = await auditSaved(req, res, {
        action: 'UPDATE',
        resourceId: id,
        priorState: outcome.prior.active ? 'active' : 'inactive',
      });
      if (!audited) return undefined;
      return res.json({ success: true, staff: outcome.staff });
    })
  );
}

module.exports = router;
