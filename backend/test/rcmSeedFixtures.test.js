'use strict';

/**
 * Unit tests for scripts/rcm-seed-fixtures.cjs.
 *
 * CI has no standing tenant DB at unit-test time (backend tests run before the
 * ephemeral Postgres exists — see .github/workflows/staging.yml), so everything
 * here is pure: the plan is authored rather than derived, the guard takes its
 * environment as an argument, and idempotency is exercised through an in-memory
 * target that models `INSERT … ON CONFLICT DO NOTHING`. Real application
 * against Postgres is covered by the throwaway-PG16 rehearsal recorded in the
 * Slice 2 PR.
 *
 * The properties under test are the ones that would hurt:
 *  - the prod guard refuses, on every branch, and refuses by default;
 *  - two dry-runs print byte-identical plans (no clock, no random source);
 *  - a second --execute creates nothing;
 *  - every foreign key resolves to a row planned EARLIER, in the same office;
 *  - both offices are present in every per-office table;
 *  - no od_patient_id outside the designated test set ever appears;
 *  - nothing in the fixture reads as having reached Open Dental;
 *  - the seeder's columns exist in the Slice 1 migration (drift guard).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const seeder = require('../scripts/rcm-seed-fixtures.cjs');
const migration = require('../migrations-tenant/1786622400000_rcm_schema.js');

const {
  OFFICES,
  TEST_PATIENTS,
  FORBIDDEN_PATNUMS,
  ROW_ORDER,
  REMITTANCE_KEY,
  SeedGuardError,
  buildFixturePlan,
  formatPlan,
  executePlan,
  assertSeedAllowed,
  assertTargetIsSeedable,
  applyUserMapOverrides,
} = seeder;

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * In-memory execute target modelling PgSeedTarget: a row whose primary key is
 * already present is skipped, exactly as `ON CONFLICT DO NOTHING` skips it.
 */
class MemoryTarget {
  constructor() {
    this.tables = new Map();
    this.began = 0;
    this.committed = 0;
    this.rolledBack = 0;
  }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
  }

  async begin() {
    this.began += 1;
  }
  async commit() {
    this.committed += 1;
  }
  async rollback() {
    this.rolledBack += 1;
  }

  async insertIfAbsent(table, pkColumn, row) {
    const rows = this.table(table);
    if (rows.some((r) => r[pkColumn] === row[pkColumn])) return false;
    rows.push({ ...row });
    return true;
  }

  async countNonFixtureRows(table, pkColumn, ids) {
    return this.table(table).filter((r) => !ids.includes(String(r[pkColumn]))).length;
  }
}

/** The Slice 1 migration's column definitions, by table — the drift guard's source. */
function migrationColumns() {
  const created = [];
  const pgm = {
    sql: () => {},
    func: (expr) => ({ __func: expr }),
    createTable: (name, cols) => created.push({ name, cols }),
    dropTable: () => {},
    addConstraint: () => {},
    createIndex: () => {},
  };
  migration.up(pgm);
  return new Map(created.map((t) => [t.name, t.cols]));
}

/**
 * The seeder's foreign keys, restated here independently of the script so the
 * two have to agree. `office` marks the ones that must ALSO match office_id —
 * the schema deliberately has no composite (office_id, parent_id) FK, so
 * nothing in the database would catch a cross-office link.
 */
const FOREIGN_KEYS = {
  rcm_procedure_lines: [{ column: 'claim_id', table: 'rcm_claims', pk: 'claim_id', office: true }],
  rcm_procedure_adjustments: [
    { column: 'procedure_line_id', table: 'rcm_procedure_lines', pk: 'line_id', office: true },
    { column: 'claim_id', table: 'rcm_claims', pk: 'claim_id', office: true },
  ],
  rcm_payment_batches: [
    { column: 'bank_transaction_id', table: 'rcm_bank_transactions', pk: 'bank_transaction_id', office: true },
    { column: 'created_by', table: 'rcm_user_map', pk: 'user_key', office: false },
  ],
  rcm_batch_claim_payments: [
    { column: 'batch_id', table: 'rcm_payment_batches', pk: 'batch_id', office: true },
    { column: 'claim_id', table: 'rcm_claims', pk: 'claim_id', office: true },
  ],
  rcm_eob_uploads: [
    { column: 'bank_transaction_id', table: 'rcm_bank_transactions', pk: 'bank_transaction_id', office: true },
    { column: 'result_batch_id', table: 'rcm_payment_batches', pk: 'batch_id', office: true },
    { column: 'result_claim_id', table: 'rcm_claims', pk: 'claim_id', office: true },
  ],
  rcm_remittance_keys: [{ column: 'batch_id', table: 'rcm_payment_batches', pk: 'batch_id', office: true }],
  rcm_handoff_tasks: [
    { column: 'deposit_id', table: 'rcm_bank_transactions', pk: 'bank_transaction_id', office: true },
    { column: 'assignee_user_key', table: 'rcm_user_map', pk: 'user_key', office: false },
    { column: 'created_by_user_key', table: 'rcm_user_map', pk: 'user_key', office: false },
  ],
  rcm_activity_events: [{ column: 'claim_id', table: 'rcm_claims', pk: 'claim_id', office: true }],
  rcm_posting_queue: [
    { column: 'batch_id', table: 'rcm_payment_batches', pk: 'batch_id', office: true },
    { column: 'bank_transaction_id', table: 'rcm_bank_transactions', pk: 'bank_transaction_id', office: true },
    { column: 'approved_by', table: 'rcm_user_map', pk: 'user_key', office: false },
  ],
  rcm_posting_queue_line: [
    { column: 'queue_id', table: 'rcm_posting_queue', pk: 'queue_id', office: true },
    { column: 'claim_id', table: 'rcm_claims', pk: 'claim_id', office: true },
    { column: 'batch_claim_payment_id', table: 'rcm_batch_claim_payments', pk: 'batch_claim_payment_id', office: true },
  ],
};

// ─── the prod guard ─────────────────────────────────────────────────────────

const STAGING_URL = 'postgresql://u:p@psql-carein-staging.postgres.database.azure.com:5432/carein_t_carein';
const PROD_URL = 'postgresql://u:p@psql-carein-prod.postgres.database.azure.com:5432/carein_t_carein';
const LOCAL_URL = 'postgresql://postgres:postgres@localhost:55432/rcm_rehearsal';

/** @param {Record<string,string|undefined>} env */
function guardCode(env) {
  try {
    assertSeedAllowed(env);
    return null;
  } catch (err) {
    assert.ok(err instanceof SeedGuardError, `expected SeedGuardError, got ${err}`);
    return err.code;
  }
}

test('guard: refuses by default — no opt-in means no write', () => {
  assert.equal(guardCode({}), 'GUARD_NO_OPT_IN');
  assert.equal(guardCode({ RCM_SEED_DB_URL: LOCAL_URL }), 'GUARD_NO_OPT_IN');
  // Near-misses are refusals too. There is no value that targets prod.
  for (const allow of ['prod', 'production', 'yes', 'true', '1', 'PROD', '']) {
    assert.equal(guardCode({ RCM_SEED_ALLOW: allow, RCM_SEED_DB_URL: LOCAL_URL }), 'GUARD_NO_OPT_IN', allow);
  }
});

test('guard: refuses NODE_ENV=production even with a valid opt-in and a local URL', () => {
  assert.equal(
    guardCode({ RCM_SEED_ALLOW: 'dev', NODE_ENV: 'production', RCM_SEED_DB_URL: LOCAL_URL }),
    'GUARD_NODE_ENV_PRODUCTION'
  );
});

test('guard: refuses a prod-looking database URL under EVERY opt-in', () => {
  for (const allow of ['dev', 'staging']) {
    assert.equal(guardCode({ RCM_SEED_ALLOW: allow, RCM_SEED_DB_URL: PROD_URL }), 'GUARD_PROD_DATABASE_URL', allow);
  }
  // A prod marker in the database NAME refuses just as hard as one in the host.
  assert.equal(
    guardCode({ RCM_SEED_ALLOW: 'staging', RCM_SEED_DB_URL: 'postgresql://u:p@db-staging.example.com/carein_prod' }),
    'GUARD_PROD_DATABASE_URL'
  );
});

test('guard: RCM_SEED_ALLOW=dev cannot reach a cloud database at all', () => {
  assert.equal(guardCode({ RCM_SEED_ALLOW: 'dev', RCM_SEED_DB_URL: STAGING_URL }), 'GUARD_DEV_REQUIRES_LOCAL');
  for (const host of ['localhost', '127.0.0.1', 'host.docker.internal']) {
    assert.equal(guardCode({ RCM_SEED_ALLOW: 'dev', RCM_SEED_DB_URL: `postgresql://u:p@${host}:5432/x` }), null, host);
  }
});

test('guard: RCM_SEED_ALLOW=staging requires a staging host', () => {
  assert.equal(
    guardCode({ RCM_SEED_ALLOW: 'staging', RCM_SEED_DB_URL: 'postgresql://u:p@psql-carein.postgres.database.azure.com/x' }),
    'GUARD_STAGING_URL_MISMATCH'
  );
  assert.equal(guardCode({ RCM_SEED_ALLOW: 'staging', RCM_SEED_DB_URL: STAGING_URL }), null);
});

test('guard: a missing or unparseable connection string is a refusal, not a default', () => {
  assert.equal(guardCode({ RCM_SEED_ALLOW: 'dev' }), 'GUARD_NO_DB_URL');
  assert.equal(guardCode({ RCM_SEED_ALLOW: 'dev', RCM_SEED_DB_URL: 'not a url' }), 'GUARD_UNPARSEABLE_DB_URL');
});

test('guard: the happy paths return the mode and the URL', () => {
  assert.deepEqual(assertSeedAllowed({ RCM_SEED_ALLOW: 'dev', RCM_SEED_DB_URL: LOCAL_URL }), {
    mode: 'dev',
    databaseUrl: LOCAL_URL,
  });
  assert.deepEqual(assertSeedAllowed({ RCM_SEED_ALLOW: ' STAGING ', RCM_SEED_DB_URL: STAGING_URL }), {
    mode: 'staging',
    databaseUrl: STAGING_URL,
  });
});

test('guard: a database holding non-fixture RCM rows is refused', async () => {
  const plan = buildFixturePlan();
  const target = new MemoryTarget();

  // Empty database: seedable.
  await assertTargetIsSeedable(target, plan);

  // Our own rows: still seedable — that is what makes a re-run possible.
  await executePlan(plan, target);
  await assertTargetIsSeedable(target, plan);

  // One row we did not write: refused. This is the guard that does not depend
  // on anyone setting an env var correctly.
  target.table('rcm_claims').push({ claim_id: '00000000-0000-4000-8000-000000000001' });
  await assert.rejects(
    () => assertTargetIsSeedable(target, plan),
    (err) => err instanceof SeedGuardError && err.code === 'GUARD_NON_FIXTURE_DATA'
  );
});

// ─── determinism ────────────────────────────────────────────────────────────

test('two dry-runs produce byte-identical plans', () => {
  const a = formatPlan(buildFixturePlan(), 'dry-run');
  const b = formatPlan(buildFixturePlan(), 'dry-run');
  assert.equal(a, b);
  assert.ok(a.length > 1000, 'the plan should not be trivially short');
});

test('the plan carries no clock reading and no random value', () => {
  const plan = buildFixturePlan();
  // Every derived uuid is v5 (the version nibble is 5). A gen_random_uuid()
  // leaking into the plan would be v4 and fail here.
  const uuids = plan.rows.map((r) => r.pk).filter((pk) => /^[0-9a-f-]{36}$/.test(pk));
  assert.ok(uuids.length > 40);
  for (const pk of uuids) {
    assert.match(pk, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, pk);
  }
  // No value in any row is within a year of "now" unless it is one of the fixed
  // literals — the cheapest way to catch a Date.now() creeping in.
  const thisYear = String(new Date().getFullYear());
  for (const r of plan.rows) {
    for (const [col, v] of Object.entries(r.row)) {
      if (typeof v !== 'string') continue;
      assert.ok(
        !v.startsWith(`${thisYear}-`) || /^2026-0[6-8]-/.test(v),
        `${r.table}.${col} looks clock-derived: ${v}`
      );
    }
  }
});

test('the same fixture key always derives the same uuid', () => {
  assert.equal(seeder.fixtureUuid('claim:roland:0001'), seeder.fixtureUuid('claim:roland:0001'));
  assert.notEqual(seeder.fixtureUuid('claim:roland:0001'), seeder.fixtureUuid('claim:valley:0001'));
});

// ─── idempotency ────────────────────────────────────────────────────────────

test('executing twice creates the graph once and then reports 0 creates', async () => {
  const plan = buildFixturePlan();
  const target = new MemoryTarget();

  const first = await executePlan(plan, target);
  const created = Object.values(first.created).reduce((n, v) => n + v, 0);
  const skipped = Object.values(first.skipped).reduce((n, v) => n + v, 0);
  assert.equal(created, plan.rows.length);
  assert.equal(skipped, 0);

  const second = await executePlan(plan, target);
  assert.equal(Object.values(second.created).reduce((n, v) => n + v, 0), 0);
  assert.equal(Object.values(second.skipped).reduce((n, v) => n + v, 0), plan.rows.length);

  // And no row was duplicated.
  for (const table of ROW_ORDER) {
    const planned = plan.rows.filter((r) => r.table === table).length;
    assert.equal(target.table(table).length, planned, table);
  }

  assert.equal(target.committed, 2);
  assert.equal(target.rolledBack, 0);
});

test('the report says so when a re-run creates nothing', async () => {
  const plan = buildFixturePlan();
  const target = new MemoryTarget();
  await executePlan(plan, target);
  const report = formatPlan(plan, 'execute', await executePlan(plan, target));
  assert.match(report, /idempotent re-run/);
  assert.match(report, /TOTAL\s+0 created/);
});

test('a failed insert rolls the whole graph back — never half a fixture', async () => {
  const plan = buildFixturePlan();
  const target = new MemoryTarget();
  let calls = 0;
  target.insertIfAbsent = async () => {
    calls += 1;
    if (calls === 12) throw new Error('boom');
    return true;
  };
  await assert.rejects(() => executePlan(plan, target), /boom/);
  assert.equal(target.rolledBack, 1);
  assert.equal(target.committed, 0);
});

// ─── referential completeness ───────────────────────────────────────────────

test('every foreign key resolves to a row planned EARLIER, in the same office', () => {
  const plan = buildFixturePlan();
  const seen = new Map(); // `${table}:${pk}` -> office

  for (const r of plan.rows) {
    for (const fk of FOREIGN_KEYS[r.table] || []) {
      const value = r.row[fk.column];
      if (value == null) continue;
      const parentOffice = seen.get(`${fk.table}:${value}`);
      assert.notEqual(
        parentOffice,
        undefined,
        `${r.table} (${r.key}).${fk.column} → ${fk.table} ${value} is not planned before it`
      );
      if (fk.office) {
        assert.equal(
          parentOffice,
          r.office,
          `${r.table} (${r.key}).${fk.column} crosses offices: ${r.office} → ${parentOffice}`
        );
      }
    }
    seen.set(`${r.table}:${r.row[r.pkColumn]}`, r.office);
  }
});

test('every table in ROW_ORDER is actually populated, and every planned table is in ROW_ORDER', () => {
  const plan = buildFixturePlan();
  const tables = new Set(plan.rows.map((r) => r.table));
  assert.deepEqual([...tables].sort(), [...ROW_ORDER].sort());
});

test('every seeded table exists in the Slice 1 migration, with every column it writes', () => {
  const plan = buildFixturePlan();
  const columns = migrationColumns();

  for (const table of ROW_ORDER) {
    assert.ok(migration.RCM_TABLES.includes(table), `${table} is not created by the migration`);
    const defs = columns.get(table);
    assert.ok(defs, `${table} has no createTable in the migration`);
    for (const r of plan.rows.filter((row) => row.table === table)) {
      for (const col of Object.keys(r.row)) {
        assert.ok(defs[col], `${table}.${col} is written by the seeder but does not exist in the schema`);
      }
    }
  }
});

test('every NOT NULL column without a database default is supplied', () => {
  const plan = buildFixturePlan();
  const columns = migrationColumns();

  for (const r of plan.rows) {
    const defs = columns.get(r.table);
    for (const [col, def] of Object.entries(defs)) {
      const required = def && def.notNull === true && def.default === undefined;
      if (!required) continue;
      assert.notEqual(r.row[col], undefined, `${r.table} (${r.key}) omits NOT NULL column ${col}`);
      assert.notEqual(r.row[col], null, `${r.table} (${r.key}) nulls NOT NULL column ${col}`);
    }
  }
});

// ─── both offices ───────────────────────────────────────────────────────────

test('both offices are present in every per-office table', () => {
  const plan = buildFixturePlan();
  const globalTables = new Set(['rcm_user_map']);

  for (const table of ROW_ORDER) {
    if (globalTables.has(table)) continue;
    for (const office of OFFICES) {
      const n = plan.rows.filter((r) => r.table === table && r.row.office_id === office).length;
      assert.ok(n > 0, `${table} has no ${office} row — office isolation is not exercisable`);
    }
  }
});

test('rcm_user_map is tenant-global — no office_id anywhere on it', () => {
  const plan = buildFixturePlan();
  for (const r of plan.rows.filter((row) => row.table === 'rcm_user_map')) {
    assert.equal(r.row.office_id, undefined);
    assert.equal(r.office, null);
  }
});

test('the remittance key is IDENTICAL in both offices — the office-scoped unique is what allows it', () => {
  const plan = buildFixturePlan();
  const keys = plan.rows.filter((r) => r.table === 'rcm_remittance_keys');
  assert.equal(keys.length, 2);
  assert.equal(keys[0].row.remittance_key, REMITTANCE_KEY);
  assert.equal(keys[1].row.remittance_key, REMITTANCE_KEY);
  assert.notEqual(keys[0].row.office_id, keys[1].row.office_id);

  // The posting queue carries the same (office_id, remittance_key) unique.
  const queues = plan.rows.filter((r) => r.table === 'rcm_posting_queue');
  assert.equal(queues.length, 2);
  assert.equal(new Set(queues.map((q) => q.row.remittance_key)).size, 1);
  assert.equal(new Set(queues.map((q) => q.row.office_id)).size, 2);

  // Same for the payer name: one carrier, two practices, UNIQUE(office, payer).
  const rules = plan.rows.filter((r) => r.table === 'rcm_payer_rules');
  assert.equal(new Set(rules.map((r) => r.row.payer_name)).size, 1);
  assert.equal(new Set(rules.map((r) => r.row.office_id)).size, 2);
});

// ─── the safety rules ───────────────────────────────────────────────────────

test('every od_patient_id is a designated test patient of ITS OWN office', () => {
  const plan = buildFixturePlan();
  let checked = 0;
  for (const r of plan.rows) {
    const patNum = r.row.od_patient_id;
    if (patNum == null) continue;
    checked += 1;
    assert.ok(!FORBIDDEN_PATNUMS.includes(patNum), `PatNum ${patNum} is explicitly rejected as a fixture`);
    const allowed = Object.keys(TEST_PATIENTS[r.office]).map(Number);
    assert.ok(
      allowed.includes(patNum),
      `${r.table} (${r.key}) references PatNum ${patNum}, which is not a ${r.office} test patient`
    );
  }
  assert.ok(checked >= 5, 'expected the claims to carry od_patient_id');
});

test('PatNum 7115 appears only under valley — in roland it is a different, real person', () => {
  const plan = buildFixturePlan();
  for (const r of plan.rows.filter((row) => row.row.od_patient_id === 7115)) {
    assert.equal(r.office, 'valley');
  }
});

test('Open Dental claim/claimproc identifiers are outside either practice\'s real range', () => {
  const plan = buildFixturePlan();
  const odIds = plan.rows.flatMap((r) =>
    ['od_claim_num', 'od_claim_proc_num'].map((c) => r.row[c]).filter((v) => v != null)
  );
  assert.ok(odIds.length >= 10);
  for (const id of odIds) assert.ok(id > 9_000_000_000, `${id} is low enough to collide with a real OD row`);
});

test('nothing in the fixture reads as having reached Open Dental', () => {
  const plan = buildFixturePlan();
  for (const r of plan.rows) {
    if (r.table === 'rcm_claims') assert.notEqual(r.row.status, 'posted');
    if (r.table === 'rcm_payment_batches') {
      assert.notEqual(r.row.status, 'posted');
      assert.equal(r.row.posted_amount_cents, 0);
    }
    if (r.table === 'rcm_activity_events') assert.notEqual(r.row.type, 'posted');
    if (r.table === 'rcm_remittance_keys') assert.equal(r.row.status, 'pending');
    if (r.table === 'rcm_posting_queue') {
      assert.equal(r.row.status, 'approved');
      assert.equal(r.row.posted_total_cents, 0);
      assert.equal(r.row.od_claim_payment_num, undefined);
    }
    if (r.table === 'rcm_posting_queue_line') {
      assert.equal(r.row.status, 'pending');
      assert.equal(r.row.od_claim_payment_num, undefined);
    }
  }
});

test('exactly one office carries the recoupment, and its negative line is a supplemental', () => {
  const plan = buildFixturePlan();
  const queues = plan.rows.filter((r) => r.table === 'rcm_posting_queue');
  const recoup = queues.filter((q) => q.row.is_recoupment === true);
  assert.equal(recoup.length, 1, 'Slice 6/7 needs exactly one one-way-door case to render');
  assert.equal(recoup[0].office, 'valley');

  const negatives = plan.rows.filter(
    (r) => r.table === 'rcm_posting_queue_line' && r.row.intended_ins_pay_amt_cents < 0
  );
  assert.equal(negatives.length, 1);
  assert.equal(negatives[0].office, 'valley');
  assert.equal(negatives[0].row.is_supplemental, true);

  // Every other line is a plain PUT, not a supplemental.
  for (const r of plan.rows.filter((row) => row.table === 'rcm_posting_queue_line' && row !== negatives[0])) {
    assert.equal(r.row.is_supplemental, false);
  }
});

test('cent amounts balance: batch total = claim payments = intended line amounts', () => {
  const plan = buildFixturePlan();
  for (const office of OFFICES) {
    const batch = plan.rows.find((r) => r.table === 'rcm_payment_batches' && r.office === office);
    const claimPayments = plan.rows
      .filter((r) => r.table === 'rcm_batch_claim_payments' && r.office === office)
      .reduce((n, r) => n + r.row.paid_cents, 0);
    const intended = plan.rows
      .filter((r) => r.table === 'rcm_posting_queue_line' && r.office === office)
      .reduce((n, r) => n + r.row.intended_ins_pay_amt_cents, 0);
    const queue = plan.rows.find((r) => r.table === 'rcm_posting_queue' && r.office === office);

    assert.equal(batch.row.total_amount_cents, claimPayments, `${office}: batch total vs claim payments`);
    assert.equal(claimPayments, intended, `${office}: claim payments vs intended lines`);
    assert.equal(queue.row.intended_total_cents, intended, `${office}: queue total vs its lines`);
    assert.equal(plan.money[office].batchTotal, claimPayments);
  }
});

test('every procedure line balances: billed = paid + write_off + patient responsibility', () => {
  const plan = buildFixturePlan();
  const lines = plan.rows.filter((r) => r.table === 'rcm_procedure_lines');
  assert.ok(lines.length >= 8);
  for (const { row, key } of lines) {
    assert.equal(row.billed_cents, row.paid_cents + row.write_off_cents + row.patient_resp_cents, key);
    assert.equal(row.allowed_cents, row.billed_cents - row.write_off_cents, key);
  }
});

test('every office has a CARC adjustment, and at least one carries a RARC remark', () => {
  const plan = buildFixturePlan();
  const adjustments = plan.rows.filter((r) => r.table === 'rcm_procedure_adjustments');
  for (const office of OFFICES) {
    const mine = adjustments.filter((r) => r.office === office);
    assert.ok(mine.length > 0, `${office} has no CARC adjustment`);
    for (const r of mine) {
      assert.ok(['CO', 'PR', 'OA', 'PI', 'CR'].includes(r.row.group_code), `${r.key}: bad CARC group`);
      assert.ok(String(r.row.reason_code).length > 0, `${r.key}: empty CARC reason`);
    }
    assert.ok(mine.some((r) => r.row.remark_code), `${office} has no RARC remark code`);
  }
});

test('procedure line flags stay inside the schema\'s allowed set', () => {
  const plan = buildFixturePlan();
  const allowed = new Set([
    'downcode', 'bundled', 'denied', 'partial_pay',
    'unexplained_adj', 'frequency_limit', 'not_covered', 'pre_auth_required',
  ]);
  for (const r of plan.rows.filter((row) => row.table === 'rcm_procedure_lines')) {
    for (const flag of r.row.flags) assert.ok(allowed.has(flag), `${r.key}: unknown flag '${flag}'`);
  }
});

// ─── user map ───────────────────────────────────────────────────────────────

test('user map emails are lowercase and non-deliverable by default', () => {
  const plan = buildFixturePlan();
  const users = plan.rows.filter((r) => r.table === 'rcm_user_map');
  assert.equal(users.length, 3);
  for (const r of users) {
    // rcm_user_map has a CHECK that the email equals its own lowercase.
    assert.equal(r.row.platform_email, r.row.platform_email.toLowerCase());
    assert.match(r.row.platform_email, /@example\.invalid$/);
  }
});

test('--user-map overrides emails but cannot remove the identities rows attribute to', () => {
  const merged = applyUserMapOverrides({ 'fixture-poster': 'Billing.Lead@Example.Com', extra: 'x@example.invalid' });
  const byKey = new Map(merged.map((u) => [u.user_key, u]));
  assert.equal(byKey.get('fixture-poster').platform_email, 'billing.lead@example.com');
  assert.ok(byKey.has('fixture-lead'), 'fixture-lead must survive an override');
  assert.ok(byKey.has('extra'));

  const plan = buildFixturePlan({ userMap: merged });
  assert.equal(plan.rows.filter((r) => r.table === 'rcm_user_map').length, 4);
});

test('buildFixturePlan rejects a user map missing an identity the fixture attributes to', () => {
  assert.throws(
    () => buildFixturePlan({ userMap: [{ user_key: 'someone', platform_email: 'someone@example.invalid' }] }),
    /must contain 'fixture-poster'/
  );
});

test('buildFixturePlan rejects an uppercase email — the CHECK would reject it at INSERT', () => {
  assert.throws(
    () =>
      buildFixturePlan({
        userMap: [
          { user_key: 'fixture-poster', platform_email: 'Poster@example.invalid' },
          { user_key: 'fixture-lead', platform_email: 'lead@example.invalid' },
        ],
      }),
    /must be lowercase/
  );
});
