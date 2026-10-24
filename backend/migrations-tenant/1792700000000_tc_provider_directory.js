'use strict';

/**
 * The provider directory: the office's own list of providers, for a
 * referral's referring provider and a pre-auth's doctor.
 *
 *   tc_provider_directory   one row per provider per office
 *     provider_id        uuid PK
 *     office_id          'roland' | 'valley'
 *     name               1..200 characters ("Jane Smith")
 *     credential_suffix  0..40 characters ("DDS"), '' when none
 *     active             staff deactivate a provider by hand; nothing else does
 *     od_prov_num        Open Dental's ProvNum when the row came from an
 *                        import, NULL when added by hand. UNIQUE per office:
 *                        it is the import's merge key, and the arbiter when
 *                        two imports race.
 *
 * The app OWNS this list. "Import from Open Dental" reads the office's
 * providers once and merges them in (adds new, updates names); it never
 * deletes. So the app role is granted SELECT, INSERT, UPDATE and NOT DELETE:
 * "never deletes" is a property of the grant, not of whoever writes the next
 * route.
 *
 * Nothing references this table. The two fields that use it keep storing text
 * (tc_referrals.referring_provider, tc_preauth_cases.doctor_name), so a
 * deactivated provider never changes what an existing record says.
 *
 * CHECK literals inline (house rule). Grants in this same migration.
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_provider_directory migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

const TABLE = 'tc_provider_directory';
exports.TABLE = TABLE;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  pgm.createTable(TABLE, {
    provider_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    credential_suffix: { type: 'text', notNull: true, default: '' },
    active: { type: 'boolean', notNull: true, default: true },
    od_prov_num: { type: 'bigint' },
    created_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_by: { type: 'text', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(TABLE, 'tc_provider_directory_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint(TABLE, 'tc_provider_directory_name_check', {
    check: 'char_length(btrim(name)) BETWEEN 1 AND 200',
  });
  pgm.addConstraint(TABLE, 'tc_provider_directory_suffix_check', {
    check: 'char_length(credential_suffix) <= 40',
  });
  pgm.addConstraint(TABLE, 'tc_provider_directory_prov_num_check', {
    check: 'od_prov_num IS NULL OR od_prov_num > 0',
  });
  // One row per ProvNum per office. NULLs (hand-added rows) never collide.
  pgm.addConstraint(TABLE, 'tc_provider_directory_office_prov_num_unique', {
    unique: ['office_id', 'od_prov_num'],
  });
  pgm.createIndex(TABLE, ['office_id', 'name'], { name: 'tc_provider_directory_office_name_idx' });

  // ── carein_app grants: no DELETE, on purpose (see the header) ────────────
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', '${TABLE}');
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I', '${TABLE}', r);
      ELSE
        RAISE NOTICE 'tc_provider_directory: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable(TABLE, { ifExists: true });
};
