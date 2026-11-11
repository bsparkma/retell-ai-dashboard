'use strict';

/**
 * POST /api/tc/checkout/:id/route — "Route to…" from a checkout card (CO-6).
 *
 * The front desk sends the card's patient to one of four places in TC
 * (shared/tc/checkoutRouting.ts says what each one means for the card):
 *
 *   preauth   a pre-auth through the EXISTING create path (preauth.js
 *             createPreauthInTx), prefilled from the card, linked to the card's
 *             case or the patient's open case when there is one — and to no
 *             case when there is none (a pre-auth needs no case).
 *   pipeline  the case (the card's open case, the patient's open case, or a
 *             new pending_tc one), set to the chosen status through the EXISTING
 *             status transition (caseStatus.applyStatusChange — the body of
 *             POST /cases/:id/status, extracted so both run one piece of code).
 *   followup  a tc_followups row on that case — due date and talking point
 *             required — through caseStore.insertFollowupRow, the follow-up
 *             queue's own writer.
 *   inbox     the TC Inbox: the patient's same-visit hygiene_review case if it
 *             is there, otherwise a new unowned hygiene_review case with its
 *             intake row (the Inbox lists exactly those). The card closes as
 *             Dismissed, "Sent to the TC Inbox…", because a waiting card is what
 *             keeps a same-day hygiene case OUT of the Inbox (CO-1).
 *
 * RULES (the checkout's own, unchanged):
 *   - tc.full (the /checkout mount), the office from `?office=` (requireOffice),
 *     behind the checkout switch and the day sweep (`enter`).
 *   - The PatNum, name and doctor are the STORED card's. The body names only
 *     the destination and the person's words; a body naming an office or a
 *     patient is a 400 (strict schemas).
 *   - Waiting cards only (open / claimed): an answered card is a record. The
 *     card row is locked FOR UPDATE first, so a routing and an outcome on the
 *     same card serialize, and everything a routing writes commits together.
 *   - EXISTING VOCABULARY ONLY. Case events: case_created, status_change,
 *     note_added. The pre-auth's own `created` history row. No outcome, card
 *     status, case status or event type is added.
 *   - "No case is left ownerless" (F1): a Pipeline move of an unowned case
 *     assigns it to the person who routed it, with a note.
 *   - Audit rows after the commit; the answer is the card READ BACK.
 *   - ZERO Open Dental reads or writes.
 */

const { randomUUID } = require('node:crypto');

const { contract, actorEmail, actorName, parseBody, h, auditTc } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const store = require('./caseStore');
const checkoutStore = require('./checkoutStore');
const caseStatus = require('./caseStatus');
const preauthRoute = require('./preauth');
const { findOpenCase } = require('./intakeFromCall');

const { z, TcCase, caseToRows, OPEN_CASE_STATUSES, TcCheckoutRouteRequest, CHECKOUT_INBOX_DISMISS_REASON } = contract;

const HandoffId = z.string().uuid();

const CHANNEL_WORDS = Object.freeze({ phone_call: 'phone call', text: 'text', email: 'email', in_person: 'in person' });

/** A refusal thrown out of the transaction: everything in it rolls back. */
class RouteRefusal extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function caseUrl(caseId) {
  return `/tc/cases/${caseId}`;
}

/**
 * The case this card's routing works on, or null: the card's own case while it
 * is still open, else the patient's most recently active open case in this
 * office (the attach-or-create rule every TC intake shares).
 */
async function openCaseFor(client, office, row) {
  if (row.case_id) {
    const header = await store.getCaseHeader(client, office, String(row.case_id));
    if (header && OPEN_CASE_STATUSES.includes(header.status)) return { caseId: String(row.case_id), header };
  }
  const found = await findOpenCase(client, office, Number(row.od_patient_id));
  if (!found) return null;
  return { caseId: String(found), header: await store.getCaseHeader(client, office, String(found)) };
}

/** A timeline line on the case. An existing type: note_added. */
async function note(client, { office, caseId, now, actor, description }) {
  await store.insertEventRow(client, {
    event_id: randomUUID(),
    case_id: caseId,
    office_id: office,
    ts: now,
    type: 'note_added',
    description: description.slice(0, 8000),
    actor,
    detail: null,
    legacy_id: null,
  });
}

/**
 * Point the card at the case its routing touched — the card's annotation (it
 * then shows that case, and the case's staff panel shows the card's staged
 * treatment). Conditional on the card still waiting.
 */
async function linkCard(client, { office, handoffId, caseId }) {
  const res = await client.query(
    `UPDATE tc_checkout_handoffs SET case_id = $3, updated_at = now()
      WHERE office_id = $1 AND handoff_id = $2 AND status = ANY($4)
      RETURNING handoff_id`,
    [office, handoffId, caseId, [...checkoutStore.WAITING_STATUSES]]
  );
  if (res.rowCount !== 1) throw new Error('the checkout card was not linked to its case');
}

/**
 * Everything the routing modules share, passed in by checkout.js (which owns
 * them) so this file adds no second copy: the case defaults a checkout opens a
 * case with, and the staged procedures as text lines.
 *
 * @typedef {{
 *   enter: (req: import('express').Request, res: import('express').Response) => Promise<string|null>,
 *   clock: () => Date,
 *   CHECKOUT_CASE_DEFAULTS: Record<string, unknown>,
 *   URGENCY_BY_PRIORITY: Record<string, string>,
 *   procedureLines: (snapshot: object) => string[],
 * }} RouteDeps
 */

/**
 * The case-level notes a case opened from a card carries — the same lines the
 * checkout outcome's created case carries.
 */
function caseNotes(deps, snapshot) {
  const lines = deps.procedureLines(snapshot);
  const nextVisit = (snapshot && snapshot.nextVisit) || {};
  return [
    lines.length ? `Staged at the hygiene visit:\n${lines.join('\n')}` : 'Nothing staged at the hygiene visit.',
    nextVisit.type ? `Next visit: ${nextVisit.type}` : '',
    snapshot && snapshot.frontDeskNote ? `Front desk note: ${snapshot.frontDeskNote}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 8000);
}

/**
 * Open a case for the card's patient (no open one exists). The full aggregate
 * through the contract, like the checkout outcome's own created case.
 *
 * @param {object} opts
 * @param {'pending_tc'|'hygiene_review'} opts.status
 * @param {string} opts.assignedTc  '' = unowned (the Inbox)
 * @param {string} opts.createdText the case_created event's words
 * @param {object|null} opts.intake  a TcHygieneIntake, or null
 */
async function createCase(client, deps, { office, row, handoff, actor, now, status, assignedTc, createdText, intake }) {
  const caseId = randomUUID();
  const snapshot = handoff.snapshot || {};
  const aggregate = TcCase.parse({
    ...deps.CHECKOUT_CASE_DEFAULTS,
    referralSource: contract.checkoutHasHygieneData(handoff) ? 'hygiene' : 'other',
    caseId,
    officeId: office,
    patientName: row.patient_name,
    odPatientId: Number(row.od_patient_id),
    status,
    urgency: deps.URGENCY_BY_PRIORITY[snapshot.priority] || 'medium',
    doctorName: row.provider || '',
    diagnosingProvider: row.provider || null,
    assignedTc,
    notes: caseNotes(deps, snapshot),
    statusChangedAt: now,
    hygieneIntake: intake,
    events: [
      { eventId: randomUUID(), legacyId: null, ts: now, type: 'case_created', description: createdText, actor, detail: null },
    ],
  });
  const rows = caseToRows(aggregate, randomUUID);
  await store.insertCaseRow(client, rows.caseRow);
  for (const e of rows.eventRows) await store.insertEventRow(client, e);
  if (rows.hygieneIntakeRow) await store.insertIntakeRow(client, rows.hygieneIntakeRow);
  return caseId;
}

/**
 * The intake a card sent to the Inbox carries (the Inbox lists hygiene_review
 * cases WITH an intake). Built from the card's snapshot only. WHO WAS SIGNED IN
 * is the person who routed it; WHO DID THE VISIT is the card's hygiene provider
 * when the card carries hygiene data, and says plainly there was no hygiene
 * visit otherwise — never the desk person's name.
 */
function inboxIntake(deps, { handoff, actor, actorDisplay, now }) {
  const snap = handoff.snapshot || {};
  const hygiene = contract.checkoutHasHygieneData(handoff);
  return {
    submittedBy: actor,
    submittedByName: actorDisplay,
    hygienistName: hygiene ? handoff.providerSeen || 'Hygiene visit' : 'Checkout (no hygiene visit)',
    submittedAt: now,
    operatory: handoff.operatory || '',
    visitDate: handoff.visitDate || null,
    providerSeen: handoff.providerSeen || '',
    chiefConcern: '',
    perioStatus: 'unknown',
    recallType: 'none',
    radiographs: [],
    intraoralPhotosTaken: false,
    areasOfConcern: '',
    suspectedTreatment: deps.procedureLines(snap).join('\n').slice(0, 8000),
    hygienistRecommendation: '',
    insuranceNoted: '',
    patientInterestLevel: 'unknown',
    flagUrgent: snap.priority === 'urgent',
    orthoScreening: null,
    existingTx: Array.isArray(snap.existingTx) && snap.existingTx.length ? snap.existingTx : null,
    collectAtCheckout: Array.isArray(snap.collectAtCheckout) && snap.collectAtCheckout.length ? snap.collectAtCheckout : null,
    records: Array.isArray(snap.records) && snap.records.length ? snap.records : null,
  };
}

/** F1: an unowned case the routing moved is now the router's, with a note. */
async function ownIfUnowned(client, { office, caseId, actor, now }) {
  const assigned = await client.query(
    `UPDATE tc_cases SET assigned_tc = $3, updated_at = now()
      WHERE office_id = $1 AND case_id = $2 AND assigned_tc = ''
      RETURNING case_id`,
    [office, caseId, actor]
  );
  if (assigned.rows.length > 0) {
    await note(client, {
      office,
      caseId,
      now,
      actor,
      description: 'Checkout: assigned to the person who routed it (nobody owned this case)',
    });
  }
}

/**
 * One destination's writes, inside the transaction, with the card locked and
 * known to be waiting. Returns what to report and audit.
 */
async function routeInTx(client, deps, { req, office, row, handoff, body, actor, now }) {
  const out = {
    caseId: null,
    caseAction: null, // 'CREATE' | 'UPDATE'
    preauthId: null,
    followupId: null,
    statusChanged: null,
    stoppedEnrollments: [],
    resolved: false,
  };

  if (body.destination === 'preauth') {
    const ctx = await openCaseFor(client, office, row);
    const preauthId = randomUUID();
    const input = preauthRoute.PreauthCreate.parse({
      ...(ctx ? { caseId: ctx.caseId } : {}),
      patientName: row.patient_name,
      odPatientId: Number(row.od_patient_id),
      preauthType: body.preauthType,
      description: (body.description ?? deps.procedureLines(handoff.snapshot).join('\n')).slice(0, 8000),
      insuranceCarrier: body.insuranceCarrier,
      doctorName: row.provider || '',
      notes: body.notes,
    });
    const created = await preauthRoute.createPreauthInTx(client, { office, actor, preauthId, input });
    if (created === preauthRoute.CASE_NOT_IN_OFFICE || !created) throw new Error('the pre-auth was not created');
    out.preauthId = preauthId;
    if (ctx) {
      out.caseId = ctx.caseId;
      out.caseAction = 'UPDATE';
      const carrier = body.insuranceCarrier ? ` (${body.insuranceCarrier})` : '';
      await note(client, {
        office,
        caseId: ctx.caseId,
        now,
        actor,
        description: `From checkout: a ${body.preauthType} pre-authorization was created${carrier}`,
      });
      await linkCard(client, { office, handoffId: handoff.handoffId, caseId: ctx.caseId });
    }
    return out;
  }

  if (body.destination === 'pipeline' || body.destination === 'followup') {
    const ctx = await openCaseFor(client, office, row);
    let caseId;
    if (ctx) {
      caseId = ctx.caseId;
      out.caseAction = 'UPDATE';
    } else {
      caseId = await createCase(client, deps, {
        office,
        row,
        handoff,
        actor,
        now,
        status: 'pending_tc',
        assignedTc: actor,
        createdText: `Case created at checkout (routed to ${body.destination === 'pipeline' ? 'the Pipeline' : 'a follow-up'})`,
        intake: null,
      });
      out.caseAction = 'CREATE';
    }
    out.caseId = caseId;

    if (body.destination === 'pipeline') {
      const applied = await caseStatus.applyStatusChange(client, {
        office,
        caseId,
        status: body.status,
        lostReason: null,
        note: body.note ? `Routed from checkout: ${body.note}` : 'Routed from checkout',
        actor,
        now,
      });
      if (applied.missing) throw new Error('the case vanished inside its own transaction');
      out.statusChanged = !applied.unchanged;
      out.stoppedEnrollments = applied.unchanged ? [] : applied.stoppedEnrollments;
      if (!applied.unchanged) await ownIfUnowned(client, { office, caseId, actor, now });
    } else {
      const followupId = randomUUID();
      await store.insertFollowupRow(client, {
        followup_id: followupId,
        case_id: caseId,
        office_id: office,
        kind: 'followup',
        due_date: body.dueDate,
        channel: body.channel,
        status: 'pending',
        talking_point: body.talkingPoint,
        outcome_note: '',
        completed_at: null,
        completed_by: null,
        source: 'manual',
        patient_responded: null,
        nurture_type: null,
        legacy_id: null,
      });
      out.followupId = followupId;
      await note(client, {
        office,
        caseId,
        now,
        actor,
        description: `From checkout: follow-up due ${body.dueDate} (${CHANNEL_WORDS[body.channel] || body.channel}): ${body.talkingPoint}`,
      });
    }
    await linkCard(client, { office, handoffId: handoff.handoffId, caseId });
    return out;
  }

  // inbox
  const ctx = await openCaseFor(client, office, row);
  let caseId;
  if (ctx) {
    if (!ctx.header || ctx.header.status !== 'hygiene_review') {
      throw new RouteRefusal(
        409,
        'CASE_ALREADY_ON_PIPELINE',
        `This patient already has an open case on the Pipeline (${ctx.header ? ctx.header.status : 'unknown'}), so there is nothing to put in the Inbox. Route to the Pipeline instead.`,
        { caseId: ctx.caseId, url: caseUrl(ctx.caseId) }
      );
    }
    const intake = await client.query('SELECT case_id FROM tc_hygiene_intakes WHERE office_id = $1 AND case_id = $2', [
      office,
      ctx.caseId,
    ]);
    if (intake.rows.length === 0) {
      throw new RouteRefusal(
        409,
        'CASE_NOT_IN_INBOX',
        "This patient's open case has no hygiene intake, so the TC Inbox cannot list it. Route to the Pipeline instead.",
        { caseId: ctx.caseId, url: caseUrl(ctx.caseId) }
      );
    }
    caseId = ctx.caseId;
    out.caseAction = 'UPDATE';
    await note(client, {
      office,
      caseId,
      now,
      actor,
      description: `From checkout: sent to the TC Inbox${body.note ? `: ${body.note}` : ''}`,
    });
  } else {
    caseId = await createCase(client, deps, {
      office,
      row,
      handoff,
      actor,
      now,
      status: 'hygiene_review',
      assignedTc: '',
      createdText: `Case created at checkout: sent to the TC Inbox${body.note ? `: ${body.note}` : ''}`,
      intake: inboxIntake(deps, { handoff, actor, actorDisplay: actorName(req), now }),
    });
    out.caseAction = 'CREATE';
  }
  out.caseId = caseId;
  await linkCard(client, { office, handoffId: handoff.handoffId, caseId });
  const reason = `${CHECKOUT_INBOX_DISMISS_REASON}${body.note ? `: ${body.note}` : ''}`.slice(0, 500);
  const prior = await checkoutStore.dismiss(client, { office, handoffId: handoff.handoffId, actor, reason });
  if (!prior) throw new Error('the checkout card was not closed');
  out.resolved = true;
  return out;
}

/**
 * Mount the route on the checkout router.
 *
 * @param {import('express').Router} router
 * @param {RouteDeps} deps
 */
function mount(router, deps) {
  router.post(
    '/:id/route',
    h(async (req, res) => {
      const id = HandoffId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ success: false, error: 'Invalid handoff id', code: 'INVALID_ID' });
      const body = parseBody(res, TcCheckoutRouteRequest, req.body);
      if (!body) return undefined;
      const today = await deps.enter(req, res);
      if (today === null) return undefined;

      const office = req.tcOffice;
      const actor = actorEmail(req);
      const now = deps.clock().toISOString();

      let result;
      try {
        result = await withTenantTx(req, async (client) => {
          if (!(await checkoutStore.lockHandoff(client, office, id.data))) return { missing: true };
          const row = await checkoutStore.findById(client, office, id.data);
          if (!row) return { missing: true };
          const priorState = row.status || 'open';
          if (!checkoutStore.WAITING_STATUSES.includes(priorState)) return { closed: row };
          const handoff = checkoutStore.toHandoff(row);
          const done = await routeInTx(client, deps, { req, office, row, handoff, body, actor, now });
          return { ...done, priorState };
        });
      } catch (err) {
        if (err instanceof RouteRefusal) {
          return res.status(err.status).json({ success: false, error: err.message, code: err.code, ...err.extra });
        }
        throw err;
      }

      if (result.missing) return res.status(404).json({ success: false, error: 'Checkout handoff not found', code: 'NOT_FOUND' });
      if (result.closed) {
        return res.status(409).json({
          success: false,
          error: `This checkout cannot be routed: it is already ${contract.TC_CHECKOUT_STATUS_LABELS[result.closed.status] || result.closed.status}.`,
          code: 'CHECKOUT_NOT_ACTIONABLE',
          handoff: checkoutStore.toHandoff(result.closed),
        });
      }

      // After the commit: the card (what the routing did to it, as a slug), and
      // each row the routing made or changed.
      await auditTc(req, 'UPDATE', 'tc_checkout_handoff', id.data, {
        office,
        sourceRef: `checkout_route:${body.destination}`,
        priorState: result.priorState,
      });
      if (result.caseId) await auditTc(req, result.caseAction, 'tc_case', result.caseId, { office });
      if (result.preauthId) await auditTc(req, 'CREATE', 'tc_preauth', result.preauthId, { office });
      if (result.followupId) await auditTc(req, 'CREATE', 'tc_followup', result.followupId, { office });
      for (const enrollmentId of result.stoppedEnrollments) {
        await auditTc(req, 'UPDATE', 'tc_nurture_enrollment.stopped', enrollmentId, { office });
      }

      // Report what PERSISTED: the card read back after the commit.
      const now2 = await tenantDb.withTenantDb(req, (pool) => checkoutStore.findById(pool, office, id.data));
      const handoff = now2 ? checkoutStore.toHandoff(now2) : null;
      const holds =
        handoff &&
        (result.caseId === null || handoff.caseId === result.caseId) &&
        (result.resolved ? handoff.status === 'dismissed' : checkoutStore.WAITING_STATUSES.includes(handoff.status));
      if (!holds) {
        return res.status(500).json({
          success: false,
          error: 'The routing could not be read back from the checkout card. Reload before trusting it.',
          code: 'ROUTE_NOT_PERSISTED',
        });
      }
      return res.json({
        success: true,
        destination: body.destination,
        handoff,
        caseId: result.caseId,
        url: result.caseId ? caseUrl(result.caseId) : null,
        attached: result.caseAction === 'UPDATE',
        preauthId: result.preauthId,
        followupId: result.followupId,
        statusChanged: result.statusChanged,
        resolved: result.resolved,
      });
    })
  );
}

// routeInTx is exported for scripts/checkout-questions-verify-queries.js, which
// runs every destination's real statements against the real schema.
module.exports = { mount, RouteRefusal, routeInTx };
