'use strict';

/**
 * Per-tenant data-plane: the ask-hygiene thread on a checkout card (CO-7).
 *
 * `tc_checkout_questions` — one row per message. A front-desk (TC) message is a
 * QUESTION; a hygienist message, written from the hygiene app's day view, is a
 * REPLY. In-app only: nothing about it reaches Open Dental, email or SMS.
 *
 *   office_id     the card's office, ('roland', 'valley') like every TC table.
 *                 The route copies it from the STORED card, never a request.
 *   handoff_id    the card (tc_checkout_handoffs). The FK is on the id alone,
 *                 as tc_checkout_attestations' is: the routes read the card
 *                 under its office and copy both from it, so a row cannot be
 *                 written against another office's card.
 *   author_email  the SSO identity that wrote it — server-stamped.
 *   author_role   'tc' | 'hygienist': which app it was written from (the route
 *                 decides, never the body).
 *   body          the message, 1..2000 characters.
 *   created_at    when.
 *   resolved_at   NULL while a question is open; set by "Mark resolved". Only a
 *                 QUESTION is ever resolved — a reply has nothing to resolve,
 *                 and the CHECK says so.
 *
 * GRANTS. The app role (carein_app) gets SELECT and INSERT, and UPDATE of
 * `resolved_at` ONLY (a column grant): a message's author, role, body and time
 * cannot be rewritten by the application, and nothing can be deleted by it.
 * There is no ALTER DEFAULT PRIVILEGES anywhere, so these grants are the whole
 * of what the app role holds here.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_checkout_questions migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  pgm.createTable('tc_checkout_questions', {
    question_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    handoff_id: { type: 'uuid', notNull: true, references: 'tc_checkout_handoffs(handoff_id)' },
    author_email: { type: 'text', notNull: true }, // staff identity — never patient identity
    author_role: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true }, // may carry PHI: the front desk's question
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    resolved_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('tc_checkout_questions', 'tc_checkout_questions_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint('tc_checkout_questions', 'tc_checkout_questions_role_check', {
    check: "author_role IN ('tc', 'hygienist')",
  });
  pgm.addConstraint('tc_checkout_questions', 'tc_checkout_questions_body_check', {
    check: 'char_length(body) BETWEEN 1 AND 2000',
  });
  pgm.addConstraint('tc_checkout_questions', 'tc_checkout_questions_author_check', {
    check: "char_length(author_email) > 0",
  });
  // Led by IS NULL so the open state is always writable; a reply is never resolved.
  pgm.addConstraint('tc_checkout_questions', 'tc_checkout_questions_resolved_check', {
    check: "resolved_at IS NULL OR author_role = 'tc'",
  });
  pgm.createIndex('tc_checkout_questions', ['office_id', 'handoff_id', 'created_at'], {
    name: 'tc_checkout_questions_thread_idx',
  });

  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      EXECUTE 'REVOKE ALL ON TABLE tc_checkout_questions FROM PUBLIC';
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT ON TABLE tc_checkout_questions TO %I', r);
        EXECUTE format('GRANT UPDATE (resolved_at) ON TABLE tc_checkout_questions TO %I', r);
      ELSE
        RAISE NOTICE 'tc_checkout_questions: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

/**
 * The thread goes with its table; nothing else references it.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('tc_checkout_questions', { ifExists: true });
};
