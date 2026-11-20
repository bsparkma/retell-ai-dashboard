'use strict';

/**
 * tc_email_library_profile — one office's answers to the TC patient email
 * library's questionnaire (EL-1).
 *
 * WHAT IT HOLDS. One row per office: the WORDING answers (does the office make
 * same-day crowns, which sedation it offers, its scheduling link, ...) that the
 * library composer (services/tcEmailLibrary/compose.js) reads. They change what
 * an email SAYS, never who is contacted or when. No patient data, no PHI.
 *
 *   office_id        the office (primary key: one profile per office)
 *   answers          the whole validated answers object; a save replaces it
 *   library_version  the source.json version the answers were saved against
 *   updated_by       the signed-in user who saved (staff identity)
 *   updated_at       when
 *
 * NEVER IN HERE: office_name and office_phone. The route refuses them; they come
 * from the office's email identity at preview time.
 *
 * NOT A LIBRARY SECTION. This is deliberately its own table, not a
 * tc_library_config section: the generic PUT /api/tc/library/:section route
 * must never reach it (pinned by tcEmailLibrary.route.test.js).
 *
 * CHECK LITERALS ARE INLINE (house rule). The office CHECK is the MT-2b2 format
 * check (1795000000000), never a list of office keys.
 *
 * GRANTS. The app role gets SELECT, INSERT, UPDATE only: a profile is replaced,
 * never deleted, by the app. Role-guarded exactly like 1791100000000_tc_nurture.
 *
 * NUMBERING: newest tenant migration on origin/develop at authoring time was
 * 1795200000000_hyg_visit_addendum.js; 1795400000000 is the number the EL-1
 * brief assigned and sorts after it.
 *
 * Proven against real Postgres by scripts/tc-email-library-verify-queries.js
 * (CI runs it after migrate).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_email_library_profile migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

const TABLE = 'tc_email_library_profile';
exports.TABLE = TABLE;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    office_id: { type: 'text', primaryKey: true },
    answers: { type: 'jsonb', notNull: true },
    library_version: { type: 'text', notNull: true },
    /** The signed-in user who saved. Staff identity, never patient identity. */
    updated_by: { type: 'text', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint(TABLE, 'tc_email_library_profile_office_check', {
    check: "office_id ~ '^[a-z][a-z0-9_-]{1,31}$'",
  });
  // CASE, not AND: Postgres does not promise to short-circuit.
  pgm.addConstraint(TABLE, 'tc_email_library_profile_answers_check', {
    check: "CASE WHEN jsonb_typeof(answers) = 'object' THEN NOT (answers ? 'office_name' OR answers ? 'office_phone') ELSE false END",
  });
  pgm.addConstraint(TABLE, 'tc_email_library_profile_version_check', {
    check: 'char_length(btrim(library_version)) BETWEEN 1 AND 32',
  });
  pgm.addConstraint(TABLE, 'tc_email_library_profile_updated_by_check', {
    check: 'char_length(btrim(updated_by)) BETWEEN 1 AND 320',
  });

  // ── carein_app grants (tc_nurture's mechanism; SELECT, INSERT, UPDATE) ────
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', '${TABLE}');
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I', '${TABLE}', r);
      ELSE
        RAISE NOTICE 'tc_email_library_profile: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

/**
 * Removes the table. The rows are an office's wording choices (re-enterable on
 * the page), not a clinical or financial record, so down() drops them with it.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable(TABLE, { ifExists: true });
};
