'use strict';

/**
 * GET /api/hyg/day/checkout-questions?office=&date=&apt=1,2,3 — the
 * ask-hygiene badges for the day view (CO-7).
 *
 * Which visits on the day have a front-desk question on their checkout card,
 * and how many are still open (services/hyg/checkoutQuestions.js says which
 * card is a visit's).
 *
 * SHAPED LIKE /day/progress, ON PURPOSE: the caller sends the day's own AptNums
 * and the date; the answer is AptNums and counts — no PatNum, no name, no
 * message text — so, like /day/progress (which the page also asks every
 * minute), it writes no audit row. The thread itself is read through GET
 * /api/hyg/visit/:aptNum/checkout-questions, which is audited.
 *
 * Its own file, mounted at /day/checkout-questions ABOVE /day in index.js, so
 * day.js stays the day, the names and the progress pill. GET only: the reply
 * is visit.js's, the module's one mutating route file.
 *
 * ZERO OPEN DENTAL. Checkout switched off for the office → `enabled: false`
 * and no badges, never an error.
 */

const express = require('express');

const { h } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const visitProgress = require('../../services/hyg/visitProgress');
const checkoutQuestions = require('../../services/hyg/checkoutQuestions');
const tcCheckout = require('../../config/tcCheckout');

const router = express.Router();

router.get(
  '/',
  h(async (req, res) => {
    const office = req.hygOffice;
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD', code: 'INVALID_DATE', office });
    }
    const parsed = visitProgress.parseAptNums(req.query.apt);
    if (!parsed.ok) {
      return res.status(400).json({ success: false, error: parsed.error, code: 'INVALID_APT_NUMS', office });
    }
    if (!(await tcCheckout.isEnabled(office))) {
      return res.json({ success: true, office, enabled: false, badges: [] });
    }
    const badges = await tenantDb.withTenantDb(req, (pool) =>
      checkoutQuestions.badgesForDay(pool, office, parsed.aptNums, date)
    );
    return res.json({ success: true, office, enabled: true, badges });
  })
);

module.exports = router;
