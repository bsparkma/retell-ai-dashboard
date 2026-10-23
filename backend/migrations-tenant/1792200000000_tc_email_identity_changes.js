'use strict';

/**
 * The CHANGE HISTORY of an office's in-app email identity (R5c).
 *
 * The identity itself (reply-to, practice name, practice phone per office) is
 * stored in the control plane's platform_setting['tc_email_identity'], next to
 * the app settings it shadows — see config/emailIdentity.js for why. What this
 * table adds is the part audit_log cannot hold: WHAT each value was before a
 * change and what it became. audit_log.prior_state is a slug by CHECK
 * (1788000000000), and an email address or a practice name is not one.
 *
 * ONE ROW PER FIELD CHANGED. A save that changes two fields writes two rows; a
 * save that changes nothing writes none. Each row also gets an audit_log row
 * (resource tc_email_identity, `<office>/<field>`, prior_state stored | unset),
 * so the trail is findable from the ordinary audit view.
 *
 * WHAT IS IN HERE: office contact details (an office mailbox, the practice's
 * name, the practice's phone) and the sign-in email of who changed them. No
 * patient data, and nothing secret.
 *
 * APPEND-ONLY: the app role gets SELECT and INSERT only, the same shape as the
 * audit_log grant (and a uuid key, so no sequence grant is needed). A history
 * the app could rewrite would not be a history.
 *
 * VOCABULARY (CHECK literals inline, pinned against shared/tc/emailIdentity.ts
 * by test/emailIdentityMigration.test.js):
 *   field  reply_to | practice_name | practice_phone
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_email_identity_changes migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

const TABLE = 'tc_email_identity_changes';
exports.TABLE = TABLE;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    // uuid, not bigserial, so the append-only grant needs no sequence (the
    // audit_log precedent, 1780453117650).
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    field: { type: 'text', notNull: true },
    // NULL = nothing was saved in the app (the app setting, if any, applied).
    prior_value: { type: 'text' },
    // NULL = the saved value was cleared (back to the app setting).
    new_value: { type: 'text' },
    changed_by: { type: 'text', notNull: true },
    changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(TABLE, 'tc_email_identity_changes_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint(TABLE, 'tc_email_identity_changes_field_check', {
    check: "field IN ('reply_to', 'practice_name', 'practice_phone')",
  });
  // A row records a CHANGE: the two sides cannot be the same (NULL-safe).
  pgm.addConstraint(TABLE, 'tc_email_identity_changes_changed_check', {
    check: 'prior_value IS DISTINCT FROM new_value',
  });
  pgm.addConstraint(TABLE, 'tc_email_identity_changes_by_check', {
    check: 'changed_by = lower(changed_by) AND length(changed_by) > 0',
  });
  pgm.createIndex(TABLE, ['office_id', 'changed_at'], { name: 'tc_email_identity_changes_office_idx' });

  // ── carein_app grants: append-only (SELECT + INSERT) ─────────────────────
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', '${TABLE}');
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO %I', '${TABLE}', r);
      ELSE
        RAISE NOTICE '${TABLE}: app role % absent; grants SKIPPED', r;
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
