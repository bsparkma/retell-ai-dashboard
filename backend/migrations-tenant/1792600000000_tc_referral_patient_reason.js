'use strict';

/**
 * The reason in plain words (referral letter enrichment, part B).
 *
 * tc_referrals
 *   patient_reason  text NULL   what the PATIENT's email says the visit is
 *                               for ("an evaluation of a sore tooth"), written
 *                               by staff or the doctor. NULL = none written,
 *                               and the email keeps its generic phrase ("a
 *                               specialist consultation"). Used ONLY in the
 *                               patient's email — never the specialist's letter,
 *                               never the clinical `reason`.
 *   CHECK           NULL or at most 200 characters, equal to
 *                   TC_REFERRAL_PATIENT_REASON_MAX in shared/tc/referrals.ts
 *                   (this migration's test pins it).
 *
 * Nullable, no backfill: every existing referral reads as "none written".
 * No grant change: the app role's table grants cover a new column. CHECK
 * literal inline (house rule).
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const CHECK = 'tc_referrals_patient_reason_check';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumns('tc_referrals', {
    patient_reason: { type: 'text' },
  });
  pgm.addConstraint('tc_referrals', CHECK, {
    check: 'patient_reason IS NULL OR char_length(patient_reason) <= 200',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropConstraint('tc_referrals', CHECK, { ifExists: true });
  pgm.dropColumns('tc_referrals', ['patient_reason'], { ifExists: true });
};
