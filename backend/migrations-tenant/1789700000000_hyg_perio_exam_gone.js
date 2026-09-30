'use strict';

/**
 * Per-tenant data-plane: THE EXAM CAREIN WROTE IS NO LONGER IN OPEN DENTAL
 * (H4 item 14).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A `written` SEND NEEDS A WAY TO SAY THE EXAM IS GONE
 * ═════════════════════════════════════════════════════════════════════════════
 * `written` means every site was read back from Open Dental and matched — at the
 * moment it was read back. Open Dental's own perio chart has a Delete button on
 * that screen. When somebody presses it, CareIN goes on saying
 *
 *     "Perio exam 2260: 192 sites read back and match"
 *
 * about an exam that does not exist. Item 13 built the re-read that notices, but
 * only on the way into a correction, where it refuses `AMEND_BASE_MISSING` and
 * leaves the chart with nowhere to go. This slice adds the way forward: send it
 * again, as a new exam.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY TWO COLUMNS AND NOT A SEVENTH STATE
 * ═════════════════════════════════════════════════════════════════════════════
 * `deleted` already exists and means something different and specific: CareIN's
 * own undo removed the exam, and `deleted_by` is the person who pressed it.
 * Reusing it here would put the name of whoever opened the chart against a
 * deletion they did not perform. And `written` is not wrong — that send DID
 * write the exam and DID read every site back. What changed is a later fact
 * about Open Dental, not the history of the send.
 *
 * So the state machine is untouched and the fact is recorded beside it:
 *
 *   `exam_gone_at`  when a person, opening the chart, was shown that the exam is
 *                   missing and confirmed a resend. Never stamped by a read.
 *   `exam_gone_by`  who confirmed it.
 *
 * `getLiveSend` excludes a send whose exam is gone, and that one clause is what
 * makes the resend work: with no live send the next send is a FIRST send, so it
 * posts a new exam instead of trying to amend one that is not there. The chart
 * the send wrote stays on the row, so nothing about what was written is lost.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CHECKS ARE WRITTEN THE LONG WAY
 * ═════════════════════════════════════════════════════════════════════════════
 * Postgres ACCEPTS a CHECK that evaluates to NULL, so every nullable column is
 * tested with IS [NOT] NULL before anything else is asserted about it.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

/** Columns this migration adds to hyg_perio_send. */
const PERIO_SEND_GONE_COLUMNS = ['exam_gone_at', 'exam_gone_by'];

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('hyg_perio_send', {
    /** When a person was shown the exam is missing from Open Dental and confirmed a resend. */
    exam_gone_at: { type: 'timestamptz' },
    /** Who confirmed it. Never a background job — there is no background job. */
    exam_gone_by: { type: 'text' },
  });

  // Both, or neither. A time with no actor is an unattributed claim about a
  // chart of record, which is the class of thing this module does not make.
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_exam_gone_check', {
    check:
      '(exam_gone_at IS NULL AND exam_gone_by IS NULL) OR ' +
      '(exam_gone_at IS NOT NULL AND exam_gone_by IS NOT NULL)',
  });
  // Only an exam this send actually wrote can have gone missing. A send with no
  // exam number never put one in Open Dental for anybody to delete.
  pgm.addConstraint('hyg_perio_send', 'hyg_perio_send_exam_gone_exam_check', {
    check: "exam_gone_at IS NULL OR (exam_num IS NOT NULL AND state = 'written')",
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('hyg_perio_send', 'hyg_perio_send_exam_gone_exam_check');
  pgm.dropConstraint('hyg_perio_send', 'hyg_perio_send_exam_gone_check');
  // Dropping the columns makes those sends live again. That is the honest
  // pre-item-14 behaviour: their charts go back to claiming an exam that may not
  // be there, and a correction refuses AMEND_BASE_MISSING as it did before.
  pgm.dropColumns('hyg_perio_send', PERIO_SEND_GONE_COLUMNS);
};

exports.PERIO_SEND_GONE_COLUMNS = PERIO_SEND_GONE_COLUMNS;
