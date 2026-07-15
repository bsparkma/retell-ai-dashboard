'use strict';

/**
 * Production migration entrypoint — run by the `caj-carein-prod-migrate` Container
 * Apps Job (Phase 3 Step 5 gated prod CI/CD). Runs control-plane migrations, then
 * per-tenant migrations, as the **carein_owner** role, from inside Azure (so it
 * reaches psql-carein-prod via the Azure-services firewall rule).
 *
 * Connection strings are injected by the Job as env vars sourced from Key Vault
 * secret references (owner creds — separate from the carein_app runtime secrets):
 *   CONTROL_DB_URL         <- prod-control-db-owner-url          (carein_owner @ carein_control)
 *   MIGRATE_TENANT_DB_URL  <- prod-tenant-carein-db-owner-url    (carein_owner @ carein_t_carein)
 * CAREIN_SEED_CONNECTOR_URL is set so the idempotent control seed migration runs.
 *
 * The migrations themselves are the same scripts validated in staging:
 *   scripts/migrate.js up                            (control plane + seed)
 *   scripts/migrate-tenant.js up --tenant <slug>     (per-tenant; npm mangles
 *                                                     --tenant, so we call node)
 * Both are idempotent — re-running on an already-migrated DB is a no-op, so a
 * release that carries no new migration files (e.g. Slice A) does nothing here.
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
// set a per-tenant owner URL (prod-tenant-<slug>-db-owner-url) before each
// migrate-tenant call. Single tenant 'carein' for now.
const TENANTS = ['carein'];

console.log('[migrate-prod] control-plane migrations (carein_owner)…');
runNode([migrate, 'up']);

for (const slug of TENANTS) {
  console.log(`[migrate-prod] tenant migrations: ${slug} (carein_owner)…`);
  runNode([migrateTenant, 'up', '--tenant', slug]);
}

console.log('[migrate-prod] all migrations complete.');
