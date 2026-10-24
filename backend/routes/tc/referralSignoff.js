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
 *   GET  /:id/attachments[/:aid]   the referral's files, so the doctor can
 *                        look at the X-ray they are signing off (R4; every
 *                        view audited)
 *
 *   R6 (item 56):
 *   GET   /directory     the office's ACTIVE specialists — the doctor may pick
 *                        a different one; the directory itself stays tc.full
 *   GET   /providers     the office's ACTIVE providers (provider directory),
 *                        for the referring-provider pick; the list stays tc.full
 *   PATCH /:id/fields    the doctor edits specialist / urgency / reason / teeth
 *                        and their own note, while it awaits sign-off
 *   POST  /:id/return    pending_signoff → draft, with the doctor's question
 *                        (required) — shown to the submitter as
 *                        "Returned by Dr. — <comment>"
 *
 *   R6.2:
 *   POST  /:id/attachments  the doctor adds a file while it awaits sign-off,
 *                        through the R4 upload handler unchanged
 *
 * The minimum for a doctor, on purpose: they can read only referrals and
 * only from here. What else a doctor may see is not decided in this slice.
 *
 * R5: approving may EMAIL it, after the approval committed, when the office
 * has referral email on and its policy says to send on approval
 * (./referralSend.js sendAfterApproval). The approval succeeds either way; the
 * answer carries `autoSend` saying what the email did.
 */

const express = require('express');

const { contract, requireOffice, parseBody, h, auditTc } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const tcReferrals = require('../../config/tcReferrals');
const store = require('./referralStore');
const transitions = require('./referralTransitions');
const attachments = require('./referralAttachments');
const referralSend = require('./referralSend');
const providerStore = require('./providerStore');

const { z, TcReferralDeclineRequest, TcReferralDoctorEdit, TcReferralReturnRequest } = contract;

const router = express.Router();
router.use(requireOffice);

const ReferralId = z.string().uuid();

/**
 * What the sign-off surface may open: a referral waiting for sign-off, or one
 * that has been through it (so the doctor can see the result). Not drafts,
 * not cancelled ones — those are the TC's, not the doctor's.
 */
const SIGNOFF_READABLE = Object.freeze(['pending_signoff', 'approved', 'declined']);

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
    // "Newest" is the one that most recently ARRIVED for sign-off — a referral
    // withdrawn and resubmitted is a new arrival though it was created earlier.
    const arrived = (r) => new Date(r.status_changed_at).getTime();
    const newest = rows.reduce((best, r) => (best === null || arrived(r) > arrived(best) ? r : best), null);
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

// R6: who the doctor may send it to instead. Not PHI; read-only; active only.
router.get(
  '/directory',
  h(async (req, res) => {
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      store.listDirectory(pool, req.tcOffice, { includeInactive: false })
    );
    res.json({ success: true, entries: rows.map(store.toEntry) });
  })
);

// Provider directory: the referring provider the doctor may pick at sign-off.
// Not PHI; read-only; active only. The list itself is /api/tc/providers (tc.full).
router.get(
  '/providers',
  h(async (req, res) => {
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      providerStore.listProviders(pool, req.tcOffice, { includeInactive: false })
    );
    res.json({ success: true, entries: rows.map(providerStore.toEntry) });
  })
);

router.get(
  '/:id',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ success: false, error: 'Invalid referral id', code: 'INVALID_ID' });
    const referral = await transitions.readBack(req, id.data);
    if (!referral || !SIGNOFF_READABLE.includes(referral.status)) {
      return res.status(404).json({ success: false, error: 'Referral not found', code: 'NOT_FOUND' });
    }
    await auditTc(req, 'READ', 'tc_referral', id.data, { office: req.tcOffice });
    return res.json({ success: true, referral });
  })
);

// R4: the files of a referral the doctor may open (the same SIGNOFF_READABLE rule).
const signoffAttachmentOpts = {
  officeOf: (req) => req.tcOffice,
  referralIdOf: (req) => req.params.id,
  guard: (_req, ref) =>
    SIGNOFF_READABLE.includes(ref.status) ? null : [404, 'Referral not found', 'NOT_FOUND'],
};
router.get('/:id/attachments', h(attachments.listHandler(signoffAttachmentOpts)));
router.get('/:id/attachments/:attachmentId', h(attachments.viewHandler(signoffAttachmentOpts)));

// R6.2: the doctor may ADD a file while editing what they sign — the same R4
// handler (bytes sniffed, 10 MB cut by multer, ≤5 under the row lock, audited,
// 503 when storage is unconfigured), and only while it awaits sign-off, which
// is where the doctor may edit at all. The guard runs under the row lock.
router.post(
  '/:id/attachments',
  attachments.receiveFile,
  h(
    attachments.uploadHandler({
      ...signoffAttachmentOpts,
      guard: (_req, ref) => {
        if (!SIGNOFF_READABLE.includes(ref.status)) return [404, 'Referral not found', 'NOT_FOUND'];
        if (!contract.REFERRAL_DOCTOR_EDITABLE_STATUSES.includes(ref.status)) {
          return [409, 'Files can be added at sign-off only while the referral is awaiting it.', 'REFERRAL_LOCKED'];
        }
        return null;
      },
    })
  )
);

router.post(
  '/:id/approve',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ success: false, error: 'Invalid referral id', code: 'INVALID_ID' });
    const out = await transitions.applyVerb(req, { referralId: id.data, verb: 'approve' });
    if (out.status !== 200) return res.status(out.status).json(out.body);
    // R5: the approval has COMMITTED. If the office emails on approval (and
    // email is on), try now; whatever happens, the approval stands and the
    // answer says what the email did. A failure leaves it approved, with a
    // visible send_failed row and a retry in the hub.
    const auto = await referralSend.sendAfterApproval(req, { office: req.tcOffice, referralId: id.data });
    if (!auto) return res.json(out.body);
    return res.json({ ...out.body, referral: auto.referral || out.body.referral, autoSend: auto.outcome });
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

router.patch(
  '/:id/fields',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ success: false, error: 'Invalid referral id', code: 'INVALID_ID' });
    const fields = parseBody(res, TcReferralDoctorEdit, req.body);
    if (!fields) return undefined;
    const out = await transitions.editFields(req, { referralId: id.data, fields, kind: 'doctor_edit' });
    return res.status(out.status).json(out.body);
  })
);

router.post(
  '/:id/return',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ success: false, error: 'Invalid referral id', code: 'INVALID_ID' });
    const body = parseBody(res, TcReferralReturnRequest, req.body);
    if (!body) return undefined;
    const out = await transitions.applyVerb(req, { referralId: id.data, verb: 'return', note: body.comment });
    return res.status(out.status).json(out.body);
  })
);

module.exports = router;
