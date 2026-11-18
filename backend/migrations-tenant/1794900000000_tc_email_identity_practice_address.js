'use strict';

/**
 * Setup polish: the practice ADDRESS joins the email identity's change history.
 *
 * The address itself is saved with the rest of the office's identity in the
 * control plane's platform_setting['tc_email_identity'] (config/emailIdentity.js),
 * a field inside that object, so it rides MT-2a's existing dual-write into
 * office_setting unchanged: no new setting key, no control-plane migration.
 * What changes is the vocabulary of the history table 1792200000000 created
 * and 1792400000000 widened:
 *
 *   tc_email_identity_changes.field CHECK
 *     reply_to | practice_name | practice_phone | practice_address | referral_bcc
 *
 * Dropped and re-added (a CHECK cannot be altered in place). The list equals
 * TcEmailIdentityStoredField in shared/tc/emailIdentity.ts, snake-cased; this
 * migration's test pins it. No column, no table, no grant.
 *
 * NUMBERING: develop's newest tenant migration is 1794700000000, and the open
 * PR #337 holds 1794800000000; this takes 1794900000000 so the two cannot
 * collide whichever merges first.
 *
 * down() refuses while any practice_address history row exists: the history is
 * append-only, and there is no earlier field to relabel such a row as.
 *
 * CHECK literals inline (house rule).
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropConstraint('tc_email_identity_changes', 'tc_email_identity_changes_field_check', { ifExists: true });
  pgm.addConstraint('tc_email_identity_changes', 'tc_email_identity_changes_field_check', {
    check: "field IN ('reply_to', 'practice_name', 'practice_phone', 'practice_address', 'referral_bcc')",
  });
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM tc_email_identity_changes WHERE field = 'practice_address') THEN
        RAISE EXCEPTION 'tc_email_identity_practice_address down: practice_address history rows exist; the history is append-only';
      END IF;
    END $$;
  `);
  pgm.dropConstraint('tc_email_identity_changes', 'tc_email_identity_changes_field_check', { ifExists: true });
  pgm.addConstraint('tc_email_identity_changes', 'tc_email_identity_changes_field_check', {
    check: "field IN ('reply_to', 'practice_name', 'practice_phone', 'referral_bcc')",
  });
};
