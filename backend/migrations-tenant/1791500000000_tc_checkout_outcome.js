'use strict';

/**
 * The checkout handoff's front-desk lifecycle (queue item 50, Checkout C2).
 *
 * Item 49 created `tc_checkout_handoffs` as a snapshot with no state of its
 * own. This migration adds the state the Checkout page works:
 *
 *     open ──claim──▶ claimed ──outcome──▶ scheduled | not_scheduled | nothing_needed
 *       │                │
 *       └───dismiss──────┴──▶ dismissed        (a reason is required)
 *       └───day ends─────┴──▶ expired          (system, day-scoped; PM addition)
 *
 * WHY A STATUS HERE AND NOT A NEW CASE STATUS. The outcome is the front
 * desk's answer about ONE checkout, and two of the three answers lead to an
 * existing case status (`scheduled`; `pending_pt` for "not scheduled"). The
 * third ("nothing needed") must create NO case at all. Keeping the vocabulary
 * on the handoff means tc_cases' CHECK, the board and the funnel report — all of
 * which keep their own copy of the case statuses — are untouched.
 *
 * EXPIRY IS A RECORDED STATE, NOT A DELETE. The visit Send creates a handoff on
 * every hygiene Send in an enabled office, so the inbox must not accumulate:
 * a handoff whose office day has passed is closed as `expired` with a system
 * actor, and its audit row says what it was before.
 *
 * Every column below is additive; every existing row reads `open` (the
 * default), which is exactly what each one is. CHECK literals are inline.
 * The columns ride tc_checkout_handoffs' existing carein_app grant.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('tc_checkout_handoffs', {
    status: { type: 'text', notNull: true, default: 'open' },
    claimed_by: { type: 'text' },
    claimed_at: { type: 'timestamptz' },
    dismissed_reason: { type: 'text' }, // the TC's own words — never copied to audit_log
    dismissed_by: { type: 'text' },
    dismissed_at: { type: 'timestamptz' },
    outcome_by: { type: 'text' },
    outcome_at: { type: 'timestamptz' },
    // Optional front-desk note for "Scheduled" ("Tue 10/21 9am, Dr. chair") — PHI-capable.
    appointment_note: { type: 'text' },
    // The case an outcome created or moved. NULL for nothing_needed / dismissed / expired.
    case_id: { type: 'uuid', references: 'tc_cases', onDelete: 'SET NULL' },
    expired_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_status_check', {
    check:
      "status IN ('open', 'claimed', 'dismissed', 'scheduled', 'not_scheduled', 'nothing_needed', 'expired')",
  });
  // A claim names who holds it.
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_claimed_check', {
    check: "status <> 'claimed' OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)",
  });
  // A dismissal always says why; nothing else carries a reason.
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_dismissed_check', {
    check:
      "(status = 'dismissed') = (dismissed_reason IS NOT NULL AND length(btrim(dismissed_reason)) > 0)",
  });
  // An outcome names who chose it and when.
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_outcome_check', {
    check:
      "(status IN ('scheduled', 'not_scheduled', 'nothing_needed')) = " +
      '(outcome_by IS NOT NULL AND outcome_at IS NOT NULL)',
  });
  // Scheduled / not scheduled land on a case; nothing needed never does.
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_case_check', {
    check:
      "(status NOT IN ('scheduled', 'not_scheduled') OR case_id IS NOT NULL) AND " +
      "(status <> 'nothing_needed' OR case_id IS NULL)",
  });
  pgm.addConstraint('tc_checkout_handoffs', 'tc_checkout_handoffs_expired_check', {
    check: "(status = 'expired') = (expired_at IS NOT NULL)",
  });

  pgm.createIndex('tc_checkout_handoffs', ['office_id', 'status', 'visit_date'], {
    name: 'tc_checkout_handoffs_office_status_day_idx',
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropIndex('tc_checkout_handoffs', ['office_id', 'status', 'visit_date'], {
    name: 'tc_checkout_handoffs_office_status_day_idx',
    ifExists: true,
  });
  for (const name of [
    'tc_checkout_handoffs_expired_check',
    'tc_checkout_handoffs_case_check',
    'tc_checkout_handoffs_outcome_check',
    'tc_checkout_handoffs_dismissed_check',
    'tc_checkout_handoffs_claimed_check',
    'tc_checkout_handoffs_status_check',
  ]) {
    pgm.dropConstraint('tc_checkout_handoffs', name, { ifExists: true });
  }
  pgm.dropColumns(
    'tc_checkout_handoffs',
    [
      'status',
      'claimed_by',
      'claimed_at',
      'dismissed_reason',
      'dismissed_by',
      'dismissed_at',
      'outcome_by',
      'outcome_at',
      'appointment_note',
      'case_id',
      'expired_at',
    ],
    { ifExists: true }
  );
};
