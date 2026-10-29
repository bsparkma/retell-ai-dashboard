'use strict';

/**
 * hyg_existing_tx_disposition: the MIGRATION and the CONTRACT agree, and the
 * table is reachable by the least-privilege app role.
 *
 * The CHECKs in migrations-tenant/1792800000000_hyg_existing_tx_disposition.js
 * are inline literals on purpose (see that file's header). This is what pays
 * for that choice: every list the database enforces is asserted against the zod
 * enum the API and the screen use, by reading the CHECK the migration actually
 * emits — not only the exported constant beside it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../../migrations-tenant/1792800000000_hyg_existing_tx_disposition.js');
const contract = require('../../hyg/contract.gen.cjs');
const { buildTenantSchema } = require('../../scripts/lib/tenantSchemaReplay');

const FILE = '1792800000000_hyg_existing_tx_disposition.js';
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations-tenant');
const SOURCE = fs.readFileSync(path.join(MIGRATIONS_DIR, FILE), 'utf8');

function capture() {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    func: (expr) => ({ __func: expr }),
    sql: rec('sql'),
    createTable: rec('createTable'),
    addConstraint: rec('addConstraint'),
    createIndex: rec('createIndex'),
  };
  migration.up(pgm);
  return calls;
}

/** The constraint `name` on the table, as emitted. */
function constraint(calls, name) {
  const c = calls.find((x) => x.op === 'addConstraint' && x.args[1] === name);
  assert.ok(c, `no constraint ${name}`);
  return c.args[2];
}

/** The IN-list of a CHECK, as emitted. */
function inList(check) {
  const m = /IN \(([^)]+)\)/.exec(check);
  assert.ok(m, check);
  return m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
}

test('the CHECK vocabularies equal the shared contract’s', () => {
  const calls = capture();
  const t = migration.TABLE;
  assert.deepEqual(inList(constraint(calls, `${t}_clinical_check`).check), contract.ExistingTxClinicalSchema.options);
  assert.deepEqual(inList(constraint(calls, `${t}_patient_check`).check), contract.ExistingTxPatientSchema.options);
  assert.deepEqual(
    inList(constraint(calls, `${t}_wait_timeframe_check`).check),
    contract.ExistingTxWaitSchema.options
  );
  assert.deepEqual(inList(constraint(calls, `${t}_office_check`).check), contract.OfficeIdSchema.options);
  assert.equal(migration.NOTE_MAX, contract.EXISTING_TX_NOTE_MAX);
  assert.match(constraint(calls, `${t}_note_check`).check, new RegExp(`<= ${contract.EXISTING_TX_NOTE_MAX}\\b`));
});

test('every nullable CHECK states its NULL case — Postgres accepts a NULL-evaluating CHECK', () => {
  const calls = capture();
  const t = migration.TABLE;
  assert.match(constraint(calls, `${t}_clinical_check`).check, /^clinical IS NULL OR /);
  assert.match(constraint(calls, `${t}_wait_timeframe_check`).check, /^wait_timeframe IS NULL OR /);
  assert.match(constraint(calls, `${t}_note_check`).check, /^note IS NULL OR /);
  assert.equal(
    constraint(calls, `${t}_wait_only_when_waiting_check`).check,
    "patient = 'wants_to_wait' OR wait_timeframe IS NULL"
  );
});

test('the table shape: office-keyed, unique per visit and procedure, FK carries the office', () => {
  const calls = capture();
  const t = migration.TABLE;
  const create = calls.find((c) => c.op === 'createTable');
  const cols = create.args[1];
  assert.equal(create.args[0], 'hyg_existing_tx_disposition');
  for (const c of ['office', 'visit_id', 'pat_num', 'proc_num', 'patient', 'proc_snapshot', 'created_by', 'updated_by']) {
    assert.equal(cols[c].notNull, true, `${c} is NOT NULL`);
  }
  assert.equal(cols.patient.default, 'not_discussed');
  assert.equal(cols.proc_snapshot.type, 'jsonb');
  assert.equal(cols.pat_num.type, 'bigint');
  assert.equal(cols.proc_num.type, 'bigint');
  assert.ok(!cols.clinical.notNull, 'clinical has no default answer');

  assert.deepEqual(constraint(calls, `${t}_key`).unique, ['office', 'visit_id', 'proc_num']);
  assert.deepEqual(constraint(calls, `${t}_visit_fk`).foreignKeys, {
    columns: ['visit_id', 'office'],
    references: 'hyg_visit(visit_id, office)',
    onDelete: 'CASCADE',
  });
  assert.equal(constraint(calls, `${t}_pat_num_check`).check, 'pat_num > 0');
  assert.equal(constraint(calls, `${t}_proc_num_check`).check, 'proc_num > 0');
});

test('the table is granted to the app role in this migration', () => {
  assert.match(SOURCE, /REVOKE ALL ON TABLE %I FROM PUBLIC/);
  assert.match(SOURCE, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
  assert.match(SOURCE, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\)/);
  assert.ok(!/audit_log/.test(SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'audit_log untouched');
});

test('it sorts after every other tenant migration, with a unique timestamp', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.js$/.test(f)).sort();
  const stamps = files.map((f) => f.split('_')[0]);
  assert.equal(new Set(stamps).size, stamps.length, 'timestamps are unique');
  assert.ok(files.indexOf(FILE) > files.indexOf('1792700000000_tc_provider_directory.js'));
});

test('after replaying every tenant migration, the table has the columns the store names', () => {
  const cols = buildTenantSchema().get('hyg_existing_tx_disposition');
  assert.ok(cols, 'the replay knows the table');
  const storeSrc = fs.readFileSync(path.join(__dirname, 'existingTxStore.js'), 'utf8');
  for (const c of [
    'office', 'visit_id', 'pat_num', 'proc_num', 'clinical', 'patient', 'wait_timeframe', 'note',
    'proc_snapshot', 'created_by', 'created_at', 'updated_by', 'updated_at',
  ]) {
    assert.ok(cols.has(c), c);
    assert.ok(storeSrc.includes(c), `the store names ${c}`);
  }
});
