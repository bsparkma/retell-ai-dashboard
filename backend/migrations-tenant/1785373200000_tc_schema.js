'use strict';

/**
 * Per-tenant data-plane: TC (Treatment Coordinator) module schema — Slice 1.
 *
 * SCHEMA ONLY. Creates the tc_* tables the TC module (formerly the standalone
 * TC-app / DentaFlow) will live in. No routes, no data — the legacy-JSON
 * importer is Slice 2. The strict shared contract that validates every shape
 * written into these tables lives in new-dashboard/shared/tc/ (killing the
 * legacy `.passthrough()` server schema).
 *
 * Design decisions (full rationale in docs/TC_SCHEMA.md + the Slice 1 PR):
 *
 *  - office_id TEXT NOT NULL CHECK IN ('roland','valley') on every data table.
 *    Frozen internal keys; display labels are config. The legacy app's
 *    location key 'riley' maps to 'valley' (Fort Smith) at import.
 *    Exception: tc_legacy_user_map is tenant-global (staff work across both
 *    offices) — documented, deliberate.
 *
 *  - MONEY IS INTEGER CENTS (*_cents columns). The legacy app mixes float
 *    dollars; conversion at import is Math.round(dollars * 100). These are
 *    dollars read aloud to patients — no float columns anywhere.
 *
 *  - FOLLOW-UP UNIFICATION: legacy PatientCase carried TWO parallel follow-up
 *    systems (followUps[] legacy, followUpSteps[] current) plus a separate
 *    nurtureTouchpoints[] campaign list. All three unify into ONE outreach
 *    work-queue table, tc_followups, discriminated by `kind`
 *    ('followup' | 'nurture'). One table = one "what's due" query for the TC.
 *
 *  - contactAttempts[] fold into tc_case_events (type 'contact_attempt',
 *    structured payload in detail jsonb) — they are timeline facts, not queue
 *    items.
 *
 *  - Deep author-owned structures (email template blocks, library config
 *    sections) are jsonb validated by the shared contract at the edge —
 *    normalizing an 8-way block union into tables buys nothing.
 *
 *  - tc_cases.legacy_snapshot jsonb archives the FULL original JSON per case
 *    at import so even deliberately-dropped legacy fields (e.g. stale
 *    financingOptions[]) remain recoverable. PHI — same handling as the row.
 *
 * PHI: most tc_* tables hold PHI (names, contact info, clinical notes,
 * photos-by-reference). Per-column flags are in docs/TC_SCHEMA.md; blob bytes
 * (gallery / smile-sim images) go to Azure Blob in a later slice — these
 * tables store blob keys + metadata only.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const OFFICE_CHECK = "office_id IN ('roland', 'valley')";

/** Shared column fragments (spread into createTable). */
function officeCol() {
  // Frozen internal office keys — see docs/TC_SCHEMA.md.
  return { office_id: { type: 'text', notNull: true } };
}
function timestamps(pgm) {
  return {
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  };
}

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // ── tc_cases ─────────────────────────────────────────────────────────────
  pgm.createTable('tc_cases', {
    case_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true }, // TC-app case id ('p001', nanoid) — import idempotency key
    ...officeCol(),

    // Patient identity (PHI). Manual cases have no OD link; od_patient_id is
    // the OD PatNum (bigint) when linked.
    patient_name: { type: 'text', notNull: true },
    patient_age: { type: 'integer' }, // legacy stores age-at-entry; birthdate lands with OD linking
    phone: { type: 'text' },
    email: { type: 'text' },
    od_patient_id: { type: 'bigint' },

    // Case classification.
    case_type: { type: 'text', notNull: true, default: '' }, // free text ("Full Mouth Rehabilitation")
    category: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    urgency: { type: 'text', notNull: true },
    doctor_name: { type: 'text', notNull: true, default: '' },
    assigned_tc: { type: 'text', notNull: true, default: '' }, // legacy user slug/name; resolves via tc_legacy_user_map

    // Value / readiness (money = integer cents, always).
    case_value_cents: { type: 'bigint', notNull: true, default: 0 },
    readiness_score: { type: 'integer', notNull: true, default: 0 },
    financing_status: { type: 'text', notNull: true, default: '' },
    preferred_financing_provider: { type: 'text' },

    // Discovery / context (PHI free text).
    decision_makers: { type: 'text', notNull: true, default: '' },
    financial_situation: { type: 'text[]', notNull: true, default: '{}' },
    key_motivators: { type: 'text[]', notNull: true, default: '{}' },
    contact_preference: { type: 'text' }, // 'phone'|'text'|'email'|null
    best_time_to_reach: { type: 'text', notNull: true, default: '' },
    notes: { type: 'text', notNull: true, default: '' },
    referral_source: { type: 'text' },
    lost_reason: { type: 'text' },

    // Lifecycle dates.
    diagnosed_date: { type: 'date' },
    status_changed_at: { type: 'timestamptz' },

    // Nurture campaign scalars (touchpoints live in tc_followups kind='nurture').
    nurture_cadence: { type: 'text', notNull: true, default: 'standard' },
    in_long_tail_mode: { type: 'boolean', notNull: true, default: false },
    nurture_enrolled_at: { type: 'timestamptz' },
    nurture_phase_changed_at: { type: 'timestamptz' },
    nurture_phase1_days_override: { type: 'integer' },
    nurture_phase2_days_override: { type: 'integer' },
    nurture_unsubscribed: { type: 'boolean', notNull: true, default: false },

    // One-time archival of the complete legacy JSON at import (PHI). Nothing
    // is silently lost even where the contract deliberately drops a field.
    legacy_snapshot: { type: 'jsonb' },

    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_cases', 'tc_cases_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('tc_cases', 'tc_cases_category_check', {
    check:
      "category IN ('single_tooth','quadrant','implant','full_mouth_rehab','full_arch','cosmetic','ortho')",
  });
  pgm.addConstraint('tc_cases', 'tc_cases_status_check', {
    check:
      "status IN ('hygiene_review','diagnosed','pending_tc','pending_pt','presented','considering','financing_pending','accepted','partially_accepted','scheduled','started','completed','lost','nurture')",
  });
  pgm.addConstraint('tc_cases', 'tc_cases_urgency_check', {
    check: "urgency IN ('high','medium','low','elective')",
  });
  pgm.addConstraint('tc_cases', 'tc_cases_nurture_cadence_check', {
    check: "nurture_cadence IN ('light','standard','high_touch')",
  });
  pgm.createIndex('tc_cases', ['office_id', 'status'], { name: 'tc_cases_office_status_idx' });
  pgm.createIndex('tc_cases', 'od_patient_id', { name: 'tc_cases_od_patient_idx' });

  // ── tc_case_phases (phases[]) ────────────────────────────────────────────
  pgm.createTable('tc_case_phases', {
    phase_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    case_id: { type: 'uuid', notNull: true, references: 'tc_cases', onDelete: 'CASCADE' },
    ...officeCol(),
    position: { type: 'integer', notNull: true }, // legacy numeric phase id = presentation order
    name: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true, default: '' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_case_phases', 'tc_case_phases_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('tc_case_phases', 'tc_case_phases_case_position_unique', {
    unique: ['case_id', 'position'],
  });

  // ── tc_case_items (phases[].items[]) ─────────────────────────────────────
  pgm.createTable('tc_case_items', {
    item_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    phase_id: { type: 'uuid', notNull: true, references: 'tc_case_phases', onDelete: 'CASCADE' },
    case_id: { type: 'uuid', notNull: true, references: 'tc_cases', onDelete: 'CASCADE' },
    ...officeCol(),
    position: { type: 'integer', notNull: true },
    legacy_item_id: { type: 'text' }, // legacy item id ('od_12345', nanoid)
    od_proc_num: { type: 'bigint' }, // parsed from 'od_<ProcNum>' items — link back to OD
    tooth: { type: 'text', notNull: true, default: '' },
    procedure_name: { type: 'text', notNull: true },
    patient_description: { type: 'text', notNull: true, default: '' },
    fee_cents: { type: 'bigint', notNull: true, default: 0 },
    insurance_est_cents: { type: 'bigint', notNull: true, default: 0 },
    patient_portion_cents: { type: 'bigint', notNull: true, default: 0 },
    urgency: { type: 'text', notNull: true },
    time_estimate: { type: 'text', notNull: true, default: '' },
    benefits: { type: 'text[]', notNull: true, default: '{}' },
    risks_of_delay: { type: 'text[]', notNull: true, default: '{}' },
    expected_outcome: { type: 'text', notNull: true, default: '' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_case_items', 'tc_case_items_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('tc_case_items', 'tc_case_items_urgency_check', {
    check: "urgency IN ('high','medium','low','elective')",
  });
  pgm.createIndex('tc_case_items', 'case_id', { name: 'tc_case_items_case_idx' });
  pgm.createIndex('tc_case_items', 'phase_id', { name: 'tc_case_items_phase_idx' });

  // ── tc_case_objections (objections[]) ────────────────────────────────────
  pgm.createTable('tc_case_objections', {
    objection_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    case_id: { type: 'uuid', notNull: true, references: 'tc_cases', onDelete: 'CASCADE' },
    ...officeCol(),
    category: { type: 'text', notNull: true },
    note: { type: 'text', notNull: true, default: '' },
    patient_words: { type: 'text', notNull: true, default: '' }, // PHI — verbatim patient speech
    logged_at: { type: 'timestamptz', notNull: true },
    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_case_objections', 'tc_case_objections_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.createIndex('tc_case_objections', 'case_id', { name: 'tc_case_objections_case_idx' });

  // ── tc_followups — THE unified outreach queue ────────────────────────────
  // Unifies legacy followUps[] (no ids, boolean completed), followUpSteps[]
  // (current system) and nurtureTouchpoints[] (campaign outreach) into one
  // work-queue. kind discriminates; nurture-only fields are nullable.
  pgm.createTable('tc_followups', {
    followup_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    case_id: { type: 'uuid', notNull: true, references: 'tc_cases', onDelete: 'CASCADE' },
    ...officeCol(),
    kind: { type: 'text', notNull: true, default: 'followup' }, // 'followup' | 'nurture'
    due_date: { type: 'date', notNull: true },
    channel: { type: 'text', notNull: true }, // phone_call | text | email | in_person
    status: { type: 'text', notNull: true, default: 'pending' }, // pending | completed | skipped
    talking_point: { type: 'text', notNull: true, default: '' }, // suggestedTalkingPoint / legacy note / nurture scriptTemplate
    outcome_note: { type: 'text', notNull: true, default: '' },
    completed_at: { type: 'timestamptz' },
    completed_by: { type: 'text' }, // nurture: TC name or 'system'; followups: null (legacy had none)
    source: { type: 'text', notNull: true, default: 'manual' }, // auto | manual | legacy
    patient_responded: { type: 'boolean' }, // null = not recorded
    nurture_type: { type: 'text' }, // nurture only: check_in | seasonal | life_event | financing
    legacy_id: { type: 'text' }, // FollowUpStep.id / NurtureTouchpoint.id (legacy followUps[] had none)
    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_followups', 'tc_followups_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('tc_followups', 'tc_followups_kind_check', {
    check: "kind IN ('followup','nurture')",
  });
  pgm.addConstraint('tc_followups', 'tc_followups_channel_check', {
    check: "channel IN ('phone_call','text','email','in_person')",
  });
  pgm.addConstraint('tc_followups', 'tc_followups_status_check', {
    check: "status IN ('pending','completed','skipped')",
  });
  pgm.addConstraint('tc_followups', 'tc_followups_source_check', {
    check: "source IN ('auto','manual','legacy')",
  });
  pgm.addConstraint('tc_followups', 'tc_followups_nurture_type_check', {
    check: "nurture_type IS NULL OR nurture_type IN ('check_in','seasonal','life_event','financing')",
  });
  // The TC's daily queue: what's due, by office, pending first.
  pgm.createIndex('tc_followups', ['office_id', 'status', 'due_date'], {
    name: 'tc_followups_queue_idx',
  });
  pgm.createIndex('tc_followups', 'case_id', { name: 'tc_followups_case_idx' });

  // ── tc_case_events (caseEvents[] + contactAttempts[]) ────────────────────
  pgm.createTable('tc_case_events', {
    event_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    case_id: { type: 'uuid', notNull: true, references: 'tc_cases', onDelete: 'CASCADE' },
    ...officeCol(),
    ts: { type: 'timestamptz', notNull: true },
    type: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true, default: '' },
    actor: { type: 'text' }, // staff name/slug — never patient identity
    // Structured payload for typed events (e.g. contact_attempt:
    // { channel, outcome }). Shape validated by the shared contract.
    detail: { type: 'jsonb' },
    legacy_id: { type: 'text' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_case_events', 'tc_case_events_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('tc_case_events', 'tc_case_events_type_check', {
    check:
      "type IN ('status_change','follow_up_completed','objection_logged','note_added','case_created','nurture_enrolled','contact_attempt')",
  });
  pgm.createIndex('tc_case_events', ['case_id', 'ts'], { name: 'tc_case_events_case_ts_idx' });

  // ── tc_hygiene_intakes (hygieneIntake, 1:0..1) ───────────────────────────
  // Accommodates the in-flight hygiene-intake workstream (see TC-app
  // docs/hygiene-intake-prd.md). Clinical findings = PHI.
  pgm.createTable('tc_hygiene_intakes', {
    intake_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    case_id: { type: 'uuid', notNull: true, references: 'tc_cases', onDelete: 'CASCADE', unique: true },
    ...officeCol(),
    submitted_by: { type: 'text', notNull: true }, // legacy hygienist user id/slug
    submitted_by_name: { type: 'text', notNull: true, default: '' },
    submitted_at: { type: 'timestamptz', notNull: true },
    operatory: { type: 'text', notNull: true, default: '' },
    visit_date: { type: 'date' },
    provider_seen: { type: 'text', notNull: true, default: '' },
    chief_concern: { type: 'text', notNull: true, default: '' },
    perio_status: { type: 'text', notNull: true, default: 'unknown' },
    recall_type: { type: 'text', notNull: true, default: 'none' },
    radiographs: { type: 'text[]', notNull: true, default: '{}' },
    intraoral_photos_taken: { type: 'boolean', notNull: true, default: false },
    areas_of_concern: { type: 'text', notNull: true, default: '' },
    suspected_treatment: { type: 'text', notNull: true, default: '' },
    hygienist_recommendation: { type: 'text', notNull: true, default: '' },
    insurance_noted: { type: 'text', notNull: true, default: '' },
    patient_interest_level: { type: 'text', notNull: true, default: 'unknown' },
    flag_urgent: { type: 'boolean', notNull: true, default: false },
    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_perio_check', {
    check:
      "perio_status IN ('healthy','gingivitis','early_perio','moderate_perio','advanced_perio','unknown')",
  });
  pgm.addConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_recall_check', {
    check: "recall_type IN ('prophy','perio_maint','srp_needed','d4346','fmd','none')",
  });
  pgm.addConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_interest_check', {
    check: "patient_interest_level IN ('hot','warm','cold','unknown')",
  });

  // ── tc_preauth_cases ─────────────────────────────────────────────────────
  pgm.createTable('tc_preauth_cases', {
    preauth_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true },
    ...officeCol(),
    case_id: { type: 'uuid', references: 'tc_cases', onDelete: 'SET NULL' }, // optional link (legacy had none)
    patient_name: { type: 'text', notNull: true },
    phone: { type: 'text' },
    email: { type: 'text' },
    od_patient_id: { type: 'bigint' },
    preauth_type: { type: 'text', notNull: true }, // treatment | perio | manual
    description: { type: 'text', notNull: true, default: '' },
    insurance_carrier: { type: 'text', notNull: true, default: '' },
    status: { type: 'text', notNull: true },
    doctor_name: { type: 'text', notNull: true, default: '' },
    submitted_date: { type: 'date' },
    decision_date: { type: 'date' },
    reference_number: { type: 'text', notNull: true, default: '' },
    notes: { type: 'text', notNull: true, default: '' },
    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_preauth_cases', 'tc_preauth_cases_office_check', { check: OFFICE_CHECK });
  pgm.addConstraint('tc_preauth_cases', 'tc_preauth_cases_type_check', {
    check: "preauth_type IN ('treatment','perio','manual')",
  });
  pgm.addConstraint('tc_preauth_cases', 'tc_preauth_cases_status_check', {
    check: "status IN ('pending','submitted','in_review','approved','denied','appealing','expired')",
  });
  pgm.createIndex('tc_preauth_cases', ['office_id', 'status'], {
    name: 'tc_preauth_office_status_idx',
  });

  // ── tc_email_templates ───────────────────────────────────────────────────
  // blocks jsonb = the 8-type block union, validated by shared/tc contract at
  // the edge (author-owned deep structure; tables would buy nothing).
  pgm.createTable('tc_email_templates', {
    template_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true }, // 'tpl_…'
    ...officeCol(),
    name: { type: 'text', notNull: true },
    category: { type: 'text', notNull: true },
    subject: { type: 'text', notNull: true },
    preheader: { type: 'text', notNull: true, default: '' },
    blocks: { type: 'jsonb', notNull: true },
    is_seed: { type: 'boolean', notNull: true, default: false },
    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_email_templates', 'tc_email_templates_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('tc_email_templates', 'tc_email_templates_category_check', {
    check:
      "category IN ('consult_confirmation','consult_followup','financing_followup','preauth_approved','unscheduled_treatment','treatment_presentation','general')",
  });

  // ── tc_communications (outbound email log) ───────────────────────────────
  pgm.createTable('tc_communications', {
    comm_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true }, // 'cm_…'
    ...officeCol(),
    case_id: { type: 'uuid', references: 'tc_cases', onDelete: 'SET NULL' },
    template_id: { type: 'uuid', references: 'tc_email_templates', onDelete: 'SET NULL' },
    template_name: { type: 'text', notNull: true, default: '' }, // denormalized: survives template deletion
    sender: { type: 'text', notNull: true }, // legacy user slug; resolves via tc_legacy_user_map
    sender_name: { type: 'text', notNull: true, default: '' },
    to_email: { type: 'text', notNull: true }, // PHI
    subject: { type: 'text', notNull: true, default: '' }, // PHI (often carries patient/treatment context)
    status: { type: 'text', notNull: true }, // sent | stubbed | error
    provider_message_id: { type: 'text' },
    error: { type: 'text' },
    sent_at: { type: 'timestamptz', notNull: true },
    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_communications', 'tc_communications_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('tc_communications', 'tc_communications_status_check', {
    check: "status IN ('sent','stubbed','error')",
  });
  pgm.createIndex('tc_communications', 'case_id', { name: 'tc_communications_case_idx' });
  pgm.createIndex('tc_communications', ['office_id', 'sent_at'], {
    name: 'tc_communications_office_sent_idx',
  });

  // ── tc_gallery_cases (before/after gallery) ──────────────────────────────
  // Image bytes go to Azure Blob (later slice) — blob keys only here.
  pgm.createTable('tc_gallery_cases', {
    gallery_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true },
    ...officeCol(),
    title: { type: 'text', notNull: true }, // PHI — legacy titles embed patient names
    category: { type: 'text', notNull: true, default: '' },
    description: { type: 'text', notNull: true, default: '' },
    doctor_name: { type: 'text', notNull: true, default: '' },
    before_blob_key: { type: 'text', notNull: true }, // PHI by reference (clinical photo)
    after_blob_key: { type: 'text', notNull: true },
    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_gallery_cases', 'tc_gallery_cases_office_check', { check: OFFICE_CHECK });

  // ── tc_smile_simulations (AI smile sim) ──────────────────────────────────
  pgm.createTable('tc_smile_simulations', {
    sim_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    legacy_id: { type: 'text', unique: true },
    ...officeCol(),
    case_id: { type: 'uuid', references: 'tc_cases', onDelete: 'SET NULL' },
    treatment_type: { type: 'text', notNull: true }, // open vocabulary (legacy: Veneers, Orthodontics, …)
    prompt: { type: 'text', notNull: true, default: '' },
    original_blob_key: { type: 'text', notNull: true }, // PHI by reference (face photo)
    result_blob_key: { type: 'text', notNull: true },
    saved_to_gallery: { type: 'boolean', notNull: true, default: false },
    gallery_id: { type: 'uuid', references: 'tc_gallery_cases', onDelete: 'SET NULL' },
    created_by: { type: 'text', notNull: true, default: '' }, // legacy user slug
    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_smile_simulations', 'tc_smile_simulations_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.createIndex('tc_smile_simulations', 'case_id', { name: 'tc_smile_simulations_case_idx' });

  // ── tc_library_config (server-owned config, per office) ─────────────────
  // Absorbs legacy library.json (stages, objection scripts, financing
  // providers, crown pricing, cadence config, …) AND the per-browser
  // localStorage financingSettings — config becomes server truth, keyed per
  // office so the two practices can diverge. One row per (office, section);
  // section values are jsonb validated by the shared contract.
  pgm.createTable('tc_library_config', {
    ...officeCol(),
    section: { type: 'text', notNull: true },
    value: { type: 'jsonb', notNull: true },
    ...timestamps(pgm),
  });
  pgm.addConstraint('tc_library_config', 'tc_library_config_pkey', {
    primaryKey: ['office_id', 'section'],
  });
  pgm.addConstraint('tc_library_config', 'tc_library_config_office_check', {
    check: OFFICE_CHECK,
  });
  pgm.addConstraint('tc_library_config', 'tc_library_config_section_check', {
    check:
      "section IN ('stages','objections','motivators','lost_reasons','referral_sources','treatment_categories','financing_providers','crown_pricing','financing_config','cadence_config','financing_settings')",
  });

  // ── tc_legacy_user_map ───────────────────────────────────────────────────
  // Legacy TC-app user slug → platform identity (email). Tenant-global by
  // design: staff work across both offices, so this is the ONE tc_* table
  // without office_id (documented exception).
  pgm.createTable('tc_legacy_user_map', {
    legacy_user_id: { type: 'text', primaryKey: true }, // 'beau', 'holly', 'aarionna', …
    platform_email: { type: 'text', notNull: true },
    display_name: { type: 'text', notNull: true, default: '' },
    legacy_role: { type: 'text', notNull: true, default: '' },
    ...timestamps(pgm),
  });
};

/**
 * Reverse of up(). Children before parents (FK order).
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('tc_legacy_user_map');
  pgm.dropTable('tc_library_config');
  pgm.dropTable('tc_smile_simulations');
  pgm.dropTable('tc_gallery_cases');
  pgm.dropTable('tc_communications');
  pgm.dropTable('tc_email_templates');
  pgm.dropTable('tc_preauth_cases');
  pgm.dropTable('tc_hygiene_intakes');
  pgm.dropTable('tc_case_events');
  pgm.dropTable('tc_followups');
  pgm.dropTable('tc_case_objections');
  pgm.dropTable('tc_case_items');
  pgm.dropTable('tc_case_phases');
  pgm.dropTable('tc_cases');
};
