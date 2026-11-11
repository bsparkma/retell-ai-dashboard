#!/usr/bin/env node
'use strict';

/**
 * CO-7's migration (1794400000000_tc_checkout_questions.js) and its store,
 * EXECUTED against a real migrated tenant schema with synthetic data — the
 * sibling of at0-note-history-verify-queries.js, for the same reason: the unit
 * suite's database is a Map that accepts any row, so it cannot prove a CHECK, a
 * foreign key or a column grant.
 *
 * PART A — one transaction, ALWAYS rolled back:
 *   - the store's insert / list / resolve run for real (a question, a reply,
 *     resolve-twice resolves once);
 *   - the CHECKs refuse an unknown office, an unknown role, an empty and an
 *     oversized body, an empty author, and a RESOLVED reply;
 *   - the FK refuses a question on a card that does not exist;
 *   - as the app role: SELECT and INSERT work, UPDATE of resolved_at works,
 *     UPDATE of any other column and DELETE are permission errors.
 *
 * PART B — this migration's REAL down() and up(), via node-pg-migrate, with a
 *   COMMITTED card + question present (a down() runs its own transaction):
 *   down() drops the table, up() restores it with its CHECKs and grants. RUNS
 *   ONLY when this migration is the newest applied one and the database holds no
 *   tc_checkout_handoffs row it did not seed — it never rolls back somebody
 *   else's migration or touches real data. The seeded rows are deleted at the
 *   end, pass or fail.
 *
 * PART C — CO-6's "Route to…" writes (routes/tc/checkoutRouting.js routeInTx,
 *   with the deps checkout.js mounts it with), one destination per savepoint,
 *   inside one transaction that is ALWAYS rolled back: the pre-auth INSERT and
 *   its history row, the case created through the contract, the status
 *   transition, the follow-up row, the Inbox case WITH its intake row, the
 *   card's link (`status = ANY($4)` with a text[] parameter) and the dismiss —
 *   every CHECK on tc_cases / tc_case_events / tc_hygiene_intakes /
 *   tc_followups / tc_preauth_cases evaluated for real.
 *
 * NO OPEN DENTAL. Every value is a synthetic literal.
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside the other verifiers):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/checkout-questions-verify-queries.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const questionStore = require('../routes/tc/checkoutQuestionStore');
const checkoutStore = require('../routes/tc/checkoutStore');
const checkoutRoute = require('../routes/tc/checkout');
const { routeInTx } = require('../routes/tc/checkoutRouting');
const contract = require('../tc/contract.gen.cjs');
const hygQuestions = require('../services/hyg/checkoutQuestions');

const SELF = '1794400000000_tc_checkout_questions';
const OFFICE = 'roland';
const ACTOR = 'tc.verify@fixture.invalid';
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();

const PG_CHECK_VIOLATION = '23514';
const PG_FK_VIOLATION = '23503';
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

/** A synthetic checkout card. 12827 is the Roland test fixture. */
async function seedCard(client, id = randomUUID()) {
  await client.query(
    `INSERT INTO tc_checkout_handoffs
        (handoff_id, office_id, source_key, od_patient_id, patient_name, visit_date, payload, submitted_by, updated_by)
     VALUES ($1, $2, $3, 12827, 'Verify, Synthetic', '2026-11-11', '{}'::jsonb, $4, $4)`,
    [id, OFFICE, `verify:${id}`, ACTOR]
  );
  return id;
}

const insert = (client, over) =>
  questionStore.insertQuestion(client, {
    office: OFFICE,
    authorEmail: ACTOR,
    authorRole: 'tc',
    body: 'Synthetic question?',
    at: '2026-11-11T16:00:00Z',
    ...over,
  });

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
    const card = await seedCard(client);

    await step('the store writes a question and a reply, and lists them oldest first', async () => {
      await insert(client, { handoffId: card, at: '2026-11-11T16:00:00Z' });
      await insert(client, { handoffId: card, authorRole: 'hygienist', body: 'Synthetic reply', at: '2026-11-11T16:05:00Z' });
      const rows = await questionStore.listForHandoffs(client, OFFICE, [card]);
      const thread = questionStore.threadOf(card, rows);
      assert.deepEqual(thread.messages.map((m) => m.authorRole), ['tc', 'hygienist']);
      assert.equal(thread.open, 1);
      assert.equal(thread.messages[0].resolvedAt, null);
    });
    await step('resolve resolves the open question once; the reply stays unresolved', async () => {
      assert.equal(await questionStore.resolveOpen(client, { office: OFFICE, handoffId: card, at: '2026-11-11T17:00:00Z' }), 1);
      assert.equal(await questionStore.resolveOpen(client, { office: OFFICE, handoffId: card, at: '2026-11-11T18:00:00Z' }), 0);
      const rows = await questionStore.listForHandoffs(client, OFFICE, [card]);
      assert.equal(questionStore.threadOf(card, rows).open, 0);
      assert.equal(rows.find((r) => r.author_role === 'hygienist').resolved_at, null);
    });
    await step('another office\'s read of the same card id returns nothing', async () => {
      assert.deepEqual(await questionStore.listForHandoffs(client, 'valley', [card]), []);
    });
    await step('the CHECKs refuse: office, role, empty / oversized body, empty author, a resolved reply', async () => {
      await mustRefuse(client, PG_CHECK_VIOLATION, () => insert(client, { handoffId: card, office: 'unknown' }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => insert(client, { handoffId: card, authorRole: 'doctor' }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => insert(client, { handoffId: card, body: '' }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => insert(client, { handoffId: card, body: 'x'.repeat(2001) }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => insert(client, { handoffId: card, authorEmail: '' }));
      await mustRefuse(client, PG_CHECK_VIOLATION, () =>
        client.query(
          `INSERT INTO tc_checkout_questions (office_id, handoff_id, author_email, author_role, body, resolved_at)
           VALUES ($1, $2, $3, 'hygienist', 'reply', now())`,
          [OFFICE, card, ACTOR]
        )
      );
      // 2000 is the bound, not past it.
      await insert(client, { handoffId: card, body: 'x'.repeat(2000) });
    });
    await step("the hygiene day's badge reads run for real (bigint[] / text[] parameters, the schedule origin)", async () => {
      await client.query(
        "UPDATE tc_checkout_handoffs SET source = 'schedule', origin_apt_num = 900001, origin_appt = '{}'::jsonb WHERE handoff_id = $1",
        [card]
      );
      const badges = await hygQuestions.badgesForDay(client, OFFICE, [900001, 900002], '2026-11-11');
      assert.equal(badges.length, 1);
      assert.equal(badges[0].aptNum, 900001);
      assert.equal(badges[0].handoffId, card);
      assert.ok(badges[0].total >= 2);
      assert.deepEqual(await hygQuestions.badgesForDay(client, 'valley', [900001], '2026-11-11'), []);
      const found = await hygQuestions.threadForApt(client, OFFICE, 900001);
      assert.equal(found && found.handoffId, card);
    });
    await step('the FK refuses a question on a card that does not exist', async () => {
      await mustRefuse(client, PG_FK_VIOLATION, () => insert(client, { handoffId: randomUUID() }));
    });
    await step(`${APP_ROLE}: SELECT + INSERT + UPDATE(resolved_at) yes; UPDATE of anything else and DELETE no`, async () => {
      await client.query('SAVEPOINT as_app');
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await questionStore.listForHandoffs(client, OFFICE, [card]);
      await insert(client, { handoffId: card, body: 'As the app role' });
      await questionStore.resolveOpen(client, { office: OFFICE, handoffId: card, at: '2026-11-11T19:00:00Z' });
      await mustRefuse(client, PG_INSUFFICIENT_PRIVILEGE, () =>
        client.query("UPDATE tc_checkout_questions SET body = 'rewritten' WHERE office_id = $1 AND handoff_id = $2", [OFFICE, card])
      );
      await mustRefuse(client, PG_INSUFFICIENT_PRIVILEGE, () =>
        client.query("UPDATE tc_checkout_questions SET author_role = 'tc' WHERE office_id = $1 AND handoff_id = $2", [OFFICE, card])
      );
      await mustRefuse(client, PG_INSUFFICIENT_PRIVILEGE, () =>
        client.query('DELETE FROM tc_checkout_questions WHERE office_id = $1 AND handoff_id = $2', [OFFICE, card])
      );
      await client.query('ROLLBACK TO SAVEPOINT as_app');
    });
  } finally {
    await client.query('ROLLBACK');
  }
  return results;
}

// ── PART C ──────────────────────────────────────────────────────────────────

const SNAPSHOT = {
  procedures: [
    { teeth: [3], code: 'Crown', category: 'Restorative', priority: 'urgent', status: 'proposed', surfaces: ['O'], scheduleNext: true, note: '' },
  ],
  priority: 'urgent',
  nextVisit: { type: 'Prophy', intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: '6 mo' },
  notesPending: false,
  frontDeskNote: 'Synthetic note',
  financialNote: '',
  collectAtCheckout: ['Fl2'],
};

/** Seed a card (plus whatever `before` seeds), route it, and read the card back. */
async function routeCard(client, raw, { before } = {}) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO tc_checkout_handoffs
        (handoff_id, office_id, source_key, od_patient_id, patient_name, provider, provider_seen, visit_date, payload, submitted_by, updated_by)
     VALUES ($1, $2, $3, 12827, 'Verify, Synthetic', 'DOC1', 'HYG1', '2026-11-11', $4::jsonb, $5, $5)`,
    [id, OFFICE, `verify:${id}`, JSON.stringify(SNAPSHOT), ACTOR]
  );
  if (before) await before(id);
  const row = await checkoutStore.findById(client, OFFICE, id);
  const out = await routeInTx(client, checkoutRoute.routeDeps, {
    req: { user: { email: ACTOR, name: 'Verify Desk' } },
    office: OFFICE,
    row,
    handoff: checkoutStore.toHandoff(row),
    body: contract.TcCheckoutRouteRequest.parse(raw),
    actor: ACTOR,
    now: '2026-11-11T16:00:00.000Z',
  });
  return { id, out, card: await checkoutStore.findById(client, OFFICE, id) };
}

async function partC(client) {
  const results = [];
  const step = async (name, fn) => {
    await client.query('SAVEPOINT route_step');
    try {
      await fn();
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT route_step');
    }
    results.push(name);
    console.log(`  ok  ${name}`);
  };
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];

  await client.query('BEGIN');
  try {
    await step('preauth (no case): the pre-auth row and its created history; the card stays Waiting', async () => {
      const { out, card } = await routeCard(client, { destination: 'preauth', insuranceCarrier: 'Synthetic Dental' });
      const pa = await one('SELECT od_patient_id, status, case_id FROM tc_preauth_cases WHERE office_id = $1 AND preauth_id = $2', [
        OFFICE,
        out.preauthId,
      ]);
      assert.deepEqual([Number(pa.od_patient_id), pa.status, pa.case_id], [12827, 'pending', null]);
      const hist = await client.query('SELECT type FROM tc_preauth_events WHERE office_id = $1 AND preauth_id = $2', [OFFICE, out.preauthId]);
      assert.deepEqual(hist.rows.map((r) => r.type), ['created']);
      assert.equal(card.status, 'open');
    });
    await step('pipeline (no case): created through the contract, moved by the status transition, card linked', async () => {
      const { out, card } = await routeCard(client, { destination: 'pipeline', status: 'presented' });
      const cs = await one('SELECT status FROM tc_cases WHERE office_id = $1 AND case_id = $2', [OFFICE, out.caseId]);
      assert.equal(cs.status, 'presented');
      const ev = await client.query('SELECT type FROM tc_case_events WHERE office_id = $1 AND case_id = $2', [OFFICE, out.caseId]);
      assert.deepEqual(ev.rows.map((r) => r.type).sort(), ['case_created', 'status_change']);
      assert.deepEqual([String(card.case_id), card.status], [out.caseId, 'open']);
    });
    await step('pipeline (unowned hygiene_review case): moved and assigned (F1)', async () => {
      const caseId = randomUUID();
      const { out } = await routeCard(
        client,
        { destination: 'pipeline', status: 'pending_tc' },
        {
          before: () =>
            client.query(
              `INSERT INTO tc_cases (case_id, office_id, patient_name, category, status, urgency, od_patient_id, assigned_tc)
               VALUES ($1, $2, 'Verify, Synthetic', 'single_tooth', 'hygiene_review', 'medium', 12827, '')`,
              [caseId, OFFICE]
            ),
        }
      );
      assert.equal(out.caseId, caseId);
      const cs = await one('SELECT status, assigned_tc FROM tc_cases WHERE office_id = $1 AND case_id = $2', [OFFICE, caseId]);
      assert.deepEqual([cs.status, cs.assigned_tc], ['pending_tc', ACTOR]);
    });
    await step('followup (no case): a pending_tc case and a pending follow-up row', async () => {
      const { out } = await routeCard(client, { destination: 'followup', dueDate: '2026-11-20', talkingPoint: 'Synthetic call', channel: 'text' });
      const f = await one('SELECT case_id, kind, status, channel, source FROM tc_followups WHERE office_id = $1 AND followup_id = $2', [
        OFFICE,
        out.followupId,
      ]);
      assert.deepEqual([String(f.case_id), f.kind, f.status, f.channel, f.source], [out.caseId, 'followup', 'pending', 'text', 'manual']);
    });
    await step('inbox (no case): an unowned hygiene_review case WITH its intake; the card Dismissed and linked', async () => {
      const { out, card } = await routeCard(client, { destination: 'inbox', note: 'Synthetic' });
      const cs = await one('SELECT status, assigned_tc FROM tc_cases WHERE office_id = $1 AND case_id = $2', [OFFICE, out.caseId]);
      assert.deepEqual([cs.status, cs.assigned_tc], ['hygiene_review', '']);
      const intake = await client.query(
        'SELECT hygienist_name, submitted_by, flag_urgent, collect_at_checkout FROM tc_hygiene_intakes WHERE office_id = $1 AND case_id = $2',
        [OFFICE, out.caseId]
      );
      assert.equal(intake.rows.length, 1);
      assert.deepEqual(
        [intake.rows[0].hygienist_name, intake.rows[0].submitted_by, intake.rows[0].flag_urgent, intake.rows[0].collect_at_checkout],
        ['HYG1', ACTOR, true, ['Fl2']]
      );
      assert.deepEqual([card.status, String(card.case_id)], ['dismissed', out.caseId]);
      assert.match(card.dismissed_reason, /^Sent to the TC Inbox/);
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

const TABLE_SQL = "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'tc_checkout_questions'";

async function tableExists(client) {
  return (await client.query(TABLE_SQL)).rows[0].n > 0;
}

async function partB(client, databaseUrl) {
  const newest = await client.query('SELECT name FROM pgmigrations ORDER BY run_on DESC, id DESC LIMIT 1');
  if (!newest.rows[0] || newest.rows[0].name !== SELF) {
    console.log(`  SKIP down/up: the newest applied migration is ${newest.rows[0] && newest.rows[0].name}, not ${SELF}`);
    return false;
  }
  const busy = await client.query('SELECT count(*)::int AS n FROM tc_checkout_handoffs');
  if (busy.rows[0].n > 0) {
    console.log('  SKIP down/up: this database already holds checkout cards; refusing to migrate it down');
    return false;
  }

  const card = randomUUID();
  try {
    await seedCard(client, card);
    await insert(client, { handoffId: card });

    await migrate(databaseUrl, 'down');
    assert.equal(await tableExists(client), false);
    const kept = await client.query('SELECT count(*)::int AS n FROM tc_checkout_handoffs WHERE handoff_id = $1', [card]);
    assert.equal(kept.rows[0].n, 1, 'the card itself is untouched by down()');
    console.log('  ok  down() ran with a question present: the table is gone, the card is not');

    await migrate(databaseUrl, 'up');
    assert.equal(await tableExists(client), true);
    await insert(client, { handoffId: card, body: 'after up' });
    await mustRefuseOutsideTx(client, () => insert(client, { handoffId: card, authorRole: 'doctor' }));
    const grant = await client.query(
      `SELECT privilege_type, column_name FROM information_schema.column_privileges
        WHERE table_name = 'tc_checkout_questions' AND grantee = $1 AND privilege_type = 'UPDATE'`,
      [APP_ROLE]
    );
    const roleExists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE])).rows.length > 0;
    if (roleExists) assert.deepEqual(grant.rows.map((r) => r.column_name), ['resolved_at']);
    console.log('  ok  up() again restored the table, its CHECKs and the resolved_at-only UPDATE grant');
    return true;
  } finally {
    if (await tableExists(client)) {
      await client.query('DELETE FROM tc_checkout_questions WHERE handoff_id = $1', [card]);
    }
    await client.query('DELETE FROM tc_checkout_handoffs WHERE handoff_id = $1', [card]);
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
  throw new Error('the restored CHECK ACCEPTED an unknown role');
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
    console.log('CO-7 part A (one transaction, rolled back):');
    const a = await partA(client);
    console.log('CO-6 part C (route writes, one transaction, rolled back):');
    const c = await partC(client);
    console.log(`CO-7 part B (${SELF} down → up):`);
    const b = await partB(client, databaseUrl);
    console.log(
      `CO-6/CO-7 verification passed: ${a.length} part-A checks; ${c.length} part-C routes; down/up ${b ? 'verified' : 'SKIPPED'}`
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('CO-7 verification FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
