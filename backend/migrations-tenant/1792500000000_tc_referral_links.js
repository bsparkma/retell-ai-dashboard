'use strict';

/**
 * Referrals R5b: closing the loop after a referral email goes out.
 *
 * tc_referral_link_tokens  (new)
 *   One row per link in a sent email: the specialist's "We received this
 *   referral" and "The patient is scheduled", the patient's "I've scheduled my
 *   appointment". Each is unique to its referral and its recipient.
 *
 *   token_hash   text PK    SHA-256 (hex) of the token in the link. The token
 *                           itself is NEVER stored: a copy of this table does
 *                           not yield a usable link.
 *   office_id    text       the office the referral belongs to; the public
 *                           route reads the office from HERE, never from a
 *                           request.
 *   referral_id  uuid       composite FK to tc_referrals(office_id, referral_id).
 *   audience     text       specialist | patient
 *   purpose      text       received | scheduled. A patient link can only be
 *                           `scheduled` (CHECK).
 *   created_at   timestamptz
 *   expires_at   timestamptz  created_at + 60 days (the route checks it; the
 *                           CHECK only refuses an expiry before creation).
 *   used_at      timestamptz  NULL until the one click that acts on it.
 *                           Single use: the route consumes it with a
 *                           conditional UPDATE (used_at IS NULL AND not yet
 *                           expired), so of two clicks exactly one acts.
 *   UNIQUE (office_id, referral_id, audience, purpose): one link of each kind
 *   per referral.
 *
 *   No address is stored here: the history row that records the email
 *   (`send`, `patient_email_sent`) already says where it went.
 *
 * tc_referrals
 *   scheduled_date  date   the appointment date the specialist's office or
 *                          the patient gave from a link; NULL = none given.
 *
 * tc_referral_events
 *   verb CHECK      R5's list followed by R5b's four (patient_scheduled,
 *                   patient_email_sent, patient_email_skipped,
 *                   patient_email_failed). Equal to TC_REFERRAL_ALL_EVENT_VERBS
 *                   in shared/tc/referrals.ts; this migration's test pins it.
 *   send-fields CHECK  `patient_email_sent` joins send / send_conflict as a
 *                   row that records an email that went out, and so must carry
 *                   which email (ACS id), to whom, and its unsubscribe link's
 *                   hash — the patient's unsubscribe link resolves through it.
 *
 * THE STATUS CHECK IS UNTOUCHED: no new referral status. "We received this
 * referral" is the existing mark_acknowledged move (sent → acknowledged).
 *
 * CHECK literals inline (house rule). Grants in-migration, role-guarded and
 * idempotent.
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_referral_links migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

const TOKENS = 'tc_referral_link_tokens';
exports.TOKENS = TOKENS;

/** The tables this migration creates or alters — and grants. */
const TABLES = [TOKENS, 'tc_referrals', 'tc_referral_events'];
exports.TABLES = TABLES;

/** R5's CHECKs, restored by down(). */
const R5_VERB_CHECK =
  "verb IS NULL OR verb IN ('create', 'edit', 'doctor_edit', 'submit', 'withdraw', 'cancel', 'approve', 'decline', 'reopen', 'return', 'mark_sent', 'mark_acknowledged', 'mark_patient_seen', 'close', 'send', 'send_failed', 'send_conflict')";
const R5_SEND_FIELDS_CHECK =
  "(verb IN ('send', 'send_conflict')) = (acs_message_id IS NOT NULL AND recipient_address IS NOT NULL AND unsubscribe_token_hash IS NOT NULL)";

exports.up = (pgm) => {
  // ── the event vocabulary ─────────────────────────────────────────────────
  pgm.dropConstraint('tc_referral_events', 'tc_referral_events_verb_check', { ifExists: true });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_verb_check', {
    check:
      "verb IS NULL OR verb IN ('create', 'edit', 'doctor_edit', 'submit', 'withdraw', 'cancel', 'approve', 'decline', 'reopen', 'return', 'mark_sent', 'mark_acknowledged', 'mark_patient_seen', 'close', 'send', 'send_failed', 'send_conflict', 'patient_scheduled', 'patient_email_sent', 'patient_email_skipped', 'patient_email_failed')",
  });
  pgm.dropConstraint('tc_referral_events', 'tc_referral_events_send_fields_check', { ifExists: true });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_send_fields_check', {
    check:
      "(verb IN ('send', 'send_conflict', 'patient_email_sent')) = (acs_message_id IS NOT NULL AND recipient_address IS NOT NULL AND unsubscribe_token_hash IS NOT NULL)",
  });

  // ── the appointment date ─────────────────────────────────────────────────
  pgm.addColumns('tc_referrals', {
    scheduled_date: { type: 'date' },
  });

  // ── the link tokens ──────────────────────────────────────────────────────
  pgm.createTable(TOKENS, {
    token_hash: { type: 'text', primaryKey: true },
    office_id: { type: 'text', notNull: true },
    referral_id: { type: 'uuid', notNull: true },
    audience: { type: 'text', notNull: true },
    purpose: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
  });
  pgm.addConstraint(TOKENS, 'tc_referral_link_tokens_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint(TOKENS, 'tc_referral_link_tokens_hash_check', {
    check: "token_hash ~ '^[0-9a-f]{64}$'",
  });
  pgm.addConstraint(TOKENS, 'tc_referral_link_tokens_audience_check', {
    check: "audience IN ('specialist', 'patient')",
  });
  pgm.addConstraint(TOKENS, 'tc_referral_link_tokens_purpose_check', {
    check: "purpose IN ('received', 'scheduled')",
  });
  pgm.addConstraint(TOKENS, 'tc_referral_link_tokens_patient_purpose_check', {
    check: "audience <> 'patient' OR purpose = 'scheduled'",
  });
  pgm.addConstraint(TOKENS, 'tc_referral_link_tokens_expiry_check', {
    check: 'expires_at > created_at',
  });
  pgm.addConstraint(TOKENS, 'tc_referral_link_tokens_referral_fk', {
    foreignKeys: {
      columns: ['office_id', 'referral_id'],
      references: 'tc_referrals(office_id, referral_id)',
      onDelete: 'CASCADE',
    },
  });
  pgm.addConstraint(TOKENS, 'tc_referral_link_tokens_one_per_kind', {
    unique: ['office_id', 'referral_id', 'audience', 'purpose'],
  });

  const tableList = TABLES.map((t) => `'${t}'`).join(', ');
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
            t text;
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', '${TOKENS}');
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        FOREACH t IN ARRAY ARRAY[${tableList}] LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', t, r);
        END LOOP;
      ELSE
        RAISE NOTICE 'tc_referral_links: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.dropTable(TOKENS, { ifExists: true });
  pgm.dropColumns('tc_referrals', ['scheduled_date'], { ifExists: true });

  // Back to R5's CHECKs. A patient_email_sent row cannot satisfy R5's
  // send-fields CHECK (it carries an ACS id but is not a send), and none of
  // the four verbs satisfies R5's verb CHECK, so those rows are relabelled
  // first rather than deleted: the history line stays, as an unlabelled
  // non-move, with the email's fields cleared.
  pgm.sql(
    "UPDATE tc_referral_events SET verb = NULL, acs_message_id = NULL, recipient_address = NULL, unsubscribe_token_hash = NULL WHERE verb IN ('patient_scheduled', 'patient_email_sent', 'patient_email_skipped', 'patient_email_failed')"
  );
  pgm.dropConstraint('tc_referral_events', 'tc_referral_events_send_fields_check', { ifExists: true });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_send_fields_check', { check: R5_SEND_FIELDS_CHECK });
  pgm.dropConstraint('tc_referral_events', 'tc_referral_events_verb_check', { ifExists: true });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_verb_check', { check: R5_VERB_CHECK });
};
