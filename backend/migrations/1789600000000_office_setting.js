'use strict';

/**
 * Per-office settings, keyed by TENANT and office (MT-2a). DARK.
 *
 * WHY. Ten settings are per office today, and every one of them lives in the
 * global platform_setting table as ONE row whose value is a map keyed by bare
 * office key: {"roland": true, "valley": false}. That map has no tenant
 * dimension. A second practice with an office called 'main' would share the
 * namespace with every other practice's 'main'. MT-1 gave each office a
 * control-plane row (office, PK (tenant_id, office_key)); this table hangs the
 * settings off that row.
 *
 * MT-2a SHIPS IT DARK. Nothing serves these rows. Every write path that stores
 * one of the ten keys in platform_setting also writes the matching row here,
 * in the same control-DB transaction (platform/registry.js setPlatformSetting),
 * and each of the ten readers compares the two after every successful read
 * (platform/officeSettingsParity.js) and warns on drift. platform_setting is
 * still what is served. The cutover is MT-2b, once the tripwire has stayed
 * silent in every environment.
 *
 * THE CLOSED VOCABULARY. setting_key may only be one of the ten keys below,
 * written out as a literal at the addConstraint call ON PURPOSE (a migration
 * that required the live list would rewrite its own history). Nine are
 * booleans; tc_email_identity is an object. tc_email_enabled, tc_sms_enabled
 * and call_retention_days are NOT here: they are process-wide, and they stay in
 * platform_setting.
 *
 * THE FOREIGN KEY. (tenant_id, office_key) references office, so a setting can
 * only exist for an office the tenant really has, and the 'unknown' bucket can
 * never hold one (office refuses that row, office_not_unknown). ON DELETE
 * CASCADE: an office row removed takes its settings with it.
 *
 * updated_by is the actor's email, an identifier, not PHI (the same class as
 * platform_setting.updated_by). Null means a migration or a runbook wrote it.
 *
 * NO carein_app GRANT. Control plane, like office and platform_setting.
 *
 * The backfill is the paired migration 1789600000001_backfill_office_setting.js.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.createTable('office_setting', {
    tenant_id: { type: 'uuid', notNull: true },
    office_key: { type: 'text', notNull: true },
    setting_key: { type: 'text', notNull: true },
    value: { type: 'jsonb', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_by: { type: 'text' },
  });

  pgm.addConstraint('office_setting', 'office_setting_pkey', {
    primaryKey: ['tenant_id', 'office_key', 'setting_key'],
  });

  pgm.addConstraint('office_setting', 'office_setting_office_fkey', {
    foreignKeys: {
      columns: ['tenant_id', 'office_key'],
      references: 'office(tenant_id, office_key)',
      onDelete: 'CASCADE',
    },
  });

  // Every column these CHECKs read is NOT NULL, so a NULL cannot slip past the
  // IN () (a NULL IN (...) is NULL, and a CHECK passes on NULL).
  pgm.addConstraint('office_setting', 'office_setting_key_vocabulary', {
    check: `setting_key IN (
      'tc_checkout_enabled',
      'tc_od_sync_enabled',
      'tc_auto_checkout_enabled',
      'tc_referrals_enabled',
      'tc_referral_email_enabled',
      'tc_referral_patient_email_enabled',
      'hyg_od_enabled',
      'tc_nurture_enabled',
      'tc_opportunities_sync',
      'tc_email_identity'
    )`,
  });

  pgm.addConstraint('office_setting', 'office_setting_value_shape', {
    check: `
      (setting_key = 'tc_email_identity' AND jsonb_typeof(value) = 'object')
      OR (setting_key <> 'tc_email_identity' AND jsonb_typeof(value) = 'boolean')
    `,
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('office_setting');
};
