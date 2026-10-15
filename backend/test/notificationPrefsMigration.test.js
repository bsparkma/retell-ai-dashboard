'use strict';

/**
 * Item 51's tenant migration, 1791600000000_tc_notification_prefs: two new
 * tables, CHECK literals inline and pinned against the shared contract,
 * grants role-guarded, a clean down, and every column the route names present.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1791600000000_tc_notification_prefs.js');
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
    createIndex: rec('createIndex'),
  };
  migration[direction](pgm);
  return calls;
}

function literals(calls, name) {
  const c = calls.find((x) => x.op === 'addConstraint' && x.args[1] === name);
  assert.ok(c, name);
  return /IN \(([^)]+)\)/.exec(String(c.args[2].check))[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

test('two new tables, nothing else touched', () => {
  const calls = capture();
  assert.deepEqual(calls.filter((c) => c.op === 'createTable').map((c) => c.args[0]), migration.TABLES);
  assert.deepEqual(migration.TABLES, ['tc_notification_defaults', 'tc_notification_prefs']);
  assert.ok(!calls.some((c) => c.op === 'sql' && /ALTER TABLE|audit_log/i.test(String(c.args[0]))));
});

test('event and level CHECKs are inline and equal the contract', () => {
  const calls = capture();
  const events = [...contract.TcNotificationEvent.options];
  const levels = [...contract.TcNotificationLevel.options];
  assert.deepEqual(literals(calls, 'tc_notification_defaults_event_check'), events);
  assert.deepEqual(literals(calls, 'tc_notification_prefs_event_check'), events);
  assert.deepEqual(literals(calls, 'tc_notification_defaults_level_check'), levels);
  assert.deepEqual(literals(calls, 'tc_notification_prefs_level_check'), levels);
  assert.deepEqual(literals(calls, 'tc_notification_defaults_office_check'), ['roland', 'valley']);
  const src = fs.readFileSync(path.join(MIGRATIONS_DIR, '1791600000000_tc_notification_prefs.js'), 'utf8');
  assert.match(src, /check: "level IN \('silent', 'banner', 'sound_banner'\)"/);
});

test('keys: (office, event) and (user, event); the user key is stored lowercased', () => {
  const calls = capture();
  const defaults = calls.find((c) => c.op === 'createTable' && c.args[0] === 'tc_notification_defaults').args[1];
  const prefs = calls.find((c) => c.op === 'createTable' && c.args[0] === 'tc_notification_prefs').args[1];
  assert.equal(defaults.office_id.primaryKey, true);
  assert.equal(defaults.event.primaryKey, true);
  assert.equal(prefs.user_email.primaryKey, true);
  assert.equal(prefs.event.primaryKey, true);
  const lower = calls.find((c) => c.args[1] === 'tc_notification_prefs_email_lower_check');
  assert.match(String(lower.args[2].check), /user_email = lower\(user_email\)/);
});

test('carein_app CRUD grant on both tables, role-guarded', () => {
  const sql = capture().filter((c) => c.op === 'sql').map((c) => String(c.args[0])).join('\n');
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
  assert.match(sql, /SELECT 1 FROM pg_roles WHERE rolname = r/);
  assert.match(sql, /'tc_notification_defaults', 'tc_notification_prefs'/);
});

test('down() drops both tables', () => {
  assert.deepEqual(
    capture('down').filter((c) => c.op === 'dropTable').map((c) => c.args[0]),
    ['tc_notification_prefs', 'tc_notification_defaults']
  );
});

test('numbered after develop\'s newest (item 50); uniform width; unique', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  // Ordered AFTER item 50's migration, in the order checkOrder applies.
  const mine = files.indexOf('1791600000000_tc_notification_prefs.js');
  const item50 = files.indexOf('1791500000000_tc_checkout_outcome.js');
  assert.ok(item50 >= 0 && mine > item50, 'sorts after 1791500000000_tc_checkout_outcome.js');
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers, 'filename order = numeric order');
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
});

test('every column the route reads exists once every tenant migration has run', () => {
  const schema = buildTenantSchema();
  for (const c of ['office_id', 'event', 'level', 'updated_by']) assert.ok(schema.get('tc_notification_defaults').has(c), c);
  for (const c of ['user_email', 'event', 'level']) assert.ok(schema.get('tc_notification_prefs').has(c), c);
});
