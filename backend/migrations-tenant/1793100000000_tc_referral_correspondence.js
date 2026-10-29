'use strict';

/**
 * Referrals R6.9: the correspondence log — staff recording a call, an email or
 * a fax with the specialist's office or the patient, that happened OUTSIDE the
 * app. A history row that never moves the status and sends nothing.
 *
 * tc_referral_events
 *   verb CHECK                     R5b's list followed by `correspondence`.
 *                                  Equal to TC_REFERRAL_R69_EVENT_VERBS (the
 *                                  frozen R6.9 list) in shared/tc/referrals.ts;
 *                                  this migration's test pins it.
 *   correspondence_direction text  to | from              ┐ NULL on every other
 *   correspondence_party     text  specialist | patient   │ row; all three set on
 *   correspondence_channel   text  phone | email | fax | other ┘ a correspondence row
 *   correspondence_fields CHECK    (verb = 'correspondence') = (all three set):
 *                                  a correspondence row says which way, with
 *                                  whom and how; no other row may.
 *   correspondence_status CHECK    a correspondence row has from = to — it can
 *                                  never record a move.
 *   correspondence_note CHECK      its note is 1–2000 characters, equal to
 *                                  TC_REFERRAL_CORRESPONDENCE_NOTE_MAX.
 *
 * THE STATUS CHECK IS UNTOUCHED: no new referral status, no new move.
 * Attachments are R4's table, unchanged: a file logged with a contact goes
 * through the existing upload route, under its existing cap.
 *
 * Nullable columns, no backfill. No grant change: the app role's table grants
 * cover new columns. CHECK literals inline (house rule).
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const EVENTS = 'tc_referral_events';

/** R5b's verb CHECK (1792500000000), restored by down(). */
const R5B_VERB_CHECK =
  "verb IS NULL OR verb IN ('create', 'edit', 'doctor_edit', 'submit', 'withdraw', 'cancel', 'approve', 'decline', 'reopen', 'return', 'mark_sent', 'mark_acknowledged', 'mark_patient_seen', 'close', 'send', 'send_failed', 'send_conflict', 'patient_scheduled', 'patient_email_sent', 'patient_email_skipped', 'patient_email_failed')";

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // ── the event vocabulary ─────────────────────────────────────────────────
  pgm.dropConstraint(EVENTS, 'tc_referral_events_verb_check', { ifExists: true });
  pgm.addConstraint(EVENTS, 'tc_referral_events_verb_check', {
    check:
      "verb IS NULL OR verb IN ('create', 'edit', 'doctor_edit', 'submit', 'withdraw', 'cancel', 'approve', 'decline', 'reopen', 'return', 'mark_sent', 'mark_acknowledged', 'mark_patient_seen', 'close', 'send', 'send_failed', 'send_conflict', 'patient_scheduled', 'patient_email_sent', 'patient_email_skipped', 'patient_email_failed', 'correspondence')",
  });

  // ── which way, with whom, how ────────────────────────────────────────────
  pgm.addColumns(EVENTS, {
    correspondence_direction: { type: 'text' },
    correspondence_party: { type: 'text' },
    correspondence_channel: { type: 'text' },
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_correspondence_direction_check', {
    check: "correspondence_direction IS NULL OR correspondence_direction IN ('to', 'from')",
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_correspondence_party_check', {
    check: "correspondence_party IS NULL OR correspondence_party IN ('specialist', 'patient')",
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_correspondence_channel_check', {
    check: "correspondence_channel IS NULL OR correspondence_channel IN ('phone', 'email', 'fax', 'other')",
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_correspondence_fields_check', {
    check:
      "(verb IS NOT DISTINCT FROM 'correspondence') = (correspondence_direction IS NOT NULL AND correspondence_party IS NOT NULL AND correspondence_channel IS NOT NULL)",
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_correspondence_status_check', {
    check: "verb IS DISTINCT FROM 'correspondence' OR from_status = to_status",
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_correspondence_note_check', {
    check: "verb IS DISTINCT FROM 'correspondence' OR char_length(btrim(note)) BETWEEN 1 AND 2000",
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  // A correspondence row cannot satisfy R5b's verb CHECK, so it is relabelled
  // first rather than deleted: the history line and its note stay, as an
  // unlabelled row with from = to (as 1792500000000's down did for its verbs).
  // The three facts are cleared in the same statement, or the relabelled row
  // would break the fields CHECK, which is still in force at this point.
  pgm.sql(
    `UPDATE ${EVENTS} SET verb = NULL, correspondence_direction = NULL, correspondence_party = NULL, correspondence_channel = NULL WHERE verb = 'correspondence'`
  );
  for (const name of ['note', 'status', 'fields', 'channel', 'party', 'direction']) {
    pgm.dropConstraint(EVENTS, `tc_referral_events_correspondence_${name}_check`, { ifExists: true });
  }
  pgm.dropColumns(EVENTS, ['correspondence_direction', 'correspondence_party', 'correspondence_channel'], { ifExists: true });
  pgm.dropConstraint(EVENTS, 'tc_referral_events_verb_check', { ifExists: true });
  pgm.addConstraint(EVENTS, 'tc_referral_events_verb_check', { check: R5B_VERB_CHECK });
};
