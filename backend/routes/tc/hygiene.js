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
 *
 * ITEM 49 — INTAKE KINDS AND THE SOURCE KEY. POST / takes a `kind`
 * (shared/tc/checkout.ts): `hygiene` and `ortho` create a case exactly as
 * before; `checkout` creates a tc_checkout_handoffs row and NO case. Every kind
 * may carry a `sourceKey`, and a key TC has already seen answers with what it
 * already made — a lost response plus a resend can no longer open a second
 * case. The unique index on (office_id, source_key) is the arbiter; the read
 * first is only the fast path.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const { contract, requireOffice, actorEmail, actorName, parseBody, h, auditTc, notFound, isoDate } = require('./helpers');
const { localDayKey } = require('../../services/localDayClock');
const { withTenantTx } = require('./tx');
const { requirePermission } = require('../../config/permissions');
const tenantDb = require('../../platform/tenantDb');
const registry = require('../../platform/registry');
const store = require('./caseStore');
const checkoutStore = require('./checkoutStore');
const tcCheckout = require('../../config/tcCheckout');

const {
  z,
  TcCase,
  TcHygieneIntake,
  Uuid,
  caseToRows,
  TcIntakeKind,
  TcIntakeSourceKey,
  TcCheckoutSubmit,
} = contract;

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
    // Item 49. Both optional, so a client that predates them still submits.
    kind: TcIntakeKind.exclude(['checkout']).optional(),
    sourceKey: TcIntakeSourceKey.optional(),
  })
  .strict();

/**
 * The case an earlier submit with this source key made, or null when the key
 * is new.
 */
async function replayIntake(req, sourceKey) {
  return tenantDb.withTenantDb(req, async (pool) => {
    const prior = await pool.query(
      'SELECT case_id FROM tc_hygiene_intakes WHERE office_id = $1 AND source_key = $2',
      [req.tcOffice, sourceKey]
    );
    if (prior.rows.length === 0) return null;
    return store.loadCaseAggregate(pool, req.tcOffice, prior.rows[0].case_id);
  });
}

/** How many times a FINAL checkout submit retries a lost revision swap. */
const CHECKOUT_CAS_ATTEMPTS = 5;

/**
 * kind: 'checkout' — store (or update) the handoff. NO case is created.
 *
 * Off for this office → 403 CHECKOUT_DISABLED, nothing stored. A repeat key
 * answers with the handoff it already made; a newer payload for the same key
 * replaces the snapshot (the visit Send supersedes the early alert), except
 * that a FINAL snapshot is never replaced by a non-final one.
 */
async function submitCheckout(req, res) {
  if (!(await tcCheckout.isEnabled(req.tcOffice))) {
    return res.status(403).json({
      success: false,
      error: 'The checkout handoff is not switched on for this office',
      code: 'CHECKOUT_DISABLED',
    });
  }
  const input = parseBody(res, TcCheckoutSubmit, req.body);
  if (!input) return undefined;

  const actor = actorEmail(req);
  const office = req.tcOffice;
  const incoming = {
    patient_name: input.patientName,
    provider: input.provider,
    provider_seen: input.providerSeen,
    operatory: input.operatory,
    payload: input.snapshot,
    is_final: input.final,
    updated_by: actor,
  };

  const outcome = await tenantDb.withTenantDb(req, async (pool) => {
    let existing = await checkoutStore.findBySourceKey(pool, office, input.sourceKey);
    if (!existing) {
      try {
        /*
         * A key TC has never seen. CO-5a: if the front desk already added
         * this patient BY HAND today, the visit's handoff merges onto that
         * card (CO-1's same-patient, same-day, same-office rule) instead of
         * opening a second one. Under the patient-day lock, so a click and a
         * handoff arriving together cannot each make a card.
         */
        const made = await withTenantTx(req, async (client) => {
          await checkoutStore.lockPatientDay(client, office, input.odPatientId, input.visitDate);
          const manual = await checkoutStore.findManualAwaitingHygiene(client, office, input.odPatientId, input.visitDate);
          if (manual) {
            const merged = await checkoutStore.mergeHygieneOntoManual(client, {
              office,
              handoffId: manual.handoff_id,
              expectRevision: Number(manual.revision),
              sourceKey: input.sourceKey,
              row: incoming,
            });
            if (!merged) throw new Error('the manual checkout card could not take the hygiene handoff');
            // PM ruling (CO-5a fix): an ANSWERED card the visit lands on goes
            // back to Waiting, its answer kept as history; the desk has new
            // work for this patient. Same transaction as the merge.
            const reopened = await checkoutStore.reopenAnswered(client, {
              office,
              handoffId: manual.handoff_id,
              row: manual,
              at: new Date().toISOString(),
            });
            if (checkoutStore.OUTCOMES.includes(manual.status) && !reopened) {
              throw new Error('the answered checkout card could not be reopened');
            }
            return reopened ? { action: 'merged', reopenedFrom: manual.status } : { action: 'merged', reopenedFrom: null };
          }
          await checkoutStore.insertHandoff(client, {
            ...incoming,
            handoff_id: randomUUID(),
            office_id: office,
            source_key: input.sourceKey,
            od_patient_id: input.odPatientId,
            visit_date: input.visitDate,
            revision: 1,
            submitted_by: actor,
            source: 'hygiene',
          });
          return { action: 'created', reopenedFrom: null };
        });
        return {
          action: made.action,
          reopenedFrom: made.reopenedFrom,
          row: await checkoutStore.findBySourceKey(pool, office, input.sourceKey),
        };
      } catch (err) {
        if (!err || err.code !== checkoutStore.PG_UNIQUE_VIOLATION) throw err;
        // Lost the race to a submit with the same key: the winner's row stands.
        existing = await checkoutStore.findBySourceKey(pool, office, input.sourceKey);
        if (!existing) throw err;
      }
    }

    // The same visit, the same patient — a key that came back carrying a
    // different PatNum is a bug upstream, and refusing beats re-pointing.
    if (Number(existing.od_patient_id) !== input.odPatientId) {
      return { action: 'mismatch', row: existing };
    }

    /*
     * Apply the snapshot, compare-and-swap on the revision. A LOST swap means
     * somebody else updated in between: a non-final submit may simply yield
     * (its snapshot is not the last word anyway), but a FINAL submit must end
     * up applied — answering it with the winner's older, non-final snapshot
     * would let the hygiene side report "final notes delivered" for notes TC
     * does not hold. So a final submit re-reads and tries again, a bounded
     * number of times, and is refused rather than replayed if it never lands.
     */
    for (let attempt = 0; attempt < CHECKOUT_CAS_ATTEMPTS; attempt += 1) {
      if (existing.is_final === true && !input.final) {
        return { action: 'replayed', row: existing };
      }
      const applied = await checkoutStore.updatePayload(pool, {
        office,
        handoffId: existing.handoff_id,
        expectRevision: Number(existing.revision),
        row: incoming,
      });
      const now = await checkoutStore.findBySourceKey(pool, office, input.sourceKey);
      if (applied) return { action: 'updated', row: now };
      if (!input.final) return { action: 'replayed', row: now };
      existing = now;
    }
    return { action: 'contended', row: existing };
  });

  if (outcome.action === 'contended') {
    return res.status(409).json({
      success: false,
      error: 'The checkout handoff kept changing while the final notes were being saved. Try again.',
      code: 'CHECKOUT_UPDATE_CONFLICT',
    });
  }

  if (outcome.action === 'mismatch') {
    return res.status(409).json({
      success: false,
      error: 'This checkout key already belongs to a different patient. Nothing was changed.',
      code: 'SOURCE_KEY_CONFLICT',
    });
  }
  if (outcome.action !== 'replayed') {
    await auditTc(
      req,
      outcome.action === 'created' ? 'CREATE' : 'UPDATE',
      'tc_checkout_handoff',
      String(outcome.row.handoff_id),
      outcome.action === 'merged' ? { office, sourceRef: 'checkout_manual_merge' } : { office }
    );
  }
  if (outcome.reopenedFrom) {
    // Its own event: the answer the reopen cleared, as the prior state.
    await auditTc(req, 'UPDATE', 'tc_checkout_handoff', String(outcome.row.handoff_id), {
      office,
      sourceRef: 'checkout_reopened_by_hygiene',
      priorState: outcome.reopenedFrom,
    });
  }
  return res.status(outcome.action === 'created' ? 201 : 200).json({
    success: true,
    kind: 'checkout',
    handoff: checkoutStore.toHandoff(outcome.row),
    replayed: outcome.action === 'replayed',
  });
}

router.post(
  '/',
  h(async (req, res) => {
    if (req.body && typeof req.body === 'object' && req.body.kind === 'checkout') {
      return submitCheckout(req, res);
    }
    const input = parseBody(res, IntakeSubmit, req.body);
    if (!input) return;

    // A declared kind must match what rides along: an ortho intake carries a
    // screening and a treatment intake does not.
    if (input.kind) {
      const hasScreening = input.orthoScreening !== undefined && input.orthoScreening !== null;
      if ((input.kind === 'ortho') !== hasScreening) {
        return res.status(400).json({
          success: false,
          error:
            input.kind === 'ortho'
              ? 'An ortho intake must carry its screening'
              : 'A treatment intake must not carry an ortho screening',
          code: 'INTAKE_KIND_MISMATCH',
        });
      }
    }

    // Replay: this key already made a case. Answer with it; create nothing.
    if (input.sourceKey) {
      const prior = await replayIntake(req, input.sourceKey);
      if (prior) return res.status(200).json({ success: true, case: prior, replayed: true });
    }

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
        // Item 33. Null for every intake that is not an ortho screening —
        // including the treatment handoff and TC's own intake form.
        orthoScreening: input.orthoScreening ?? null,
        // Hygiene Slice 2b. Null for every intake that carried none, which is
        // every intake before it and TC's own intake form.
        existingTx: input.existingTx ?? null,
        // Checkout v2. Null for every intake that carried nothing to collect.
        collectAtCheckout: input.collectAtCheckout ?? null,
        records: input.records ?? null,
      },
    });

    const rows = caseToRows(aggregate, randomUUID);
    let persisted;
    try {
      persisted = await withTenantTx(req, async (client) => {
        await store.insertCaseRow(client, rows.caseRow);
        for (const e of rows.eventRows) await store.insertEventRow(client, e);
        await store.insertIntakeRow(client, rows.hygieneIntakeRow);
        if (input.sourceKey) {
          // Inside the SAME transaction: a duplicate key raises 23505 here and
          // the whole case rolls back, so the loser of a race leaves nothing.
          await client.query(
            'UPDATE tc_hygiene_intakes SET source_key = $3 WHERE office_id = $1 AND case_id = $2',
            [req.tcOffice, caseId, input.sourceKey]
          );
        }
        return store.loadCaseAggregate(client, req.tcOffice, caseId);
      });
    } catch (err) {
      if (input.sourceKey && err && err.code === checkoutStore.PG_UNIQUE_VIOLATION) {
        const prior = await replayIntake(req, input.sourceKey);
        if (prior) return res.status(200).json({ success: true, case: prior, replayed: true });
      }
      throw err;
    }

    await auditTc(req, 'CREATE', 'tc_hygiene_intake', caseId);
    res.status(201).json({ success: true, case: persisted, replayed: false });
  })
);

// CO-2: GET /hygienists (the intake form's picker) and GET / (Submissions) were
// removed with the TC app's Hygiene pages, their only callers. The hygiene app
// replaces those screens; POST / (its handoff), /mine, /inbox and the claim
// stay exactly as they were.

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

/**
 * CO-1 (Beau, 2026-10-29): a hygiene handoff for a patient who has a SAME-DAY
 * checkout entry is not an Inbox item. Its content — the same visit's staged
 * treatment — is on the checkout card, where the front desk is already working
 * the patient. The case itself is untouched: it still exists, still shows on
 * the Pipeline, and is still the open case a checkout outcome attaches to
 * (findOpenCase). Only WHERE it surfaces changes. A dismissed or expired
 * checkout hands it back (checkoutStore.RELEASES_INBOX_STATUSES).
 *
 * "Same day" is the intake's visit date; an intake without one (TC's own form
 * may leave it blank) falls back to the office day it was submitted.
 */
function intakeDay(row) {
  const visit = isoDate(row.visit_date);
  if (visit) return visit;
  if (!row.submitted_at) return null;
  const tz = String(process.env.OFFICE_TIMEZONE || '').trim() || 'America/Chicago';
  return localDayKey(tz, new Date(row.submitted_at));
}

router.get(
  '/inbox',
  h(async (req, res) => {
    const joined = await tenantDb.withTenantDb(req, (pool) =>
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

    // CO-1: drop the intakes a same-day checkout entry holds (see intakeDay).
    const keyed = joined.rows.map((r) => ({
      od_patient_id: r.od_patient_id == null ? null : Number(r.od_patient_id),
      day: intakeDay(r),
    }));
    const handoffs = await tenantDb.withTenantDb(req, (pool) =>
      checkoutStore.listForPatientsOnDays(
        pool,
        req.tcOffice,
        [...new Set(keyed.map((k) => k.od_patient_id).filter((v) => v != null))],
        [...new Set(keyed.map((k) => k.day).filter((v) => v != null))]
      )
    );
    const claimed = checkoutStore.claimedBySameDayCheckout(keyed, handoffs);
    const rows = { rows: joined.rows.filter((_, i) => !claimed[i]) };

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
