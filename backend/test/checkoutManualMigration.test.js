'use strict';

/**
 * CO-5a's tenant migration, 1793600000000_tc_checkout_manual: two NULLABLE
 * columns on tc_checkout_handoffs (old rows stay NULL and read as hygiene), a
 * CHECK led by IS NULL, the partial unique index that arbitrates two racing
 * "Add patient" clicks, a clean down, numbered above every migration before it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1793600000000_tc_checkout_manual.js');
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

test('additive only: two NULLABLE columns, no default, no table, no raw SQL', () => {
  const calls = capture();
  assert.equal(calls.filter((c) => c.op === 'createTable' || c.op === 'sql').length, 0);
  const added = calls.filter((c) => c.op === 'addColumns');
  assert.equal(added.length, 1);
  assert.equal(added[0].args[0], 'tc_checkout_handoffs');
  assert.deepEqual(Object.keys(added[0].args[1]), ['source', 'hygiene_merged_at']);
  assert.equal(added[0].args[1].source.type, 'text');
  assert.equal(added[0].args[1].hygiene_merged_at.type, 'timestamptz');
  for (const col of Object.values(added[0].args[1])) {
    assert.notEqual(col.notNull, true);
    assert.equal(col.default, undefined, 'old rows stay NULL; the reader reads them as hygiene');
  }
});

test('the source CHECK is led by IS NULL and allows exactly hygiene and manual', () => {
  const c = capture().find((x) => x.op === 'addConstraint');
  assert.equal(c.args[1], 'tc_checkout_handoffs_source_check');
  assert.equal(c.args[2].check, "source IS NULL OR source IN ('hygiene', 'manual')");
});

test('the dedupe arbiter: UNIQUE per office, patient and day, over manual cards that still hold the patient', () => {
  const idx = capture().find((x) => x.op === 'createIndex');
  assert.equal(idx.args[0], 'tc_checkout_handoffs');
  assert.deepEqual(idx.args[1], ['office_id', 'od_patient_id', 'visit_date']);
  assert.equal(idx.args[2].name, 'tc_checkout_handoffs_manual_patient_day_key');
  assert.equal(idx.args[2].unique, true);
  assert.equal(idx.args[2].where, "source = 'manual' AND status NOT IN ('dismissed', 'expired')");
  // The statuses the index releases are the ones the store's "holding" rule releases.
  assert.deepEqual([...checkoutStore.RELEASES_INBOX_STATUSES].sort(), ['dismissed', 'expired']);
});

test('down() drops the index, then the constraint, then the columns', () => {
  const ops = capture('down').map((c) => c.op);
  assert.deepEqual(ops, ['dropIndex', 'dropConstraint', 'dropColumns']);
});

test("numbered above develop's newest at the time (CO-1's workup); uniform width; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
  assert.ok(numbers.includes(1793600000000));
  assert.ok(1793600000000 > 1793500000000);
});

test('every column the store SELECTs exists once every tenant migration has run', () => {
  const table = buildTenantSchema().get('tc_checkout_handoffs');
  assert.deepEqual(checkoutStore.COLS.filter((c) => !table.has(c)), []);
  assert.ok(table.has('source') && table.has('hygiene_merged_at'));
});
