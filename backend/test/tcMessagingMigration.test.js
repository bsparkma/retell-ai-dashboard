'use strict';

/**
 * Item 38's tenant migration, 1790300000000_tc_messaging.js.
 *
 * The CHECK literals are written INLINE in the migration (a migration records
 * what a database was told; it must not read today's contract). This file pays
 * for that choice: every literal is asserted against the shared/tc/messaging.ts
 * zod enum the API and the screen use, so a value one side accepts and the
 * other refuses is red here, not a 500 in front of a TC.
 *
 * Also pinned: the carein_app GRANT block covers both tables (a table the
 * least-privilege role cannot reach fails as a permission error in production,
 * not as a red migration), both tables key on office_id, and every column the
 * messaging service SELECTs exists after replaying every tenant migration.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../migrations-tenant/1790300000000_tc_messaging.js');
const contract = require('../tc/contract.gen.cjs');
const messaging = require('../services/messaging');
const { buildTenantSchema } = require('../scripts/lib/tenantSchemaReplay');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'migrations-tenant', '1790300000000_tc_messaging.js'),
  'utf8'
);

/** Record every MigrationBuilder call. */
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

/** The IN-list of a CHECK literal on `table.column`, as an array. */
function checkValues(calls, table, column) {
  const c = calls.find(
    (x) =>
      x.op === 'addConstraint' &&
      x.args[0] === table &&
      typeof x.args[2].check === 'string' &&
      x.args[2].check.startsWith(`${column} IN (`)
  );
  assert.ok(c, `no CHECK on ${table}.${column}`);
  return [...c.args[2].check.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('every CHECK literal equals the contract enum it mirrors', () => {
  const calls = capture();
  const pairs = [
    ['tc_messages', 'office_id', contract.OfficeId.options],
    ['tc_messages', 'direction', contract.MessageDirection.options],
    ['tc_messages', 'channel', contract.MessageChannel.options],
    ['tc_messages', 'status', contract.MessageStatus.options],
    ['tc_contact_consent', 'office_id', contract.OfficeId.options],
    ['tc_contact_consent', 'channel', contract.MessageChannel.options],
    ['tc_contact_consent', 'state', contract.ConsentState.options],
    ['tc_contact_consent', 'source', contract.ConsentSource.options],
  ];
  for (const [table, column, enumValues] of pairs) {
    assert.deepEqual(checkValues(calls, table, column), enumValues, `${table}.${column}`);
  }
});

test('CHECK literals are inline at the addConstraint call (the modules.test.js text-scan rule)', () => {
  assert.match(SOURCE, /check: "status IN \('draft', 'queued', 'sending', 'sent', 'delivered', 'failed', 'received'\)"/);
  assert.match(SOURCE, /check: "source IN \('od', 'stop_keyword', 'manual', 'unsubscribe_link'\)"/);
});

test('consent is UNIQUE on (office_id, channel, address) — an address means nothing without its office', () => {
  const calls = capture();
  const u = calls.find((c) => c.op === 'addConstraint' && c.args[0] === 'tc_contact_consent' && c.args[2].unique);
  assert.ok(u);
  assert.deepEqual(u.args[2].unique, ['office_id', 'channel', 'address']);
});

test('message indexes lead with office_id', () => {
  const idx = capture().filter((c) => c.op === 'createIndex' && c.args[0] === 'tc_messages').map((c) => c.args[1]);
  assert.deepEqual(idx, [
    ['office_id', 'case_id'],
    ['office_id', 'to_address'],
  ]);
});

test('office_id is NOT NULL on both tables; case_id is nullable with SET NULL', () => {
  const tables = Object.fromEntries(capture().filter((c) => c.op === 'createTable').map((c) => [c.args[0], c.args[1]]));
  assert.equal(tables.tc_messages.office_id.notNull, true);
  assert.equal(tables.tc_contact_consent.office_id.notNull, true);
  assert.equal(tables.tc_contact_consent.address.notNull, true);
  assert.notEqual(tables.tc_messages.case_id.notNull, true);
  assert.equal(tables.tc_messages.case_id.references, 'tc_cases');
  assert.equal(tables.tc_messages.case_id.onDelete, 'SET NULL');
});

test('the carein_app grant block names BOTH new tables, CRUD, role-guarded', () => {
  assert.deepEqual(migration.TABLES, ['tc_messages', 'tc_contact_consent']);
  const sql = capture().filter((c) => c.op === 'sql').map((c) => String(c.args[0])).join('\n');
  assert.match(sql, /ARRAY\['tc_messages', 'tc_contact_consent'\]/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\)/);
  assert.match(sql, /REVOKE ALL ON TABLE %I FROM PUBLIC/);
});

test('down() drops both tables', () => {
  const dropped = capture('down').filter((c) => c.op === 'dropTable').map((c) => c.args[0]);
  assert.deepEqual(dropped.sort(), ['tc_contact_consent', 'tc_messages']);
});

test('every column the messaging service reads exists after replaying all tenant migrations', () => {
  const schema = buildTenantSchema();
  const messages = schema.get('tc_messages');
  const consentT = schema.get('tc_contact_consent');
  assert.ok(messages && consentT, 'replay found both tables');
  assert.deepEqual(messaging.MESSAGE_COLS.filter((c) => !messages.has(c)), []);
  assert.deepEqual(messaging.CONSENT_COLS.filter((c) => !consentT.has(c)), []);
  // And the case columns the service reads to assemble an address.
  const cases = schema.get('tc_cases');
  for (const c of ['case_id', 'office_id', 'patient_name', 'phone', 'email', 'od_patient_id']) {
    assert.ok(cases.has(c), `tc_cases.${c}`);
  }
});
