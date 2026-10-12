'use strict';

/**
 * Item 45's tenant migration, 1790900000000_tc_library_opportunities_config.js:
 * one more tc_library_config section literal, nothing else.
 *
 * The section CHECK and the shared contract's LibrarySectionSchemas are two
 * spellings of one vocabulary; this file pins them equal so a section added to
 * one and not the other is a red build, not a 500 on the first PUT.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../migrations-tenant/1790900000000_tc_library_opportunities_config.js');
const { LibrarySectionSchemas } = require('../tc/contract.gen.cjs');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations-tenant');

const ORIGINAL_ELEVEN = [
  'stages',
  'objections',
  'motivators',
  'lost_reasons',
  'referral_sources',
  'treatment_categories',
  'financing_providers',
  'crown_pricing',
  'financing_config',
  'cadence_config',
  'financing_settings',
];

function capture(direction) {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    func: (expr) => ({ __func: expr }),
    sql: rec('sql'),
    createTable: rec('createTable'),
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

function literals(check) {
  const m = /^section IN \(([^)]+)\)$/.exec(check);
  assert.ok(m, check);
  return m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
}

test('up: re-adds the section CHECK with exactly the contract sections', () => {
  const calls = capture('up');
  assert.deepEqual(calls.map((c) => [c.op, c.args[0], c.args[1]]), [
    ['dropConstraint', 'tc_library_config', 'tc_library_config_section_check'],
    ['addConstraint', 'tc_library_config', 'tc_library_config_section_check'],
  ]);
  const check = calls[1].args[2].check;
  assert.deepEqual(literals(check), Object.keys(LibrarySectionSchemas), 'CHECK literals == LibrarySectionSchemas keys');
  assert.deepEqual(literals(check), [...ORIGINAL_ELEVEN, 'opportunities_config']);
});

test('down: removes the new section rows, then restores the original eleven', () => {
  const calls = capture('down');
  assert.equal(calls[0].op, 'sql');
  assert.equal(calls[0].args[0], "DELETE FROM tc_library_config WHERE section = 'opportunities_config'");
  const add = calls.find((c) => c.op === 'addConstraint');
  assert.deepEqual(literals(add.args[2].check), ORIGINAL_ELEVEN);
  // The original declaration in the base schema is the same eleven.
  const base = fs.readFileSync(path.join(MIGRATIONS_DIR, '1785373200000_tc_schema.js'), 'utf8');
  const m = /"section IN \(([^)]+)\)"/.exec(base);
  assert.ok(m);
  assert.deepEqual(m[1].split(',').map((s) => s.replace(/'/g, '')), ORIGINAL_ELEVEN);
});

test('touches only tc_library_config, adds no column and writes no row on up', () => {
  const calls = capture('up');
  assert.deepEqual([...new Set(calls.map((c) => c.args[0]))], ['tc_library_config']);
  assert.ok(!calls.some((c) => c.op === 'sql' || c.op === 'addColumns' || c.op === 'createTable'));
});

test('sorts after item 40 (1790800000000)', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.js$/.test(f)).sort();
  const self = files.indexOf('1790900000000_tc_library_opportunities_config.js');
  assert.ok(self > files.indexOf('1790800000000_tc_messages_email.js'));
});
