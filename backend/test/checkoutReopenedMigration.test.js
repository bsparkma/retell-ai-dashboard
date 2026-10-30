'use strict';

/**
 * The CO-5a fix's tenant migration, 1793700000000_tc_checkout_reopened: one
 * NULLABLE jsonb column on tc_checkout_handoffs (never-reopened cards stay
 * NULL), an object-or-NULL CHECK led by IS NULL, a clean down, numbered above
 * CO-5a's own 1793600000000.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1793700000000_tc_checkout_reopened.js');
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
    dropIndex: rec('dropIndex'),
    createTable: rec('createTable'),
  };
  migration[direction](pgm);
  return calls;
}

test('additive only: one NULLABLE jsonb column, no default, no table, no raw SQL', () => {
  const calls = capture();
  assert.equal(calls.filter((c) => c.op === 'createTable' || c.op === 'sql').length, 0);
  const added = calls.filter((c) => c.op === 'addColumns');
  assert.equal(added.length, 1);
  assert.equal(added[0].args[0], 'tc_checkout_handoffs');
  assert.deepEqual(Object.keys(added[0].args[1]), ['reopened_from']);
  assert.equal(added[0].args[1].reopened_from.type, 'jsonb');
  assert.notEqual(added[0].args[1].reopened_from.notNull, true);
  assert.equal(added[0].args[1].reopened_from.default, undefined);
});

test('the CHECK is led by IS NULL and requires an object', () => {
  const c = capture().find((x) => x.op === 'addConstraint');
  assert.equal(c.args[1], 'tc_checkout_handoffs_reopened_from_object_check');
  assert.equal(c.args[2].check, "reopened_from IS NULL OR jsonb_typeof(reopened_from) = 'object'");
});

test('down() drops the constraint before the column', () => {
  assert.deepEqual(capture('down').map((c) => c.op), ['dropConstraint', 'dropColumns']);
});

test('numbered above CO-5a (1793600000000); uniform width; unique', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
  assert.ok(numbers.includes(1793700000000));
  assert.ok(1793700000000 > 1793600000000);
});

test('every column the store SELECTs exists once every tenant migration has run', () => {
  const table = buildTenantSchema().get('tc_checkout_handoffs');
  assert.deepEqual(checkoutStore.COLS.filter((c) => !table.has(c)), []);
  assert.ok(table.has('reopened_from'));
});
