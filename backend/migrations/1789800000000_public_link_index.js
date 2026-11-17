'use strict';

/**
 * MT-3: the public link index — which TENANT a public email link belongs to.
 *
 * WHY. The public pages a patient or a specialist reaches from an email
 * (routes/referralLinkWebhooks.js, routes/emailWebhooks.js) carry no SSO user,
 * so until now they took their tenant from one app setting,
 * TC_EMAIL_TENANT_SLUG. Every link in the deployment therefore resolved into
 * ONE tenant's database, and a second practice's links would have hit the
 * wrong one. This table maps a link's token HASH to the tenant that minted it,
 * so the public route can find the right database before it reads anything.
 *
 * COLUMNS, AND WHAT THEY ARE NOT
 *
 *   token_hash   SHA-256 (hex) of the link's token, the same hash the tenant
 *                database stores. Never the token: a copy of this table yields
 *                no usable link.
 *   tenant_id    The tenant that minted the link.
 *   kind         'referral_link' (R5b specialist / patient links) or
 *                'unsubscribe' (the List-Unsubscribe link in every TC email).
 *   created_at   When the link was registered.
 *   expires_at   When the link stops resolving. Required for a referral link
 *                (they live 60 days). NULL for an unsubscribe link, which has
 *                never expired (an unsubscribe must keep working).
 *
 * NO PHI. No patient, office, case, referral or message id; no address; no
 * name. The tenant database's own row keeps all of that, and is still what
 * decides whether the link is live (single use, its own expiry).
 *
 * APPEND-ONLY, like audit_log. Expiry is by query (expires_at > now()), never
 * by deleting rows. Two layers enforce it:
 *   1. The grant: REVOKE ALL FROM PUBLIC, and INSERT + SELECT only for the
 *      least-privilege app role when it exists (same DO block as audit_log).
 *   2. A trigger that refuses UPDATE, DELETE and TRUNCATE. The control plane
 *      is reached with CONTROL_DB_URL, which today is not a least-privilege
 *      role (see 1789400000000_office_registry.js), so the grant alone would
 *      not stop the app. The trigger does, whatever role connects. DROP TABLE
 *      (down()) is not affected.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[public_link_index migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const TABLE = 'public_link_index';

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    token_hash: { type: 'text', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenant', onDelete: 'RESTRICT' },
    kind: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz' },
  });

  // token_hash and kind are NOT NULL, so these CHECKs cannot be passed by a NULL.
  pgm.addConstraint(TABLE, 'public_link_index_hash_check', {
    check: "token_hash ~ '^[0-9a-f]{64}$'",
  });
  pgm.addConstraint(TABLE, 'public_link_index_kind_check', {
    check: "kind IN ('referral_link', 'unsubscribe')",
  });
  // A referral link must expire; an unsubscribe link may not be given one by
  // accident either way it is written (NULL is the only unsubscribe shape).
  pgm.addConstraint(TABLE, 'public_link_index_expiry_check', {
    check: "(kind = 'referral_link' AND expires_at IS NOT NULL) OR (kind = 'unsubscribe' AND expires_at IS NULL)",
  });

  pgm.sql(`
    CREATE FUNCTION public_link_index_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'public_link_index is append-only (% refused)', TG_OP;
    END $$;
  `);
  pgm.sql(`
    CREATE TRIGGER public_link_index_no_update_delete
      BEFORE UPDATE OR DELETE ON ${TABLE}
      FOR EACH ROW EXECUTE FUNCTION public_link_index_append_only();
  `);
  pgm.sql(`
    CREATE TRIGGER public_link_index_no_truncate
      BEFORE TRUNCATE ON ${TABLE}
      FOR EACH STATEMENT EXECUTE FUNCTION public_link_index_append_only();
  `);

  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      REVOKE ALL ON TABLE ${TABLE} FROM PUBLIC;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE ${TABLE} FROM %I', r);
        EXECUTE format('GRANT INSERT, SELECT ON TABLE ${TABLE} TO %I', r);
        RAISE NOTICE '${TABLE}: append-only grants (INSERT, SELECT) applied to role %', r;
      ELSE
        RAISE NOTICE '${TABLE}: app role % absent — grants SKIPPED; the append-only trigger still applies.', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable(TABLE);
  pgm.sql('DROP FUNCTION IF EXISTS public_link_index_append_only();');
};
