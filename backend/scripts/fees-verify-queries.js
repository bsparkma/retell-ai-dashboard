#!/usr/bin/env node
'use strict';

/**
 * Run the fee-posting module's REAL statements against a real migrated tenant
 * schema, with synthetic data, through the whole posting lifecycle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * On 2026-09-24 the first real fee post failed at its first database write:
 * `claimBatchForPosting` set `posted_by` while `posted_at` was still NULL,
 * which `fees_import_batch_posted_pair_check` forbids. The module had never
 * successfully written a fee. The unit suite was green, because its database is
 * a Map that accepted a row Postgres refuses.
 * (docs/reports/fees-post-failure-recon.md.)
 *
 * `rcm-verify-queries.js` is the sibling of this script and would NOT have
 * caught it. That one proves statements PARSE against the real schema, with
 * parameters that match nothing — perfect for a missing column, useless for a
 * constraint, because a CHECK is only evaluated when a row is actually written.
 *
 * SO THIS SCRIPT SEEDS AND MUTATES. It walks a synthetic batch through the
 * whole lifecycle — claim, stale takeover, requester stamp, row writes,
 * completion, failure, rollback, backup — calling THE REAL FUNCTIONS, so what
 * is verified is the code the job runs rather than a copy of its SQL that could
 * drift. Every CHECK, every NOT NULL and every foreign key is enforced by
 * Postgres itself, which is the only authority that counts.
 *
 * NO OPEN DENTAL. `ensureBackup`'s one outbound read is stubbed on the writer
 * module's namespace — the same seam the unit tests use, and the reason
 * `odFeesWrites` is required as a namespace rather than destructured. Nothing
 * here reaches a practice, and the script is safe to point at any migrated
 * tenant database.
 *
 * EVERYTHING RUNS INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK. The script
 * writes a great deal and leaves nothing: a verifier that had to be cleaned up
 * after is a verifier nobody runs.
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside rcm-verify-queries):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/fees-verify-queries.js
 */

const { Client } = require('pg');

const postJob = require('../services/fees/postJob');
const importStore = require('../routes/fees/importStore');
const odFeesWrites = require('../services/fees/odFeesWrites');

/** The frozen office key the CHECKs accept. Synthetic data only. */
const OFFICE = 'roland';
/** A fee schedule number that exists in no practice — nothing is called with it. */
const FEESCHED = 999001;

/** Synthetic rows. CDT codes and money; a fee schedule has no patient on it. */
const ROWS = [
  { procCode: 'D0120', feeCents: 4500, rawLine: 'D0120 Periodic exam 45.00', warnings: [] },
  { procCode: 'D1110', feeCents: 9200, rawLine: 'D1110 Prophylaxis 92.00', warnings: [] },
  {
    procCode: 'D2740',
    feeCents: 115000,
    rawLine: 'D2740 Crown 1,150.00 920.00 805.00',
    warnings: [{ code: 'ambiguous_amount', message: 'three amounts; the first was read' }],
  },
];

/**
 * A `pool`-shaped wrapper over one client.
 *
 * Every function under test takes a `pool` and calls `pool.query`, so a Client
 * satisfies them directly — but `importStore.insertBatch` also calls
 * `pool.connect()` for its transaction. Handing back the same client keeps the
 * whole script inside the single outer transaction that gets rolled back; the
 * nested BEGIN/COMMIT are then no-ops on an open transaction, which Postgres
 * warns about and permits.
 */
function poolFor(client) {
  let depth = 0;
  return {
    query: (text, params) => client.query(text, params),
    connect: async () => ({
      /*
       * TRANSACTION CONTROL IS TRANSLATED TO SAVEPOINTS, and this is
       * load-bearing rather than tidiness. `importStore.insertBatch` runs its
       * own BEGIN/COMMIT so a batch and its rows land together. Passed through
       * verbatim inside this script's outer transaction, that COMMIT would
       * commit the OUTER one — and the script would leave its synthetic batches
       * behind in whatever database it was pointed at, which for a verifier is
       * the one unforgivable behaviour.
       *
       * As savepoints the nested semantics are preserved exactly (a failed
       * insert still rolls its own rows back) while the outer ROLLBACK remains
       * the only thing that decides what is kept: nothing.
       */
      query: (text, params) => {
        const verb = String(text).trim().toUpperCase();
        if (verb.startsWith('BEGIN')) {
          depth += 1;
          return client.query(`SAVEPOINT nested_${depth}`);
        }
        if (verb.startsWith('COMMIT')) {
          const at = depth;
          depth = Math.max(0, depth - 1);
          return client.query(`RELEASE SAVEPOINT nested_${at}`);
        }
        if (verb.startsWith('ROLLBACK')) {
          const at = depth;
          depth = Math.max(0, depth - 1);
          return client.query(`ROLLBACK TO SAVEPOINT nested_${at}`);
        }
        return client.query(text, params);
      },
      release: () => {},
    }),
  };
}

/** `withDb` in the shape the job expects, bound to one client. */
function withDbFor(client) {
  const pool = poolFor(client);
  return (fn) => fn(pool);
}

/**
 * The lifecycle, as a list of named steps.
 *
 * Each step runs the real function and asserts what the schema let through.
 * Ordered, because the whole point is that a batch moves through states the
 * CHECKs constrain — `target_check` only bites once a batch reaches 'posting',
 * and `posted_pair_check` only once something writes half of it.
 *
 * @param {import('pg').Client} client
 */
function steps(client) {
  const pool = poolFor(client);
  const withDb = withDbFor(client);
  /** Filled in by the first step and used by the rest. */
  const ctx = { batchId: null, rowIds: [] };

  const seedBatch = async () => {
    const stored = await importStore.insertBatch(
      pool,
      {
        office: OFFICE,
        filename: 'verify-synthetic.pdf',
        fileSha256: 'f'.repeat(64),
        fileSizeBytes: 123456,
        sourceType: 'pdf',
        status: 'parsed',
        warningCount: 1,
        warnings: [{ code: 'file_note', message: 'synthetic' }],
        failureReason: null,
        failureCode: null,
        createdBy: 'verify@carein.ai',
      },
      ROWS
    );
    ctx.batchId = stored.batch.batchId;
    ctx.rowIds = stored.rows.map((r) => r.rowId);
    if (stored.rows.length !== ROWS.length) throw new Error('rows did not come back');
  };

  return [
    { name: 'importStore.insertBatch (parsed, with rows)', run: seedBatch },

    {
      name: 'importStore.insertBatch (failed parse, zero rows)',
      run: async () => {
        // The other half of the insert path. `failed_no_rows_check` and
        // `failed_reason_check` only bite here.
        await importStore.insertBatch(
          pool,
          {
            office: OFFICE,
            filename: 'unreadable.pdf',
            fileSha256: 'e'.repeat(64),
            fileSizeBytes: 999,
            sourceType: 'pdf',
            status: 'failed',
            warningCount: 0,
            warnings: [],
            failureReason: 'No fee-shaped rows were found.',
            failureCode: 'NO_ROWS_PARSED',
            createdBy: 'verify@carein.ai',
          },
          []
        );
      },
    },

    {
      name: 'importStore.listBatches / getBatch / getBatchRows',
      run: async () => {
        await importStore.listBatches(pool, OFFICE, { limit: 50, offset: 0 });
        const b = await importStore.getBatch(pool, OFFICE, ctx.batchId);
        if (!b) throw new Error('getBatch returned nothing for a batch just inserted');
        const rows = await importStore.getBatchRows(pool, OFFICE, ctx.batchId);
        if (rows.length !== ROWS.length) throw new Error('getBatchRows lost rows');
      },
    },

    {
      name: 'route: decide a warned row (accepted)',
      run: async () => {
        // The route's own statement shape. Exercises decided_pair_check,
        // decided_by_check and the `edited_fee_cents` CASE.
        await pool.query(
          `UPDATE fees_import_row
              SET decision = $4,
                  edited_fee_cents = CASE WHEN $4 = 'edited' THEN $6::int ELSE NULL END,
                  decided_by = CASE WHEN $4 = 'pending' THEN NULL ELSE $5 END,
                  decided_at = CASE WHEN $4 = 'pending' THEN NULL ELSE now() END
            WHERE office = $1 AND batch_id = $2 AND row_id = $3`,
          [OFFICE, ctx.batchId, ctx.rowIds[2], 'accepted', 'verify@carein.ai', null]
        );
      },
    },
    {
      name: 'route: decide a warned row (edited, with a value)',
      run: async () => {
        // Both `edited` pair CHECKs, in the direction that stores a value.
        await pool.query(
          `UPDATE fees_import_row
              SET decision = $4,
                  edited_fee_cents = CASE WHEN $4 = 'edited' THEN $6::int ELSE NULL END,
                  decided_by = CASE WHEN $4 = 'pending' THEN NULL ELSE $5 END,
                  decided_at = CASE WHEN $4 = 'pending' THEN NULL ELSE now() END
            WHERE office = $1 AND batch_id = $2 AND row_id = $3`,
          [OFFICE, ctx.batchId, ctx.rowIds[2], 'edited', 'verify@carein.ai', 92000]
        );
      },
    },
    {
      name: 'route: re-decide clears the override',
      run: async () => {
        // The other direction of `edited_only_check`: moving off `edited` MUST
        // null the column, or the row becomes unstorable.
        await pool.query(
          `UPDATE fees_import_row
              SET decision = $4,
                  edited_fee_cents = CASE WHEN $4 = 'edited' THEN $6::int ELSE NULL END,
                  decided_by = CASE WHEN $4 = 'pending' THEN NULL ELSE $5 END,
                  decided_at = CASE WHEN $4 = 'pending' THEN NULL ELSE now() END
            WHERE office = $1 AND batch_id = $2 AND row_id = $3`,
          [OFFICE, ctx.batchId, ctx.rowIds[2], 'edited', 'verify@carein.ai', 92000]
        );
      },
    },

    {
      name: 'postJob.countBlockingRows / summarise',
      run: async () => {
        await postJob.countBlockingRows(pool, OFFICE, ctx.batchId);
        const counts = await postJob.summarise(pool, OFFICE, ctx.batchId);
        if (counts.total !== ROWS.length) throw new Error('summarise miscounted');
      },
    },

    {
      name: 'route: set the target, then promote to ready',
      run: async () => {
        await pool.query(
          `UPDATE fees_import_batch
              SET od_feesched_num = $3, od_feesched_desc = $4, od_feesched_is_new = $5,
                  updated_at = now()
            WHERE office = $1 AND batch_id = $2`,
          [OFFICE, ctx.batchId, FEESCHED, 'Synthetic verify schedule', false]
        );
        await pool.query(
          `UPDATE fees_import_batch
              SET status = 'ready', updated_at = now()
            WHERE office = $1 AND batch_id = $2 AND status = 'parsed'`,
          [OFFICE, ctx.batchId]
        );
      },
    },

    {
      // THE STATEMENT THAT BROKE PRODUCTION. Both halves of the claim, against
      // the real constraints.
      name: 'postJob.claimBatchForPosting (fresh, from ready)',
      run: async () => {
        const res = await postJob.claimBatchForPosting(
          pool,
          OFFICE,
          ctx.batchId,
          'verify@carein.ai'
        );
        if (!res.ok) throw new Error(`claim refused a ready batch: ${res.error}`);
        if (res.tookOver) throw new Error('a fresh claim reported a takeover');
        const check = await pool.query(
          'SELECT post_requested_by, posted_by, posted_at FROM fees_import_batch WHERE batch_id = $1',
          [ctx.batchId]
        );
        const b = check.rows[0];
        if (b.post_requested_by !== 'verify@carein.ai') {
          throw new Error('the claim did not record who asked for the post');
        }
        // The pair the old code broke. Postgres would have refused the row, but
        // assert it anyway so a future change that satisfies the CHECK by
        // writing BOTH halves early is caught here rather than by a reader
        // wondering why a running post has a completion time.
        if (b.posted_by !== null || b.posted_at !== null) {
          throw new Error('a claim must not write either half of the posted pair');
        }
      },
    },

    {
      name: 'postJob.claimBatchForPosting (stale takeover)',
      run: async () => {
        // Age the run past the threshold, then let a second actor take it over.
        await pool.query(
          `UPDATE fees_import_batch
              SET posting_started_at = now() - make_interval(secs => $2)
            WHERE batch_id = $1`,
          [ctx.batchId, postJob.STALE_POSTING_MS / 1000 + 60]
        );
        const res = await postJob.claimBatchForPosting(pool, OFFICE, ctx.batchId, 'other@carein.ai');
        if (!res.ok) throw new Error(`stale takeover refused: ${res.error}`);
        if (!res.tookOver) throw new Error('a stale claim did not report a takeover');
        const check = await pool.query(
          'SELECT post_requested_by FROM fees_import_batch WHERE batch_id = $1',
          [ctx.batchId]
        );
        if (check.rows[0].post_requested_by !== 'verify@carein.ai') {
          throw new Error('a takeover overwrote who authorised the post');
        }
      },
    },

    {
      name: 'postJob.ensureBackup (existing schedule)',
      run: async () => {
        /*
         * The one outbound read, stubbed on the module namespace. Restored in
         * the `finally` below so a later step cannot accidentally reach a
         * practice — and the value it returns is an empty schedule, which is a
         * VALID snapshot and the case that was wrongly suspected during the
         * incident.
         */
        const real = odFeesWrites.listFeesInSchedule;
        odFeesWrites.listFeesInSchedule = async () => ({ ok: true, fees: [], ignoredFilter: false });
        try {
          const res = await postJob.ensureBackup(
            pool,
            OFFICE,
            ctx.batchId,
            FEESCHED,
            false,
            'verify@carein.ai'
          );
          if (!res.ok || !res.taken) throw new Error('the backup was not stored');
        } finally {
          odFeesWrites.listFeesInSchedule = real;
        }
        const b = await pool.query(
          'SELECT row_count FROM fees_od_backup WHERE office = $1 AND batch_id = $2',
          [OFFICE, ctx.batchId]
        );
        if (b.rows.length !== 1) throw new Error('an empty schedule stored NO snapshot');
      },
    },
    {
      name: 'postJob.ensureBackup (idempotent on a resume)',
      run: async () => {
        const res = await postJob.ensureBackup(
          pool,
          OFFICE,
          ctx.batchId,
          FEESCHED,
          false,
          'verify@carein.ai'
        );
        if (!res.ok || res.taken) throw new Error('a second backup was taken');
      },
    },

    {
      name: 'postJob.recordWritten (row FeeNum + derived rows_written)',
      run: async () => {
        // Synthetic FeeNums. `rows_written` is derived from the rows, and
        // `rows_written_check` bounds it by row_count.
        for (const [i, rowId] of ctx.rowIds.entries()) {
          await postJob.recordWritten(pool, OFFICE, ctx.batchId, rowId, 800000 + i);
        }
        const b = await pool.query(
          'SELECT rows_written, row_count FROM fees_import_batch WHERE batch_id = $1',
          [ctx.batchId]
        );
        if (Number(b.rows[0].rows_written) !== ROWS.length) {
          throw new Error(`rows_written is ${b.rows[0].rows_written}, expected ${ROWS.length}`);
        }
      },
    },

    {
      name: 'postJob.getProgress',
      run: async () => {
        const p = await postJob.getProgress(pool, OFFICE, ctx.batchId);
        if (!p) throw new Error('getProgress returned nothing');
        if (p.requestedBy !== 'verify@carein.ai') {
          throw new Error('getProgress does not surface the requester');
        }
      },
    },

    {
      name: 'postJob.markFailed',
      run: async () => {
        // `post_failed_reason_check` refuses this status without a reason.
        await postJob.markFailed(pool, OFFICE, ctx.batchId, 'synthetic failure, for verification');
      },
    },

    {
      // THE PAIR, LANDING TOGETHER. The statement the fix depends on.
      name: 'postJob.markPosted',
      run: async () => {
        const res = await postJob.markPosted(pool, OFFICE, ctx.batchId, ['D9999']);
        if (res.rowsWritten !== ROWS.length) throw new Error('markPosted lost the count');
        const b = await pool.query(
          'SELECT posted_by, posted_at FROM fees_import_batch WHERE batch_id = $1',
          [ctx.batchId]
        );
        if (b.rows[0].posted_by !== 'verify@carein.ai') {
          throw new Error('the completed post was not attributed to the requester');
        }
        if (b.rows[0].posted_at === null) throw new Error('posted_at was not set');
      },
    },

    {
      name: 'rollback transitions (rows un-written, batch rolled_back, backup stamped)',
      run: async () => {
        for (const rowId of ctx.rowIds) {
          await pool.query(
            `UPDATE fees_import_row
                SET od_fee_num = NULL, written_at = NULL
              WHERE office = $1 AND batch_id = $2 AND row_id = $3`,
            [OFFICE, ctx.batchId, rowId]
          );
        }
        await pool.query(
          `UPDATE fees_import_batch b
              SET status = 'rolled_back',
                  rolled_back_at = now(),
                  rolled_back_by = $3,
                  rows_written = (
                    SELECT COUNT(*) FROM fees_import_row r
                     WHERE r.office = b.office AND r.batch_id = b.batch_id
                       AND r.od_fee_num IS NOT NULL
                  ),
                  updated_at = now()
            WHERE b.office = $1 AND b.batch_id = $2`,
          [OFFICE, ctx.batchId, 'verify@carein.ai']
        );
        await pool.query(
          `UPDATE fees_od_backup
              SET restored_at = now(), restored_by = $3, restore_note = $4
            WHERE office = $1 AND batch_id = $2`,
          [OFFICE, ctx.batchId, 'verify@carein.ai', 'synthetic restore note']
        );
      },
    },

    {
      name: 'every batch CHECK still holds at the end',
      run: async () => {
        // A final sweep: read the row back and confirm the state machine ended
        // somewhere the schema is content with. Postgres has already enforced
        // this on every statement above; this is the assertion that the END
        // state is coherent, not just each step.
        const b = await pool.query(
          `SELECT status, rows_written, row_count, od_feesched_num,
                  posted_by, posted_at, rolled_back_by, rolled_back_at, post_requested_by
             FROM fees_import_batch WHERE batch_id = $1`,
          [ctx.batchId]
        );
        const r = b.rows[0];
        if (r.status !== 'rolled_back') throw new Error(`ended at ${r.status}`);
        if ((r.posted_by === null) !== (r.posted_at === null)) {
          throw new Error('the posted pair is half-written');
        }
        if ((r.rolled_back_by === null) !== (r.rolled_back_at === null)) {
          throw new Error('the rolled-back pair is half-written');
        }
      },
    },
  ];
}

async function main() {
  const url = process.env.MIGRATE_TENANT_DB_URL || process.env.TENANT_DB_URL;
  if (!url) {
    console.error('[fees-verify-queries] set MIGRATE_TENANT_DB_URL to a MIGRATED tenant database');
    process.exit(2);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  const failures = [];
  let ran = 0;
  try {
    /*
     * ONE TRANSACTION, ALWAYS ROLLED BACK. Unlike the RCM sibling this script
     * really does write, so the rollback is not a precaution — it is what makes
     * the script safe to run against any migrated database and repeatable
     * without cleanup.
     *
     * NO SAVEPOINT PER STEP, deliberately. The steps are a sequence: a batch
     * that failed to claim cannot be marked posted, and letting later steps run
     * against a state an earlier one failed to produce would turn one real
     * failure into a page of misleading ones. The first failure stops the walk.
     */
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
    console.error(`\n[fees-verify-queries] ${failures.length} step(s) the schema refuses:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n[fees-verify-queries] ${ran} lifecycle step(s) accepted by the migrated schema`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[fees-verify-queries] failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { steps };
