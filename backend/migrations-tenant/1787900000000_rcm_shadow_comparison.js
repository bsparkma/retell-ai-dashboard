'use strict';

/**
 * DID THE APP GET THIS CHECK RIGHT? — the shadow-mode comparison (Stage C-2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES
 * ─────────────────────────────────────────────────────────────────────────────
 * For the next several weeks the Roland biller works real remittances with
 * posting switched off (RCM_POSTING §2.5) and puts the same money into Open
 * Dental by hand. The whole point of that period is one question: does what this
 * app worked out match what she would have done?
 *
 * The go-live plan answered that with a HAND-MAINTAINED CSV. That is the weakest
 * link in it, because it asks a tired person at 9pm to do bookkeeping about her
 * own work — and the first thing that gets dropped is the record, not the work.
 * The decision to switch posting on then rests on somebody's impression.
 *
 * These six columns are that record, captured with one click at the moment she
 * already knows the answer, and they turn shadow mode's exit criterion from a
 * conversation into a number.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS COLUMNS ON THE CHECK AND NOT A TABLE OF ITS OWN
 * ─────────────────────────────────────────────────────────────────────────────
 * It is exactly the shape `parked_*` and `set_aside_*` are (1787500000000):
 * a stamp, an actor, a slug, and a human sentence, at most one of each, about
 * ONE remittance. A separate table would buy the ability to hold several answers
 * per check and would cost a join on every read that wants the one answer there
 * is. Same table, same pattern, same rollback.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT CANNOT REACH POSTING, BY CONSTRUCTION
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing the posting run reads lives on these columns. `postingDrain` works
 * from `rcm_posting_queue` and its lines; `rcm_payment_batches` is the check
 * these columns hang off, and the posting run never selects one. So an answer
 * here cannot change what posts, when, or whether — and
 * `shadowComparison.test.js` proves it rather than asserting it, by driving the
 * real posting run twice and comparing the Open Dental call transcript and the
 * resulting rows byte for byte.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CHECKS ARE WRITTEN THE LONG WAY, AND THAT IS THE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 * RCM_POSTING §15: **Postgres accepts a CHECK that evaluates to NULL.** It only
 * refuses FALSE. Two of B1's five CHECKs were constraints over nothing for
 * exactly that reason, and no unit test could have told anybody — the fake
 * accepts what it is handed. So every disjunct below LEADS with a two-valued
 * predicate on `comparison_verdict` (`IS NULL` / `IS NOT NULL`), which makes the
 * whole expression two-valued: when the verdict is NULL, every `= 'same'` test
 * that would have returned NULL sits behind a leading `IS NOT NULL` that is
 * already FALSE, and an AND chain led by FALSE is FALSE rather than NULL.
 *
 * The live rehearsal in RCM_POSTING §11a is what proves it. Do not shorten it.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** The least-privilege application role — same constant as every RCM migration. */
const APP_ROLE = process.env.AUDIT_APP_ROLE || 'carein_app';

/**
 * The two answers, and there is deliberately no third.
 *
 * `same` and `differed` are the whole vocabulary. No "partly", no "not sure",
 * no "skip": a maybe is an answer nobody can count, and the exit criterion this
 * exists to serve is a run of checks that matched. Somebody genuinely unsure
 * leaves it unanswered, which the NULL state already says.
 */
const COMPARISON_VERDICTS = ['same', 'differed'];

/**
 * What was off — a CLOSED list, and short on purpose.
 *
 * It follows `set_aside_reason`'s reasoning rather than `blocked_reason`'s:
 * blocked reasons are a list the posting run grows every slice, while "what did
 * this app get wrong" has a small set of answers that map onto the four things
 * it works out, and a new member is a design decision worth stopping for.
 *
 *   payment_amount   what the app said the insurance paid on a line
 *   write_off        a write-off — the amount, or that there was one at all
 *   patient_portion  what the app said the patient would end up owing
 *   wrong_target     it had the wrong claim, or the wrong patient, entirely
 *   other            anything else
 *
 * Unlike `set_aside_reason`, the note is required for EVERY slug and not only
 * for `other`. A set-aside is a filing decision whose slug is usually the whole
 * story; this is a report of a defect, and "the payment amount" without the
 * figures is a report nobody can act on.
 */
const COMPARISON_REASONS = [
  'payment_amount',
  'write_off',
  'patient_portion',
  'wrong_target',
  'other',
];

/** `'a','b','c'` for a CHECK ... IN (...) list. */
const quoted = (values) => values.map((v) => `'${v}'`).join(',');

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('rcm_payment_batches', {
    /**
     * `same` | `differed` | NULL, and NULL means NOT YET ANSWERED.
     *
     * Never "no difference found": nobody has looked. The screens read the null
     * as an open question and the report counts it as uncompared, which are the
     * same fact said two ways.
     */
    comparison_verdict: { type: 'text' },
    /** A SLUG the UI renders copy from. Never prose, never PHI. */
    comparison_reason: { type: 'text' },
    /**
     * Her own line, in her own words, and REQUIRED whenever the verdict is
     * `differed`.
     *
     * The slug says which of five things was off; this says what the app had and
     * what it should have had. Somebody reading this in three weeks to decide
     * whether to switch posting on needs the second one — a column of five slugs
     * is a tally, not evidence.
     *
     * PHI-CAPABLE by nature: a biller may name a patient in it. Treated the way
     * this schema treats every other free text a person typed — never copied
     * into an audit row and never into a log line.
     */
    comparison_note: { type: 'text' },
    /**
     * The crosswalk key, with the same `RESTRICT` FK every other actor column in
     * this schema carries (D-5). Resolved on the SAME connection as the write.
     */
    comparison_by: { type: 'text', references: 'rcm_user_map', onDelete: 'RESTRICT' },
    comparison_at: { type: 'timestamptz' },
    /**
     * HOW MANY TIMES THIS CHECK HAS BEEN ANSWERED. 0 = never.
     *
     * An answer is CHANGEABLE until the check posts, and a change must not be a
     * silent overwrite. This is the half of that promise the row carries; the
     * other half is one `audit_log` row per answer, which is where the actor and
     * the instant of each of them live.
     *
     * It is a counter rather than a stored history because of the precedent the
     * shadow gate itself set (§2.5): *"the before and after live in the row
     * itself … so audit_log gains no columns."* Keeping every superseded
     * sentence would mean a growing PHI-capable blob on a row read by every list
     * page, to answer a question — *what did she say the first time* — that
     * nothing in this slice asks. What the report DOES ask is "was this one
     * answered more than once", and this answers exactly that, for free.
     */
    comparison_revision: { type: 'integer', notNull: true, default: 0 },
  });

  pgm.addConstraint('rcm_payment_batches', 'rcm_payment_batches_comparison_verdict_check', {
    check: `comparison_verdict IS NULL OR comparison_verdict IN (${quoted(COMPARISON_VERDICTS)})`,
  });

  pgm.addConstraint('rcm_payment_batches', 'rcm_payment_batches_comparison_reason_check', {
    check: `comparison_reason IS NULL OR comparison_reason IN (${quoted(COMPARISON_REASONS)})`,
  });

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * THE PAIRING — the load-bearing one, and the one §15's trap was set for.
   * ═══════════════════════════════════════════════════════════════════════════
   * Three shapes are legal and nothing else is:
   *
   *   unanswered  every column null, revision 0
   *   same        stamp + actor + revision, and NO reason and NO note — a
   *               "same" carrying a reason describes two answers at once
   *   differed    stamp + actor + revision + BOTH the slug and the sentence
   *
   * Every disjunct LEADS with `comparison_verdict IS NULL` or
   * `comparison_verdict IS NOT NULL`, both of which are TRUE or FALSE and never
   * NULL. An AND chain led by FALSE is FALSE, so no disjunct can evaluate to
   * NULL, so the whole constraint is two-valued and Postgres can refuse it.
   *
   * Written `comparison_verdict IS NOT NULL AND comparison_verdict = 'same'`
   * rather than the shorter `comparison_verdict = 'same'` for exactly that
   * reason. The redundant-looking half is the half that works: without it, a row
   * with a NULL verdict but a stamp and an actor — an orphaned answer — yields
   * FALSE OR NULL OR FALSE = NULL, and Postgres ACCEPTS it.
   */
  pgm.addConstraint('rcm_payment_batches', 'rcm_payment_batches_comparison_check', {
    check: `(comparison_verdict IS NULL
             AND comparison_at IS NULL AND comparison_by IS NULL
             AND comparison_reason IS NULL AND comparison_note IS NULL
             AND comparison_revision = 0)
            OR (comparison_verdict IS NOT NULL AND comparison_verdict = 'same'
             AND comparison_at IS NOT NULL AND comparison_by IS NOT NULL
             AND comparison_reason IS NULL AND comparison_note IS NULL
             AND comparison_revision > 0)
            OR (comparison_verdict IS NOT NULL AND comparison_verdict = 'differed'
             AND comparison_at IS NOT NULL AND comparison_by IS NOT NULL
             AND comparison_reason IS NOT NULL AND comparison_note IS NOT NULL
             AND comparison_revision > 0)`,
  });

  /*
   * ONE PARTIAL INDEX, on the same argument `set_aside_at`'s carries.
   *
   * Both readers of these columns — the biller's running tally and the admin
   * summary — ask the same question: which of THIS OFFICE's checks have been
   * answered. Answered rows are the minority for most of the shadow period and
   * all of it at the start, so a partial index over `comparison_at IS NOT NULL`
   * costs nothing on the ordinary path and is the whole of both reads' work.
   *
   * Leading with `office_id` because office is a correctness boundary in this
   * module rather than a filter: neither reader ever asks a question that spans
   * both practices, so an index that did not start there would be scanning the
   * other office's answers on every read.
   */
  pgm.createIndex('rcm_payment_batches', ['office_id', 'comparison_at'], {
    name: 'rcm_payment_batches_comparison_idx',
    where: 'comparison_at IS NOT NULL',
  });

  // Re-assert the grant, as every migration in this module does.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON rcm_payment_batches TO ${APP_ROLE};`);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  /*
   * ROLLS BACK OVER LIVE ROWS, on 1787500000000's reasoning exactly.
   *
   * Nothing here is a status. `status` is untouched; these are additive stamps
   * beside it, and dropping them returns every row to a state the schema already
   * understood — a check simply becomes unanswered again, which is the
   * pre-migration truth rather than a corruption of it.
   *
   * Losing the answers is a real cost — they are the evidence the posting switch
   * gets turned on with — and is the reason this comment exists rather than a
   * silent drop. It is not a reason to make the migration irreversible: an
   * un-runnable `down` is not a safety property, it is an untested one.
   */
  pgm.dropIndex('rcm_payment_batches', ['office_id', 'comparison_at'], {
    name: 'rcm_payment_batches_comparison_idx',
  });

  /*
   * CONSTRAINTS BEFORE COLUMNS. Postgres silently drops a CHECK when a column it
   * references goes, so dropping the columns first would make these explicit
   * `dropConstraint` calls fail — the ordering bug PR #113's rollback found by
   * being run, and the reason every RCM `down` since is written this way.
   */
  pgm.dropConstraint('rcm_payment_batches', 'rcm_payment_batches_comparison_check');
  pgm.dropConstraint('rcm_payment_batches', 'rcm_payment_batches_comparison_reason_check');
  pgm.dropConstraint('rcm_payment_batches', 'rcm_payment_batches_comparison_verdict_check');

  pgm.dropColumns('rcm_payment_batches', [
    'comparison_verdict',
    'comparison_reason',
    'comparison_note',
    'comparison_by',
    'comparison_at',
    'comparison_revision',
  ]);
};

module.exports.COMPARISON_VERDICTS = COMPARISON_VERDICTS;
module.exports.COMPARISON_REASONS = COMPARISON_REASONS;
