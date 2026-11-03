'use strict';

/**
 * CO-3b's tenant migration, 1794200000000_tc_print_styling: ONE nullable jsonb
 * column on the existing tc_print_templates — additive (no default, no
 * backfill, so every existing row reads NULL = today's printout), a two-valued
 * CHECK (NULL or a JSON object), a clean down, numbered above CO-3's
 * 1794100000000.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1794200000000_tc_print_styling.js');

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
  };
  migration[direction](pgm);
  return calls;
}

test('one nullable jsonb column on tc_print_templates — no default, no backfill', () => {
  const calls = capture();
  assert.deepEqual(calls.map((c) => c.op), ['addColumns', 'addConstraint']);
  const [table, cols] = calls[0].args;
  assert.equal(table, 'tc_print_templates');
  assert.deepEqual(Object.keys(cols), ['styling']);
  assert.deepEqual(cols.styling, { type: 'jsonb' }, 'nullable, no default');
  assert.ok(!calls.some((c) => c.op === 'sql'), 'no data rewrite');
});

test('the CHECK is two-valued: NULL or a JSON object', () => {
  const [, name, { check }] = capture()[1].args;
  assert.equal(name, 'tc_print_templates_styling_check');
  assert.equal(check, "styling IS NULL OR jsonb_typeof(styling) = 'object'");
});

test('down() drops the CHECK and the column', () => {
  assert.deepEqual(
    capture('down').map((c) => [c.op, c.args[0], c.args[1]]),
    [
      ['dropConstraint', 'tc_print_templates', 'tc_print_templates_styling_check'],
      ['dropColumns', 'tc_print_templates', ['styling']],
    ]
  );
});

test("numbered above CO-3's 1794100000000 and is the newest; uniform width; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
  assert.equal(Math.max(...numbers), 1794200000000);
});

test('the store reads the column once every tenant migration has run', () => {
  const cols = buildTenantSchema().get('tc_print_templates');
  assert.ok(cols.has('styling'));
  assert.ok(require('../services/tc/printTemplateStore').COLS.includes('styling'));
});
