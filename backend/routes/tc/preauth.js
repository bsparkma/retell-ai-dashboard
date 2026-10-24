'use strict';

/**
 * /api/tc/preauth — insurance pre-authorization tracking (tc_preauth_cases).
 *
 * Port of the legacy /api/preauth CRUD (which validated nothing beyond an id —
 * every write now parses the strict contract). Status changes go through
 * POST /:id/status, which stamps submitted_date / decision_date server-side.
 * /api/preauth/bulk is gone — bulk ingest is the Slice 2 importer.
 *
 * POST /:id/start-case puts the pre-auth's patient on the pipeline:
 * attach-or-create a TC case from the ROW (never the request), and link it.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const { contract, requireOffice, actorEmail, parseBody, h, auditTc, iso, isoDate, num, notFound } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const caseStore = require('./caseStore');
const { findOpenCase } = require('./intakeFromCall');

const { z, TcPreauthCase, PreauthStatus, Uuid, TcCase, caseToRows, TcPreauthStartCaseRequest } = contract;

const router = express.Router();
router.use(requireOffice);

const COLS = [
  'preauth_id',
  'legacy_id',
  'office_id',
  'case_id',
  'patient_name',
  'phone',
  'email',
  'od_patient_id',
  'preauth_type',
  'description',
  'insurance_carrier',
  'status',
  'doctor_name',
  'submitted_date',
  'decision_date',
  'reference_number',
  'notes',
];

/** DB row → contract entity (validated — a corrupt row fails loudly). */
function toContract(r) {
  return TcPreauthCase.parse({
    preauthId: r.preauth_id,
    legacyId: r.legacy_id,
    officeId: r.office_id,
    caseId: r.case_id,
    patientName: r.patient_name,
    phone: r.phone,
    email: r.email,
    odPatientId: num(r.od_patient_id),
    preauthType: r.preauth_type,
    description: r.description,
    insuranceCarrier: r.insurance_carrier,
    status: r.status,
    doctorName: r.doctor_name,
    createdAt: iso(r.created_at),
    submittedDate: isoDate(r.submitted_date),
    decisionDate: isoDate(r.decision_date),
    referenceNumber: r.reference_number,
    notes: r.notes,
  });
}

const PreauthCreate = TcPreauthCase.omit({
  preauthId: true,
  legacyId: true,
  officeId: true,
  createdAt: true,
  status: true,
  submittedDate: true,
  decisionDate: true,
})
  .partial({
    caseId: true,
    phone: true,
    email: true,
    odPatientId: true,
    description: true,
    insuranceCarrier: true,
    doctorName: true,
    referenceNumber: true,
    notes: true,
  })
  .strict();

const PreauthPatch = TcPreauthCase.pick({
  patientName: true,
  phone: true,
  email: true,
  odPatientId: true,
  caseId: true,
  preauthType: true,
  description: true,
  insuranceCarrier: true,
  doctorName: true,
  referenceNumber: true,
  notes: true,
})
  .partial()
  .strict();

const PATCH_COLUMN = Object.freeze({
  patientName: 'patient_name',
  phone: 'phone',
  email: 'email',
  odPatientId: 'od_patient_id',
  caseId: 'case_id',
  preauthType: 'preauth_type',
  description: 'description',
  insuranceCarrier: 'insurance_carrier',
  doctorName: 'doctor_name',
  referenceNumber: 'reference_number',
  notes: 'notes',
});

const StatusChange = z.object({ status: PreauthStatus }).strict();

/** Statuses that stamp a decision date the first time they're reached. */
const DECISION_STATUSES = new Set(['approved', 'denied', 'expired']);

function parseId(res, raw) {
  const parsed = Uuid.safeParse(raw);
  if (!parsed.success) {
    notFound(res, 'preauth case');
    return null;
  }
  return parsed.data;
}

async function loadOne(q, office, preauthId) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')}, created_at FROM tc_preauth_cases
      WHERE office_id = $1 AND preauth_id = $2`,
    [office, preauthId]
  );
  return res.rows.length ? toContract(res.rows[0]) : null;
}

// ── GET / — list, optional status filter ────────────────────────────────────

const ListQuery = z.object({ office: z.string(), status: PreauthStatus.optional() }).strict();

router.get(
  '/',
  h(async (req, res) => {
    const query = parseBody(res, ListQuery, req.query);
    if (!query) return;

    const values = [req.tcOffice];
    let where = 'office_id = $1';
    if (query.status) {
      values.push(query.status);
      where += ` AND status = $${values.length}`;
    }

    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${COLS.join(', ')}, created_at FROM tc_preauth_cases
          WHERE ${where} ORDER BY created_at DESC LIMIT 500`,
        values
      )
    );

    await auditTc(req, 'READ', 'tc_preauth', null);
    res.json({ success: true, preauthCases: rows.rows.map(toContract) });
  })
);

// ── POST / — create (status always starts 'pending') ────────────────────────

router.post(
  '/',
  h(async (req, res) => {
    const input = parseBody(res, PreauthCreate, req.body);
    if (!input) return;

    const preauthId = randomUUID();
    const persisted = await withTenantTx(req, async (client) => {
      await client.query(
        `INSERT INTO tc_preauth_cases
            (${COLS.join(', ')})
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          preauthId,
          null,
          req.tcOffice,
          input.caseId ?? null,
          input.patientName,
          input.phone ?? null,
          input.email ?? null,
          input.odPatientId ?? null,
          input.preauthType,
          input.description ?? '',
          input.insuranceCarrier ?? '',
          'pending',
          input.doctorName ?? '',
          null,
          null,
          input.referenceNumber ?? '',
          input.notes ?? '',
        ]
      );
      return loadOne(client, req.tcOffice, preauthId);
    });

    await auditTc(req, 'CREATE', 'tc_preauth', preauthId);
    res.status(201).json({ success: true, preauthCase: persisted });
  })
);

// ── GET /:id ────────────────────────────────────────────────────────────────

router.get(
  '/:id',
  h(async (req, res) => {
    const preauthId = parseId(res, req.params.id);
    if (!preauthId) return;

    const found = await tenantDb.withTenantDb(req, (pool) => loadOne(pool, req.tcOffice, preauthId));
    if (!found) return notFound(res, 'preauth case');

    await auditTc(req, 'READ', 'tc_preauth', preauthId);
    res.json({ success: true, preauthCase: found });
  })
);

// ── PUT /:id — field patch (never status) ───────────────────────────────────

router.put(
  '/:id',
  h(async (req, res) => {
    const preauthId = parseId(res, req.params.id);
    if (!preauthId) return;

    const patch = parseBody(res, PreauthPatch, req.body);
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
    const values = [req.tcOffice, preauthId];
    for (const key of keys) {
      values.push(patch[key]);
      sets.push(`${PATCH_COLUMN[key]} = $${values.length}`);
    }
    sets.push('updated_at = now()');

    const persisted = await withTenantTx(req, async (client) => {
      const updated = await client.query(
        `UPDATE tc_preauth_cases SET ${sets.join(', ')}
          WHERE office_id = $1 AND preauth_id = $2 RETURNING preauth_id`,
        values
      );
      if (updated.rows.length === 0) return null;
      return loadOne(client, req.tcOffice, preauthId);
    });
    if (!persisted) return notFound(res, 'preauth case');

    await auditTc(req, 'UPDATE', 'tc_preauth', preauthId);
    res.json({ success: true, preauthCase: persisted });
  })
);

// ── POST /:id/status — transition with server-stamped dates ─────────────────

router.post(
  '/:id/status',
  h(async (req, res) => {
    const preauthId = parseId(res, req.params.id);
    if (!preauthId) return;

    const input = parseBody(res, StatusChange, req.body);
    if (!input) return;

    const persisted = await withTenantTx(req, async (client) => {
      const updated = await client.query(
        `UPDATE tc_preauth_cases
            SET status = $3,
                submitted_date = CASE WHEN $4 AND submitted_date IS NULL THEN CURRENT_DATE ELSE submitted_date END,
                decision_date = CASE WHEN $5 AND decision_date IS NULL THEN CURRENT_DATE ELSE decision_date END,
                updated_at = now()
          WHERE office_id = $1 AND preauth_id = $2
          RETURNING preauth_id`,
        [
          req.tcOffice,
          preauthId,
          input.status,
          input.status === 'submitted',
          DECISION_STATUSES.has(input.status),
        ]
      );
      if (updated.rows.length === 0) return null;
      return loadOne(client, req.tcOffice, preauthId);
    });
    if (!persisted) return notFound(res, 'preauth case');

    await auditTc(req, 'UPDATE', 'tc_preauth', preauthId);
    res.json({ success: true, preauthCase: persisted });
  })
);

// ── POST /:id/start-case — put this pre-auth's patient on the pipeline ──────
//
// ATTACH-OR-CREATE, the rule the voice handoff, the Opportunities claim and the
// checkout intake already share (intakeFromCall's `findOpenCase`): a patient
// with an OPEN case in this office gets the pre-auth ATTACHED to it — a
// timeline note, the case otherwise untouched — and never a second case.
// Otherwise a new pending_tc case is created, assigned to the caller, and it
// lands on the pipeline like any other.
//
// THE PATIENT IS NEVER FROM THE REQUEST. The body is the empty strict object;
// the office is `?office=`; PatNum, name, phone, email and doctor are read from
// the pre-auth row, office-scoped. A pre-auth with no Open Dental patient
// linked is refused: without a PatNum there is no way to find the patient's
// open case, and a guessed match is not a match.
//
// The pre-auth's case_id is the link, and the arbiter: it is written only
// where it is still NULL, so two clicks cannot both start a case — the loser's
// whole transaction (case included) rolls back and it is told which case won.
// Postgres-only: no Open Dental read or write, nothing sends.

const PREAUTH_CASE_DEFAULTS = Object.freeze({
  legacyId: null,
  patientAge: null,
  caseType: '',
  category: 'single_tooth',
  status: 'pending_tc',
  urgency: 'medium',
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
  // A PatNum in the practice's own chart: an existing patient.
  referralSource: 'existing_patient',
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

const PREAUTH_TYPE_WORDS = Object.freeze({ treatment: 'treatment', perio: 'perio', manual: 'manual' });

/** "a treatment pre-authorization (Delta Dental)" — no PHI beyond the carrier. */
function preauthWords(p) {
  const kind = PREAUTH_TYPE_WORDS[p.preauthType] || p.preauthType;
  return `a ${kind} pre-authorization${p.insuranceCarrier ? ` (${p.insuranceCarrier})` : ''}`;
}

function caseUrl(caseId) {
  return `/tc/cases/${caseId}`;
}

router.post(
  '/:id/start-case',
  h(async (req, res) => {
    const preauthId = parseId(res, req.params.id);
    if (!preauthId) return;
    const body = parseBody(res, TcPreauthStartCaseRequest, req.body && typeof req.body === 'object' ? req.body : {});
    if (!body) return;

    const office = req.tcOffice;
    const actor = actorEmail(req);
    const now = new Date().toISOString();

    /** @type {{ kind: 'ok', caseId: string, attached: boolean } | { kind: 'refuse', status: number, code: string, error: string, extra?: object }} */
    const outcome = await withTenantTx(req, async (client) => {
      const pa = await loadOne(client, office, preauthId);
      if (!pa) return { kind: 'refuse', status: 404, code: 'NOT_FOUND', error: 'preauth case not found' };
      if (pa.caseId) {
        return {
          kind: 'refuse',
          status: 409,
          code: 'PREAUTH_ALREADY_LINKED',
          error: 'This pre-auth is already linked to a case',
          extra: { caseId: pa.caseId, url: caseUrl(pa.caseId) },
        };
      }
      if (pa.odPatientId == null) {
        return {
          kind: 'refuse',
          status: 409,
          code: 'NO_OD_PATIENT',
          error: 'Link this pre-auth to an Open Dental patient first, so the case is for the right patient',
        };
      }

      const openCaseId = await findOpenCase(client, office, pa.odPatientId);
      const attached = openCaseId !== null;
      const caseId = openCaseId ?? randomUUID();

      if (!attached) {
        // The full aggregate through the contract — the path POST /cases uses —
        // so a case started here is indistinguishable from a hand-entered one.
        const aggregate = TcCase.parse({
          ...PREAUTH_CASE_DEFAULTS,
          caseId,
          officeId: office,
          patientName: pa.patientName,
          phone: pa.phone,
          email: pa.email,
          odPatientId: pa.odPatientId,
          doctorName: pa.doctorName,
          assignedTc: actor,
          statusChangedAt: now,
          events: [
            {
              eventId: randomUUID(),
              legacyId: null,
              ts: now,
              type: 'case_created',
              description: `Case started from ${preauthWords(pa)}`,
              actor,
              detail: null,
            },
          ],
        });
        const rows = caseToRows(aggregate, randomUUID);
        await caseStore.insertCaseRow(client, rows.caseRow);
        for (const e of rows.eventRows) await caseStore.insertEventRow(client, e);
      } else {
        // Attach: a timeline fact on the live case, nothing else.
        await caseStore.insertEventRow(client, {
          event_id: randomUUID(),
          case_id: caseId,
          office_id: office,
          ts: now,
          type: 'note_added',
          description: `Linked ${preauthWords(pa)} to this case`,
          actor,
          detail: null,
          legacy_id: null,
        });
      }

      // The arbiter: only while the pre-auth is still unlinked.
      const linked = await client.query(
        `UPDATE tc_preauth_cases SET case_id = $3, updated_at = now()
          WHERE office_id = $1 AND preauth_id = $2 AND case_id IS NULL`,
        [office, preauthId, caseId]
      );
      if (!linked.rowCount) {
        const err = new Error('START_CASE_RACE');
        err.code = 'START_CASE_RACE';
        throw err;
      }
      return { kind: 'ok', caseId, attached };
    }).catch(async (err) => {
      if (!err || err.code !== 'START_CASE_RACE') throw err;
      // Someone else linked it while ours was open; ours rolled back whole.
      const now2 = await tenantDb.withTenantDb(req, (pool) => loadOne(pool, office, preauthId));
      return {
        kind: 'refuse',
        status: 409,
        code: 'PREAUTH_ALREADY_LINKED',
        error: 'This pre-auth was just linked to a case by someone else',
        extra: now2 && now2.caseId ? { caseId: now2.caseId, url: caseUrl(now2.caseId) } : {},
      };
    });

    if (outcome.kind === 'refuse') {
      return res
        .status(outcome.status)
        .json({ success: false, error: outcome.error, code: outcome.code, ...(outcome.extra || {}) });
    }

    await auditTc(req, 'UPDATE', 'tc_preauth', preauthId, { office });
    await auditTc(req, outcome.attached ? 'UPDATE' : 'CREATE', 'tc_case', outcome.caseId, { office });

    const persisted = await tenantDb.withTenantDb(req, (pool) => loadOne(pool, office, preauthId));
    res.json({
      success: true,
      caseId: outcome.caseId,
      url: caseUrl(outcome.caseId),
      attached: outcome.attached,
      preauthCase: persisted,
    });
  })
);

// ── DELETE /:id ─────────────────────────────────────────────────────────────

router.delete(
  '/:id',
  h(async (req, res) => {
    const preauthId = parseId(res, req.params.id);
    if (!preauthId) return;

    const deleted = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        'DELETE FROM tc_preauth_cases WHERE office_id = $1 AND preauth_id = $2 RETURNING preauth_id',
        [req.tcOffice, preauthId]
      )
    );
    if (deleted.rows.length === 0) return notFound(res, 'preauth case');

    await auditTc(req, 'DELETE', 'tc_preauth', preauthId);
    res.json({ success: true });
  })
);

module.exports = router;
