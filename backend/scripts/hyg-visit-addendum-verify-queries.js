#!/usr/bin/env node
'use strict';

/**
 * 1795200000000_hyg_visit_addendum, EXECUTED against a real migrated tenant
 * schema with synthetic data. The unit suites' databases are fakes, so they
 * cannot prove a CHECK, a trigger, a grant or a real down().
 *
 * PART A — one transaction, ALWAYS rolled back:
 *   - the store (visitStore.addAddendum → markAddendumSending → markAddendumWritten)
 *     adds an addendum and walks it to Written; getVisit reads it back on the visit
 *   - CHECKs refuse: a blank body, an unknown state, Written without a ref,
 *     Failed without a reason, a preview that is not an array of >= 3 lines,
 *     an office that fails the format check, a visit in another office (FK)
 *   - the write-once trigger refuses an UPDATE of body / author / preview, and
 *     any change to a Written row
 *   - as the app role: add + send transitions work, and DELETE is refused
 *     (insufficient_privilege) — append-only by the database
 *
 * PART B — this migration's REAL down() and up(), via node-pg-migrate:
 *   down() with a COMMITTED addendum present is REFUSED (nothing dropped);
 *   with none, down() removes the table and up() brings it back. RUNS ONLY
 *   when this migration is the newest applied one and the database holds no
 *   hyg_visit row it did not seed. Seeded rows are removed at the end.
 *
 * NO OPEN DENTAL. Every value is a synthetic literal; PatNum 12827 is the
 * roland test fixture.
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside the other verifiers):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/hyg-visit-addendum-verify-queries.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');

const visitStore = require('../services/hyg/visitStore');

const SELF = '1795200000000_hyg_visit_addendum';
const ACTOR = 'verify@fixture.invalid';
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
const APT = 990052001; // synthetic appointment number
const PAT = 12827; // roland test fixture
const PREVIEW = ['ADDENDUM to the hygiene visit note of 2026-11-19', 'Synthetic words', 'Entered in CareIN by verify. Unsigned.'];

const PG_CHECK_VIOLATION = '23514';
const PG_FK_VIOLATION = '23503';
const PG_INSUFFICIENT_PRIVILEGE = '42501';
const PG_RESTRICT_VIOLATION = '23001';

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

async function openSeedVisit(client) {
  const v = await visitStore.openVisit(client, { office: 'roland', aptNum: APT, patNum: PAT, visitDate: '2026-11-19', actor: ACTOR });
  assert.ok(v && v.visitId, 'a visit id');
  return v.visitId;
}

const rawAddendum = (client, visitId, over = {}) => {
  const row = { office: 'roland', body: 'Synthetic', author: ACTOR, preview: PREVIEW, state: 'Staged', ...over };
  return client.query(
    `INSERT INTO hyg_visit_addendum (visit_id, office, body, author, preview, state, written_ref, sent_by, sent_at, error_message)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10) RETURNING addendum_id`,
    [visitId, row.office, row.body, row.author, JSON.stringify(row.preview), row.state,
      row.written_ref ?? null, row.sent_by ?? null, row.sent_at ?? null, row.error_message ?? null]
  );
};

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

    await step('store: add → Sending → Written, and the visit reads it back', async () => {
      const a = await visitStore.addAddendum(client, { office: 'roland', visitId, text: 'Synthetic words', author: ACTOR, preview: PREVIEW });
      assert.equal(a.state, 'Staged');
      assert.ok(await visitStore.markAddendumSending(client, { office: 'roland', visitId, addendumId: a.id }));
      assert.equal(await visitStore.markAddendumSending(client, { office: 'roland', visitId, addendumId: a.id }), false, 'claimed once');
      await visitStore.markAddendumWritten(client, { office: 'roland', visitId, addendumId: a.id, actor: ACTOR, writtenRef: 'GroupNote 1 (addendum)' });
      const v = await visitStore.getVisit(client, { office: 'roland', aptNum: APT });
      assert.equal(v.addenda.length, 1);
      assert.equal(v.addenda[0].state, 'Written');
      assert.equal(v.addenda[0].sentBy, ACTOR);
      assert.deepEqual(v.addenda[0].preview, PREVIEW);
      // Another office cannot see it.
      assert.equal(await visitStore.getAddendum(client, { office: 'valley', visitId, addendumId: a.id }), null);
    });

    await step('CHECKs: blank body, unknown state, half-Written, reasonless Failed, bad preview, bad office', async () => {
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawAddendum(client, visitId, { body: '   ' }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawAddendum(client, visitId, { body: 'x'.repeat(4001) }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawAddendum(client, visitId, { state: 'Draft' }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawAddendum(client, visitId, { state: 'Written' }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawAddendum(client, visitId, { state: 'Failed' }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawAddendum(client, visitId, { error_message: 'x' }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawAddendum(client, visitId, { preview: ['one', 'two'] }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawAddendum(client, visitId, { preview: { not: 'an array' } }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawAddendum(client, visitId, { office: 'Roland!' }));
      await mustRefuse(client, PG_FK_VIOLATION, () => rawAddendum(client, visitId, { office: 'valley' }));
    });

    await step('trigger: what an addendum says is write-once, and Written is final', async () => {
      const { rows } = await rawAddendum(client, visitId);
      const id = rows[0].addendum_id;
      for (const set of ["body = 'changed'", "author = 'someone@else.invalid'", `preview = '${JSON.stringify([...PREVIEW, 'more'])}'::jsonb`]) {
        await mustRefuse(client, PG_CHECK_VIOLATION, () => client.query(`UPDATE hyg_visit_addendum SET ${set} WHERE addendum_id = $1`, [id]));
      }
      await client.query(
        "UPDATE hyg_visit_addendum SET state = 'Written', written_ref = 'r', sent_by = $2, sent_at = now() WHERE addendum_id = $1",
        [id, ACTOR]
      );
      await mustRefuse(client, PG_CHECK_VIOLATION, () =>
        client.query("UPDATE hyg_visit_addendum SET state = 'Failed', error_message = 'x', written_ref = NULL, sent_by = NULL, sent_at = NULL WHERE addendum_id = $1", [id])
      );
    });

    if (await roleExists(client)) {
      await step(`${APP_ROLE}: add + send transitions work; DELETE is refused`, async () => {
        await client.query('SAVEPOINT as_app');
        await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
        const a = await visitStore.addAddendum(client, { office: 'roland', visitId, text: 'As the app', author: ACTOR, preview: PREVIEW });
        assert.ok(await visitStore.markAddendumSending(client, { office: 'roland', visitId, addendumId: a.id }));
        await visitStore.markAddendumFailed(client, { office: 'roland', visitId, addendumId: a.id, error: 'synthetic' });
        await mustRefuse(client, PG_INSUFFICIENT_PRIVILEGE, () =>
          client.query('DELETE FROM hyg_visit_addendum WHERE addendum_id = $1', [a.id])
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
  return (await client.query("SELECT to_regclass('public.hyg_visit_addendum') IS NOT NULL AS t")).rows[0].t;
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

  let addendumId = null;
  try {
    const visitId = await openSeedVisit(client);
    const a = await visitStore.addAddendum(client, { office: 'roland', visitId, text: 'Committed', author: ACTOR, preview: PREVIEW });
    addendumId = a.id;

    await assert.rejects(migrate(databaseUrl, 'down'), (err) => {
      const code = err && (err.code || (err.cause && err.cause.code));
      return code === PG_RESTRICT_VIOLATION || /holds addenda/.test(String(err && err.message));
    }, 'down() refuses while an addendum exists');
    assert.equal(await tableExists(client), true, 'nothing was dropped');
    assert.ok(await visitStore.getAddendum(client, { office: 'roland', visitId, addendumId }), 'the addendum is intact');
    console.log('  ok  down() with an addendum present: REFUSED, table and row intact');

    // The only way a row leaves: by hand, as the owner (the app role cannot).
    await client.query('DELETE FROM hyg_visit_addendum WHERE addendum_id = $1', [addendumId]);
    addendumId = null;
    await migrate(databaseUrl, 'down');
    assert.equal(await tableExists(client), false);
    console.log('  ok  down() on an empty table: removed');
    await migrate(databaseUrl, 'up');
    assert.equal(await tableExists(client), true);
    await rawAddendum(client, visitId);
    console.log('  ok  up() again: the table is back and takes an addendum');
    return true;
  } finally {
    if (await tableExists(client)) {
      await client.query(
        'DELETE FROM hyg_visit_addendum WHERE office = $1 AND visit_id IN (SELECT visit_id FROM hyg_visit WHERE office = $1 AND apt_num = $2)',
        ['roland', APT]
      );
    }
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
    console.log(`hyg visit addendum verification passed: ${a.length} part-A checks; down/up ${b ? 'verified' : 'SKIPPED'}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('hyg visit addendum verification FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
