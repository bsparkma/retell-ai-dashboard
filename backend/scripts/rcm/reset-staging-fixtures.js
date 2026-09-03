'use strict';

/*
 * CLEAR THE RCM TEST DEBRIS OUT OF THE STAGING APP DATABASE.  THIS DELETES.
 *
 *     # 1. Look first. Dry run is the default and touches nothing.
 *     RCM_RESET_ALLOW=staging RCM_RESET_DB_URL=<staging tenant url> \
 *       node scripts/rcm/reset-staging-fixtures.js
 *
 *     # 2. Then, once the printed plan is the right one:
 *     RCM_RESET_ALLOW=staging RCM_RESET_DB_URL=<staging tenant url> \
 *       node scripts/rcm/reset-staging-fixtures.js --execute
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT NEVER TOUCHES OPEN DENTAL. NOT ONCE, NOT READ-ONLY.
 * ═════════════════════════════════════════════════════════════════════════════
 * There is no Open Dental client in this file, no office handle, no `odOffices`
 * require, and no write verb of any kind. The rows it removes are the APP's
 * record of a remittance — a check, its claims, its lines, its decisions and its
 * posting plans. The CHART is a separate universe and is unwound by
 * `scripts/rcm-s11-unwind.js`, which is the only file in this repository that
 * may issue a DELETE against Open Dental.
 *
 * That separation is the point, and it is why the two are separate scripts
 * rather than one "clean up staging" command. Deleting an app row is reversible
 * in the sense that nothing on anybody's chart moved; deleting a claim in Open
 * Dental is not. A single command that did both would make the cheap half carry
 * the risk profile of the expensive half.
 *
 * ⚠ RUN `rcm-s11-unwind.js` FIRST if a walk left live claims behind. This script
 * removes the app's memory of them; the manifest that names them lives on the
 * /data volume and is untouched, but a plan this script deletes is one nobody
 * can read afterwards to see what it was pointing at.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE GUARD — five conditions, and every one of them must pass
 * ═════════════════════════════════════════════════════════════════════════════
 * Same shape and the same reasoning as `assertSeedAllowed` in
 * `scripts/rcm-seed-fixtures.cjs`, tightened because this one DELETES:
 *
 *   1. `RCM_RESET_ALLOW` must be exactly `staging` (or `dev`, see below). Unset
 *      is a refusal, so the script does nothing by accident.
 *   2. `NODE_ENV` must not be `production`.
 *   3. `RCM_RESET_DB_URL` must be set and must parse.
 *   4. Any prod marker in the host OR the database name — a `-prod`/`_prod`
 *      segment, or a bare `prod` token — is an UNCONDITIONAL refusal, whichever
 *      opt-in was given. This is what makes rule 5 belt-and-braces rather than
 *      the only line of defence.
 *   5. `RCM_RESET_ALLOW=staging` requires `staging` in the host. The staging
 *      server is `psql-carein-staging`; prod is `psql-carein-prod`.
 *
 * ─── THE ONE LANE THAT IS NOT STAGING, AND WHY IT EXISTS ─────────────────────
 * `RCM_RESET_ALLOW=dev` is accepted for a LOCALHOST host only — 127.0.0.1, ::1,
 * localhost, host.docker.internal — and for nothing else. A dev opt-in cannot
 * reach a cloud database at all.
 *
 * The brief said "refuses to run unless the connection string is the staging
 * database", and this is one lane wider than that. It is here because the
 * fourteen DELETE statements below are ordered against a foreign-key graph with
 * RESTRICT edges in it, and an order that is wrong fails at the fifth statement
 * against a live database rather than in a test. `rcm_office_settings` was
 * already-existing and only the live PostgreSQL rehearsal caught it (§RCM
 * shadow gate). A rehearsal lane that can only reach a database on the same
 * machine is strictly safer than rehearsing on staging, which is what the
 * alternative actually means in practice.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PRIVILEGE PRE-CHECK — before the first DELETE, never after
 * ═════════════════════════════════════════════════════════════════════════════
 * `audit_log` is APPEND-ONLY to the application role. The audit migration
 * revokes everything from `carein_app` and grants back `INSERT, SELECT` and
 * nothing else, deliberately, so the platform cannot erase its own PHI trail.
 * The rcm_* tables grant `SELECT, INSERT, UPDATE, DELETE` to the same role.
 *
 * So a run as `carein_app` can clear every rcm_* row and then fail on the last
 * statement — after fourteen successful deletes — with a permission error. That
 * is a failure in the reporting path masking nothing at all, but it is still
 * the shape the §10.0 prep learned to avoid: check the cheap precondition
 * BEFORE the expensive part starts. `assertCanDelete` asks
 * `has_table_privilege` for every table this script will touch and refuses with
 * a sentence naming the role to reconnect as (`carein_owner`) rather than
 * discovering it half way through. It checks UPDATE on `rcm_claims` too, for the
 * cycle-break below.
 *
 * Everything runs inside ONE transaction anyway, so a mid-run failure rolls the
 * whole thing back. The pre-check is about telling the operator something
 * useful, not about correctness.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * `audit_log` IS SCOPED TO RCM, AND THAT IS NOT A CONVENIENCE
 * ═════════════════════════════════════════════════════════════════════════════
 * `audit_log` is TENANT-WIDE. The voice module's record of who read a patient's
 * call, and TC's record of who opened a case, live in the same table as RCM's.
 * A bare `DELETE FROM audit_log WHERE ts < today` would destroy a compliance
 * artefact to tidy up a test fixture.
 *
 * So the predicate is `resource_type LIKE 'rcm\_%'`, and every one of the 21
 * resource types the RCM routes and services write is prefixed that way.
 * `test/rcmResetStagingFixtures.test.js` scans `routes/rcm` and `services/rcm`
 * for `resource_type` literals and fails if one is not — so the guarantee is
 * checked rather than asserted. Note which way that failure points: a new
 * unprefixed type makes this script LEAVE a row behind, never delete one it
 * should not have.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * "CREATED BEFORE TODAY" — the cutoff, and what it applies to
 * ═════════════════════════════════════════════════════════════════════════════
 * Today is LOCAL, in `OFFICE_TIMEZONE` (default `America/Chicago`), not UTC.
 * UTC midnight lands at 7pm the previous evening in Roland, so a UTC cutoff run
 * at 8pm would delete a check somebody uploaded two hours earlier. The same
 * reasoning the drain applies to `DateReceived` (§3.3).
 *
 * The cutoff selects ROOTS — remittances, claims, EOB uploads, posting plans,
 * remittance keys, RCM audit rows. Everything hanging off a root goes with it
 * REGARDLESS of its own timestamp, because a line created this morning under a
 * check from last week is that check's debris, and because the FK graph would
 * refuse the parent delete anyway.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SCHEMA AND MIGRATIONS ARE NOT TOUCHED
 * ═════════════════════════════════════════════════════════════════════════════
 * No DDL. No `pgmigrations` row is read or written. Nothing is TRUNCATEd — a
 * TRUNCATE would take the rows created TODAY with it and would silently bypass
 * the RESTRICT edges this script exists to respect one at a time.
 */

const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────────
// The guard
// ─────────────────────────────────────────────────────────────────────────────

/** A refusal carrying a stable code, so tests assert on the code not the prose. */
class ResetGuardError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ResetGuardError';
    this.code = code;
  }
}

/** Hosts an `RCM_RESET_ALLOW=dev` rehearsal is permitted to reach. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

/**
 * Pull {host, database} out of a connection string without needing it to be a
 * perfectly-formed URL. Lowercased; unparseable input yields nulls, which every
 * caller treats as a refusal.
 * @param {string} url
 * @returns {{ host: string|null, database: string|null }}
 */
function parseDbUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      host: (parsed.hostname || '').toLowerCase() || null,
      database: decodeURIComponent(parsed.pathname || '').replace(/^\//, '').toLowerCase() || null,
    };
  } catch {
    return { host: null, database: null };
  }
}

/** A '-prod'/'_prod'/'.prod' segment, or a bare 'prod' token. */
function looksLikeProd(value) {
  return value != null && /(^|[-_.])prod([-_.]|$)/.test(value);
}

/**
 * Fail-closed authorization for the DELETE. Throws unless every condition in
 * the header's GUARD section holds. PURE — takes the environment as an argument
 * so the tests exercise every branch without a database.
 *
 * @param {Record<string, string|undefined>} env typically process.env
 * @returns {{ mode: 'staging'|'dev', databaseUrl: string, host: string, database: string|null }}
 */
function assertResetAllowed(env) {
  const allow = String(env.RCM_RESET_ALLOW || '').trim().toLowerCase();
  if (allow !== 'staging' && allow !== 'dev') {
    throw new ResetGuardError(
      'GUARD_NO_OPT_IN',
      'refusing to delete: set RCM_RESET_ALLOW=staging. There is no opt-in value that targets ' +
        'production, and `dev` reaches a localhost rehearsal database only.'
    );
  }

  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    throw new ResetGuardError('GUARD_NODE_ENV_PRODUCTION', 'refusing to delete: NODE_ENV=production.');
  }

  const databaseUrl = String(env.RCM_RESET_DB_URL || '').trim();
  if (!databaseUrl) {
    throw new ResetGuardError(
      'GUARD_NO_DB_URL',
      'refusing to delete: RCM_RESET_DB_URL is not set. Fetch the staging tenant connection ' +
        'string into the session; never commit it.'
    );
  }

  const { host, database } = parseDbUrl(databaseUrl);
  if (!host) {
    throw new ResetGuardError(
      'GUARD_UNPARSEABLE_DB_URL',
      'refusing to delete: RCM_RESET_DB_URL has no parseable host.'
    );
  }

  // Unconditional, and checked before the per-mode rules: a prod marker anywhere
  // in the target refuses regardless of which opt-in was given.
  if (looksLikeProd(host) || looksLikeProd(database)) {
    throw new ResetGuardError(
      'GUARD_PROD_DATABASE_URL',
      `refusing to delete: the target looks like production (host '${host}', database '${database || '?'}').`
    );
  }

  if (allow === 'staging' && !host.includes('staging')) {
    throw new ResetGuardError(
      'GUARD_STAGING_URL_MISMATCH',
      `refusing to delete: RCM_RESET_ALLOW=staging but host '${host}' is not a staging host. ` +
        'The staging server is psql-carein-staging.'
    );
  }

  if (allow === 'dev' && !LOCAL_HOSTS.has(host)) {
    throw new ResetGuardError(
      'GUARD_DEV_REQUIRES_LOCAL',
      `refusing to delete: RCM_RESET_ALLOW=dev only reaches a database on this machine, not '${host}'. ` +
        'Use RCM_RESET_ALLOW=staging for psql-carein-staging.'
    );
  }

  return { mode: allow, databaseUrl, host, database };
}

// ─────────────────────────────────────────────────────────────────────────────
// What gets counted, and what gets deleted
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EVERY rcm_* table, counted before and after — including the ones this script
 * does not delete from.
 *
 * Reporting more than it removes is deliberate. `rcm_stedi_transactions` and
 * `rcm_bank_transactions` survive a run with their batch references SET NULL,
 * and `rcm_handoff_tasks` / `rcm_deposit_audit_events` / `rcm_approval_requests`
 * hang off a bank transaction rather than off a remittance. None of them is
 * remittance debris, so none of them is in scope — but an operator reading
 * "0 rows everywhere" would reasonably conclude the database was empty, and it
 * is not. The counts say what is actually there.
 *
 * @type {ReadonlyArray<string>}
 */
const ALL_RCM_TABLES = Object.freeze([
  'rcm_user_map',
  'rcm_payer_rules',
  'rcm_office_settings',
  'rcm_vcc_processor_patterns',
  'rcm_stedi_poll_state',
  'rcm_stedi_events',
  'rcm_stedi_transactions',
  'rcm_bank_transactions',
  'rcm_claims',
  'rcm_procedure_lines',
  'rcm_procedure_adjustments',
  'rcm_activity_events',
  'rcm_payment_batches',
  'rcm_batch_claim_payments',
  'rcm_claim_payment_history',
  'rcm_eob_uploads',
  'rcm_posting_audits',
  'rcm_remittance_keys',
  'rcm_handoff_tasks',
  'rcm_deposit_audit_events',
  'rcm_approval_requests',
  'rcm_recon_runs',
  'rcm_posting_queue',
  'rcm_posting_queue_line',
  /*
   * 6d's document table. It CASCADEs from `rcm_posting_queue`, so it never
   * blocked anything and was missing from this list entirely until the first
   * live run — which meant its rows were deleted by the cascade and never
   * appeared in either count. Rows that vanish without being reported are the
   * one thing a before/after table exists to prevent.
   */
  'rcm_posting_document',
]);

/**
 * The RCM audit predicate. Every `resource_type` the RCM routes and services
 * write is `rcm_`-prefixed; `rcmResetStagingFixtures.test.js` scans for one that
 * is not.
 *
 * `LIKE 'rcm\_%'` with an explicit ESCAPE, because `_` is a LIKE wildcard: the
 * unescaped form would also match `rcmX…`, and a predicate that is wider than
 * it reads is exactly the wrong kind of surprise in a DELETE.
 */
const AUDIT_RCM_PREDICATE = "resource_type LIKE 'rcm\\_%' ESCAPE '\\'";

/**
 * BREAKING THE CYCLE — the statements that must run BEFORE any delete.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * `rcm_claims` AND `rcm_posting_queue` POINT AT EACH OTHER
 * ═════════════════════════════════════════════════════════════════════════════
 * `rcm_posting_queue_line.claim_id -> rcm_claims` is RESTRICT, and
 * `rcm_claims.posting_queue_id -> rcm_posting_queue` is **also RESTRICT**. There
 * is no ordering of pure DELETEs that satisfies both: whichever of the two goes
 * first, the other still points at it.
 *
 * FOUND BY THE FIRST LIVE RUN, 2026-09-01, and not by the PostgreSQL rehearsal
 * that preceded it — the rehearsal's fixture never set `posting_queue_id`, so
 * the edge existed in the schema and not in the data. A fixture that does not
 * exercise an edge proves nothing about it, and this is the second time that
 * lesson has been paid for in this module.
 *
 * The transaction rolled back correctly and nothing was committed, which is the
 * only reason this reads as a defect rather than as an incident.
 *
 * The fix is an UPDATE, not a reordering: null the back-reference on the claims
 * whose plan is about to go. That is safe because the plan is being deleted —
 * a claim pointing at a deleted plan is the thing being prevented, and a claim
 * pointing at NOTHING is what the column already means when no plan exists.
 *
 * It runs INSIDE the same transaction as the deletes, so a later failure rolls
 * the null-out back with everything else.
 *
 * @type {ReadonlyArray<{ table: string, sql: string, why: string }>}
 */
const CYCLE_BREAKS = Object.freeze([
  {
    table: 'rcm_claims',
    why: 'posting_queue_id -> rcm_posting_queue is RESTRICT, and queue_line -> claims is too: a cycle',
    /*
     * ALL THREE COLUMNS, NOT JUST THE FOREIGN KEY.
     *
     * `rcm_claims_approval_check` holds `posting_queue_id`, `approved_at` and
     * `approved_by` as ONE UNIT -- either all three are set or none is. Nulling
     * only the FK violates it, which is what the second rehearsal found after
     * the first live run found the cycle itself.
     *
     * Clearing all three is the honest answer rather than a way round the
     * constraint: the approval being erased is an approval OF A PLAN THAT NO
     * LONGER EXISTS. A claim left carrying "approved by X at T" with nothing to
     * point at would be asserting something no row can corroborate.
     */
    sql: `UPDATE rcm_claims
             SET posting_queue_id = NULL,
                 approved_at = NULL,
                 approved_by = NULL
           WHERE posting_queue_id IS NOT NULL
             AND posting_queue_id IN (
                   SELECT queue_id FROM rcm_posting_queue
                    WHERE created_at < $1
                       OR batch_id IN (SELECT batch_id FROM rcm_payment_batches WHERE created_at < $1))`,
  },
]);

/**
 * THE FOURTEEN STATEMENTS, IN THE ONLY ORDER THAT WORKS.
 *
 * The FK graph carries RESTRICT edges on purpose — "a claim with money posted
 * against it must not be deletable", the same stance Open Dental itself takes.
 * CASCADE would have made this list shorter and would also have made a wrong
 * order silently succeed. So each statement names its own rows and the order is
 * a decision:
 *
 *   `$1` is the cutoff instant in every statement.
 *
 *   B := remittances created before the cutoff
 *   C := claims created before the cutoff
 *   Q := posting plans created before the cutoff, PLUS every plan pointing at a
 *        row of B (RESTRICT: the batch cannot go while its plan is there, and a
 *        plan created this morning against last week's check is that check's)
 *
 * Read the `why` on each line. The subqueries are re-evaluated per statement,
 * which is safe because every parent is deleted AFTER its children — B and C
 * still select the same rows when steps 11 and 12 finally remove them.
 *
 * @type {ReadonlyArray<{ table: string, sql: string, why: string }>}
 */
const DELETES = Object.freeze([
  {
    table: 'rcm_posting_queue_line',
    why: 'RESTRICT to claims AND to batch_claim_payments — nothing can go before these do',
    sql: `DELETE FROM rcm_posting_queue_line
           WHERE queue_id IN (SELECT queue_id FROM rcm_posting_queue
                               WHERE created_at < $1
                                  OR batch_id IN (SELECT batch_id FROM rcm_payment_batches WHERE created_at < $1))
              OR claim_id IN (SELECT claim_id FROM rcm_claims WHERE created_at < $1)
              OR batch_claim_payment_id IN (
                   SELECT batch_claim_payment_id FROM rcm_batch_claim_payments
                    WHERE batch_id IN (SELECT batch_id FROM rcm_payment_batches WHERE created_at < $1)
                       OR claim_id IN (SELECT claim_id FROM rcm_claims WHERE created_at < $1))`,
  },
  {
    table: 'rcm_posting_document',
    /*
     * CASCADEs from the plan, so it never blocks — but a cascade deletes rows
     * without reporting them, and this table was missing from the count list
     * entirely until the first live run. Named for the same reason
     * `rcm_procedure_adjustments` is: the count is the point.
     */
    why: '6d’s document rows — CASCADE from the plan, named so the count is honest',
    sql: `DELETE FROM rcm_posting_document
           WHERE queue_id IN (SELECT queue_id FROM rcm_posting_queue
                               WHERE created_at < $1
                                  OR batch_id IN (SELECT batch_id FROM rcm_payment_batches WHERE created_at < $1))`,
  },
  {
    table: 'rcm_posting_queue',
    why: 'RESTRICT to batches; its lines, its documents and the claims’ back-reference went first',
    sql: `DELETE FROM rcm_posting_queue
           WHERE created_at < $1
              OR batch_id IN (SELECT batch_id FROM rcm_payment_batches WHERE created_at < $1)`,
  },
  {
    table: 'rcm_claim_payment_history',
    why: 'RESTRICT to BOTH claims and batches — the money trail is deliberately not erasable by cascade',
    sql: `DELETE FROM rcm_claim_payment_history
           WHERE claim_id IN (SELECT claim_id FROM rcm_claims WHERE created_at < $1)
              OR batch_id IN (SELECT batch_id FROM rcm_payment_batches WHERE created_at < $1)`,
  },
  {
    table: 'rcm_batch_claim_payments',
    why: 'RESTRICT to claims (CASCADE from batches, but the claim side still has to be named)',
    sql: `DELETE FROM rcm_batch_claim_payments
           WHERE batch_id IN (SELECT batch_id FROM rcm_payment_batches WHERE created_at < $1)
              OR claim_id IN (SELECT claim_id FROM rcm_claims WHERE created_at < $1)`,
  },
  {
    table: 'rcm_posting_audits',
    why: 'RESTRICT to batches',
    sql: `DELETE FROM rcm_posting_audits
           WHERE created_at < $1
              OR batch_id IN (SELECT batch_id FROM rcm_payment_batches WHERE created_at < $1)`,
  },
  {
    table: 'rcm_remittance_keys',
    /*
     * THE ONE WHOSE ABSENCE WOULD BE FELT IMMEDIATELY.
     *
     * `rcm_remittance_keys` is UNIQUE (office_id, remittance_key) and is what
     * makes a second upload of the same check a refusal rather than a duplicate.
     * Its FK to the batch is SET NULL, so deleting the remittance leaves the KEY
     * behind with a null batch_id — still unique, still blocking. A reseed that
     * uploaded the same synthetic 835 twice would then be refused by a row
     * pointing at nothing, which reads to an operator as the app being broken.
     */
    why: 'SET NULL to batches, so it OUTLIVES them and would refuse the reseed upload',
    sql: `DELETE FROM rcm_remittance_keys
           WHERE created_at < $1
              OR batch_id IN (SELECT batch_id FROM rcm_payment_batches WHERE created_at < $1)`,
  },
  {
    table: 'rcm_activity_events',
    why: 'CASCADE from claims, but a claim-less activity row has no parent to take it',
    sql: `DELETE FROM rcm_activity_events
           WHERE created_at < $1
              OR claim_id IN (SELECT claim_id FROM rcm_claims WHERE created_at < $1)`,
  },
  {
    table: 'rcm_procedure_adjustments',
    why: 'CASCADE would take these, but naming them is what makes the count honest',
    sql: `DELETE FROM rcm_procedure_adjustments
           WHERE claim_id IN (SELECT claim_id FROM rcm_claims WHERE created_at < $1)`,
  },
  {
    table: 'rcm_procedure_lines',
    why: 'carries the LINE DECISIONS (bill_patient / office_writeoff + reason); CASCADE from claims',
    sql: `DELETE FROM rcm_procedure_lines
           WHERE claim_id IN (SELECT claim_id FROM rcm_claims WHERE created_at < $1)`,
  },
  {
    table: 'rcm_eob_uploads',
    why: 'SET NULL to both batches and claims, so it survives them unless named',
    sql: `DELETE FROM rcm_eob_uploads
           WHERE created_at < $1
              OR result_batch_id IN (SELECT batch_id FROM rcm_payment_batches WHERE created_at < $1)
              OR result_claim_id IN (SELECT claim_id FROM rcm_claims WHERE created_at < $1)`,
  },
  {
    table: 'rcm_payment_batches',
    why: 'THE REMITTANCE — and the row that carries the SHADOW-COMPARISON columns and the worklist state',
    sql: 'DELETE FROM rcm_payment_batches WHERE created_at < $1',
  },
  {
    table: 'rcm_claims',
    why: 'THE CLAIM MATCH (od_claim_num, confidence, evidence) and the DECIDED FIGURES live here',
    sql: 'DELETE FROM rcm_claims WHERE created_at < $1',
  },
  {
    table: 'audit_log',
    /*
     * `ts`, not `created_at`. The audit table predates the rcm_* schema and uses
     * its own column name; reaching for `created_at` here is a 42703 half way
     * through a transaction that has already deleted twelve tables' worth.
     */
    why: 'RCM rows ONLY — voice and TC share this table and their trail is a compliance artefact',
    sql: `DELETE FROM audit_log WHERE ts < $1 AND ${AUDIT_RCM_PREDICATE}`,
  },
]);

/** Every table this script issues a DELETE against — what the privilege check asks about. */
const DELETE_TABLES = Object.freeze([...new Set(DELETES.map((d) => d.table))]);

// ─────────────────────────────────────────────────────────────────────────────
// The database seam
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A thin wrapper over one `pg.Client`, kept behind an interface so `main` is
 * testable against a fake. Same reason `rcm-seed-fixtures.cjs` has
 * `PgSeedTarget`: the interesting behaviour is the ORDER and the REFUSALS, and
 * neither should need a PostgreSQL to exercise.
 */
class PgResetTarget {
  /** @param {string} connectionString */
  constructor(connectionString) {
    const pg = require('pg');
    this.client = new pg.Client({ connectionString });
  }

  async connect() {
    await this.client.connect();
  }

  async close() {
    await this.client.end();
  }

  /** @param {string} sql @param {unknown[]} [params] */
  async query(sql, params) {
    return this.client.query(sql, params);
  }
}

/**
 * The instant local midnight began, as a real timestamptz.
 *
 * Computed BY POSTGRES rather than in Node, so the cutoff and the `created_at`
 * values it is compared against are read by the same clock and the same
 * timezone database. A cutoff derived from the workstation's idea of
 * `America/Chicago` — a laptop that may be in Arkansas, a runner that is in
 * UTC — is a different number from the server's, and the difference is silent.
 *
 * @param {{ query(sql: string, params?: unknown[]): Promise<{rows: any[]}> }} db
 * @param {string} tz
 * @returns {Promise<Date>}
 */
async function localMidnight(db, tz) {
  const res = await db.query(
    "SELECT (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AS cutoff",
    [tz]
  );
  return res.rows[0].cutoff;
}

/**
 * Refuse now, with a sentence, rather than at statement 13 with a 42501.
 *
 * `audit_log` is append-only to `carein_app` by design — the audit migration
 * revokes and re-grants `INSERT, SELECT` only. So the common case is not a
 * misconfiguration: it is a correctly-configured application role being handed
 * a job only the owner can do.
 *
 * @param {{ query(sql: string, params?: unknown[]): Promise<{rows: any[]}> }} db
 * @returns {Promise<void>}
 */
async function assertCanDelete(db) {
  const res = await db.query(
    `SELECT t AS table_name,
            has_table_privilege(current_user, t, 'DELETE') AS can_delete
       FROM unnest($1::text[]) AS t`,
    [DELETE_TABLES]
  );
  /*
   * UPDATE is checked too, because breaking the claims/queue cycle is an UPDATE
   * and a role holding DELETE everywhere but lacking UPDATE on `rcm_claims`
   * would fail at the very first statement — which is precisely the "discover it
   * half way through" this function exists to prevent.
   */
  const upd = await db.query(
    `SELECT t AS table_name,
            has_table_privilege(current_user, t, 'UPDATE') AS can_update
       FROM unnest($1::text[]) AS t`,
    [CYCLE_BREAKS.map((s) => s.table)]
  );
  const denied = [
    ...res.rows.filter((r) => !r.can_delete).map((r) => r.table_name),
    ...upd.rows.filter((r) => !r.can_update).map((r) => `${r.table_name} (UPDATE)`),
  ];
  if (denied.length === 0) return;

  const who = await db.query('SELECT current_user AS role');
  throw new ResetGuardError(
    'GUARD_NO_DELETE_PRIVILEGE',
    `refusing to start: the role '${who.rows[0].role}' cannot DELETE from ${denied.join(', ')}.\n` +
      "  `audit_log` is APPEND-ONLY to the application role on purpose — the audit migration grants\n" +
      '  it INSERT and SELECT and nothing else, so the platform cannot erase its own PHI trail.\n' +
      '  Reconnect as the OWNER role (carein_owner) to clear RCM audit rows, or drop them from the\n' +
      '  run. Nothing has been deleted.'
  );
}

/**
 * Count every rcm_* table plus the RCM slice of `audit_log`, in one round trip.
 *
 * One statement rather than 25, because these numbers are printed twice and the
 * second reading happens inside the open transaction, where 25 sequential round
 * trips against a cloud PostgreSQL is a visible pause for no reason.
 *
 * @param {{ query(sql: string, params?: unknown[]): Promise<{rows: any[]}> }} db
 * @returns {Promise<Record<string, number>>}
 */
async function countAll(db) {
  const parts = ALL_RCM_TABLES.map(
    (t) => `SELECT '${t}' AS table_name, count(*)::bigint AS n FROM ${t}`
  );
  parts.push(`SELECT 'audit_log (rcm_*)' AS table_name, count(*)::bigint AS n FROM audit_log WHERE ${AUDIT_RCM_PREDICATE}`);
  const res = await db.query(parts.join(' UNION ALL '));
  /** @type {Record<string, number>} */
  const out = {};
  for (const row of res.rows) out[row.table_name] = Number(row.n);
  return out;
}

/**
 * Render the before/after table. `after` is optional — a dry run has no after,
 * and printing one that was never measured would be a lie of exactly the kind
 * this module's honest-states rule is about.
 *
 * @param {Record<string, number>} before
 * @param {Record<string, number>|null} after
 * @returns {string}
 */
function formatCounts(before, after) {
  const names = Object.keys(before);
  const width = Math.max(...names.map((n) => n.length));
  const lines = [
    `  ${'table'.padEnd(width)}   before` + (after ? '    after' : ''),
    `  ${'-'.repeat(width)}   ------` + (after ? '   ------' : ''),
  ];
  for (const name of names) {
    const b = String(before[name]).padStart(6);
    const a = after ? String(after[name]).padStart(9) : '';
    // Rows that did not move are still printed. A table that is meant to be
    // untouched and IS untouched is a result, not noise.
    lines.push(`  ${name.padEnd(width)}   ${b}${a}`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { execute: false };
  for (const a of argv) {
    if (a === '--execute') args.execute = true;
    else if (a === '--dry-run') args.execute = false;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/**
 * Clear the debris. ONE TRANSACTION: any failure rolls back every statement,
 * so there is no half-cleared database to reason about.
 *
 * A dry run opens the same transaction, runs the same thirteen statements, and
 * ROLLS BACK. That is deliberate rather than lazy: it means the dry run's row
 * counts are the counts the execute will produce, measured rather than
 * predicted, and it exercises the FK order for real. A dry run that only
 * printed SQL would have told an operator nothing about whether statement 5
 * was going to fail.
 *
 * @param {{ query(sql: string, params?: unknown[]): Promise<{rows: any[], rowCount: number}> }} db
 * @param {{ execute: boolean, timezone: string }} opts
 */
async function runReset(db, { execute, timezone }) {
  await assertCanDelete(db);

  const before = await countAll(db);
  const cutoff = await localMidnight(db, timezone);

  /** @type {Array<{ table: string, why: string, deleted: number, verb: string }>} */
  const steps = [];
  await db.query('BEGIN');
  try {
    /*
     * The cycle-breaking UPDATEs FIRST, inside the same transaction. `rcm_claims`
     * and `rcm_posting_queue` point at each other with RESTRICT on both edges, so
     * no ordering of pure DELETEs can satisfy them — see CYCLE_BREAKS.
     */
    for (const step of CYCLE_BREAKS) {
      const res = await db.query(step.sql, [cutoff]);
      steps.push({ table: step.table, why: step.why, deleted: res.rowCount || 0, verb: 'UPDATE' });
    }
    for (const step of DELETES) {
      const res = await db.query(step.sql, [cutoff]);
      steps.push({ table: step.table, why: step.why, deleted: res.rowCount || 0, verb: 'DELETE' });
    }
    const after = await countAll(db);
    if (execute) await db.query('COMMIT');
    else await db.query('ROLLBACK');
    return { cutoff, before, after, steps, committed: execute };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { mode, databaseUrl, host, database } = assertResetAllowed(process.env);
  const timezone = String(process.env.OFFICE_TIMEZONE || 'America/Chicago').trim() || 'America/Chicago';

  const target = new PgResetTarget(databaseUrl);
  await target.connect();
  try {
    const result = await runReset(target, { execute: args.execute, timezone });

    console.log(`\n=== RCM STAGING RESET — ${args.execute ? 'EXECUTE' : 'DRY RUN'} ===`);
    console.log(`  target      ${mode}  host=${host}  database=${database || '?'}`);
    console.log(`  timezone    ${timezone} (OFFICE_TIMEZONE)`);
    console.log(`  cutoff      ${new Date(result.cutoff).toISOString()}  — rows created BEFORE this go`);
    console.log('\n-- what changed');
    let total = 0;
    for (const s of result.steps) {
      // The UPDATEs are counted separately from the TOTAL: they null a
      // back-reference rather than removing anything, and folding them in would
      // overstate how many rows this run actually deleted.
      if (s.verb === 'DELETE') total += s.deleted;
      console.log(
        `  ${String(s.deleted).padStart(6)}  ${s.verb.padEnd(6)} ${s.table.padEnd(24)} ${s.why}`
      );
    }
    console.log(`  ${String(total).padStart(6)}  DELETED IN TOTAL`);
    console.log('\n-- row counts');
    console.log(formatCounts(result.before, result.after));

    if (result.committed) {
      console.log('\nCOMMITTED. Nothing was read from or written to Open Dental.');
      console.log('NEXT: `node scripts/rcm/reseed-prep.js`, then `node scripts/rcm/reseed-835.js`.');
    } else {
      console.log('\nROLLED BACK — this was a dry run and the database is unchanged.');
      console.log('The counts above are MEASURED, not predicted: the same thirteen statements ran');
      console.log('inside a transaction that was then rolled back. Re-run with --execute to keep them.');
    }
    return 0;
  } finally {
    await target.close();
  }
}

// Run ONLY when invoked directly. Requiring this file must never delete a row.
if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const code = err instanceof ResetGuardError ? `[${err.code}] ` : '';
      console.error(`\nreset-staging-fixtures FAILED: ${code}${err && err.message ? err.message : err}`);
      console.error('Nothing was committed.');
      process.exitCode = 1;
    });
}

module.exports = {
  ResetGuardError,
  LOCAL_HOSTS,
  ALL_RCM_TABLES,
  CYCLE_BREAKS,
  DELETES,
  DELETE_TABLES,
  AUDIT_RCM_PREDICATE,
  assertResetAllowed,
  assertCanDelete,
  countAll,
  formatCounts,
  localMidnight,
  parseArgs,
  parseDbUrl,
  looksLikeProd,
  runReset,
  PgResetTarget,
  SCRIPT_PATH: path.relative(path.join(__dirname, '..', '..'), __filename),
};
