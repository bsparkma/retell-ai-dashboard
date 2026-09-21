'use strict';

/**
 * The perio send: the migration, the contract, the writer and the store agree
 * (item 12). Same shape as visitSchema.test.js, and for the same reasons.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../../migrations-tenant/1788500000000_hyg_perio_send.js');
const contract = require('../../hyg/contract.gen.cjs');
const writer = require('./odPerioWriter');

const MIGRATION_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'migrations-tenant', '1788500000000_hyg_perio_send.js'),
  'utf8'
);
const STORE_SOURCE = fs.readFileSync(path.join(__dirname, 'perioSendStore.js'), 'utf8');

function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the send enforces exactly the states the contract names, and the writer the types it names', () => {
  assert.deepEqual(migration.PERIO_SEND_STATES, [...contract.PERIO_SEND_STATES]);
  assert.deepEqual(migration.PERIO_SEND_STATES, contract.PerioSendStateSchema.options);
  assert.deepEqual([...writer.ALLOWED_SEQUENCE_TYPES], contract.PerioSendSequenceTypeSchema.options);
  // The CHECK literal carries every state, in order.
  const literal = migration.PERIO_SEND_STATES.map((s) => `'${s}'`).join(', ');
  assert.ok(MIGRATION_SOURCE.includes(`state IN (${literal})`));
  assert.doesNotMatch(code(MIGRATION_SOURCE), /'CAL'/);
});

test('every table this migration creates is granted to the app role — and never DELETE', () => {
  const created = [...MIGRATION_SOURCE.matchAll(/pgm\.createTable\('(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(created, migration.HYG_PERIO_TABLES);
  // A send that created an exam is a record of something in a chart: the app
  // can write and update it, and cannot delete it.
  assert.match(MIGRATION_SOURCE, /GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I/);
  assert.doesNotMatch(code(MIGRATION_SOURCE), /GRANT[^;']*DELETE/);
  assert.doesNotMatch(code(MIGRATION_SOURCE), /ON DELETE CASCADE|onDelete: 'CASCADE'/);
});

test('the CHECKs that carry meaning are there, written so NULL cannot slip past', () => {
  assert.match(MIGRATION_SOURCE, /state NOT IN \('filling', 'written', 'deleted'\) OR exam_num IS NOT NULL/);
  assert.match(MIGRATION_SOURCE, /state <> 'refused' OR exam_num IS NULL/);
  assert.match(MIGRATION_SOURCE, /state NOT IN \('incomplete', 'refused'\) OR error_message IS NOT NULL/);
  assert.match(MIGRATION_SOURCE, /state <> 'deleted' OR \(deleted_by IS NOT NULL AND deleted_at IS NOT NULL\)/);
  assert.match(MIGRATION_SOURCE, /hyg_perio_send_visit_fk/);
  assert.match(MIGRATION_SOURCE, /hyg_perio_send_in_flight_key[\s\S]*WHERE state IN \('posting', 'filling'\)/);
  assert.match(MIGRATION_SOURCE, /exam_date: \{ type: 'text'/, 'exam_date is text: a `date` crosses timezones');
});

test('the store takes an office in every function and names it in every WHERE', () => {
  const signatures = [...STORE_SOURCE.matchAll(/^async function (\w+)\(\s*pool,\s*\{([^}]*)\}/gm)];
  assert.ok(signatures.length >= 10, 'expected the store functions, found ' + signatures.length);
  for (const [, name, args] of signatures) {
    assert.ok(/\boffice\b/.test(args), `perioSendStore.${name}() takes no office`);
  }
  const wheres = [...code(STORE_SOURCE).matchAll(/\bWHERE ([^`]+?)(?=`)/g)].map((m) => m[1].replace(/\s+/g, ' '));
  assert.ok(wheres.length >= 10, 'expected a WHERE per statement, found ' + wheres.length);
  for (const clause of wheres) assert.ok(/office = \$2/.test(clause), 'a WHERE with no office: ' + clause);
});

test('the send migration sorts after the visit migrations it references', () => {
  const dir = path.join(__dirname, '..', '..', 'migrations-tenant');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_/.test(f)).sort();
  assert.ok(files.indexOf('1788500000000_hyg_perio_send.js') > files.indexOf('1788300000000_hyg_written_ref.js'));
});
