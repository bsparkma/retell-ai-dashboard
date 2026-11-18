#!/usr/bin/env node
'use strict';

/**
 * 1794800000000_hyg_priority_holding, EXECUTED against a real migrated tenant
 * schema with synthetic data. The unit suites' databases are fakes, so they
 * cannot prove a CHECK or a real down().
 *
 * PART A — one transaction, ALWAYS rolled back:
 *   - the store (services/hyg/visitStore.js addItem / updateItem) saves a
 *     'holding' item and reads it back as 'holding'; an item patched from
 *     preventative to holding reads back as holding
 *   - the CHECK still refuses an unknown priority, and a CATEGORY word in the
 *     priority column ('Cosmetic')
 *   - as the app role: the holding save works (hyg_treatment_item's existing
 *     grant)
 *
 * PART B — this migration's REAL down() and up(), via node-pg-migrate, with a
 *   COMMITTED 'holding' item present: down() rewrites it to 'cosmetic' (it
 *   does not fail on the restored CHECK, the #278 class of bug) and the
 *   restored CHECK refuses 'holding'; up() accepts 'holding' again. RUNS ONLY
 *   when this migration is the newest applied one and the database holds no
 *   hyg_visit row it did not seed — it never rolls back somebody else's
 *   migration or touches real data. Seeded rows are deleted at the end, pass
 *   or fail.
 *
 * NO OPEN DENTAL. Every value is a synthetic literal; PatNum 12827 is the
 * roland test fixture.
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside the other verifiers):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/hyg-priority-holding-verify-queries.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');

const visitStore = require('../services/hyg/visitStore');

const SELF = '1794800000000_hyg_priority_holding';
const ACTOR = 'verify@fixture.invalid';
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
const APT = 990048001; // synthetic appointment number
const PAT = 12827; // roland test fixture

const PG_CHECK_VIOLATION = '23514';

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

async function roleExists(client) {
  return (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE])).rows.length > 0;
}

/** A treatment item as the route's schema takes it. */
function input(priority, code = 'Bridge') {
  return {
    teeth: [30],
    code,
    category: 'Prosth',
    surfaces: [],
    dx: [],
    priority,
    motivation: [],
    status: 'proposed',
    scheduleNext: false,
    photos: [],
  };
}

const rawItem = (client, visitId, priority, category = 'Prosth') =>
  client.query(
    `INSERT INTO hyg_treatment_item (visit_id, office, teeth, whole_mouth, code, category, priority, status, created_by)
     VALUES ($1, 'roland', '[30]'::jsonb, false, 'Bridge', $2, $3, 'proposed', $4)`,
    [visitId, category, priority, ACTOR]
  );

async function openSeedVisit(client) {
  const v = await visitStore.openVisit(client, { office: 'roland', aptNum: APT, patNum: PAT, visitDate: '2026-11-16', actor: ACTOR });
  assert.ok(v && v.visitId, 'a visit id');
  return v.visitId;
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
    const visitId = await openSeedVisit(client);

    await step("store: a 'holding' item saves and reads back as 'holding'; a patch to holding sticks", async () => {
      const saved = await visitStore.addItem(client, { office: 'roland', visitId, input: input('holding'), actor: ACTOR });
      assert.equal(saved.priority, 'holding');
      const other = await visitStore.addItem(client, { office: 'roland', visitId, input: input('preventative', 'Implant'), actor: ACTOR });
      const patched = await visitStore.updateItem(client, {
        office: 'roland', visitId, itemId: other.id, patch: { priority: 'holding' }, actor: ACTOR,
      });
      assert.equal(patched.priority, 'holding');
      const rows = await client.query(
        'SELECT priority FROM hyg_treatment_item WHERE visit_id = $1 AND office = $2 ORDER BY item_order',
        [visitId, 'roland']
      );
      assert.deepEqual(rows.rows.map((r) => r.priority), ['holding', 'holding']);
    });

    await step('CHECK: still refuses an unknown priority and a category word in the priority column', async () => {
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawItem(client, visitId, 'someday'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawItem(client, visitId, 'Holding'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawItem(client, visitId, 'Cosmetic'));
      for (const p of ['urgent', 'preventative', 'cosmetic', 'holding']) await rawItem(client, visitId, p);
    });

    if (await roleExists(client)) {
      await step(`${APP_ROLE}: the holding save works`, async () => {
        await client.query('SAVEPOINT as_app');
        await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
        const saved = await visitStore.addItem(client, { office: 'roland', visitId, input: input('holding'), actor: ACTOR });
        assert.equal(saved.priority, 'holding');
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

async function seededPriorities(client) {
  const r = await client.query(
    `SELECT i.priority FROM hyg_treatment_item i JOIN hyg_visit v ON v.visit_id = i.visit_id AND v.office = i.office
      WHERE v.office = $1 AND v.apt_num = $2 ORDER BY i.item_order`,
    ['roland', APT]
  );
  return r.rows.map((x) => x.priority);
}

async function partB(client, databaseUrl) {
  const newest = await client.query('SELECT name FROM pgmigrations ORDER BY run_on DESC, id DESC LIMIT 1');
  if (!newest.rows[0] || newest.rows[0].name !== SELF) {
    console.log(`  SKIP down/up: the newest applied migration is ${newest.rows[0] && newest.rows[0].name}, not ${SELF}`);
    return false;
  }
  const visits = await client.query('SELECT count(*)::int AS n FROM hyg_visit');
  if (visits.rows[0].n > 0) {
    console.log('  SKIP down/up: this database already holds hygiene visits; refusing to migrate it down');
    return false;
  }

  try {
    const visitId = await openSeedVisit(client);
    await visitStore.addItem(client, { office: 'roland', visitId, input: input('urgent', 'Implant'), actor: ACTOR });
    await visitStore.addItem(client, { office: 'roland', visitId, input: input('holding'), actor: ACTOR });
    assert.deepEqual(await seededPriorities(client), ['urgent', 'holding']);

    await migrate(databaseUrl, 'down');
    assert.deepEqual(
      await seededPriorities(client),
      ['urgent', 'cosmetic'],
      "down() rewrote the holding row to 'cosmetic' and left the urgent one alone"
    );
    await assert.rejects(rawItem(client, visitId, 'holding'), (err) => err.code === PG_CHECK_VIOLATION, 'restored CHECK refuses holding');
    console.log("  ok  down() with a 'holding' row present: the row became 'cosmetic', the 3-value CHECK is back");

    await migrate(databaseUrl, 'up');
    await rawItem(client, visitId, 'holding');
    await assert.rejects(rawItem(client, visitId, 'someday'), (err) => err.code === PG_CHECK_VIOLATION);
    console.log("  ok  up() again: 'holding' is accepted, an unknown value still refused");
    return true;
  } finally {
    // Items go with the visit (ON DELETE CASCADE).
    await client.query('DELETE FROM hyg_visit WHERE office = $1 AND apt_num = $2', ['roland', APT]);
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
    console.log(`hyg priority holding verification passed: ${a.length} part-A checks; down/up ${b ? 'verified' : 'SKIPPED'}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('hyg priority holding verification FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
