'use strict';

/**
 * /api/tc/templates — email template CRUD (tc_email_templates).
 *
 * Port of the legacy /api/email/templates surface. blocks is the strict 8-type
 * block union (shared/tc/emailBlocks.ts) — validated on every write, stored as
 * jsonb. Seeded templates are delete-protected (409), exactly like legacy.
 * Rendering/sending is NOT here — Slice 7 (ACS).
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const { contract, requireOffice, parseBody, h, auditTc, iso, notFound } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');

const { z, TcEmailTemplate, EmailTemplateCategory, Uuid } = contract;

const router = express.Router();
router.use(requireOffice);

const COLS = ['template_id', 'legacy_id', 'office_id', 'name', 'category', 'subject', 'preheader', 'blocks', 'is_seed'];

/** DB row → contract entity (+ timestamps for the UI). */
function toContract(r) {
  const tpl = TcEmailTemplate.parse({
    templateId: r.template_id,
    legacyId: r.legacy_id,
    officeId: r.office_id,
    name: r.name,
    category: r.category,
    subject: r.subject,
    preheader: r.preheader,
    blocks: r.blocks,
    isSeed: r.is_seed,
  });
  return { ...tpl, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };
}

const TemplateCreate = TcEmailTemplate.omit({
  templateId: true,
  legacyId: true,
  officeId: true,
  isSeed: true,
})
  .partial({ preheader: true })
  .strict();

const TemplatePatch = TcEmailTemplate.pick({
  name: true,
  category: true,
  subject: true,
  preheader: true,
  blocks: true,
})
  .partial()
  .strict();

function parseId(res, raw) {
  const parsed = Uuid.safeParse(raw);
  if (!parsed.success) {
    notFound(res, 'template');
    return null;
  }
  return parsed.data;
}

async function loadOne(q, office, templateId) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')}, created_at, updated_at FROM tc_email_templates
      WHERE office_id = $1 AND template_id = $2`,
    [office, templateId]
  );
  return res.rows.length ? toContract(res.rows[0]) : null;
}

async function insertTemplate(q, row) {
  await q.query(
    `INSERT INTO tc_email_templates (${COLS.join(', ')})
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.template_id,
      row.legacy_id,
      row.office_id,
      row.name,
      row.category,
      row.subject,
      row.preheader,
      JSON.stringify(row.blocks),
      row.is_seed,
    ]
  );
}

// ── GET / — list (optionally by category) ───────────────────────────────────

const ListQuery = z.object({ office: z.string(), category: EmailTemplateCategory.optional() }).strict();

router.get(
  '/',
  h(async (req, res) => {
    const query = parseBody(res, ListQuery, req.query);
    if (!query) return;

    const values = [req.tcOffice];
    let where = 'office_id = $1';
    if (query.category) {
      values.push(query.category);
      where += ` AND category = $${values.length}`;
    }

    const rows = await tenantDb.withTenantDb(req, (pool) =>
      pool.query(
        `SELECT ${COLS.join(', ')}, created_at, updated_at FROM tc_email_templates
          WHERE ${where} ORDER BY name LIMIT 500`,
        values
      )
    );

    res.json({ success: true, templates: rows.rows.map(toContract) });
  })
);

// ── POST / — create (never a seed) ──────────────────────────────────────────

router.post(
  '/',
  h(async (req, res) => {
    const input = parseBody(res, TemplateCreate, req.body);
    if (!input) return;

    const templateId = randomUUID();
    const persisted = await withTenantTx(req, async (client) => {
      await insertTemplate(client, {
        template_id: templateId,
        legacy_id: null,
        office_id: req.tcOffice,
        name: input.name,
        category: input.category,
        subject: input.subject,
        preheader: input.preheader ?? '',
        blocks: input.blocks,
        is_seed: false,
      });
      return loadOne(client, req.tcOffice, templateId);
    });

    await auditTc(req, 'CREATE', 'tc_email_template', templateId);
    res.status(201).json({ success: true, template: persisted });
  })
);

// ── GET /:id ────────────────────────────────────────────────────────────────

router.get(
  '/:id',
  h(async (req, res) => {
    const templateId = parseId(res, req.params.id);
    if (!templateId) return;

    const found = await tenantDb.withTenantDb(req, (pool) => loadOne(pool, req.tcOffice, templateId));
    if (!found) return notFound(res, 'template');

    res.json({ success: true, template: found });
  })
);

// ── PUT /:id ────────────────────────────────────────────────────────────────

const PATCH_COLUMN = Object.freeze({
  name: 'name',
  category: 'category',
  subject: 'subject',
  preheader: 'preheader',
  blocks: 'blocks',
});

router.put(
  '/:id',
  h(async (req, res) => {
    const templateId = parseId(res, req.params.id);
    if (!templateId) return;

    const patch = parseBody(res, TemplatePatch, req.body);
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
    const values = [req.tcOffice, templateId];
    for (const key of keys) {
      values.push(key === 'blocks' ? JSON.stringify(patch[key]) : patch[key]);
      sets.push(`${PATCH_COLUMN[key]} = $${values.length}`);
    }
    sets.push('updated_at = now()');

    const persisted = await withTenantTx(req, async (client) => {
      const updated = await client.query(
        `UPDATE tc_email_templates SET ${sets.join(', ')}
          WHERE office_id = $1 AND template_id = $2 RETURNING template_id`,
        values
      );
      if (updated.rows.length === 0) return null;
      return loadOne(client, req.tcOffice, templateId);
    });
    if (!persisted) return notFound(res, 'template');

    await auditTc(req, 'UPDATE', 'tc_email_template', templateId);
    res.json({ success: true, template: persisted });
  })
);

// ── DELETE /:id — seeds are protected (legacy 409 behavior) ─────────────────

router.delete(
  '/:id',
  h(async (req, res) => {
    const templateId = parseId(res, req.params.id);
    if (!templateId) return;

    const result = await withTenantTx(req, async (client) => {
      const existing = await client.query(
        'SELECT is_seed FROM tc_email_templates WHERE office_id = $1 AND template_id = $2',
        [req.tcOffice, templateId]
      );
      if (existing.rows.length === 0) return { missing: true };
      if (existing.rows[0].is_seed) return { seed: true };

      await client.query('DELETE FROM tc_email_templates WHERE office_id = $1 AND template_id = $2', [
        req.tcOffice,
        templateId,
      ]);
      return {};
    });

    if (result.missing) return notFound(res, 'template');
    if (result.seed) {
      return res.status(409).json({
        success: false,
        error: 'Seeded templates cannot be deleted',
        code: 'SEED_TEMPLATE_PROTECTED',
      });
    }

    await auditTc(req, 'DELETE', 'tc_email_template', templateId);
    res.json({ success: true });
  })
);

// ── POST /:id/duplicate — "<name> (copy)", never a seed ─────────────────────

router.post(
  '/:id/duplicate',
  h(async (req, res) => {
    const templateId = parseId(res, req.params.id);
    if (!templateId) return;

    const copyId = randomUUID();
    const persisted = await withTenantTx(req, async (client) => {
      const src = await client.query(
        `SELECT ${COLS.join(', ')} FROM tc_email_templates WHERE office_id = $1 AND template_id = $2`,
        [req.tcOffice, templateId]
      );
      if (src.rows.length === 0) return null;

      const s = src.rows[0];
      await insertTemplate(client, {
        template_id: copyId,
        legacy_id: null,
        office_id: req.tcOffice,
        name: `${s.name} (copy)`.slice(0, 200),
        category: s.category,
        subject: s.subject,
        preheader: s.preheader,
        blocks: s.blocks,
        is_seed: false,
      });
      return loadOne(client, req.tcOffice, copyId);
    });
    if (!persisted) return notFound(res, 'template');

    await auditTc(req, 'CREATE', 'tc_email_template', copyId);
    res.status(201).json({ success: true, template: persisted });
  })
);

module.exports = router;
