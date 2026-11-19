'use strict';

/**
 * 1795200000000_hyg_visit_addendum — the after-Send addendum's table.
 *
 * The source-level half: numbering, the inline CHECK literals pinned to the
 * shared contract, the append-only grants (no DELETE), the write-once trigger,
 * and a down() that refuses while any addendum exists. The real-Postgres half
 * is scripts/hyg-visit-addendum-verify-queries.js, which CI runs after migrate.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../migrations-tenant/1795200000000_hyg_visit_addendum.js');
const visitStore = require('../services/hyg/visitStore');
const hygContract = require('../hyg/contract.gen.cjs');

const SELF = 1795200000000;
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations-tenant');
const SOURCE = fs.readFileSync(path.join(MIGRATIONS_DIR, '1795200000000_hyg_visit_addendum.js'), 'utf8');

function capture(direction) {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    sql: rec('sql'),
    func: (s) => ({ func: s }),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    createIndex: rec('createIndex'),
  };
  migration[direction](pgm);
  return calls;
}

const checks = () =>
  Object.fromEntries(
    capture('up')
      .filter((c) => c.op === 'addConstraint' && c.args[2].check)
      .map((c) => [c.args[1], c.args[2].check])
  );

test("numbered above develop's newest at push (1795100000000); unique; numeric order = filename order", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.js$/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.ok(files.includes('1795100000000_tc_referral_signoff_mode.js'));
  assert.ok(SELF > 1795100000000);
  assert.ok(numbers.includes(SELF));
  assert.equal(new Set(numbers).size, numbers.length, 'no two tenant migrations share a number');
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers, 'filename order is numeric order');
});

test('up(): one table whose columns are exactly the store\'s ADDENDUM_COLUMNS', () => {
  const create = capture('up').filter((c) => c.op === 'createTable');
  assert.equal(create.length, 1);
  assert.equal(create[0].args[0], 'hyg_visit_addendum');
  const columns = Object.keys(create[0].args[1]);
  const storeColumns = visitStore.ADDENDUM_COLUMNS.split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual([...columns].sort(), [...storeColumns].sort(), 'no SELECT names a column the table lacks');
});

test('the CHECK literals are inline and agree with the contract', () => {
  const c = checks();
  assert.equal(c.hyg_visit_addendum_state_check, "state IN ('Staged', 'Sending', 'Written', 'Failed')");
  assert.deepEqual([...c.hyg_visit_addendum_state_check.matchAll(/'([^']+)'/g)].map((m) => m[1]), hygContract.AddendumStateSchema.options);
  assert.deepEqual(migration.ADDENDUM_STATES, hygContract.AddendumStateSchema.options);
  assert.equal(c.hyg_visit_addendum_body_check, 'char_length(btrim(body)) BETWEEN 1 AND 4000');
  assert.equal(migration.BODY_MAX, hygContract.ADDENDUM_TEXT_MAX);
  // MT-2b2's format check, not the two-office list.
  assert.equal(c.hyg_visit_addendum_office_check, "office ~ '^[a-z][a-z0-9_-]{1,31}$'");
  assert.match(c.hyg_visit_addendum_written_check, /\(state = 'Written'\) = \(written_ref IS NOT NULL AND sent_by IS NOT NULL AND sent_at IS NOT NULL\)/);
  assert.equal(c.hyg_visit_addendum_error_check, "(state = 'Failed') = (error_message IS NOT NULL)");
  assert.match(c.hyg_visit_addendum_preview_check, /^CASE WHEN jsonb_typeof\(preview\) = 'array'/);
  assert.doesNotMatch(SOURCE, /check: `/, 'no template-built CHECK');
});

test('the visit FK is office-matched and NO ACTION (a visit with addenda cannot be deleted under them)', () => {
  const fk = capture('up').find((c) => c.op === 'addConstraint' && c.args[1] === 'hyg_visit_addendum_visit_fk');
  assert.deepEqual(fk.args[2].foreignKeys.columns, ['visit_id', 'office']);
  assert.equal(fk.args[2].foreignKeys.references, 'hyg_visit(visit_id, office)');
  assert.equal(fk.args[2].foreignKeys.onDelete, 'NO ACTION');
});

test('append-only: SELECT/INSERT/UPDATE granted, never DELETE; content write-once; Written final', () => {
  const sql = capture('up').filter((c) => c.op === 'sql').map((c) => c.args[0]).join('\n');
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE/);
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE/);
  assert.match(sql, /REVOKE ALL ON TABLE/);
  for (const col of ['body', 'author', 'created_at', 'preview', 'visit_id', 'office', 'addendum_id']) {
    assert.match(sql, new RegExp(`NEW\\.${col} IS DISTINCT FROM OLD\\.${col}`), col);
  }
  assert.match(sql, /OLD\.state = 'Written'/);
  assert.match(sql, /BEFORE UPDATE ON hyg_visit_addendum/);
});

test('down(): REFUSES while any addendum exists, before it drops anything', () => {
  const calls = capture('down');
  assert.equal(calls[0].op, 'sql');
  assert.match(calls[0].args[0], /IF[\s\S]*EXISTS \(SELECT 1 FROM hyg_visit_addendum\)[\s\S]*RAISE EXCEPTION/);
  const dropAt = calls.findIndex((c) => c.op === 'dropTable');
  assert.ok(dropAt > 0, 'the refusal runs first');
  assert.deepEqual(calls[dropAt].args, ['hyg_visit_addendum', { ifExists: true }]);
  assert.match(calls[calls.length - 1].args[0], /DROP FUNCTION IF EXISTS hyg_visit_addendum_write_once\(\)/);
});
