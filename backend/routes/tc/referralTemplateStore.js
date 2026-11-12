'use strict';

/**
 * tc_referral_templates — every statement the referral-template feature owns
 * (migration 1794600000000). Office is in every WHERE; a caller passes the
 * server-derived office (requireOffice / the hygiene visit's), never a body's.
 *
 * Nothing here is patient data: a template is an office's own wording. No
 * Open Dental.
 */

const contract = require('../../tc/contract.gen.cjs');

const COLS = ['office_id', 'template_kind', 'body', 'updated_by', 'updated_at', 'created_at'];

/** ISO string for a pg timestamptz value (Date | string | null). */
function iso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** A row → the contract's ReferralTemplateState. */
function toState(kind, row) {
  return {
    kind,
    body: row ? String(row.body ?? '') : '',
    updatedBy: row ? row.updated_by ?? null : null,
    updatedAt: row ? iso(row.updated_at) : null,
  };
}

/**
 * Both kinds for one office, in registry order — a kind never saved reads as
 * blank (no prefill).
 *
 * @param {{ query: Function }} q
 * @param {string} office
 */
async function listTemplates(q, office) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_referral_templates WHERE office_id = $1`,
    [office]
  );
  const byKind = new Map(res.rows.map((r) => [String(r.template_kind), r]));
  return contract.REFERRAL_TEMPLATE_KINDS.map((kind) => toState(kind, byKind.get(kind) ?? null));
}

/**
 * Read one kind's row, or null.
 *
 * @param {{ query: Function }} q
 */
async function readTemplate(q, office, kind) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_referral_templates WHERE office_id = $1 AND template_kind = $2`,
    [office, kind]
  );
  return res.rows[0] ?? null;
}

/**
 * Store one kind's body (one atomic upsert, so two first saves racing end as
 * an update of each other, never a primary-key error). Answers the row AS
 * STORED and whether one existed before.
 *
 * @param {{ query: Function }} q
 * @returns {Promise<{ row: Record<string, unknown>, prior: 'default' | 'stored' }>}
 */
async function saveTemplate(q, { office, kind, body, actor }) {
  const before = await readTemplate(q, office, kind);
  const res = await q.query(
    `INSERT INTO tc_referral_templates (office_id, template_kind, body, updated_by)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (office_id, template_kind) DO UPDATE
       SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING ${COLS.join(', ')}`,
    [office, kind, body, actor]
  );
  return { row: res.rows[0], prior: before ? 'stored' : 'default' };
}

module.exports = { COLS, toState, listTemplates, readTemplate, saveTemplate };
