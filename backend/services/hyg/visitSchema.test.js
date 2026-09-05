'use strict';

/**
 * The MIGRATION and the CONTRACT agree — enforced, not hoped for.
 *
 * The CHECK constraints in migrations-tenant/1788200000000_hyg_visit.js are
 * written as inline literals on purpose: a migration is a historical record of
 * what a database was told, and one that reads its constraint out of today's
 * source code silently changes meaning when that source changes.
 *
 * The cost of that choice is drift, and this file is what pays it. Every
 * vocabulary the database enforces is asserted against the zod enum the API and
 * the screen use. A value that the contract accepts and the database refuses is
 * a 500 in front of a hygienist with a patient in the chair; the reverse is a
 * row nothing can render.
 *
 * The GRANT block is checked here too. A table the least-privilege `carein_app`
 * role cannot reach fails as a PERMISSION ERROR in production, not as a red
 * migration — the `call_record` lesson, and the reason every table-creating
 * migration in this repo carries one.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../../migrations-tenant/1788200000000_hyg_visit.js');
const contract = require('../../hyg/contract.gen.cjs');

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  '..',
  'migrations-tenant',
  '1788200000000_hyg_visit.js'
);
const SOURCE = fs.readFileSync(MIGRATION_PATH, 'utf8');

test('the database enforces exactly the vocabularies the contract does', () => {
  assert.deepEqual(
    migration.TREATMENT_PRIORITIES,
    contract.TreatmentPrioritySchema.options,
    'priority'
  );
  assert.deepEqual(
    migration.TREATMENT_CATEGORIES,
    contract.TreatmentCategorySchema.options,
    'category'
  );
  assert.deepEqual(migration.TREATMENT_STATUSES, contract.TreatmentStatusSchema.options, 'status');
  assert.deepEqual(migration.STAGED_WRITE_KINDS, contract.StagedWriteKindSchema.options, 'kind');
  assert.deepEqual(migration.STAGED_WRITE_STATES, contract.StagedWriteStateSchema.options, 'state');
});

test('priority and category are checked SEPARATELY, and their words cannot cross', () => {
  // The two axes share the word "cosmetic": a cosmetic veneer is a
  // Cosmetic-CATEGORY item, and a cosmetic PRIORITY says the work can wait.
  // Case-insensitively disjoint, because lowercasing the category union later
  // is the obvious future tidy-up and it must fail the build rather than open
  // the hole.
  const priorities = new Set(migration.TREATMENT_PRIORITIES.map((v) => v.toLowerCase()));
  const overlap = migration.TREATMENT_CATEGORIES.filter((c) => priorities.has(c.toLowerCase()));
  assert.deepEqual(overlap, ['Cosmetic'], 'the one word they share, and it must stay separate');

  // Two constraints, two columns, two names. One shared CHECK or one shared
  // enum type would be the defect.
  assert.match(SOURCE, /hyg_treatment_item_priority_check/);
  assert.match(SOURCE, /hyg_treatment_item_category_check/);
  assert.match(SOURCE, /priority IN \(/);
  assert.match(SOURCE, /category IN \(/);
  // And they are separate COLUMNS, not one column read two ways.
  assert.match(SOURCE, /category: \{ type: 'text', notNull: true \}/);
  assert.match(SOURCE, /priority: \{ type: 'text', notNull: true \}/);
});

test('every table this migration creates is granted to the app role, in this migration', () => {
  const created = [...SOURCE.matchAll(/pgm\.createTable\('(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(created, migration.HYG_TABLES, 'HYG_TABLES is the grant block’s list');

  // The grant block itself: REVOKE from PUBLIC, then CRUD to the role, guarded
  // on the role existing so local dev on a superuser is a NOTICE, not a crash.
  assert.match(SOURCE, /REVOKE ALL ON TABLE %I FROM PUBLIC/);
  assert.match(SOURCE, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
  assert.match(SOURCE, /AUDIT_APP_ROLE \|\| 'carein_app'/);
  assert.match(SOURCE, /SELECT 1 FROM pg_roles WHERE rolname = r/);
  // No STATEMENT in this migration touches audit_log: its grants are
  // append-only and are somebody else's. Comments are stripped first, because
  // the migration explains itself by pointing at that table by name.
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /audit_log/);
});

test('office is NOT NULL and CHECKed on all three tables', () => {
  for (const table of migration.HYG_TABLES) {
    assert.match(
      SOURCE,
      new RegExp(`'${table}', '${table}_office_check'`),
      `${table} has no office CHECK`
    );
  }
  // The frozen list, matching the contract's own office enum.
  assert.deepEqual(contract.OfficeIdSchema.options, ['roland', 'valley']);
  assert.match(SOURCE, /office IN \('roland', 'valley'\)/);

  // The composite FK is what stops a child's office drifting from its parent's.
  const fks = [...SOURCE.matchAll(/references: 'hyg_visit\(visit_id, office\)'/g)];
  assert.equal(fks.length, 2, 'both children must reference (visit_id, office)');
});

test('one visit per appointment, and one staged write per kind', () => {
  assert.match(SOURCE, /unique: \['office', 'apt_num'\]/);
  assert.match(SOURCE, /unique: \['visit_id', 'kind'\]/);
});

test('a Failed staged write must carry a reason, and attribution is all-or-nothing', () => {
  // Both are written the long way because Postgres ACCEPTS a CHECK that
  // evaluates to NULL — it only rejects an explicit false.
  assert.match(SOURCE, /state <> 'Failed' OR error_message IS NOT NULL/);
  assert.match(SOURCE, /\(sent_by IS NULL\) = \(sent_at IS NULL\)/);
});

test('the migration number is above every migration already in the tree', () => {
  // A lower-timestamped migration cannot land behind a deployed one:
  // node-pg-migrate's checkOrder refuses it, and the failure is at deploy time.
  const dir = path.join(__dirname, '..', '..', 'migrations-tenant');
  const numbers = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_/.test(f))
    .map((f) => Number(f.split('_')[0]));
  const mine = 1788200000000;
  const higher = numbers.filter((n) => n > mine);
  assert.deepEqual(higher, [], 'something already sorts after the hyg_visit migration');
});
