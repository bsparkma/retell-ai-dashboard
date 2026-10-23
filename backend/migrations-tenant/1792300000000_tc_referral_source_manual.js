'use strict';

/**
 * Referrals R6.2: a referral started BY HAND.
 *
 * tc_referrals
 *   source_kind CHECK   item 53's four (1791900000000) plus `manual`: started
 *                       from the Referrals hub for a patient looked up in the
 *                       office's own Open Dental, with no case, checkout,
 *                       visit or call behind it (source_ref is ''). Dropped
 *                       and re-added (a CHECK cannot be altered in place). The
 *                       list equals TcReferralSourceKind in
 *                       shared/tc/referrals.ts; this migration's test pins it.
 *
 * Nothing else changes: no column, no table, no index (the source index from
 * 1791900000000 is not unique, so many manual rows with source_ref '' are
 * fine), and no grant (the table's grants cover a constraint change).
 *
 * down() refuses while any `manual` referral exists rather than relabel one
 * as a kind it is not; there is no honest kind to move it to.
 *
 * CHECK literals inline (house rule).
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropConstraint('tc_referrals', 'tc_referrals_source_kind_check', { ifExists: true });
  pgm.addConstraint('tc_referrals', 'tc_referrals_source_kind_check', {
    check: "source_kind IN ('case', 'checkout', 'hyg_visit', 'call', 'manual')",
  });
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM tc_referrals WHERE source_kind = 'manual') THEN
        RAISE EXCEPTION 'tc_referral_source_manual down: manual referrals exist; there is no earlier kind to relabel them as';
      END IF;
    END $$;
  `);
  pgm.dropConstraint('tc_referrals', 'tc_referrals_source_kind_check', { ifExists: true });
  pgm.addConstraint('tc_referrals', 'tc_referrals_source_kind_check', {
    check: "source_kind IN ('case', 'checkout', 'hyg_visit', 'call')",
  });
};
