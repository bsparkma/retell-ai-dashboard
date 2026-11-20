#!/usr/bin/env node
'use strict';

/**
 * 1795400000000_tc_email_library_profile, EXECUTED against a real migrated
 * tenant schema. The unit suites' database is a fake, so it cannot prove a
 * CHECK, a grant, jsonb's round trip or a real down().
 *
 * PART A — one transaction, ALWAYS rolled back:
 *   - the store (profileStore.upsertProfile → readProfile) saves an office's
 *     answers and reads back what was validated (jsonb reorders keys;
 *     sameAnswers is key-order-insensitive), and a second save REPLACES it
 *   - each office has its own row; a read for another office sees nothing
 *   - CHECKs refuse: an office that fails the format check, answers that carry
 *     office_name or office_phone, answers that are not an object, a blank
 *     library_version or updated_by
 *   - as the app role: select / insert / update work, DELETE is refused
 *     (insufficient_privilege)
 *
 * PART B — this migration's REAL down() and up(), via node-pg-migrate. RUNS ONLY
 * when this migration is the newest applied one and the table holds no row it
 * did not seed (so it never drops anything real).
 *
 * No Open Dental, no messaging, no patient data. Every value is synthetic.
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside the other verifiers):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/tc-email-library-verify-queries.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');

const profileStore = require('../services/tcEmailLibrary/profileStore');
const contract = require('../tc/contract.gen.cjs');

const SELF = '1795400000000_tc_email_library_profile';
const ACTOR = 'verify@fixture.invalid';
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
const VERSION = '1.1.0';

const PG_CHECK_VIOLATION = '23514';
const PG_INSUFFICIENT_PRIVILEGE = '42501';

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

const rawInsert = (client, office, answersJson, version = VERSION, by = ACTOR) =>
  client.query(
    'INSERT INTO tc_email_library_profile (office_id, answers, library_version, updated_by) VALUES ($1, $2::jsonb, $3, $4)',
    [office, answersJson, version, by]
  );

/** A validated answers object, as the route would store it. */
function validated(raw) {
  const v = contract.validateEmailLibraryAnswers(raw);
  assert.ok(v.ok, `fixture answers validate: ${JSON.stringify(v)}`);
  return v.answers;
}

async function partA(client) {
  const results = [];
  const step = async (name, fn) => {
    await fn();
    results.push(name);
    console.log(`  ok  ${name}`);
  };

  await client.query('BEGIN');
  try {
    // A key order jsonb will NOT keep (it sorts by length, then bytes).
    const first = validated({
      services_off: ['braces'],
      schedule_link: 'https://book.example.test/sample',
      cbct: true,
      sedation: ['nitrous', 'iv'],
      doctor_name: 'Dr. Sample',
      cancel_hours: '24',
    });

    await step('store: upsert then read back what was validated (key order aside)', async () => {
      await profileStore.upsertProfile(client, { office: 'roland', answers: first, libraryVersion: VERSION, updatedBy: ACTOR });
      const back = await profileStore.readProfile(client, 'roland');
      assert.ok(back, 'a row');
      assert.equal(typeof back.answers, 'object', 'jsonb comes back as an object');
      assert.ok(profileStore.sameAnswers(back.answers, first));
      assert.equal(back.libraryVersion, VERSION);
      assert.equal(back.updatedBy, ACTOR);
      assert.ok(back.updatedAt instanceof Date);
    });

    await step('store: a second save replaces the whole object', async () => {
      const second = validated({ laser: true });
      await profileStore.upsertProfile(client, { office: 'roland', answers: second, libraryVersion: VERSION, updatedBy: 'second@fixture.invalid' });
      const back = await profileStore.readProfile(client, 'roland');
      assert.deepEqual(back.answers, { laser: true });
      assert.equal(back.updatedBy, 'second@fixture.invalid');
      const n = await client.query("SELECT count(*)::int AS n FROM tc_email_library_profile WHERE office_id = 'roland'");
      assert.equal(n.rows[0].n, 1, 'one row per office');
    });

    await step('store: offices are separate rows; a new office key is accepted by the format check', async () => {
      assert.equal(await profileStore.readProfile(client, 'verifyoffice'), null);
      await profileStore.upsertProfile(client, { office: 'verifyoffice', answers: {}, libraryVersion: VERSION, updatedBy: ACTOR });
      assert.deepEqual((await profileStore.readProfile(client, 'verifyoffice')).answers, {});
      assert.deepEqual((await profileStore.readProfile(client, 'roland')).answers, { laser: true }, 'roland untouched');
    });

    await step('CHECKs refuse a bad office, office fields, a non-object, blank version / actor', async () => {
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawInsert(client, 'Roland', '{}'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawInsert(client, 'x', '{}'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawInsert(client, 'checkoffice', '{"office_name":"Sample Dental"}'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawInsert(client, 'checkoffice', '{"office_phone":"(555) 555-0100"}'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawInsert(client, 'checkoffice', '["cbct"]'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawInsert(client, 'checkoffice', '"text"'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawInsert(client, 'checkoffice', '{}', '  '));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawInsert(client, 'checkoffice', '{}', VERSION, ' '));
    });

    const roleRow = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (roleRow.rows.length > 0) {
      await step(`${APP_ROLE}: select / insert / update work; DELETE is refused`, async () => {
        await client.query('SAVEPOINT as_app');
        await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
        await profileStore.upsertProfile(client, { office: 'approle', answers: { cbct: true }, libraryVersion: VERSION, updatedBy: ACTOR });
        await profileStore.upsertProfile(client, { office: 'approle', answers: { cbct: false }, libraryVersion: VERSION, updatedBy: ACTOR });
        assert.deepEqual((await profileStore.readProfile(client, 'approle')).answers, { cbct: false });
        await mustRefuse(client, PG_INSUFFICIENT_PRIVILEGE, () =>
          client.query("DELETE FROM tc_email_library_profile WHERE office_id = 'approle'")
        );
        await client.query('ROLLBACK TO SAVEPOINT as_app');
      });
    } else {
      console.log(`  SKIP app-role grant: role ${APP_ROLE} absent`);
    }
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

async function tableExists(client) {
  const r = await client.query("SELECT to_regclass('public.tc_email_library_profile') IS NOT NULL AS present");
  return r.rows[0].present;
}

async function partB(client, databaseUrl) {
  const newest = await client.query('SELECT name FROM pgmigrations ORDER BY run_on DESC, id DESC LIMIT 1');
  if (!newest.rows[0] || newest.rows[0].name !== SELF) {
    console.log(`  SKIP down/up: the newest applied migration is ${newest.rows[0] && newest.rows[0].name}, not ${SELF}`);
    return false;
  }
  const rows = await client.query('SELECT count(*)::int AS n FROM tc_email_library_profile');
  if (rows.rows[0].n > 0) {
    console.log('  SKIP down/up: this database already holds email library profiles; refusing to migrate it down');
    return false;
  }
  await migrate(databaseUrl, 'down');
  assert.equal(await tableExists(client), false, 'down() removed the table');
  console.log('  ok  down(): the table is gone');
  await migrate(databaseUrl, 'up');
  assert.equal(await tableExists(client), true, 'up() brought it back');
  const grants = await client.query(
    "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'tc_email_library_profile' AND grantee = $1 ORDER BY privilege_type",
    [APP_ROLE]
  );
  const roleRow = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
  if (roleRow.rows.length > 0) {
    assert.deepEqual(grants.rows.map((r) => r.privilege_type), ['INSERT', 'SELECT', 'UPDATE'], 'exactly SELECT, INSERT, UPDATE');
  }
  console.log('  ok  up() again: the table is back with SELECT, INSERT, UPDATE for the app role');
  return true;
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
    console.log(`tc email library verification passed: ${a.length} part-A checks; down/up ${b ? 'verified' : 'SKIPPED'}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('tc email library verification FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
