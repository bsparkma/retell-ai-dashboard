'use strict';

/**
 * /api/tc/referrals — referral foundations (queue item 52, R1).
 *
 *   GET    /status                is referrals on for this office? (never refused)
 *   GET    /directory             the office's specialists (?includeInactive=true)
 *   POST   /directory             add one
 *   PUT    /directory/:id         edit one (including active / inactive)
 *   DELETE /directory/:id         remove one that no referral names (else 409)
 *   GET    /settings              the two policies, what is in force and why
 *   PUT    /settings              change them — practice admin only
 *
 * GUARDRAILS
 *   - DARK. `tc_referrals_enabled` off for the office → 403 REFERRALS_DISABLED
 *     on everything but /status, which answers `enabled: false` so the
 *     Settings page can hide the section without treating "off" as an error.
 *   - NOTHING SENDS. No email, no fax, no Open Dental read or write. R1 is the
 *     directory and the settings; referrals themselves arrive in R2.
 *   - Office from `?office=` through requireOffice, in every WHERE. A body can
 *     never name an office or an entry's owner.
 *   - Every change is audited (append-only audit_log) after it persisted, and
 *     every answer is the row the database returned.
 */

const express = require('express');

const { contract, requireOffice, actorEmail, parseBody, h, auditTc } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const { holdsPermission } = require('../../config/permissions');
const tcReferrals = require('../../config/tcReferrals');
const store = require('./referralStore');

const { z, TcReferralDirectoryInput, TcReferralSettingsRequest } = contract;

const router = express.Router();
router.use(requireOffice);

const EntryId = z.string().uuid();

/** Postgres foreign-key violation (a referral named the entry in between). */
const PG_FK_VIOLATION = '23503';

router.get(
  '/status',
  h(async (req, res) => {
    res.json({ success: true, office: req.tcOffice, enabled: await tcReferrals.isEnabled(req.tcOffice) });
  })
);

// Everything below is dark until the office is switched on.
// (Plain middleware, not h(): h() does not pass `next`.)
router.use(async (req, res, next) => {
  try {
    if (await tcReferrals.isEnabled(req.tcOffice)) return next();
    return res.status(403).json({
      success: false,
      error: 'Referrals are not switched on for this office.',
      code: 'REFERRALS_DISABLED',
    });
  } catch (err) {
    return next(err);
  }
});

function badId(res) {
  return res.status(400).json({ success: false, error: 'Invalid directory entry id', code: 'INVALID_ID' });
}

function notFound(res) {
  return res.status(404).json({ success: false, error: 'Directory entry not found', code: 'NOT_FOUND' });
}

// ── The directory ───────────────────────────────────────────────────────────

router.get(
  '/directory',
  h(async (req, res) => {
    const includeInactive = String(req.query.includeInactive || '') === 'true';
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      store.listDirectory(pool, req.tcOffice, { includeInactive })
    );
    res.json({ success: true, entries: rows.map(store.toEntry) });
  })
);

router.post(
  '/directory',
  h(async (req, res) => {
    const input = parseBody(res, TcReferralDirectoryInput, req.body);
    if (!input) return undefined;
    const row = await tenantDb.withTenantDb(req, (pool) =>
      store.insertEntry(pool, req.tcOffice, input, actorEmail(req))
    );
    if (!row) throw new Error('directory entry was not stored');
    await auditTc(req, 'CREATE', 'tc_referral_directory', String(row.entry_id), { office: req.tcOffice });
    return res.status(201).json({ success: true, entry: store.toEntry(row) });
  })
);

router.put(
  '/directory/:id',
  h(async (req, res) => {
    const id = EntryId.safeParse(req.params.id);
    if (!id.success) return badId(res);
    const input = parseBody(res, TcReferralDirectoryInput, req.body);
    if (!input) return undefined;
    const office = req.tcOffice;
    const result = await tenantDb.withTenantDb(req, async (pool) => {
      const before = await store.findEntry(pool, office, id.data);
      if (!before) return null;
      const after = await store.updateEntry(pool, office, id.data, input, actorEmail(req));
      return after ? { before, after } : null;
    });
    if (!result) return notFound(res);
    await auditTc(req, 'UPDATE', 'tc_referral_directory', id.data, {
      office,
      priorState: result.before.active ? 'active' : 'inactive',
    });
    return res.json({ success: true, entry: store.toEntry(result.after) });
  })
);

router.delete(
  '/directory/:id',
  h(async (req, res) => {
    const id = EntryId.safeParse(req.params.id);
    if (!id.success) return badId(res);
    const office = req.tcOffice;
    let result;
    try {
      result = await tenantDb.withTenantDb(req, async (pool) => {
        const before = await store.findEntry(pool, office, id.data);
        if (!before) return { missing: true };
        if (await store.entryInUse(pool, office, id.data)) return { inUse: true };
        const removed = await store.deleteEntry(pool, office, id.data);
        return removed ? { removed } : { missing: true };
      });
    } catch (err) {
      if (err && err.code === PG_FK_VIOLATION) result = { inUse: true };
      else throw err;
    }
    if (result.missing) return notFound(res);
    if (result.inUse) {
      return res.status(409).json({
        success: false,
        error: 'A referral names this specialist, so it cannot be deleted. Mark it inactive instead.',
        code: 'DIRECTORY_ENTRY_IN_USE',
      });
    }
    await auditTc(req, 'DELETE', 'tc_referral_directory', id.data, {
      office,
      priorState: result.removed.active ? 'active' : 'inactive',
    });
    return res.json({ success: true });
  })
);

// ── Settings ────────────────────────────────────────────────────────────────

async function settingsPayload(req) {
  const office = req.tcOffice;
  const row = await tenantDb.withTenantDb(req, (pool) => store.readSettingsRow(pool, office));
  const policies = store.resolvePolicies(office, row);
  return {
    success: true,
    office,
    signoffRequired: policies.signoffRequired,
    autosendOnApproval: policies.autosendOnApproval,
    canEdit: holdsPermission(req, 'admin.all'),
    updatedBy: row ? row.updated_by : null,
    updatedAt: row && row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/** `signoff_on:autosend_off` — a slug inside audit_log's prior_state grammar. */
function settingsSlug(p) {
  return `signoff_${p.signoffRequired.value ? 'on' : 'off'}:autosend_${p.autosendOnApproval.value ? 'on' : 'off'}`;
}

router.get(
  '/settings',
  h(async (req, res) => {
    res.json(await settingsPayload(req));
  })
);

router.put(
  '/settings',
  h(async (req, res) => {
    if (!holdsPermission(req, 'admin.all')) {
      return res.status(403).json({
        success: false,
        error: 'Only a practice admin can change the referral settings.',
        code: 'FORBIDDEN',
      });
    }
    const body = parseBody(res, TcReferralSettingsRequest, req.body);
    if (!body) return undefined;
    const office = req.tcOffice;
    const before = await tenantDb.withTenantDb(req, async (pool) => {
      const row = await store.readSettingsRow(pool, office);
      // Store the OFFICE's choice: what it already chose (or the defaults),
      // with this request's changes on top. An env pin still wins on read.
      const stored = {
        signoffRequired: row ? row.signoff_required : store.POLICIES.signoffRequired.defaultValue,
        autosendOnApproval: row ? row.autosend_on_approval : store.POLICIES.autosendOnApproval.defaultValue,
      };
      const next = {
        signoffRequired: body.signoffRequired ?? stored.signoffRequired,
        autosendOnApproval: body.autosendOnApproval ?? stored.autosendOnApproval,
      };
      const written = await store.upsertSettings(pool, office, next, actorEmail(req));
      if (!written) throw new Error('referral settings were not stored');
      return store.resolvePolicies(office, row);
    });
    await auditTc(req, 'UPDATE', 'tc_referral_settings', office, { office, priorState: settingsSlug(before) });
    res.json(await settingsPayload(req));
  })
);

module.exports = router;
