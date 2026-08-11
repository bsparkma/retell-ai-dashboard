'use strict';

/**
 * Role enforcement spine (Roles PR A).
 *
 * Three things, one migration — the Users page in PR B needs the columns, and
 * one migration now beats two later:
 *
 *  1. platform_admin   the PLATFORM tier. A super_admin acts as tenant 'admin'
 *                      inside every tenant AND passes requireSuperAdmin. Keyed
 *                      by email (lowercased) because that is the only identity
 *                      an Entra sign-in carries before an app_user row exists.
 *  2. app_user columns status (active|disabled) + last_login_at. Additive and
 *                      defaulted, so existing rows keep working untouched.
 *  3. the CareIN roster seeded as app_user rows with their real roles.
 *
 * Tenant roles (app_user.role), locked 2026-08-11:
 *   admin    everything, including /api/admin
 *   office   everything except /api/admin
 *   tc       TC module + read-only voice
 *   hygiene  hygiene intake/submissions/inbox only
 *
 * Idempotent by construction: every INSERT is an upsert on the natural key, so
 * re-running this migration (or applying it to an environment where admin@ was
 * already seeded by 1780448576257_seed_tenant_carein) neither duplicates rows
 * nor clobbers a role someone has since changed by hand.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** Tenant #1 — fixed UUID from 1780448576257_seed_tenant_carein.js. */
const CAREIN_TENANT_ID = 'ca7e1000-0000-4000-8000-000000000001';

/**
 * THE ROSTER. One place to correct an address — edit the line, re-run the
 * migration, done (the upsert below updates the role of an existing email
 * rather than inserting a second row).
 *
 * temp@carein.ai is one deliberately shared, rotated account for temp
 * hygienists (Beau's explicit decision) — it is scoped to 'hygiene' precisely
 * because it is shared.
 *
 * admin@carein.ai is NOT listed here: 1780448576257 already seeds its app_user
 * row as 'admin'. It additionally becomes the platform super_admin below.
 *
 * @type {ReadonlyArray<{ email: string, role: 'admin'|'office'|'tc'|'hygiene' }>}
 */
const ROSTER = Object.freeze([
  // --- admin: everything, including /api/admin -------------------------------
  { email: 'holly@carein.ai', role: 'admin' },
  { email: 'paola@carein.ai', role: 'admin' },

  // --- office: everything except /api/admin ---------------------------------
  { email: 'sam@carein.ai', role: 'office' },
  { email: 'krishana@carein.ai', role: 'office' },
  { email: 'jen@carein.ai', role: 'office' },
  { email: 'aarionna@carein.ai', role: 'office' },
  { email: 'hayley@carein.ai', role: 'office' },

  // --- hygiene: hygiene intake/submissions/inbox only -----------------------
  { email: 'raegan@carein.ai', role: 'hygiene' },
  { email: 'laura@carein.ai', role: 'hygiene' },
  { email: 'cindy@carein.ai', role: 'hygiene' },
  { email: 'megan@carein.ai', role: 'hygiene' },
  { email: 'temp@carein.ai', role: 'hygiene' }, // shared, rotated temp-hygienist account
]);

/** The seeded platform super_admin. */
const PLATFORM_ADMINS = Object.freeze(['admin@carein.ai']);

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

/** SQL string literal with single quotes escaped. */
function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // --- 1. platform_admin ----------------------------------------------------
  // Email is the primary key and is stored lowercased; the CHECK makes that a
  // schema guarantee rather than a convention every caller has to remember.
  pgm.createTable('platform_admin', {
    email: { type: 'text', primaryKey: true },
    status: { type: 'text', notNull: true, default: 'active' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('platform_admin', 'platform_admin_status_check', {
    check: "status IN ('active', 'disabled')",
  });
  pgm.addConstraint('platform_admin', 'platform_admin_email_lower_check', {
    check: 'email = lower(email)',
  });

  // --- 2. app_user additive columns ----------------------------------------
  // NOT NULL with a default so existing rows are backfilled to 'active' in the
  // same statement — nobody loses access when this applies.
  pgm.addColumns('app_user', {
    status: { type: 'text', notNull: true, default: 'active' },
    last_login_at: { type: 'timestamptz', notNull: false },
  });
  pgm.addConstraint('app_user', 'app_user_status_check', {
    check: "status IN ('active', 'disabled')",
  });

  // --- 3. seed --------------------------------------------------------------
  const tenantId = lit(CAREIN_TENANT_ID);

  for (const { email, role } of ROSTER) {
    // ON CONFLICT on (tenant_id, email) — the unique constraint from
    // 1780448575257. DO UPDATE (not DO NOTHING) so a corrected role in the
    // ROSTER above takes effect on re-run; status is left alone so re-running
    // never silently re-enables someone who was disabled on purpose.
    pgm.sql(`
      INSERT INTO app_user (tenant_id, email, role)
      VALUES (${tenantId}, ${lit(email)}, ${lit(role)})
      ON CONFLICT (tenant_id, email) DO UPDATE
        SET role = EXCLUDED.role;
    `);
  }

  for (const email of PLATFORM_ADMINS) {
    pgm.sql(`
      INSERT INTO platform_admin (email, status)
      VALUES (${lit(email.toLowerCase())}, 'active')
      ON CONFLICT (email) DO UPDATE
        SET status = 'active';
    `);
  }
};

/**
 * Reverse of up(). Removes only what up() added: the roster rows it seeded
 * (admin@carein.ai is NOT among them — it belongs to the earlier seed
 * migration and must survive this rollback), the two app_user columns, and the
 * platform_admin table.
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  const tenantId = lit(CAREIN_TENANT_ID);
  const emails = ROSTER.map((r) => lit(r.email)).join(', ');

  pgm.sql(`DELETE FROM app_user WHERE tenant_id = ${tenantId} AND email IN (${emails});`);

  pgm.dropConstraint('app_user', 'app_user_status_check');
  pgm.dropColumns('app_user', ['status', 'last_login_at']);

  pgm.dropTable('platform_admin');
};

// Exported for the migration test — the roster is data, and a test that asserts
// against a copy of it is a test that can silently drift.
exports.ROSTER = ROSTER;
exports.PLATFORM_ADMINS = PLATFORM_ADMINS;
exports.CAREIN_TENANT_ID = CAREIN_TENANT_ID;
