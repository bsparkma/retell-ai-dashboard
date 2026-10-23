'use strict';

/**
 * Item 53's tenant migration, 1791900000000_tc_referral_source: two columns on
 * tc_referrals saying where a referral was started, the kind CHECK inline and
 * equal to the shared contract, a clean down, and numbered after R1's.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1791900000000_tc_referral_source.js');
const contract = require('../tc/contract.gen.cjs');

function capture(direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    createIndex: rec('createIndex'),
    dropIndex: rec('dropIndex'),
    sql: rec('sql'),
  };
  migration[direction](pgm);
  return calls;
}

test('adds source_kind + source_ref to tc_referrals only; no table, no grant needed', () => {
  const calls = capture();
  assert.ok(calls.every((c) => c.args[0] === 'tc_referrals'));
  const cols = calls.find((c) => c.op === 'addColumns').args[1];
  assert.deepEqual(Object.keys(cols), ['source_kind', 'source_ref']);
  assert.equal(cols.source_kind.notNull, true);
  assert.equal(cols.source_ref.notNull, true);
  assert.ok(!calls.some((c) => c.op === 'sql'));
});

test('the kind CHECK is inline and equals the contract', () => {
  const calls = capture();
  const check = String(calls.find((c) => c.args[1] === 'tc_referrals_source_kind_check').args[2].check);
  const inList = /IN \(([^)]+)\)/.exec(check)[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  // This migration is history: it pins the list it was written with. R6.2's
  // 1792300000000 adds `manual` and pins the live TcReferralSourceKind.
  assert.deepEqual(inList, [...contract.TC_REFERRAL_SOURCE_KINDS_R2]);
  assert.deepEqual(inList, ['case', 'checkout', 'hyg_visit', 'call']);
});

test('down() removes what up() added', () => {
  const calls = capture('down');
  assert.ok(calls.some((c) => c.op === 'dropColumns' && c.args[1].includes('source_kind') && c.args[1].includes('source_ref')));
  assert.ok(calls.some((c) => c.op === 'dropConstraint' && c.args[1] === 'tc_referrals_source_kind_check'));
  assert.ok(calls.some((c) => c.op === 'dropIndex'));
});

test("numbered after R1's migration; uniform width; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  const mine = files.indexOf('1791900000000_tc_referral_source.js');
  const r1 = files.indexOf('1791800000000_tc_referrals.js');
  assert.ok(r1 >= 0 && mine > r1, 'sorts after 1791800000000_tc_referrals.js');
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers, 'filename order = numeric order');
  assert.equal(new Set(numbers).size, numbers.length);
});

test('every referral column the routes read exists once every migration has run', () => {
  const schema = buildTenantSchema();
  const { REFERRAL_COLS, EVENT_COLS } = require('../routes/tc/referralStore');
  for (const c of REFERRAL_COLS) assert.ok(schema.get('tc_referrals').has(c), c);
  for (const c of EVENT_COLS) assert.ok(schema.get('tc_referral_events').has(c), c);
});
