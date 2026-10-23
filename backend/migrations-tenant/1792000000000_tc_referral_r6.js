'use strict';

/**
 * Referrals R6 (queue item 56): the hub, field edits, the doctor's edits at
 * sign-off, "send back with a question", and the manual lifecycle marks.
 *
 * Two nullable columns; no new table, no new status:
 *
 *   tc_referrals.doctor_note   the doctor's own note, written at sign-off.
 *                              NULL = none. Capped at 4000 characters by a
 *                              CHECK (TC_REFERRAL_DOCTOR_NOTE_MAX in the
 *                              shared contract; a test pins them equal).
 *
 *   tc_referral_events.verb    WHAT an event row records. Before R6 every row
 *                              was a status move and from → to said enough.
 *                              R6 adds rows that move nothing (an edit:
 *                              from = to) and two verbs that share a move with
 *                              an older one (`return` and `withdraw` are both
 *                              pending_signoff → draft), so the row has to say
 *                              which. NULL on rows written before R6 — no
 *                              backfill, because a guess printed into a
 *                              referral's history as though it were known is
 *                              worse than an honest blank.
 *
 * THE STATUS CHECK IS UNTOUCHED. reopen / return / the four marks move between
 * the nine statuses 1791800000000 already carries; the shared transition table
 * (referralNextStatus) is still the only place a move is decided.
 *
 * CHECK literals inline (house rule). The verb list equals
 * TC_REFERRAL_EVENT_VERBS in shared/tc/referrals.ts; a migration test pins
 * them equal.
 *
 * Grants: the columns inherit their tables' grants from 1791800000000. The
 * grant is restated here anyway (role-guarded, idempotent) so this migration
 * is correct on its own if it is ever replayed against a database whose
 * grants drifted.
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[tc_referral_r6 migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/** The tables this migration alters — and re-grants. */
const TABLES = ['tc_referrals', 'tc_referral_events'];
exports.TABLES = TABLES;

exports.up = (pgm) => {
  pgm.addColumns('tc_referrals', {
    doctor_note: { type: 'text' },
  });
  pgm.addConstraint('tc_referrals', 'tc_referrals_doctor_note_check', {
    check: 'doctor_note IS NULL OR length(doctor_note) <= 4000',
  });

  pgm.addColumns('tc_referral_events', {
    verb: { type: 'text' },
  });
  pgm.addConstraint('tc_referral_events', 'tc_referral_events_verb_check', {
    check:
      "verb IS NULL OR verb IN ('create', 'edit', 'doctor_edit', 'submit', 'withdraw', 'cancel', 'approve', 'decline', 'reopen', 'return', 'mark_sent', 'mark_acknowledged', 'mark_patient_seen', 'close')",
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
        RAISE NOTICE 'tc_referral_r6: app role % absent; grants SKIPPED', r;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.dropConstraint('tc_referral_events', 'tc_referral_events_verb_check', { ifExists: true });
  pgm.dropColumns('tc_referral_events', ['verb'], { ifExists: true });
  pgm.dropConstraint('tc_referrals', 'tc_referrals_doctor_note_check', { ifExists: true });
  pgm.dropColumns('tc_referrals', ['doctor_note'], { ifExists: true });
};
