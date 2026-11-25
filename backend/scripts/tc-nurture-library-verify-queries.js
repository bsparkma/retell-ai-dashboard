#!/usr/bin/env node
'use strict';

/**
 * 1795500000000_tc_nurture_library (EL-2), EXECUTED against a real migrated
 * tenant schema. The unit suites' database is a fake that accepts any column a
 * fixture seeds, so it cannot prove a CHECK or the generator's INSERT (the
 * #342/#343 lesson: a statement is only proven by the real schema).
 *
 * PART A — one transaction, ALWAYS rolled back:
 *   - the store's real INSERT (store.insertEnrollment) accepts a row with
 *     procedure + variant, and store.loadEnrollment → toEnrollment reads both
 *     back through the contract
 *   - rows WITHOUT the library columns are unaffected: the item-47 insert shape
 *     still works, and reads back as libraryProcedureId/libraryVariant null
 *   - the CHECK refuses: a procedure without a variant (the NULL hole the brief's
 *     literal had), a variant without a procedure, and a variant 'D'
 *   - THE GENERATOR, for real: one pass over a due library enrollment, inside
 *     the same rolled-back transaction (its BEGIN/COMMIT become a savepoint),
 *     writes (EL-2c) EVERY remaining step as a tc_messages draft with the
 *     library template_id, the stage as touch_key, a preheader, jsonb
 *     email_blocks and a planned time, and advances the row to the end; a
 *     second pass writes nothing; the office's saved answers are read from the
 *     real tc_email_library_profile
 *   - as the app role: the same insert and the generator's UPDATE work
 *
 * PART B — this migration's REAL down() and up(), via node-pg-migrate. RUNS ONLY
 * when this migration is the newest applied one and no enrollment carries a
 * library procedure (so it never strips anything real).
 *
 * No Open Dental, no messaging send, no AI. Every value is synthetic; the case
 * is the designated roland test patient (Test 2, Stedi — PatNum 12827).
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside the other verifiers):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/tc-nurture-library-verify-queries.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

// The office phone the library's merge needs: the carein env fallback
// (config/acsEmail practiceDetailsFor). Set before anything reads config.
process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND || '(918) 555-0100';

const store = require('../services/tcNurture/store');
const generator = require('../services/tcNurture/generator');
const profileStore = require('../services/tcEmailLibrary/profileStore');
const library = require('../services/tcEmailLibrary');

const SELF = '1795500000000_tc_nurture_library';
const OFFICE = 'roland';
const ACTOR = 'verify@fixture.invalid';
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();

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

async function insertCase(client, over = {}) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO tc_cases (case_id, office_id, patient_name, email, category, status, urgency, od_patient_id, assigned_tc)
     VALUES ($1, $2, 'Test 2, Stedi', 'stedi.test2@example.com', 'single_tooth', $3, 'medium', 12827, $4)`,
    [id, OFFICE, over.status || 'nurture', over.assignedTc ?? 'Test Coordinator']
  );
  return id;
}

function enrollmentRow(caseId, over = {}) {
  return {
    enrollment_id: randomUUID(),
    case_id: caseId,
    office_id: OFFICE,
    track_key: 'warm_followup',
    intensity_at_enroll: 'standard',
    status: 'active',
    next_touch_index: 0,
    next_touch_due_at: '2026-10-14T05:00:00.000Z',
    created_by: ACTOR,
    created_at: '2026-10-13T15:00:00.000Z',
    ...over,
  };
}

/** A raw insert of just the library columns, for the CHECK probes. */
const rawLibraryInsert = (client, caseId, procedure, variant) =>
  client.query(
    `INSERT INTO tc_nurture_enrollments (enrollment_id, case_id, office_id, track_key, intensity_at_enroll, status,
       next_touch_index, created_by, library_procedure_id, library_variant)
     VALUES ($1, $2, $3, 'warm_followup', 'standard', 'completed', 0, $4, $5, $6)`,
    [randomUUID(), caseId, OFFICE, ACTOR, procedure, variant]
  );

/**
 * A pool over ONE client already inside a transaction: the generator's own
 * BEGIN / COMMIT / ROLLBACK become a savepoint, so its pass is real SQL that
 * the outer ROLLBACK still undoes.
 */
function savepointPool(client) {
  const map = { BEGIN: 'SAVEPOINT gen_tx', COMMIT: 'RELEASE SAVEPOINT gen_tx', ROLLBACK: 'ROLLBACK TO SAVEPOINT gen_tx' };
  const q = (sql, params) => client.query(map[String(sql).trim()] || sql, params);
  return {
    query: q,
    connect: async () => ({ query: q, release: () => {} }),
  };
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
    // Leave other enrollments of the office out of the generator's pass: this
    // verifier's rows are the only ones due at its fixed instant's past.
    const caseId = await insertCase(client);

    await step('store: insert with procedure + variant; read back through the contract', async () => {
      const row = enrollmentRow(caseId, { status: 'completed', library_procedure_id: 'crown', library_variant: 'A' });
      await store.insertEnrollment(client, row);
      const back = await store.loadEnrollment(client, OFFICE, row.enrollment_id);
      assert.equal(back.library_procedure_id, 'crown');
      assert.equal(back.library_variant, 'A');
      const e = store.toEnrollment(back, 0);
      assert.equal(e.libraryProcedureId, 'crown');
      assert.equal(e.libraryVariant, 'A');
    });

    await step('store: a row without library columns is unaffected (item-47 shape), reads back null', async () => {
      const row = enrollmentRow(caseId, { status: 'completed' });
      await store.insertEnrollment(client, row);
      const back = await store.loadEnrollment(client, OFFICE, row.enrollment_id);
      assert.equal(back.library_procedure_id, null);
      assert.equal(back.library_variant, null);
      const e = store.toEnrollment(back, 0);
      assert.equal(e.libraryProcedureId, null);
      assert.equal(e.nextTouchKey, null, 'completed');
      // The item-47 column list, exactly as it was, still inserts.
      await client.query(
        `INSERT INTO tc_nurture_enrollments (enrollment_id, case_id, office_id, track_key, intensity_at_enroll,
           status, stop_reason, next_touch_index, next_touch_due_at, last_touch_at, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'no_show_recovery', 'gentle', 'stopped', 'verify', 0, NULL, NULL, $4, now(), now())`,
        [randomUUID(), caseId, OFFICE, ACTOR]
      );
    });

    await step('CHECK refuses: procedure without variant, variant without procedure, variant D', async () => {
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawLibraryInsert(client, caseId, 'crown', null));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawLibraryInsert(client, caseId, null, 'A'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawLibraryInsert(client, caseId, 'crown', 'D'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawLibraryInsert(client, caseId, 'crown', 'a'));
      for (const v of ['A', 'B', 'C']) await rawLibraryInsert(client, caseId, 'implant', v);
      await rawLibraryInsert(client, caseId, null, null);
    });

    // EL-2c: a library enrollment with steps left (this #359-era shape) gets ALL
    // of them written in one pass, each with a planned time; then nothing more.
    await step('generator: one real pass writes EVERY step of a #359-era library enrollment; a second pass writes nothing', async () => {
      await profileStore.upsertProfile(client, {
        office: OFFICE,
        answers: { same_day_crowns: true, same_day_length: 'about two hours' },
        libraryVersion: library.LIBRARY_VERSION,
        updatedBy: ACTOR,
      });
      const genCase = await insertCase(client);
      const row = enrollmentRow(genCase, { library_procedure_id: 'crown', library_variant: 'B' });
      await store.insertEnrollment(client, row);
      // Only this verifier's row may be due at the pass's instant.
      const now = new Date('2026-10-14T10:00:00.000Z');
      const others = await client.query(
        `SELECT count(*)::int AS n FROM tc_nurture_enrollments
          WHERE office_id = $1 AND status = 'active' AND next_touch_due_at <= $2 AND enrollment_id <> $3`,
        [OFFICE, now.toISOString(), row.enrollment_id]
      );
      assert.equal(others.rows[0].n, 0, 'no other due enrollment in this database (a verifier must not draft for a real one)');

      const pool = savepointPool(client);
      const out = await generator.runForOffice({ pool, tenantSlug: 'carein', office: OFFICE, now, tz: 'America/Chicago' });
      assert.equal(out.queued, 1, JSON.stringify(out));
      assert.equal(out.errors, 0, JSON.stringify(out));
      const drafts = await client.query(
        `SELECT channel, status, template_id, touch_key, subject, email_preheader, email_blocks, body, created_by, scheduled_for
           FROM tc_messages WHERE office_id = $1 AND enrollment_id = $2 ORDER BY scheduled_for`,
        [OFFICE, row.enrollment_id]
      );
      assert.equal(drafts.rows.length, 10, 'every warm_followup step');
      assert.ok(drafts.rows.every((x) => x.status === 'draft' && x.scheduled_for instanceof Date), 'each with a planned time');
      const m = drafts.rows[0];
      assert.equal(m.status, 'draft');
      assert.equal(m.channel, 'email');
      assert.equal(m.template_id, 'library.crown.tp_recap.B');
      assert.equal(m.touch_key, 'tp_recap');
      assert.ok(m.email_preheader && m.email_preheader.length > 0, 'preheader stored');
      assert.ok(Array.isArray(m.email_blocks) && m.email_blocks.every((b) => b.type === 'text'), 'jsonb text blocks');
      assert.ok(!/\{\{/.test(m.subject + m.email_preheader + m.body), 'no unresolved merge field');
      assert.equal(m.created_by, 'system:nurture');
      const advanced = await store.loadEnrollment(client, OFFICE, row.enrollment_id);
      assert.equal(Number(advanced.next_touch_index), 10);
      assert.equal(advanced.status, 'active', 'running until its last email is sent or skipped');

      const again = await generator.runForOffice({ pool, tenantSlug: 'carein', office: OFFICE, now, tz: 'America/Chicago' });
      assert.equal(again.due, 0);
      const n = await client.query('SELECT count(*)::int AS n FROM tc_messages WHERE enrollment_id = $1', [row.enrollment_id]);
      assert.equal(n.rows[0].n, 10, 'still ten drafts');
    });

    const roleRow = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (roleRow.rows.length > 0) {
      await step(`${APP_ROLE}: inserts a library enrollment and claims it (no new grants needed)`, async () => {
        await client.query('SAVEPOINT as_app');
        await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
        const row = enrollmentRow(caseId, { library_procedure_id: 'implant', library_variant: 'C', next_touch_due_at: null });
        await store.insertEnrollment(client, row);
        const claimed = await store.advance(client, OFFICE, row.enrollment_id, {
          expectIndex: 0,
          nextIndex: 1,
          lastTouchAt: new Date().toISOString(),
          nextTouchDueAt: null,
          status: 'active',
        });
        assert.ok(claimed, 'the claim UPDATE works as the app role');
        assert.equal(claimed.library_procedure_id, 'implant');
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

async function libraryColumns(client) {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'tc_nurture_enrollments' AND column_name IN ('library_procedure_id', 'library_variant')
      ORDER BY column_name`
  );
  return r.rows.map((x) => x.column_name);
}

async function partB(client, databaseUrl) {
  const newest = await client.query('SELECT name FROM pgmigrations ORDER BY run_on DESC, id DESC LIMIT 1');
  if (!newest.rows[0] || newest.rows[0].name !== SELF) {
    console.log(`  SKIP down/up: the newest applied migration is ${newest.rows[0] && newest.rows[0].name}, not ${SELF}`);
    return false;
  }
  const rows = await client.query('SELECT count(*)::int AS n FROM tc_nurture_enrollments WHERE library_procedure_id IS NOT NULL');
  if (rows.rows[0].n > 0) {
    console.log('  SKIP down/up: this database already holds library enrollments; refusing to migrate it down');
    return false;
  }
  await migrate(databaseUrl, 'down');
  assert.deepEqual(await libraryColumns(client), [], 'down() removed both columns');
  console.log('  ok  down(): both columns (and the CHECK) are gone');
  await migrate(databaseUrl, 'up');
  assert.deepEqual(await libraryColumns(client), ['library_procedure_id', 'library_variant'], 'up() brought them back');
  const check = await client.query(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'tc_nurture_enrollments_library_check'"
  );
  assert.equal(check.rows.length, 1, 'the CHECK is back');
  assert.match(check.rows[0].def, /library_variant IS NOT NULL/);
  console.log('  ok  up() again: both columns and the CHECK are back');
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
    console.log(`tc nurture library verification passed: ${a.length} part-A checks; down/up ${b ? 'verified' : 'SKIPPED'}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('tc nurture library verification FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
