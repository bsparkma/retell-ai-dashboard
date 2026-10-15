'use strict';

/**
 * Item 49's two tenant migrations:
 *
 *   1791300000000_tc_checkout_handoff  tc_checkout_handoffs (new) + the source
 *                                      key on tc_hygiene_intakes
 *   1791400000000_hyg_checkout_send    the checkout columns on hyg_visit
 *
 * Additive only, CHECK literals inline, the new table granted (role-guarded),
 * the key unique PER OFFICE, a clean down, and every column the code names
 * actually created once every tenant migration has run.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const tcMig = require('../migrations-tenant/1791300000000_tc_checkout_handoff.js');
const hygMig = require('../migrations-tenant/1791400000000_hyg_checkout_send.js');
const checkoutStore = require('../routes/tc/checkoutStore');
const visitStore = require('../services/hyg/visitStore');
const tcContract = require('../tc/contract.gen.cjs');

function capture(migration, direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    func: (expr) => ({ __func: expr }),
    sql: rec('sql'),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
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

function constraint(calls, name) {
  const c = calls.find((x) => x.op === 'addConstraint' && x.args[1] === name);
  assert.ok(c, `constraint ${name}`);
  return c.args[2];
}

test('TC: one new table, one new nullable column, nothing else', () => {
  const calls = capture(tcMig);
  assert.deepEqual(calls.filter((c) => c.op === 'createTable').map((c) => c.args[0]), ['tc_checkout_handoffs']);
  assert.deepEqual(tcMig.TABLES, ['tc_checkout_handoffs']);
  const added = calls.filter((c) => c.op === 'addColumns');
  assert.equal(added.length, 1);
  assert.equal(added[0].args[0], 'tc_hygiene_intakes');
  assert.deepEqual(Object.keys(added[0].args[1]), ['source_key']);
  assert.notEqual(added[0].args[1].source_key.notNull, true, 'nullable: every existing row stays valid');
  assert.ok(!calls.some((c) => c.op === 'sql' && /ALTER TABLE|audit_log|DROP/i.test(String(c.args[0]))));
});

test('TC: the source key is unique PER OFFICE, and only when set', () => {
  const calls = capture(tcMig);
  const idx = calls.find((c) => c.op === 'createIndex' && c.args[2] && c.args[2].name === 'tc_hygiene_intakes_office_source_key_key');
  assert.ok(idx);
  assert.deepEqual(idx.args[1], ['office_id', 'source_key']);
  assert.equal(idx.args[2].unique, true);
  assert.equal(idx.args[2].where, 'source_key IS NOT NULL');
  assert.deepEqual(
    constraint(calls, 'tc_checkout_handoffs_office_source_key_unique').unique,
    ['office_id', 'source_key']
  );
});

test('TC: CHECK literals are inline, and the key shape matches the contract', () => {
  const calls = capture(tcMig);
  assert.equal(constraint(calls, 'tc_checkout_handoffs_office_check').check, "office_id IN ('roland', 'valley')");
  const shape = /'\^\[A-Za-z0-9:_-\]\{8,200\}\$'/;
  assert.match(constraint(calls, 'tc_checkout_handoffs_source_key_shape_check').check, shape);
  assert.match(constraint(calls, 'tc_hygiene_intakes_source_key_shape_check').check, shape);
  // The contract's key and the CHECK agree on both ends of the length range.
  assert.equal(tcContract.TcIntakeSourceKey.safeParse('a'.repeat(8)).success, true);
  assert.equal(tcContract.TcIntakeSourceKey.safeParse('a'.repeat(7)).success, false);
  assert.equal(tcContract.TcIntakeSourceKey.safeParse('a'.repeat(200)).success, true);
  assert.equal(tcContract.TcIntakeSourceKey.safeParse('a'.repeat(201)).success, false);
  const src = fs.readFileSync(path.join(MIGRATIONS_DIR, '1791300000000_tc_checkout_handoff.js'), 'utf8');
  assert.match(src, /check: "office_id IN \('roland', 'valley'\)"/, 'literal written at the call');

  const cols = calls.find((c) => c.op === 'createTable').args[1];
  assert.equal(cols.office_id.notNull, true);
  assert.equal(cols.od_patient_id.type, 'bigint', 'PatNum is a Long in Open Dental');
  assert.equal(cols.payload.type, 'jsonb');
});

test('TC: carein_app CRUD grant on the new table, role-guarded', () => {
  const sql = capture(tcMig).filter((c) => c.op === 'sql').map((c) => String(c.args[0])).join('\n');
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
  assert.match(sql, /SELECT 1 FROM pg_roles WHERE rolname = r/);
  assert.match(sql, /'tc_checkout_handoffs'/);
});

test('hyg: five nullable columns on hyg_visit, all-or-nothing CHECKs', () => {
  const calls = capture(hygMig);
  assert.equal(calls.filter((c) => c.op === 'createTable').length, 0);
  const added = calls.find((c) => c.op === 'addColumns');
  assert.equal(added.args[0], 'hyg_visit');
  assert.deepEqual(Object.keys(added.args[1]), [
    'checkout_handoff_id',
    'checkout_sent_at',
    'checkout_sent_by',
    'checkout_send_claimed_at',
    'checkout_final_at',
  ]);
  for (const def of Object.values(added.args[1])) assert.notEqual(def.notNull, true);
  assert.match(constraint(calls, 'hyg_visit_checkout_sent_check').check, /\(checkout_handoff_id IS NULL\) = \(checkout_sent_at IS NULL\)/);
  assert.match(constraint(calls, 'hyg_visit_checkout_final_check').check, /checkout_final_at IS NULL OR checkout_handoff_id IS NOT NULL/);
});

test('down() undoes exactly what up() did', () => {
  const tcDown = capture(tcMig, 'down');
  assert.deepEqual(tcDown.filter((c) => c.op === 'dropTable').map((c) => c.args[0]), ['tc_checkout_handoffs']);
  assert.deepEqual(tcDown.find((c) => c.op === 'dropColumns').args[1], ['source_key']);
  const hygDown = capture(hygMig, 'down');
  assert.equal(hygDown.find((c) => c.op === 'dropColumns').args[1].length, 5);
});

test('every column the code names exists once every tenant migration has run', () => {
  const schema = buildTenantSchema();
  const handoffs = schema.get('tc_checkout_handoffs');
  assert.deepEqual(checkoutStore.COLS.filter((c) => !handoffs.has(c)), []);
  assert.ok(schema.get('tc_hygiene_intakes').has('source_key'));
  const visitCols = visitStore.VISIT_COLUMNS.split(',').map((s) => s.trim()).filter(Boolean);
  const hygVisit = schema.get('hyg_visit');
  assert.deepEqual(visitCols.filter((c) => !hygVisit.has(c)), []);
});
