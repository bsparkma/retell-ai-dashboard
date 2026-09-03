'use strict';

/*
 * THE STAGING RESET, AND THE THREE THINGS THAT WOULD MAKE IT DANGEROUS.
 *
 *   1. Reaching a database it must not reach.
 *   2. Taking the voice module's audit trail with it.
 *   3. Deleting a parent before its children and failing half way, or —
 *      worse — leaving a child that blocks the parent and reporting success.
 *
 * The FK order (3) is exercised for real against PostgreSQL in the rehearsal
 * recorded in `docs/RCM_POSTING.md` §10.8; what is pinned here is the STATIC
 * property that makes that rehearsal repeatable — every table appears before the
 * table it is a child of.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reset = require('../scripts/rcm/reset-staging-fixtures');

// ─────────────────────────────────────────────────────────────────────────────
// 1. The guard
// ─────────────────────────────────────────────────────────────────────────────

const STAGING_URL = 'postgres://u:p@psql-carein-staging.postgres.database.azure.com:5432/carein_t_x';
const PROD_URL = 'postgres://u:p@psql-carein-prod.postgres.database.azure.com:5432/carein_t_x';
const LOCAL_URL = 'postgres://u:p@127.0.0.1:5432/tenant';

/** @param {Record<string,string|undefined>} over */
const env = (over) => ({ RCM_RESET_ALLOW: 'staging', RCM_RESET_DB_URL: STAGING_URL, ...over });

/** @param {Record<string,string|undefined>} e @returns {string} the guard code */
function refusalCode(e) {
  try {
    reset.assertResetAllowed(e);
    return 'ALLOWED';
  } catch (err) {
    assert.ok(err instanceof reset.ResetGuardError, `expected a ResetGuardError, got ${err}`);
    return err.code;
  }
}

test('the guard allows staging, and a localhost rehearsal, and nothing else', () => {
  assert.equal(refusalCode(env({})), 'ALLOWED');
  assert.equal(refusalCode(env({ RCM_RESET_ALLOW: 'dev', RCM_RESET_DB_URL: LOCAL_URL })), 'ALLOWED');

  // No opt-in at all is a refusal — the script does nothing by accident.
  assert.equal(refusalCode(env({ RCM_RESET_ALLOW: undefined })), 'GUARD_NO_OPT_IN');
  assert.equal(refusalCode(env({ RCM_RESET_ALLOW: '' })), 'GUARD_NO_OPT_IN');
  // And there is deliberately no value that names production.
  assert.equal(refusalCode(env({ RCM_RESET_ALLOW: 'prod' })), 'GUARD_NO_OPT_IN');
  assert.equal(refusalCode(env({ RCM_RESET_ALLOW: 'production' })), 'GUARD_NO_OPT_IN');
});

test('a prod marker refuses UNCONDITIONALLY, whichever opt-in was given', () => {
  /*
   * This is the belt-and-braces check, and it is deliberately evaluated BEFORE
   * the per-mode rules. `RCM_RESET_ALLOW=staging` plus a prod host must not fall
   * through to "not a staging host" — the operator needs to be told they were
   * pointing at production, not that they had the wrong environment name.
   */
  assert.equal(refusalCode(env({ RCM_RESET_DB_URL: PROD_URL })), 'GUARD_PROD_DATABASE_URL');
  assert.equal(
    refusalCode(env({ RCM_RESET_ALLOW: 'dev', RCM_RESET_DB_URL: PROD_URL })),
    'GUARD_PROD_DATABASE_URL'
  );
  // The DATABASE name counts, not just the host.
  assert.equal(
    refusalCode(env({ RCM_RESET_DB_URL: 'postgres://u:p@somewhere-staging:5432/carein_prod' })),
    'GUARD_PROD_DATABASE_URL'
  );

  // And `prod` as a bare token or a dotted segment, not only hyphenated.
  assert.equal(reset.looksLikeProd('psql-carein-prod'), true);
  assert.equal(reset.looksLikeProd('prod'), true);
  assert.equal(reset.looksLikeProd('db.prod.internal'), true);
  // ...but not a word that merely contains the letters.
  assert.equal(reset.looksLikeProd('production-lookalike-prodigy'), false);
  assert.equal(reset.looksLikeProd('psql-carein-staging'), false);
});

test('NODE_ENV=production refuses, and a dev opt-in cannot leave the machine', () => {
  assert.equal(refusalCode(env({ NODE_ENV: 'production' })), 'GUARD_NODE_ENV_PRODUCTION');
  assert.equal(
    refusalCode(env({ RCM_RESET_ALLOW: 'dev', RCM_RESET_DB_URL: STAGING_URL })),
    'GUARD_DEV_REQUIRES_LOCAL'
  );
  assert.equal(
    refusalCode(env({ RCM_RESET_ALLOW: 'staging', RCM_RESET_DB_URL: LOCAL_URL })),
    'GUARD_STAGING_URL_MISMATCH'
  );
  assert.equal(refusalCode(env({ RCM_RESET_DB_URL: undefined })), 'GUARD_NO_DB_URL');
  assert.equal(refusalCode(env({ RCM_RESET_DB_URL: 'not a url' })), 'GUARD_UNPARSEABLE_DB_URL');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The audit trail
// ─────────────────────────────────────────────────────────────────────────────

test('the audit predicate ESCAPES the underscore, so `rcmXsomething` survives', () => {
  /*
   * `_` is a LIKE wildcard. `LIKE 'rcm_%'` unescaped matches `rcmXnotours` as
   * happily as `rcm_claim_match`, and a DELETE predicate that is wider than it
   * reads is the wrong kind of surprise. Proved live in the §10.8 rehearsal: an
   * audit row typed `rcmXnotours` survived the run.
   */
  assert.match(reset.AUDIT_RCM_PREDICATE, /ESCAPE/);
  const step = reset.DELETES.find((d) => d.table === 'audit_log');
  assert.ok(step, 'audit_log must be one of the steps');
  assert.match(step.sql, /ESCAPE/);
  // And it is scoped by resource_type at all — never a bare `ts <` sweep.
  assert.match(step.sql, /resource_type/);
});

test('audit_log is filtered by `ts`, not by `created_at` — it does not have one', () => {
  /*
   * `audit_log` predates the rcm_* schema and uses its own column name. Reaching
   * for `created_at` here is a 42703 raised half way through a transaction that
   * has already deleted twelve tables' worth of rows.
   */
  const step = reset.DELETES.find((d) => d.table === 'audit_log');
  assert.match(step.sql, /\bts\s*<\s*\$1/);
  assert.ok(!/created_at/.test(step.sql), 'audit_log has no created_at column');
});

test('every RCM resource_type is `rcm_`-prefixed, so the predicate reaches all of them', () => {
  /*
   * The reset's audit predicate is a PREFIX, so it is only correct while every
   * resource type the module writes carries that prefix. This scan is what turns
   * that from an assertion into a check.
   *
   * NOTE WHICH WAY THE FAILURE POINTS. A new unprefixed type makes the reset
   * LEAVE a row behind — never delete one it should not have. So this test going
   * red is a tidiness problem, not a safety one, and the fix is to prefix the
   * type rather than to widen the predicate.
   */
  const roots = ['routes/rcm', 'services/rcm'].map((p) => path.join(__dirname, '..', p));
  /** @type {string[]} */
  const unprefixed = [];
  let seen = 0;
  for (const root of roots) {
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
      const src = fs.readFileSync(path.join(root, name), 'utf8');
      for (const m of src.matchAll(/resource_?[Tt]ype:\s*'([a-z0-9_]+)'/g)) {
        seen += 1;
        if (!m[1].startsWith('rcm_')) unprefixed.push(`${name} → ${m[1]}`);
      }
    }
  }
  assert.ok(seen > 10, `expected to find RCM resource types, found ${seen} — has the scan drifted?`);
  assert.deepEqual(
    unprefixed,
    [],
    'an RCM audit resource_type without the `rcm_` prefix is invisible to the reset. Found: ' +
      unprefixed.join(', ')
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The order
// ─────────────────────────────────────────────────────────────────────────────

test('children are deleted before their parents, on every RESTRICT edge', () => {
  /*
   * The schema's RESTRICT edges are deliberate — "a claim with money posted
   * against it must not be deletable", the same stance Open Dental takes. They
   * are also what makes the order load-bearing rather than cosmetic: get it
   * wrong and statement N fails against a live database.
   *
   * Each pair below is [child, parent] read off `1786622400000_rcm_schema.js`.
   */
  const order = reset.DELETES.map((d) => d.table);
  const EDGES = [
    ['rcm_posting_queue_line', 'rcm_posting_queue'],
    ['rcm_posting_queue_line', 'rcm_claims'],
    ['rcm_posting_queue_line', 'rcm_batch_claim_payments'],
    ['rcm_posting_queue', 'rcm_payment_batches'],
    ['rcm_claim_payment_history', 'rcm_claims'],
    ['rcm_claim_payment_history', 'rcm_payment_batches'],
    ['rcm_batch_claim_payments', 'rcm_claims'],
    ['rcm_batch_claim_payments', 'rcm_payment_batches'],
    ['rcm_posting_audits', 'rcm_payment_batches'],
    ['rcm_procedure_adjustments', 'rcm_procedure_lines'],
    ['rcm_procedure_lines', 'rcm_claims'],
    ['rcm_activity_events', 'rcm_claims'],
    ['rcm_eob_uploads', 'rcm_payment_batches'],
    ['rcm_remittance_keys', 'rcm_payment_batches'],
  ];
  for (const [child, parent] of EDGES) {
    const c = order.indexOf(child);
    const p = order.indexOf(parent);
    assert.ok(c !== -1, `${child} is not in the delete list`);
    assert.ok(p !== -1, `${parent} is not in the delete list`);
    assert.ok(c < p, `${child} must be deleted before ${parent} (got ${c} then ${p})`);
  }
});

test('the claims/queue CYCLE is broken by an UPDATE before anything is deleted', () => {
  /*
   * FOUND BY THE FIRST LIVE RUN, 2026-09-01, and missed by the rehearsal before
   * it — the fixture never set `posting_queue_id`, so the edge existed in the
   * schema and not in the data. A fixture that does not exercise an edge proves
   * nothing about it.
   *
   * `rcm_posting_queue_line.claim_id -> rcm_claims` is RESTRICT and
   * `rcm_claims.posting_queue_id -> rcm_posting_queue` is ALSO RESTRICT. No
   * ordering of pure DELETEs satisfies both, so the back-reference is nulled
   * first — inside the same transaction, so a later failure rolls it back too.
   */
  assert.equal(reset.CYCLE_BREAKS.length, 1);
  const [step] = reset.CYCLE_BREAKS;
  assert.equal(step.table, 'rcm_claims');
  assert.match(step.sql, /^UPDATE rcm_claims/);
  assert.ok(!/DELETE/i.test(step.sql), 'a cycle break must not delete anything');

  /*
   * And it must null ALL THREE columns. `rcm_claims_approval_check` holds
   * `posting_queue_id`, `approved_at` and `approved_by` as one unit, so nulling
   * only the FK raises a CHECK violation — the second thing the rehearsal found.
   */
  for (const col of ['posting_queue_id', 'approved_at', 'approved_by']) {
    assert.ok(step.sql.includes(col + ' = NULL'), col + ' must be nulled too');
  }
});

test('rcm_posting_document is counted, not silently cascaded away', () => {
  /*
   * It CASCADEs from `rcm_posting_queue`, so it never blocked anything — and it
   * was missing from the count list entirely until the first live run against
   * staging listed the live tables. Rows that vanish without being reported are
   * the one thing a before/after table exists to prevent.
   */
  assert.ok(reset.ALL_RCM_TABLES.includes('rcm_posting_document'));
  assert.ok(reset.DELETE_TABLES.includes('rcm_posting_document'));
  const order = reset.DELETES.map((d) => d.table);
  assert.ok(
    order.indexOf('rcm_posting_document') < order.indexOf('rcm_posting_queue'),
    'name it before its parent cascades it away uncounted'
  );
});

test('the remittance keys go, or the reseed upload would be refused by a row pointing at nothing', () => {
  /*
   * `rcm_remittance_keys` is UNIQUE (office_id, remittance_key) and its FK to the
   * batch is SET NULL — so deleting the remittance leaves the KEY behind, still
   * unique, still blocking. Re-uploading the same synthetic 835 would then be
   * refused by a row that points at nothing, which reads on the screen as the app
   * being broken.
   */
  assert.ok(reset.DELETE_TABLES.includes('rcm_remittance_keys'));
});

/**
 * The script with its comments stripped.
 *
 * The same treatment `rcmNoOdWrites.test.js` gives every file it scans, and for
 * the same reason: this script's header EXPLAINS at length why it names no
 * Open Dental client and never TRUNCATEs, so a scan over the raw bytes would
 * find every forbidden token in the prose that documents its absence.
 */
function scriptCode(relative) {
  return fs
    .readFileSync(path.join(__dirname, '..', 'scripts', 'rcm', relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('nothing here can reach Open Dental, and requiring it deletes nothing', () => {
  const src = scriptCode('reset-staging-fixtures.js');
  // No office handle, no client, no write verb of any kind.
  for (const forbidden of [
    'odOffices',
    'apiWriteRaw',
    'apiGetRaw',
    'openDental',
    'axios',
    'getOdOffice',
  ]) {
    assert.ok(!src.includes(forbidden), `the reset must not name ${forbidden}`);
  }
  // And it must not self-execute on import.
  assert.match(src, /require\.main\s*===\s*module/);
});

test('it is DDL-free and never TRUNCATEs', () => {
  const src = scriptCode('reset-staging-fixtures.js');
  /*
   * A TRUNCATE would take TODAY's rows with it and would bypass the RESTRICT
   * edges the ordered statements exist to respect one at a time. Schema and
   * migrations are explicitly out of scope.
   */
  for (const forbidden of ['TRUNCATE', 'DROP TABLE', 'ALTER TABLE', 'pgmigrations']) {
    assert.ok(!src.toUpperCase().includes(forbidden.toUpperCase()), `the reset must not name ${forbidden}`);
  }
});

test('the dry run is the default, and it rolls back', async () => {
  /*
   * A dry run that only printed SQL would tell an operator nothing about whether
   * statement 5 was going to fail. This one runs all thirteen inside a
   * transaction and rolls back, so its counts are MEASURED.
   */
  assert.equal(reset.parseArgs([]).execute, false);
  assert.equal(reset.parseArgs(['--dry-run']).execute, false);
  assert.equal(reset.parseArgs(['--execute']).execute, true);
  assert.throws(() => reset.parseArgs(['--force']), /unknown argument/);

  /** A fake database that records the statements it is given. */
  const seen = [];
  const db = {
    async query(sql, params) {
      seen.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (sql.includes('has_table_privilege')) {
        return {
          rows: reset.DELETE_TABLES.map((t) => ({ table_name: t, can_delete: true, can_update: true })),
          rowCount: 0,
        };
      }
      if (sql.includes('date_trunc')) return { rows: [{ cutoff: new Date('2026-09-01T05:00:00Z') }], rowCount: 0 };
      if (sql.includes('count(*)')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };

  await reset.runReset(db, { execute: false, timezone: 'America/Chicago' });
  assert.ok(seen.includes('ROLLBACK'), 'a dry run must roll back');
  assert.ok(!seen.includes('COMMIT'), 'a dry run must not commit');

  seen.length = 0;
  await reset.runReset(db, { execute: true, timezone: 'America/Chicago' });
  assert.ok(seen.includes('COMMIT'), '--execute must commit');
});

test('the privilege check refuses BEFORE the first delete, naming the table and the role', async () => {
  /*
   * `audit_log` is append-only to `carein_app` by design. A run as that role
   * would clear every rcm_* row and then fail on the last statement with a
   * 42501. One transaction means it all rolls back — but the operator deserves a
   * sentence rather than a Postgres error code, and it should arrive before the
   * expensive part starts.
   *
   * Confirmed live in the §10.8 rehearsal against a real `carein_app` role.
   */
  const seen = [];
  const db = {
    async query(sql) {
      seen.push(sql.trim().split(/\s+/)[0]);
      if (sql.includes('has_table_privilege')) {
        return {
          rows: reset.DELETE_TABLES.map((t) => ({
            table_name: t,
            can_delete: t !== 'audit_log',
            can_update: true,
          })),
          rowCount: 0,
        };
      }
      if (sql.includes('current_user')) return { rows: [{ role: 'carein_app' }], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(
    () => reset.runReset(db, { execute: true, timezone: 'America/Chicago' }),
    (err) => {
      assert.equal(err.code, 'GUARD_NO_DELETE_PRIVILEGE');
      assert.match(err.message, /audit_log/);
      assert.match(err.message, /carein_app/);
      assert.match(err.message, /carein_owner/);
      assert.match(err.message, /Nothing has been deleted/);
      return true;
    }
  );
  assert.ok(!seen.includes('BEGIN'), 'the refusal must come before the transaction opens');
  assert.ok(!seen.includes('DELETE'), 'and before any delete');
});

test('the count report covers every rcm_* table, including the ones it does not delete', () => {
  /*
   * Reporting more than it removes is deliberate. `rcm_stedi_*`, the bank
   * transactions and the deposit tables survive a run — none of them is
   * remittance debris — and an operator reading "0 rows everywhere" would
   * reasonably conclude the database was empty when it is not.
   */
  for (const t of reset.DELETE_TABLES) {
    if (t === 'audit_log') continue;
    assert.ok(reset.ALL_RCM_TABLES.includes(t), `${t} is deleted from but never counted`);
  }
  for (const t of ['rcm_bank_transactions', 'rcm_stedi_transactions', 'rcm_handoff_tasks']) {
    assert.ok(reset.ALL_RCM_TABLES.includes(t), `${t} should be counted`);
    assert.ok(!reset.DELETE_TABLES.includes(t), `${t} is out of scope and must not be deleted`);
  }
});

test('formatCounts prints no `after` column on a dry run that measured none', () => {
  const before = { rcm_claims: 3, rcm_payment_batches: 1 };
  const dry = reset.formatCounts(before, null);
  assert.ok(dry.includes('before'));
  assert.ok(!dry.includes('after'), 'an after column nobody measured would be a fabrication');
  const wet = reset.formatCounts(before, { rcm_claims: 0, rcm_payment_batches: 0 });
  assert.ok(wet.includes('after'));
});
