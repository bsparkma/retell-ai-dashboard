'use strict';

/**
 * The tenant schema, derived from the migrations without a database.
 *
 * Replays every `migrations-tenant/*.js` `up()` in filename order against a
 * capturing MigrationBuilder and keeps a table → column inventory as it goes.
 * The same technique `rcmSchemaMigration.test.js` uses to assert SQL semantics,
 * lifted out so the query guard (`test/rcmQueryColumns.test.js`) and the live
 * verifier (`scripts/rcm-verify-queries.js`) share one answer.
 *
 * SOUND ONLY WHILE NO MIGRATION CHANGES A COLUMN THROUGH RAW `pgm.sql`. That
 * premise is pinned by a test in `rcmQueryColumns.test.js` rather than assumed
 * here, so it goes red before this file starts lying.
 */

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations-tenant');

/**
 * node-pg-migrate accepts a column spec as an array of names or an object keyed
 * by name; `dropColumns` also accepts a bare string. All three mean the same
 * thing to an inventory.
 * @param {unknown} spec
 * @returns {string[]}
 */
function columnNames(spec) {
  if (Array.isArray(spec)) return spec.map(String);
  if (spec && typeof spec === 'object') return Object.keys(spec);
  return [String(spec)];
}

/**
 * @returns {Map<string, Set<string>>} table name → its columns, after every migration
 */
function buildTenantSchema() {
  /** @type {Map<string, Set<string>>} */
  const tables = new Map();

  const pgm = {
    func: (expr) => ({ __func: expr }),
    // Constraints, indexes and type changes cannot add or remove a column, so
    // the inventory does not need them.
    sql: () => {},
    addConstraint: () => {},
    dropConstraint: () => {},
    createIndex: () => {},
    dropIndex: () => {},
    alterColumn: () => {},
    createTable: (name, cols) => tables.set(String(name), new Set(Object.keys(cols || {}))),
    dropTable: (name) => tables.delete(String(name)),
    addColumns: (table, cols) => {
      const set = tables.get(String(table));
      if (set) for (const c of columnNames(cols)) set.add(c);
    },
    dropColumns: (table, cols) => {
      const set = tables.get(String(table));
      if (set) for (const c of columnNames(cols)) set.delete(c);
    },
  };
  pgm.addColumn = pgm.addColumns;
  pgm.dropColumn = pgm.dropColumns;

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
  for (const file of files) {
    require(path.join(MIGRATIONS_DIR, file)).up(pgm);
  }
  return tables;
}

module.exports = { buildTenantSchema, columnNames, MIGRATIONS_DIR };
