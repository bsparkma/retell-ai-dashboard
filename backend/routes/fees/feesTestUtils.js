'use strict';

/**
 * Test harness for /api/fees: the real middleware chain over an ephemeral HTTP
 * server, and a fake Postgres that executes this module's ACTUAL SQL.
 *
 * Much smaller than routes/rcm/rcmTestUtils.js, which it is modelled on, for a
 * good reason: this module runs six statements, all in importStore.js, and
 * `FakeFeesDb` understands exactly those six. A general SQL interpreter would
 * be a second implementation of Postgres to maintain; one that understands the
 * statements the module actually runs fails loudly the moment a new one is
 * added, which is the behaviour worth having.
 *
 * WHY NOT CALL THE HANDLERS DIRECTLY. A test that did would pass with the
 * office guard deleted, with the module guard deleted, and with the permission
 * gate deleted — which are three of the things these tests exist to prove. So
 * every test boots the chain server.js assembles: auth gate → tenantContext →
 * requireModule('fees') → requireReadWrite('fees.read','fees.write') → the real
 * router.
 */

const express = require('express');
const crypto = require('crypto');

const registry = require('../../platform/registry');
const userContext = require('../../platform/userContext');
const tenantDb = require('../../platform/tenantDb');
const { tenantContext, requireModule } = require('../../middleware/tenantContext');
const { requireDashboardAuth } = require('../../middleware/auth');
const { requireReadWrite } = require('../../config/permissions');

const REGISTRY_KEYS = [
  'getUserByEmail',
  'getTenantById',
  'getTenantClinics',
  'getEnabledModules',
  'getPlatformAdminByEmail',
  'touchUserLogin',
];

/**
 * A Postgres stand-in that executes importStore.js's six statements.
 *
 * It enforces the things the real schema enforces and the tests depend on:
 * office scoping in the WHERE, the batch CHECK constraints, the composite FK,
 * and transactional atomicity (BEGIN snapshots, ROLLBACK restores). A fake that
 * dropped any of those would let a test pass with the corresponding guarantee
 * deleted from the migration.
 *
 * An unrecognised statement THROWS rather than returning an empty result. A
 * silent `{ rows: [] }` is how a fake starts lying about what the module does.
 */
class FakeFeesDb {
  constructor() {
    /** @type {Map<string, Array<Record<string, unknown>>>} */
    this.tables = new Map([
      ['fees_import_batch', []],
      ['fees_import_row', []],
      ['audit_log', []],
    ]);
    /** @type {Array<{ sql: string, params: unknown[] }>} */
    this.log = [];
    /** Snapshot taken at BEGIN, restored at ROLLBACK. */
    this.snapshot = null;
    /** Throw on the next statement matching this predicate, for atomicity tests. */
    this.failWhen = null;
  }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
  }

  /** The pg Pool surface importStore.js uses. */
  async connect() {
    return {
      query: (sql, params) => this.query(sql, params),
      release: () => {},
    };
  }

  async query(sql, params = []) {
    const text = String(sql).trim();
    this.log.push({ sql: text, params });

    if (this.failWhen && this.failWhen(text)) {
      throw new Error('simulated database failure');
    }

    if (/^BEGIN/i.test(text)) {
      this.snapshot = new Map(
        [...this.tables].map(([k, v]) => [k, v.map((row) => ({ ...row }))])
      );
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT/i.test(text)) {
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK/i.test(text)) {
      if (this.snapshot) this.tables = this.snapshot;
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }

    if (/^INSERT INTO audit_log/i.test(text)) return this.insertAudit(text, params);
    if (/^INSERT INTO fees_import_batch/i.test(text)) return this.insertBatch(params);
    if (/^INSERT INTO fees_import_row/i.test(text)) return this.insertRows(params);
    // `[\s\S]` rather than `.`: importStore.js builds these as template
    // literals spanning several lines, and a `.` would not cross them — the
    // statement would fall through to the throw below and every read would 500.
    if (/^SELECT [\s\S]*FROM fees_import_batch/i.test(text)) return this.selectBatches(text, params);
    if (/^SELECT [\s\S]*FROM fees_import_row/i.test(text)) return this.selectRows(params);

    throw new Error(`FakeFeesDb does not know this statement — teach it: ${text.slice(0, 160)}`);
  }

  insertAudit(text, params) {
    // The audit writer names its columns; map them positionally the same way.
    const columns = (text.match(/\(([^)]*)\)\s*VALUES/i) || [, ''])[1]
      .split(',')
      .map((c) => c.trim());
    /** @type {Record<string, unknown>} */
    const row = { created_at: new Date() };
    columns.forEach((c, i) => {
      row[c] = params[i];
    });
    this.table('audit_log').push(row);
    return { rows: [row], rowCount: 1 };
  }

  /** The batch INSERT, with the CHECK constraints the migration declares. */
  insertBatch(params) {
    const [
      office,
      filename,
      file_sha256,
      file_size_bytes,
      source_type,
      status,
      row_count,
      warning_count,
      parse_warnings,
      failure_reason,
      failure_code,
      created_by,
    ] = params;

    const check = (ok, name) => {
      if (!ok) throw new Error(`new row violates check constraint "${name}"`);
    };
    check(['roland', 'valley'].includes(office), 'fees_import_batch_office_check');
    check(['pdf', 'csv'].includes(source_type), 'fees_import_batch_source_type_check');
    check(['parsed', 'failed'].includes(status), 'fees_import_batch_status_check');
    check(/^[0-9a-f]{64}$/.test(String(file_sha256)), 'fees_import_batch_sha256_check');
    check(String(filename).trim().length > 0, 'fees_import_batch_filename_check');
    check(
      Number(file_size_bytes) > 0 && Number(row_count) >= 0 && Number(warning_count) >= 0,
      'fees_import_batch_sizes_check'
    );
    check(
      status !== 'failed' || failure_reason != null,
      'fees_import_batch_failed_reason_check'
    );
    check(
      status !== 'parsed' || (failure_reason == null && failure_code == null),
      'fees_import_batch_parsed_clean_check'
    );
    check(status !== 'failed' || Number(row_count) === 0, 'fees_import_batch_failed_no_rows_check');

    const now = new Date();
    const row = {
      batch_id: crypto.randomUUID(),
      office,
      filename,
      file_sha256,
      file_size_bytes: Number(file_size_bytes),
      source_type,
      status,
      row_count: Number(row_count),
      warning_count: Number(warning_count),
      parse_warnings: JSON.parse(String(parse_warnings)),
      failure_reason: failure_reason ?? null,
      failure_code: failure_code ?? null,
      created_by,
      created_at: now,
      updated_at: now,
    };
    this.table('fees_import_batch').push(row);
    return { rows: [row], rowCount: 1 };
  }

  /** The multi-row row INSERT, six parameters per row plus a literal row_order. */
  insertRows(params) {
    const out = [];
    for (let i = 0; i < params.length; i += 6) {
      const [batch_id, office, proc_code, fee_cents, raw_line, parse_warnings] = params.slice(
        i,
        i + 6
      );

      // The composite FK: a row's office must equal its batch's.
      const parent = this.table('fees_import_batch').find((b) => b.batch_id === batch_id);
      if (!parent || parent.office !== office) {
        throw new Error('insert violates foreign key constraint "fees_import_row_batch_fk"');
      }
      if (!/^D[0-9]{4}$/.test(String(proc_code))) {
        throw new Error('new row violates check constraint "fees_import_row_proc_code_check"');
      }
      if (!(Number(fee_cents) >= 0) || !Number.isInteger(Number(fee_cents))) {
        throw new Error('new row violates check constraint "fees_import_row_fee_cents_check"');
      }

      const row = {
        row_id: crypto.randomUUID(),
        batch_id,
        office,
        proc_code,
        fee_cents: Number(fee_cents),
        raw_line,
        parse_warnings: JSON.parse(String(parse_warnings)),
        row_order: i / 6,
        created_at: new Date(),
      };
      this.table('fees_import_row').push(row);
      out.push(row);
    }
    return { rows: out, rowCount: out.length };
  }

  selectBatches(text, params) {
    let rows = this.table('fees_import_batch').filter((r) => r.office === params[0]);
    if (/batch_id = \$2/.test(text)) {
      rows = rows.filter((r) => r.batch_id === params[1]);
      return { rows, rowCount: rows.length };
    }
    rows = [...rows].sort((a, b) => b.created_at - a.created_at);
    const limit = Number(params[1]);
    const offset = Number(params[2]);
    rows = rows.slice(offset, offset + limit);
    return { rows, rowCount: rows.length };
  }

  selectRows(params) {
    const rows = this.table('fees_import_row')
      .filter((r) => r.office === params[0] && r.batch_id === params[1])
      .sort((a, b) => a.row_order - b.row_order);
    return { rows, rowCount: rows.length };
  }
}

/**
 * Boot the real /api/fees stack over an ephemeral HTTP server.
 *
 * The middleware chain mirrors server.js exactly. `modules` defaults to
 * ['fees'] so the ordinary tests run entitled; pass [] to prove the module
 * ships dark.
 */
async function bootFeesApp({
  modules = ['fees'],
  user = { email: 'manager@carein.ai', name: 'Office Manager', tenantId: 'x' },
  role = 'admin',
  superAdmin = false,
  db = new FakeFeesDb(),
} = {}) {
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
    token: process.env.DASHBOARD_API_TOKEN,
  };

  registry.getUserByEmail = async () => ({
    user_id: 'U1',
    tenant_id: 'T1',
    email: user && user.email,
    role,
    status: 'active',
  });
  registry.getTenantById = async () => ({
    tenant_id: 'T1',
    slug: 'carein',
    display_name: 'CareIN',
    status: 'active',
  });
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => modules;
  registry.getPlatformAdminByEmail = async () =>
    superAdmin
      ? { email: (user && user.email) || '', status: 'active', created_at: new Date() }
      : null;
  registry.touchUserLogin = async () => {};
  // Process-wide identity cache: a stale entry would answer this app's lookups
  // with the previous test's role.
  userContext.clearCache();
  tenantDb.withTenantDb = async (_req, fn) => fn(db);

  // The auth gate runs unauthenticated in dev when no token is configured, so
  // the anonymous-401 case only exists with one set.
  process.env.DASHBOARD_API_TOKEN = 'test-token';

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', requireDashboardAuth());
  if (user) {
    // Stands in for a verified SSO session cookie, downstream of the gate.
    app.use('/api', (req, _res, next) => {
      req.user = user;
      req.authMethod = 'session';
      next();
    });
  }
  app.use('/api', tenantContext());
  // Mirrors server.js EXACTLY. The guards are only real if the tests boot them.
  app.use(
    '/api/fees',
    requireModule('fees'),
    requireReadWrite('fees.read', 'fees.write'),
    require('./index')
  );

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        db,
        close: () =>
          new Promise((r) => {
            for (const k of REGISTRY_KEYS) registry[k] = originals.registry[k];
            tenantDb.withTenantDb = originals.withTenantDb;
            if (originals.token === undefined) delete process.env.DASHBOARD_API_TOKEN;
            else process.env.DASHBOARD_API_TOKEN = originals.token;
            server.close(r);
          }),
      });
    });
  });
}

/**
 * JSON fetch helper. Sends the shared bearer by default so requests get past
 * the auth gate; pass `{ anon: true }` to omit it.
 *
 * `body` is passed through untouched — pass a FormData to exercise the
 * multipart upload path, and let undici set the boundary (setting Content-Type
 * by hand is the classic way to break a multipart request).
 */
async function api(baseUrl, method, path, { anon = false, body, json = false } = {}) {
  const headers = anon ? {} : { Authorization: 'Bearer test-token' };
  if (json) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${baseUrl}${path}`, { method, headers, body });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: parsed, headers: Object.fromEntries(res.headers.entries()) };
}

/** A multipart body carrying one file, as a browser would send it. */
function filePart(bytes, filename, contentType = 'application/pdf', field = 'file') {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type: contentType }), filename);
  return form;
}

/** Audit rows written to the fake store. */
function auditRows(db) {
  return db.table('audit_log');
}

/** Boot, run, always close. */
async function withApp(opts, fn) {
  const app = await bootFeesApp(opts);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

module.exports = { FakeFeesDb, bootFeesApp, withApp, api, filePart, auditRows };
