'use strict';

/**
 * 1795000000000_office_format_checks (MT-2b2): every hard-coded office CHECK
 * becomes one format check, and down() puts the originals back verbatim.
 *
 * The real-Postgres half (a new office key inserts, garbage is refused, the
 * real down() and up() with rows present, down() refusing over a third
 * office's rows) is scripts/office-format-checks-verify-queries.js, which CI
 * runs after migrate.
 *
 * This file also pins the guardrail that makes a looser database safe: the
 * SERVER gates still refuse a made-up office. MT-2b3 moved those gates from a
 * hard-coded pair to officeRegistry.isTenantOffice for the session tenant
 * (platform/officeGate.js); the tests below pin the NEW rule. Every route is
 * walked by test/officeGateWiring.test.js.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../migrations-tenant/1795000000000_office_format_checks.js');

const SELF = 1795000000000;
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations-tenant');
const SOURCE = fs.readFileSync(path.join(MIGRATIONS_DIR, '1795000000000_office_format_checks.js'), 'utf8');

function capture(direction) {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = { sql: rec('sql'), addConstraint: rec('addConstraint'), dropConstraint: rec('dropConstraint') };
  migration[direction](pgm);
  return calls;
}

/** Every earlier tenant migration's source, in number order. */
function earlierSources() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.js$/.test(f) && Number(f.split('_')[0]) < SELF)
    .sort()
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8') }));
}

/**
 * The tables an earlier migration gave an office CHECK, read from source: the
 * literal `<table>_office_check` names, plus the `${TABLE}_office_check`
 * template form resolved through that file's `const TABLE = '...'`.
 */
function officeCheckTablesFromSource() {
  const tables = new Set();
  for (const { text } of earlierSources()) {
    if (!/IN \('roland', 'valley'\)/.test(text)) continue;
    for (const m of text.matchAll(/\b([a-z0-9_]+)_office_check\b/g)) tables.add(m[1]);
    if (/\$\{TABLE\}_office_check/.test(text)) {
      const t = text.match(/const TABLE = '([a-z0-9_]+)'/);
      assert.ok(t, 'a template-named office check resolves through const TABLE');
      tables.add(t[1]);
    }
  }
  return tables;
}

test("numbered above develop's newest at push (1794900000000); unique; numeric order = filename order", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.js$/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.ok(files.includes('1794900000000_tc_email_identity_practice_address.js'));
  assert.ok(SELF > 1794900000000);
  assert.equal(new Set(numbers).size, numbers.length, 'no two tenant migrations share a number');
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers, 'filename order is numeric order');
});

test('OFFICE_TABLES: 70 unique tables, 61 office_id + 9 office', () => {
  const names = migration.OFFICE_TABLES.map(([t]) => t);
  assert.equal(names.length, 70);
  assert.equal(new Set(names).size, 70, 'no table twice');
  assert.equal(migration.OFFICE_TABLES.filter(([, c]) => c === 'office_id').length, 61);
  assert.equal(migration.OFFICE_TABLES.filter(([, c]) => c === 'office').length, 9);
  for (const [table, column] of migration.OFFICE_TABLES) {
    // The hyg_* and fees_* modules named the column `office`; everything else `office_id`.
    assert.equal(column, /^(hyg|fees)_/.test(table) ? 'office' : 'office_id', table);
  }
});

test('OFFICE_TABLES is exactly the set of office CHECKs the earlier migrations created', () => {
  const fromSource = officeCheckTablesFromSource();
  const listed = new Set(migration.OFFICE_TABLES.map(([t]) => t));
  assert.deepEqual([...listed].filter((t) => !fromSource.has(t)), [], 'listed but never created');
  assert.deepEqual([...fromSource].filter((t) => !listed.has(t)), [], 'created but not listed — a pin would survive');
});

test('the originals are verbatim: every earlier office CHECK uses one of the two restored strings', () => {
  assert.equal(migration.ORIGINAL_CHECK_OFFICE_ID, "office_id IN ('roland', 'valley')");
  assert.equal(migration.ORIGINAL_CHECK_OFFICE, "office IN ('roland', 'valley')");
  for (const { file, text } of earlierSources()) {
    for (const m of text.matchAll(/"(office(?:_id)? IN \([^)]*\))"/g)) {
      assert.ok(
        [migration.ORIGINAL_CHECK_OFFICE_ID, migration.ORIGINAL_CHECK_OFFICE].includes(m[1]),
        `${file} wrote an office CHECK down() would not restore verbatim: ${m[1]}`
      );
    }
  }
});

test('up(): for each table, drop then re-add the SAME name with the format check', () => {
  const calls = capture('up');
  assert.equal(calls.length, 140);
  migration.OFFICE_TABLES.forEach(([table, column], i) => {
    const name = `${table}_office_check`;
    assert.deepEqual(calls[2 * i], { op: 'dropConstraint', args: [table, name] });
    assert.equal(calls[2 * i + 1].op, 'addConstraint');
    assert.deepEqual(calls[2 * i + 1].args, [table, name, { check: `${column} ~ '^[a-z][a-z0-9_-]{1,31}$'` }]);
  });
});

test('down(): the guard runs FIRST, then each original is restored under its own name', () => {
  const calls = capture('down');
  assert.equal(calls.length, 141);
  assert.deepEqual(calls[0], { op: 'sql', args: [migration.DOWN_GUARD] });
  migration.OFFICE_TABLES.forEach(([table, column], i) => {
    const name = `${table}_office_check`;
    assert.deepEqual(calls[1 + 2 * i], { op: 'dropConstraint', args: [table, name] });
    assert.deepEqual(calls[2 + 2 * i].args, [table, name, { check: `${column} IN ('roland', 'valley')` }]);
  });
});

test('the down guard checks every table and raises rather than rewriting rows', () => {
  for (const [table, column] of migration.OFFICE_TABLES) {
    assert.ok(migration.DOWN_GUARD.includes(`('${table}', '${column}')`), table);
  }
  assert.match(migration.DOWN_GUARD, /RAISE EXCEPTION/);
  assert.doesNotMatch(migration.DOWN_GUARD, /\b(DELETE|UPDATE)\b/i, 'a rollback never deletes or rewrites a practice’s rows');
});

test('the four CHECK strings are inline literals, not templates', () => {
  assert.match(SOURCE, /const FORMAT_CHECK_OFFICE_ID = "office_id ~ '\^\[a-z\]\[a-z0-9_-\]\{1,31\}\$'";/);
  assert.match(SOURCE, /const FORMAT_CHECK_OFFICE = "office ~ '\^\[a-z\]\[a-z0-9_-\]\{1,31\}\$'";/);
  assert.match(SOURCE, /const ORIGINAL_CHECK_OFFICE_ID = "office_id IN \('roland', 'valley'\)";/);
  assert.match(SOURCE, /const ORIGINAL_CHECK_OFFICE = "office IN \('roland', 'valley'\)";/);
  assert.doesNotMatch(SOURCE, /check: `/, 'no template-built CHECK');
});

test('the format (mirrored in JS): keys pass, garbage does not', () => {
  const re = /^[a-z][a-z0-9_-]{1,31}$/;
  for (const ok of ['roland', 'valley', 'unknown', 'fortsmith', 'office-3', 'tulsa_2', 'ab', 'a'.repeat(32)]) {
    assert.ok(re.test(ok), ok);
  }
  for (const bad of ['', 'a', 'Roland', 'ROLAND', '3office', '-x', '_x', 'has space', "x';--", 'a'.repeat(33), 'café']) {
    assert.ok(!re.test(bad), bad);
  }
});

// ── The refusal layer is the server. MT-2b3: the rule is isTenantOffice. ─────

function runGate(requireOffice, office, tenant = { id: 'T1', slug: 'carein' }) {
  const req = { tenant, query: office === undefined ? {} : { office } };
  const out = { status: null, nexted: false };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json() {
      return this;
    },
  };
  requireOffice(req, res, () => {
    out.nexted = true;
  });
  return out;
}

for (const mod of ['tc', 'hyg', 'fees', 'rcm']) {
  test(`routes/${mod} requireOffice asks isTenantOffice: carein's roland/valley pass; a made-up office is still 400`, () => {
    // MT-2b3 (was: the gate list is the literal pair). No list of its own now:
    // the gate is platform/officeGate.js, and for carein the registry or its
    // code-map fallback answers roland, valley.
    const helpers = require(`../routes/${mod}/helpers`);
    assert.equal(helpers.OFFICES, undefined, 'no hard-coded office list');
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', mod, 'helpers.js'), 'utf8');
    assert.match(SRC, /makeRequireOffice\(/);
    for (const ok of ['roland', 'valley']) assert.equal(runGate(helpers.requireOffice, ok).nexted, true, ok);
    // 'fortsmith' passes the NEW database format; the server must still refuse it.
    for (const bad of ['fortsmith', 'unknown', 'Roland', '', undefined]) {
      const r = runGate(helpers.requireOffice, bad);
      assert.equal(r.nexted, false, String(bad));
      assert.equal(r.status, 400, String(bad));
    }
    // No tenant, no offices: fail closed even for roland.
    assert.equal(runGate(helpers.requireOffice, 'roland', null).nexted, false);
  });
}

test("messaging.recordInbound still refuses an office that is not the tenant's before touching anything", async () => {
  const messaging = require('../services/messaging');
  await assert.rejects(
    messaging.recordInbound({}, { office: 'fortsmith', channel: 'sms', fromAddress: '+15555550100', body: 'hi' }),
    /frozen office key/
  );
  await assert.rejects(
    messaging.recordInbound(
      { tenant: { id: 'T1', slug: 'carein' } },
      { office: 'fortsmith', channel: 'sms', fromAddress: '+15555550100', body: 'hi' }
    ),
    /frozen office key/
  );
});
