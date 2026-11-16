'use strict';

/**
 * Per-tenant data-plane: "Holding" as a 4th hygiene treatment-item priority.
 *
 * WHAT HOLDING MEANS (Beau's ruling). It marks an alternative or secondary
 * option to the proposed treatment — a bridge held as the alternative to the
 * proposed implant. It is NOT a level of urgency: a holding item never raises,
 * and never determines, the urgency of a visit, a checkout card or a TC case.
 * That rule lives in code (services/hyg/tcHandoffClient.js, shared/tc
 * checkout.ts); this migration only lets the value be stored.
 *
 * ONE CHECK WIDENED, NOTHING ELSE:
 *   hyg_treatment_item_priority_check (created by 1788200000000_hyg_visit.js)
 *     urgent | preventative | cosmetic   →   urgent | preventative | cosmetic | holding
 *
 * ITEM-LEVEL ONLY. No visit-level priority column exists in the hygiene
 * tables, and TC stores the checkout snapshot (procedures and the visit's
 * priority) as jsonb with no priority CHECK (1791300000000), so there is no
 * other CHECK to widen. The visit-level value stays three-valued in the
 * contract (TcCheckoutPriority).
 *
 * The CHECK literals are INLINE at the addConstraint calls on purpose: a
 * migration is a record of what a database was told, and one that reads its
 * constraint out of today's source silently changes meaning when that source
 * changes. TREATMENT_PRIORITIES is exported for the drift test only
 * (services/hyg/visitSchema.test.js, test/hygPriorityHoldingMigration.test.js
 * asserts the inline literal says the same thing).
 *
 * down() MOVES 'holding' ROWS FIRST. Restoring the three-value CHECK over a
 * table that still holds a 'holding' row would fail (the #278 class of bug), so
 * down() first rewrites them to 'cosmetic' — the lowest of the three, the one
 * that raises nothing — IN THE DOWN STEP, then restores the old CHECK. That
 * rewrite is lossy by necessity: the old schema has no word for "holding".
 *
 * No grant change: hyg_treatment_item's table-level grant (1788200000000)
 * is untouched. No Open Dental effect.
 *
 * The real-Postgres half (the CHECK evaluated, the real down() and up() with a
 * 'holding' row present) is scripts/hyg-priority-holding-verify-queries.js,
 * which CI runs after migrate.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const TABLE = 'hyg_treatment_item';
const PRIORITY_CHECK = 'hyg_treatment_item_priority_check';

/** The vocabulary the CHECK enforces after up(). For the drift tests only. */
const TREATMENT_PRIORITIES = ['urgent', 'preventative', 'cosmetic', 'holding'];
/** The vocabulary the CHECK enforces after down() — 1788200000000's. */
const PREVIOUS_PRIORITIES = ['urgent', 'preventative', 'cosmetic'];

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.dropConstraint(TABLE, PRIORITY_CHECK);
  pgm.addConstraint(TABLE, PRIORITY_CHECK, {
    check: "priority IN ('urgent', 'preventative', 'cosmetic', 'holding')",
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  // FIRST: no row may carry a value the restored CHECK refuses.
  pgm.sql(`UPDATE ${TABLE} SET priority = 'cosmetic' WHERE priority = 'holding'`);
  pgm.dropConstraint(TABLE, PRIORITY_CHECK);
  pgm.addConstraint(TABLE, PRIORITY_CHECK, {
    check: "priority IN ('urgent', 'preventative', 'cosmetic')",
  });
};

exports.TABLE = TABLE;
exports.PRIORITY_CHECK = PRIORITY_CHECK;
exports.TREATMENT_PRIORITIES = TREATMENT_PRIORITIES;
exports.PREVIOUS_PRIORITIES = PREVIOUS_PRIORITIES;
