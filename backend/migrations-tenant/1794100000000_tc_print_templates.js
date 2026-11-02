'use strict';

/**
 * Per-tenant data-plane: print templates (CO-3) — the school/work excuse and
 * the appointment card the front desk prints from the checkout workup.
 *
 * ONE NEW TABLE, tc_print_templates: at most one row per office and template
 * type. NO ROW IS THE SHIPPED DEFAULT — the wording lives in code
 * (shared/tc/printTemplates.ts) and the letterhead is prefilled from the
 * office's existing identity, so an office that never edits still prints. A
 * row exists once somebody saves.
 *
 *   template_type   a slug (CHECK on its SHAPE, not on a list): a third type is
 *                   an addition to the code's registry, not a migration
 *   heading, letterhead_name, letterhead_address, letterhead_phone,
 *   body, signature_line
 *                   the editable text, bounded here as in the contract
 *   logo_key        the logo's key in the print-assets blob container, or NULL
 *   logo_content_type  'image/png' | 'image/jpeg', set exactly when logo_key is
 *   updated_by, updated_at, created_at
 *
 * Nothing here is patient data: a template holds wording and the practice's
 * own letterhead. A printout itself is never stored (its disclosure is the
 * audit row).
 *
 * carein_app gets SELECT, INSERT, UPDATE — no DELETE: nothing removes a
 * template (an office goes back to the shipped wording by saving it).
 *
 * CHECKS, each two-valued, per RCM_POSTING §15.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
const TABLE = 'tc_print_templates';
exports.TABLE = TABLE;

const CHECKS = {
  tc_print_templates_office_check: "office_id IN ('roland', 'valley')",
  tc_print_templates_type_shape_check: "template_type ~ '^[a-z][a-z_]{0,39}$'",
  tc_print_templates_lengths_check:
    'length(heading) <= 120 AND length(letterhead_name) <= 120 AND length(letterhead_address) <= 300 ' +
    'AND length(letterhead_phone) <= 40 AND length(body) <= 4000 AND length(signature_line) <= 200',
  // `logo_content_type IS NOT NULL` is load-bearing: without it a NULL type
  // makes the IN (...) NULL, the whole CHECK NULL, and Postgres lets NULL pass.
  tc_print_templates_logo_check:
    '(logo_key IS NULL AND logo_content_type IS NULL) OR ' +
    "(logo_key IS NOT NULL AND logo_content_type IS NOT NULL AND logo_content_type IN ('image/png', 'image/jpeg'))",
};
exports.CHECKS = CHECKS;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    office_id: { type: 'text', notNull: true },
    template_type: { type: 'text', notNull: true },
    heading: { type: 'text', notNull: true, default: '' },
    letterhead_name: { type: 'text', notNull: true, default: '' },
    letterhead_address: { type: 'text', notNull: true, default: '' },
    letterhead_phone: { type: 'text', notNull: true, default: '' },
    body: { type: 'text', notNull: true },
    signature_line: { type: 'text', notNull: true, default: '' },
    logo_key: { type: 'text' },
    logo_content_type: { type: 'text' },
    updated_by: { type: 'text', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(TABLE, 'tc_print_templates_pkey', { primaryKey: ['office_id', 'template_type'] });
  for (const [name, check] of Object.entries(CHECKS)) {
    pgm.addConstraint(TABLE, name, { check });
  }

  // ── carein_app grant (tc_schema's mechanism; no DELETE) ──────────────────
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      EXECUTE 'REVOKE ALL ON TABLE ${TABLE} FROM PUBLIC';
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE ${TABLE} TO %I', r);
      ELSE
        RAISE NOTICE '${TABLE}: app role % absent; grant SKIPPED', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable(TABLE, { ifExists: true });
};
