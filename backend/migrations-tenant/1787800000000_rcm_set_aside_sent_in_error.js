'use strict';

/**
 * ONE MORE REASON A CHECK IS NEVER COMING BACK: the carrier sent it in error.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SIXTH REASON, AND WHY IT IS ADDITIVE ONLY
 * ─────────────────────────────────────────────────────────────────────────────
 * Stage A shipped five: `target_gone`, `duplicate`, `posted_by_hand`,
 * `not_ours`, `other`. Stage C's design review found a case none of them says,
 * and it is the one a biller meets: the carrier sent a remittance that should
 * never have been sent at all — the wrong practice's file, a run they reversed
 * the next day, a test transmission. It is not a duplicate (there is no other
 * copy being worked), it is not `not_ours` (it IS addressed to this practice),
 * and filing it under `other` costs a typed sentence every time for a thing that
 * happens on a schedule.
 *
 * The other five are UNCHANGED and none is retired. `target_gone` in particular
 * stays exactly as it is: it is the case the whole feature was built for — a
 * check whose claims no longer exist in Open Dental, of which staging has had
 * two sitting in the attention queue permanently (RCM_POSTING §15.2 finding 5).
 * Its LABEL is reworded on the screen; the slug it stores is untouched, because
 * a stored slug is a machine name and Stage C changes none of those.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE VOCABULARY MOVES TO THIS FILE
 * ─────────────────────────────────────────────────────────────────────────────
 * `1787500000000` exports the list it wrote, and it must go on exporting exactly
 * that: a database migrated to that point holds a five-value CHECK, and a
 * constant claiming six would be a claim about a schema that does not exist yet.
 * So the FIVE stay frozen there as the record of what that migration did, and
 * the CURRENT vocabulary lives here — which is what the route and the client
 * copy now read, and what `new-dashboard/tests/rcm-labels.test.ts` holds the
 * copy against.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDITIVE, AND THE ROLLBACK SAYS SO OUT LOUD
 * ─────────────────────────────────────────────────────────────────────────────
 * `up` widens one CHECK constraint. No column, no index, no data movement, and
 * every existing row satisfies the new constraint by construction because it
 * satisfied the narrower one.
 *
 * `down` REFUSES while a row uses the new word — the same property the
 * `withdrawn` rollback has (`1787300000000`) and for the same reason. Narrowing
 * the vocabulary under a row that uses it would fail on the re-keyed CHECK with
 * a bare 23514, or — if the ordering were ever got wrong — succeed and leave a
 * row no constraint recognises. A migration that can corrupt the thing it is
 * undoing is not reversible; it is untested.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** The least-privilege application role — same constant as every RCM migration. */
const APP_ROLE = process.env.AUDIT_APP_ROLE || 'carein_app';

/** What `1787500000000` wrote. Read for the rollback, never widened. */
const { SET_ASIDE_REASONS: ORIGINAL_REASONS } = require('./1787500000000_rcm_remittance_worklist_state');

/**
 * The reason this migration adds.
 *
 *   sent_in_error   the carrier should never have sent this remittance at all —
 *                   the wrong practice's file, a run they reversed, a test
 *                   transmission. Nothing on it will ever be posted, and there
 *                   is no other copy of it being worked.
 */
const SENT_IN_ERROR = 'sent_in_error';

/**
 * THE CURRENT VOCABULARY. The route and the client copy both read this.
 *
 * Order matters only to the screen, which renders them in this order; the
 * constraint is a set. `other` stays LAST because it is the escape hatch and a
 * list that offered it third would invite it third.
 */
const SET_ASIDE_REASONS = [
  'target_gone',
  'duplicate',
  'posted_by_hand',
  'not_ours',
  // Written as a LITERAL rather than as `SENT_IN_ERROR`, because
  // `new-dashboard/tests/rcm-labels.test.ts` reads this array out of the source
  // to hold the client copy against it — an interpolated constant would read as
  // a five-value list and the sixth would go unlabelled without a red test.
  'sent_in_error',
  'other',
];

/** `'a','b','c'` for a CHECK ... IN (...) list. */
const quoted = (values) => values.map((v) => `'${v}'`).join(',');

/** The constraint's name, unchanged — this migration re-keys it, never renames it. */
const CONSTRAINT = 'rcm_payment_batches_set_aside_reason_check';

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  /*
   * DROP THEN ADD, rather than `ALTER ... ADD CONSTRAINT` under a new name.
   *
   * Two constraints over the same column with two vocabularies would both have
   * to pass, so the narrower one would go on refusing and the widening would do
   * nothing at all — silently. One constraint, re-stated.
   */
  pgm.dropConstraint('rcm_payment_batches', CONSTRAINT);
  pgm.addConstraint('rcm_payment_batches', CONSTRAINT, {
    check: `set_aside_reason IS NULL OR set_aside_reason IN (${quoted(SET_ASIDE_REASONS)})`,
  });

  // Re-assert the grant, as every migration in this module does.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON rcm_payment_batches TO ${APP_ROLE};`);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM rcm_payment_batches WHERE set_aside_reason = '${SENT_IN_ERROR}'
      ) THEN
        RAISE EXCEPTION 'refusing to roll back: checks are set aside as %. '
          'Decide what they are first — there is no earlier reason for them.', '${SENT_IN_ERROR}';
      END IF;
    END $$;
  `);

  pgm.dropConstraint('rcm_payment_batches', CONSTRAINT);
  pgm.addConstraint('rcm_payment_batches', CONSTRAINT, {
    check: `set_aside_reason IS NULL OR set_aside_reason IN (${quoted(ORIGINAL_REASONS)})`,
  });
};

module.exports.SET_ASIDE_REASONS = SET_ASIDE_REASONS;
module.exports.SENT_IN_ERROR = SENT_IN_ERROR;
