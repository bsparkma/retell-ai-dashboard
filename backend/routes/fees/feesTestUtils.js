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
    // ── Slice 3: posting. Order matters — the COUNT/aggregate form must be
    //    matched before the generic row SELECT, and the UPDATEs before anything.
    if (/^UPDATE fees_import_batch/i.test(text)) return this.updateBatch(text, params);
    if (/^UPDATE fees_import_row/i.test(text)) return this.updateRow(text, params);
    if (/^UPDATE fees_od_backup/i.test(text)) return this.updateBackup(params);
    if (/^INSERT INTO fees_od_backup/i.test(text)) return this.insertBackup(params);
    if (/^SELECT [\s\S]*FROM fees_od_backup/i.test(text)) return this.selectBackup(params);
    if (/^SELECT COUNT\(\*\)::int AS n[\s\S]*FROM fees_import_row/i.test(text)) {
      return this.countBlocking(params);
    }
    if (/^SELECT COUNT\(\*\)::int AS total/i.test(text)) return this.summarise(params);

    if (/^SELECT [\s\S]*FROM fees_import_batch/i.test(text)) return this.selectBatches(text, params);
    if (/^SELECT [\s\S]*FROM fees_import_row/i.test(text)) return this.selectRows(text, params);

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
      // Slice 3's columns, at their migration defaults. `rows_written` is 0 and
      // NOT NULL in every state, which is the whole point of it: a post_failed
      // batch can never be read as "nothing was written" because the number is
      // always there.
      od_feesched_num: null,
      od_feesched_desc: null,
      od_feesched_is_new: false,
      rows_written: 0,
      post_error: null,
      posting_started_at: null,
      posted_at: null,
      posted_by: null,
      rolled_back_at: null,
      rolled_back_by: null,
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
        // Slice 3's columns, at their migration defaults. A CLEAN row is
        // postable while still 'pending' — the gate is warned-AND-pending, not
        // a checklist — which is why every row starts here and only the warned
        // ones ever need a click.
        decision: 'pending',
        decided_by: null,
        decided_at: null,
        od_fee_num: null,
        written_at: null,
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

  selectRows(text, params) {
    let rows = this.table('fees_import_row').filter(
      (r) => r.office === params[0] && r.batch_id === params[1]
    );
    // The job's own scans narrow further. Recognised by their WHERE text rather
    // than guessed, so a statement this fake does not understand is a loud
    // failure instead of a quietly wrong row set.
    if (/decision <> 'excluded'/.test(text)) rows = rows.filter((r) => r.decision !== 'excluded');
    if (/od_fee_num IS NOT NULL/.test(text)) {
      rows = rows.filter((r) => r.od_fee_num !== null && r.od_fee_num !== undefined);
    }
    rows = [...rows].sort((a, b) => a.row_order - b.row_order);
    return { rows, rowCount: rows.length };
  }

  // ── Slice 3: posting ──────────────────────────────────────────────────────

  /** Warned AND undecided — the predicate the gate and the job both use. */
  isBlocking(row) {
    const warnings = Array.isArray(row.parse_warnings) ? row.parse_warnings : [];
    return warnings.length > 0 && row.decision === 'pending';
  }

  countBlocking(params) {
    const n = this.table('fees_import_row').filter(
      (r) => r.office === params[0] && r.batch_id === params[1] && this.isBlocking(r)
    ).length;
    return { rows: [{ n }], rowCount: 1 };
  }

  summarise(params) {
    const rows = this.table('fees_import_row').filter(
      (r) => r.office === params[0] && r.batch_id === params[1]
    );
    const writable = rows.filter((r) => r.decision !== 'excluded');
    return {
      rows: [
        {
          total: rows.length,
          writable: writable.length,
          excluded: rows.filter((r) => r.decision === 'excluded').length,
          accepted: rows.filter((r) => r.decision === 'accepted').length,
          blocking: rows.filter((r) => this.isBlocking(r)).length,
          total_cents: writable.reduce((sum, r) => sum + Number(r.fee_cents || 0), 0),
        },
      ],
      rowCount: 1,
    };
  }

  /**
   * The batch UPDATEs, matched by the columns each one sets.
   *
   * THE CONDITIONAL CLAIM IS HONOURED EXACTLY. `status IN ('ready',
   * 'post_failed')` is the real concurrency guard in production — a fake that
   * updated unconditionally would let a test pass with that guard deleted, and
   * this fake exists to make the opposite true.
   */
  updateBatch(text, params) {
    const office = params[0];
    const batchId = params[1];
    const batches = this.table('fees_import_batch').filter(
      (b) => b.office === office && b.batch_id === batchId
    );

    const matched = batches.filter((b) => {
      if (/status IN \('ready', 'post_failed'\)/.test(text)) {
        if (['ready', 'post_failed'].includes(b.status)) return true;
        // THE STALE-POSTING TAKEOVER, honoured exactly — including the
        // IS NOT NULL, so a 'posting' row with no recorded start is never taken
        // over. A fake that skipped this would let the takeover tests pass with
        // the WHERE condition reverted, which is the one thing they exist for.
        if (!/make_interval\(secs => \$3\)/.test(text)) return false;
        if (b.status !== 'posting') return false;
        if (!b.posting_started_at) return false;
        const staleAfterMs = Number(params[2]) * 1000;
        return Date.now() - new Date(b.posting_started_at).getTime() > staleAfterMs;
      }
      if (/status IN \('parsed', 'ready'\)/.test(text)) {
        return ['parsed', 'ready'].includes(b.status);
      }
      // The promote-to-ready is conditional on 'parsed' so it cannot move a
      // batch backwards out of a later state. Honoured exactly.
      if (/AND status = 'parsed'/.test(text)) return b.status === 'parsed';
      if (/posted_at IS NULL/.test(text)) return b.posted_at == null;
      return true;
    });

    for (const b of matched) {
      if (/SET status = 'ready'/.test(text)) {
        b.status = 'ready';
      } else if (/SET status = 'posting'/.test(text)) {
        // The CASE reads the OLD status, as every SQL SET expression does, so
        // the takeover note is recorded only when one actually happened. Read
        // before the overwrite, or this always says "no takeover".
        const tookOver = b.status === 'posting';
        const startedAt = b.posting_started_at;
        b.status = 'posting';
        b.post_error = tookOver
          ? `${params[3]} It started ${new Date(startedAt)
              .toISOString()
              .slice(0, 16)
              .replace('T', ' ')} UTC and never finished.`
          : null;
        b.posting_started_at = new Date();
      } else if (/SET status = 'post_failed'/.test(text)) {
        b.status = 'post_failed';
        b.post_error = params[2];
      } else if (/SET status = 'posted'/.test(text)) {
        b.status = 'posted';
        b.posted_at = new Date();
        b.posted_by = b.posted_by || 'unknown';
        b.post_error = null;
      } else if (/SET status = 'rolled_back'/.test(text)) {
        b.status = 'rolled_back';
        b.rolled_back_at = new Date();
        b.rolled_back_by = params[2];
      } else if (/SET status = \$3/.test(text)) {
        b.status = params[2];
      } else if (/SET posted_by = COALESCE/.test(text)) {
        b.posted_by = b.posted_by || params[2];
      } else if (/SET od_feesched_num = \$3, od_feesched_desc = \$4, od_feesched_is_new = \$5/.test(text)) {
        b.od_feesched_num = params[2];
        b.od_feesched_desc = params[3];
        b.od_feesched_is_new = params[4];
      } else if (/SET od_feesched_num = \$3, od_feesched_desc = \$4/.test(text)) {
        b.od_feesched_num = params[2];
        b.od_feesched_desc = params[3];
      } else if (!/rows_written = \(/.test(text)) {
        throw new Error(`FakeFeesDb: unrecognised fees_import_batch UPDATE — ${text.slice(0, 120)}`);
      }
      // `rows_written` is DERIVED in production, so it is derived here too
      // rather than incremented — the same number, computed the same way, so a
      // test cannot pass against a counter that drifted from its rows.
      if (/rows_written = \(/.test(text)) b.rows_written = this.writtenCount(office, batchId);
      b.updated_at = new Date();
    }

    return { rows: matched.map((b) => ({ ...b })), rowCount: matched.length };
  }

  writtenCount(office, batchId) {
    return this.table('fees_import_row').filter(
      (r) =>
        r.office === office &&
        r.batch_id === batchId &&
        r.od_fee_num !== null &&
        r.od_fee_num !== undefined
    ).length;
  }

  updateRow(text, params) {
    const [office, batchId, rowId] = params;
    const rows = this.table('fees_import_row').filter(
      (r) => r.office === office && r.batch_id === batchId && r.row_id === rowId
    );

    const matched = rows.filter((r) => {
      // The write recorder is conditional on the row being unwritten — that is
      // what makes recording idempotent, so the fake honours it.
      if (/od_fee_num IS NULL/.test(text)) return r.od_fee_num == null;
      return true;
    });

    for (const r of matched) {
      if (/SET decision = \$4/.test(text)) {
        const decision = params[3];
        r.decision = decision;
        r.decided_by = decision === 'pending' ? null : params[4];
        r.decided_at = decision === 'pending' ? null : new Date();
      } else if (/SET od_fee_num = \$4/.test(text)) {
        r.od_fee_num = params[3];
        r.written_at = new Date();
      } else if (/SET od_fee_num = NULL/.test(text)) {
        r.od_fee_num = null;
        r.written_at = null;
      } else {
        throw new Error(`FakeFeesDb: unrecognised fees_import_row UPDATE — ${text.slice(0, 120)}`);
      }
      // The database refuses a FeeNum on an excluded row. Enforced here so a
      // test cannot pass with that CHECK removed from the migration.
      if (r.decision === 'excluded' && r.od_fee_num != null) {
        throw new Error(
          'new row violates check constraint "fees_import_row_excluded_unwritten_check"'
        );
      }
    }
    return { rows: matched.map((r) => ({ ...r })), rowCount: matched.length };
  }

  insertBackup(params) {
    const [office, batchId, feeSchedNum, isNew, rows, rowCount, takenBy] = params;
    // ONE backup per batch — the UNIQUE the migration declares, and the reason
    // a resume cannot overwrite the snapshot with its own partial writes.
    if (this.table('fees_od_backup').some((b) => b.batch_id === batchId)) {
      throw new Error('duplicate key value violates unique constraint "fees_od_backup_batch_key"');
    }
    const row = {
      backup_id: crypto.randomUUID(),
      office,
      batch_id: batchId,
      od_feesched_num: Number(feeSchedNum),
      is_new_schedule: isNew === true,
      rows: JSON.parse(String(rows)),
      row_count: Number(rowCount),
      taken_at: new Date(),
      taken_by: takenBy,
      restored_at: null,
      restored_by: null,
      restore_note: null,
    };
    this.table('fees_od_backup').push(row);
    return { rows: [row], rowCount: 1 };
  }

  selectBackup(params) {
    const rows = this.table('fees_od_backup').filter(
      (b) => b.office === params[0] && b.batch_id === params[1]
    );
    return { rows, rowCount: rows.length };
  }

  /** The restore stamp a rollback writes onto the snapshot it used. */
  updateBackup(params) {
    const [office, batchId, restoredBy, note] = params;
    const rows = this.table('fees_od_backup').filter(
      (b) => b.office === office && b.batch_id === batchId
    );
    for (const b of rows) {
      b.restored_at = new Date();
      b.restored_by = restoredBy;
      b.restore_note = note;
    }
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
  od = null,
} = {}) {
  const odWrites = require('../../services/fees/odFeesWrites');
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
    token: process.env.DASHBOARD_API_TOKEN,
    od: Object.fromEntries(Object.keys(odWrites).map((k) => [k, odWrites[k]])),
  };

  /*
   * THE ALLOW-LISTED WRITER IS STUBBED ON THE MODULE OBJECT, not swapped for a
   * new one: postJob.js and posting.js both `require` the namespace precisely so
   * a stub can be installed here. A destructured import would pin the real
   * functions at require time and no test could reach them.
   *
   * Stubbing the WRITER rather than the transport is deliberate. It keeps the
   * one-file allow-list honest — a test that faked `config/odOffices` instead
   * would still pass if a second file started reaching Open Dental directly,
   * which is the regression the guard exists for.
   */
  if (od) {
    for (const [key, value] of Object.entries(od)) {
      if (typeof value === 'function') odWrites[key] = value;
    }
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
        od,
        close: () =>
          new Promise((r) => {
            for (const k of REGISTRY_KEYS) registry[k] = originals.registry[k];
            tenantDb.withTenantDb = originals.withTenantDb;
            for (const [k, v] of Object.entries(originals.od)) odWrites[k] = v;
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

/**
 * A stand-in for the allow-listed writer, with a real fee schedule behind it.
 *
 * It keeps an actual in-memory schedule so the properties that matter can be
 * ASSERTED rather than assumed: that a resume does not create a second fee for
 * a code that already has one, that a rollback removes exactly what the batch
 * wrote, and that `writeFee` is create-or-update rather than blindly POSTing.
 *
 * `failOn` is a predicate over the proc code, so a test can stop a run at a
 * chosen row and inspect what `rows_written` says afterwards — the W-21
 * property this slice was built around.
 */
function fakeOd({ schedules = [], codeNums = {}, failOn = null, fees = [] } = {}) {
  /** FeeNum → { FeeNum, FeeSched, CodeNum, Amount }. The practice's real state. */
  const store = new Map();
  let nextFeeNum = 900001;
  let nextSchedNum = 501;
  for (const fee of fees) {
    store.set(fee.FeeNum, { ...fee });
    nextFeeNum = Math.max(nextFeeNum, Number(fee.FeeNum) + 1);
  }

  const calls = { writeFee: [], deleteFee: [], createFeeSchedule: 0, hideFeeSchedule: [] };
  const state = { schedules: [...schedules] };

  return {
    calls,
    store,
    state,
    listFeeSchedules: async () => ({ ok: true, schedules: state.schedules }),
    listFeesInSchedule: async (_office, feeSchedNum) => ({
      ok: true,
      fees: [...store.values()].filter((f) => f.FeeSched === feeSchedNum),
      ignoredFilter: false,
    }),
    fetchProcedureCodeMap: async () => ({ ok: true, codeNums, total: Object.keys(codeNums).length }),
    findFee: async (_office, feeSchedNum, codeNum) => ({
      ok: true,
      fee:
        [...store.values()].find((f) => f.FeeSched === feeSchedNum && f.CodeNum === codeNum) || null,
    }),
    createFeeSchedule: async (_office, description) => {
      calls.createFeeSchedule += 1;
      const feeSchedNum = nextSchedNum++;
      state.schedules.push({ feeSchedNum, description, feeSchedType: 'Normal', isHidden: false, isGlobal: true });
      return { ok: true, feeSchedNum, description };
    },
    writeFee: async (_office, { feeSchedNum, codeNum, amountCents }) => {
      calls.writeFee.push({ feeSchedNum, codeNum, amountCents });
      if (failOn && failOn({ feeSchedNum, codeNum, amountCents })) {
        return { ok: false, code: 'OD_WRITE_FAILED', error: 'Open Dental refused the fee' };
      }
      const existing = [...store.values()].find(
        (f) => f.FeeSched === feeSchedNum && f.CodeNum === codeNum
      );
      if (existing) {
        existing.Amount = amountCents / 100;
        return { ok: true, feeNum: existing.FeeNum, action: 'updated' };
      }
      const feeNum = nextFeeNum++;
      store.set(feeNum, { FeeNum: feeNum, FeeSched: feeSchedNum, CodeNum: codeNum, Amount: amountCents / 100 });
      return { ok: true, feeNum, action: 'created' };
    },
    deleteFee: async (_office, feeNum) => {
      calls.deleteFee.push(feeNum);
      const had = store.delete(feeNum);
      return { ok: true, alreadyGone: !had };
    },
    hideFeeSchedule: async (_office, feeSchedNum) => {
      calls.hideFeeSchedule.push(feeSchedNum);
      const sched = state.schedules.find((s) => s.feeSchedNum === feeSchedNum);
      if (sched) sched.isHidden = true;
      return { ok: true };
    },
  };
}

/** Poll until a batch reaches a terminal status, or give up. The post is async. */
async function waitForStatus(app, batchId, statuses, office = 'roland') {
  for (let i = 0; i < 200; i += 1) {
    const res = await api(app.baseUrl, 'GET', `/api/fees/imports/${batchId}/progress?office=${office}`);
    if (res.status === 200 && statuses.includes(res.body.progress.status)) return res.body.progress;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`batch ${batchId} never reached ${statuses.join('|')}`);
}

module.exports = {
  FakeFeesDb,
  fakeOd,
  bootFeesApp,
  withApp,
  api,
  filePart,
  auditRows,
  waitForStatus,
};
