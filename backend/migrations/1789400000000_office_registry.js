'use strict';

/**
 * The office registry (MT-1a): one row per office of a tenant, in the control
 * plane.
 *
 * WHY. Everything that says which offices a practice has, and how each one
 * reaches its phones and its Open Dental database, is a hardcoded map in
 * config/officeAgents.js (labels, Retell agents, Mango DIDs) and
 * config/odOffices.js (customer-key secret NAME, commlog DefNums, OD switches).
 * A second practice cannot be onboarded without a deploy. This table is where
 * those facts will live once it is the source of truth.
 *
 * MT-1a SHIPS IT DARK. Nothing serves these values. platform/officeRegistry.js
 * reads them so the parity tripwire can compare them with the code maps and
 * warn on any drift, and every consumer keeps getting the CODE answer. The
 * cutover is a later slice, once the tripwire has stayed silent in every
 * environment.
 *
 * COLUMNS, AND WHAT THEY ARE NOT
 *
 *   office_key             The FROZEN internal key ('roland', 'valley'). It is
 *                          stored on calls and sent in office_id params, so it
 *                          is never renamed. display_name may change freely.
 *   retell_agent_ids       jsonb array of Retell agent id strings.
 *   mango_dids             jsonb array of E.164 DIDs ('+1XXXXXXXXXX').
 *   od_customer_key_secret The Key Vault secret NAME. NEVER a key value: the
 *                          value is read from process.env, which config/secrets
 *                          fills at startup.
 *   od_customer_key_env    The process.env variable NAME that holds the key.
 *   commtype_defnums       {"call": n|null, "referral": n|null}. DefNums are
 *                          per Open Dental database and must never cross
 *                          offices. A null member means UNCONFIGURED, and the
 *                          reader refuses that write. It never falls back to
 *                          another type or another office's number.
 *   od_enabled             The voice/TC Open Dental switch (odOffices odEnabled).
 *   hyg_od_enabled         The hygiene module's hardcoded FLOOR (odOffices
 *                          hygOdEnabled). It is not the live pilot switch; that
 *                          stays in platform_setting via config/hygPilot.js.
 *
 * The 'unknown' bucket is NOT a row and cannot become one (office_not_unknown).
 * It is where unattributable calls land, it has no Open Dental database, and it
 * stays code-only.
 *
 * NO carein_app GRANT. Like platform_setting and app_user, this is a control
 * plane table, and the app reaches the control plane with CONTROL_DB_URL.
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
  pgm.createTable('office', {
    tenant_id: { type: 'uuid', notNull: true, references: 'tenant', onDelete: 'CASCADE' },
    office_key: { type: 'text', notNull: true },
    display_name: { type: 'text', notNull: true },
    sort_order: { type: 'integer', notNull: true, default: 0 },
    retell_agent_ids: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    mango_dids: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    od_customer_key_secret: { type: 'text' },
    od_customer_key_env: { type: 'text' },
    commtype_defnums: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func(`'{"call": null, "referral": null}'::jsonb`),
    },
    od_enabled: { type: 'boolean', notNull: true, default: false },
    hyg_od_enabled: { type: 'boolean', notNull: true, default: false },
    status: { type: 'text', notNull: true, default: 'active' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // The email of whoever last wrote the row. An identifier, not PHI. Null for
    // a row written by a migration (the seed) or a runbook.
    updated_by: { type: 'text' },
  });

  pgm.addConstraint('office', 'office_pkey', { primaryKey: ['tenant_id', 'office_key'] });

  // Every column below is NOT NULL, so none of these CHECKs can be satisfied by
  // a NULL slipping past an IN () or a comparison.
  pgm.addConstraint('office', 'office_status_check', {
    check: "status IN ('active', 'disabled')",
  });
  pgm.addConstraint('office', 'office_key_shape', {
    check: "office_key ~ '^[a-z][a-z0-9_]*$'",
  });
  pgm.addConstraint('office', 'office_not_unknown', {
    check: "office_key <> 'unknown'",
  });
  pgm.addConstraint('office', 'office_retell_agent_ids_array', {
    check: "jsonb_typeof(retell_agent_ids) = 'array'",
  });
  pgm.addConstraint('office', 'office_mango_dids_array', {
    check: "jsonb_typeof(mango_dids) = 'array'",
  });
  // Exactly the two members, each a positive integer or JSON null. A typo'd key
  // ("referal") would otherwise read as "referral unconfigured" and refuse
  // silently, which is the safe direction but still the wrong one.
  pgm.addConstraint('office', 'office_commtype_defnums_shape', {
    // (No subquery: Postgres refuses one in a CHECK. Subtracting the two known
    // keys and requiring what is left to be {} is the same "exactly these" test.)
    check: `
      jsonb_typeof(commtype_defnums) = 'object'
      AND commtype_defnums ?& ARRAY['call', 'referral']
      AND (commtype_defnums - 'call' - 'referral') = '{}'::jsonb
      AND (jsonb_typeof(commtype_defnums->'call') = 'null'
           OR (jsonb_typeof(commtype_defnums->'call') = 'number'
               AND (commtype_defnums->>'call') ~ '^[1-9][0-9]*$'))
      AND (jsonb_typeof(commtype_defnums->'referral') = 'null'
           OR (jsonb_typeof(commtype_defnums->'referral') = 'number'
               AND (commtype_defnums->>'referral') ~ '^[1-9][0-9]*$'))
    `,
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('office');
};
