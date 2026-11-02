#!/usr/bin/env node
'use strict';

/**
 * Run the schedule sweep's REAL statements (CO-5b) against a real migrated
 * tenant schema, with synthetic data — the sibling of
 * od-sync-verify-queries.js, for the same reason.
 *
 * The unit suite's database is a Map: it cannot prove the new CHECKs (the
 * widened source list, a schedule card carrying its appointment and nothing
 * else carrying one), the one-card-per-AptNum unique index, that
 * `origin_apt_num = ANY($2)` binds a bigint array, or that the hygiene merge's
 * `source = ANY($13)` binds a text array. So this script calls THE REAL engine
 * — sweepOffice — and the real merge, and then asserts the schema REFUSES the
 * rows it must refuse.
 *
 * NO OPEN DENTAL: the "Open Dental" here is a function returning synthetic
 * rows. No control plane either: both switches answer ON from a stub. Nothing
 * here reaches a practice.
 *
 * EVERYTHING RUNS INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK. The
 * engine's own per-card transactions become savepoints inside it.
 *
 * Usage:
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/auto-checkout-verify-queries.js
 */

const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const registry = require('../platform/registry');
const engine = require('../services/tc/autoCheckout');
const checkoutStore = require('../routes/tc/checkoutStore');
const contract = require('../tc/contract.gen.cjs');

const OFFICE = 'roland';
const TODAY = '2026-10-30';
/** Synthetic PatNums (the roland test patients). */
const PATNUM = 12827;
const OTHER_PATNUM = 12828;
const PG_CHECK_VIOLATION = '23514';
const PG_UNIQUE_VIOLATION = '23505';

/** Open Dental, synthetic. */
const schedule = [
  { AptNum: 9200001, PatNum: PATNUM, AptStatus: 'Complete', IsHygiene: false, AptDateTime: `${TODAY} 09:00:00`, ProvNum: 1, Op: 3 },
  { AptNum: 9200002, PatNum: OTHER_PATNUM, AptStatus: 'Complete', IsHygiene: true, AptDateTime: `${TODAY} 10:00:00`, ProvNum: 1, Op: 3 },
  { AptNum: 9200003, PatNum: 0, AptStatus: 'Complete', IsHygiene: false, AptDateTime: `${TODAY} 11:00:00`, ProvNum: 1, Op: 3 },
];
const odGet = async (path) => {
  if (path === '/appointments') return { ok: true, status: 200, data: schedule };
  if (path === `/patients/${PATNUM}`) return { ok: true, status: 200, data: { PatNum: PATNUM, LName: 'Verify', FName: 'Synthetic' } };
  if (path.startsWith('/patients/')) return { ok: false, status: 404, data: null, error: 'not found' };
  return { ok: true, status: 200, data: [] };
};

/** The engine's pool, over the one open transaction: its BEGIN/COMMIT become savepoints. */
function poolOver(client) {
  let n = 0;
  return {
    query: (sql, params) => client.query(sql, params),
    connect: async () => {
      const name = `auto_checkout_${(n += 1)}`;
      return {
        query: (sql, params) => {
          const s = String(sql).trim().toUpperCase();
          if (s === 'BEGIN') return client.query(`SAVEPOINT ${name}`);
          if (s === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${name}`);
          if (s === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          return client.query(sql, params);
        },
        release() {},
      };
    },
  };
}

/** A minimal handoff row for the refusal probes. */
function probeRow(over) {
  const id = randomUUID();
  return {
    handoff_id: id, office_id: OFFICE, source_key: `verify:${id}`, od_patient_id: OTHER_PATNUM, patient_name: 'Verify, Synthetic',
    provider: '', provider_seen: '', operatory: '', visit_date: '2026-10-21', payload: contract.emptyCheckoutSnapshot(),
    is_final: false, revision: 1, submitted_by: 'verify@carein.ai', updated_by: 'verify@carein.ai', status: 'open', ...over,
  };
}

function steps(client) {
  const pool = poolOver(client);
  const audited = [];
  const sweep = () => engine.sweepOffice({ office: OFFICE, today: TODAY, pool, odGet, audit: async (e) => audited.push(e) });
  const s = {};

  const mustRefuse = (name, code, row) => ({
    name: `refuses: ${name}`,
    run: async () => {
      await client.query('SAVEPOINT must_refuse');
      try {
        await checkoutStore.insertHandoff(client, row());
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT must_refuse');
        if (err.code !== code) throw new Error(`refused, but with ${err.code}: ${err.message}`);
        return;
      }
      await client.query('ROLLBACK TO SAVEPOINT must_refuse');
      throw new Error('the schema ACCEPTED a row it must refuse');
    },
  });

  return [
    {
      name: 'a sweep makes ONE schedule card (the hygiene and the unattached rows make none), audited with the AptNum',
      run: async () => {
        const out = await sweep();
        if (out.status !== 'ok' || out.summary.created !== 1) throw new Error(`summary ${JSON.stringify(out)}`);
        const r = await client.query(
          'SELECT handoff_id, source, status, origin_apt_num, origin_appt, submitted_by FROM tc_checkout_handoffs WHERE office_id = $1 AND origin_apt_num = $2',
          [OFFICE, 9200001]
        );
        if (r.rows.length !== 1) throw new Error(`${r.rows.length} rows`);
        const row = r.rows[0];
        if (row.source !== 'schedule' || row.status !== 'open' || row.submitted_by !== engine.SYSTEM_ACTOR) throw new Error(JSON.stringify(row));
        if (row.origin_appt.aptNum !== 9200001) throw new Error('origin_appt not stored as an object');
        if (audited.length !== 1 || audited[0].sourceRef !== 'apt_num:9200001') throw new Error(JSON.stringify(audited));
        s.handoffId = row.handoff_id;
      },
    },
    {
      name: 'the next sweep makes nothing (origin_apt_num = ANY($2) binds a bigint array)',
      run: async () => {
        const out = await sweep();
        if (out.summary.created !== 0 || out.summary.alreadyCarded !== 1) throw new Error(JSON.stringify(out.summary));
      },
    },
    {
      name: 'the card reads back through the contract',
      run: async () => {
        const row = await checkoutStore.findById(client, OFFICE, s.handoffId);
        const h = contract.TcCheckoutHandoff.parse(checkoutStore.toHandoff(row));
        if (h.source !== 'schedule' || !h.scheduleAppointment || h.scheduleAppointment.aptNum !== 9200001) throw new Error(JSON.stringify(h));
      },
    },
    {
      name: 'a later hygiene handoff merges onto it (source = ANY($13) binds a text array); the appointment stays',
      run: async () => {
        await checkoutStore.lockPatientDay(client, OFFICE, PATNUM, TODAY);
        const found = await checkoutStore.findManualAwaitingHygiene(client, OFFICE, PATNUM, TODAY);
        if (!found || found.handoff_id !== s.handoffId) throw new Error('the schedule card was not found for the merge');
        const merged = await checkoutStore.mergeHygieneOntoManual(client, {
          office: OFFICE,
          handoffId: s.handoffId,
          expectRevision: Number(found.revision),
          sourceKey: `hyg-visit:${randomUUID()}:checkout`,
          row: { payload: contract.emptyCheckoutSnapshot(), is_final: false, patient_name: 'Verify, Synthetic', provider: 'HYG1', provider_seen: 'DOC1', operatory: 'Hyg 1', updated_by: 'verify@carein.ai' },
        });
        if (!merged) throw new Error('the merge did not apply');
        const r = await client.query('SELECT source, origin_apt_num, hygiene_merged_at FROM tc_checkout_handoffs WHERE office_id = $1 AND handoff_id = $2', [OFFICE, s.handoffId]);
        const row = r.rows[0];
        if (row.source !== 'schedule' || Number(row.origin_apt_num) !== 9200001 || !row.hygiene_merged_at) throw new Error(JSON.stringify(row));
      },
    },
    // Another patient, another day: the AptNum alone is the key.
    mustRefuse('a second card from the same AptNum (the unique index)', PG_UNIQUE_VIOLATION, () =>
      probeRow({ source: 'schedule', origin_apt_num: 9200001, origin_appt: { aptNum: 9200001 } })
    ),
    mustRefuse('a schedule card with no appointment', PG_CHECK_VIOLATION, () => probeRow({ source: 'schedule' })),
    mustRefuse('an appointment on a manual card', PG_CHECK_VIOLATION, () =>
      probeRow({ source: 'manual', origin_apt_num: 9200009, origin_appt: { aptNum: 9200009 } })
    ),
    mustRefuse('AptNum 0', PG_CHECK_VIOLATION, () => probeRow({ source: 'schedule', origin_apt_num: 0, origin_appt: { aptNum: 0 } })),
    mustRefuse('an unknown source', PG_CHECK_VIOLATION, () => probeRow({ source: 'robot' })),
  ];
}

async function main() {
  const url = process.env.MIGRATE_TENANT_DB_URL || process.env.TENANT_DB_URL;
  if (!url) {
    console.error('[auto-checkout-verify-queries] set MIGRATE_TENANT_DB_URL to a MIGRATED tenant database');
    process.exit(2);
  }
  // No control plane: both switches ON through their env fallback.
  registry.getPlatformSetting = async () => null;
  process.env.TC_CHECKOUT_ENABLED_ROLAND = 'true';
  process.env.TC_AUTO_CHECKOUT_ENABLED_ROLAND = 'true';

  const client = new Client({ connectionString: url });
  await client.connect();

  const failures = [];
  let ran = 0;
  try {
    // ONE TRANSACTION, ALWAYS ROLLED BACK. The first failure stops the walk.
    await client.query('BEGIN');
    for (const step of steps(client)) {
      try {
        await step.run();
        ran += 1;
        console.log(`  ok   ${step.name}`);
      } catch (err) {
        failures.push(`${step.name}: ${err.message}`);
        console.log(`  FAIL ${step.name}: ${err.message}`);
        break;
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }

  if (failures.length) {
    console.error(`\n[auto-checkout-verify-queries] ${failures.length} step(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n[auto-checkout-verify-queries] ${ran} step(s) behaved as the migrated schema requires`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[auto-checkout-verify-queries] failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { steps };
