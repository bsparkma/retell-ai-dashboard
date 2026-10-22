'use strict';

/**
 * R6.3's tenant migration, 1792400000000_tc_email_identity_referral_bcc: the
 * history table's field CHECK gains referral_bcc, inline and equal to the
 * shared stored-field list (snake-cased); nothing else changes; down() refuses
 * while a referral_bcc history row exists; numbered above develop's newest and
 * clear of the open #257's 1792300000000.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1792400000000_tc_email_identity_referral_bcc.js');
const contract = require('../tc/contract.gen.cjs');

const FILE = '1792400000000_tc_email_identity_referral_bcc.js';

function capture(direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
    createIndex: rec('createIndex'),
    sql: rec('sql'),
  };
  migration[direction](pgm);
  return calls;
}

const inList = (sql) => /IN \(([^)]+)\)/.exec(String(sql))[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
const snake = (s) => s.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

test('up: only the field CHECK is replaced, and it equals the shared stored fields, snake-cased', () => {
  const calls = capture();
  assert.deepEqual(calls.map((c) => [c.op, c.args[0], c.args[1]]), [
    ['dropConstraint', 'tc_email_identity_changes', 'tc_email_identity_changes_field_check'],
    ['addConstraint', 'tc_email_identity_changes', 'tc_email_identity_changes_field_check'],
  ]);
  const list = inList(calls[1].args[2].check);
  assert.deepEqual(list, contract.TcEmailIdentityStoredField.options.map(snake));
  assert.deepEqual(list, ['reply_to', 'practice_name', 'practice_phone', 'referral_bcc']);
});

test("down: refuses while referral_bcc history exists (append-only), then restores R5c's three", () => {
  const calls = capture('down');
  assert.equal(calls[0].op, 'sql');
  assert.match(String(calls[0].args[0]), /field = 'referral_bcc'[\s\S]*RAISE EXCEPTION/);
  assert.ok(!calls.some((c) => c.op === 'sql' && /\b(UPDATE|DELETE)\b/i.test(String(c.args[0]))), 'never rewrites the history');
  const add = calls.find((c) => c.op === 'addConstraint');
  assert.deepEqual(inList(add.args[2].check), contract.TcEmailIdentityField.options.map(snake));
});

test('numbered above develop’s newest (1792200000000) and clear of #257 (1792300000000); unique; ordered', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.ok(files.indexOf(FILE) > files.indexOf('1792200000000_tc_email_identity_changes.js'));
  assert.ok(Number(FILE.split('_')[0]) > 1792300000000);
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers, 'filename order = numeric order');
  assert.equal(new Set(numbers).size, numbers.length);
});
