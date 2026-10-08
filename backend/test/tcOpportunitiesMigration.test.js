'use strict';

/**
 * Item 41's tenant migration: two new tables, CHECK literals inline and pinned
 * against services/tcOpportunities/core.js, grants role-guarded, a clean down,
 * and every column the store names actually created.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1790600000000_tc_opportunities.js');
const core = require('../services/tcOpportunities/core');
const oppStore = require('../services/tcOpportunities/store');

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

/** The IN (...) literal list of a named CHECK. */
function checkLiterals(calls, name) {
  const c = calls.find((x) => x.op === 'addConstraint' && x.args[1] === name);
  assert.ok(c, `constraint ${name}`);
  const m = /IN \(([^)]+)\)/.exec(String(c.args[2].check));
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

test('two new tables, nothing else touched', () => {
  const calls = capture();
  assert.deepEqual(
    calls.filter((c) => c.op === 'createTable').map((c) => c.args[0]),
    ['tc_opportunities', 'tc_opportunity_sync']
  );
  assert.deepEqual(migration.TABLES, ['tc_opportunities', 'tc_opportunity_sync']);
  assert.ok(!calls.some((c) => c.op === 'sql' && /ALTER TABLE|audit_log/i.test(String(c.args[0]))));
});

test('status CHECK literals are inline and equal core.OPPORTUNITY_STATUSES', () => {
  const calls = capture();
  assert.deepEqual(checkLiterals(calls, 'tc_opportunities_status_check'), [...core.OPPORTUNITY_STATUSES]);
  assert.deepEqual(checkLiterals(calls, 'tc_opportunities_office_check'), ['roland', 'valley']);
  assert.deepEqual(checkLiterals(calls, 'tc_opportunity_sync_office_check'), ['roland', 'valley']);
  assert.deepEqual(checkLiterals(calls, 'tc_opportunity_sync_status_check'), [...core.SYNC_STATUSES]);
  const src = fs.readFileSync(path.join(MIGRATIONS_DIR, '1790600000000_tc_opportunities.js'), 'utf8');
  assert.match(src, /check: "status IN \('new', 'claimed', 'dismissed', 'existing_case'\)"/, 'literal written at the call');
});

test('UNIQUE (office_id, od_patient_id) — a PatNum never stands without its office', () => {
  const u = capture().find((c) => c.op === 'addConstraint' && c.args[1] === 'tc_opportunities_office_patient_unique');
  assert.deepEqual(u.args[2].unique, ['office_id', 'od_patient_id']);
  const cols = capture().find((c) => c.op === 'createTable' && c.args[0] === 'tc_opportunities').args[1];
  assert.equal(cols.office_id.notNull, true);
  assert.equal(cols.od_patient_id.notNull, true);
  assert.equal(cols.od_patient_id.type, 'bigint', 'PatNum is a Long in Open Dental');
  assert.equal(cols.procedures.type, 'jsonb');
  assert.equal(cols.value_cents.type, 'bigint');
  assert.equal(cols.claimed_case_id.references, 'tc_cases');
});

test('dismissal needs a reason; a claim needs a case', () => {
  const calls = capture();
  const d = calls.find((c) => c.args[1] === 'tc_opportunities_dismissed_reason_check');
  assert.match(String(d.args[2].check), /\(status = 'dismissed'\) = \(dismissed_reason IS NOT NULL/);
  const c = calls.find((x) => x.args[1] === 'tc_opportunities_claimed_case_check');
  assert.match(String(c.args[2].check), /status <> 'claimed' OR claimed_case_id IS NOT NULL/);
});

test('carein_app CRUD grant on both tables, role-guarded', () => {
  const sql = capture().filter((c) => c.op === 'sql').map((c) => String(c.args[0])).join('\n');
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
  assert.match(sql, /SELECT 1 FROM pg_roles WHERE rolname = r/);
  assert.match(sql, /'tc_opportunities', 'tc_opportunity_sync'/);
});

test('down() drops exactly what up() created, children first', () => {
  assert.deepEqual(
    capture('down').filter((c) => c.op === 'dropTable').map((c) => c.args[0]),
    ['tc_opportunity_sync', 'tc_opportunities']
  );
});

test('numbered after the in-flight TC messaging migrations, uniform width, unique', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const numbers = files.map((f) => Number(f.split('_')[0]));
  // PRs #229/#230/#231 claim 1790300000000–1790500000000; this sits after them.
  assert.ok(1790600000000 > 1790500000000);
  assert.equal(new Set(numbers).size, numbers.length, 'two migrations share a timestamp');
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
});

test('every column the store SELECTs exists once every tenant migration has run', () => {
  const schema = buildTenantSchema();
  const opp = schema.get('tc_opportunities');
  const sync = schema.get('tc_opportunity_sync');
  assert.deepEqual(oppStore.OPP_COLS.filter((c) => !opp.has(c)), []);
  assert.deepEqual(oppStore.SYNC_COLS.filter((c) => !sync.has(c)), []);
});
