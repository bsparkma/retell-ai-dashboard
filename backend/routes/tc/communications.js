'use strict';

/**
 * /api/tc/communications — outbound email log (tc_communications), read-only
 * in this slice.
 *
 * NO OUTBOUND EMAIL IN SLICE 3: /send, /test-send and /render exist but return
 * FEATURE_DISABLED (501) — the render engine + ACS sender land in Slice 7.
 * Rows in tc_communications come from the Slice 2 importer until then.
 *
 * GET / ports the legacy /api/email/communications behavior (newest first,
 * limit 1..200 default 50, optional caseId filter); /template-usage ports the
 * legacy aggregation (counts sent+stubbed, excludes error and template-less
 * rows) as one GROUP BY instead of a JS scan.
 */

const express = require('express');

const { contract, requireOffice, parseBody, h, auditTc, iso, featureDisabled, notFound } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');

const { z, TcCommunication, Uuid } = contract;

const router = express.Router();
router.use(requireOffice);

const COLS = [
  'comm_id',
  'legacy_id',
  'office_id',
  'case_id',
  'template_id',
  'template_name',
  'sender',
  'sender_name',
  'to_email',
  'subject',
  'status',
  'provider_message_id',
  'error',
  'sent_at',
];

/** DB row → contract entity. */
function toContract(r) {
  return TcCommunication.parse({
    commId: r.comm_id,
    legacyId: r.legacy_id,
    officeId: r.office_id,
    caseId: r.case_id,
    templateId: r.template_id,
    templateName: r.template_name,
    sender: r.sender,
    senderName: r.sender_name,
    toEmail: r.to_email,
    subject: r.subject,
    status: r.status,
    providerMessageId: r.provider_message_id,
    error: r.error,
    sentAt: iso(r.sent_at),
  });
}

// ── GET / — the log ─────────────────────────────────────────────────────────

const ListQuery = z
  .object({
    office: z.string(),
    caseId: Uuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

router.get(
  '/',
  h(async (req, res) => {
    const query = parseBody(res, ListQuery, req.query);
    if (!query) return;

    const values = [req.tcOffice];
    let where = 'office_id = $1';
    if (query.caseId) {
      values.push(query.caseId);
      where += ` AND case_id = $${values.length}`;
    }
    values.push(query.limit);

    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${COLS.join(', ')} FROM tc_communications
          WHERE ${where} ORDER BY sent_at DESC LIMIT $${values.length}`,
        values
      )
    );

    await auditTc(req, 'READ', 'tc_communication', null);
    res.json({ success: true, communications: rows.rows.map(toContract) });
  })
);

// ── GET /template-usage — per-template send counts ──────────────────────────

router.get(
  '/template-usage',
  h(async (req, res) => {
    // Legacy semantics: count sent + stubbed ("I clicked send and it didn't
    // fail"), exclude errors and rows with no template attribution.
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT template_id,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE sent_at >= now() - interval '30 days')::int AS last30days
           FROM tc_communications
          WHERE office_id = $1 AND template_id IS NOT NULL AND status != 'error'
          GROUP BY template_id`,
        [req.tcOffice]
      )
    );

    const usage = {};
    for (const r of rows.rows) {
      usage[r.template_id] = { total: r.total, last30Days: r.last30days };
    }
    res.json({ success: true, usage });
  })
);

// ── GET /:id — one log entry ────────────────────────────────────────────────

router.get(
  '/:id',
  h(async (req, res) => {
    const parsed = Uuid.safeParse(req.params.id);
    if (!parsed.success) return notFound(res, 'communication');

    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${COLS.join(', ')} FROM tc_communications WHERE office_id = $1 AND comm_id = $2`,
        [req.tcOffice, parsed.data]
      )
    );
    if (rows.rows.length === 0) return notFound(res, 'communication');

    await auditTc(req, 'READ', 'tc_communication', parsed.data);
    res.json({ success: true, communication: toContract(rows.rows[0]) });
  })
);

// ── Sending pipeline — Slice 7 (ACS). Endpoints exist, uniformly disabled. ──

router.post('/render', featureDisabled('tc_email_render'));
router.post('/test-send', featureDisabled('tc_email_send'));
router.post('/send', featureDisabled('tc_email_send'));

module.exports = router;
