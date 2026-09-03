'use strict';

/**
 * Per-tenant data-plane: what the post actually did with a decided write-off
 * (Stage B2).
 *
 * ADDITIVE ONLY: one column on `rcm_posting_queue_line`, two on `rcm_claims`.
 * B1 recorded the decision and snapshotted it onto the posting line; B2 posts
 * it. A post that reaches Open Dental leaves an id behind, and a post that has
 * happened turns the screen's projection into a fact — this is where both go.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY ONLY ONE OF THE TWO MODES NEEDS A COLUMN
 * ═════════════════════════════════════════════════════════════════════════════
 * `writeoff_mode = 'writeoff_field'` folds the decided amount into the
 * claimproc's own `WriteOff`. There is no second object in the chart, nothing
 * new to identify, and the existing read-back already proves the figure landed:
 * the number Open Dental returns either is `W + decided` or it is not.
 *
 * `adjustment_by_name` writes a SEPARATE ledger adjustment, which mints an
 * `AdjNum` — and an id we did not keep is an id nobody can trace, prove or
 * reverse. There is no `DELETE /adjustments` (G6), so this is also the only
 * record of a row in a patient's ledger that can never be removed, only
 * offset.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY NOT REUSE `od_adjustment_num`
 * ═════════════════════════════════════════════════════════════════════════════
 * 6d's column is spoken for by a CHECK: `od_adjustment_num IS NULL OR
 * recoupment_path = 'adjustment'`. A takeback and an office write-off are
 * opposite operations on the same money — one is the carrier removing what it
 * paid, the other is the practice absorbing what the patient owes — and putting
 * both ids in one column would make "is this row a takeback" unanswerable by
 * looking at it. The gate already refuses a claim that is both.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE-VALUED LOGIC, AND WHY THE CHECK IS WRITTEN THE LONG WAY
 * ═════════════════════════════════════════════════════════════════════════════
 * B1's live rehearsal found two CHECKs that constrained nothing: `NULL > 0` and
 * `NULL = 'office_writeoff'` are neither TRUE nor FALSE, and **Postgres accepts
 * a CHECK that evaluates to NULL** — it only refuses FALSE. So the guard below
 * leads with an explicit `IS NOT NULL` rather than relying on a comparison to
 * carry the absence, and the left-hand disjunct (`… IS NULL`) can never itself
 * be NULL.
 *
 * A CHECK is only a constraint over the values it can see as FALSE. See
 * `docs/RCM_POSTING.md` §15.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('rcm_posting_queue_line', {
    /**
     * `POST /adjustments` → AdjNum, for the office's own write-off under
     * `adjustment_by_name`.
     *
     * Its presence is also the idempotency key: a re-drain that finds this set
     * re-reads the patient's ledger for that AdjNum rather than posting a second
     * concession. A row in a ledger cannot be deleted, so a double-post is not a
     * mistake anybody can tidy up afterwards.
     */
    od_writeoff_adjustment_num: { type: 'bigint' },
    /**
     * WHAT THIS LINE PROMISED THE PATIENT WOULD OWE — R = allowed − paid,
     * before the office's own decision, frozen at the instant of approval.
     *
     * Nullable, and signed: a carrier that paid more than it allowed produces a
     * negative remainder and clamping it would hide the case that most needs a
     * person to look at it.
     *
     * WHY IT IS FROZEN RATHER THAN DERIVED. After the post, the drain can work R
     * out from the chart's own `FeeBilled` — and a fee somebody edits between
     * the approve and the press moves that derivation along with it, so the
     * "promise" would silently become whatever the chart now says and could
     * never disagree with it. A confirmation that cannot disagree is not a
     * confirmation. Rows approved before this column existed carry NULL, and the
     * drain falls back to the derivation for those, saying so.
     */
    intended_patient_cents: { type: 'integer' },
  });

  /*
   * AN ADJUSTMENT ID ONLY MEANS ANYTHING BESIDE A DECIDED AMOUNT.
   *
   * `decided_write_off_cents` is NULL — never 0 — when nobody decided anything,
   * so a row carrying an AdjNum with no decision would be an adjustment against
   * a patient that no decision on any screen asked for.
   *
   * Written with an explicit `IS NOT NULL` first: `NULL > 0` is NULL, and a
   * CHECK that evaluates to NULL is ACCEPTED.
   */
  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_writeoff_adj_check', {
    check: `od_writeoff_adjustment_num IS NULL
            OR (decided_write_off_cents IS NOT NULL AND decided_write_off_cents > 0)`,
  });

  // ── 2. What the patient owes, once it has actually posted ─────────────────
  //
  // The verdict a screen shows about a claim has two registers: before posting
  // it is a PROJECTION from the carrier's figures plus the decisions, and after
  // posting it is what Open Dental was read back as holding. Only the second is
  // a fact, and until now nothing stored one — so a posted claim's screen went
  // on saying "will owe … once posted" about a claim that had.
  //
  // The whole verdict is kept rather than a total: it carries the sentence a
  // person reads, the state, the decided write-offs with their reasons, and any
  // problem that made it red. Recomputing that months later would need the
  // chart to still look the way it did, which is exactly what nobody can promise.
  pgm.addColumns('rcm_claims', {
    /** `lineDecisions.verdictFor({ register: 'confirmed' })`, as written. */
    confirmed_verdict: { type: 'jsonb' },
    /** When the chart was read back. NOT when the money moved. */
    confirmed_at: { type: 'timestamptz' },
  });

  /*
   * BOTH OR NEITHER, and written the NULL-safe way.
   *
   * A timestamp with no verdict says a reading happened that nobody can look
   * at; a verdict with no timestamp is a claim about a chart with no date on
   * it, which is the shape that gets quoted back months later as though it were
   * current.
   */
  pgm.addConstraint('rcm_claims', 'rcm_claims_confirmed_verdict_check', {
    check: `(confirmed_verdict IS NULL AND confirmed_at IS NULL)
            OR (confirmed_verdict IS NOT NULL AND confirmed_at IS NOT NULL)`,
  });
};

/**
 * Reverse of up(). The constraint goes before its column.
 *
 * This one does NOT refuse while ids exist, and that is a deliberate difference
 * from 6c's and 6d's `down`. Those refuse because a chart is mid-flight — money
 * has moved and the row is the only record of where. Here the row is a record of
 * something already finished and provable from the patient's own ledger: the
 * AdjNum is in Open Dental whether or not this column remembers it. Dropping it
 * loses a convenience, not a fact.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('rcm_claims', 'rcm_claims_confirmed_verdict_check');
  pgm.dropColumns('rcm_claims', ['confirmed_verdict', 'confirmed_at']);

  pgm.dropConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_writeoff_adj_check');
  pgm.dropColumns('rcm_posting_queue_line', [
    'od_writeoff_adjustment_num',
    'intended_patient_cents',
  ]);
};
