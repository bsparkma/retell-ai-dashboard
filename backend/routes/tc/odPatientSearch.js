'use strict';

/**
 * /api/tc/od/patient-search — attach a patient to a hygiene intake.
 *
 * The ONE Open Dental read the `hygiene` role holds. A hygienist finishing a
 * visit needs to say WHICH patient the handoff is about; everything else under
 * /api/tc/od (treatment plans, unaccepted money, COB, insurance, the next
 * appointment) stays tc.full.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SEPARATE ROUTER INSTEAD OF LOOSENING /od/patients
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. FAIL-CLOSED SHAPE. /api/tc/od is gated tc.full at the mount. Narrowing one
 *     route inside it means dropping the mount gate and re-applying it per
 *     route — and then the next route added to od.js is hygiene-readable by
 *     omission. This router is gated tc.hygiene as a whole and holds exactly one
 *     route, so its blast radius is what its mount says it is. It is registered
 *     BEFORE the /od mount in index.js; express matches mounts in registration
 *     order, so this path never reaches the tc.full gate.
 *  2. IT RETURNS LESS. PatNum, name, date of birth. That is what it takes to
 *     attach the right person and to tell two same-named patients apart — OD
 *     matches names by PREFIX, so DOB is load-bearing, not decoration. No phone,
 *     no email, no patient status: none of them help choose, and all of them are
 *     PHI this surface has no reason to serve.
 *  3. IT IS PER-OFFICE. The rest of /od reads through platform/odAccess, the
 *     TENANT-level seam bound to one configured OD client — Roland. This route
 *     resolves the office's own client through config/odOffices, the same
 *     registry the voice chart-write path uses. Riley is a SEPARATE Open Dental
 *     database and PatNum numbering restarts in each one (PatNum 7115 is the
 *     Riley test patient and a different, real person in Roland), so a search
 *     that ignored the office would offer the wrong practice's patients for
 *     someone to attach to a chart.
 *
 * OFFICE LAW. The office comes from the validated `?office=` param and is
 * checked against the frozen office list before anything else happens; an
 * unknown office is a 400 that never reaches Open Dental. The resolved handle
 * then goes through assertOfficeMatch, so a client bound to another practice is
 * refused rather than used.
 *
 * PHI. Nothing here logs a name, a search term or a row. The one audit row per
 * request records the office and a null resource id — the query itself is PHI.
 *
 * READ-ONLY BY CONSTRUCTION: the only transport is apiGetRaw, a GET with no
 * write counterpart.
 */

const express = require('express');

const { requireOffice, h, auditTc } = require('./helpers');
const odOffices = require('../../config/odOffices');
const odReads = require('./odReads');

const router = express.Router();
router.use(requireOffice);

/** Bounded numeric query param with a default. */
function intParam(value, def, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Exactly the fields attaching needs. Built by naming them, not by deleting
 * from the full record — a projection that removes fields grows new ones the
 * day the source shape does.
 * @param {{patNum:number, firstName:string, lastName:string, displayName:string, birthdate:string}} p
 */
function toBrief(p) {
  return {
    patNum: p.patNum,
    firstName: p.firstName,
    lastName: p.lastName,
    displayName: p.displayName,
    birthdate: p.birthdate,
  };
}

router.get(
  '/',
  h(async (req, res) => {
    const office = req.tcOffice;

    // Resolve THIS office's Open Dental connection. Unknown / switched off /
    // unkeyed all land here, and none of them fall back to another practice's
    // client — that fallback is precisely the PatNum-collision hazard.
    let od;
    try {
      od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
    } catch (err) {
      // OFFICE_NOT_CONNECTED is the code the shared OD UI renders as the honest
      // "OD not connected for this office yet" state (features/tc/od/OdShell).
      // `reason` carries the precise odOffices code so a log says which of the
      // three it was without anyone having to guess.
      return res.status(503).json({
        success: false,
        error: err.publicMessage || 'Open Dental is not connected for this office',
        code: 'OFFICE_NOT_CONNECTED',
        reason: err.code,
        office,
        patients: [],
      });
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > 100) {
      return res
        .status(400)
        .json({ success: false, error: 'Search text is too long', code: 'INVALID_QUERY' });
    }
    if (q.length < 2) {
      // Not an error — the type-ahead debounces into this while the user types.
      // Answered without an OD round trip, and without an audit row: nothing
      // was read.
      return res.json({
        success: true,
        office,
        officeName: od.officeName,
        query: q,
        matchMode: 'prefix',
        patients: [],
        truncated: false,
      });
    }

    let result;
    try {
      // odReads.searchPatients takes the transport as an argument, so the same
      // dual-lane search (last-name lane, then the first-name lane when it comes
      // back thin) runs against whichever office's client we just resolved. The
      // merge is not optional: the Roland test patient is LName "Test", FName
      // "MangoTest", and a last-name-only search misses it entirely.
      const odGet = (path, params, opts) => od.client.apiGetRaw(path, params, opts);
      result = await odReads.searchPatients(odGet, q, {
        limit: intParam(req.query.limit, 20, 1, 50),
      });
    } catch (err) {
      console.error(`[tc/od-patient-search] office=${office} search failed`);
      return res.status(502).json({
        success: false,
        error: 'Could not search Open Dental',
        code: 'OD_READ_FAILED',
        office,
        patients: [],
      });
    }

    // resourceId is null on purpose: the search term is PHI and must not be
    // written to the audit trail. The OFFICE is recorded, so the trail still
    // shows which practice's records were searched.
    await auditTc(req, 'READ', 'od_patient_search', null, { office });

    res.json({
      success: true,
      office,
      officeName: od.officeName,
      query: result.query,
      matchMode: result.matchMode,
      patients: result.patients.map(toBrief),
      truncated: result.truncated,
    });
  })
);

module.exports = router;
