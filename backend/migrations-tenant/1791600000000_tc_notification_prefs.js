'use strict';

/**
 * Notification preferences for TC's in-app alerts (queue item 51, Checkout C3).
 *
 * TWO NEW TABLES, NOTHING ELSE TOUCHED.
 *
 *   tc_notification_defaults   one row per (office, event): the office-wide
 *                              level an admin chose. Absent ⇒ the built-in
 *                              default, `banner`.
 *   tc_notification_prefs      one row per (user, event): a person's own
 *                              override. Absent ⇒ the office default applies.
 *
 * Effective level = the user's override ?? the office default ?? 'banner'.
 *
 * VOCABULARY (CHECK literals inline, pinned against shared/tc/notifications.ts
 * by test/notificationPrefsMigration.test.js):
 *   event  checkout_handoff   a patient is headed to checkout (item 50)
 *          referral_signoff   a referral awaits the doctor's sign-off (item 53)
 *   level  silent        badge only
 *          banner        in-app toast
 *          sound_banner  toast + a short chime
 *
 * IN-APP ONLY. No push subscription, no device token, no service worker —
 * nothing here can reach a patient or leave the browser tab.
 *
 * A user's override is keyed by their sign-in EMAIL (lowercased), the same
 * identity every tc_* `*_by` column records. It is per user, not per office:
 * "I want sound for checkouts" is a fact about the person.
 *
 * GRANTS: both tables get the carein_app CRUD grant, role-guarded exactly like
 * tc_opportunities' block.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_notification_prefs migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** The tables this migration creates — and grants — in creation order. */
const TABLES = ['tc_notification_defaults', 'tc_notification_prefs'];
exports.TABLES = TABLES;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.createTable('tc_notification_defaults', {
    office_id: { type: 'text', notNull: true, primaryKey: true },
    event: { type: 'text', notNull: true, primaryKey: true },
    level: { type: 'text', notNull: true },
    updated_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('tc_notification_defaults', 'tc_notification_defaults_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint('tc_notification_defaults', 'tc_notification_defaults_event_check', {
    check: "event IN ('checkout_handoff', 'referral_signoff')",
  });
  pgm.addConstraint('tc_notification_defaults', 'tc_notification_defaults_level_check', {
    check: "level IN ('silent', 'banner', 'sound_banner')",
  });

  pgm.createTable('tc_notification_prefs', {
    user_email: { type: 'text', notNull: true, primaryKey: true },
    event: { type: 'text', notNull: true, primaryKey: true },
    level: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('tc_notification_prefs', 'tc_notification_prefs_event_check', {
    check: "event IN ('checkout_handoff', 'referral_signoff')",
  });
  pgm.addConstraint('tc_notification_prefs', 'tc_notification_prefs_level_check', {
    check: "level IN ('silent', 'banner', 'sound_banner')",
  });
  // Stored lowercased, so one person is one key however their IdP cases it.
  pgm.addConstraint('tc_notification_prefs', 'tc_notification_prefs_email_lower_check', {
    check: 'user_email = lower(user_email) AND length(user_email) > 0',
  });

  // ── carein_app grants (tc_schema's mechanism, CRUD scope) ────────────────
  const tableList = TABLES.map((t) => `'${t}'`).join(', ');
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
            t text;
    BEGIN
      FOREACH t IN ARRAY ARRAY[${tableList}] LOOP
        EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
      END LOOP;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        FOREACH t IN ARRAY ARRAY[${tableList}] LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', t, r);
        END LOOP;
      ELSE
        RAISE NOTICE 'tc_notification_prefs: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('tc_notification_prefs', { ifExists: true });
  pgm.dropTable('tc_notification_defaults', { ifExists: true });
};
