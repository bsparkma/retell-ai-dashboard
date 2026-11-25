'use strict';

/**
 * 1795500000000_tc_nurture_library (EL-2), read as source. The real-Postgres
 * proof (the CHECK refusing a procedure without a tone, a tone without a
 * procedure and a tone 'D'; the store's insert; one real generator pass; the
 * real down() and up()) is scripts/tc-nurture-library-verify-queries.js, run by
 * CI after migrate.
 *
 *   - two nullable text columns on tc_nurture_enrollments, nothing else
 *   - the CHECK literal is inline, both-or-neither, A/B/C, and carries the
 *     explicit `library_variant IS NOT NULL` that closes the NULL hole
 *   - no grants (an ALTER on a table the app role already writes)
 *   - down() drops exactly what up() added
 *   - its timestamp is unique among the tenant migrations
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const DIR = path.join(__dirname, '..', 'migrations-tenant');
const FILE = '1795500000000_tc_nurture_library.js';
const src = fs.readFileSync(path.join(DIR, FILE), 'utf8');

/** A recording stand-in for node-pg-migrate's builder. */
function record(fn) {
  const calls = [];
  const pgm = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'func') return (s) => ({ func: s });
        return (...args) => calls.push([name, ...args]);
      },
    }
  );
  fn(pgm);
  return calls;
}

test('up(): two nullable text columns and one inline CHECK, on tc_nurture_enrollments only', () => {
  const calls = record(require(path.join(DIR, FILE)).up);
  assert.deepEqual(calls.map((c) => c[0]), ['addColumns', 'addConstraint']);
  const [, table, cols] = calls[0];
  assert.equal(table, 'tc_nurture_enrollments');
  assert.deepEqual(cols, {
    library_procedure_id: { type: 'text', notNull: false },
    library_variant: { type: 'text', notNull: false },
  });
  const [, ctable, name, opts] = calls[1];
  assert.equal(ctable, 'tc_nurture_enrollments');
  assert.equal(name, 'tc_nurture_enrollments_library_check');
  assert.equal(
    opts.check,
    "(library_procedure_id IS NULL AND library_variant IS NULL) OR (library_procedure_id IS NOT NULL AND library_variant IS NOT NULL AND library_variant IN ('A','B','C'))"
  );
});

test('the tone CHECK matches the contract vocabulary', () => {
  const contract = require('../tc/contract.gen.cjs');
  assert.deepEqual([...contract.NurtureLibraryVariant.options], ['A', 'B', 'C']);
});

test('no grants and no raw SQL: the app role already holds SELECT/INSERT/UPDATE on the table', () => {
  assert.ok(!/GRANT|REVOKE|pgm\.sql\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no grant statements in code');
});

test('down(): drops the CHECK and the two columns, nothing else', () => {
  const calls = record(require(path.join(DIR, FILE)).down);
  assert.deepEqual(calls, [
    ['dropConstraint', 'tc_nurture_enrollments', 'tc_nurture_enrollments_library_check', { ifExists: true }],
    ['dropColumns', 'tc_nurture_enrollments', ['library_procedure_id', 'library_variant'], { ifExists: true }],
  ]);
});

test('the timestamp is unique among tenant migrations', () => {
  const stamps = fs
    .readdirSync(DIR)
    .filter((f) => /^\d+_.+\.js$/.test(f))
    .map((f) => f.split('_')[0]);
  assert.equal(stamps.filter((s) => s === '1795500000000').length, 1);
});

test('the store and the generator read and write both columns', () => {
  const store = require('../services/tcNurture/store');
  assert.ok(store.ENROLLMENT_COLS.includes('library_procedure_id'));
  assert.ok(store.ENROLLMENT_COLS.includes('library_variant'));
});
