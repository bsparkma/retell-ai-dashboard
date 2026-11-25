#!/usr/bin/env node
'use strict';

/**
 * 1795600000000_tc_messages_scheduled (EL-2c, approve up front), EXECUTED
 * against a real migrated tenant schema. The unit suites' database is a fake
 * that accepts any column a fixture seeds, so it proves nothing about a CHECK
 * or an INSERT; this does.
 *
 * PART A — one transaction, ALWAYS rolled back:
 *   - the scheduled CHECK refuses a 'scheduled' row missing approved_by,
 *     approved_at, scheduled_for or enrollment_id (each inserted on its own —
 *     a CHECK that evaluates to NULL would PASS, so every hole is probed);
 *     the complete row is accepted
 *   - the skip_reason CHECK refuses an unknown reason, and any reason on a
 *     row that is not skipped; the status CHECK refuses an unknown status
 *   - THE REAL ROUTES, on the real schema (the assembled /api/tc stack, its
 *     database the rolled-back transaction; every BEGIN/COMMIT a savepoint):
 *       POST /nurture/enrollments writes the enrollment AND every step as a
 *       draft with scheduled_for, in one transaction; a render failure writes
 *       nothing; approve / unapprove / approve-all / reschedule / stop each
 *       write rows the CHECKs accept; sendMessage is replaced with a thrower
 *       for the whole run (NOTHING SENDS). The routes' clocks are PINNED
 *       to Sat 12:00 office time (outside the send window), never the wall
 *       clock, and the planned times are checked against the sequence-gap
 *       rule (no gap shorter than the sequence's, in local days)
 *   - as the app role: the approve UPDATE and the stop's cancel UPDATE work
 *     (no new grants needed)
 *
 * PART B — this migration's REAL down() and up(), via node-pg-migrate. RUNS
 * ONLY when this migration is the newest applied one and no row is
 * 'scheduled' (so it never moves anything real).
 *
 * No Open Dental, no send, no AI. Every value is synthetic; the case is the
 * designated roland test patient (Test 2, Stedi — PatNum 12827).
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside the other verifiers):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/tc-nurture-approve-verify-queries.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

// The office phone the library's merge needs: the carein env fallback.
process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND || '(918) 555-0100';

const messaging = require('../services/messaging');
const adapters = require('../services/messaging/adapters');
const library = require('../services/tcEmailLibrary');
const engine = require('../services/tcNurture/engine');
const registry = require('../platform/registry');
const { bootTcApp, api } = require('../routes/tc/tcTestUtils');
const nurtureRoute = require('../routes/tc/nurture');

const SELF = '1795600000000_tc_messages_scheduled';
const OFFICE = 'roland';
const ACTOR = 'tc@carein.ai'; // bootTcApp's synthetic signed-in user
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
const TZ = 'America/Chicago';
const PG_CHECK_VIOLATION = '23514';
/** The clock the routes read for the whole run: Sat 2026-12-05 12:00 CST, OUTSIDE the send window. */
const VERIFY_NOW = new Date('2026-12-05T18:00:00.000Z');

/** Run `fn` inside a savepoint and require Postgres to refuse it with `code`. */
async function mustRefuse(client, code, fn, what) {
  await client.query('SAVEPOINT must_refuse');
  try {
    await fn();
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT must_refuse');
    if (err.code !== code) throw new Error(`${what}: refused, but with ${err.code} (wanted ${code}): ${err.message}`);
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT must_refuse');
  throw new Error(`${what}: the schema ACCEPTED a write it must refuse`);
}

async function insertCase(client, over = {}) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO tc_cases (case_id, office_id, patient_name, email, category, status, urgency, od_patient_id, assigned_tc)
     VALUES ($1, $2, 'Test 2, Stedi', $3, 'single_tooth', $4, 'medium', 12827, 'Test Coordinator')`,
    [id, OFFICE, over.email || 'stedi.test2@example.com', over.status || 'presented']
  );
  return id;
}

async function insertEnrollment(client, caseId) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO tc_nurture_enrollments (enrollment_id, case_id, office_id, track_key, intensity_at_enroll, status,
       next_touch_index, created_by, library_procedure_id, library_variant)
     VALUES ($1, $2, $3, 'reactivation', 'standard', 'completed', 5, $4, 'crown', 'A')`,
    [id, caseId, OFFICE, ACTOR]
  );
  return id;
}

/** A raw tc_messages insert for the CHECK probes. */
const rawMessage = (client, fields) => {
  const row = {
    message_id: randomUUID(),
    office_id: OFFICE,
    direction: 'outbound',
    channel: 'email',
    body: 'Synthetic',
    status: 'draft',
    ...fields,
  };
  const cols = Object.keys(row);
  return client.query(
    `INSERT INTO tc_messages (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => row[c])
  );
};

/**
 * A pool over ONE client already inside a transaction: every BEGIN / COMMIT /
 * ROLLBACK the routes and services issue becomes a savepoint, so their SQL is
 * real and the outer ROLLBACK still undoes it.
 */
function savepointPool(client) {
  const map = { BEGIN: 'SAVEPOINT el2c_tx', COMMIT: 'RELEASE SAVEPOINT el2c_tx', ROLLBACK: 'ROLLBACK TO SAVEPOINT el2c_tx' };
  const q = (sql, params) => client.query(map[String(sql).trim()] || sql, params);
  return { query: q, connect: async () => ({ query: q, release: () => {} }) };
}

async function rowsOf(client, enrollmentId) {
  const r = await client.query(
    `SELECT message_id, status, touch_key, scheduled_for, approved_by, approved_at, skip_reason, template_id
       FROM tc_messages WHERE office_id = $1 AND enrollment_id = $2 ORDER BY scheduled_for`,
    [OFFICE, enrollmentId]
  );
  return r.rows;
}

async function partA(client) {
  const results = [];
  const step = async (name, fn) => {
    await fn();
    results.push(name);
    console.log(`  ok  ${name}`);
  };

  // NOTHING SENDS, for the whole run.
  const origSend = messaging.sendMessage;
  const origGet = adapters.getAdapter;
  messaging.sendMessage = async () => {
    throw new Error('EL-2c verifier: a send was attempted');
  };
  adapters.getAdapter = () => {
    throw new Error('EL-2c verifier: an adapter was reached');
  };

  await client.query('BEGIN');
  try {
    const probeCase = await insertCase(client);
    const probeEnrollment = await insertEnrollment(client, probeCase);
    const complete = {
      case_id: probeCase,
      enrollment_id: probeEnrollment,
      status: 'scheduled',
      approved_by: ACTOR,
      approved_at: new Date(),
      scheduled_for: new Date(),
    };

    await step('scheduled CHECK: each missing field is refused (NULL-safe), the complete row accepted', async () => {
      for (const missing of ['approved_by', 'approved_at', 'scheduled_for', 'enrollment_id']) {
        await mustRefuse(client, PG_CHECK_VIOLATION, () => rawMessage(client, { ...complete, [missing]: null }), `scheduled without ${missing}`);
      }
      await mustRefuse(
        client,
        PG_CHECK_VIOLATION,
        () => rawMessage(client, { case_id: probeCase, enrollment_id: probeEnrollment, status: 'scheduled' }),
        'scheduled with none of them'
      );
      await rawMessage(client, complete);
      // A draft needs none of them (every non-library message is unaffected).
      await rawMessage(client, { case_id: probeCase, status: 'draft' });
    });

    await step('skip_reason + status CHECKs: unknown reason, a reason on a non-skipped row, unknown status — refused', async () => {
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawMessage(client, { status: 'skipped', skip_reason: 'bored' }), 'skip reason bored');
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawMessage(client, { status: 'draft', skip_reason: 'manual' }), 'reason on a draft');
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawMessage(client, { status: 'approved' }), 'status approved');
      for (const reason of ['manual', 'case_terminal', 'opted_out', 'stopped_by_user']) {
        await rawMessage(client, { status: 'skipped', skip_reason: reason });
      }
      await rawMessage(client, { status: 'skipped', skip_reason: null }); // a pre-EL-2c skip
    });

    // ── the real routes over the real schema ──────────────────────────────
    const origSetting = registry.getPlatformSetting;
    registry.getPlatformSetting = async (key) => (key === 'tc_nurture_enabled' ? { value: { roland: true } } : null);
    const app = await bootTcApp({ db: savepointPool(client) });
    nurtureRoute.setClockForTests(() => new Date(VERIFY_NOW.getTime()));
    messaging.setClockForTests(() => new Date(VERIFY_NOW.getTime()));
    // The real audit_log keys tenant_id as a uuid (the test harness's 'T1' is
    // not one): a synthetic tenant uuid, so every audit row really is written
    // into the rolled-back transaction. bootTcApp restores both on close.
    const tenantUuid = randomUUID();
    registry.getUserByEmail = async () => ({ user_id: 'U1', tenant_id: tenantUuid, email: ACTOR, role: 'admin', status: 'active' });
    registry.getTenantById = async () => ({ tenant_id: tenantUuid, slug: 'carein', display_name: 'CareIN', status: 'active' });
    require('../platform/userContext').clearCache();
    try {
      const N = (p) => `${app.baseUrl}/api/tc/nurture${p}`;
      const post = (p, body) => api('', 'POST', N(p), body);

      let enrollmentId = null;
      await step('POST /enrollments (real route): the enrollment + all 5 steps as drafts with scheduled_for, in one transaction', async () => {
        const caseId = await insertCase(client);
        const r = await post('/enrollments?office=roland', {
          case_id: caseId,
          track_key: 'reactivation',
          procedure_id: 'crown',
          variant: 'B',
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        enrollmentId = r.body.enrollment.enrollmentId;
        assert.equal(r.body.enrollment.status, 'active');
        const rows = await rowsOf(client, enrollmentId);
        assert.equal(rows.length, 5);
        assert.ok(rows.every((x) => x.status === 'draft' && x.scheduled_for instanceof Date));
        assert.deepEqual(
          rows.map((x) => x.touch_key),
          library.sequenceFor('reactivation', 'crown').map((s) => s.stage)
        );
        assert.equal(engine.capViolation(TZ, rows.map((x) => x.scheduled_for)), null);
        assert.ok(rows.every((x) => engine.isInSendWindow(TZ, x.scheduled_for)));
        // Started on a Saturday: the first email is Monday's opening, and every
        // later one keeps at least the sequence's gap from where it was PLACED.
        const steps = library.sequenceFor('reactivation', 'crown');
        assert.ok(rows.every((x) => x.scheduled_for >= VERIFY_NOW), 'nothing before the (pinned) now');
        for (let i = 1; i < rows.length; i++) {
          const gap = engine.localDaysBetween(TZ, rows[i - 1].scheduled_for, rows[i].scheduled_for);
          assert.ok(gap >= steps[i].day - steps[i - 1].day, `gap ${i} is ${gap}, the sequence says ${steps[i].day - steps[i - 1].day}`);
        }
        const e = await client.query(
          'SELECT status, next_touch_index, next_touch_due_at FROM tc_nurture_enrollments WHERE enrollment_id = $1',
          [enrollmentId]
        );
        assert.deepEqual(e.rows[0], { status: 'active', next_touch_index: 5, next_touch_due_at: null });
      });

      await step('POST /enrollments: a render failure writes NOTHING (no enrollment, no messages, case unmoved)', async () => {
        const caseId = await insertCase(client, { email: 'second.test2@example.com' });
        const orig = library.renderLibraryEmail;
        let n = 0;
        library.renderLibraryEmail = (input) => {
          n += 1;
          if (n === 3) throw new library.LibraryRenderError('UNRESOLVED_MERGE', 'appointment_date', 'UNRESOLVED_MERGE');
          return orig(input);
        };
        try {
          const r = await post('/enrollments?office=roland', {
            case_id: caseId,
            track_key: 'reactivation',
            procedure_id: 'crown',
            variant: 'A',
          });
          assert.equal(r.status, 409, JSON.stringify(r.body));
          assert.equal(r.body.code, 'UNRESOLVED_MERGE');
        } finally {
          library.renderLibraryEmail = orig;
        }
        const e = await client.query('SELECT count(*)::int AS n FROM tc_nurture_enrollments WHERE case_id = $1', [caseId]);
        const m = await client.query('SELECT count(*)::int AS n FROM tc_messages WHERE case_id = $1', [caseId]);
        const c = await client.query('SELECT status FROM tc_cases WHERE case_id = $1', [caseId]);
        assert.equal(e.rows[0].n, 0);
        assert.equal(m.rows[0].n, 0);
        assert.equal(c.rows[0].status, 'presented');
      });

      await step('approve → scheduled (CHECK satisfied); unapprove → draft; approve-all; reschedule', async () => {
        const rows = await rowsOf(client, enrollmentId);
        const a = await post(`/messages/${rows[1].message_id}/approve?office=roland`, {});
        assert.equal(a.status, 200, JSON.stringify(a.body));
        let back = await rowsOf(client, enrollmentId);
        assert.equal(back[1].status, 'scheduled');
        assert.equal(back[1].approved_by, ACTOR);
        assert.ok(back[1].approved_at instanceof Date);
        const u = await post(`/messages/${rows[1].message_id}/unapprove?office=roland`, {});
        assert.equal(u.status, 200, JSON.stringify(u.body));
        back = await rowsOf(client, enrollmentId);
        assert.equal(back[1].status, 'draft');
        assert.equal(back[1].approved_by, null);
        const all = await post(`/enrollments/${enrollmentId}/approve-all?office=roland`, {});
        assert.equal(all.status, 200, JSON.stringify(all.body));
        assert.equal(all.body.approved, 5);
        back = await rowsOf(client, enrollmentId);
        assert.ok(back.every((x) => x.status === 'scheduled' && x.approved_by === ACTOR));
        // Move the last email one weekday later, inside the window.
        const last = back[4].scheduled_for;
        const p = engine.localParts(TZ, last);
        let ymd = engine.addDaysYmd(p.ymd, 1);
        while ([6, 7].includes(engine.localParts(TZ, engine.plannedAtOn(TZ, ymd)).weekday)) ymd = engine.addDaysYmd(ymd, 1);
        const rs = await post(`/messages/${back[4].message_id}/reschedule?office=roland`, { date: ymd, time: '11:15' });
        assert.equal(rs.status, 200, JSON.stringify(rs.body));
        back = await rowsOf(client, enrollmentId);
        assert.equal(back[4].scheduled_for.toISOString(), engine.localInstant(TZ, ymd, 11 * 60 + 15).toISOString());
        assert.equal(back[4].status, 'scheduled', 'approval kept');
      });

      await step('Stop: every scheduled email → skipped with stopped_by_user (the CHECK accepts it)', async () => {
        const s = await post(`/enrollments/${enrollmentId}/stop?office=roland`, { reason: 'verify' });
        assert.equal(s.status, 200, JSON.stringify(s.body));
        const back = await rowsOf(client, enrollmentId);
        assert.ok(back.every((x) => x.status === 'skipped' && x.skip_reason === 'stopped_by_user'));
      });
    } finally {
      await app.close();
      nurtureRoute.resetClock();
      messaging.resetClock();
      registry.getPlatformSetting = origSetting;
    }

    const roleRow = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (roleRow.rows.length > 0) {
      await step(`${APP_ROLE}: the approve UPDATE and the stop's cancel UPDATE work (no new grants needed)`, async () => {
        await client.query('SAVEPOINT as_app');
        await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
        const id = randomUUID();
        await client.query(
          `INSERT INTO tc_messages (message_id, office_id, case_id, direction, channel, body, status, enrollment_id, scheduled_for)
           VALUES ($1, $2, $3, 'outbound', 'email', 'Synthetic', 'draft', $4, now())`,
          [id, OFFICE, probeCase, probeEnrollment]
        );
        const a = await client.query(
          `UPDATE tc_messages SET status = 'scheduled', approved_by = $3, approved_at = now()
            WHERE office_id = $1 AND message_id = $2 AND status = 'draft' RETURNING message_id`,
          [OFFICE, id, ACTOR]
        );
        assert.equal(a.rows.length, 1);
        const c = await client.query(
          `UPDATE tc_messages SET status = 'skipped', skip_reason = 'stopped_by_user', skipped_by = $3, skipped_at = now()
            WHERE office_id = $1 AND message_id = $2 AND status = ANY($4) RETURNING message_id`,
          [OFFICE, id, ACTOR, ['draft', 'scheduled']]
        );
        assert.equal(c.rows.length, 1);
        await client.query('ROLLBACK TO SAVEPOINT as_app');
      });
    } else {
      console.log(`  SKIP app-role grant: role ${APP_ROLE} absent`);
    }
  } finally {
    await client.query('ROLLBACK');
    messaging.sendMessage = origSend;
    adapters.getAdapter = origGet;
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

async function newColumns(client) {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'tc_messages' AND column_name IN ('scheduled_for', 'approved_by', 'approved_at', 'skip_reason')
      ORDER BY column_name`
  );
  return r.rows.map((x) => x.column_name);
}

async function statusCheck(client) {
  const r = await client.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'tc_messages_status_check'");
  return r.rows.length ? r.rows[0].def : null;
}

async function partB(client, databaseUrl) {
  const newest = await client.query('SELECT name FROM pgmigrations ORDER BY run_on DESC, id DESC LIMIT 1');
  if (!newest.rows[0] || newest.rows[0].name !== SELF) {
    console.log(`  SKIP down/up: the newest applied migration is ${newest.rows[0] && newest.rows[0].name}, not ${SELF}`);
    return false;
  }
  const rows = await client.query("SELECT count(*)::int AS n FROM tc_messages WHERE status = 'scheduled'");
  if (rows.rows[0].n > 0) {
    console.log('  SKIP down/up: this database holds approved emails; refusing to migrate it down');
    return false;
  }
  await migrate(databaseUrl, 'down');
  assert.deepEqual(await newColumns(client), [], 'down() removed the four columns');
  assert.doesNotMatch(String(await statusCheck(client)), /scheduled/, 'down() narrowed the status CHECK');
  console.log("  ok  down(): the four columns are gone and 'scheduled' is out of the status CHECK");
  await migrate(databaseUrl, 'up');
  assert.deepEqual(await newColumns(client), ['approved_at', 'approved_by', 'scheduled_for', 'skip_reason']);
  assert.match(String(await statusCheck(client)), /'scheduled'/);
  const checks = await client.query(
    "SELECT conname FROM pg_constraint WHERE conname IN ('tc_messages_scheduled_check', 'tc_messages_skip_reason_check') ORDER BY conname"
  );
  assert.deepEqual(checks.rows.map((x) => x.conname), ['tc_messages_scheduled_check', 'tc_messages_skip_reason_check']);
  console.log('  ok  up() again: columns, the widened status CHECK and both new CHECKs are back');
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
    console.log(`tc nurture approve-up-front verification passed: ${a.length} part-A checks; down/up ${b ? 'verified' : 'SKIPPED'}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('tc nurture approve-up-front verification FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
