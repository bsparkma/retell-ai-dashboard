'use strict';

/**
 * Item 33's two tenant migrations: additive, nullable, and in order.
 *
 *   1790100000000_tc_ortho_screening.js   one nullable jsonb column on
 *                                         tc_hygiene_intakes, grant re-asserted
 *   1790200000000_hyg_ortho_send.js       the visit's appointment snapshot and
 *                                         ortho-send columns, all nullable
 *
 * Acceptance row 9: nullable/additive, above develop's newest timestamp at push
 * time (1790000000000_rcm_check_archive.js when this was written — the push
 * re-checks), and visitSchema.test.js's uniqueness/order test still passing.
 * The column-list checks replay every tenant migration (the rcmQueryColumns
 * technique), so a store that SELECTs a column no migration created is red
 * here rather than in production.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const tcMigration = require('../migrations-tenant/1790100000000_tc_ortho_screening.js');
const hygMigration = require('../migrations-tenant/1790200000000_hyg_ortho_send.js');
const caseStore = require('../routes/tc/caseStore');
const visitStore = require('../services/hyg/visitStore');

/** A MigrationBuilder that records every call. */
function capture(migration, direction = 'up') {
  /** @type {Array<{ op: string, args: unknown[] }>} */
  const calls = [];
  const rec = (op) => (...args) => {
    calls.push({ op, args });
  };
  const pgm = {
    func: (expr) => ({ __func: expr }),
    sql: rec('sql'),
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    createTable: rec('createTable'),
    createIndex: rec('createIndex'),
  };
  migration[direction](pgm);
  return calls;
}

test('tc: ONE nullable jsonb column, ortho_screening, on tc_hygiene_intakes — no default, no backfill', () => {
  const calls = capture(tcMigration);
  const adds = calls.filter((c) => c.op === 'addColumns');
  assert.equal(adds.length, 1);
  const [table, cols] = adds[0].args;
  assert.equal(table, 'tc_hygiene_intakes');
  assert.deepEqual(Object.keys(cols), ['ortho_screening']);
  assert.equal(cols.ortho_screening.type, 'jsonb');
  assert.notEqual(cols.ortho_screening.notNull, true, 'nullable');
  assert.equal(cols.ortho_screening.default, undefined, 'no default: NULL means no screening');
  assert.ok(!calls.some((c) => c.op === 'createTable'), 'no new table');
  // No UPDATE: there is no honest value to give an intake nobody screened.
  const sql = calls.filter((c) => c.op === 'sql').map((c) => String(c.args[0]));
  // (The grant block names the UPDATE privilege; a backfill is UPDATE … SET.)
  assert.ok(!sql.some((s) => /\bUPDATE\s+\w+\s+SET\b/i.test(s)), 'no backfill');
});

test('tc: the carein_app grant is re-asserted, role-guarded, and audit_log is untouched', () => {
  const sql = capture(tcMigration)
    .filter((c) => c.op === 'sql')
    .map((c) => String(c.args[0]))
    .join('\n');
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', 'tc_hygiene_intakes'/);
  assert.match(sql, /SELECT 1 FROM pg_roles WHERE rolname = r/);
  assert.doesNotMatch(sql, /audit_log/);
  const src = fs.readFileSync(path.join(MIGRATIONS_DIR, '1790100000000_tc_ortho_screening.js'), 'utf8');
  assert.match(src, /AUDIT_APP_ROLE \|\| 'carein_app'/);
});

test('hyg: every new hyg_visit column is nullable, and the sent trio is all-or-nothing', () => {
  const calls = capture(hygMigration);
  const adds = calls.filter((c) => c.op === 'addColumns');
  assert.equal(adds.length, 1);
  const [table, cols] = adds[0].args;
  assert.equal(table, 'hyg_visit');
  for (const [name, spec] of Object.entries(cols)) {
    assert.notEqual(spec.notNull, true, `${name} must be nullable — existing visits have none`);
  }
  const checks = calls
    .filter((c) => c.op === 'addConstraint')
    .map((c) => String(c.args[2] && c.args[2].check));
  assert.ok(
    checks.some((c) => /\(ortho_tc_case_id IS NULL\) = \(ortho_sent_at IS NULL\)/.test(c)),
    'case id and sent-at together'
  );
  assert.ok(checks.some((c) => /\(ortho_sent_at IS NULL\) = \(ortho_sent_by IS NULL\)/.test(c)));
});

test('both down() migrations remove exactly what their up() added', () => {
  const tcDown = capture(tcMigration, 'down');
  assert.deepEqual(
    tcDown.filter((c) => c.op === 'dropColumns').map((c) => c.args[1]),
    [['ortho_screening']]
  );
  const hygDown = capture(hygMigration, 'down');
  const added = Object.keys(capture(hygMigration).find((c) => c.op === 'addColumns').args[1]);
  assert.deepEqual(
    hygDown.filter((c) => c.op === 'dropColumns').map((c) => [...c.args[1]].sort()),
    [[...added].sort()]
  );
});

test('both sit above 1790000000000 (develop’s newest when written) and nothing is numbered inside their range', () => {
  const numbers = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_/.test(f))
    .map((f) => Number(f.split('_')[0]));
  assert.ok(1790100000000 > 1790000000000 && 1790200000000 > 1790100000000);
  const others = numbers.filter((n) => n !== 1790100000000 && n !== 1790200000000);
  // Item 38 (1790300000000_tc_messaging) was the first migration to land after
  // these, which made the original "and are the newest" clause permanently
  // false for every later slice. What it protected at push time is that nothing
  // was numbered INTO item 33's range; that is what stays pinned.
  assert.ok(
    others.every((n) => n <= 1790000000000 || n > 1790200000000),
    'a migration was numbered inside item 33’s range — re-number it'
  );
  assert.equal(new Set(numbers).size, numbers.length, 'two migrations share a timestamp');
});

test('every column the stores SELECT exists once every tenant migration has run', () => {
  const schema = buildTenantSchema();

  const intake = schema.get('tc_hygiene_intakes');
  assert.ok(intake, 'replay found tc_hygiene_intakes');
  assert.deepEqual(
    caseStore.INTAKE_COLS.filter((c) => !intake.has(c)),
    [],
    'caseStore.INTAKE_COLS names a column no migration created'
  );
  assert.ok(caseStore.INTAKE_COLS.includes('ortho_screening'));

  const visit = schema.get('hyg_visit');
  assert.ok(visit, 'replay found hyg_visit');
  const visitCols = visitStore.VISIT_COLUMNS.split(',').map((c) => c.trim()).filter(Boolean);
  assert.deepEqual(
    visitCols.filter((c) => !visit.has(c)),
    [],
    'visitStore.VISIT_COLUMNS names a column no migration created'
  );
  for (const c of ['appointment_snapshot', 'ortho_tc_case_id', 'ortho_sent_at', 'ortho_sent_by', 'ortho_send_claimed_at']) {
    assert.ok(visitCols.includes(c), c);
  }
});
