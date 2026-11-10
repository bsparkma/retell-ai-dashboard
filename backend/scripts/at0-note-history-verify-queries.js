#!/usr/bin/env node
'use strict';

/**
 * AT-0's migration (1794300000000_at0_note_history.js) and its writers,
 * EXECUTED against a real migrated tenant schema with synthetic data — the
 * sibling of checkout-anchor-verify-queries.js, for the same reason: the unit
 * suite's database is a Map that accepts any row, so it cannot prove a CHECK,
 * a trigger, a grant, or that down() leaves no row violating a narrowed CHECK.
 *
 * PART A — one transaction, ALWAYS rolled back:
 *   - a notes_updated row is accepted; an unknown type is refused;
 *   - the funnel (routes/tc/funnel.js computeFunnel, the route's exact SQL)
 *     answers IDENTICALLY with and without a notes_updated row — even one
 *     whose description is shaped like a status transition;
 *   - letter_snapshot: accepted on `send` / `patient_email_sent`, refused on
 *     any other verb and in a wrong shape, and WRITE-ONCE (an UPDATE that
 *     changes it raises; an UPDATE of another column does not);
 *   - tc_preauth_events: office / type / changes CHECKs; no FK, so a row
 *     outlives its pre-auth; append-only for carein_app (UPDATE and DELETE are
 *     permission errors, SELECT and INSERT work).
 *
 * PART B — this migration's REAL down() and up(), via node-pg-migrate:
 *   seeds a notes_updated row, a snapshot-bearing send row and a pre-auth
 *   history row (COMMITTED — a down() runs its own transaction), then rolls
 *   the newest migration back. down() succeeding at all proves no row was left
 *   violating the narrowed type CHECK (Postgres validates existing rows when a
 *   CHECK is added). Then: the notes row is a note_added row that still says
 *   what the notes said; the column, trigger and table are gone. up() again
 *   restores them. The seeded rows are deleted at the end, pass or fail.
 *   PART B RUNS ONLY when this migration is the newest applied one and the
 *   database holds no tc_cases row it did not seed — it never rolls back
 *   somebody else's migration or touches real data.
 *
 * NO OPEN DENTAL. Every value is a synthetic literal.
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside the other verifiers):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/at0-note-history-verify-queries.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Client } = require('pg');

const caseStore = require('../routes/tc/caseStore');
const referralStore = require('../routes/tc/referralStore');
const preauthStore = require('../routes/tc/preauthStore');
const { computeFunnel } = require('../routes/tc/funnel');

const SELF = '1794300000000_at0_note_history';
const OFFICE = 'roland';
const ACTOR = 'tc.verify@fixture.invalid';
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();

const PG_CHECK_VIOLATION = '23514';
const PG_INSUFFICIENT_PRIVILEGE = '42501';

/** Run `fn` and require Postgres to refuse it with `code`. */
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

async function seedCase(client, id = randomUUID()) {
  await client.query(
    `INSERT INTO tc_cases (case_id, office_id, patient_name, category, status, urgency, notes)
     VALUES ($1, $2, 'Verify, Synthetic', 'single_tooth', 'presented', 'medium', 'v2')`,
    [id, OFFICE]
  );
  return id;
}

async function seedReferral(client, id = randomUUID()) {
  await client.query(
    `INSERT INTO tc_referrals (referral_id, office_id, od_patient_id, patient_name, created_by, status_changed_by, status)
     VALUES ($1, $2, 12827, 'Verify, Synthetic', $3, $3, 'sent')`,
    [id, OFFICE, ACTOR]
  );
  return id;
}

function notesEvent(caseId, text, description = 'Case notes edited') {
  return {
    event_id: randomUUID(),
    case_id: caseId,
    office_id: OFFICE,
    ts: '2026-09-10T15:00:00Z',
    type: 'notes_updated',
    description,
    actor: ACTOR,
    detail: { notes: text },
    legacy_id: null,
  };
}

const SNAPSHOT = { audience: 'specialist', subject: 'Referral: Verify, Synthetic', text: 'Synthetic letter body.', withheld: [] };

function sendEvent(referralId, verb, letterSnapshot) {
  const sends = verb === 'send' || verb === 'send_conflict' || verb === 'patient_email_sent';
  return {
    office: OFFICE,
    referralId,
    from: 'approved',
    to: verb === 'send' ? 'sent' : 'approved',
    actor: ACTOR,
    at: '2026-09-10T15:00:00Z',
    note: 'verify',
    verb,
    acsMessageId: sends ? `verify-${randomUUID()}` : null,
    recipientAddress: sends ? 'specialist@fixture.invalid' : null,
    // Unique per tenant (R5): a fresh synthetic hash per row.
    unsubscribeTokenHash: sends ? createHash('sha256').update(randomUUID()).digest('hex') : null,
    letterSnapshot,
  };
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
    const caseId = await seedCase(client);

    await step('a notes_updated row is accepted by the type CHECK', async () => {
      await caseStore.insertEventRow(client, notesEvent(caseId, 'v1'));
    });
    await step('an unknown event type is still refused', async () => {
      await mustRefuse(client, PG_CHECK_VIOLATION, () =>
        caseStore.insertEventRow(client, { ...notesEvent(caseId, 'x'), type: 'notes_rewritten' })
      );
    });

    await step('the funnel answers identically with a notes_updated row present (even transition-shaped)', async () => {
      const funnelCase = await seedCase(client);
      await caseStore.insertEventRow(client, {
        ...notesEvent(funnelCase, ''),
        type: 'case_created',
        description: 'Case created',
        detail: null,
        ts: '2026-09-01T15:00:00Z',
      });
      await caseStore.insertEventRow(client, {
        ...notesEvent(funnelCase, ''),
        type: 'status_change',
        description: 'pending_tc → presented',
        detail: null,
        ts: '2026-09-02T15:00:00Z',
      });
      const args = { office: OFFICE, from: '2026-09-01', to: '2026-09-30', timeZone: 'America/Chicago' };
      const before = await computeFunnel(client, args);
      assert.ok(before && before.funnel, JSON.stringify(before));
      await caseStore.insertEventRow(client, notesEvent(funnelCase, 'presented → accepted', 'presented → accepted'));
      const after = await computeFunnel(client, args);
      assert.deepEqual(after, before);
    });

    const referralId = await seedReferral(client);
    await step('letter_snapshot is accepted on `send` and on `patient_email_sent`', async () => {
      await referralStore.insertSendEvent(client, sendEvent(referralId, 'send', SNAPSHOT));
      await referralStore.insertSendEvent(
        client,
        sendEvent(referralId, 'patient_email_sent', { audience: 'patient', subject: 's', text: 't', after: '' })
      );
      const res = await client.query(
        "SELECT letter_snapshot FROM tc_referral_events WHERE office_id = $1 AND referral_id = $2 AND verb = 'send'",
        [OFFICE, referralId]
      );
      assert.deepEqual(res.rows[0].letter_snapshot, SNAPSHOT);
    });
    await step('letter_snapshot is refused on a verb that sent nothing, and in the wrong shape', async () => {
      await mustRefuse(client, PG_CHECK_VIOLATION, () =>
        referralStore.insertSendEvent(client, sendEvent(referralId, 'send_failed', SNAPSHOT))
      );
      await mustRefuse(client, PG_CHECK_VIOLATION, () =>
        referralStore.insertSendEvent(client, sendEvent(referralId, 'send', { audience: 'nobody', subject: 's', text: 't' }))
      );
      await mustRefuse(client, PG_CHECK_VIOLATION, () =>
        referralStore.insertSendEvent(client, sendEvent(referralId, 'send', { audience: 'specialist', subject: 's' }))
      );
    });
    await step('letter_snapshot is WRITE-ONCE; other columns of the row stay updatable', async () => {
      await mustRefuse(client, PG_CHECK_VIOLATION, () =>
        client.query(
          `UPDATE tc_referral_events SET letter_snapshot = '{"audience":"specialist","subject":"x","text":"rewritten"}'::jsonb
            WHERE office_id = $1 AND referral_id = $2 AND verb = 'send'`,
          [OFFICE, referralId]
        )
      );
      await mustRefuse(client, PG_CHECK_VIOLATION, () =>
        client.query(
          "UPDATE tc_referral_events SET letter_snapshot = NULL WHERE office_id = $1 AND referral_id = $2 AND verb = 'send'",
          [OFFICE, referralId]
        )
      );
      const ok = await client.query(
        "UPDATE tc_referral_events SET note = 'verify edit' WHERE office_id = $1 AND referral_id = $2 AND verb = 'send'",
        [OFFICE, referralId]
      );
      assert.equal(ok.rowCount, 1);
    });

    const preauthId = randomUUID();
    await step('tc_preauth_events: a row per type is accepted, through the real writer', async () => {
      for (const type of ['created', 'updated', 'status_change', 'deleted']) {
        await preauthStore.insertPreauthEvent(client, {
          office: OFFICE,
          preauthId,
          actor: ACTOR,
          type,
          changes: { notes: { from: 'a', to: 'b' } },
        });
      }
      const res = await client.query(
        'SELECT type, changes FROM tc_preauth_events WHERE office_id = $1 AND preauth_id = $2 ORDER BY type',
        [OFFICE, preauthId]
      );
      assert.equal(res.rows.length, 4);
      assert.deepEqual(res.rows[0].changes, { notes: { from: 'a', to: 'b' } });
    });
    await step('tc_preauth_events: office, type and changes CHECKs refuse', async () => {
      const base = { office: OFFICE, preauthId, actor: ACTOR, type: 'updated', changes: {} };
      await mustRefuse(client, PG_CHECK_VIOLATION, () => preauthStore.insertPreauthEvent(client, { ...base, office: 'unknown' }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => preauthStore.insertPreauthEvent(client, { ...base, type: 'create' }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () =>
        client.query(
          "INSERT INTO tc_preauth_events (office_id, preauth_id, type, changes) VALUES ($1, $2, 'updated', '[]'::jsonb)",
          [OFFICE, preauthId]
        )
      );
    });
    await step('tc_preauth_events has no FK: history for a pre-auth that no longer exists is kept', async () => {
      const fk = await client.query(
        "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'tc_preauth_events'::regclass AND contype = 'f'"
      );
      assert.equal(fk.rows[0].n, 0);
    });
    await step(`tc_preauth_events is append-only for ${APP_ROLE}: SELECT + INSERT yes, UPDATE + DELETE no`, async () => {
      await client.query('SAVEPOINT as_app');
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await client.query('SELECT event_id FROM tc_preauth_events WHERE office_id = $1 AND preauth_id = $2', [OFFICE, preauthId]);
      await preauthStore.insertPreauthEvent(client, { office: OFFICE, preauthId, actor: ACTOR, type: 'updated', changes: {} });
      await mustRefuse(client, PG_INSUFFICIENT_PRIVILEGE, () =>
        client.query("UPDATE tc_preauth_events SET actor = 'x' WHERE office_id = $1 AND preauth_id = $2", [OFFICE, preauthId])
      );
      await mustRefuse(client, PG_INSUFFICIENT_PRIVILEGE, () =>
        client.query('DELETE FROM tc_preauth_events WHERE office_id = $1 AND preauth_id = $2', [OFFICE, preauthId])
      );
      await client.query('ROLLBACK TO SAVEPOINT as_app');
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

async function exists(client, sql, params = []) {
  return (await client.query(sql, params)).rows[0].n > 0;
}

const COLUMN_SQL =
  "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'tc_referral_events' AND column_name = 'letter_snapshot'";
const TABLE_SQL = "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'tc_preauth_events'";
const TRIGGER_SQL =
  "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'tc_referral_events_letter_snapshot_write_once' AND NOT tgisinternal";

async function partB(client, databaseUrl) {
  const newest = await client.query('SELECT name FROM pgmigrations ORDER BY run_on DESC, id DESC LIMIT 1');
  if (!newest.rows[0] || newest.rows[0].name !== SELF) {
    console.log(`  SKIP down/up: the newest applied migration is ${newest.rows[0] && newest.rows[0].name}, not ${SELF}`);
    return false;
  }
  const busy = await client.query('SELECT count(*)::int AS n FROM tc_cases');
  if (busy.rows[0].n > 0) {
    console.log('  SKIP down/up: this database already holds tc_cases rows; refusing to migrate it down');
    return false;
  }

  const caseId = randomUUID();
  const referralId = randomUUID();
  const preauthId = randomUUID();
  try {
    await seedCase(client, caseId);
    await caseStore.insertEventRow(client, notesEvent(caseId, 'what the notes said'));
    await caseStore.insertEventRow(client, notesEvent(caseId, ''));
    await seedReferral(client, referralId);
    await referralStore.insertSendEvent(client, sendEvent(referralId, 'send', SNAPSHOT));
    await preauthStore.insertPreauthEvent(client, { office: OFFICE, preauthId, actor: ACTOR, type: 'deleted', changes: {} });

    await migrate(databaseUrl, 'down');
    console.log('  ok  down() ran with history rows present — nothing stranded against the narrowed CHECK');

    const kept = await client.query(
      'SELECT type, description, detail FROM tc_case_events WHERE office_id = $1 AND case_id = $2 ORDER BY description',
      [OFFICE, caseId]
    );
    assert.deepEqual(
      kept.rows.map((r) => [r.type, r.description, r.detail]),
      [
        ['note_added', 'Case notes cleared', null],
        ['note_added', 'Case notes edited: what the notes said', null],
      ]
    );
    console.log('  ok  down() kept each notes revision as a note_added row that still says what the notes said');
    await mustRefuseOutsideTx(client, () => caseStore.insertEventRow(client, notesEvent(caseId, 'after down')));
    assert.equal(await exists(client, COLUMN_SQL), false);
    assert.equal(await exists(client, TABLE_SQL), false);
    assert.equal(await exists(client, TRIGGER_SQL), false);
    console.log('  ok  down() narrowed the CHECK and removed the column, trigger and table');

    await migrate(databaseUrl, 'up');
    assert.equal(await exists(client, COLUMN_SQL), true);
    assert.equal(await exists(client, TABLE_SQL), true);
    assert.equal(await exists(client, TRIGGER_SQL), true);
    await caseStore.insertEventRow(client, notesEvent(caseId, 'after up'));
    console.log('  ok  up() again restored the CHECK, column, trigger and table');
    return true;
  } finally {
    await client.query('DELETE FROM tc_case_events WHERE office_id = $1 AND case_id = $2', [OFFICE, caseId]);
    await client.query('DELETE FROM tc_cases WHERE office_id = $1 AND case_id = $2', [OFFICE, caseId]);
    await client.query('DELETE FROM tc_referral_events WHERE office_id = $1 AND referral_id = $2', [OFFICE, referralId]);
    await client.query('DELETE FROM tc_referrals WHERE office_id = $1 AND referral_id = $2', [OFFICE, referralId]);
    // tc_preauth_events (if it exists) is append-only for the app role only; the owner may clean up.
    if (await exists(client, TABLE_SQL)) {
      await client.query('DELETE FROM tc_preauth_events WHERE office_id = $1 AND preauth_id = $2', [OFFICE, preauthId]);
    }
  }
}

/** mustRefuse for autocommit statements (Part B runs outside a transaction). */
async function mustRefuseOutsideTx(client, fn) {
  try {
    await fn();
  } catch (err) {
    if (err.code !== PG_CHECK_VIOLATION) throw err;
    return;
  }
  throw new Error('the narrowed CHECK ACCEPTED a notes_updated row');
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
    console.log('AT-0 part A (one transaction, rolled back):');
    const a = await partA(client);
    console.log(`AT-0 part B (${SELF} down → up):`);
    const b = await partB(client, databaseUrl);
    console.log(`AT-0 verification passed: ${a.length} part-A checks; down/up ${b ? 'verified' : 'SKIPPED'}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('AT-0 verification FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
