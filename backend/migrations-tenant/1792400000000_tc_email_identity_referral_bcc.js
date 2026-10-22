'use strict';

/**
 * R6.3: the referral copy inbox joins the email identity's change history.
 *
 * The inbox itself is saved with the rest of the office's identity in the
 * control plane's platform_setting['tc_email_identity'] (config/emailIdentity.js),
 * so nothing new is stored here. What changes is the vocabulary of the
 * history table 1792200000000 created:
 *
 *   tc_email_identity_changes.field CHECK
 *     reply_to | practice_name | practice_phone | referral_bcc
 *
 * Dropped and re-added (a CHECK cannot be altered in place). The list equals
 * TcEmailIdentityStoredField in shared/tc/emailIdentity.ts, snake-cased; this
 * migration's test pins it. No column, no table, no grant (the append-only
 * grant from 1792200000000 covers a constraint change).
 *
 * NUMBERING: develop's newest tenant migration is 1792200000000, and an open
 * PR (#257) holds 1792300000000; this takes 1792400000000 so the two cannot
 * collide whichever merges first.
 *
 * down() refuses while any referral_bcc history row exists: the history is
 * append-only, and there is no earlier field to relabel such a row as.
 *
 * CHECK literals inline (house rule).
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropConstraint('tc_email_identity_changes', 'tc_email_identity_changes_field_check', { ifExists: true });
  pgm.addConstraint('tc_email_identity_changes', 'tc_email_identity_changes_field_check', {
    check: "field IN ('reply_to', 'practice_name', 'practice_phone', 'referral_bcc')",
  });
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM tc_email_identity_changes WHERE field = 'referral_bcc') THEN
        RAISE EXCEPTION 'tc_email_identity_referral_bcc down: referral_bcc history rows exist; the history is append-only';
      END IF;
    END $$;
  `);
  pgm.dropConstraint('tc_email_identity_changes', 'tc_email_identity_changes_field_check', { ifExists: true });
  pgm.addConstraint('tc_email_identity_changes', 'tc_email_identity_changes_field_check', {
    check: "field IN ('reply_to', 'practice_name', 'practice_phone')",
  });
};
