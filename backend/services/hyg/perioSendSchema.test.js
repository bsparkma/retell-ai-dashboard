'use strict';

/**
 * The perio send queue: the migration, the contract and the store agree
 * (H4 slice 11). Same shape as visitSchema.test.js, and for the same reasons.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../../migrations-tenant/1788400000000_hyg_perio_send.js');
const contract = require('../../hyg/contract.gen.cjs');
const writer = require('./odPerioWriter');

const MIGRATION_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'migrations-tenant', '1788400000000_hyg_perio_send.js'),
  'utf8'
);
const STORE_SOURCE = fs.readFileSync(path.join(__dirname, 'perioSendStore.js'), 'utf8');

test('the queue enforces exactly the vocabularies the contract and the writer do', () => {
  assert.deepEqual(migration.PERIO_SEND_ROW_STATES, contract.PerioSendRowStateSchema.options);
  assert.deepEqual(migration.PERIO_SEND_SEQUENCE_TYPES, contract.PerioSendSequenceTypeSchema.options);
  assert.deepEqual(migration.PERIO_SEND_SEQUENCE_TYPES, [...writer.ALLOWED_SEQUENCE_TYPES]);
  // CAL is not a word the queue can hold.
  assert.doesNotMatch(MIGRATION_SOURCE.replace(/\/\*[\s\S]*?\*\//g, ''), /'CAL'/);
});

test('every table this migration creates is granted to the app role, in this migration', () => {
  const created = [...MIGRATION_SOURCE.matchAll(/pgm\.createTable\('(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(created, migration.HYG_PERIO_TABLES);
  assert.match(MIGRATION_SOURCE, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
});

test('the CHECKs that carry meaning are there, written so NULL cannot slip past', () => {
  assert.match(MIGRATION_SOURCE, /hyg_perio_send_row_failed_reason_check/);
  assert.match(MIGRATION_SOURCE, /state <> 'confirmed' OR \(od_ref IS NOT NULL AND confirmed_at IS NOT NULL\)/);
  // A measurement's tooth and type are tested for NULL before their ranges.
  assert.match(MIGRATION_SOURCE, /tooth IS NOT NULL AND tooth BETWEEN 1 AND 32/);
  assert.match(MIGRATION_SOURCE, /sequence_type IS NOT NULL AND sequence_type IN/);
  assert.match(MIGRATION_SOURCE, /hyg_perio_send_row_visit_fk/);
  assert.match(MIGRATION_SOURCE, /hyg_perio_send_row_measure_key/);
});

test('the queue store takes an office in every function and names it in every WHERE', () => {
  const signatures = [...STORE_SOURCE.matchAll(/^async function (\w+)\(pool, \{([^}]*)\}/gm)];
  assert.ok(signatures.length >= 7, 'expected the queue store functions, found ' + signatures.length);
  for (const [, name, args] of signatures) {
    assert.ok(/\boffice\b/.test(args), `perioSendStore.${name}() takes no office`);
  }
  const code = STORE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const wheres = [...code.matchAll(/\bWHERE ([^`]+?)(?=`)/g)].map((m) => m[1].replace(/\s+/g, ' '));
  assert.ok(wheres.length >= 7, 'expected several WHERE clauses, found ' + wheres.length);
  for (const clause of wheres) assert.ok(/office/.test(clause), 'a WHERE with no office: ' + clause);
});

test('the send migration sorts after the visit migrations it references', () => {
  const dir = path.join(__dirname, '..', '..', 'migrations-tenant');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_/.test(f)).sort();
  assert.ok(files.indexOf('1788400000000_hyg_perio_send.js') > files.indexOf('1788300000000_hyg_written_ref.js'));
});

test('the send plan never holds a type the queue cannot', () => {
  let chart = contract.emptyPerioChart();
  for (const c of contract.chartingOrder(chart.sweep)) {
    chart = contract.withPerioSite(chart, c.tooth, c.surface, { depth: 3, bleeding: c.tooth % 2 === 0 });
  }
  chart = contract.withPerioSkipped(chart, 16, true);
  const plan = contract.perioMeasureRows(chart);
  assert.ok(plan.every((p) => migration.PERIO_SEND_SEQUENCE_TYPES.includes(p.sequenceType)));
  // #16 skipped: one SkipTooth. 31 Probing. 15 even teeth other than 16 with flags.
  assert.equal(plan.filter((p) => p.sequenceType === 'SkipTooth').length, 1);
  assert.equal(plan.filter((p) => p.sequenceType === 'Probing').length, 31);
  assert.equal(plan.filter((p) => p.sequenceType === 'BleedSupPlaqCalc').length, 15);
  assert.deepEqual(plan.map((p) => p.seq), plan.map((_, i) => i + 1));
});
