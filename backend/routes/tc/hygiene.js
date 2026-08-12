'use strict';

/**
 * /api/tc/hygiene-intakes — the hygiene → TC handoff (tc_hygiene_intakes).
 *
 * The schema binds every intake to a case (case_id NOT NULL), so submitting an
 * intake CREATES the case in one transaction: status 'hygiene_review', with
 * diagnosing_provider captured at entry (PR #23 review item). The TC inbox is
 * the set of hygiene_review cases; claiming one assigns it to the calling TC
 * and moves it to 'pending_tc'.
 *
 * Identity: submitted_by / assigned_tc are stamped from the SSO session —
 * hygienists and TCs never self-report who they are.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const { contract, requireOffice, actorEmail, actorName, parseBody, h, auditTc, notFound } = require('./helpers');
const { withTenantTx } = require('./tx');
const { requirePermission } = require('../../config/permissions');
const tenantDb = require('../../platform/tenantDb');
const registry = require('../../platform/registry');
const store = require('./caseStore');

const { z, TcCase, TcHygieneIntake, Uuid, caseToRows } = contract;

const router = express.Router();
router.use(requireOffice);

/**
 * Submit = clinical intake fields (contract, minus server-stamped identity)
 * + the patient/case-entry fields needed to open the case shell.
 */
const IntakeSubmit = TcHygieneIntake.omit({
  submittedBy: true,
  submittedByName: true,
  submittedAt: true,
})
  // hygienistName IS client-supplied — that is the point of it (Roles PR B).
  // It is clinical attribution the person chooses, not identity: the server
  // still stamps submittedBy/submittedByName from the session, so a bad value
  // here can misattribute a visit but can never misrepresent who was signed in.
  .partial({ hygienistName: true })
  .partial({
    operatory: true,
    visitDate: true,
    providerSeen: true,
    chiefConcern: true,
    areasOfConcern: true,
    suspectedTreatment: true,
    hygienistRecommendation: true,
    insuranceNoted: true,
  })
  .extend({
    // Case-entry fields.
    patientName: TcCase.shape.patientName,
    patientAge: TcCase.shape.patientAge.default(null),
    phone: TcCase.shape.phone.default(null),
    email: TcCase.shape.email.default(null),
    odPatientId: TcCase.shape.odPatientId.default(null),
    diagnosingProvider: z.string().min(1).max(200), // captured at entry — required
    category: TcCase.shape.category,
    urgency: TcCase.shape.urgency,
    caseType: TcCase.shape.caseType.default(''),
  })
  .strict();

router.post(
  '/',
  h(async (req, res) => {
    const input = parseBody(res, IntakeSubmit, req.body);
    if (!input) return;

    const submitter = actorEmail(req);
    const submitterName = actorName(req);
    const now = new Date().toISOString();
    const caseId = randomUUID();

    // Case shell + intake through the contract (fails loudly before any write).
    const aggregate = TcCase.parse({
      caseId,
      legacyId: null,
      officeId: req.tcOffice,
      patientName: input.patientName,
      patientAge: input.patientAge,
      phone: input.phone,
      email: input.email,
      odPatientId: input.odPatientId,
      caseType: input.caseType,
      category: input.category,
      status: 'hygiene_review',
      urgency: input.urgency,
      doctorName: input.diagnosingProvider,
      diagnosingProvider: input.diagnosingProvider,
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
      referralSource: 'hygiene',
      lostReason: null,
      diagnosedDate: null,
      statusChangedAt: now,
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
      events: [
        {
          eventId: randomUUID(),
          legacyId: null,
          ts: now,
          type: 'case_created',
          description: 'Case created from hygiene intake',
          actor: submitter,
          detail: null,
        },
      ],
      hygieneIntake: {
        submittedBy: submitter,
        submittedByName: submitterName,
        // The pick, trimmed; empty falls back to the signed-in user's display
        // name so a submission is never attributed to nobody. The fallback is
        // also applied in caseToRows, so both paths agree.
        hygienistName: (input.hygienistName || '').trim() || submitterName,
        submittedAt: now,
        operatory: input.operatory ?? '',
        visitDate: input.visitDate ?? null,
        providerSeen: input.providerSeen ?? '',
        chiefConcern: input.chiefConcern ?? '',
        perioStatus: input.perioStatus,
        recallType: input.recallType,
        radiographs: input.radiographs,
        intraoralPhotosTaken: input.intraoralPhotosTaken,
        areasOfConcern: input.areasOfConcern ?? '',
        suspectedTreatment: input.suspectedTreatment ?? '',
        hygienistRecommendation: input.hygienistRecommendation ?? '',
        insuranceNoted: input.insuranceNoted ?? '',
        patientInterestLevel: input.patientInterestLevel,
        flagUrgent: input.flagUrgent,
      },
    });

    const rows = caseToRows(aggregate, randomUUID);
    const persisted = await withTenantTx(req, async (client) => {
      await store.insertCaseRow(client, rows.caseRow);
      for (const e of rows.eventRows) await store.insertEventRow(client, e);
      await store.insertIntakeRow(client, rows.hygieneIntakeRow);
      return store.loadCaseAggregate(client, req.tcOffice, caseId);
    });

    await auditTc(req, 'CREATE', 'tc_hygiene_intake', caseId);
    res.status(201).json({ success: true, case: persisted });
  })
);

// ── GET /hygienists — the roster the intake form's picker offers ────────────

/**
 * The tenant's active hygiene-role users, for the intake form's "Hygienist"
 * picker (Roles PR B).
 *
 * MUST precede /:caseId-shaped routes? No — this router's only param route is
 * POST /:caseId/claim, a different method and depth. Ordering here is by
 * readability, not necessity.
 *
 * app_user carries no display-name column (Entra owns names and this platform
 * does not sync them), so the label is derived from the address' local part:
 * raegan@carein.ai → "Raegan". That is exactly right for this roster of first
 * names and merely unhelpful for an address it doesn't fit — which is why the
 * form also offers free text. The picker is a convenience, never a constraint.
 *
 * Gated tc.hygiene at the mount, so a hygienist can read it. It exposes staff
 * addresses within one's own practice and no patient data.
 */
router.get(
  '/hygienists',
  h(async (req, res) => {
    const rows = await registry.listTenantUsersByRole(req.tenant.id, 'hygiene');
    res.json({
      success: true,
      hygienists: rows.map((r) => ({ email: r.email, label: labelFromEmail(r.email) })),
    });
  })
);

/** "raegan@carein.ai" → "Raegan". Best effort; the form allows free text. */
function labelFromEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ── GET / — the office's submissions, optionally filtered by hygienist ──────

/**
 * The shared, filterable submissions view (Roles PR B).
 *
 * "My Submissions" used to be exactly `/mine`. With a shared temp account that
 * view answers the wrong question, so the page now lists the office's
 * submissions and filters by ATTRIBUTION. `/mine` is untouched below and stays
 * the session-scoped fast path — nobody loses their current view.
 *
 * `hygienists` comes back alongside the rows so the UI can build its filter
 * chips from what actually exists rather than from the roster (a hygienist who
 * has left still has submissions; a new hire has none yet).
 */
router.get(
  '/',
  h(async (req, res) => {
    const wanted = typeof req.query.hygienist === 'string' ? req.query.hygienist.trim() : '';

    const params = [req.tcOffice];
    let filter = '';
    if (wanted) {
      params.push(wanted);
      filter = `AND i.hygienist_name = $${params.length}`;
    }

    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${store.INTAKE_COLS.map((c) => `i.${c}`).join(', ')},
                c.patient_name, c.status AS case_status, c.od_patient_id
           FROM tc_hygiene_intakes i
           JOIN tc_cases c ON c.case_id = i.case_id AND c.office_id = i.office_id
          WHERE i.office_id = $1 ${filter}
          ORDER BY i.submitted_at DESC
          LIMIT 200`,
        params
      )
    );

    // The chip list is derived from the UNFILTERED set — otherwise selecting a
    // chip would erase every other chip and strand the user on one filter.
    const names = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT DISTINCT hygienist_name
           FROM tc_hygiene_intakes
          WHERE office_id = $1 AND hygienist_name <> ''
          ORDER BY hygienist_name`,
        [req.tcOffice]
      )
    );

    await auditTc(req, 'READ', 'tc_hygiene_intake', null);
    res.json({
      success: true,
      intakes: rows.rows.map((r) => ({
        ...store.normalizeIntakeRow(r),
        patient_name: r.patient_name,
        case_status: r.case_status,
        // The attached Open Dental patient, if any. Only meaningful together
        // with office_id (already on the row) — PatNum numbering restarts in
        // every OD database.
        od_patient_id: r.od_patient_id ?? null,
      })),
      hygienists: names.rows.map((r) => r.hygienist_name),
    });
  })
);

// ── GET /mine — intakes the calling user submitted ──────────────────────────

router.get(
  '/mine',
  h(async (req, res) => {
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${store.INTAKE_COLS.map((c) => `i.${c}`).join(', ')},
                c.patient_name, c.status AS case_status, c.od_patient_id
           FROM tc_hygiene_intakes i
           JOIN tc_cases c ON c.case_id = i.case_id AND c.office_id = i.office_id
          WHERE i.office_id = $1 AND i.submitted_by = $2
          ORDER BY i.submitted_at DESC
          LIMIT 200`,
        [req.tcOffice, actorEmail(req)]
      )
    );

    await auditTc(req, 'READ', 'tc_hygiene_intake', null);
    res.json({
      success: true,
      intakes: rows.rows.map((r) => ({
        ...store.normalizeIntakeRow(r),
        patient_name: r.patient_name,
        case_status: r.case_status,
        // The attached Open Dental patient, if any. Only meaningful together
        // with office_id (already on the row) — PatNum numbering restarts in
        // every OD database.
        od_patient_id: r.od_patient_id ?? null,
      })),
    });
  })
);

// ── GET /inbox — unclaimed hygiene_review cases, urgent first ───────────────

router.get(
  '/inbox',
  h(async (req, res) => {
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${store.INTAKE_COLS.map((c) => `i.${c}`).join(', ')},
                c.patient_name, c.patient_age, c.phone, c.category, c.urgency,
                c.diagnosing_provider, c.od_patient_id
           FROM tc_hygiene_intakes i
           JOIN tc_cases c ON c.case_id = i.case_id AND c.office_id = i.office_id
          WHERE i.office_id = $1 AND c.status = 'hygiene_review'
          ORDER BY i.flag_urgent DESC, i.submitted_at
          LIMIT 200`,
        [req.tcOffice]
      )
    );

    await auditTc(req, 'READ', 'tc_hygiene_intake', null);
    res.json({
      success: true,
      inbox: rows.rows.map((r) => ({
        ...store.normalizeIntakeRow(r),
        patient_name: r.patient_name,
        patient_age: r.patient_age,
        phone: r.phone,
        category: r.category,
        urgency: r.urgency,
        diagnosing_provider: r.diagnosing_provider,
        // Lets the TC see the patient is already linked, instead of looking
        // them up in Open Dental a second time before claiming.
        od_patient_id: r.od_patient_id ?? null,
      })),
    });
  })
);

// ── POST /:caseId/claim — TC takes the case out of the inbox ────────────────

// The one route in this router that is NOT part of the hygiene grant. Claiming
// assigns the caller as the case's TC and moves it to pending_tc — a TC action
// that happens to live on a Hygiene-nav page. A hygienist can watch the inbox;
// they cannot make themselves the coordinator on a case. tc.full narrows the
// mount's tc.hygiene (index.js).
router.post(
  '/:caseId/claim',
  requirePermission('tc.full'),
  h(async (req, res) => {
    const parsed = Uuid.safeParse(req.params.caseId);
    if (!parsed.success) return notFound(res, 'case');
    const caseId = parsed.data;

    const actor = actorEmail(req);
    const now = new Date().toISOString();

    const result = await withTenantTx(req, async (client) => {
      const updated = await client.query(
        `UPDATE tc_cases
            SET assigned_tc = $3, status = 'pending_tc', status_changed_at = $4, updated_at = now()
          WHERE office_id = $1 AND case_id = $2 AND status = 'hygiene_review'
          RETURNING case_id`,
        [req.tcOffice, caseId, actor, now]
      );
      if (updated.rows.length === 0) return null;

      await store.insertEventRow(client, {
        event_id: randomUUID(),
        case_id: caseId,
        office_id: req.tcOffice,
        ts: now,
        type: 'status_change',
        description: `hygiene_review → pending_tc (claimed)`,
        actor,
        detail: null,
        legacy_id: null,
      });
      return store.loadCaseAggregate(client, req.tcOffice, caseId);
    });
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Claimable case not found (not in hygiene_review, or wrong office)',
        code: 'NOT_FOUND',
      });
    }

    await auditTc(req, 'UPDATE', 'tc_case', caseId);
    res.json({ success: true, case: result });
  })
);

module.exports = router;
