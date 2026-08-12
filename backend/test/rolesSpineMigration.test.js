'use strict';

/**
 * Unit tests for 1786449600000_roles_spine.
 *
 * CI has no standing control DB at unit-test time, so this exercises the
 * migration against a capturing mock of node-pg-migrate's MigrationBuilder and
 * asserts the SQL semantics — the same approach as renameModuleMigration.test.js.
 * Real application against Postgres is covered by the CI staging gate
 * (`node scripts/migrate.js up`).
 *
 * The properties under test are the ones that would hurt in production:
 *  - re-running the seed neither duplicates a row nor re-enables a disabled one;
 *  - admin@carein.ai (seeded by an EARLIER migration) is not duplicated by this
 *    one, and survives its down();
 *  - the roster in the migration matches the roster in the Entra script, so an
 *    account can never exist without a role row.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../migrations/1786449600000_roles_spine.js');

function makePgm() {
  const calls = {
    sql: [],
    createTable: [],
    dropTable: [],
    addColumns: [],
    dropColumns: [],
    addConstraint: [],
    dropConstraint: [],
  };
  return {
    calls,
    sql: (text) => calls.sql.push(String(text)),
    func: (expr) => ({ __func: expr }),
    createTable: (name, cols) => calls.createTable.push({ name, cols }),
    dropTable: (name) => calls.dropTable.push(name),
    addColumns: (table, cols) => calls.addColumns.push({ table, cols }),
    dropColumns: (table, cols) => calls.dropColumns.push({ table, cols }),
    addConstraint: (table, name, opts) => calls.addConstraint.push({ table, name, opts }),
    dropConstraint: (table, name) => calls.dropConstraint.push({ table, name }),
  };
}

// --- roster shape ----------------------------------------------------------

test('the roster is exactly the 12 seeded accounts, with valid roles and unique emails', () => {
  const { ROSTER } = migration;
  assert.equal(ROSTER.length, 12);

  const valid = ['admin', 'office', 'tc', 'hygiene'];
  for (const entry of ROSTER) {
    assert.ok(valid.includes(entry.role), `${entry.email}: '${entry.role}' is not a valid role`);
    assert.match(entry.email, /^[a-z0-9._-]+@carein\.ai$/, `${entry.email}: unexpected address shape`);
    assert.equal(entry.email, entry.email.toLowerCase(), `${entry.email}: must be lowercased`);
  }

  const emails = ROSTER.map((r) => r.email);
  assert.equal(new Set(emails).size, emails.length, 'duplicate address in the roster');
});

test('admin@carein.ai is NOT in the roster — the earlier seed owns that row', () => {
  assert.ok(!migration.ROSTER.some((r) => r.email === 'admin@carein.ai'));
  assert.deepEqual([...migration.PLATFORM_ADMINS], ['admin@carein.ai']);
});

test('the roster matches the Entra account script (an account without a role row locks out in PR B)', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', '..', 'scripts', 'entra', 'create-staff-accounts.ps1'),
    'utf8'
  );

  const inScript = new Set(
    [...script.matchAll(/Upn\s*=\s*'([^']+)'/g)].map((m) => m[1].toLowerCase())
  );
  const inMigration = new Set(migration.ROSTER.map((r) => r.email));

  for (const email of inMigration) {
    assert.ok(inScript.has(email), `${email} is seeded but the Entra script would not create it`);
  }
  for (const email of inScript) {
    assert.ok(inMigration.has(email), `${email} would be created in Entra but has no app_user row`);
  }
});

// --- up() ------------------------------------------------------------------

test('up(): creates platform_admin with the status + lowercase-email CHECKs', () => {
  const pgm = makePgm();
  migration.up(pgm);

  const created = pgm.calls.createTable.find((t) => t.name === 'platform_admin');
  assert.ok(created, 'platform_admin must be created');
  assert.equal(created.cols.email.primaryKey, true);
  assert.equal(created.cols.status.notNull, true);
  assert.equal(created.cols.status.default, 'active');

  const checks = pgm.calls.addConstraint.filter((c) => c.table === 'platform_admin');
  assert.equal(checks.length, 2);
  assert.ok(checks.some((c) => c.opts.check === "status IN ('active', 'disabled')"));
  assert.ok(checks.some((c) => c.opts.check === 'email = lower(email)'));
});

test('up(): adds app_user.status (NOT NULL, defaulted) and nullable last_login_at', () => {
  const pgm = makePgm();
  migration.up(pgm);

  const added = pgm.calls.addColumns.find((a) => a.table === 'app_user');
  assert.ok(added, 'app_user must gain the two columns');
  // NOT NULL + default backfills every existing row in the same statement —
  // nobody loses access when this applies.
  assert.equal(added.cols.status.notNull, true);
  assert.equal(added.cols.status.default, 'active');
  assert.equal(added.cols.last_login_at.notNull, false);

  const check = pgm.calls.addConstraint.find((c) => c.name === 'app_user_status_check');
  assert.ok(check);
  assert.equal(check.opts.check, "status IN ('active', 'disabled')");
});

test('up(): seeds every roster row as an idempotent upsert on (tenant_id, email)', () => {
  const pgm = makePgm();
  migration.up(pgm);
  const all = pgm.calls.sql.join('\n');

  for (const { email, role } of migration.ROSTER) {
    const stmt = pgm.calls.sql.find((s) => s.includes(`'${email}'`));
    assert.ok(stmt, `${email} is not seeded`);
    assert.match(stmt, /INSERT INTO app_user \(tenant_id, email, role\)/);
    assert.match(stmt, /ON CONFLICT \(tenant_id, email\) DO UPDATE/);
    assert.ok(stmt.includes(`'${role}'`), `${email} should be seeded as ${role}`);
    assert.ok(stmt.includes(`'${migration.CAREIN_TENANT_ID}'`), `${email} must be scoped to the CareIN tenant`);
  }

  // Re-running must never silently re-enable an account someone disabled: the
  // app_user upsert touches `role` and nothing else.
  for (const stmt of pgm.calls.sql.filter((s) => s.includes('INSERT INTO app_user'))) {
    assert.doesNotMatch(stmt, /status/i, 'the app_user seed must not write status');
    assert.match(stmt, /SET role = EXCLUDED\.role;/);
  }
  assert.ok(all.length > 0);
});

test('up(): seeds admin@carein.ai into platform_admin only (no duplicate app_user row)', () => {
  const pgm = makePgm();
  migration.up(pgm);

  const adminStatements = pgm.calls.sql.filter((s) => s.includes('admin@carein.ai'));
  assert.equal(adminStatements.length, 1, 'admin@ should be touched exactly once');
  assert.match(adminStatements[0], /INSERT INTO platform_admin/);
  assert.match(adminStatements[0], /ON CONFLICT \(email\) DO UPDATE/);
  assert.doesNotMatch(adminStatements[0], /INSERT INTO app_user/);
});

test('up(): every seeded email is lowercased into platform_admin', () => {
  const pgm = makePgm();
  migration.up(pgm);
  const stmt = pgm.calls.sql.find((s) => s.includes('INSERT INTO platform_admin'));
  assert.ok(stmt.includes("'admin@carein.ai'"));
});

// --- down() ----------------------------------------------------------------

test('down(): removes only what up() added, and leaves admin@carein.ai alone', () => {
  const pgm = makePgm();
  migration.down(pgm);
  const all = pgm.calls.sql.join('\n');

  assert.match(all, /DELETE FROM app_user WHERE tenant_id = /);
  for (const { email } of migration.ROSTER) {
    assert.ok(all.includes(`'${email}'`), `${email} should be removed by down()`);
  }
  assert.ok(
    !all.includes("'admin@carein.ai'"),
    "down() must NOT delete admin@carein.ai — it belongs to the earlier seed migration"
  );

  assert.deepEqual(pgm.calls.dropColumns, [{ table: 'app_user', cols: ['status', 'last_login_at'] }]);
  assert.deepEqual(pgm.calls.dropConstraint, [{ table: 'app_user', name: 'app_user_status_check' }]);
  assert.deepEqual(pgm.calls.dropTable, ['platform_admin']);
});

test('down(): the app_user delete is tenant-scoped (never a bare email match)', () => {
  const pgm = makePgm();
  migration.down(pgm);
  const del = pgm.calls.sql.find((s) => s.includes('DELETE FROM app_user'));
  assert.ok(del.includes(migration.CAREIN_TENANT_ID));
});

// --- idempotence -----------------------------------------------------------

test('up() emits identical SQL on a second run (the seed is pure and re-runnable)', () => {
  const a = makePgm();
  const b = makePgm();
  migration.up(a);
  migration.up(b);
  assert.deepEqual(a.calls.sql, b.calls.sql);
});
