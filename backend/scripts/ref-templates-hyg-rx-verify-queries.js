#!/usr/bin/env node
'use strict';

/**
 * 1794600000000_ref_templates_hyg_rx and its two stores, EXECUTED against a
 * real migrated tenant schema with synthetic data. The unit suites' databases
 * are fakes that accept any row, so they cannot prove a CHECK, a grant or a
 * real down().
 *
 * PART A — one transaction, ALWAYS rolled back:
 *   referral templates (routes/tc/referralTemplateStore.js)
 *     - save / list per office for real; one office never sees the other's;
 *       a second save updates the one row
 *     - the CHECKs refuse an unknown office, an unknown kind, a body over 2000
 *       and an empty updated_by
 *     - as the app role: SELECT / INSERT / UPDATE work, DELETE is refused
 *   hygiene Rx / pharmacy (services/hyg/visitStore.js)
 *     - a new visit reads '' / ''; save → read back; another office's read of
 *       the same appointment number is null
 *     - the CHECKs refuse rx_needed over 1000, pharmacy over 200, and a
 *       pharmacy with a line break
 *     - as the app role: the save works (hyg_visit's existing grant)
 *
 * PART B — this migration's REAL down() and up(), via node-pg-migrate, with a
 *   COMMITTED template row and a COMMITTED visit carrying Rx present: down()
 *   drops the table and the two columns (and leaves the visit row), up()
 *   restores them with their CHECKs, defaults and grant. RUNS ONLY when this
 *   migration is the newest applied one and the database holds no hyg_visit or
 *   tc_referral_templates row it did not seed — it never rolls back somebody
 *   else's migration or touches real data. Seeded rows are deleted at the end,
 *   pass or fail.
 *
 * NO OPEN DENTAL. Every value is a synthetic literal; PatNum 12827 is the
 * roland test fixture.
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside the other verifiers):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/ref-templates-hyg-rx-verify-queries.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');

const templateStore = require('../routes/tc/referralTemplateStore');
const visitStore = require('../services/hyg/visitStore');

const SELF = '1794600000000_ref_templates_hyg_rx';
const ACTOR = 'verify@fixture.invalid';
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
const APT = 990045001; // synthetic appointment number
const PAT = 12827; // roland test fixture

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

async function roleExists(client) {
  return (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE])).rows.length > 0;
}

const rawTemplate = (client, office, kind, body, by = ACTOR) =>
  client.query(
    'INSERT INTO tc_referral_templates (office_id, template_kind, body, updated_by) VALUES ($1, $2, $3, $4)',
    [office, kind, body, by]
  );

const rxUpdate = (client, office, rx, pharmacy) =>
  client.query('UPDATE hyg_visit SET rx_needed = $3, pharmacy = $4 WHERE office = $1 AND apt_num = $2', [office, APT, rx, pharmacy]);

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
    await step('templates: save / list per office; the other office reads blank; a re-save updates the one row', async () => {
      const first = await templateStore.saveTemplate(client, { office: 'roland', kind: 'specialist_message', body: 'Dear {specialist_name}', actor: ACTOR });
      assert.equal(first.prior, 'default');
      assert.equal(first.row.body, 'Dear {specialist_name}');
      const again = await templateStore.saveTemplate(client, { office: 'roland', kind: 'specialist_message', body: 'Re {reason}', actor: ACTOR });
      assert.equal(again.prior, 'stored');
      const roland = await templateStore.listTemplates(client, 'roland');
      assert.deepEqual(roland.map((t) => [t.kind, t.body]), [
        ['specialist_message', 'Re {reason}'],
        ['correspondence_note', ''],
      ]);
      const valley = await templateStore.listTemplates(client, 'valley');
      assert.deepEqual(valley.map((t) => t.body), ['', '']);
      const n = await client.query("SELECT count(*)::int AS n FROM tc_referral_templates WHERE office_id = 'roland'");
      assert.equal(n.rows[0].n, 1);
    });

    await step('templates: the CHECKs refuse an unknown office, an unknown kind, a body over 2000, an empty updated_by', async () => {
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawTemplate(client, 'unknown', 'specialist_message', 'x'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawTemplate(client, 'valley', 'patient_letter', 'x'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawTemplate(client, 'valley', 'correspondence_note', 'x'.repeat(2001)));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rawTemplate(client, 'valley', 'correspondence_note', 'x', ''));
      await rawTemplate(client, 'valley', 'correspondence_note', 'x'.repeat(2000));
    });

    await step('hyg: a new visit reads blank; save → read back; the other office reads nothing', async () => {
      await visitStore.openVisit(client, { office: 'roland', aptNum: APT, patNum: PAT, visitDate: '2026-11-11', actor: ACTOR });
      assert.deepEqual(await visitStore.getPrescriptions(client, { office: 'roland', aptNum: APT }), { rxNeeded: '', pharmacy: '' });
      const saved = await visitStore.savePrescriptions(client, {
        office: 'roland',
        aptNum: APT,
        rxNeeded: 'Synthetic Rx line 1\nline 2',
        pharmacy: 'Synthetic Pharmacy',
        actor: ACTOR,
      });
      assert.deepEqual(saved, { rxNeeded: 'Synthetic Rx line 1\nline 2', pharmacy: 'Synthetic Pharmacy' });
      assert.equal(await visitStore.getPrescriptions(client, { office: 'valley', aptNum: APT }), null);
      assert.equal(
        await visitStore.savePrescriptions(client, { office: 'valley', aptNum: APT, rxNeeded: 'x', pharmacy: '', actor: ACTOR }),
        null
      );
      // The send context carries them (for the checkout card) — and the HygVisit does not.
      const ctx = await visitStore.getOrthoSendContext(client, { office: 'roland', aptNum: APT });
      assert.deepEqual(ctx.prescriptions, saved);
      assert.ok(!JSON.stringify(ctx.visit).includes('Synthetic Rx'), 'the HygVisit never carries them');
    });

    await step('hyg: the CHECKs refuse rx over 1000, pharmacy over 200, a pharmacy with a line break', async () => {
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rxUpdate(client, 'roland', 'x'.repeat(1001), ''));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rxUpdate(client, 'roland', '', 'x'.repeat(201)));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rxUpdate(client, 'roland', '', 'one\ntwo'));
      await mustRefuse(client, PG_CHECK_VIOLATION, () => rxUpdate(client, 'roland', '', 'one\rtwo'));
      await rxUpdate(client, 'roland', 'x'.repeat(1000), 'y'.repeat(200));
    });

    if (await roleExists(client)) {
      await step(`${APP_ROLE}: templates SELECT + INSERT + UPDATE yes, DELETE no; the Rx save works`, async () => {
        await client.query('SAVEPOINT as_app');
        await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
        await templateStore.listTemplates(client, 'roland');
        await templateStore.saveTemplate(client, { office: 'roland', kind: 'correspondence_note', body: 'As the app role', actor: ACTOR });
        await templateStore.saveTemplate(client, { office: 'roland', kind: 'correspondence_note', body: 'Again', actor: ACTOR });
        await mustRefuse(client, PG_INSUFFICIENT_PRIVILEGE, () =>
          client.query("DELETE FROM tc_referral_templates WHERE office_id = 'roland'")
        );
        await visitStore.savePrescriptions(client, { office: 'roland', aptNum: APT, rxNeeded: 'As app', pharmacy: '', actor: ACTOR });
        await client.query('ROLLBACK TO SAVEPOINT as_app');
      });
    } else {
      console.log(`  SKIP app-role grants: role ${APP_ROLE} absent`);
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
  const r = await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'tc_referral_templates'");
  return r.rows[0].n > 0;
}

async function rxColumns(client) {
  const r = await client.query(
    `SELECT column_name, column_default, is_nullable FROM information_schema.columns
      WHERE table_name = 'hyg_visit' AND column_name IN ('rx_needed', 'pharmacy') ORDER BY column_name`
  );
  return r.rows;
}

async function partB(client, databaseUrl) {
  const newest = await client.query('SELECT name FROM pgmigrations ORDER BY run_on DESC, id DESC LIMIT 1');
  if (!newest.rows[0] || newest.rows[0].name !== SELF) {
    console.log(`  SKIP down/up: the newest applied migration is ${newest.rows[0] && newest.rows[0].name}, not ${SELF}`);
    return false;
  }
  const visits = await client.query('SELECT count(*)::int AS n FROM hyg_visit');
  const templates = await client.query('SELECT count(*)::int AS n FROM tc_referral_templates');
  if (visits.rows[0].n > 0 || templates.rows[0].n > 0) {
    console.log('  SKIP down/up: this database already holds hygiene visits or templates; refusing to migrate it down');
    return false;
  }

  try {
    await templateStore.saveTemplate(client, { office: 'roland', kind: 'specialist_message', body: 'Seeded {reason}', actor: ACTOR });
    await visitStore.openVisit(client, { office: 'roland', aptNum: APT, patNum: PAT, visitDate: '2026-11-11', actor: ACTOR });
    await visitStore.savePrescriptions(client, { office: 'roland', aptNum: APT, rxNeeded: 'Seeded Rx', pharmacy: 'Seeded Pharmacy', actor: ACTOR });

    await migrate(databaseUrl, 'down');
    assert.equal(await tableExists(client), false, 'down() drops tc_referral_templates');
    assert.deepEqual(await rxColumns(client), [], 'down() drops the two hyg_visit columns');
    const kept = await client.query('SELECT count(*)::int AS n FROM hyg_visit WHERE office = $1 AND apt_num = $2', ['roland', APT]);
    assert.equal(kept.rows[0].n, 1, 'the visit row itself survives down()');
    console.log('  ok  down() with a template and an Rx present: the table and columns are gone, the visit is not');

    await migrate(databaseUrl, 'up');
    assert.equal(await tableExists(client), true);
    const cols = await rxColumns(client);
    assert.deepEqual(cols.map((c) => [c.column_name, c.is_nullable]), [
      ['pharmacy', 'NO'],
      ['rx_needed', 'NO'],
    ]);
    // The pre-existing visit row took the default.
    assert.deepEqual(await visitStore.getPrescriptions(client, { office: 'roland', aptNum: APT }), { rxNeeded: '', pharmacy: '' });
    await assert.rejects(rxUpdate(client, 'roland', '', 'a\nb'), (err) => err.code === PG_CHECK_VIOLATION);
    await assert.rejects(rawTemplate(client, 'unknown', 'specialist_message', 'x'), (err) => err.code === PG_CHECK_VIOLATION);
    if (await roleExists(client)) {
      const grants = await client.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_name = 'tc_referral_templates' AND grantee = $1 ORDER BY privilege_type`,
        [APP_ROLE]
      );
      assert.deepEqual(grants.rows.map((r) => r.privilege_type), ['INSERT', 'SELECT', 'UPDATE']);
    }
    console.log('  ok  up() again restored the table, the columns (NOT NULL, default \'\'), their CHECKs and the grant');
    return true;
  } finally {
    if (await tableExists(client)) await client.query("DELETE FROM tc_referral_templates WHERE updated_by = $1", [ACTOR]);
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
    console.log(`ref-templates + hyg Rx verification passed: ${a.length} part-A checks; down/up ${b ? 'verified' : 'SKIPPED'}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('ref-templates + hyg Rx verification FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
