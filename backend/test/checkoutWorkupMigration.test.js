'use strict';

/**
 * CO-1's tenant migration, 1793500000000_tc_checkout_workup: one nullable jsonb
 * column on tc_checkout_handoffs, an object-or-NULL CHECK led by IS NULL, a
 * clean down, numbered above every migration before it, and the store's
 * columns all present once every migration has run.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1793500000000_tc_checkout_workup.js');
const checkoutStore = require('../routes/tc/checkoutStore');

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
  };
  migration[direction](pgm);
  return calls;
}

test('additive only: one NULLABLE jsonb column, no table, no raw SQL, no default', () => {
  const calls = capture();
  assert.equal(calls.filter((c) => c.op === 'createTable' || c.op === 'sql').length, 0);
  const added = calls.filter((c) => c.op === 'addColumns');
  assert.equal(added.length, 1);
  assert.equal(added[0].args[0], 'tc_checkout_handoffs');
  assert.deepEqual(Object.keys(added[0].args[1]), ['workup']);
  assert.equal(added[0].args[1].workup.type, 'jsonb');
  assert.notEqual(added[0].args[1].workup.notNull, true);
  assert.equal(added[0].args[1].workup.default, undefined, 'old rows stay NULL; the reader defaults them');
});

test('the CHECK is two-valued (led by IS NULL) and requires an object', () => {
  const c = capture().find((x) => x.op === 'addConstraint');
  assert.equal(c.args[1], 'tc_checkout_handoffs_workup_object_check');
  assert.equal(c.args[2].check, "workup IS NULL OR jsonb_typeof(workup) = 'object'");
});

test('down() drops the constraint before the column', () => {
  const ops = capture('down').map((c) => c.op);
  assert.deepEqual(ops, ['dropConstraint', 'dropColumns']);
});

test('numbered above every earlier tenant migration; uniform width; unique', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
  assert.ok(1793500000000 > 1793400000000, "above develop's newest at the time (hyg_staff)");
  const ours = numbers.indexOf(1793500000000);
  assert.ok(ours >= 0);
});

test('every column the store SELECTs exists once every tenant migration has run', () => {
  const table = buildTenantSchema().get('tc_checkout_handoffs');
  assert.deepEqual(checkoutStore.COLS.filter((c) => !table.has(c)), []);
  assert.ok(table.has('workup'));
});
