'use strict';

/**
 * CO-3's tenant migration, 1794100000000_tc_print_templates: one new table,
 * keyed by office and type, the type a SHAPE (a new type is code, not a
 * migration), bounded text, the logo pair all-or-none, no DELETE grant, a
 * clean down, numbered above CO-5b's 1794000000000.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1794100000000_tc_print_templates.js');
const contract = require('../tc/contract.gen.cjs');

function capture(direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    func: (expr) => ({ __func: expr }),
    sql: rec('sql'),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
    addConstraint: rec('addConstraint'),
  };
  migration[direction](pgm);
  return calls;
}

test('one table, keyed by (office, type)', () => {
  const calls = capture();
  const [table] = calls.filter((c) => c.op === 'createTable');
  assert.equal(table.args[0], 'tc_print_templates');
  const pk = calls.find((c) => c.op === 'addConstraint' && c.args[2].primaryKey);
  assert.deepEqual(pk.args[2].primaryKey, ['office_id', 'template_type']);
});

test('the type CHECK is a shape, so every registry type fits and a new one needs no migration', () => {
  const re = /^[a-z][a-z_]{0,39}$/;
  assert.equal(migration.CHECKS.tc_print_templates_type_shape_check, "template_type ~ '^[a-z][a-z_]{0,39}$'");
  for (const type of contract.PRINT_TEMPLATE_TYPE_KEYS) assert.ok(re.test(type), type);
});

test('the bounds match the contract, and the logo pair is all-or-none', () => {
  const lengths = migration.CHECKS.tc_print_templates_lengths_check;
  const base = contract.defaultPrintTemplate('excuse', { name: '', address: '', phone: '' });
  for (const [col, field] of [
    ['heading', 'heading'],
    ['letterhead_name', 'letterheadName'],
    ['letterhead_address', 'letterheadAddress'],
    ['letterhead_phone', 'letterheadPhone'],
    ['body', 'body'],
    ['signature_line', 'signatureLine'],
  ]) {
    const m = new RegExp(`length\\(${col}\\) <= (\\d+)`).exec(lengths);
    assert.ok(m, col);
    const max = Number(m[1]);
    // The contract accepts exactly what the CHECK accepts, and not one more.
    assert.equal(contract.PrintTemplateFields.safeParse({ ...base, [field]: 'x'.repeat(max) }).success, true, col);
    assert.equal(contract.PrintTemplateFields.safeParse({ ...base, [field]: 'x'.repeat(max + 1) }).success, false, col);
  }
  assert.match(migration.CHECKS.tc_print_templates_logo_check, /logo_key IS NULL AND logo_content_type IS NULL/);
  assert.match(migration.CHECKS.tc_print_templates_logo_check, /'image\/png', 'image\/jpeg'/);
});

test('carein_app gets SELECT, INSERT, UPDATE — never DELETE — and PUBLIC nothing', () => {
  const [sql] = capture().filter((c) => c.op === 'sql');
  assert.match(sql.args[0], /REVOKE ALL ON TABLE tc_print_templates FROM PUBLIC/);
  assert.match(sql.args[0], /GRANT SELECT, INSERT, UPDATE ON TABLE tc_print_templates TO %I/);
  assert.ok(!/DELETE/.test(sql.args[0]));
});

test('down() drops the table', () => {
  assert.deepEqual(capture('down').map((c) => [c.op, c.args[0]]), [['dropTable', 'tc_print_templates']]);
});

test("numbered above CO-5b's 1794000000000; uniform width; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
  assert.ok(numbers.includes(1794100000000) && 1794100000000 > 1794000000000);
});

test('every column the store names exists once every tenant migration has run', () => {
  const schema = buildTenantSchema();
  const cols = schema.get('tc_print_templates');
  assert.ok(cols, 'tc_print_templates exists');
  const src = fs.readFileSync(path.join(__dirname, '../services/tc/printTemplateStore.js'), 'utf8');
  for (const c of require('../services/tc/printTemplateStore').COLS) {
    assert.ok(cols.has(c), c);
    assert.ok(src.includes(c), c);
  }
});
