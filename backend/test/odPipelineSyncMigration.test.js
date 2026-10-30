'use strict';

/**
 * CO-4b's tenant migration, 1793900000000_tc_od_pipeline_sync: four NULLABLE
 * columns on tc_cases (old cases stay NULL = never touched by the sync), the
 * tc_od_sync_runs table with its carein_app grant, two-valued CHECKs, a clean
 * down, numbered above CO-4a's 1793800000000.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1793900000000_tc_od_pipeline_sync.js');

function capture(direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    func: (expr) => ({ __func: expr }),
    sql: rec('sql'),
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    createIndex: rec('createIndex'),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
  };
  migration[direction](pgm);
  return calls;
}

test('additive: four NULLABLE tc_cases columns with no default', () => {
  const [added] = capture().filter((c) => c.op === 'addColumns');
  assert.equal(added.args[0], 'tc_cases');
  assert.deepEqual(Object.keys(added.args[1]), ['od_sync_action', 'od_sync_flag', 'od_sync_undone', 'od_sync_checked_at']);
  assert.deepEqual(Object.values(added.args[1]).map((c) => c.type), ['jsonb', 'jsonb', 'jsonb', 'timestamptz']);
  for (const col of Object.values(added.args[1])) {
    assert.notEqual(col.notNull, true);
    assert.equal(col.default, undefined, 'old cases stay NULL');
  }
});

test('the CHECKs are two-valued (led by IS NULL) and name the closed vocabularies', () => {
  const checks = Object.fromEntries(capture().filter((c) => c.op === 'addConstraint').map((c) => [c.args[1], c.args[2].check]));
  for (const [name, check] of Object.entries(checks)) {
    if (name.startsWith('tc_cases_') || name.endsWith('summary_object_check')) assert.match(check, /^\w+ IS NULL OR \(?/, name);
  }
  assert.match(checks.tc_cases_od_sync_action_object_check, /'completed', 'unscheduled', 'rescheduled'/);
  assert.match(checks.tc_cases_od_sync_flag_object_check, /'missing', 'status', 'patient', 'multiple'/);
  assert.equal(checks.tc_od_sync_runs_trigger_check, "trigger IN ('manual', 'nightly')");
  assert.equal(checks.tc_od_sync_runs_status_check, "status IN ('running', 'ok', 'failed')");
});

test('the runs table is granted to the app role, never PUBLIC', () => {
  const [sql] = capture().filter((c) => c.op === 'sql');
  assert.match(sql.args[0], /REVOKE ALL ON TABLE tc_od_sync_runs FROM PUBLIC/);
  assert.match(sql.args[0], /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tc_od_sync_runs TO %I/);
});

test('down() drops the table, then every constraint before the columns', () => {
  const ops = capture('down').map((c) => c.op);
  assert.deepEqual(ops, ['dropTable', 'dropConstraint', 'dropConstraint', 'dropConstraint', 'dropColumns']);
});

test("numbered above CO-4a's 1793800000000; uniform width; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
  assert.ok(numbers.includes(1793900000000));
  assert.ok(1793900000000 > 1793800000000);
});

test('every column the sync reads or writes exists once every tenant migration has run', () => {
  const schema = buildTenantSchema();
  const src = fs.readFileSync(path.join(__dirname, '../services/tc/odPipelineSync.js'), 'utf8');
  const cases = schema.get('tc_cases');
  for (const c of ['od_sync_action', 'od_sync_flag', 'od_sync_undone', 'od_sync_checked_at', 'status', 'status_changed_at', 'patient_name']) {
    assert.ok(cases.has(c), `tc_cases.${c}`);
  }
  const runs = schema.get('tc_od_sync_runs');
  assert.ok(runs, 'tc_od_sync_runs exists');
  for (const c of ['run_id', 'office_id', 'trigger', 'requested_by', 'started_at', 'finished_at', 'status', 'summary', 'error_code']) {
    assert.ok(runs.has(c), `tc_od_sync_runs.${c}`);
    assert.ok(src.includes(c), `the engine names ${c}`);
  }
});
