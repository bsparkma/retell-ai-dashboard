#!/usr/bin/env node
'use strict';

/**
 * Run the Open Dental pipeline sync's REAL statements (CO-4b) against a real
 * migrated tenant schema, with synthetic data — the sibling of
 * checkout-anchor-verify-queries.js, for the same reason.
 *
 * The unit suite's database is a Map: it cannot prove the new CHECKs (the
 * action / flag vocabularies, the runs table's trigger and status), that the
 * engine's jsonb and NULL parameters type cleanly in Postgres, that
 * `case_id = ANY($2)` binds a uuid array, or that a rescheduled time still
 * satisfies CO-4a's wall-clock CHECK. So this script calls THE REAL engine —
 * syncOffice, undoChange, listForPanel, the run-row reads — and then asserts
 * the schema REFUSES the rows it must refuse.
 *
 * NO OPEN DENTAL: the "Open Dental" here is a function returning synthetic
 * rows. Nothing here reaches a practice.
 *
 * EVERYTHING RUNS INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK. The
 * engine's own per-case transactions become savepoints inside it.
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside the other verifiers):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/od-sync-verify-queries.js
 */

const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const engine = require('../services/tc/odPipelineSync');
const checkoutStore = require('../routes/tc/checkoutStore');
const caseStore = require('../routes/tc/caseStore');
const contract = require('../tc/contract.gen.cjs');

const OFFICE = 'roland';
/** A synthetic PatNum (the roland test patient). */
const PATNUM = 12827;
const PG_CHECK_VIOLATION = '23514';

/** Open Dental, synthetic: AptNum → row. Mutated between steps. */
const od = {};
const odGet = async (path) => {
  const n = Number(String(path).split('/').pop());
  const row = od[n];
  return row ? { ok: true, status: 200, data: row } : { ok: false, status: 404, data: null, error: 'not found' };
};

/** The engine's pool, over the one open transaction: its BEGIN/COMMIT become savepoints. */
function poolOver(client) {
  let n = 0;
  return {
    query: (sql, params) => client.query(sql, params),
    connect: async () => {
      const name = `od_sync_${(n += 1)}`;
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

const CASE_DEFAULTS = {
  legacyId: null, patientAge: null, phone: null, email: null, caseType: 'Checkout', category: 'single_tooth',
  readinessScore: 0, caseValueCents: 0, financingStatus: '', preferredFinancingProvider: null, decisionMakers: '',
  financialSituation: [], keyMotivators: [], contactPreference: null, bestTimeToReach: '', referralSource: 'hygiene',
  lostReason: null, diagnosedDate: null, nurtureCadence: 'standard', inLongTailMode: false, nurtureEnrolledAt: null,
  nurturePhaseChangedAt: null, nurturePhase1DaysOverride: null, nurturePhase2DaysOverride: null,
  nurtureUnsubscribed: false, phases: [], objections: [], followups: [], events: [], hygieneIntake: null,
  urgency: 'medium', doctorName: '', diagnosingProvider: null, assignedTc: 'verify@carein.ai', notes: '',
  statusChangedAt: '2026-10-30T15:00:00.000Z',
};

/** Visit days for the seeded checkouts: CO-5a allows one hand-added card per patient per day. */
let seedDay = 20;

/** A Scheduled case and its Scheduled checkout anchored to `aptNum` — through the real store functions. */
async function seed(client, aptNum, at) {
  seedDay += 1;
  const caseId = randomUUID();
  const aggregate = contract.TcCase.parse({ ...CASE_DEFAULTS, caseId, officeId: OFFICE, patientName: 'Verify, Synthetic', odPatientId: PATNUM, status: 'scheduled' });
  await caseStore.insertCaseRow(client, contract.caseToRows(aggregate, randomUUID).caseRow);
  const handoffId = randomUUID();
  await checkoutStore.insertHandoff(client, {
    handoff_id: handoffId, office_id: OFFICE, source_key: `verify:${handoffId}`, od_patient_id: PATNUM,
    patient_name: 'Verify, Synthetic', provider: '', provider_seen: '', operatory: '', visit_date: `2026-10-${seedDay}`,
    payload: contract.emptyCheckoutSnapshot(), is_final: false, revision: 1, submitted_by: 'verify@carein.ai',
    updated_by: 'verify@carein.ai', status: 'open', source: 'manual',
  });
  if (!(await checkoutStore.recordOutcome(client, { office: OFFICE, handoffId, expectStatus: 'open', outcome: 'scheduled', actor: 'verify@carein.ai', appointmentNote: null, caseId }))) {
    throw new Error('seed: the outcome did not apply');
  }
  if (!(await checkoutStore.setAnchor(client, { office: OFFICE, handoffId, appointment: { aptNum, dateTime: at, provider: 'DOC1', appointmentType: 'Crown prep', operatory: 'Op 4' }, actor: 'verify@carein.ai' }))) {
    throw new Error('seed: the anchor did not apply');
  }
  return { caseId, handoffId };
}

async function caseOf(client, caseId) {
  const r = await client.query('SELECT status, od_sync_action, od_sync_flag, od_sync_undone FROM tc_cases WHERE office_id = $1 AND case_id = $2', [OFFICE, caseId]);
  return r.rows[0];
}

function steps(client) {
  const pool = poolOver(client);
  const audited = [];
  const run = () =>
    engine.syncOffice({ office: OFFICE, pool, trigger: 'nightly', odGet, sw: { isEnabled: async () => true }, audit: async (e) => audited.push(...e) });
  const s = {};

  const mustRefuse = (name, sql, params) => ({
    name: `refuses: ${name}`,
    run: async () => {
      await client.query('SAVEPOINT must_refuse');
      try {
        await client.query(sql, params);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT must_refuse');
        if (err.code !== PG_CHECK_VIOLATION) throw new Error(`refused, but with ${err.code}: ${err.message}`);
        return;
      }
      await client.query('ROLLBACK TO SAVEPOINT must_refuse');
      throw new Error('the schema ACCEPTED a row it must refuse');
    },
  });

  return [
    {
      name: 'seed four Scheduled cases (complete / reschedule / gone) and one with no appointment linked',
      run: async () => {
        s.done = await seed(client, 9100001, '2026-11-04 09:00:00');
        s.moved = await seed(client, 9100002, '2026-11-05 10:00');
        s.gone = await seed(client, 9100003, '2026-11-06 11:00:00');
        const bare = randomUUID();
        const agg = contract.TcCase.parse({ ...CASE_DEFAULTS, caseId: bare, officeId: OFFICE, patientName: 'Verify, Bare', odPatientId: PATNUM, status: 'scheduled' });
        await caseStore.insertCaseRow(client, contract.caseToRows(agg, randomUUID).caseRow);
        od[9100001] = { AptNum: 9100001, PatNum: PATNUM, AptStatus: 'Complete', AptDateTime: '2026-11-04 09:00:00' };
        od[9100002] = { AptNum: 9100002, PatNum: PATNUM, AptStatus: 'Scheduled', AptDateTime: '2026-11-07 13:30:00' };
      },
    },
    {
      name: 'a sweep: completed, rescheduled (CO-4a wall-clock CHECK holds), flagged, unanchored counted, run row ok',
      run: async () => {
        const out = await run();
        if (out.status !== 'ok') throw new Error(`run ${JSON.stringify(out)}`);
        const sum = out.summary;
        if (sum.completed < 1 || sum.rescheduled < 1 || sum.flagged < 1 || sum.unanchored < 1) throw new Error(`summary ${JSON.stringify(sum)}`);
        const done = await caseOf(client, s.done.caseId);
        if (done.status !== 'completed' || done.od_sync_action.kind !== 'completed') throw new Error(`done ${JSON.stringify(done)}`);
        const at = await client.query('SELECT appt_at_local FROM tc_checkout_handoffs WHERE office_id = $1 AND handoff_id = $2', [OFFICE, s.moved.handoffId]);
        if (at.rows[0].appt_at_local !== '2026-11-07 13:30:00') throw new Error(`moved ${at.rows[0].appt_at_local}`);
        if ((await caseOf(client, s.gone.caseId)).od_sync_flag.reason !== 'missing') throw new Error('gone not flagged');
        const last = await engine.lastRun(client, OFFICE);
        if (!last || last.status !== 'ok' || typeof last.summary !== 'object') throw new Error(`last run ${JSON.stringify(last)}`);
      },
    },
    {
      name: 'the panel and the unanchored count read back',
      run: async () => {
        const panel = await engine.listForPanel(client, OFFICE);
        if (!panel.changes.find((c) => c.caseId === s.done.caseId)) throw new Error('the completed change is not listed');
        if (!panel.flagged.find((c) => c.caseId === s.gone.caseId)) throw new Error('the flag is not listed');
        if ((await engine.countUnanchored(client, OFFICE)) < 1) throw new Error('unanchored not counted');
      },
    },
    {
      name: 'undo a move and a reschedule (NULL + jsonb parameters type cleanly), then no redo',
      run: async () => {
        const a = await engine.undoChange(pool, { office: OFFICE, caseId: s.done.caseId, actor: 'verify@carein.ai', at: new Date().toISOString() });
        const b = await engine.undoChange(pool, { office: OFFICE, caseId: s.moved.caseId, actor: 'verify@carein.ai', at: new Date().toISOString() });
        if (!a.ok || !b.ok) throw new Error(`undo ${JSON.stringify({ a, b })}`);
        const done = await caseOf(client, s.done.caseId);
        if (done.status !== 'scheduled' || done.od_sync_action !== null || !done.od_sync_undone.fingerprint) throw new Error(`undo ${JSON.stringify(done)}`);
        const out = await run();
        if (out.summary.heldByUndo < 2) throw new Error(`redone: ${JSON.stringify(out.summary)}`);
      },
    },
    mustRefuse(
      'an action outside the vocabulary',
      "UPDATE tc_cases SET od_sync_action = '{\"kind\":\"deleted\"}'::jsonb WHERE office_id = $1 AND status = 'scheduled'",
      [OFFICE]
    ),
    mustRefuse('a flag that is not an object', "UPDATE tc_cases SET od_sync_flag = '[]'::jsonb WHERE office_id = $1 AND status = 'scheduled'", [OFFICE]),
    mustRefuse('an undo record with no fingerprint', "UPDATE tc_cases SET od_sync_undone = '{}'::jsonb WHERE office_id = $1 AND status = 'scheduled'", [OFFICE]),
    mustRefuse(
      'a run with a trigger nobody has',
      "INSERT INTO tc_od_sync_runs (run_id, office_id, trigger, started_at, status) VALUES ($1, 'roland', 'cron', now(), 'ok')",
      [randomUUID()]
    ),
    mustRefuse(
      'a run for an office that is not one',
      "INSERT INTO tc_od_sync_runs (run_id, office_id, trigger, started_at, status) VALUES ($1, 'unknown', 'manual', now(), 'ok')",
      [randomUUID()]
    ),
  ];
}

async function main() {
  const url = process.env.MIGRATE_TENANT_DB_URL || process.env.TENANT_DB_URL;
  if (!url) {
    console.error('[od-sync-verify-queries] set MIGRATE_TENANT_DB_URL to a MIGRATED tenant database');
    process.exit(2);
  }
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
    console.error(`\n[od-sync-verify-queries] ${failures.length} step(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n[od-sync-verify-queries] ${ran} step(s) behaved as the migrated schema requires`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[od-sync-verify-queries] failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { steps };
