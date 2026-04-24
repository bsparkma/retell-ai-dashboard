const express = require('express');
const router = express.Router();

const CONNECTOR_BASE = process.env.OD_CONNECTOR_URL || 'http://localhost:8444';
const CONNECTOR_API_KEY = process.env.OD_CONNECTOR_API_KEY || '';

// GET /api/slot-markers
router.get('/', async (req, res) => {
  const { startDate, endDate, clinicNum, category } = req.query;

  if (!startDate || !endDate || !clinicNum) {
    return res.status(400).json({ success: false, error: 'startDate, endDate, and clinicNum are required' });
  }

  try {
    const url = new URL('/api/slot-markers', CONNECTOR_BASE);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('clinicNum', clinicNum);
    if (category) url.searchParams.set('category', category);

    const upstream = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${CONNECTOR_API_KEY}` },
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error('[slot-markers] Connector error:', upstream.status, text);
      return res.status(502).json({ success: false, error: 'Connector returned an error' });
    }

    const json = await upstream.json();
    return res.json(Array.isArray(json.data) ? json.data : []);
  } catch (err) {
    console.error('[slot-markers] Failed to reach connector:', err.message);
    return res.status(503).json({ success: false, error: 'Could not reach OD connector' });
  }
});

module.exports = router;
