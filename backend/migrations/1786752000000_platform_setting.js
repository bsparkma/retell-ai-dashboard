'use strict';

/**
 * Platform-wide settings (Platform Console, PR C).
 *
 * WHY A NEW TABLE AND NOT tenant_module / a tenant column.
 * The first setting to live here is the call-store retention window, and the
 * call store is ONE JSON file for the whole process (see
 * services/unifiedCallStore.js — `${CALLSTORE_DIR}/unified_calls.json`). It has
 * no tenant dimension at all. Hanging retention off `tenant` would invent a
 * per-practice policy the pruner has no way to honour, and the first person to
 * set two practices to different windows would be silently lied to.
 *
 * So: key/value, keyed by nothing but the key. When the JSON store is finally
 * cut over to the per-tenant `call_record` table, retention becomes a
 * per-tenant question and gets a per-tenant home — that is a later slice's
 * migration, not a column we speculatively add now.
 *
 * `value` is jsonb rather than text so a setting that is naturally a number, a
 * boolean, or a small object does not have to be stringly-typed and re-parsed
 * by every reader.
 *
 * NO SEED ROW — DELIBERATE. Absence of a row is a meaningful state: it means
 * "nobody has chosen, fall back to the environment". Seeding `30` here would
 * make CALL_RETENTION_DAYS dead on arrival in every environment, which is the
 * opposite of the precedence documented in docs/PLATFORM_CONSOLE.md:
 *
 *     DB row  →  CALL_RETENTION_DAYS  →  30
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
  pgm.createTable('platform_setting', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'jsonb', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // The email of the super_admin who last wrote it. An identifier, not PHI —
    // same class of value as audit_log.user_id. Nullable so a value written by
    // a migration or a runbook is not forced to invent an author.
    updated_by: { type: 'text' },
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('platform_setting');
};
