'use strict';

/**
 * Control-plane registry schema (carein_control).
 *
 * The tenant catalog every request consults. Low-PHI: IDs + config + Key Vault
 * secret NAMES only — never secret values. See PHASE1_PRD_PLATFORM_SPINE.md.
 *
 * Hierarchy:  tenant (customer org) ─┬─ tenant_clinic (OD ClinicNum, scoped inside tenant)
 *                                    ├─ tenant_connector (how to reach this tenant's OD)
 *                                    ├─ tenant_database (KV secret name for its app DB)
 *                                    ├─ tenant_module (enabled product modules)
 *                                    └─ app_user (who belongs to the tenant)
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
  // gen_random_uuid() is core in PG13+, but pgcrypto guarantees it on older
  // servers too. IF NOT EXISTS keeps this safe to re-run; down() leaves the
  // extension in place (dropping a shared extension would be unfriendly).
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // --- tenant -------------------------------------------------------------
  pgm.createTable('tenant', {
    tenant_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    slug: { type: 'text', notNull: true, unique: true }, // 'carein', 'smithdental'
    display_name: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'active' }, // active|suspended|provisioning
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('tenant', 'tenant_status_check', {
    check: "status IN ('active', 'suspended', 'provisioning')",
  });

  // --- tenant_database (1:1) ---------------------------------------------
  pgm.createTable('tenant_database', {
    tenant_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'tenant',
      onDelete: 'CASCADE',
    },
    kv_conn_secret: { type: 'text', notNull: true }, // Key Vault secret NAME (per-tenant DB conn string)
    db_name: { type: 'text', notNull: true },
  });

  // --- tenant_connector (1:1) --------------------------------------------
  pgm.createTable('tenant_connector', {
    tenant_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'tenant',
      onDelete: 'CASCADE',
    },
    od_primary_mode: { type: 'text', notNull: true }, // 'api' | 'agent' (primary OD data path hint)
    od_api_base: { type: 'text' }, // OD cloud API base (non-secret config)
    kv_od_dev_key: { type: 'text' }, // KV secret name — OD developer key
    kv_od_cust_key: { type: 'text' }, // KV secret name — OD customer key
    connector_url: { type: 'text' }, // on-prem CareIN connector service base URL
    kv_connector_key: { type: 'text' }, // KV secret name — connector API key
  });
  pgm.addConstraint('tenant_connector', 'tenant_connector_od_primary_mode_check', {
    check: "od_primary_mode IN ('api', 'agent')",
  });

  // --- tenant_clinic (N per tenant) --------------------------------------
  pgm.createTable('tenant_clinic', {
    tenant_id: { type: 'uuid', notNull: true, references: 'tenant', onDelete: 'CASCADE' },
    clinic_num: { type: 'integer', notNull: true }, // OD ClinicNum within this tenant
    name: { type: 'text', notNull: true },
  });
  pgm.addConstraint('tenant_clinic', 'tenant_clinic_pkey', {
    primaryKey: ['tenant_id', 'clinic_num'],
  });

  // --- tenant_module (N per tenant) --------------------------------------
  pgm.createTable('tenant_module', {
    tenant_id: { type: 'uuid', notNull: true, references: 'tenant', onDelete: 'CASCADE' },
    module: { type: 'text', notNull: true }, // 'carein' | 'tc' | 'rcm'
    enabled: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addConstraint('tenant_module', 'tenant_module_pkey', {
    primaryKey: ['tenant_id', 'module'],
  });

  // --- app_user (N per tenant) -------------------------------------------
  pgm.createTable('app_user', {
    user_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenant', onDelete: 'CASCADE' },
    email: { type: 'text', notNull: true }, // carein.ai now / Entra External ID later
    role: { type: 'text', notNull: true, default: 'staff' },
  });
  pgm.addConstraint('app_user', 'app_user_tenant_email_unique', {
    unique: ['tenant_id', 'email'],
  });
  // getUserByEmail() looks up by email alone; index it (case-insensitive).
  pgm.createIndex('app_user', [{ name: 'lower(email)' }], { name: 'app_user_email_lower_idx' });
};

/**
 * Reverse of up(). Drop in FK-dependency order (children before parent).
 * The pgcrypto extension is intentionally left in place.
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('app_user');
  pgm.dropTable('tenant_module');
  pgm.dropTable('tenant_clinic');
  pgm.dropTable('tenant_connector');
  pgm.dropTable('tenant_database');
  pgm.dropTable('tenant');
};
