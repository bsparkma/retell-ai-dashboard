'use strict';

/**
 * Item 40's tenant migration, 1790800000000_tc_messages_email.js: three
 * columns and one index on tc_messages, nothing else.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../migrations-tenant/1790800000000_tc_messages_email.js');
const { buildTenantSchema } = require('../scripts/lib/tenantSchemaReplay');

function capture(direction = 'up') {
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

test('up: adds the three email columns to tc_messages and touches no other table', () => {
  const calls = capture();
  assert.deepEqual([...new Set(calls.map((c) => c.args[0]))], ['tc_messages']);
  const add = calls.find((c) => c.op === 'addColumns');
  assert.deepEqual(Object.keys(add.args[1]).sort(), ['email_blocks', 'email_preheader', 'unsubscribe_token_hash']);
  assert.equal(add.args[1].email_blocks.type, 'jsonb');
  for (const col of Object.values(add.args[1])) assert.notEqual(col.notNull, true, 'all nullable: existing rows are untouched');
  assert.ok(
    !calls.some((c) => c.op === 'createTable' || c.op === 'addConstraint' || c.op === 'sql'),
    'no new table, CHECK or raw SQL'
  );
});

test('up: one token can never name two emails (UNIQUE where present)', () => {
  const idx = capture().filter((c) => c.op === 'createIndex');
  assert.equal(idx.length, 1);
  assert.deepEqual(idx[0].args[1], ['unsubscribe_token_hash']);
  assert.equal(idx[0].args[2].unique, true);
  assert.equal(idx[0].args[2].where, 'unsubscribe_token_hash IS NOT NULL');
});

test('down: reverses exactly what up did', () => {
  const calls = capture('down');
  assert.deepEqual(calls.filter((c) => c.op === 'dropIndex').map((c) => c.args[2].name), [
    'tc_messages_unsubscribe_token_unique',
  ]);
  assert.deepEqual(calls.find((c) => c.op === 'dropColumns').args[1], [
    'email_blocks',
    'email_preheader',
    'unsubscribe_token_hash',
  ]);
});

test('it sorts after item 39 and its timestamp is unique', () => {
  const dir = path.join(__dirname, '..', 'migrations-tenant');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.js$/.test(f));
  const stamps = files.map((f) => f.split('_')[0]);
  assert.equal(new Set(stamps).size, stamps.length, 'timestamps are unique');
  // Renumbered from 1790500000000: #232 (1790600000000) and #230 (1790700000000)
  // merged first and staging has applied them. scripts/migrate-tenant.js runs
  // node-pg-migrate with its default checkOrder, which refuses a not-yet-run
  // migration that sorts before an applied one.
  const sorted = [...files].sort();
  const at = (f) => {
    const i = sorted.indexOf(f);
    assert.ok(i >= 0, `${f} exists`);
    return i;
  };
  const self = at('1790800000000_tc_messages_email.js');
  assert.ok(self > at('1790700000000_tc_messages_twilio.js'), 'sorts after #230');
  assert.ok(self > at('1790600000000_tc_opportunities.js'), 'sorts after #232');
});

test('the consent CHECK item 38 wrote already allows source unsubscribe_link (no CHECK change needed)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'migrations-tenant', '1790300000000_tc_messaging.js'), 'utf8');
  assert.match(src, /source IN \('od', 'stop_keyword', 'manual', 'unsubscribe_link'\)/);
});

test('after replaying every tenant migration, tc_messages has the columns the service writes', () => {
  const cols = buildTenantSchema().get('tc_messages');
  for (const c of ['email_blocks', 'email_preheader', 'unsubscribe_token_hash']) assert.ok(cols.has(c), c);
});
