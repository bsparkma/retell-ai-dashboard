'use strict';

/**
 * Unit tests for migrations-tenant/1786622400000_rcm_schema.
 *
 * CI has no standing tenant DB at unit-test time, so this exercises the
 * migration against a capturing mock of node-pg-migrate's MigrationBuilder and
 * asserts the SQL semantics — the same approach as rolesSpineMigration.test.js
 * and renameModuleMigration.test.js. Real application against Postgres is
 * covered by the CI staging gate (`node scripts/migrate-tenant.js up`) and by
 * the throwaway-PG16 rehearsal recorded in the Slice 1 PR.
 *
 * The properties under test are the ones that would hurt in production:
 *  - EVERY created table is granted to the app role (the call_record grant gap
 *    was a near-miss; a CREATE without a GRANT is a defect);
 *  - EVERY data table carries office_id NOT NULL with the frozen-key CHECK;
 *  - the remittance-key uniqueness is office-scoped, not global;
 *  - money columns are integer cents, never float;
 *  - down() removes exactly what up() created, children first;
 *  - audit_log is not touched at all.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const migration = require('../migrations-tenant/1786622400000_rcm_schema.js');

function makePgm() {
  const calls = {
    sql: [],
    createTable: [],
    dropTable: [],
    addConstraint: [],
    createIndex: [],
  };
  return {
    calls,
    sql: (text) => calls.sql.push(String(text)),
    func: (expr) => ({ __func: expr }),
    createTable: (name, cols) => calls.createTable.push({ name, cols }),
    dropTable: (name, opts) => calls.dropTable.push({ name, opts }),
    addConstraint: (table, name, opts) => calls.addConstraint.push({ table, name, opts }),
    createIndex: (table, cols, opts) => calls.createIndex.push({ table, cols, opts }),
  };
}

function runUp() {
  const pgm = makePgm();
  migration.up(pgm);
  return pgm;
}

/** Every column of every created table, flattened to {table, column, def}. */
function allColumns(pgm) {
  const out = [];
  for (const { name, cols } of pgm.calls.createTable) {
    for (const [column, def] of Object.entries(cols)) out.push({ table: name, column, def });
  }
  return out;
}

// --- table inventory -------------------------------------------------------

test('up() creates exactly the tables named in RCM_TABLES, in that order', () => {
  const pgm = runUp();
  const created = pgm.calls.createTable.map((t) => t.name);
  assert.deepEqual(created, migration.RCM_TABLES);
  assert.equal(created.length, 24);
});

test('every created table is prefixed rcm_ (the module namespace)', () => {
  for (const table of migration.RCM_TABLES) {
    assert.match(table, /^rcm_[a-z0-9_]+$/, `${table} is not a snake_case rcm_ table`);
  }
});

test('the two platform-native queue tables exist', () => {
  assert.ok(migration.RCM_TABLES.includes('rcm_posting_queue'));
  assert.ok(migration.RCM_TABLES.includes('rcm_posting_queue_line'));
});

test('the excluded source tables are NOT ported', () => {
  // `users` (standalone auth, replaced by the platform roles spine + rcm_user_map)
  // and `plaidItems` (holds a live credential; secrets belong in Key Vault).
  for (const absent of ['rcm_users', 'rcm_plaid_items']) {
    assert.ok(!migration.RCM_TABLES.includes(absent), `${absent} must not be ported`);
  }
  assert.ok(migration.RCM_TABLES.includes('rcm_user_map'), 'the crosswalk replaces `users`');
});

// --- grants: the non-negotiable ---------------------------------------------

test('up() grants CRUD on EVERY created table to the app role, in one guarded block', () => {
  const pgm = runUp();
  const grantBlock = pgm.calls.sql.find((s) => s.includes('GRANT SELECT, INSERT, UPDATE, DELETE'));
  assert.ok(grantBlock, 'a grant block must exist');

  for (const table of migration.RCM_TABLES) {
    assert.ok(
      grantBlock.includes(`'${table}'`),
      `${table} is created but never granted — that is the defect this test exists for`
    );
  }
  // Guarded on the role existing, so a superuser dev box gets a NOTICE, not a crash.
  assert.match(grantBlock, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\)/);
  assert.match(grantBlock, /REVOKE ALL ON TABLE %I FROM PUBLIC/);
  assert.ok(grantBlock.includes(`'${migration.APP_ROLE}'`));
});

test('the grant block touches nothing outside rcm_*  — audit_log stays append-only', () => {
  const pgm = runUp();
  const all = pgm.calls.sql.join('\n');
  assert.ok(!/audit_log/i.test(all), 'this migration must never mention audit_log');
  assert.ok(!/ALTER DEFAULT PRIVILEGES/i.test(all));
  // Nothing but the extension and the grant block is emitted as raw SQL.
  assert.equal(pgm.calls.sql.length, 2);
  assert.match(pgm.calls.sql[0], /CREATE EXTENSION IF NOT EXISTS pgcrypto/);
});

test('additive only: up() creates and grants, it never alters or drops an existing table', () => {
  const pgm = runUp();
  const all = pgm.calls.sql.join('\n');
  assert.ok(!/DROP TABLE/i.test(all));
  assert.ok(!/ALTER TABLE (?!%I)/i.test(all));
  // Every constraint/index it adds lands on a table it just created.
  for (const { table } of [...pgm.calls.addConstraint, ...pgm.calls.createIndex]) {
    assert.ok(
      migration.RCM_TABLES.includes(table),
      `${table} is not created by this migration — additive-only violated`
    );
  }
});

// --- office_id: part of the data model, not an attribute --------------------

test('every table except the documented tenant-global one has office_id NOT NULL', () => {
  const pgm = runUp();
  for (const { name, cols } of pgm.calls.createTable) {
    if (migration.TENANT_GLOBAL_TABLES.includes(name)) {
      assert.ok(!cols.office_id, `${name} is tenant-global and must NOT carry office_id`);
      continue;
    }
    assert.ok(cols.office_id, `${name} has no office_id`);
    const isPk = cols.office_id.primaryKey === true;
    assert.ok(
      cols.office_id.notNull === true || isPk,
      `${name}.office_id must be NOT NULL (or the primary key)`
    );
    assert.equal(cols.office_id.type, 'text', `${name}.office_id must be text`);
  }
  assert.deepEqual(migration.TENANT_GLOBAL_TABLES, ['rcm_user_map']);
});

test('every table with office_id constrains it to the frozen office keys', () => {
  const pgm = runUp();
  const checks = pgm.calls.addConstraint.filter((c) => c.opts.check === migration.OFFICE_CHECK);
  const checked = new Set(checks.map((c) => c.table));

  for (const table of migration.RCM_TABLES) {
    if (migration.TENANT_GLOBAL_TABLES.includes(table)) continue;
    assert.ok(checked.has(table), `${table}.office_id has no frozen-key CHECK`);
  }
  assert.equal(migration.OFFICE_CHECK, "office_id IN ('roland', 'valley')");
});

// --- the remittance key: the dedupe primitive -------------------------------

test('remittance-key uniqueness is office-scoped, never global', () => {
  const pgm = runUp();
  const uniques = pgm.calls.addConstraint.filter((c) => c.opts.unique);

  const dedupe = uniques.find((c) => c.table === 'rcm_remittance_keys');
  assert.ok(dedupe, 'rcm_remittance_keys must carry a uniqueness constraint');
  assert.deepEqual(dedupe.opts.unique, ['office_id', 'remittance_key']);

  // The queue enqueues on the same primitive.
  const queue = uniques.find((c) => c.name === 'rcm_posting_queue_office_remittance_unique');
  assert.ok(queue, 'the posting queue must be idempotent on the same primitive');
  assert.deepEqual(queue.opts.unique, ['office_id', 'remittance_key']);

  // A bare single-column unique on remittance_key would let one office's
  // remittance block the other's.
  const cols = pgm.calls.createTable.find((t) => t.name === 'rcm_remittance_keys').cols;
  assert.notEqual(cols.remittance_key.unique, true);
});

// --- money ------------------------------------------------------------------

test('every money column is integer cents — no float, numeric or money type anywhere', () => {
  const pgm = runUp();
  const banned = /^(real|double precision|numeric|decimal|money|float)/i;
  for (const { table, column, def } of allColumns(pgm)) {
    assert.ok(!banned.test(String(def.type)), `${table}.${column} is ${def.type} — money is cents`);
    if (/_cents$/.test(column)) {
      assert.ok(
        def.type === 'bigint' || def.type === 'integer',
        `${table}.${column} must be an integer type, got ${def.type}`
      );
    }
  }
  // And the amount columns are actually named that way, so the unit is visible
  // at every call site.
  const centsCols = allColumns(pgm).filter((c) => /_cents$/.test(c.column));
  assert.ok(centsCols.length >= 30, `expected the money surface to be broad, saw ${centsCols.length}`);
});

// --- dates: no varchar dates survive the port -------------------------------

test('no date-like column is stored as text', () => {
  const pgm = runUp();
  const dateish = /(_date|_at|^ts$|_dob)$/;
  for (const { table, column, def } of allColumns(pgm)) {
    if (!dateish.test(column)) continue;
    assert.ok(
      def.type === 'date' || def.type === 'timestamptz',
      `${table}.${column} is ${def.type} — the port converts varchar dates to real dates`
    );
  }
});

test('every timestamp carries a zone (timestamptz, never bare timestamp)', () => {
  const pgm = runUp();
  for (const { table, column, def } of allColumns(pgm)) {
    assert.notEqual(def.type, 'timestamp', `${table}.${column} must be timestamptz`);
  }
});

// --- referential integrity --------------------------------------------------

test('the FK graph is declared, and every ON DELETE is explicit', () => {
  const pgm = runUp();

  const inlineFks = allColumns(pgm).filter((c) => c.def.references);
  const addedFks = pgm.calls.addConstraint.filter((c) => c.opts.foreignKeys);

  for (const { table, column, def } of inlineFks) {
    assert.ok(
      ['CASCADE', 'RESTRICT', 'SET NULL'].includes(def.onDelete),
      `${table}.${column} references ${def.references} with no deliberate ON DELETE`
    );
  }
  for (const { table, name, opts } of addedFks) {
    assert.ok(
      ['CASCADE', 'RESTRICT', 'SET NULL'].includes(opts.foreignKeys.onDelete),
      `${table} constraint ${name} has no deliberate ON DELETE`
    );
  }

  // The source had 5 FKs across 23 tables; the port is meant to be materially
  // stronger than that.
  assert.ok(
    inlineFks.length + addedFks.length >= 25,
    `expected a dense FK graph, saw ${inlineFks.length + addedFks.length}`
  );
});

test('money-bearing children RESTRICT rather than CASCADE', () => {
  const pgm = runUp();
  const byTable = Object.fromEntries(pgm.calls.createTable.map((t) => [t.name, t.cols]));

  // Deleting a claim must not erase its payment history or its posted money.
  assert.equal(byTable.rcm_claim_payment_history.claim_id.onDelete, 'RESTRICT');
  assert.equal(byTable.rcm_claim_payment_history.batch_id.onDelete, 'RESTRICT');
  assert.equal(byTable.rcm_batch_claim_payments.claim_id.onDelete, 'RESTRICT');
  // A batch with a posting audit is not deletable at all — the source declared
  // this column NOT NULL *and* ON DELETE SET NULL, which could only have raised
  // a not-null violation.
  assert.equal(byTable.rcm_posting_audits.batch_id.notNull, true);
  assert.equal(byTable.rcm_posting_audits.batch_id.onDelete, 'RESTRICT');
  // The remittance key must OUTLIVE its batch — that is its entire job.
  assert.equal(byTable.rcm_remittance_keys.batch_id.onDelete, 'SET NULL');
});

test('every actor column is crosswalk-typed against rcm_user_map', () => {
  const pgm = runUp();
  const actorish = /(^created_by$|^posted_by$|^approved_by$|_user_key$)/;
  const actors = allColumns(pgm).filter((c) => actorish.test(c.column));

  assert.ok(actors.length >= 9, `expected the actor surface to be broad, saw ${actors.length}`);
  for (const { table, column, def } of actors) {
    assert.equal(def.references, 'rcm_user_map', `${table}.${column} is not crosswalk-typed`);
    assert.equal(def.onDelete, 'RESTRICT', `${table}.${column} must not lose attribution on delete`);
  }
});

// --- the posting queue ------------------------------------------------------

test('the queue can honestly represent approved-not-posted and failed-mid-sequence', () => {
  const pgm = runUp();
  const status = pgm.calls.addConstraint.find((c) => c.name === 'rcm_posting_queue_status_check');
  assert.ok(status);
  for (const state of ['approved', 'posting', 'posted', 'failed', 'partially_posted']) {
    assert.ok(status.opts.check.includes(`'${state}'`), `queue cannot express '${state}'`);
  }

  const cols = pgm.calls.createTable.find((t) => t.name === 'rcm_posting_queue').cols;
  // Recoupments are the one irreversible OD operation — marked from day one.
  assert.equal(cols.is_recoupment.type, 'boolean');
  assert.equal(cols.is_recoupment.notNull, true);
  // OD's DateCP is not writable (G2), so the carrier's date lives here.
  assert.equal(cols.carrier_eob_date.type, 'date');
  // Approval attribution is separate from execution timestamps, and a queue row
  // cannot exist without a named approver.
  assert.equal(cols.approved_by.notNull, true);
  assert.equal(cols.approved_by.references, 'rcm_user_map');
  assert.ok(cols.approved_at.notNull);
  assert.ok('started_at' in cols && 'finished_at' in cols);
});

test('the queue records intended per-line amounts as queryable columns, not a jsonb blob', () => {
  const pgm = runUp();
  const cols = pgm.calls.createTable.find((t) => t.name === 'rcm_posting_queue_line').cols;

  // The three amounts §8 says recovery requires, in cents, NOT NULL on the one
  // that drives CheckAmt.
  assert.equal(cols.intended_ins_pay_amt_cents.type, 'bigint');
  assert.equal(cols.intended_ins_pay_amt_cents.notNull, true);
  assert.equal(cols.intended_write_off_cents.type, 'bigint');
  assert.equal(cols.intended_ded_applied_cents.type, 'bigint');
  // Addressed by ClaimProcNum, which is what a resume has to work from.
  assert.equal(cols.od_claim_proc_num.type, 'bigint');
  assert.equal(cols.od_claim_proc_num.notNull, true);
  // Per-line progress through the forced sequence.
  const status = pgm.calls.addConstraint.find(
    (c) => c.name === 'rcm_posting_queue_line_status_check'
  );
  for (const state of ['pending', 'claimproc_written', 'claim_received', 'paid', 'failed', 'skipped']) {
    assert.ok(status.opts.check.includes(`'${state}'`), `line cannot express '${state}'`);
  }
  // No jsonb anywhere on the line — the whole point is that it is queryable.
  for (const [column, def] of Object.entries(cols)) {
    assert.notEqual(def.type, 'jsonb', `queue line column ${column} must not be a blob`);
  }
});

test('the queue is worker-split safe: it references only rcm_* tables', () => {
  const pgm = runUp();
  const queueTables = ['rcm_posting_queue', 'rcm_posting_queue_line'];
  const refs = allColumns(pgm)
    .filter((c) => queueTables.includes(c.table) && c.def.references)
    .map((c) => c.def.references);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.match(ref, /^rcm_/, `the queue must not couple to ${ref}`);
  }
});

// --- CARC/RARC --------------------------------------------------------------

test('CARC/RARC codes are typed columns — OD cannot store them, so we must', () => {
  const pgm = runUp();
  const cols = pgm.calls.createTable.find((t) => t.name === 'rcm_procedure_adjustments').cols;

  assert.equal(cols.group_code.notNull, true); // CARC group
  assert.equal(cols.reason_code.notNull, true); // CARC
  assert.ok('remark_code' in cols); // RARC
  assert.equal(cols.amount_cents.type, 'bigint');

  const group = pgm.calls.addConstraint.find(
    (c) => c.name === 'rcm_procedure_adjustments_group_check'
  );
  for (const code of ['CO', 'PR', 'OA', 'PI', 'CR']) {
    assert.ok(group.opts.check.includes(`'${code}'`));
  }
});

// --- enums became CHECKs ----------------------------------------------------

test('the source pgEnums became text + CHECK, so down() has no types to drop', () => {
  const pgm = runUp();
  const all = pgm.calls.sql.join('\n');
  assert.ok(!/CREATE TYPE/i.test(all), 'no enum types');
  const checks = pgm.calls.addConstraint.filter((c) => c.opts.check);
  assert.ok(checks.length >= 25, `expected broad CHECK coverage, saw ${checks.length}`);
});

// --- down() -----------------------------------------------------------------

test('down() drops exactly what up() created, children before parents', () => {
  const pgm = makePgm();
  migration.down(pgm);

  const dropped = pgm.calls.dropTable.map((d) => d.name);
  assert.deepEqual(dropped, [...migration.RCM_TABLES].reverse());
  assert.equal(dropped.length, migration.RCM_TABLES.length);
  // Nothing outside this migration is touched on the way down.
  assert.equal(pgm.calls.sql.length, 0);
});

test('up()/down() round-trip: the drop set equals the create set', () => {
  const up = runUp();
  const down = makePgm();
  migration.down(down);

  const created = new Set(up.calls.createTable.map((t) => t.name));
  const dropped = new Set(down.calls.dropTable.map((d) => d.name));
  assert.deepEqual([...created].sort(), [...dropped].sort());
});

// --- determinism ------------------------------------------------------------

test('up() emits identical SQL on a second run (no clock, no randomness)', () => {
  const a = runUp();
  const b = runUp();
  assert.deepEqual(a.calls.sql, b.calls.sql);
  assert.deepEqual(
    a.calls.createTable.map((t) => t.name),
    b.calls.createTable.map((t) => t.name)
  );
});
