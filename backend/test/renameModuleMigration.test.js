'use strict';

/**
 * Unit tests for 1785369600000_rename_module_carein_to_voice.
 *
 * CI has no standing control DB at unit-test time, so this exercises the
 * migration against a capturing mock of node-pg-migrate's MigrationBuilder and
 * asserts the SQL semantics: rows merge-renamed 'carein' → 'voice' (PK-safe),
 * old rows deleted, and the module-vocabulary CHECK enforced with exactly the
 * decided ids. The real DB application is covered by the CI staging gate,
 * which runs `node scripts/migrate.js up` against ephemeral Postgres and then
 * smoke-spine (which asserts modules.includes('voice')).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../migrations/1785369600000_rename_module_carein_to_voice.js');

function makePgm() {
  const calls = { sql: [], addConstraint: [], dropConstraint: [] };
  return {
    calls,
    sql: (text) => calls.sql.push(String(text)),
    addConstraint: (table, name, opts) => calls.addConstraint.push({ table, name, opts }),
    dropConstraint: (table, name) => calls.dropConstraint.push({ table, name }),
  };
}

test('up(): merge-renames carein rows to voice without PK conflicts, then deletes the old rows', () => {
  const pgm = makePgm();
  migration.up(pgm);

  const all = pgm.calls.sql.join('\n');
  // Rename is INSERT..SELECT with ON CONFLICT (merge), not a bare UPDATE —
  // a bare UPDATE would violate the (tenant_id, module) PK on envs whose
  // seed already wrote 'voice'.
  assert.match(all, /INSERT INTO tenant_module/);
  assert.match(all, /SELECT tenant_id, 'voice', enabled/);
  assert.match(all, /WHERE module = 'carein'/);
  assert.match(all, /ON CONFLICT \(tenant_id, module\)/);
  assert.match(all, /DELETE FROM tenant_module WHERE module = 'carein';/);
  assert.doesNotMatch(all, /UPDATE tenant_module\s+SET module/i);
});

test("up(): enforces the module vocabulary CHECK ('voice','rcm','tc','scheduling')", () => {
  const pgm = makePgm();
  migration.up(pgm);

  assert.equal(pgm.calls.addConstraint.length, 1);
  const c = pgm.calls.addConstraint[0];
  assert.equal(c.table, 'tenant_module');
  assert.equal(c.name, 'tenant_module_module_check');
  assert.equal(c.opts.check, "module IN ('voice', 'rcm', 'tc', 'scheduling')");
});

test('down(): drops the CHECK and merge-renames voice back to carein', () => {
  const pgm = makePgm();
  migration.down(pgm);

  assert.deepEqual(pgm.calls.dropConstraint, [
    { table: 'tenant_module', name: 'tenant_module_module_check' },
  ]);
  const all = pgm.calls.sql.join('\n');
  assert.match(all, /SELECT tenant_id, 'carein', enabled/);
  assert.match(all, /WHERE module = 'voice'/);
  assert.match(all, /DELETE FROM tenant_module WHERE module = 'voice';/);
});

test("seed migration now enables module 'voice' (fresh installs never write 'carein')", () => {
  const seedSrc = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '1780448576257_seed_tenant_carein.js'),
    'utf8'
  );
  assert.match(seedSrc, /VALUES \(\$\{id\}, 'voice', true\)/);
  assert.doesNotMatch(seedSrc, /VALUES \(\$\{id\}, 'carein', true\)/);
});
