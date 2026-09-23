'use strict';

/**
 * THE EFFECTIVE FEE: the one number that actually gets written, in one place.
 *
 * A row carries two amounts once inline editing exists — `fee_cents`, what the
 * file said, and `edited_fee_cents`, what a human says it should be. Exactly
 * one of them reaches Open Dental:
 *
 *     decision = 'edited'  →  edited_fee_cents
 *     anything else        →  fee_cents
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A FILE AND NOT THREE `CASE` EXPRESSIONS
 * ═════════════════════════════════════════════════════════════════════════════
 * Four things need the answer and they do not all get it the same way:
 *
 *   the posting job      per row, in JavaScript, to decide what to write and
 *                        what to compare a read-back against
 *   the summary totals   in SQL, as a SUM over the whole batch
 *   the confirm dialog   from those totals, before the human clicks Post
 *   the audit row        from those totals, after they do
 *
 * If the rule were written out at each of those, the plausible defect is not
 * that one of them is wrong today — it is that somebody later adds a fifth
 * decision, or a second override column, and updates three of the four. The
 * confirm dialog would then state a total the job does not write, and the
 * person approving it would be approving a number that never existed. A
 * disagreement between a confirmation and the thing it confirms is the worst
 * shape this can fail in, because it looks like review-then-send while not
 * being it.
 *
 * So both forms live here, next to each other, and every caller takes one of
 * them. Changing the rule means changing this file, and the two forms are three
 * lines apart, so they cannot drift without somebody seeing both.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SQL SAYS THE RULE, NOT A SHORTCUT FOR IT
 * ═════════════════════════════════════════════════════════════════════════════
 * `COALESCE(edited_fee_cents, fee_cents)` would compute the same answer today,
 * because `fees_import_row_edited_only_check` guarantees the override is NULL
 * on every non-edited row. It is not written that way. The COALESCE is only
 * correct as long as that constraint exists somewhere else; the CASE is correct
 * on its own terms, and states the rule a reader is trying to learn.
 *
 * INTEGER CENTS THROUGHOUT. Never dollars, never a float — the platform rule,
 * and the reason a read-back comparison can use `===` at all.
 */

/**
 * The effective fee as a SQL expression, for aggregates over `fees_import_row`.
 *
 * Unqualified column names, so it works both bare and under a table alias that
 * does not shadow them. Interpolated into statements as a compile-time
 * constant; it contains no value and no parameter.
 *
 * @type {string}
 */
const EFFECTIVE_FEE_CENTS_SQL =
  "CASE WHEN decision = 'edited' THEN edited_fee_cents ELSE fee_cents END";

/**
 * The effective fee for one row, in integer cents.
 *
 * Takes the database row shape (snake_case) because every caller in this module
 * has one — the job reads rows straight out of `fees_import_row`.
 *
 * DEFENSIVE ON A MISSING OVERRIDE. An `edited` row with no `edited_fee_cents`
 * cannot exist — the pair CHECK refuses it — but if one ever did, falling back
 * to the parsed value would silently write the number the office corrected
 * away. Throwing is the honest response: a row whose effective fee is unknown
 * is not a row to guess at, and the job's catch turns it into `post_failed`
 * with the reason, which is a state somebody can act on.
 *
 * @param {{ decision?: string|null, fee_cents?: number|string|null, edited_fee_cents?: number|string|null }} row
 * @returns {number}
 */
function effectiveFeeCents(row) {
  if (row && row.decision === 'edited') {
    const edited = row.edited_fee_cents;
    if (edited === null || edited === undefined) {
      throw new Error(
        "[fees] a row marked 'edited' carries no edited_fee_cents — refusing to post the parsed value in its place"
      );
    }
    return Number(edited);
  }
  return Number((row && row.fee_cents) ?? 0);
}

module.exports = {
  EFFECTIVE_FEE_CENTS_SQL,
  effectiveFeeCents,
};
