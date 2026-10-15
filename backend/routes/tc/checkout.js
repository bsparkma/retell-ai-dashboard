'use strict';

/**
 * /api/tc/checkout — the front desk's Checkout inbox (queue item 50, C2).
 *
 * A checkout handoff (item 49) is the hygienist saying "this patient is on the
 * way, here is what I staged". This route family is where the front desk
 * answers it:
 *
 *   GET  /?view=waiting|done   today's handoffs, newest first
 *   GET  /summary              the nav badge + the arrival toast
 *   GET  /:id                  one handoff (the patient sidebar)
 *   POST /:id/claim            "I've got this patient" (open → claimed)
 *   POST /:id/dismiss          not a checkout after all — a reason is required
 *   POST /:id/outcome          scheduled | not_scheduled | nothing_needed
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE THREE OUTCOMES
 * ═════════════════════════════════════════════════════════════════════════════
 *   scheduled       the patient's open case (if any) MOVES to `scheduled`, with
 *                   a status_change event in the funnel's `from → to` format;
 *                   otherwise a case is CREATED at `scheduled`.
 *   not_scheduled   the patient's open case (if any) moves FORWARD to
 *                   `pending_pt` ("Pending Patient") when it is still before
 *                   it — hygiene_review / diagnosed / pending_tc, which is
 *                   where the same visit's own hygiene case usually sits — and
 *                   otherwise only gets a note: "left without booking" is never
 *                   a reason to move a case backwards. No open case → one is
 *                   CREATED at `pending_pt`.
 *   nothing_needed  the handoff closes and NO case is created.
 * The handoff's status update is conditional on the status the request read,
 * inside the same transaction as the case write: two people answering the
 * same checkout cannot both win, and the loser leaves no case behind.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DAY-SCOPED EXPIRY (PM addition)
 * ═════════════════════════════════════════════════════════════════════════════
 * The visit Send creates a handoff on EVERY hygiene Send in an enabled office.
 * So every request here first closes, as `expired`, each still-waiting handoff
 * whose visit day is before the office's today (America/Chicago unless
 * OFFICE_TIMEZONE says otherwise). One audit row per expiry, `prior_state` the
 * status it had, `source_ref` `checkout_day_expiry`, and the SYSTEM as the
 * actor (`system:checkout_expiry`, also stamped on the row's `expired_by`) —
 * never whoever's request happened to run the sweep. Nothing is deleted.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * GUARDRAILS
 * ═════════════════════════════════════════════════════════════════════════════
 *   - ZERO Open Dental reads or writes. Everything renders the snapshot.
 *   - Office from `?office=` through requireOffice, in every WHERE. The PatNum
 *     a case is opened for is the HANDOFF's — never a request's.
 *   - Dark: `tc_checkout_enabled` off for the office → 403 CHECKOUT_DISABLED on
 *     everything but /summary, which answers `enabled: false` so the shell can
 *     hide the nav item without treating "off" as an error.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const { contract, requireOffice, actorEmail, parseBody, h, auditTc } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const store = require('./caseStore');
const checkoutStore = require('./checkoutStore');
const { findOpenCase } = require('./intakeFromCall');
const nurtureHooks = require('../../services/tcNurture/hooks');
const { localDayKey } = require('../../services/localDayClock');
const tcCheckout = require('../../config/tcCheckout');

const { z, TcCase, caseToRows, TcCheckoutOutcomeRequest, TcCheckoutDismissRequest } = contract;

const router = express.Router();
router.use(requireOffice);

/** The clock, swappable in tests so "today" is a fixed office day. */
let clock = () => new Date();
function setClockForTests(fn) {
  clock = fn || (() => new Date());
}

/** The office day "today" means here. */
function officeToday() {
  const tz = String(process.env.OFFICE_TIMEZONE || '').trim() || 'America/Chicago';
  return localDayKey(tz, clock());
}

const HandoffId = z.string().uuid();
const View = z.enum(['waiting', 'done']).default('waiting');

/**
 * Open case statuses that sit BEFORE "Pending Patient" — where "Not scheduled"
 * moves a case forward to pending_pt. Everything else open is at or past it.
 */
const BEFORE_PENDING_PT = Object.freeze(['hygiene_review', 'diagnosed', 'pending_tc']);

/**
 * The request the expiry audit rows are written through: the real request
 * (tenant, endpoint, ip) with the SYSTEM as its user, so the trail never names
 * a person for an act the system performed.
 */
function systemRequest(req) {
  return Object.assign(Object.create(req), { user: { email: checkoutStore.EXPIRY_ACTOR } });
}

/** Statuses the "Done today" view shows: every answer a human gave. */
const DONE_STATUSES = Object.freeze(['scheduled', 'not_scheduled', 'nothing_needed', 'dismissed']);

/** The visit's priority → TC urgency (the same mapping the treatment handoff uses). */
const URGENCY_BY_PRIORITY = Object.freeze({ urgent: 'high', preventative: 'medium', cosmetic: 'low' });

/** Scalars for a case opened at checkout. */
const CHECKOUT_CASE_DEFAULTS = Object.freeze({
  legacyId: null,
  patientAge: null,
  phone: null,
  email: null,
  caseType: 'Checkout',
  category: 'single_tooth',
  readinessScore: 0,
  caseValueCents: 0,
  financingStatus: '',
  preferredFinancingProvider: null,
  decisionMakers: '',
  financialSituation: [],
  keyMotivators: [],
  contactPreference: null,
  bestTimeToReach: '',
  referralSource: 'hygiene',
  lostReason: null,
  diagnosedDate: null,
  nurtureCadence: 'standard',
  inLongTailMode: false,
  nurtureEnrolledAt: null,
  nurturePhaseChangedAt: null,
  nurturePhase1DaysOverride: null,
  nurturePhase2DaysOverride: null,
  nurtureUnsubscribed: false,
  phases: [],
  objections: [],
  followups: [],
  hygieneIntake: null,
});

/** The 403 an office with checkout switched off answers. */
function disabled(res) {
  return res.status(403).json({
    success: false,
    error: 'The checkout handoff is not switched on for this office',
    code: 'CHECKOUT_DISABLED',
  });
}

/**
 * Close yesterday's still-waiting handoffs, and audit each one. Runs at the
 * top of every request, so the inbox can never show (or act on) a stale day.
 */
async function sweep(req, office, today) {
  const expired = await tenantDb.withTenantDb(req, (pool) =>
    checkoutStore.expireBefore(pool, office, today)
  );
  const asSystem = systemRequest(req);
  for (const e of expired) {
    await auditTc(asSystem, 'UPDATE', 'tc_checkout_handoff', e.handoffId, {
      office,
      sourceRef: 'checkout_day_expiry',
      priorState: e.priorState,
    });
  }
  return expired.length;
}

/** Gate + sweep for the action/read routes. Returns today, or null having answered. */
async function enter(req, res) {
  if (!(await tcCheckout.isEnabled(req.tcOffice))) {
    disabled(res);
    return null;
  }
  const today = officeToday();
  await sweep(req, req.tcOffice, today);
  return today;
}

/** The procedures as plain lines, for a case created at checkout's notes. */
function procedureLines(snapshot) {
  const procs = snapshot && Array.isArray(snapshot.procedures) ? snapshot.procedures : [];
  return procs.map((p) => {
    const teeth = p.teeth === 'mouth' ? 'Whole mouth' : `#${(p.teeth || []).join(', #')}`;
    return `${teeth} ${p.code} (${p.priority})`;
  });
}

// ── GET / — today's handoffs ────────────────────────────────────────────────

router.get(
  '/',
  h(async (req, res) => {
    const view = View.safeParse(req.query.view);
    if (!view.success) {
      return res.status(400).json({ success: false, error: 'view must be waiting or done', code: 'INVALID_VIEW' });
    }
    const today = await enter(req, res);
    if (today === null) return undefined;
    const statuses = view.data === 'done' ? DONE_STATUSES : checkoutStore.WAITING_STATUSES;
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      checkoutStore.listForDay(pool, req.tcOffice, today, statuses)
    );
    return res.json({ success: true, today, view: view.data, handoffs: rows.map(checkoutStore.toHandoff) });
  })
);

// ── GET /summary — the badge and the toast ──────────────────────────────────

router.get(
  '/summary',
  h(async (req, res) => {
    const office = req.tcOffice;
    if (!(await tcCheckout.isEnabled(office))) {
      return res.json({ success: true, office, enabled: false, today: null, waiting: 0, newest: null });
    }
    const today = officeToday();
    await sweep(req, office, today);
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      checkoutStore.listForDay(pool, office, today, checkoutStore.WAITING_STATUSES)
    );
    const newest = rows[0] ? checkoutStore.toHandoff(rows[0]) : null;
    return res.json({
      success: true,
      office,
      enabled: true,
      today,
      waiting: rows.length,
      newest: newest
        ? { handoffId: newest.handoffId, patientName: newest.patientName, createdAt: newest.createdAt }
        : null,
    });
  })
);

// ── GET /:id — one handoff ──────────────────────────────────────────────────

router.get(
  '/:id',
  h(async (req, res) => {
    const id = HandoffId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ success: false, error: 'Invalid handoff id', code: 'INVALID_ID' });
    const today = await enter(req, res);
    if (today === null) return undefined;
    const row = await tenantDb.withTenantDb(req, (pool) => checkoutStore.findById(pool, req.tcOffice, id.data));
    if (!row) return res.status(404).json({ success: false, error: 'Checkout handoff not found', code: 'NOT_FOUND' });
    return res.json({ success: true, today, handoff: checkoutStore.toHandoff(row) });
  })
);

/** Re-read after a conditional write lost: 404, or 409 naming where it stands now. */
async function refusal(req, res, id, verb) {
  const row = await tenantDb.withTenantDb(req, (pool) => checkoutStore.findById(pool, req.tcOffice, id));
  if (!row) return res.status(404).json({ success: false, error: 'Checkout handoff not found', code: 'NOT_FOUND' });
  return res.status(409).json({
    success: false,
    error: `This checkout cannot be ${verb}: it is already ${contract.TC_CHECKOUT_STATUS_LABELS[row.status] || row.status}.`,
    code: 'CHECKOUT_NOT_ACTIONABLE',
    handoff: checkoutStore.toHandoff(row),
  });
}

// ── POST /:id/claim ─────────────────────────────────────────────────────────

router.post(
  '/:id/claim',
  h(async (req, res) => {
    const id = HandoffId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ success: false, error: 'Invalid handoff id', code: 'INVALID_ID' });
    const today = await enter(req, res);
    if (today === null) return undefined;
    const actor = actorEmail(req);
    const ok = await tenantDb.withTenantDb(req, (pool) =>
      checkoutStore.claim(pool, { office: req.tcOffice, handoffId: id.data, actor })
    );
    if (!ok) return refusal(req, res, id.data, 'claimed');
    await auditTc(req, 'UPDATE', 'tc_checkout_handoff', id.data, { office: req.tcOffice, priorState: 'open' });
    const row = await tenantDb.withTenantDb(req, (pool) => checkoutStore.findById(pool, req.tcOffice, id.data));
    return res.json({ success: true, handoff: checkoutStore.toHandoff(row) });
  })
);

// ── POST /:id/dismiss ───────────────────────────────────────────────────────

router.post(
  '/:id/dismiss',
  h(async (req, res) => {
    const id = HandoffId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ success: false, error: 'Invalid handoff id', code: 'INVALID_ID' });
    const body = parseBody(res, TcCheckoutDismissRequest, req.body);
    if (!body) return undefined;
    const today = await enter(req, res);
    if (today === null) return undefined;
    const actor = actorEmail(req);
    const prior = await tenantDb.withTenantDb(req, (pool) =>
      checkoutStore.dismiss(pool, { office: req.tcOffice, handoffId: id.data, actor, reason: body.reason })
    );
    if (!prior) return refusal(req, res, id.data, 'dismissed');
    // The reason is the TC's own words and stays on the row; the audit row
    // carries only what the handoff WAS — as the database matched it.
    await auditTc(req, 'UPDATE', 'tc_checkout_handoff', id.data, {
      office: req.tcOffice,
      priorState: prior,
    });
    const row = await tenantDb.withTenantDb(req, (pool) => checkoutStore.findById(pool, req.tcOffice, id.data));
    return res.json({ success: true, handoff: checkoutStore.toHandoff(row) });
  })
);

// ── POST /:id/outcome ───────────────────────────────────────────────────────

router.post(
  '/:id/outcome',
  h(async (req, res) => {
    const id = HandoffId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ success: false, error: 'Invalid handoff id', code: 'INVALID_ID' });
    const body = parseBody(res, TcCheckoutOutcomeRequest, req.body);
    if (!body) return undefined;
    const today = await enter(req, res);
    if (today === null) return undefined;

    const office = req.tcOffice;
    const actor = actorEmail(req);
    const now = clock().toISOString();
    const note = body.appointmentNote || '';

    let result;
    try {
      result = await withTenantTx(req, async (client) => {
        const handoff = await checkoutStore.findById(client, office, id.data);
        if (!handoff) return { missing: true };
        if (!checkoutStore.WAITING_STATUSES.includes(handoff.status || 'open')) return { closed: handoff };

        const priorState = handoff.status || 'open';
        const snapshot =
          typeof handoff.payload === 'string' ? JSON.parse(handoff.payload) : handoff.payload || {};
        let caseId = null;
        let caseAction = null; // 'CREATE' | 'UPDATE'
        let stoppedEnrollments = [];

        if (body.outcome !== 'nothing_needed') {
          // The PatNum is the HANDOFF's: the visit's own patient, server-derived
          // when the hygiene module filed it. Never a request's.
          const odPatientId = Number(handoff.od_patient_id);
          const openCaseId = await findOpenCase(client, office, odPatientId);
          const label = body.outcome === 'scheduled' ? 'Scheduled' : 'Not scheduled';
          const noteSuffix = note ? `: ${note}` : '';

          if (openCaseId) {
            caseId = openCaseId;
            caseAction = 'UPDATE';
            const header = await store.getCaseHeader(client, office, openCaseId);
            // Where the open case moves, if anywhere: Scheduled always moves it
            // to scheduled; Not scheduled moves it to pending_pt only FORWARD.
            const moveTo =
              body.outcome === 'scheduled'
                ? 'scheduled'
                : header && BEFORE_PENDING_PT.includes(header.status)
                  ? 'pending_pt'
                  : null;
            if (moveTo && header && header.status !== moveTo) {
              await client.query(
                `UPDATE tc_cases
                    SET status = $3, status_changed_at = $4, updated_at = now()
                  WHERE office_id = $1 AND case_id = $2`,
                [office, openCaseId, moveTo, now]
              );
              await store.insertEventRow(client, {
                event_id: randomUUID(),
                case_id: openCaseId,
                office_id: office,
                ts: now,
                type: 'status_change',
                // The funnel report parses `<from> → <to>`; keep that prefix exact.
                description: `${header.status} → ${moveTo}: ${label} at checkout${noteSuffix}`,
                actor,
                detail: null,
                legacy_id: null,
              });
              stoppedEnrollments = await nurtureHooks.stopForTerminalCase(client, {
                office,
                caseId: openCaseId,
                newStatus: moveTo,
                actor,
                now: new Date(now),
              });
            } else {
              await store.insertEventRow(client, {
                event_id: randomUUID(),
                case_id: openCaseId,
                office_id: office,
                ts: now,
                type: 'note_added',
                description: `Checkout: ${label}${noteSuffix}`,
                actor,
                detail: null,
                legacy_id: null,
              });
            }
          } else {
            caseId = randomUUID();
            caseAction = 'CREATE';
            const status = body.outcome === 'scheduled' ? 'scheduled' : 'pending_pt';
            const lines = procedureLines(snapshot);
            const nextVisit = snapshot.nextVisit || {};
            const notes = [
              lines.length ? `Staged at the hygiene visit:\n${lines.join('\n')}` : 'Nothing staged at the hygiene visit.',
              nextVisit.type ? `Next visit: ${nextVisit.type}` : '',
              snapshot.frontDeskNote ? `Front desk note: ${snapshot.frontDeskNote}` : '',
            ]
              .filter(Boolean)
              .join('\n');
            const events = [
              {
                eventId: randomUUID(),
                legacyId: null,
                ts: now,
                type: 'case_created',
                description: `Case created at checkout (${label.toLowerCase()})`,
                actor,
                detail: null,
              },
            ];
            if (note) {
              events.push({
                eventId: randomUUID(),
                legacyId: null,
                ts: now,
                type: 'note_added',
                description: `Checkout: ${note}`,
                actor,
                detail: null,
              });
            }
            const aggregate = TcCase.parse({
              ...CHECKOUT_CASE_DEFAULTS,
              caseId,
              officeId: office,
              patientName: handoff.patient_name,
              odPatientId,
              status,
              urgency: URGENCY_BY_PRIORITY[snapshot.priority] || 'medium',
              doctorName: handoff.provider || '',
              diagnosingProvider: handoff.provider || null,
              assignedTc: actor,
              notes: notes.slice(0, 8000),
              statusChangedAt: now,
              events,
            });
            const rows = caseToRows(aggregate, randomUUID);
            await store.insertCaseRow(client, rows.caseRow);
            for (const e of rows.eventRows) await store.insertEventRow(client, e);
          }
        }

        const applied = await checkoutStore.recordOutcome(client, {
          office,
          handoffId: id.data,
          expectStatus: priorState,
          outcome: body.outcome,
          actor,
          appointmentNote: note || null,
          caseId,
        });
        if (!applied) {
          const err = /** @type {Error & { code?: string }} */ (new Error('CHECKOUT_RACE'));
          err.code = 'CHECKOUT_RACE';
          throw err; // rolls back any case written above
        }
        return { priorState, caseId, caseAction, stoppedEnrollments };
      });
    } catch (err) {
      if (err && err.code === 'CHECKOUT_RACE') return refusal(req, res, id.data, 'answered');
      throw err;
    }

    if (result.missing) {
      return res.status(404).json({ success: false, error: 'Checkout handoff not found', code: 'NOT_FOUND' });
    }
    if (result.closed) {
      return res.status(409).json({
        success: false,
        error: `This checkout cannot be answered: it is already ${contract.TC_CHECKOUT_STATUS_LABELS[result.closed.status] || result.closed.status}.`,
        code: 'CHECKOUT_NOT_ACTIONABLE',
        handoff: checkoutStore.toHandoff(result.closed),
      });
    }

    await auditTc(req, 'UPDATE', 'tc_checkout_handoff', id.data, { office, priorState: result.priorState });
    if (result.caseId) await auditTc(req, result.caseAction, 'tc_case', result.caseId, { office });
    for (const enrollmentId of result.stoppedEnrollments || []) {
      await auditTc(req, 'UPDATE', 'tc_nurture_enrollment.stopped', enrollmentId, { office });
    }

    const row = await tenantDb.withTenantDb(req, (pool) => checkoutStore.findById(pool, office, id.data));
    return res.json({
      success: true,
      handoff: checkoutStore.toHandoff(row),
      caseId: result.caseId,
      url: result.caseId ? `/tc/cases/${result.caseId}` : null,
      attached: result.caseAction === 'UPDATE',
    });
  })
);

module.exports = router;
module.exports.setClockForTests = setClockForTests;
module.exports.officeToday = officeToday;
