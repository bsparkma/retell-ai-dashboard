'use strict';

/**
 * Referral sign-off MODE, per office (referral-verbal-signoff).
 *
 * tc_referral_settings
 *   signoff_mode  text NOT NULL DEFAULT 'doctor'
 *                 doctor | verbal | off
 *                   doctor  a tc.referral_signoff holder signs it in the app
 *                           (exactly the old signoff_required = true)
 *                   verbal  the same, OR a tc.full user records a named
 *                           doctor's verbal OK from the hub
 *                   off     submit approves it (the old signoff_required = false)
 *                 Equal to TC_REFERRAL_SIGNOFF_MODES in shared/tc/referrals.ts;
 *                 this migration's test pins it.
 *   BACKFILL      true -> 'doctor', false -> 'off': every office keeps exactly
 *                 the behaviour it has today. The default (a NEW office) is
 *                 'doctor', the strictest.
 *   signoff_mode_coherent CHECK  signoff_required = (signoff_mode <> 'off').
 *                 signoff_required stays, kept in step by the one writer
 *                 (referralStore.upsertSettings), so the two columns can never
 *                 disagree about whether a doctor is needed.
 *
 * tc_referral_events
 *   verbal_provider_id    uuid  ┐ the doctor whose verbal OK a tc.full user
 *   verbal_provider_name  text  ┘ recorded — the provider directory's id and the
 *                                 name as it read at that moment. NULL on every
 *                                 other row. `actor` is still the person who
 *                                 clicked (the recorder).
 *   verbal_fields CHECK   both set or neither.
 *   verbal_verb CHECK     set only on approve / decline / return — the only
 *                         moves a verbal OK can stand behind.
 *   verbal_name CHECK     the name is 1–200 characters.
 *
 * THE VERB AND STATUS CHECKS ARE UNTOUCHED: a verbal approval is an `approve`
 * row with two more facts on it. No grant change: the app role's table grants
 * cover new columns. CHECK literals inline (house rule).
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const SETTINGS = 'tc_referral_settings';
const EVENTS = 'tc_referral_events';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // ── the mode ─────────────────────────────────────────────────────────────
  pgm.addColumns(SETTINGS, {
    signoff_mode: { type: 'text', notNull: true, default: 'doctor' },
  });
  pgm.sql(`UPDATE ${SETTINGS} SET signoff_mode = CASE WHEN signoff_required THEN 'doctor' ELSE 'off' END`);
  pgm.addConstraint(SETTINGS, 'tc_referral_settings_signoff_mode_check', {
    check: "signoff_mode IN ('doctor', 'verbal', 'off')",
  });
  pgm.addConstraint(SETTINGS, 'tc_referral_settings_signoff_mode_coherent_check', {
    check: "signoff_required = (signoff_mode <> 'off')",
  });

  // ── who gave the verbal OK ───────────────────────────────────────────────
  pgm.addColumns(EVENTS, {
    verbal_provider_id: { type: 'uuid' },
    verbal_provider_name: { type: 'text' },
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_verbal_fields_check', {
    check:
      '(verbal_provider_id IS NULL AND verbal_provider_name IS NULL) OR (verbal_provider_id IS NOT NULL AND verbal_provider_name IS NOT NULL)',
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_verbal_verb_check', {
    check: "verbal_provider_id IS NULL OR verb IN ('approve', 'decline', 'return')",
  });
  pgm.addConstraint(EVENTS, 'tc_referral_events_verbal_name_check', {
    check: 'verbal_provider_name IS NULL OR char_length(btrim(verbal_provider_name)) BETWEEN 1 AND 200',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  // A verbal row stays as the approve / decline / return it is; only the
  // doctor's name and id go (the audit row still names the provider id).
  for (const name of ['name', 'verb', 'fields']) {
    pgm.dropConstraint(EVENTS, `tc_referral_events_verbal_${name}_check`, { ifExists: true });
  }
  pgm.dropColumns(EVENTS, ['verbal_provider_id', 'verbal_provider_name'], { ifExists: true });
  // 'verbal' needs a doctor, so it folds back to signoff_required = true, which
  // the coherence CHECK already guarantees; dropping the column loses nothing else.
  pgm.dropConstraint(SETTINGS, 'tc_referral_settings_signoff_mode_coherent_check', { ifExists: true });
  pgm.dropConstraint(SETTINGS, 'tc_referral_settings_signoff_mode_check', { ifExists: true });
  pgm.dropColumns(SETTINGS, ['signoff_mode'], { ifExists: true });
};
