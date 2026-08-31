'use strict';

/**
 * WHAT IT WAS BEFORE — one slug on the audit row, for actions that REPLACE a
 * decision somebody already made.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES
 * ─────────────────────────────────────────────────────────────────────────────
 * Stage C-2 records, per check, whether the app's figures came out the same as
 * what the biller posted by hand — and lets her change that answer until the
 * check posts. The check's own row carries a `comparison_revision` counter, so
 * the product can say *"this was answered twice"*.
 *
 * It cannot say WHICH WAY. "How often did she revise, and in which direction"
 * is exactly the question somebody weighing whether to switch posting on will
 * ask — a `same` corrected to `differed` is the app being caught, and a
 * `differed` corrected to `same` is the biller catching herself, and those two
 * mean opposite things about the software. The counter cannot tell them apart.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WHOLE CHAIN IS RECONSTRUCTIBLE FROM THIS ONE COLUMN
 * ─────────────────────────────────────────────────────────────────────────────
 * Every answer files an audit row. A revision's row records what the answer WAS
 * before it, so for one `resource_id` ordered by `ts`:
 *
 *   row 1  prior_state = NULL                 first answer — nothing replaced
 *   row 2  prior_state = 'same'               ⇒ answer 1 was `same`
 *   row 3  prior_state = 'differed:write_off' ⇒ answer 2 was `differed`/write_off
 *   the batch row's own columns               ⇒ answer 3, the one that stands
 *
 * Each row names its predecessor and the table names the last one, so the full
 * sequence and every direction of travel falls out of N rows. Recording the NEW
 * state as well would have been the same fact written twice, and two copies of
 * one fact are two chances to disagree.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT IS STRUCTURALLY INCAPABLE OF HOLDING PROSE, AND THAT IS THE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 * `audit_log` has no detail column, deliberately: this platform never copies
 * free text a person typed into the trail, because a biller's own sentence is
 * PHI-capable by nature (see `comparison_note`, `parked_note`, `withdrawn_note`).
 * A column called `detail` or `metadata` would become that copy within two
 * slices, whatever its comment said.
 *
 * So the CHECK below is not decoration — it is the whole safety argument. The
 * grammar is `slug` or `slug:slug`, lowercase and underscores only, 64 chars:
 *
 *   ACCEPTS   'same'   'differed:payment_amount'   'withdrawn'
 *   REFUSES   'The office absorbed $60 on Ms Fixture's crown'
 *             'Differed'   'differed: payment_amount'   'a note'
 *
 * A sentence has a space, a capital or a punctuation mark in it. A patient name
 * has a capital. Neither can be stored here, by the database rather than by
 * anybody remembering — which is the same reasoning `comparison_reason` follows
 * one table over, and the reason this is a CHECK rather than a comment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A PLATFORM COLUMN FOR A FEATURE'S QUESTION
 * ─────────────────────────────────────────────────────────────────────────────
 * The same precedent `source_ref` (1786500000000, the voice→TC handoff) and
 * `origin_office` (1787200000000, cross-office chart writes) set: an audit
 * DIMENSION that one feature needs first, named for what it means rather than
 * for the feature, and constrained to identifiers. Nothing here is specific to
 * the comparison — "what did this action replace" is a question any decision
 * this product lets somebody revise will eventually raise.
 *
 * The append-only grant is table-level INSERT (1780453117650), so the app role
 * writes the new column with no additional grant.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

/**
 * `slug` or `slug:slug` — lowercase, digits and underscores, 64 chars at most.
 *
 * Anchored at both ends, so a sentence with a slug in it does not slip through
 * on a partial match.
 */
const PRIOR_STATE_GRAMMAR = "prior_state ~ '^[a-z0-9_]{1,32}(:[a-z0-9_]{1,31})?$'";

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumn('audit_log', {
    /**
     * What the thing this action touched WAS, immediately before it — as a slug
     * from that thing's own closed vocabulary. NULL means this action replaced
     * nothing, which is the case for every row written before this migration
     * and for every first-time decision after it.
     *
     * NEVER prose, NEVER a person's words, NEVER PHI. The CHECK enforces it.
     */
    prior_state: { type: 'text' },
  });

  pgm.addConstraint('audit_log', 'audit_log_prior_state_check', {
    /*
     * LED BY `IS NULL`, so the expression is two-valued.
     *
     * RCM_POSTING §15: Postgres ACCEPTS a CHECK that evaluates to NULL — it only
     * refuses FALSE. `prior_state ~ '…'` against a NULL yields NULL, so the bare
     * regex would have accepted every row AND every sentence somebody later put
     * in a non-null one, because the constraint would never have been consulted
     * for the null case and the flaw would have hidden behind rows that passed.
     * Same trap the C-2 pairing CHECK was written the long way to avoid.
     */
    check: `prior_state IS NULL OR (${PRIOR_STATE_GRAMMAR})`,
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  /*
   * CONSTRAINT BEFORE COLUMN — Postgres silently drops a CHECK when a column it
   * references goes, so the explicit dropConstraint must come first or it fails.
   * PR #113's rollback found this by being run, and every RCM `down` since is
   * written this way.
   *
   * Rolls back over live rows: `audit_log` is append-only and nothing reads this
   * column to decide anything, so dropping it loses history rather than
   * corrupting state. An un-runnable `down` is not a safety property, it is an
   * untested one.
   */
  pgm.dropConstraint('audit_log', 'audit_log_prior_state_check');
  pgm.dropColumn('audit_log', 'prior_state');
};

module.exports.PRIOR_STATE_GRAMMAR = PRIOR_STATE_GRAMMAR;
