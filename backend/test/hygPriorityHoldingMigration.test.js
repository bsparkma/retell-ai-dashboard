'use strict';

/**
 * 1794800000000_hyg_priority_holding — widen hyg_treatment_item's priority
 * CHECK to include 'holding', and a down() that moves 'holding' rows BEFORE it
 * restores the three-value CHECK.
 *
 * The real-Postgres half (the CHECK evaluated; the real down() and up() with a
 * 'holding' row present) is scripts/hyg-priority-holding-verify-queries.js,
 * which CI runs after migrate.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../migrations-tenant/1794800000000_hyg_priority_holding.js');
const original = require('../migrations-tenant/1788200000000_hyg_visit.js');
const hygContract = require('../hyg/contract.gen.cjs');

const SELF = 1794800000000;
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations-tenant');
const SOURCE = fs.readFileSync(path.join(MIGRATIONS_DIR, '1794800000000_hyg_priority_holding.js'), 'utf8');

function capture(direction) {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    sql: rec('sql'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
  };
  migration[direction](pgm);
  return calls;
}

/** The quoted values of an `x IN ('a', 'b')` CHECK. */
function valuesOf(check) {
  return [...check.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('up(): drops and re-adds exactly the priority CHECK, with holding LAST', () => {
  const calls = capture('up');
  assert.deepEqual(calls.map((c) => c.op), ['dropConstraint', 'addConstraint']);
  assert.deepEqual(calls[0].args, ['hyg_treatment_item', 'hyg_treatment_item_priority_check']);
  assert.equal(calls[1].args[0], 'hyg_treatment_item');
  assert.equal(calls[1].args[1], 'hyg_treatment_item_priority_check');
  const check = calls[1].args[2].check;
  assert.match(check, /^priority IN \(/);
  assert.deepEqual(valuesOf(check), ['urgent', 'preventative', 'cosmetic', 'holding']);
  assert.deepEqual(valuesOf(check), migration.TREATMENT_PRIORITIES, 'the export says what the inline literal says');
  assert.deepEqual(valuesOf(check), hygContract.TreatmentPrioritySchema.options, 'the database and the contract agree');
});

test('the CHECK literals are INLINE at the addConstraint calls, not built from an array', () => {
  assert.match(SOURCE, /check: "priority IN \('urgent', 'preventative', 'cosmetic', 'holding'\)"/);
  assert.match(SOURCE, /check: "priority IN \('urgent', 'preventative', 'cosmetic'\)"/);
  assert.doesNotMatch(SOURCE, /check: `/, 'no template-built CHECK');
});

test("down(): moves 'holding' rows to 'cosmetic' FIRST, then restores 1788200000000's three values", () => {
  const calls = capture('down');
  assert.deepEqual(calls.map((c) => c.op), ['sql', 'dropConstraint', 'addConstraint']);
  assert.equal(
    calls[0].args[0],
    "UPDATE hyg_treatment_item SET priority = 'cosmetic' WHERE priority = 'holding'",
    'a down that leaves holding rows would violate the restored CHECK'
  );
  const restored = calls[2].args[2].check;
  assert.deepEqual(valuesOf(restored), original.TREATMENT_PRIORITIES, 'exactly the original vocabulary');
  assert.deepEqual(migration.PREVIOUS_PRIORITIES, original.TREATMENT_PRIORITIES);
  // The rewrite target is a value the restored CHECK accepts.
  assert.ok(valuesOf(restored).includes('cosmetic'));
});

test('touches no other table, column or grant', () => {
  for (const dir of ['up', 'down']) {
    for (const c of capture(dir)) {
      assert.ok(['sql', 'dropConstraint', 'addConstraint'].includes(c.op), `${dir}: ${c.op}`);
      if (c.op !== 'sql') assert.equal(c.args[0], 'hyg_treatment_item');
      else assert.doesNotMatch(c.args[0], /GRANT|REVOKE|DROP|ALTER/i);
    }
  }
});

test('numbered above every earlier tenant migration; numeric order == filename order; unique', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const nums = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(nums).size, nums.length, 'no two migrations share a number');
  const before = nums.filter((n) => n < SELF);
  assert.ok(before.length > 0);
  assert.ok(nums.includes(SELF));
  assert.ok(before.every((n) => n < SELF));
  const sortedByName = [...files].sort();
  const sortedByNum = [...files].sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
  assert.deepEqual(sortedByName, sortedByNum);
});
