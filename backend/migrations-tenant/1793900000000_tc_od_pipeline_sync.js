'use strict';

/**
 * Per-tenant data-plane: the Open Dental-driven pipeline sync (CO-4b).
 *
 * The sync follows the AptNum a Scheduled checkout was anchored to (CO-4a,
 * tc_checkout_handoffs.appt_*) and, on an UNAMBIGUOUS Open Dental signal,
 * moves the case: Complete → completed, Broken / UnschedList → pending_pt, a
 * new date or time → the anchor follows it. Anything else is a FLAG. Every
 * automatic change carries a badge, an audit row and an Undo.
 *
 * FOUR NULLABLE COLUMNS on tc_cases, all additive (NULL on every case before
 * this one, which reads as "the sync never touched it"):
 *
 *   od_sync_action   jsonb object — the LAST automatic change, while it stands:
 *                    { kind, at, runId, aptNum, handoffId, fromStatus,
 *                      toStatus, fromDateTime, toDateTime, fingerprint }. It is
 *                    what the "Moved by Open Dental sync" badge and its Undo
 *                    read. Cleared by the Undo.
 *   od_sync_flag     jsonb object — "Open Dental no longer matches — check":
 *                    { reason, aptNum, aptStatus, at }. Never moves anything.
 *                    Cleared when a later sweep reads a clean state.
 *   od_sync_undone   jsonb object — the change a person undid: { kind,
 *                    fingerprint, at, by }. The engine will not redo a change
 *                    while Open Dental still shows THE SAME state
 *                    (fingerprint); only a new Open Dental state is a new
 *                    signal.
 *   od_sync_checked_at timestamptz — when a sweep last read this case's
 *                    appointment. Orders the per-run cap so it rotates.
 *
 * ONE NEW TABLE, tc_od_sync_runs: one row per sweep of one office (manual
 * "Sync now" or nightly), for the Pipeline's "last run" line and the Sync now
 * rate limit. Counts only — never a PatNum or a name.
 *
 * No platform_setting row is seeded: the per-office switch
 * ('tc_od_sync_enabled', config/tcOdSync.js) follows tc_checkout_enabled
 * exactly, where NO ROW means every office OFF.
 *
 * CHECKS, each two-valued (led by IS NULL), per RCM_POSTING §15.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();

const CASE_COLUMNS = ['od_sync_action', 'od_sync_flag', 'od_sync_undone', 'od_sync_checked_at'];
exports.CASE_COLUMNS = CASE_COLUMNS;

const CASE_CHECKS = {
  tc_cases_od_sync_action_object_check:
    "od_sync_action IS NULL OR (jsonb_typeof(od_sync_action) = 'object' AND od_sync_action->>'kind' IN ('completed', 'unscheduled', 'rescheduled'))",
  tc_cases_od_sync_flag_object_check:
    "od_sync_flag IS NULL OR (jsonb_typeof(od_sync_flag) = 'object' AND od_sync_flag->>'reason' IN ('missing', 'status', 'patient', 'multiple'))",
  tc_cases_od_sync_undone_object_check:
    "od_sync_undone IS NULL OR (jsonb_typeof(od_sync_undone) = 'object' AND od_sync_undone ? 'fingerprint')",
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('tc_cases', {
    od_sync_action: { type: 'jsonb' },
    od_sync_flag: { type: 'jsonb' },
    od_sync_undone: { type: 'jsonb' },
    od_sync_checked_at: { type: 'timestamptz' },
  });
  for (const [name, check] of Object.entries(CASE_CHECKS)) {
    pgm.addConstraint('tc_cases', name, { check });
  }

  pgm.createTable('tc_od_sync_runs', {
    run_id: { type: 'uuid', primaryKey: true },
    office_id: { type: 'text', notNull: true },
    trigger: { type: 'text', notNull: true },
    requested_by: { type: 'text' },
    started_at: { type: 'timestamptz', notNull: true },
    finished_at: { type: 'timestamptz' },
    status: { type: 'text', notNull: true },
    summary: { type: 'jsonb' },
    error_code: { type: 'text' },
  });
  pgm.addConstraint('tc_od_sync_runs', 'tc_od_sync_runs_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint('tc_od_sync_runs', 'tc_od_sync_runs_trigger_check', {
    check: "trigger IN ('manual', 'nightly')",
  });
  pgm.addConstraint('tc_od_sync_runs', 'tc_od_sync_runs_status_check', {
    check: "status IN ('running', 'ok', 'failed')",
  });
  pgm.addConstraint('tc_od_sync_runs', 'tc_od_sync_runs_summary_object_check', {
    check: "summary IS NULL OR jsonb_typeof(summary) = 'object'",
  });
  pgm.createIndex('tc_od_sync_runs', ['office_id', { name: 'started_at', sort: 'DESC' }], {
    name: 'tc_od_sync_runs_office_started_idx',
  });

  // ── carein_app grant (tc_schema's mechanism, CRUD scope) ─────────────────
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      EXECUTE 'REVOKE ALL ON TABLE tc_od_sync_runs FROM PUBLIC';
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tc_od_sync_runs TO %I', r);
      ELSE
        RAISE NOTICE 'tc_od_sync_runs: app role % absent; grant SKIPPED', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('tc_od_sync_runs', { ifExists: true });
  // CONSTRAINTS BEFORE COLUMNS: Postgres drops a CHECK silently with its column.
  for (const name of Object.keys(CASE_CHECKS)) {
    pgm.dropConstraint('tc_cases', name, { ifExists: true });
  }
  pgm.dropColumns('tc_cases', CASE_COLUMNS, { ifExists: true });
};
