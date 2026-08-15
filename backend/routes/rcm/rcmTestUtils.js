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
 * Primary key per rcm_* table, from the Slice 1 migration. The fake mints a
 * uuid for THESE columns on insert (as `gen_random_uuid()` would) and for no
 * others — see the RETURNING branch in query().
 */
const PRIMARY_KEYS = Object.freeze({
  rcm_eob_uploads: 'upload_id',
  rcm_claims: 'claim_id',
  rcm_procedure_lines: 'line_id',
  rcm_procedure_adjustments: 'adjustment_id',
  rcm_payment_batches: 'batch_id',
  rcm_batch_claim_payments: 'batch_claim_payment_id',
  rcm_bank_transactions: 'bank_transaction_id',
  rcm_posting_queue: 'queue_id',
  rcm_remittance_keys: 'remittance_key_id',
});

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
    /**
     * Snapshot taken at BEGIN and restored at ROLLBACK.
     *
     * Transactions are SIMULATED, not faked away, and that is the point: Slice
     * 4 commits a claim, its lines, its adjustments, the batch, the batch links
     * AND the upload's 'extracted' flip together. "All of that is atomic" is
     * only a testable claim if a rollback actually undoes it here.
     * @type {Map<string, Array<Record<string, unknown>>>|null}
     */
    this.snapshot = null;
    /** Query index at which to throw, for atomicity tests. @type {null|((sql: string) => boolean)} */
    this.failWhen = null;
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
        // A literal, e.g. the startup sweep's `status = 'processing'`, or the
        // remittance-key protocol re-asserting the status it expects inside its
        // own WHERE — which is what makes a take-over or a release atomic
        // rather than a read-then-write.
        if ((m = term.match(/^(\w+) = '([^']*)'$/))) {
          const [, col, literal] = m;
          return (r) => r[col] === literal;
        }
        // `era_file_key = ANY($2::text[])` — era.js's list joins a page of
        // uploads back to the batches they produced.
        if ((m = term.match(/^(\w+) = ANY\(\$(\d+)(?:::\w+\[\])?\)$/))) {
          const [, col, idx] = m;
          const list = params[idx - 1];
          return (r) => Array.isArray(list) && list.includes(r[col]);
        }
        throw new Error(`FakeRcmDb: unsupported WHERE term: ${term}`);
      });
    return (r) => checks.every((c) => c(r));
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  async query(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.log.push({ sql: text, params: params || [] });

    if (this.failWhen && this.failWhen(text)) {
      throw new Error(`FakeRcmDb: injected failure on: ${text.slice(0, 60)}`);
    }

    let m;

    // ── Transaction control ─────────────────────────────────────────────────
    if (/^BEGIN$/i.test(text)) {
      this.snapshot = new Map([...this.tables].map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(text)) {
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK$/i.test(text)) {
      if (this.snapshot) this.tables = this.snapshot;
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }

    // The audit row (platform/audit.js) and every rcm_* INSERT.
    //
    // Each column is bound to ITS OWN slot in the VALUES tuple, not to its
    // ordinal position in the column list. Those differ the moment a literal
    // appears in the tuple (`… , 'uploaded')`), and binding by ordinal quietly
    // handed such a column `undefined` — which reads as a route that forgot to
    // set a NOT NULL field rather than as a fake that cannot parse SQL.

    // INSERT … ON CONFLICT (cols) DO NOTHING [RETURNING col] — the remittance
    // key's reservation, and the ONE place the fake has to enforce a UNIQUE
    // constraint. Without it the second upload of a file would silently insert
    // a second key and the dedupe test, the point of Slice 5, would pass
    // against a broken guard.
    if (
      (m = text.match(
        /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([\s\S]+?)\) ON CONFLICT \(([^)]+)\) DO NOTHING(?: RETURNING (.+))?$/i
      ))
    ) {
      const [, table, colList, valueList, conflictCols, returning] = m;
      const cols = colList.split(',').map((s) => s.trim());
      const values = splitTopLevel(valueList).map((s) => s.trim());
      if (values.length !== cols.length) {
        throw new Error(`FakeRcmDb: ${table} lists ${cols.length} columns but ${values.length} values`);
      }
      const row = {};
      cols.forEach((c, i) => {
        row[c] = literalOrParam(values[i], params);
      });

      const unique = conflictCols.split(',').map((s) => s.trim());
      if (this.table(table).some((r) => unique.every((c) => r[c] === row[c]))) {
        return { rows: [], rowCount: 0 };
      }

      const pk = PRIMARY_KEYS[table];
      if (pk && row[pk] === undefined) row[pk] = require('crypto').randomUUID();
      this.table(table).push(row);
      return {
        rows: returning ? [project(row, returning)] : [],
        rowCount: 1,
      };
    }

    if ((m = text.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES (.+)$/i))) {
      const cols = m[2].split(',').map((s) => s.trim());
      const tuple = m[3].match(/^\(([\s\S]*?)\)(?:\s+RETURNING|$)/);
      if (!tuple) throw new Error(`FakeRcmDb: cannot parse VALUES of: ${text}`);
      const values = splitTopLevel(tuple[1]).map((s) => s.trim());
      if (values.length !== cols.length) {
        throw new Error(
          `FakeRcmDb: ${m[1]} lists ${cols.length} columns but ${values.length} values`
        );
      }
      const row = {};
      cols.forEach((c, i) => {
        row[c] = literalOrParam(values[i], params);
      });
      this.table(m[1]).push(row);

      const returning = m[3].match(/RETURNING (.+)$/i);
      if (!returning) return { rows: [], rowCount: 1 };

      // Fill the columns pg would have DEFAULTED, so a route reading
      // `RETURNING upload_id` gets an id rather than undefined.
      //
      // Only the declared PRIMARY KEY gets a generated uuid. Minting one for
      // every `*_id` column would hand back a `result_claim_id` on a row that
      // has not been extracted — i.e. it would fabricate the exact linkage this
      // slice is careful never to claim before it exists.
      const out = {};
      for (const col of returning[1].split(',').map((s) => s.trim())) {
        if (col in row) {
          out[col] = row[col];
          continue;
        }
        if (PRIMARY_KEYS[m[1]] === col) row[col] = require('crypto').randomUUID();
        else if (/_at$/.test(col)) row[col] = new Date();
        else row[col] = null;
        out[col] = row[col];
      }
      return { rows: [out], rowCount: 1 };
    }

    // UPDATE t SET a = $n | 'literal' | NULL | now() WHERE <terms> [RETURNING <cols>]
    if ((m = text.match(/^UPDATE (\w+) SET (.+?) WHERE (.+?)(?: RETURNING (.+))?$/i))) {
      const assignments = splitTopLevel(m[2]).map((raw) => {
        const [, col, value] = raw.trim().match(/^(\w+) = (.+)$/) || [];
        if (!col) throw new Error(`FakeRcmDb: unsupported SET term: ${raw}`);
        return { col, value: value.trim() };
      });
      const rows = this.table(m[1]).filter(this.wherePredicate(m[3], params));
      for (const row of rows) {
        for (const { col, value } of assignments) {
          row[col] = literalOrParam(value, params, row);
        }
      }
      return {
        rows: m[4] ? rows.map((r) => project(r, m[4])) : [],
        rowCount: rows.length,
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

    // eob.js dedup probe: SELECT <cols> FROM t WHERE … ORDER BY … LIMIT <n>
    if ((m = text.match(/^SELECT (.+?) FROM (\w+) WHERE (.+?) ORDER BY (.+?) LIMIT (\d+)$/i))) {
      let rows = this.table(m[2]).filter(this.wherePredicate(m[3], params));
      rows = this.applyOrder(rows, m[4]);
      return { rows: rows.slice(0, Number(m[5])).map((r) => project(r, m[1])) };
    }

    // claims.js: SELECT <cols> FROM t WHERE … ORDER BY … LIMIT $n OFFSET $n
    if (
      (m = text.match(
        /^SELECT (.+?) FROM (\w+) WHERE (.+?) ORDER BY (.+?) LIMIT \$(\d+) OFFSET \$(\d+)$/i
      ))
    ) {
      const cols = m[1].split(',').map((s) => s.trim());
      let rows = this.table(m[2]).filter(this.wherePredicate(m[3], params));
      rows = this.applyOrder(rows, m[4]);
      const limit = Number(params[m[5] - 1]);
      const offset = Number(params[m[6] - 1]);
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

    // era.js's three shapes, which the patterns above do not cover: an
    // ORDER BY with no LIMIT (the batches for a page of uploads), a literal
    // LIMIT with no ORDER BY (the remittance-key lookups), and a WHERE
    // containing parentheses (`… = ANY($2::uuid[])`).
    //
    // AFTER the narrower shapes above so they still win, and BEFORE the bare
    // fallback below, which would swallow a trailing ORDER BY into the WHERE.
    if (
      (m = text.match(
        /^SELECT (.+?) FROM (\w+) WHERE (.+?)(?: ORDER BY ([\w, ]+?(?: (?:ASC|DESC)(?: NULLS LAST)?)?))?(?: LIMIT (\$?\d+))?(?: OFFSET (\$?\d+))?$/i
      ))
    ) {
      const [, colList, table, where, order, limitTok, offsetTok] = m;
      let rows = this.table(table).filter(this.wherePredicate(where, params));
      if (order) rows = this.applyOrder(rows, order);

      const bound = (tok, fallback) => {
        if (!tok) return fallback;
        return tok.startsWith('$') ? Number(params[Number(tok.slice(1)) - 1]) : Number(tok);
      };
      const offset = bound(offsetTok, 0);
      const limit = bound(limitTok, rows.length);
      return { rows: rows.slice(offset, offset + limit).map((r) => project(r, colList)) };
    }

    // eobExtractionWorker's single-row read: SELECT <cols> FROM t WHERE <terms>.
    // LAST, so the narrower ORDER BY / LIMIT / COUNT shapes above win — this
    // pattern would otherwise swallow their trailing clauses into the WHERE.
    if ((m = text.match(/^SELECT ([\w, ]+) FROM (\w+) WHERE ([^()]+)$/i))) {
      const rows = this.table(m[2]).filter(this.wherePredicate(m[3], params));
      return { rows: rows.map((r) => project(r, m[1])) };
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

/** Keep only the named columns, so a route reading an unselected one gets undefined. */
function project(row, colList) {
  const out = {};
  for (const c of colList.split(',').map((s) => s.trim())) out[c] = row[c];
  return out;
}

/** Split a SET clause on commas that are not inside parentheses (`now()`, casts). */
function splitTopLevel(clause) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of clause) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Resolve the right-hand side of a SET assignment, or one item of a VALUES
 * tuple. `row` is the row being updated, needed only by COALESCE.
 */
function literalOrParam(value, params, row) {
  if (/^\$\d+$/.test(value)) return params[Number(value.slice(1)) - 1] ?? null;
  if (/^NULL$/i.test(value)) return null;
  if (/^now\(\)$/i.test(value)) return new Date();
  if (/^CURRENT_DATE$/i.test(value)) return new Date().toISOString().slice(0, 10);
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  const quoted = value.match(/^'(.*)'$/);
  if (quoted) return quoted[1];

  // `COALESCE($3, batch_id)` — finalizeRemittanceKey links the batch it
  // produced without clobbering one already recorded.
  let m;
  if ((m = value.match(/^COALESCE\((.+)\)$/i))) {
    const args = splitTopLevel(m[1]).map((s) => s.trim());
    const first = literalOrParam(args[0], params, row);
    return first == null ? (row ? row[args[1]] : null) : first;
  }
  // `array_append(needs_review_reasons, $3)` — a review reason discovered while
  // writing rather than while parsing.
  if ((m = value.match(/^array_append\((\w+), (.+)\)$/i))) {
    const existing = row && Array.isArray(row[m[1]]) ? row[m[1]] : [];
    return [...existing, literalOrParam(m[2].trim(), params, row)];
  }

  throw new Error(`FakeRcmDb: unsupported SET value: ${value}`);
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
 *
 * `body` is passed through untouched — pass a FormData to exercise the
 * multipart upload path, and let undici set the boundary (setting
 * Content-Type by hand is the classic way to break a multipart request).
 */
async function api(baseUrl, method, path, { anon = false, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: anon ? {} : { Authorization: 'Bearer test-token' },
    body,
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
 * A multipart body carrying one file, as a browser would send it.
 * @param {Buffer} bytes
 * @param {string} filename
 * @param {string} [contentType]
 * @param {string} [field]
 */
function filePart(bytes, filename, contentType = 'application/pdf', field = 'file') {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type: contentType }), filename);
  return form;
}

/**
 * A minimal, VALID PDF whose text layer says `text`.
 *
 * Built by hand rather than committed as a fixture so no binary blob enters the
 * repo, and so a test can state in one line exactly what the extractor will
 * see. Padded past the route's 256-byte floor. NEVER contains a real name.
 * @param {string} text
 */
function syntheticPdf(text = 'SYNTHETIC EOB') {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const body =
    '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]' +
    '/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n' +
    '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
    `5 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n` +
    'trailer<</Root 1 0 R>>\n' +
    `% padding ${'-'.repeat(300)}\n`;
  return Buffer.from(body, 'latin1');
}

/** Audit rows written to the fake store. */
function auditRows(db) {
  return db.table('audit_log');
}

/**
 * A blob store that records what it was handed instead of reaching Azure.
 *
 * Keys are shaped like the real ones — `tenant/<slug>/rcm/era/<uuid>.edi` — so
 * a test can assert the opaqueness rule (no filename, no patient name, no
 * office in the path) against the same string production would produce.
 */
function defaultEraStoreStub() {
  const crypto = require('crypto');
  const puts = [];
  return {
    puts,
    isConfigured: () => true,
    putEraFile: async ({ tenantSlug, bytes, contentType }) => {
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
  auditRows,
  filePart,
  syntheticPdf,
  defaultEraStoreStub,
  fixture835,
};
