'use strict';

/**
 * GET /api/rcm/claims?office=roland|valley[&status=&limit=&offset=]
 *
 * The office's claims, newest first, paginated. Minimal fields — enough for a
 * worklist row and for Slice 7 to grow from, and nothing more. Notably ABSENT:
 * raw_extracted_json (the full PHI extraction payload), subscriber_id,
 * group_number, patient_dob. A list endpoint has no use for them and shipping
 * them "just in case" widens the PHI surface for free.
 *
 * patient_name IS returned — a claims worklist that cannot say whose claim it
 * is has no product in it. That is what makes this a PHI path, which is why the
 * read is audited fail-closed.
 */

const express = require('express');

// Namespace import — see the note in summary.js.
const tenantDb = require('../../platform/tenantDb');
const { h, auditRcmRead, num, iso, isoDate } = require('./helpers');
const { CLAIM_STATUSES } = require('./summary');

const router = express.Router();

/** Page size ceiling. A caller asking for more gets DEFAULT_LIMIT, not a 400. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Columns this endpoint returns. Named explicitly — no SELECT * anywhere in
 * this repo, and here the list doubles as the PHI budget for the route.
 */
const COLUMNS = [
  'claim_id',
  'office_id',
  'claim_number',
  'check_number',
  'patient_name',
  'od_patient_id',
  'payer',
  'service_date',
  'received_date',
  'status',
  'payment_status',
  'insurance_type',
  'total_billed_cents',
  'total_paid_cents',
  'patient_balance_cents',
  'needs_review_reasons',
  'created_at',
].join(', ');

/**
 * Parse a positive-integer query param, falling back on anything unusable.
 * A garbage `?limit=banana` yields the default rather than a 400: pagination is
 * a display concern, and refusing to render a page over it helps nobody.
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} max
 */
function parseBound(raw, fallback, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

/** Map a DB row to the wire shape. camelCase out; cents stay integers. */
function toWire(row) {
  return {
    claimId: row.claim_id,
    officeId: row.office_id,
    claimNumber: row.claim_number,
    checkNumber: row.check_number || null,
    patientName: row.patient_name,
    odPatientId: row.od_patient_id == null ? null : num(row.od_patient_id),
    payer: row.payer,
    serviceDate: isoDate(row.service_date),
    receivedDate: isoDate(row.received_date),
    status: row.status,
    paymentStatus: row.payment_status,
    insuranceType: row.insurance_type,
    totalBilledCents: num(row.total_billed_cents),
    totalPaidCents: num(row.total_paid_cents),
    patientBalanceCents: num(row.patient_balance_cents),
    needsReviewReasons: Array.isArray(row.needs_review_reasons) ? row.needs_review_reasons : [],
    createdAt: iso(row.created_at),
  };
}

router.get(
  '/',
  h(async (req, res) => {
    const office = req.rcmOffice;
    const limit = parseBound(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
    const offset = parseBound(req.query.offset, 0, Number.MAX_SAFE_INTEGER);

    // An unknown status is dropped rather than passed through: it could not
    // match a row anyway (CHECK constraint), and validating it here keeps the
    // filter from becoming a way to probe the column.
    const status =
      typeof req.query.status === 'string' && CLAIM_STATUSES.includes(req.query.status)
        ? req.query.status
        : null;

    // office_id is ALWAYS $1 and always present — there is no code path through
    // this handler that omits it, which is what makes a cross-office read
    // structurally impossible rather than merely unlikely.
    const where = status
      ? 'office_id = $1 AND archived_at IS NULL AND status = $2'
      : 'office_id = $1 AND archived_at IS NULL';
    const params = status ? [office, status] : [office];

    const { rows, total } = await tenantDb.withTenantDb(req, async (pool) => {
      const [page, count] = await Promise.all([
        pool.query(
          `SELECT ${COLUMNS} FROM rcm_claims WHERE ${where} ` +
            `ORDER BY received_date DESC NULLS LAST, created_at DESC ` +
            `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*)::int AS n FROM rcm_claims WHERE ${where}`, params),
      ]);
      return { rows: page.rows, total: num(count.rows[0] && count.rows[0].n) };
    });

    // PHI leaves the building only after the trail is recorded (hard rule 5).
    await auditRcmRead(req, 'rcm_claim', { office });

    return res.json({
      success: true,
      office,
      claims: rows.map(toWire),
      total,
      limit,
      offset,
    });
  })
);

module.exports = router;
