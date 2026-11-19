'use strict';

/**
 * MT-2b3: the SERVER is the office validity layer.
 *
 * Since MT-2b2 the database checks only an office key's FORMAT, and since
 * MT-2b3 so do the shared/ zod schemas. What stops a request naming an office
 * that is not the practice's own is therefore ONLY the gates in
 * platform/officeGate.js. This suite pins that:
 *
 *   1. BEHAVIOURAL: every route the tc, hyg, hyg-staff, fees, rcm and
 *      print-templates routers register is hit with a made-up office, with
 *      'unknown', and with ANOTHER tenant's real office. Each one is refused at
 *      the gate with byte-identical bodies (no oracle), equal to the body the
 *      hard-coded gates sent before MT-2b3. The one route whose office is in
 *      its BODY (POST /api/tc/cases/from-call) is pinned the same way.
 *      A new route mounted above a gate fails here, by name.
 *   2. SOURCE: no `['roland', 'valley']` literal survives in server source
 *      outside migrations, tests and the named exceptions below; every module
 *      gate is built by makeRequireOffice; the gate calls isTenantOffice.
 *   3. INVENTORY: every route file that reads an office from a request is
 *      listed below with the check it uses. A new reader fails here until it
 *      is listed (and reviewed).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const registry = require('../platform/registry');
const officeRegistry = require('../platform/officeRegistry');
const { walkRoutes } = require('./routeWalk');

const BACKEND = path.join(__dirname, '..');

/** The body every module gate sent for a bad office before MT-2b3 (tenant carein). */
const LEGACY_REFUSAL =
  '{"success":false,"error":"office query param is required and must be one of: roland, valley","code":"INVALID_OFFICE"}';

/** A made-up key, the system bucket, a casing variant, and another tenant's REAL office. */
const BAD_OFFICES = ['fortsmith', 'unknown', 'Roland', 'main'];

/** The one route whose office arrives in the body; the gate is its zod schema. */
const BODY_OFFICE_ROUTES = new Set(['POST /api/tc/cases/from-call/']);

function officeRow(officeKey, sortOrder) {
  return {
    office_key: officeKey,
    display_name: officeKey,
    sort_order: sortOrder,
    retell_agent_ids: [],
    mango_dids: [],
    od_customer_key_secret: null,
    od_customer_key_env: null,
    commtype_defnums: {},
    od_enabled: false,
    hyg_od_enabled: false,
    status: 'active',
    updated_at: new Date(0),
    updated_by: null,
  };
}

const quiet = { warn: console.warn, error: console.error, log: console.log };
const savedList = registry.listTenantOffices;

/** Make 'main' a REAL office of another tenant, acme, for the oracle check. */
async function seedOtherTenant() {
  registry.listTenantOffices = async (slug) => {
    if (slug === 'acme') return [officeRow('main', 1)];
    throw new Error(`no registry rows for ${slug}`);
  };
  officeRegistry.resetCacheForTests();
  await officeRegistry.refreshFromDb('acme');
  assert.equal(officeRegistry.isTenantOffice('acme', 'main'), true, 'main is a real office of another tenant');
  assert.equal(officeRegistry.isTenantOffice('carein', 'main'), false);
}

test.before(() => {
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
});
test.after(() => {
  registry.listTenantOffices = savedList;
  officeRegistry.resetCacheForTests();
  Object.assign(console, quiet);
});

/**
 * Hit every route with each bad office; return a map key -> body text.
 * @returns {Promise<Array<{ key: string, office: string, status: number, text: string }>>}
 */
async function hitAll(baseUrl, prefix, routes) {
  const out = [];
  for (const r of routes) {
    for (const office of BAD_OFFICES) {
      const key = `${r.method} ${prefix}${r.routePath}`;
      const res = await fetch(`${baseUrl}${prefix}${r.path}?office=${encodeURIComponent(office)}`, {
        method: r.method,
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body:
          r.method === 'GET' || r.method === 'HEAD'
            ? undefined
            : BODY_OFFICE_ROUTES.has(key)
              ? JSON.stringify({ od_patient_id: 1, office, call_id: 'c1', patient_name: 'Test Patient' })
              : '{}',
        signal: AbortSignal.timeout(10000),
      });
      out.push({ key, office, status: res.status, text: await res.text() });
    }
  }
  return out;
}

function assertGated(results) {
  for (const r of results) {
    if (BODY_OFFICE_ROUTES.has(r.key)) continue;
    assert.equal(r.status, 400, `${r.key} ?office=${r.office} must be refused at the gate (got ${r.status} ${r.text})`);
    assert.equal(r.text, LEGACY_REFUSAL, `${r.key} ?office=${r.office}: refusal bytes changed`);
  }
}

test('tc: every route refuses a non-office at the gate, byte-identically; from-call refuses it in the body', async () => {
  await seedOtherTenant();
  const { bootTcApp } = require('../routes/tc/tcTestUtils');
  const app = await bootTcApp({ modules: ['tc', 'hyg'] });
  try {
    const routes = walkRoutes(require('../routes/tc'));
    assert.ok(routes.length > 100, `walked ${routes.length} tc routes`);
    const results = await hitAll(app.baseUrl, '/api/tc', routes);
    assertGated(results);

    const fromCall = results.filter((r) => BODY_OFFICE_ROUTES.has(r.key));
    assert.equal(fromCall.length, BAD_OFFICES.length, 'from-call was walked');
    for (const r of fromCall) {
      assert.equal(r.status, 400, r.text);
      const body = JSON.parse(r.text);
      assert.equal(body.code, 'VALIDATION_FAILED');
      const officeIssue = body.issues.find((i) => i.path === 'office');
      assert.ok(officeIssue, `from-call names the office issue: ${r.text}`);
    }
    // Oracle-free: the other tenant's real office reads exactly like a made-up one.
    const byOffice = Object.fromEntries(fromCall.map((r) => [r.office, r.text]));
    assert.equal(byOffice.main, byOffice.fortsmith);
    assert.equal(byOffice.unknown, byOffice.fortsmith);
    // And it is exactly the zod issue the static z.enum(["roland","valley"]) sent.
    assert.deepEqual(
      JSON.parse(byOffice.fortsmith).issues.find((i) => i.path === 'office'),
      { path: 'office', code: 'invalid_value', message: 'Invalid option: expected one of "roland"|"valley"' }
    );
  } finally {
    await app.close();
  }
});

test('hyg and hyg-staff: every route refuses a non-office at the gate, byte-identically', async () => {
  await seedOtherTenant();
  const { bootHygApp } = require('../routes/hyg/hygTestUtils');
  const app = await bootHygApp({ role: 'admin', modules: ['hyg'] });
  try {
    const hyg = walkRoutes(require('../routes/hyg'));
    const staff = walkRoutes(require('../routes/hygStaff'));
    assert.ok(hyg.length > 30 && staff.length > 0);
    assertGated(await hitAll(app.baseUrl, '/api/hyg', hyg));
    assertGated(await hitAll(app.baseUrl, '/api/platform/hyg-staff', staff));
  } finally {
    await app.close();
  }
});

test('fees: every route refuses a non-office at the gate, byte-identically', async () => {
  await seedOtherTenant();
  const { bootFeesApp } = require('../routes/fees/feesTestUtils');
  const app = await bootFeesApp({});
  try {
    const routes = walkRoutes(require('../routes/fees'));
    assert.ok(routes.length > 5);
    assertGated(await hitAll(app.baseUrl, '/api/fees', routes));
  } finally {
    await app.close();
  }
});

test('rcm: every route refuses a non-office at the gate, byte-identically', async () => {
  await seedOtherTenant();
  const { bootRcmApp } = require('../routes/rcm/rcmTestUtils');
  const app = await bootRcmApp({});
  try {
    const routes = walkRoutes(require('../routes/rcm'));
    assert.ok(routes.length > 30);
    assertGated(await hitAll(app.baseUrl, '/api/rcm', routes));
  } finally {
    await app.close();
  }
});

test('print-templates: every route refuses a non-office at the gate, byte-identically', async () => {
  await seedOtherTenant();
  const router = require('../routes/printTemplates');
  const app = express();
  app.use(express.json());
  // Stand-in for the auth gate + tenantContext: the session tenant is carein.
  app.use((req, _res, next) => {
    req.user = { email: 'admin@carein.ai' };
    req.tenant = { id: 'T1', slug: 'carein', modules: ['tc'], clinics: [] };
    next();
  });
  app.use('/api/platform/print-templates', router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const routes = walkRoutes(router);
    assert.ok(routes.length > 0);
    assertGated(await hitAll(`http://127.0.0.1:${server.address().port}`, '/api/platform/print-templates', routes));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── 2. source ───────────────────────────────────────────────────────────────

/** @returns {string[]} server source files (relative), tests and migrations excluded */
function serverSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '__fixtures__', 'migrations', 'migrations-tenant', 'test'].includes(e.name)) continue;
        walk(full);
      } else if (/\.(c?js)$/.test(e.name) && !/\.test\.c?js$/.test(e.name) && !/TestUtils\.js$/.test(e.name)) {
        if (e.name.endsWith('.gen.cjs')) continue;
        out.push(path.relative(BACKEND, full).split(path.sep).join('/'));
      }
    }
  };
  for (const d of ['routes', 'services', 'platform', 'middleware', 'config', 'scripts', 'utils', 'tc', 'hyg']) {
    if (fs.existsSync(path.join(BACKEND, d))) walk(path.join(BACKEND, d));
  }
  return out;
}

/**
 * Server files allowed to spell the pair. Each is a script or a list that is
 * NOT a validity check. Adding one is a review decision, not a typo fix.
 */
const PAIR_LITERAL_EXCEPTIONS = Object.freeze({
  // CI/ops scripts that act on the two real offices by name.
  'scripts/rcm-seed-fixtures.cjs': 'seeds synthetic fixtures for both offices',
  'scripts/tc-commtype-readback.js': 'reads back the two offices\' CommLog types',
  'scripts/office-format-checks-verify-queries.js': 'the MT-2b2 CI verifier inserts both offices',
  'scripts/office-settings-verify-queries.js': 'the MT-2a CI verifier reads both seeded offices',
});

test('no hard-coded office pair survives in server source outside migrations, tests and the named exceptions', () => {
  const PAIR = /\[\s*['"]roland['"]\s*,\s*['"]valley['"]\s*\]|IN\s*\(\s*'roland'\s*,\s*'valley'\s*\)|z\.enum\(\s*\[\s*["']roland["']\s*,\s*["']valley["']\s*\]\s*\)/;
  const offenders = [];
  const files = serverSources();
  assert.ok(files.length > 100, `scanned ${files.length} files`);
  for (const rel of files) {
    const src = fs.readFileSync(path.join(BACKEND, rel), 'utf8');
    if (PAIR.test(src) && !Object.prototype.hasOwnProperty.call(PAIR_LITERAL_EXCEPTIONS, rel)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'validate an office with platform/officeGate.js, not a literal pair');
  for (const rel of Object.keys(PAIR_LITERAL_EXCEPTIONS)) {
    assert.ok(files.includes(rel), `stale exception: ${rel}`);
  }
});

test('every module gate is built by makeRequireOffice, and the gate asks isTenantOffice', () => {
  for (const mod of ['tc', 'hyg', 'fees', 'rcm']) {
    const src = fs.readFileSync(path.join(BACKEND, 'routes', mod, 'helpers.js'), 'utf8');
    assert.match(src, /const requireOffice = makeRequireOffice\('\w+Office'\);/, mod);
    assert.doesNotMatch(src, /\bOFFICES\b/, `${mod}: no office list of its own`);
    assert.equal(require(`../routes/${mod}/helpers`).OFFICES, undefined, `${mod}: OFFICES is no longer exported`);
  }
  const gate = fs.readFileSync(path.join(BACKEND, 'platform/officeGate.js'), 'utf8');
  assert.match(gate, /officeRegistry\.isTenantOffice\(sessionTenantSlug\(req\), officeKey\)/);
  assert.match(gate, /officeRegistry\.tenantOfficeKeys\(sessionTenantSlug\(req\)\)/);
});

// ── 3. inventory ────────────────────────────────────────────────────────────

/**
 * Every route file that reads an office from a request, and the check it uses.
 * platform/officeGate.js IS the gate (the four module helpers build theirs from it). The rest are outside the four modules
 * and each has its own, named check.
 */
const OFFICE_READERS = Object.freeze({
  'platform/officeGate.js': 'THE gate: makeRequireOffice, used by the tc, hyg, fees and rcm helpers',
  'routes/rcm/officeSettings.js': 'path/body office asserted equal to the gated query office (isSessionOffice)',
  'routes/officeSwitches.js': ':office looked up in the session tenant\'s switch states (MT-2c, tenant-filtered)',
  'routes/twilioWebhooks.js': ':office is our own callback path, checked by twilioConfig.isKnownOffice',
  'routes/openDentalSync.js': 'voice-only ?office_id= checked by odOffices.isOdReady',
  'routes/analytics.js': 'voice-only ?office_id= is a filter over the call store, never a write target',
});

test('every route file that reads an office from a request is inventoried with its check', () => {
  const READ = /req\.(query|params|body)\.(office|officeId|office_id|officeKey|office_key)\b|req\.(query|params|body)\[['"]office/;
  const found = serverSources().filter(
    (rel) => (rel.startsWith('routes/') || rel.startsWith('platform/')) && READ.test(fs.readFileSync(path.join(BACKEND, rel), 'utf8'))
  );
  assert.deepEqual(found.sort(), Object.keys(OFFICE_READERS).sort());
});
