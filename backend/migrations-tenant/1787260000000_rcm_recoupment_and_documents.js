/* eslint-disable camelcase */

/**
 * RCM Slice 6d — the recoupment gate and the EOB document attach.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS MIGRATION EXISTS AT ALL
 * ═════════════════════════════════════════════════════════════════════════════
 * 6d was scoped as a code-only slice. It is not, and three shipped constraints
 * are the reason — each one correct for 6c and each one a wall for 6d:
 *
 *   1. `rcm_posting_queue_posted_proof_check` demands a ClaimPaymentNum for
 *      `posted`. A PURE-RECOUPMENT plan creates no check by design, so under
 *      that constraint it could never reach `posted` — it would sit
 *      `partially_posted` forever with the takeback correctly on the chart.
 *
 *      ⚠ The relaxation is keyed on a new `requires_check` column and NOT on
 *      `is_recoupment`. They are different questions, and a MIXED plan (paid
 *      claims plus a takeback) answers them differently: it is a recoupment
 *      AND it owes a check. Keying on `is_recoupment` would have let that plan
 *      say `posted` with no check number — the exact false-`posted` this
 *      constraint exists to prevent.
 *   2. `rcm_posting_queue_line_status_check` has no word for a line whose
 *      takeback landed. Reusing `paid` would say a carrier paid when it took.
 *   3. Nothing anywhere can hold an `od_doc_num`, an `od_adjustment_num`, or
 *      which of the two recoupment paths a line took. Writing to a chart and
 *      then being unable to say what was written is the honest-states rule
 *      failing at the only moment it costs money.
 *
 * ADDITIVE ONLY. Every column is nullable or defaulted, every CHECK is either
 * new or a RELAXATION of an existing one, and `down` restores the 6c shape
 * exactly. No existing row changes meaning.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY *NOT* HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * **`audit_log` is untouched.** The 6d brief asked for a distinct
 * `APPROVE_RECOUPMENT` audit action, but `audit_log_action_check` permits only
 * `READ | CREATE | UPDATE | DELETE` and there is no `detail` column. Widening an
 * APPEND-ONLY, cross-module table so one RCM event can name itself is a far
 * larger change than the event warrants — so the distinctness lives in
 * `resource_type` instead, which is where this platform already puts it
 * (`rcm_posting_approval` vs `rcm_posting_drain`). A recoupment approval writes
 * `CREATE rcm_recoupment_approval` and never `CREATE rcm_posting_approval`, so
 * the two are still separable by a query, and the numbers the brief wanted in
 * `detail` are all on the plan the row points at.
 *
 * **The 6d.2 follow-on plan is not here either.** Relaxing
 * `(office_id, remittance_key)` to `(office_id, remittance_key, sequence)` is a
 * decided, scheduled change (docs/RCM_POSTING.md §15.1) and it is a different
 * slice's migration. Doing it early would ship an unused `sequence` column and a
 * weaker uniqueness guarantee months before anything enforced the new one.
 */

/**
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/**
 * The line vocabulary AFTER this migration.
 *
 * `recouped` is the only addition, and it is a separate word from `paid` on
 * purpose. A line that ends `paid` is money the carrier sent; a line that ends
 * `recouped` is money the carrier took back. Collapsing them would make the
 * queue unable to answer "what did this practice actually receive" — which is
 * the question the whole module exists to answer.
 */
const LINE_STATUSES = [
  'pending',
  'claimproc_written',
  'claim_received',
  'paid',
  'recouped',
  'failed',
  'skipped',
  'skipped_already_posted',
];

/** The 6c vocabulary, restored by `down`. */
const LINE_STATUSES_6C = LINE_STATUSES.filter((s) => s !== 'recouped');

/**
 * Which irreversible-ness a recoupment line was written with.
 *
 *   `adjustment`   `POST /adjustments` — DELETABLE, and the default the dialog
 *                  offers. This is the path a cautious biller takes.
 *   `supplemental` `POST /claimprocs/Supplemental` with a negative InsPayAmt —
 *                  G10, the one Open Dental operation that cannot be reverted,
 *                  cannot be deleted, and permanently pins its claim and
 *                  procedure. Opt-in only.
 *
 * Stored rather than re-derived because after the fact the two are not
 * distinguishable from our side, and "can this be undone" is the single most
 * important thing a person asks about a takeback.
 */
const RECOUPMENT_PATHS = ['adjustment', 'supplemental'];

/**
 * How the EOB filing went, at the PLAN level.
 *
 * NOT a plan `status`. §8 puts the document last precisely because *"a document
 * failure is retryable and never a financial error"*, so a failed attach must
 * leave `posted` alone — a plan whose money is correct and proven does not stop
 * being posted because a PDF did not file. Two axes, two columns.
 *
 * `partial` is real and not a hedge: a plan spanning three patients can file two
 * of them. Calling that `attached` would claim a document exists in a chart
 * where it does not.
 */
const DOCUMENT_ATTACH_STATUSES = ['attached', 'partial', 'failed'];

/** `'a','b','c'` for a CHECK ... IN (...) list. */
const quoted = (values) => values.map((v) => `'${v}'`).join(',');

/**
 * The least-privilege app role, read the same way every other RCM migration
 * reads it. Validated as an identifier before it is interpolated — the same
 * guard `1786622400000_rcm_schema.js` carries, and for the same reason.
 */
const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(APP_ROLE)) {
  throw new Error(`[rcm 6d migration] invalid AUDIT_APP_ROLE '${APP_ROLE}'`);
}

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // ── 1. `posted` for a plan that correctly has no check ────────────────────
  //
  // The 6c rule was: a check number says money landed somewhere, and
  // `reconciled_at` says the check holds exactly this plan's lines. BOTH proofs,
  // enforced by the database rather than only by the code that sets it.
  //
  // A pure recoupment has no check to point at — `POST /claimpayments` is not
  // part of its sequence — so the first proof is unavailable and the constraint
  // made `posted` unreachable. The relaxation opens exactly that one door and
  // no other: an ORDINARY plan still cannot be `posted` without its check
  // number, which is the guarantee that was actually load-bearing.
  //
  // `reconciled_at` is still required in BOTH cases. Whatever a recoupment
  // wrote, something read it back and agreed before this row could say `posted`.
  /*
   * `requires_check` — DOES THIS PLAN OWE THE PRACTICE A CHECK?
   *
   * NOT the same question as `is_recoupment`, and conflating them was a real
   * hole: a MIXED plan (nine paid claims plus one takeback) is
   * `is_recoupment = true` AND must create a check for the positive side. A
   * constraint keyed on `is_recoupment` would have accepted `posted` on that
   * plan with `od_claim_payment_num` NULL — precisely the false-`posted` the
   * constraint exists to stop.
   *
   * So the column records the SHAPE of the plan rather than a flag about its
   * contents: true when it carries at least one ordinary (non-supplemental)
   * line, false only for a plan that is takebacks and nothing else.
   *
   * DEFAULT true, and that direction is deliberate. An un-derived plan DEMANDS
   * its check number before it may say `posted`; the failure mode of the
   * default is a refusal, never a false claim that money landed.
   */
  pgm.addColumns('rcm_posting_queue', {
    requires_check: { type: 'boolean', notNull: true, default: true },
  });

  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_posted_proof_check');
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_posted_proof_check', {
    check: `status <> 'posted'
            OR (reconciled_at IS NOT NULL
                AND (od_claim_payment_num IS NOT NULL OR requires_check = false))`,
  });

  // ── 2. The EOB filing, on its own axis ────────────────────────────────────
  pgm.addColumns('rcm_posting_queue', {
    /**
     * NULL means NOT ATTEMPTED, and that is a third state rather than a missing
     * value: the attach runs only after a plan reaches `posted`, so every plan
     * that is not yet posted legitimately has nothing here. A screen renders
     * null as "not filed yet", never as a failure.
     */
    document_attach_status: { type: 'text' },
    /** Why the last attempt did not file. Prose for a human; never PHI. */
    document_attach_error: { type: 'text' },
    /** When the last attempt ran — set on success AND on failure. */
    document_attach_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_document_attach_check', {
    check: `document_attach_status IS NULL
            OR document_attach_status IN (${quoted(DOCUMENT_ATTACH_STATUSES)})`,
  });

  /*
   * ONE ROW PER PATIENT PER PLAN, because a document is filed into a PATIENT's
   * images and a plan can span several patients.
   *
   * This is a table rather than a jsonb blob on the queue for one reason: the
   * retry has to be able to say "these two filed, that one did not" and act on
   * only the third. A blob would make partial progress something the code
   * re-derives on every attempt, and re-deriving is what adopt-before-create
   * exists to stop.
   */
  pgm.createTable('rcm_posting_document', {
    posting_document_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    // Frozen internal office keys. In EVERY key on this table, because DocNum
    // and PatNum numbering restart in every Open Dental database.
    office_id: { type: 'text', notNull: true },
    queue_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_posting_queue',
      onDelete: 'CASCADE',
    },
    /** The chart the PDF was filed into. An identifier, never a name. */
    od_patient_id: { type: 'bigint', notNull: true },
    /**
     * The DocNum Open Dental returned, READ BACK via `GET /documents?PatNum=`.
     * Null while pending or failed — G2 again: the upload's own response is not
     * evidence that a document exists.
     */
    od_doc_num: { type: 'bigint' },
    /**
     * The description we filed it under. Stored because it is also the
     * ADOPT-BEFORE-CREATE key: the next attempt lists the patient's documents
     * and skips if one already carries this exact description, so a retry after
     * a lost response does not file the same EOB twice.
     */
    description: { type: 'text', notNull: true },
    /** `pending` | `attached` | `failed`. */
    status: { type: 'text', notNull: true, default: 'pending' },
    error: { type: 'text' },
    attached_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('rcm_posting_document', 'rcm_posting_document_office_check', {
    check: "office_id IN ('roland', 'valley')",
  });
  pgm.addConstraint('rcm_posting_document', 'rcm_posting_document_status_check', {
    check: "status IN ('pending','attached','failed')",
  });
  /*
   * `attached` IMPLIES A DocNum, AND A DocNum IMPLIES `attached`.
   *
   * The same pairing rule `blocked_reason` and `skip_reason` carry. A row
   * claiming a document was filed without saying which one is a claim nobody can
   * check; a DocNum on a failed row is a stale success rendered over a retry.
   */
  pgm.addConstraint('rcm_posting_document', 'rcm_posting_document_attached_proof_check', {
    check: `(status = 'attached' AND od_doc_num IS NOT NULL AND attached_at IS NOT NULL)
            OR (status <> 'attached' AND od_doc_num IS NULL)`,
  });
  /*
   * ONE DOCUMENT PER PATIENT PER PLAN, enforced by the database rather than by
   * the code that files it. This is the same class of guarantee as
   * `rcm_posting_queue_line`'s claimproc index: the retry path is the one most
   * likely to be re-entered concurrently, and a duplicate EOB in a patient's
   * images is a mess somebody has to clean up by hand in Open Dental.
   */
  pgm.addConstraint('rcm_posting_document', 'rcm_posting_document_one_per_patient_unique', {
    unique: ['office_id', 'queue_id', 'od_patient_id'],
  });
  // The retry's own scan: this plan's unfiled patients.
  pgm.createIndex('rcm_posting_document', ['office_id', 'queue_id', 'status'], {
    name: 'rcm_posting_document_retry_idx',
  });

  // ── 3. What a recoupment line actually wrote ──────────────────────────────
  pgm.dropConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_status_check');
  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_status_check', {
    check: `status IN (${quoted(LINE_STATUSES)})`,
  });

  pgm.addColumns('rcm_posting_queue_line', {
    /** Which path this takeback was written by. See RECOUPMENT_PATHS above. */
    recoupment_path: { type: 'text' },
    /**
     * `POST /adjustments` → AdjNum. The reversible path, and the only id in this
     * module that a teardown can actually delete — `rcm-s11-unwind.js` reads it
     * off the manifest.
     */
    od_adjustment_num: { type: 'bigint' },
    /**
     * `POST /claimprocs/Supplemental` → the NEW ClaimProcNum it minted.
     *
     * Deliberately not written over `od_claim_proc_num`: that column names the
     * already-paid line the takeback is aimed AT, and the supplemental is a
     * second, separate row in the chart. Overwriting the target would lose which
     * adjudication was being reversed — and this id can never be deleted (G10),
     * so it is also the permanent record of what this module did.
     */
    od_supplemental_claim_proc_num: { type: 'bigint' },
  });

  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_recoupment_path_check', {
    check: `recoupment_path IS NULL OR recoupment_path IN (${quoted(RECOUPMENT_PATHS)})`,
  });
  /*
   * A PATH IS ONLY MEANINGFUL ON A SUPPLEMENTAL LINE.
   *
   * `is_supplemental` is what the money guard keys on — the partial unique index
   * on `(office_id, od_claim_proc_num) WHERE is_supplemental = false` exists
   * because a takeback targets an already-paid claimproc and would collide under
   * a total index. Letting an ordinary line carry a recoupment path would put a
   * row on the wrong side of that index while claiming to be a takeback.
   */
  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_recoupment_shape_check', {
    check: `recoupment_path IS NULL OR is_supplemental = true`,
  });
  /*
   * EACH PATH LEAVES EXACTLY ITS OWN ID, AND NEVER THE OTHER'S.
   *
   * The two are not interchangeable: one can be deleted and one cannot. A row
   * holding both would make "is this reversible" unanswerable, which is the one
   * question a takeback has to be able to answer.
   */
  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_recoupment_ids_check', {
    check: `(od_adjustment_num IS NULL OR recoupment_path = 'adjustment')
            AND (od_supplemental_claim_proc_num IS NULL OR recoupment_path = 'supplemental')`,
  });

  // ── 4. Grants, re-asserted for the new table ──────────────────────────────
  //
  // Same reasoning as the 6c migration: a table created after the role's grants
  // were issued is a table the app cannot read, and the failure surfaces as a
  // permission error in the middle of a drain rather than at deploy time.
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I',
                       'rcm_posting_document', r);
        RAISE NOTICE 'rcm 6d: grants applied to rcm_posting_document for role %', r;
      ELSE
        RAISE NOTICE 'rcm 6d: app role % absent — grants SKIPPED.', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_recoupment_ids_check');
  pgm.dropConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_recoupment_shape_check');
  pgm.dropConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_recoupment_path_check');
  pgm.dropColumns('rcm_posting_queue_line', [
    'recoupment_path',
    'od_adjustment_num',
    'od_supplemental_claim_proc_num',
  ]);
  pgm.dropConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_status_check');
  pgm.addConstraint('rcm_posting_queue_line', 'rcm_posting_queue_line_status_check', {
    check: `status IN (${quoted(LINE_STATUSES_6C)})`,
  });

  pgm.dropTable('rcm_posting_document');

  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_document_attach_check');
  pgm.dropColumns('rcm_posting_queue', [
    'document_attach_status',
    'document_attach_error',
    'document_attach_at',
  ]);

  /*
   * ORDER MATTERS HERE, and getting it wrong made `down` fail outright.
   *
   * `rcm_posting_queue_posted_proof_check` REFERENCES `requires_check`, and
   * Postgres silently drops a CHECK when the column it depends on goes — so
   * dropping the column first left the later `dropConstraint` aiming at
   * something that no longer existed, and the whole rollback errored.
   *
   * Constraint first, then the column, then the 6c constraint back. Found by
   * running it rather than by reading it, which is the only way this kind of
   * thing is ever found.
   */
  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_posted_proof_check');
  pgm.dropColumns('rcm_posting_queue', ['requires_check']);
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_posted_proof_check', {
    check: `status <> 'posted'
            OR (od_claim_payment_num IS NOT NULL AND reconciled_at IS NOT NULL)`,
  });
};

module.exports.LINE_STATUSES = LINE_STATUSES;
module.exports.RECOUPMENT_PATHS = RECOUPMENT_PATHS;
module.exports.DOCUMENT_ATTACH_STATUSES = DOCUMENT_ATTACH_STATUSES;
