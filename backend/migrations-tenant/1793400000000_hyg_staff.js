'use strict';

/**
 * hyg_staff — the practice's hygienists, entered by the office manager.
 *
 * Replaces the HYGIENISTS list in backend/config/hygStaff.js as the source of
 * a note's typed-name line. That file STAYS: it is the fallback for an office
 * with no rows here yet, so nothing changes until somebody enters data.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. TWO PEOPLE MAY SHARE A NAME; NO TWO SHARE A SIGN-IN
 * ═════════════════════════════════════════════════════════════════════════════
 * There is deliberately NO unique index on the name. What identifies a row is
 * `sign_in_ids` — the emails / usernames that mean "this person is signed in" —
 * and every row must carry at least one. No sign-in id may appear on two rows
 * of the same office (active or not), or a signed-in hygienist could be printed
 * as somebody else, licence and all.
 *
 * Postgres cannot put a unique index across the members of a jsonb array, so
 * that rule is enforced twice: the route refuses an overlap with a 409 before
 * it writes (services/hyg/staffStore.js), and the trigger below is the backstop
 * two simultaneous saves cannot race past. It takes a per-office advisory lock
 * for the rest of the transaction, then looks — and because a plpgsql statement
 * takes a fresh snapshot, it sees a row the other save committed while it
 * waited. A collision raises unique_violation (23505), which the store maps to
 * the same 409.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. A LICENCE IS NEVER A PLACEHOLDER
 * ═════════════════════════════════════════════════════════════════════════════
 * NULL means "none on file", and the note then prints the name alone. A blank
 * string is refused, so "" can never stand in for NULL and print `RDH #`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. NO HARD DELETE
 * ═════════════════════════════════════════════════════════════════════════════
 * A person leaves by `active = false`. The app role is granted SELECT, INSERT
 * and UPDATE only — not DELETE — so that is true of the database, not only of
 * the routes.
 *
 * Staff, not patients: nothing here is PHI.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

// Least-privilege app role — the same role-guarded GRANT every table-creating
// migration in this repo carries. See 1788200000000_hyg_visit.js.
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[hyg_staff migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

const TABLE = 'hyg_staff';

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  pgm.createTable(TABLE, {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office: { type: 'text', notNull: true },
    full_name: { type: 'text', notNull: true },
    license: { type: 'text' },
    sign_in_ids: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    active: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_by: { type: 'text', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Inline literals, as in every hyg migration: a migration records what the
  // database was told, and must not change meaning when today's source does.
  pgm.addConstraint(TABLE, `${TABLE}_office_check`, { check: "office IN ('roland', 'valley')" });
  pgm.addConstraint(TABLE, `${TABLE}_full_name_check`, {
    check: "btrim(full_name) <> '' AND char_length(full_name) <= 120",
  });
  pgm.addConstraint(TABLE, `${TABLE}_license_check`, {
    check: "license IS NULL OR (btrim(license) <> '' AND char_length(license) <= 40)",
  });
  pgm.addConstraint(TABLE, `${TABLE}_sign_in_ids_check`, {
    check:
      "jsonb_typeof(sign_in_ids) = 'array' AND jsonb_array_length(sign_in_ids) BETWEEN 1 AND 10",
  });

  pgm.createIndex(TABLE, ['office'], { name: `${TABLE}_office_idx` });

  // ── The sign-in uniqueness backstop (see note 1) ───────────────────────────
  pgm.sql(`
    CREATE FUNCTION ${TABLE}_sign_in_unique() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('${TABLE}:' || NEW.office));
      IF EXISTS (
        SELECT 1 FROM ${TABLE} s
         WHERE s.office = NEW.office
           AND s.id <> NEW.id
           AND s.sign_in_ids ?| ARRAY(SELECT jsonb_array_elements_text(NEW.sign_in_ids))
      ) THEN
        RAISE EXCEPTION 'a sign-in id on this row is already used by another staff row in office %', NEW.office
          USING ERRCODE = 'unique_violation', CONSTRAINT = '${TABLE}_sign_in_ids_unique';
      END IF;
      RETURN NEW;
    END
    $fn$;
  `);
  pgm.sql(`
    CREATE TRIGGER ${TABLE}_sign_in_unique
      BEFORE INSERT OR UPDATE OF sign_in_ids, office ON ${TABLE}
      FOR EACH ROW EXECUTE FUNCTION ${TABLE}_sign_in_unique();
  `);

  // ── App-role grants: no DELETE (note 3) ────────────────────────────────────
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', '${TABLE}');
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I', '${TABLE}', r);
        RAISE NOTICE '${TABLE}: SELECT/INSERT/UPDATE granted to role %', r;
      ELSE
        RAISE NOTICE '${TABLE}: app role % absent - grants SKIPPED. Create the least-privilege role and re-run.', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS ${TABLE}_sign_in_unique ON ${TABLE};`);
  pgm.sql(`DROP FUNCTION IF EXISTS ${TABLE}_sign_in_unique();`);
  pgm.dropTable(TABLE, { ifExists: true });
};
