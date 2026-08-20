'use strict';

/**
 * /api/tc/od - Treatment Coordinator's Open Dental READS (Slice 5).
 *
 * READ-ONLY BY CONSTRUCTION. Every handler is a GET, the only transport is
 * `apiGetRaw` (which has no write counterpart on the client), and no route in
 * this file touches a write path. The commlog write stays FEATURE_DISABLED
 * until Slice 6.
 *
 * OFFICE LAW
 * ----------
 * Office comes from the validated `?office=` param (helpers.requireOffice),
 * never the body. `requireOdOffice` then resolves THAT OFFICE'S OWN Open Dental
 * connection through config/odOffices - the same registry the voice chart-write
 * path and the hygiene attach-search use - and refuses, with a structured 503
 * OFFICE_NOT_CONNECTED, any office that is unknown, switched off, or unkeyed.
 *
 * Until this slice these routes read through platform/odAccess, the TENANT-level
 * seam, which is bound to the single process-wide client built from ROLAND's
 * customer key. That was correct only while Roland was the only OD-connected
 * office; it is why `valley` was refused outright rather than served. The refusal
 * was a correctness guard, not a nicety: **PatNum numbering restarts in every OD
 * database** - PatNum 7115 is "Stedi TestValley" in Riley/valley and a different,
 * REAL patient in Roland - so a Valley read through Roland's key would have shown
 * one practice's chart under the other practice's selector.
 *
 * With the client resolved per office, the refusal is no longer needed to keep
 * offices apart; the registry does that structurally. Every OD call additionally
 * re-runs `assertOfficeMatch` at the transport boundary, so a handle bound to
 * another practice cannot be used even if one were somehow substituted.
 *
 * PACING
 * ------
 * Open Dental's throttle is a property of the CREDENTIAL, and the transport
 * reserves a shared per-key slot for it (config/openDental.js). Resolving the
 * office client is therefore all it takes for TC's reads to queue with the voice
 * module's on the same key. TC does NOT enter services/rcm/odPacer's serialized
 * 1200ms queue: that queue exists so a biller's BATCH cannot degrade interactive
 * paths, and TC is an interactive path - a treatment plan fans out to as many as
 * 25 GETs, which at 1200ms each is a 30-second screen, and a TC read issued
 * during a batch match would queue behind the whole batch. What TC does do is
 * pass `module: 'tc'` so the transport's counters attribute its 429s and its
 * waits, which is what makes revisiting this a measurement rather than an
 * argument (see the D-8 note in services/rcm/odPacer.js).
 *
 * PHI
 * ---
 * No route logs a patient name, a search string, or any row content. Errors log
 * method + path + office + OD status only. The one audit row per request records
 * an ID or null - never a query string (a search term is PHI).
 *
 * AUDIT
 * -----
 * Each PHI read emits exactly ONE audit row via helpers.auditTc(req,'READ',...),
 * stamped with the office it touched. That matches the granularity the voice
 * module gets from odAccess's audited named methods (docs/AUDIT.md) - one row
 * per logical OD read - without the 25-row spam a per-call audit of a fanned-out
 * treatment-plan fetch would create.
 */

const express = require('express');

const { requireOffice, h, auditTc } = require('./helpers');
const odOffices = require('../../config/odOffices');
const odReads = require('./odReads');

const router = express.Router();
router.use(requireOffice);

// ── Office gate ─────────────────────────────────────────────────────

/**
 * Resolve THIS office's Open Dental connection, or refuse.
 *
 * Gates on `odOffices` - intent AND credentials, per office - rather than on a
 * separate boolean. There used to be two switches: `OFFICE_OD_SETTINGS.odEnabled`
 * for voice and `officeAgents.OFFICES[].odConnected` for TC, kept apart because
 * flipping the shared one would have opened these routes for valley while they
 * still read through Roland's client. Now that the client is resolved per office
 * there is nothing left for the second switch to protect, and a second boolean
 * that no longer gates anything is a lie waiting to be believed - so it is gone,
 * and both modules ask one question: `odOffices.isOdReady(office)`.
 *
 * 503 (not 403): the office is legitimate and entitled, the upstream connection
 * simply is not available. `code` stays OFFICE_NOT_CONNECTED because that is what
 * the shared OD UI renders as the honest "OD not connected for this office yet"
 * state (features/tc/api.ts isOdNotConnected); `reason` carries the precise
 * odOffices code - OFFICE_UNKNOWN / OFFICE_NOT_OD_CONNECTED /
 * OFFICE_OD_KEY_MISSING - so a log says which of the three it was without anyone
 * having to guess. Same shape the hygiene attach-search already returns.
 *
 * On success the resolved handle rides on `req.tcOd`, so the gate and the
 * transport can never disagree about which practice this request is for.
 * @type {import('express').RequestHandler}
 */
function requireOdOffice(req, res, next) {
  const office = req.tcOffice;
  let handle;
  try {
    handle = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  } catch (err) {
    if (!(err instanceof odOffices.OdOfficeError)) throw err;
    return res.status(503).json({
      success: false,
      error: err.publicMessage || 'Open Dental is not connected for this office yet',
      code: 'OFFICE_NOT_CONNECTED',
      reason: err.code,
      office,
      officeName: odOffices.describeOffice(office).officeName,
    });
  }
  req.tcOd = handle;
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

// ── OD transport for this request ──────────────────────────────────

/**
 * The GET-only closure everything in odReads.js runs through.
 *
 * `assertOfficeMatch` runs again HERE, per call, not only in the gate. The gate
 * proves the handle was right when the request arrived; re-asserting at the
 * transport boundary is what makes it impossible for any code between the two -
 * present or future - to substitute another practice's client. It costs a string
 * comparison and it is the safety property this file rests on.
 *
 * `module: 'tc'` is ATTRIBUTION ONLY and buys no priority: it is what lets
 * config/openDental.js count TC's 429s and TC's waits behind an RCM reservation
 * separately from everything else sharing the credential.
 *
 * No client object leaves this closure, so nothing downstream can find a write
 * verb on one.
 * @param {import('express').Request} req
 */
function odGetFor(req) {
  return (path, params, opts) =>
    odOffices
      .assertOfficeMatch(req.tcOffice, req.tcOd)
      .client.apiGetRaw(path, params, { ...(opts || {}), module: 'tc' });
}

/**
 * Turn a failure into the structured error the SPA can render honestly.
 * Distinguishes: office/connection refusals (odOffices codes), OD capability
 * gaps, and everything else. Never leaks OD internals or PHI.
 */
function sendOdError(req, res, err, what) {
  if (err && err.name === 'OdOfficeError') {
    // A cross-office refusal, or a connection that went away mid-request. It is
    // always a statement about the OFFICE, never a fact about Open Dental.
    console.error(`[tc/od] ${req.method} ${req.path} office=${req.tcOffice} - ${err.code}`);
    return res.status(odOffices.httpStatusFor(err)).json({
      success: false,
      error: err.publicMessage || 'Open Dental is not available for this office',
      code: err.code,
      office: req.tcOffice,
    });
  }
  const odStatus = err && err.odStatus;
  console.error(
    `[tc/od] ${req.method} ${req.path} office=${req.tcOffice} - ${what} failed (OD status ${odStatus || 'n/a'})`
  );
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
    let reachable = false;
    let detail = '';
    try {
      const probe = await odGetFor(req)('/providers', {}, { timeoutMs: 15000 });
      reachable = probe.ok;
      if (!probe.ok) detail = `Open Dental returned ${probe.status}`;
    } catch (err) {
      detail =
        err && err.name === 'OdOfficeError' ? err.publicMessage : 'Open Dental is unreachable';
    }
    res.json({
      success: true,
      office: req.tcOffice,
      officeName: req.tcOd.officeName,
      // The gate passed, so this office IS connected - to its OWN database.
      odConnected: true,
      reachable,
      detail,
      /** Reads only in this slice - the commlog write arrives in Slice 6. */
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
    // written to the audit trail. The OFFICE is recorded, so the trail still
    // shows which practice's records were searched.
    await auditTc(req, 'READ', 'od_patient_search', null, { office: req.tcOffice });
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

    await auditTc(req, 'READ', 'od_patient', patNum, { office: req.tcOffice });
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

    await auditTc(req, 'READ', 'od_treatment_plan', patNum, { office: req.tcOffice });
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

    await auditTc(req, 'READ', 'od_unaccepted_treatment', null, { office: req.tcOffice });
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

    await auditTc(req, 'READ', 'od_cob_procedures', patNum, { office: req.tcOffice });
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

    await auditTc(req, 'READ', 'od_insurance', patNum, { office: req.tcOffice });
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

    await auditTc(req, 'READ', 'od_appointment', patNum, { office: req.tcOffice });
    res.json({ success: true, patNum, ...result });
  })
);

module.exports = router;
module.exports.requireOdOffice = requireOdOffice;
module.exports.parsePatNum = parsePatNum;
