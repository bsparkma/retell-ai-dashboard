'use strict';

/**
 * /api/admin/setup-status — the /admin hub's "Practice setup" card (OB-1).
 *
 *   GET /?office=<key>    per office, which setup steps are done and which
 *                         need attention, each linking to its existing screen
 *
 * Answer:
 *   { success: true, office, officeName, offices: [{ officeId, officeName }],
 *     steps: [{ id, title, required, status: 'done'|'needs_attention', detail, link }],
 *     doneRequired, totalRequired }
 *
 * THE GATE is the /admin hub's own: `requirePermission('admin.all')` at the
 * mount in server.js — the same action the Users page and Print templates are
 * mounted behind. It is mounted ABOVE the voice-guarded /api/admin mount on
 * purpose: whether a practice is set up is a property of the practice, not of
 * the voice product, so a TC-only practice gets the card too.
 *
 * THE OFFICE is `?office=`, validated by TC's requireOffice (the validator
 * Print templates uses). THE TENANT is req.tenant, from the session. Neither
 * is ever read from a body, and this route has no body.
 *
 * READ-ONLY: GET is the only method; nothing is written, nothing is audited
 * (a config read, like the Users listing), and nothing calls Open Dental.
 * The computation is services/setupStatus.js.
 */

const express = require('express');

const { requireOffice } = require('./tc/helpers');
const tenantDb = require('../platform/tenantDb');
const { assignableOffices } = require('../services/tenantUsers');
const { computeSetupStatus } = require('../services/setupStatus');

const router = express.Router();

router.get('/', requireOffice, async (req, res) => {
  const office = req.tcOffice;
  const tenantId = req.tenant && req.tenant.id;
  if (!tenantId) {
    // Fail closed: under tenantContext this cannot happen.
    return res.status(403).json({ success: false, error: 'No practice for this session', code: 'NO_TENANT' });
  }
  try {
    const status = await tenantDb.withTenantDb(req, (pool) =>
      computeSetupStatus({ office, tenantId, modules: req.tenant.modules || [], pool })
    );
    const offices = assignableOffices();
    const here = offices.find((o) => o.officeId === office);
    return res.json({
      success: true,
      ...status,
      officeName: here ? here.officeName : office,
      offices,
    });
  } catch (err) {
    console.error('[setup-status] failed:', err && err.message ? err.message : err);
    return res
      .status(503)
      .json({ success: false, error: 'Could not check the practice setup right now', code: 'SETUP_STATUS_UNAVAILABLE' });
  }
});

module.exports = router;
