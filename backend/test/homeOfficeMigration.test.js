'use strict';

/**
 * Unit tests for 1786680000000_app_user_home_office.
 *
 * CI has no standing control DB at unit-test time, so this exercises the
 * migration against a capturing mock of node-pg-migrate's MigrationBuilder and
 * asserts the SQL semantics — the same approach as rolesSpineMigration.test.js.
 * Real application against Postgres is covered by the CI staging gate
 * (`node scripts/migrate.js up`).
 *
 * The properties that would hurt in production:
 *  - the column is ADDITIVE and NULLABLE, so applying it locks nobody out and
 *    every existing row keeps working with no home office;
 *  - there is NO database-level enum or CHECK on the value. Offices are
 *    CONFIG (config/officeAgents), not schema: adding an office must stay a
 *    config change, and a migration that pinned the office list would make it
 *    a schema change. Validation lives in the API, where the roster is;
 *  - down() removes exactly what up() added.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const migration = require('../migrations/1786680000000_app_user_home_office.js');

function makePgm() {
  const calls = { sql: [], addColumns: [], dropColumns: [], addConstraint: [], dropConstraint: [] };
  return {
    calls,
    sql: (text) => calls.sql.push(String(text)),
    func: (expr) => ({ __func: expr }),
    addColumns: (table, cols) => calls.addColumns.push({ table, cols }),
    dropColumns: (table, cols) => calls.dropColumns.push({ table, cols }),
    addConstraint: (table, name, opts) => calls.addConstraint.push({ table, name, opts }),
    dropConstraint: (table, name) => calls.dropConstraint.push({ table, name }),
  };
}

test('up() adds one nullable text column to app_user and nothing else', () => {
  const pgm = makePgm();
  migration.up(pgm);

  assert.equal(pgm.calls.addColumns.length, 1);
  const [added] = pgm.calls.addColumns;
  assert.equal(added.table, 'app_user');
  assert.deepEqual(Object.keys(added.cols), ['home_office']);
  assert.equal(added.cols.home_office.type, 'text');
  // Nullable and undefaulted: "no home office" is a real, common answer — the
  // shared temp@ account is meant to have none — and a NOT NULL column would
  // force a fabricated default onto every existing row.
  assert.equal(added.cols.home_office.notNull, false);
  assert.equal(added.cols.home_office.default, undefined);

  assert.equal(pgm.calls.dropColumns.length, 0);
  assert.equal(pgm.calls.sql.length, 0, 'nothing is backfilled — no home office is the honest state');
});

test('up() adds NO check constraint — offices are config, not schema', () => {
  // If the valid offices were pinned here, adding an office would become a
  // migration instead of a one-line config change (config/odOffices.js says
  // adding an office is a config change, not new code). The API validates the
  // value against the live roster instead.
  const pgm = makePgm();
  migration.up(pgm);
  assert.equal(pgm.calls.addConstraint.length, 0);
});

test('down() drops exactly the column up() added', () => {
  const pgm = makePgm();
  migration.down(pgm);

  assert.equal(pgm.calls.dropColumns.length, 1);
  assert.deepEqual(pgm.calls.dropColumns[0], { table: 'app_user', cols: ['home_office'] });
  assert.equal(pgm.calls.dropConstraint.length, 0);
  assert.equal(pgm.calls.sql.length, 0, 'down() must not touch anyone’s role or status');
});
