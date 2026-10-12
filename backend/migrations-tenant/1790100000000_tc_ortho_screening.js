'use strict';

/**
 * The hygienist's ortho screening, on the TC intake it arrives with (item 33).
 *
 * ONE NULLABLE jsonb COLUMN, ADDITIVE. Every intake before this — and every
 * treatment handoff after it, which carries no screening — is NULL, and NULL
 * renders exactly as the case did before. No backfill, no default: there is no
 * honest value to give an intake nobody screened.
 *
 * jsonb rather than eighteen columns for the same reason the hygiene slip is
 * one: the screening is a FORM whose chip lists belong to the practice, every
 * answer is a closed vocabulary or a short string that nothing joins on, and
 * the shape is enforced by `OrthoScreeningSchema` on both sides of the wire
 * (new-dashboard/shared/hyg/orthoScreening.ts, bundled into both
 * backend/tc/contract.gen.cjs and backend/hyg/contract.gen.cjs). The intake row
 * is only ever written through `TcCase.parse`, so a malformed screening is a
 * 400 before it is a row.
 *
 * GRANTS. No new table, so no new grant: the least-privilege `carein_app` role
 * already holds SELECT/INSERT/UPDATE/DELETE on `tc_hygiene_intakes` from
 * 1785373200000_tc_schema.js, and a table-level grant covers a column added
 * later. The block below re-asserts exactly that grant, role-guarded the same
 * way, so a database whose grant was ever narrowed to a column list cannot
 * fail the first ortho intake as a permission error instead of a red migration.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

// The same role and the same validation every grant-carrying migration uses.
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_ortho_screening migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('tc_hygiene_intakes', {
    // NULL = no screening. Never '{}': an empty object would read as "screened,
    // nothing answered", which is a different sentence to a TC.
    ortho_screening: { type: 'jsonb' },
  });

  // A screening is an OBJECT or it is absent. A bare string or array in this
  // column is a row no renderer can read.
  pgm.addConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_ortho_screening_object_check', {
    check: "ortho_screening IS NULL OR jsonb_typeof(ortho_screening) = 'object'",
  });

  // The carein_app grant, re-asserted. Guarded on the role existing so local
  // dev on a superuser is a NOTICE, not a crash.
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', 'tc_hygiene_intakes', r);
      ELSE
        RAISE NOTICE 'role % does not exist; skipping tc_hygiene_intakes grant', r;
      END IF;
    END
    $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  // Constraint before column, so rollback runs in the reverse of application.
  pgm.dropConstraint('tc_hygiene_intakes', 'tc_hygiene_intakes_ortho_screening_object_check', {
    ifExists: true,
  });
  pgm.dropColumns('tc_hygiene_intakes', ['ortho_screening'], { ifExists: true });
};
