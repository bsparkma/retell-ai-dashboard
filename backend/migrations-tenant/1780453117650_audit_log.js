'use strict';

/**
 * Per-tenant HIPAA audit log (Slice 6, COMPLY hard gate).
 *
 * One row per PHI-touching action. Stores resource IDs and the acting user +
 * source IP only — NEVER PHI values. Lives in the tenant's own data-plane DB.
 *
 * APPEND-ONLY: the least-privilege application role is granted INSERT + SELECT
 * on audit_log and nothing else (no UPDATE/DELETE/TRUNCATE), so the app can
 * write and read the trail but cannot alter or erase it. This requires a TWO-
 * ROLE model: migrations run as an owner/admin role; the app connects as a
 * separate least-privilege role (default name 'carein_app', override with
 * AUDIT_APP_ROLE). If that role does not exist at migration time (e.g. local
 * dev using a superuser) the grant is skipped with a NOTICE — create the role
 * and re-run, or apply the grant manually, in any environment holding real PHI.
 * See docs/AUDIT.md.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[audit_log migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  pgm.createTable('audit_log', {
    // uuid PK (not bigserial) so the append-only app role needs only table-level
    // INSERT — no sequence grant. gen_random_uuid() is callable by any role.
    audit_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    ts: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }, // UTC
    user_id: { type: 'text' }, // acting staff identity (email/oid) — not patient PHI
    tenant_id: { type: 'uuid', notNull: true },
    action: { type: 'text', notNull: true }, // READ | CREATE | UPDATE | DELETE
    resource_type: { type: 'text', notNull: true }, // e.g. patient, appointment, call
    resource_id: { type: 'text' }, // ID only — never a PHI value
    ip: { type: 'text' },
    result: { type: 'text', notNull: true }, // SUCCESS | UNAUTHORIZED | ERROR
    endpoint: { type: 'text' }, // optional, scrubbed request path
  });

  pgm.addConstraint('audit_log', 'audit_log_action_check', {
    check: "action IN ('READ', 'CREATE', 'UPDATE', 'DELETE')",
  });
  pgm.addConstraint('audit_log', 'audit_log_result_check', {
    check: "result IN ('SUCCESS', 'UNAUTHORIZED', 'ERROR')",
  });

  pgm.createIndex('audit_log', 'ts', { name: 'audit_log_ts_idx' });
  pgm.createIndex('audit_log', ['resource_type', 'resource_id'], {
    name: 'audit_log_resource_idx',
  });

  // Append-only enforcement: grant INSERT + SELECT (only) to the app role.
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      REVOKE ALL ON TABLE audit_log FROM PUBLIC;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE audit_log FROM %I', r);
        EXECUTE format('GRANT INSERT, SELECT ON TABLE audit_log TO %I', r);
        RAISE NOTICE 'audit_log: append-only grants (INSERT, SELECT) applied to role %', r;
      ELSE
        RAISE NOTICE 'audit_log: app role % absent — append-only grants SKIPPED. Create a least-privilege role and grant INSERT,SELECT (no UPDATE/DELETE) before serving PHI.', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('audit_log');
};
