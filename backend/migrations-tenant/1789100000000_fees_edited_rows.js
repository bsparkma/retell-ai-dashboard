'use strict';

/**
 * Per-tenant data-plane: a fourth row decision, `edited`.
 *
 * Slice 3 gave a warned row three answers: leave it alone, accept the parsed
 * number, or exclude the row entirely. Real payer files need a fourth. The
 * common warned row is the multi-column one —
 *
 *     D2740   Crown - porcelain/ceramic   1,150.00   920.00   805.00
 *
 * — where the parser took the first amount and said so. The office knows which
 * column their contract is in. Before this, their only options were to accept a
 * number they know is wrong or to drop the code out of the schedule; both are
 * worse than typing the right one.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. THE PARSED VALUE IS NEVER OVERWRITTEN
 * ═════════════════════════════════════════════════════════════════════════════
 * The override goes in a NEW column. `fee_cents` continues to hold exactly what
 * the file said, forever, and `raw_line` continues to hold the line it said it
 * on. That is the whole reason this module exists: the reference importer it
 * was ported from made its interpretations in place and in silence, and nobody
 * could reconstruct what the file had actually contained.
 *
 * So after an edit there are three facts on the row and all three survive:
 *   fee_cents         what the file said
 *   edited_fee_cents  what a human says it should be
 *   decided_by / _at  who said so, and when
 *
 * A screen can therefore always show "edited from $1,150.00", and the audit
 * trail can always answer "what did the file say before somebody changed it".
 * An UPDATE of `fee_cents` would have destroyed the only copy of the first.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. THE PAIR CHECKS — WHY BOTH DIRECTIONS
 * ═════════════════════════════════════════════════════════════════════════════
 *     decision = 'edited'  ⇒  edited_fee_cents IS NOT NULL AND >= 0
 *     decision <> 'edited' ⇒  edited_fee_cents IS NULL
 *
 * The first stops an `edited` row with no value, which would post the parsed
 * number while the screen said it had been corrected — a silent revert of
 * somebody's correction, which is the exact failure this feature exists to
 * prevent.
 *
 * The second is the one that is easy to leave out and costs more. Without it, a
 * row could carry an override while sitting at `accepted` or `pending`, and
 * every reader — the job, the totals, the confirm dialog — would have to decide
 * for itself whether an override on a non-edited row counts. They would not all
 * decide the same way. With it, `COALESCE(edited_fee_cents, fee_cents)` and
 * `CASE WHEN decision = 'edited' …` are provably the same expression, so a
 * caller cannot disagree with another caller by accident.
 *
 * Re-deciding is therefore a real transition, not a flag: edited → accepted
 * MUST clear the override, and the database refuses the alternative.
 *
 * `>= 0` rather than `> 0`: $0.00 is a legitimate fee meaning not covered,
 * bundled, or no charge. The reference importer discarded every zero with a
 * `> 0` guard and this module has spent three slices not doing that.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. NO NEW TABLE, SO NO GRANT BLOCK
 * ═════════════════════════════════════════════════════════════════════════════
 * This migration only alters `fees_import_row`, which the slice-1 migration
 * created and granted. A grant follows the table, not its columns, so a new
 * column on a granted table needs nothing. The repo's rule is that a CREATE
 * without a GRANT is a defect; an ALTER without one is correct, and stating that
 * here is cheaper than the next reader checking.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

const DECISION_CONSTRAINT = 'fees_import_row_decision_check';

/**
 * The four answers a row can carry.
 *
 * `pending` is the default and is what a CLEAN row stays at forever — the
 * posting gate is warned-AND-pending, not a checklist.
 */
const ROW_DECISIONS = ['pending', 'accepted', 'excluded', 'edited'];

/**
 * The same ceiling the parser applies (`services/fees/feeValues.js`
 * MAX_FEE_CENTS, $20,000,000.00). The column is an `integer`, which tops out at
 * 2,147,483,647 cents, so a typed-in figure past the cap would otherwise be an
 * INSERT error — a 500 where a refusal belongs. The route validates it first;
 * this is the backstop that makes the refusal a property of the data rather
 * than of the one handler that happens to check.
 */
const MAX_FEE_CENTS = 2000000000;

/** `decision = 'edited'` ⇒ there is a value, and it is a real amount. */
const EDITED_VALUE_CHECK = `decision <> 'edited' OR (edited_fee_cents IS NOT NULL AND edited_fee_cents >= 0 AND edited_fee_cents <= ${MAX_FEE_CENTS})`;

/** Anything else ⇒ there is no override. See note 2 — this is the load-bearing half. */
const EDITED_ONLY_CHECK = "decision = 'edited' OR edited_fee_cents IS NULL";

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('fees_import_row', {
    /**
     * What a human says this fee should be, in integer CENTS.
     *
     * NULL on every row that has not been edited — see the pair CHECKs. The
     * parsed value lives in `fee_cents` and is never touched.
     */
    edited_fee_cents: { type: 'integer' },
  });

  // REPLACE, NOT ALTER — Postgres has no "widen a CHECK". Guarded DROP so this
  // is safe on a database that somehow never got the slice-3 constraint. The
  // literal is written inline at addConstraint because config/modules.test.js
  // and its siblings scan migration SOURCE TEXT; a constant interpolated here
  // would read as an empty constraint to them.
  pgm.sql(`ALTER TABLE fees_import_row DROP CONSTRAINT IF EXISTS ${DECISION_CONSTRAINT};`);
  pgm.addConstraint('fees_import_row', DECISION_CONSTRAINT, {
    check: "decision IN ('pending', 'accepted', 'excluded', 'edited')",
  });

  pgm.addConstraint('fees_import_row', 'fees_import_row_edited_value_check', {
    check: EDITED_VALUE_CHECK,
  });
  pgm.addConstraint('fees_import_row', 'fees_import_row_edited_only_check', {
    check: EDITED_ONLY_CHECK,
  });
};

/**
 * Reverse of up().
 *
 * NOT SYMMETRIC, for the reason the slice-3 migration's down() records:
 * narrowing a CHECK back fails against rows the wider one admitted, so the rows
 * move first.
 *
 * An `edited` row becomes `pending`, WITH ITS ATTRIBUTION LEFT IN PLACE. The
 * alternatives are both worse. `accepted` would assert that the parsed number
 * is the fee this office holds, which is the one thing the row's existence
 * proves it is not — and the override column is about to be dropped, so the
 * correction would be gone and the wrong number would post. `excluded` is
 * refused outright by `fees_import_row_excluded_unwritten_check` on any row
 * that was already written.
 *
 * `pending` re-blocks the post for a warned row, which is the honest outcome:
 * rolling this migration back discards somebody's correction, and the batch
 * should stop until a person looks again. That cost is the point of writing it
 * down rather than discovering it during an incident.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('fees_import_row', 'fees_import_row_edited_only_check', { ifExists: true });
  pgm.dropConstraint('fees_import_row', 'fees_import_row_edited_value_check', { ifExists: true });

  pgm.sql(`UPDATE fees_import_row SET decision = 'pending' WHERE decision = 'edited';`);

  pgm.sql(`ALTER TABLE fees_import_row DROP CONSTRAINT IF EXISTS ${DECISION_CONSTRAINT};`);
  pgm.addConstraint('fees_import_row', DECISION_CONSTRAINT, {
    check: "decision IN ('pending', 'accepted', 'excluded')",
  });

  pgm.dropColumns('fees_import_row', ['edited_fee_cents']);
};

/** Exported for the tests that assert these against the service constants. */
exports.ROW_DECISIONS = ROW_DECISIONS;
exports.MAX_FEE_CENTS = MAX_FEE_CENTS;
exports.EDITED_VALUE_CHECK = EDITED_VALUE_CHECK;
exports.EDITED_ONLY_CHECK = EDITED_ONLY_CHECK;
