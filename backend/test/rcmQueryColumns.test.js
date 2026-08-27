'use strict';

/**
 * Every column an RCM query names must be a column the migrations create.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The 2026-08-26 staging walk stopped at the first Drain:
 *
 *     column "od_patient_office" does not exist
 *
 * `loadPlan` selected it from `rcm_claims`. It had never existed — a claim's
 * patient office IS the claim's `office_id` (hard rule 3: one remittance, one
 * office, and no cross-office claim). The unit suite was green, because the test
 * double is a `Map` that hands back whatever a fixture seeded, including a
 * column Postgres would refuse. CI migrates a real Postgres and runs a spine
 * smoke test, but it never drains a real plan, so nothing anywhere held the
 * queries against the schema.
 *
 * A query naming a column that does not exist must fail HERE, on every machine
 * and in CI, and not on a walk night with a biller watching.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW IT KNOWS THE SCHEMA
 * ─────────────────────────────────────────────────────────────────────────────
 * By replaying `migrations-tenant/*.js` `up()` in filename order against a
 * capturing MigrationBuilder — the same technique `rcmSchemaMigration.test.js`
 * uses — and keeping a table → column inventory as it goes. That is sound here
 * for one checkable reason, pinned as a test below: **no tenant migration adds
 * or drops a column through raw `pgm.sql`.** Every column change goes through
 * `createTable` / `addColumns` / `dropColumns`, all of which this replay sees.
 * If that ever stops being true, the guard test below goes red before this file
 * starts lying.
 *
 * This is a static check, so it cannot catch everything a real Postgres would —
 * a bad cast, a function that does not exist, an ambiguous join. It catches the
 * class that actually bit us, on zero infrastructure. The live counterpart is
 * `scripts/rcm-verify-queries.js`, which runs the real statements against the
 * real migrated schema in CI.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const postingDrain = require('../services/rcm/postingDrain');
const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');

const SCHEMA = buildTenantSchema();

// ─── The premise this file rests on ──────────────────────────────────────────

test('no tenant migration changes a column through raw pgm.sql', () => {
  /*
   * The replay only sees the structured builder calls. A migration that reached
   * for `pgm.sql('ALTER TABLE ... ADD COLUMN ...')` would be invisible to it,
   * and this file would start passing queries it should refuse — or, worse,
   * refusing ones that are fine. Pinning the premise is cheaper than teaching
   * the replay to parse SQL.
   */
  const offenders = [];
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const re = /pgm\.sql\(([\s\S]*?)\)\s*;/g;
    let m;
    while ((m = re.exec(src))) {
      if (/\b(add|drop)\s+column\b/i.test(m[1])) offenders.push(`${file}: ${m[1].slice(0, 80)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a raw-SQL column change makes the replay wrong — teach it, or use addColumns'
  );
});

test('the replay found the tables the drain reads', () => {
  for (const t of [
    'rcm_claims',
    'rcm_posting_queue',
    'rcm_posting_queue_line',
    'rcm_payment_batches',
  ]) {
    assert.ok(SCHEMA.has(t), `${t} missing from the replayed schema — the replay is broken`);
  }
});

// ─── The column lists the drain builds its SELECTs from ──────────────────────

const COLUMN_LISTS = [
  ['rcm_posting_queue', postingDrain.QUEUE_COLUMNS],
  ['rcm_posting_queue_line', postingDrain.LINE_COLUMNS],
  ['rcm_claims', postingDrain.CLAIM_COLUMNS],
];

for (const [table, columns] of COLUMN_LISTS) {
  test(`every column postingDrain selects from ${table} exists`, () => {
    const known = SCHEMA.get(table);
    const missing = columns.filter((c) => !known.has(c));
    assert.deepEqual(missing, [], `${table} has no such column(s)`);
  });
}

test('rcm_claims has no od_patient_office column — the office is office_id', () => {
  /*
   * THE REGRESSION PIN. Hard rule 3 says a PatNum without its office names
   * nothing; it does NOT say the office is stored twice. `rcm_claims.office_id`
   * is the office, a remittance belongs to one, and there is no cross-office
   * claim. A second column would be a pair that can disagree.
   */
  assert.ok(!SCHEMA.get('rcm_claims').has('od_patient_office'));
  assert.ok(SCHEMA.get('rcm_claims').has('office_id'));
  assert.ok(SCHEMA.get('rcm_claims').has('od_patient_id'));
  assert.ok(
    !postingDrain.CLAIM_COLUMNS.includes('od_patient_office'),
    'the drain must not ask for it again'
  );
});

// ─── Every literal query in the module, held against the schema ──────────────

const RCM_SOURCES = [
  ...fs
    .readdirSync(path.join(__dirname, '..', 'services', 'rcm'))
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => path.join('services', 'rcm', f)),
  ...fs
    .readdirSync(path.join(__dirname, '..', 'routes', 'rcm'))
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'rcmTestUtils.js')
    .map((f) => path.join('routes', 'rcm', f)),
];

/**
 * Pull the checkable column references out of one file's SQL.
 *
 * Deliberately conservative: it reads only what it can read with certainty and
 * stays quiet about the rest. A query assembled through an interpolation is
 * skipped rather than guessed at — the column LISTS above cover those — and
 * anything this misses is a false negative, never a false alarm. A guard that
 * cries wolf gets switched off.
 *
 * @param {string} rawSrc
 * @returns {{table: string, column: string, kind: string}[]}
 */
function columnReferences(rawSrc) {
  /*
   * FLATTEN THE CONCATENATION SEAMS FIRST.
   *
   * These queries are written as adjacent string literals joined with `+`, so a
   * select-list routinely straddles a seam. Scanning the raw source misses those
   * queries ENTIRELY and says nothing about it — which is how the first version
   * of this file passed on the very defect it was written for. Collapsing
   * `<quote> + <quote>` to a space makes a concatenated statement read as the
   * one statement Postgres will actually receive.
   */
  const src = rawSrc.replace(/['"`]\s*\+\s*['"`]/g, ' ');
  const refs = [];
  const add = (table, column, kind) => {
    if (/^rcm_[a-z0-9_]+$/.test(table)) refs.push({ table, column, kind });
  };
  const interpolated = (s) => s.includes('${');

  // UPDATE <table> SET a = $1, b = now(), c = NULL
  const updates = /UPDATE\s+(rcm_[a-z0-9_]+)\s+SET\s+([\s\S]*?)(?:WHERE|RETURNING|`)/gi;
  let m;
  while ((m = updates.exec(src))) {
    const [, table, setClause] = m;
    if (interpolated(setClause)) continue;
    const assign = /(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/gi;
    let a;
    while ((a = assign.exec(setClause))) add(table, a[1], 'UPDATE SET');
  }

  // SELECT a, b, c FROM <table> — literal select-lists only.
  const selects = /SELECT\s+([\s\S]*?)\s+FROM\s+(rcm_[a-z0-9_]+)/gi;
  while ((m = selects.exec(src))) {
    const [, list, table] = m;
    if (interpolated(list) || list.includes('*') || list.includes('(')) continue;
    for (const raw of list.split(',')) {
      const col = raw.trim().split(/\s+/)[0].replace(/::.*$/, '');
      if (/^[a-z_][a-z0-9_]*$/.test(col)) add(table, col, 'SELECT');
    }
  }

  // INSERT INTO <table> (a, b, c)
  const inserts = /INSERT\s+INTO\s+(rcm_[a-z0-9_]+)\s*\(([\s\S]*?)\)/gi;
  while ((m = inserts.exec(src))) {
    const [, table, list] = m;
    if (interpolated(list)) continue;
    for (const raw of list.split(',')) {
      const col = raw.trim();
      if (/^[a-z_][a-z0-9_]*$/.test(col)) add(table, col, 'INSERT');
    }
  }

  return refs;
}

test('every literal column reference in services/rcm and routes/rcm exists', () => {
  const missing = [];
  let checked = 0;
  for (const rel of RCM_SOURCES) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const ref of columnReferences(src)) {
      const known = SCHEMA.get(ref.table);
      if (!known) {
        missing.push(`${rel}: no such table ${ref.table}`);
        continue;
      }
      checked++;
      if (!known.has(ref.column)) {
        missing.push(`${rel}: ${ref.table}.${ref.column} (${ref.kind}) does not exist`);
      }
    }
  }
  assert.deepEqual(missing, []);
  // A scanner that silently matched nothing would pass forever. It has to be
  // seen to be doing work.
  assert.ok(
    checked > 100,
    `only ${checked} column references checked — the scanner stopped working`
  );
});
