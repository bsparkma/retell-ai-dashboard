'use strict';

/**
 * `withdrawn` — a posting plan whose target is gone, and which must never run.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A STATUS AND NOT A `blocked_reason`
 * ─────────────────────────────────────────────────────────────────────────────
 * `blocked_reason` carries no CHECK, so a new reason needs no migration at all.
 * Adding one would have been free. It would also have been wrong.
 *
 * §2.2.1 defines `blocked` by a promise: **a blocked plan has a way out.** It is
 * in `DRAINABLE_STATUSES` precisely so a biller can fix the cause and press
 * Drain again, as many times as she likes. Every reason in that vocabulary is
 * something a human can act on — switch valley on, confirm the recoupment, fix
 * the arithmetic, add the DefNum.
 *
 * A plan whose Open Dental claim has been DELETED has no way out. Open Dental
 * does not reissue ClaimNums, so the target is not coming back, and nothing a
 * biller does will make that plan postable. Filing it under `blocked` would let
 * her press Drain forever — one paced Open Dental read per press — against a
 * claim that will never exist again, and would make §2.2.1's promise false for
 * one member of its own vocabulary.
 *
 * So: a terminal status, outside `DRAINABLE_STATUSES`, which cannot be pressed
 * at all. The refusal is structural rather than repeated.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * **Not a delete.** The plan, its lines, its approval and its audit trail all
 * stay exactly where they are. Withdrawing records a decision ON a plan; it does
 * not remove the record that the plan existed and was approved. A remittance is
 * unique on `(office_id, remittance_key)` — deleting the row would silently make
 * a second plan enqueueable for the same money, which is the one thing that
 * index exists to prevent (§15.1).
 *
 * **Not reachable from `posted` or `partially_posted`.** Money that moved
 * happened. A withdrawal that could hide a posted plan would be a way to make
 * the queue disagree with the chart, and every rule in this module points the
 * other way. It is not reachable from `posting` either: a run owns that row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COLUMNS, AND WHY FOUR
 * ─────────────────────────────────────────────────────────────────────────────
 * `withdrawn_reason` is a SLUG the UI renders copy from — `target_removed` when
 * the drain found a 404, `manual` when a human pressed the button. Machine-
 * readable, never prose, never PHI: the same contract `blocked_reason` has.
 *
 * `withdrawn_note` is the human's sentence, and it is separate on purpose. A
 * biller withdrawing a plan knows something the machine does not, and folding
 * her words into the slug would make the slug unusable for anything else.
 *
 * `withdrawn_by` is a crosswalk key with the same `RESTRICT` FK every other
 * actor column here carries (D-5). Open Dental cannot attribute an API write to
 * a human at all; this is the whole record that a person decided this.
 *
 * `withdrawn_at` is the instant. Kept distinct from `finished_at`, which means
 * "a run ended" — no run ended here, which is the point.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** The least-privilege application role — same constant as every RCM migration. */
const APP_ROLE = process.env.AUDIT_APP_ROLE || 'carein_app';

/**
 * The row vocabulary AFTER this migration. 6c's six, plus `withdrawn`.
 */
const QUEUE_STATUSES = [
  'approved',
  'posting',
  'posted',
  'failed',
  'partially_posted',
  'blocked',
  'withdrawn',
];

/**
 * Why a plan was withdrawn. A CHECK here and NOT on `blocked_reason`, and the
 * asymmetry is deliberate: blocked reasons are a growing list the drain adds to
 * every slice, while withdrawal has exactly two causes and a third would be a
 * design decision worth stopping for.
 */
const WITHDRAW_REASONS = ['target_removed', 'manual'];

/** `'a','b','c'` for a CHECK ... IN (...) list. */
const quoted = (values) => values.map((v) => `'${v}'`).join(',');

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('rcm_posting_queue', {
    withdrawn_at: { type: 'timestamptz' },
    withdrawn_by: { type: 'text', references: 'rcm_user_map', onDelete: 'RESTRICT' },
    /** A slug the UI renders copy from. Never prose, never PHI. */
    withdrawn_reason: { type: 'text' },
    /**
     * The human's own sentence. PHI-CAPABLE by nature — a biller may name a
     * patient in it — so it is treated as the rest of this schema treats free
     * text a person typed, and is never copied into an audit row or a log line.
     */
    withdrawn_note: { type: 'text' },
  });

  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_withdraw_reason_check', {
    check: `withdrawn_reason IS NULL OR withdrawn_reason IN (${quoted(WITHDRAW_REASONS)})`,
  });

  /*
   * WITHDRAWN IMPLIES ITS EVIDENCE, AND THE EVIDENCE IMPLIES WITHDRAWN.
   *
   * The same pairing `blocked_reason` has, for the same reason. A `withdrawn`
   * row with no reason and no instant is a decision nobody can account for; a
   * withdrawal stamp left on a row in any other state is a decision the screen
   * would render over a plan that has since moved on.
   *
   * `withdrawn_note` is NOT in the pairing. It is optional by design — the drain
   * withdraws a plan by itself when a claim 404s, and there is no human in that
   * path to write a sentence. Demanding one would force the machine to invent
   * prose, which is exactly the habit `blocked_reason` exists to avoid.
   */
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_withdrawn_check', {
    check: `(status = 'withdrawn' AND withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL)
            OR (status <> 'withdrawn' AND withdrawn_at IS NULL AND withdrawn_reason IS NULL
                AND withdrawn_by IS NULL AND withdrawn_note IS NULL)`,
  });

  // The status vocabulary gains its seventh word. Re-keyed rather than added to,
  // because a CHECK cannot be extended in place.
  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check');
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check', {
    check: `status IN (${quoted(QUEUE_STATUSES)})`,
  });

  /*
   * A WITHDRAWN PLAN CANNOT CARRY A CHECK NUMBER.
   *
   * `posted_proof_check` already refuses a `posted` row without its proofs. This
   * is the mirror: a plan that never ran cannot have produced a ClaimPayment,
   * and a withdrawal that could carry one would be a withdrawal hiding money.
   * The route refuses `posted` and `partially_posted` as states; this refuses
   * the evidence, which is the half a future code path cannot talk its way past.
   */
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_withdrawn_no_money_check', {
    check: `status <> 'withdrawn'
            OR (od_claim_payment_num IS NULL AND reconciled_at IS NULL
                AND posted_total_cents = 0)`,
  });

  // Re-assert the grant, as every migration in this module does. A column added
  // to a granted table inherits the table's grant, but saying so costs nothing
  // and the call_record gap is why this line is a habit here.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON rcm_posting_queue TO ${APP_ROLE};`);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  /*
   * REFUSES WHILE A WITHDRAWN PLAN EXISTS — the same property 6c's down has for
   * `blocked` and 6d's for `recouped`.
   *
   * Rolling the vocabulary back under a row that uses the word would either fail
   * on the re-keyed CHECK or, worse, succeed and leave a row whose status no
   * constraint recognises. A migration that can corrupt the thing it is undoing
   * is not reversible; it is just untested.
   */
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM rcm_posting_queue WHERE status = 'withdrawn') THEN
        RAISE EXCEPTION 'refusing to roll back: withdrawn posting plans exist. '
          'Decide what they are first — there is no earlier word for them.';
      END IF;
    END $$;
  `);

  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_withdrawn_no_money_check');
  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_withdrawn_check');
  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_withdraw_reason_check');

  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check');
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check', {
    check: `status IN (${quoted(QUEUE_STATUSES.filter((s) => s !== 'withdrawn'))})`,
  });

  /*
   * COLUMNS LAST. Postgres silently drops a CHECK when a column it references
   * goes, so dropping these first would make the explicit `dropConstraint` calls
   * above fail — the exact ordering bug PR #113's rollback ran into and only
   * found by being run.
   */
  pgm.dropColumns('rcm_posting_queue', [
    'withdrawn_at',
    'withdrawn_by',
    'withdrawn_reason',
    'withdrawn_note',
  ]);
};

module.exports.QUEUE_STATUSES = QUEUE_STATUSES;
module.exports.WITHDRAW_REASONS = WITHDRAW_REASONS;
