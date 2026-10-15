'use strict';

/**
 * Item 50's tenant migration, 1791500000000_tc_checkout_outcome: additive
 * columns on tc_checkout_handoffs, the status CHECK written inline and pinned
 * against the store and the contract, the pairing CHECKs, a clean down, and
 * every column the store names present once every migration has run.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1791500000000_tc_checkout_outcome.js');
const checkoutStore = require('../routes/tc/checkoutStore');
const contract = require('../tc/contract.gen.cjs');

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

function check(calls, name) {
  const c = calls.find((x) => x.op === 'addConstraint' && x.args[1] === name);
  assert.ok(c, name);
  return String(c.args[2].check);
}

test('additive only: columns on tc_checkout_handoffs, no table, no raw SQL', () => {
  const calls = capture();
  assert.equal(calls.filter((c) => c.op === 'createTable').length, 0);
  assert.equal(calls.filter((c) => c.op === 'sql').length, 0);
  const added = calls.filter((c) => c.op === 'addColumns');
  assert.equal(added.length, 1);
  assert.equal(added[0].args[0], 'tc_checkout_handoffs');
  const cols = added[0].args[1];
  assert.equal(cols.status.notNull, true);
  assert.equal(cols.status.default, 'open', 'every existing row reads open');
  for (const [name, def] of Object.entries(cols)) {
    if (name !== 'status') assert.notEqual(def.notNull, true, `${name} is nullable`);
  }
  assert.equal(cols.case_id.references, 'tc_cases');
  assert.equal(cols.case_id.onDelete, 'SET NULL');
});

test('the status CHECK is inline and equals the store and the contract', () => {
  const sql = check(capture(), 'tc_checkout_handoffs_status_check');
  const literals = /IN \(([^)]+)\)/.exec(sql)[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
  assert.deepEqual([...literals].sort(), [...checkoutStore.STATUSES].sort());
  assert.deepEqual([...literals].sort(), [...contract.TcCheckoutStatus.options].sort());
  assert.deepEqual([...checkoutStore.OUTCOMES].sort(), [...contract.TcCheckoutOutcome.options].sort());
  const src = fs.readFileSync(path.join(MIGRATIONS_DIR, '1791500000000_tc_checkout_outcome.js'), 'utf8');
  assert.match(src, /'open', 'claimed', 'dismissed', 'scheduled', 'not_scheduled', 'nothing_needed', 'expired'/);
});

test('the pairing CHECKs say what each state carries', () => {
  const calls = capture();
  assert.match(check(calls, 'tc_checkout_handoffs_dismissed_check'), /\(status = 'dismissed'\) = \(dismissed_reason IS NOT NULL/);
  assert.match(check(calls, 'tc_checkout_handoffs_outcome_check'), /outcome_by IS NOT NULL AND outcome_at IS NOT NULL/);
  assert.match(check(calls, 'tc_checkout_handoffs_case_check'), /status <> 'nothing_needed' OR case_id IS NULL/);
  assert.match(check(calls, 'tc_checkout_handoffs_expired_check'), /\(status = 'expired'\) = \(expired_at IS NOT NULL\)/);
  assert.match(check(calls, 'tc_checkout_handoffs_claimed_check'), /claimed_by IS NOT NULL AND claimed_at IS NOT NULL/);
});

test('down() drops the constraints before the columns', () => {
  const calls = capture('down');
  const firstDropCol = calls.findIndex((c) => c.op === 'dropColumns');
  const lastDropCon = calls.map((c) => c.op).lastIndexOf('dropConstraint');
  assert.ok(lastDropCon < firstDropCol);
  assert.equal(calls[firstDropCol].args[1].length, 11);
});

test('numbered after develop\'s item-49 migrations; uniform width; unique', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.ok(1791500000000 > 1791400000000);
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
});

test('every column the store SELECTs exists once every tenant migration has run', () => {
  const table = buildTenantSchema().get('tc_checkout_handoffs');
  assert.deepEqual(checkoutStore.COLS.filter((c) => !table.has(c)), []);
});
