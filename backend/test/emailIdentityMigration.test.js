'use strict';

/**
 * R5c's tenant migration, 1792200000000_tc_email_identity_changes: one history
 * table, its field vocabulary equal to the shared contract (camelCase in the
 * contract, snake_case here), a CHECK that a row is a real change, an
 * APPEND-ONLY role-guarded grant (SELECT + INSERT, nothing else), a clean
 * down, and numbered after R5's.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1792200000000_tc_email_identity_changes.js');
const contract = require('../tc/contract.gen.cjs');

const FILE = '1792200000000_tc_email_identity_changes.js';

function capture(direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    func: (expr) => ({ __func: expr }),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
    addConstraint: rec('addConstraint'),
    createIndex: rec('createIndex'),
    sql: rec('sql'),
  };
  migration[direction](pgm);
  return calls;
}

function check(calls, name) {
  const c = calls.find((x) => x.op === 'addConstraint' && x.args[1] === name);
  return c ? String(c.args[2].check) : null;
}

function inList(sql) {
  return /IN \(([^)]+)\)/.exec(sql)[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

const snake = (s) => s.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

test('one table, nullable prior/new values, a uuid key with no sequence', () => {
  const calls = capture();
  const tables = calls.filter((c) => c.op === 'createTable');
  assert.equal(tables.length, 1);
  assert.equal(tables[0].args[0], 'tc_email_identity_changes');
  const cols = tables[0].args[1];
  assert.deepEqual(Object.keys(cols), ['id', 'office_id', 'field', 'prior_value', 'new_value', 'changed_by', 'changed_at']);
  assert.equal(cols.id.type, 'uuid');
  assert.notEqual(cols.prior_value.notNull, true);
  assert.notEqual(cols.new_value.notNull, true);
  assert.equal(cols.changed_by.notNull, true);
});

test('the field CHECK equals the contract fields, snake-cased; offices are the two real ones', () => {
  const calls = capture();
  assert.deepEqual(inList(check(calls, 'tc_email_identity_changes_field_check')), contract.TcEmailIdentityField.options.map(snake));
  assert.deepEqual(inList(check(calls, 'tc_email_identity_changes_office_check')), ['roland', 'valley']);
  assert.equal(check(calls, 'tc_email_identity_changes_changed_check'), 'prior_value IS DISTINCT FROM new_value');
});

test('the grant is append-only and role-guarded: SELECT + INSERT, never UPDATE or DELETE', () => {
  const sql = capture()
    .filter((c) => c.op === 'sql')
    .map((c) => String(c.args[0]))
    .join('\n');
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\)/);
  assert.match(sql, /REVOKE ALL ON TABLE %I FROM PUBLIC/);
  assert.match(sql, /GRANT SELECT, INSERT ON TABLE %I TO %I/);
  assert.doesNotMatch(sql, /UPDATE|DELETE|SEQUENCE/);
});

test('down() drops the table', () => {
  const calls = capture('down');
  assert.deepEqual(
    calls.map((c) => [c.op, c.args[0]]),
    [['dropTable', 'tc_email_identity_changes']]
  );
});

test("numbered after R5's; filename order = numeric order; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.ok(files.indexOf(FILE) > files.indexOf('1792100000000_tc_referral_email.js'));
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('every column the route writes exists once every migration has run', () => {
  const schema = buildTenantSchema();
  const src = fs.readFileSync(`${__dirname}/../routes/tc/emailIdentity.js`, 'utf8');
  for (const c of ['office_id', 'field', 'prior_value', 'new_value', 'changed_by']) {
    assert.ok(schema.get('tc_email_identity_changes').has(c), c);
    assert.match(src, new RegExp(c), `the route names ${c}`);
  }
});
