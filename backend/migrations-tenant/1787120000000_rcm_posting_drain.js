'use strict';

/**
 * RCM Slice 6c — the drain's durable side. ADDITIVE ONLY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VOCABULARY QUESTION, ANSWERED ONCE
 * ─────────────────────────────────────────────────────────────────────────────
 * The 6c brief names the row states `queued -> running -> posted | ...` and the
 * line states `queued -> ... -> skipped_already_posted`. The database, since
 * Slice 1, calls the first two `approved` and `posting`, and 6b writes
 * `'approved'` by name in one statement and reads it back in another
 * (`QUEUE_ALREADY_RUNNING` fires on `status !== 'approved'`).
 *
 * **The stored words are not renamed.** `approved` and `posting` mean exactly
 * what `queued` and `running` mean in the brief — Slice 1 defines `approved` as
 * "approved and NOT yet posted" in its own header — and a rename would be a data
 * migration on a shipped table plus an edit to the gate that writes it, bought
 * for nothing but a synonym. The API and the screens say "Queued" and
 * "Running"; `postingVocabulary.js` holds the one map between the two, and its
 * test pins that the map covers every stored value in both directions.
 *
 * What IS new is genuinely new, and is added rather than substituted:
 *
 * 1. `blocked` on the row, `skipped_already_posted` on the line.
 *
 *    Both are widenings of an existing CHECK, and both name a state the machine
 *    could not previously express honestly.
 *
 *    `blocked` is the drain's refusal: a precondition failed, so NO Open Dental
 *    call was made and none will be until a human changes something. It is not
 *    `failed` — nothing was attempted — and it must not be left at `approved`,
 *    because a row that reads "queued" while the drain will never pick it up is
 *    the honest-states rule failing in the most expensive place in the module.
 *    The two rows that need it on day one are a valley row under D-7 and a
 *    recoupment under D-6, neither of which is an error and neither of which may
 *    be silently skipped.
 *
 *    `skipped_already_posted` is resume's word for "Open Dental already shows
 *    this line Received with our exact amounts, so there is nothing to write."
 *    Slice 1's `skipped` stays in the vocabulary and stays unused by this slice:
 *    "we chose not to" and "it was already done" are different facts about
 *    money, and collapsing them would make the one thing a resume needs to
 *    prove — that it did not double-post — unreadable afterwards.
 *
 * 2. `blocked_reason` — a MACHINE reason, not a sentence.
 *
 *    `valley_not_enabled`, `recoupment_not_in_scope`, `office_config_unresolved`,
 *    ... The UI renders copy from the slug; nothing parses prose. A CHECK is
 *    deliberately NOT put on this column: the reason vocabulary is code that
 *    grows every slice, and a CHECK would make adding a refusal reason a
 *    migration. The PAIRING with the state IS constrained, because that pairing
 *    is the honest-state claim: `blocked` implies a reason and a reason implies
 *    `blocked`.
 *
 * 3. `drain_step` — the row's step cursor.
 *
 *    Persisted BEFORE each Open Dental call, so a process that dies mid-row
 *    leaves a record of what it was about to do. It is NOT what resume trusts —
 *    resume re-reads Open Dental and reconciles against the plan (rule 4) — it
 *    is what makes a stuck row legible to a human without an OD round trip, and
 *    what the workbench shows as per-row progress.
 *
 * 4. `drained_by` / `drain_attempt_at` — who pressed, and when this attempt
 *    began.
 *
 *    Separate from `approved_by`, which is a different decision by (possibly) a
 *    different person. Open Dental cannot attribute an API write to a human at
 *    all — every row it writes logs `UserNum 0` and "Created by ... through
 *    API." (RCM_OD_WRITES section 9, Spike 0b test 13) — so the crosswalk key
 *    here plus one `audit_log` row per write IS the attribution record. There is
 *    no second copy anywhere.
 *
 * 5. `readback` jsonb on the line, and `readback_at`.
 *
 *    THE PROOF, kept rather than recomputed. G2 is the reason: Open Dental
 *    returns `200 OK` on a write it silently ignores, so the response status is
 *    not evidence and the read-back is. Storing the compared fields means a
 *    `posted` row can say "verified by read-back at <time>" and show what was
 *    read, instead of asserting a verification whose evidence was thrown away.
 *    It is also what a `partially_posted` row uses to name the exact
 *    disagreement.
 *
 * 6. `rcm_posting_queue.reconciled_at` — when `GET /claimprocs?ClaimPaymentNum=`
 *    was read back and matched our lines exactly.
 *
 *    NOTHING is ever marked `posted` before this is set. `od_claim_payment_num`
 *    (Slice 1) says a check exists; this says the check contains exactly the
 *    lines this plan intended and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT ADD
 * ─────────────────────────────────────────────────────────────────────────────
 * No new table. No lease/heartbeat column: the drain is a serial in-process loop
 * under maxReplicas = 1, the same standing invariant `eobStartupSweep.js`
 * documents, and a lease is the work to do BEFORE raising maxReplicas rather
 * than a column to add speculatively now. No document-attach state — the
 * `document_attached` step is 6d's and is left unimplemented on purpose, so this
 * migration does not mint a column nothing can set.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** The least-privilege application role — same constant as the Slice 1 migration. */
const APP_ROLE = process.env.AUDIT_APP_ROLE || 'carein_app';

/** Tables this migration touches. Used only by the grant re-assertion below. */
const TOUCHED_TABLES = ['rcm_posting_queue', 'rcm_posting_queue_line'];

/**
 * The row vocabulary AFTER this migration. `approved` and `posting` are Slice
 * 1's words for the brief's `queued` and `running`; see the header.
 */
const QUEUE_STATUSES = ['approved', 'posting', 'posted', 'failed', 'partially_posted', 'blocked'];

/**
 * The line vocabulary AFTER this migration. `skipped` is Slice 1's and stays
 * unused by 6c; `skipped_already_posted` is resume's.
 */
const LINE_STATUSES = [
  'pending',
  'claimproc_written',
  'claim_received',
  'paid',
  'failed',
  'skipped',
  'skipped_already_posted',
];

/** `'a','b','c'` for a CHECK ... IN (...) list. */
const quoted = (values) => values.map((v) => `'${v}'`).join(',');

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // -- 1. `blocked`, and the reason that must accompany it -------------------
  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check');
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check', {
    check: `status IN (${quoted(QUEUE_STATUSES)})`,
  });

  pgm.addColumns('rcm_posting_queue', {
    /**
     * WHY the drain refused, as a slug the UI renders copy from. Never prose,
     * never PHI. See the header for why this column carries no CHECK of its own.
     */
    blocked_reason: { type: 'text' },
    /**
     * What the drain was about to do when it last persisted. Advisory: resume
     * re-reads Open Dental and continues from TRUTH (rule 4), never from this.
     */
    drain_step: { type: 'text' },
    /** The crosswalk key of the human who pressed Drain on the current attempt. */
    drained_by: { type: 'text', references: 'rcm_user_map', onDelete: 'RESTRICT' },
    /** When the current (or last) attempt began — distinct from `started_at`. */
    drain_attempt_at: { type: 'timestamptz' },
    /**
     * When `GET /claimprocs?ClaimPaymentNum=` returned EXACTLY our lines.
     * `posted` is unreachable without it.
     */
    reconciled_at: { type: 'timestamptz' },
  });

  /*
   * BLOCKED IMPLIES A REASON, AND A REASON IMPLIES BLOCKED.
   *
   * The pairing is the honest-state claim itself. A `blocked` row with no reason
   * is a refusal nobody can act on; a reason left on a row in any other state is
   * a stale refusal the screen would render over a run that has since moved on.
   */
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_blocked_reason_check', {
    check: `(status = 'blocked' AND blocked_reason IS NOT NULL)
            OR (status <> 'blocked' AND blocked_reason IS NULL)`,
  });

  /*
   * `posted` REQUIRES BOTH PROOFS.
   *
   * A check number says money landed somewhere; the reconciliation timestamp
   * says the check contains exactly the lines this plan intended. Rule 11 —
   * "nothing is ever marked `posted` before the reconciliation read matches" —
   * is enforced here rather than only in the code that sets it, because the
   * whole point of the state is that a screen may trust it without re-deriving.
   *
   * `partially_posted` is deliberately NOT covered: it exists precisely for the
   * case where a check exists and the reconciliation did not match.
   */
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_posted_proof_check', {
    check: `status <> 'posted'
            OR (od_claim_payment_num IS NOT NULL AND reconciled_at IS NOT NULL)`,
  });

  // -- 2. The line's read-back evidence, and resume's own word ---------------
  pgm.dropConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_status_check');
  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_status_check', {
    check: `status IN (${quoted(LINE_STATUSES)})`,
  });

  pgm.addColumns('rcm_posting_queue_line', {
    /**
     * The last read-back verdict for this line: what we sent, what Open Dental
     * read back, and whether they agreed. Kept because G2 makes the response
     * status worthless as evidence — a 200 on an ignored write looks identical
     * to a 200 on an accepted one, and only the comparison distinguishes them.
     *
     * Shape (services/rcm/odPostingWrites.js is the single writer):
     *   { step, agreed, sent: {...}, read: {...}, mismatches: [{field,sent,read}] }
     *
     * Money-shaped fields only. No patient identity ever lands here.
     */
    readback: { type: 'jsonb' },
    readback_at: { type: 'timestamptz' },
    /**
     * Why a line was skipped, when it was. Today the only value is
     * `already_received_matching`, set by resume when Open Dental already shows
     * the line `Received` with our exact amounts.
     */
    skip_reason: { type: 'text' },
  });

  /*
   * The same pairing rule as `blocked_reason`, one level down: a skip must say
   * which kind of skip it was.
   */
  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_skip_reason_check', {
    check: `(status IN ('skipped','skipped_already_posted') AND skip_reason IS NOT NULL)
            OR (status NOT IN ('skipped','skipped_already_posted') AND skip_reason IS NULL)`,
  });

  /*
   * No new index. The drain's claim on work — rows waiting for THIS office,
   * oldest approval first — is exactly Slice 1's `rcm_posting_queue_drain_idx`
   * over (office_id, status, approved_at), and the startup sweep's scan for
   * `posting` rows uses the same one. A second index over the same columns would
   * only cost writes.
   */

  // -- 3. Grants, re-asserted ------------------------------------------------
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
        RAISE NOTICE 'rcm posting drain: grants re-asserted for role %', r;
      ELSE
        RAISE NOTICE 'rcm posting drain: app role % absent — grants SKIPPED.', r;
      END IF;
    END $$;
  `);
};

/**
 * Reverse of up().
 *
 * The two CHECK constraints are restored to their Slice 1 vocabularies, which
 * means `down` FAILS on a database holding a `blocked` row or a
 * `skipped_already_posted` line — deliberately. Silently rewriting a refusal
 * into some other state to make a rollback succeed would erase the fact that a
 * human still owes an action; a loud failure is the correct outcome, and the
 * operator's move is to resolve those rows first.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_skip_reason_check');
  pgm.dropColumns('rcm_posting_queue_line', ['readback', 'readback_at', 'skip_reason']);
  pgm.dropConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_status_check');
  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_status_check', {
    check: "status IN ('pending','claimproc_written','claim_received','paid','failed','skipped')",
  });

  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_posted_proof_check');
  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_blocked_reason_check');
  pgm.dropColumns('rcm_posting_queue', [
    'blocked_reason',
    'drain_step',
    'drained_by',
    'drain_attempt_at',
    'reconciled_at',
  ]);
  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check');
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check', {
    check: "status IN ('approved','posting','posted','failed','partially_posted')",
  });
};

module.exports.QUEUE_STATUSES = QUEUE_STATUSES;
module.exports.LINE_STATUSES = LINE_STATUSES;
