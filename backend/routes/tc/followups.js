'use strict';

/**
 * /api/tc/followups — THE unified outreach queue (tc_followups).
 *
 * Unifies the legacy followUps[] / followUpSteps[] / nurtureTouchpoints[]
 * triplet (see docs/TC_SCHEMA.md §2) into one work-queue, discriminated by
 * `kind`. The workhorse is GET /due — one indexed query over
 * (office_id, status, due_date) joined to tc_cases for patient context, not
 * client-side assembly.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const { contract, requireOffice, actorEmail, parseBody, h, auditTc, notFound } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const store = require('./caseStore');

const { z, TcFollowup, FollowupKind, FollowupStatus, Uuid } = contract;

const router = express.Router();
router.use(requireOffice);

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

// Create: server owns id/status/completion; source is 'auto' | 'manual' only —
// 'legacy' is reserved for the Slice 2 importer.
const FollowupCreate = TcFollowup.omit({
  followupId: true,
  legacyId: true,
  status: true,
  completedAt: true,
  completedBy: true,
})
  .extend({
    caseId: Uuid,
    source: z.enum(['auto', 'manual']).default('manual'),
    outcomeNote: z.string().max(8000).default(''),
    patientResponded: z.boolean().nullable().default(null),
    nurtureType: TcFollowup.shape.nurtureType.default(null),
  })
  .strict()
  .refine((v) => v.kind === 'nurture' || v.nurtureType === null, {
    message: "nurtureType is only valid when kind is 'nurture'",
    path: ['nurtureType'],
  });

const CompleteInput = z
  .object({
    outcomeNote: z.string().max(8000).default(''),
    patientResponded: z.boolean().nullable().default(null),
  })
  .strict();

const RescheduleInput = z.object({ dueDate: IsoDate }).strict();

function parseId(res, raw) {
  const parsed = Uuid.safeParse(raw);
  if (!parsed.success) {
    notFound(res, 'followup');
    return null;
  }
  return parsed.data;
}

async function loadFollowup(q, office, followupId) {
  const res = await q.query(
    `SELECT ${store.FOLLOWUP_COLS.join(', ')} FROM tc_followups
      WHERE office_id = $1 AND followup_id = $2`,
    [office, followupId]
  );
  return res.rows.length ? store.normalizeFollowupRow(res.rows[0]) : null;
}

// ── GET /due — the TC's daily queue ─────────────────────────────────────────

const DueQuery = z
  .object({
    office: z.string(),
    date: IsoDate.optional(), // horizon; defaults to today (server date)
    assignee: z.string().max(200).optional(),
    kind: FollowupKind.optional(),
  })
  .strict();

router.get(
  '/due',
  h(async (req, res) => {
    const query = parseBody(res, DueQuery, req.query);
    if (!query) return;
    const horizon = query.date || new Date().toISOString().slice(0, 10);

    const values = [req.tcOffice, horizon];
    let extra = '';
    if (query.assignee) {
      values.push(query.assignee);
      extra += ` AND c.assigned_tc = $${values.length}`;
    }
    if (query.kind) {
      values.push(query.kind);
      extra += ` AND f.kind = $${values.length}`;
    }

    // One indexed pass over tc_followups_queue_idx: everything pending and due
    // (including overdue), with just enough case context to work the queue.
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${store.FOLLOWUP_COLS.map((c) => `f.${c}`).join(', ')},
                c.patient_name, c.phone AS case_phone, c.status AS case_status,
                c.assigned_tc, c.case_value_cents, c.urgency AS case_urgency
           FROM tc_followups f
           JOIN tc_cases c ON c.case_id = f.case_id AND c.office_id = f.office_id
          WHERE f.office_id = $1 AND f.status = 'pending' AND f.due_date <= $2${extra}
          ORDER BY f.due_date, c.urgency, c.patient_name
          LIMIT 500`,
        values
      )
    );

    await auditTc(req, 'READ', 'tc_followup', null);
    res.json({
      success: true,
      due: rows.rows.map((r) => ({
        ...store.normalizeFollowupRow(r),
        patient_name: r.patient_name,
        case_phone: r.case_phone,
        case_status: r.case_status,
        assigned_tc: r.assigned_tc,
        case_value_cents: r.case_value_cents == null ? null : Number(r.case_value_cents),
        case_urgency: r.case_urgency,
      })),
    });
  })
);

// ── GET / — list (by case / status / kind) ──────────────────────────────────

const ListQuery = z
  .object({
    office: z.string(),
    caseId: Uuid.optional(),
    status: FollowupStatus.optional(),
    kind: FollowupKind.optional(),
  })
  .strict();

router.get(
  '/',
  h(async (req, res) => {
    const query = parseBody(res, ListQuery, req.query);
    if (!query) return;

    const where = ['office_id = $1'];
    const values = [req.tcOffice];
    if (query.caseId) {
      values.push(query.caseId);
      where.push(`case_id = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }
    if (query.kind) {
      values.push(query.kind);
      where.push(`kind = $${values.length}`);
    }

    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${store.FOLLOWUP_COLS.join(', ')} FROM tc_followups
          WHERE ${where.join(' AND ')}
          ORDER BY due_date
          LIMIT 500`,
        values
      )
    );

    await auditTc(req, 'READ', 'tc_followup', null);
    res.json({ success: true, followups: rows.rows.map(store.normalizeFollowupRow) });
  })
);

// ── POST / — create a queue item ────────────────────────────────────────────

router.post(
  '/',
  h(async (req, res) => {
    const input = parseBody(res, FollowupCreate, req.body);
    if (!input) return;

    const followupId = randomUUID();
    const persisted = await withTenantTx(req, async (client) => {
      const header = await store.getCaseHeader(client, req.tcOffice, input.caseId);
      if (!header) return null;

      await store.insertFollowupRow(client, {
        followup_id: followupId,
        case_id: input.caseId,
        office_id: req.tcOffice,
        kind: input.kind,
        due_date: input.dueDate,
        channel: input.channel,
        status: 'pending',
        talking_point: input.talkingPoint,
        outcome_note: input.outcomeNote,
        completed_at: null,
        completed_by: null,
        source: input.source,
        patient_responded: input.patientResponded,
        nurture_type: input.nurtureType,
        legacy_id: null,
      });
      return loadFollowup(client, req.tcOffice, followupId);
    });
    if (!persisted) return notFound(res, 'case');

    await auditTc(req, 'CREATE', 'tc_followup', followupId);
    res.status(201).json({ success: true, followup: persisted });
  })
);

// ── POST /:id/complete | /:id/skip — one completion model for both kinds ────

function closeOut(finalStatus) {
  return h(async (req, res) => {
    const followupId = parseId(res, req.params.id);
    if (!followupId) return;

    const input = parseBody(res, CompleteInput, req.body || {});
    if (!input) return;

    const actor = actorEmail(req);
    const now = new Date().toISOString();

    const result = await withTenantTx(req, async (client) => {
      const updated = await client.query(
        `UPDATE tc_followups
            SET status = $3, outcome_note = $4, patient_responded = $5,
                completed_at = $6, completed_by = $7, updated_at = now()
          WHERE office_id = $1 AND followup_id = $2 AND status = 'pending'
          RETURNING case_id`,
        [req.tcOffice, followupId, finalStatus, input.outcomeNote, input.patientResponded, now, actor]
      );
      if (updated.rows.length === 0) return null;

      if (finalStatus === 'completed') {
        await store.insertEventRow(client, {
          event_id: randomUUID(),
          case_id: updated.rows[0].case_id,
          office_id: req.tcOffice,
          ts: now,
          type: 'follow_up_completed',
          description: input.outcomeNote ? `Follow-up completed: ${input.outcomeNote}` : 'Follow-up completed',
          actor,
          detail: null,
          legacy_id: null,
        });
      }
      return loadFollowup(client, req.tcOffice, followupId);
    });
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Pending follow-up not found (already completed/skipped, or wrong office)',
        code: 'NOT_FOUND',
      });
    }

    await auditTc(req, 'UPDATE', 'tc_followup', followupId);
    res.json({ success: true, followup: result });
  });
}

router.post('/:id/complete', closeOut('completed'));
router.post('/:id/skip', closeOut('skipped'));

// ── POST /:id/reschedule — move a pending item's due date ───────────────────

router.post(
  '/:id/reschedule',
  h(async (req, res) => {
    const followupId = parseId(res, req.params.id);
    if (!followupId) return;

    const input = parseBody(res, RescheduleInput, req.body);
    if (!input) return;

    const persisted = await withTenantTx(req, async (client) => {
      const updated = await client.query(
        `UPDATE tc_followups SET due_date = $3, updated_at = now()
          WHERE office_id = $1 AND followup_id = $2 AND status = 'pending'
          RETURNING followup_id`,
        [req.tcOffice, followupId, input.dueDate]
      );
      if (updated.rows.length === 0) return null;
      return loadFollowup(client, req.tcOffice, followupId);
    });
    if (!persisted) {
      return res.status(404).json({
        success: false,
        error: 'Pending follow-up not found (already completed/skipped, or wrong office)',
        code: 'NOT_FOUND',
      });
    }

    await auditTc(req, 'UPDATE', 'tc_followup', followupId);
    res.json({ success: true, followup: persisted });
  })
);

module.exports = router;
