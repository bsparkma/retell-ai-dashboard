'use strict';

/**
 * /api/tc/communications — the outbound email LOG (tc_communications), plus the
 * render preview and the legacy direct-send route.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE SEND PATH (queue item 40)
 * ═════════════════════════════════════════════════════════════════════════════
 * POST /send is a THIN WRAPPER over the item-38 message pipeline. It writes a
 * tc_messages draft from ONE library template for ONE case, then calls
 * messaging.sendMessage, the SAME function POST /api/tc/messages/:id/send
 * calls (the approval click). Every gate (opt-out, the unsubscribe link, the
 * legacy nurture unsubscribe, the per-office kill switch and sender) is
 * therefore the same gate. After an attempt that reached the provider it also
 * writes one tc_communications row ('sent' or 'error'), so the log imported
 * from the legacy TC app keeps its continuity.
 *
 * It is still one human, one message: the body names one case and one
 * template, it is strict (no address, no list), and the address is assembled
 * from the case. The dashboard never calls it. The Messages tab uses the
 * two-step draft, review, Send path, which is the review-then-send rule
 * itself. The route exists for the legacy contract only.
 *
 * POST /render renders the shared block model to HTML server-side
 * (shared/tc/emailRender.ts, the one implementation): a stored email draft, or
 * a library template for a case. It never sends anything.
 *
 * POST /test-send stays FEATURE_DISABLED (501). Nothing in item 40 needs it,
 * and a "send this template to me" path would be a second send path.
 *
 * GET / ports the legacy /api/email/communications behavior (newest first,
 * limit 1..200 default 50, optional caseId filter); /template-usage ports the
 * legacy aggregation (counts sent+stubbed, excludes error and template-less
 * rows) as one GROUP BY instead of a JS scan.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const {
  contract,
  requireOffice,
  parseBody,
  h,
  auditTc,
  iso,
  featureDisabled,
  notFound,
  actorEmail,
  actorName,
} = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const messaging = require('../../services/messaging');
const { MessagingError } = require('../../services/messaging/errors');

const { z, TcCommunication, Uuid, RenderEmailBody, CommunicationSendBody } = contract;

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

// ── Rendering and the legacy send route (item 40) ───────────────────────────

/** h() plus the MessagingError mapping (same shape as routes/tc/messages.js). */
function m(fn) {
  return h(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof MessagingError) {
        return res.status(err.httpStatus).json({ success: false, error: err.message, code: err.code, ...err.extra });
      }
      throw err;
    }
  });
}

router.post(
  '/render',
  m(async (req, res) => {
    const body = parseBody(res, RenderEmailBody, req.body);
    if (!body) return;
    const email =
      'messageId' in body
        ? await messaging.renderMessage(req, req.tcOffice, body.messageId)
        : await messaging.renderTemplateForCase(req, req.tcOffice, body.caseId, body.templateId);
    res.json({ success: true, email });
  })
);

router.post('/test-send', featureDisabled('tc_email_send'));

/**
 * One tc_communications row for an attempt that reached the provider. Legacy
 * vocabulary: 'sent' (handed off, queued included) or 'error'.
 */
async function logCommunication(req, message, templateName) {
  const commId = randomUUID();
  const ok = message.status === 'sent' || message.status === 'queued';
  await tenantDb.withTenantDb(req, (pool) =>
    pool.query(
      `INSERT INTO tc_communications (comm_id, legacy_id, office_id, case_id, template_id, template_name,
         sender, sender_name, to_email, subject, status, provider_message_id, error, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        commId,
        null,
        req.tcOffice,
        message.caseId,
        message.templateId,
        templateName,
        actorEmail(req),
        actorName(req),
        message.toAddress,
        message.subject ?? '',
        ok ? 'sent' : 'error',
        message.providerMessageId,
        ok ? null : message.error,
        message.sentAt || new Date().toISOString(),
      ]
    )
  );
  await auditTc(req, 'CREATE', 'tc_communication', commId);
  return commId;
}

router.post(
  '/send',
  m(async (req, res) => {
    const body = parseBody(res, CommunicationSendBody, req.body);
    if (!body) return;

    const tpl = await tenantDb.withTenantDb(req, (pool) =>
      pool.query('SELECT template_id, name FROM tc_email_templates WHERE office_id = $1 AND template_id = $2', [
        req.tcOffice,
        body.templateId,
      ])
    );
    if (tpl.rows.length === 0) return notFound(res, 'template');
    const templateName = String(tpl.rows[0].name || '').slice(0, 200);

    // 1. The draft: the same function POST /api/tc/messages/draft calls.
    const draft = await messaging.draftMessage(req, req.tcOffice, {
      caseId: body.caseId,
      channel: 'email',
      emailTemplateId: body.templateId,
      ...(body.subject ? { subject: body.subject } : {}),
    });

    // 2. The send: the SAME function as POST /api/tc/messages/:id/send. A
    //    refusal before the provider (consent, kill switch, no sender) leaves
    //    the draft a draft, visible in the case's Messages tab, and writes no
    //    tc_communications row: nothing was attempted.
    try {
      const sent = await messaging.sendMessage(req, req.tcOffice, draft.messageId);
      const commId = await logCommunication(req, sent, templateName);
      return res.json({ success: true, message: sent, commId });
    } catch (err) {
      if (err instanceof MessagingError && err.code === 'SEND_FAILED' && err.extra && err.extra.message) {
        // The provider was tried and refused: that IS a logged communication.
        const commId = await logCommunication(req, err.extra.message, templateName);
        err.extra = { ...err.extra, commId };
      } else if (err instanceof MessagingError) {
        err.extra = { ...err.extra, draftMessageId: draft.messageId };
      }
      throw err;
    }
  })
);

module.exports = router;
