'use strict';

/**
 * Item 56's tenant migration, 1792000000000_tc_referral_r6: two nullable
 * columns (tc_referrals.doctor_note, tc_referral_events.verb), each CHECK
 * inline and equal to the shared contract, the status CHECK untouched, a
 * role-guarded grant, a clean down, and numbered after R2's.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1792000000000_tc_referral_r6.js');
const contract = require('../tc/contract.gen.cjs');

const FILE = '1792000000000_tc_referral_r6.js';

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

function check(calls, name) {
  const c = calls.find((x) => x.op === 'addConstraint' && x.args[1] === name);
  assert.ok(c, name);
  return String(c.args[2].check);
}

test('two NULLABLE columns, one per table; no new table, no index, no status change', () => {
  const calls = capture();
  const adds = calls.filter((c) => c.op === 'addColumns');
  assert.deepEqual(adds.map((c) => [c.args[0], Object.keys(c.args[1])]), [
    ['tc_referrals', ['doctor_note']],
    ['tc_referral_events', ['verb']],
  ]);
  for (const c of adds) for (const col of Object.values(c.args[1])) assert.notEqual(col.notNull, true, 'nullable: no backfill');
  assert.deepEqual(
    calls.filter((c) => c.op === 'addConstraint').map((c) => c.args[1]),
    ['tc_referrals_doctor_note_check', 'tc_referral_events_verb_check']
  );
  assert.ok(!calls.some((c) => c.op === 'createIndex'));
  const src = fs.readFileSync(`${MIGRATIONS_DIR}/${FILE}`, 'utf8');
  assert.doesNotMatch(src, /status_check|DROP CONSTRAINT/i, 'the status CHECK is untouched');
});

test('the verb CHECK is inline and equals the contract event verbs', () => {
  const sql = check(capture(), 'tc_referral_events_verb_check');
  assert.match(sql, /^verb IS NULL OR verb IN \(/);
  const list = /IN \(([^)]+)\)/.exec(sql)[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(list, [...contract.TC_REFERRAL_EVENT_VERBS]);
});

test("the doctor's note cap equals the contract's", () => {
  const sql = check(capture(), 'tc_referrals_doctor_note_check');
  assert.equal(sql, `doctor_note IS NULL OR length(doctor_note) <= ${contract.TC_REFERRAL_DOCTOR_NOTE_MAX}`);
  assert.equal(contract.TC_REFERRAL_DOCTOR_NOTE_MAX, 4000);
});

test('the grant is role-guarded and names exactly the two tables', () => {
  const sql = capture().filter((c) => c.op === 'sql').map((c) => String(c.args[0])).join('\n');
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\)/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
  assert.match(sql, /ARRAY\['tc_referrals', 'tc_referral_events'\]/);
  assert.deepEqual(migration.TABLES, ['tc_referrals', 'tc_referral_events']);
});

test('down() removes what up() added', () => {
  const calls = capture('down');
  assert.deepEqual(
    calls.filter((c) => c.op === 'dropColumns').map((c) => [c.args[0], c.args[1]]),
    [
      ['tc_referral_events', ['verb']],
      ['tc_referrals', ['doctor_note']],
    ]
  );
  assert.deepEqual(
    calls.filter((c) => c.op === 'dropConstraint').map((c) => c.args[1]).sort(),
    ['tc_referral_events_verb_check', 'tc_referrals_doctor_note_check']
  );
});

test("numbered after R2's source migration; filename order = numeric order; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.ok(files.indexOf(FILE) > files.indexOf('1791900000000_tc_referral_source.js'));
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('every referral + event column the routes read exists once every migration has run', () => {
  const schema = buildTenantSchema();
  const { REFERRAL_COLS, EVENT_COLS } = require('../routes/tc/referralStore');
  assert.ok(REFERRAL_COLS.includes('doctor_note'));
  assert.ok(EVENT_COLS.includes('verb'));
  for (const c of REFERRAL_COLS) assert.ok(schema.get('tc_referrals').has(c), c);
  for (const c of EVENT_COLS) assert.ok(schema.get('tc_referral_events').has(c), c);
});
