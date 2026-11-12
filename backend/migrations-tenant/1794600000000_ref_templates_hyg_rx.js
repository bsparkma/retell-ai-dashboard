'use strict';

/**
 * Per-tenant data-plane: two small, unrelated additions that ship together.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PART 1 — tc_referral_templates (per-office referral wording)
 * ═════════════════════════════════════════════════════════════════════════════
 * At most one row per office and template kind:
 *
 *   specialist_message    prefills "Notes for the specialist" (the referral's
 *                         narrative, the text that goes into the letter) when
 *                         a referral is created or edited
 *   correspondence_note   prefills the note in "Log correspondence"
 *
 *   body                  the wording, ≤ 2000 characters. '' (or no row) means
 *                         "no prefill". It may carry placeholders from the
 *                         CLOSED menu in shared/tc/referralTemplates.ts — the
 *                         server refuses an unknown one at save. Placeholders
 *                         are filled in the BROWSER from values already on the
 *                         form; nothing here is patient data.
 *   updated_by, updated_at, created_at
 *
 * Per-practice TENANT storage on purpose: the global platform_setting table is
 * being retired for per-practice settings. Modelled on CO-3's
 * tc_print_templates (1794100000000).
 *
 * A prefill is only a starting point: staff edit it freely, and what is saved
 * is what is sent (routes/tc/referralSend.js is unchanged).
 *
 * carein_app gets SELECT, INSERT, UPDATE — no DELETE (an office clears a
 * template by saving it blank).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PART 2 — hyg_visit.rx_needed / hyg_visit.pharmacy (in-app only)
 * ═════════════════════════════════════════════════════════════════════════════
 * Two optional free-form fields the hygienist fills in for the doctor and the
 * front desk: what prescription is needed (multi-line, ≤ 1000) and which
 * pharmacy (single line, ≤ 200). '' = not filled in.
 *
 * THEY ARE NEVER SENT TO OPEN DENTAL. They live in their own columns, not in
 * the `slip` jsonb, precisely so the staged-write composer (which reads the
 * slip) cannot pick them up; they are shown on the visit and, read-only, on
 * the checkout card. routes/hyg/hygRxNeverToOd.test.js pins it.
 *
 * hyg_visit's existing table-level grant (SELECT, INSERT, UPDATE, DELETE,
 * 1788200000000) covers the new columns; no grant change.
 *
 * CHECKS, each two-valued (NOT NULL columns, so no CHECK can evaluate to NULL).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
const TABLE = 'tc_referral_templates';
exports.TABLE = TABLE;

const TEMPLATE_CHECKS = {
  tc_referral_templates_office_check: "office_id IN ('roland', 'valley')",
  tc_referral_templates_kind_check: "template_kind IN ('specialist_message', 'correspondence_note')",
  tc_referral_templates_body_length_check: 'length(body) <= 2000',
  tc_referral_templates_updated_by_check: "length(updated_by) > 0",
};
exports.TEMPLATE_CHECKS = TEMPLATE_CHECKS;

const RX_CHECKS = {
  hyg_visit_rx_needed_length_check: 'length(rx_needed) <= 1000',
  hyg_visit_pharmacy_length_check: 'length(pharmacy) <= 200',
  // Single line: no line break of either kind.
  hyg_visit_pharmacy_single_line_check: "position(E'\\n' in pharmacy) = 0 AND position(E'\\r' in pharmacy) = 0",
};
exports.RX_CHECKS = RX_CHECKS;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // ── Part 1 ────────────────────────────────────────────────────────────────
  pgm.createTable(TABLE, {
    office_id: { type: 'text', notNull: true },
    template_kind: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true, default: '' },
    updated_by: { type: 'text', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(TABLE, 'tc_referral_templates_pkey', { primaryKey: ['office_id', 'template_kind'] });
  for (const [name, check] of Object.entries(TEMPLATE_CHECKS)) {
    pgm.addConstraint(TABLE, name, { check });
  }
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

  // ── Part 2 ────────────────────────────────────────────────────────────────
  pgm.addColumns('hyg_visit', {
    rx_needed: { type: 'text', notNull: true, default: '' },
    pharmacy: { type: 'text', notNull: true, default: '' },
  });
  for (const [name, check] of Object.entries(RX_CHECKS)) {
    pgm.addConstraint('hyg_visit', name, { check });
  }
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  for (const name of Object.keys(RX_CHECKS)) {
    pgm.dropConstraint('hyg_visit', name, { ifExists: true });
  }
  pgm.dropColumns('hyg_visit', ['rx_needed', 'pharmacy'], { ifExists: true });
  pgm.dropTable(TABLE, { ifExists: true });
};
