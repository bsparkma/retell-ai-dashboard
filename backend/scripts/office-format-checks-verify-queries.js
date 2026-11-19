#!/usr/bin/env node
'use strict';

/**
 * 1795000000000_office_format_checks (MT-2b2), EXECUTED against a real
 * migrated tenant schema with synthetic data. The unit suite captures pgm
 * calls; only Postgres can prove a CHECK or a real down().
 *
 * PART A — one transaction, ALWAYS rolled back:
 *   - the catalog: no CHECK anywhere still names roland/valley, and all 70
 *     `<table>_office_check` constraints are the one format check
 *   - existing writes still succeed: hyg visitStore.openVisit for roland AND
 *     valley (a real store path)
 *   - a NEW office key ('fortsmith') inserts directly into representative
 *     tables of every module family (hyg_staff `office`; tc_referral_directory,
 *     tc_provider_directory, rcm_payer_rules `office_id`) — and so does
 *     'unknown', accepted by design (the server gates keep it out)
 *   - the format refuses garbage (23514) on each of those tables, and NULL is
 *     still refused (23502)
 *
 * PART B — this migration's REAL down() and up(), via node-pg-migrate, with
 *   COMMITTED rows present: a 'fortsmith' row makes down() REFUSE (and the
 *   schema is untouched — the migration runs in one transaction); with only
 *   roland/valley rows, down() restores all 70 originals verbatim, keeps the
 *   rows, and refuses 'fortsmith' again; up() accepts it again. RUNS ONLY when
 *   this migration is the newest applied one and the representative tables
 *   hold no row it did not seed — it never rolls back somebody else's
 *   migration or touches real data. Seeded rows are deleted at the end, pass
 *   or fail.
 *
 * NO OPEN DENTAL. Every value is a synthetic literal; PatNum 12827 is the
 * roland test fixture and 7115 the valley one.
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside the other verifiers):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/office-format-checks-verify-queries.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');

const migration = require('../migrations-tenant/1795000000000_office_format_checks.js');
const visitStore = require('../services/hyg/visitStore');

const SELF = '1795000000000_office_format_checks';
const ACTOR = 'verify@fixture.invalid';
const NEW_OFFICE = 'fortsmith';
const MARK = 'MT2b2 verify fixture'; // every seeded row's name carries this

const PG_CHECK_VIOLATION = '23514';
const PG_NOT_NULL_VIOLATION = '23502';

const GARBAGE = ['', 'a', 'Roland', '3office', '-x', 'has space', "x';--", 'a'.repeat(33)];

/** One synthetic row per representative table, for any office value. */
const INSERTS = {
  hyg_staff: (office, n) => [
    // sign_in_ids must hold 1–10 entries (hyg_staff_sign_in_ids_check).
    "INSERT INTO hyg_staff (office, full_name, sign_in_ids, created_by, updated_by) VALUES ($1, $2, jsonb_build_array($3::text), $3, $3)",
    [office, `${MARK} ${n}`, ACTOR],
  ],
  tc_referral_directory: (office, n) => [
    'INSERT INTO tc_referral_directory (office_id, practice_name, created_by, updated_by) VALUES ($1, $2, $3, $3)',
    [office, `${MARK} ${n}`, ACTOR],
  ],
  tc_provider_directory: (office, n) => [
    'INSERT INTO tc_provider_directory (office_id, name, created_by, updated_by) VALUES ($1, $2, $3, $3)',
    [office, `${MARK} ${n}`, ACTOR],
  ],
  rcm_payer_rules: (office, n) => [
    'INSERT INTO rcm_payer_rules (office_id, payer_name) VALUES ($1, $2)',
    [office, `${MARK} ${n}`],
  ],
};
const NAME_COLUMN = {
  hyg_staff: 'full_name',
  tc_referral_directory: 'practice_name',
  tc_provider_directory: 'name',
  rcm_payer_rules: 'payer_name',
};

let seq = 0;
const insert = (client, table, office) => client.query(...INSERTS[table](office, ++seq));

/** Run `fn` inside a savepoint and require Postgres to refuse it with `code`. */
async function mustRefuse(client, code, fn) {
  await client.query('SAVEPOINT must_refuse');
  try {
    await fn();
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT must_refuse');
    if (err.code !== code) throw new Error(`refused, but with ${err.code} (wanted ${code}): ${err.message}`);
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT must_refuse');
  throw new Error('the schema ACCEPTED a write it must refuse');
}

/** { table -> constraint definition } for every `<table>_office_check`. */
async function officeChecks(client) {
  const r = await client.query(
    `SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE contype = 'c' AND conname = conrelid::regclass::text || '_office_check'`
  );
  return new Map(r.rows.map((x) => [x.tbl, x.def]));
}

async function pairPinsLeft(client) {
  const r = await client.query(
    `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ '(roland|valley)'`
  );
  return r.rows[0].n;
}

const formatDef = (col) => `CHECK ((${col} ~ '^[a-z][a-z0-9_-]{1,31}$'::text))`;
const originalDef = (col) => `CHECK ((${col} = ANY (ARRAY['roland'::text, 'valley'::text])))`;

async function assertCatalog(client, defFor, label) {
  const checks = await officeChecks(client);
  for (const [table, column] of migration.OFFICE_TABLES) {
    assert.equal(checks.get(table), defFor(column), `${label}: ${table}`);
  }
  assert.equal(checks.size, migration.OFFICE_TABLES.length, `${label}: no extra office_check constraints`);
}

// ── PART A ──────────────────────────────────────────────────────────────────

async function partA(client) {
  const results = [];
  const step = async (name, fn) => {
    await fn();
    results.push(name);
    console.log(`  ok  ${name}`);
  };

  await client.query('BEGIN');
  try {
    await step('catalog: zero CHECKs name roland/valley; all 70 office checks are the format check', async () => {
      assert.equal(await pairPinsLeft(client), 0);
      await assertCatalog(client, formatDef, 'after up');
    });

    await step('existing writes: hyg visitStore.openVisit still succeeds for roland and valley', async () => {
      const r = await visitStore.openVisit(client, { office: 'roland', aptNum: 990050001, patNum: 12827, visitDate: '2026-11-18', actor: ACTOR });
      const v = await visitStore.openVisit(client, { office: 'valley', aptNum: 990050002, patNum: 7115, visitDate: '2026-11-18', actor: ACTOR });
      assert.ok(r && r.visitId && v && v.visitId);
    });

    await step(`a new office key ('${NEW_OFFICE}') and 'unknown' insert into every representative table`, async () => {
      for (const table of Object.keys(INSERTS)) {
        for (const office of ['roland', 'valley', NEW_OFFICE, 'unknown']) await insert(client, table, office);
      }
    });

    await step('the format refuses garbage (23514) and NULL is still refused (23502)', async () => {
      for (const table of Object.keys(INSERTS)) {
        for (const bad of GARBAGE) await mustRefuse(client, PG_CHECK_VIOLATION, () => insert(client, table, bad));
        await mustRefuse(client, PG_NOT_NULL_VIOLATION, () => insert(client, table, null));
      }
    });
  } finally {
    await client.query('ROLLBACK');
  }
  return results;
}

// ── PART B ──────────────────────────────────────────────────────────────────

function runner() {
  const mod = require('node-pg-migrate');
  return typeof mod === 'function' ? mod : mod.default;
}

async function migrate(databaseUrl, direction) {
  await runner()({
    databaseUrl,
    dir: path.join(__dirname, '..', 'migrations-tenant'),
    migrationsTable: 'pgmigrations',
    direction,
    count: 1,
    singleTransaction: true,
    log: () => {},
  });
}

async function cleanup(client) {
  for (const [table, col] of Object.entries(NAME_COLUMN)) {
    await client.query(`DELETE FROM ${table} WHERE ${col} LIKE $1`, [`${MARK}%`]);
  }
}

async function partB(client, databaseUrl) {
  const newest = await client.query('SELECT name FROM pgmigrations ORDER BY run_on DESC, id DESC LIMIT 1');
  if (!newest.rows[0] || newest.rows[0].name !== SELF) {
    console.log(`  SKIP down/up: the newest applied migration is ${newest.rows[0] && newest.rows[0].name}, not ${SELF}`);
    return false;
  }
  for (const table of Object.keys(INSERTS)) {
    const n = (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    if (n > 0) {
      console.log(`  SKIP down/up: ${table} already holds rows; refusing to migrate this database down`);
      return false;
    }
  }

  try {
    // Committed rows for both real offices in every representative table, plus
    // one third-office row.
    for (const table of Object.keys(INSERTS)) {
      await insert(client, table, 'roland');
      await insert(client, table, 'valley');
    }
    await insert(client, 'tc_referral_directory', NEW_OFFICE);

    await assert.rejects(migrate(databaseUrl, 'down'), /hold an office other than roland\/valley/);
    await assertCatalog(client, formatDef, 'after a refused down');
    console.log(`  ok  down() with a '${NEW_OFFICE}' row present REFUSES, naming the table; the schema is untouched`);

    await client.query('DELETE FROM tc_referral_directory WHERE office_id = $1', [NEW_OFFICE]);
    await migrate(databaseUrl, 'down');
    await assertCatalog(client, originalDef, 'after down');
    for (const table of Object.keys(INSERTS)) {
      const r = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${NAME_COLUMN[table]} LIKE $1`, [`${MARK}%`]);
      assert.equal(r.rows[0].n, 2, `${table}: down() kept the roland and valley rows`);
      await assert.rejects(insert(client, table, NEW_OFFICE), (err) => err.code === PG_CHECK_VIOLATION, `${table}: pair re-pinned`);
    }
    console.log('  ok  down() with roland/valley rows: all 70 originals restored verbatim, rows kept, a third office refused');

    await migrate(databaseUrl, 'up');
    await assertCatalog(client, formatDef, 'after up again');
    for (const table of Object.keys(INSERTS)) {
      await insert(client, table, NEW_OFFICE);
      await assert.rejects(insert(client, table, 'Roland'), (err) => err.code === PG_CHECK_VIOLATION);
    }
    console.log(`  ok  up() again: '${NEW_OFFICE}' accepted, garbage still refused`);
    return true;
  } finally {
    await cleanup(client);
  }
}

async function main() {
  const databaseUrl = process.env.MIGRATE_TENANT_DB_URL;
  if (!databaseUrl) {
    console.error('MIGRATE_TENANT_DB_URL is required');
    process.exit(2);
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    console.log('Part A (one transaction, rolled back):');
    const a = await partA(client);
    console.log(`Part B (${SELF} down → up):`);
    const b = await partB(client, databaseUrl);
    console.log(`office format checks verification passed: ${a.length} part-A checks; down/up ${b ? 'verified' : 'SKIPPED'}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('office format checks verification FAILED:', err);
  process.exit(1);
});
