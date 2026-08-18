'use strict';

/**
 * Per-tenant data-plane: the RCM review workbench's match + review state
 * (Slice 6a).
 *
 * ADDITIVE ONLY. Columns on two existing tables, no new tables, no data
 * migration — the Slice 1 schema was designed for this and already carries the
 * Open Dental linkage columns (`rcm_claims.od_patient_id` / `od_claim_num`,
 * `rcm_procedure_lines.od_claim_proc_num`). What it did NOT carry is the
 * evidence behind a linkage, whether a human has confirmed it, and whether a
 * search that found nothing actually ran.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SNAPSHOT AND NOT JUST A ClaimNum
 * ─────────────────────────────────────────────────────────────────────────────
 * Slice 6c posts money against a chart that may have moved since the match was
 * confirmed — a second EOB may have landed, a line may have been zeroed, a
 * check may have been attached. RCM_OD_WRITES §2 is explicit that a claimproc
 * with a ClaimPayment attached REFUSES an InsPayAmt update, and §G12 that a
 * soft-deleted procedure keeps appearing in list reads. So 6c must re-verify
 * at drain time, and re-verify means *compare against what we saw*.
 *
 * `od_match_snapshot` is that "what we saw": the candidate claims, the evidence
 * for each, the OD amounts AS READ, the per-line ClaimProcNums, and the instant
 * they were read. It is a record of a past observation, never a cache to serve
 * from — nothing in this slice or the next reads a dollar figure out of it and
 * calls it current.
 *
 * PER-LINE OD FACTS LIVE IN THE SNAPSHOT, NOT ON THE LINE ROW. The Slice 1
 * schema dropped `bankTransactions.matchedClaimIds` for exactly this reason:
 * "Carrying both lets them disagree." `rcm_procedure_lines.od_claim_proc_num`
 * is the CONFIRMED linkage — one number a human stood behind — and the amounts
 * that justified it stay in one place on the claim.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONEST STATES (hard rule 4)
 * ─────────────────────────────────────────────────────────────────────────────
 * `od_match_status` distinguishes four facts that a nullable `od_claim_num`
 * cannot tell apart:
 *
 *   not_run       Nobody has looked. NOT the same as "we looked and found none".
 *   candidates    A search ran and returned candidates. NOBODY HAS CHOSEN.
 *   no_candidate  A search ran against this office's Open Dental and found
 *                 nothing. A first-class outcome with a timestamp, because
 *                 "we checked on Tuesday and there is no such claim" is
 *                 information a biller acts on.
 *   confirmed     A human picked one. `od_claim_num` is meaningful ONLY here.
 *
 * There is deliberately no value meaning "probably this one". Hard rule: no
 * auto-match ever decides anything (Slice 6a, decision in force). The scorer
 * ranks and explains; the transition to `confirmed` is a human act, attributed
 * through `od_matched_by`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A PatNum NEEDS AN OFFICE (hard rule 3) — and already has one
 * ─────────────────────────────────────────────────────────────────────────────
 * Every rcm_* row carries `office_id` with a CHECK, so a stored `od_claim_num`
 * or `od_patient_id` is inseparable from the practice database it came from.
 * No `od_*_office` column is added here because there is nowhere for one to
 * disagree with: the office is on the same row, on the parent, and on the
 * child. `assertOfficeMatch(office, getOdOffice(office))` at every call site is
 * what keeps a Riley PatNum from ever being written under `office_id='roland'`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REVIEWED IS NOT MATCHED
 * ─────────────────────────────────────────────────────────────────────────────
 * `reviewed_at` / `reviewed_by` / `review_note` are worklist hygiene with NO
 * Open Dental effect whatsoever. A biller can mark a claim reviewed with a note
 * saying "carrier owes a corrected EOB, nothing to post" — that is a real
 * outcome, and conflating it with a chart linkage would make the worklist lie
 * in both directions.
 *
 * Grants: additive columns inherit the table's existing grants, so no GRANT
 * block is needed here (see the Slice 1 migration for the per-table path).
 * `audit_log` is not mentioned by this migration and stays append-only.
 */

/** @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder */

/**
 * The four honest states of a claim's Open Dental linkage.
 * Exported so the route layer and its tests read the same list the CHECK does.
 */
const OD_MATCH_STATUSES = Object.freeze(['not_run', 'candidates', 'no_candidate', 'confirmed']);

/**
 * An actor column — the crosswalk-typed FK the Slice 1 migration established.
 * RESTRICT because attribution must not be erasable by deleting a user row.
 * NULL means system / automated, which for these columns means "never set".
 */
const ACTOR = { type: 'text', references: 'rcm_user_map', onDelete: 'RESTRICT' };

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('rcm_claims', {
    // ── The match ──────────────────────────────────────────────────────────
    od_match_status: { type: 'text', notNull: true, default: 'not_run' },
    // Candidates + evidence + OD amounts as read + fetched_at. See the header:
    // a record of an observation, not a cache.
    od_match_snapshot: { type: 'jsonb' },
    // When the SEARCH last ran. Kept separate from the confirmation instant so
    // "when did we last look" is never inferred from "when did someone decide",
    // the same separation rcm_posting_queue makes between approved_at and
    // started_at.
    od_match_at: { type: 'timestamptz' },
    od_match_confirmed_at: { type: 'timestamptz' },
    od_matched_by: ACTOR,

    // ── The local review marker (no Open Dental effect) ─────────────────────
    reviewed_at: { type: 'timestamptz' },
    reviewed_by: ACTOR,
    review_note: { type: 'text' },
  });

  pgm.addConstraint('rcm_claims', 'rcm_claims_od_match_status_check', {
    check: `od_match_status IN (${OD_MATCH_STATUSES.map((s) => `'${s}'`).join(', ')})`,
  });

  /*
   * `od_claim_num` is meaningful ONLY in the confirmed state, and this is what
   * makes that a database guarantee rather than a convention. Without it a
   * failed re-match could leave a stale ClaimNum on a row whose status says
   * nothing was chosen — and Slice 6c reads `od_claim_num` to decide which
   * chart to touch.
   *
   * Stated in the permissive direction (a confirmed row MUST have one; every
   * other state MUST NOT) so both halves are enforced.
   */
  pgm.addConstraint('rcm_claims', 'rcm_claims_od_claim_num_confirmed_check', {
    check: `(od_match_status = 'confirmed' AND od_claim_num IS NOT NULL)
            OR (od_match_status <> 'confirmed' AND od_claim_num IS NULL)`,
  });

  /*
   * A confirmation is an attributed act (decision D-5). `od_matched_by` is a FK
   * to rcm_user_map, which the route auto-upserts from the SSO identity on the
   * first RCM action — so this constraint is satisfiable without anyone
   * pre-seeding a staff crosswalk, and a confirmation with no name attached is
   * impossible rather than merely discouraged.
   */
  pgm.addConstraint('rcm_claims', 'rcm_claims_od_match_attribution_check', {
    check: `od_match_status <> 'confirmed'
            OR (od_matched_by IS NOT NULL AND od_match_confirmed_at IS NOT NULL)`,
  });

  /* Same rule for the review marker: reviewed means somebody reviewed it. */
  pgm.addConstraint('rcm_claims', 'rcm_claims_reviewed_attribution_check', {
    check: `(reviewed_at IS NULL AND reviewed_by IS NULL)
            OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)`,
  });

  /*
   * The workbench's default view is "needs attention", which is every claim
   * that is not confirmed-and-reviewed. Indexed on the pair the list filters
   * on, office first — every RCM query is office-scoped by construction.
   */
  pgm.createIndex('rcm_claims', ['office_id', 'od_match_status'], {
    name: 'rcm_claims_office_od_match_idx',
  });
  pgm.createIndex('rcm_claims', ['office_id', 'reviewed_at'], {
    name: 'rcm_claims_office_reviewed_idx',
  });

  /*
   * WHO BROUGHT THIS DOCUMENT IN.
   *
   * `rcm_eob_uploads` records what was uploaded and when, and — until now — not
   * by whom. Slices 4 and 5 could not record it: every actor column in this
   * schema is a FK to `rcm_user_map`, and there was no way to satisfy that FK
   * for a live SSO user, so Slice 5's doc states plainly that
   * "`rcm_payment_batches.created_by` is NULL … the staff crosswalk is deferred
   * to Slice 6. Attribution lives in `audit_log` until then."
   *
   * D-5 is what discharges that: services/rcm/rcmUserMap.js upserts the acting
   * user on their first RCM action, so both upload routes can now stamp this
   * column. Rows created before this migration keep NULL, and the workbench
   * renders that as "not recorded" rather than as a system upload — a document
   * a person uploaded in August did not stop having an uploader because the
   * column arrived in September.
   */
  pgm.addColumns('rcm_eob_uploads', { uploaded_by: ACTOR });
};

/**
 * Reverse of up(). Dropping the columns drops their constraints and indexes.
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('rcm_eob_uploads', ['uploaded_by']);
  pgm.dropColumns('rcm_claims', [
    'od_match_status',
    'od_match_snapshot',
    'od_match_at',
    'od_match_confirmed_at',
    'od_matched_by',
    'reviewed_at',
    'reviewed_by',
    'review_note',
  ]);
};

// Exported for the route layer and backend/test/rcmSchemaMigration.test.js, so
// the CHECK and the code read one list.
exports.OD_MATCH_STATUSES = OD_MATCH_STATUSES;
