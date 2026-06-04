'use strict';

/**
 * Per-tenant data-plane: call_record.
 *
 * Holds the merged Retell + Mango call records that currently live in
 * data/unified_calls.json (see backend/services/unifiedCallStore.js
 * normalizeCall()). SCHEMA ONLY — this migration creates the table; it does NOT
 * read or move the JSON. The unified_calls.json -> call_record data cutover is
 * a deliberate later step (Slice 3b); see docs/DATA_PLANE.md.
 *
 * Columns mirror the normalized unified call shape, plus clinic_num (the
 * tenant-internal OD ClinicNum) which the JSON does not yet carry and which the
 * cutover will populate. Indexed by clinic_num + timestamps + external id.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  pgm.createTable('call_record', {
    // Internal surrogate key for this row.
    record_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },

    // Tenant-internal OD clinic. Nullable for now — the JSON store does not yet
    // carry it; backfilled at cutover (Slice 3b).
    clinic_num: { type: 'integer' },

    // Identity / source (unifiedCallStore: source, id, external_id).
    source: { type: 'text', notNull: true }, // 'retell' | 'mango'
    call_uid: { type: 'text', notNull: true }, // unifiedCallStore `id` (stable unified id)
    external_id: { type: 'text' }, // provider-side id (Retell call_id / Mango external_id)

    // Call metadata.
    call_date: { type: 'timestamptz' },
    duration_seconds: { type: 'integer' },

    // Caller.
    caller_number: { type: 'text' },
    caller_name: { type: 'text' },

    // Handler.
    handler_type: { type: 'text' }, // 'ai' | 'staff'
    handler_id: { type: 'text' },
    handler_name: { type: 'text' },

    // Outcome / classification.
    outcome: { type: 'text' },
    call_reason: { type: 'text' },
    is_emergency: { type: 'boolean', notNull: true, default: false },
    sentiment: { type: 'text' },

    // Transfer / callback tracking.
    transfer_attempted: { type: 'boolean', notNull: true, default: false },
    transfer_status: { type: 'text' },
    transfer_destination: { type: 'text' },
    callback_required: { type: 'boolean', notNull: true, default: false },
    callback_reason: { type: 'text' },

    // Content.
    summary: { type: 'text' },
    transcript: { type: 'text' },
    transcript_json: { type: 'jsonb' },
    recording_url: { type: 'text' },
    recording_path: { type: 'text' },

    // Mango-specific deep-link metadata.
    mango_call_id: { type: 'text' },
    mango_detail_url: { type: 'text' },

    // Patient matching (OD PatNum is bigint; nullable until matched).
    patient_id: { type: 'bigint' },
    patient_matched_by: { type: 'text' },
    is_new_patient: { type: 'boolean' },

    // QA.
    qa_score: { type: 'numeric' },
    qa_evaluated_at: { type: 'timestamptz' },

    // Bookkeeping.
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // One row per unified call id within a tenant DB (idempotent upsert target).
  pgm.addConstraint('call_record', 'call_record_call_uid_unique', { unique: ['call_uid'] });

  // Common access patterns: by clinic, by date range, by clinic+date, by provider id.
  pgm.createIndex('call_record', 'clinic_num', { name: 'call_record_clinic_num_idx' });
  pgm.createIndex('call_record', 'call_date', { name: 'call_record_call_date_idx' });
  pgm.createIndex('call_record', ['clinic_num', 'call_date'], {
    name: 'call_record_clinic_date_idx',
  });
  pgm.createIndex('call_record', 'external_id', { name: 'call_record_external_id_idx' });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('call_record');
};
