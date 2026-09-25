'use strict';

/**
 * Per-tenant data-plane: WHO ASKED FOR THE POST, recorded separately from who
 * it was posted by.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS COLUMN EXISTS — THE BUG IT CLOSES
 * ═════════════════════════════════════════════════════════════════════════════
 * `fees_import_batch_posted_pair_check` says
 *
 *     (posted_by IS NULL) = (posted_at IS NULL)
 *
 * and it is right to. Half an attribution is worse than none, because it looks
 * like a whole one: a row naming a person with no time, or a time with no
 * person, reads as a completed post to anything that checks either column.
 *
 * `claimBatchForPosting` then tried to record who pressed Post at CLAIM time:
 *
 *     UPDATE fees_import_batch SET posted_by = COALESCE(posted_by, $3)
 *      WHERE office = $1 AND batch_id = $2 AND posted_at IS NULL
 *
 * Its own WHERE guarantees `posted_at IS NULL`; its SET makes `posted_by`
 * non-null. That is exactly the row the CHECK forbids, so the statement threw —
 * on the FIRST post of EVERY batch, deterministically. The job died at its first
 * database write, before the backup, before the procedure-code map and before
 * the write loop, and the fee-posting module had never successfully written a
 * fee when this was found (staging, 2026-09-24; see
 * docs/reports/fees-post-failure-recon.md).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE FIX IS A COLUMN, NOT A LOOSER CONSTRAINT
 * ═════════════════════════════════════════════════════════════════════════════
 * The constraint is not the defect and is NOT touched. What was wrong is that
 * two different facts were being stored in one column:
 *
 *   post_requested_by   who pressed Post. Known at claim time. NOT half of any
 *                       pair, so writing it early is safe by construction.
 *   posted_by           who the completed post is attributed to. Meaningless
 *                       before there is a `posted_at` to pair with, which is
 *                       precisely what the CHECK is saying.
 *
 * `markPosted` now lands the pair together, taking `posted_by` from
 * `COALESCE(post_requested_by, 'unknown')` — so attribution still names the
 * ORIGINAL requester rather than whoever's container happened to resume the run
 * or take it over after a SIGKILL. The first-claim-wins COALESCE that made that
 * true is kept; it simply writes to a column that can hold it.
 *
 * Relaxing the CHECK to `posted_at IS NULL OR posted_by IS NOT NULL` would have
 * been one line and would have thrown away the guarantee. A half-written pair
 * would then be storable forever, and the next reader of `posted_by` would have
 * to know which halves are trustworthy.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO GRANT BLOCK
 * ═════════════════════════════════════════════════════════════════════════════
 * A grant follows the table, not its columns, and `fees_import_batch` was
 * granted by the slice-1 migration. The repo's rule is that a CREATE without a
 * GRANT is a defect; an ALTER without one is correct, and saying so here is
 * cheaper than the next reader checking.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('fees_import_batch', {
    /**
     * Who pressed Post, stamped on the first claim and never overwritten.
     *
     * NULLABLE and DELIBERATELY UNPAIRED. It answers "who started this" for a
     * run that is still going or that failed partway — the two states in which
     * `posted_by` is necessarily NULL and the question is most likely to be
     * asked. A batch that reaches `posted` carries both: this column for who
     * asked, `posted_by` for who the finished post is attributed to, and today
     * they are the same person by construction.
     *
     * NOT backfilled. Batches posted before this migration have no requester on
     * record, and inventing one — from `created_by`, say — would put a name
     * against an act that person may not have performed. NULL is the honest
     * answer to a question that was never recorded.
     */
    post_requested_by: { type: 'text' },
  });
};

/**
 * Reverse of up().
 *
 * Symmetric, and safe: no constraint references the column, and dropping it
 * loses only the requester of any run started since it landed. A batch that
 * completed still carries `posted_by`/`posted_at`, which is the attribution
 * that matters after the fact.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('fees_import_batch', ['post_requested_by']);
};
