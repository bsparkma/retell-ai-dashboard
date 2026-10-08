'use strict';

/**
 * /api/tc/opportunities — the Opportunities inbox (queue item 41).
 *
 * Treatment planned in Open Dental and sitting unscheduled, surfaced by the
 * nightly sync (services/tcOpportunities/) as CANDIDATES. Nothing here creates
 * a case on its own: a human claims (→ case) or dismisses (reason required).
 *
 *   GET  /               ?office= &status=new|claimed|dismissed|existing_case|all
 *   POST /:id/claim      attach-or-create a TC case (intakeFromCall's rule)
 *   POST /:id/dismiss    { reason }
 *
 * POSTGRES ONLY. No route in this file reaches Open Dental — there is no OD
 * client imported here, and tcOpportunities.test.js pins that. The inbox is
 * the nightly sync's snapshot; an on-demand OD fan-out from a screen is the
 * one thing the throttle cannot afford.
 *
 * OFFICE LAW. `?office=` through helpers.requireOffice, and every statement is
 * office_id-scoped. A PatNum is never read or written without its office.
 *
 * ATTACH-OR-CREATE. A claim uses intakeFromCall's own `findOpenCase` — the
 * OPEN_CASE_STATUSES partition from the shared contract, most recently active
 * first — so a patient who already has an open case gets the opportunity
 * ATTACHED to it (a timeline event, the case otherwise untouched; status
 * existing_case) and never a second case. Otherwise a new pending_tc case is
 * created, assigned to the claimer.
 *
 * THE PHASE TREE is built on the client by features/tc/od/odPlan.ts — the ONE
 * implementation of groupItemsIntoPhases + inferUrgency — and verified here
 * against the snapshot (core.verifyClaimPhases): every item must be a
 * procedure the opportunity holds, at the fee it holds.
 *
 * AUDIT. audit_log.action allows only READ/CREATE/UPDATE/DELETE, so the event
 * name rides in resource_type: `tc_opportunity` (READ on list, UPDATE on claim
 * and dismiss) beside the `tc_case` CREATE/UPDATE the claim causes.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const { contract, requireOffice, actorEmail, parseBody, h, auditTc } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const caseStore = require('./caseStore');
const { findOpenCase } = require('./intakeFromCall');
const { PhaseCreate } = require('./cases');
const core = require('../../services/tcOpportunities/core');
const oppStore = require('../../services/tcOpportunities/store');

const { z, TcCase, Uuid, caseToRows } = contract;

const router = express.Router();
router.use(requireOffice);

/** Rows returned per list; totals are always over the whole filtered set. */
const LIST_LIMIT = 500;

const STATUS_FILTERS = Object.freeze([...core.OPPORTUNITY_STATUSES, 'all']);

const ClaimBody = z
  .object({
    phases: z.array(PhaseCreate).max(20).optional(),
  })
  .strict();

const DismissBody = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** Scalars for a case opened by a claim — NewCaseDialog's own defaults. */
const CLAIM_CASE_DEFAULTS = Object.freeze({
  legacyId: null,
  patientAge: null,
  email: null,
  caseType: '',
  category: 'single_tooth',
  status: 'pending_tc',
  doctorName: '',
  diagnosingProvider: null,
  readinessScore: 0,
  financingStatus: '',
  preferredFinancingProvider: null,
  decisionMakers: '',
  financialSituation: [],
  keyMotivators: [],
  contactPreference: null,
  bestTimeToReach: '',
  notes: '',
  // Treatment planned in the practice's own chart: an existing patient.
  referralSource: 'existing_patient',
  lostReason: null,
  nurtureCadence: 'standard',
  inLongTailMode: false,
  nurtureEnrolledAt: null,
  nurturePhaseChangedAt: null,
  nurturePhase1DaysOverride: null,
  nurturePhase2DaysOverride: null,
  nurtureUnsubscribed: false,
  objections: [],
  followups: [],
  hygieneIntake: null,
});

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

/** 409 with a code. */
function conflict(res, code, error, extra = {}) {
  return res.status(409).json({ success: false, error, code, ...extra });
}

// ── GET / ───────────────────────────────────────────────────────────────────

router.get(
  '/',
  h(async (req, res) => {
    const raw = typeof req.query.status === 'string' ? req.query.status.trim() : 'new';
    const wanted = raw || 'new';
    if (!STATUS_FILTERS.includes(wanted)) {
      return res.status(400).json({
        success: false,
        error: `status must be one of: ${STATUS_FILTERS.join(', ')}`,
        code: 'INVALID_STATUS',
      });
    }
    const office = req.tcOffice;

    const result = await withTenantTx(req, async (client) => {
      // existing_case is a live fact about the case table, so it is brought up
      // to date on every read — a Postgres-only statement, no Open Dental.
      await oppStore.reconcileExistingCases(client, office);
      const rows = await oppStore.listForOffice(client, office);
      const sync = await oppStore.getSyncState(client, office);
      return { rows, sync };
    });

    const visible = result.rows.filter(
      (r) =>
        r.cleared_at == null &&
        core.isShowablePatientStatus(r.patient_status) &&
        (wanted === 'all' || r.status === wanted)
    );
    const totals = {
      count: visible.length,
      valueCents: visible.reduce((s, r) => s + r.value_cents, 0),
    };

    await auditTc(req, 'READ', 'tc_opportunity', null, { office });
    res.json({
      success: true,
      opportunities: visible.slice(0, LIST_LIMIT).map(oppStore.toWire),
      totals,
      truncated: visible.length > LIST_LIMIT,
      sync: oppStore.syncToWire(result.sync),
    });
  })
);

// ── POST /:id/claim ─────────────────────────────────────────────────────────

router.post(
  '/:opportunityId/claim',
  h(async (req, res) => {
    const id = Uuid.safeParse(req.params.opportunityId);
    if (!id.success) return res.status(404).json({ success: false, error: 'opportunity not found', code: 'NOT_FOUND' });
    const input = parseBody(res, ClaimBody, req.body && typeof req.body === 'object' ? req.body : {});
    if (!input) return;

    const office = req.tcOffice;
    const actor = actorEmail(req);
    const now = new Date().toISOString();

    /** @type {{ kind: 'ok', caseId: string, attached: boolean } | { kind: 'refuse', status: number, code: string, error: string, extra?: object }} */
    const outcome = await withTenantTx(req, async (client) => {
      const opp = await oppStore.getOne(client, office, id.data);
      if (!opp) return { kind: 'refuse', status: 404, code: 'NOT_FOUND', error: 'opportunity not found' };
      if (opp.claimed_case_id != null) {
        return {
          kind: 'refuse',
          status: 409,
          code: 'ALREADY_CLAIMED',
          error: 'This opportunity was already claimed',
          extra: { caseId: String(opp.claimed_case_id) },
        };
      }
      if (!core.ACTIONABLE_STATUSES.includes(opp.status)) {
        return { kind: 'refuse', status: 409, code: 'NOT_CLAIMABLE', error: `Opportunity is ${opp.status}` };
      }
      if (opp.cleared_at != null) {
        return {
          kind: 'refuse',
          status: 409,
          code: 'NO_LONGER_PLANNED',
          error: 'Open Dental no longer shows this treatment as planned and unscheduled',
        };
      }
      if (!opp.patient_name) {
        return {
          kind: 'refuse',
          status: 409,
          code: 'PATIENT_NAME_PENDING',
          error: "This patient's name has not been read from Open Dental yet — it arrives with the next nightly sync",
        };
      }

      const phases = input.phases || [];
      const mismatch = core.verifyClaimPhases(phases, opp.procedures);
      if (mismatch) {
        return {
          kind: 'refuse',
          status: 400,
          code: mismatch,
          error: 'The treatment plan does not match this opportunity',
        };
      }

      const openCaseId = await findOpenCase(client, office, opp.od_patient_id);
      const attached = openCaseId !== null;
      const caseId = openCaseId ?? randomUUID();
      const procCount = opp.procedures.length;

      if (!attached) {
        const valueCents = phases.length
          ? phases.reduce((s, p) => s + p.items.reduce((t, it) => t + it.feeCents, 0), 0)
          : opp.value_cents;
        const aggregate = TcCase.parse({
          ...CLAIM_CASE_DEFAULTS,
          caseId,
          officeId: office,
          patientName: opp.patient_name,
          phone: opp.patient_phone ?? null,
          odPatientId: opp.od_patient_id,
          urgency: core.caseUrgencyFromPhases(phases),
          assignedTc: actor,
          caseValueCents: valueCents,
          diagnosedDate: oppStore.isoDate(opp.planned_date),
          statusChangedAt: now,
          phases: phases.map((p) => ({
            phaseId: randomUUID(),
            position: p.position,
            name: p.name,
            description: p.description ?? '',
            items: p.items.map((it) => ({
              itemId: randomUUID(),
              legacyItemId: it.legacyItemId ?? null,
              odProcNum: it.odProcNum ?? null,
              position: it.position,
              tooth: it.tooth ?? '',
              procedureName: it.procedureName,
              patientDescription: it.patientDescription ?? '',
              feeCents: it.feeCents,
              insuranceEstCents: it.insuranceEstCents,
              patientPortionCents: it.patientPortionCents,
              urgency: it.urgency,
              timeEstimate: it.timeEstimate ?? '',
              benefits: it.benefits ?? [],
              risksOfDelay: it.risksOfDelay ?? [],
              expectedOutcome: it.expectedOutcome ?? '',
            })),
          })),
          events: [
            {
              eventId: randomUUID(),
              legacyId: null,
              ts: now,
              type: 'case_created',
              description: `Case created from an Open Dental opportunity — ${procCount} planned procedure${
                procCount === 1 ? '' : 's'
              }, ${money(opp.value_cents)}`,
              actor,
              detail: null,
            },
          ],
        });
        const rows = caseToRows(aggregate, randomUUID);
        await caseStore.insertCaseRow(client, rows.caseRow);
        for (const p of rows.phaseRows) await caseStore.insertPhaseRow(client, p);
        for (const it of rows.itemRows) await caseStore.insertItemRow(client, it);
        for (const e of rows.eventRows) await caseStore.insertEventRow(client, e);
      } else {
        // Attach: a timeline fact on the live case, nothing else. Its phases,
        // value and status are the TC's, and a nightly snapshot is not better
        // data than a case somebody is working.
        await caseStore.insertEventRow(client, {
          event_id: randomUUID(),
          case_id: caseId,
          office_id: office,
          ts: now,
          type: 'note_added',
          description: `Open Dental opportunity claimed and attached to this case — ${procCount} planned procedure${
            procCount === 1 ? '' : 's'
          }, ${money(opp.value_cents)} unscheduled`,
          actor,
          detail: null,
          legacy_id: null,
        });
      }

      // The arbiter. Guarded on the status we read and on no case yet, so two
      // concurrent claims cannot both land: the loser updates nothing and its
      // whole transaction — case included — rolls back.
      const upd = await client.query(
        `UPDATE tc_opportunities
            SET status = $4, claimed_case_id = $5, claimed_by = $6, claimed_at = now(), updated_at = now()
          WHERE office_id = $1 AND opportunity_id = $2 AND status = $3 AND claimed_case_id IS NULL`,
        [office, id.data, opp.status, attached ? 'existing_case' : 'claimed', caseId, actor]
      );
      if (!upd.rowCount) {
        const err = new Error('CLAIM_RACE');
        err.code = 'CLAIM_RACE';
        throw err;
      }
      return { kind: 'ok', caseId, attached };
    }).catch((err) => {
      if (err && err.code === 'CLAIM_RACE') {
        return { kind: 'refuse', status: 409, code: 'CLAIM_RACE', error: 'Someone else just acted on this opportunity' };
      }
      throw err;
    });

    if (outcome.kind === 'refuse') {
      return res.status(outcome.status).json({ success: false, error: outcome.error, code: outcome.code, ...(outcome.extra || {}) });
    }

    await auditTc(req, 'UPDATE', 'tc_opportunity', id.data, { office });
    await auditTc(req, outcome.attached ? 'UPDATE' : 'CREATE', 'tc_case', outcome.caseId, { office });

    const persisted = await tenantDb.withTenantDb(req, (pool) => oppStore.getOne(pool, office, id.data));
    res.json({
      success: true,
      caseId: outcome.caseId,
      url: `/tc/cases/${outcome.caseId}`,
      attached: outcome.attached,
      opportunity: persisted ? oppStore.toWire(persisted) : null,
    });
  })
);

// ── POST /:id/dismiss ───────────────────────────────────────────────────────

router.post(
  '/:opportunityId/dismiss',
  h(async (req, res) => {
    const id = Uuid.safeParse(req.params.opportunityId);
    if (!id.success) return res.status(404).json({ success: false, error: 'opportunity not found', code: 'NOT_FOUND' });
    const input = parseBody(res, DismissBody, req.body);
    if (!input) return;
    const office = req.tcOffice;
    const actor = actorEmail(req);

    const updated = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `UPDATE tc_opportunities
            SET status = $4, dismissed_reason = $5, dismissed_by = $6, dismissed_at = now(), updated_at = now()
          WHERE office_id = $1 AND opportunity_id = $2 AND status = ANY($3) AND claimed_case_id IS NULL
          RETURNING opportunity_id`,
        [office, id.data, [...core.ACTIONABLE_STATUSES], 'dismissed', input.reason, actor]
      )
    );
    if (!updated.rows.length) {
      const existing = await tenantDb.withTenantDb(req, (pool) => oppStore.getOne(pool, office, id.data));
      if (!existing) return res.status(404).json({ success: false, error: 'opportunity not found', code: 'NOT_FOUND' });
      return conflict(res, 'NOT_DISMISSABLE', `Opportunity is ${existing.status}`);
    }

    await auditTc(req, 'UPDATE', 'tc_opportunity', id.data, { office });
    const persisted = await tenantDb.withTenantDb(req, (pool) => oppStore.getOne(pool, office, id.data));
    res.json({ success: true, opportunity: persisted ? oppStore.toWire(persisted) : null });
  })
);

module.exports = router;
