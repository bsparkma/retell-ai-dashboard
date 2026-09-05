'use strict';

/**
 * Test harness for the /api/hyg route family (H1 slice 1).
 *
 * Follows the platform's harness pattern (moduleGateWiring.test.js,
 * routes/tc/tcTestUtils.js, routes/rcm/rcmTestUtils.js): a REAL ephemeral HTTP
 * server running the REAL auth gate, tenantContext, requireModule,
 * requireReadWrite and the REAL routes/hyg/index.js router — assembled in the
 * same order and shape as server.js.
 *
 * Booting index.js rather than the handlers is the point, and it is the lesson
 * the TC voice-handoff slice paid for: mount order is only under test if the
 * test goes through the assembled chain. A test that called day.js's handler
 * directly would pass with `router.use(requireOffice)` deleted from index.js.
 *
 * TWO DELIBERATE DIFFERENCES FROM THE RCM HARNESS
 *
 * 1. A STATEMENT-DISPATCH SQL FAKE, NOT A SQL INTERPRETER. RCM's fake parses
 *    WHERE clauses because RCM builds queries dynamically across two dozen
 *    tables. The hygiene module's whole database surface is thirteen FIXED
 *    statements in services/hyg/visitStore.js, so `FakeHygDb` below dispatches
 *    on each one and hand-implements it. An unrecognised statement THROWS,
 *    which is the point: a new query has to be taught to this file, and
 *    teaching it is where somebody notices they wrote one without an office in
 *    the WHERE clause.
 *
 *    It enforces the CHECK constraints that carry meaning — the office list,
 *    the priority and category vocabularies, both unique keys, and the
 *    composite FK's office match — so a test can state "a cross-office write is
 *    impossible" against the fake and mean it. What it CANNOT prove is that the
 *    real DDL agrees; `backend/scripts/rehearse-hyg-visit.js` runs the real
 *    migration and the real store against a real Postgres for that.
 *
 * 2. A RECORDING OPEN DENTAL CLIENT WITH WRITE VERBS THAT THROW. `FakeOd` below
 *    answers `apiGetRaw` from a scripted route table and defines `apiWriteRaw`,
 *    `post`, `put` and `patch` as throwing stubs. That is what makes
 *    hygNoOdWrites.test.js a behavioural claim rather than a grep: driving the
 *    day route to SUCCESS against this client proves no write verb was reached,
 *    because reaching one would have thrown.
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
// Namespace import so the harness can patch getOdOffice. A destructured import
// would pin the real function at require time and no test could reach it.
const odOffices = require('../../config/odOffices');
const odPatientCache = require('../../services/odPatientCache');

const REGISTRY_KEYS = [
  'getUserByEmail',
  'getTenantById',
  'getTenantClinics',
  'getEnabledModules',
  'getPlatformAdminByEmail',
  'touchUserLogin',
];

/**
 * The audit trail, and nothing else.
 *
 * Every statement that is not the audit INSERT throws, on purpose. A permissive
 * fake would let a route quietly grow a table read that nobody notices until
 * production says the table does not exist.
 */
class FakeAuditDb {
  constructor() {
    /** @type {Array<Record<string, unknown>>} */
    this.audit = [];
    /**
     * Every statement, verbatim. Rows and STATEMENTS are different facts once
     * the audit writer batches: a test that only counted rows could not tell a
     * batched insert from forty sequential ones, which is the thing being
     * changed.
     * @type {string[]}
     */
    this.statements = [];
    /** Set by a test to make the NEXT audit write fail (hard rule 5). */
    this.failAudit = false;
  }

  async query(sql, params = []) {
    const text = String(sql);
    this.statements.push(text);
    if (/INSERT INTO audit_log/i.test(text)) {
      if (this.failAudit) throw new Error('simulated audit_log outage');
      // The column list is PARSED out of the statement rather than restated
      // here. platform/audit.js inserts twelve columns and has gained three
      // since it was written (office, origin_office, source_ref, prior_state);
      // a hardcoded positional map silently shifts every field the next time
      // one is added, and the test that notices is whichever one happened to
      // assert on the column that moved.
      const cols = (text.match(/\(([^)]*)\)\s*VALUES/i) || [, ''])[1]
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      // ONE ROW PER DISCLOSURE, however many statements they arrived in.
      // platform/audit.js batches a day's patients into a single multi-VALUES
      // INSERT, so `params` is a flat run of N × cols.length. Expanding it here
      // rather than in each test keeps every existing assertion — which counts
      // ROWS, because rows are what the HIPAA trail is measured in — true
      // whether the route batched or not.
      const rowCount = cols.length > 0 ? Math.max(1, Math.floor(params.length / cols.length)) : 1;
      for (let r = 0; r < rowCount; r += 1) {
        const slice = params.slice(r * cols.length, (r + 1) * cols.length);
        /** @type {Record<string, unknown>} */
        const row = { params: slice };
        cols.forEach((col, i) => {
          row[col] = slice[i];
        });
        this.audit.push(row);
      }
      return { rows: [], rowCount };
    }
    if (/^\s*SELECT 1 FROM audit_log/i.test(text)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    throw new Error('[hygTestUtils] unexpected SQL under /api/hyg: ' + text.slice(0, 120));
  }
}

/**
 * The audit trail PLUS the three hyg_* tables (H1 slice 2).
 *
 * Extends FakeAuditDb rather than replacing it, so every existing audit
 * assertion in this suite keeps working unchanged and the audit statements stay
 * captured in exactly the same place.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT ENFORCES, AND WHY THOSE THINGS
 * ─────────────────────────────────────────────────────────────────────────────
 * A fake that accepts anything proves nothing. This one refuses what the
 * migration refuses, for the constraints a test would otherwise have to take on
 * trust:
 *
 *   - `office` must be roland or valley, on every table.
 *   - A child row's office must equal its parent's (the composite FK).
 *   - `priority` and `category` are checked against their OWN separate lists.
 *     They are different axes that share the word "cosmetic", and a fake that
 *     let one hold the other's value would make the whole point untestable.
 *   - UNIQUE (office, apt_num) and UNIQUE (visit_id, kind).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * JSONB ROUND-TRIPS ARE SIMULATED, NOT SKIPPED
 * ─────────────────────────────────────────────────────────────────────────────
 * visitStore passes jsonb columns as JSON STRINGS and reads them back as
 * OBJECTS, because that is what node-postgres does. This fake parses on the way
 * in for the same reason: a fake that stored the string would let a bug through
 * where the store forgot to stringify, and every read would return a string
 * where production returns an object.
 */
class FakeHygDb extends FakeAuditDb {
  constructor() {
    super();
    /** @type {Array<Record<string, any>>} */
    this.hyg_visit = [];
    /** @type {Array<Record<string, any>>} */
    this.hyg_treatment_item = [];
    /** @type {Array<Record<string, any>>} */
    this.hyg_staged_write = [];
    this.seq = 0;
  }

  /** Deterministic ids — a test that asserts on one should not need a regex. */
  nextId(prefix) {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, '0')}`;
  }

  static OFFICES = ['roland', 'valley'];
  static PRIORITIES = ['urgent', 'preventative', 'cosmetic'];
  static CATEGORIES = [
    'Restorative', 'Endo', 'Surgery', 'Perio', 'Prosth', 'Ortho', 'Cosmetic', 'Other',
  ];
  static STATUSES = ['proposed', 'watch', 'confirmed', 'scheduled'];
  static KINDS = ['router', 'perio', 'note', 'tc-handoff'];
  static STATES = ['Draft', 'Staged', 'Sending', 'Written', 'Failed'];

  checkOffice(office) {
    if (!FakeHygDb.OFFICES.includes(office)) {
      throw new Error(`hyg office_check violated: '${office}'`);
    }
  }

  /** A jsonb parameter as the driver would have stored it. */
  static json(value) {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      throw new Error('invalid input syntax for type json: ' + value.slice(0, 40));
    }
  }

  async query(sql, params = []) {
    const text = String(sql);
    // Audit and its probe stay with the parent, unchanged.
    if (/audit_log/i.test(text)) return super.query(sql, params);
    this.statements.push(text);

    // ── hyg_visit ───────────────────────────────────────────────────────────
    if (/^\s*SELECT[\s\S]*FROM hyg_visit\s+WHERE office = \$1 AND apt_num = \$2/i.test(text)) {
      const [office, aptNum] = params;
      const rows = this.hyg_visit.filter(
        (r) => r.office === office && Number(r.apt_num) === Number(aptNum)
      );
      return { rows, rowCount: rows.length };
    }

    if (/INSERT INTO hyg_visit/i.test(text)) {
      const [office, aptNum, patNum, visitDate, slip, actor] = params;
      this.checkOffice(office);
      const existing = this.hyg_visit.find(
        (r) => r.office === office && Number(r.apt_num) === Number(aptNum)
      );
      if (existing) {
        // ON CONFLICT (office, apt_num) DO UPDATE — the upsert that makes
        // re-opening an appointment find the visit already there.
        existing.pat_num = Number(patNum);
        if (visitDate) existing.visit_date = visitDate;
        existing.updated_at = new Date();
        return { rows: [existing], rowCount: 1 };
      }
      const row = {
        visit_id: this.nextId('visit'),
        office,
        apt_num: Number(aptNum),
        pat_num: Number(patNum),
        visit_date: visitDate,
        slip: FakeHygDb.json(slip),
        created_by: actor,
        created_at: new Date(),
        updated_by: actor,
        updated_at: new Date(),
      };
      this.hyg_visit.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (/UPDATE hyg_visit\s+SET slip/i.test(text)) {
      const [office, aptNum, slip, actor] = params;
      const row = this.hyg_visit.find(
        (r) => r.office === office && Number(r.apt_num) === Number(aptNum)
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.slip = FakeHygDb.json(slip);
      row.updated_by = actor;
      row.updated_at = new Date();
      return { rows: [row], rowCount: 1 };
    }

    if (/UPDATE hyg_visit SET updated_by/i.test(text)) {
      const [visitId, office, actor] = params;
      const row = this.hyg_visit.find((r) => r.visit_id === visitId && r.office === office);
      if (row) {
        row.updated_by = actor;
        row.updated_at = new Date();
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    // ── hyg_treatment_item ──────────────────────────────────────────────────
    if (/^\s*SELECT[\s\S]*FROM hyg_treatment_item\s+WHERE visit_id = \$1 AND office = \$2/i.test(text)) {
      const [visitId, office] = params;
      const rows = this.hyg_treatment_item
        .filter((r) => r.visit_id === visitId && r.office === office)
        .sort((a, b) => a.item_order - b.item_order);
      return { rows, rowCount: rows.length };
    }

    if (/^\s*SELECT[\s\S]*FROM hyg_treatment_item\s+WHERE item_id = \$1/i.test(text)) {
      const [itemId, visitId, office] = params;
      const rows = this.hyg_treatment_item.filter(
        (r) => r.item_id === itemId && r.visit_id === visitId && r.office === office
      );
      return { rows, rowCount: rows.length };
    }

    if (/INSERT INTO hyg_treatment_item/i.test(text)) {
      const [
        visitId, office, teeth, wholeMouth, code, category, priority, status,
        surfaces, dx, dxNote, motivation, motivationNote, crownType, prosthesis,
        scheduleNext, note, photos, tags, actor,
      ] = params;
      this.checkOffice(office);
      // The composite FK: a child cannot claim an office its parent does not have.
      const parent = this.hyg_visit.find((r) => r.visit_id === visitId && r.office === office);
      if (!parent) {
        throw new Error('hyg_treatment_item_visit_fk violated: no such (visit_id, office)');
      }
      if (!FakeHygDb.CATEGORIES.includes(category)) {
        throw new Error(`hyg_treatment_item_category_check violated: '${category}'`);
      }
      if (!FakeHygDb.PRIORITIES.includes(priority)) {
        throw new Error(`hyg_treatment_item_priority_check violated: '${priority}'`);
      }
      if (!FakeHygDb.STATUSES.includes(status)) {
        throw new Error(`hyg_treatment_item_status_check violated: '${status}'`);
      }
      const teethValue = FakeHygDb.json(teeth);
      if (wholeMouth ? teethValue.length !== 0 : teethValue.length < 1) {
        throw new Error('hyg_treatment_item_teeth_check violated');
      }
      const siblings = this.hyg_treatment_item.filter(
        (r) => r.visit_id === visitId && r.office === office
      );
      const row = {
        item_id: this.nextId('item'),
        visit_id: visitId,
        office,
        teeth: teethValue,
        whole_mouth: wholeMouth === true,
        code,
        category,
        priority,
        status,
        surfaces: FakeHygDb.json(surfaces),
        dx: FakeHygDb.json(dx),
        dx_note: dxNote,
        motivation: FakeHygDb.json(motivation),
        motivation_note: motivationNote,
        crown_type: crownType,
        prosthesis: prosthesis === null ? null : FakeHygDb.json(prosthesis),
        schedule_next: scheduleNext === true,
        note,
        photos: FakeHygDb.json(photos),
        tags: FakeHygDb.json(tags),
        item_order: siblings.reduce((max, r) => Math.max(max, r.item_order), 0) + 1,
        created_by: actor,
        created_at: new Date(),
        updated_by: actor,
        updated_at: new Date(),
      };
      this.hyg_treatment_item.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (/UPDATE hyg_treatment_item/i.test(text)) {
      const [
        itemId, visitId, office, teeth, wholeMouth, code, category, priority, status,
        surfaces, dx, dxNote, motivation, motivationNote, crownType, prosthesis,
        scheduleNext, note, photos, tags, actor,
      ] = params;
      const row = this.hyg_treatment_item.find(
        (r) => r.item_id === itemId && r.visit_id === visitId && r.office === office
      );
      if (!row) return { rows: [], rowCount: 0 };
      if (!FakeHygDb.CATEGORIES.includes(category)) {
        throw new Error(`hyg_treatment_item_category_check violated: '${category}'`);
      }
      if (!FakeHygDb.PRIORITIES.includes(priority)) {
        throw new Error(`hyg_treatment_item_priority_check violated: '${priority}'`);
      }
      Object.assign(row, {
        teeth: FakeHygDb.json(teeth),
        whole_mouth: wholeMouth === true,
        code,
        category,
        priority,
        status,
        surfaces: FakeHygDb.json(surfaces),
        dx: FakeHygDb.json(dx),
        dx_note: dxNote,
        motivation: FakeHygDb.json(motivation),
        motivation_note: motivationNote,
        crown_type: crownType,
        prosthesis: prosthesis === null ? null : FakeHygDb.json(prosthesis),
        schedule_next: scheduleNext === true,
        note,
        photos: FakeHygDb.json(photos),
        tags: FakeHygDb.json(tags),
        updated_by: actor,
        updated_at: new Date(),
      });
      return { rows: [row], rowCount: 1 };
    }

    if (/DELETE FROM hyg_treatment_item/i.test(text)) {
      const [itemId, visitId, office] = params;
      const before = this.hyg_treatment_item.length;
      this.hyg_treatment_item = this.hyg_treatment_item.filter(
        (r) => !(r.item_id === itemId && r.visit_id === visitId && r.office === office)
      );
      return { rows: [], rowCount: before - this.hyg_treatment_item.length };
    }

    // ── hyg_staged_write ────────────────────────────────────────────────────
    if (/^\s*SELECT state FROM hyg_staged_write/i.test(text)) {
      const [visitId, office, kind] = params;
      const rows = this.hyg_staged_write
        .filter((r) => r.visit_id === visitId && r.office === office && r.kind === kind)
        .map((r) => ({ state: r.state }));
      return { rows, rowCount: rows.length };
    }

    if (/^\s*SELECT[\s\S]*FROM hyg_staged_write\s+WHERE visit_id = \$1 AND office = \$2/i.test(text)) {
      const [visitId, office] = params;
      const rows = this.hyg_staged_write.filter(
        (r) => r.visit_id === visitId && r.office === office
      );
      return { rows, rowCount: rows.length };
    }

    if (/INSERT INTO hyg_staged_write/i.test(text)) {
      const [visitId, office, kind, title, summary, preview, payload, actor] = params;
      this.checkOffice(office);
      if (!FakeHygDb.KINDS.includes(kind)) {
        throw new Error(`hyg_staged_write_kind_check violated: '${kind}'`);
      }
      const parent = this.hyg_visit.find((r) => r.visit_id === visitId && r.office === office);
      if (!parent) {
        throw new Error('hyg_staged_write_visit_fk violated: no such (visit_id, office)');
      }
      const existing = this.hyg_staged_write.find(
        (r) => r.visit_id === visitId && r.kind === kind
      );
      const fields = {
        state: 'Staged',
        title,
        summary,
        preview: FakeHygDb.json(preview),
        payload: FakeHygDb.json(payload),
        error_message: null,
        staged_by: actor,
        staged_at: new Date(),
        updated_at: new Date(),
      };
      if (existing) {
        Object.assign(existing, fields);
        return { rows: [existing], rowCount: 1 };
      }
      const row = {
        staged_write_id: this.nextId('staged'),
        visit_id: visitId,
        office,
        kind,
        sent_by: null,
        sent_at: null,
        created_at: new Date(),
        ...fields,
      };
      this.hyg_staged_write.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (/DELETE FROM hyg_staged_write/i.test(text)) {
      const [visitId, office, kind] = params;
      const before = this.hyg_staged_write.length;
      this.hyg_staged_write = this.hyg_staged_write.filter(
        (r) => !(r.visit_id === visitId && r.office === office && r.kind === kind)
      );
      return { rows: [], rowCount: before - this.hyg_staged_write.length };
    }

    throw new Error('[hygTestUtils] unexpected SQL under /api/hyg: ' + text.trim().slice(0, 160));
  }
}

/**
 * A scripted Open Dental client bound to one office.
 *
 * `routes` maps an OD path (or a `path?Offset=N` key, for paging tests) to
 * either a response array or a `{ ok, status, data, error }` envelope. An
 * unscripted path answers 404 the way a real capability miss would, rather
 * than throwing — the routes are supposed to survive one.
 */
class FakeOd {
  /**
   * @param {Record<string, unknown>} routes
   */
  constructor(routes = {}) {
    this.routes = routes;
    /** Every GET made, in order: `{ path, params, opts }`. */
    this.calls = [];
    /** Write verbs reached. Must stay empty — see the class note. */
    this.writes = [];
  }

  async apiGetRaw(path, params = {}, opts = {}) {
    this.calls.push({ path, params, opts });
    const offset = params && params.Offset;
    const keyed = offset !== undefined ? path + '?Offset=' + offset : path;
    const scripted = Object.prototype.hasOwnProperty.call(this.routes, keyed)
      ? this.routes[keyed]
      : Object.prototype.hasOwnProperty.call(this.routes, path)
        ? this.routes[path]
        : undefined;

    if (scripted === undefined) {
      return { ok: false, status: 404, data: null, error: "'" + path + "' is not scripted" };
    }
    if (scripted && typeof scripted === 'object' && !Array.isArray(scripted) && 'ok' in scripted) {
      return scripted;
    }
    return { ok: true, status: 200, data: scripted };
  }

  // Every write verb the transport defines, plus the raw axios ones the older
  // code paths use. Reaching any of them from /api/hyg is the failure.
  async apiWriteRaw(...args) {
    this.writes.push(['apiWriteRaw', ...args]);
    throw new Error('[hygTestUtils] /api/hyg reached an Open Dental WRITE verb: apiWriteRaw');
  }
  async post(...args) {
    this.writes.push(['post', ...args]);
    throw new Error('[hygTestUtils] /api/hyg reached an Open Dental WRITE verb: post');
  }
  async put(...args) {
    this.writes.push(['put', ...args]);
    throw new Error('[hygTestUtils] /api/hyg reached an Open Dental WRITE verb: put');
  }
  async patch(...args) {
    this.writes.push(['patch', ...args]);
    throw new Error('[hygTestUtils] /api/hyg reached an Open Dental WRITE verb: patch');
  }
  async delete(...args) {
    this.writes.push(['delete', ...args]);
    throw new Error('[hygTestUtils] /api/hyg reached an Open Dental WRITE verb: delete');
  }
}

/**
 * Boot the real /api/hyg stack over an ephemeral HTTP server.
 *
 * @param {{
 *   modules?: string[],
 *   user?: { email: string, name?: string, tenantId?: string } | null,
 *   role?: string,
 *   superAdmin?: boolean,
 *   db?: FakeAuditDb,
 *   od?: FakeOd,
 *   hygOffices?: string[],
 *   odUnavailableFor?: string[]
 * }} [opts]
 *   `hygOffices` names the offices whose `hygOdEnabled` switch is ON for this
 *   boot — DEFAULT roland only, because the shipped default is off everywhere
 *   and a test that never turns one on could not reach a handler.
 *   `odUnavailableFor` names offices whose getOdOffice should throw as an
 *   unkeyed office would, so the honest-refusal path is exercised for real.
 */
async function bootHygApp({
  modules = ['hyg'],
  user = { email: 'hygienist@carein.ai', name: 'Hyg User', tenantId: 'x' },
  role = 'hygiene',
  superAdmin = false,
  db = new FakeHygDb(),
  od = new FakeOd(),
  hygOffices = ['roland'],
  odUnavailableFor = [],
} = {}) {
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
    getOdOffice: odOffices.getOdOffice,
    hygFlags: Object.fromEntries(
      Object.entries(odOffices.OFFICE_OD_SETTINGS).map(([k, v]) => [k, v.hygOdEnabled])
    ),
    token: process.env.DASHBOARD_API_TOKEN,
    keys: {
      OPENDENTAL_CUSTOMER_KEY: process.env.OPENDENTAL_CUSTOMER_KEY,
      OPENDENTAL_CUSTOMER_KEY_VALLEY: process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY,
    },
  };

  /*
   * Placeholder customer keys, so `hygOdBlockReason` runs FOR REAL rather than
   * being stubbed out.
   *
   * That function asks odBlockReason first, which checks for a per-office
   * customer key in process.env — and a test box has none, so every office
   * would answer OFFICE_OD_KEY_MISSING and the hygiene switch would never be
   * reached. Setting them here means the readiness chain under test is the one
   * production runs. The VALUES are never used: getOdOffice is stubbed below,
   * so no client is ever built from them.
   *
   * `odUnavailableFor` still produces a genuine OFFICE_OD_KEY_MISSING, from the
   * stub, which is how the unkeyed-office refusal stays testable.
   */
  /*
   * The patient cache is PROCESS-WIDE and survives between boots — which is the
   * whole point of it in the app, and which would silently invalidate every
   * "how many Open Dental calls did this make" assertion in this suite: the
   * second test to load 2026-09-08 for roland would find the first test's
   * patients already there. Cleared per boot so each test measures a cold read,
   * which is what the first load of a day actually is.
   */
  odPatientCache.resetOdPatientCache();

  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-customer-key-roland';
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-customer-key-valley';
  odOffices.resetOdOfficeCache();

  // The per-office hygiene switch, flipped on the REAL settings object so
  // hygOdBlockReason is exercised rather than stubbed. The entries are mutable
  // for exactly this reason (config/odOffices.js says so at the map).
  for (const [key, settings] of Object.entries(odOffices.OFFICE_OD_SETTINGS)) {
    settings.hygOdEnabled = hygOffices.includes(key);
  }

  // The office's OWN client, faked. `assertOfficeMatch` is left REAL, so a
  // route that resolved the wrong office's handle is still refused here.
  odOffices.getOdOffice = (key) => {
    if (odUnavailableFor.includes(key)) {
      throw new odOffices.OdOfficeError(
        'office ' + key + ' has no customer key',
        'OFFICE_OD_KEY_MISSING',
        'Open Dental credentials are not configured for this office',
        key
      );
    }
    return Object.freeze({
      officeKey: key,
      officeName: key === 'valley' ? 'Riley Family Dental' : 'Roland Family Dental',
      commTypeDefNum: key === 'valley' ? 451 : 486,
      client: od,
    });
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
  // Mirrors server.js EXACTLY. No exemption list there, none here.
  app.use(
    '/api/hyg',
    requireModule('hyg'),
    requireReadWrite('hyg.read', 'hyg.write'),
    require('./index')
  );

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: 'http://127.0.0.1:' + port,
        db,
        od,
        close: () =>
          new Promise((r) => {
            for (const k of REGISTRY_KEYS) registry[k] = originals.registry[k];
            tenantDb.withTenantDb = originals.withTenantDb;
            odOffices.getOdOffice = originals.getOdOffice;
            for (const [key, value] of Object.entries(originals.hygFlags)) {
              odOffices.OFFICE_OD_SETTINGS[key].hygOdEnabled = value;
            }
            if (originals.token === undefined) delete process.env.DASHBOARD_API_TOKEN;
            else process.env.DASHBOARD_API_TOKEN = originals.token;
            for (const [k, v] of Object.entries(originals.keys)) {
              if (v === undefined) delete process.env[k];
              else process.env[k] = v;
            }
            // The per-office client cache is process-wide and keyed by office.
            // Leaving a handle built under this boot's placeholder keys would
            // hand it to the next suite.
            odOffices.resetOdOfficeCache();
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
async function api(baseUrl, method, path, { anon = false, body } = {}) {
  const headers = anon ? {} : { Authorization: 'Bearer test-token' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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
 * A synthetic Open Dental appointment row.
 *
 * NO REAL PATIENT DATA ANYWHERE. Every PatNum here is either a designated
 * staging fixture (roland 12827 / 12828, valley 7115) or an obviously
 * synthetic number far outside them.
 */
function apptRow(over = {}) {
  return {
    AptNum: 900001,
    PatNum: 12827,
    AptStatus: 'Scheduled',
    // Twelve characters = 60 minutes. See odDay.minutesFromPattern.
    Pattern: '//XXXXXXXX//',
    Op: 2,
    ProvNum: 1,
    ProvHyg: 7,
    IsHygiene: true,
    AptDateTime: '2026-09-08 08:00:00',
    AppointmentTypeNum: 3,
    ProcDescript: 'Prophy',
    Confirmed: 244,
    confirmed: 'Confirmed',
    IsNewPatient: false,
    ...over,
  };
}

/** A synthetic Open Dental patient record. */
function patientRow(over = {}) {
  return {
    PatNum: 12827,
    LName: 'Test 2',
    FName: 'Stedi',
    Preferred: '',
    Birthdate: '1990-01-01',
    Premed: false,
    MedUrgNote: '',
    ...over,
  };
}

/** A synthetic Open Dental operatory row. */
function operatoryRow(over = {}) {
  return {
    OperatoryNum: 2,
    OpName: 'Hygiene 1',
    Abbrev: 'HY1',
    ItemOrder: 1,
    IsHidden: 'false',
    IsHygiene: 'true',
    ...over,
  };
}

module.exports = {
  FakeAuditDb,
  FakeHygDb,
  FakeOd,
  bootHygApp,
  api,
  apptRow,
  patientRow,
  operatoryRow,
};
