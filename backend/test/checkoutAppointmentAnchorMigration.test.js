'use strict';

/**
 * CO-4a's tenant migration, 1793800000000_tc_checkout_appointment_anchor: five
 * NULLABLE columns on tc_checkout_handoffs (old rows stay NULL = unanchored),
 * two-valued CHECKs (all-or-none, Scheduled only, the wall-clock shape, an
 * object snapshot), a clean down, numbered above the CO-5a fix's 1793700000000.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1793800000000_tc_checkout_appointment_anchor.js');
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

test('additive only: five NULLABLE columns with no default, no table, no raw SQL', () => {
  const calls = capture();
  assert.equal(calls.filter((c) => c.op === 'createTable' || c.op === 'sql').length, 0);
  const [added] = calls.filter((c) => c.op === 'addColumns');
  assert.equal(added.args[0], 'tc_checkout_handoffs');
  assert.deepEqual(Object.keys(added.args[1]), ['appt_num', 'appt_at_local', 'appt_snapshot', 'appt_linked_by', 'appt_linked_at']);
  assert.deepEqual(Object.values(added.args[1]).map((c) => c.type), ['bigint', 'text', 'jsonb', 'text', 'timestamptz']);
  for (const col of Object.values(added.args[1])) {
    assert.notEqual(col.notNull, true);
    assert.equal(col.default, undefined, 'old rows stay NULL: unanchored');
  }
});

test('the CHECKs: all-or-none (no NULL can slip past), Scheduled only, the wall-clock shape, an object snapshot', () => {
  const checks = Object.fromEntries(capture().filter((c) => c.op === 'addConstraint').map((c) => [c.args[1], c.args[2].check]));
  assert.deepEqual(Object.keys(checks), [
    'tc_checkout_handoffs_appt_all_or_none_check',
    'tc_checkout_handoffs_appt_scheduled_check',
    'tc_checkout_handoffs_appt_at_shape_check',
    'tc_checkout_handoffs_appt_snapshot_object_check',
  ]);
  // Both branches are led by IS [NOT] NULL tests, so the expression is never NULL.
  assert.match(checks.tc_checkout_handoffs_appt_all_or_none_check, /^\(appt_num IS NULL AND .+\) OR \(appt_num IS NOT NULL AND appt_num > 0 AND .+\)$/);
  assert.equal(checks.tc_checkout_handoffs_appt_scheduled_check, "appt_num IS NULL OR status = 'scheduled'");
  assert.match(checks.tc_checkout_handoffs_appt_at_shape_check, /^appt_at_local IS NULL OR /);
  assert.equal(checks.tc_checkout_handoffs_appt_snapshot_object_check, "appt_snapshot IS NULL OR jsonb_typeof(appt_snapshot) = 'object'");
});

test('down() drops every constraint before the columns', () => {
  const ops = capture('down').map((c) => c.op);
  assert.deepEqual(ops, ['dropConstraint', 'dropConstraint', 'dropConstraint', 'dropConstraint', 'dropColumns']);
});

test('numbered above the CO-5a fix (1793700000000); uniform width; unique', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
  assert.ok(numbers.includes(1793800000000));
  assert.ok(1793800000000 > 1793700000000);
});

test('every column the store SELECTs exists once every tenant migration has run', () => {
  const table = buildTenantSchema().get('tc_checkout_handoffs');
  assert.deepEqual(checkoutStore.COLS.filter((c) => !table.has(c)), []);
});
