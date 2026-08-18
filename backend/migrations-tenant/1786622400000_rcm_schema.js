'use strict';

/**
 * Per-tenant data-plane: RCM (Revenue Cycle Management) module schema — Slice 1.
 *
 * SCHEMA ONLY. Creates the rcm_* tables the RCM module (formerly the standalone
 * rcm-posting app) will live in. No routes, no data, no OD client code — the
 * importer is Slice 2 and route mounting is Slice 3. Nothing in this migration
 * is reachable until then.
 *
 * Ported from rcm-posting @ `fix/prod-acr-registry-identity` (9bf5ac8),
 * `drizzle/schema.ts` — 23 source tables, of which 21 are ported, 2 excluded
 * (see "NOT PORTED" below). Three tables are platform-native additions.
 *
 * Design decisions (full rationale in docs/RCM_SCHEMA.md + the Slice 1 PR):
 *
 *  - office_id TEXT NOT NULL CHECK IN ('roland','valley') on every data table,
 *    exactly as tc_schema does. The source app has NO office dimension at all —
 *    its own officeSettings comment concedes "office identity is not yet
 *    persisted on transactional rows, so today everything resolves to the
 *    '__default__' row". Office is part of this data model from row one; the
 *    '__default__' sentinel does not survive the port.
 *    TWO documented exceptions, both tenant-global: rcm_user_map (billing staff
 *    work across both offices — the same exception tc_legacy_user_map takes) and
 *    rcm_stedi_poll_state (one Stedi ACCOUNT covers both offices, so the poll
 *    cursor belongs to the account; two per-office rows would double-poll it).
 *
 *  - MONEY IS INTEGER CENTS (*_cents columns), widened from the source's
 *    `integer` to `bigint` to match the platform convention and to put the
 *    ceiling out of reach ($21.4M would have overflowed int4 cents).
 *
 *  - THE REMITTANCE KEY IS THE DEDUPE PRIMITIVE, AND IT IS NOW OFFICE-SCOPED:
 *    UNIQUE (office_id, remittance_key). The source enforced a bare global
 *    UNIQUE(remittanceKey), which in a two-office tenant would have let one
 *    office's remittance block the other's — two practices legitimately receive
 *    distinct checks that hash to the same key components.
 *
 *  - varchar DATES BECOME REAL DATES. The source stores 10 date fields as
 *    varchar(20)/varchar(32) and every `timestamp` without a zone. All become
 *    `date` / `timestamptz`. Full list in the PR description. One consequence
 *    worth stating: `claims.patientDOB` was varchar NOT NULL, which permitted
 *    the empty string; a real `date` cannot, so rcm_claims.patient_dob is
 *    nullable rather than silently rejecting rows at import.
 *
 *  - FULL REFERENTIAL INTEGRITY. The source had 5 FKs across 23 tables (migration
 *    0011); this port declares 27. ON DELETE is chosen per relationship, RESTRICT
 *    by default on anything carrying money — see the FK table in the PR. Two
 *    relationships the source expressed as untyped strings become real FKs:
 *    `depositId` and `matchId` both turned out to be bankTransactions.id
 *    (routers.ts:2540 sets `matchId: input.depositId`; :2573 comments
 *    "matchId = bankTransactionId"), so both now reference rcm_bank_transactions.
 *
 *  - ACTORS ARE CROSSWALK-TYPED. Every createdBy / postedBy / approvedBy /
 *    assigneeUserId / leadUserId varchar becomes a FK to rcm_user_map, the RCM
 *    analogue of tc_legacy_user_map. NULL means "system / automated" — the
 *    source encoded that as the magic string 'system' in postingAudits.postedBy,
 *    which a typed column cannot carry without seeding a fake user.
 *
 *  - ENUMS BECOME text + CHECK, not pgEnum. The source declares 15 pgEnums; this
 *    repo's convention (tc_schema) is text with a CHECK constraint. Same
 *    guarantee, and down() has no enum types left to drop.
 *
 *  - uuid PKs + `legacy_id text UNIQUE` for import idempotency, exactly as
 *    tc_schema does. The source's varchar(64) business ids and serial ints
 *    become legacy_id values, so Slice 2's importer is re-runnable.
 *
 * PLATFORM-NATIVE ADDITIONS (not in the source — designed here):
 *
 *  - rcm_posting_queue + rcm_posting_queue_line: the durable, resumable record
 *    of INTENDED posting that docs/RCM_OD_WRITES.md §8 proves is mandatory. Open
 *    Dental has no transactions (G4), and the worst failure window is between
 *    "claim marked Received" and "check created": the claim reads Received with
 *    money on its lines and no check exists, and recovery "works, but only if
 *    the poster knows exactly which claimprocs it had touched". That is what the
 *    line table records — per-line intended InsPayAmt/WriteOff/DedApplied in
 *    cents with per-line progress, queryable during resume rather than buried in
 *    a jsonb blob.
 *  - rcm_user_map: replaces the source `users` table (see NOT PORTED).
 *
 * NOT PORTED, and why:
 *
 *  - `users` — standalone-app auth (openId, bcrypt passwordHash, its own role
 *    enum). Slice 3 mounts RCM behind the platform's Entra SSO + roles spine, so
 *    porting a second identity store would create exactly the drift the roles
 *    spine exists to prevent. Its one durable job — resolving the actor strings
 *    stamped on historical rows — is taken over by rcm_user_map.
 *  - `plaidItems` — exists only to hold a live Plaid `accessToken` in a plaintext
 *    text column, plus a sync cursor. On this platform credentials live in Key
 *    Vault, never in a tenant table (docs/SECRETS.md). Bank-feed ingestion is not
 *    in Slice 1 or 2; when it is ported, the item/cursor row can return WITHOUT
 *    the token. Flagged for a PM decision rather than ported as-is.
 *
 * TWO SOURCE COLUMNS DELIBERATELY DROPPED:
 *
 *  - `bankTransactions.matchedClaimIds` jsonb — a relationship expressed as an
 *    integrity-free id array. It is derivable: rcm_payment_batches.bank_transaction_id
 *    -> rcm_batch_claim_payments.claim_id. Carrying both would let them disagree.
 *  - `postingAudits.batchId` keeps its column but not its source semantics: the
 *    source declared it NOT NULL *and* gave it ON DELETE SET NULL, which are
 *    contradictory — deleting a batch would have raised a not-null violation
 *    rather than preserving the audit. Resolved as NOT NULL + RESTRICT: a batch
 *    with a posting audit cannot be deleted at all.
 *
 * CARC/RARC: `ClaimAdjReasonCodes` is READ-ONLY over the OD API (RCM_OD_WRITES
 * G3), so structured denial/adjustment reason codes exist ONLY here.
 * rcm_procedure_adjustments carries them as typed columns — group_code (CARC
 * group), reason_code (CARC), remark_code (RARC), amount_cents — never free text.
 *
 * CARRIER EOB DATE: OD's `DateCP` is not writable and returns 200 OK while
 * silently ignoring the write (G2). The carrier's adjudication date therefore
 * lives in OUR schema as first-class data — rcm_posting_queue.carrier_eob_date —
 * and must never be claimed to be in Open Dental.
 *
 * RECOUPMENTS: a negative supplemental is the single irreversible Open Dental
 * operation (G10) — it cannot be reverted and cannot be deleted. It is marked in
 * the schema from day one (rcm_posting_queue.is_recoupment NOT NULL) so Slice 6
 * has something to gate on rather than inferring intent from a sign.
 *
 * PHI: rcm_claims, rcm_batch_claim_payments and rcm_eob_uploads carry patient
 * identity (names, DOB, subscriber ids, raw extraction payloads). Same handling
 * as the tc_* tables. No real patient data appears anywhere in this repo.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

// Least-privilege app role, same mechanism as the audit_log and tc_schema
// migrations: the repo's ONLY per-table grant path is an explicit role-guarded
// GRANT inside the migration (there is no ALTER DEFAULT PRIVILEGES anywhere;
// provisioning grants schema USAGE only). A migration that creates a table
// without granting it is a defect — every rcm_* table below is in RCM_TABLES.
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[rcm_schema migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

const OFFICE_CHECK = "office_id IN ('roland', 'valley')";

/**
 * Every table this migration creates, in creation order (parents before
 * children). down() drops the reverse. Kept as one list so the grant block and
 * the tests cannot drift from the tables.
 */
const RCM_TABLES = [
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
];

/**
 * The tables without office_id — tenant-global, documented exceptions.
 *  - rcm_user_map: billing staff work across both offices (the same exception
 *    tc_legacy_user_map takes).
 *  - rcm_stedi_poll_state: ONE Stedi account covers both offices, so the poll
 *    cursor belongs to the account. Two per-office rows would double-poll it.
 */
const TENANT_GLOBAL_TABLES = ['rcm_user_map', 'rcm_stedi_poll_state'];

/** Shared column fragments (spread into createTable). */
function officeCol() {
  // Frozen internal office keys — see docs/RCM_SCHEMA.md.
  return { office_id: { type: 'text', notNull: true } };
}
function timestamps(pgm) {
  return {
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  };
}
/**
 * An actor column: the crosswalk-typed replacement for the source's untyped
 * varchar(64) user strings. NULL = system / automated (the source's magic
 * 'system' string). RESTRICT because attribution must not be erasable by
 * deleting a user row.
 */
function actorCol() {
  return { type: 'text', references: 'rcm_user_map', onDelete: 'RESTRICT' };
}

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // ── rcm_user_map ─────────────────────────────────────────────────────────
  // Standalone rcm-posting user key -> platform identity (email). Tenant-global
  // by design: billing staff work across both offices, so this is the ONE rcm_*
  // table without office_id (documented exception, same as tc_legacy_user_map).
  // Every actor/approver column in this migration references it.
  pgm.createTable('rcm_user_map', {
    user_key: { type: 'text', primaryKey: true }, // source users.openId / createdBy / postedBy value
    platform_email: { type: 'text', notNull: true },
    display_name: { type: 'text', notNull: true, default: '' },
    legacy_role: { type: 'text', notNull: true, default: '' }, // source roleEnum: user|poster|lead|admin
    active: { type: 'boolean', notNull: true, default: true },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_user_map', 'rcm_user_map_email_lower_check', {
    check: 'platform_email = lower(platform_email)',
  });

  // ── rcm_payer_rules ──────────────────────────────────────────────────────
  // Per-office because plan terms are negotiated per practice. The source's
  // global UNIQUE(payerName) becomes UNIQUE(office_id, payer_name).
  pgm.createTable('rcm_payer_rules', {
    payer_rule_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    ...officeCol(),
    payer_name: { type: 'text', notNull: true },
    preventive_coverage_pct: { type: 'integer', notNull: true, default: 100 },
    basic_coverage_pct: { type: 'integer', notNull: true, default: 80 },
    major_coverage_pct: { type: 'integer', notNull: true, default: 50 },
    orthodontic_coverage_pct: { type: 'integer', notNull: true, default: 50 },
    annual_maximum_cents: { type: 'bigint', notNull: true, default: 150000 },
    deductible_cents: { type: 'bigint', notNull: true, default: 5000 },
    filing_limit_days: { type: 'integer', notNull: true, default: 365 },
    resubmission_limit_days: { type: 'integer', notNull: true, default: 180 },
    frequency_limits: { type: 'jsonb' },
    notes: { type: 'text', notNull: true, default: '' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_payer_rules', 'rcm_payer_rules_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('rcm_payer_rules', 'rcm_payer_rules_office_payer_unique', {
    unique: ['office_id', 'payer_name'],
  });

  // ── rcm_office_settings ──────────────────────────────────────────────────
  // Merchant discount rate used to price what a virtual card actually cost.
  // office_id IS the primary key — the source's '__default__' sentinel row
  // existed only because that app had no office dimension.
  pgm.createTable('rcm_office_settings', {
    office_id: { type: 'text', primaryKey: true },
    merchant_fee_bps: { type: 'integer', notNull: true, default: 250 }, // 250 = 2.50%; money math stays integer
    notes: { type: 'text', notNull: true, default: '' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_office_settings', 'rcm_office_settings_office_check', {
    check: OFFICE_CHECK,
  });

  // ── rcm_vcc_processor_patterns ───────────────────────────────────────────
  // Virtual-card processors change constantly and each office sees a different
  // mix, so identifying patterns are rows: adding a processor is an INSERT.
  pgm.createTable('rcm_vcc_processor_patterns', {
    pattern_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    ...officeCol(),
    processor: { type: 'text', notNull: true }, // Zelis, VPay, …
    pattern_type: { type: 'text', notNull: true },
    pattern: { type: 'text', notNull: true }, // case-insensitive substring, or regex source when is_regex
    is_regex: { type: 'boolean', notNull: true, default: false },
    weight: { type: 'integer', notNull: true, default: 40 }, // points contributed to vcc_likelihood
    active: { type: 'boolean', notNull: true, default: true },
    notes: { type: 'text', notNull: true, default: '' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_vcc_processor_patterns', 'rcm_vcc_processor_patterns_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_vcc_processor_patterns', 'rcm_vcc_patterns_office_type_pattern_unique', {
    unique: ['office_id', 'pattern_type', 'pattern'],
  });

  // ── rcm_stedi_poll_state ─────────────────────────────────────────────────
  // Last pageToken for polling recovery.
  //
  // TENANT-GLOBAL — the second documented exception to office-id-on-every-table,
  // and the only one that is not about staff. ONE Stedi account covers both
  // offices (confirmed by Beau, PM review of PR #81), and the cursor belongs to
  // that ACCOUNT, not to a practice. Two per-office rows would each walk the
  // same feed and double-poll it.
  //
  // Office attribution is not lost, it just happens one layer down: an inbound
  // 835 is attributed by payee onto rcm_stedi_events / rcm_stedi_transactions,
  // both of which keep their office_id. The cursor says HOW FAR we have read;
  // those rows say WHOSE money arrived.
  //
  // Singleton by construction: the PK is a constant, so a second cursor row is
  // a constraint violation rather than a silent second reader.
  pgm.createTable('rcm_stedi_poll_state', {
    poll_state_id: { type: 'text', primaryKey: true, default: 'stedi' },
    page_token: { type: 'text', notNull: true },
    last_poll_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    transactions_processed: { type: 'integer', notNull: true, default: 0 },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_stedi_poll_state', 'rcm_stedi_poll_state_singleton_check', {
    check: "poll_state_id = 'stedi'",
  });

  // ── rcm_stedi_events ─────────────────────────────────────────────────────
  // Webhook events from Stedi, kept for idempotency. event_id is Stedi's own
  // globally-unique id, so its UNIQUE is not office-scoped (unlike the
  // remittance key, which we compute) — and rcm_claims references it.
  pgm.createTable('rcm_stedi_events', {
    stedi_event_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    ...officeCol(),
    event_id: { type: 'text', notNull: true, unique: true }, // vendor id
    transaction_id: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    raw_payload: { type: 'jsonb', notNull: true },
    processed: { type: 'boolean', notNull: true, default: false },
    processed_at: { type: 'timestamptz' },
    error_message: { type: 'text' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_stedi_events', 'rcm_stedi_events_office_check', { check: OFFICE_CHECK });
  pgm.createIndex('rcm_stedi_events', ['office_id', 'processed'], {
    name: 'rcm_stedi_events_office_processed_idx',
  });

  // ── rcm_stedi_transactions ───────────────────────────────────────────────
  // 835/837 transaction metadata. batch_id's FK is added AFTER
  // rcm_payment_batches exists — the two tables reference each other.
  pgm.createTable('rcm_stedi_transactions', {
    stedi_transaction_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    ...officeCol(),
    transaction_id: { type: 'text', notNull: true, unique: true }, // vendor id
    file_execution_id: { type: 'text' },
    transaction_set_identifier: { type: 'text' }, // "835"
    direction: { type: 'text' },
    processed_at: { type: 'timestamptz' },
    status: { type: 'text' },
    error_message: { type: 'text' },
    raw_report: { type: 'jsonb' },
    claims_created: { type: 'integer', notNull: true, default: 0 },
    batch_id: { type: 'uuid' }, // FK added below, after rcm_payment_batches
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_stedi_transactions', 'rcm_stedi_transactions_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_stedi_transactions', 'rcm_stedi_transactions_direction_check', {
    check: "direction IS NULL OR direction IN ('RECEIVED','SENT')",
  });
  pgm.addConstraint('rcm_stedi_transactions', 'rcm_stedi_transactions_status_check', {
    check: "status IS NULL OR status IN ('success','failed')",
  });

  // ── rcm_bank_transactions ────────────────────────────────────────────────
  // The bank-side deposit. Referred to as "the deposit" throughout the module:
  // the source's handoffTasks.depositId, depositAuditEvents.depositId,
  // approvalRequests.depositId AND approvalRequests.matchId all resolve here.
  // The source's matchedClaimIds jsonb is dropped — see the header.
  pgm.createTable('rcm_bank_transactions', {
    bank_transaction_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    legacy_id: { type: 'text', unique: true },
    ...officeCol(),
    posted_date: { type: 'date', notNull: true }, // was varchar(20) `date`
    description: { type: 'text', notNull: true },
    amount_cents: { type: 'bigint', notNull: true, default: 0 },
    type: { type: 'text', notNull: true, default: 'eft' },
    payer: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'unmatched' },
    account_last4: { type: 'text' },
    trace_number: { type: 'text' }, // EFT trace from the bank feed, matched against the ERA TRN
    follow_up_at: { type: 'timestamptz' }, // was varchar(32)
    secondary_task_id: { type: 'uuid' }, // FK added below, after rcm_handoff_tasks
    misc_payment_id: { type: 'text' }, // opaque in the source; left untyped pending Slice 2
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_bank_transactions', 'rcm_bank_transactions_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_bank_transactions', 'rcm_bank_transactions_type_check', {
    check: "type IN ('eft','check','ach')",
  });
  pgm.addConstraint('rcm_bank_transactions', 'rcm_bank_transactions_status_check', {
    check:
      "status IN ('new','pending_era','ready','partial','matched','unmatched','variance','exception')",
  });
  pgm.createIndex('rcm_bank_transactions', ['office_id', 'status'], {
    name: 'rcm_bank_txns_office_status_idx',
  });
  pgm.createIndex('rcm_bank_transactions', ['office_id', 'posted_date'], {
    name: 'rcm_bank_txns_office_date_idx',
  });
  pgm.createIndex('rcm_bank_transactions', 'trace_number', {
    name: 'rcm_bank_txns_trace_idx',
  });

  // ── rcm_claims ───────────────────────────────────────────────────────────
  // PHI: patient_name, patient_dob, subscriber_id, raw_extracted_json.
  pgm.createTable('rcm_claims', {
    claim_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true },
    ...officeCol(),

    claim_number: { type: 'text', notNull: true },
    check_number: { type: 'text', notNull: true, default: '' },

    // Patient identity (PHI).
    patient_name: { type: 'text', notNull: true },
    // Nullable by necessity: the source column was varchar NOT NULL, which
    // admitted ''. A real date cannot, and dropping the row would be worse.
    patient_dob: { type: 'date' },
    subscriber_id: { type: 'text', notNull: true, default: '' },
    group_number: { type: 'text', notNull: true, default: '' },

    // Open Dental linkage. Platform-native: a PatNum is meaningless without its
    // office (hard rule 3), and office_id above is what makes these safe to store.
    od_patient_id: { type: 'bigint' },
    od_claim_num: { type: 'bigint' },

    payer: { type: 'text', notNull: true },
    service_date: { type: 'date' }, // was varchar(20)
    received_date: { type: 'date' }, // was varchar(20)
    status: { type: 'text', notNull: true, default: 'processing' },
    source: { type: 'text', notNull: true, default: 'manual_upload' },

    total_billed_cents: { type: 'bigint', notNull: true, default: 0 },
    total_allowed_cents: { type: 'bigint', notNull: true, default: 0 },
    total_deductible_cents: { type: 'bigint', notNull: true, default: 0 },
    total_copay_cents: { type: 'bigint', notNull: true, default: 0 },
    total_paid_cents: { type: 'bigint', notNull: true, default: 0 },
    total_received_cents: { type: 'bigint', notNull: true, default: 0 },
    patient_balance_cents: { type: 'bigint', notNull: true, default: 0 },

    provider_npi: { type: 'text', notNull: true, default: '' },
    rendering_provider: { type: 'text', notNull: true, default: '' },

    pms_synced: { type: 'boolean', notNull: true, default: false },
    bank_matched: { type: 'boolean', notNull: true, default: false },
    payment_status: { type: 'text', notNull: true, default: 'unpaid' },

    // Coordination of benefits.
    insurance_type: { type: 'text', notNull: true, default: 'primary' },
    primary_claim_id: { type: 'uuid', references: 'rcm_claims', onDelete: 'SET NULL' },
    cob_sequence: { type: 'integer', notNull: true, default: 1 },

    confidence: { type: 'integer', notNull: true, default: 0 },
    processing_time_sec: { type: 'integer', notNull: true, default: 0 },
    raw_extracted_json: { type: 'jsonb' }, // PHI — full extraction payload
    eob_file_key: { type: 'text' },
    eob_file_url: { type: 'text' },
    // Machine-readable reasons the extraction needs human review. Empty = clean.
    // jsonb string[] in the source; text[] here, as tc_schema does.
    needs_review_reasons: { type: 'text[]', notNull: true, default: '{}' },

    stedi_transaction_id: { type: 'text' }, // FK to the vendor id, added below
    stedi_event_id: { type: 'text' }, // FK to the vendor id, added below

    archived_at: { type: 'timestamptz' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_claims', 'rcm_claims_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('rcm_claims', 'rcm_claims_status_check', {
    check: "status IN ('posted','pending_review','processing','error','matched')",
  });
  pgm.addConstraint('rcm_claims', 'rcm_claims_source_check', {
    check: "source IN ('clearinghouse','portal_rpa','email_parse','manual_upload')",
  });
  pgm.addConstraint('rcm_claims', 'rcm_claims_payment_status_check', {
    check: "payment_status IN ('unpaid','partial','paid','overpaid','reversed')",
  });
  pgm.addConstraint('rcm_claims', 'rcm_claims_insurance_type_check', {
    check: "insurance_type IN ('primary','secondary','tertiary')",
  });
  pgm.addConstraint('rcm_claims', 'rcm_claims_stedi_txn_fk', {
    foreignKeys: {
      columns: 'stedi_transaction_id',
      references: 'rcm_stedi_transactions(transaction_id)',
      onDelete: 'SET NULL',
    },
  });
  pgm.addConstraint('rcm_claims', 'rcm_claims_stedi_event_fk', {
    foreignKeys: {
      columns: 'stedi_event_id',
      references: 'rcm_stedi_events(event_id)',
      onDelete: 'SET NULL',
    },
  });
  pgm.createIndex('rcm_claims', ['office_id', 'status'], { name: 'rcm_claims_office_status_idx' });
  pgm.createIndex('rcm_claims', ['office_id', 'payer'], { name: 'rcm_claims_office_payer_idx' });
  pgm.createIndex('rcm_claims', ['office_id', 'claim_number'], {
    name: 'rcm_claims_office_number_idx',
  });
  pgm.createIndex('rcm_claims', 'od_patient_id', { name: 'rcm_claims_od_patient_idx' });
  pgm.createIndex('rcm_claims', 'archived_at', { name: 'rcm_claims_archived_idx' });

  // ── rcm_procedure_lines ──────────────────────────────────────────────────
  pgm.createTable('rcm_procedure_lines', {
    line_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    claim_id: { type: 'uuid', notNull: true, references: 'rcm_claims', onDelete: 'CASCADE' },
    ...officeCol(),
    position: { type: 'integer', notNull: true }, // the source's serial id = line order
    billed_code: { type: 'text', notNull: true },
    paid_code: { type: 'text' }, // set when the carrier downcoded
    code: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true, default: '' },
    billed_cents: { type: 'bigint', notNull: true, default: 0 },
    allowed_cents: { type: 'bigint', notNull: true, default: 0 },
    deductible_cents: { type: 'bigint', notNull: true, default: 0 },
    copay_cents: { type: 'bigint', notNull: true, default: 0 },
    paid_cents: { type: 'bigint', notNull: true, default: 0 },
    adjustment_cents: { type: 'bigint', notNull: true, default: 0 },
    patient_resp_cents: { type: 'bigint', notNull: true, default: 0 },
    write_off_cents: { type: 'bigint', notNull: true, default: 0 },
    adjustment_reason: { type: 'text' }, // free text; the STRUCTURED codes live in rcm_procedure_adjustments
    is_downcoded: { type: 'boolean', notNull: true, default: false },
    is_bundled: { type: 'boolean', notNull: true, default: false },
    is_denied: { type: 'boolean', notNull: true, default: false },
    flags: { type: 'text[]', notNull: true, default: '{}' },
    // Platform-native: the OD ClaimProcNum this line adjudicates, once matched.
    od_claim_proc_num: { type: 'bigint' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_procedure_lines', 'rcm_procedure_lines_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_procedure_lines', 'rcm_procedure_lines_claim_position_unique', {
    unique: ['claim_id', 'position'],
  });
  // The source's procedure_flag enum, enforced over the array rather than lost.
  pgm.addConstraint('rcm_procedure_lines', 'rcm_procedure_lines_flags_check', {
    check:
      "flags <@ ARRAY['downcode','bundled','denied','partial_pay','unexplained_adj','frequency_limit','not_covered','pre_auth_required']::text[]",
  });
  pgm.createIndex('rcm_procedure_lines', 'claim_id', { name: 'rcm_procedure_lines_claim_idx' });

  // ── rcm_procedure_adjustments ────────────────────────────────────────────
  // CARC/RARC. OD's ClaimAdjReasonCodes is read-only over the API (G3), so this
  // table is the ONLY structured home for denial and adjustment reason codes.
  // The industry standard allows 3+ per line, hence a table rather than columns.
  pgm.createTable('rcm_procedure_adjustments', {
    adjustment_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    procedure_line_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_procedure_lines',
      onDelete: 'CASCADE',
    },
    claim_id: { type: 'uuid', notNull: true, references: 'rcm_claims', onDelete: 'CASCADE' },
    ...officeCol(),
    group_code: { type: 'text', notNull: true }, // CARC group: CO/PR/OA/PI/CR
    reason_code: { type: 'text', notNull: true }, // CARC
    reason_description: { type: 'text', notNull: true, default: '' },
    amount_cents: { type: 'bigint', notNull: true, default: 0 },
    quantity: { type: 'integer', notNull: true, default: 1 },
    remark_code: { type: 'text' }, // RARC
    remark_description: { type: 'text', notNull: true, default: '' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_procedure_adjustments', 'rcm_procedure_adjustments_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_procedure_adjustments', 'rcm_procedure_adjustments_group_check', {
    check: "group_code IN ('CO','PR','OA','PI','CR')",
  });
  pgm.createIndex('rcm_procedure_adjustments', 'claim_id', {
    name: 'rcm_procedure_adjustments_claim_idx',
  });
  pgm.createIndex('rcm_procedure_adjustments', 'procedure_line_id', {
    name: 'rcm_procedure_adjustments_line_idx',
  });

  // ── rcm_activity_events ──────────────────────────────────────────────────
  // Module activity feed. NOT the platform audit_log — that stays append-only
  // and is untouched by this migration.
  pgm.createTable('rcm_activity_events', {
    activity_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true },
    ...officeCol(),
    ts: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    type: { type: 'text', notNull: true, default: 'received' },
    message: { type: 'text', notNull: true },
    detail: { type: 'text' },
    claim_id: { type: 'uuid', references: 'rcm_claims', onDelete: 'CASCADE' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_activity_events', 'rcm_activity_events_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_activity_events', 'rcm_activity_events_type_check', {
    check: "type IN ('posted','extracted','matched','error','synced','received')",
  });
  pgm.createIndex('rcm_activity_events', ['office_id', 'ts'], {
    name: 'rcm_activity_events_office_ts_idx',
  });

  // ── rcm_payment_batches ──────────────────────────────────────────────────
  // One carrier check/EFT, spanning many claims — the real-world EOB shape, and
  // the same shape OD's POST /claimpayments/Batch takes.
  pgm.createTable('rcm_payment_batches', {
    batch_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true },
    ...officeCol(),
    bank_transaction_id: {
      type: 'uuid',
      references: 'rcm_bank_transactions',
      onDelete: 'SET NULL',
    },
    check_number: { type: 'text' },
    eft_number: { type: 'text' },
    // How the payer actually sent the money, from the ERA's BPR04. Drives the
    // PayType stamped on the Open Dental payment — a per-office DefNum
    // (Category 32), never a hardcode. See RCM_OD_WRITES §1.
    payment_method: { type: 'text' },
    payer: { type: 'text', notNull: true },
    deposit_date: { type: 'date' }, // was varchar(20)
    total_amount_cents: { type: 'bigint', notNull: true, default: 0 },
    posted_amount_cents: { type: 'bigint', notNull: true, default: 0 },
    claim_count: { type: 'integer', notNull: true, default: 0 },
    status: { type: 'text', notNull: true, default: 'open' },
    era_file_key: { type: 'text' },
    era_file_url: { type: 'text' },
    stedi_transaction_id: { type: 'text' }, // FK to the vendor id, added below
    // EFT trace fields, from the ERA's TRN segment.
    trace_number: { type: 'text' },
    trace_originator_id: { type: 'text' },
    // Provider Level Balance adjustments — author-owned deep structure,
    // validated at the edge rather than normalized into tables.
    plb_adjustments: { type: 'jsonb' },
    plb_total_cents: { type: 'bigint', notNull: true, default: 0 },
    // The engine's second opinion (validation issues, reconciliation vs the
    // deposit, plan summary). Annotation only; never consulted by a write path.
    engine_validation: { type: 'jsonb' },
    // Virtual-credit-card detection: heuristic score plus the evidence behind
    // it, because "this is a virtual card" is a claim staff must be able to
    // argue with. NULL = not scored.
    vcc_likelihood: { type: 'integer' },
    vcc_signals: { type: 'jsonb' },
    vcc_processor: { type: 'text' },
    vcc_confirmed: { type: 'boolean' }, // null = suspected · true = confirmed · false = cleared
    notes: { type: 'text', notNull: true, default: '' },
    created_by: actorCol(),
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_payment_batches', 'rcm_payment_batches_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_payment_batches', 'rcm_payment_batches_status_check', {
    check: "status IN ('open','ready','posting','balanced','unbalanced','posted','error')",
  });
  pgm.addConstraint('rcm_payment_batches', 'rcm_payment_batches_payment_method_check', {
    check: "payment_method IS NULL OR payment_method IN ('check','eft')",
  });
  pgm.addConstraint('rcm_payment_batches', 'rcm_payment_batches_stedi_txn_fk', {
    foreignKeys: {
      columns: 'stedi_transaction_id',
      references: 'rcm_stedi_transactions(transaction_id)',
      onDelete: 'SET NULL',
    },
  });
  pgm.createIndex('rcm_payment_batches', ['office_id', 'status'], {
    name: 'rcm_payment_batches_office_status_idx',
  });
  pgm.createIndex('rcm_payment_batches', 'bank_transaction_id', {
    name: 'rcm_payment_batches_bank_txn_idx',
  });
  pgm.createIndex('rcm_payment_batches', 'vcc_likelihood', {
    name: 'rcm_payment_batches_vcc_idx',
  });

  // The back-reference completing the batch <-> stedi transaction pair. Added
  // here rather than at creation because the two tables reference each other.
  pgm.addConstraint('rcm_stedi_transactions', 'rcm_stedi_transactions_batch_fk', {
    foreignKeys: {
      columns: 'batch_id',
      references: 'rcm_payment_batches(batch_id)',
      onDelete: 'SET NULL',
    },
  });

  // ── rcm_batch_claim_payments ─────────────────────────────────────────────
  // One claim's money within a batch. PHI: patient_name, subscriber_id.
  pgm.createTable('rcm_batch_claim_payments', {
    batch_claim_payment_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    batch_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_payment_batches',
      onDelete: 'CASCADE',
    },
    // RESTRICT, not CASCADE: a claim with money posted against it must not be
    // deletable — the same stance Open Dental itself takes ("Claim cannot be
    // deleted. Procedure(s) have an insurance payment attached.").
    claim_id: { type: 'uuid', references: 'rcm_claims', onDelete: 'RESTRICT' },
    ...officeCol(),
    position: { type: 'integer', notNull: true },
    patient_name: { type: 'text' }, // PHI
    subscriber_id: { type: 'text' },
    claim_number: { type: 'text' },
    service_date: { type: 'date' }, // was varchar(20)
    paid_cents: { type: 'bigint', notNull: true, default: 0 },
    allowed_cents: { type: 'bigint', notNull: true, default: 0 },
    adjustment_cents: { type: 'bigint', notNull: true, default: 0 },
    patient_resp_cents: { type: 'bigint', notNull: true, default: 0 },
    status: { type: 'text', notNull: true, default: 'pending' },
    match_confidence: { type: 'integer', notNull: true, default: 0 },
    error_message: { type: 'text' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_batch_claim_payments', 'rcm_batch_claim_payments_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_batch_claim_payments', 'rcm_batch_claim_payments_status_check', {
    check: "status IN ('pending','posting','posted','error','skipped')",
  });
  pgm.addConstraint('rcm_batch_claim_payments', 'rcm_batch_claim_payments_batch_position_unique', {
    unique: ['batch_id', 'position'],
  });
  pgm.createIndex('rcm_batch_claim_payments', 'batch_id', {
    name: 'rcm_batch_claim_payments_batch_idx',
  });
  pgm.createIndex('rcm_batch_claim_payments', 'claim_id', {
    name: 'rcm_batch_claim_payments_claim_idx',
  });

  // ── rcm_claim_payment_history ────────────────────────────────────────────
  // Every payment event for a claim — split payments, reversals, takebacks.
  // RESTRICT on both parents: deleting a claim or a batch must never silently
  // erase the money trail.
  pgm.createTable('rcm_claim_payment_history', {
    payment_history_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    claim_id: { type: 'uuid', notNull: true, references: 'rcm_claims', onDelete: 'RESTRICT' },
    batch_id: { type: 'uuid', references: 'rcm_payment_batches', onDelete: 'RESTRICT' },
    ...officeCol(),
    payment_type: { type: 'text', notNull: true, default: 'payment' },
    amount_cents: { type: 'bigint', notNull: true }, // legitimately negative for reversals/takebacks
    check_number: { type: 'text' },
    eft_number: { type: 'text' },
    payer: { type: 'text' },
    payment_date: { type: 'date' }, // was varchar(20)
    reason: { type: 'text' },
    reason_code: { type: 'text' },
    notes: { type: 'text', notNull: true, default: '' },
    requires_approval: { type: 'boolean', notNull: true, default: false },
    approved_by: actorCol(),
    approved_at: { type: 'timestamptz' },
    created_by: actorCol(),
    archived_at: { type: 'timestamptz' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_claim_payment_history', 'rcm_claim_payment_history_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_claim_payment_history', 'rcm_claim_payment_history_type_check', {
    check: "payment_type IN ('payment','reversal','adjustment','refund','takeback')",
  });
  pgm.createIndex('rcm_claim_payment_history', ['claim_id', 'created_at'], {
    name: 'rcm_claim_payment_history_claim_idx',
  });

  // ── rcm_eob_uploads ──────────────────────────────────────────────────────
  // Uploaded EOB documents. file_hash detects re-uploads of the same physical
  // document under a different filename — indexed, not unique, because a
  // deliberate re-upload is legitimate.
  pgm.createTable('rcm_eob_uploads', {
    upload_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    ...officeCol(),
    filename: { type: 'text', notNull: true }, // PHI — filenames routinely carry patient names
    file_key: { type: 'text', notNull: true },
    file_url: { type: 'text', notNull: true },
    file_hash: { type: 'text' }, // SHA-256 of the bytes
    file_size_bytes: { type: 'bigint' },
    content_type: { type: 'text' },
    bank_transaction_id: {
      type: 'uuid',
      references: 'rcm_bank_transactions',
      onDelete: 'SET NULL',
    },
    result_batch_id: { type: 'uuid', references: 'rcm_payment_batches', onDelete: 'SET NULL' },
    result_claim_id: { type: 'uuid', references: 'rcm_claims', onDelete: 'SET NULL' },
    status: { type: 'text', notNull: true, default: 'uploaded' },
    error_message: { type: 'text' },
    uploaded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    processed_at: { type: 'timestamptz' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_eob_uploads', 'rcm_eob_uploads_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('rcm_eob_uploads', 'rcm_eob_uploads_status_check', {
    check: "status IN ('uploaded','processing','extracted','failed')",
  });
  pgm.createIndex('rcm_eob_uploads', ['office_id', 'file_hash'], {
    name: 'rcm_eob_uploads_office_hash_idx',
  });
  pgm.createIndex('rcm_eob_uploads', ['office_id', 'status'], {
    name: 'rcm_eob_uploads_office_status_idx',
  });

  // ── rcm_posting_audits ───────────────────────────────────────────────────
  // The record of what a posting run actually did against Open Dental.
  // batch_id is NOT NULL + RESTRICT: the source declared it NOT NULL while
  // giving its FK ON DELETE SET NULL, which could only ever have raised a
  // not-null violation. A batch with a posting audit is not deletable.
  pgm.createTable('rcm_posting_audits', {
    posting_audit_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true },
    ...officeCol(),
    batch_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_payment_batches',
      onDelete: 'RESTRICT',
    },
    bank_transaction_id: {
      type: 'uuid',
      references: 'rcm_bank_transactions',
      onDelete: 'SET NULL',
    },

    // Pre-posting snapshot.
    bank_deposit_cents: { type: 'bigint' },
    bank_deposit_date: { type: 'date' }, // was varchar(20)
    bank_payer: { type: 'text' },
    era_total_cents: { type: 'bigint' },
    era_check_number: { type: 'text' },
    variance_cents: { type: 'bigint' },

    // Preflight results.
    preflight_status: { type: 'text' },
    patients_found: { type: 'integer' },
    patients_missing: { type: 'integer' },
    claims_found: { type: 'integer' },
    claims_already_paid: { type: 'integer' },

    // Posting results.
    claims_posted: { type: 'integer', notNull: true, default: 0 },
    claims_skipped: { type: 'integer', notNull: true, default: 0 },
    claims_errored: { type: 'integer', notNull: true, default: 0 },
    claim_details: { type: 'jsonb' }, // PHI — per-claim outcome incl. patient name

    status: { type: 'text', notNull: true },
    error_message: { type: 'text' },

    // NULL = automated/system. Open Dental's own audit trail cannot distinguish
    // WHICH operator posted (every API write logs UserNum 0 — RCM_OD_WRITES §9),
    // so this column and the platform audit_log are the only attribution there is.
    posted_by: actorCol(),
    posted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    archived_at: { type: 'timestamptz' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_posting_audits', 'rcm_posting_audits_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_posting_audits', 'rcm_posting_audits_status_check', {
    check: "status IN ('success','partial','failed')",
  });
  pgm.createIndex('rcm_posting_audits', ['office_id', 'posted_at'], {
    name: 'rcm_posting_audits_office_posted_idx',
  });
  pgm.createIndex('rcm_posting_audits', 'batch_id', { name: 'rcm_posting_audits_batch_idx' });

  // ── rcm_remittance_keys ──────────────────────────────────────────────────
  // THE double-posting guard. Identity components: trace number, payer,
  // payment date, amount — hashed into remittance_key.
  //
  // UNIQUE (office_id, remittance_key), NOT a bare global unique: two practices
  // legitimately receive distinct checks whose components collide, and a global
  // key would let one office's remittance silently block the other's.
  //
  // Reservation protocol: 'pending' is reserved BEFORE the OD write, 'posted'
  // finalized after, 'failed' released (retryable). A stuck 'pending' means a
  // crashed post — verify in OD before clearing it.
  pgm.createTable('rcm_remittance_keys', {
    remittance_key_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    ...officeCol(),
    trace_number: { type: 'text', notNull: true },
    payer_id: { type: 'text', notNull: true },
    payment_date: { type: 'date', notNull: true }, // was varchar(20)
    payment_amount_cents: { type: 'bigint', notNull: true },
    check_number: { type: 'text' },
    remittance_key: { type: 'text', notNull: true },
    // SET NULL, not RESTRICT: the key must OUTLIVE the batch. Its whole job is
    // to make a remittance un-repostable, and that must survive cleanup.
    batch_id: { type: 'uuid', references: 'rcm_payment_batches', onDelete: 'SET NULL' },
    posting_audit_id: {
      type: 'uuid',
      references: 'rcm_posting_audits',
      onDelete: 'SET NULL',
    },
    status: { type: 'text', notNull: true, default: 'posted' },
    reserved_at: { type: 'timestamptz' },
    posted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_remittance_keys', 'rcm_remittance_keys_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_remittance_keys', 'rcm_remittance_keys_status_check', {
    check: "status IN ('pending','posted','failed')",
  });
  pgm.addConstraint('rcm_remittance_keys', 'rcm_remittance_keys_office_key_unique', {
    unique: ['office_id', 'remittance_key'],
  });
  pgm.createIndex('rcm_remittance_keys', ['office_id', 'status'], {
    name: 'rcm_remittance_keys_office_status_idx',
  });
  pgm.createIndex('rcm_remittance_keys', 'batch_id', { name: 'rcm_remittance_keys_batch_idx' });

  // ── rcm_handoff_tasks ────────────────────────────────────────────────────
  // Durable, multi-user handoff work raised during posting.
  pgm.createTable('rcm_handoff_tasks', {
    task_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true },
    ...officeCol(),
    deposit_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_bank_transactions',
      onDelete: 'RESTRICT',
    },
    type: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'OPEN' },
    summary: { type: 'text', notNull: true, default: '' },
    payload: { type: 'jsonb' },
    assignee_user_key: actorCol(),
    created_by_user_key: actorCol(),
    actor_role: { type: 'text' },
    completed_at: { type: 'timestamptz' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_handoff_tasks', 'rcm_handoff_tasks_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('rcm_handoff_tasks', 'rcm_handoff_tasks_type_check', {
    check:
      "type IN ('SECONDARY','DENIAL','MISSING_INFO','MISSING_ERA','RECOUPMENT','RECON_VARIANCE','OTHER')",
  });
  pgm.addConstraint('rcm_handoff_tasks', 'rcm_handoff_tasks_status_check', {
    check: "status IN ('OPEN','IN_PROGRESS','DONE')",
  });
  // At most one OPEN task per (deposit, type) — the source's partial unique
  // index, which is what makes task creation idempotent.
  pgm.createIndex('rcm_handoff_tasks', ['deposit_id', 'type'], {
    name: 'rcm_handoff_tasks_deposit_type_open_idx',
    unique: true,
    where: "status = 'OPEN'",
  });
  pgm.createIndex('rcm_handoff_tasks', ['office_id', 'type', 'status'], {
    name: 'rcm_handoff_tasks_office_type_status_idx',
  });

  // The bank transaction's pointer at the secondary-insurance task it spawned.
  // Added here because rcm_bank_transactions is created first.
  pgm.addConstraint('rcm_bank_transactions', 'rcm_bank_transactions_secondary_task_fk', {
    foreignKeys: {
      columns: 'secondary_task_id',
      references: 'rcm_handoff_tasks(task_id)',
      onDelete: 'SET NULL',
    },
  });

  // ── rcm_deposit_audit_events ─────────────────────────────────────────────
  // Per-deposit workflow trail (match confirm, preflight, post). A DOMAIN
  // timeline, distinct from both rcm_posting_audits (batch/OD-scoped) and the
  // platform's append-only audit_log, which this migration does not touch.
  pgm.createTable('rcm_deposit_audit_events', {
    event_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    ...officeCol(),
    deposit_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_bank_transactions',
      onDelete: 'RESTRICT',
    },
    actor_user_key: actorCol(),
    actor_role: { type: 'text' },
    action: { type: 'text', notNull: true },
    detail: { type: 'jsonb' },
    client_event_id: { type: 'text' }, // client-supplied idempotency token
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_deposit_audit_events', 'rcm_deposit_audit_events_office_check', {
    check: OFFICE_CHECK,
  });
  // Partial: only rows that carry a token are deduped by it.
  pgm.createIndex('rcm_deposit_audit_events', ['deposit_id', 'client_event_id'], {
    name: 'rcm_deposit_audit_events_client_event_idx',
    unique: true,
    where: 'client_event_id IS NOT NULL',
  });
  pgm.createIndex('rcm_deposit_audit_events', ['deposit_id', 'created_at'], {
    name: 'rcm_deposit_audit_events_deposit_idx',
  });

  // ── rcm_approval_requests ────────────────────────────────────────────────
  // Variance overrides needing lead/admin sign-off.
  //
  // deposit_id and match_id are BOTH bank transactions — the source's
  // routers.ts sets `matchId: input.depositId` and comments "matchId =
  // bankTransactionId from the deposit matching flow". Both are typed here
  // rather than left as strings; collapsing them is a Slice 3 decision.
  pgm.createTable('rcm_approval_requests', {
    approval_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true },
    ...officeCol(),
    deposit_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_bank_transactions',
      onDelete: 'RESTRICT',
    },
    match_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_bank_transactions',
      onDelete: 'RESTRICT',
    },
    variance_cents: { type: 'bigint', notNull: true },
    reason: { type: 'text', notNull: true },
    category: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'PENDING' },
    note: { type: 'text', notNull: true, default: '' },
    lead_user_key: actorCol(),
    created_by: actorCol(),
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_approval_requests', 'rcm_approval_requests_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_approval_requests', 'rcm_approval_requests_category_check', {
    check:
      "category IN ('BUNDLED_INCOMPLETE','ERA_MISMATCH','POSTING_MISMATCH','RECOUPMENT','NON_ERA','OTHER')",
  });
  pgm.addConstraint('rcm_approval_requests', 'rcm_approval_requests_status_check', {
    check: "status IN ('PENDING','APPROVED','REJECTED')",
  });
  pgm.createIndex('rcm_approval_requests', ['office_id', 'status'], {
    name: 'rcm_approval_requests_office_status_idx',
  });

  // ── rcm_recon_runs ───────────────────────────────────────────────────────
  // One row per three-way reconciliation run. Two source columns are renamed
  // off reserved-ish words: `rows` -> row_details, `trigger` -> trigger_source.
  pgm.createTable('rcm_recon_runs', {
    recon_run_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true },
    ...officeCol(),
    run_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    window_start: { type: 'timestamptz', notNull: true },
    window_end: { type: 'timestamptz', notNull: true },
    batches_checked: { type: 'integer', notNull: true, default: 0 },
    balanced_count: { type: 'integer', notNull: true, default: 0 },
    od_pending_count: { type: 'integer', notNull: true, default: 0 },
    unlinked_count: { type: 'integer', notNull: true, default: 0 },
    variance_count: { type: 'integer', notNull: true, default: 0 },
    variance_total_cents: { type: 'bigint', notNull: true, default: 0 },
    row_details: { type: 'jsonb' }, // full ThreeWayRow[] for drill-down
    trigger_source: { type: 'text', notNull: true, default: 'scheduled' },
    handoff_tasks_created: { type: 'integer', notNull: true, default: 0 },
    error_message: { type: 'text' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_recon_runs', 'rcm_recon_runs_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('rcm_recon_runs', 'rcm_recon_runs_trigger_check', {
    check: "trigger_source IN ('scheduled','manual')",
  });
  pgm.createIndex('rcm_recon_runs', ['office_id', 'run_at'], {
    name: 'rcm_recon_runs_office_run_idx',
  });

  // ── rcm_posting_queue ────────────────────────────────────────────────────
  // PLATFORM-NATIVE. The durable, resumable record of INTENDED posting.
  //
  // Open Dental has no transactions (RCM_OD_WRITES G4) and the posting sequence
  // is forced: per-line claimproc PUTs -> claim PUT to "R" -> POST
  // /claimpayments. §8 names the worst window explicitly — between the claim PUT
  // and the check POST, "the claim reads Received with money on the lines and no
  // check exists", and recovery "works, but only if the poster knows exactly
  // which claimprocs it had touched". This table plus its lines IS that record,
  // written BEFORE the first OD call.
  //
  // Worker-split safe: nothing here references a request-scoped construct, so
  // the future ca-carein-rcm worker can drain it with only a DB connection.
  pgm.createTable('rcm_posting_queue', {
    queue_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    ...officeCol(),
    batch_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_payment_batches',
      onDelete: 'RESTRICT',
    },
    bank_transaction_id: {
      type: 'uuid',
      references: 'rcm_bank_transactions',
      onDelete: 'SET NULL',
    },
    // Idempotency: the same (office_id, remittance_key) primitive the dedupe
    // table uses. Enqueueing the same remittance twice is a constraint
    // violation, not a second posting run.
    remittance_key: { type: 'text', notNull: true },

    // Honest states. 'approved' means approved and NOT yet posted;
    // 'partially_posted' means the sequence failed mid-flight and the line rows
    // say exactly where. There is no state that means "probably fine".
    status: { type: 'text', notNull: true, default: 'approved' },

    // Recoupments are negative supplementals — the ONE irreversible Open Dental
    // operation (G10): it cannot be reverted and cannot be deleted, and it then
    // pins its claim and procedure permanently. Marked from day one so Slice 6
    // has a column to gate on rather than inferring intent from a sign.
    is_recoupment: { type: 'boolean', notNull: true, default: false },

    // The carrier's adjudication date. OD's DateCP is NOT writable and returns
    // 200 OK while ignoring the write (G2), so this date lives here and is never
    // claimed to be in Open Dental.
    carrier_eob_date: { type: 'date' },

    intended_total_cents: { type: 'bigint', notNull: true, default: 0 },
    posted_total_cents: { type: 'bigint', notNull: true, default: 0 },

    // Approval attribution, deliberately separate from execution timestamps: a
    // queue row exists only because a human approved it, so approved_by is NOT
    // NULL — unlike the automated actors elsewhere in this schema.
    approved_by: { type: 'text', notNull: true, references: 'rcm_user_map', onDelete: 'RESTRICT' },
    approved_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },

    // Execution.
    started_at: { type: 'timestamptz' },
    finished_at: { type: 'timestamptz' },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
    // The Open Dental check this run created, once it exists — the proof the
    // money landed, and what a resume checks before re-posting.
    od_claim_payment_num: { type: 'bigint' },

    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check', {
    check: "status IN ('approved','posting','posted','failed','partially_posted')",
  });
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_office_remittance_unique', {
    unique: ['office_id', 'remittance_key'],
  });
  // The drain query: what is waiting, per office, oldest approval first.
  pgm.createIndex('rcm_posting_queue', ['office_id', 'status', 'approved_at'], {
    name: 'rcm_posting_queue_drain_idx',
  });
  pgm.createIndex('rcm_posting_queue', 'batch_id', { name: 'rcm_posting_queue_batch_idx' });

  // ── rcm_posting_queue_line ───────────────────────────────────────────────
  // PLATFORM-NATIVE. One row per claimproc the run intends to write, with the
  // intended amounts recorded BEFORE the first OD call.
  //
  // A table rather than a jsonb blob on the queue row specifically so lines are
  // QUERYABLE during a resume: "which claimprocs did I already write, and what
  // did I intend for the rest" has to be answerable in SQL when a run is stuck
  // in the §8 window.
  //
  // CASCADE from the queue row is the one deliberate exception to RESTRICT-for-
  // money-rows: the plan and its lines are a single record of intent, and a line
  // without its queue row records nothing.
  pgm.createTable('rcm_posting_queue_line', {
    queue_line_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    queue_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_posting_queue',
      onDelete: 'CASCADE',
    },
    ...officeCol(),
    position: { type: 'integer', notNull: true }, // deterministic replay order

    // Open Dental targets. od_claim_proc_num is the line being adjudicated;
    // od_claim_num is the claim whose status the sequence flips to "R".
    od_claim_proc_num: { type: 'bigint', notNull: true },
    od_claim_num: { type: 'bigint' },

    // Our side of the linkage, both nullable — a line can be planned from ERA
    // data before either row is matched.
    claim_id: { type: 'uuid', references: 'rcm_claims', onDelete: 'RESTRICT' },
    batch_claim_payment_id: {
      type: 'uuid',
      references: 'rcm_batch_claim_payments',
      onDelete: 'RESTRICT',
    },

    // THE PRE-FLIGHT RECORD. These three are what §8 says recovery requires and
    // what OD refuses to tell us afterwards: once a check is attached,
    // InsPayAmt can no longer be read back as "what was intended".
    intended_ins_pay_amt_cents: { type: 'bigint', notNull: true },
    intended_write_off_cents: { type: 'bigint', notNull: true, default: 0 },
    intended_ded_applied_cents: { type: 'bigint', notNull: true, default: 0 },

    // Recoupment lines go through POST /claimprocs/Supplemental with a negative
    // amount rather than a PUT — a different call, so a different flag.
    is_supplemental: { type: 'boolean', notNull: true, default: false },

    // Per-line progress through the forced sequence. Each value is a fact about
    // an OD call that returned, never an assumption.
    status: { type: 'text', notNull: true, default: 'pending' },
    claimproc_written_at: { type: 'timestamptz' },
    claim_received_at: { type: 'timestamptz' },
    paid_at: { type: 'timestamptz' },
    od_claim_payment_num: { type: 'bigint' }, // which check this line landed on
    last_error: { type: 'text' },

    ...timestamps(pgm),
  });
  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_status_check', {
    check: "status IN ('pending','claimproc_written','claim_received','paid','failed','skipped')",
  });
  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_position_unique', {
    unique: ['queue_id', 'position'],
  });
  pgm.createIndex('rcm_posting_queue_line', ['queue_id', 'status'], {
    name: 'rcm_posting_queue_line_resume_idx',
  });
  pgm.createIndex('rcm_posting_queue_line', 'od_claim_proc_num', {
    name: 'rcm_posting_queue_line_claimproc_idx',
  });

  // ── App-role grants (audit_log mechanism, CRUD scope) ─────────────────────
  // uuid PKs via gen_random_uuid() mean no sequence grants are needed. If the
  // role is absent (local dev on a superuser) the grant is skipped with a
  // NOTICE — create the role and re-run before serving PHI. down() needs no
  // revoke: dropping a table drops its grants. audit_log is NOT in this list and
  // its append-only grants are untouched.
  const tableList = RCM_TABLES.map((t) => `'${t}'`).join(', ');
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
            t text;
    BEGIN
      FOREACH t IN ARRAY ARRAY[${tableList}] LOOP
        EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
      END LOOP;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        FOREACH t IN ARRAY ARRAY[${tableList}] LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', t, r);
        END LOOP;
        RAISE NOTICE 'rcm_schema: CRUD grants applied to role % on % rcm_* tables', r, ${RCM_TABLES.length};
      ELSE
        RAISE NOTICE 'rcm_schema: app role % absent — grants SKIPPED. Create the least-privilege role and re-run before serving PHI.', r;
      END IF;
    END $$;
  `);
};

/**
 * Reverse of up(). Children before parents (FK order) — the exact reverse of
 * RCM_TABLES. The two cross-references added with addConstraint
 * (rcm_stedi_transactions.batch_id, rcm_bank_transactions.secondary_task_id)
 * are dropped with their tables.
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  for (const table of [...RCM_TABLES].reverse()) {
    pgm.dropTable(table, { cascade: true });
  }
};

// Exported for backend/test/rcmSchemaMigration.test.js — the grant block, the
// office CHECK and the drop order all read from these, so a table added to the
// migration without being added here fails the tests rather than shipping
// ungranted.
exports.RCM_TABLES = RCM_TABLES;
exports.TENANT_GLOBAL_TABLES = TENANT_GLOBAL_TABLES;
exports.OFFICE_CHECK = OFFICE_CHECK;
exports.APP_ROLE = APP_ROLE;
