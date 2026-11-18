'use strict';

/**
 * Setup polish's tenant migration, 1794900000000_tc_email_identity_practice_address:
 * the history table's field CHECK gains practice_address, inline and equal to
 * the shared stored-field list (snake-cased); nothing else changes; down()
 * refuses while a practice_address history row exists; numbered above
 * develop's newest and clear of the open #337's 1794800000000.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1794900000000_tc_email_identity_practice_address.js');
const contract = require('../tc/contract.gen.cjs');
const emailIdentity = require('../config/emailIdentity');
const path = require('node:path');

/** The slugs routes/tc/emailIdentity.js writes (its FIELD_SLUG map, read from source). */
function routeSlugs() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tc', 'emailIdentity.js'), 'utf8');
  const block = /const FIELD_SLUG = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(src)[1];
  return [...block.matchAll(/^\s*\w+: '([a-z_]+)',/gm)].map((m) => m[1]);
}

const FILE = '1794900000000_tc_email_identity_practice_address.js';

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
  assert.deepEqual(list, emailIdentity.STORED_FIELDS.map(snake), 'and the server’s own list');
  assert.deepEqual(list, ['reply_to', 'practice_name', 'practice_phone', 'practice_address', 'referral_bcc']);
  // The route writes exactly these slugs.
  assert.deepEqual(routeSlugs().sort(), [...list].sort());
});

test("down: refuses while practice_address history exists (append-only), then restores 1792400000000's four", () => {
  const calls = capture('down');
  assert.equal(calls[0].op, 'sql');
  assert.match(String(calls[0].args[0]), /field = 'practice_address'[\s\S]*RAISE EXCEPTION/);
  assert.ok(!calls.some((c) => c.op === 'sql' && /\b(UPDATE|DELETE)\b/i.test(String(c.args[0]))), 'never rewrites the history');
  const add = calls.find((c) => c.op === 'addConstraint');
  assert.deepEqual(inList(add.args[2].check), ['reply_to', 'practice_name', 'practice_phone', 'referral_bcc']);
});

test('numbered above develop’s newest (1794700000000) and clear of #337 (1794800000000); unique; ordered', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.ok(files.includes('1794700000000_tc_chart_writes.js'));
  assert.ok(files.indexOf(FILE) > files.indexOf('1794700000000_tc_chart_writes.js'));
  assert.ok(Number(FILE.split('_')[0]) > 1794800000000);
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers, 'filename order = numeric order');
  assert.equal(new Set(numbers).size, numbers.length);
});
