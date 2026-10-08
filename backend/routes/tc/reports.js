'use strict';

/**
 * /api/tc/reports — server-side TC reporting (queue item 42).
 *
 *   GET /funnel?office=roland|valley&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * READ-ONLY. Every statement is a SELECT over tc_case_events + tc_cases,
 * scoped to the validated office; see ./funnel.js for the evidence base and
 * every counting rule.
 *
 * ONE OFFICE PER REQUEST. The TC surface takes `?office=` from the frozen list
 * and nothing else (helpers.requireOffice) — there is no "all offices" form
 * anywhere under /api/tc, so this route does not invent one. "Rollup" here is
 * the office-level total alongside its per-stage / per-person breakdowns.
 *
 * Honest states: an office with no reliable transition history answers 200
 * with zeros, null percentages, `coverageStartsAt: null` and a coverage note —
 * never a 500, never a fabricated rate. A malformed window is a 400.
 */

const express = require('express');

const { requireOffice, h, auditTc } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const { parseWindowQuery, computeFunnel } = require('./funnel');

const router = express.Router();
router.use(requireOffice);

router.get(
  '/funnel',
  h(async (req, res) => {
    const parsed = parseWindowQuery(req.query.from, req.query.to);
    if (!parsed.ok) {
      return res.status(400).json({ success: false, error: parsed.error, code: parsed.code });
    }

    const result = await tenantDb.withTenantDb(req, (pool) =>
      computeFunnel(pool, { office: req.tcOffice, from: parsed.from, to: parsed.to })
    );
    if (result.error) {
      return res.status(400).json({ success: false, error: result.error.message, code: result.error.code });
    }

    // An aggregate read over case rows: audited like the case list (same
    // action + resource type, no new audit vocabulary).
    await auditTc(req, 'READ', 'tc_case', null, { office: req.tcOffice });
    return res.json({ success: true, funnel: result.funnel });
  })
);

module.exports = router;
