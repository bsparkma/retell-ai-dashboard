'use strict';

/**
 * Staging migration entrypoint — run by the `caj-carein-migrate` Container Apps
 * Job (Phase 3 Step 3 CI/CD). Runs control-plane migrations, then per-tenant
 * migrations, as the **carein_owner** role, from inside Azure (so it reaches
 * psql-carein-staging now via the Azure-services rule and later via §6 VNet
 * with no rework).
 *
 * Connection strings are injected by the Job as env vars sourced from Key Vault
 * secret references (owner creds — separate from the carein_app runtime secrets):
 *   CONTROL_DB_URL         <- staging-control-db-owner-url   (carein_owner @ carein_control)
 *   MIGRATE_TENANT_DB_URL  <- staging-tenant-carein-db-owner-url (carein_owner @ carein_t_carein)
 * CAREIN_SEED_CONNECTOR_URL is set so the idempotent control seed migration runs.
 *
 * The migrations themselves are the same scripts validated in Step 2:
 *   scripts/migrate.js up                 (control plane + seed)
 *   scripts/migrate-tenant.js up --tenant <slug>   (per-tenant; npm mangles
 *                                                    --tenant, so we call node)
 * Both are idempotent — re-running on an already-migrated DB is a no-op.
 */

const { execFileSync } = require('child_process');
const path = require('path');

/** Run a node script, inheriting stdio; throws (non-zero exit) on failure. */
function runNode(scriptRelArgs) {
  execFileSync(process.execPath, scriptRelArgs, { stdio: 'inherit' });
}

const migrate = path.join(__dirname, 'migrate.js');
const migrateTenant = path.join(__dirname, 'migrate-tenant.js');

// TODO(multi-tenant): when more tenants exist, loop registry.listTenants() and
// set a per-tenant owner URL (staging-tenant-<slug>-db-owner-url) before each
// migrate-tenant call. Single tenant 'carein' for now.
const TENANTS = ['carein'];

console.log('[migrate-staging] control-plane migrations (carein_owner)…');
runNode([migrate, 'up']);

for (const slug of TENANTS) {
  console.log(`[migrate-staging] tenant migrations: ${slug} (carein_owner)…`);
  runNode([migrateTenant, 'up', '--tenant', slug]);
}

console.log('[migrate-staging] all migrations complete.');
