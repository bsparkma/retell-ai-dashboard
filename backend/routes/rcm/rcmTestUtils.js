'use strict';

/**
 * Test harness for the /api/rcm route families.
 *
 * Follows the platform's harness pattern (moduleGateWiring.test.js,
 * routes/tc/tcTestUtils.js): a REAL ephemeral HTTP server running the REAL auth
 * gate, tenantContext, requireModule, requireReadWrite and the REAL
 * routes/rcm/index.js router — assembled in the same order and shape as
 * server.js — with the registry stubbed and the per-tenant Pool replaced by
 * FakeRcmDb.
 *
 * Booting index.js rather than the handlers is the point (the lesson from the
 * TC voice-handoff slice): mount order is only under test if the test goes
 * through the assembled chain. A test that calls a handler directly would pass
 * with requireOffice deleted from index.js.
 *
 * FakeRcmDb executes the routes' ACTUAL SQL — the GROUP BY aggregates and the
 * paginated SELECT, office-scoped WHEREs included — so office scoping is
 * exercised for real without a Postgres in CI (backend unit tests run before
 * the ephemeral DB exists; see .github/workflows/staging.yml).
 *
 * NOT a test file (no .test suffix) — node --test must not run it directly.
 */

const express = require('express');

const registry = require('../../platform/registry');
const tenantDb = require('../../platform/tenantDb');
const userContext = require('../../platform/userContext');
const { tenantContext, requireModule } = require('../../middleware/tenantContext');
const { requireReadWrite } = require('../../config/permissions');
const { requireDashboardAuth } = require('../../middleware/auth');
// Namespace import so bootRcmApp can patch it — see the note at the patch site.
const eraFileStore = require('../../services/rcm/eraFileStore');

/**
 * An in-memory stand-in for the tenant pg Pool that understands exactly the
 * query shapes routes/rcm issues. Anything else throws by design: a fake that
 * silently answers a query it does not understand turns a broken route into a
 * green test.
 */
class FakeRcmDb {
  constructor() {
    /** @type {Map<string, Array<Record<string, unknown>>>} */
    this.tables = new Map();
    /** @type {Array<{ sql: string, params: unknown[] }>} */
    this.log = [];
  }

  /** Seed rows into a table (created on first touch). */
  seed(table, rows) {
    const target = this.table(table);
    for (const row of rows) target.push({ created_at: new Date(), archived_at: null, ...row });
    return this;
  }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
  }

  /** Predicate for the WHERE shapes routes/rcm builds. */
  wherePredicate(clause, params) {
    const checks = clause
      .split(/ AND /i)
      .map((t) => t.trim())
      .map((term) => {
        let m;
        if ((m = term.match(/^(\w+) = \$(\d+)$/))) {
          const [, col, idx] = m;
          return (r) => r[col] === params[idx - 1];
        }
        if ((m = term.match(/^(\w+) IS NULL$/))) {
          const [, col] = m;
          return (r) => r[col] == null;
        }
        // `status = 'failed'` — the remittance-key protocol re-asserts the
        // status it expects inside its own WHERE, which is what makes a
        // take-over or a release atomic rather than a read-then-write.
        if ((m = term.match(/^(\w+) = '([^']*)'$/))) {
          const [, col, value] = m;
          return (r) => r[col] === value;
        }
        // `era_file_key = ANY($2::text[])` — the list endpoint's join back from
        // a page of uploads to the batches they produced.
        if ((m = term.match(/^(\w+) = ANY\(\$(\d+)(?:::\w+\[\])?\)$/))) {
          const [, col, idx] = m;
          const list = params[idx - 1];
          return (r) => Array.isArray(list) && list.includes(r[col]);
        }
        throw new Error(`FakeRcmDb: unsupported WHERE term: ${term}`);
      });
    return (r) => checks.every((c) => c(r));
  }

  /**
   * A pooled client. Slice 5's upload runs `BEGIN … COMMIT/ROLLBACK` around the
   * whole ingest, so the fake has to implement transactions for real: a test
   * that could not observe a rollback could not tell an atomic write path from
   * one that leaves half a remittance behind.
   *
   * The snapshot is taken on BEGIN and restored on ROLLBACK. Rows are copied
   * one level deep, which is enough because every mutation here replaces column
   * values rather than mutating a nested object in place.
   */
  async connect() {
    let snapshot = null;
    return {
      query: async (sql, params) => {
        const verb = String(sql).trim().toUpperCase();
        if (verb === 'BEGIN') {
          snapshot = new Map(
            [...this.tables].map(([name, rows]) => [name, rows.map((r) => ({ ...r }))])
          );
          this.log.push({ sql: 'BEGIN', params: [] });
          return { rows: [], rowCount: 0 };
        }
        if (verb === 'COMMIT') {
          snapshot = null;
          this.log.push({ sql: 'COMMIT', params: [] });
          return { rows: [], rowCount: 0 };
        }
        if (verb === 'ROLLBACK') {
          if (snapshot) this.tables = snapshot;
          snapshot = null;
          this.log.push({ sql: 'ROLLBACK', params: [] });
          return { rows: [], rowCount: 0 };
        }
        return this.query(sql, params);
      },
      release() {},
    };
  }

  /**
   * Evaluate one item of a VALUES list. Routes mix bound parameters with SQL
   * literals (`'pending_review'`, `now()`, `CURRENT_DATE`, `0`), so a
   * positional params[i] mapping would silently misalign every column after the
   * first literal — which is exactly the class of bug this fake exists to catch.
   */
  static literal(token, params) {
    const t = token.trim();
    let m;
    if ((m = t.match(/^\$(\d+)$/))) {
      const v = params[Number(m[1]) - 1];
      return v === undefined ? null : v;
    }
    if (/^'(.*)'$/.test(t)) return t.slice(1, -1);
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^(now\(\)|CURRENT_TIMESTAMP)$/i.test(t)) return new Date();
    if (/^CURRENT_DATE$/i.test(t)) return new Date().toISOString().slice(0, 10);
    if (/^NULL$/i.test(t)) return null;
    if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
    throw new Error(`FakeRcmDb: unsupported VALUES item: ${t}`);
  }

  /** Split a parenthesised list on TOP-LEVEL commas (nested calls survive). */
  static splitTopLevel(list) {
    const out = [];
    let depth = 0;
    let quoted = false;
    let current = '';
    for (const ch of list) {
      if (ch === "'") quoted = !quoted;
      if (!quoted && ch === '(') depth += 1;
      if (!quoted && ch === ')') depth -= 1;
      if (!quoted && depth === 0 && ch === ',') {
        out.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) out.push(current);
    return out.map((s) => s.trim());
  }

  /** Primary-key column per table, so RETURNING can hand one back. */
  static primaryKey(table) {
    return {
      rcm_remittance_keys: 'remittance_key_id',
      rcm_payment_batches: 'batch_id',
      rcm_claims: 'claim_id',
      rcm_batch_claim_payments: 'batch_claim_payment_id',
      rcm_procedure_lines: 'line_id',
      rcm_procedure_adjustments: 'adjustment_id',
      rcm_eob_uploads: 'upload_id',
    }[table];
  }

  /**
   * The UNIQUE constraints Slice 5 depends on. `ON CONFLICT DO NOTHING` is only
   * meaningful if the fake actually enforces one — otherwise the duplicate test,
   * the whole point of the slice, would pass against a broken guard.
   */
  static uniqueColumns(table) {
    return { rcm_remittance_keys: ['office_id', 'remittance_key'] }[table] || null;
  }

  async query(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.log.push({ sql: text, params: params || [] });

    let m;

    // INSERT INTO t (cols) VALUES (items) [ON CONFLICT (…) DO NOTHING] [RETURNING col]
    if (
      (m = text.match(
        /^INSERT INTO (\w+) \(([^)]+)\) VALUES \((.+?)\)(?: ON CONFLICT \(([^)]+)\) DO NOTHING)?(?: RETURNING (\w+))?$/i
      ))
    ) {
      const [, table, colList, valueList, , returning] = m;
      const cols = colList.split(',').map((s) => s.trim());
      const values = FakeRcmDb.splitTopLevel(valueList);
      if (cols.length !== values.length) {
        throw new Error(
          `FakeRcmDb: ${table} INSERT has ${cols.length} columns and ${values.length} values`
        );
      }

      /** @type {Record<string, unknown>} */
      const row = {};
      cols.forEach((c, i) => {
        row[c] = FakeRcmDb.literal(values[i], params);
      });

      const unique = FakeRcmDb.uniqueColumns(table);
      if (unique && this.table(table).some((r) => unique.every((c) => r[c] === row[c]))) {
        // ON CONFLICT DO NOTHING: no row inserted, no rows returned. Without
        // the constraint the second upload of a file would succeed silently.
        return { rows: [], rowCount: 0 };
      }

      const pk = FakeRcmDb.primaryKey(table);
      if (pk && row[pk] === undefined) row[pk] = require('crypto').randomUUID();
      // Column defaults the routes rely on but do not name in their INSERTs.
      const now = new Date();
      for (const [col, value] of [
        ['created_at', now],
        ['updated_at', now],
        ['archived_at', null],
      ]) {
        if (row[col] === undefined) row[col] = value;
      }
      if (table === 'rcm_eob_uploads' && row.uploaded_at === undefined) row.uploaded_at = now;
      if (table === 'rcm_remittance_keys' && row.posted_at === undefined) row.posted_at = now;

      this.table(table).push(row);
      return {
        rows: returning ? [{ [returning]: row[returning] }] : [],
        rowCount: 1,
      };
    }

    // UPDATE t SET a = …, b = … WHERE … [RETURNING col]
    if ((m = text.match(/^UPDATE (\w+) SET (.+?) WHERE (.+?)(?: RETURNING (\w+))?$/i))) {
      const [, table, setList, where, returning] = m;
      const assignments = FakeRcmDb.splitTopLevel(setList).map((pair) => {
        const eq = pair.indexOf('=');
        return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()];
      });
      const matched = this.table(table).filter(this.wherePredicate(where, params));
      for (const row of matched) {
        for (const [col, expr] of assignments) {
          let inner;
          if ((inner = expr.match(/^COALESCE\((.+)\)$/i))) {
            const args = FakeRcmDb.splitTopLevel(inner[1]);
            const first = FakeRcmDb.literal(args[0], params);
            row[col] = first == null ? row[args[1].trim()] : first;
          } else if ((inner = expr.match(/^array_append\((\w+), (.+)\)$/i))) {
            const existing = Array.isArray(row[inner[1]]) ? row[inner[1]] : [];
            row[col] = [...existing, FakeRcmDb.literal(inner[2], params)];
          } else {
            row[col] = FakeRcmDb.literal(expr, params);
          }
        }
      }
      return {
        rows: returning ? matched.map((r) => ({ [returning]: r[returning] })) : [],
        rowCount: matched.length,
      };
    }

    // summary.js: SELECT status, COUNT(*)::int AS n FROM t WHERE … GROUP BY status
    if ((m = text.match(/^SELECT status, COUNT\(\*\)::int AS n FROM (\w+) WHERE (.+?) GROUP BY status$/i))) {
      const rows = this.table(m[1]).filter(this.wherePredicate(m[2], params));
      /** @type {Map<string, number>} */
      const counts = new Map();
      for (const r of rows) counts.set(r.status, (counts.get(r.status) || 0) + 1);
      return { rows: [...counts].map(([status, n]) => ({ status, n })) };
    }

    // claims.js: SELECT COUNT(*)::int AS n FROM t WHERE …
    if ((m = text.match(/^SELECT COUNT\(\*\)::int AS n FROM (\w+) WHERE (.+)$/i))) {
      const rows = this.table(m[1]).filter(this.wherePredicate(m[2], params));
      return { rows: [{ n: rows.length }] };
    }

    // SELECT <cols> FROM t WHERE … [ORDER BY …] [LIMIT …] [OFFSET …]
    //
    // Covers claims.js's paginated page, era.js's upload page and its two
    // follow-up lookups, and the remittance-key protocol's `LIMIT 1` reads.
    // ORDER BY / LIMIT / OFFSET are each optional and each may be a bound
    // parameter or a literal.
    if (
      (m = text.match(
        /^SELECT (.+?) FROM (\w+) WHERE (.+?)(?: ORDER BY (.+?))?(?: LIMIT (\$\d+|\d+))?(?: OFFSET (\$\d+|\d+))?$/i
      ))
    ) {
      const [, colList, table, where, order, limitTok, offsetTok] = m;
      const cols = colList.split(',').map((s) => s.trim());
      let rows = this.table(table).filter(this.wherePredicate(where, params));
      if (order) rows = this.applyOrder(rows, order);

      const bound = (tok, fallback) => {
        if (!tok) return fallback;
        return tok.startsWith('$') ? Number(params[Number(tok.slice(1)) - 1]) : Number(tok);
      };
      const offset = bound(offsetTok, 0);
      const limit = bound(limitTok, rows.length);

      return {
        rows: rows.slice(offset, offset + limit).map((r) => {
          const out = {};
          // Project only the named columns — so a route that forgets to select
          // a column it then reads gets undefined here, like it would in pg.
          for (const c of cols) out[c] = r[c];
          return out;
        }),
      };
    }

    throw new Error(`FakeRcmDb: cannot handle: ${text}`);
  }

  /** `col DESC NULLS LAST, col2 DESC` over the two terms claims.js uses. */
  applyOrder(rows, clause) {
    const terms = clause.split(',').map((raw) => {
      const parts = raw.trim().split(/\s+/);
      return { col: parts[0], desc: parts.includes('DESC') };
    });
    return rows.slice().sort((a, b) => {
      for (const { col, desc } of terms) {
        const av = key(a[col]);
        const bv = key(b[col]);
        if (av === bv) continue;
        // NULLS LAST in both directions — what `DESC NULLS LAST` asks for, and
        // for the ASC term pg's own default.
        if (av == null) return 1;
        if (bv == null) return -1;
        const cmp = av < bv ? -1 : 1;
        return desc ? -cmp : cmp;
      }
      return 0;
    });
  }
}

function key(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  return typeof v === 'number' ? v : String(v);
}

const REGISTRY_KEYS = [
  'getUserByEmail',
  'getTenantById',
  'getTenantClinics',
  'getEnabledModules',
  'getPlatformAdminByEmail',
  'touchUserLogin',
];

/**
 * Boot the real /api/rcm stack over an ephemeral HTTP server.
 *
 * The middleware chain mirrors server.js exactly: auth gate → tenantContext →
 * requireModule('rcm') → requireReadWrite('rcm.read','rcm.write') → the real
 * router from ./index.
 *
 * @param {{
 *   modules?: string[],
 *   user?: { email: string, name?: string, tenantId?: string } | null,
 *   role?: 'admin'|'office'|'tc'|'hygiene',
 *   superAdmin?: boolean,
 *   db?: FakeRcmDb,
 *   eraStore?: { isConfigured?: () => boolean, putEraFile?: Function } | null
 * }} [opts] `user: null` boots WITHOUT the fake identity layer, so the real auth
 *   gate answers — that is how the anonymous 401 is tested. `eraStore: null`
 *   leaves the real (unconfigured) blob module in place, which is how the 503
 *   is tested.
 */
async function bootRcmApp({
  modules = ['rcm'],
  user = { email: 'billing@carein.ai', name: 'Billing User', tenantId: 'x' },
  role = 'admin',
  superAdmin = false,
  db = new FakeRcmDb(),
  eraStore = defaultEraStoreStub(),
} = {}) {
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
    token: process.env.DASHBOARD_API_TOKEN,
    eraStore: { isConfigured: eraFileStore.isConfigured, putEraFile: eraFileStore.putEraFile },
  };

  // Patched on the MODULE OBJECT, not swapped for a new one: routes/rcm/era.js
  // imports the namespace (`require('…/eraFileStore')`) precisely so a stub can
  // be installed here. A destructured import would pin the real function at
  // require time and no test could reach it.
  if (eraStore) {
    if (eraStore.isConfigured) eraFileStore.isConfigured = eraStore.isConfigured;
    if (eraStore.putEraFile) eraFileStore.putEraFile = eraStore.putEraFile;
  }

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
    superAdmin ? { email: (user && user.email) || '', status: 'active', created_at: new Date() } : null;
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
  app.use(
    '/api/rcm',
    requireModule('rcm'),
    requireReadWrite('rcm.read', 'rcm.write'),
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
            eraFileStore.isConfigured = originals.eraStore.isConfigured;
            eraFileStore.putEraFile = originals.eraStore.putEraFile;
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
 */
async function api(baseUrl, method, path, { anon = false } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: anon ? {} : { Authorization: 'Bearer test-token' },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: json };
}

/**
 * POST raw bytes — the shape POST /api/rcm/era takes, and the shape the browser
 * sends (a `File` straight into the body, name in a header).
 *
 * @param {string} baseUrl
 * @param {string} path
 * @param {string|Buffer} body
 * @param {{ filename?: string, contentType?: string, anon?: boolean }} [opts]
 */
async function postRaw(baseUrl, path, body, opts = {}) {
  const headers = opts.anon ? {} : { Authorization: 'Bearer test-token' };
  headers['Content-Type'] = opts.contentType || 'application/edi-x12';
  if (opts.filename) headers['X-RCM-Filename'] = opts.filename;

  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: json };
}

/**
 * A blob store that records what it was handed instead of reaching Azure.
 *
 * Keys are shaped like the real ones — `tenant/<slug>/rcm/era/<uuid>.edi` — so
 * a test can assert the opaqueness rule (no filename, no patient name, no
 * office in the path) against the same string production would produce.
 */
function defaultEraStoreStub() {
  const puts = [];
  const stub = {
    puts,
    isConfigured: () => true,
    putEraFile: async ({ tenantSlug, bytes, contentType }) => {
      const crypto = require('crypto');
      const put = {
        key: `tenant/${tenantSlug}/rcm/era/${crypto.randomUUID()}.edi`,
        bytes: bytes.length,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'),
        contentType,
      };
      puts.push(put);
      return put;
    },
  };
  return stub;
}

/** Audit rows written to the fake store. */
function auditRows(db) {
  return db.table('audit_log');
}

/** Read a fixture 835 from backend/test/fixtures/rcm. */
function fixture835(name) {
  return require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'test', 'fixtures', 'rcm', name),
    'utf8'
  );
}

module.exports = {
  FakeRcmDb,
  bootRcmApp,
  api,
  postRaw,
  auditRows,
  fixture835,
  defaultEraStoreStub,
};
