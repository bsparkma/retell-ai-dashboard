#!/usr/bin/env node
'use strict';

/**
 * MT-2a (migrations 1789600000000_office_setting + 1789600000001_backfill_office_setting),
 * EXECUTED against a real migrated CONTROL schema with synthetic data. The unit
 * suite's control plane is an in-memory fake (platform/officeSettingsTestUtils.js);
 * this proves the CHECKs, the foreign key, the backfill and the dual-write
 * transaction against Postgres itself.
 *
 * PART A — one transaction, ALWAYS rolled back. The schema:
 *   - the CHECK refuses a setting_key outside the ten (including the three
 *     keys that stay global), a non-boolean switch value, and a non-object
 *     tc_email_identity;
 *   - the FK refuses a row for an office that does not exist, for 'unknown',
 *     and for a tenant that does not exist; deleting an office cascades;
 *   - two tenants that each have an office named 'main' hold independent rows;
 *   - carein_app has no privilege on the table (control plane).
 *
 * PART B — one transaction, ALWAYS rolled back. The backfill on real rows: a
 *   fixture full of ignorable entries is put in platform_setting, the
 *   migration's own backfill() runs, and exactly planBackfill()'s rows land;
 *   a second run inserts nothing; platform_setting is byte-for-byte untouched.
 *
 * PART C — COMMITTED, through the real registry and the real readers' persist
 *   functions (each one a route's write path), then cleaned up. RUNS ONLY on a
 *   pristine database (no platform_setting row for any of the ten keys and no
 *   office_setting row for tenant 'carein'), so it never touches real data:
 *   - tcCheckout.persist, hygPilot.persistHygEnabled and emailIdentity.persist
 *     land identical values in both tables;
 *   - with a trigger that makes the office_setting write fail, the
 *     platform_setting write rolls back with it;
 *   - with every reader read once, the parity tripwire finds nothing.
 *
 * NO OPEN DENTAL. Every value is a synthetic literal (example.test / .invalid).
 *
 * Usage (CI runs it after `migrate.js up`, beside the other verifiers):
 *   CONTROL_DB_URL=postgres://... node scripts/office-settings-verify-queries.js
 */

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const backfillMigration = require('../migrations/1789600000001_backfill_office_setting');

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
const ACTOR = 'mt2a.verify@fixture.invalid';
const PG_CHECK_VIOLATION = '23514';
const PG_FK_VIOLATION = '23503';
const TEN = backfillMigration.ALL_KEYS;

/** Run `fn` and require Postgres to refuse it with `code`. */
async function mustRefuse(client, code, label, fn) {
  await client.query('SAVEPOINT must_refuse');
  try {
    await fn();
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT must_refuse');
    if (err.code !== code) throw new Error(`${label}: refused with ${err.code} (wanted ${code}): ${err.message}`);
    console.log(`  ok  refused: ${label}`);
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT must_refuse');
  throw new Error(`${label}: the schema ACCEPTED a write it must refuse`);
}

/** @param {Client} client */
async function insertSetting(client, tenantId, officeKey, settingKey, valueJson) {
  await client.query(
    `INSERT INTO office_setting (tenant_id, office_key, setting_key, value, updated_by)
          VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [tenantId, officeKey, settingKey, valueJson, ACTOR]
  );
}

/** @param {Client} client */
async function newTenantWithOffice(client, officeKey) {
  const tenantId = randomUUID();
  await client.query(`INSERT INTO tenant (tenant_id, slug, display_name, status) VALUES ($1, $2, $3, 'active')`, [
    tenantId,
    `mt2a-verify-${tenantId.slice(0, 8)}`,
    'MT-2a verify (synthetic)',
  ]);
  await client.query(`INSERT INTO office (tenant_id, office_key, display_name) VALUES ($1, $2, $3)`, [
    tenantId,
    officeKey,
    'Main (synthetic)',
  ]);
  return tenantId;
}

/** @param {Client} client */
async function partA(client) {
  const checks = [];
  await client.query('BEGIN');
  try {
    const a = await newTenantWithOffice(client, 'main');
    const b = await newTenantWithOffice(client, 'main');

    // Every key of the vocabulary is accepted with its right shape.
    for (const key of TEN) {
      await insertSetting(client, a, 'main', key, key === 'tc_email_identity' ? '{"replyTo":"a@example.test"}' : 'true');
    }
    checks.push('all ten keys accepted');
    console.log('  ok  all ten keys accepted with their shape');

    for (const bad of ['tc_email_enabled', 'tc_sms_enabled', 'call_retention_days', 'bogus_setting']) {
      await mustRefuse(client, PG_CHECK_VIOLATION, `unknown setting_key '${bad}'`, () =>
        insertSetting(client, b, 'main', bad, 'true')
      );
      checks.push(bad);
    }
    for (const [label, json] of [
      ['string "true" for a switch', '"true"'],
      ['number 1 for a switch', '1'],
      ['JSON null for a switch', 'null'],
      ['object for a switch', '{"on": true}'],
    ]) {
      await mustRefuse(client, PG_CHECK_VIOLATION, label, () =>
        insertSetting(client, b, 'main', 'tc_checkout_enabled', json)
      );
      checks.push(label);
    }
    for (const [label, json] of [
      ['boolean for tc_email_identity', 'true'],
      ['array for tc_email_identity', '[]'],
    ]) {
      await mustRefuse(client, PG_CHECK_VIOLATION, label, () =>
        insertSetting(client, b, 'main', 'tc_email_identity', json)
      );
      checks.push(label);
    }

    await mustRefuse(client, PG_FK_VIOLATION, 'a row for an office that does not exist', () =>
      insertSetting(client, b, 'nowhere', 'tc_checkout_enabled', 'true')
    );
    await mustRefuse(client, PG_FK_VIOLATION, "a row for the 'unknown' bucket", () =>
      insertSetting(client, b, 'unknown', 'tc_checkout_enabled', 'true')
    );
    await mustRefuse(client, PG_FK_VIOLATION, 'a row for a tenant that does not exist', () =>
      insertSetting(client, randomUUID(), 'main', 'tc_checkout_enabled', 'true')
    );
    checks.push('fk office', 'fk unknown', 'fk tenant');

    // Two tenants, each with an office named 'main': independent rows.
    await insertSetting(client, b, 'main', 'tc_checkout_enabled', 'false');
    await client.query(
      `UPDATE office_setting SET value = 'false'::jsonb WHERE tenant_id = $1 AND office_key = 'main' AND setting_key = 'tc_referrals_enabled'`,
      [a]
    );
    const both = await client.query(
      `SELECT tenant_id, setting_key, value FROM office_setting
        WHERE tenant_id = ANY($1::uuid[]) AND office_key = 'main' AND setting_key IN ('tc_checkout_enabled', 'tc_referrals_enabled')
        ORDER BY setting_key, (tenant_id = $2) DESC`,
      [[a, b], a]
    );
    assert.deepEqual(
      both.rows.map((r) => [r.tenant_id === a ? 'A' : 'B', r.setting_key, r.value]),
      [
        ['A', 'tc_checkout_enabled', true],
        ['B', 'tc_checkout_enabled', false],
        ['A', 'tc_referrals_enabled', false],
      ]
    );
    checks.push('two tenants named main');
    console.log("  ok  two tenants each with an office 'main' hold independent rows");

    // The same (office, key) twice for one tenant is the primary key.
    await mustRefuse(client, '23505', 'a second row for the same tenant/office/key', () =>
      insertSetting(client, b, 'main', 'tc_checkout_enabled', 'true')
    );

    // ON DELETE CASCADE.
    await client.query(`DELETE FROM office WHERE tenant_id = $1 AND office_key = 'main'`, [b]);
    const gone = await client.query('SELECT count(*)::int AS n FROM office_setting WHERE tenant_id = $1', [b]);
    assert.equal(gone.rows[0].n, 0);
    checks.push('cascade');
    console.log('  ok  deleting an office cascades to its settings');

    const roleExists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE])).rows.length > 0;
    if (roleExists) {
      const priv = await client.query(
        `SELECT has_table_privilege($1, 'office_setting', 'SELECT') AS s,
                has_table_privilege($1, 'office_setting', 'INSERT') AS i`,
        [APP_ROLE]
      );
      assert.deepEqual(priv.rows[0], { s: false, i: false });
      checks.push('no app grant');
      console.log(`  ok  ${APP_ROLE} holds no privilege on office_setting`);
    }
  } finally {
    await client.query('ROLLBACK');
  }
  return checks;
}

const FIXTURE = Object.freeze({
  tc_checkout_enabled: { roland: true, valley: 'yes', unknown: true, main: true },
  tc_od_sync_enabled: { valley: false, roland: 1 },
  tc_auto_checkout_enabled: ['roland'],
  tc_referrals_enabled: { roland: false, valley: true },
  hyg_od_enabled: { roland: true, unknown: true, valley: 'true' },
  tc_nurture_enabled: { roland: true, valley: false, bogus: true },
  tc_opportunities_sync: { valley: true, roland: 'true' },
  tc_email_identity: {
    roland: { replyTo: ' FrontDesk@Roland.Example.Test ', practiceName: 'Example Dental', practicePhone: 'x'.repeat(41) },
    valley: 'not-a-map',
  },
});

/** @param {Client} client */
async function partB(client) {
  await client.query('BEGIN');
  try {
    const tenant = await client.query(`SELECT tenant_id FROM tenant WHERE slug = 'carein'`);
    if (!tenant.rows[0]) {
      console.log("  --  SKIPPED: no 'carein' tenant in this database");
      return false;
    }
    const tenantId = tenant.rows[0].tenant_id;
    const offices = (await client.query('SELECT office_key FROM office WHERE tenant_id = $1', [tenantId])).rows.map(
      (r) => r.office_key
    );
    await client.query('DELETE FROM office_setting WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM platform_setting WHERE key = ANY($1::text[])', [TEN]);
    for (const [key, value] of Object.entries(FIXTURE)) {
      await client.query('INSERT INTO platform_setting (key, value, updated_by) VALUES ($1, $2::jsonb, $3)', [
        key,
        JSON.stringify(value),
        ACTOR,
      ]);
    }
    const platformBefore = await client.query(
      'SELECT key, value::text AS v, updated_at, updated_by FROM platform_setting WHERE key = ANY($1::text[]) ORDER BY key',
      [TEN]
    );

    const q = (text, params) => client.query(text, params);
    const inserted = await backfillMigration.backfill(q);
    const expected = backfillMigration.planBackfill(
      Object.entries(FIXTURE).map(([key, value]) => ({ key, value })),
      offices
    );
    assert.equal(inserted, expected.length);
    const got = await client.query(
      `SELECT office_key, setting_key, value, updated_by FROM office_setting WHERE tenant_id = $1 ORDER BY setting_key, office_key`,
      [tenantId]
    );
    const sortKey = (r) => `${r.setting_key}/${r.office_key}`;
    assert.deepEqual(
      got.rows.map((r) => ({ office_key: r.office_key, setting_key: r.setting_key, value: r.value })),
      [...expected].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : 1))
    );
    assert.ok(got.rows.every((r) => r.updated_by === null), 'backfilled rows carry no actor');
    assert.ok(!got.rows.some((r) => r.office_key === 'unknown'));
    console.log(`  ok  the backfill copied exactly the ${inserted} honoured entries (no junk, no 'unknown')`);

    assert.equal(await backfillMigration.backfill(q), 0);
    console.log('  ok  a second run inserts nothing (idempotent)');

    const platformAfter = await client.query(
      'SELECT key, value::text AS v, updated_at, updated_by FROM platform_setting WHERE key = ANY($1::text[]) ORDER BY key',
      [TEN]
    );
    assert.deepEqual(platformAfter.rows, platformBefore.rows);
    console.log('  ok  platform_setting is untouched by the backfill');
    return true;
  } finally {
    await client.query('ROLLBACK');
  }
}

/** @param {Client} client */
async function partC(client) {
  const tenant = await client.query(`SELECT tenant_id FROM tenant WHERE slug = 'carein'`);
  if (!tenant.rows[0]) {
    console.log("  --  SKIPPED: no 'carein' tenant in this database");
    return false;
  }
  const tenantId = tenant.rows[0].tenant_id;
  const offices = await client.query(
    `SELECT office_key FROM office WHERE tenant_id = $1 AND office_key IN ('roland', 'valley')`,
    [tenantId]
  );
  const dirtyPlatform = await client.query('SELECT count(*)::int AS n FROM platform_setting WHERE key = ANY($1::text[])', [
    TEN,
  ]);
  const dirtyOffice = await client.query('SELECT count(*)::int AS n FROM office_setting WHERE tenant_id = $1', [tenantId]);
  if (offices.rows.length !== 2 || dirtyPlatform.rows[0].n > 0 || dirtyOffice.rows[0].n > 0) {
    console.log('  --  SKIPPED: not a pristine database (it holds settings, or lacks the two office rows)');
    return false;
  }

  for (const k of ['TC_CHECKOUT_ENABLED_ROLAND', 'TC_CHECKOUT_ENABLED_VALLEY', 'HYG_OD_ENABLED_ROLAND', 'HYG_OD_ENABLED_VALLEY']) {
    delete process.env[k];
  }
  const registry = require('../platform/registry');
  const parity = require('../platform/officeSettingsParity');
  const tcCheckout = require('../config/tcCheckout');
  const hygPilot = require('../config/hygPilot');
  const emailIdentity = require('../config/emailIdentity');

  const officeValues = async (key) => {
    const r = await client.query(
      `SELECT office_key, value FROM office_setting WHERE tenant_id = $1 AND setting_key = $2 ORDER BY office_key`,
      [tenantId, key]
    );
    return Object.fromEntries(r.rows.map((x) => [x.office_key, x.value]));
  };
  const platformValue = async (key) => {
    const r = await client.query('SELECT value FROM platform_setting WHERE key = $1', [key]);
    return r.rows[0] ? r.rows[0].value : undefined;
  };

  try {
    await tcCheckout.persist('roland', true, ACTOR);
    await tcCheckout.persist('valley', false, ACTOR);
    assert.deepEqual(await platformValue('tc_checkout_enabled'), { roland: true, valley: false });
    assert.deepEqual(await officeValues('tc_checkout_enabled'), { roland: true, valley: false });
    console.log('  ok  tcCheckout.persist (PUT /tc-checkout-offices) wrote both tables identically');

    await hygPilot.persistHygEnabled('valley', false, ACTOR);
    assert.deepEqual(await platformValue('hyg_od_enabled'), { valley: false });
    assert.deepEqual(await officeValues('hyg_od_enabled'), { valley: false });
    console.log('  ok  hygPilot.persistHygEnabled (PUT /hyg-offices) wrote both tables identically');

    await emailIdentity.persist(
      'roland',
      { replyTo: 'FrontDesk@Roland.example.test', practiceName: 'Roland Example Dental', practicePhone: null, referralBcc: null },
      ACTOR
    );
    const identity = { replyTo: 'frontdesk@roland.example.test', practiceName: 'Roland Example Dental' };
    assert.deepEqual(await platformValue('tc_email_identity'), { roland: identity });
    assert.deepEqual(await officeValues('tc_email_identity'), { roland: identity });
    console.log('  ok  emailIdentity.persist (PUT /tc/email-identity) wrote both tables identically');

    // A failing office_setting write takes the platform_setting write with it.
    await client.query(`
      CREATE FUNCTION mt2a_verify_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'mt2a verify: forced office_setting failure'; END $$;
      CREATE TRIGGER mt2a_verify_refuse BEFORE INSERT OR UPDATE ON office_setting
        FOR EACH ROW EXECUTE FUNCTION mt2a_verify_refuse();
    `);
    try {
      await assert.rejects(tcCheckout.persist('valley', true, ACTOR), /forced office_setting failure/);
    } finally {
      await client.query('DROP TRIGGER IF EXISTS mt2a_verify_refuse ON office_setting; DROP FUNCTION IF EXISTS mt2a_verify_refuse();');
    }
    assert.deepEqual(await platformValue('tc_checkout_enabled'), { roland: true, valley: false });
    assert.deepEqual(await officeValues('tc_checkout_enabled'), { roland: true, valley: false });
    console.log('  ok  a failed office_setting write rolled the platform_setting write back');

    // Every reader once, armed: the tripwire finds nothing.
    parity.arm();
    for (const sw of [
      tcCheckout,
      require('../config/tcOdSync'),
      require('../config/tcAutoCheckout'),
      require('../config/tcReferrals'),
      require('../config/tcReferralEmail'),
      require('../config/tcReferralPatientEmail'),
    ]) {
      assert.equal((await sw.refreshFromDb()).ok, true);
    }
    assert.equal((await hygPilot.refreshFromDb()).ok, true);
    assert.equal((await emailIdentity.refreshFromDb()).ok, true);
    await require('../config/tcNurture').switchedOnOffices(registry);
    await require('../config/tcOpportunities').switchedOnOffices(registry);
    await parity.settled();
    for (const key of TEN) assert.deepEqual(parity.lastResult(key), [], key);
    console.log('  ok  every reader compared clean against office_setting');
    return true;
  } finally {
    await client.query('DELETE FROM office_setting WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM platform_setting WHERE key = ANY($1::text[])', [TEN]);
    await registry.close();
  }
}

async function main() {
  const databaseUrl = process.env.CONTROL_DB_URL;
  if (!databaseUrl) {
    console.error('CONTROL_DB_URL is required');
    process.exit(2);
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    console.log('MT-2a part A (schema, one transaction, rolled back):');
    const a = await partA(client);
    console.log('MT-2a part B (backfill on real rows, one transaction, rolled back):');
    const b = await partB(client);
    console.log('MT-2a part C (real dual-write through the registry, committed then cleaned):');
    const c = await partC(client);
    console.log(
      `MT-2a verification passed: ${a.length} part-A checks; backfill ${b ? 'verified' : 'SKIPPED'}; ` +
        `dual-write ${c ? 'verified' : 'SKIPPED'}`
    );
    if (process.env.CI && (!b || !c)) {
      throw new Error('in CI, parts B and C must not skip');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('MT-2a verification FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
