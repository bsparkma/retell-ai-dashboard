'use strict';

/**
 * /api/tc/preauth — insurance pre-authorization tracking (tc_preauth_cases).
 *
 * Port of the legacy /api/preauth CRUD (which validated nothing beyond an id —
 * every write now parses the strict contract). Status changes go through
 * POST /:id/status, which stamps submitted_date / decision_date server-side.
 * /api/preauth/bulk is gone — bulk ingest is the Slice 2 importer.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const { contract, requireOffice, parseBody, h, auditTc, iso, isoDate, num, notFound } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');

const { z, TcPreauthCase, PreauthStatus, Uuid } = contract;

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
