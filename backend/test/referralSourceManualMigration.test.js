'use strict';

/**
 * R6.2's tenant migration, 1792300000000_tc_referral_source_manual: the
 * source_kind CHECK gains `manual`, inline and equal to the shared contract;
 * nothing else changes; down() refuses while a manual referral exists, then
 * restores item 53's four; numbered after develop's newest (1792200000000).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1792300000000_tc_referral_source_manual.js');
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
    createTable: rec('createTable'),
    sql: rec('sql'),
  };
  migration[direction](pgm);
  return calls;
}

const inList = (check) => /IN \(([^)]+)\)/.exec(String(check))[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));

test('up: the source_kind CHECK is replaced, inline, and equals the contract — nothing else', () => {
  const calls = capture();
  assert.deepEqual(calls.map((c) => [c.op, c.args[0], c.args[1]]), [
    ['dropConstraint', 'tc_referrals', 'tc_referrals_source_kind_check'],
    ['addConstraint', 'tc_referrals', 'tc_referrals_source_kind_check'],
  ]);
  const check = calls[1].args[2].check;
  assert.deepEqual(inList(check), [...contract.TcReferralSourceKind.options]);
  assert.deepEqual(inList(check), ['case', 'checkout', 'hyg_visit', 'call', 'manual']);
});

test("down: refuses while a manual referral exists, then restores item 53's four", () => {
  const calls = capture('down');
  assert.equal(calls[0].op, 'sql');
  assert.match(String(calls[0].args[0]), /source_kind = 'manual'[\s\S]*RAISE EXCEPTION/);
  const add = calls.find((c) => c.op === 'addConstraint');
  assert.deepEqual(inList(add.args[2].check), [...contract.TC_REFERRAL_SOURCE_KINDS_R2]);
  assert.ok(!calls.some((c) => c.op === 'sql' && /UPDATE|DELETE/i.test(String(c.args[0]))), 'never relabels or deletes a referral');
});

test("numbered after develop's newest tenant migration; uniform width; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  const mine = files.indexOf('1792300000000_tc_referral_source_manual.js');
  const prev = files.indexOf('1792200000000_tc_email_identity_changes.js');
  assert.ok(prev >= 0 && mine > prev, 'sorts after 1792200000000_tc_email_identity_changes.js');
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers, 'filename order = numeric order');
  assert.equal(new Set(numbers).size, numbers.length);
});
