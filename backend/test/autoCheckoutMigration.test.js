'use strict';

/**
 * CO-5b's tenant migration, 1794000000000_tc_auto_checkout_cards: the source
 * CHECK widened to 'schedule', two NULLABLE origin columns (old cards stay
 * NULL), a CHECK that ties them to a schedule card, the one-card-per-AptNum
 * unique index over EVERY status, a clean down that keeps rows, numbered above
 * CO-4b's 1793900000000.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1794000000000_tc_auto_checkout_cards.js');

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
  };
  migration[direction](pgm);
  return calls;
}

test('additive: two NULLABLE tc_checkout_handoffs columns with no default', () => {
  const [added] = capture().filter((c) => c.op === 'addColumns');
  assert.equal(added.args[0], 'tc_checkout_handoffs');
  assert.deepEqual(Object.keys(added.args[1]), ['origin_apt_num', 'origin_appt']);
  assert.deepEqual(Object.values(added.args[1]).map((c) => c.type), ['bigint', 'jsonb']);
  for (const col of Object.values(added.args[1])) {
    assert.notEqual(col.notNull, true);
    assert.equal(col.default, undefined, 'old cards stay NULL');
  }
});

test("the source CHECK keeps NULL, 'hygiene' and 'manual' and adds 'schedule'", () => {
  const calls = capture();
  const dropFirst = calls.findIndex((c) => c.op === 'dropConstraint' && c.args[1] === 'tc_checkout_handoffs_source_check');
  const addAfter = calls.findIndex((c) => c.op === 'addConstraint' && c.args[1] === 'tc_checkout_handoffs_source_check');
  assert.ok(dropFirst >= 0 && addAfter > dropFirst);
  assert.equal(calls[addAfter].args[2].check, "source IS NULL OR source IN ('hygiene', 'manual', 'schedule')");
});

test('the origin CHECK: a schedule card carries its appointment, nothing else carries one', () => {
  const [origin] = capture().filter((c) => c.op === 'addConstraint' && c.args[1] === 'tc_checkout_handoffs_origin_check');
  const check = origin.args[2].check;
  assert.match(check, /source IS DISTINCT FROM 'schedule' AND origin_apt_num IS NULL AND origin_appt IS NULL/);
  assert.match(check, /source = 'schedule' AND origin_apt_num IS NOT NULL AND origin_apt_num > 0/);
  assert.match(check, /jsonb_typeof\(origin_appt\) = 'object'/);
});

test('one card per appointment, EVER: the unique index covers every status', () => {
  const [idx] = capture().filter((c) => c.op === 'createIndex');
  assert.deepEqual(idx.args[1], ['office_id', 'origin_apt_num']);
  assert.equal(idx.args[2].unique, true);
  assert.equal(idx.args[2].name, migration.ORIGIN_INDEX);
  assert.equal(idx.args[2].where, 'origin_apt_num IS NOT NULL', 'no status filter: a dismissed card still holds its AptNum');
});

test('down() drops the index, the origin CHECK and the columns, and restores the narrow source CHECK as NOT VALID (rows kept)', () => {
  const calls = capture('down');
  assert.deepEqual(calls.map((c) => c.op), ['dropIndex', 'dropConstraint', 'dropColumns', 'dropConstraint', 'sql']);
  assert.match(calls[4].args[0], /CHECK \(source IS NULL OR source IN \('hygiene', 'manual'\)\) NOT VALID$/);
});

test("numbered above CO-4b's 1793900000000; uniform width; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
  assert.ok(numbers.includes(1794000000000));
  assert.ok(1794000000000 > 1793900000000);
});

test('every column the sweep writes exists once every tenant migration has run', () => {
  const schema = buildTenantSchema();
  const src = fs.readFileSync(path.join(__dirname, '../services/tc/autoCheckout.js'), 'utf8');
  const store = fs.readFileSync(path.join(__dirname, '../routes/tc/checkoutStore.js'), 'utf8');
  const handoffs = schema.get('tc_checkout_handoffs');
  for (const c of ['origin_apt_num', 'origin_appt', 'source', 'od_patient_id', 'visit_date', 'status', 'patient_name', 'provider_seen', 'operatory']) {
    assert.ok(handoffs.has(c), `tc_checkout_handoffs.${c}`);
  }
  for (const c of ['origin_apt_num', 'origin_appt']) {
    assert.ok(src.includes(c) && store.includes(c), `the sweep and the store name ${c}`);
  }
});
