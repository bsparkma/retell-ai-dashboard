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
// Namespace import for the same reason: routes/rcm/matchService.js requires the
// namespace so a test can install a RECORDING Open Dental client here without
// the real registry ever resolving a customer key.
const odOffices = require('../../config/odOffices');
const odPacer = require('../../services/rcm/odPacer');
/*
 * Slice 6c. The posting config cache is PROCESS-WIDE and keyed by office, so a
 * suite that resolved roland's DefNums would otherwise hand them to the next
 * suite's valley — the one cross-office leak this whole module exists to make
 * impossible. Reset with the pacer, at both ends of a boot.
 */
const odOfficeConfig = require('../../services/rcm/odOfficeConfig');

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
  rcm_posting_queue_line: 'queue_line_id',
  rcm_remittance_keys: 'remittance_key_id',
  rcm_user_map: 'user_key',
  rcm_activity_events: 'activity_id',
});

/**
 * Columns pg would store as `jsonb` and hand back PARSED.
 *
 * Routes bind them with JSON.stringify (node-postgres wants text on the way in)
 * and read them as objects on the way out. A fake that stored the string would
 * make `Array.isArray(row.plb_adjustments)` false and
 * `snapshot.candidates.find(...)` a TypeError — i.e. it would fail a route that
 * works, which is the one thing a fake must never do.
 */
const JSONB_COLUMNS = new Set([
  'od_match_snapshot',
  'plb_adjustments',
  'engine_validation',
  'vcc_signals',
  'raw_extracted_json',
  'raw_payload',
  'raw_report',
  'frequency_limits',
  'claim_details',
  'row_details',
  // Slice 6c: the per-line read-back verdict. Stored as jsonb and READ AS AN
  // OBJECT by the queue detail route, so a fake that kept the string would make
  // `line.readback.agreed` undefined — i.e. it would report an unverified write
  // as verified-with-no-evidence, which is the exact failure the column exists
  // to make impossible.
  'readback',
  // Stage B2: the verdict read back out of the chart after a post, stored on
  // the claim. Same reason as `readback` above — the screen reads
  // `verdict.sentence` and `verdict.state` off it, so a fake that kept the
  // string would render "undefined" where a patient's balance goes.
  'confirmed_verdict',
]);

/**
 * The UNIQUE INDEXES this fake enforces on a plain INSERT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A FAKE ENFORCES CONSTRAINTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * Because a route's REFUSAL PATH is code, and code nothing exercises is code
 * that does not work. Slice 6b's approval gate translates a `23505` on the
 * claimproc index into a named 409; without the index here that translation
 * could only be reached against a live Postgres, so in the default suite it
 * would have been decorative — and the defect it fixes (a constraint doing its
 * job, surfacing to a biller as INTERNAL_ERROR) is exactly the sort that hides.
 *
 * The error is shaped like pg's: `code` and `constraint` are what the route
 * switches on, so a translation that keyed on the message would still fail here.
 *
 * `where` mirrors the index's own partial predicate. The real index is
 * `WHERE is_supplemental = false` — a supplemental deliberately MAY reuse a
 * claimproc (that is 6d's recoupment path), and a fake that refused it would
 * fail a route that works.
 *
 * @type {Record<string, Array<{ name: string, columns: string[], where?: (row: any) => boolean }>>}
 */
const UNIQUE_INDEXES = Object.freeze({
  rcm_posting_queue_line: [
    {
      name: 'rcm_posting_queue_line_claimproc_unique',
      columns: ['office_id', 'od_claim_proc_num'],
      where: (row) => row.is_supplemental !== true,
    },
    {
      name: 'rcm_posting_queue_line_position_unique',
      columns: ['queue_id', 'position'],
    },
  ],
  rcm_posting_queue: [
    { name: 'rcm_posting_queue_office_remittance_unique', columns: ['office_id', 'remittance_key'] },
  ],
});

/** Throw a pg-shaped unique violation if `row` collides with an existing one. */
function assertUniqueIndexes(table, row, existing) {
  for (const index of UNIQUE_INDEXES[table] || []) {
    if (index.where && !index.where(row)) continue;
    if (index.columns.some((c) => row[c] == null)) continue;
    const clash = existing.some(
      (r) =>
        (!index.where || index.where(r)) &&
        index.columns.every((c) => String(r[c]) === String(row[c]))
    );
    if (!clash) continue;
    const err = new Error(
      `duplicate key value violates unique constraint "${index.name}"`
    );
    // The shape routes switch on — see approvalGate.asClaimprocConflict.
    err.code = '23505';
    err.constraint = index.name;
    err.detail = `Key (${index.columns.join(', ')})=(${index.columns
      .map((c) => row[c])
      .join(', ')}) already exists.`;
    throw err;
  }
}

/*
 * ─── CHECK CONSTRAINTS THE FAKE ENFORCES ──────────────────────────────────────
 *
 * The same argument as `UNIQUE_INDEXES` above, learned the same way. A fake that
 * accepts a row real Postgres rejects turns a defect into a green test — and on
 * 2026-09-04 that is exactly what happened: the drain wrote
 * `status='paid'` onto a line that still carried `skip_reason`, every kill-and-
 * resume test passed because the fake shrugged, and the first live resume
 * stranded a plan at `partially_posted` with money correctly on the chart.
 *
 * Only constraints whose violation is REACHABLE from code under test belong
 * here. This one pairs two columns in both directions and is easy to break from
 * any code path that changes a line's status without thinking about the reason
 * beside it.
 *
 * Mirrors `migrations-tenant/1787120000000_rcm_posting_drain.js`:
 *
 *     (status IN ('skipped','skipped_already_posted') AND skip_reason IS NOT NULL)
 *  OR (status NOT IN ('skipped','skipped_already_posted') AND skip_reason IS NULL)
 *
 * @type {Record<string, Array<{ name: string, ok: (row: any) => boolean }>>}
 */
const CHECK_CONSTRAINTS = Object.freeze({
  rcm_posting_queue_line: [
    {
      name: 'rcm_posting_queue_line_skip_reason_check',
      ok: (row) => {
        // A row that names neither column cannot violate it — and an UPDATE that
        // touches only, say, od_claim_payment_num must not be judged on columns
        // it never mentioned. The caller passes the row as it WOULD be after the
        // write, so both columns are always present by then.
        const skipped = ['skipped', 'skipped_already_posted'].includes(String(row.status));
        const hasReason = row.skip_reason != null;
        return skipped === hasReason;
      },
    },
  ],
});

/** Throw a pg-shaped check violation if `row` would break one. */
function assertCheckConstraints(table, row) {
  for (const c of CHECK_CONSTRAINTS[table] || []) {
    if (c.ok(row)) continue;
    const err = new Error(
      `new row for relation "${table}" violates check constraint "${c.name}"`
    );
    err.code = '23514';
    err.constraint = c.name;
    throw err;
  }
}

/** Parse a jsonb column's bound text, exactly as pg does on the way back out. */
function coerceJsonb(col, value) {
  if (!JSONB_COLUMNS.has(col) || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

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
        // …and its opposite, which the fake could not express until Stage B's
        // "where you left off" read asked for the lines somebody has decided.
        if ((m = term.match(/^(\w+) IS NOT NULL$/))) {
          const [, col] = m;
          return (r) => r[col] != null;
        }
        // `col <> 'literal'` — runClaimMatch re-asserts the match status inside
        // its own WHERE so the check and the write are ONE statement. Without
        // this the fake could not express the guard, and the lost-confirmation
        // race would be untestable.
        if ((m = term.match(/^(\w+) <> '([^']*)'$/))) {
          const [, col, literal] = m;
          return (r) => r[col] !== literal;
        }
        // A literal, e.g. the startup sweep's `status = 'processing'`, or the
        // remittance-key protocol re-asserting the status it expects inside its
        // own WHERE — which is what makes a take-over or a release atomic
        // rather than a read-then-write.
        if ((m = term.match(/^(\w+) = '([^']*)'$/))) {
          const [, col, literal] = m;
          return (r) => r[col] === literal;
        }
        // `status IN ('uploaded', 'failed')` — the EOB retry path re-asserts the
        // statuses it is allowed to claim, which is what makes the transition
        // atomic against a concurrent re-upload.
        if ((m = term.match(/^(\w+) IN \(([^)]+)\)$/i))) {
          const [, col, list] = m;
          const allowed = [...list.matchAll(/'([^']*)'/g)].map((x) => x[1]);
          return (r) => allowed.includes(r[col]);
        }
        // `is_supplemental = false` — an UNQUOTED literal, which the quoted
        // form above does not match. The approval gate's planned-claimproc
        // probe mirrors the partial unique index's own predicate, so this is
        // how the fake expresses the same partiality.
        if ((m = term.match(/^(\w+) = (true|false)$/i))) {
          const [, col, literal] = m;
          const want = literal.toLowerCase() === 'true';
          // `!== true` rather than `=== false`: pg treats a NULL boolean as not
          // matching either literal, and the index's predicate is written the
          // permissive way round for exactly that reason.
          return (r) => (want ? r[col] === true : r[col] !== true);
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
    const raw = sql.replace(/\s+/g, ' ').trim();
    this.log.push({ sql: raw, params: params || [] });

    /*
     * `FOR UPDATE` is a LOCK HINT, and this fake is single-threaded — there is
     * nothing to lock against. It is stripped rather than rejected so real SQL
     * parses, and the UNSTRIPPED statement stays in `this.log`, which is how a
     * test asserts the lock was actually requested.
     */
    const text = raw.replace(/ FOR UPDATE$/i, '');

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
        row[c] = coerceJsonb(c, literalOrParam(values[i], params));
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

    // INSERT … ON CONFLICT (cols) DO UPDATE SET … RETURNING … — the D-5
    // rcm_user_map upsert. DO UPDATE rather than DO NOTHING because RETURNING
    // must yield a row on BOTH paths: two concurrent first actions by the same
    // biller race here, and the loser needs the winner's key back, not a 23505
    // that surfaces as a failed confirmation.
    if (
      (m = text.match(
        /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([\s\S]+?)\) ON CONFLICT \(([^)]+)\) DO UPDATE SET ([\s\S]+?)(?: RETURNING (.+))?$/i
      ))
    ) {
      const [, table, colList, valueList, conflictCols, setClause, returning] = m;
      const cols = colList.split(',').map((s) => s.trim());
      const values = splitTopLevel(valueList).map((s) => s.trim());
      if (values.length !== cols.length) {
        throw new Error(`FakeRcmDb: ${table} lists ${cols.length} columns but ${values.length} values`);
      }
      const incoming = {};
      cols.forEach((c, i) => {
        incoming[c] = coerceJsonb(c, literalOrParam(values[i], params));
      });

      const unique = conflictCols.split(',').map((s) => s.trim());
      const existing = this.table(table).find((r) => unique.every((c) => r[c] === incoming[c]));

      let row;
      if (existing) {
        row = existing;
        for (const raw of splitTopLevel(setClause)) {
          const [, col, value] = raw.trim().match(/^(\w+) = (.+)$/) || [];
          if (!col) throw new Error(`FakeRcmDb: unsupported DO UPDATE SET term: ${raw}`);
          // `EXCLUDED.col` is the value the INSERT would have written.
          const excluded = value.trim().match(/^EXCLUDED\.(\w+)$/i);
          row[col] = excluded
            ? incoming[excluded[1]]
            : coerceJsonb(col, literalOrParam(value.trim(), params, row));
        }
      } else {
        row = incoming;
        const pk = PRIMARY_KEYS[table];
        if (pk && row[pk] === undefined) row[pk] = require('crypto').randomUUID();
        if (row.created_at === undefined) row.created_at = new Date();
        this.table(table).push(row);
      }

      return { rows: returning ? [project(row, returning)] : [], rowCount: 1 };
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
        row[c] = coerceJsonb(c, literalOrParam(values[i], params));
      });
      assertUniqueIndexes(m[1], row, this.table(m[1]));
      assertCheckConstraints(m[1], row);
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

      /*
       * VALIDATE EVERY ROW BEFORE MUTATING ANY OF THEM.
       *
       * A statement that violates a constraint changes nothing in Postgres, so a
       * fake that applied the first row and then threw on the second would leave
       * a state the database can never produce — and the test written against it
       * would be a test of a fiction. `next` is the row as it WOULD be, so the
       * check sees both paired columns even when the SET touched only one.
       */
      const pending = rows.map((row) => {
        const next = { ...row };
        for (const { col, value } of assignments) {
          next[col] = coerceJsonb(col, literalOrParam(value, params, row));
        }
        return { row, next };
      });
      for (const { next } of pending) assertCheckConstraints(m[1], next);
      for (const { row, next } of pending) Object.assign(row, next);

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

    // approvalGate.js: SELECT COALESCE(SUM(col), 0)::bigint AS alias FROM t WHERE …
    //
    // Its own shape rather than the generic SELECT below, which would have
    // projected the literal aggregate expression as a column name and returned
    // `undefined` — a plan whose header total silently read 0 while its lines
    // said otherwise. The whole reason this fake refuses unknown SQL is so a
    // query it cannot really answer fails loudly instead of quietly.
    if (
      (m = text.match(
        /^SELECT COALESCE\(SUM\((\w+)\), 0\)::bigint AS (\w+) FROM (\w+) WHERE (.+)$/i
      ))
    ) {
      const [, col, alias, table, where] = m;
      const rows = this.table(table).filter(this.wherePredicate(where, params));
      const total = rows.reduce((n, r) => n + Number(r[col] || 0), 0);
      // pg hands a bigint back as a STRING; the routes' `num()` is what copes
      // with that, and a fake returning a number would hide a route that forgot.
      return { rows: [{ [alias]: String(total) }] };
    }

    /*
     * 6d: the same aggregate PLUS a filtered count, in one statement —
     *   SELECT COALESCE(SUM(col), 0)::bigint AS a,
     *          COUNT(*) FILTER (WHERE pred)::int AS b FROM t WHERE …
     *
     * `requires_check` is derived from the lines ACTUALLY WRITTEN alongside the
     * plan's total, in one round trip, so the two can never disagree about the
     * same set of rows. Modelled explicitly for the reason above: the generic
     * SELECT would project the aggregate expression as a column name and hand
     * back `undefined`, which is exactly how a plan comes to demand a check it
     * does not owe — or worse, not demand one it does.
     */
    if (
      (m = text.match(
        /^SELECT COALESCE\(SUM\((\w+)\), 0\)::bigint AS (\w+), COUNT\(\*\) FILTER \(WHERE (.+?)\)::int AS (\w+) FROM (\w+) WHERE (.+)$/i
      ))
    ) {
      const [, col, alias, filterPred, countAlias, table, where] = m;
      const rows = this.table(table).filter(this.wherePredicate(where, params));
      const total = rows.reduce((n, r) => n + Number(r[col] || 0), 0);
      // The filter is a simple `col = true|false` predicate; anything else is
      // unknown SQL and must fail loudly rather than be guessed at.
      const fm = filterPred.match(/^(\w+)\s*=\s*(true|false)$/i);
      if (!fm) throw new Error(`FakeRcmDb: unsupported FILTER predicate: ${filterPred}`);
      const want = fm[2].toLowerCase() === 'true';
      const n = rows.filter((r) => Boolean(r[fm[1]]) === want).length;
      return { rows: [{ [alias]: String(total), [countAlias]: n }] };
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

/**
 * A jsonb field pulled out under an alias — `(col->>'key')::int AS alias`.
 *
 * The claim LIST projects one integer out of `od_match_snapshot` rather than
 * shipping the whole snapshot, so the fake has to model the extraction or the
 * list tests would run against a column that is always undefined. jsonb is held
 * PARSED here (see JSONB_COLUMNS), exactly as node-postgres hands it over, so
 * the `->>`-plus-cast is a property read plus a Number().
 */
const JSONB_PROJECTION = /^\((\w+)->>'(\w+)'\)(?:::(\w+))? AS (\w+)$/;

/** Keep only the named columns, so a route reading an unselected one gets undefined. */
function project(row, colList) {
  const out = {};
  for (const c of colList.split(',').map((s) => s.trim())) {
    const m = c.match(JSONB_PROJECTION);
    if (m) {
      const [, col, field, cast, alias] = m;
      const doc = row[col];
      const value = doc && typeof doc === 'object' ? doc[field] : undefined;
      // pg returns NULL for a missing key, and `::int` on NULL is still NULL.
      out[alias] = value == null ? null : cast === 'int' ? Number(value) : String(value);
      continue;
    }
    out[c] = row[c];
  }
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

  // A BARE COLUMN NAME. `COALESCE(started_at, now())` — the drain stamps the
  // first attempt's start time and leaves it alone on every retry, so a plan
  // says when posting first began rather than when it was last tried.
  //
  // Checked before the compound forms below so a column may appear as an
  // argument to any of them.
  if (row && /^[a-z_][a-z0-9_]*$/i.test(value) && Object.prototype.hasOwnProperty.call(row, value)) {
    return row[value];
  }

  // `attempt_count = attempt_count + 1` — the drain counts its own tries in the
  // same statement that claims the row, so the count cannot drift from the
  // claim it belongs to.
  let m;
  if ((m = value.match(/^(\w+) \+ (\d+)$/))) {
    return Number((row && row[m[1]]) || 0) + Number(m[2]);
  }

  // `GREATEST(attempt_count - 1, 0)` — `releaseRow` gives back the increment
  // `claimRow` took, when the run never reached Open Dental at all. Floored,
  // because a count of tries cannot be negative however the two get out of step.
  if ((m = value.match(/^GREATEST\((\w+) - (\d+), (\d+)\)$/i))) {
    return Math.max(Number((row && row[m[1]]) || 0) - Number(m[2]), Number(m[3]));
  }

  // `COALESCE($3, batch_id)` — finalizeRemittanceKey links the batch it
  // produced without clobbering one already recorded.
  if ((m = value.match(/^COALESCE\((.+)\)$/i))) {
    const args = splitTopLevel(m[1]).map((s) => s.trim());
    const first = literalOrParam(args[0], params, row);
    // The fallback arg may be a column the row has never carried (a fresh
    // insert), so it is read directly rather than through the bare-column branch
    // above — which deliberately throws on an unknown name.
    return first == null
      ? /^\$\d+$|^'|^now\(\)$/i.test(args[1])
        ? literalOrParam(args[1], params, row)
        : row
          ? (row[args[1]] ?? null)
          : null
      : first;
  }
  // `array_append(needs_review_reasons, $3)` — a review reason discovered while
  // writing rather than while parsing.
  if ((m = value.match(/^array_append\((\w+), (.+)\)$/i))) {
    const existing = row && Array.isArray(row[m[1]]) ? row[m[1]] : [];
    return [...existing, literalOrParam(m[2].trim(), params, row)];
  }

  throw new Error(`FakeRcmDb: unsupported SET value: ${value}`);
}


/**
 * A recording stand-in for an office's Open Dental client.
 *
 * TWO jobs, and the second is the one that matters:
 *
 *  1. Answer GETs from canned, RECORDED-SHAPE rows, so the read layer is tested
 *     against what Open Dental actually returns — string enums (`Status:
 *     "Received"`, `ProcStatus: "D"`), decimal-dollar amounts, `IsTransfer`, and
 *     the `-1` "not calculated" sentinel.
 *
 *  2. REFUSE, LOUDLY, on any write verb. Slice 6a writes nothing to a chart, and
 *     the way that is enforced is a client on which every write method THROWS:
 *     a route that grows one turns a test red at the call site rather than at a
 *     code review. `calls` records every method name, so a test can assert the
 *     positive form too — that ONLY apiGetRaw was ever used.
 */
/*
 *  3. Slice 6c: OPTIONALLY MODEL THE WRITES, and model them the way the live
 *     database behaved in the Spike 0b transcript rather than the way a
 *     convenient stub would.
 *
 *     `new FakeOd({ writable: true, ... })` turns `apiWriteRaw` from a throwing
 *     recorder into a small simulator of Open Dental's posting surface, carrying
 *     the four behaviours that make posting hard and that a permissive fake
 *     would hide:
 *
 *       - `DateCP` accepts a write, returns 200, and CHANGES NOTHING       (G2)
 *       - `CheckAmt` that does not equal the eligible total is a 400   (test 5)
 *       - a PUT to a check-attached line is a 400                    (test 11)
 *       - `POST /claimpayments` returns a `ClaimPaymentNum` and attaches the
 *         eligible claimprocs to it                                (tests 4/10)
 *
 *     Every OTHER suite keeps the default (`writable` absent), where every write
 *     verb still throws — so the guard that the rest of the module cannot write
 *     is not weakened by the existence of a fake that can.
 */
class FakeOd {
  /**
   * @param {{ patients?: object[], claims?: object[], claimProcs?: object[],
   *           procedures?: object[], definitions?: object[], preferences?: object[],
   *           writable?: boolean, dieAfterWrites?: number|null,
   *           fail?: Record<string, {status:number,error:string}> }} [rows]
   */
  constructor(rows = {}) {
    this.rows = {
      patients: rows.patients || [],
      claims: rows.claims || [],
      claimProcs: rows.claimProcs || [],
      procedures: rows.procedures || [],
      definitions: rows.definitions || [],
      preferences: rows.preferences || [],
      // Slice 6d — the takeback and document lanes.
      adjustments: rows.adjustments || [],
      documents: rows.documents || [],
    };
    this.fail = rows.fail || {};
    this.writable = rows.writable === true;
    /**
     * CRASH SIMULATION. After N successful writes, every further call throws a
     * transport-shaped error — the thing a container being killed looks like
     * from inside the drain. `postingDrain.test.js` uses it to kill a run after
     * each step in turn and prove the resume completes without a duplicate write
     * or a duplicate check.
     */
    this.dieAfterWrites = rows.dieAfterWrites == null ? null : Number(rows.dieAfterWrites);
    /** 6d id sequences. Far apart so a test never confuses one kind for another. */
    this.nextAdjNum = rows.nextAdjNum || 19200;
    this.nextSupplementalNum = rows.nextSupplementalNum || 540000;
    this.nextDocNum = rows.nextDocNum || 88000;
    /**
     * THE HARDER CRASH: the write LANDS and the response is lost.
     *
     * `dieAfterWrites` models a process killed before its request reached Open
     * Dental. `dieOnLandedWrite: n` models the genuinely dangerous case — request
     * n is applied to the database and then the caller dies, so the chart has
     * changed and our row has no idea. For `POST /claimpayments` that means a
     * real check exists that the plan never recorded, and a resume that did not
     * look for it would create a second one.
     */
    this.dieOnLandedWrite = rows.dieOnLandedWrite == null ? null : Number(rows.dieOnLandedWrite);
    this.writeCount = 0;
    /** Auto-increment for the checks this fake creates. */
    this.nextClaimPaymentNum = 21300;
    /** @type {Array<{ method: string, path?: string, params?: object, body?: object }>} */
    this.calls = [];

    const record = (method) => (...args) => {
      this.calls.push({ method, path: args[0] });
      throw new Error(
        `FakeOd: this suite must not call ${method} — only services/rcm/odPostingWrites.js ` +
          'may reach an Open Dental write verb, and only through apiWriteRaw'
      );
    };

    this.client = {
      apiGetRaw: (path, params = {}, opts = {}) => this.get(path, params, opts),
      /*
       * The transport's ONE write verb (Slice 6c). Throws exactly like the other
       * write methods unless this fake was constructed `writable`, so the
       * default remains "any write is a loud test failure".
       */
      apiWriteRaw: this.writable
        ? (method, path, body = {}, opts = {}) => this.write(method, path, body, opts)
        : record('apiWriteRaw'),
      // Every other write verb the real client and its callers expose. Present
      // so a route that reaches for one gets a THROW naming the rule, rather
      // than a TypeError that reads like a missing stub.
      apiPost: record('apiPost'),
      apiPut: record('apiPut'),
      apiPatch: record('apiPatch'),
      apiDelete: record('apiDelete'),
      createCommlog: record('createCommlog'),
      bookAppointment: record('bookAppointment'),
      updateAppointment: record('updateAppointment'),
      cancelAppointment: record('cancelAppointment'),
      post: record('post'),
      put: record('put'),
      delete: record('delete'),
    };
  }

  /** The OD verb sequence this fake saw, as `"PUT /claimprocs/533930"` strings. */
  writesIssued() {
    return this.calls
      .filter((c) => c.method === 'apiWriteRaw')
      .map((c) => `${c.verb} ${c.path}`);
  }

  /**
   * Open Dental's posting surface, as the transcript recorded it.
   *
   * @param {'POST'|'PUT'} method
   * @param {string} path
   * @param {Record<string, unknown>} body
   */
  async write(method, path, body = {}) {
    const verb = String(method).toUpperCase();
    // `landed` is stamped below once the write has actually taken effect, so a
    // test can count writes that CHANGED something rather than calls attempted —
    // the two differ by exactly one on every crash, which is the difference
    // between "the resume re-wrote a line" and "the resume was fine".
    const call = { method: 'apiWriteRaw', verb, path, body, landed: false };
    this.calls.push(call);

    if (this.dieAfterWrites !== null && this.writeCount >= this.dieAfterWrites) {
      // Not a 4xx and not a 5xx — a socket dying mid-flight, which is what a
      // killed container looks like to the caller.
      const err = new Error('FakeOd: simulated process death');
      err.code = 'ECONNRESET';
      throw err;
    }
    this.writeCount += 1;

    const result = this.applyWrite(verb, path, body);
    // Only a 2xx changed anything; a modelled refusal (a CheckAmt mismatch, a
    // check-attached line) left the chart exactly as it was.
    call.landed = result.ok === true;

    /*
     * Apply the write, then LOSE THE ANSWER — see `dieOnLandedWrite`. The result
     * is computed and discarded, so the chart carries the change and the caller
     * sees a dead socket. This is the case a resume has to survive by reading
     * Open Dental rather than by remembering.
     */
    if (this.dieOnLandedWrite !== null && this.writeCount === this.dieOnLandedWrite) {
      const err = new Error('FakeOd: simulated process death AFTER the write landed');
      err.code = 'ECONNRESET';
      throw err;
    }
    return result;
  }

  /** The dispatch itself, so `write` can decide what to do with the answer. */
  applyWrite(verb, path, body) {
    let m;

    // PUT /claimprocs/{n} — test 2, test 11, test 2b.
    if ((m = path.match(/^\/claimprocs\/(\d+)$/)) && verb === 'PUT') {
      const row = this.rows.claimProcs.find((r) => Number(r.ClaimProcNum) === Number(m[1]));
      if (!row) return { ok: false, status: 404, data: null, error: 'ClaimProc not found.' };
      if (Number(row.ClaimPaymentNum || 0) !== 0 && body.InsPayAmt !== undefined) {
        // Test 11, verbatim.
        return {
          ok: false,
          status: 400,
          data: null,
          error: 'Cannot change InsPayAmt when Status is Received and attached to a ClaimPayment.',
        };
      }
      for (const field of ['Status', 'InsPayAmt', 'WriteOff', 'DedApplied']) {
        if (body[field] !== undefined) row[field] = body[field];
      }
      /*
       * G2, MODELLED. `DateCP` is accepted, answered 200, and IGNORED. A fake
       * that applied it would let a read-back "verify" a write the real database
       * silently drops — which is the exact defect the read-back exists to catch.
       */
      return { ok: true, status: 200, data: row };
    }

    // PUT /claims/{n} — test 3.
    if ((m = path.match(/^\/claims\/(\d+)$/)) && verb === 'PUT') {
      const row = this.rows.claims.find((r) => Number(r.ClaimNum) === Number(m[1]));
      if (!row) return { ok: false, status: 404, data: null, error: 'Claim not found.' };
      for (const field of ['ClaimStatus', 'DateReceived', 'ClaimNote']) {
        if (body[field] !== undefined) row[field] = body[field];
      }
      return { ok: true, status: 200, data: row };
    }

    // POST /claimpayments[/Batch] — tests 4, 5, 10.
    if ((path === '/claimpayments' || path === '/claimpayments/Batch') && verb === 'POST') {
      const claimNums =
        path === '/claimpayments/Batch'
          ? (body.claimNums || []).map(Number)
          : [Number(body.claimNum)];

      // The eligible total, exactly as Open Dental computes it: the InsPayAmt of
      // the claimprocs on these claims whose ClaimPaymentNum is 0.
      const eligible = this.rows.claimProcs.filter(
        (r) => claimNums.includes(Number(r.ClaimNum)) && Number(r.ClaimPaymentNum || 0) === 0
      );
      const total = eligible.reduce((a, r) => a + Math.round(Number(r.InsPayAmt || 0) * 100), 0);
      const asked = Math.round(Number(body.CheckAmt || 0) * 100);
      if (asked !== total) {
        // Test 5, verbatim — the highest-value negative test in the plan.
        return {
          ok: false,
          status: 400,
          data: null,
          error: 'CheckAmt does not match the total of eligible ClaimProcs.',
        };
      }

      const claimPaymentNum = this.nextClaimPaymentNum++;
      for (const row of eligible) row.ClaimPaymentNum = claimPaymentNum;
      return {
        ok: true,
        status: 201,
        // `IsPartial` comes back as the STRING "false" on the live API.
        data: { ClaimPaymentNum: claimPaymentNum, CheckAmt: body.CheckAmt, IsPartial: 'false' },
      };
    }

    /*
     * ── Slice 6d ─────────────────────────────────────────────────────────────
     */

    // POST /adjustments — Spike 0b test 8. The SIGN RULE is modelled, because it
    // is the refusal a caller that resolved the wrong AdjType would actually hit.
    if (path === '/adjustments' && verb === 'POST') {
      const def = this.rows.definitions.find(
        (d) => Number(d.Category) === 1 && Number(d.DefNum) === Number(body.AdjType)
      );
      const amount = Number(body.AdjAmt);
      if (def && def.ItemValue === '-' && amount > 0) {
        return {
          ok: false,
          status: 400,
          data: null,
          error: 'AdjAmt must be negative for this AdjType.',
        };
      }
      if (def && def.ItemValue === '+' && amount < 0) {
        return {
          ok: false,
          status: 400,
          data: null,
          error: 'AdjAmt must be positive for this AdjType.',
        };
      }
      const row = {
        AdjNum: this.nextAdjNum++,
        PatNum: Number(body.PatNum),
        AdjType: Number(body.AdjType),
        AdjAmt: amount,
        AdjDate: body.AdjDate,
        AdjNote: body.AdjNote || '',
      };
      this.rows.adjustments.push(row);
      return { ok: true, status: 201, data: row };
    }

    /*
     * POST /claimprocs/Supplemental — G10, THE ONE-WAY DOOR.
     *
     * The fake mints a NEW claimproc rather than editing the target, because
     * that is what the live API does and it is the whole reason the queue line
     * keeps `od_supplemental_claim_proc_num` separate from `od_claim_proc_num`.
     * There is deliberately no way to remove it from this fake either.
     */
    if (path === '/claimprocs/Supplemental' && verb === 'POST') {
      const claim = this.rows.claims.find((c) => Number(c.ClaimNum) === Number(body.ClaimNum));
      if (!claim) return { ok: false, status: 404, data: null, error: 'Claim not found.' };
      const row = {
        ClaimProcNum: this.nextSupplementalNum++,
        ClaimNum: Number(body.ClaimNum),
        Status: 'Supplemental',
        InsPayAmt: Number(body.InsPayAmt),
        WriteOff: 0,
        DedApplied: 0,
        ClaimPaymentNum: 0,
      };
      this.rows.claimProcs.push(row);
      return { ok: true, status: 201, data: row };
    }

    // POST /documents/Upload — Spike 0b test 9. `rawBase64` + `extension`.
    if (path === '/documents/Upload' && verb === 'POST') {
      if (!body.rawBase64) {
        return { ok: false, status: 400, data: null, error: 'rawBase64 is required.' };
      }
      const row = {
        DocNum: this.nextDocNum++,
        PatNum: Number(body.PatNum),
        DocCategory: Number(body.DocCategory),
        Description: String(body.Description || ''),
        DateCreated: body.DateCreated || null,
      };
      this.rows.documents.push(row);
      return { ok: true, status: 201, data: row };
    }

    return { ok: false, status: 400, data: null, error: `${path} ${verb} is not a valid method.` };
  }

  /** Method names this client saw, deduplicated. */
  methodsUsed() {
    return [...new Set(this.calls.map((c) => c.method))];
  }

  /** Paths this client was asked to GET, in order. */
  pathsRead() {
    return this.calls.filter((c) => c.method === 'apiGetRaw').map((c) => c.path);
  }

  async get(path, params = {}) {
    this.calls.push({ method: 'apiGetRaw', path, params });

    for (const [prefix, res] of Object.entries(this.fail)) {
      if (path.startsWith(prefix)) {
        return { ok: false, status: res.status, data: null, error: res.error };
      }
    }

    let m;
    if ((m = path.match(/^\/patients\/(\d+)$/))) {
      const found = this.rows.patients.find((p) => Number(p.PatNum) === Number(m[1]));
      return found
        ? { ok: true, status: 200, data: found }
        : { ok: false, status: 404, data: null, error: 'not found' };
    }
    // Slice 6c — the single-item claim read the drain uses for resume and for
    // the claim-receipt read-back.
    if ((m = path.match(/^\/claims\/(\d+)$/))) {
      const found = this.rows.claims.find((c) => Number(c.ClaimNum) === Number(m[1]));
      return found
        ? { ok: true, status: 200, data: found }
        : { ok: false, status: 404, data: null, error: 'Claim not found.' };
    }
    /*
     * Slice 6c — the per-office configuration reads.
     *
     * `Category` IS honoured here, and the numeric-only rule is modelled by
     * honouring ONLY the numeric form: a `category=` string filter returns the
     * unfiltered list, exactly as the live database does (§9). That is what
     * makes `odOfficeConfig`'s client-side re-filter a tested behaviour rather
     * than a comment.
     */
    if (path === '/definitions') {
      if (params.Category !== undefined) {
        return {
          ok: true,
          status: 200,
          data: this.rows.definitions.filter(
            (d) => Number(d.Category) === Number(params.Category)
          ),
        };
      }
      return { ok: true, status: 200, data: this.rows.definitions };
    }
    if (path === '/preferences') {
      // `?PrefName=` is likewise unproven against the live API, so this fake
      // ignores it — the caller re-matches by name, and that is the behaviour
      // under test.
      return { ok: true, status: 200, data: this.rows.preferences };
    }
    if (path === '/patients') {
      // OD matches names by PREFIX — modelled, because it is the single most
      // consequential behaviour of this endpoint (LName=Spark returned 18 rows
      // live, the first being "Sparkman").
      const pref = (field, value) =>
        this.rows.patients.filter((p) =>
          String(p[field] || '').toUpperCase().startsWith(String(value).toUpperCase())
        );
      if (params.LName) return { ok: true, status: 200, data: pref('LName', params.LName) };
      if (params.FName) return { ok: true, status: 200, data: pref('FName', params.FName) };
      return { ok: true, status: 200, data: this.rows.patients };
    }
    if (path === '/claims') {
      return { ok: true, status: 200, data: this.filtered('claims', params, 'PatNum') };
    }
    // Slice 6d — the two read-backs. `?PatNum=` is honoured here; the callers
    // re-filter anyway, which is the behaviour under test.
    if (path === '/adjustments') {
      return { ok: true, status: 200, data: this.filtered('adjustments', params, 'PatNum') };
    }
    if (path === '/documents') {
      return { ok: true, status: 200, data: this.filtered('documents', params, 'PatNum') };
    }
    if (path === '/claimprocs') {
      // `?ClaimPaymentNum=` is the reconciliation read (§9, verified live) and
      // takes precedence: the drain asks "what is on this check", never both.
      if (params.ClaimPaymentNum !== undefined) {
        return {
          ok: true,
          status: 200,
          data: this.filtered('claimProcs', params, 'ClaimPaymentNum'),
        };
      }
      return { ok: true, status: 200, data: this.filtered('claimProcs', params, 'ClaimNum') };
    }
    if (path === '/procedurelogs') {
      return { ok: true, status: 200, data: this.filtered('procedures', params, 'PatNum') };
    }
    return { ok: false, status: 404, data: null, error: `${path} is not a valid resource.` };
  }

  /** Apply the filter OD would apply, honouring Offset paging at 100/page. */
  filtered(bucket, params, key) {
    let rows = this.rows[bucket];
    if (params[key] !== undefined) rows = rows.filter((r) => Number(r[key]) === Number(params[key]));
    const offset = Number(params.Offset || 0);
    return rows.slice(offset, offset + 100);
  }
}

/**
 * The shadow gate's rows, exactly as the tenant migration seeds them.
 *
 * SEEDED OFF BY DEFAULT, because that is what production does. A test double
 * that defaulted to ON would make every drain test pass without the gate ever
 * being exercised — and would let a future change to the gate ship green.
 *
 * `over` sets the B2 write-off booking on BOTH offices — the one thing a drain
 * test routinely needs to vary, and varying it per office would invite a test
 * that proves roland's behaviour while asserting valley's row.
 *
 * @param {FakeRcmDb} db
 * @param {{ roland?: boolean, valley?: boolean }} [enabled]
 * @param {{ writeoff_mode?: string, writeoff_adjtype_name?: string|null }} [over]
 * @returns {FakeRcmDb}
 */
function seedOfficeSettings(db, enabled = {}, over = {}) {
  db.seed(
    'rcm_office_settings',
    ['roland', 'valley'].map((office) => ({
      office_id: office,
      merchant_fee_bps: 250,
      notes: '',
      drain_enabled: enabled[office] === true,
      drain_updated_at: null,
      drain_updated_by: null,
      /*
       * Stage B1. Seeded EXPLICITLY rather than omitted: an omitted key reads
       * as `undefined` out of the fake, which is a shape pg never produces —
       * the same lesson 6d's FakeRcmDb note records.
       */
      writeoff_mode: 'writeoff_field',
      writeoff_adjtype_name: null,
      ...over,
    }))
  );
  return db;
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
 *   role?: 'admin'|'office'|'tc'|'hygiene'|'reviewer'|'rcm_biller',
 *   superAdmin?: boolean,
 *   db?: FakeRcmDb,
 *   eraStore?: { isConfigured?: () => boolean, putEraFile?: Function } | null,
 *   od?: FakeOd | null,
 * }} [opts] `user: null` boots WITHOUT the fake identity layer, so the real auth
 *   gate answers — that is how the anonymous 401 is tested. `eraStore: null`
 *   leaves the real (unconfigured) blob module in place, which is how the 503
 *   is tested. `od: null` (the default) leaves the REAL odOffices in place,
 *   which — with no customer key in the environment — is how the honest
 *   "Open Dental is not connected for this office" refusal is tested.
 */
async function bootRcmApp({
  modules = ['rcm'],
  user = { email: 'billing@carein.ai', name: 'Billing User', tenantId: 'x' },
  role = 'admin',
  superAdmin = false,
  db = new FakeRcmDb(),
  eraStore = defaultEraStoreStub(),
  od = null,
} = {}) {
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
    token: process.env.DASHBOARD_API_TOKEN,
    eraStore: { isConfigured: eraFileStore.isConfigured, putEraFile: eraFileStore.putEraFile },
    getOdOffice: odOffices.getOdOffice,
  };

  /*
   * PACE AT 1ms IN ROUTE TESTS.
   *
   * The production floor is 1200ms per Open Dental call, which is correct and
   * non-negotiable — but a route suite that pays it takes two minutes to prove
   * things that have nothing to do with timing. The pacer's MECHANISM
   * (serialization, observed spacing) and its FLOOR (no env var can lower it)
   * are proven independently in services/rcm/odPacer.test.js, so neither can be
   * satisfied by this override.
   *
   * The queue is still real here: calls still serialize, so a route that
   * accidentally fanned out would still be caught.
   */
  odPacer._resetForTests();
  odPacer._setIntervalForTests(1);
  odOfficeConfig._resetForTests();

  // The office's OWN client, faked. `getOdOffice` is what the per-office
  // registry hands out, and `assertOfficeMatch` is left REAL — so a route that
  // forgot the office assertion still fails its test rather than passing on a
  // stub that never checks.
  if (od) {
    odOffices.getOdOffice = (key) =>
      Object.freeze({
        officeKey: key,
        officeName: key === 'valley' ? 'Riley Family Dental' : 'Roland Family Dental',
        commTypeDefNum: key === 'valley' ? 451 : 486,
        client: od.client,
      });
  }

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
  // The mount mirrors server.js EXACTLY, exempt list included — the D-9 queue
  // tier is only real if the tests boot the same gate production does.
  const rcmRouter = require('./index');
  app.use(
    '/api/rcm',
    requireModule('rcm'),
    requireReadWrite('rcm.read', 'rcm.write', { writeExempt: rcmRouter.QUEUE_PATHS }),
    rcmRouter
  );

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        db,
        od,
        close: () =>
          new Promise((r) => {
            for (const k of REGISTRY_KEYS) registry[k] = originals.registry[k];
            tenantDb.withTenantDb = originals.withTenantDb;
            eraFileStore.isConfigured = originals.eraStore.isConfigured;
            eraFileStore.putEraFile = originals.eraStore.putEraFile;
            odOffices.getOdOffice = originals.getOdOffice;
            odPacer._resetForTests();
            odOfficeConfig._resetForTests();
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
async function api(baseUrl, method, path, { anon = false, body, json = false, raw = false } = {}) {
  const headers = anon ? {} : { Authorization: 'Bearer test-token' };
  // `json: true` sets the header EXPLICITLY, and only then. A multipart body
  // must be left to undici so it can set its own boundary — declaring a
  // Content-Type by hand is the classic way to make an upload 400.
  if (json) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${baseUrl}${path}`, { method, headers, body });

  // `raw: true` for the document proxy, whose successful response is PDF or
  // EDI bytes with a Content-Disposition — reading it as JSON would discard
  // exactly what the test is about.
  if (raw) {
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      bytes: Buffer.from(await res.arrayBuffer()),
    };
  }

  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: parsed, headers: Object.fromEntries(res.headers.entries()) };
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
  seedOfficeSettings,
  FakeOd,
  bootRcmApp,
  api,
  auditRows,
  filePart,
  syntheticPdf,
  defaultEraStoreStub,
  fixture835,
};
