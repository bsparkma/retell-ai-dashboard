'use strict';

/**
 * Per-tenant data-plane: AMENDING a perio chart that is already in Open Dental
 * (H4 item 13).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A CHART THAT IS `Written` MUST BE EDITABLE AGAIN
 * ═════════════════════════════════════════════════════════════════════════════
 * Slice 2 gave every staged write one lifecycle — Draft → Staged → Sending →
 * Written | Failed — and `Written` was terminal because a procnote in Open
 * Dental is physically append-only: a sent note can never be unsaid. Perio
 * measurements are NOT notes. They are editable in Open Dental's own chart, and
 * a hygienist fixing a mistyped depth is routine clinical work. Locking her out
 * of a sent chart sent her to Open Dental to do it, which defeats charting in
 * CareIN at all.
 *
 * So this migration adds ONE state, `Amending`: a sent chart being edited for a
 * correction. It is client-mutable like `Draft`, and it means *"there is an exam
 * in Open Dental, and these readings are the correction being prepared for it"*.
 * Nothing in Open Dental changes while a chart sits here.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AN AMENDMENT IS A SAFE SWAP, AND THESE COLUMNS ARE WHAT MAKES IT ONE
 * ═════════════════════════════════════════════════════════════════════════════
 * `PUT /periomeasures` is documented by Open Dental and has NEVER been exercised
 * against a live database — exactly the status arch strings had before the probe
 * found they corrupt a chart silently (docs/reports/feature-hyg-perio-arch-probe.md
 * §4, Q3). So an amendment uses only the two proven operations: `POST
 * /perioexams` and `DELETE /perioexams/{n}`, in this order —
 *
 *     POST the corrected exam → read back EVERY site → only then DELETE the old.
 *
 * `supersedes_exam_num` is the old exam this send is replacing, recorded when
 * the amendment is confirmed. `supersedes_deleted_at` is stamped only after the
 * new exam verified AND the old one was read back gone. A send with the first
 * and not the second is the honest record of a swap whose last step did not
 * land: the chart is correct in Open Dental, and a duplicate exam is still there
 * to remove.
 *
 * `chart` is the chart the send WROTE. It is the baseline the next amendment
 * diffs against ("#14 B: 3 mm → 4 mm") and the thing an amendment re-reads Open
 * Dental against before it writes: if the exam no longer matches what CareIN
 * wrote, somebody edited it in Open Dental, and this build refuses rather than
 * quietly reverting their correction.
 *
 * `amend_diff` is that per-site diff, frozen at confirm, so the record of what
 * was corrected does not depend on re-deriving it later from two charts.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CHECKS ARE WRITTEN THE LONG WAY
 * ═════════════════════════════════════════════════════════════════════════════
 * Postgres ACCEPTS a CHECK that evaluates to NULL, so every nullable column is
 * tested with IS [NOT] NULL before anything else is asserted about it.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

/**
 * The staged-write lifecycle AFTER this migration. Inline literals, asserted
 * against shared/hyg/contract.ts by services/hyg/visitSchema.test.js. The
 * original list lives in 1788200000000_hyg_visit.js and is left alone: a
 * migration is a historical record of what was true when it ran.
 */
const STAGED_WRITE_STATES = ['Draft', 'Staged', 'Sending', 'Written', 'Failed', 'Amending'];

/** Columns this migration adds to hyg_perio_send. */
const PERIO_SEND_AMEND_COLUMNS = ['chart', 'supersedes_exam_num', 'supersedes_deleted_at', 'amend_diff'];

const STATE_CHECK = 'hyg_staged_write_state_check';

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // ── one more state on the staged write ──────────────────────────────────
  pgm.dropConstraint('hyg_staged_write', STATE_CHECK);
  pgm.addConstraint('hyg_staged_write', STATE_CHECK, {
    check: `state IN (${STAGED_WRITE_STATES.map((s) => `'${s}'`).join(', ')})`,
  });

  // ── what a send wrote, and what it replaces ─────────────────────────────
  pgm.addColumns('hyg_perio_send', {
    /** The chart this send wrote, normalised. The baseline the next amendment diffs against. */
    chart: { type: 'jsonb' },
    /** The exam this send replaces. NULL on a first send. */
    supersedes_exam_num: { type: 'bigint' },
    /** Stamped only when the new exam verified AND the old was read back gone. */
    supersedes_deleted_at: { type: 'timestamptz' },
    /** The per-site changes this amendment makes, frozen at confirm. */
    amend_diff: { type: 'jsonb', notNull: true, default: '[]' },
  });

  // A delete cannot be recorded for an exam this send never replaced.
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_supersedes_check', {
    check: 'supersedes_deleted_at IS NULL OR supersedes_exam_num IS NOT NULL',
  });
  // And a send can never supersede the exam it just created.
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_supersedes_self_check', {
    check:
      'supersedes_exam_num IS NULL OR exam_num IS NULL OR supersedes_exam_num <> exam_num',
  });
  // A diff describes a replacement; there is nothing to diff on a first send.
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_amend_diff_check', {
    check: "amend_diff = '[]'::jsonb OR supersedes_exam_num IS NOT NULL",
  });

  /*
   * WHICH SEND IS THE LIVE ONE IS AN ORDERING, SO ITS CLOCK MUST TICK.
   *
   * `now()` is the TRANSACTION's timestamp: every row written in one
   * transaction carries the same value, and "the most recent send that
   * verified" — the exam a correction replaces — would then be a coin flip
   * between them. Two sends are seconds apart in the application, but a
   * rehearsal that wrote both in one transaction found the ordering ambiguous,
   * and an ordering that CAN tie is one somebody will eventually lose.
   * `clock_timestamp()` advances inside a transaction.
   */
  pgm.sql('ALTER TABLE hyg_perio_send ALTER COLUMN created_at SET DEFAULT clock_timestamp()');
  pgm.sql('ALTER TABLE hyg_perio_send ALTER COLUMN updated_at SET DEFAULT clock_timestamp()');
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.sql('ALTER TABLE hyg_perio_send ALTER COLUMN created_at SET DEFAULT now()');
  pgm.sql('ALTER TABLE hyg_perio_send ALTER COLUMN updated_at SET DEFAULT now()');
  pgm.dropConstraint('hyg_perio_send', 'hyg_perio_send_amend_diff_check');
  pgm.dropConstraint('hyg_perio_send', 'hyg_perio_send_supersedes_self_check');
  pgm.dropConstraint('hyg_perio_send', 'hyg_perio_send_supersedes_check');
  pgm.dropColumns('hyg_perio_send', PERIO_SEND_AMEND_COLUMNS);

  // Back to the lifecycle without `Amending`. Any row sitting in it becomes a
  // Draft: its readings are the correction, and nothing in Open Dental changed.
  pgm.sql("UPDATE hyg_staged_write SET state = 'Draft' WHERE state = 'Amending'");
  pgm.dropConstraint('hyg_staged_write', STATE_CHECK);
  pgm.addConstraint('hyg_staged_write', STATE_CHECK, {
    check: "state IN ('Draft', 'Staged', 'Sending', 'Written', 'Failed')",
  });
};

exports.STAGED_WRITE_STATES = STAGED_WRITE_STATES;
exports.PERIO_SEND_AMEND_COLUMNS = PERIO_SEND_AMEND_COLUMNS;
