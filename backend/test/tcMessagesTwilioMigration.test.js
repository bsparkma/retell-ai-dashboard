'use strict';

/**
 * Item 39's tenant migration, 1790700000000_tc_messages_twilio.js: two columns
 * and two indexes on tc_messages, nothing else.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../migrations-tenant/1790700000000_tc_messages_twilio.js');
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

test('up: adds seen_at / seen_by to tc_messages and touches no other table', () => {
  const calls = capture();
  const tables = new Set(calls.map((c) => c.args[0]));
  assert.deepEqual([...tables], ['tc_messages']);
  const add = calls.find((c) => c.op === 'addColumns');
  assert.deepEqual(Object.keys(add.args[1]).sort(), ['seen_at', 'seen_by']);
  assert.equal(add.args[1].seen_at.type, 'timestamptz');
  assert.notEqual(add.args[1].seen_at.notNull, true, 'NULL means unseen');
  assert.ok(!calls.some((c) => c.op === 'createTable' || c.op === 'addConstraint' || c.op === 'sql'), 'no new table, CHECK or raw SQL');
});

test('up: the provider id is UNIQUE where present (a re-delivered webhook cannot store twice)', () => {
  const idx = capture().filter((c) => c.op === 'createIndex');
  const uniq = idx.find((c) => c.args[2].name === 'tc_messages_provider_id_unique');
  assert.ok(uniq);
  assert.deepEqual(uniq.args[1], ['provider', 'provider_message_id']);
  assert.equal(uniq.args[2].unique, true);
  assert.equal(uniq.args[2].where, 'provider_message_id IS NOT NULL');
  const unseen = idx.find((c) => c.args[2].name === 'tc_messages_unseen_idx');
  assert.deepEqual(unseen.args[1], ['office_id']);
});

test('down: reverses exactly what up did', () => {
  const calls = capture('down');
  assert.deepEqual(
    calls.filter((c) => c.op === 'dropIndex').map((c) => c.args[2].name).sort(),
    ['tc_messages_provider_id_unique', 'tc_messages_unseen_idx']
  );
  assert.deepEqual(calls.find((c) => c.op === 'dropColumns').args[1], ['seen_at', 'seen_by']);
});

test('it sorts after item 38 and its timestamp is unique', () => {
  const dir = path.join(__dirname, '..', 'migrations-tenant');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.js$/.test(f));
  const stamps = files.map((f) => f.split('_')[0]);
  assert.equal(new Set(stamps).size, stamps.length, 'timestamps are unique');
  assert.ok(files.indexOf('1790700000000_tc_messages_twilio.js') > files.indexOf('1790300000000_tc_messaging.js'));
});

// Renumbered from 1790400000000 after #232 merged first: scripts/migrate-tenant.js
// runs node-pg-migrate with its default checkOrder, which refuses a not-yet-run
// migration that sorts BEFORE one already applied (1790600000000 is on staging).
test('it sorts after every tenant migration already merged ahead of it', () => {
  const dir = path.join(__dirname, '..', 'migrations-tenant');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.js$/.test(f)).sort();
  assert.ok(
    files.indexOf('1790700000000_tc_messages_twilio.js') > files.indexOf('1790600000000_tc_opportunities.js'),
    "must sort after #232's tc_opportunities migration",
  );
});

test('after replaying every tenant migration, tc_messages has the columns the service writes', () => {
  const cols = buildTenantSchema().get('tc_messages');
  for (const c of ['seen_at', 'seen_by', 'provider', 'provider_message_id']) assert.ok(cols.has(c), c);
});
