'use strict';

/**
 * Per-tenant (data-plane) migration runner.
 *
 * Applies migrations from backend/migrations-tenant/ to a tenant's OWN database
 * (carein_t_<...>), kept entirely separate from the control-plane migrations in
 * backend/migrations/ (which target carein_control).
 *
 * Each tenant's connection string is resolved the same way the app resolves it
 * at runtime: registry.getTenantDbRef(tenantId).kv_conn_secret ->
 * secrets.getSecretValue(name) (env in dev, Key Vault in prod). No connection
 * string is ever read from .env directly or hardcoded.
 *
 * Usage:
 *   node scripts/migrate-tenant.js up   --tenant carein         # one tenant by slug
 *   node scripts/migrate-tenant.js up   --tenant-id <uuid>      # one tenant by id
 *   node scripts/migrate-tenant.js up   --all                   # every tenant
 *   node scripts/migrate-tenant.js down --tenant carein         # roll back 1
 *   node scripts/migrate-tenant.js down --tenant carein 3       # roll back 3
 *   node scripts/migrate-tenant.js redo --tenant carein
 */

require('dotenv').config();
const path = require('path');
const { loadSecrets, getSecretValue, secretNameToEnvKey } = require('../config/secrets');
const registry = require('./../platform/registry');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations-tenant');
const MIGRATIONS_TABLE = 'pgmigrations'; // bookkeeping table inside each tenant DB

/** @returns {Function} node-pg-migrate runner across CJS/ESM shapes. */
function resolveRunner() {
  const mod = require('node-pg-migrate');
  return typeof mod === 'function' ? mod : mod.default;
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ verb:string, direction:'up'|'down', count:number, redo:boolean,
 *            all:boolean, slug:string|null, tenantId:string|null }}
 */
function parseArgs(argv) {
  const verb = (argv[0] || 'up').toLowerCase();
  let all = false;
  let slug = null;
  let tenantId = null;
  let count = NaN;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') all = true;
    else if (a === '--tenant') slug = argv[++i];
    else if (a === '--tenant-id') tenantId = argv[++i];
    else if (/^\d+$/.test(a)) count = parseInt(a, 10);
  }

  const redo = verb === 'redo';
  const direction = verb === 'down' ? 'down' : 'up';
  const fallback = direction === 'down' ? 1 : Infinity;
  const resolvedCount = Number.isFinite(count) && count >= 0 ? count : fallback;
  return { verb, direction, count: resolvedCount, redo, all, slug, tenantId };
}

/**
 * Resolve the list of target tenants from CLI selectors.
 * @param {{ all:boolean, slug:string|null, tenantId:string|null }} sel
 * @returns {Promise<Array<{ tenant_id:string, slug:string }>>}
 */
async function resolveTargets(sel) {
  if (sel.all) {
    return registry.listTenants();
  }
  if (sel.slug) {
    const t = await registry.getTenantBySlug(sel.slug);
    if (!t) throw new Error(`no tenant with slug '${sel.slug}'`);
    return [t];
  }
  if (sel.tenantId) {
    const t = await registry.getTenantById(sel.tenantId);
    if (!t) throw new Error(`no tenant with id '${sel.tenantId}'`);
    return [t];
  }
  throw new Error('select a tenant: --tenant <slug> | --tenant-id <uuid> | --all');
}

/**
 * Apply migrations to one tenant's database.
 * @param {{ tenant_id:string, slug:string }} tenant
 * @param {'up'|'down'} direction
 * @param {number} count
 * @param {boolean} redo
 * @param {string|null} [overrideUrl] explicit DB URL (single-tenant only); used
 *   by provisioning to migrate a freshly-created DB before its KV secret exists.
 */
async function migrateOne(tenant, direction, count, redo, overrideUrl) {
  const ref = await registry.getTenantDbRef(tenant.tenant_id);
  if (!ref) {
    throw new Error(`tenant '${tenant.slug}' has no tenant_database row`);
  }

  let databaseUrl = overrideUrl || null;
  if (databaseUrl) {
    console.log(`[migrate-tenant] using explicit DB URL override for '${tenant.slug}'`);
  } else {
    databaseUrl = await getSecretValue(ref.kv_conn_secret);
  }
  if (!databaseUrl) {
    const envKey = secretNameToEnvKey(ref.kv_conn_secret);
    throw new Error(
      `connection string for tenant '${tenant.slug}' not available ` +
        `(secret '${ref.kv_conn_secret}'). Dev: set ${envKey}; Prod: create the Key Vault secret.`
    );
  }

  const runner = resolveRunner();
  const base = {
    databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    singleTransaction: true,
    verbose: true,
  };

  console.log(`\n=== tenant '${tenant.slug}' (${tenant.tenant_id}) -> ${ref.db_name} ===`);
  if (redo) {
    await runner({ ...base, direction: 'down', count: 1 });
    await runner({ ...base, direction: 'up', count: 1 });
  } else {
    await runner({ ...base, direction, count });
  }
}

async function main() {
  await loadSecrets(); // prod: enables Key Vault fetches; dev: no-op
  const args = parseArgs(process.argv.slice(2));
  const targets = await resolveTargets(args);

  // MIGRATE_TENANT_DB_URL is honored only for a SINGLE target (e.g. provisioning
  // migrating a just-created DB). It is ignored for --all to avoid pointing
  // every tenant at one database.
  const overrideUrl = targets.length === 1 ? (process.env.MIGRATE_TENANT_DB_URL || null) : null;

  for (const tenant of targets) {
    await migrateOne(tenant, args.direction, args.count, args.redo, overrideUrl);
  }

  await registry.close().catch(() => {});
  console.log(`\n[migrate-tenant] ${args.redo ? 'redo' : args.direction} complete for ${targets.length} tenant(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrate-tenant] failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
