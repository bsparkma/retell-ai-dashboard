'use strict';

/**
 * 1792700000000_tc_provider_directory: one new table, CHECK literals inline
 * and equal to the contract's caps, (office_id, od_prov_num) UNIQUE as the
 * import's merge key, a role-guarded grant WITHOUT DELETE ("never deletes" is
 * the grant's property), a timestamp no other migration holds, and a clean
 * down.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1792700000000_tc_provider_directory.js');
const contract = require('../tc/contract.gen.cjs');

const FILE = '1792700000000_tc_provider_directory.js';

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
  };
  migration[direction](pgm);
  return calls;
}

function check(calls, name) {
  const c = calls.find((x) => x.op === 'addConstraint' && x.args[1] === name);
  assert.ok(c, name);
  return c.args[2];
}

test('one new table and nothing else touched', () => {
  const calls = capture();
  assert.deepEqual(calls.filter((c) => c.op === 'createTable').map((c) => c.args[0]), ['tc_provider_directory']);
  assert.ok(calls.filter((c) => ['addConstraint', 'createIndex'].includes(c.op)).every((c) => c.args[0] === migration.TABLE));
  assert.ok(!calls.some((c) => c.op === 'sql' && /ALTER TABLE|audit_log|DROP/i.test(String(c.args[0]))));
});

test('the CHECKs equal the contract: office, name 1..200, suffix ≤ 40, ProvNum positive', () => {
  const calls = capture();
  assert.equal(check(calls, 'tc_provider_directory_office_check').check, "office_id IN ('roland', 'valley')");
  assert.equal(
    check(calls, 'tc_provider_directory_name_check').check,
    `char_length(btrim(name)) BETWEEN 1 AND ${contract.TC_PROVIDER_NAME_MAX}`
  );
  assert.equal(
    check(calls, 'tc_provider_directory_suffix_check').check,
    `char_length(credential_suffix) <= ${contract.TC_PROVIDER_SUFFIX_MAX}`
  );
  assert.equal(check(calls, 'tc_provider_directory_prov_num_check').check, 'od_prov_num IS NULL OR od_prov_num > 0');
  // Inline literals (house rule), not interpolated constants.
  const src = fs.readFileSync(`${MIGRATIONS_DIR}/${FILE}`, 'utf8');
  assert.match(src, /'char_length\(btrim\(name\)\) BETWEEN 1 AND 200'/);
  assert.match(src, /'char_length\(credential_suffix\) <= 40'/);
});

test('(office_id, od_prov_num) is UNIQUE — the import merge key and race arbiter', () => {
  const calls = capture();
  assert.deepEqual(check(calls, 'tc_provider_directory_office_prov_num_unique'), { unique: ['office_id', 'od_prov_num'] });
  const table = calls.find((c) => c.op === 'createTable').args[1];
  assert.equal(table.od_prov_num.type, 'bigint');
  assert.ok(!table.od_prov_num.notNull, 'hand-added rows have no ProvNum');
  assert.equal(table.active.default, true);
});

test('carein_app gets SELECT, INSERT, UPDATE — and NOT DELETE — role-guarded', () => {
  const sql = capture().filter((c) => c.op === 'sql').map((c) => String(c.args[0])).join('\n');
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I/);
  assert.doesNotMatch(sql, /DELETE/);
  assert.match(sql, /SELECT 1 FROM pg_roles WHERE rolname = r/);
  assert.match(sql, /REVOKE ALL ON TABLE %I FROM PUBLIC/);
});

test('its timestamp is taken by no other tenant migration', () => {
  const stamps = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.js$/.test(f))
    .map((f) => Number(f.split('_')[0]));
  assert.equal(stamps.filter((s) => s === 1792700000000).length, 1);
});

test('down drops the table', () => {
  assert.deepEqual(capture('down').map((c) => [c.op, c.args[0]]), [['dropTable', 'tc_provider_directory']]);
});
