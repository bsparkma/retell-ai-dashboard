'use strict';

/**
 * Where a referral was started (queue item 53, R2).
 *
 * R1's tc_referrals records the patient and an optional linked case, but not
 * the SURFACE that produced it. R2 starts referrals from a TC case and from the
 * checkout sidebar, and the checkout sidebar's chip has to find "the referral
 * started from THIS checkout" — which the case link cannot answer (a checkout
 * answered "Nothing needed" has no case at all). R3 adds two more starting
 * points (the hygiene visit, a voice call), so the vocabulary carries all four
 * now rather than growing a migration per slice:
 *
 *   source_kind   case | checkout | hyg_visit | call
 *   source_ref    the id within that kind: a case id, a checkout handoff id,
 *                 a hygiene visit id, a call id. Text, because the four id
 *                 spaces are not one type (a call id is not a uuid).
 *
 * Both NOT NULL with a backfill-free default: R1 shipped no route that creates
 * a referral, so there are no rows to backfill; the defaults exist only so the
 * ADD COLUMN is safe on a table that might (on a dev box) hold a hand-made row.
 *
 * CHECK literal inline (house rule). No new table, so no new grant: the
 * columns inherit tc_referrals' grant from 1791800000000.
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('tc_referrals', {
    source_kind: { type: 'text', notNull: true, default: 'case' },
    source_ref: { type: 'text', notNull: true, default: '' },
  });
  pgm.addConstraint('tc_referrals', 'tc_referrals_source_kind_check', {
    check: "source_kind IN ('case', 'checkout', 'hyg_visit', 'call')",
  });
  pgm.addConstraint('tc_referrals', 'tc_referrals_source_ref_check', {
    check: 'length(source_ref) <= 200',
  });
  pgm.createIndex('tc_referrals', ['office_id', 'source_kind', 'source_ref'], {
    name: 'tc_referrals_office_source_idx',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('tc_referrals', ['office_id', 'source_kind', 'source_ref'], {
    name: 'tc_referrals_office_source_idx',
    ifExists: true,
  });
  pgm.dropConstraint('tc_referrals', 'tc_referrals_source_ref_check', { ifExists: true });
  pgm.dropConstraint('tc_referrals', 'tc_referrals_source_kind_check', { ifExists: true });
  pgm.dropColumns('tc_referrals', ['source_kind', 'source_ref'], { ifExists: true });
};
