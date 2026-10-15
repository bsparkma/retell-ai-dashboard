'use strict';

/**
 * Item 50b's tenant migration, 1791700000000_tc_checkout_attestation: one new
 * table keyed (office, handoff, item), a composite FK that cannot cross
 * offices, the office CHECK inline, a role-guarded grant, a clean down, and
 * every column the route names present after every migration has run.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1791700000000_tc_checkout_attestation.js');

function capture(direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    func: (expr) => ({ __func: expr }),
    sql: rec('sql'),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    createIndex: rec('createIndex'),
    dropIndex: rec('dropIndex'),
  };
  migration[direction](pgm);
  return calls;
}

test('one new table; the parent only gains a unique pair and an index', () => {
  const calls = capture();
  assert.deepEqual(calls.filter((c) => c.op === 'createTable').map((c) => c.args[0]), ['tc_checkout_attestations']);
  assert.deepEqual(migration.TABLES, ['tc_checkout_attestations']);
  const onParent = calls.filter((c) => c.args[0] === 'tc_checkout_handoffs').map((c) => [c.op, c.args[1]]);
  assert.deepEqual(onParent, [
    ['addConstraint', 'tc_checkout_handoffs_office_handoff_unique'],
    ['createIndex', ['office_id', 'case_id']],
  ]);
  assert.ok(!calls.some((c) => c.op === 'sql' && /ALTER TABLE|audit_log/i.test(String(c.args[0]))));
});

test('keyed (office, handoff, item); FK is the composite (office, handoff), cascading', () => {
  const calls = capture();
  const cols = calls.find((c) => c.op === 'createTable').args[1];
  for (const k of ['office_id', 'handoff_id', 'item_index']) assert.equal(cols[k].primaryKey, true, k);
  for (const k of ['item_key', 'attested_by', 'attested_at']) assert.equal(cols[k].notNull, true, k);
  const fk = calls.find((c) => c.args[1] === 'tc_checkout_attestations_handoff_fk').args[2].foreignKeys;
  assert.deepEqual(fk.columns, ['office_id', 'handoff_id']);
  assert.equal(fk.references, 'tc_checkout_handoffs(office_id, handoff_id)');
  assert.equal(fk.onDelete, 'CASCADE');
});

test('office and index CHECKs are inline literals', () => {
  const calls = capture();
  const check = (name) => String(calls.find((c) => c.args[1] === name).args[2].check);
  assert.equal(check('tc_checkout_attestations_office_check'), "office_id IN ('roland', 'valley')");
  assert.equal(check('tc_checkout_attestations_index_check'), 'item_index >= 0 AND item_index < 100');
});

test('carein_app CRUD grant, role-guarded', () => {
  const sql = capture().filter((c) => c.op === 'sql').map((c) => String(c.args[0])).join('\n');
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
  assert.match(sql, /SELECT 1 FROM pg_roles WHERE rolname = r/);
  assert.match(sql, /'tc_checkout_attestations'/);
});

test('down() reverses everything up() added', () => {
  const calls = capture('down');
  assert.deepEqual(calls.filter((c) => c.op === 'dropTable').map((c) => c.args[0]), ['tc_checkout_attestations']);
  assert.ok(calls.some((c) => c.op === 'dropIndex' && c.args[2].name === 'tc_checkout_handoffs_office_case_idx'));
  assert.ok(calls.some((c) => c.op === 'dropConstraint' && c.args[1] === 'tc_checkout_handoffs_office_handoff_unique'));
});

test("numbered after develop's newest (item 51); uniform width; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  const mine = files.indexOf('1791700000000_tc_checkout_attestation.js');
  const item51 = files.indexOf('1791600000000_tc_notification_prefs.js');
  assert.ok(item51 >= 0 && mine > item51, 'sorts after 1791600000000_tc_notification_prefs.js');
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers, 'filename order = numeric order');
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
});

test('every column the route reads exists once every tenant migration has run', () => {
  const schema = buildTenantSchema();
  for (const c of ['office_id', 'handoff_id', 'item_index', 'item_key', 'attested_by', 'attested_at']) {
    assert.ok(schema.get('tc_checkout_attestations').has(c), c);
  }
  assert.ok(schema.get('tc_checkout_handoffs').has('case_id'));
});
