'use strict';

/**
 * Platform-spine smoke test against a LIVE Postgres (local Docker in dev).
 *
 * Exercises the real registry / tenantDb / audit modules end-to-end so you can
 * confirm the Phase 1 control plane + per-tenant data plane are wired correctly
 * BEFORE doing the manual sign-in / live-OD checks in PHASE1_SWITCHON_RUNBOOK.md
 * Section 1.4.
 *
 * It connects exactly as the app does:
 *   - control plane  -> CONTROL_DB_URL            (carein_control, owner)
 *   - data plane     -> TENANT_CAREIN_DB_URL      (carein_t_carein, as carein_app)
 * resolved through the same registry + secrets flow (dev = .env, prod = KV).
 *
 * Checks:
 *   1. registry     — tenant 'carein', clinics, module, db ref, admin app_user
 *   2. tenantDb     — per-tenant pool connects (as carein_app) to carein_t_carein
 *   3. audit        — INSERT + SELECT succeed as carein_app
 *   4. append-only  — UPDATE and DELETE on audit_log are DENIED for carein_app
 *   5. entitlement  — requireEntitledClinic() allows own clinic, blocks a foreign one
 *
 * Read-only against your real OD/connector — it never calls Open Dental. The OD
 * live checks are manual (Section 1.4). No secrets are read or printed.
 *
 * Usage (from backend/, with CONTROL_DB_URL + TENANT_CAREIN_DB_URL set):
 *   node scripts/smoke-spine.js
 */

require('dotenv').config();
const assert = require('node:assert/strict');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const audit = require('../platform/audit');
const { requireEntitledClinic } = require('../middleware/tenantContext');

/** @type {Array<{ name: string, ok: boolean, detail: string }>} */
const results = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function record(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  console.log('[smoke-spine] platform spine checks against live Postgres\n');

  // --- 1. registry (carein_control) --------------------------------------
  const tenant = await registry.getTenantBySlug('carein');
  assert(tenant, "tenant 'carein' not found — did control migrate:up + seed run?");
  const [clinics, modules, dbRef, adminUser] = await Promise.all([
    registry.getTenantClinics(tenant.tenant_id),
    registry.getEnabledModules(tenant.tenant_id),
    registry.getTenantDbRef(tenant.tenant_id),
    registry.getUserByEmail('admin@carein.ai'),
  ]);

  record(
    'registry: tenant carein resolves',
    tenant.slug === 'carein' && tenant.display_name === 'CareIN Dental LLC' && tenant.status === 'active',
    `${tenant.display_name} / ${tenant.status}`
  );
  record('registry: 2 clinics seeded', clinics.length === 2, clinics.map((c) => `${c.clinic_num}:${c.name}`).join(', '));
  record('registry: carein module enabled', modules.includes('carein'), `[${modules.join(', ')}]`);
  record(
    'registry: tenant_database ref',
    !!dbRef && dbRef.db_name === 'carein_t_carein' && dbRef.kv_conn_secret === 'tenant-carein-db-url',
    dbRef ? `${dbRef.db_name} via secret '${dbRef.kv_conn_secret}'` : '(missing)'
  );
  record(
    'registry: admin@carein.ai app_user',
    !!adminUser && adminUser.email.toLowerCase() === 'admin@carein.ai' && adminUser.role === 'admin',
    adminUser ? `${adminUser.email} / ${adminUser.role}` : '(missing)'
  );

  // Synthetic request — tenant id is SERVER-resolved (never client input).
  const req = {
    tenant: { id: tenant.tenant_id },
    user: { email: 'smoke@carein.ai' },
    ip: '127.0.0.1',
    originalUrl: '/api/_smoke',
  };

  // --- 2. tenantDb (carein_t_carein, as carein_app) ----------------------
  const who = await tenantDb.withTenantDb(req, (pool) =>
    pool.query('SELECT current_user AS u, current_database() AS d')
  );
  const dbName = who.rows[0].d;
  const dbUser = who.rows[0].u;
  record(
    'tenantDb: per-tenant pool connects',
    dbName === 'carein_t_carein',
    `connected as '${dbUser}' to '${dbName}'`
  );
  if (dbUser !== 'carein_app') {
    record(
      'tenantDb: app connects as least-privilege role',
      false,
      `expected carein_app, got '${dbUser}' — point TENANT_CAREIN_DB_URL at carein_app to exercise append-only`
    );
  } else {
    record('tenantDb: app connects as least-privilege role', true, 'carein_app (non-owner)');
  }

  // --- 3. audit INSERT + SELECT ------------------------------------------
  await audit.audit(req, { action: 'READ', resourceType: 'smoke', resourceId: 'smoke-1', result: 'SUCCESS' });
  const back = await tenantDb.withTenantDb(req, (pool) =>
    pool.query(
      `SELECT action, resource_type, resource_id, result
         FROM audit_log
        WHERE resource_type = 'smoke'
        ORDER BY ts DESC
        LIMIT 1`
    )
  );
  record(
    'audit: INSERT + SELECT as carein_app',
    back.rows.length === 1 && back.rows[0].resource_id === 'smoke-1' && back.rows[0].action === 'READ',
    back.rows[0] ? JSON.stringify(back.rows[0]) : '(no row)'
  );

  // --- 4. append-only: UPDATE / DELETE must be DENIED for carein_app ------
  // Only a genuine privilege error (SQLSTATE 42501) counts as a pass; any other
  // failure (or success) is reported so a misconfigured role can't masquerade.
  async function expectDenied(label, sql) {
    try {
      await tenantDb.withTenantDb(req, (pool) => pool.query(sql));
      record(label, false, 'statement SUCCEEDED — append-only NOT enforced (check carein_app grants)');
    } catch (err) {
      const denied = err && err.code === '42501';
      record(label, denied, denied ? `denied (42501): ${err.message}` : `unexpected error: ${err && err.message}`);
    }
  }
  await expectDenied("audit: UPDATE denied for carein_app", "UPDATE audit_log SET result = 'ERROR' WHERE resource_type = 'smoke'");
  await expectDenied("audit: DELETE denied for carein_app", "DELETE FROM audit_log WHERE resource_type = 'smoke'");

  // --- 5. entitlement guard (pure logic; the HTTP 403 is a manual check) --
  const reqEnt = { tenant: { clinics: clinics.map((c) => ({ clinic_num: c.clinic_num, name: c.name })) } };
  const ownClinic = clinics.length ? clinics[0].clinic_num : null;
  record(
    'entitlement: own clinic allowed',
    ownClinic != null && requireEntitledClinic(reqEnt, ownClinic) === true,
    `clinicNum ${ownClinic}`
  );
  record(
    'entitlement: foreign clinic blocked (-> 403)',
    requireEntitledClinic(reqEnt, 999999) === false,
    'clinicNum 999999 outside tenant'
  );

  // --- summary -----------------------------------------------------------
  await registry.close().catch(() => {});
  await tenantDb.closeAll().catch(() => {});

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n[smoke-spine] ${passed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : ''}`);
  if (failed) process.exitCode = 1;
}

main().catch(async (err) => {
  await registry.close().catch(() => {});
  await tenantDb.closeAll().catch(() => {});
  console.error('\n[smoke-spine] ERROR:', err && err.message ? err.message : err);
  process.exit(1);
});
