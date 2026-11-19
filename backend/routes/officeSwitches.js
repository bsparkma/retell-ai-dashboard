'use strict';

/**
 * The per-office switch routes, ONE rule set behind TWO doors (MT-2c).
 *
 *   GET    /hyg-offices                               the hygiene pilot switch, per office
 *   PUT    /hyg-offices/:office                       turn one office's hygiene on or off
 *   GET    /tc-checkout-offices                       the TC checkout handoff switch (item 50)
 *   PUT    /tc-checkout-offices/:office
 *   GET    /tc-od-sync-offices                        the TC Open Dental pipeline sync (CO-4b)
 *   PUT    /tc-od-sync-offices/:office
 *   GET    /tc-auto-checkout-offices                  checkout cards from today's schedule (CO-5b)
 *   PUT    /tc-auto-checkout-offices/:office
 *   GET    /tc-referrals-offices                      the TC referrals switch (item 52)
 *   PUT    /tc-referrals-offices/:office
 *   GET    /tc-referral-email-offices                 referral email to the specialist (R5)
 *   PUT    /tc-referral-email-offices/:office
 *   GET    /tc-referral-patient-email-offices         the referral PATIENT email (R5b)
 *   PUT    /tc-referral-patient-email-offices/:office
 *
 * THE DOORS. This router carries no gate of its own; each mount brings one:
 *
 *   /api/platform/*                 requireSuperAdmin() — the Developer Console
 *                                   (routes/platform.js mounts this router)
 *   /api/admin/office-settings/*    requirePermission('admin.all') plus the
 *                                   module guard — the practice's /admin page
 *                                   (routes/adminOfficeSettings.js)
 *
 * Moved here VERBATIM from routes/platform.js so the two doors cannot drift:
 * the same validation, the same persist() (dual-write + read-back), the same
 * audit row, the same honest answer read back from the database. Ruling A
 * (Beau): /admin is practice-level, so a practice's admins manage their
 * practice's offices; the Developer Console stays developer-only.
 *
 * TENANT AND OFFICE. The tenant is ALWAYS the session's
 * (platform/sessionTenant.js), never a parameter, header or body field. The
 * office is the only thing a request names, and it must be one of THAT
 * tenant's offices (realOffices(tenant) / hygSwitchState(tenant)) or the
 * answer is 404 INVALID_OFFICE — the same body whether the office does not
 * exist at all or belongs to another practice, so the refusal is not an oracle
 * for another tenant's office keys.
 *
 * AUDIT. audit(req) files the row in the SESSION tenant's log, whichever door
 * it came through: the acting user's own practice.
 *
 * NOT HERE, ON PURPOSE: the process-wide keys (tc_email_enabled,
 * tc_sms_enabled, call_retention_days). They stay Developer-Console-only;
 * GET/PUT /retention lives in routes/platform.js, which the /admin door never
 * reaches.
 */

const express = require('express');

const { audit } = require('../platform/audit');
const hygPilot = require('../config/hygPilot');
const tcCheckout = require('../config/tcCheckout');
const tcReferrals = require('../config/tcReferrals');
const tcOdSync = require('../config/tcOdSync');
const tcAutoCheckout = require('../config/tcAutoCheckout');
const tcReferralEmail = require('../config/tcReferralEmail');
const tcReferralPatientEmail = require('../config/tcReferralPatientEmail');
const { realOffices } = require('../config/tcOfficeSwitch');
const { sessionTenantSlug } = require('../platform/sessionTenant');
const odOffices = require('../config/odOffices');

const router = express.Router();

/** Structured refusal, matching the platform's error shape. */
function fail(res, status, error, code, extra = {}) {
  return res.status(status).json({ success: false, error, code, ...extra });
}

/** The acting user's email, lowercased. Guaranteed present under either gate. */
function actorEmail(req) {
  return String((req.user && req.user.email) || '').trim().toLowerCase();
}

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

/**
 * The switch panel's whole view, freshly composed, for the SESSION tenant
 * (MT-2b: platform/sessionTenant.js — never a tenant the request names).
 * @param {string|null} tenantSlug
 */
function hygOfficesPayload(tenantSlug) {
  return {
    offices: odOffices.hygSwitchState(tenantSlug),
    setting: hygPilot.settingMeta(tenantSlug),
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
  const refreshed = await hygPilot.refreshFromDb(sessionTenantSlug(req));
  // Reported, not thrown. The panel is still useful when the control plane is
  // down — it just has to say so rather than present the fallback as the policy.
  return res.json({ success: true, ...hygOfficesPayload(sessionTenantSlug(req)), controlPlaneError: refreshed.error });
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
 * The audit row goes to the ACTING user's own (session) tenant, like the retention
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
  const before = odOffices.hygSwitchState(sessionTenantSlug(req)).find((o) => o.officeKey === office);
  if (!before) {
    return fail(res, 404, 'No such office', 'INVALID_OFFICE');
  }

  try {
    await hygPilot.persistHygEnabled(sessionTenantSlug(req), office, enabled, actorEmail(req));

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

    return res.json({ success: true, ...hygOfficesPayload(sessionTenantSlug(req)) });
  } catch (err) {
    const code = err && err.code ? err.code : 'HYG_SWITCH_WRITE_FAILED';
    console.error('[platform] hygiene switch write failed:', err && err.message ? err.message : err);
    const status =
      code === 'INVALID_OFFICE' || code === 'INVALID_HYG_ENABLED'
        ? 400
        : code === 'OFFICE_SETTING_TENANT_NOT_WRITABLE'
          ? 409
          : 500;
    return fail(res, status, 'Could not save the hygiene switch', code);
  }
});

// ── the TC checkout handoff switch (item 50) ────────────────────────────────
//
// Per office, like the hygiene switch above, and for the same reason it is not
// the module entitlement: TC is bought per practice, but whether the hygiene
// visit's "Alert checkout" (and the visit Send's handoff) is live is decided
// per LOCATION. config/tcOfficeSwitch.js holds the precedence — an env `=false`
// always wins, a stored row beats an env `=true`, the floor is OFF — and
// `officeState()` reports which layer answered, so the panel can say when the
// environment, not this switch, is in charge.

/** The panel's whole view, freshly composed. */
/** @param {string|null} tenantSlug the SESSION tenant (MT-2b) */
function tcCheckoutPayload(tenantSlug) {
  return {
    offices: realOffices(tenantSlug).map((office) => tcCheckout.officeState(tenantSlug, office)),
    settingKey: tcCheckout.settingKey,
  };
}

/** GET /tc-checkout-offices — refreshed from the control plane before answering. */
router.get('/tc-checkout-offices', async (req, res) => {
  const refreshed = await tcCheckout.refreshFromDb(sessionTenantSlug(req));
  return res.json({ success: true, ...tcCheckoutPayload(sessionTenantSlug(req)), controlPlaneError: refreshed.error });
});

/**
 * PUT /tc-checkout-offices/:office   { enabled: boolean }
 *
 * `persist` writes, then re-reads from the database, so the answer is what was
 * stored. Audited to the acting user's own (session) tenant like the hygiene
 * switch, with `priorState` on|off.
 */
router.put('/tc-checkout-offices/:office', async (req, res) => {
  const office = String(req.params.office || '');
  const enabled = req.body ? req.body.enabled : undefined;
  if (typeof enabled !== 'boolean') {
    return fail(res, 400, 'enabled must be true or false', 'INVALID_BODY');
  }
  if (!realOffices(sessionTenantSlug(req)).includes(office)) {
    return fail(res, 404, 'No such office', 'INVALID_OFFICE');
  }

  try {
    await tcCheckout.refreshFromDb(sessionTenantSlug(req));
    const before = tcCheckout.officeState(sessionTenantSlug(req), office);
    await tcCheckout.persist(sessionTenantSlug(req), office, enabled, actorEmail(req));
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'platform_setting',
      resourceId: tcCheckout.settingKey,
      result: 'SUCCESS',
      office,
      priorState: before.enabled ? 'on' : 'off',
    });
    return res.json({ success: true, ...tcCheckoutPayload(sessionTenantSlug(req)) });
  } catch (err) {
    const code = err && err.code ? err.code : 'TC_CHECKOUT_SWITCH_WRITE_FAILED';
    console.error('[platform] checkout switch write failed:', err && err.message ? err.message : err);
    const status =
      code === 'INVALID_OFFICE' || code === 'INVALID_BODY'
        ? 400
        : code === 'OFFICE_SETTING_TENANT_NOT_WRITABLE'
          ? 409
          : 500;
    return fail(res, status, 'Could not save the checkout switch', code);
  }
});

// ── TC Open Dental pipeline sync switch (CO-4b) — the checkout switch's shape ─
//
// Per office, default OFF, TC_OD_SYNC_ENABLED_<OFFICE>=false supreme. When on,
// "Sync now" and the nightly pass read the office's anchored appointments
// (GET only) and move cases on unambiguous Open Dental signals.

/** @param {string|null} tenantSlug the SESSION tenant (MT-2b) */
function tcOdSyncPayload(tenantSlug) {
  return {
    offices: realOffices(tenantSlug).map((office) => tcOdSync.officeState(tenantSlug, office)),
    settingKey: tcOdSync.settingKey,
  };
}

/** GET /tc-od-sync-offices — refreshed from the control plane before answering. */
router.get('/tc-od-sync-offices', async (req, res) => {
  const refreshed = await tcOdSync.refreshFromDb(sessionTenantSlug(req));
  return res.json({ success: true, ...tcOdSyncPayload(sessionTenantSlug(req)), controlPlaneError: refreshed.error });
});

/** PUT /tc-od-sync-offices/:office   { enabled: boolean } — written, read back, audited with priorState on|off. */
router.put('/tc-od-sync-offices/:office', async (req, res) => {
  const office = String(req.params.office || '');
  const enabled = req.body ? req.body.enabled : undefined;
  if (typeof enabled !== 'boolean') {
    return fail(res, 400, 'enabled must be true or false', 'INVALID_BODY');
  }
  if (!realOffices(sessionTenantSlug(req)).includes(office)) {
    return fail(res, 404, 'No such office', 'INVALID_OFFICE');
  }

  try {
    await tcOdSync.refreshFromDb(sessionTenantSlug(req));
    const before = tcOdSync.officeState(sessionTenantSlug(req), office);
    await tcOdSync.persist(sessionTenantSlug(req), office, enabled, actorEmail(req));
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'platform_setting',
      resourceId: tcOdSync.settingKey,
      result: 'SUCCESS',
      office,
      priorState: before.enabled ? 'on' : 'off',
    });
    return res.json({ success: true, ...tcOdSyncPayload(sessionTenantSlug(req)) });
  } catch (err) {
    const code = err && err.code ? err.code : 'TC_OD_SYNC_SWITCH_WRITE_FAILED';
    console.error('[platform] OD sync switch write failed:', err && err.message ? err.message : err);
    const status =
      code === 'INVALID_OFFICE' || code === 'INVALID_BODY'
        ? 400
        : code === 'OFFICE_SETTING_TENANT_NOT_WRITABLE'
          ? 409
          : 500;
    return fail(res, status, 'Could not save the Open Dental sync switch', code);
  }
});

// ── TC checkout cards from today's schedule (CO-5b) — the same shape ─────────
//
// Per office, default OFF, TC_AUTO_CHECKOUT_ENABLED_<OFFICE>=false supreme.
// When on (and checkout is on), the Checkout page's schedule check reads the
// office's appointments today (GET only) and makes a Waiting card for each
// completed non-hygiene appointment.

/** @param {string|null} tenantSlug the SESSION tenant (MT-2b) */
function tcAutoCheckoutPayload(tenantSlug) {
  return {
    offices: realOffices(tenantSlug).map((office) => tcAutoCheckout.officeState(tenantSlug, office)),
    settingKey: tcAutoCheckout.settingKey,
  };
}

/** GET /tc-auto-checkout-offices — refreshed from the control plane before answering. */
router.get('/tc-auto-checkout-offices', async (req, res) => {
  const refreshed = await tcAutoCheckout.refreshFromDb(sessionTenantSlug(req));
  return res.json({ success: true, ...tcAutoCheckoutPayload(sessionTenantSlug(req)), controlPlaneError: refreshed.error });
});

/** PUT /tc-auto-checkout-offices/:office   { enabled: boolean } — written, read back, audited with priorState on|off. */
router.put('/tc-auto-checkout-offices/:office', async (req, res) => {
  const office = String(req.params.office || '');
  const enabled = req.body ? req.body.enabled : undefined;
  if (typeof enabled !== 'boolean') {
    return fail(res, 400, 'enabled must be true or false', 'INVALID_BODY');
  }
  if (!realOffices(sessionTenantSlug(req)).includes(office)) {
    return fail(res, 404, 'No such office', 'INVALID_OFFICE');
  }

  try {
    await tcAutoCheckout.refreshFromDb(sessionTenantSlug(req));
    const before = tcAutoCheckout.officeState(sessionTenantSlug(req), office);
    await tcAutoCheckout.persist(sessionTenantSlug(req), office, enabled, actorEmail(req));
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'platform_setting',
      resourceId: tcAutoCheckout.settingKey,
      result: 'SUCCESS',
      office,
      priorState: before.enabled ? 'on' : 'off',
    });
    return res.json({ success: true, ...tcAutoCheckoutPayload(sessionTenantSlug(req)) });
  } catch (err) {
    const code = err && err.code ? err.code : 'TC_AUTO_CHECKOUT_SWITCH_WRITE_FAILED';
    console.error('[platform] auto-checkout switch write failed:', err && err.message ? err.message : err);
    const status =
      code === 'INVALID_OFFICE' || code === 'INVALID_BODY'
        ? 400
        : code === 'OFFICE_SETTING_TENANT_NOT_WRITABLE'
          ? 409
          : 500;
    return fail(res, status, 'Could not save the checkout-from-schedule switch', code);
  }
});

// ── TC referrals switch (item 52) — the same shape as checkout's ────────────

/** @param {string|null} tenantSlug the SESSION tenant (MT-2b) */
function tcReferralsPayload(tenantSlug) {
  return {
    offices: realOffices(tenantSlug).map((office) => tcReferrals.officeState(tenantSlug, office)),
    settingKey: tcReferrals.settingKey,
  };
}

/** GET /tc-referrals-offices — refreshed from the control plane before answering. */
router.get('/tc-referrals-offices', async (req, res) => {
  const refreshed = await tcReferrals.refreshFromDb(sessionTenantSlug(req));
  return res.json({ success: true, ...tcReferralsPayload(sessionTenantSlug(req)), controlPlaneError: refreshed.error });
});

/**
 * PUT /tc-referrals-offices/:office   { enabled: boolean }
 *
 * Writes, re-reads from the database, answers with what was stored. Audited
 * to the acting user's own (session) tenant, `priorState` on|off.
 */
router.put('/tc-referrals-offices/:office', async (req, res) => {
  const office = String(req.params.office || '');
  const enabled = req.body ? req.body.enabled : undefined;
  if (typeof enabled !== 'boolean') {
    return fail(res, 400, 'enabled must be true or false', 'INVALID_BODY');
  }
  if (!realOffices(sessionTenantSlug(req)).includes(office)) {
    return fail(res, 404, 'No such office', 'INVALID_OFFICE');
  }

  try {
    await tcReferrals.refreshFromDb(sessionTenantSlug(req));
    const before = tcReferrals.officeState(sessionTenantSlug(req), office);
    await tcReferrals.persist(sessionTenantSlug(req), office, enabled, actorEmail(req));
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'platform_setting',
      resourceId: tcReferrals.settingKey,
      result: 'SUCCESS',
      office,
      priorState: before.enabled ? 'on' : 'off',
    });
    return res.json({ success: true, ...tcReferralsPayload(sessionTenantSlug(req)) });
  } catch (err) {
    const code = err && err.code ? err.code : 'TC_REFERRALS_SWITCH_WRITE_FAILED';
    console.error('[platform] referrals switch write failed:', err && err.message ? err.message : err);
    const status =
      code === 'INVALID_OFFICE' || code === 'INVALID_BODY'
        ? 400
        : code === 'OFFICE_SETTING_TENANT_NOT_WRITABLE'
          ? 409
          : 500;
    return fail(res, status, 'Could not save the referrals switch', code);
  }
});

// ── TC referral EMAIL switch (R5) — the same shape again ────────────────────

/** @param {string|null} tenantSlug the SESSION tenant (MT-2b) */
function tcReferralEmailPayload(tenantSlug) {
  return {
    offices: realOffices(tenantSlug).map((office) => tcReferralEmail.officeState(tenantSlug, office)),
    settingKey: tcReferralEmail.settingKey,
  };
}

/** GET /tc-referral-email-offices — refreshed from the control plane before answering. */
router.get('/tc-referral-email-offices', async (req, res) => {
  const refreshed = await tcReferralEmail.refreshFromDb(sessionTenantSlug(req));
  return res.json({ success: true, ...tcReferralEmailPayload(sessionTenantSlug(req)), controlPlaneError: refreshed.error });
});

/**
 * PUT /tc-referral-email-offices/:office   { enabled: boolean }
 *
 * Writes, re-reads from the database, answers with what was stored. Audited
 * to the acting user's own (session) tenant, `priorState` on|off.
 */
router.put('/tc-referral-email-offices/:office', async (req, res) => {
  const office = String(req.params.office || '');
  const enabled = req.body ? req.body.enabled : undefined;
  if (typeof enabled !== 'boolean') {
    return fail(res, 400, 'enabled must be true or false', 'INVALID_BODY');
  }
  if (!realOffices(sessionTenantSlug(req)).includes(office)) {
    return fail(res, 404, 'No such office', 'INVALID_OFFICE');
  }

  try {
    await tcReferralEmail.refreshFromDb(sessionTenantSlug(req));
    const before = tcReferralEmail.officeState(sessionTenantSlug(req), office);
    await tcReferralEmail.persist(sessionTenantSlug(req), office, enabled, actorEmail(req));
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'platform_setting',
      resourceId: tcReferralEmail.settingKey,
      result: 'SUCCESS',
      office,
      priorState: before.enabled ? 'on' : 'off',
    });
    return res.json({ success: true, ...tcReferralEmailPayload(sessionTenantSlug(req)) });
  } catch (err) {
    const code = err && err.code ? err.code : 'TC_REFERRAL_EMAIL_SWITCH_WRITE_FAILED';
    console.error('[platform] referral email switch write failed:', err && err.message ? err.message : err);
    const status =
      code === 'INVALID_OFFICE' || code === 'INVALID_BODY'
        ? 400
        : code === 'OFFICE_SETTING_TENANT_NOT_WRITABLE'
          ? 409
          : 500;
    return fail(res, status, 'Could not save the referral email switch', code);
  }
});

// ── TC referral PATIENT email switch (R5b) — the same shape again ───────────
// Gates only the patient's notice; the specialist letter keeps its own switch.

/** @param {string|null} tenantSlug the SESSION tenant (MT-2b) */
function tcReferralPatientEmailPayload(tenantSlug) {
  return {
    offices: realOffices(tenantSlug).map((office) => tcReferralPatientEmail.officeState(tenantSlug, office)),
    settingKey: tcReferralPatientEmail.settingKey,
  };
}

/** GET /tc-referral-patient-email-offices — refreshed from the control plane before answering. */
router.get('/tc-referral-patient-email-offices', async (req, res) => {
  const refreshed = await tcReferralPatientEmail.refreshFromDb(sessionTenantSlug(req));
  return res.json({ success: true, ...tcReferralPatientEmailPayload(sessionTenantSlug(req)), controlPlaneError: refreshed.error });
});

/**
 * PUT /tc-referral-patient-email-offices/:office   { enabled: boolean }
 *
 * Writes, re-reads from the database, answers with what was stored. Audited
 * to the acting user's own (session) tenant, `priorState` on|off.
 */
router.put('/tc-referral-patient-email-offices/:office', async (req, res) => {
  const office = String(req.params.office || '');
  const enabled = req.body ? req.body.enabled : undefined;
  if (typeof enabled !== 'boolean') {
    return fail(res, 400, 'enabled must be true or false', 'INVALID_BODY');
  }
  if (!realOffices(sessionTenantSlug(req)).includes(office)) {
    return fail(res, 404, 'No such office', 'INVALID_OFFICE');
  }

  try {
    await tcReferralPatientEmail.refreshFromDb(sessionTenantSlug(req));
    const before = tcReferralPatientEmail.officeState(sessionTenantSlug(req), office);
    await tcReferralPatientEmail.persist(sessionTenantSlug(req), office, enabled, actorEmail(req));
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'platform_setting',
      resourceId: tcReferralPatientEmail.settingKey,
      result: 'SUCCESS',
      office,
      priorState: before.enabled ? 'on' : 'off',
    });
    return res.json({ success: true, ...tcReferralPatientEmailPayload(sessionTenantSlug(req)) });
  } catch (err) {
    const code = err && err.code ? err.code : 'TC_REFERRAL_PATIENT_EMAIL_SWITCH_WRITE_FAILED';
    console.error('[platform] referral patient email switch write failed:', err && err.message ? err.message : err);
    const status =
      code === 'INVALID_OFFICE' || code === 'INVALID_BODY'
        ? 400
        : code === 'OFFICE_SETTING_TENANT_NOT_WRITABLE'
          ? 409
          : 500;
    return fail(res, status, 'Could not save the referral patient email switch', code);
  }
});

module.exports = router;
