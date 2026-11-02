'use strict';

/**
 * Per-tenant data-plane: the Open Dental appointment a "Scheduled" checkout is
 * anchored to (CO-4a). The prelude to the OD-driven pipeline sync (CO-4b),
 * which will track the AptNum stored here.
 *
 * FIVE NULLABLE COLUMNS on tc_checkout_handoffs, all additive:
 *
 *   appt_num         bigint — the Open Dental AptNum (Long, like every OD key).
 *   appt_at_local    text, 'YYYY-MM-DD HH:MM[:SS]' — the appointment's date and
 *                    time as Open Dental gave it: the office's own wall clock,
 *                    a snapshot taken when the link was made. Text, not a
 *                    timestamp: it is a reading of the office's calendar, and
 *                    a timezone conversion here would be a guess.
 *   appt_snapshot    jsonb object — the labels shown with it then: { provider,
 *                    appointmentType, operatory }. Display only; no notes, no
 *                    other patient.
 *   appt_linked_by   text — who linked it.
 *   appt_linked_at   timestamptz — when.
 *
 * THE OFFICE IS THE ROW'S office_id. An AptNum means nothing without its
 * practice (numbering restarts in every Open Dental database), and the anchor
 * is only ever written for the row's own office, from that office's own
 * client. A second office column could only ever disagree with the first.
 *
 * NULL on every record before this one, and on a Scheduled checkout the desk
 * marked "Not in Open Dental yet": both read as unanchored.
 *
 * CHECKS, each two-valued (led by IS NULL / IS NOT NULL, so no NULL slips past):
 *   - all five set, or none: an anchor always says what, when, by whom.
 *   - an anchor only on a Scheduled checkout.
 *   - the snapshot, when set, is an object.
 *
 * The columns ride tc_checkout_handoffs' existing carein_app grant.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const COLUMNS = ['appt_num', 'appt_at_local', 'appt_snapshot', 'appt_linked_by', 'appt_linked_at'];
exports.COLUMNS = COLUMNS;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('tc_checkout_handoffs', {
    appt_num: { type: 'bigint' },
    appt_at_local: { type: 'text' },
    appt_snapshot: { type: 'jsonb' },
    appt_linked_by: { type: 'text' },
    appt_linked_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_appt_all_or_none_check', {
    check:
      '(appt_num IS NULL AND appt_at_local IS NULL AND appt_snapshot IS NULL AND appt_linked_by IS NULL AND appt_linked_at IS NULL) OR ' +
      '(appt_num IS NOT NULL AND appt_num > 0 AND appt_at_local IS NOT NULL AND appt_snapshot IS NOT NULL AND appt_linked_by IS NOT NULL AND appt_linked_at IS NOT NULL)',
  });
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_appt_scheduled_check', {
    check: "appt_num IS NULL OR status = 'scheduled'",
  });
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_appt_at_shape_check', {
    check: "appt_at_local IS NULL OR appt_at_local ~ '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}(:\\d{2})?$'",
  });
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_appt_snapshot_object_check', {
    check: "appt_snapshot IS NULL OR jsonb_typeof(appt_snapshot) = 'object'",
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  for (const name of [
    'tc_checkout_handoffs_appt_snapshot_object_check',
    'tc_checkout_handoffs_appt_at_shape_check',
    'tc_checkout_handoffs_appt_scheduled_check',
    'tc_checkout_handoffs_appt_all_or_none_check',
  ]) {
    pgm.dropConstraint('tc_checkout_handoffs', name, { ifExists: true });
  }
  pgm.dropColumns('tc_checkout_handoffs', COLUMNS, { ifExists: true });
};
