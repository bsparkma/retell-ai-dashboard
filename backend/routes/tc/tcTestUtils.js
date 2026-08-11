'use strict';

/**
 * Test harness for the /api/tc route families.
 *
 * Follows the platform's harness pattern (moduleGateWiring.test.js /
 * audit.test.js): a REAL ephemeral HTTP server running the REAL tenantContext
 * + requireModule middlewares and the real routers, with the registry stubbed
 * and the per-tenant Pool replaced by FakeTenantDb — an in-memory store that
 * executes the routes' actual SQL (INSERT/SELECT/UPDATE/DELETE with
 * office_id-scoped WHEREs), so CRUD round-trips, office-scoping denials and
 * audit-row writes are exercised end to end without a Postgres in CI
 * (backend unit tests run before the ephemeral DB exists — see
 * .github/workflows/staging.yml).
 *
 * NOT a test file (no .test suffix) — node --test must not run it directly.
 */

const express = require('express');

const registry = require('../../platform/registry');
const tenantDb = require('../../platform/tenantDb');
const userContext = require('../../platform/userContext');
const { tenantContext, requireModule } = require('../../middleware/tenantContext');

/** Columns stored as jsonb — real pg returns objects, so the fake must too. */
const JSONB_COLS = new Set(['blocks', 'value', 'detail', 'legacy_snapshot']);

/** Comparable scalar for a cell (Date → epoch ms, null → sorts last like pg's default). */
function sortKey(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  return typeof v === 'number' ? v : String(v);
}

/**
 * Apply an `ORDER BY a DESC, b, c DESC` clause. Ties fall through to the next
 * term and finally to insertion order (Array.prototype.sort is stable), which
 * matches what a real query with a fully-tied ORDER BY may return.
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} clause
 */
function sortRows(rows, clause) {
  const terms = clause.split(',').map((raw) => {
    const [col, dir] = raw.trim().split(/\s+/);
    return { col, desc: (dir || '').toUpperCase() === 'DESC' };
  });
  return rows.slice().sort((a, b) => {
    for (const { col, desc } of terms) {
      const av = sortKey(a[col]);
      const bv = sortKey(b[col]);
      if (av === bv) continue;
      // NULLS LAST on ASC, NULLS FIRST on DESC — Postgres's default ordering.
      if (av == null) return desc ? -1 : 1;
      if (bv == null) return desc ? 1 : -1;
      const cmp = av < bv ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return 0;
  });
}

class FakeTenantDb {
  constructor() {
    /** @type {Map<string, Array<Record<string, unknown>>>} */
    this.tables = new Map();
    /** @type {Array<{ sql: string, params: unknown[] }>} */
    this.log = [];
    /** @type {Array<{ regex: RegExp, fn: (text: string, params: unknown[]) => { rows: unknown[] } }>} */
    this.overrides = [];
  }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
  }

  onQuery(regex, fn) {
    this.overrides.push({ regex, fn });
  }

  /** Pool.connect() → a client backed by the same store (tx statements no-op). */
  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  /** Predicate for a WHERE clause over the supported term shapes. */
  wherePredicate(clause, params) {
    const terms = clause.split(/ AND /i).map((t) => t.trim());
    const checks = terms.map((term) => {
      let m;
      if ((m = term.match(/^\(\s*(\w+) = \$(\d+) OR (\w+) = \$(\d+)\s*\)$/))) {
        const [, a, ai, b, bi] = m;
        return (r) => r[a] === params[ai - 1] || r[b] === params[bi - 1];
      }
      // `col = ANY($n)` — the parameterized IN-list form (open-status filter).
      if ((m = term.match(/^(\w+) = ANY\(\$(\d+)\)$/))) {
        const [, col, idx] = m;
        return (r) => {
          const set = params[idx - 1];
          return Array.isArray(set) && set.includes(r[col]);
        };
      }
      if ((m = term.match(/^(\w+) = \$(\d+)$/))) {
        const [, col, idx] = m;
        return (r) => r[col] === params[idx - 1];
      }
      if ((m = term.match(/^(\w+) <= \$(\d+)$/))) {
        const [, col, idx] = m;
        return (r) => String(r[col]) <= String(params[idx - 1]);
      }
      if ((m = term.match(/^(\w+) = '([^']*)'$/))) {
        const [, col, lit] = m;
        return (r) => r[col] === lit;
      }
      if ((m = term.match(/^(\w+) IS NULL$/))) {
        const [, col] = m;
        return (r) => r[col] == null;
      }
      if ((m = term.match(/^(\w+) IS NOT NULL$/))) {
        const [, col] = m;
        return (r) => r[col] != null;
      }
      if ((m = term.match(/^(\w+) != '([^']*)'$/))) {
        const [, col, lit] = m;
        return (r) => r[col] !== lit;
      }
      throw new Error(`FakeTenantDb: unsupported WHERE term: ${term}`);
    });
    return (r) => checks.every((c) => c(r));
  }

  /** Apply a SET list to a row (supports $n, now(), and the CASE forms used). */
  applySets(row, setClause, params) {
    const parts = setClause.split(/,(?![^(]*\))/).map((s) => s.trim());
    for (const part of parts) {
      let m;
      if ((m = part.match(/^(\w+) = \$(\d+)(?:::\w+)?$/))) {
        row[m[1]] = params[m[2] - 1];
      } else if ((m = part.match(/^(\w+) = now\(\)$/))) {
        row[m[1]] = new Date();
      } else if ((m = part.match(/^(\w+) = '([^']*)'$/))) {
        row[m[1]] = m[2];
      } else if (
        (m = part.match(
          /^(\w+) = CASE WHEN \$(\d+)(?: AND (\w+) IS NULL)? THEN (?:\$(\d+)(?:::\w+)?|CURRENT_DATE) ELSE \w+ END$/
        ))
      ) {
        const [, col, condIdx, nullCol, valIdx] = m;
        const cond = Boolean(params[condIdx - 1]) && (!nullCol || row[nullCol] == null);
        if (cond) row[col] = valIdx ? params[valIdx - 1] : new Date().toISOString().slice(0, 10);
      } else if ((m = part.match(/^(\w+) = EXCLUDED\.(\w+)$/))) {
        // handled by the upsert path; ignore here
      } else {
        throw new Error(`FakeTenantDb: unsupported SET term: ${part}`);
      }
    }
  }

  async query(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.log.push({ sql: text, params: params || [] });

    for (const o of this.overrides) {
      if (o.regex.test(text)) return o.fn(text, params || []);
    }

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) return { rows: [], rowCount: 0 };

    let m;

    // Media-proxy ownership probe (UNION across the two blob-key tables).
    if (/^SELECT 1 FROM tc_gallery_cases .*UNION ALL SELECT 1 FROM tc_smile_simulations/i.test(text)) {
      const [office, key] = params;
      const inGallery = this.table('tc_gallery_cases').some(
        (r) => r.office_id === office && (r.before_blob_key === key || r.after_blob_key === key)
      );
      const inSims = this.table('tc_smile_simulations').some(
        (r) => r.office_id === office && (r.original_blob_key === key || r.result_blob_key === key)
      );
      return { rows: inGallery || inSims ? [{ '?column?': 1 }] : [] };
    }

    // Upsert (tc_library_config).
    if (
      (m = text.match(
        /^INSERT INTO (\w+) \(([^)]+)\) VALUES \([^)]+\) ON CONFLICT \(([^)]+)\) DO UPDATE SET .+?(?: RETURNING (.+))?$/i
      ))
    ) {
      const table = m[1];
      const cols = m[2].split(',').map((s) => s.trim());
      const conflictCols = m[3].split(',').map((s) => s.trim());
      const row = {};
      cols.forEach((c, i) => {
        row[c] = JSONB_COLS.has(c) && typeof params[i] === 'string' ? JSON.parse(params[i]) : params[i];
      });
      const rows = this.table(table);
      const existing = rows.find((r) => conflictCols.every((c) => r[c] === row[c]));
      let result;
      if (existing) {
        Object.assign(existing, row, { updated_at: new Date() });
        result = existing;
      } else {
        row.created_at = new Date();
        row.updated_at = new Date();
        rows.push(row);
        result = row;
      }
      return { rows: [{ ...result }], rowCount: 1 };
    }

    // INSERT.
    if ((m = text.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES/i))) {
      const table = m[1];
      const cols = m[2].split(',').map((s) => s.trim());
      const row = {};
      cols.forEach((c, i) => {
        const v = params[i] === undefined ? null : params[i];
        row[c] = JSONB_COLS.has(c) && typeof v === 'string' ? JSON.parse(v) : v;
      });
      if (!('created_at' in row)) row.created_at = new Date();
      if (!('updated_at' in row)) row.updated_at = new Date();
      this.table(table).push(row);
      return { rows: [], rowCount: 1 };
    }

    // DELETE.
    if ((m = text.match(/^DELETE FROM (\w+) WHERE (.+?)(?: RETURNING (.+))?$/i))) {
      const table = m[1];
      const pred = this.wherePredicate(m[2], params);
      const rows = this.table(table);
      const removed = rows.filter(pred);
      this.tables.set(
        table,
        rows.filter((r) => !pred(r))
      );
      return { rows: m[3] ? removed.map((r) => ({ ...r })) : [], rowCount: removed.length };
    }

    // UPDATE.
    if ((m = text.match(/^UPDATE (\w+) SET (.+) WHERE (.+?)(?: RETURNING (.+))?$/i))) {
      const table = m[1];
      const pred = this.wherePredicate(m[3], params);
      const matched = this.table(table).filter(pred);
      for (const row of matched) this.applySets(row, m[2], params);
      return { rows: m[4] ? matched.map((r) => ({ ...r })) : [], rowCount: matched.length };
    }

    // SELECT (single table; JOIN queries need a per-test override).
    if ((m = text.match(/^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY ([^)]+?))?(?: LIMIT (\d+))?$/i))) {
      if (/ JOIN /i.test(text)) {
        throw new Error(`FakeTenantDb: JOIN queries need an onQuery override: ${text}`);
      }
      const table = m[2];
      let rows = this.table(table).slice();
      if (m[3]) rows = rows.filter(this.wherePredicate(m[3], params));
      // ORDER BY and LIMIT are APPLIED, not ignored: "the most recently active
      // open case" and "newest 500" are behaviours the routes rely on, and a
      // harness that silently returns insertion order would pass a test the
      // real database fails.
      if (m[4]) rows = sortRows(rows, m[4]);
      if (m[5]) rows = rows.slice(0, Number(m[5]));
      return { rows: rows.map((r) => ({ ...r })) };
    }

    throw new Error(`FakeTenantDb: cannot handle: ${text}`);
  }
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
 * Boot the real /api/tc stack over an ephemeral HTTP server.
 *
 * `role` is the caller's app_user.role (Roles PR A). It defaults to 'admin' so
 * every pre-roles test keeps exercising the full surface; the role-gating tests
 * pass 'hygiene' / 'tc' to check the tc.full vs tc.hygiene split.
 *
 * @param {{
 *   modules?: string[],
 *   user?: { email: string, name?: string, tenantId?: string } | null,
 *   role?: 'admin'|'office'|'tc'|'hygiene',
 *   superAdmin?: boolean,
 *   db?: FakeTenantDb
 * }} [opts]
 * @returns {Promise<{ baseUrl: string, db: FakeTenantDb, close: () => Promise<void> }>}
 */
async function bootTcApp({
  modules = ['tc'],
  user = { email: 'tc@carein.ai', name: 'TC User', tenantId: 'x' },
  role = 'admin',
  superAdmin = false,
  db = new FakeTenantDb(),
} = {}) {
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
  };

  registry.getUserByEmail = async () => ({
    user_id: 'U1',
    tenant_id: 'T1',
    email: user && user.email,
    role,
    status: 'active',
  });
  registry.getTenantById = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN', status: 'active' });
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => modules;
  registry.getPlatformAdminByEmail = async () =>
    superAdmin ? { email: (user && user.email) || '', status: 'active', created_at: new Date() } : null;
  registry.touchUserLogin = async () => {};
  // The identity cache is process-wide; a stale entry from a previous boot
  // would answer this app's lookups with the previous test's role.
  userContext.clearCache();
  tenantDb.withTenantDb = async (_req, fn) => fn(db);

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  if (user) {
    app.use('/api', (req, _res, next) => {
      req.user = user;
      next();
    });
  }
  app.use('/api', tenantContext());
  app.use('/api/tc', requireModule('tc'), require('./index'));

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
            server.close(r);
          }),
      });
    });
  });
}

/** JSON fetch helper. */
async function api(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body (media stream tests read separately)
  }
  return { status: res.status, body: json };
}

/** Audit rows written to the fake store. */
function auditRows(db) {
  return db.table('audit_log');
}

module.exports = { FakeTenantDb, bootTcApp, api, auditRows };
