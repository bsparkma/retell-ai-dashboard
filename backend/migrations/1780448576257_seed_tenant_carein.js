'use strict';

/**
 * Seed: CareIN as tenant #1.
 *
 *   tenant            slug 'carein', 'CareIN Dental LLC', active
 *   tenant_clinic     (1, 'Roland'), (2, 'Valley')   [OD ClinicNum]
 *   tenant_module     'carein' enabled
 *   tenant_connector  od_primary_mode 'api', od_api_base = current OPENDENTAL_API_BASE_URL,
 *                     KV secret NAMES for OD dev/cust keys + connector key (already in kv-carein-core)
 *   tenant_database   references KV secret NAME 'tenant-carein-db-url' (per-tenant app DB conn string)
 *   app_user          admin@carein.ai → role 'admin'
 *
 * No secret VALUES live here — only Key Vault secret NAMES.
 *
 * connector_url is intentionally NOT hardcoded (it is environment-specific and
 * the real value lives only in .env, which is never read). Supply it at apply
 * time via CAREIN_SEED_CONNECTOR_URL; the migration fails closed if it's unset
 * rather than defaulting to localhost. down() does not need it.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** Fixed UUID for tenant #1 so the seed is idempotent and referentially simple. */
const CAREIN_TENANT_ID = 'ca7e1000-0000-4000-8000-000000000001';

/** Current non-secret OD cloud API base (see backend/.env.example, docs/SECRETS.md). */
const OD_API_BASE = 'https://api.opendental.com/api/v1';

/** Per-tenant app DB conn-string secret NAME (created in Key Vault by provisioning). */
const KV_TENANT_DB_SECRET = 'tenant-carein-db-url';

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

/** SQL string literal with single quotes escaped. */
function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  const connectorUrl = (process.env.CAREIN_SEED_CONNECTOR_URL || '').trim();
  if (!connectorUrl) {
    throw new Error(
      "[seed:carein] CAREIN_SEED_CONNECTOR_URL is required to seed tenant 'carein'. " +
        'This is the on-prem CareIN connector base URL (no localhost default by design). ' +
        'Set it for the target environment, e.g. ' +
        'CAREIN_SEED_CONNECTOR_URL=https://connector.example  then re-run the migration.'
    );
  }

  const id = lit(CAREIN_TENANT_ID);

  pgm.sql(`
    INSERT INTO tenant (tenant_id, slug, display_name, status)
    VALUES (${id}, 'carein', 'CareIN Dental LLC', 'active')
    ON CONFLICT (slug) DO NOTHING;
  `);

  pgm.sql(`
    INSERT INTO tenant_database (tenant_id, kv_conn_secret, db_name)
    VALUES (${id}, ${lit(KV_TENANT_DB_SECRET)}, 'carein_t_carein')
    ON CONFLICT (tenant_id) DO NOTHING;
  `);

  pgm.sql(`
    INSERT INTO tenant_connector (
      tenant_id, od_primary_mode, od_api_base,
      kv_od_dev_key, kv_od_cust_key, connector_url, kv_connector_key
    )
    VALUES (
      ${id}, 'api', ${lit(OD_API_BASE)},
      'opendental-developer-key', 'opendental-customer-key',
      ${lit(connectorUrl)}, 'od-connector-api-key'
    )
    ON CONFLICT (tenant_id) DO NOTHING;
  `);

  pgm.sql(`
    INSERT INTO tenant_clinic (tenant_id, clinic_num, name)
    VALUES (${id}, 1, 'Roland'), (${id}, 2, 'Valley')
    ON CONFLICT (tenant_id, clinic_num) DO NOTHING;
  `);

  pgm.sql(`
    INSERT INTO tenant_module (tenant_id, module, enabled)
    VALUES (${id}, 'carein', true)
    ON CONFLICT (tenant_id, module) DO NOTHING;
  `);

  pgm.sql(`
    INSERT INTO app_user (tenant_id, email, role)
    VALUES (${id}, 'admin@carein.ai', 'admin')
    ON CONFLICT (tenant_id, email) DO NOTHING;
  `);
};

/**
 * Remove the CareIN seed. Children first (FKs), then the tenant row.
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  const id = lit(CAREIN_TENANT_ID);
  pgm.sql(`DELETE FROM app_user        WHERE tenant_id = ${id};`);
  pgm.sql(`DELETE FROM tenant_module   WHERE tenant_id = ${id};`);
  pgm.sql(`DELETE FROM tenant_clinic   WHERE tenant_id = ${id};`);
  pgm.sql(`DELETE FROM tenant_connector WHERE tenant_id = ${id};`);
  pgm.sql(`DELETE FROM tenant_database WHERE tenant_id = ${id};`);
  pgm.sql(`DELETE FROM tenant          WHERE tenant_id = ${id};`);
};
