'use strict';

/**
 * POST /api/tc/cases/from-call — the voice → TC handoff intake (TC half).
 *
 * A user in the voice dashboard clicks "Send to TC" on a call whose patient is
 * already resolved to an Open Dental PatNum. This endpoint turns that click into
 * TC data: it attaches the call to the patient's open case, or opens a new one,
 * and records the handoff on the case's Activity timeline. The voice half (the
 * button) is built separately against the same frozen request/response contract.
 *
 * Five laws this route implements (all five are contract, not preference):
 *
 *  1. IDEMPOTENT ON call_id. tc_case_events.source_call_id is UNIQUE per tenant
 *     where non-null. A repeat Send returns the case the first Send landed on,
 *     with the SAME `attached` value, and writes nothing — no second event, no
 *     second audit row (log-once; see the audit note below). The uniqueness is
 *     enforced by the index, not by the read that precedes the write, so two
 *     concurrent clicks cannot both create a case: the loser's INSERT raises
 *     23505 and is converted into a replay of the winner's result.
 *
 *  2. ATTACH-OR-CREATE. If (od_patient_id, office) already has a case in an OPEN
 *     status, the handoff attaches to the MOST RECENTLY ACTIVE one and the case
 *     is left otherwise untouched — scalars are never overwritten from the call
 *     snapshot, because a live case's patient record is better data than a
 *     caller-ID name. Otherwise a new case is created: status pending_tc,
 *     assigned to the acting user, diagnosing_provider null.
 *     The open/terminal partition is OPEN_CASE_STATUSES in the shared contract,
 *     where it is a compile-time-total partition of CaseStatus.
 *
 *  3. SNAPSHOT, NOT REFERENCE. patient_name / patient_phone land on the case,
 *     and call_summary / call_url / call_id land on a typed `voice_handoff`
 *     event. The voice module prunes call rows on its own schedule; nothing here
 *     dereferences one, and call_url is stored knowing it may 404 later.
 *
 *  4. OFFICE LAW. `office` is read from the BODY (the frozen contract puts it
 *     there) and validated against the same frozen keys the sibling routes use —
 *     anything else is a 400. This is the one /api/tc route that does NOT use
 *     helpers.requireOffice, and that is deliberate: there is no office picker in
 *     this flow, the office is a property of the call being handed off. The
 *     security property is unchanged, because requireOffice only ever validated
 *     membership in the frozen list (no route grants per-office authorization),
 *     and every statement below is still office_id-scoped. Valley handoffs create
 *     cases normally — TC cases are TC-internal data, and the separate "OD not
 *     connected" gating covers the Open Dental affordances on them.
 *
 *  5. AUDIT + CONFIRMED WRITE. One audit row on create AND on attach, stamped
 *     with the acting user, the office, and the source call id (audit_log
 *     .source_ref). The response is sent only after COMMIT and carries the
 *     persisted ids — never the input echoed back.
 *
 * NOT here: any write to the voice module, any Open Dental write, any money
 * field. This flow touches neither.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const { contract, actorEmail, parseBody, h, auditTc, OFFICES } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const store = require('./caseStore');

const { z, TcCase, OfficeId, OPEN_CASE_STATUSES, caseToRows } = contract;

const router = express.Router();

// The frozen office keys must be the SAME list the tc_* CHECK constraints use;
// helpers.OFFICES and the contract's OfficeId are two spellings of it, and a
// silent divergence would let a row through that the database then rejects.
if (OFFICES.join(',') !== OfficeId.options.join(',')) {
  throw new Error('[tc/from-call] OFFICES and contract OfficeId disagree — frozen office keys drifted');
}

/** Postgres unique_violation. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * The frozen request contract. snake_case (the voice track's spelling), strict —
 * an unknown key is a 400, so a future field cannot be silently dropped on the
 * floor while the caller believes it was stored.
 */
const FromCallBody = z
  .object({
    od_patient_id: z.number().int().positive(),
    office: OfficeId,
    call_id: z.string().min(1).max(200),
    // REQUIRED: TC must be able to name the case without an OD round-trip, so
    // the voice side supplies the name it already resolved.
    patient_name: z.string().min(1).max(200),
    patient_phone: z.string().max(200).optional(),
    call_summary: z.string().max(8000).nullable().optional(),
    call_url: z.string().max(500).optional(),
  })
  .strict();

/**
 * Scalars for a case opened by a handoff. Matches the manual New Case dialog's
 * own defaults (single_tooth / pending_tc / medium) — a call has no diagnosis
 * yet, and these are the app's existing "new, unclassified" starting point
 * rather than a claim invented here. referralSource is the one field the call
 * genuinely establishes.
 */
const HANDOFF_CASE_DEFAULTS = Object.freeze({
  legacyId: null,
  patientAge: null,
  email: null,
  caseType: '',
  category: 'single_tooth',
  status: 'pending_tc',
  urgency: 'medium',
  doctorName: '',
  diagnosingProvider: null,
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
  referralSource: 'carein_call',
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

/** The SPA route for a case — the frozen response's `url`. */
function caseUrl(caseId) {
  return `/tc/cases/${caseId}`;
}

/**
 * Find the handoff already recorded for this call, if any.
 * Not office-scoped by design: source_call_id is unique across the tenant, so a
 * hit IS the answer, and scoping by the request's office would hide a
 * cross-office replay instead of returning the case it actually landed on.
 * @param {{ query: Function }} q
 * @param {string} callId
 * @returns {Promise<{ caseId: string, attached: boolean } | null>}
 */
async function findExistingHandoff(q, callId) {
  const res = await q.query(
    `SELECT case_id, detail FROM tc_case_events
      WHERE source_call_id = $1
      LIMIT 1`,
    [callId]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  const detail = row.detail && typeof row.detail === 'object' ? row.detail : null;
  return {
    caseId: row.case_id,
    // The original outcome is stored on the event precisely so a replay can
    // report it truthfully instead of re-deciding it against today's statuses.
    attached: Boolean(detail && detail.attached),
  };
}

/**
 * The patient's most recently active OPEN case in this office, or null.
 *
 * "Most recently active" is tc_cases.updated_at — every write to the aggregate's
 * header bumps it. created_at and case_id break ties so the choice is
 * deterministic under identical timestamps (which the same-millisecond import of
 * a legacy patient can produce).
 * @param {{ query: Function }} q
 */
async function findOpenCase(q, office, odPatientId) {
  const res = await q.query(
    `SELECT case_id FROM tc_cases
      WHERE office_id = $1 AND od_patient_id = $2 AND status = ANY($3)
      ORDER BY updated_at DESC, created_at DESC, case_id DESC
      LIMIT 1`,
    [office, odPatientId, [...OPEN_CASE_STATUSES]]
  );
  return res.rows.length ? res.rows[0].case_id : null;
}

router.post(
  '/',
  h(async (req, res) => {
    const input = parseBody(res, FromCallBody, req.body);
    if (!input) return;

    const office = input.office;
    const actor = actorEmail(req);
    const now = new Date().toISOString();

    // Replay before doing any work — the common repeat-click path costs one
    // indexed read and writes nothing.
    const replay = await tenantDb.withTenantDb(req, (pool) => findExistingHandoff(pool, input.call_id));
    if (replay) {
      return res.json({
        success: true,
        case_id: replay.caseId,
        url: caseUrl(replay.caseId),
        attached: replay.attached,
      });
    }

    /** @returns {Promise<{ caseId: string, attached: boolean }>} */
    const runHandoff = () =>
      withTenantTx(req, async (client) => {
        const openCaseId = await findOpenCase(client, office, input.od_patient_id);
        const attached = openCaseId !== null;
        const caseId = openCaseId ?? randomUUID();

        if (!attached) {
          // Full aggregate through the contract — the same path POST /cases uses,
          // so a handoff-created case is indistinguishable from a hand-entered one.
          const aggregate = TcCase.parse({
            ...HANDOFF_CASE_DEFAULTS,
            caseId,
            officeId: office,
            patientName: input.patient_name,
            phone: input.patient_phone ?? null,
            odPatientId: input.od_patient_id,
            assignedTc: actor,
            statusChangedAt: now,
            events: [
              {
                eventId: randomUUID(),
                legacyId: null,
                ts: now,
                type: 'case_created',
                description: 'Case created from a CareIN call',
                actor,
                detail: null,
                sourceCallId: null,
              },
            ],
          });
          const rows = caseToRows(aggregate, randomUUID);
          await store.insertCaseRow(client, rows.caseRow);
          for (const e of rows.eventRows) await store.insertEventRow(client, e);
        }

        // The durable artifact, on both paths. Its INSERT is what the unique
        // index guards, so it is also the concurrency arbiter.
        await store.insertEventRow(client, {
          event_id: randomUUID(),
          case_id: caseId,
          office_id: office,
          ts: now,
          type: 'voice_handoff',
          description: attached
            ? 'Sent to TC from a CareIN call — attached to this case'
            : 'Sent to TC from a CareIN call — new case',
          actor,
          detail: {
            callUrl: input.call_url ?? null,
            callSummary: input.call_summary ?? null,
            attached,
          },
          legacy_id: null,
          source_call_id: input.call_id,
        });

        return { caseId, attached };
      });

    let result;
    try {
      result = await runHandoff();
    } catch (err) {
      if (!err || err.code !== PG_UNIQUE_VIOLATION) throw err;
      // Lost a race on the same call_id: the winner's transaction committed
      // while ours was open, and ours rolled back whole (case row included).
      // Report the winner rather than 500-ing on a click that did work.
      const winner = await tenantDb.withTenantDb(req, (pool) =>
        findExistingHandoff(pool, input.call_id)
      );
      if (!winner) throw err;
      return res.json({
        success: true,
        case_id: winner.caseId,
        url: caseUrl(winner.caseId),
        attached: winner.attached,
      });
    }

    // Committed — now the trail, then the response. Both outcomes audit; the
    // action verb distinguishes them and source_ref ties the row to the call.
    await auditTc(req, result.attached ? 'UPDATE' : 'CREATE', 'tc_case', result.caseId, {
      office,
      sourceRef: input.call_id,
    });

    res.json({
      success: true,
      case_id: result.caseId,
      url: caseUrl(result.caseId),
      attached: result.attached,
    });
  })
);

module.exports = router;
