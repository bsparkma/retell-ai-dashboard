'use strict';

/**
 * Tenant provisioning routine (Slice 5).
 *
 * Stands up a new tenant end-to-end, idempotently and re-runnably:
 *   1. control-plane rows (tenant + clinics + modules + connector + database)
 *      via registry.createTenant — Key Vault secret NAMES only, never values
 *   2. the per-tenant Postgres database  carein_t_<slug>  (guarded if present)
 *   3. the per-tenant migrations, via the existing migrate-tenant runner
 *   4. a gitignored .local/provision-<slug>.ps1 with PLACEHOLDER `az keyvault
 *      secret set` commands (no real values) for the operator to fill + run
 *   5. an onboarding checklist (BAA gate, connector_url, Retell mapping)
 *
 * Makes NO outbound calls with real secrets and reads no .env file. The control
 * DB connection (CONTROL_DB_URL) is resolved the same way the app resolves it.
 * New tenants are created with status 'provisioning' — flipping to 'active' is a
 * deliberate operator step AFTER the signed BAA is on file (COMPLY gate).
 *
 * Usage:
 *   node platform/provisionTenant.js \
 *     --slug smithdental --display-name "Smith Dental LLC" \
 *     --od-mode api --clinics "1:Main,2:North" [--connector-url https://...]
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const { loadSecrets } = require('../config/secrets');
const registry = require('./registry');

/** Non-secret OD cloud API base (same for all OD-cloud tenants). */
const OD_API_BASE_DEFAULT = 'https://api.opendental.com/api/v1';
/** Product modules; only 'carein' is enabled for a new tenant. */
const MODULES = ['carein', 'tc', 'rcm'];

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ slug:string, displayName:string, odMode:'api'|'agent', clinics:Array<{clinic_num:number,name:string}>, connectorUrl:string|null }}
 */
function parseArgs(argv) {
  /** @type {Record<string,string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
  }

  const slug = (flags['slug'] || '').trim().toLowerCase();
  assertValidSlug(slug);

  const displayName = (flags['display-name'] || '').trim();
  if (!displayName) throw new Error('--display-name is required');

  const odMode = (flags['od-mode'] || 'api').trim().toLowerCase();
  if (odMode !== 'api' && odMode !== 'agent') {
    throw new Error("--od-mode must be 'api' or 'agent'");
  }

  const clinics = parseClinics(flags['clinics'] || '');
  if (clinics.length === 0) {
    throw new Error('--clinics is required, e.g. --clinics "1:Roland,2:Valley"');
  }

  const connectorUrl = flags['connector-url'] ? String(flags['connector-url']).trim() : null;

  return { slug, displayName, odMode: /** @type {'api'|'agent'} */ (odMode), clinics, connectorUrl };
}

/** @param {string} slug */
function assertValidSlug(slug) {
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    throw new Error(
      "--slug is required and must be lowercase letters/digits/hyphens starting with a letter (e.g. 'smithdental')"
    );
  }
}

/**
 * Parse "1:Roland,2:Valley" → [{clinic_num:1,name:'Roland'},{clinic_num:2,name:'Valley'}].
 * @param {string} str
 * @returns {Array<{clinic_num:number,name:string}>}
 */
function parseClinics(str) {
  return String(str)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(':');
      if (idx === -1) throw new Error(`bad --clinics entry '${pair}' (expected NUM:Name)`);
      const num = parseInt(pair.slice(0, idx), 10);
      const name = pair.slice(idx + 1).trim();
      if (!Number.isInteger(num) || !name) throw new Error(`bad --clinics entry '${pair}'`);
      return { clinic_num: num, name };
    });
}

/**
 * Derive this tenant's Key Vault secret NAMES + db name from its slug.
 * @param {string} slug
 */
function deriveNames(slug) {
  return {
    kvDbSecret: `tenant-${slug}-db-url`,
    kvOdDevKey: `opendental-${slug}-developer-key`,
    kvOdCustKey: `opendental-${slug}-customer-key`,
    kvConnectorKey: `od-connector-${slug}-api-key`,
    dbName: `carein_t_${slug}`,
  };
}

/** The control-DB connection string (resolved by loadSecrets in prod / env in dev). */
function controlDbUrl() {
  const url = process.env.CONTROL_DB_URL;
  if (!url) {
    throw new Error(
      'CONTROL_DB_URL is not set — cannot reach carein_control or create the tenant DB.'
    );
  }
  return url;
}

/**
 * Create the per-tenant database on the same server as carein_control, guarded
 * if it already exists. dbName is a validated identifier (slug is [a-z0-9-]).
 * @param {string} dbName
 * @returns {Promise<boolean>} true if created, false if it already existed
 */
async function ensureDatabase(dbName) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: controlDbUrl() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rowCount > 0) {
      console.log(`[provision] database "${dbName}" already exists — skipping CREATE`);
      return false;
    }
    // CREATE DATABASE cannot be parameterized; dbName is validated + quoted.
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`[provision] created database "${dbName}"`);
    return true;
  } finally {
    await client.end();
  }
}

/**
 * Derive the new tenant's DB connection string from CONTROL_DB_URL (same server,
 * swapped database name). Used only to run migrations immediately; the durable
 * value lives in Key Vault (prod) / TENANT_<SLUG>_DB_URL (dev) once the operator
 * runs the placeholder script.
 * @param {string} dbName
 * @returns {string}
 */
function deriveTenantDbUrl(dbName) {
  const u = new URL(controlDbUrl());
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Run the per-tenant migrations via the existing migrate-tenant runner, pointing
 * it at the freshly-created DB through the single-tenant URL override.
 * @param {string} slug
 * @param {string} dbUrl
 */
function runTenantMigrations(slug, dbUrl) {
  const script = path.join(__dirname, '..', 'scripts', 'migrate-tenant.js');
  execFileSync(process.execPath, [script, 'up', '--tenant', slug], {
    stdio: 'inherit',
    env: { ...process.env, MIGRATE_TENANT_DB_URL: dbUrl },
  });
}

/**
 * Emit a gitignored placeholder script with `az keyvault secret set` commands
 * for this tenant's secrets. NO real values — operator fills + runs it.
 * @param {string} slug
 * @param {ReturnType<typeof deriveNames>} names
 * @param {string|null} connectorUrl
 * @returns {string} the written file path
 */
function emitPlaceholderScript(slug, names, connectorUrl) {
  const dir = path.join(__dirname, '..', '..', '.local');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `provision-${slug}.ps1`);

  const connectorNote = connectorUrl
    ? `# connector_url for this tenant is already set in carein_control: ${connectorUrl}`
    : `# connector_url is PENDING (null in carein_control). Re-run provisioning with\n` +
      `#   --connector-url https://<this tenant's connector> to set it.`;

  const content = `# =============================================================================
#  provision-${slug}.ps1  —  PLACEHOLDER secret population for tenant '${slug}'
# =============================================================================
#  PLACEHOLDERS ONLY. This file contains NO real secret values.
#  NEVER COMMIT THIS FILE. It lives in .local/ which is gitignored.
#  Once you fill in real values, treat it as a live credential file.
#
#  The control-plane row for '${slug}' stores only these secret NAMES; the VALUES
#  live only in Key Vault (prod) or backend/.env (dev). The per-tenant database
#  "${names.dbName}" and its schema were already created by provisionTenant.js.
#
#  USAGE:
#    1) az login   (as a Key Vault Secrets Officer)
#    2) Replace every <PLACEHOLDER...> below with the real value.
#    3) Run:  pwsh ./.local/provision-${slug}.ps1
#    4) Dev alternative: instead of Key Vault, set these env vars in backend/.env
#       (kebab secret name -> SCREAMING_SNAKE), e.g. TENANT_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_DB_URL=...
# =============================================================================

$ErrorActionPreference = "Stop"
$VAULT = "kv-carein-core"

function Set-Secret($name, $value) {
    Write-Host "Setting secret: $name"
    az keyvault secret set --vault-name $VAULT --name $name --value $value --output none
}

# Per-tenant app database connection string (include sslmode=require for Azure):
#   postgres://<APP_USER>:<APP_PASSWORD>@<PG_HOST>:5432/${names.dbName}?sslmode=require
Set-Secret "${names.kvDbSecret}"     "<PLACEHOLDER_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_DB_URL>"

# Open Dental eConnector keys for this practice (ODFHIR developer/customer keys):
Set-Secret "${names.kvOdDevKey}"   "<PLACEHOLDER_OD_DEVELOPER_KEY>"
Set-Secret "${names.kvOdCustKey}"  "<PLACEHOLDER_OD_CUSTOMER_KEY>"

# On-prem CareIN connector API key for this practice:
Set-Secret "${names.kvConnectorKey}" "<PLACEHOLDER_CONNECTOR_API_KEY>"

${connectorNote}

Write-Host ""
Write-Host "Done. Values live only in Key Vault (prod) / backend/.env (dev) — never in the repo."
`;

  fs.writeFileSync(file, content);
  return file;
}

/**
 * @param {string} slug
 * @param {import('./registry').Tenant} tenant
 * @param {string|null} connectorUrl
 * @param {string} scriptPath
 */
function printChecklist(slug, tenant, connectorUrl, scriptPath) {
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`Onboarding checklist for tenant '${slug}' (status: ${tenant.status})`);
  console.log('──────────────────────────────────────────────────────────────');
  console.log('  [ ] Signed BAA on file?  *** REQUIRED before go-live ***');
  console.log("      Tenant stays status='provisioning' until you flip it to 'active' post-BAA.");
  console.log(`  [ ] connector_url set?   ${connectorUrl ? `yes → ${connectorUrl}` : 'NO — pending; re-run with --connector-url'}`);
  console.log('  [ ] Retell agent / phone-number → tenant mapping (Phase 2 — see docs/SCHEDULER.md)');
  console.log(`  [ ] Fill + run the placeholder secret script: ${scriptPath}`);
  console.log('  [ ] Verify: registry.getTenantBySlug(\'' + slug + "') returns the tenant with its clinics + connector");
  console.log('──────────────────────────────────────────────────────────────\n');
}

async function main() {
  await loadSecrets(); // prod: CONTROL_DB_URL from Key Vault; dev: from .env
  const args = parseArgs(process.argv.slice(2));
  const names = deriveNames(args.slug);

  /** @type {import('./registry').TenantSpec} */
  const spec = {
    slug: args.slug,
    displayName: args.displayName,
    status: 'provisioning', // not live until BAA confirmed (COMPLY)
    odMode: args.odMode,
    odApiBase: OD_API_BASE_DEFAULT,
    connectorUrl: args.connectorUrl, // null → pending
    kvOdDevKey: names.kvOdDevKey,
    kvOdCustKey: names.kvOdCustKey,
    kvConnectorKey: names.kvConnectorKey,
    kvDbSecret: names.kvDbSecret,
    dbName: names.dbName,
    clinics: args.clinics,
    modules: MODULES.map((m) => ({ module: m, enabled: m === 'carein' })),
  };

  // 1) control-plane rows
  const tenant = await registry.createTenant(spec);
  console.log(`[provision] tenant '${tenant.slug}' (${tenant.tenant_id}) rows upserted (status=${tenant.status})`);
  console.log(`[provision] clinics: ${args.clinics.map((c) => `${c.clinic_num}:${c.name}`).join(', ')}`);

  // 2) per-tenant database
  await ensureDatabase(names.dbName);

  // 3) per-tenant migrations (via the existing runner, against the new DB)
  runTenantMigrations(args.slug, deriveTenantDbUrl(names.dbName));

  // 4) placeholder secret script
  const scriptPath = emitPlaceholderScript(args.slug, names, args.connectorUrl);
  console.log(`[provision] wrote placeholder secret script: ${scriptPath}`);

  // 5) onboarding checklist
  printChecklist(args.slug, tenant, args.connectorUrl, scriptPath);

  await registry.close().catch(() => {});
}

// Only run when invoked as a script (not when required by a test).
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[provision] failed:', err && err.message ? err.message : err);
      process.exit(1);
    });
}

module.exports = { parseArgs, parseClinics, deriveNames, assertValidSlug, deriveTenantDbUrl };
