'use strict';

/**
 * Per-tenant data-plane: the biller's per-line write-off decision (Stage B1).
 *
 * ADDITIVE ONLY. Four columns on `rcm_procedure_lines`, three on
 * `rcm_posting_queue_line`, two on `rcm_office_settings`. No new tables, no data
 * migration, no column dropped or retyped, and every new column is NULLABLE
 * except the one office setting that carries a safe default.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE RULE THIS SCHEMA EXISTS TO MAKE RECORDABLE
 * ═════════════════════════════════════════════════════════════════════════════
 * What the carrier's remittance says the patient owes must equal what Open
 * Dental will say the patient owes once the payment and the write-offs post —
 * with exactly ONE legitimate exception: a write-off the office chose to make,
 * which lowers the patient's number on purpose. That exception is a DECISION a
 * person made, and a decision nobody recorded is indistinguishable from a
 * mistake. These columns are where it is recorded.
 *
 * Per line the carrier gives billed (B), allowed (A) and paid (P). From those:
 *
 *     contractual write-off   W = B − A     the carrier's own figure
 *     patient remainder       R = A − P     what the remittance says they owe
 *
 * W is a fact and is always accepted; there is nothing to decide about it and no
 * column here holds it. The decision is about R, and it is one enum:
 *
 *     bill_patient      the patient is billed R. The default; needs no action.
 *     office_writeoff   the office absorbs R. Needs a reason, always.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE DECISION LIVES ON THE REVIEW LINE AND NOT ON A POSTING LINE
 * ═════════════════════════════════════════════════════════════════════════════
 * `rcm_procedure_lines` is the review side: one row per line of the carrier's
 * proposal, written at ingestion, carrying `od_claim_proc_num` once a human
 * confirms the match. `rcm_posting_queue_line` is the INTENT side and does not
 * exist until somebody approves — and D-14 makes it immutable from that moment.
 *
 * A biller decides write-offs while reading the remittance, which is before any
 * approval has happened. Putting the decision on the posting line would mean it
 * could not be made until after the act it is supposed to inform, and changing
 * one would mean editing a record that is deliberately frozen. So the decision
 * belongs to the review, and approving SNAPSHOTS it onto the posting line —
 * which is why the same three facts appear on both tables and are not the same
 * columns.
 *
 * The snapshot is what the drain reads. It must never read the review row: the
 * review may have moved on, and a plan that posted figures nobody approved would
 * be the worst failure this module has.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE REASON IS A CHECK ON NULL-NESS AND NOT ON MEMBERSHIP
 * ═════════════════════════════════════════════════════════════════════════════
 * An office write-off with no reason is money leaving the practice with nobody's
 * name on why — so the database refuses it, in both directions (a reason without
 * a write-off is a reason for nothing).
 *
 * WHICH reasons are legitimate is enforced in the route, not here. The canned
 * list ships as five and is meant to become per-office editable in a later
 * slice; a CHECK over the five would turn that slice into a migration on a table
 * holding a practice's money history. Null-ness is the invariant; membership is
 * a policy, and they belong in different places.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY `writeoff_mode` IS A PER-OFFICE SETTING
 * ═════════════════════════════════════════════════════════════════════════════
 * Roland books a voluntary write-off into the claimproc's own WriteOff field
 * plus a note, and uses no adjustment type for it. Other practices book the same
 * decision as a ledger adjustment. Both are correct bookkeeping; they are not
 * the same Open Dental call. So HOW an office write-off is written is a fact
 * about the practice, it lives beside the practice's other posting settings, and
 * the default is the one Roland already uses — the mode whose write the drain
 * makes today, so a practice that never touches this setting gets the behaviour
 * it has now.
 *
 * `adjustment_by_name` carries the AdjType NAME, never a DefNum. D-13: DefNums
 * are per-database and a number copied between practices writes the wrong type
 * into the wrong chart. The name is resolved live against that office's own
 * definitions at post time, and a name that is empty or not found REFUSES the
 * claim — never a default, never a number. The CHECK below makes the empty half
 * of that impossible to store in the first place.
 *
 * Grants: additive columns inherit the table's existing grants, so no GRANT
 * block is needed (see the Slice 1 migration for the per-table path).
 * `audit_log` is not mentioned by this migration and stays append-only.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

/**
 * The two decisions a biller can record about a line's patient remainder.
 * Exported so the route layer, the gate and their tests read the same list the
 * CHECK constraint does.
 */
const LINE_DECISIONS = Object.freeze(['bill_patient', 'office_writeoff']);

/**
 * How an office books a write-off it chose to make.
 *
 * `writeoff_field` — into the claimproc's WriteOff, alongside the contractual
 * figure. Roland's way, and the default.
 * `adjustment_by_name` — as a ledger adjustment of the named type.
 */
const WRITEOFF_MODES = Object.freeze(['writeoff_field', 'adjustment_by_name']);

/**
 * An actor column — the crosswalk-typed FK the Slice 1 migration established.
 * RESTRICT because attribution must not be erasable by deleting a user row.
 */
const ACTOR = { type: 'text', references: 'rcm_user_map', onDelete: 'RESTRICT' };

/** SQL list literal for a CHECK, from a JS array. */
const list = (values) => values.map((v) => `'${v}'`).join(', ');

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // ── The review side: the decision itself ──────────────────────────────────
  pgm.addColumns('rcm_procedure_lines', {
    /**
     * NULL means "nobody has said" — which reads as `bill_patient`, the default
     * that needs no action, everywhere it is evaluated. Deliberately not
     * defaulted to the string: a line a person actively decided to bill and a
     * line nobody looked at are different facts, and only one of them carries a
     * name and an instant.
     */
    line_decision: { type: 'text' },
    /** Required for `office_writeoff`, forbidden otherwise. See the CHECK. */
    decision_reason: { type: 'text' },
    decided_by: ACTOR,
    decided_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('rcm_procedure_lines', 'rcm_procedure_lines_decision_check', {
    check: `line_decision IS NULL OR line_decision IN (${list(LINE_DECISIONS)})`,
  });

  /*
   * A DECISION IS A PERSON AND AN INSTANT, or it is nothing. Same pairing rule
   * `rcm_claims_reviewed_attribution_check` applies to the review marker: an
   * unattributed decision about money is not a weaker record, it is a different
   * and worse one, because it looks like a record.
   */
  pgm.addConstraint('rcm_procedure_lines', 'rcm_procedure_lines_decision_attribution_check', {
    check: `(line_decision IS NULL AND decided_at IS NULL AND decided_by IS NULL)
            OR (line_decision IS NOT NULL AND decided_at IS NOT NULL AND decided_by IS NOT NULL)`,
  });

  /*
   * BOTH DIRECTIONS. An office write-off with no reason is unexplained money
   * leaving the practice; a reason attached to anything else is a reason for
   * nothing, and would print under a line the office is billing in full.
   */
  /*
   * ⚠ `IS NOT DISTINCT FROM`, NOT `=`, AND THE LIVE REHEARSAL IS WHY.
   *
   * Written first as `line_decision = 'office_writeoff' AND …`, this had a
   * three-valued-logic hole: with `line_decision` NULL that conjunct is NULL
   * rather than FALSE, the whole branch evaluates to NULL, and Postgres ACCEPTS
   * a CHECK that is NULL — it only refuses one that is FALSE. So a reason could
   * be stored against a line nobody had decided anything about: a record of a
   * write-off with no write-off.
   *
   * `IS DISTINCT FROM` and `IS NOT DISTINCT FROM` are NULL-safe — they return
   * TRUE or FALSE and never NULL — so the whole expression is two-valued and
   * every combination is decided. The rehearsal below proves all four.
   */
  pgm.addConstraint('rcm_procedure_lines', 'rcm_procedure_lines_decision_reason_check', {
    check: `(decision_reason IS NULL AND line_decision IS DISTINCT FROM 'office_writeoff')
            OR (line_decision IS NOT DISTINCT FROM 'office_writeoff'
                AND decision_reason IS NOT NULL AND btrim(decision_reason) <> '')`,
  });

  // ── The intent side: the snapshot approving takes ─────────────────────────
  pgm.addColumns('rcm_posting_queue_line', {
    /**
     * The office's own write-off for this line, in cents, as it stood when a
     * human approved. NULL means no office write-off was decided — which is not
     * the same as zero, and the drain's arithmetic reads it that way.
     *
     * SEPARATE from `intended_write_off_cents`, which is the CARRIER's
     * contractual figure. Adding the two together at approve time would destroy
     * the one distinction the whole slice exists to keep: what the carrier took
     * off, and what this practice chose to absorb. The drain sums them at the
     * moment it writes and the read-back verifies the sum.
     */
    decided_write_off_cents: { type: 'bigint' },
    /** Frozen with the amount. Lives in CareIN; the drain does not send it to OD. */
    decided_reason: { type: 'text' },
    decided_by: ACTOR,
  });

  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_decided_check', {
    /*
     * All three or none, and the amount is positive when present. A zero-cent
     * "decision" would be a write-off of nothing carrying a reason, which says
     * something happened when nothing did; a negative one would be the office
     * handing the patient money through a field that cannot mean that.
     */
    /*
     * `IS NOT NULL` BEFORE `> 0`, for the same reason as above: `NULL > 0` is
     * NULL, not FALSE, and a CHECK that evaluates to NULL is accepted. Without
     * it a reason and a name could be stored against no amount — a decision
     * that claims money moved when none did.
     */
    check: `(decided_write_off_cents IS NULL AND decided_reason IS NULL AND decided_by IS NULL)
            OR (decided_write_off_cents IS NOT NULL AND decided_write_off_cents > 0
                AND decided_reason IS NOT NULL AND btrim(decided_reason) <> ''
                AND decided_by IS NOT NULL)`,
  });

  // ── The office: how it books a write-off it chose ─────────────────────────
  pgm.addColumns('rcm_office_settings', {
    /**
     * NOT NULL with a default, unlike everything else in this migration: there
     * is no such thing as an office with no way of booking a write-off, and the
     * default is the behaviour the drain already has. An office nobody
     * configures keeps working exactly as it does today.
     */
    writeoff_mode: { type: 'text', notNull: true, default: 'writeoff_field' },
    /**
     * The AdjType NAME, never a DefNum (D-13). NULL under `writeoff_field`,
     * where there is no adjustment type to name.
     */
    writeoff_adjtype_name: { type: 'text' },
  });

  pgm.addConstraint('rcm_office_settings', 'rcm_office_settings_writeoff_mode_check', {
    check: `writeoff_mode IN (${list(WRITEOFF_MODES)})`,
  });

  /*
   * A MODE THAT NAMES AN ADJUSTMENT TYPE MUST NAME ONE.
   *
   * Fail-closed at the schema, so the drain's live refusal (D-13: a name that
   * resolves to nothing refuses the claim) never has to handle the case where
   * the name was blank all along. The two guards answer different questions —
   * "was one configured" and "does that office's database have it" — and only
   * the second needs an Open Dental call.
   *
   * The reverse is NOT constrained: a name left behind after switching back to
   * `writeoff_field` is harmless and switching modes should not require
   * retyping it.
   */
  pgm.addConstraint('rcm_office_settings', 'rcm_office_settings_writeoff_adjtype_check', {
    check: `writeoff_mode <> 'adjustment_by_name'
            OR (writeoff_adjtype_name IS NOT NULL AND btrim(writeoff_adjtype_name) <> '')`,
  });
};

/**
 * Reverse of up(). Constraints are dropped before their columns — the same
 * order every RCM migration uses, because dropping a column out from under a
 * named CHECK leaves the constraint behind on some Postgres paths.
 *
 * Unlike 6c's and 6d's `down`, this one does NOT refuse while decided rows
 * exist. Nothing here is a state a chart can be in: a decision is CareIN's own
 * record of an intention, and dropping it loses information without leaving Open
 * Dental holding anything that no longer has a record. `blocked` and `recouped`
 * refuse because a chart is mid-flight; a write-off decision never is.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('rcm_office_settings', 'rcm_office_settings_writeoff_adjtype_check');
  pgm.dropConstraint('rcm_office_settings', 'rcm_office_settings_writeoff_mode_check');
  pgm.dropColumns('rcm_office_settings', ['writeoff_mode', 'writeoff_adjtype_name']);

  pgm.dropConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_decided_check');
  pgm.dropColumns('rcm_posting_queue_line', [
    'decided_write_off_cents',
    'decided_reason',
    'decided_by',
  ]);

  pgm.dropConstraint('rcm_procedure_lines', 'rcm_procedure_lines_decision_reason_check');
  pgm.dropConstraint('rcm_procedure_lines', 'rcm_procedure_lines_decision_attribution_check');
  pgm.dropConstraint('rcm_procedure_lines', 'rcm_procedure_lines_decision_check');
  pgm.dropColumns('rcm_procedure_lines', [
    'line_decision',
    'decision_reason',
    'decided_by',
    'decided_at',
  ]);
};

module.exports.LINE_DECISIONS = LINE_DECISIONS;
module.exports.WRITEOFF_MODES = WRITEOFF_MODES;
