'use strict';

/**
 * /api/tc/cases — the TC case aggregate (port of the legacy TC-app cases API).
 *
 * Deliberate deviations from the legacy surface (all reported in the Slice 3
 * PR):
 *  - Status changes go ONLY through POST /:caseId/status (legacy allowed a
 *    whole-case PUT to flip status silently) — the server owns the
 *    status_change event + status_changed_at stamp.
 *  - Children are managed by dedicated endpoints (phases tree replace,
 *    objections add/remove, events append) instead of legacy's
 *    whole-JSON-blob PUT; follow-ups live in ./followups.js.
 *  - POST /api/cases/bulk is gone — bulk ingest is the Slice 2 importer.
 *  - Acting identity is the SSO session user; the server writes timeline
 *    events itself (legacy trusted the client to send caseEvents[]).
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const {
  contract,
  requireOffice,
  actorEmail,
  parseBody,
  h,
  auditTc,
  iso,
  notFound,
} = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const store = require('./caseStore');

const { z, TcCase, TcCasePhase, TcCaseItem, TcObjection, ContactAttemptDetail, CaseStatus, LostReason, Uuid, caseToRows } = contract;

const router = express.Router();
router.use(requireOffice);

// ── Input schemas (derived from the contract — reject unknown keys) ─────────

const CHILD_KEYS = Object.freeze({
  phases: true,
  objections: true,
  followups: true,
  events: true,
  hygieneIntake: true,
});

/** Item create: server generates itemId; optional metadata defaults filled in code. */
const ItemCreate = TcCaseItem.omit({ itemId: true })
  .partial({
    legacyItemId: true,
    odProcNum: true,
    tooth: true,
    patientDescription: true,
    timeEstimate: true,
    benefits: true,
    risksOfDelay: true,
    expectedOutcome: true,
  })
  .strict();

const PhaseCreate = TcCasePhase.omit({ phaseId: true, items: true })
  .partial({ description: true })
  .extend({ items: z.array(ItemCreate).max(100).default([]) })
  .strict();

/**
 * Case create: the contract shape minus server-owned fields. Optional fields
 * default via CASE_CREATE_DEFAULTS so a minimal manual entry (name, category,
 * status, urgency) is a valid create.
 */
const CaseCreate = TcCase.omit({
  caseId: true,
  legacyId: true,
  officeId: true,
  statusChangedAt: true,
  ...CHILD_KEYS,
})
  .extend({ phases: z.array(PhaseCreate).max(20).default([]) })
  .strict();

const CASE_CREATE_DEFAULTS = Object.freeze({
  patientAge: null,
  phone: null,
  email: null,
  odPatientId: null,
  caseType: '',
  doctorName: '',
  diagnosingProvider: null,
  assignedTc: '',
  caseValueCents: 0,
  readinessScore: 0,
  financingStatus: '',
  preferredFinancingProvider: null,
  decisionMakers: '',
  financialSituation: [],
  keyMotivators: [],
  contactPreference: null,
  bestTimeToReach: '',
  notes: '',
  referralSource: null,
  lostReason: null,
  diagnosedDate: null,
  nurtureCadence: 'standard',
  inLongTailMode: false,
  nurtureEnrolledAt: null,
  nurturePhaseChangedAt: null,
  nurturePhase1DaysOverride: null,
  nurturePhase2DaysOverride: null,
  nurtureUnsubscribed: false,
});

/** Scalar patch — status/lostReason excluded (POST /:caseId/status owns them). */
const CaseScalarPatch = TcCase.pick({
  patientName: true,
  patientAge: true,
  phone: true,
  email: true,
  odPatientId: true,
  caseType: true,
  category: true,
  urgency: true,
  doctorName: true,
  diagnosingProvider: true,
  assignedTc: true,
  caseValueCents: true,
  readinessScore: true,
  financingStatus: true,
  preferredFinancingProvider: true,
  decisionMakers: true,
  financialSituation: true,
  keyMotivators: true,
  contactPreference: true,
  bestTimeToReach: true,
  notes: true,
  referralSource: true,
  diagnosedDate: true,
  nurtureCadence: true,
  inLongTailMode: true,
  nurturePhase1DaysOverride: true,
  nurturePhase2DaysOverride: true,
  nurtureUnsubscribed: true,
})
  .partial()
  .strict();

/** Contract camelCase field → tc_cases column, for the dynamic UPDATE. */
const PATCH_COLUMN = Object.freeze({
  patientName: 'patient_name',
  patientAge: 'patient_age',
  phone: 'phone',
  email: 'email',
  odPatientId: 'od_patient_id',
  caseType: 'case_type',
  category: 'category',
  urgency: 'urgency',
  doctorName: 'doctor_name',
  diagnosingProvider: 'diagnosing_provider',
  assignedTc: 'assigned_tc',
  caseValueCents: 'case_value_cents',
  readinessScore: 'readiness_score',
  financingStatus: 'financing_status',
  preferredFinancingProvider: 'preferred_financing_provider',
  decisionMakers: 'decision_makers',
  financialSituation: 'financial_situation',
  keyMotivators: 'key_motivators',
  contactPreference: 'contact_preference',
  bestTimeToReach: 'best_time_to_reach',
  notes: 'notes',
  referralSource: 'referral_source',
  diagnosedDate: 'diagnosed_date',
  nurtureCadence: 'nurture_cadence',
  inLongTailMode: 'in_long_tail_mode',
  nurturePhase1DaysOverride: 'nurture_phase1_days_override',
  nurturePhase2DaysOverride: 'nurture_phase2_days_override',
  nurtureUnsubscribed: 'nurture_unsubscribed',
});

const StatusChange = z
  .object({
    status: CaseStatus,
    lostReason: LostReason.nullable().default(null),
    note: z.string().max(8000).default(''),
  })
  .strict();

const ObjectionCreate = TcObjection.omit({ objectionId: true }).partial({ loggedAt: true }).strict();

const EventCreate = z
  .object({
    type: z.enum(['note_added', 'contact_attempt']),
    description: z.string().max(8000).default(''),
    detail: ContactAttemptDetail.nullable().default(null),
  })
  .strict();

/** Validate a path id as a UUID or 404 (an unparseable id can't match a row). */
function parseId(res, raw, what) {
  const parsed = Uuid.safeParse(raw);
  if (!parsed.success) {
    notFound(res, what);
    return null;
  }
  return parsed.data;
}

/** Normalized case row → contract-shaped scalar summary (list endpoint). */
function caseRowToSummary(row) {
  const r = store.normalizeCaseRow(row);
  return {
    caseId: r.case_id,
    legacyId: r.legacy_id,
    officeId: r.office_id,
    patientName: r.patient_name,
    patientAge: r.patient_age,
    phone: r.phone,
    email: r.email,
    odPatientId: r.od_patient_id,
    caseType: r.case_type,
    category: r.category,
    status: r.status,
    urgency: r.urgency,
    doctorName: r.doctor_name,
    diagnosingProvider: r.diagnosing_provider,
    assignedTc: r.assigned_tc,
    caseValueCents: r.case_value_cents,
    readinessScore: r.readiness_score,
    financingStatus: r.financing_status,
    preferredFinancingProvider: r.preferred_financing_provider,
    decisionMakers: r.decision_makers,
    financialSituation: r.financial_situation,
    keyMotivators: r.key_motivators,
    contactPreference: r.contact_preference,
    bestTimeToReach: r.best_time_to_reach,
    notes: r.notes,
    referralSource: r.referral_source,
    lostReason: r.lost_reason,
    diagnosedDate: r.diagnosed_date,
    statusChangedAt: r.status_changed_at,
    nurtureCadence: r.nurture_cadence,
    inLongTailMode: r.in_long_tail_mode,
    nurtureEnrolledAt: r.nurture_enrolled_at,
    nurturePhaseChangedAt: r.nurture_phase_changed_at,
    nurturePhase1DaysOverride: r.nurture_phase1_days_override,
    nurturePhase2DaysOverride: r.nurture_phase2_days_override,
    nurtureUnsubscribed: r.nurture_unsubscribed,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

// ── GET / — office-scoped case list (summaries, no children) ────────────────

const ListQuery = z
  .object({
    office: z.string(),
    status: CaseStatus.optional(),
    category: TcCase.shape.category.optional(),
    assignee: z.string().max(200).optional(),
  })
  .strict();

router.get(
  '/',
  h(async (req, res) => {
    const query = parseBody(res, ListQuery, req.query);
    if (!query) return;

    const where = ['office_id = $1'];
    const values = [req.tcOffice];
    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }
    if (query.category) {
      values.push(query.category);
      where.push(`category = $${values.length}`);
    }
    if (query.assignee) {
      values.push(query.assignee);
      where.push(`assigned_tc = $${values.length}`);
    }

    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${store.CASE_COLS.join(', ')}, created_at, updated_at
           FROM tc_cases
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT 500`,
        values
      )
    );

    await auditTc(req, 'READ', 'tc_case', null);
    res.json({ success: true, cases: rows.rows.map(caseRowToSummary) });
  })
);

// ── POST / — create a case (+ optional phases tree) ─────────────────────────

router.post(
  '/',
  h(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const input = parseBody(res, CaseCreate, { ...CASE_CREATE_DEFAULTS, ...body });
    if (!input) return;

    const actor = actorEmail(req);
    const now = new Date().toISOString();
    const { phases, ...scalars } = input;

    // Full aggregate through the contract — server ids, server timeline event.
    const aggregate = TcCase.parse({
      ...scalars,
      caseId: randomUUID(),
      legacyId: null,
      officeId: req.tcOffice,
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
      objections: [],
      followups: [],
      events: [
        {
          eventId: randomUUID(),
          legacyId: null,
          ts: now,
          type: 'case_created',
          description: 'Case created',
          actor,
          detail: null,
        },
      ],
      hygieneIntake: null,
    });

    const rows = caseToRows(aggregate, randomUUID);

    const persisted = await withTenantTx(req, async (client) => {
      await store.insertCaseRow(client, rows.caseRow);
      for (const p of rows.phaseRows) await store.insertPhaseRow(client, p);
      for (const it of rows.itemRows) await store.insertItemRow(client, it);
      for (const e of rows.eventRows) await store.insertEventRow(client, e);
      // Return what the DB persisted — never echo the input as if it were saved.
      return store.loadCaseAggregate(client, req.tcOffice, aggregate.caseId);
    });

    await auditTc(req, 'CREATE', 'tc_case', aggregate.caseId);
    res.status(201).json({ success: true, case: persisted });
  })
);

// ── GET /:caseId — full aggregate ───────────────────────────────────────────

router.get(
  '/:caseId',
  h(async (req, res) => {
    const caseId = parseId(res, req.params.caseId, 'case');
    if (!caseId) return;

    const aggregate = await tenantDb.withTenantDb(req, (pool) =>
      store.loadCaseAggregate(pool, req.tcOffice, caseId)
    );
    if (!aggregate) return notFound(res, 'case');

    await auditTc(req, 'READ', 'tc_case', caseId);
    res.json({ success: true, case: aggregate });
  })
);

// ── PUT /:caseId — scalar patch (never status) ──────────────────────────────

router.put(
  '/:caseId',
  h(async (req, res) => {
    const caseId = parseId(res, req.params.caseId, 'case');
    if (!caseId) return;

    const patch = parseBody(res, CaseScalarPatch, req.body);
    if (!patch) return;
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Patch must contain at least one field',
        code: 'EMPTY_PATCH',
      });
    }

    const sets = [];
    const values = [req.tcOffice, caseId];
    for (const key of keys) {
      values.push(patch[key]);
      sets.push(`${PATCH_COLUMN[key]} = $${values.length}`);
    }
    // Long-tail flips are nurture-phase changes — stamp the phase clock.
    if (Object.prototype.hasOwnProperty.call(patch, 'inLongTailMode')) {
      sets.push('nurture_phase_changed_at = now()');
    }
    sets.push('updated_at = now()');

    const aggregate = await withTenantTx(req, async (client) => {
      const updated = await client.query(
        `UPDATE tc_cases SET ${sets.join(', ')} WHERE office_id = $1 AND case_id = $2 RETURNING case_id`,
        values
      );
      if (updated.rows.length === 0) return null;
      return store.loadCaseAggregate(client, req.tcOffice, caseId);
    });
    if (!aggregate) return notFound(res, 'case');

    await auditTc(req, 'UPDATE', 'tc_case', caseId);
    res.json({ success: true, case: aggregate });
  })
);

// ── POST /:caseId/status — the ONLY status-transition path ──────────────────

router.post(
  '/:caseId/status',
  h(async (req, res) => {
    const caseId = parseId(res, req.params.caseId, 'case');
    if (!caseId) return;

    const input = parseBody(res, StatusChange, req.body);
    if (!input) return;
    if (input.status === 'lost' && !input.lostReason) {
      return res.status(400).json({
        success: false,
        error: "lostReason is required when status is 'lost'",
        code: 'LOST_REASON_REQUIRED',
      });
    }
    if (input.status !== 'lost' && input.lostReason) {
      return res.status(400).json({
        success: false,
        error: "lostReason is only valid when status is 'lost'",
        code: 'LOST_REASON_INVALID',
      });
    }

    const actor = actorEmail(req);
    const now = new Date().toISOString();

    const result = await withTenantTx(req, async (client) => {
      const header = await store.getCaseHeader(client, req.tcOffice, caseId);
      if (!header) return { missing: true };
      if (header.status === input.status) {
        return { unchanged: true, aggregate: await store.loadCaseAggregate(client, req.tcOffice, caseId) };
      }

      const enrollingInNurture = input.status === 'nurture' && !header.nurture_enrolled_at;
      await client.query(
        `UPDATE tc_cases
            SET status = $3,
                lost_reason = $4,
                status_changed_at = $5,
                nurture_enrolled_at = CASE WHEN $6 THEN $5::timestamptz ELSE nurture_enrolled_at END,
                updated_at = now()
          WHERE office_id = $1 AND case_id = $2`,
        [req.tcOffice, caseId, input.status, input.lostReason, now, enrollingInNurture]
      );

      await store.insertEventRow(client, {
        event_id: randomUUID(),
        case_id: caseId,
        office_id: req.tcOffice,
        ts: now,
        type: 'status_change',
        description: input.note
          ? `${header.status} → ${input.status}: ${input.note}`
          : `${header.status} → ${input.status}`,
        actor,
        detail: null,
        legacy_id: null,
      });
      if (enrollingInNurture) {
        await store.insertEventRow(client, {
          event_id: randomUUID(),
          case_id: caseId,
          office_id: req.tcOffice,
          ts: now,
          type: 'nurture_enrolled',
          description: 'Enrolled in nurture campaign',
          actor,
          detail: null,
          legacy_id: null,
        });
      }

      return { aggregate: await store.loadCaseAggregate(client, req.tcOffice, caseId) };
    });

    if (result.missing) return notFound(res, 'case');
    if (!result.unchanged) await auditTc(req, 'UPDATE', 'tc_case', caseId);
    res.json({ success: true, changed: !result.unchanged, case: result.aggregate });
  })
);

// ── DELETE /:caseId ─────────────────────────────────────────────────────────

router.delete(
  '/:caseId',
  h(async (req, res) => {
    const caseId = parseId(res, req.params.caseId, 'case');
    if (!caseId) return;

    const deleted = await tenantDb.withTenantDb(req, (pool) =>
      pool.query('DELETE FROM tc_cases WHERE office_id = $1 AND case_id = $2 RETURNING case_id', [
        req.tcOffice,
        caseId,
      ])
    );
    if (deleted.rows.length === 0) return notFound(res, 'case');

    await auditTc(req, 'DELETE', 'tc_case', caseId);
    res.json({ success: true });
  })
);

// ── PUT /:caseId/phases — atomic replace of the phases + items tree ─────────

const PhasesReplace = z.array(PhaseCreate).max(20);

router.put(
  '/:caseId/phases',
  h(async (req, res) => {
    const caseId = parseId(res, req.params.caseId, 'case');
    if (!caseId) return;

    const phases = parseBody(res, PhasesReplace, req.body);
    if (!phases) return;
    const positions = new Set(phases.map((p) => p.position));
    if (positions.size !== phases.length) {
      return res.status(400).json({
        success: false,
        error: 'Phase positions must be unique',
        code: 'DUPLICATE_PHASE_POSITION',
      });
    }

    const aggregate = await withTenantTx(req, async (client) => {
      const header = await store.getCaseHeader(client, req.tcOffice, caseId);
      if (!header) return null;

      await client.query('DELETE FROM tc_case_items WHERE office_id = $1 AND case_id = $2', [req.tcOffice, caseId]);
      await client.query('DELETE FROM tc_case_phases WHERE office_id = $1 AND case_id = $2', [req.tcOffice, caseId]);

      for (const p of phases) {
        const phaseId = randomUUID();
        await store.insertPhaseRow(client, {
          phase_id: phaseId,
          case_id: caseId,
          office_id: req.tcOffice,
          position: p.position,
          name: p.name,
          description: p.description ?? '',
        });
        for (const it of p.items) {
          await store.insertItemRow(client, {
            item_id: randomUUID(),
            phase_id: phaseId,
            case_id: caseId,
            office_id: req.tcOffice,
            position: it.position,
            legacy_item_id: it.legacyItemId ?? null,
            od_proc_num: it.odProcNum ?? null,
            tooth: it.tooth ?? '',
            procedure_name: it.procedureName,
            patient_description: it.patientDescription ?? '',
            fee_cents: it.feeCents,
            insurance_est_cents: it.insuranceEstCents,
            patient_portion_cents: it.patientPortionCents,
            urgency: it.urgency,
            time_estimate: it.timeEstimate ?? '',
            benefits: it.benefits ?? [],
            risks_of_delay: it.risksOfDelay ?? [],
            expected_outcome: it.expectedOutcome ?? '',
          });
        }
      }
      return store.loadCaseAggregate(client, req.tcOffice, caseId);
    });
    if (!aggregate) return notFound(res, 'case');

    await auditTc(req, 'UPDATE', 'tc_case', caseId);
    res.json({ success: true, case: aggregate });
  })
);

// ── Objections ──────────────────────────────────────────────────────────────

router.post(
  '/:caseId/objections',
  h(async (req, res) => {
    const caseId = parseId(res, req.params.caseId, 'case');
    if (!caseId) return;

    const input = parseBody(res, ObjectionCreate, req.body);
    if (!input) return;

    const actor = actorEmail(req);
    const now = new Date().toISOString();
    const objectionId = randomUUID();

    const persisted = await withTenantTx(req, async (client) => {
      const header = await store.getCaseHeader(client, req.tcOffice, caseId);
      if (!header) return null;

      await store.insertObjectionRow(client, {
        objection_id: objectionId,
        case_id: caseId,
        office_id: req.tcOffice,
        category: input.category,
        note: input.note,
        patient_words: input.patientWords,
        logged_at: input.loggedAt ?? now,
      });
      await store.insertEventRow(client, {
        event_id: randomUUID(),
        case_id: caseId,
        office_id: req.tcOffice,
        ts: now,
        type: 'objection_logged',
        description: `Objection logged: ${input.category}`,
        actor,
        detail: null,
        legacy_id: null,
      });

      const row = await client.query(
        `SELECT ${store.OBJECTION_COLS.join(', ')} FROM tc_case_objections
          WHERE office_id = $1 AND objection_id = $2`,
        [req.tcOffice, objectionId]
      );
      return row.rows[0];
    });
    if (!persisted) return notFound(res, 'case');

    await auditTc(req, 'CREATE', 'tc_objection', objectionId);
    res.status(201).json({ success: true, objection: store.normalizeObjectionRow(persisted) });
  })
);

router.delete(
  '/:caseId/objections/:objectionId',
  h(async (req, res) => {
    const caseId = parseId(res, req.params.caseId, 'case');
    if (!caseId) return;
    const objectionId = parseId(res, req.params.objectionId, 'objection');
    if (!objectionId) return;

    const deleted = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `DELETE FROM tc_case_objections
          WHERE office_id = $1 AND case_id = $2 AND objection_id = $3
          RETURNING objection_id`,
        [req.tcOffice, caseId, objectionId]
      )
    );
    if (deleted.rows.length === 0) return notFound(res, 'objection');

    await auditTc(req, 'DELETE', 'tc_objection', objectionId);
    res.json({ success: true });
  })
);

// ── Events (client-loggable timeline facts only) ────────────────────────────

router.post(
  '/:caseId/events',
  h(async (req, res) => {
    const caseId = parseId(res, req.params.caseId, 'case');
    if (!caseId) return;

    const input = parseBody(res, EventCreate, req.body);
    if (!input) return;
    if (input.type === 'contact_attempt' && !input.detail) {
      return res.status(400).json({
        success: false,
        error: 'contact_attempt events require detail { channel, outcome }',
        code: 'DETAIL_REQUIRED',
      });
    }
    if (input.type === 'note_added' && input.detail) {
      return res.status(400).json({
        success: false,
        error: 'note_added events must not carry detail',
        code: 'DETAIL_INVALID',
      });
    }

    const eventId = randomUUID();
    const persisted = await withTenantTx(req, async (client) => {
      const header = await store.getCaseHeader(client, req.tcOffice, caseId);
      if (!header) return null;

      await store.insertEventRow(client, {
        event_id: eventId,
        case_id: caseId,
        office_id: req.tcOffice,
        ts: new Date().toISOString(),
        type: input.type,
        description: input.description,
        actor: actorEmail(req),
        detail: input.detail,
        legacy_id: null,
      });
      const row = await client.query(
        `SELECT ${store.EVENT_COLS.join(', ')} FROM tc_case_events WHERE office_id = $1 AND event_id = $2`,
        [req.tcOffice, eventId]
      );
      return row.rows[0];
    });
    if (!persisted) return notFound(res, 'case');

    await auditTc(req, 'CREATE', 'tc_case_event', eventId);
    res.status(201).json({ success: true, event: store.normalizeEventRow(persisted) });
  })
);

module.exports = router;
