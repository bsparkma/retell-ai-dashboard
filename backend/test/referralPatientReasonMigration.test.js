'use strict';

/**
 * 1792600000000_tc_referral_patient_reason: one nullable column, its length
 * CHECK equal to the contract's cap, no backfill, a clean down, and numbered
 * above develop's newest (1792500000000).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1792600000000_tc_referral_patient_reason.js');
const contract = require('../tc/contract.gen.cjs');

const FILE = '1792600000000_tc_referral_patient_reason.js';

function capture(direction) {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    sql: rec('sql'),
  };
  migration[direction](pgm);
  return calls;
}

test('up: one nullable text column, no default, no backfill', () => {
  const calls = capture('up');
  const add = calls.filter((c) => c.op === 'addColumns');
  assert.equal(add.length, 1);
  assert.equal(add[0].args[0], 'tc_referrals');
  assert.deepEqual(add[0].args[1], { patient_reason: { type: 'text' } }, 'nullable (no notNull), no default');
  assert.equal(calls.filter((c) => c.op === 'sql').length, 0, 'no UPDATE: nothing is backfilled');
});

test("the length CHECK is inline and equal to the contract's cap", () => {
  const [check] = capture('up').filter((c) => c.op === 'addConstraint');
  assert.equal(check.args[1], 'tc_referrals_patient_reason_check');
  assert.equal(check.args[2].check, `patient_reason IS NULL OR char_length(patient_reason) <= ${contract.TC_REFERRAL_PATIENT_REASON_MAX}`);
  assert.equal(contract.TC_REFERRAL_PATIENT_REASON_MAX, 200);
});

test('down drops the CHECK, then the column', () => {
  const calls = capture('down');
  assert.deepEqual(
    calls.map((c) => [c.op, c.args[1]]),
    [
      ['dropConstraint', 'tc_referrals_patient_reason_check'],
      ['dropColumns', ['patient_reason']],
    ]
  );
});

test("numbered above develop's newest (1792500000000); unique; filename order = numeric order", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  assert.ok(files.includes(FILE));
  const nums = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(nums).size, nums.length, 'unique numbers');
  assert.deepEqual([...nums].sort((a, b) => a - b), nums, 'filename order = numeric order');
  assert.ok(Number(FILE.split('_')[0]) > 1792500000000);
});
