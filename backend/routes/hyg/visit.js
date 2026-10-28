'use strict';

/**
 * /api/hyg/visit — the visit workspace and the send (H1 slices 2 and 3).
 *
 * Everything on this router except ONE route composes: the routing slip, the
 * treatment items on it, and what is staged to be written. `POST /:aptNum/send`
 * is the exception, and it is the module's first Open Dental WRITE.
 *
 * That write does not happen here. This route validates, resolves the office,
 * checks that what is being confirmed is what is stored, and hands off to
 * `services/hyg/sendVisit.js`, which reaches the transport only through
 * `services/hyg/odWriter.js` — the one file `hygNoOdWrites.test.js` allows to
 * name a write verb.
 *
 * The send route lives in THIS file rather than a sibling on purpose: the
 * mutation allow-list in that same guard names one file, and a send is a
 * mutation on a visit. Two files would be two places for the next mutation to
 * go, and the second is always the one nobody reviewed.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY `patNum` IS NEVER IN A REQUEST BODY
 * ═════════════════════════════════════════════════════════════════════════════
 * A client that could name the patient could attach a slip — and one slice
 * later a chart note — to somebody else. So `POST /:aptNum/open` reads the
 * appointment's own day from Open Dental, finds the appointment, and takes the
 * PatNum from there. Every other mutation works on a visit that already exists
 * and cannot change whose it is; there is no route on which `patNum` is an
 * input.
 *
 * That read is the DAY, not the appointment, because the day is the read this
 * module already has, already pages correctly, and already audits. Opening a
 * visit therefore costs the day's four list requests (the per-patient reads are
 * answered by services/odPatientCache.js, which the day view has usually just
 * warmed). A single-appointment read would be cheaper and is the obvious
 * follow-up — `GET /appointments/{AptNum}` is plural-with-id, the shape that
 * works for /patients — but H0 never proved it against a live database, and a
 * guess here would be a guess about which patient a note lands on.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * GET DOES NOT CREATE
 * ═════════════════════════════════════════════════════════════════════════════
 * `GET /:aptNum` answers `visit: null` when nobody has started one. If it
 * created a row, then opening a card to glance at it would leave a visit behind
 * for a patient nobody worked on, and "which visits happened today" would stop
 * being an answerable question. The client renders an empty slip from the
 * contract's `emptySlip()` and calls `open` the moment the hygienist changes
 * something.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY BODY IS PARSED BEFORE ANY HANDLER LOGIC
 * ═════════════════════════════════════════════════════════════════════════════
 * Slice 1 ran no zod on the backend and the PM accepted that for two query
 * params. That deferral ends here: these bodies become chart writes one slice
 * later. `parseBody` below runs the shared schema from
 * backend/hyg/contract.gen.cjs FIRST, and a rejection is a 400 that NAMES the
 * field. "The client validated it" is not a statement a server may rely on —
 * that is RCM audit finding F3 restated as a design.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NOTHING ON THESE ROUTES GATES ON COMPLETENESS
 * ═════════════════════════════════════════════════════════════════════════════
 * Beau's ruling, verbatim: *"the hygienist should be able to send the treatment
 * to the tc app."* `recareScheduled` and `txEnteredInOd` are ordinary slip
 * fields. The RECORDS_MATRIX produces a list a screen shows. Neither refuses
 * anything here — including on the SEND path, which `hygSend.test.js` pins with
 * a completely unanswered slip going all the way into a chart.
 */

const express = require('express');

const { h, resolveHygOd, actorEmail, auditHygRead, auditHygReads, auditHygDenial } =
  require('./helpers');
const { audit, auditMany } = require('../../platform/audit');
const tenantDb = require('../../platform/tenantDb');
const odDay = require('../../services/hyg/odDay');
const visitStore = require('../../services/hyg/visitStore');
const composer = require('../../services/hyg/stagedWriteComposer');
const sendVisitService = require('../../services/hyg/sendVisit');
const odPerio = require('../../services/hyg/odPerio');
const odToothInitials = require('../../services/hyg/odToothInitials');
const existingTreatment = require('../../services/hyg/existingTreatment');
const existingTxStore = require('../../services/hyg/existingTxStore');
const existingTxStale = require('../../services/hyg/existingTxStale');
const { refuseUnlessTestPatient } = require('../../config/hygFixtureGate');
const perioSend = require('../../services/hyg/perioSend');
const perioDrift = require('../../services/hyg/perioDrift');
const hygStaff = require('../../config/hygStaff');
const tcHandoff = require('../../services/hyg/tcHandoffClient');
const tcCheckout = require('../../config/tcCheckout');
const { snapshotFromAppointment } = require('../../services/hyg/appointmentSnapshot');
const contract = require('../../hyg/contract.gen.cjs');
const tcContract = require('../../tc/contract.gen.cjs');
const referralCreate = require('../tc/referralCreate');
const referralStore = require('../tc/referralStore');
const providerStore = require('../tc/providerStore');
const referralAttachments = require('../tc/referralAttachments');
const transitions = require('../tc/referralTransitions');

const router = express.Router();

/** Same calendar-date rule as the day route. `2026-02-31` is not a day. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isRealDate(value) {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}

/**
 * `:aptNum` as a positive integer, or null.
 *
 * Open Dental's AptNum is a Long. A non-numeric or negative one is a malformed
 * request rather than a missing visit, so it 400s with its own code instead of
 * becoming a 404 that reads like "that appointment does not exist".
 */
function aptNumFrom(req) {
  const raw = String(req.params.aptNum || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The dotted path of the field a zod issue is about.
 *
 * `.strict()` reports an unknown key as an issue on the OBJECT, with the
 * offending keys in `issue.keys` — so the naive `path.join('.')` answers
 * "slip", which tells a hygienist reporting the error nothing they can act on.
 * This answers "slip.somethingNew".
 * @param {{ path?: (string|number)[], code?: string, keys?: string[] }} issue
 * @returns {string}
 */
function fieldOf(issue) {
  if (!issue) return '(body)';
  const path = Array.isArray(issue.path) ? [...issue.path] : [];
  if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys) && issue.keys.length > 0) {
    path.push(issue.keys[0]);
  }
  return path.length > 0 ? path.join('.') : '(body)';
}

/**
 * Parse a request body through a shared schema, or answer 400 naming the field.
 *
 * Returns the parsed value, or `null` having ALREADY sent the response — the
 * caller returns immediately on null. zod's issue path is what turns "invalid
 * body" into "slip.nextVisit.intervalMonths must be at most 24", which is the
 * difference between a message a hygienist can report and one nobody can act on.
 *
 * @template T
 * @param {import('express').Response} res
 * @param {{ safeParse: (v: unknown) => { success: boolean, data?: T, error?: any } }} schema
 * @param {unknown} body
 * @returns {T|null}
 */
function parseBody(res, schema, body) {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = fieldOf(issue);
  res.status(400).json({
    success: false,
    error: `${field}: ${issue ? issue.message : 'is not valid'}`,
    code: 'INVALID_BODY',
    field,
    // Every issue, capped — a form with three bad fields should not need three
    // round trips to discover them.
    issues: parsed.error.issues.slice(0, 10).map((i) => ({
      field: fieldOf(i),
      message: i.message,
    })),
  });
  return null;
}

/** The response shape every visit route answers with, so no screen sees two. */
function visitPayload(visit) {
  return {
    success: true,
    visit,
    // Computed rather than stored: RECORDS_MATRIX is the office's standard and
    // changing it must change what every open visit asks for, not only the ones
    // saved since.
    recordsNeeded: contract.recordsNeededFor(visit.items),
    handoffCategory: contract.deriveCategory(visit.items),
    // THE DOCTOR PICK-LIST, FROM THE OFFICE ON THE STORED VISIT.
    //
    // `Dr. ___ performed periodic exam` needs a name, and a name compiled into
    // a component is a name that can be rendered for the wrong practice. The
    // office comes off the visit row rather than off a query param for the same
    // reason every other office decision in this module does: there is no value
    // a request can pass that changes whose doctors appear on whose note.
    doctorOptions: hygStaff.doctorOptions(visit.office),
  };
}

/**
 * The typed-name block a note ends with, for THIS request's signed-in user.
 *
 * Built in the route because it needs `req` and the office; handed to the
 * composer, which stays pure. `req.user.name` is the SSO display name — who is
 * SIGNED IN, which the roster then turns into a licence line when it knows one.
 * A name it does not know prints alone. See backend/config/hygStaff.js.
 *
 * @param {import('express').Request} req
 * @param {string} office
 * @returns {string[]}
 */
function signatureFor(req, office) {
  const name = req.user && typeof req.user.name === 'string' ? req.user.name.trim() : '';
  return hygStaff.signatureBlock({ office, hygienistName: name || null });
}

/**
 * Resolve the appointment this visit belongs to, from Open Dental.
 *
 * Returns `{ ok: true, appointment, officeName }` or `{ ok: false, status, body }`
 * with the same honest refusal vocabulary the day route uses. An appointment
 * that is not on the date given is a refusal and never a fabricated visit: the
 * PatNum is what everything downstream hangs on, and guessing it is the one
 * thing this module may never do.
 */
async function resolveAppointment(req, { office, aptNum, date }) {
  const resolved = resolveHygOd(office);
  if (!resolved.ok) return { ok: false, status: resolved.status, body: resolved.body };

  const odGet = (path, params, opts) =>
    resolved.od.client.apiGetRaw(path, params, { ...(opts || {}), module: 'hyg' });

  let day;
  try {
    /*
     * CACHE-ONLY, THEN ONE PATIENT.
     *
     * This reads the whole day to find one appointment, because Open Dental
     * has no "get me this appointment" that also carries the chair and the
     * type. It used to resolve every patient on that day too — so opening one
     * visit paid the whole fan-out, about forty seconds on a cold cache, to
     * learn one name.
     *
     * Now the day comes back with cached identities only, and the ONE patient
     * this visit is about is resolved below if the cache did not have them.
     * Same names on screen, one request instead of forty.
     */
    day = await odDay.readDay(odGet, { date, office, identities: 'cached' });
  } catch {
    day = { ok: false };
  }
  if (!day.ok) {
    return {
      ok: false,
      status: 502,
      body: {
        success: false,
        error: 'Could not read the schedule from Open Dental',
        code: 'OD_READ_FAILED',
        office,
        date,
      },
    };
  }

  let appointment = day.appointments.find((a) => a.aptNum === aptNum) || null;
  if (appointment && appointment.identity === 'pending' && appointment.patNum !== null) {
    // The one patient this page is about. A miss here is not fatal: the visit
    // opens with an unnamed appointment, exactly as it always did when a
    // patient record could not be read.
    const one = await odDay.readPatients(odGet, [appointment.patNum], { office });
    const patient = one.byPatNum.get(appointment.patNum);
    appointment = patient
      ? {
          ...appointment,
          identity: 'resolved',
          patientName: patient.displayName,
          flags: {
            ...appointment.flags,
            premed: patient.premed,
            medicalAlerts: patient.medicalAlerts,
          },
        }
      : { ...appointment, identity: 'unavailable' };
  }
  if (!appointment) {
    return {
      ok: false,
      status: 404,
      body: {
        success: false,
        // Says WHICH thing is missing. "Appointment not found" would leave a
        // hygienist wondering whether the appointment or the day was wrong.
        error: `Appointment ${aptNum} is not on ${date} for this office`,
        code: 'APPOINTMENT_NOT_ON_DAY',
        office,
        date,
      },
    };
  }
  if (appointment.patNum === null) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        error: 'This appointment has no patient on it in Open Dental, so a visit cannot be started',
        code: 'APPOINTMENT_HAS_NO_PATIENT',
        office,
        date,
      },
    };
  }
  // `od` travels with it: the send path needs the SAME handle this function
  // already put through assertOfficeMatch, not a second resolution of it.
  return { ok: true, appointment, officeName: resolved.od.officeName, od: resolved.od, day };
}

/**
 * Record the appointment as this request just read it (item 33).
 *
 * Costs no Open Dental request: the appointment is the one `resolveAppointment`
 * already returned, and age/phone come from the patient cache only. A failure
 * here must not cost the hygienist her page - the ortho send says plainly when
 * it has no snapshot to file from - so it is logged and swallowed.
 */
async function rememberAppointment(req, office, aptNum, appointment) {
  try {
    const snapshot = await snapshotFromAppointment(office, appointment);
    await tenantDb.withTenantDb(req, (pool) =>
      visitStore.saveAppointmentSnapshot(pool, {
        office,
        aptNum,
        patNum: appointment.patNum,
        snapshot,
      })
    );
  } catch (err) {
    console.warn(
      `[hygvisit] could not record the appointment snapshot for ${office} apt ${aptNum}: ` +
        ((err && err.message) || String(err))
    );
  }
}

/**
 * Load the visit for a mutation, or answer the refusal.
 *
 * Every mutation below except `open` needs an EXISTING visit. Creating one here
 * would mean a stray request could start a visit with no appointment lookup
 * behind it, and therefore with no Open-Dental-derived PatNum.
 */
/**
 * The visit as a RESPONSE carries it: every staged write says whether its
 * stored words still match the existing-treatment answers (existingTxStale.js).
 * Every visit this router sends goes through here, so no mutation's answer can
 * quietly drop the "Out of date" a GET would show.
 */
async function getVisitView(pool, { office, aptNum }) {
  return existingTxStale.annotate(pool, await visitStore.getVisit(pool, { office, aptNum }));
}

async function loadForMutation(req, res, office, aptNum) {
  const visit = await tenantDb.withTenantDb(req, (pool) =>
    visitStore.getVisit(pool, { office, aptNum })
  );
  if (!visit) {
    res.status(404).json({
      success: false,
      error: 'No visit has been started for this appointment yet',
      code: 'VISIT_NOT_FOUND',
      office,
    });
    return null;
  }
  return visit;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/hyg/visit/:aptNum?office=&date=
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/:aptNum',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (!isRealDate(date)) {
      return res.status(400).json({
        success: false,
        error: 'date query param is required and must be a real calendar date (YYYY-MM-DD)',
        code: 'INVALID_DATE',
        office,
      });
    }

    const resolved = await resolveAppointment(req, { office, aptNum, date });
    if (!resolved.ok) {
      await auditHygDenial(req, 'hyg_visit', aptNum, {
        office,
        result: resolved.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
      });
      return res.status(resolved.status).json(resolved.body);
    }

    // This response carries a patient's name and their chairside flags, so it
    // is a disclosure and is audited like one — fail-closed, before the body is
    // sent. One row for the visit, one for the patient, exactly as the day
    // route does it.
    await auditHygRead(req, 'hyg_visit', { office, resourceId: aptNum });
    await auditHygReads(req, [
      {
        resourceType: 'hyg_visit_patient',
        office,
        resourceId: resolved.appointment.patNum,
      },
    ]);

    const visit = await tenantDb.withTenantDb(req, (pool) =>
      getVisitView(pool, { office, aptNum })
    );

    // ITEM 33: remember what Open Dental just said about this appointment, so
    // the ortho send can file a TC case without asking Open Dental again. Only
    // onto an existing visit of the SAME patient (the store re-checks pat_num).
    if (visit && visit.patNum === resolved.appointment.patNum) {
      await rememberAppointment(req, office, aptNum, resolved.appointment);
    }

    return res.json({
      success: true,
      office,
      officeName: resolved.officeName,
      date,
      // The header a hygienist reads: the same appointment object the day view
      // renders, with the same three-state flags and the same flagSources, so
      // a null still means "unknown" and never "no".
      appointment: resolved.appointment,
      flagSources: resolved.day.flagSources,
      // null when nobody has started one. NOT an error, and NOT a created row.
      visit,
      recordsNeeded: visit ? contract.recordsNeededFor(visit.items) : [],
      handoffCategory: visit ? contract.deriveCategory(visit.items) : 'Other',
      // Present even before a visit row exists — the form draws the doctor row
      // on first open, and `office` here is the REQUEST's office, which the
      // module gate has already checked.
      doctorOptions: hygStaff.doctorOptions(office),
      // Item 49: whether this office shows "Alert checkout" at all. The switch
      // is re-checked on every send; this only decides what the page draws.
      checkoutEnabled: await tcCheckout.isEnabled(office),
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/hyg/visit/:aptNum/open?office=&date=
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/:aptNum/open',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (!isRealDate(date)) {
      return res.status(400).json({
        success: false,
        error: 'date query param is required and must be a real calendar date (YYYY-MM-DD)',
        code: 'INVALID_DATE',
        office,
      });
    }

    const resolved = await resolveAppointment(req, { office, aptNum, date });
    if (!resolved.ok) {
      await auditHygDenial(req, 'hyg_visit', aptNum, {
        office,
        result: resolved.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
      });
      return res.status(resolved.status).json(resolved.body);
    }

    // The PatNum comes from Open Dental's own answer for this appointment.
    // There is no path through this module by which a request body sets it.
    const visit = await tenantDb.withTenantDb(req, (pool) =>
      visitStore.openVisit(pool, {
        office,
        aptNum,
        patNum: resolved.appointment.patNum,
        visitDate: date,
        actor: actorEmail(req),
      })
    );
    // Item 33 - see GET above. The row was just upserted with this PatNum.
    await rememberAppointment(req, office, aptNum, resolved.appointment);

    await audit(req, {
      action: 'CREATE',
      resourceType: 'hyg_visit',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({ ...visitPayload(visit), appointment: resolved.appointment });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/hyg/visit/:aptNum — the slip
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  '/:aptNum',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }

    const body = parseBody(res, contract.VisitUpsertRequestSchema, req.body);
    if (body === null) return undefined;

    const visit = await tenantDb.withTenantDb(req, (pool) =>
      visitStore.saveSlip(pool, { office, aptNum, slip: body.slip, actor: actorEmail(req) })
    );
    if (!visit) {
      return res.status(404).json({
        success: false,
        error: 'No visit has been started for this appointment yet',
        code: 'VISIT_NOT_FOUND',
        office,
      });
    }

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'hyg_visit',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });
    return res.json(visitPayload(visit));
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Treatment items
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/:aptNum/items',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    const input = parseBody(res, contract.TreatmentItemCreateRequestSchema, req.body);
    if (input === null) return undefined;

    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;

    const updated = await tenantDb.withTenantDb(req, async (pool) => {
      await visitStore.addItem(pool, {
        office,
        visitId: visit.visitId,
        input,
        actor: actorEmail(req),
      });
      return getVisitView(pool, { office, aptNum });
    });

    await audit(req, {
      action: 'CREATE',
      resourceType: 'hyg_treatment_item',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });
    return res.status(201).json(visitPayload(updated));
  })
);

router.put(
  '/:aptNum/items/:itemId',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    const patch = parseBody(res, contract.TreatmentItemUpdateRequestSchema, req.body);
    if (patch === null) return undefined;

    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;

    const result = await tenantDb.withTenantDb(req, async (pool) => {
      const item = await visitStore.updateItem(pool, {
        office,
        visitId: visit.visitId,
        itemId: req.params.itemId,
        patch,
        actor: actorEmail(req),
      });
      if (!item) return null;
      return getVisitView(pool, { office, aptNum });
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'No such treatment item on this visit',
        code: 'ITEM_NOT_FOUND',
        office,
      });
    }

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'hyg_treatment_item',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });
    return res.json(visitPayload(result));
  })
);

router.delete(
  '/:aptNum/items/:itemId',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }

    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;

    const result = await tenantDb.withTenantDb(req, async (pool) => {
      const removed = await visitStore.removeItem(pool, {
        office,
        visitId: visit.visitId,
        itemId: req.params.itemId,
        actor: actorEmail(req),
      });
      if (!removed) return null;
      return getVisitView(pool, { office, aptNum });
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'No such treatment item on this visit',
        code: 'ITEM_NOT_FOUND',
        office,
      });
    }

    await audit(req, {
      action: 'DELETE',
      resourceType: 'hyg_treatment_item',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });
    return res.json(visitPayload(result));
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Existing treatment (Slice 2a)
//   GET /api/hyg/visit/:aptNum/existing-tx?office=[&refresh=1]
//   PUT /api/hyg/visit/:aptNum/existing-tx/:procNum?office=
// ─────────────────────────────────────────────────────────────────────────────
//
// WHOSE PLAN COMES FROM THE STORED VISIT, NEVER FROM THE REQUEST. The office and
// PatNum are the hyg_visit row's own; there is no parameter that names either,
// so there is no request that can read another patient's plan. Both routes
// need a started visit (404 VISIT_NOT_FOUND otherwise) for exactly that reason.
//
// NOTHING HERE WRITES TO OPEN DENTAL. The read is GET-only through the office's
// own client; the answers land in hyg_existing_tx_disposition, CareIN only.

const EXISTING_TX_READ_FAILED = "Couldn't load existing treatment from Open Dental";

/** `:procNum` as a positive integer, or null. Same rule as `:aptNum`. */
function procNumFrom(req) {
  const raw = String(req.params.procNum || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The patient's treatment-planned procedures, for the STORED visit's office and
 * PatNum — cached up to ten minutes (services/hyg/existingTreatment.js).
 *
 * Returns `{ ok: true, items, readAt, cached }` or `{ ok: false, status, body }`.
 * An Open Dental failure is a 502 carrying the sentence the section shows. It is
 * never an empty list, because an empty list reads as "this patient has no
 * treatment planned".
 */
async function readExistingTxFor(visit, { refresh }) {
  const resolved = resolveHygOd(visit.office);
  if (!resolved.ok) return { ok: false, status: resolved.status, body: resolved.body };
  const odGet = (path, params, opts) =>
    resolved.od.client.apiGetRaw(path, params, { ...(opts || {}), module: 'hyg' });
  try {
    const read = await existingTreatment.loadExistingTreatment(odGet, {
      office: visit.office,
      visitId: visit.visitId,
      patNum: visit.patNum,
      refresh,
    });
    return { ok: true, ...read };
  } catch (err) {
    console.error(
      `[hygexistingtx] office=${visit.office} apt=${visit.aptNum} Open Dental read failed: ` +
        String((err && err.message) || err).slice(0, 200)
    );
    return {
      ok: false,
      status: 502,
      body: { success: false, error: EXISTING_TX_READ_FAILED, code: 'OD_READ_FAILED', office: visit.office },
    };
  }
}

/**
 * Record the read's outcome on the visit (hygiene Slice 2b). Best effort, like
 * rememberAppointment: a failure here costs the Router its "every item" list
 * (it then says the plan was not recorded), never the hygienist her page.
 */
async function rememberExistingTxRead(req, visit, read) {
  if (!read.ok && read.body && read.body.code !== 'OD_READ_FAILED') return;
  try {
    await tenantDb.withTenantDb(req, (pool) =>
      read.ok
        ? existingTxStore.recordLoaded(pool, {
            office: visit.office,
            visitId: visit.visitId,
            readAt: read.readAt,
            items: read.items,
          })
        : existingTxStore.recordFailed(pool, {
            office: visit.office,
            visitId: visit.visitId,
            at: new Date().toISOString(),
          })
    );
  } catch (err) {
    console.warn(
      `[hygexistingtx] could not record the read for ${visit.office} apt ${visit.aptNum}: ` +
        ((err && err.message) || String(err))
    );
  }
}

router.get(
  '/:aptNum/existing-tx',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;

    const startedAt = Date.now();
    const read = await readExistingTxFor(visit, { refresh: req.query.refresh === '1' });
    // SLICE 2b: REMEMBER WHAT THE READ SAID, so the Router can list every item
    // (answered or not) and can tell "never loaded" from "could not be loaded".
    // Only an Open Dental outcome is recorded — an office that is not ready
    // never reached Open Dental and says nothing about the plan.
    await rememberExistingTxRead(req, visit, read);
    if (!read.ok) {
      await auditHygDenial(req, 'hyg_existing_tx', aptNum, {
        office,
        result: read.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
      });
      return res.status(read.status).json(read.body);
    }

    const procNums = read.items.map((i) => i.procNum);
    const stored = await tenantDb.withTenantDb(req, async (pool) => {
      const [frozen, dispositions, last] = await Promise.all([
        existingTxStore.isFrozen(pool, { office: visit.office, visitId: visit.visitId }),
        existingTxStore.listForVisit(pool, { office: visit.office, visitId: visit.visitId }),
        existingTxStore.lastDiscussed(pool, {
          office: visit.office,
          patNum: visit.patNum,
          visitId: visit.visitId,
          visitDate: visit.visitDate,
          procNums,
        }),
      ]);
      return { frozen, dispositions, last };
    });

    // A patient's treatment plan is in this body — and "nothing planned" is a
    // statement about a patient too — so it audits before it is sent, fail-
    // closed, whether or not the read was a cache hit. One row for the visit,
    // one for the patient, the same pair the visit GET writes.
    await auditHygRead(req, 'hyg_existing_tx', { office, resourceId: aptNum });
    await auditHygReads(req, [
      { resourceType: 'hyg_existing_tx_patient', office, resourceId: visit.patNum },
    ]);

    const ms = Date.now() - startedAt;
    // Counts and milliseconds only — never a PatNum, never a code.
    console.log(
      `[hygexistingtx] office=${office} apt=${aptNum} items=${read.items.length} ` +
        `cached=${read.cached} ms=${ms}${ms > 500 ? ' SLOW' : ''}`
    );

    return res.json({
      success: true,
      office,
      aptNum,
      frozen: stored.frozen,
      readAt: read.readAt,
      items: read.items.map((item) => ({
        ...item,
        disposition: stored.dispositions.get(item.procNum) || null,
        lastDiscussed: stored.last.get(item.procNum) || null,
      })),
    });
  })
);

router.put(
  '/:aptNum/existing-tx/:procNum',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    const procNum = procNumFrom(req);
    if (procNum === null) {
      return res.status(400).json({
        success: false,
        error: 'procNum must be a positive whole number',
        code: 'INVALID_PROC_NUM',
        office,
      });
    }
    const body = parseBody(res, contract.ExistingTxDispositionInputSchema, req.body);
    if (body === null) return undefined;
    // A blank note is no note, so "cleared" and "never typed" store the same.
    const note = body.note === null ? null : body.note.trim() || null;
    const input = { ...body, note };

    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;

    const frozenRefusal = {
      success: false,
      error: 'This visit has been sent, so its existing-treatment answers can no longer be changed',
      code: 'EXISTING_TX_FROZEN',
      office,
    };
    // Checked first so a frozen visit costs no Open Dental request. The upsert
    // below re-checks in the same statement as the write; this is not the guard.
    const frozen = await tenantDb.withTenantDb(req, (pool) =>
      existingTxStore.isFrozen(pool, { office: visit.office, visitId: visit.visitId })
    );
    if (frozen) return res.status(409).json(frozenRefusal);

    // THE PROCEDURE MUST BE IN THIS VISIT'S OWN READ — the stored office and
    // PatNum's plan — or there is nothing to answer about. A ProcNum from another
    // patient, or from the same number in the other office, is a 404 here.
    const read = await readExistingTxFor(visit, { refresh: false });
    if (!read.ok) {
      await auditHygDenial(req, 'hyg_existing_tx', aptNum, {
        office,
        result: read.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
      });
      return res.status(read.status).json(read.body);
    }
    const item = read.items.find((i) => i.procNum === procNum);
    if (!item) {
      await auditHygDenial(req, 'hyg_existing_tx', aptNum, { office, result: 'UNAUTHORIZED' });
      return res.status(404).json({
        success: false,
        error: "That procedure is not on this patient's treatment plan in Open Dental",
        code: 'PROC_NOT_IN_PLAN',
        office,
      });
    }

    // The snapshot is the SERVER's read of the procedure, never the client's.
    const snapshot = {
      code: item.code,
      description: item.description,
      tooth: item.tooth,
      surface: item.surface,
      date_tp: item.dateTp,
      priority_name: item.priorityName,
      // Slice 2b: the Router's "Already scheduled", as the read said it.
      scheduled: item.scheduled,
    };
    const saved = await tenantDb.withTenantDb(req, (pool) =>
      existingTxStore.saveDisposition(pool, {
        office: visit.office,
        visit,
        procNum,
        input,
        snapshot,
        actor: actorEmail(req),
      })
    );
    if (!saved.ok) return res.status(409).json(frozenRefusal);

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'hyg_existing_tx',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      // An identifier Open Dental minted, never a code or a name.
      sourceRef: `proc_num:${procNum}`,
    });
    // The staged writes AFTER the save: a note staged before this answer now
    // says "Out of date", and says it in this response rather than on the next GET.
    const after = await tenantDb.withTenantDb(req, (pool) => getVisitView(pool, { office, aptNum }));
    return res.json({
      success: true,
      office,
      aptNum,
      procNum,
      disposition: saved.disposition,
      stagedWrites: after ? after.stagedWrites : [],
    });
  })
);

/**
 * PUT /api/hyg/visit/:aptNum/existing-tx — the "Select" bulk answer.
 *
 * THE SINGLE PUT'S GUARDS, FOR EVERY ROW, AND ALL OR NOTHING:
 *   - office and PatNum come off the STORED visit (loadForMutation), never the body;
 *   - every ProcNum must be in this visit's own Open Dental read, or the WHOLE
 *     batch is a 404 and nothing is written — one stranger ProcNum is not "most
 *     of them saved";
 *   - a frozen visit is a 409, checked first and again inside the one statement
 *     that writes them all (existingTxStore.saveDispositions);
 *   - audited exactly as the single PUT is: one UPDATE row per procedure, by the
 *     identifier Open Dental minted.
 * At most EXISTING_TX_BATCH_MAX (200) rows; a ProcNum may appear once.
 */
router.put(
  '/:aptNum/existing-tx',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    const body = parseBody(res, contract.ExistingTxBatchRequestSchema, req.body);
    if (body === null) return undefined;

    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;

    const frozenRefusal = {
      success: false,
      error: 'This visit has been sent, so its existing-treatment answers can no longer be changed',
      code: 'EXISTING_TX_FROZEN',
      office,
    };
    const frozen = await tenantDb.withTenantDb(req, (pool) =>
      existingTxStore.isFrozen(pool, { office: visit.office, visitId: visit.visitId })
    );
    if (frozen) return res.status(409).json(frozenRefusal);

    const read = await readExistingTxFor(visit, { refresh: false });
    if (!read.ok) {
      await auditHygDenial(req, 'hyg_existing_tx', aptNum, {
        office,
        result: read.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
      });
      return res.status(read.status).json(read.body);
    }
    const planned = new Map(read.items.map((i) => [i.procNum, i]));
    if (body.items.some((entry) => !planned.has(entry.procNum))) {
      await auditHygDenial(req, 'hyg_existing_tx', aptNum, { office, result: 'UNAUTHORIZED' });
      return res.status(404).json({
        success: false,
        error:
          "One or more of those procedures is not on this patient's treatment plan in Open Dental. " +
          'Nothing was saved.',
        code: 'PROC_NOT_IN_PLAN',
        office,
      });
    }

    const entries = body.items.map((entry) => {
      const item = planned.get(entry.procNum);
      return {
        procNum: entry.procNum,
        input: {
          clinical: entry.clinical,
          patient: entry.patient,
          waitTimeframe: entry.waitTimeframe,
          // A blank note is no note, exactly as the single PUT stores it.
          note: entry.note === null ? null : entry.note.trim() || null,
        },
        // The SERVER's read of each procedure, never the client's.
        snapshot: {
          code: item.code,
          description: item.description,
          tooth: item.tooth,
          surface: item.surface,
          date_tp: item.dateTp,
          priority_name: item.priorityName,
          scheduled: item.scheduled,
        },
      };
    });
    const saved = await tenantDb.withTenantDb(req, (pool) =>
      existingTxStore.saveDispositions(pool, {
        office: visit.office,
        visit,
        entries,
        actor: actorEmail(req),
      })
    );
    if (!saved.ok) return res.status(409).json(frozenRefusal);

    for (const entry of entries) {
      await audit(req, {
        action: 'UPDATE',
        resourceType: 'hyg_existing_tx',
        resourceId: aptNum,
        result: 'SUCCESS',
        office,
        sourceRef: `proc_num:${entry.procNum}`,
      });
    }
    const after = await tenantDb.withTenantDb(req, (pool) => getVisitView(pool, { office, aptNum }));
    return res.json({
      success: true,
      office,
      aptNum,
      items: entries.map((e) => ({ procNum: e.procNum, disposition: saved.dispositions.get(e.procNum) })),
      stagedWrites: after ? after.stagedWrites : [],
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Staged writes
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/:aptNum/staged-writes',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    // The body carries ONE field. Title, summary, preview and payload are
    // composed server-side from the stored visit — see stagedWriteComposer.js.
    const body = parseBody(res, contract.StagedWriteCreateRequestSchema, req.body);
    if (body === null) return undefined;

    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;

    const outcome = await tenantDb.withTenantDb(req, async (pool) => {
      // SLICE 2b: the existing-treatment answers, from the STORED dispositions
      // and their own snapshots — never from this request. Only the note and the
      // slip print them; the handoff reads them at send time, frozen.
      const existingTx =
        body.kind === 'note' || body.kind === 'router'
          ? await existingTxStore.loadForSend(pool, { office, visitId: visit.visitId })
          : undefined;
      const staged = await visitStore.stageWrite(pool, {
        office,
        visit,
        kind: body.kind,
        actor: actorEmail(req),
        // BOUND, not passed through the store. The signature depends on who is
        // signed in and which office this is, and visitStore has no business
        // knowing either — it holds rows.
        compose: (kind, ctx) =>
          composer.compose(kind, { ...ctx, signature: signatureFor(req, office), existingTx }),
      });
      if (!staged.ok) return staged;
      return { ok: true, visit: await getVisitView(pool, { office, aptNum }) };
    });

    if (!outcome.ok) {
      // 422: the request was well-formed and this is a refusal about the
      // CONTENT — there is nothing of that kind to send, or it has already gone.
      return res.status(outcome.code === 'STAGED_WRITE_IMMUTABLE' ? 409 : 422).json({
        success: false,
        error: outcome.message,
        code: outcome.code,
        office,
      });
    }

    await audit(req, {
      action: 'CREATE',
      resourceType: 'hyg_staged_write',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });
    return res.status(201).json(visitPayload(outcome.visit));
  })
);

router.delete(
  '/:aptNum/staged-writes/:kind',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    // The kind comes off the PATH, so it is validated the same way a body would
    // be rather than trusted because it is shorter.
    const kind = contract.StagedWriteKindSchema.safeParse(req.params.kind);
    if (!kind.success) {
      return res.status(400).json({
        success: false,
        error: 'kind must be one of: ' + contract.StagedWriteKindSchema.options.join(', '),
        code: 'INVALID_BODY',
        field: 'kind',
        office,
      });
    }

    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;

    const outcome = await tenantDb.withTenantDb(req, async (pool) => {
      // ITEM 13: a correction taken off the list goes back to `Amending`, not
      // `Draft` — the exam it corrects is still in Open Dental.
      const live =
        kind.data === 'perio' ? (await perioSend.readSend(pool, { office, visit })).live : null;
      const removed = await visitStore.unstageWrite(pool, {
        office,
        visitId: visit.visitId,
        kind: kind.data,
        actor: actorEmail(req),
        amending: live !== null,
      });
      if (!removed.ok) return removed;
      return { ok: true, visit: await getVisitView(pool, { office, aptNum }) };
    });

    if (!outcome.ok) {
      return res.status(outcome.code === 'STAGED_WRITE_IMMUTABLE' ? 409 : 404).json({
        success: false,
        error: outcome.message,
        code: outcome.code,
        office,
      });
    }

    await audit(req, {
      action: 'DELETE',
      resourceType: 'hyg_staged_write',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });
    return res.json(visitPayload(outcome.visit));
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// The perio chart (H4 slice 10) — READ, DISPLAY, STAGE. NOTHING SENDS.
// ─────────────────────────────────────────────────────────────────────────────
//
// Three routes, and they live in THIS file for the same reason the send does:
// the mutation allow-list in hygNoOdWrites.test.js names one file.
//
//   GET /:aptNum/perio          the stored chart. Our database only.
//   PUT /:aptNum/perio          store the chart, whole, as a Draft.
//   GET /:aptNum/perio/prior    Open Dental's last exam. GETs only.
//
// The chart and the prior exam are separate requests on purpose. The chart is
// what she is typing into and it paints from Postgres in milliseconds; the prior
// exam is two paged reads on a credential three modules share. Waiting on the
// second to show the first would put a spinner in front of the part of the page
// she is working in.
//
// Staging is the existing POST /:aptNum/staged-writes with `kind: 'perio'`. A
// staged chart is sent from its own page (below) or rides the visit's Send
// (item 15) — the same perioSend machinery either way; see services/hyg/sendVisit.js.

/** The response every stored-chart route answers with. */
function perioPayload(office, aptNum, visit, perio) {
  const chart = perio ? perio.chart : contract.emptyPerioChart();
  return {
    success: true,
    office,
    aptNum,
    visitStarted: Boolean(visit),
    chart,
    stagedWrite: perio && perio.row ? visitStore.toStagedWrite(perio.row) : null,
    counts: contract.countPerioChart(chart),
    /*
     * ITEM 27: has a chart for this visit ever been STORED? The pre-skip hangs
     * off this and NOT off `counts.empty`, because an empty chart is not the
     * same thing as an untouched one — un-skipping the last pre-skipped tooth
     * leaves an empty chart behind, and re-skipping it on the next open would
     * be CareIN overruling her. A stored row says she has been here.
     */
    chartStored: Boolean(perio && perio.row),
  };
}

router.get(
  '/:aptNum/perio',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }

    const loaded = await tenantDb.withTenantDb(req, async (pool) => {
      const visit = await getVisitView(pool, { office, aptNum });
      if (!visit) return { visit: null, perio: null };
      return { visit, perio: await visitStore.getPerio(pool, { office, visitId: visit.visitId }) };
    });

    // Readings are a patient's clinical data even without a name beside them,
    // so a stored chart is audited as a disclosure — fail-closed, before the
    // body. No visit means nothing stored and nobody disclosed: no row.
    if (loaded.visit) {
      await auditHygRead(req, 'hyg_perio', { office, resourceId: aptNum });
      await auditHygReads(req, [
        { resourceType: 'hyg_perio_patient', office, resourceId: loaded.visit.patNum },
      ]);
    }
    return res.json(perioPayload(office, aptNum, loaded.visit, loaded.perio));
  })
);

router.put(
  '/:aptNum/perio',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    const body = parseBody(res, contract.PerioChartSaveRequestSchema, req.body);
    if (body === null) return undefined;

    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;

    const outcome = await tenantDb.withTenantDb(req, async (pool) => {
      // ITEM 13: a chart whose exam is LIVE in Open Dental is being corrected,
      // so an unsent change rests in `Amending`, not `Draft` — the difference is
      // whether the row still says an exam exists.
      const { live } = await perioSend.readSend(pool, { office, visit });
      const saved = await visitStore.savePerioDraft(pool, {
        office,
        visit,
        chart: body.chart,
        actor: actorEmail(req),
        amending: live !== null,
      });
      if (!saved.ok) return saved;
      return { ok: true, perio: await visitStore.getPerio(pool, { office, visitId: visit.visitId }) };
    });

    if (!outcome.ok) {
      return res.status(409).json({
        success: false,
        error: outcome.message,
        code: outcome.code,
        office,
      });
    }

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'hyg_perio',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });
    return res.json(perioPayload(office, aptNum, visit, outcome.perio));
  })
);

router.get(
  '/:aptNum/perio/prior',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (!isRealDate(date)) {
      return res.status(400).json({
        success: false,
        error: 'date query param is required and must be a real calendar date (YYYY-MM-DD)',
        code: 'INVALID_DATE',
        office,
      });
    }

    // WHOSE exam comes from Open Dental's answer for this appointment, never
    // from a request — the same lookup the visit itself was opened with.
    const resolved = await resolveAppointment(req, { office, aptNum, date });
    if (!resolved.ok) {
      await auditHygDenial(req, 'hyg_perio_prior', aptNum, {
        office,
        result: resolved.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
      });
      return res.status(resolved.status).json(resolved.body);
    }
    const patNum = resolved.appointment.patNum;

    const visit = await tenantDb.withTenantDb(req, (pool) =>
      getVisitView(pool, { office, aptNum })
    );
    if (visit && visit.patNum !== patNum) {
      // A chart composed for one patient must never be drawn beside another
      // patient's history. There is no version of this where guessing is right.
      await auditHygDenial(req, 'hyg_perio_prior', aptNum, { office, result: 'UNAUTHORIZED' });
      return res.status(409).json({
        success: false,
        error:
          'This appointment now belongs to a different patient in Open Dental than the visit ' +
          'the chart was entered on.',
        code: 'PATIENT_CHANGED',
        office,
      });
    }

    const startedAt = Date.now();
    let odPerioReads = 0;
    const odGet = (path, params, opts) => {
      odPerioReads += 1;
      return resolved.od.client.apiGetRaw(path, params, { ...(opts || {}), module: 'hyg' });
    };

    /*
     * ITEM 14: THE DRIFT CHECK RIDES THIS READ, IT DOES NOT ADD ONE.
     *
     * `Written` claims every site was read back and matched, and goes on
     * claiming it after somebody deletes or edits the exam in Open Dental's own
     * perio chart. So a `Written` chart is re-checked when it is OPENED — against
     * the exam list this read already fetches, and against the readings it
     * already fetched whenever CareIN's exam is the newest one, which it is on
     * every ordinary open. Nothing here writes, and a person presses the resend.
     */
    /*
     * ITEM 27: AND WHETHER A CHART HAS EVER BEEN STORED FOR THIS VISIT.
     *
     * The pre-skip below can only ever apply to a chart nobody has touched, so
     * a visit that already holds one does not spend an Open Dental request
     * asking which teeth are missing. The client gates on the same fact and is
     * the authority — this read only decides whether the request is worth
     * making, and getting it wrong in this direction costs a request, never a
     * reading.
     */
    const loaded = await tenantDb.withTenantDb(req, async (pool) => {
      if (!visit) return { context: { staged: null, live: null }, chartStored: false };
      const context = await perioDrift.readDriftContext(pool, { office, visit });
      const perio = await visitStore.getPerio(pool, { office, visitId: visit.visitId });
      return { context, chartStored: Boolean(perio && perio.row) };
    });
    const context = loaded.context;

    let prior;
    let read = { ok: false, list: [], error: 'the exam list read threw' };
    let latest = null;
    try {
      ({ prior, exams: read, latest } = await odPerio.readPriorPerio(odGet, { patNum }));
    } catch (err) {
      prior = {
        status: 'unavailable',
        message: 'The last perio exam could not be read from Open Dental.',
        detail: String((err && err.message) || 'threw').slice(0, 200),
      };
    }

    let drift = perioDrift.NOT_APPLICABLE;
    try {
      ({ drift } = await perioDrift.checkDrift({
        staged: context.staged,
        live: context.live,
        exams: read,
        latest,
        odGet,
        careinExamNums: context.careinExamNums,
      }));
    } catch (err) {
      // A drift check that throws must not cost the chart its prior panel, and
      // must not say anything either: an unfinished comparison is exactly the
      // `unknown` row of the table.
      drift =
        context.live && context.live.exam_num !== null
          ? perioDrift.unreadableOd(context.live.exam_num)
          : perioDrift.NOT_APPLICABLE;
      console.error(`[hygperio] drift check failed: ${String((err && err.message) || err)}`);
    }

    /*
     * ITEM 27: WHICH TEETH OPEN DENTAL SAYS ARE MISSING, so a chart nobody has
     * touched opens with them already skipped.
     *
     * THIS IS THE ONE PLACE IN THE SLICE THAT SPENDS A REQUEST, and it spends
     * at most one: `readMissingTeeth` makes a single GET and does not page.
     * It rides this response rather than one of its own because this is the
     * request that is already waiting on Open Dental.
     *
     * `200 []` IS NOT A FAILURE. It is "this patient has no missing teeth" —
     * measured, not assumed — and it pre-skips nothing, which is the same
     * visible outcome as a failed read but an entirely different claim.
     */
    let preSkip = { status: 'unavailable' };
    let initials = null;
    if (!loaded.chartStored) {
      try {
        initials = await odToothInitials.readMissingTeeth(odGet, { patNum });
        preSkip = initials.preSkip;
      } catch (err) {
        // A convenience must never cost the chart its prior panel. Nothing
        // pre-skipped, nothing said: she skips the teeth herself, as today.
        console.error(`[hygperio] tooth initials read failed: ${String((err && err.message) || err)}`);
      }
    }

    // The appointment (a name) and a perio history are both in this body, so
    // both are audited before it is sent — including when the history came
    // back `none`, because the name did not.
    await auditHygRead(req, 'hyg_perio_prior', { office, resourceId: aptNum });
    await auditHygReads(req, [{ resourceType: 'hyg_perio_prior_patient', office, resourceId: patNum }]);
    /*
     * THE RE-READ IS A FETCH AND DOES NOT AUDIT. THE MOMENT IT TELLS HER
     * SOMETHING, IT DOES.
     *
     * `matches` says nothing to the user, and neither does `unknown` for
     * `unreadable_od` (Open Dental could not be read), so there is nothing
     * disclosed and nothing to record. `missing` and `changed` are a statement
     * about what a chart of record does and does not contain — that is the
     * disclosure, and it carries which of the answers it was and the exam number.
     *
     * ITEM 32: `unknown` for `uninterpretable` NAMES TEETH — "Open Dental holds a
     * value here CareIN can't read (#3 B gingival margin)" — and naming teeth is
     * the disclosure, so it audits too. `prior_state` is `unknown:uninterpretable`
     * and `source_ref` carries the exam number AND the positions it named
     * (`perioDrift.driftAuditRef`): identifiers only, never the raw value.
     *
     * Fail-CLOSED, like every other audit on this path: no trail, no answer.
     */
    if (perioDrift.driftDiscloses(drift)) {
      await audit(req, {
        action: 'READ',
        resourceType: 'hyg_perio_drift',
        resourceId: aptNum,
        result: 'SUCCESS',
        office,
        sourceRef: perioDrift.driftAuditRef(drift),
        priorState: drift.status === 'unknown' ? `unknown:${drift.reason}` : drift.status,
      });
    }
    /*
     * SAME RULE FOR THE PRE-SKIP: naming teeth is the disclosure, so naming
     * teeth is what audits.
     *
     * `unavailable` and a `ready` answer with no teeth both say nothing about
     * this patient — one is a failed fetch and the other is "nothing to show" —
     * so neither writes a row, exactly as `matches` and `unknown` do not. No
     * `priorState`: a pre-skip only ever lands on a chart nobody has touched,
     * so it replaces no decision anybody made.
     */
    if (preSkip.status === 'ready' && preSkip.teeth.length > 0) {
      await audit(req, {
        action: 'READ',
        resourceType: 'hyg_perio_missing_teeth',
        resourceId: aptNum,
        result: 'SUCCESS',
        office,
        sourceRef: null,
      });
    }

    // Counts and milliseconds only — never a PatNum, never a reading.
    console.log(
      `[hygperio] office=${office} apt=${aptNum} prior=${prior.status} drift=${drift.status}` +
        (drift.status === 'unknown' ? `:${drift.reason}` : '') +
        ' ' +
        `preskip=${preSkip.status}` +
        (initials
          ? `/${initials.missing} rows=${initials.rows} foreign=${initials.foreign} ` +
            `unparsed=${initials.unparsed} truncated=${initials.truncated}`
          : '/not_read') +
        ` od_perio_reads=${odPerioReads} ms=${Date.now() - startedAt}`
    );
    /*
     * A ROW FOR ANOTHER PATIENT IS THE ONE THING HERE WORTH SHOUTING ABOUT.
     * Unfiltered, `/toothinitials` answers with the whole practice (100 rows
     * across 28 PatNums, measured), so if `PatNum=` ever stops being honoured
     * this counter is how it gets noticed. Counts only — never a PatNum.
     */
    if (initials && initials.foreign > 0) {
      console.warn(
        `[hygperio] office=${office} apt=${aptNum} /toothinitials returned ` +
          `${initials.foreign} row(s) for ANOTHER PatNum; dropped`
      );
    }

    return res.json({
      success: true,
      office,
      aptNum,
      date,
      appointment: resolved.appointment,
      prior,
      drift,
      preSkip,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// The perio SEND (H4 item 12) — strings where they cannot lie, rows where they
// cannot be used, every site read back, and an undo
// ─────────────────────────────────────────────────────────────────────────────
//
//   GET  /:aptNum/perio/send               where the send stands. Our database only.
//   POST /:aptNum/perio/send               confirm: fingerprint + exam date + provider,
//                                          re-derived server-side; then the first step.
//   POST /:aptNum/perio/send/step          the next bounded step. The page calls it
//                                          until the send finishes, stops or pauses.
//   POST /:aptNum/perio/send/delete-exam   the undo: the exam THIS send created,
//                                          named again by number.
//
// Every Open Dental write happens inside one of these requests, attributed to the
// person making it and audited one row per write. There is no background thread:
// leaving the page pauses the send, and the next step reads Open Dental before it
// posts anything. See services/hyg/perioSend.js.

/** The send, as the screen reads it. */
async function perioSendPayload(req, office, aptNum, visit, paused) {
  return tenantDb.withTenantDb(req, async (pool) => {
    const { staged, send, live } = await perioSend.readSend(pool, { office, visit });
    return {
      success: true,
      office,
      aptNum,
      stagedWrite: staged ? visitStore.toStagedWrite(staged) : null,
      send: perioSend.sendView(send),
      // What is in Open Dental now, which is what a correction replaces.
      live: perioSend.sendView(live),
      paused: paused || null,
    };
  });
}

function perioOdGet(od) {
  return (path, params, opts) => od.client.apiGetRaw(path, params, { ...(opts || {}), module: 'hyg' });
}

/** ONE audit row per Open Dental write attempted, success or failure. */
async function auditPerioWrites(req, office, aptNum, attempted) {
  if (!attempted || attempted.length === 0) return;
  await auditMany(
    req,
    attempted.map((a) => ({
      action: a.action,
      resourceType: 'hyg_perio_send',
      resourceId: aptNum,
      result: a.ok ? 'SUCCESS' : 'ERROR',
      office,
      sourceRef: null,
    }))
  );
}

/**
 * A completed swap, in the trail: one row for the amendment and ONE PER SITE it
 * changed (item 13).
 *
 * What these rows carry is IDENTIFIERS — the actor (from the request), the
 * appointment, which exam replaced which, and which sites moved. What they do
 * NOT carry is the readings: `audit_log` is explicit that nothing in it may be
 * a PHI value, and `prior_state` is slug-shaped by a CHECK. The old and new
 * readings live on the send (`amend_diff`) and on the screen, which is where a
 * hygienist reads them anyway.
 */
async function auditPerioAmendment(req, office, aptNum, amend) {
  const swapRef = `perio_exam:${amend.oldExam}->${amend.newExam}`;
  await auditMany(req, [
    {
      action: 'UPDATE',
      resourceType: 'hyg_perio_amend',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: swapRef,
      priorState: amend.replacedRemoved ? 'replaced' : 'replaced_not_removed',
    },
    ...amend.changes.map((change) => ({
      action: 'UPDATE',
      resourceType: 'hyg_perio_amend_site',
      resourceId: `${aptNum}:${change.tooth}${change.surface ? '-' + change.surface : ''}`,
      result: 'SUCCESS',
      office,
      sourceRef: swapRef,
      priorState: change.kind,
    })),
  ]);
}

async function runPerioStep(req, office, aptNum, od, visit) {
  const step = await tenantDb.withTenantDb(req, (pool) =>
    perioSend.stepPerioSend({ pool, office, visit, od, odGet: perioOdGet(od) })
  );
  if (step.ok) await auditPerioWrites(req, office, aptNum, step.attempted);
  if (step.ok && step.amend) await auditPerioAmendment(req, office, aptNum, step.amend);
  return step;
}

/** Office readiness and the visit, for the routes that continue a send. */
async function perioContinuation(req, res, office, aptNum) {
  const resolved = resolveHygOd(office);
  if (!resolved.ok) {
    await auditHygDenial(req, 'hyg_perio_send', aptNum, {
      office,
      result: resolved.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
    });
    res.status(resolved.status).json(resolved.body);
    return null;
  }
  const visit = await loadForMutation(req, res, office, aptNum);
  if (!visit) return null;
  return { od: resolved.od, visit };
}

function badAptNum(res, office) {
  return res.status(400).json({
    success: false,
    error: 'aptNum must be a positive whole number',
    code: 'INVALID_APT_NUM',
    office,
  });
}

router.get(
  '/:aptNum/perio/send',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) return badAptNum(res, office);
    const visit = await tenantDb.withTenantDb(req, (pool) => getVisitView(pool, { office, aptNum }));
    if (!visit) {
      return res.json({ success: true, office, aptNum, stagedWrite: null, send: null, live: null, paused: null });
    }
    await auditHygRead(req, 'hyg_perio_send', { office, resourceId: aptNum });
    return res.json(await perioSendPayload(req, office, aptNum, visit, null));
  })
);

router.post(
  '/:aptNum/perio/send',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) return badAptNum(res, office);
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (!isRealDate(date)) {
      return res.status(400).json({
        success: false,
        error: 'date query param is required and must be a real calendar date (YYYY-MM-DD)',
        code: 'INVALID_DATE',
        office,
      });
    }
    const body = parseBody(res, contract.PerioSendRequestSchema, req.body);
    if (body === null) return undefined;

    // The appointment is re-read from Open Dental at confirm time: the provider
    // the exam is filed under comes from HERE, and the office handle has been put
    // through assertOfficeMatch before anything is written.
    const resolved = await resolveAppointment(req, { office, aptNum, date });
    if (!resolved.ok) {
      await auditHygDenial(req, 'hyg_perio_send', aptNum, {
        office,
        result: resolved.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
      });
      return res.status(resolved.status).json(resolved.body);
    }
    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;
    if (resolved.appointment.patNum !== visit.patNum) {
      await auditHygDenial(req, 'hyg_perio_send', aptNum, { office, result: 'UNAUTHORIZED' });
      return res.status(409).json({
        success: false,
        error:
          'This appointment now belongs to a different patient in Open Dental than the visit ' +
          'the chart was entered on. Nothing was sent.',
        code: 'PATIENT_CHANGED',
        office,
      });
    }

    const started = await tenantDb.withTenantDb(req, (pool) =>
      perioSend.startPerioSend({
        pool,
        office,
        visit,
        appointment: resolved.appointment,
        request: body,
        actor: actorEmail(req),
        // A correction re-reads the exam it replaces before anything is written.
        odGet: perioOdGet(resolved.od),
      })
    );
    if (!started.ok) {
      await auditHygDenial(req, 'hyg_perio_send', aptNum, { office, result: 'UNAUTHORIZED' });
      return res.status(started.status).json({ success: false, error: started.error, code: started.code, office });
    }
    // The confirmation is a recorded act of its own, before anything is written.
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'hyg_perio_send',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    const step = await runPerioStep(req, office, aptNum, resolved.od, visit);
    if (!step.ok) {
      return res.status(step.status).json({ success: false, error: step.error, code: step.code, office });
    }
    return res.json(await perioSendPayload(req, office, aptNum, visit, step.paused));
  })
);

router.post(
  '/:aptNum/perio/send/step',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) return badAptNum(res, office);
    const cont = await perioContinuation(req, res, office, aptNum);
    if (!cont) return undefined;

    const step = await runPerioStep(req, office, aptNum, cont.od, cont.visit);
    if (!step.ok) {
      return res.status(step.status).json({ success: false, error: step.error, code: step.code, office });
    }
    return res.json(await perioSendPayload(req, office, aptNum, cont.visit, step.paused));
  })
);

router.post(
  '/:aptNum/perio/send/delete-exam',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) return badAptNum(res, office);
    const body = parseBody(res, contract.PerioDeleteExamRequestSchema, req.body);
    if (body === null) return undefined;
    const cont = await perioContinuation(req, res, office, aptNum);
    if (!cont) return undefined;

    const outcome = await tenantDb.withTenantDb(req, (pool) =>
      perioSend.deletePerioExamForSend({
        pool,
        office,
        visit: cont.visit,
        od: cont.od,
        odGet: perioOdGet(cont.od),
        request: body,
        actor: actorEmail(req),
      })
    );
    await auditPerioWrites(req, office, aptNum, outcome.attempted);
    if (!outcome.ok) {
      if (!outcome.attempted || outcome.attempted.length === 0) {
        // A guard said no before Open Dental was asked. Still a recorded attempt.
        await auditHygDenial(req, 'hyg_perio_send', aptNum, {
          office,
          result: outcome.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
        });
      }
      return res.status(outcome.status).json({ success: false, error: outcome.error, code: outcome.code, office });
    }
    if (outcome.alreadyGone) {
      // No delete was issued, but the send's record changed: say who changed it.
      await audit(req, {
        action: 'UPDATE',
        resourceType: 'hyg_perio_send',
        resourceId: aptNum,
        result: 'SUCCESS',
        office,
        sourceRef: null,
      });
    }
    return res.json(await perioSendPayload(req, office, aptNum, cont.visit, null));
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Correcting a chart that is already in Open Dental (H4 item 13)
// ─────────────────────────────────────────────────────────────────────────────
//
//   POST /:aptNum/perio/amend                 open a Written chart for a correction
//   POST /:aptNum/perio/amend/cancel          abandon it; the chart goes back
//   POST /:aptNum/perio/send/remove-replaced  the swap's last step, run again
//
// The correction itself goes out through the ordinary send routes above: an
// amendment IS a send, of a new exam, which replaces the old one only after
// every site of it has been read back. Opening and abandoning a correction
// write NOTHING to Open Dental.

router.post(
  '/:aptNum/perio/amend',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) return badAptNum(res, office);
    const cont = await perioContinuation(req, res, office, aptNum);
    if (!cont) return undefined;

    const opened = await tenantDb.withTenantDb(req, (pool) =>
      perioSend.beginAmendment({
        pool,
        office,
        visit: cont.visit,
        odGet: perioOdGet(cont.od),
        actor: actorEmail(req),
      })
    );
    if (!opened.ok) {
      await auditHygDenial(req, 'hyg_perio_amend', aptNum, {
        office,
        result: opened.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
      });
      return res.status(opened.status).json({ success: false, error: opened.error, code: opened.code, office });
    }
    // Opening a sent chart for correction is itself a recorded act: it is the
    // moment a Written chart became editable again, and by whom.
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'hyg_perio_amend',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: `perio_exam:${opened.examNum}`,
      priorState: 'written',
    });
    return res.json(await perioSendPayload(req, office, aptNum, cont.visit, null));
  })
);

router.post(
  '/:aptNum/perio/amend/cancel',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) return badAptNum(res, office);
    // Our database only: this touches nothing in Open Dental, so it does not
    // need the office's client — only the visit.
    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;

    const closed = await tenantDb.withTenantDb(req, (pool) =>
      perioSend.cancelAmendment({ pool, office, visit, actor: actorEmail(req) })
    );
    if (!closed.ok) {
      return res.status(closed.status).json({ success: false, error: closed.error, code: closed.code, office });
    }
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'hyg_perio_amend',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: `perio_exam:${closed.examNum}`,
      priorState: 'amending',
    });
    return res.json(await perioSendPayload(req, office, aptNum, visit, null));
  })
);

router.post(
  '/:aptNum/perio/send/remove-replaced',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) return badAptNum(res, office);
    const body = parseBody(res, contract.PerioDeleteExamRequestSchema, req.body);
    if (body === null) return undefined;
    const cont = await perioContinuation(req, res, office, aptNum);
    if (!cont) return undefined;

    const outcome = await tenantDb.withTenantDb(req, (pool) =>
      perioSend.removeReplacedExam({
        pool,
        office,
        visit: cont.visit,
        od: cont.od,
        odGet: perioOdGet(cont.od),
        request: body,
        actor: actorEmail(req),
      })
    );
    await auditPerioWrites(req, office, aptNum, outcome.attempted);
    if (!outcome.ok) {
      if (!outcome.attempted || outcome.attempted.length === 0) {
        await auditHygDenial(req, 'hyg_perio_send', aptNum, {
          office,
          result: outcome.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
        });
      }
      return res.status(outcome.status).json({ success: false, error: outcome.error, code: outcome.code, office });
    }
    return res.json(await perioSendPayload(req, office, aptNum, cont.visit, null));
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Sending a chart again when its exam has GONE from Open Dental (H4 item 14)
// ─────────────────────────────────────────────────────────────────────────────
//
//   POST /:aptNum/perio/resend   the exam is gone; re-arm the send
//
// The drift check that offers this lives on GET /:aptNum/perio/prior, which is a
// READ and writes nothing. This route is the only thing item 14 adds that changes
// state, it is only ever reached because a person pressed a button, and it still
// writes NOTHING to Open Dental: it records that the exam is gone and puts the
// chart back to `Staged`. The ordinary send routes above then post a NEW exam,
// with their own confirmation and their own site-by-site read-back.
//
// There is deliberately no resend for a chart whose readings merely DIFFER. See
// services/hyg/perioDrift.js — a reading that differs is somebody's correction.

router.post(
  '/:aptNum/perio/resend',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) return badAptNum(res, office);
    const body = parseBody(res, contract.PerioResendRequestSchema, req.body);
    if (body === null) return undefined;
    const cont = await perioContinuation(req, res, office, aptNum);
    if (!cont) return undefined;

    const outcome = await tenantDb.withTenantDb(req, (pool) =>
      perioDrift.resendVanishedChart({
        pool,
        office,
        visit: cont.visit,
        odGet: perioOdGet(cont.od),
        request: body,
        actor: actorEmail(req),
      })
    );
    if (!outcome.ok) {
      await auditHygDenial(req, 'hyg_perio_resend', aptNum, {
        office,
        result: outcome.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
      });
      return res.status(outcome.status).json({ success: false, error: outcome.error, code: outcome.code, office });
    }
    // A `Written` chart becoming sendable again is a recorded act: it is the
    // moment CareIN stopped claiming exam N is in Open Dental, and by whom.
    // Identifiers only — the exam number, never a reading.
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'hyg_perio_resend',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: `perio_exam:${outcome.examNum}`,
      priorState: 'exam_gone',
    });
    return res.json(await perioSendPayload(req, office, aptNum, cont.visit, null));
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/hyg/visit/:aptNum/send?office=&date=   (H1 slice 3)
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/:aptNum/send',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (!isRealDate(date)) {
      return res.status(400).json({
        success: false,
        error: 'date query param is required and must be a real calendar date (YYYY-MM-DD)',
        code: 'INVALID_DATE',
        office,
      });
    }

    // The body carries WHICH kinds and WHAT THEY LOOKED LIKE. Never a payload:
    // everything that reaches a chart is built server-side from the stored row.
    const body = parseBody(res, contract.SendVisitRequestSchema, req.body);
    if (body === null) return undefined;

    // OFFICE READINESS FIRST, before this route says anything about whether a
    // visit exists. An office that is switched off, unkeyed or unreachable must
    // hear its own refusal — answering "no such visit" for a practice CareIN is
    // not talking to is a true sentence that teaches the wrong thing.
    //
    // It also re-reads the appointment from Open Dental at SEND time rather
    // than trusting the stage: the provider, the operatory and the patient's
    // name come from here, and `resolveAppointment` puts the office handle
    // through assertOfficeMatch before any of it is used.
    const resolved = await resolveAppointment(req, { office, aptNum, date });
    if (!resolved.ok) {
      await auditHygDenial(req, 'hyg_visit_send', aptNum, {
        office,
        result: resolved.status >= 500 ? 'ERROR' : 'UNAUTHORIZED',
      });
      return res.status(resolved.status).json(resolved.body);
    }

    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;

    if (resolved.appointment.patNum !== visit.patNum) {
      // The appointment moved to a different patient since the visit was
      // opened. Refuse: there is no version of this where guessing is right.
      await auditHygDenial(req, 'hyg_visit_send', aptNum, { office, result: 'UNAUTHORIZED' });
      return res.status(409).json({
        success: false,
        error:
          'This appointment now belongs to a different patient in Open Dental than the visit ' +
          'that was composed for it. Nothing was sent.',
        code: 'PATIENT_CHANGED',
        office,
      });
    }

    const odGet = (path, params, opts) =>
      resolved.od.client.apiGetRaw(path, params, { ...(opts || {}), module: 'hyg' });

    const actor = actorEmail(req);
    const outcome = await tenantDb.withTenantDb(req, (pool) =>
      sendVisitService.sendVisit({
        req,
        pool,
        office,
        officeName: resolved.officeName,
        date,
        visit,
        appointment: resolved.appointment,
        od: resolved.od,
        odGet,
        actor,
        confirmations: body.confirm,
        submitHygieneIntake: req.app.get('hygTcSubmit') || undefined,
      })
    );

    if (!outcome.ok) {
      await auditHygDenial(req, 'hyg_visit_send', aptNum, { office, result: 'UNAUTHORIZED' });
      return res.status(outcome.status).json({
        success: false,
        error: outcome.error,
        code: outcome.code,
        office,
      });
    }

    // A PERIO CHART THAT RODE ALONG (item 15) is audited exactly as the chart
    // page audits its own send: the confirmation as a recorded act, then ONE row
    // per Open Dental write the step attempted. Its outcome is not also counted
    // below — its writes are its rows.
    if (outcome.perio) {
      await audit(req, {
        action: 'UPDATE',
        resourceType: 'hyg_perio_send',
        resourceId: aptNum,
        result: 'SUCCESS',
        office,
        sourceRef: null,
      });
      await auditPerioWrites(req, office, aptNum, outcome.perio.attempted);
      if (outcome.perio.amend) await auditPerioAmendment(req, office, aptNum, outcome.perio.amend);
    }

    // ONE AUDIT ROW PER WRITE, with the approving user on it, and the result
    // recorded honestly — a failed write is an ERROR row, not a missing one.
    // The action is UPDATE because that is what reaching a chart is; the
    // vocabulary is CHECK-constrained to four verbs (audit_log_action_check).
    for (const result of outcome.outcomes.filter((o) => o.kind !== 'perio')) {
      await audit(req, {
        action: 'UPDATE',
        resourceType: 'hyg_visit_send',
        resourceId: aptNum,
        result: result.state === 'Written' ? 'SUCCESS' : 'ERROR',
        office,
        sourceRef: null,
      });
    }

    // ITEM 49: THE CHECKOUT HANDOFF RIDES THE SEND — AFTER every chart write,
    // and it can never fail the Send. It creates the handoff when there is
    // none, and replaces the early alert's snapshot with the final one when
    // there is (TC's source key makes it the SAME handoff either way). Off for
    // this office → `checkout: null`, nothing sent.
    const checkout = (await tcCheckout.isEnabled(office))
      ? await deliverCheckout(req, { office, aptNum, final: true })
      : null;

    const after = await tenantDb.withTenantDb(req, (pool) =>
      getVisitView(pool, { office, aptNum })
    );

    const written = outcome.outcomes.filter((o) => o.state === 'Written').length;
    const failed = outcome.outcomes.filter((o) => o.state === 'Failed').length;
    console.log(
      `[hygsend] office=${office} apt=${aptNum} by=${actor} ` +
        `written=${written} failed=${failed} ` +
        outcome.outcomes.map((o) => `${o.kind}:${o.state}`).join(' ')
    );

    // 200 even when everything failed. The REQUEST succeeded — it did what it
    // was asked and reports what happened. A 500 here would say "we do not know
    // what happened", which would be a lie about a body full of outcomes.
    return res.json({
      ...visitPayload(after),
      outcomes: outcome.outcomes,
      written,
      failed,
      checkout: checkout ? checkout.delivery : null,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/hyg/visit/:aptNum/staged-writes/:kind/retry
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/:aptNum/staged-writes/:kind/retry',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    const kind = contract.StagedWriteKindSchema.safeParse(req.params.kind);
    if (!kind.success) {
      return res.status(400).json({
        success: false,
        error: 'kind must be one of: ' + contract.StagedWriteKindSchema.options.join(', '),
        code: 'INVALID_BODY',
        field: 'kind',
        office,
      });
    }

    const visit = await loadForMutation(req, res, office, aptNum);
    if (!visit) return undefined;

    // ITEM 20: a retry writes nothing to Open Dental itself, but it re-arms a
    // write that would. With the test-patient rail on, a patient outside it
    // cannot have one re-armed.
    const gated = refuseUnlessTestPatient({ office, patNum: visit.patNum });
    if (gated) {
      await auditHygDenial(req, 'hyg_staged_write', aptNum, { office, result: 'UNAUTHORIZED' });
      return res.status(gated.status).json({ success: false, error: gated.error, code: gated.code, office });
    }

    // A FAILED PERIO CHART GOES BACK ON THE LIST ONLY IF ITS LAST SEND LEFT
    // NOTHING BEHIND. An incomplete exam this send created is still in Open
    // Dental, understating disease; a second send beside it would put two exams
    // for one visit in the chart. Delete it from the chart page first.
    if (kind.data === 'perio') {
      const mayRestage = await tenantDb.withTenantDb(req, (pool) =>
        perioSend.canRestage(pool, { office, visit })
      );
      if (!mayRestage) {
        return res.status(409).json({
          success: false,
          error:
            "This chart's last send left an incomplete exam in Open Dental. Delete that exam from the " +
            'chart page, or correct it in Open Dental, before putting the chart back on the list.',
          code: 'PERIO_EXAM_EXISTS',
          office,
        });
      }
    }

    // Failed → Staged, with the SAME words. A retry that re-composed would send
    // something the hygienist never read, which is the rule this slice is built
    // around. Changing the visit and staging again is the other, explicit path.
    const moved = await tenantDb.withTenantDb(req, async (pool) => {
      const ok = await visitStore.retryStagedWrite(pool, {
        office,
        visitId: visit.visitId,
        kind: kind.data,
        actor: actorEmail(req),
      });
      if (!ok) return null;
      return getVisitView(pool, { office, aptNum });
    });

    if (!moved) {
      return res.status(409).json({
        success: false,
        error: `The ${kind.data} write is not in a failed state, so there is nothing to retry`,
        code: 'STAGED_WRITE_IMMUTABLE',
        office,
      });
    }

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'hyg_staged_write',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });
    return res.json(visitPayload(moved));
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/hyg/visit/:aptNum/ortho-screening/send   (item 33)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send the ortho screening to TC — NOW, not with the visit's Send.
 *
 * The TC may want to catch the patient before they leave, so this is its own
 * button and its own request. It is NOT a staged write: it reaches no chart,
 * so the preview-fingerprint machinery that guards a chart write has nothing
 * to guard, and the summary line the hygienist reads above the button is
 * computed by the same shared function from the same stored screening.
 *
 * ⚠️ ZERO OPEN DENTAL CALLS ON THIS PATH. ⚠️ Office and PatNum come off the
 * stored visit; name, age, phone, chair and provider off the snapshot the GET
 * and open routes recorded when THEY read the appointment.
 * `hygOrthoSend.test.js` drives this route against the recording Open Dental
 * fake and asserts its call log is empty.
 *
 * ⚠️ NOTHING IN THE BODY IS READ. ⚠️ The schema strips every key, so a client
 * that sends an office, a PatNum, a name or a provider has them discarded
 * unread — the test sends all four and asserts TC received the visit's own.
 *
 * ONE CASE PER VISIT. A sent visit answers 200 with `alreadySent: true` and
 * creates nothing; two racing presses are serialised by a conditional claim
 * (visitStore.claimOrthoSend). HONEST STATES: `orthoSend` is written only after
 * TC answered with a case id; any other answer releases the claim, leaves the
 * screening saved and editable, and is reported as the refusal it is.
 */
router.post(
  '/:aptNum/ortho-screening/send',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    if (parseBody(res, contract.OrthoSendRequestSchema, req.body ?? {}) === null) return undefined;

    const ctx = await tenantDb.withTenantDb(req, (pool) =>
      visitStore.getOrthoSendContext(pool, { office, aptNum })
    );
    if (!ctx) {
      return res.status(404).json({
        success: false,
        error: 'No visit has been started for this appointment yet',
        code: 'VISIT_NOT_FOUND',
        office,
      });
    }

    // Already sent: say so, create nothing.
    if (ctx.visit.orthoSend) {
      return res.json({ ...visitPayload(ctx.visit), alreadySent: true });
    }

    const date = ctx.visit.visitDate || new Date().toISOString().slice(0, 10);
    const built = tcHandoff.buildOrthoIntake({ visit: ctx.visit, snapshot: ctx.snapshot, date });
    if (!built.ok) {
      return res.status(built.code === 'ORTHO_NOTHING_TO_SEND' ? 422 : 409).json({
        success: false,
        error: built.error,
        code: built.code,
        office,
      });
    }

    const claimed = await tenantDb.withTenantDb(req, (pool) =>
      visitStore.claimOrthoSend(pool, { office, aptNum })
    );
    if (!claimed) {
      // Lost the race: either the other press already landed (the idempotent
      // answer) or it is still talking to TC (nothing is claimed here).
      const current = await tenantDb.withTenantDb(req, (pool) =>
        getVisitView(pool, { office, aptNum })
      );
      if (current && current.orthoSend) {
        return res.json({ ...visitPayload(current), alreadySent: true });
      }
      return res.status(409).json({
        success: false,
        error: 'This screening is already being sent to the TC. Wait a moment and reload.',
        code: 'ORTHO_SEND_IN_PROGRESS',
        office,
      });
    }

    const submit = req.app.get('hygTcSubmit') || tcHandoff.submitHygieneIntake;
    let sent;
    try {
      // The office is the STORED visit's, never a request's.
      sent = await submit(req, { office: ctx.visit.office, body: built.body });
    } catch (err) {
      sent = {
        ok: false,
        code: 'TC_UNREACHABLE',
        error: (err && err.message) || 'The TC app did not respond',
      };
    }

    if (!sent.ok) {
      await tenantDb.withTenantDb(req, (pool) =>
        visitStore.releaseOrthoClaim(pool, { office, aptNum })
      );
      await audit(req, {
        action: 'CREATE',
        resourceType: 'hyg_ortho_screening_send',
        resourceId: aptNum,
        result: 'ERROR',
        office,
        sourceRef: null,
      });
      console.warn(`[hygortho] office=${office} apt=${aptNum} TC refused: ${sent.code}`);
      return res.status(502).json({
        success: false,
        error: `The screening was NOT sent to the TC: ${sent.error}. It is saved here; try again.`,
        code: sent.code,
        office,
      });
    }

    const after = await tenantDb.withTenantDb(req, (pool) =>
      visitStore.markOrthoSent(pool, {
        office,
        aptNum,
        caseId: sent.caseId,
        actor: actorEmail(req),
      })
    );
    await audit(req, {
      action: 'CREATE',
      resourceType: 'hyg_ortho_screening_send',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });
    console.log(`[hygortho] office=${office} apt=${aptNum} sent as case ${sent.caseId}`);

    const visit =
      after ||
      (await tenantDb.withTenantDb(req, (pool) => getVisitView(pool, { office, aptNum })));
    return res.json({ ...visitPayload(visit), alreadySent: false });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// The checkout handoff (item 49)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send this visit's checkout snapshot to TC and record it on the visit.
 *
 * Shared by the early "Alert checkout" (final: false, AFTER the route took the
 * claim) and the visit Send's update (final: true, no claim — TC's source key
 * makes it the same handoff). NEVER THROWS: every outcome is a typed answer.
 *
 * ⚠️ ZERO OPEN DENTAL CALLS. ⚠️ The visit row, its items and the appointment
 * snapshot are all this reads; the snapshot was recorded by a route that had
 * ALREADY read the appointment.
 *
 * @returns {Promise<{ ok: boolean, status: number, code: string|null, error: string|null,
 *                     visit: Record<string, any>|null,
 *                     delivery: { state: 'delivered'|'not_delivered', code: string|null, message: string|null } }>}
 */
async function deliverCheckout(req, { office, aptNum, final }) {
  const refuse = (status, code, error) => ({
    ok: false,
    status,
    code,
    error,
    visit: null,
    delivery: { state: 'not_delivered', code, message: error },
  });
  try {
    const ctx = await tenantDb.withTenantDb(req, async (pool) => {
      const found = await visitStore.getOrthoSendContext(pool, { office, aptNum });
      if (!found) return null;
      // Slice 2b: the existing-treatment answers as they stand — stored rows
      // only. The visit Send's final update supersedes an early alert's.
      const existingTx = await existingTxStore.loadForSend(pool, {
        office,
        visitId: found.visit.visitId,
      });
      return { ...found, existingTx };
    });
    if (!ctx) return refuse(404, 'VISIT_NOT_FOUND', 'No visit has been started for this appointment yet');

    const date = ctx.visit.visitDate || new Date().toISOString().slice(0, 10);
    const built = tcHandoff.buildCheckoutIntake({
      visit: ctx.visit,
      snapshot: ctx.snapshot,
      date,
      final,
      existingTx: ctx.existingTx,
    });
    if (!built.ok) return refuse(409, built.code, built.error);

    const submit = req.app.get('hygCheckoutSubmit') || tcHandoff.submitCheckoutHandoff;
    let sent;
    try {
      // The office is the STORED visit's, never a request's.
      sent = await submit(req, { office: ctx.visit.office, body: built.body });
    } catch (err) {
      sent = { ok: false, code: 'TC_UNREACHABLE', error: (err && err.message) || 'The TC app did not respond' };
    }
    if (!sent.ok) {
      await audit(req, {
        action: final ? 'UPDATE' : 'CREATE',
        resourceType: 'hyg_checkout_alert',
        resourceId: aptNum,
        result: 'ERROR',
        office,
        sourceRef: null,
      });
      console.warn(`[hygcheckout] office=${office} apt=${aptNum} final=${final} TC refused: ${sent.code}`);
      return refuse(
        502,
        sent.code,
        `The checkout alert was NOT ${final ? 'updated' : 'sent'}: ${sent.error}. ` +
          'Nothing is lost on this visit; try again.'
      );
    }

    // A FINAL send is delivered only if TC says it now holds a final snapshot.
    // A 200 carrying somebody else's older snapshot is not that, and stamping
    // checkout_final_at for it would tell the hygienist the front desk has
    // notes it does not have.
    if (final && sent.final !== true) {
      await audit(req, {
        action: 'UPDATE',
        resourceType: 'hyg_checkout_alert',
        resourceId: aptNum,
        result: 'ERROR',
        office,
        sourceRef: null,
      });
      return refuse(
        409,
        'CHECKOUT_NOT_FINAL',
        'The checkout alert was NOT updated: TC still holds the earlier snapshot. ' +
          'Nothing is lost on this visit; try again.'
      );
    }

    // "Delivered" only once the handoff id is recorded on the visit.
    const after = await tenantDb.withTenantDb(req, (pool) =>
      visitStore.markCheckoutSent(pool, {
        office,
        aptNum,
        handoffId: sent.handoffId,
        actor: actorEmail(req),
        final,
      })
    );
    if (!after) {
      return refuse(
        409,
        'SOURCE_KEY_CONFLICT',
        'TC answered with a different handoff than the one this visit already points at. Nothing was changed here.'
      );
    }
    await audit(req, {
      action: final ? 'UPDATE' : 'CREATE',
      resourceType: 'hyg_checkout_alert',
      resourceId: aptNum,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });
    console.log(`[hygcheckout] office=${office} apt=${aptNum} final=${final} handoff ${sent.handoffId}`);
    return {
      ok: true,
      status: 200,
      code: null,
      error: null,
      visit: after,
      delivery: { state: 'delivered', code: null, message: null },
    };
  } catch (err) {
    console.error(`[hygcheckout] office=${office} apt=${aptNum} failed:`, err && err.message);
    return refuse(500, 'CHECKOUT_ERROR', 'The checkout alert could not be sent. Nothing is lost on this visit; try again.');
  }
}

/** The 403 an office with the handoff switched off answers. */
function checkoutDisabled(res, office) {
  return res.status(403).json({
    success: false,
    error: 'The checkout handoff is not switched on for this office',
    code: 'CHECKOUT_DISABLED',
    office,
  });
}

/**
 * POST /api/hyg/visit/:aptNum/checkout/alert — "Alert checkout", NOW.
 *
 * The ortho send's shape exactly: NOTHING in the body is read; one handoff per
 * visit (an alerted visit answers 200 `alreadySent: true` and sends nothing);
 * two racing presses are serialised by a conditional claim; the claim goes
 * stale after two minutes; a TC refusal releases it and answers 502.
 */
router.post(
  '/:aptNum/checkout/alert',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    if (parseBody(res, contract.CheckoutAlertRequestSchema, req.body ?? {}) === null) return undefined;
    if (!(await tcCheckout.isEnabled(office))) return checkoutDisabled(res, office);

    const current = await tenantDb.withTenantDb(req, (pool) =>
      getVisitView(pool, { office, aptNum })
    );
    if (!current) {
      return res.status(404).json({
        success: false,
        error: 'No visit has been started for this appointment yet',
        code: 'VISIT_NOT_FOUND',
        office,
      });
    }
    // Already alerted: say so, send nothing.
    if (current.checkoutSend) return res.json({ ...visitPayload(current), alreadySent: true });

    const claimed = await tenantDb.withTenantDb(req, (pool) =>
      visitStore.claimCheckoutSend(pool, { office, aptNum })
    );
    if (!claimed) {
      const now = await tenantDb.withTenantDb(req, (pool) => getVisitView(pool, { office, aptNum }));
      if (now && now.checkoutSend) return res.json({ ...visitPayload(now), alreadySent: true });
      return res.status(409).json({
        success: false,
        error: 'Checkout is already being alerted for this visit. Wait a moment and reload.',
        code: 'CHECKOUT_SEND_IN_PROGRESS',
        office,
      });
    }

    const result = await deliverCheckout(req, { office, aptNum, final: false });
    if (!result.ok) {
      await tenantDb.withTenantDb(req, (pool) => visitStore.releaseCheckoutClaim(pool, { office, aptNum }));
      return res.status(result.status).json({ success: false, error: result.error, code: result.code, office });
    }
    return res.json({ ...visitPayload(result.visit), alreadySent: false });
  })
);

/**
 * POST /api/hyg/visit/:aptNum/checkout/finalize — the visit Send's checkout
 * update, again. For when the Send's own attempt answered "not delivered":
 * the chart writes are done and must not be re-sent, so this retries ONLY the
 * handoff. Idempotent by TC's source key.
 */
router.post(
  '/:aptNum/checkout/finalize',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumFrom(req);
    if (aptNum === null) {
      return res.status(400).json({
        success: false,
        error: 'aptNum must be a positive whole number',
        code: 'INVALID_APT_NUM',
        office,
      });
    }
    if (parseBody(res, contract.CheckoutAlertRequestSchema, req.body ?? {}) === null) return undefined;
    if (!(await tcCheckout.isEnabled(office))) return checkoutDisabled(res, office);

    const result = await deliverCheckout(req, { office, aptNum, final: true });
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error, code: result.code, office });
    }
    return res.json({ ...visitPayload(result.visit), alreadySent: false });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Referrals from the chair (queue item 54, R3)
// ─────────────────────────────────────────────────────────────────────────────
//
// The hygienist drafts a referral beside the visit and it goes straight to the
// doctor's sign-off (or to approved, when this office does not require one).
// ONE producer with TC (routes/tc/referralCreate.js): the same record, the same
// event + audit, the same transition engine.
//
// THE PATIENT IS THE VISIT'S: office + PatNum from the stored visit row, the
// name from its stored appointment snapshot. Nothing in the body names a
// patient or an office (the body schema is strict). Zero Open Dental: no OD
// read happens here. Dark unless the practice has TC and referrals is on for
// the office.

/** The stored visit and the patient it is for, or the refusal to send. */
async function referralPatient(req, office, aptNum) {
  const ctx = await tenantDb.withTenantDb(req, (pool) => visitStore.getOrthoSendContext(pool, { office, aptNum }));
  if (!ctx) {
    return { refusal: [404, { success: false, error: 'No visit has been started for this appointment yet', code: 'VISIT_NOT_FOUND', office }] };
  }
  const patientName = ctx.snapshot && typeof ctx.snapshot.patientName === 'string' ? ctx.snapshot.patientName.trim() : '';
  const odPatientId = Number(ctx.visit.patNum);
  if (!Number.isFinite(odPatientId) || odPatientId <= 0) {
    return { refusal: [409, { success: false, error: 'This visit has no patient yet', code: 'APPOINTMENT_HAS_NO_PATIENT', office }] };
  }
  if (!patientName) {
    return {
      refusal: [
        409,
        {
          success: false,
          error: "Open Dental has not given this visit's patient a name yet — reload the visit and try again",
          code: 'PATIENT_NAME_UNAVAILABLE',
          office,
        },
      ],
    };
  }
  return {
    ctx,
    patient: {
      odPatientId,
      patientName,
      tcCaseId: null,
      sourceKind: 'hyg_visit',
      sourceRef: String(ctx.visit.visitId),
    },
  };
}

/** The usual :aptNum refusal, or the number. */
function aptNumOr400(req, res, office) {
  const aptNum = aptNumFrom(req);
  if (aptNum === null) {
    res.status(400).json({ success: false, error: 'aptNum must be a positive whole number', code: 'INVALID_APT_NUM', office });
  }
  return aptNum;
}

/** POST /api/hyg/visit/:aptNum/referral — draft it here, straight to sign-off. */
router.post(
  '/:aptNum/referral',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumOr400(req, res, office);
    if (aptNum === null) return undefined;
    const input = parseBody(res, tcContract.TcReferralInput, req.body ?? {});
    if (input === null) return undefined;
    const gate = await referralCreate.referralsGate(req, office);
    if (gate) return res.status(gate[0]).json(gate[1]);
    const who = await referralPatient(req, office, aptNum);
    if (who.refusal) return res.status(who.refusal[0]).json(who.refusal[1]);
    // The office is the STORED visit's, never a request's.
    // `?submit=false` (item 55): the form has X-rays to attach, so the draft is
    // created, the files land on it, and THEN it is submitted (below) — files
    // are only taken before a decision, and an office without sign-off would
    // otherwise approve it before its X-ray arrived. Default: create + submit,
    // in one transaction.
    const out = await referralCreate.startReferral(req, {
      office: who.ctx.visit.office,
      patient: who.patient,
      input,
      submit: String(req.query.submit ?? 'true') !== 'false',
    });
    return res.status(out.status).json(out.body);
  })
);

/**
 * POST /api/hyg/visit/:aptNum/referrals/:referralId/submit — send a draft THIS
 * visit started for the doctor's sign-off (item 55): after its X-rays are
 * attached, or to retry a submit that failed. The shared transition engine.
 */
router.post(
  '/:aptNum/referrals/:referralId/submit',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumOr400(req, res, office);
    if (aptNum === null) return undefined;
    const gate = await referralCreate.referralsGate(req, office);
    if (gate) return res.status(gate[0]).json(gate[1]);
    const referralId = tcContract.z.string().uuid().safeParse(req.params.referralId);
    if (!referralId.success) {
      return res.status(400).json({ success: false, error: 'Invalid referral id', code: 'INVALID_ID', office });
    }
    const ctx = await tenantDb.withTenantDb(req, (pool) => visitStore.getOrthoSendContext(pool, { office, aptNum }));
    const ref = ctx
      ? await tenantDb.withTenantDb(req, (pool) => referralStore.findReferral(pool, office, referralId.data))
      : null;
    if (!ref || ref.source_kind !== 'hyg_visit' || String(ref.source_ref) !== String(ctx.visit.visitId)) {
      return res.status(404).json({ success: false, error: 'Referral not found', code: 'NOT_FOUND', office });
    }
    const out = await transitions.applyVerb(req, { referralId: referralId.data, verb: 'submit', office });
    return res.status(out.status).json(out.body);
  })
);

/** GET /api/hyg/visit/:aptNum/referrals — the referrals started from this visit. */
router.get(
  '/:aptNum/referrals',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumOr400(req, res, office);
    if (aptNum === null) return undefined;
    const gate = await referralCreate.referralsGate(req, office);
    if (gate) return res.status(gate[0]).json(gate[1]);
    const ctx = await tenantDb.withTenantDb(req, (pool) => visitStore.getOrthoSendContext(pool, { office, aptNum }));
    if (!ctx) return res.json({ success: true, referrals: [] });
    const referrals = await tenantDb.withTenantDb(req, async (pool) => {
      const rows = await referralStore.listReferrals(pool, office, {
        sourceKind: 'hyg_visit',
        sourceRef: String(ctx.visit.visitId),
      });
      const names = await referralStore.practiceNames(pool, office, rows);
      // R6: a draft the doctor sent back carries the question, for the hygienist.
      const returns = await referralStore.openReturns(pool, office, rows);
      return rows.map((r) => ({
        ...referralStore.toReferral(r, names.get(String(r.directory_entry_id)) ?? null),
        returned: returns.get(String(r.referral_id)) ?? null,
      }));
    });
    await audit(req, { action: 'READ', resourceType: 'tc_referral', resourceId: null, result: 'SUCCESS', office, sourceRef: `hyg_visit:${aptNum}` });
    return res.json({ success: true, referrals });
  })
);

/**
 * GET /api/hyg/visit/:aptNum/referral-directory — the office's ACTIVE
 * specialists, for the chairside form's picker. Non-PHI office configuration;
 * a hygienist holds no TC action, so this is the read they get.
 */
router.get(
  '/:aptNum/referral-directory',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumOr400(req, res, office);
    if (aptNum === null) return undefined;
    const gate = await referralCreate.referralsGate(req, office);
    if (gate) return res.status(gate[0]).json(gate[1]);
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      referralStore.listDirectory(pool, office, { includeInactive: false })
    );
    return res.json({ success: true, entries: rows.map(referralStore.toEntry) });
  })
);

/**
 * GET /api/hyg/visit/:aptNum/provider-directory — the office's ACTIVE
 * providers (the TC provider directory), for the chairside form's referring
 * provider pick. Non-PHI office configuration, read only, the same gate as
 * the specialist list above.
 */
router.get(
  '/:aptNum/provider-directory',
  h(async (req, res) => {
    const office = req.hygOffice;
    const aptNum = aptNumOr400(req, res, office);
    if (aptNum === null) return undefined;
    const gate = await referralCreate.referralsGate(req, office);
    if (gate) return res.status(gate[0]).json(gate[1]);
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      providerStore.listProviders(pool, office, { includeInactive: false })
    );
    return res.json({ success: true, entries: rows.map(providerStore.toEntry) });
  })
);

/**
 * POST /api/hyg/visit/:aptNum/referrals/:referralId/attachments — the X-ray
 * snipped chairside (R4). ONLY onto a referral THIS visit started; the shared
 * handler does the rest (bytes sniffed, ≤10 MB, ≤5, stored before the row,
 * fail closed, audited). The gate runs before the body is read.
 */
router.post(
  '/:aptNum/referrals/:referralId/attachments',
  async (req, res, next) => {
    try {
      const gate = await referralCreate.referralsGate(req, req.hygOffice);
      if (gate) return res.status(gate[0]).json(gate[1]);
      return next();
    } catch (err) {
      return next(err);
    }
  },
  referralAttachments.receiveFile,
  h(
    referralAttachments.uploadHandler({
      officeOf: (req) => req.hygOffice,
      referralIdOf: (req) => req.params.referralId,
      guard: async (req, ref) => {
        const aptNum = aptNumFrom(req);
        if (aptNum === null) return [400, 'aptNum must be a positive whole number', 'INVALID_APT_NUM'];
        const ctx = await tenantDb.withTenantDb(req, (pool) =>
          visitStore.getOrthoSendContext(pool, { office: req.hygOffice, aptNum })
        );
        const mine = ctx && ref.source_kind === 'hyg_visit' && String(ref.source_ref) === String(ctx.visit.visitId);
        return mine ? null : [404, 'Referral not found', 'NOT_FOUND'];
      },
    })
  )
);

module.exports = router;
