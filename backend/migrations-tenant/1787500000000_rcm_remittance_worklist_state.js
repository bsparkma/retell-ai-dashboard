'use strict';

/**
 * TWO WAYS TO TAKE A CHECK OFF TODAY'S LIST, AND THEY ARE NOT THE SAME THING.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A REMITTANCE NEEDED EITHER
 * ─────────────────────────────────────────────────────────────────────────────
 * `needsAttention` is computed from OUTSTANDING ACTIONS (see
 * routes/rcm/remittances.js `attentionFor`), and its whole value is that it
 * cries wolf as rarely as possible. Two things break that promise, and neither
 * is expressible in the claim-level vocabulary:
 *
 *   1. A biller stops mid-check at 4:55pm. Tomorrow the queue tells her the same
 *      thing it told everybody else — that this check needs attention — and
 *      nothing anywhere records that SHE was in the middle of it, or why she put
 *      it down. `parked_*` is that record.
 *
 *   2. A check that will never be worked sits in the queue forever. RCM_POSTING
 *      §15.2 finding 5: two of them already do on staging, both matched, both
 *      reviewed, both pointing at claims a walk's unwind deleted. There is no
 *      action that clears them, so the one signal the queue exists to carry —
 *      *this needs a human* — decays with every walk. `set_aside_*` is the way
 *      out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PARKED IS NOT SET ASIDE, AND NEITHER IS RETIRED
 * ─────────────────────────────────────────────────────────────────────────────
 * Three states, three different sentences, and collapsing any two of them would
 * lose a fact somebody needs:
 *
 *   parked      "I am coming back to this." Still needs attention, still counted,
 *               still work. It appears on Today under *Where you left off* and
 *               UN-PARKS the moment somebody opens it — a note-to-self, not a
 *               state anybody else has to maintain.
 *
 *   set aside   "Nobody is coming back to this." Out of the attention counts and
 *               off Today, findable under its own filter, REVERSIBLE, and it
 *               writes nothing to Open Dental and decides nothing about money.
 *
 *   withdrawn   (`rcm_posting_queue`, 1787300000000) "This money will never post
 *               through CareIN." Terminal, irreversible, and about a POSTING
 *               PLAN rather than about a remittance. A set-aside remittance with
 *               no plan has retired nothing; a withdrawn plan is a decision that
 *               cannot be taken back. They live on different tables because they
 *               are about different objects.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY BOTH RIDE IN ONE MIGRATION
 * ─────────────────────────────────────────────────────────────────────────────
 * They are the same shape on the same table — stamp, actor, human sentence — and
 * two migrations touching `rcm_payment_batches` in sequence would have to be
 * rolled back in order to get the table back. One migration, one rollback.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NO CHECK SAYS "NOT BOTH"
 * ─────────────────────────────────────────────────────────────────────────────
 * A parked check that is later set aside is an ordinary sequence: somebody meant
 * to come back, then found out the claims were gone. Refusing it in the schema
 * would force the route to clear a stamp that records something true — that a
 * person was working on this — for no gain. The list treats set-aside as the
 * stronger state and stops showing it as parked; the parked stamp stays as
 * history.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** The least-privilege application role — same constant as every RCM migration. */
const APP_ROLE = process.env.AUDIT_APP_ROLE || 'carein_app';

/**
 * Why a check was set aside.
 *
 * A CHECK constraint, and it follows `withdrawn_reason`'s reasoning rather than
 * `blocked_reason`'s: blocked reasons are a list the drain grows every slice,
 * while "why would nobody ever work this check" has a small, argued-about set of
 * answers and a new member is a design decision worth stopping for.
 *
 *   target_gone     the claims this check pays no longer exist in Open Dental
 *   duplicate       the same money arrived twice, and the other copy is the one
 *   posted_by_hand  it went into Open Dental at the desktop; CareIN has no part
 *   not_ours        this remittance belongs to another practice or another payer
 *   other           anything else — and `set_aside_reason_note` is REQUIRED, so
 *                   the slug can never be the whole story
 */
const SET_ASIDE_REASONS = ['target_gone', 'duplicate', 'posted_by_hand', 'not_ours', 'other'];

/** `'a','b','c'` for a CHECK ... IN (...) list. */
const quoted = (values) => values.map((v) => `'${v}'`).join(',');

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('rcm_payment_batches', {
    /*
     * ── PARKED ──────────────────────────────────────────────────────────────
     * "Save for tomorrow." A stamp, a person, and optionally her own sentence.
     */
    parked_at: { type: 'timestamptz' },
    /**
     * The crosswalk key, with the same `RESTRICT` FK every other actor column in
     * this schema carries (D-5). Parking is a note to a PERSON, so the person is
     * the load-bearing half: "somebody parked this" would be useless on a screen
     * whose whole job is to show one biller where she left off.
     */
    parked_by: { type: 'text', references: 'rcm_user_map', onDelete: 'RESTRICT' },
    /**
     * Her own line. OPTIONAL by design — the friction of demanding a sentence at
     * 4:55pm is exactly the friction that would stop anybody parking anything,
     * and an unparked check she has to re-derive from scratch is the failure this
     * column exists to prevent.
     *
     * PHI-CAPABLE by nature: a biller may name a patient in it. Treated the way
     * this schema treats every other free text a person typed — never copied into
     * an audit row and never into a log line.
     */
    parked_note: { type: 'text' },

    /*
     * ── SET ASIDE ───────────────────────────────────────────────────────────
     * "Nobody is coming back to this." Out of the counts; never out of the data.
     */
    set_aside_at: { type: 'timestamptz' },
    set_aside_by: { type: 'text', references: 'rcm_user_map', onDelete: 'RESTRICT' },
    /** A SLUG the UI renders copy from. Never prose, never PHI. */
    set_aside_reason: { type: 'text' },
    /**
     * The human's own sentence, separate from the slug for the same reason
     * `withdrawn_note` is: a biller setting a check aside knows something the
     * machine does not, and folding her words into the slug would make the slug
     * unusable for anything else. REQUIRED by the route when the slug is
     * `other`, which is what stops `other` from being a silent shrug.
     */
    set_aside_reason_note: { type: 'text' },
  });

  pgm.addConstraint('rcm_payment_batches', 'rcm_payment_batches_set_aside_reason_check', {
    check: `set_aside_reason IS NULL OR set_aside_reason IN (${quoted(SET_ASIDE_REASONS)})`,
  });

  /*
   * EACH STATE IMPLIES ITS OWN EVIDENCE, IN BOTH DIRECTIONS.
   *
   * The same pairing `withdrawn_check` has, and for the same reason. A parked
   * check with no instant is a state no screen can date; a `parked_by` left
   * behind on an un-parked row is a name a screen would print beside a check
   * nobody is holding. Un-parking clears the stamp AND the actor, and the
   * constraint is what makes that a rule rather than a habit.
   *
   * `parked_note` is deliberately NOT in the pairing on the way in — it is
   * optional — but it IS on the way out: a note with no park is orphaned prose.
   */
  pgm.addConstraint('rcm_payment_batches', 'rcm_payment_batches_parked_check', {
    check: `(parked_at IS NOT NULL AND parked_by IS NOT NULL)
            OR (parked_at IS NULL AND parked_by IS NULL AND parked_note IS NULL)`,
  });

  /*
   * SET ASIDE DEMANDS ITS REASON. A check dropped out of the one queue that
   * says "a human is needed here", with no account of why, is the queue quietly
   * losing work nobody can later explain — the same argument that makes
   * `withdrawn`'s note a 400 rather than an optional field.
   */
  pgm.addConstraint('rcm_payment_batches', 'rcm_payment_batches_set_aside_check', {
    check: `(set_aside_at IS NOT NULL AND set_aside_by IS NOT NULL AND set_aside_reason IS NOT NULL)
            OR (set_aside_at IS NULL AND set_aside_by IS NULL AND set_aside_reason IS NULL
                AND set_aside_reason_note IS NULL)`,
  });

  /*
   * THE ONE INDEX, AND WHY IT IS PARTIAL.
   *
   * Every list read for an office already filters `office_id`; what this adds is
   * the ability to answer "which of this office's checks are set aside" without
   * scanning the ones that are not — and set-aside rows are, by construction,
   * the small minority. A partial index over `set_aside_at IS NOT NULL` costs
   * nothing on the ordinary path and is the whole of the new filter's work.
   *
   * Parked gets NO index: parked rows are read as part of the same whole-office
   * scan the attention predicate already runs, and a second index on a column
   * that is null for almost every row and read alongside all of them would be
   * pure write cost.
   */
  pgm.createIndex('rcm_payment_batches', 'set_aside_at', {
    name: 'rcm_payment_batches_set_aside_idx',
    where: 'set_aside_at IS NOT NULL',
  });

  // Re-assert the grant, as every migration in this module does. A column added
  // to a granted table inherits the table's grant, but saying so costs nothing.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON rcm_payment_batches TO ${APP_ROLE};`);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  /*
   * UNLIKE `withdrawn`, THIS ROLLS BACK OVER LIVE ROWS — deliberately.
   *
   * The withdraw migration refuses while a withdrawn plan exists, because
   * `withdrawn` is a WORD in a status vocabulary and rolling the vocabulary back
   * under a row that uses it leaves a row no constraint recognises. Nothing here
   * is a status. `status` is untouched; these are additive stamps beside it, and
   * dropping them returns every row to a state the schema already understood —
   * a set-aside check simply reappears in the queue it was taken out of, which
   * is the pre-migration truth rather than a corruption of it.
   *
   * Losing a biller's parked note is a real cost and is the reason this comment
   * exists rather than a silent drop. It is not a reason to make the migration
   * irreversible: an un-runnable `down` is not a safety property, it is an
   * untested one.
   */
  pgm.dropIndex('rcm_payment_batches', 'set_aside_at', {
    name: 'rcm_payment_batches_set_aside_idx',
  });

  /*
   * CONSTRAINTS BEFORE COLUMNS. Postgres silently drops a CHECK when a column it
   * references goes, so dropping the columns first would make these explicit
   * `dropConstraint` calls fail — the ordering bug PR #113's rollback found by
   * being run, and the reason every RCM `down` since is written this way.
   */
  pgm.dropConstraint('rcm_payment_batches', 'rcm_payment_batches_set_aside_check');
  pgm.dropConstraint('rcm_payment_batches', 'rcm_payment_batches_parked_check');
  pgm.dropConstraint('rcm_payment_batches', 'rcm_payment_batches_set_aside_reason_check');

  pgm.dropColumns('rcm_payment_batches', [
    'parked_at',
    'parked_by',
    'parked_note',
    'set_aside_at',
    'set_aside_by',
    'set_aside_reason',
    'set_aside_reason_note',
  ]);
};

module.exports.SET_ASIDE_REASONS = SET_ASIDE_REASONS;
