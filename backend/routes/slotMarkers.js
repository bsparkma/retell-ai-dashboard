const express = require('express');
const router = express.Router();
const odAccess = require('../platform/odAccess');

// GET /api/slot-markers
//
// The connector base URL + API key are no longer read from the environment
// (the old `OD_CONNECTOR_URL || 'http://localhost:8444'` fallback is gone).
// odAccess resolves the calling tenant's connector from the registry, enforces
// the ClinicNum entitlement check, and forwards to that tenant's connector.
router.get('/', async (req, res) => {
  const { startDate, endDate, clinicNum, category } = req.query;

  if (!startDate || !endDate || !clinicNum) {
    return res.status(400).json({ success: false, error: 'startDate, endDate, and clinicNum are required' });
  }

  try {
    const data = await odAccess.getSlotMarkers(req, { startDate, endDate, clinicNum, category });
    return res.json(data);
  } catch (err) {
    const status = odAccess.httpStatusFor(err);
    return res.status(status).json({
      success: false,
      error: err && err.publicMessage ? err.publicMessage : 'OD connector error',
      code: err && err.code ? err.code : undefined,
    });
  }
});

module.exports = router;
