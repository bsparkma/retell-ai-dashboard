#!/usr/bin/env node
'use strict';

/**
 * Run the drain's real statements against a real migrated tenant schema.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * On 2026-08-26 the first staging walk stopped at the first Drain with
 * `column "od_patient_office" does not exist`. The unit suite was green: its
 * database is a `Map` that hands back whatever a fixture seeded, including
 * columns Postgres would refuse. CI migrated a real Postgres and ran the spine
 * smoke test, but never drained a plan — so no query was ever put in front of
 * the schema it would meet in production.
 *
 * `test/rcmQueryColumns.test.js` is the always-on static half: it replays the
 * migrations and holds every literal column reference against the result, on
 * zero infrastructure. This is the other half, and it is ground truth —
 * Postgres itself parsing the exact text the drain sends.
 *
 * PARAMETERS THAT MATCH NOTHING, ON PURPOSE. Column names are resolved at PARSE
 * time, so an unknown column is an error whether or not a row would come back.
 * This script reads no data, writes nothing, and needs no fixtures.
 *
 * Usage (CI runs it after `migrate-tenant.js up`):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/rcm-verify-queries.js
 */

const { Client } = require('pg');

const postingDrain = require('../services/rcm/postingDrain');
const postingGate = require('../services/rcm/postingGate');

/** A uuid that will never be a real key. Valid syntax; matches nothing. */
const NO_SUCH_UUID = '00000000-0000-4000-8000-000000000000';
const NO_SUCH_OFFICE = 'roland';
/** An office key no seeded settings row holds. See the two statements below. */
const NO_SUCH_SETTINGS_KEY = '__no_such_office__';

/**
 * Statement + parameters, chosen so every one returns zero rows.
 * @returns {{name: string, text: string, params: unknown[]}[]}
 */
function statements() {
  const q = postingDrain.PLAN_QUERIES;
  return [
    { name: 'loadPlan.queue', text: q.queue, params: [NO_SUCH_UUID, NO_SUCH_OFFICE] },
    { name: 'loadPlan.lines', text: q.lines, params: [NO_SUCH_UUID, NO_SUCH_OFFICE] },
    { name: 'loadPlan.claims', text: q.claims, params: [NO_SUCH_UUID] },
    { name: 'loadPlan.batch', text: q.batch, params: [NO_SUCH_UUID, NO_SUCH_OFFICE] },
    /*
     * The shadow gate. `read` runs on every press of Drain and every load of
     * the Posting screen; `setDrainEnabled` is the toggle. Both are parsed
     * here for the same reason the four above are — and the UPDATE matters
     * more than most, because it is the one statement in this module that a
     * biller can never reach and therefore the one least likely to be
     * exercised before it is needed.
     *
     * KEYED ON AN OFFICE THAT DOES NOT EXIST. Unlike every other table here,
     * `rcm_office_settings` is SEEDED — `roland` is a real row, and matching it
     * would return one and trip this script's zero-rows rule. `office_id` is
     * only CHECKed on the value written, so a WHERE against a key no row holds
     * is a clean parse-and-plan that touches nothing.
     */
    { name: 'postingGate.read', text: postingGate.QUERIES.read, params: [NO_SUCH_SETTINGS_KEY] },
    {
      name: 'postingGate.setDrainEnabled',
      text: postingGate.QUERIES.setDrainEnabled,
      params: [false, null, NO_SUCH_SETTINGS_KEY],
    },
    /*
     * STAGE B1's setting: how this practice books a write-off it CHOSE to make.
     *
     * A second statement rather than a wider first one, and it belongs here for
     * the same reason `setDrainEnabled` does — it is admin-only, so it is the
     * kind of statement that gets exercised for the first time on the day it
     * matters. `writeoff_field` with a null name is the one combination the
     * adjtype CHECK accepts unconditionally, so this parses AND satisfies the
     * constraint against a key no row holds.
     */
    /*
     * STAGE B2: the confirmed verdict, written onto the claim after a post.
     *
     * An UPDATE that touches no row (the office and the claim id are both
     * impossible), so it parses and plans against the real schema without
     * leaving a mark — and a `confirmed_verdict` column that does not exist is a
     * failure here rather than at the end of a real posting sequence, which is
     * the worst possible moment to discover one.
     */
    {
      name: 'postingDrain.recordVerdict',
      text: postingDrain.CONFIRM_QUERIES.recordVerdict,
      params: [NO_SUCH_OFFICE, NO_SUCH_UUID, JSON.stringify({ state: 'green' })],
    },
    {
      name: 'postingGate.setWriteoffMode',
      text: postingGate.QUERIES.setWriteoffMode,
      params: ['writeoff_field', null, NO_SUCH_SETTINGS_KEY],
    },
  ];
}

async function main() {
  const url = process.env.MIGRATE_TENANT_DB_URL || process.env.TENANT_DB_URL;
  if (!url) {
    console.error(
      '[rcm-verify-queries] set MIGRATE_TENANT_DB_URL to a MIGRATED tenant database'
    );
    process.exit(2);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  const failures = [];
  let ran = 0;
  try {
    /*
     * Inside a transaction that is always rolled back. Nothing here writes, but
     * a verifier pointed at the wrong database must be incapable of leaving a
     * mark even if someone later adds a statement that does.
     */
    await client.query('BEGIN');
    for (const [i, s] of statements().entries()) {
      /*
       * A SAVEPOINT PER STATEMENT. The first failure aborts the transaction, and
       * without one every statement after it reports "current transaction is
       * aborted" instead of its own verdict — one broken query would hide the
       * rest, which is the opposite of what a sweep is for.
       */
      const sp = `s${i}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        const res = await client.query(s.text, s.params);
        ran++;
        if (res.rows.length !== 0) {
          failures.push(`${s.name}: expected zero rows, got ${res.rows.length}`);
        }
        await client.query(`RELEASE SAVEPOINT ${sp}`);
        console.log(`  ok   ${s.name}`);
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        failures.push(`${s.name}: ${err.message}`);
        console.log(`  FAIL ${s.name}: ${err.message}`);
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }

  if (failures.length) {
    console.error(`\n[rcm-verify-queries] ${failures.length} statement(s) the schema refuses:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n[rcm-verify-queries] ${ran} statement(s) accepted by the migrated schema`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[rcm-verify-queries] failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { statements };
