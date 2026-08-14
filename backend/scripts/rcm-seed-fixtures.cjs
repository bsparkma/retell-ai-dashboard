'use strict';

/**
 * RCM fixture seeder — Slice 2.
 *
 * WHAT THIS IS NOT: a migration of the standalone rcm-posting app's data.
 * Decision D-2 is locked — **the RCM module starts EMPTY in prod** and nothing
 * historical moves. The source app's database is never read, by this script or
 * any other.
 *
 * What this IS: the fixture layer that lets Slices 4–7 be built and
 * staging-tested against a realistic row graph. It writes an AUTHORED set of
 * synthetic rows spanning both offices — claims with procedure lines and
 * CARC/RARC adjustments, a bank deposit, a payment batch, a remittance key, an
 * EOB upload, a handoff task, an activity trail, and an approved posting queue
 * (including the one-way-door recoupment case) — into a dev or staging tenant
 * database.
 *
 * Discipline is TC's data-migration playbook:
 *   - DRY-RUN IS THE DEFAULT. Nothing is written without --execute.
 *   - Two consecutive dry-runs print BYTE-IDENTICAL plans. Every id is derived
 *     (uuid v5 over a fixture key), every date and timestamp is a literal, and
 *     nothing reads the clock or a random source. See fixtureUuid().
 *   - Re-running --execute reports 0 creates. Idempotency is by primary key,
 *     which is itself derived from the fixture key, so a re-run collides with
 *     its own previous row rather than duplicating it.
 *   - Zero errors tolerated: the whole execute is ONE transaction, and any
 *     failure rolls the entire graph back.
 *
 * USAGE
 *
 *   node scripts/rcm-seed-fixtures.cjs                      # dry-run (default)
 *   node scripts/rcm-seed-fixtures.cjs --dry-run            # same, explicit
 *   RCM_SEED_ALLOW=dev RCM_SEED_DB_URL=postgres://localhost/... \
 *     node scripts/rcm-seed-fixtures.cjs --execute
 *
 *   --user-map <path>   JSON { userKey: platformEmail } overriding the default
 *                       fixture identities in rcm_user_map (see USER MAP below).
 *
 * THE PROD GUARD (§ assertSeedAllowed)
 *
 * The seeder is structurally incapable of running against prod, and it fails
 * CLOSED — every check below must pass or nothing is written:
 *
 *   1. RCM_SEED_ALLOW must be exactly 'dev' or 'staging'. Unset is a refusal,
 *      so the script does nothing by accident.
 *   2. NODE_ENV must not be 'production'.
 *   3. RCM_SEED_ALLOW=dev requires a LOCAL database host (localhost /
 *      127.0.0.1 / ::1 / host.docker.internal). A dev opt-in cannot reach a
 *      cloud database at all.
 *   4. RCM_SEED_ALLOW=staging requires 'staging' in the host — the staging
 *      server is psql-carein-staging, prod is psql-carein-prod.
 *   5. Any prod marker in the connection string (a '-prod'/'_prod' segment in
 *      the host or the database name) is an unconditional refusal, which is
 *      what makes rule 4 belt-and-braces rather than the only line of defence.
 *
 * And one more, on the database side (§ assertTargetIsSeedable): the seeder
 * refuses a database that already holds RCM rows it did not write. Prod starts
 * empty and then accumulates real work, so the first real claim in any database
 * makes that database permanently un-seedable — a guard that does not depend on
 * anyone setting an env var correctly.
 *
 * TEST PATIENTS
 *
 * Every od_patient_id in this file comes from the repo's designated set, and a
 * build-time assertion enforces it:
 *
 *   roland → 12827 'Stedi Test 2', 12828 'Test, MangoTest'
 *   valley → 7115  'Stedi TestValley'
 *
 * PatNum 11373 is INVALID as a fixture (shared family phone → ambiguous by
 * construction) and appears nowhere. And note that PatNum 7115 in ROLAND is a
 * different, real person — which is exactly why every row here carries its
 * office_id.
 *
 * Open Dental identifiers that are NOT patients (od_claim_num,
 * od_claim_proc_num) are deliberately in a 9.8–9.9 billion range that exists in
 * neither practice's database, so that a mis-wired Slice 6 call 404s instead of
 * touching a real chart. Nothing in this script ever calls Open Dental.
 *
 * USER MAP
 *
 * rcm_user_map is the crosswalk every actor column references. The platform's
 * own user table (app_user, roles spine) lives in the CONTROL database, and
 * this script holds a TENANT connection, so the real staff set is not derivable
 * here. Per the Slice 2 brief it therefore seeds a documented minimal set of
 * three fixture identities on the reserved .invalid TLD (RFC 2606 — guaranteed
 * non-deliverable), overridable with --user-map. Mapping fixture rows onto real
 * platform identities is a SLICE 6 concern (PM ruling): Slice 3 mounts RCM
 * behind the roles spine, but the crosswalk is not needed until posting has a
 * real actor to attribute.
 *
 * NO PHI. Every name, subscriber id, claim number, payer, trace number and
 * amount below is invented. The patient names are the OD test records the
 * PatNums actually point at, which are themselves synthetic and already
 * documented in CLAUDE.md.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Frozen constants
// ─────────────────────────────────────────────────────────────────────────────

/** The two office keys, frozen by the schema's CHECK constraint. */
const OFFICES = ['roland', 'valley'];

/**
 * The ONLY Open Dental patients a fixture row may reference, per office.
 * A PatNum is meaningless without its office (hard rule 3) — 7115 is a
 * different, real person in roland's database.
 */
const TEST_PATIENTS = {
  roland: { 12827: 'Stedi Test 2', 12828: 'Test, MangoTest' },
  valley: { 7115: 'Stedi TestValley' },
};

/** Explicitly rejected as a fixture: shared family phone → ambiguous matches. */
const FORBIDDEN_PATNUMS = [11373];

/**
 * uuid v5 namespace for derived primary keys, as 32 hex characters. An
 * arbitrary but FIXED constant: it is what makes the plan byte-identical across
 * runs and makes a re-run of --execute collide with its own previous row
 * instead of duplicating it. Changing it orphans every row already seeded.
 */
const FIXTURE_NAMESPACE = '7c0f5ae2d1b4426fa93e8c15d0b7f331';

/** One shared payer across both practices — see the remittance-key note below. */
const PAYER_NAME = 'Fixture Dental Plan of Testland';
const PAYER_ID = 'FIXPAYER-01';

/**
 * The remittance identity, DELIBERATELY IDENTICAL IN BOTH OFFICES.
 *
 * rcm_remittance_keys is UNIQUE (office_id, remittance_key), not the bare
 * global UNIQUE(remittance_key) the source app had. This fixture reproduces the
 * exact collision that motivated the change: one payer sends both practices a
 * remittance under the same trace number on the same day, so both offices
 * derive the same key. Under a global unique, roland's row would silently block
 * valley's. rcm_posting_queue carries the same (office_id, remittance_key)
 * unique and is exercised by the same pair of rows.
 *
 * The fixture's key formula covers (trace, payer, payment date) — deliberately
 * NOT the amount, because the amounts legitimately differ between the two
 * practices and it is the component collision that is under test. Deriving the
 * production key is Slice 5's job, not this script's.
 */
const TRACE_NUMBER = 'FIXTRACE-0001';
const PAYMENT_DATE = '2026-08-10';
const REMITTANCE_KEY = `fixture:remit:${TRACE_NUMBER}:${PAYER_ID}:${PAYMENT_DATE}`;

/** Fixed literal dates/timestamps — nothing here reads the clock. */
const CARRIER_EOB_DATE = '2026-08-08';
const APPROVED_AT = '2026-08-10T15:00:00.000Z';
const ACTIVITY_TS = ['2026-08-10T14:00:00.000Z', '2026-08-10T14:05:00.000Z', '2026-08-10T14:10:00.000Z'];

/** Default fixture identities for rcm_user_map. Overridable with --user-map. */
const DEFAULT_USER_MAP = [
  { user_key: 'fixture-poster', platform_email: 'rcm-fixture-poster@example.invalid', display_name: 'Fixture Poster', legacy_role: 'poster' },
  { user_key: 'fixture-lead', platform_email: 'rcm-fixture-lead@example.invalid', display_name: 'Fixture Lead', legacy_role: 'lead' },
  { user_key: 'fixture-admin', platform_email: 'rcm-fixture-admin@example.invalid', display_name: 'Fixture Admin', legacy_role: 'admin' },
];

/** Columns this script writes that are jsonb — stringified so node-pg does not
 *  misformat a JS array as a Postgres array. */
const JSONB_COLUMNS = new Set(['payload', 'engine_validation', 'plb_adjustments', 'vcc_signals', 'frequency_limits', 'detail']);

/**
 * Tables checked for pre-existing non-fixture rows before an execute — the ones
 * that carry real money and real patients. If any of them holds a row this
 * seeder did not write, the database is doing real work and is not a seed
 * target. All four have uuid primary keys, which countNonFixtureRows relies on.
 */
/**
 * FK-safe insert order. rcm_claims precedes its lines; rcm_payment_batches
 * precedes every row that references it. Deliberately a literal list rather
 * than a derived topological sort: the order a fixture is written in is a fact
 * worth reading, and a planned row whose table is missing from this list is a
 * build error (see the end of buildFixturePlan).
 */
const ROW_ORDER = [
  'rcm_user_map',
  'rcm_office_settings',
  'rcm_payer_rules',
  'rcm_bank_transactions',
  'rcm_claims',
  'rcm_procedure_lines',
  'rcm_procedure_adjustments',
  'rcm_payment_batches',
  'rcm_batch_claim_payments',
  'rcm_eob_uploads',
  'rcm_remittance_keys',
  'rcm_handoff_tasks',
  'rcm_activity_events',
  'rcm_posting_queue',
  'rcm_posting_queue_line',
];

const NON_FIXTURE_GUARD_TABLES = [
  { table: 'rcm_claims', pk: 'claim_id' },
  { table: 'rcm_payment_batches', pk: 'batch_id' },
  { table: 'rcm_bank_transactions', pk: 'bank_transaction_id' },
  { table: 'rcm_posting_queue', pk: 'queue_id' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Derived ids
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A uuid v5 over FIXTURE_NAMESPACE and a fixture key. Deterministic by
 * construction: the same key always yields the same uuid, on any machine, in
 * any process, forever. That is what makes the plan reproducible and the
 * re-run idempotent.
 * @param {string} key stable fixture key, e.g. 'claim:roland:0001'
 * @returns {string} uuid
 */
function fixtureUuid(key) {
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.from(FIXTURE_NAMESPACE, 'hex'))
    .update(Buffer.from(key, 'utf8'))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The legacy_id stamped on tables that have one — the import-idempotency column. */
function legacyId(key) {
  return `fixture:${key}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The authored claim graph
//
// Every line satisfies  billed = paid + write_off + patient_resp  and
// allowed = billed - write_off. buildFixturePlan() asserts both, so a typo in
// this table is a build error rather than an inconsistent fixture.
// ─────────────────────────────────────────────────────────────────────────────

const CLAIM_FIXTURES = [
  {
    key: 'claim:roland:0001',
    office: 'roland',
    odPatientId: 12827,
    claimNumber: 'FIXCLM-ROL-0001',
    odClaimNum: 9800000001,
    serviceDate: '2026-07-20',
    lines: [
      {
        code: 'D1110',
        description: 'Prophylaxis - adult',
        odClaimProcNum: 9900000001,
        billed: 12000, writeOff: 3000, deductible: 0, paid: 7200, patientResp: 1800,
        adjustments: [
          { group: 'CO', reason: '45', description: 'Charge exceeds fee schedule/maximum allowable', amount: 3000 },
          { group: 'PR', reason: '2', description: 'Coinsurance amount', amount: 1800 },
        ],
      },
      {
        code: 'D0120',
        description: 'Periodic oral evaluation - established patient',
        odClaimProcNum: 9900000002,
        billed: 5000, writeOff: 1000, deductible: 0, paid: 4000, patientResp: 0,
        adjustments: [
          { group: 'CO', reason: '45', description: 'Charge exceeds fee schedule/maximum allowable', amount: 1000 },
        ],
      },
    ],
  },
  {
    key: 'claim:roland:0002',
    office: 'roland',
    odPatientId: 12828,
    claimNumber: 'FIXCLM-ROL-0002',
    odClaimNum: 9800000002,
    serviceDate: '2026-07-21',
    lines: [
      {
        code: 'D2391',
        description: 'Resin-based composite - one surface, posterior',
        odClaimProcNum: 9900000003,
        billed: 20000, writeOff: 5000, deductible: 5000, paid: 8000, patientResp: 7000,
        adjustments: [
          { group: 'CO', reason: '45', description: 'Charge exceeds fee schedule/maximum allowable', amount: 5000 },
          { group: 'PR', reason: '1', description: 'Deductible amount', amount: 5000 },
          { group: 'PR', reason: '2', description: 'Coinsurance amount', amount: 2000 },
        ],
      },
      {
        // The denial case: nothing allowed by the plan, the whole charge lands
        // on the patient. Slices 4–7 need a denied line to render.
        code: 'D0274',
        description: 'Bitewings - four radiographic images',
        odClaimProcNum: 9900000004,
        billed: 8000, writeOff: 0, deductible: 0, paid: 0, patientResp: 8000,
        denied: true,
        flags: ['denied', 'not_covered'],
        adjustments: [
          {
            group: 'PR', reason: '96', description: 'Non-covered charge(s)', amount: 8000,
            remarkCode: 'N130', remarkDescription: 'Consult plan benefit documents/guidelines for information about restrictions for this service',
          },
        ],
      },
    ],
  },
  {
    key: 'claim:roland:0003',
    office: 'roland',
    odPatientId: 12827,
    claimNumber: 'FIXCLM-ROL-0003',
    odClaimNum: 9800000003,
    serviceDate: '2026-07-22',
    lines: [
      {
        // The downcode case: billed as a ceramic crown, paid at the alternate
        // benefit level of a base-metal crown. billed_code ≠ paid_code.
        code: 'D2751',
        billedCode: 'D2740',
        paidCode: 'D2751',
        description: 'Crown - porcelain fused to predominantly base metal (alternate benefit)',
        odClaimProcNum: 9900000005,
        billed: 110000, writeOff: 35000, deductible: 0, paid: 60000, patientResp: 15000,
        downcoded: true,
        flags: ['downcode'],
        adjustments: [
          { group: 'CO', reason: '4', description: 'Procedure paid at an alternate benefit level', amount: 20000 },
          { group: 'CO', reason: '45', description: 'Charge exceeds fee schedule/maximum allowable', amount: 15000 },
          { group: 'PR', reason: '2', description: 'Coinsurance amount', amount: 15000 },
        ],
      },
    ],
  },
  {
    key: 'claim:valley:0001',
    office: 'valley',
    odPatientId: 7115,
    claimNumber: 'FIXCLM-VAL-0001',
    odClaimNum: 9800000101,
    serviceDate: '2026-07-23',
    lines: [
      {
        code: 'D1120',
        description: 'Prophylaxis - child',
        odClaimProcNum: 9900000101,
        billed: 9000, writeOff: 2000, deductible: 0, paid: 7000, patientResp: 0,
        adjustments: [
          { group: 'CO', reason: '45', description: 'Charge exceeds fee schedule/maximum allowable', amount: 2000 },
        ],
      },
      {
        code: 'D1206',
        description: 'Topical application of fluoride varnish',
        odClaimProcNum: 9900000102,
        billed: 4500, writeOff: 1000, deductible: 0, paid: 3500, patientResp: 0,
        adjustments: [
          { group: 'CO', reason: '45', description: 'Charge exceeds fee schedule/maximum allowable', amount: 1000 },
        ],
      },
    ],
  },
  {
    // The recoupment case. This claim was adjudicated and paid in an earlier
    // remittance; the carrier overpaid it by 4000 cents and is taking that back
    // on the current one. The LINE below shows the corrected final state
    // (paid 18000); the takeback itself lives where it operationally belongs —
    // on the batch claim payment (-4000) and on a negative-supplemental posting
    // queue line, which is the one Open Dental operation that cannot be undone.
    key: 'claim:valley:0002',
    office: 'valley',
    odPatientId: 7115,
    claimNumber: 'FIXCLM-VAL-0002',
    odClaimNum: 9800000102,
    serviceDate: '2026-06-15',
    lines: [
      {
        code: 'D4341',
        description: 'Periodontal scaling and root planing - four or more teeth per quadrant',
        odClaimProcNum: 9900000103,
        billed: 30000, writeOff: 8000, deductible: 0, paid: 18000, patientResp: 4000,
        adjustments: [
          { group: 'CO', reason: '45', description: 'Charge exceeds fee schedule/maximum allowable', amount: 8000 },
          {
            group: 'PR', reason: '2', description: 'Coinsurance amount', amount: 4000,
            remarkCode: 'N130', remarkDescription: 'Consult plan benefit documents/guidelines for information about restrictions for this service',
          },
        ],
      },
    ],
  },
];

/**
 * What each office's remittance actually moves, per claim, by line position.
 * Money arriving is positive; `recoupCents` makes the whole claim's movement a
 * single negative takeback instead. Every batch and queue total is DERIVED from
 * this — no cent total is typed twice anywhere in this file.
 */
const BATCH_MOVEMENTS = {
  roland: [
    { claimKey: 'claim:roland:0001', linePositions: [1, 2] },
    { claimKey: 'claim:roland:0002', linePositions: [1, 2] },
    { claimKey: 'claim:roland:0003', linePositions: [1] },
  ],
  valley: [
    { claimKey: 'claim:valley:0001', linePositions: [1, 2] },
    { claimKey: 'claim:valley:0002', linePositions: [1], recoupCents: -4000 },
  ],
};

/** Per-office fixture settings. */
const OFFICE_FIXTURES = {
  roland: {
    bankType: 'eft',
    eftNumber: 'FIXEFT-0001',
    checkNumber: null,
    merchantFeeBps: 250,
    eraFilename: 'Test_Guardian_Clean.edi',
    isRecoupment: false,
    task: {
      type: 'DENIAL',
      summary: 'Fixture: D0274 denied as non-covered (PR-96 / N130) on FIXCLM-ROL-0002 — confirm patient responsibility.',
      payload: { claim_number: 'FIXCLM-ROL-0002', procedure_code: 'D0274', carc: '96', rarc: 'N130' },
    },
  },
  valley: {
    bankType: 'check',
    eftNumber: null,
    checkNumber: 'FIXCHK-0001',
    merchantFeeBps: 295,
    eraFilename: 'Test_Reversal_Recoupment.edi',
    isRecoupment: true,
    task: {
      type: 'RECOUPMENT',
      summary: 'Fixture: carrier recouped 4000 cents on FIXCLM-VAL-0002 — a negative supplemental is a one-way door in Open Dental.',
      payload: { claim_number: 'FIXCLM-VAL-0002', recouped_cents: -4000, irreversible: true },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// The prod guard
// ─────────────────────────────────────────────────────────────────────────────

/** A refusal carrying a stable code, so tests assert on the code not the prose. */
class SeedGuardError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'SeedGuardError';
    this.code = code;
  }
}

/** Hosts a `RCM_SEED_ALLOW=dev` run is permitted to reach. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

/**
 * Pull {host, database} out of a connection string without needing it to be a
 * perfectly-formed URL. Returns lowercased parts; unparseable input yields
 * nulls, which every caller below treats as a refusal.
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
 * Fail-closed authorization for a WRITE. Throws SeedGuardError unless every
 * condition in the header's PROD GUARD section holds. Pure — takes the
 * environment as an argument so the tests can exercise every branch without a
 * database or a process-wide env mutation.
 *
 * @param {Record<string, string|undefined>} env typically process.env
 * @returns {{ mode: 'dev'|'staging', databaseUrl: string }}
 */
function assertSeedAllowed(env) {
  const allow = (env.RCM_SEED_ALLOW || '').trim().toLowerCase();
  if (allow !== 'dev' && allow !== 'staging') {
    throw new SeedGuardError(
      'GUARD_NO_OPT_IN',
      "refusing to write: set RCM_SEED_ALLOW=dev or RCM_SEED_ALLOW=staging. " +
        'The RCM module starts EMPTY in prod (decision D-2) and there is no opt-in value that targets it.'
    );
  }

  if ((env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    throw new SeedGuardError('GUARD_NODE_ENV_PRODUCTION', 'refusing to write: NODE_ENV=production.');
  }

  const databaseUrl = (env.RCM_SEED_DB_URL || '').trim();
  if (!databaseUrl) {
    throw new SeedGuardError(
      'GUARD_NO_DB_URL',
      'refusing to write: RCM_SEED_DB_URL is not set (fetch the tenant connection string into the session; never commit it).'
    );
  }

  const { host, database } = parseDbUrl(databaseUrl);
  if (!host) {
    throw new SeedGuardError('GUARD_UNPARSEABLE_DB_URL', 'refusing to write: RCM_SEED_DB_URL has no parseable host.');
  }

  // Unconditional: a prod marker anywhere in the target refuses regardless of
  // which opt-in was given.
  if (looksLikeProd(host) || looksLikeProd(database)) {
    throw new SeedGuardError(
      'GUARD_PROD_DATABASE_URL',
      `refusing to write: the target looks like production (host '${host}', database '${database || '?'}').`
    );
  }

  if (allow === 'dev' && !LOCAL_HOSTS.has(host)) {
    throw new SeedGuardError(
      'GUARD_DEV_REQUIRES_LOCAL',
      `refusing to write: RCM_SEED_ALLOW=dev only reaches a local database, not '${host}'. Use RCM_SEED_ALLOW=staging for psql-carein-staging.`
    );
  }

  if (allow === 'staging' && !host.includes('staging')) {
    throw new SeedGuardError(
      'GUARD_STAGING_URL_MISMATCH',
      `refusing to write: RCM_SEED_ALLOW=staging but host '${host}' is not a staging host.`
    );
  }

  return { mode: allow, databaseUrl };
}

/**
 * The database-side half of the guard: refuse a database that already holds RCM
 * rows this seeder did not write. Prod starts empty and then accumulates real
 * work, so the first real claim makes that database permanently un-seedable —
 * a guard that survives someone setting the env vars wrongly.
 *
 * @param {{ countNonFixtureRows(table: string, pk: string, ids: string[]): Promise<number> }} target
 * @param {ReturnType<typeof buildFixturePlan>} plan
 */
async function assertTargetIsSeedable(target, plan) {
  for (const { table, pk } of NON_FIXTURE_GUARD_TABLES) {
    const ours = plan.rows.filter((r) => r.table === table).map((r) => r.pk);
    const foreign = await target.countNonFixtureRows(table, pk, ours);
    if (foreign > 0) {
      throw new SeedGuardError(
        'GUARD_NON_FIXTURE_DATA',
        `refusing to write: ${table} already holds ${foreign} row(s) this seeder did not write. ` +
          'That database is doing real work and is not a fixture target.'
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One planned row. `key` is the stable fixture key the pk is derived from and
 * the only identifier the report prints.
 * @typedef {{ table: string, pkColumn: string, pk: string, key: string, office: string|null, row: Record<string, unknown> }} PlannedRow
 */

/**
 * Build the complete fixture plan. Pure and deterministic: no clock, no random
 * source, no database. Throws if the authored graph is internally inconsistent
 * or references a patient outside the designated set.
 *
 * @param {{ userMap?: Array<Record<string, string>> }} [options]
 * @returns {{ rows: PlannedRow[], userMap: Array<Record<string,string>>, money: Record<string, {batchTotal:number, claimPayments:number, intendedLines:number}> }}
 */
function buildFixturePlan(options = {}) {
  const userMap = options.userMap && options.userMap.length ? options.userMap : DEFAULT_USER_MAP;
  /** @type {PlannedRow[]} */
  const rows = [];
  const add = (table, pkColumn, key, office, row) => {
    rows.push({ table, pkColumn, pk: String(row[pkColumn]), key, office, row });
  };

  // Validate the user map before anything references it.
  const userKeys = new Set();
  for (const u of userMap) {
    if (!u.user_key || !u.platform_email) throw new Error(`user map entry missing user_key/platform_email: ${JSON.stringify(u)}`);
    if (u.platform_email !== u.platform_email.toLowerCase()) {
      throw new Error(`rcm_user_map.platform_email must be lowercase (CHECK constraint): '${u.platform_email}'`);
    }
    userKeys.add(u.user_key);
  }
  for (const required of ['fixture-poster', 'fixture-lead']) {
    if (!userKeys.has(required)) throw new Error(`user map must contain '${required}' — fixture rows attribute to it`);
  }

  // ── rcm_user_map (tenant-global) ───────────────────────────────────────────
  for (const u of userMap) {
    add('rcm_user_map', 'user_key', `user:${u.user_key}`, null, {
      user_key: u.user_key,
      platform_email: u.platform_email,
      display_name: u.display_name || u.user_key,
      legacy_role: u.legacy_role || '',
      active: true,
    });
  }

  // ── rcm_office_settings + rcm_payer_rules ─────────────────────────────────
  // The payer name is the SAME in both offices, which is what exercises
  // UNIQUE(office_id, payer_name): one carrier, two practices, two rows.
  for (const office of OFFICES) {
    add('rcm_office_settings', 'office_id', `office_settings:${office}`, office, {
      office_id: office,
      merchant_fee_bps: OFFICE_FIXTURES[office].merchantFeeBps,
      notes: 'Fixture row — RCM Slice 2 seeder.',
    });
    add('rcm_payer_rules', 'payer_rule_id', `payer_rule:${office}`, office, {
      payer_rule_id: fixtureUuid(`payer_rule:${office}`),
      office_id: office,
      payer_name: PAYER_NAME,
      preventive_coverage_pct: 100,
      basic_coverage_pct: 80,
      major_coverage_pct: 50,
      orthodontic_coverage_pct: 50,
      annual_maximum_cents: 150000,
      deductible_cents: 5000,
      filing_limit_days: 365,
      resubmission_limit_days: 180,
      notes: 'Fixture row — RCM Slice 2 seeder.',
    });
  }

  // ── Claims, lines, adjustments ────────────────────────────────────────────
  /** Everything a later section needs about a planned claim, by fixture key. */
  const claimIndex = new Map();

  for (const claim of CLAIM_FIXTURES) {
    if (!OFFICES.includes(claim.office)) throw new Error(`${claim.key}: unknown office '${claim.office}'`);
    const patients = TEST_PATIENTS[claim.office];
    if (FORBIDDEN_PATNUMS.includes(claim.odPatientId)) {
      throw new Error(`${claim.key}: PatNum ${claim.odPatientId} is explicitly rejected as a fixture`);
    }
    if (!Object.prototype.hasOwnProperty.call(patients, String(claim.odPatientId))) {
      throw new Error(
        `${claim.key}: od_patient_id ${claim.odPatientId} is not a designated ${claim.office} test patient ` +
          `(allowed: ${Object.keys(patients).join(', ')})`
      );
    }
    const patientName = patients[claim.odPatientId];

    const claimId = fixtureUuid(claim.key);
    const totals = { billed: 0, allowed: 0, deductible: 0, paid: 0, patientResp: 0 };
    const lineIndex = new Map();

    claim.lines.forEach((line, i) => {
      const position = i + 1;
      const allowed = line.billed - line.writeOff;
      // The two invariants that make this fixture's money real.
      if (line.billed !== line.paid + line.writeOff + line.patientResp) {
        throw new Error(
          `${claim.key} line ${position}: billed ${line.billed} ≠ paid ${line.paid} + write_off ${line.writeOff} + patient_resp ${line.patientResp}`
        );
      }
      if (line.deductible > line.patientResp) {
        throw new Error(`${claim.key} line ${position}: deductible ${line.deductible} exceeds patient responsibility ${line.patientResp}`);
      }

      totals.billed += line.billed;
      totals.allowed += allowed;
      totals.deductible += line.deductible;
      totals.paid += line.paid;
      totals.patientResp += line.patientResp;

      const lineKey = `${claim.key}:line:${position}`;
      const lineId = fixtureUuid(lineKey);
      lineIndex.set(position, {
        lineId,
        paid: line.paid,
        writeOff: line.writeOff,
        deductible: line.deductible,
        odClaimProcNum: line.odClaimProcNum,
      });

      add('rcm_procedure_lines', 'line_id', lineKey, claim.office, {
        line_id: lineId,
        claim_id: claimId,
        office_id: claim.office,
        position,
        billed_code: line.billedCode || line.code,
        paid_code: line.paidCode || null,
        code: line.code,
        description: line.description,
        billed_cents: line.billed,
        allowed_cents: allowed,
        deductible_cents: line.deductible,
        copay_cents: 0,
        paid_cents: line.paid,
        adjustment_cents: line.writeOff,
        patient_resp_cents: line.patientResp,
        write_off_cents: line.writeOff,
        adjustment_reason: null,
        is_downcoded: Boolean(line.downcoded),
        is_bundled: false,
        is_denied: Boolean(line.denied),
        flags: line.flags || [],
        od_claim_proc_num: line.odClaimProcNum,
      });

      (line.adjustments || []).forEach((adj, j) => {
        const adjKey = `${lineKey}:adj:${j + 1}`;
        add('rcm_procedure_adjustments', 'adjustment_id', adjKey, claim.office, {
          adjustment_id: fixtureUuid(adjKey),
          procedure_line_id: lineId,
          claim_id: claimId,
          office_id: claim.office,
          group_code: adj.group,
          reason_code: adj.reason,
          reason_description: adj.description,
          amount_cents: adj.amount,
          quantity: 1,
          remark_code: adj.remarkCode || null,
          remark_description: adj.remarkDescription || '',
        });
      });
    });

    // The claim row is planned AFTER its lines are costed but inserted BEFORE
    // them — see ROW_ORDER.
    add('rcm_claims', 'claim_id', claim.key, claim.office, {
      claim_id: claimId,
      legacy_id: legacyId(claim.key),
      office_id: claim.office,
      claim_number: claim.claimNumber,
      check_number: '',
      patient_name: patientName,
      patient_dob: null,
      subscriber_id: `FIXSUB-${String(claim.odPatientId).padStart(10, '0')}`,
      group_number: 'FIXGRP-0001',
      od_patient_id: claim.odPatientId,
      od_claim_num: claim.odClaimNum,
      payer: PAYER_NAME,
      service_date: claim.serviceDate,
      received_date: PAYMENT_DATE,
      status: 'matched',
      source: 'clearinghouse',
      total_billed_cents: totals.billed,
      total_allowed_cents: totals.allowed,
      total_deductible_cents: totals.deductible,
      total_copay_cents: 0,
      total_paid_cents: totals.paid,
      total_received_cents: totals.paid,
      patient_balance_cents: totals.patientResp,
      provider_npi: '',
      rendering_provider: '',
      pms_synced: false,
      bank_matched: true,
      payment_status: 'paid',
      insurance_type: 'primary',
      cob_sequence: 1,
      confidence: 95,
      processing_time_sec: 0,
      needs_review_reasons: [],
    });

    claimIndex.set(claim.key, { fixture: claim, claimId, patientName, office: claim.office, lines: lineIndex, totals });
  }

  // ── Per-office deposit → batch → queue ────────────────────────────────────
  /** @type {Record<string, {batchTotal:number, claimPayments:number, intendedLines:number}>} */
  const money = {};

  for (const office of OFFICES) {
    const cfg = OFFICE_FIXTURES[office];
    const movements = BATCH_MOVEMENTS[office];

    // What this remittance moves per claim, and the per-line intents behind it.
    const perClaim = movements.map((m) => {
      const claim = claimIndex.get(m.claimKey);
      if (!claim) throw new Error(`batch movement references unknown claim '${m.claimKey}'`);
      if (claim.office !== office) {
        throw new Error(`${office} batch references ${m.claimKey}, which belongs to ${claim.office}`);
      }
      const lineIntents = m.linePositions.map((position) => {
        const line = claim.lines.get(position);
        if (!line) throw new Error(`batch movement references unknown line ${position} on ${m.claimKey}`);
        // A recoupment moves ONE negative amount against the claim. The line's
        // own adjudicated paid amount is the corrected end state, not this
        // remittance's movement — see the claim:valley:0002 header.
        const intended = m.recoupCents != null ? m.recoupCents : line.paid;
        return { ...line, intended, supplemental: m.recoupCents != null };
      });
      if (m.recoupCents != null && lineIntents.length !== 1) {
        throw new Error(`${m.claimKey}: a recoupment must name exactly one line`);
      }
      const paid = lineIntents.reduce((n, l) => n + l.intended, 0);
      return { movement: m, claim, lineIntents, paid };
    });

    const batchTotal = perClaim.reduce((n, c) => n + c.paid, 0);

    // rcm_bank_transactions — "the deposit".
    const bankKey = `bank:${office}:0001`;
    const bankId = fixtureUuid(bankKey);
    add('rcm_bank_transactions', 'bank_transaction_id', bankKey, office, {
      bank_transaction_id: bankId,
      legacy_id: legacyId(bankKey),
      office_id: office,
      posted_date: PAYMENT_DATE,
      description: `FIXTURE ${cfg.bankType.toUpperCase()} DEPOSIT — ${PAYER_NAME}`,
      amount_cents: batchTotal,
      type: cfg.bankType,
      payer: PAYER_NAME,
      status: 'matched',
      account_last4: '0000',
      trace_number: TRACE_NUMBER,
    });

    // rcm_payment_batches — one carrier remittance.
    const batchKey = `batch:${office}:0001`;
    const batchId = fixtureUuid(batchKey);
    add('rcm_payment_batches', 'batch_id', batchKey, office, {
      batch_id: batchId,
      legacy_id: legacyId(batchKey),
      office_id: office,
      bank_transaction_id: bankId,
      check_number: cfg.checkNumber,
      eft_number: cfg.eftNumber,
      payment_method: cfg.bankType === 'check' ? 'check' : 'eft',
      payer: PAYER_NAME,
      deposit_date: PAYMENT_DATE,
      total_amount_cents: batchTotal,
      posted_amount_cents: 0,
      claim_count: perClaim.length,
      status: 'ready',
      trace_number: TRACE_NUMBER,
      trace_originator_id: PAYER_ID,
      plb_total_cents: 0,
      engine_validation: { source: 'fixture', issues: [] },
      notes: 'Fixture row — RCM Slice 2 seeder. Never posted to Open Dental.',
      created_by: 'fixture-poster',
    });

    // rcm_batch_claim_payments — one claim's money within the batch. On a
    // takeback row the only figure this remittance moved is the negative
    // paid_cents; the allowed/adjustment/responsibility columns describe the
    // ORIGINAL adjudication and belong to the earlier remittance, not this one.
    perClaim.forEach((c, i) => {
      const key = `${batchKey}:claim:${i + 1}`;
      const recoup = c.movement.recoupCents != null;
      add('rcm_batch_claim_payments', 'batch_claim_payment_id', key, office, {
        batch_claim_payment_id: fixtureUuid(key),
        batch_id: batchId,
        claim_id: c.claim.claimId,
        office_id: office,
        position: i + 1,
        patient_name: c.claim.patientName,
        subscriber_id: null,
        claim_number: c.claim.fixture.claimNumber,
        service_date: c.claim.fixture.serviceDate,
        paid_cents: c.paid,
        allowed_cents: recoup ? 0 : c.claim.totals.allowed,
        adjustment_cents: recoup ? 0 : c.claim.totals.billed - c.claim.totals.allowed,
        patient_resp_cents: recoup ? 0 : c.claim.totals.patientResp,
        status: 'pending',
        match_confidence: 95,
      });
    });

    // rcm_eob_uploads — an extracted document. The blob key is an opaque
    // placeholder: no blob is created and none is needed.
    const eobKey = `eob:${office}:0001`;
    add('rcm_eob_uploads', 'upload_id', eobKey, office, {
      upload_id: fixtureUuid(eobKey),
      office_id: office,
      filename: cfg.eraFilename,
      file_key: `carein/rcm/eob/fixture-${office}-0001.edi`,
      file_url: `https://fixture.invalid/rcm/eob/fixture-${office}-0001.edi`,
      file_hash: crypto.createHash('sha256').update(eobKey).digest('hex'),
      content_type: 'application/edi-x12',
      bank_transaction_id: bankId,
      result_batch_id: batchId,
      result_claim_id: perClaim[0].claim.claimId,
      status: 'extracted',
    });

    // rcm_remittance_keys — the double-posting guard. The key is IDENTICAL in
    // both offices on purpose; see REMITTANCE_KEY.
    const remitKey = `remittance_key:${office}:0001`;
    add('rcm_remittance_keys', 'remittance_key_id', remitKey, office, {
      remittance_key_id: fixtureUuid(remitKey),
      office_id: office,
      trace_number: TRACE_NUMBER,
      payer_id: PAYER_ID,
      payment_date: PAYMENT_DATE,
      payment_amount_cents: batchTotal,
      check_number: cfg.checkNumber,
      remittance_key: REMITTANCE_KEY,
      batch_id: batchId,
      // 'pending' = reserved, not yet posted. Nothing in this fixture reached
      // Open Dental, so nothing may read as 'posted'.
      status: 'pending',
      reserved_at: APPROVED_AT,
    });

    // rcm_handoff_tasks — the durable work the remittance raised.
    const taskKey = `task:${office}:0001`;
    add('rcm_handoff_tasks', 'task_id', taskKey, office, {
      task_id: fixtureUuid(taskKey),
      legacy_id: legacyId(taskKey),
      office_id: office,
      deposit_id: bankId,
      type: cfg.task.type,
      status: 'OPEN',
      summary: cfg.task.summary,
      payload: cfg.task.payload,
      assignee_user_key: 'fixture-lead',
      created_by_user_key: 'fixture-poster',
      actor_role: 'poster',
    });

    // rcm_activity_events — the module feed. NOT the platform audit_log.
    const trail = [
      { type: 'received', message: `Fixture: remittance ${TRACE_NUMBER} received for ${office}.` },
      { type: 'extracted', message: `Fixture: ${perClaim.length} claim(s) extracted from ${cfg.eraFilename}.` },
      { type: 'matched', message: `Fixture: batch matched to deposit ${cfg.bankType.toUpperCase()} ${batchTotal} cents.` },
    ];
    trail.forEach((entry, i) => {
      const key = `activity:${office}:${String(i + 1).padStart(4, '0')}`;
      add('rcm_activity_events', 'activity_id', key, office, {
        activity_id: fixtureUuid(key),
        legacy_id: legacyId(key),
        office_id: office,
        ts: ACTIVITY_TS[i],
        type: entry.type,
        message: entry.message,
        detail: null,
        claim_id: perClaim[0].claim.claimId,
      });
    });

    // rcm_posting_queue — approved and NOT posted. There is no state here that
    // means "probably fine", and none of these rows may look like they reached
    // Open Dental: status stays 'approved', posted_total_cents is 0, and
    // od_claim_payment_num is null.
    const queueKey = `queue:${office}:0001`;
    const queueId = fixtureUuid(queueKey);
    add('rcm_posting_queue', 'queue_id', queueKey, office, {
      queue_id: queueId,
      office_id: office,
      batch_id: batchId,
      bank_transaction_id: bankId,
      remittance_key: REMITTANCE_KEY,
      status: 'approved',
      is_recoupment: cfg.isRecoupment,
      carrier_eob_date: CARRIER_EOB_DATE,
      intended_total_cents: batchTotal,
      posted_total_cents: 0,
      approved_by: 'fixture-lead',
      approved_at: APPROVED_AT,
      attempt_count: 0,
    });

    let position = 0;
    perClaim.forEach((c, ci) => {
      const bcpKey = `${batchKey}:claim:${ci + 1}`;
      c.lineIntents.forEach((line) => {
        position += 1;
        const key = `${queueKey}:line:${position}`;
        add('rcm_posting_queue_line', 'queue_line_id', key, office, {
          queue_line_id: fixtureUuid(key),
          queue_id: queueId,
          office_id: office,
          position,
          od_claim_proc_num: line.odClaimProcNum,
          od_claim_num: c.claim.fixture.odClaimNum,
          claim_id: c.claim.claimId,
          batch_claim_payment_id: fixtureUuid(bcpKey),
          intended_ins_pay_amt_cents: line.intended,
          intended_write_off_cents: line.supplemental ? 0 : line.writeOff,
          intended_ded_applied_cents: line.supplemental ? 0 : line.deductible,
          is_supplemental: line.supplemental,
          status: 'pending',
        });
      });
    });

    // The reconciliation, read back off the rows actually planned rather than
    // off the intermediates that produced them — so a bug in the emit path
    // fails here instead of shipping an unbalanced fixture.
    const sum = (table, column) =>
      rows.filter((r) => r.table === table && r.office === office).reduce((n, r) => n + r.row[column], 0);
    const claimPayments = sum('rcm_batch_claim_payments', 'paid_cents');
    const intendedLines = sum('rcm_posting_queue_line', 'intended_ins_pay_amt_cents');
    if (batchTotal !== claimPayments || claimPayments !== intendedLines) {
      throw new Error(
        `${office}: unbalanced fixture — batch_total=${batchTotal} claim_payments=${claimPayments} intended_lines=${intendedLines}`
      );
    }
    money[office] = { batchTotal, claimPayments, intendedLines };
  }

  // Insert order: parents before children, matching the schema's FK graph.
  const ordered = ROW_ORDER.flatMap((table) => rows.filter((r) => r.table === table));
  if (ordered.length !== rows.length) {
    const unordered = [...new Set(rows.map((r) => r.table))].filter((t) => !ROW_ORDER.includes(t));
    throw new Error(`planned rows for table(s) missing from ROW_ORDER: ${unordered.join(', ')}`);
  }

  return { rows: ordered, userMap, money };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

function pad(value, width) {
  return String(value).padEnd(width);
}

/**
 * Render the plan. Byte-identical for byte-identical input — no clock, no
 * absolute paths, no environment.
 *
 * @param {ReturnType<typeof buildFixturePlan>} plan
 * @param {'dry-run'|'execute'} mode
 * @param {{ created: Record<string, number>, skipped: Record<string, number> }} [result]
 * @returns {string}
 */
function formatPlan(plan, mode, result) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push(`RCM fixture seed — ${mode.toUpperCase()}`);
  push('This is a FIXTURE seed, not a data migration. The RCM module starts empty in prod (D-2).');
  push();

  push(pad('table', 30) + pad('rows', 6) + pad('roland', 8) + pad('valley', 8) + 'tenant-global');
  push('-'.repeat(66));
  for (const table of ROW_ORDER) {
    const rows = plan.rows.filter((r) => r.table === table);
    if (!rows.length) continue;
    push(
      pad(table, 30) +
        pad(rows.length, 6) +
        pad(rows.filter((r) => r.office === 'roland').length, 8) +
        pad(rows.filter((r) => r.office === 'valley').length, 8) +
        rows.filter((r) => r.office === null).length
    );
  }
  push('-'.repeat(66));
  push(pad('TOTAL', 30) + pad(plan.rows.length, 6));
  push();

  push('money reconciliation (cents):');
  for (const office of OFFICES) {
    const m = plan.money[office];
    const balanced = m.batchTotal === m.claimPayments && m.claimPayments === m.intendedLines;
    push(
      `  ${pad(office, 8)}batch_total=${pad(m.batchTotal, 10)}claim_payments=${pad(m.claimPayments, 10)}` +
        `intended_lines=${pad(m.intendedLines, 10)}${balanced ? 'BALANCED' : 'UNBALANCED'}`
    );
  }
  push();

  push(`remittance key (identical in both offices — exercises UNIQUE(office_id, remittance_key)):`);
  push(`  ${REMITTANCE_KEY}`);
  push();

  push('planned rows (fixture key → derived uuid):');
  for (const r of plan.rows) {
    push(`  ${pad(r.table, 30)}${pad(r.office || '(global)', 10)}${pad(r.key, 34)}${r.pk}`);
  }
  push();

  if (result) {
    push('EXECUTED:');
    let created = 0;
    let skipped = 0;
    for (const table of ROW_ORDER) {
      const c = result.created[table] || 0;
      const s = result.skipped[table] || 0;
      if (!c && !s) continue;
      created += c;
      skipped += s;
      push(`  ${pad(table, 30)}${pad(`${c} created`, 14)}${s} already present`);
    }
    push(`  ${pad('TOTAL', 30)}${pad(`${created} created`, 14)}${skipped} already present`);
    if (created === 0) push('  (idempotent re-run — nothing to do)');
  } else {
    push('DRY-RUN: no database writes. Re-run with --execute to apply.');
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply the plan through a target. One transaction for the whole graph: any
 * failure rolls every row back, so the database is never left holding half a
 * fixture.
 *
 * @param {ReturnType<typeof buildFixturePlan>} plan
 * @param {{ begin():Promise<void>, commit():Promise<void>, rollback():Promise<void>,
 *           insertIfAbsent(table:string, pkColumn:string, row:Record<string,unknown>):Promise<boolean> }} target
 * @returns {Promise<{ created: Record<string,number>, skipped: Record<string,number> }>}
 */
async function executePlan(plan, target) {
  /** @type {Record<string, number>} */
  const created = {};
  /** @type {Record<string, number>} */
  const skipped = {};

  await target.begin();
  try {
    for (const r of plan.rows) {
      const inserted = await target.insertIfAbsent(r.table, r.pkColumn, r.row);
      const bucket = inserted ? created : skipped;
      bucket[r.table] = (bucket[r.table] || 0) + 1;
    }
    await target.commit();
  } catch (err) {
    await target.rollback().catch(() => {});
    throw err;
  }
  return { created, skipped };
}

/** Postgres implementation of the execute target. */
class PgSeedTarget {
  /** @param {string} connectionString */
  constructor(connectionString) {
    const pg = require('pg');
    this.client = new pg.Client({ connectionString });
  }

  async connect() {
    await this.client.connect();
  }

  async begin() {
    await this.client.query('BEGIN');
  }

  async commit() {
    await this.client.query('COMMIT');
  }

  async rollback() {
    await this.client.query('ROLLBACK');
  }

  /**
   * INSERT … ON CONFLICT DO NOTHING. The conflict target is left open on
   * purpose so a collision on the primary key, on legacy_id, or on any
   * office-scoped unique all resolve the same way: skip, do not duplicate.
   * rowCount is the honest count of creates.
   */
  async insertIfAbsent(table, _pkColumn, row) {
    const cols = Object.keys(row);
    const params = [];
    const placeholders = cols.map((col, i) => {
      let v = row[col];
      if (JSONB_COLUMNS.has(col) && v !== null && v !== undefined) v = JSON.stringify(v);
      params.push(v === undefined ? null : v);
      return JSONB_COLUMNS.has(col) ? `$${i + 1}::jsonb` : `$${i + 1}`;
    });
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT DO NOTHING`;
    const res = await this.client.query(sql, params);
    return res.rowCount === 1;
  }

  /** Rows in `table` whose pk is NOT one of `ids` — see assertTargetIsSeedable. */
  async countNonFixtureRows(table, pkColumn, ids) {
    const res = await this.client.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE NOT (${pkColumn} = ANY($1::uuid[]))`,
      [ids]
    );
    return res.rows[0].n;
  }

  async close() {
    await this.client.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a `{ userKey: platformEmail }` override file over DEFAULT_USER_MAP.
 * Known keys have their email replaced; unknown keys are appended. The three
 * fixture identities always survive, because every fixture row attributes to
 * `fixture-poster` / `fixture-lead` and an override that removed them would
 * leave those rows unattributable.
 *
 * @param {Record<string, string>|null} overrides
 * @returns {Array<Record<string, string>>|undefined}
 */
function applyUserMapOverrides(overrides) {
  if (!overrides) return undefined;
  const merged = DEFAULT_USER_MAP.map((u) =>
    Object.prototype.hasOwnProperty.call(overrides, u.user_key)
      ? { ...u, platform_email: String(overrides[u.user_key]).toLowerCase() }
      : u
  );
  for (const [user_key, email] of Object.entries(overrides)) {
    if (!merged.some((u) => u.user_key === user_key)) {
      merged.push({ user_key, platform_email: String(email).toLowerCase(), display_name: user_key, legacy_role: '' });
    }
  }
  return merged;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { execute: false, userMapPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') args.execute = true;
    else if (a === '--dry-run') args.execute = false;
    else if (a === '--user-map') args.userMapPath = argv[++i] || null;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const overrides = args.userMapPath
    ? JSON.parse(fs.readFileSync(path.resolve(args.userMapPath), 'utf8'))
    : null;

  const plan = buildFixturePlan({ userMap: applyUserMapOverrides(overrides) });

  if (!args.execute) {
    console.log(formatPlan(plan, 'dry-run'));
    return 0;
  }

  // Every write goes through the guard first. It throws; nothing below runs.
  const { mode, databaseUrl } = assertSeedAllowed(process.env);
  const target = new PgSeedTarget(databaseUrl);
  await target.connect();
  try {
    await assertTargetIsSeedable(target, plan);
    const result = await executePlan(plan, target);
    console.log(formatPlan(plan, 'execute', result));
    console.log(`\ntarget: ${mode}`);
    return 0;
  } finally {
    await target.close();
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const code = err instanceof SeedGuardError ? `[${err.code}] ` : '';
      console.error(`rcm-seed-fixtures FAILED: ${code}${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    });
}

module.exports = {
  OFFICES,
  TEST_PATIENTS,
  FORBIDDEN_PATNUMS,
  ROW_ORDER,
  REMITTANCE_KEY,
  DEFAULT_USER_MAP,
  SeedGuardError,
  fixtureUuid,
  applyUserMapOverrides,
  buildFixturePlan,
  formatPlan,
  executePlan,
  assertSeedAllowed,
  assertTargetIsSeedable,
  PgSeedTarget,
};
