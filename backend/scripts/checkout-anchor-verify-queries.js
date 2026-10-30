#!/usr/bin/env node
'use strict';

/**
 * Run the checkout appointment anchor's REAL statements (CO-4a) against a real
 * migrated tenant schema, with synthetic data — the sibling of
 * fees-verify-queries.js, for the same reason.
 *
 * The unit suite's database is a Map: it accepts any row, so it cannot prove
 * the anchor's CHECKs (all five columns or none; an anchor only on a Scheduled
 * checkout; the wall-clock shape), that its NULL parameters type cleanly in
 * Postgres (one type is deduced per $n), or that CO-5a's reopen clears the
 * anchor in a way the CHECKs accept. A CHECK is only evaluated when a row is
 * really written, so this script WRITES: it walks one synthetic checkout
 * through Scheduled → anchored → changed → cleared → re-anchored → reopened,
 * calling THE REAL store functions, then asserts the schema REFUSES the writes
 * it must refuse.
 *
 * NO OPEN DENTAL: the appointment rows are synthetic literals. Nothing here
 * reaches a practice.
 *
 * EVERYTHING RUNS INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK. The
 * must-refuse steps run inside a savepoint each, rolled back to after the
 * expected error, so one refusal does not abort the rest.
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside the other verifiers):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/checkout-anchor-verify-queries.js
 */

const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const checkoutStore = require('../routes/tc/checkoutStore');
const contract = require('../tc/contract.gen.cjs');

const OFFICE = 'roland';
/** A PatNum no practice uses for a real person in these checks — synthetic. */
const PATNUM = 12827;

const APPOINTMENT = { aptNum: 9000001, dateTime: '2026-11-04 09:00:00', provider: 'DOC1', appointmentType: 'Crown prep', operatory: 'Op 4' };
const OTHER = { aptNum: 9000002, dateTime: '2026-11-10 14:30', provider: 'DOC1', appointmentType: 'Comp', operatory: 'Op 9' };

/** Postgres's check_violation SQLSTATE. */
const PG_CHECK_VIOLATION = '23514';

function steps(client) {
  const handoffId = randomUUID();
  const read = async () => checkoutStore.toHandoff(await checkoutStore.findById(client, OFFICE, handoffId));

  /** Run `sql` and require Postgres to refuse it with a CHECK violation. */
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
      name: 'insert a waiting checkout (no anchor)',
      run: async () => {
        await checkoutStore.insertHandoff(client, {
          handoff_id: handoffId,
          office_id: OFFICE,
          source_key: `verify:${handoffId}`,
          od_patient_id: PATNUM,
          patient_name: 'Verify, Synthetic',
          provider: '',
          provider_seen: '',
          operatory: '',
          visit_date: '2026-10-30',
          payload: contract.emptyCheckoutSnapshot(),
          is_final: false,
          revision: 1,
          submitted_by: 'verify@carein.ai',
          updated_by: 'verify@carein.ai',
          status: 'open',
          source: 'manual',
        });
        if ((await read()).appointment !== null) throw new Error('a new checkout is not unanchored');
      },
    },
    {
      name: 'setAnchor refuses (writes nothing) while the checkout is not Scheduled',
      run: async () => {
        if (await checkoutStore.setAnchor(client, { office: OFFICE, handoffId, appointment: APPOINTMENT, actor: 'verify@carein.ai' })) {
          throw new Error('an anchor landed on a waiting checkout');
        }
      },
    },
    {
      name: 'record Scheduled, then anchor it (the outcome route\'s order)',
      run: async () => {
        const ok = await checkoutStore.recordOutcome(client, {
          office: OFFICE,
          handoffId,
          expectStatus: 'open',
          outcome: 'scheduled',
          actor: 'verify@carein.ai',
          appointmentNote: null,
          caseId: null,
        });
        if (!ok) throw new Error('the outcome did not apply');
        if (!(await checkoutStore.setAnchor(client, { office: OFFICE, handoffId, appointment: APPOINTMENT, actor: 'verify@carein.ai' }))) {
          throw new Error('the anchor did not apply');
        }
        const a = (await read()).appointment;
        if (!a || a.aptNum !== APPOINTMENT.aptNum || a.dateTime !== APPOINTMENT.dateTime || a.operatory !== 'Op 4') {
          throw new Error(`read back ${JSON.stringify(a)}`);
        }
      },
    },
    {
      name: 'change the anchor (a HH:MM time is accepted too)',
      run: async () => {
        await checkoutStore.setAnchor(client, { office: OFFICE, handoffId, appointment: OTHER, actor: 'verify@carein.ai' });
        if ((await read()).appointment.aptNum !== OTHER.aptNum) throw new Error('the change did not persist');
      },
    },
    {
      name: 'clear the anchor (all five NULL parameters type cleanly)',
      run: async () => {
        await checkoutStore.setAnchor(client, { office: OFFICE, handoffId, appointment: null, actor: 'verify@carein.ai' });
        if ((await read()).appointment !== null) throw new Error('the clear did not persist');
      },
    },
    mustRefuse(
      'half an anchor (an AptNum with no time)',
      "UPDATE tc_checkout_handoffs SET appt_num = 1 WHERE office_id = $1 AND handoff_id = $2",
      [OFFICE, handoffId]
    ),
    mustRefuse(
      'a time that is not the wall-clock shape',
      `UPDATE tc_checkout_handoffs SET appt_num = 1, appt_at_local = '2026-11-04T09:00:00Z', appt_snapshot = '{}'::jsonb,
              appt_linked_by = 'x', appt_linked_at = now() WHERE office_id = $1 AND handoff_id = $2`,
      [OFFICE, handoffId]
    ),
    mustRefuse(
      'a snapshot that is not an object',
      `UPDATE tc_checkout_handoffs SET appt_num = 1, appt_at_local = '2026-11-04 09:00', appt_snapshot = '[]'::jsonb,
              appt_linked_by = 'x', appt_linked_at = now() WHERE office_id = $1 AND handoff_id = $2`,
      [OFFICE, handoffId]
    ),
    {
      name: 're-anchor, then the CO-5a reopen clears it with the outcome and keeps it as history',
      run: async () => {
        await checkoutStore.setAnchor(client, { office: OFFICE, handoffId, appointment: APPOINTMENT, actor: 'verify@carein.ai' });
        const row = await checkoutStore.findById(client, OFFICE, handoffId);
        const history = await checkoutStore.reopenAnswered(client, { office: OFFICE, handoffId, row, at: new Date().toISOString() });
        if (!history || !history.appointment || history.appointment.aptNum !== APPOINTMENT.aptNum) {
          throw new Error(`history ${JSON.stringify(history)}`);
        }
        const after = await read();
        if (after.status !== 'open' || after.appointment !== null) throw new Error('the reopen left an anchor');
        if (!after.reopenedFrom || !after.reopenedFrom.appointment || after.reopenedFrom.appointment.aptNum !== APPOINTMENT.aptNum) {
          throw new Error('the reopened card does not show its old anchor');
        }
      },
    },
    mustRefuse(
      'an anchor on a checkout that is not Scheduled',
      `UPDATE tc_checkout_handoffs SET appt_num = 1, appt_at_local = '2026-11-04 09:00', appt_snapshot = '{}'::jsonb,
              appt_linked_by = 'x', appt_linked_at = now() WHERE office_id = $1 AND handoff_id = $2`,
      [OFFICE, handoffId]
    ),
  ];
}

async function main() {
  const url = process.env.MIGRATE_TENANT_DB_URL || process.env.TENANT_DB_URL;
  if (!url) {
    console.error('[checkout-anchor-verify-queries] set MIGRATE_TENANT_DB_URL to a MIGRATED tenant database');
    process.exit(2);
  }
  const client = new Client({ connectionString: url });
  await client.connect();

  const failures = [];
  let ran = 0;
  try {
    // ONE TRANSACTION, ALWAYS ROLLED BACK. The steps are a sequence, so the
    // first failure stops the walk rather than producing misleading follow-ons.
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
    console.error(`\n[checkout-anchor-verify-queries] ${failures.length} step(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n[checkout-anchor-verify-queries] ${ran} step(s) behaved as the migrated schema requires`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[checkout-anchor-verify-queries] failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { steps };
