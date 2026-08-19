'use strict';

/**
 * RCM Slice 6b — the approval gate's durable side. ADDITIVE ONLY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ADDS, AND WHY EACH PIECE IS IN THE DATABASE RATHER THAN IN CODE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. `rcm_claims.posting_queue_id` / `approved_at` / `approved_by`
 *
 *    THE CLAIM-LEVEL IDEMPOTENCY, and it is a database fact rather than a
 *    convention. Approving twice must never create a second plan to post the
 *    same claim's money, and "the handler checks first" is not good enough when
 *    two billers press Approve on one remittance at the same instant.
 *
 *    A single-valued FK column is the whole guard: a claim can be linked to at
 *    most ONE queue row because a column holds one value, and the enqueue does
 *    its check and its write in ONE statement (`… WHERE posting_queue_id IS
 *    NULL`), so the loser of a race writes nothing and finds out. That is the
 *    same idiom `confirmMatch` uses to make its own check-and-write atomic.
 *
 *    A separate join table was considered and rejected: it would need its own
 *    unique index to say the same thing, and it would put "is this claim
 *    queued?" one join away from every screen that asks.
 *
 * 2. A PARTIAL UNIQUE INDEX on `rcm_posting_queue_line (office_id,
 *    od_claim_proc_num) WHERE is_supplemental = false`
 *
 *    THE MONEY-LEVEL IDEMPOTENCY — the uniqueness ON THE QUEUE that rule 5 of
 *    the slice brief asks for. The same Open Dental claimproc can never be
 *    planned for an ordinary adjudication twice, in any office, by any path,
 *    including one added next year that forgets to look at (1).
 *
 *    Partial rather than total, and the predicate is load-bearing: a RECOUPMENT
 *    line goes through `POST /claimprocs/Supplemental` against a claimproc that
 *    has already been paid, so a legitimate 6d supplemental would collide with
 *    the original line under a total unique index. Recoupments cannot pass the
 *    6b gate at all, so the exemption opens nothing today; it is here so 6d does
 *    not have to drop and rebuild the constraint that protects everything else.
 *
 * 3. A CHECK that a queued claim is a CONFIRMED one
 *
 *    `od_claim_num` is meaningful only in the confirmed state (the Slice 6a
 *    migration makes that a CHECK in both directions), and every queue line
 *    carries the ClaimProcNums that confirmation wrote. A claim that is queued
 *    and not confirmed would be a plan to post money into a chart nobody
 *    identified.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT ADD
 * ─────────────────────────────────────────────────────────────────────────────
 * No new table, no new status value, and nothing about EXECUTION.
 * `rcm_posting_queue.status` keeps its Slice 1 vocabulary
 * (`approved | posting | posted | failed | partially_posted`) and every row 6b
 * writes lands on `approved`, which the Slice 1 migration defines as "approved
 * and NOT yet posted". The state machine past that point belongs to 6c.
 *
 * `audit_log` is untouched. Grants: no new object is created, so the tables
 * below keep the grants the Slice 1 migration gave them; the DO block at the
 * end re-asserts them idempotently so a database restored from before that
 * migration cannot end up with a column the app role cannot write.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

/** The least-privilege application role — same constant as the Slice 1 migration. */
const APP_ROLE = process.env.AUDIT_APP_ROLE || 'carein_app';

/** Tables this migration touches. Used only by the grant re-assertion below. */
const TOUCHED_TABLES = ['rcm_claims', 'rcm_posting_queue_line'];

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // ── 1. The claim's link to the plan that will post it ─────────────────────
  pgm.addColumns('rcm_claims', {
    /**
     * The posting plan this claim was approved into. NULL until a human
     * approves it; set exactly once, and never cleared by anything in 6b.
     *
     * RESTRICT rather than CASCADE: the queue row is the record that somebody
     * authorised money to move, and deleting it out from under an approved
     * claim would erase who authorised what. Nothing in the module deletes a
     * queue row today; this is what keeps that true.
     */
    posting_queue_id: {
      type: 'uuid',
      references: 'rcm_posting_queue',
      onDelete: 'RESTRICT',
    },
    approved_at: { type: 'timestamptz' },
    /**
     * D-5 attribution. A queue row exists only because a person approved it, so
     * this is a crosswalk key like every other actor column in this schema —
     * never a free-text email and never NULL on an approved claim.
     */
    approved_by: { type: 'text', references: 'rcm_user_map', onDelete: 'RESTRICT' },
  });

  /*
   * All three together or none. An approval is one fact — which plan, when, by
   * whom — and a row carrying two of the three would be a half-recorded
   * authorisation that the workbench would render as though it were complete.
   */
  pgm.addConstraint('rcm_claims', 'rcm_claims_approval_check', {
    check: `(posting_queue_id IS NULL AND approved_at IS NULL AND approved_by IS NULL)
            OR (posting_queue_id IS NOT NULL AND approved_at IS NOT NULL AND approved_by IS NOT NULL)`,
  });

  /* A queued claim is a confirmed claim. See the header, point 3. */
  pgm.addConstraint('rcm_claims', 'rcm_claims_approved_is_confirmed_check', {
    check: `posting_queue_id IS NULL OR od_match_status = 'confirmed'`,
  });

  /*
   * The workbench's next obligation is "reviewed, postable, not yet approved",
   * and the drain reads "approved and not yet posted". Both filter on this pair
   * with office first, like every other index in this module.
   */
  pgm.createIndex('rcm_claims', ['office_id', 'posting_queue_id'], {
    name: 'rcm_claims_office_queue_idx',
  });

  // ── 2. One claimproc, one ordinary adjudication ───────────────────────────
  pgm.createIndex('rcm_posting_queue_line', ['office_id', 'od_claim_proc_num'], {
    name: 'rcm_posting_queue_line_claimproc_unique',
    unique: true,
    where: 'is_supplemental = false',
  });

  // ── 3. Grants, re-asserted ────────────────────────────────────────────────
  // Column additions inherit their table's grants, so this is a no-op on any
  // database that ran the Slice 1 migration. It is here so that is provable
  // rather than assumed, and it skips with a NOTICE when the role is absent
  // (local dev on a superuser), exactly like the Slice 1 block it mirrors.
  const tableList = TOUCHED_TABLES.map((t) => `'${t}'`).join(', ');
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
            t text;
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        FOREACH t IN ARRAY ARRAY[${tableList}] LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', t, r);
        END LOOP;
        RAISE NOTICE 'rcm approval: grants re-asserted for role %', r;
      ELSE
        RAISE NOTICE 'rcm approval: app role % absent — grants SKIPPED.', r;
      END IF;
    END $$;
  `);
};

/**
 * Reverse of up(). The index on `rcm_posting_queue_line` is dropped explicitly
 * because it is on a table that survives; the `rcm_claims` constraints and
 * index go with their columns.
 *
 * `down` cannot un-approve anything — dropping the columns discards the record
 * that a human authorised a posting, which is why this migration is only ever
 * reversed on a database that has not been used.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropIndex('rcm_posting_queue_line', ['office_id', 'od_claim_proc_num'], {
    name: 'rcm_posting_queue_line_claimproc_unique',
  });
  pgm.dropConstraint('rcm_claims', 'rcm_claims_approved_is_confirmed_check');
  pgm.dropConstraint('rcm_claims', 'rcm_claims_approval_check');
  pgm.dropIndex('rcm_claims', ['office_id', 'posting_queue_id'], {
    name: 'rcm_claims_office_queue_idx',
  });
  pgm.dropColumns('rcm_claims', ['posting_queue_id', 'approved_at', 'approved_by']);
};
