'use strict';

/**
 * tc_print_templates — reads and writes (CO-3).
 *
 * NO ROW IS THE SHIPPED DEFAULT: the registry's wording (shared/tc/
 * printTemplates.ts) with a letterhead prefilled from the office's existing
 * identity — Settings → Email identity's practice name and phone, else the app
 * settings, and the app setting's practice address. An office that never edits
 * prints from that. A row exists once somebody saves.
 *
 * Explicit columns, parameterized, office in every WHERE. No Open Dental, no
 * patient data: a template is wording and the practice's own letterhead.
 */

const contract = require('../../tc/contract.gen.cjs');
const acsEmail = require('../../config/acsEmail');
const emailIdentity = require('../../config/emailIdentity');
const { OFFICES } = require('../../config/officeAgents');

const COLS = [
  'office_id',
  'template_type',
  'heading',
  'letterhead_name',
  'letterhead_address',
  'letterhead_phone',
  'body',
  'signature_line',
  'logo_key',
  'logo_content_type',
  'updated_by',
  'updated_at',
];

/** Postgres's unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

function iso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * The office's own letterhead details, from config that already exists.
 * Re-reads the saved email identity first (a failed read keeps the last one).
 * @param {string} office
 * @returns {Promise<{ name: string, address: string, phone: string }>}
 */
async function prefillFor(office) {
  await emailIdentity.refreshFromDb().catch(() => undefined);
  const details = acsEmail.practiceDetailsFor(office);
  return {
    name: acsEmail.practiceNameFor(office) || (OFFICES[office] && OFFICES[office].officeName) || '',
    address: details.address || '',
    phone: details.phone || '',
  };
}

/** A row → the editable fields. */
function fieldsOf(row) {
  return {
    heading: row.heading ?? '',
    letterheadName: row.letterhead_name ?? '',
    letterheadAddress: row.letterhead_address ?? '',
    letterheadPhone: row.letterhead_phone ?? '',
    body: row.body ?? '',
    signatureLine: row.signature_line ?? '',
  };
}

/**
 * What one type prints as in this office: the saved row, or the shipped
 * default. Pure.
 */
function effective(type, row, prefill) {
  return row ? fieldsOf(row) : contract.defaultPrintTemplate(type, prefill);
}

/** The Settings page's view of one type. Pure. */
function stateOf(type, row, prefill) {
  return {
    type,
    label: contract.PRINT_TEMPLATE_TYPES[type].label,
    stored: Boolean(row),
    fields: effective(type, row, prefill),
    logo: { present: Boolean(row && row.logo_key), contentType: (row && row.logo_content_type) || null },
    updatedBy: (row && row.updated_by) || null,
    updatedAt: row ? iso(row.updated_at) : null,
  };
}

/** Every saved row for the office, by type. */
async function rowsFor(q, office) {
  const res = await q.query(`SELECT ${COLS.join(', ')} FROM tc_print_templates WHERE office_id = $1`, [office]);
  /** @type {Map<string, object>} */
  const byType = new Map();
  for (const r of res.rows) byType.set(r.template_type, r);
  return byType;
}

/** One saved row, or null. `lock` takes it FOR UPDATE (call inside a transaction). */
async function rowFor(q, office, type, { lock = false } = {}) {
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_print_templates WHERE office_id = $1 AND template_type = $2${lock ? ' FOR UPDATE' : ''}`,
    [office, type]
  );
  return res.rows[0] || null;
}

/**
 * Save the text of one template (call inside a transaction). Updates the
 * office's row, or inserts one — the logo, if any, is left as it is.
 * @returns {Promise<'created'|'updated'>}
 */
async function saveFields(q, { office, type, fields, actor }) {
  const existing = await rowFor(q, office, type, { lock: true });
  const values = [
    fields.heading,
    fields.letterheadName,
    fields.letterheadAddress,
    fields.letterheadPhone,
    fields.body,
    fields.signatureLine,
    actor,
  ];
  if (existing) {
    await q.query(
      `UPDATE tc_print_templates
          SET heading = $3, letterhead_name = $4, letterhead_address = $5, letterhead_phone = $6,
              body = $7, signature_line = $8, updated_by = $9, updated_at = now()
        WHERE office_id = $1 AND template_type = $2`,
      [office, type, ...values]
    );
    return 'updated';
  }
  await q.query(
    `INSERT INTO tc_print_templates (office_id, template_type, heading, letterhead_name, letterhead_address,
       letterhead_phone, body, signature_line, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [office, type, ...values]
  );
  return 'created';
}

/**
 * Point a template at a stored logo, or (null) at none (call inside a
 * transaction). A type with no saved row gets one with the shipped wording, so
 * the logo has somewhere to live. The blob a cleared logo pointed at is left
 * where it is.
 */
async function setLogo(q, { office, type, logoKey, contentType, actor, prefill }) {
  const existing = await rowFor(q, office, type, { lock: true });
  if (!existing) {
    const f = contract.defaultPrintTemplate(type, prefill);
    await q.query(
      `INSERT INTO tc_print_templates (office_id, template_type, heading, letterhead_name, letterhead_address,
         letterhead_phone, body, signature_line, logo_key, logo_content_type, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [office, type, f.heading, f.letterheadName, f.letterheadAddress, f.letterheadPhone, f.body, f.signatureLine, logoKey, contentType, actor]
    );
    return { prior: null };
  }
  await q.query(
    `UPDATE tc_print_templates SET logo_key = $3, logo_content_type = $4, updated_by = $5, updated_at = now()
      WHERE office_id = $1 AND template_type = $2`,
    [office, type, logoKey, contentType, actor]
  );
  return { prior: existing.logo_key || null };
}

module.exports = { COLS, PG_UNIQUE_VIOLATION, prefillFor, fieldsOf, effective, stateOf, rowsFor, rowFor, saveFields, setLogo };
