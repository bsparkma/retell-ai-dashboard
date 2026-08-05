'use strict';

/**
 * /api/tc/od — Treatment Coordinator's Open Dental READS (Slice 5).
 *
 * READ-ONLY BY CONSTRUCTION. Every handler is a GET, the only transport is
 * odAccess.odApiGet (which has no write counterpart), and no route in this file
 * touches a write path. The commlog write stays FEATURE_DISABLED until Slice 6.
 *
 * OFFICE LAW
 * ----------
 * Office comes from the validated `?office=` param (helpers.requireOffice), never
 * the body. `requireOdOffice` then REFUSES any office without an Open Dental
 * connection with a structured 503 OFFICE_NOT_CONNECTED — today that is `valley`.
 * The UI's honest "OD not connected for this office yet" state depends on that
 * exact code, so it is asserted in tests. Roland only until the per-location
 * credential slice lands (another workstream owns it): the OD customer key scopes
 * to exactly ONE practice database, so a Valley read through this key would
 * return ROLAND's patients — the refusal is a correctness guard, not a nicety.
 *
 * PHI
 * ---
 * No route logs a patient name, a search string, or any row content. Errors log
 * method + path + OD status only. The one audit row per request records an ID or
 * null — never a query string (a search term is PHI).
 *
 * AUDIT
 * -----
 * Each PHI read emits exactly ONE audit row via helpers.auditTc(req,'READ',…).
 * That matches the granularity the voice module gets from odAccess's audited
 * named methods (docs/AUDIT.md) — one row per logical OD read — without the
 * 25-row spam a per-call audit of a fanned-out treatment-plan fetch would create.
 * odAccess.odApiGet is deliberately unaudited for that reason.
 */

const express = require('express');

const { requireOffice, h, auditTc } = require('./helpers');
const odAccess = require('../../platform/odAccess');
const odReads = require('./odReads');
const { getOfficeConfig } = require('../../config/officeAgents');

const router = express.Router();
router.use(requireOffice);

// ── Office gate ─────────────────────────────────────────────────────────────

/**
 * Refuse offices with no Open Dental connection. 503 (not 403): the office is
 * legitimate and entitled, the upstream connection simply does not exist yet.
 * @type {import('express').RequestHandler}
 */
function requireOdOffice(req, res, next) {
  const config = getOfficeConfig(req.tcOffice);
  if (!config || !config.odConnected) {
    return res.status(503).json({
      success: false,
      error: 'Open Dental is not connected for this office yet',
      code: 'OFFICE_NOT_CONNECTED',
      office: req.tcOffice,
      officeName: config ? config.officeName : req.tcOffice,
    });
  }
  return next();
}

router.use(requireOdOffice);

// ── Input validation ────────────────────────────────────────────────────────

/**
 * OD primary keys are positive bigints. Reject anything else before it reaches a
 * URL — a non-numeric PatNum has no valid OD meaning and must never be
 * interpolated into an upstream path.
 * @returns {number|null}
 */
function parsePatNum(value) {
  const s = String(value == null ? '' : value).trim();
  if (!/^\d{1,18}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function badPatNum(res) {
  return res.status(400).json({
    success: false,
    error: 'patNum must be a positive whole number',
    code: 'INVALID_PATNUM',
  });
}

/** Bounded numeric query param with a default. */
function intParam(value, def, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// ── OD transport for this request ───────────────────────────────────────────

/**
 * Bind odAccess.odApiGet to the request. Everything in odReads.js goes through
 * this closure, so tenant resolution, od_primary_mode routing and the
 * od_api_base guard apply to every OD call TC makes.
 * @param {import('express').Request} req
 */
function odGetFor(req) {
  return (path, params, opts) => odAccess.odApiGet(req, path, params, opts);
}

/**
 * Turn a failure into the structured error the SPA can render honestly.
 * Distinguishes: tenant/connection problems (odAccess codes), OD capability
 * gaps, and everything else. Never leaks OD internals or PHI.
 */
function sendOdError(req, res, err, what) {
  if (err && err.name === 'OdAccessError') {
    const status = odAccess.httpStatusFor(err);
    console.error(`[tc/od] ${req.method} ${req.path} — odAccess ${err.code}`);
    return res.status(status).json({
      success: false,
      error: err.publicMessage || 'Open Dental request failed',
      code: err.code,
    });
  }
  const odStatus = err && err.odStatus;
  console.error(`[tc/od] ${req.method} ${req.path} — ${what} failed (OD status ${odStatus || 'n/a'})`);
  if (err && err.capability) {
    return res.status(502).json({
      success: false,
      error: `Open Dental has not enabled the data needed for ${what}`,
      code: 'OD_RESOURCE_UNAVAILABLE',
    });
  }
  if (odStatus === 401 || odStatus === 403) {
    return res.status(502).json({
      success: false,
      error: 'Open Dental rejected the request (credentials or permissions)',
      code: 'OD_UNAUTHORIZED',
    });
  }
  return res.status(502).json({
    success: false,
    error: `Could not read ${what} from Open Dental`,
    code: 'OD_READ_FAILED',
  });
}

// ── GET /status — is OD reachable for this office? ──────────────────────────
//
// Lets the SPA render the OD panels without probing a PHI endpoint first.
// Non-PHI, so no audit row.

router.get(
  '/status',
  h(async (req, res) => {
    const config = getOfficeConfig(req.tcOffice);
    let reachable = false;
    let detail = '';
    try {
      const probe = await odAccess.odApiGet(req, '/providers', {}, { timeoutMs: 15000 });
      reachable = probe.ok;
      if (!probe.ok) detail = `Open Dental returned ${probe.status}`;
    } catch (err) {
      detail = err && err.name === 'OdAccessError' ? err.publicMessage : 'Open Dental is unreachable';
    }
    res.json({
      success: true,
      office: req.tcOffice,
      officeName: config.officeName,
      odConnected: true,
      reachable,
      detail,
      /** Reads only in this slice — the commlog write arrives in Slice 6. */
      writeEnabled: false,
    });
  })
);

// ── GET /patients?q= — patient search ───────────────────────────────────────

router.get(
  '/patients',
  h(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > 100) {
      return res.status(400).json({ success: false, error: 'Search text is too long', code: 'INVALID_QUERY' });
    }
    if (q.length < 2) {
      // Not an error — the UI debounces into this while typing.
      return res.json({ success: true, query: q, matchMode: 'prefix', patients: [], truncated: false, notes: [] });
    }

    let result;
    try {
      result = await odReads.searchPatients(odGetFor(req), q, {
        limit: intParam(req.query.limit, 20, 1, 50),
      });
    } catch (err) {
      return sendOdError(req, res, err, 'patient search');
    }

    // resourceId is null on purpose: the search term is PHI and must not be
    // written to the audit trail (odAccess applies the same rule).
    await auditTc(req, 'READ', 'od_patient_search', null);
    res.json({ success: true, ...result });
  })
);

// ── GET /patients/:patNum ───────────────────────────────────────────────────

router.get(
  '/patients/:patNum',
  h(async (req, res) => {
    const patNum = parsePatNum(req.params.patNum);
    if (!patNum) return badPatNum(res);

    let result;
    try {
      result = await odReads.getPatient(odGetFor(req), patNum);
    } catch (err) {
      return sendOdError(req, res, err, 'the patient record');
    }
    if (!result.patient) {
      return res.status(404).json({ success: false, error: 'Patient not found in Open Dental', code: 'NOT_FOUND' });
    }

    await auditTc(req, 'READ', 'od_patient', patNum);
    res.json({ success: true, patient: result.patient });
  })
);

// ── GET /treatment-plan/:patNum ─────────────────────────────────────────────

router.get(
  '/treatment-plan/:patNum',
  h(async (req, res) => {
    const patNum = parsePatNum(req.params.patNum);
    if (!patNum) return badPatNum(res);

    let result;
    try {
      result = await odReads.getTreatmentPlan(odGetFor(req), patNum);
    } catch (err) {
      return sendOdError(req, res, err, 'the treatment plan');
    }

    await auditTc(req, 'READ', 'od_treatment_plan', patNum);
    res.json({ success: true, patNum, ...result });
  })
);

// ── GET /unaccepted — the bulk finder (was direct MySQL) ────────────────────

router.get(
  '/unaccepted',
  h(async (req, res) => {
    let result;
    try {
      result = await odReads.findUnaccepted(odGetFor(req), {
        minFee: intParam(req.query.minFee, 0, 0, 1000000),
        days: intParam(req.query.days, 90, 1, 1825),
        limit: intParam(req.query.limit, 50, 1, 200),
      });
    } catch (err) {
      return sendOdError(req, res, err, 'unaccepted treatment');
    }

    await auditTc(req, 'READ', 'od_unaccepted_treatment', null);
    res.json({ success: true, ...result });
  })
);

// ── GET /cob-procedures/:patNum (was direct MySQL) ──────────────────────────

router.get(
  '/cob-procedures/:patNum',
  h(async (req, res) => {
    const patNum = parsePatNum(req.params.patNum);
    if (!patNum) return badPatNum(res);

    let result;
    try {
      result = await odReads.getCobProcedures(odGetFor(req), patNum);
    } catch (err) {
      return sendOdError(req, res, err, 'the treatment-planned procedures');
    }

    await auditTc(req, 'READ', 'od_cob_procedures', patNum);
    res.json({ success: true, patNum, ...result });
  })
);

// ── GET /insurance/:patNum (was direct MySQL) ───────────────────────────────

router.get(
  '/insurance/:patNum',
  h(async (req, res) => {
    const patNum = parsePatNum(req.params.patNum);
    if (!patNum) return badPatNum(res);

    let result;
    try {
      result = await odReads.getInsuranceSnapshot(odGetFor(req), patNum);
    } catch (err) {
      return sendOdError(req, res, err, 'the insurance snapshot');
    }

    await auditTc(req, 'READ', 'od_insurance', patNum);
    res.json({ success: true, patNum, ...result });
  })
);

// ── GET /next-appointment/:patNum ───────────────────────────────────────────

router.get(
  '/next-appointment/:patNum',
  h(async (req, res) => {
    const patNum = parsePatNum(req.params.patNum);
    if (!patNum) return badPatNum(res);

    let result;
    try {
      result = await odReads.getNextAppointment(odGetFor(req), patNum);
    } catch (err) {
      return sendOdError(req, res, err, 'the next appointment');
    }

    await auditTc(req, 'READ', 'od_appointment', patNum);
    res.json({ success: true, patNum, ...result });
  })
);

module.exports = router;
module.exports.requireOdOffice = requireOdOffice;
module.exports.parsePatNum = parsePatNum;
