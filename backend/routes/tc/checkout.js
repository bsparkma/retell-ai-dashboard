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
 *   GET  /by-case/:caseId      the staff-only "Treatment from hygiene" panel (C2b)
 *   POST   /:id/items/:index/entered   attest "this item is in Open Dental"
 *   DELETE /:id/items/:index/entered   undo that attestation (admin only)
 *   POST   /:id/workup        tick or untick one box on the workup checklist (CO-1)
 *
 * THE WORKUP CHECKLIST (CO-1). The full-screen workup view's boxes — each
 * staged item "Worked up", each existing-treatment group "Ready to present",
 * "Collected", "Referrals handled" — are stored on the handoff itself
 * (tc_checkout_handoffs.workup). The office is the request's (requireOffice)
 * and the record is the one this office holds under that id; nothing in the
 * body names either. Editable while the checkout is waiting (open / claimed);
 * an answered one is a record, and its checklist with it. One audit row per
 * change, after the commit, and the answer is the checklist READ BACK, never
 * the request. Like the attestation, it is a desk checklist, not a sync.
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
 *
 * NO CASE IS LEFT OWNERLESS (pre-IA fix F1, Beau's rule). An open case that
 * Scheduled / Not scheduled attaches to and that nobody owns (assigned_tc '')
 * is assigned to the person who answered the checkout, with a note on its
 * timeline. A case created here is theirs already. An owned case keeps its
 * owner.
 *
 * THE TREATMENT GOES ON THE CASE (C2b). Scheduled and Not scheduled also copy
 * the staged procedures into the case's own treatment plan (the Treatment
 * tab the coordinator presents from): one phase per checkout, "Hygiene visit
 * <date>", appended after whatever the plan already holds, one item per
 * procedure. Created or attached, same transaction, so a lost race leaves no
 * phase either. The plan is PATIENT-FACING (the presentation slides show the
 * phase description, an item's patientDescription in place of its name, and
 * its timeEstimate), so the hygienist's notes, the schedule-next flags and
 * "fees not set" go in a staff-only timeline event instead, never in those
 * fields. Fees are not known at checkout, so the items carry $0. The contract
 * caps a plan at 20 phases; a full plan gets no phase, and the event lists the
 * items as text instead so nothing is silently dropped.
 *
 * THE STAFF PANEL AND "ENTERED IN OPEN DENTAL" (C2b, PM revision). Beau's
 * requirement: the hygienist's diagnosed treatment stays visible on the case
 * until a HUMAN confirms it was entered into Open Dental. The plan phase can be
 * edited or replaced (Edit plan, Pull from Open Dental), so the persistent
 * record is the HANDOFF's own stored snapshot, rendered staff-only by
 * GET /by-case/:caseId. Each staged item carries a manual attestation (who,
 * when; tc_checkout_attestations). It is NOT a sync: nothing here reads or
 * writes Open Dental. An attestation made against an item the hygienist later
 * revised is stale and reads as not entered. Undoing one is admin-only. Every
 * attestation and undo writes one audit row, after the write committed.
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
const { holdsPermission } = require('../../config/permissions');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const store = require('./caseStore');
const checkoutStore = require('./checkoutStore');
const { findOpenCase } = require('./intakeFromCall');
const nurtureHooks = require('../../services/tcNurture/hooks');
const { localDayKey } = require('../../services/localDayClock');
const tcCheckout = require('../../config/tcCheckout');

const {
  z,
  TcCase,
  TcCasePhase,
  caseToRows,
  TcCheckoutOutcomeRequest,
  TcCheckoutDismissRequest,
  TcCheckoutWorkupRequest,
} = contract;

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
    const teeth = p.teeth === 'mouth' ? 'Whole mouth' : contract.teethText(p.teeth || []);
    return `${teeth} ${p.code} (${p.priority})`;
  });
}

/** The contract's cap on a plan's phases (TcCase.phases max). */
const MAX_PHASES = 20;

/** tc_case_phases UNIQUE (case_id, position), migration 1785373200000. */
const PHASE_POSITION_UNIQUE = 'tc_case_phases_case_position_unique';

/** "#3 O", "#3, #4 MO", "Whole mouth", or "" — the plan item's tooth column. */
function toothText(p) {
  if (p.teeth === 'mouth') return 'Whole mouth';
  const teeth = Array.isArray(p.teeth) && p.teeth.length ? contract.teethText(p.teeth) : '';
  const surfaces = Array.isArray(p.surfaces) ? p.surfaces.join('') : '';
  return [teeth, surfaces].filter(Boolean).join(' ').slice(0, 200);
}

/**
 * The checkout's staged procedures as ONE treatment-plan phase, or null when
 * nothing was staged. Pure; parsed by the contract so a bad snapshot throws
 * (rolling the outcome back) rather than writing a plan the case cannot load.
 * Only patient-safe fields are filled (see the header).
 *
 * @param {object} snapshot  the handoff's payload
 * @param {{ visitDate: string|null }} handoff
 * @param {number} position
 */
function checkoutPhase(snapshot, handoff, position) {
  const procs = snapshot && Array.isArray(snapshot.procedures) ? snapshot.procedures : [];
  if (procs.length === 0) return null;
  return TcCasePhase.parse({
    phaseId: randomUUID(),
    position,
    name: contract.checkoutPhaseName(handoff.visitDate || null).slice(0, 200),
    description: '',
    items: procs.slice(0, 100).map((p, i) => ({
      itemId: randomUUID(),
      legacyItemId: null,
      odProcNum: null,
      position: i,
      tooth: toothText(p),
      procedureName: String(p.code || 'Other').slice(0, 200),
      patientDescription: '',
      feeCents: 0,
      insuranceEstCents: 0,
      patientPortionCents: 0,
      urgency: URGENCY_BY_PRIORITY[p.priority] || 'medium',
      timeEstimate: '',
      benefits: [],
      risksOfDelay: [],
      expectedOutcome: '',
    })),
  });
}

/**
 * The staff-only timeline line that goes with a checkout phase: where it came
 * from, that fees are unset, and each item's schedule-next flag and the
 * hygienist's note. `added` false says the plan was full and lists the items
 * so they are not lost.
 */
function treatmentEventText(snapshot, handoff, phaseName, added) {
  const procs = snapshot && Array.isArray(snapshot.procedures) ? snapshot.procedures : [];
  const by = handoff.provider ? ` (provider ${handoff.provider})` : '';
  const head = added
    ? `Checkout treatment added to the plan as "${phaseName}"${by}. Fees are not known at checkout: set them before presenting.`
    : `Checkout treatment not added to the plan (it already has ${MAX_PHASES} phases)${by}:`;
  const lines = procedureLines(snapshot).map((line, i) => {
    const p = procs[i] || {};
    const extra = [p.scheduleNext ? 'schedule at next visit' : '', p.note ? `note: ${p.note}` : '']
      .filter(Boolean)
      .join('; ');
    return extra ? `${line}: ${extra}` : line;
  });
  return [head, ...lines].join('\n').slice(0, 8000);
}

/** Write one phase and its items onto an existing case. */
async function insertPhase(client, office, caseId, phase) {
  await store.insertPhaseRow(client, {
    phase_id: phase.phaseId,
    case_id: caseId,
    office_id: office,
    position: phase.position,
    name: phase.name,
    description: phase.description,
  });
  for (const it of phase.items) {
    await store.insertItemRow(client, {
      item_id: it.itemId,
      phase_id: phase.phaseId,
      case_id: caseId,
      office_id: office,
      position: it.position,
      legacy_item_id: it.legacyItemId,
      od_proc_num: it.odProcNum,
      tooth: it.tooth,
      procedure_name: it.procedureName,
      patient_description: it.patientDescription,
      fee_cents: it.feeCents,
      insurance_est_cents: it.insuranceEstCents,
      patient_portion_cents: it.patientPortionCents,
      urgency: it.urgency,
      time_estimate: it.timeEstimate,
      benefits: it.benefits,
      risks_of_delay: it.risksOfDelay,
      expected_outcome: it.expectedOutcome,
    });
  }
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

            // F1 (Beau's rule): no case is ever left ownerless by a checkout
            // outcome. The open case is usually the same visit's UNCLAIMED
            // hygiene_review case, and the move above takes it out of the
            // TC Inbox — so whoever answered the checkout becomes its owner.
            // Conditional on it still being unowned, so an Inbox Claim that
            // lands first keeps its owner.
            const assigned = await client.query(
              `UPDATE tc_cases
                  SET assigned_tc = $3, updated_at = now()
                WHERE office_id = $1 AND case_id = $2 AND assigned_tc = ''
                RETURNING case_id`,
              [office, openCaseId, actor]
            );
            if (assigned.rows.length > 0) {
              await store.insertEventRow(client, {
                event_id: randomUUID(),
                case_id: openCaseId,
                office_id: office,
                ts: now,
                type: 'note_added',
                description: 'Checkout: assigned to the person who answered it (nobody owned this case)',
                actor,
                detail: null,
                legacy_id: null,
              });
            }

            // C2b: the staged treatment goes onto the open case's plan too.
            // Row-lock the case first (an UPDATE takes it; the case IS
            // changing). Without it two answers attaching at once both read
            // the same max(position), and the loser dies on the
            // (case_id, position) unique index as a 500 instead of failing
            // the handoff CAS as a 409. With it the loser waits, re-reads the
            // winner's phase, and then loses the CAS cleanly. It also keeps
            // the 20-phase cap honest under concurrency.
            await client.query(
              `UPDATE tc_cases SET updated_at = now() WHERE office_id = $1 AND case_id = $2`,
              [office, openCaseId]
            );
            const existing = await client.query(
              'SELECT position FROM tc_case_phases WHERE office_id = $1 AND case_id = $2',
              [office, openCaseId]
            );
            const positions = existing.rows.map((r) => Number(r.position));
            const phase = checkoutPhase(
              snapshot,
              checkoutStore.toHandoff(handoff),
              positions.length ? Math.max(...positions) + 1 : 0
            );
            if (phase) {
              const added = positions.length < MAX_PHASES;
              if (added) await insertPhase(client, office, openCaseId, phase);
              await store.insertEventRow(client, {
                event_id: randomUUID(),
                case_id: openCaseId,
                office_id: office,
                ts: now,
                type: 'note_added',
                description: treatmentEventText(snapshot, checkoutStore.toHandoff(handoff), phase.name, added),
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
            const phase = checkoutPhase(snapshot, checkoutStore.toHandoff(handoff), 0);
            if (phase) {
              events.push({
                eventId: randomUUID(),
                legacyId: null,
                ts: now,
                type: 'note_added',
                description: treatmentEventText(snapshot, checkoutStore.toHandoff(handoff), phase.name, true),
                actor,
                detail: null,
              });
            }
            const aggregate = TcCase.parse({
              ...CHECKOUT_CASE_DEFAULTS,
              phases: phase ? [phase] : [],
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
            for (const p of rows.phaseRows) await store.insertPhaseRow(client, p);
            for (const it of rows.itemRows) await store.insertItemRow(client, it);
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
      // The plan was rewritten underneath this answer (an Edit-plan save or
      // a Pull from Open Dental landed between the read and the insert).
      // Everything rolled back; say so rather than 500.
      if (err && err.code === '23505' && err.constraint === PHASE_POSITION_UNIQUE) {
        return res.status(409).json({
          success: false,
          error: "The case's treatment plan changed while this was saving. Nothing was recorded; try again.",
          code: 'CHECKOUT_PLAN_CHANGED',
        });
      }
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

// ── C2b: the staff panel and "entered in Open Dental" ──────────────────────

const ItemIndex = z.coerce.number().int().min(0).max(99);

/** The panel's view of one handoff, as the client renders it. */
function panelVisit(row, attestations) {
  return {
    handoff: checkoutStore.toHandoff(row),
    items: checkoutStore.panelItems(row, attestations, contract.checkoutItemKey),
  };
}

router.get(
  '/by-case/:caseId',
  h(async (req, res) => {
    const caseId = z.string().uuid().safeParse(req.params.caseId);
    if (!caseId.success) return res.status(400).json({ success: false, error: 'Invalid case id', code: 'INVALID_ID' });
    const today = await enter(req, res);
    if (today === null) return undefined;
    const office = req.tcOffice;
    const { rows, attestations } = await tenantDb.withTenantDb(req, async (pool) => {
      const found = await checkoutStore.listForCase(pool, office, caseId.data);
      const atts = await checkoutStore.listAttestations(
        pool,
        office,
        found.map((r) => String(r.handoff_id))
      );
      return { rows: found, attestations: atts };
    });
    // A PHI read (the staged treatment): audited even when it is empty.
    await auditTc(req, 'READ', 'tc_checkout_handoff', null, { office, sourceRef: `case:${caseId.data}` });
    return res.json({
      success: true,
      caseId: caseId.data,
      canUnattest: holdsPermission(req, 'admin.all'),
      visits: rows.map((row) =>
        panelVisit(
          row,
          attestations.filter((a) => String(a.handoff_id) === String(row.handoff_id))
        )
      ),
    });
  })
);

/** Parse `:id` + `:index`, or answer the 400 and return null. */
function itemParams(req, res) {
  const id = HandoffId.safeParse(req.params.id);
  const index = ItemIndex.safeParse(req.params.index);
  if (!id.success || !index.success || !/^\d{1,2}$/.test(String(req.params.index))) {
    res.status(400).json({ success: false, error: 'Invalid handoff id or item', code: 'INVALID_ID' });
    return null;
  }
  return { id: id.data, index: index.data };
}

/** The handoff, linked to a case, with a staged item at `index`; or the refusal. */
async function attestTarget(client, office, id, index) {
  const row = await checkoutStore.findById(client, office, id);
  if (!row) return { refusal: [404, 'Checkout handoff not found', 'NOT_FOUND'] };
  if (!row.case_id) {
    return { refusal: [409, 'This checkout is not on a case, so there is nothing to mark.', 'CHECKOUT_NOT_ON_CASE'] };
  }
  const procs = checkoutStore.proceduresOf(row);
  if (index >= procs.length) return { refusal: [404, 'That item is not on this checkout', 'ITEM_NOT_FOUND'] };
  return { row, procedure: procs[index] };
}

router.post(
  '/:id/items/:index/entered',
  h(async (req, res) => {
    const p = itemParams(req, res);
    if (!p) return undefined;
    const today = await enter(req, res);
    if (today === null) return undefined;
    const office = req.tcOffice;

    const result = await withTenantTx(req, async (client) => {
      const target = await attestTarget(client, office, p.id, p.index);
      if (target.refusal) return target;
      const itemKey = contract.checkoutItemKey(target.procedure);
      const prior = await checkoutStore.findAttestation(client, office, p.id, p.index);
      if (prior && prior.item_key === itemKey) return { row: target.row, already: true };
      const stored = await checkoutStore.upsertAttestation(client, {
        office,
        handoffId: p.id,
        index: p.index,
        itemKey,
        actor: actorEmail(req),
        at: clock().toISOString(),
      });
      if (!stored) throw new Error('attestation was not stored');
      return { row: target.row, priorState: prior ? 'stale' : 'unattested' };
    });
    if (result.refusal) {
      const [status, error, code] = result.refusal;
      return res.status(status).json({ success: false, error, code });
    }

    if (!result.already) {
      await auditTc(req, result.priorState === 'stale' ? 'UPDATE' : 'CREATE', 'tc_checkout_item_attestation', `${p.id}:${p.index}`, {
        office,
        priorState: result.priorState,
      });
    }
    // Report what PERSISTED: read the attestation back after the commit.
    const atts = await tenantDb.withTenantDb(req, (pool) => checkoutStore.listAttestations(pool, office, [p.id]));
    const item = panelVisit(result.row, atts).items[p.index];
    if (!item || !item.enteredBy) {
      return res.status(500).json({ success: false, error: 'The attestation could not be read back', code: 'ATTESTATION_NOT_PERSISTED' });
    }
    return res.json({ success: true, handoffId: p.id, item, alreadyEntered: result.already === true });
  })
);

router.delete(
  '/:id/items/:index/entered',
  h(async (req, res) => {
    const p = itemParams(req, res);
    if (!p) return undefined;
    if (!holdsPermission(req, 'admin.all')) {
      return res.status(403).json({
        success: false,
        error: 'Only a practice admin can undo "entered in Open Dental".',
        code: 'UNATTEST_ADMIN_ONLY',
      });
    }
    const today = await enter(req, res);
    if (today === null) return undefined;
    const office = req.tcOffice;

    const result = await withTenantTx(req, async (client) => {
      const target = await attestTarget(client, office, p.id, p.index);
      if (target.refusal) return target;
      const removed = await checkoutStore.deleteAttestation(client, office, p.id, p.index);
      if (!removed) return { refusal: [404, 'That item is not marked as entered', 'NOT_ATTESTED'] };
      // What it WAS: a current mark, or one already stale against a revised item.
      const priorState = removed.item_key === contract.checkoutItemKey(target.procedure) ? 'attested' : 'stale';
      return { row: target.row, priorState };
    });
    if (result.refusal) {
      const [status, error, code] = result.refusal;
      return res.status(status).json({ success: false, error, code });
    }
    await auditTc(req, 'DELETE', 'tc_checkout_item_attestation', `${p.id}:${p.index}`, {
      office,
      priorState: result.priorState,
    });
    const atts = await tenantDb.withTenantDb(req, (pool) => checkoutStore.listAttestations(pool, office, [p.id]));
    return res.json({ success: true, handoffId: p.id, item: panelVisit(result.row, atts).items[p.index] });
  })
);

// ── CO-1: the workup checklist ──────────────────────────────────────────────

/**
 * Apply one tick to a checklist, or say why it does not apply to this
 * snapshot. Pure. `null` mark = untick.
 *
 * `was` is whether the box counted as ticked before (a STALE tick does not);
 * `changed` is whether storing `workup` changes anything — re-ticking a ticked
 * box keeps the first person's mark, and unticking a stale tick clears it.
 *
 * @returns {{ workup: object, was: boolean, changed: boolean } | { refusal: [number, string, string] }}
 */
function applyWorkupTick(workup, snapshot, body, mark) {
  const next = {
    workedUp: { ...workup.workedUp },
    present: { ...workup.present },
    collected: workup.collected,
    referrals: workup.referrals,
  };
  const box = workupBox(snapshot, body);
  if (box.refusal) return box;
  if (!box.keyed) {
    const was = next.referrals !== null;
    if (was !== Boolean(mark)) next.referrals = mark;
    return { workup: next, was, changed: was !== Boolean(mark) };
  }
  const prior = box.get(next);
  const was = Boolean(prior) && prior.key === box.key;
  if (mark && !was) box.set(next, { ...mark, key: box.key });
  if (!mark) box.set(next, null);
  return { workup: next, was, changed: mark ? !was : Boolean(prior) };
}

/**
 * One box of the checklist for this snapshot: where its mark lives and the key
 * a CURRENT mark carries (what it was ticked against), or the named refusal
 * when the snapshot has no such box. Referrals is the one unkeyed box.
 */
function workupBox(snapshot, body) {
  const procs = snapshot && Array.isArray(snapshot.procedures) ? snapshot.procedures : [];
  const existing = snapshot && Array.isArray(snapshot.existingTx) ? snapshot.existingTx : [];
  const collect = snapshot && Array.isArray(snapshot.collectAtCheckout) ? snapshot.collectAtCheckout : [];
  if (body.section === 'workup') {
    const p = procs[body.index];
    if (!p) return { refusal: [404, 'That item is not on this checkout', 'ITEM_NOT_FOUND'] };
    const k = String(body.index);
    return {
      keyed: true,
      key: contract.checkoutItemKey(p),
      get: (w) => w.workedUp[k],
      set: (w, m) => (m ? (w.workedUp[k] = m) : delete w.workedUp[k]),
    };
  }
  if (body.section === 'present') {
    // Only a group the snapshot actually has can become an object key.
    if (!existing.some((i) => i.patient === body.group)) {
      return { refusal: [404, 'That group of existing treatment is not on this checkout', 'GROUP_NOT_FOUND'] };
    }
    return {
      keyed: true,
      key: contract.checkoutPresentKey(existing, body.group),
      get: (w) => w.present[body.group],
      set: (w, m) => (m ? (w.present[body.group] = m) : delete w.present[body.group]),
    };
  }
  if (body.section === 'collect') {
    if (collect.length === 0) return { refusal: [404, 'There is nothing to collect on this checkout', 'NOTHING_TO_COLLECT'] };
    return {
      keyed: true,
      key: contract.checkoutCollectKey(collect),
      get: (w) => w.collected,
      set: (w, m) => (w.collected = m),
    };
  }
  return { keyed: false };
}

/**
 * Whether the read-back checklist holds the tick the request asked for: a
 * CURRENT mark for done, no mark for not-done.
 *
 * Conservative by design (review round 1): if another desk user flips the same
 * box between this commit and this read, it answers WORKUP_NOT_PERSISTED and
 * the client reloads. It can never call a tick saved that the row does not hold.
 */
function workupHolds(handoff, body) {
  const w = handoff.workup;
  const box = workupBox(handoff.snapshot, body);
  if (box.refusal) return false;
  if (!box.keyed) return (w.referrals !== null) === body.done;
  const m = box.get(w);
  return body.done ? Boolean(m) && m.key === box.key : !m;
}

router.post(
  '/:id/workup',
  h(async (req, res) => {
    const id = HandoffId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ success: false, error: 'Invalid handoff id', code: 'INVALID_ID' });
    const body = parseBody(res, TcCheckoutWorkupRequest, req.body);
    if (!body) return undefined;
    const today = await enter(req, res);
    if (today === null) return undefined;
    const office = req.tcOffice;
    const mark = body.done ? { by: actorEmail(req), at: clock().toISOString() } : null;

    const result = await withTenantTx(req, async (client) => {
      // The lock first: two ticks on one checkout serialize, so neither
      // read-modify-write can erase the other.
      if (!(await checkoutStore.lockHandoff(client, office, id.data))) return { refusal: [404, 'Checkout handoff not found', 'NOT_FOUND'] };
      const row = await checkoutStore.findById(client, office, id.data);
      if (!row) return { refusal: [404, 'Checkout handoff not found', 'NOT_FOUND'] };
      if (!checkoutStore.WAITING_STATUSES.includes(row.status || 'open')) return { closed: row };
      const handoff = checkoutStore.toHandoff(row);
      const applied = applyWorkupTick(handoff.workup, handoff.snapshot, body, mark);
      if (applied.refusal) return applied;
      if (!applied.changed) return { unchanged: true };
      if (!(await checkoutStore.writeWorkup(client, office, id.data, applied.workup))) {
        throw new Error('the workup checklist was not stored');
      }
      return { priorState: applied.was ? 'done' : 'not_done' };
    });

    if (result.refusal) {
      const [status, error, code] = result.refusal;
      return res.status(status).json({ success: false, error, code });
    }
    if (result.closed) {
      return res.status(409).json({
        success: false,
        error: `This checkout's checklist cannot change: it is already ${contract.TC_CHECKOUT_STATUS_LABELS[result.closed.status] || result.closed.status}.`,
        code: 'CHECKOUT_NOT_ACTIONABLE',
        handoff: checkoutStore.toHandoff(result.closed),
      });
    }
    if (!result.unchanged) {
      await auditTc(req, 'UPDATE', 'tc_checkout_handoff', id.data, {
        office,
        sourceRef: `checkout_workup:${body.section}`,
        priorState: result.priorState,
      });
    }

    // Report what PERSISTED: the checklist read back after the commit.
    const row = await tenantDb.withTenantDb(req, (pool) => checkoutStore.findById(pool, office, id.data));
    const handoff = row ? checkoutStore.toHandoff(row) : null;
    if (!handoff || !workupHolds(handoff, body)) {
      return res.status(500).json({
        success: false,
        error: 'The checklist could not be read back as saved. Reload before trusting it.',
        code: 'WORKUP_NOT_PERSISTED',
      });
    }
    return res.json({ success: true, handoff, unchanged: result.unchanged === true });
  })
);

module.exports = router;
module.exports.setClockForTests = setClockForTests;
module.exports.applyWorkupTick = applyWorkupTick;
module.exports.officeToday = officeToday;
// Exported for the tests: TC's own text for a hygiene procedure (feedback round 1
// pins that a primary tooth prints as its letter here too).
module.exports.procedureLines = procedureLines;
