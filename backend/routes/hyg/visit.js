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
const { audit } = require('../../platform/audit');
const tenantDb = require('../../platform/tenantDb');
const odDay = require('../../services/hyg/odDay');
const visitStore = require('../../services/hyg/visitStore');
const composer = require('../../services/hyg/stagedWriteComposer');
const sendVisitService = require('../../services/hyg/sendVisit');
const contract = require('../../hyg/contract.gen.cjs');

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
  };
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
    day = await odDay.readDay(odGet, { date, office });
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

  const appointment = day.appointments.find((a) => a.aptNum === aptNum) || null;
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
 * Load the visit for a mutation, or answer the refusal.
 *
 * Every mutation below except `open` needs an EXISTING visit. Creating one here
 * would mean a stray request could start a visit with no appointment lookup
 * behind it, and therefore with no Open-Dental-derived PatNum.
 */
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
      visitStore.getVisit(pool, { office, aptNum })
    );

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
      return visitStore.getVisit(pool, { office, aptNum });
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
      return visitStore.getVisit(pool, { office, aptNum });
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
      return visitStore.getVisit(pool, { office, aptNum });
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
      const staged = await visitStore.stageWrite(pool, {
        office,
        visit,
        kind: body.kind,
        actor: actorEmail(req),
        compose: composer.compose,
      });
      if (!staged.ok) return staged;
      return { ok: true, visit: await visitStore.getVisit(pool, { office, aptNum }) };
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
      const removed = await visitStore.unstageWrite(pool, {
        office,
        visitId: visit.visitId,
        kind: kind.data,
        actor: actorEmail(req),
      });
      if (!removed.ok) return removed;
      return { ok: true, visit: await visitStore.getVisit(pool, { office, aptNum }) };
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

    // ONE AUDIT ROW PER WRITE, with the approving user on it, and the result
    // recorded honestly — a failed write is an ERROR row, not a missing one.
    // The action is UPDATE because that is what reaching a chart is; the
    // vocabulary is CHECK-constrained to four verbs (audit_log_action_check).
    for (const result of outcome.outcomes) {
      await audit(req, {
        action: 'UPDATE',
        resourceType: 'hyg_visit_send',
        resourceId: aptNum,
        result: result.state === 'Written' ? 'SUCCESS' : 'ERROR',
        office,
        sourceRef: null,
      });
    }

    const after = await tenantDb.withTenantDb(req, (pool) =>
      visitStore.getVisit(pool, { office, aptNum })
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
      return visitStore.getVisit(pool, { office, aptNum });
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

module.exports = router;
