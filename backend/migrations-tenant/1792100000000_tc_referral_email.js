'use strict';

/**
 * Referrals R5: the referral email send.
 *
 * tc_referral_events
 *   verb CHECK                 R6's list followed by R5's three: send,
 *                              send_failed, send_conflict. Dropped and re-added
 *                              (a CHECK cannot be altered in place). The list
 *                              equals TC_REFERRAL_ALL_EVENT_VERBS in
 *                              shared/tc/referrals.ts; this migration's test
 *                              pins them equal.
 *   acs_message_id     text    the ACS operation id of the email this row
 *                              records. Only on send / send_conflict rows.
 *   recipient_address  text    the address it went to, lowercased, from the
 *                              directory row at the moment of sending (the
 *                              directory can change later; the history must
 *                              not). Only on send / send_conflict rows.
 *   unsubscribe_token_hash text  SHA-256 (hex) of the one-time token in that
 *                              email's unsubscribe link, the same scheme as
 *                              tc_messages (1790800000000). The link resolves
 *                              through it; the token itself is never stored.
 *                              UNIQUE where present.
 *   send-row CHECKs            a send / send_conflict row carries all three;
 *                              any other row carries none of them. A row
 *                              claiming an email went out without saying which
 *                              email and to whom is refused by the database.
 *
 * tc_referrals
 *   send_attempt_id    uuid    the in-flight email for this referral, if any.
 *   send_attempt_at    timestamptz  when it was claimed.
 *                              A send CLAIMS the row (conditional UPDATE while
 *                              both are NULL) before anything leaves, so two
 *                              clicks — or a click racing an auto-send — cannot
 *                              both email it. Released on every outcome; a
 *                              claim a crash left behind is treated as stale
 *                              after a few minutes (routes/tc/referralSend.js).
 *                              The pair is NULL together or set together.
 *
 * THE STATUS CHECK IS UNTOUCHED: `send` moves approved → sent, two of the nine
 * statuses 1791800000000 already carries.
 *
 * CHECK literals inline (house rule). Grants in-migration, role-guarded and
 * idempotent, for both tables (the new columns inherit them; restated so this
 * migration is correct on its own against a database whose grants drifted).
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_referral_email migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** The tables this migration alters — and re-grants. */
const TABLES = ['tc_referrals', 'tc_referral_events'];
exports.TABLES = TABLES;

/** R6's CHECK, restored by down(). */
const R6_VERB_CHECK =
  "verb IS NULL OR verb IN ('create', 'edit', 'doctor_edit', 'submit', 'withdraw', 'cancel', 'approve', 'decline', 'reopen', 'return', 'mark_sent', 'mark_acknowledged', 'mark_patient_seen', 'close')";

exports.up = (pgm) => {
  pgm.dropConstraint('tc_referral_events', 'tc_referral_events_verb_check', { ifExists: true });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_verb_check', {
    check:
      "verb IS NULL OR verb IN ('create', 'edit', 'doctor_edit', 'submit', 'withdraw', 'cancel', 'approve', 'decline', 'reopen', 'return', 'mark_sent', 'mark_acknowledged', 'mark_patient_seen', 'close', 'send', 'send_failed', 'send_conflict')",
  });

  pgm.addColumns('tc_referral_events', {
    acs_message_id: { type: 'text' },
    recipient_address: { type: 'text' },
    unsubscribe_token_hash: { type: 'text' },
  });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_send_fields_check', {
    check:
      "(verb IN ('send', 'send_conflict')) = (acs_message_id IS NOT NULL AND recipient_address IS NOT NULL AND unsubscribe_token_hash IS NOT NULL)",
  });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_send_lengths_check', {
    check: '(acs_message_id IS NULL OR length(acs_message_id) <= 200) AND (recipient_address IS NULL OR length(recipient_address) <= 254)',
  });
  pgm.createIndex('tc_referral_events', ['unsubscribe_token_hash'], {
    name: 'tc_referral_events_unsubscribe_token_unique',
    unique: true,
    where: 'unsubscribe_token_hash IS NOT NULL',
  });

  pgm.addColumns('tc_referrals', {
    send_attempt_id: { type: 'uuid' },
    send_attempt_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('tc_referrals', 'tc_referrals_send_attempt_check', {
    check: '(send_attempt_id IS NULL) = (send_attempt_at IS NULL)',
  });

  const tableList = TABLES.map((t) => `'${t}'`).join(', ');
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
            t text;
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        FOREACH t IN ARRAY ARRAY[${tableList}] LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', t, r);
        END LOOP;
      ELSE
        RAISE NOTICE 'tc_referral_email: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.dropConstraint('tc_referrals', 'tc_referrals_send_attempt_check', { ifExists: true });
  pgm.dropColumns('tc_referrals', ['send_attempt_id', 'send_attempt_at'], { ifExists: true });

  pgm.dropIndex('tc_referral_events', ['unsubscribe_token_hash'], {
    name: 'tc_referral_events_unsubscribe_token_unique',
    ifExists: true,
  });
  pgm.dropConstraint('tc_referral_events', 'tc_referral_events_send_lengths_check', { ifExists: true });
  pgm.dropConstraint('tc_referral_events', 'tc_referral_events_send_fields_check', { ifExists: true });
  pgm.dropColumns('tc_referral_events', ['acs_message_id', 'recipient_address', 'unsubscribe_token_hash'], {
    ifExists: true,
  });

  // Back to R6's verbs. A send row cannot satisfy that CHECK, so they are
  // relabelled first rather than deleted: the history line stays, as an
  // unlabelled move (NULL verb is what every pre-R6 row carries).
  pgm.sql("UPDATE tc_referral_events SET verb = NULL WHERE verb IN ('send', 'send_failed', 'send_conflict')");
  pgm.dropConstraint('tc_referral_events', 'tc_referral_events_verb_check', { ifExists: true });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_verb_check', { check: R6_VERB_CHECK });
};
