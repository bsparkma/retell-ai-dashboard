'use strict';

/**
 * Per-tenant data-plane: checkout cards made from TODAY'S SCHEDULE (CO-5b).
 *
 * When `tc_auto_checkout_enabled` is on for an office, a bounded read of the
 * office's appointments today makes a Waiting checkout card for each
 * non-hygiene appointment Open Dental marks Complete (services/tc/autoCheckout.js).
 * This migration lets tc_checkout_handoffs hold such a card, and remember the
 * appointment that made it. All additive:
 *
 *   source             the CO-5a CHECK widened from 'hygiene' | 'manual' to
 *                      'hygiene' | 'manual' | 'schedule'. NULL still reads as
 *                      'hygiene'.
 *   origin_apt_num     bigint, NULLABLE. The Open Dental AptNum the card was
 *                      made from. Set on a 'schedule' card and on nothing else
 *                      (CHECK). It stays when a later hygiene handoff merges
 *                      onto the card and takes its source_key, so the card's
 *                      history — and the dedupe below — never lose it.
 *   origin_appt        jsonb object, NULLABLE. What Open Dental said about that
 *                      appointment when the card was made: { aptNum, dateTime,
 *                      appointmentType, provider, operatory, aptStatus }. Labels
 *                      only — never a note.
 *
 *   tc_checkout_handoffs_origin_apt_key
 *                      UNIQUE (office_id, origin_apt_num) WHERE origin_apt_num
 *                      IS NOT NULL — EVERY status, dismissed included. One
 *                      appointment makes at most one card, ever: a card the
 *                      desk dismissed is not re-made 60 seconds later by the
 *                      next sweep. It is also the arbiter for two sweeps racing
 *                      on the same appointment.
 *
 * The columns ride tc_checkout_handoffs' existing carein_app grant.
 *
 * NO platform_setting row is seeded. The per-office switch
 * ('tc_auto_checkout_enabled', config/tcAutoCheckout.js) follows
 * tc_checkout_enabled exactly: NO ROW means every office OFF. Roland's pilot
 * is a Platform console toggle, written and audited there.
 *
 * CHECKS, each led by IS NULL / a two-valued condition, per RCM_POSTING §15.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const TABLE = 'tc_checkout_handoffs';
const SOURCE_CHECK = 'tc_checkout_handoffs_source_check';
const ORIGIN_CHECK = 'tc_checkout_handoffs_origin_check';
const ORIGIN_INDEX = 'tc_checkout_handoffs_origin_apt_key';
exports.ORIGIN_INDEX = ORIGIN_INDEX;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.dropConstraint(TABLE, SOURCE_CHECK, { ifExists: true });
  pgm.addConstraint(TABLE, SOURCE_CHECK, {
    check: "source IS NULL OR source IN ('hygiene', 'manual', 'schedule')",
  });
  pgm.addColumns(TABLE, {
    origin_apt_num: { type: 'bigint' },
    origin_appt: { type: 'jsonb' },
  });
  // A schedule card carries its appointment; nothing else carries one.
  pgm.addConstraint(TABLE, ORIGIN_CHECK, {
    check:
      "(source IS DISTINCT FROM 'schedule' AND origin_apt_num IS NULL AND origin_appt IS NULL) OR " +
      "(source = 'schedule' AND origin_apt_num IS NOT NULL AND origin_apt_num > 0 AND " +
      "origin_appt IS NOT NULL AND jsonb_typeof(origin_appt) = 'object')",
  });
  pgm.createIndex(TABLE, ['office_id', 'origin_apt_num'], {
    name: ORIGIN_INDEX,
    unique: true,
    where: 'origin_apt_num IS NOT NULL',
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropIndex(TABLE, ['office_id', 'origin_apt_num'], { name: ORIGIN_INDEX, ifExists: true });
  pgm.dropConstraint(TABLE, ORIGIN_CHECK, { ifExists: true });
  pgm.dropColumns(TABLE, ['origin_apt_num', 'origin_appt'], { ifExists: true });
  pgm.dropConstraint(TABLE, SOURCE_CHECK, { ifExists: true });
  // NOT VALID: schedule cards made while this was up keep their rows (nothing
  // is deleted on the way down); only NEW rows are held to the narrower list.
  pgm.sql(
    `ALTER TABLE ${TABLE} ADD CONSTRAINT ${SOURCE_CHECK} CHECK (source IS NULL OR source IN ('hygiene', 'manual')) NOT VALID`
  );
};
