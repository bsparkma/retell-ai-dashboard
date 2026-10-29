'use strict';

/**
 * Referrals R6.10: chart notes — a referral milestone written to the patient's
 * Open Dental chart as a commlog, by a person who saw the exact text. The
 * history row records that it happened; it never moves the status.
 *
 * tc_referral_events
 *   verb CHECK                       R6.9's list followed by
 *                                    `chart_note_written`. Equal to
 *                                    TC_REFERRAL_ALL_EVENT_VERBS in
 *                                    shared/tc/referrals.ts; this migration's
 *                                    test pins it.
 *   chart_note_milestone    text     sent | received | scheduled | seen |  ┐ NULL on every
 *                                    declined | closed                     │ other row; all
 *   chart_note_commlog_num  bigint   the CommlogNum Open Dental minted     │ three set on a
 *   chart_note_comm_type    integer  the commlog type DefNum written with  ┘ chart note row
 *   chart_note_fields CHECK          a chart note row has all three; every
 *                                    other row has none of them
 *   chart_note_status CHECK          a chart note row has from = to — it can
 *                                    never record a move.
 *   chart_note_note CHECK            its note (the exact text written) is
 *                                    1–2000 characters, equal to
 *                                    TC_REFERRAL_CHART_NOTE_MAX.
 *   chart_note_ids CHECK             the CommlogNum and the type are positive.
 *   tc_referral_events_chart_note_once   UNIQUE (office_id, referral_id,
 *                                    chart_note_milestone) WHERE verb =
 *                                    'chart_note_written': one chart note per
 *                                    milestone per referral, whatever the route
 *                                    gets wrong.
 *
 * THE STATUS CHECK IS UNTOUCHED: no new referral status, no new move.
 *
 * Nullable columns, no backfill. No grant change: the app role's table grants
 * cover new columns. CHECK literals inline (house rule).
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const EVENTS = 'tc_referral_events';
const ONCE_INDEX = 'tc_referral_events_chart_note_once';

/** R6.9's verb CHECK (1793100000000), restored by down(). */
const R69_VERB_CHECK =
  "verb IS NULL OR verb IN ('create', 'edit', 'doctor_edit', 'submit', 'withdraw', 'cancel', 'approve', 'decline', 'reopen', 'return', 'mark_sent', 'mark_acknowledged', 'mark_patient_seen', 'close', 'send', 'send_failed', 'send_conflict', 'patient_scheduled', 'patient_email_sent', 'patient_email_skipped', 'patient_email_failed', 'correspondence')";

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // ── the event vocabulary ─────────────────────────────────────────────────
  pgm.dropConstraint(EVENTS, 'tc_referral_events_verb_check', { ifExists: true });
  pgm.addConstraint(EVENTS, 'tc_referral_events_verb_check', {
    check:
      "verb IS NULL OR verb IN ('create', 'edit', 'doctor_edit', 'submit', 'withdraw', 'cancel', 'approve', 'decline', 'reopen', 'return', 'mark_sent', 'mark_acknowledged', 'mark_patient_seen', 'close', 'send', 'send_failed', 'send_conflict', 'patient_scheduled', 'patient_email_sent', 'patient_email_skipped', 'patient_email_failed', 'correspondence', 'chart_note_written')",
  });

  // ── which milestone, and what Open Dental minted ─────────────────────────
  pgm.addColumns(EVENTS, {
    chart_note_milestone: { type: 'text' },
    chart_note_commlog_num: { type: 'bigint' },
    chart_note_comm_type: { type: 'integer' },
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_chart_note_milestone_check', {
    check:
      "chart_note_milestone IS NULL OR chart_note_milestone IN ('sent', 'received', 'scheduled', 'seen', 'declined', 'closed')",
  });
  // All three on a chart note row, NONE on any other. (The `(verb = x) = (all
  // three set)` shape would let another row carry one or two of them.)
  pgm.addConstraint(EVENTS, 'tc_referral_events_chart_note_fields_check', {
    check:
      "(verb IS NOT DISTINCT FROM 'chart_note_written' AND chart_note_milestone IS NOT NULL AND chart_note_commlog_num IS NOT NULL AND chart_note_comm_type IS NOT NULL) OR (verb IS DISTINCT FROM 'chart_note_written' AND chart_note_milestone IS NULL AND chart_note_commlog_num IS NULL AND chart_note_comm_type IS NULL)",
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_chart_note_status_check', {
    check: "verb IS DISTINCT FROM 'chart_note_written' OR from_status = to_status",
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_chart_note_note_check', {
    check: "verb IS DISTINCT FROM 'chart_note_written' OR char_length(btrim(note)) BETWEEN 1 AND 2000",
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_chart_note_ids_check', {
    check:
      '(chart_note_commlog_num IS NULL OR chart_note_commlog_num > 0) AND (chart_note_comm_type IS NULL OR chart_note_comm_type > 0)',
  });
  pgm.createIndex(EVENTS, ['office_id', 'referral_id', 'chart_note_milestone'], {
    name: ONCE_INDEX,
    unique: true,
    where: "verb = 'chart_note_written'",
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  // A chart note row cannot satisfy R6.9's verb CHECK, so it is relabelled
  // first rather than deleted: the history line and its note (the text that
  // was written) stay, as an unlabelled row with from = to. The three facts are
  // cleared in the SAME statement, or the relabelled row would break the
  // fields CHECK, which is still in force at this point (1793100000000's
  // lesson). The commlog itself stays in Open Dental; the audit row still
  // names its CommlogNum.
  pgm.sql(
    `UPDATE ${EVENTS} SET verb = NULL, chart_note_milestone = NULL, chart_note_commlog_num = NULL, chart_note_comm_type = NULL WHERE verb = 'chart_note_written'`
  );
  pgm.dropIndex(EVENTS, ['office_id', 'referral_id', 'chart_note_milestone'], { name: ONCE_INDEX, ifExists: true });
  for (const name of ['ids', 'note', 'status', 'fields', 'milestone']) {
    pgm.dropConstraint(EVENTS, `tc_referral_events_chart_note_${name}_check`, { ifExists: true });
  }
  pgm.dropColumns(EVENTS, ['chart_note_milestone', 'chart_note_commlog_num', 'chart_note_comm_type'], { ifExists: true });
  pgm.dropConstraint(EVENTS, 'tc_referral_events_verb_check', { ifExists: true });
  pgm.addConstraint(EVENTS, 'tc_referral_events_verb_check', { check: R69_VERB_CHECK });
};
