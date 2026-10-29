'use strict';

/**
 * The two Slice 2b migrations are ADDITIVE and NULLABLE, sort after every
 * tenant migration already on develop, and leave the columns the code names.
 *
 *   1792900000000_hyg_existing_tx_read            hyg_visit.existing_tx_read
 *   1793000000000_tc_hygiene_intake_existing_tx   tc_hygiene_intakes.existing_tx
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const read = require('../migrations-tenant/1792900000000_hyg_existing_tx_read.js');
const intake = require('../migrations-tenant/1793000000000_tc_hygiene_intake_existing_tx.js');
const { buildTenantSchema } = require('../scripts/lib/tenantSchemaReplay');

const DIR = path.join(__dirname, '..', 'migrations-tenant');

function capture(migration, direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  migration[direction]({
    func: (expr) => ({ __func: expr }),
    sql: rec('sql'),
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
  });
  return calls;
}

test('both add ONE nullable jsonb column, and nothing else changes shape', () => {
  for (const [m, table, column] of [
    [read, 'hyg_visit', 'existing_tx_read'],
    [intake, 'tc_hygiene_intakes', 'existing_tx'],
  ]) {
    const calls = capture(m);
    const add = calls.filter((c) => c.op === 'addColumns');
    assert.equal(add.length, 1);
    assert.equal(add[0].args[0], table);
    assert.deepEqual(Object.keys(add[0].args[1]), [column]);
    assert.equal(add[0].args[1][column].type, 'jsonb');
    assert.ok(!add[0].args[1][column].notNull, 'nullable: every existing row reads as "none"');
    assert.equal(add[0].args[1][column].default, undefined, 'no default rewrites existing rows');
    assert.ok(!calls.some((c) => c.op === 'sql'), 'no raw SQL — the columns ride the tables’ existing grants');
  }
});

test('the CHECKs state their NULL case and the shape they allow', () => {
  const r = capture(read).find((c) => c.op === 'addConstraint').args[2].check;
  assert.match(r, /^existing_tx_read IS NULL OR \(/);
  assert.match(r, /jsonb_typeof\(existing_tx_read\) = 'object'/);
  assert.match(r, /IN \('loaded', 'failed'\)/);
  assert.deepEqual(read.STATUSES, ['loaded', 'failed']);

  const i = capture(intake).find((c) => c.op === 'addConstraint').args[2].check;
  assert.equal(i, "existing_tx IS NULL OR jsonb_typeof(existing_tx) = 'array'");
});

test('down() removes exactly what up() added', () => {
  for (const [m, table, column] of [
    [read, 'hyg_visit', 'existing_tx_read'],
    [intake, 'tc_hygiene_intakes', 'existing_tx'],
  ]) {
    const calls = capture(m, 'down');
    const drop = calls.find((c) => c.op === 'dropColumns');
    assert.equal(drop.args[0], table);
    assert.deepEqual(drop.args[1], [column]);
    assert.equal(calls.filter((c) => c.op === 'dropConstraint').length, 1);
  }
});

test('they sort after every tenant migration already on develop, with unique timestamps', () => {
  const files = fs.readdirSync(DIR).filter((f) => /^\d+_.*\.js$/.test(f)).sort();
  const stamps = files.map((f) => f.split('_')[0]);
  assert.equal(new Set(stamps).size, stamps.length);
  const at = (f) => files.indexOf(f);
  assert.ok(at('1792900000000_hyg_existing_tx_read.js') > at('1792800000000_hyg_existing_tx_disposition.js'));
  assert.ok(at('1793000000000_tc_hygiene_intake_existing_tx.js') > at('1792900000000_hyg_existing_tx_read.js'));
});

test('after replaying every tenant migration, the columns the code names exist', () => {
  const schema = buildTenantSchema();
  assert.ok(schema.get('hyg_visit').has('existing_tx_read'));
  assert.ok(schema.get('tc_hygiene_intakes').has('existing_tx'));
  const caseStore = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tc', 'caseStore.js'), 'utf8');
  assert.match(caseStore, /'existing_tx'/);
});
