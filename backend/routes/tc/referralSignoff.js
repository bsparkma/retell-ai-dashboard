'use strict';

/**
 * /api/tc/referrals/signoff — the doctor's "Awaiting sign-off" queue (queue
 * item 53, R2). Mounted with requirePermission('tc.referral_signoff'), which
 * PM ruling 2026-10-14 grants to the NEW `doctor` role and to `admin` — and
 * to nobody else. It is registered BEFORE the tc.full `/referrals` mount in
 * routes/tc/index.js, because a doctor holds no other TC action and the
 * tc.full mount would otherwise refuse them first.
 *
 *   GET  /summary        the nav badge and the arrival alert (never refused:
 *                        `enabled: false` when referrals is off here)
 *   GET  /queue          referrals awaiting sign-off, oldest first
 *   GET  /:id            one referral, with its history (what the doctor reads)
 *   POST /:id/approve    pending_signoff → approved
 *   POST /:id/decline    pending_signoff → declined, with a reason
 *
 * The minimum for a doctor, on purpose: they can read only referrals and
 * only from here. What else a doctor may see is not decided in this slice.
 *
 * NOTHING SENDS. Approved is where R2 stops; the UI says so.
 */

const express = require('express');

const { contract, requireOffice, parseBody, h, auditTc } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const tcReferrals = require('../../config/tcReferrals');
const store = require('./referralStore');
const transitions = require('./referralTransitions');

const { z, TcReferralDeclineRequest } = contract;

const router = express.Router();
router.use(requireOffice);

const ReferralId = z.string().uuid();

router.get(
  '/summary',
  h(async (req, res) => {
    const office = req.tcOffice;
    if (!(await tcReferrals.isEnabled(office))) {
      return res.json({ success: true, office, enabled: false, waiting: 0, newest: null });
    }
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      store.listReferrals(pool, office, { status: 'pending_signoff' })
    );
    const newest = rows[0] || null; // newest first
    return res.json({
      success: true,
      office,
      enabled: true,
      waiting: rows.length,
      newest: newest
        ? {
            referralId: String(newest.referral_id),
            patientName: newest.patient_name,
            at: new Date(newest.status_changed_at).toISOString(),
          }
        : null,
    });
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

router.get(
  '/queue',
  h(async (req, res) => {
    const office = req.tcOffice;
    const referrals = await tenantDb.withTenantDb(req, async (pool) => {
      const rows = await store.listReferrals(pool, office, { status: 'pending_signoff', oldestFirst: true });
      const names = await store.practiceNames(pool, office, rows);
      return rows.map((r) => store.toReferral(r, names.get(String(r.directory_entry_id)) ?? null));
    });
    await auditTc(req, 'READ', 'tc_referral', null, { office, sourceRef: 'signoff_queue' });
    return res.json({ success: true, referrals });
  })
);

router.get(
  '/:id',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ success: false, error: 'Invalid referral id', code: 'INVALID_ID' });
    const referral = await transitions.readBack(req, id.data);
    if (!referral) return res.status(404).json({ success: false, error: 'Referral not found', code: 'NOT_FOUND' });
    await auditTc(req, 'READ', 'tc_referral', id.data, { office: req.tcOffice });
    return res.json({ success: true, referral });
  })
);

router.post(
  '/:id/approve',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ success: false, error: 'Invalid referral id', code: 'INVALID_ID' });
    const out = await transitions.applyVerb(req, { referralId: id.data, verb: 'approve' });
    return res.status(out.status).json(out.body);
  })
);

router.post(
  '/:id/decline',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ success: false, error: 'Invalid referral id', code: 'INVALID_ID' });
    const body = parseBody(res, TcReferralDeclineRequest, req.body);
    if (!body) return undefined;
    const out = await transitions.applyVerb(req, { referralId: id.data, verb: 'decline', note: body.reason });
    return res.status(out.status).json(out.body);
  })
);

module.exports = router;
