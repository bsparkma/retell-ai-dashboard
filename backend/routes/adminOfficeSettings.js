'use strict';

/**
 * /api/admin/office-settings — the PRACTICE's door to its own per-office
 * settings (MT-2c, ruling A).
 *
 * Ruling A (Beau, ratified): /admin is practice-level. A practice's admins
 * manage THEIR practice's offices; the Developer Console (/platform) stays
 * Beau / developers only.
 *
 * THE GATE is /admin's own: `requirePermission('admin.all')`, applied at the
 * mount in server.js, ABOVE the voice-guarded /api/admin mount (the same
 * pattern as /api/admin/setup-status), so a TC-only practice reaches it. On top
 * of that, each switch is guarded by the module it belongs to, so a practice
 * that has not bought TC (or hygiene) gets a 403 MODULE_NOT_ENTITLED rather
 * than a switch for a product it does not have.
 *
 *   /tc-checkout-offices[/:office]                 tc   ┐
 *   /tc-od-sync-offices[/:office]                  tc   │ routes/officeSwitches.js —
 *   /tc-auto-checkout-offices[/:office]            tc   │ the Developer Console's
 *   /tc-referrals-offices[/:office]                tc   │ handlers, verbatim: same
 *   /tc-referral-email-offices[/:office]           tc   │ validation, persist(),
 *   /tc-referral-patient-email-offices[/:office]   tc   │ read-back and audit row
 *   /hyg-offices[/:office]                         hyg  ┘
 *   GET /runbook-switches                          tc   nurture + opportunities, READ-ONLY
 *
 * NO NEW WRITE MECHANICS. Every write above is the existing persist() path
 * (registry.setPlatformSetting's dual-write + office_setting read-back), with
 * the tenant taken from the session and the office checked against that
 * tenant's offices (404 INVALID_OFFICE otherwise, oracle-free — see
 * routes/officeSwitches.js).
 *
 * READ-ONLY, ON PURPOSE: tc_nurture_enabled and tc_opportunities_sync. Neither
 * has a write path anywhere today — they are switched on by the runbook in
 * docs/MT2A_OFFICE_SETTINGS.md — and giving them one would be a new writer,
 * which this slice does not add. The practice can SEE them; changing them is
 * still CareIN's runbook until a ruling says otherwise.
 *
 * NOT HERE: tc_email_identity (already practice-level, at /api/tc/email-identity
 * under tc.full, reached from the hub's "Practice info & email identity" card),
 * and the process-wide keys tc_email_enabled, tc_sms_enabled and
 * call_retention_days, which stay Developer-Console-only. A request for any
 * path not listed above falls through to the /api/admin mount below this one,
 * whose own gate refuses it.
 */

const express = require('express');

const { requireModule } = require('../middleware/tenantContext');
const officeSettings = require('../platform/officeSettings');
const tcNurture = require('../config/tcNurture');
const tcOpportunities = require('../config/tcOpportunities');
const { realOffices } = require('../config/tcOfficeSwitch');
const { sessionTenantSlug } = require('../platform/sessionTenant');

const router = express.Router();

/** The TC switches' paths: each one, and each one with an office. */
const TC_SWITCH_PATHS = [
  '/tc-checkout-offices',
  '/tc-od-sync-offices',
  '/tc-auto-checkout-offices',
  '/tc-referrals-offices',
  '/tc-referral-email-offices',
  '/tc-referral-patient-email-offices',
];

router.use(TC_SWITCH_PATHS, requireModule('tc'));
router.use('/hyg-offices', requireModule('hyg'));
router.use('/runbook-switches', requireModule('tc'));

/** The read-only keys, in the order the page shows them. */
const RUNBOOK_KEYS = Object.freeze([tcNurture.SETTING_KEY, tcOpportunities.SETTING_KEY]);

/**
 * GET /runbook-switches
 *
 * What the nurture and opportunities switches are serving for each of the
 * session tenant's offices. An 'on'-kind setting is ON only for a stored
 * literal `true` (platform/officeSettingKeys.js), so that is the only thing
 * reported as on. `policyKnown: false` means the control plane has not been
 * readable, and every office reads as off — said, not guessed.
 *
 * No writes, no audit (a config read with no PHI, like the other GETs here).
 */
router.get('/runbook-switches', async (req, res) => {
  const tenantSlug = sessionTenantSlug(req);
  const offices = realOffices(tenantSlug);
  /** @type {Array<{ office: string, settingKey: string, enabled: boolean, updatedAt: unknown, updatedBy: unknown }>} */
  const switches = [];
  try {
    for (const settingKey of RUNBOOK_KEYS) {
      for (const office of offices) {
        const cell = tenantSlug ? await officeSettings.get(tenantSlug, office, settingKey) : null;
        switches.push({
          office,
          settingKey,
          enabled: Boolean(cell && cell.value === true),
          updatedAt: cell ? cell.updatedAt : null,
          updatedBy: cell ? cell.updatedBy : null,
        });
      }
    }
  } catch (err) {
    console.error('[admin/office-settings] runbook switch read failed:', err && err.message ? err.message : err);
    return res.status(503).json({ success: false, error: 'Could not read these switches just now', code: 'CONTROL_PLANE_UNAVAILABLE' });
  }
  return res.json({
    success: true,
    offices,
    switches,
    policyKnown: tenantSlug ? officeSettings.isServed(tenantSlug) : false,
  });
});

router.use(require('./officeSwitches'));

module.exports = router;
