'use strict';

/**
 * A LINE THE SCAN MISSED — and a line the scan invented.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The confirm step (`…_rcm_eob_field_confirm.js`) lets a person check or correct
 * every figure the read produced. It has no answer for a figure the read never
 * produced at all: a procedure line printed on the EOB that the reader skipped.
 *
 * That is not a rare case on a scanned document — a page break, a faint row, a
 * subtotal mistaken for a line — and its consequence is precise. The claim's
 * lines no longer sum to the claim total, `CLAIM_TOTALS_AGREE` refuses, and the
 * refusal is one a biller can do nothing about: every figure on the screen is
 * right, and the one that is missing is not on the screen to correct.
 *
 * So she can type it in from the page. ADDING LINES IS HOW AN INCOMPLETE READ
 * BECOMES ABLE TO RECONCILE — it is never a way around the arithmetic. An added
 * line counts in the sum exactly like one the reader found, which is the whole
 * point: the sum is the thing that then goes from "does not add up" to "adds up".
 *
 * The mirror case is the same act backwards. If the read invented a line that is
 * not on the page, she strikes it with a reason, and it stops counting.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXTRACTION IS IMMUTABLE. THIS IS BESIDE IT, LIKE THE CONFIRMATIONS.
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing here touches `rcm_procedure_lines`, `rcm_claims` or
 * `raw_extracted_json`. An added line does not become an extraction row, and a
 * struck line is not deleted from one — striking writes a row saying a person
 * read the page and that line is not on it. "What did the machine produce"
 * stays answerable for ever, which is the property the confirm slice is built
 * on and the only thing that makes a typed figure safe.
 *
 * Downstream readers never join these tables by hand. They go through
 * `services/rcm/confirmedFigures.js`, which is the one thing in the codebase
 * that decides what a claim's lines are and what each figure on them is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TYPING A FIGURE HERE IS TRANSCRIPTION, NOT A DECISION (owner ruling)
 * ─────────────────────────────────────────────────────────────────────────────
 * Same ruling, same scope as the confirm step: the module's no-amount-fields
 * rule governs DECISIONS, where a typed number creates money movement out of
 * somebody's judgement. This figure already exists, printed on paper, and she is
 * copying it across. The ruling is scoped to that one screen and nothing else
 * may read it as precedent.
 *
 * What makes it safe is the trail. Every added line records who added it and
 * when; every strike records who, when and why; and the screen marks an added
 * line as human-added wherever it appears, for as long as it exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO OPEN DENTAL ANYTHING
 * ─────────────────────────────────────────────────────────────────────────────
 * This migration writes nothing to a chart and knows of no chart. An added line
 * carries no ClaimProcNum and cannot be paired to one — which is exactly why the
 * approval gate withholds a claim that has one, rather than posting a line Open
 * Dental never heard of.
 */

/** Frozen internal office keys — matches every other RCM table. */
const OFFICE_CHECK = "office_id IN ('roland', 'valley')";

/**
 * The money columns an added line carries.
 *
 * The same five the extraction stores per line and the same five the confirm
 * step confirms, so an added line and a read line are the same shape to
 * everything downstream. A sixth here would be a figure the confirm screen has
 * no row for.
 */
const MONEY_COLUMNS = [
  'billed_cents',
  'allowed_cents',
  'deductible_cents',
  'copay_cents',
  'paid_cents',
];

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ── 1. A line a person read off the page and typed in ──────────────────────
  //
  // PHI: every money column is an amount on a patient's claim, and the row
  // points at a claim. Treated as PHI throughout.
  pgm.createTable('rcm_eob_added_lines', {
    added_line_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    /**
     * THE CHECK IS THE ANCHOR, so the batch is the row's home — the same reason
     * the confirmations table is keyed to the batch. The thing being established
     * is "this check has been read correctly", and the whole added-line state for
     * a check is then one indexed read.
     */
    batch_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_payment_batches',
      onDelete: 'CASCADE',
    },
    /** NOT NULL: a line belongs to a patient's claim. There is no loose line. */
    claim_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_claims',
      onDelete: 'CASCADE',
    },
    /** The procedure code as printed. Not validated against a code set here. */
    code: { type: 'text', notNull: true },
    /** What the page calls it, if anything. Optional: the code is the identity. */
    description: { type: 'text' },

    /**
     * THE FIGURES, EVERY ONE NULLABLE — and null is a real answer.
     *
     * "The page does not state an allowed amount for this line" is the ordinary
     * case on a category-subtotal EOB, and a NOT NULL DEFAULT 0 here would force
     * her to invent a zero. Zero asserts the plan allowed nothing, which is a
     * claim about a patient's balance. Those are different facts, and this is the
     * same distinction `paid_cents` on the extraction table was made nullable for.
     */
    billed_cents: { type: 'bigint' },
    allowed_cents: { type: 'bigint' },
    deductible_cents: { type: 'bigint' },
    copay_cents: { type: 'bigint' },
    paid_cents: { type: 'bigint' },

    /** D-5 crosswalk key. NOT NULL: a line with no author is not a transcription. */
    added_by: {
      type: 'text',
      notNull: true,
      references: 'rcm_user_map',
      onDelete: 'RESTRICT',
    },
    added_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('rcm_eob_added_lines', 'rcm_eob_added_lines_office_check', {
    check: OFFICE_CHECK,
  });

  /*
   * A LINE WITH NO CODE IS NOT A LINE.
   *
   * The code is what makes the row identifiable on the page and what a person
   * pairing it to a chart would look for. An empty string would store a row that
   * counts in the arithmetic and names nothing, which is an unaccountable figure
   * — the exact thing this whole slice exists to stop.
   */
  pgm.addConstraint('rcm_eob_added_lines', 'rcm_eob_added_lines_code_check', {
    check: 'length(btrim(code)) > 0',
  });

  /*
   * NO NEGATIVE FIGURE ON AN ADDED LINE.
   *
   * A negative amount on an EOB is a takeback, which is its own lane with its own
   * acknowledgement and its own irreversible posting path. It is not something to
   * transcribe on a confirm screen, and the route refuses it before the database
   * sees it — this is the backstop, not the error message.
   */
  for (const column of MONEY_COLUMNS) {
    pgm.addConstraint('rcm_eob_added_lines', `rcm_eob_added_lines_${column}_check`, {
      check: `${column} IS NULL OR ${column} >= 0`,
    });
  }

  /** The screen's and the gate's read: every added line on this check, one scan. */
  pgm.createIndex('rcm_eob_added_lines', ['office_id', 'batch_id'], {
    name: 'rcm_eob_added_lines_office_batch_idx',
  });

  /*
   * AND BY CLAIM, for the workbench.
   *
   * The workbench opens a claim, not a check, and it has to show the same lines
   * the confirm screen does or the two screens disagree about what a claim was
   * paid. Without this index that read is a sequential scan of every added line
   * in the practice.
   */
  pgm.createIndex('rcm_eob_added_lines', ['office_id', 'claim_id'], {
    name: 'rcm_eob_added_lines_office_claim_idx',
  });

  // ── 2. A line a person says is not on the page ─────────────────────────────
  pgm.createTable('rcm_eob_line_strikes', {
    strike_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    batch_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_payment_batches',
      onDelete: 'CASCADE',
    },
    claim_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_claims',
      onDelete: 'CASCADE',
    },

    /**
     * WHICH LINE — exactly one of these two, each a real foreign key.
     *
     * Two nullable references rather than one id column that could mean either:
     * a single polymorphic column would have to carry its own "which table" flag,
     * and nothing but application code would stop the flag and the id
     * disagreeing. Here the database refuses a strike against a line that does
     * not exist, in either table, and `num_nonnulls` below refuses one that
     * points at both or at neither.
     */
    line_id: { type: 'uuid', references: 'rcm_procedure_lines', onDelete: 'CASCADE' },
    added_line_id: { type: 'uuid', references: 'rcm_eob_added_lines', onDelete: 'CASCADE' },

    /**
     * WHY. NOT NULL, and the route refuses an empty one.
     *
     * A line vanishing from a claim's arithmetic with no recorded reason is a
     * figure that changed and cannot be accounted for. "OCR read the subtotal row
     * as a procedure" is the kind of sentence the next person needs.
     */
    reason: { type: 'text', notNull: true },

    /** D-5 crosswalk key. NOT NULL: a strike with no author is not one. */
    struck_by: {
      type: 'text',
      notNull: true,
      references: 'rcm_user_map',
      onDelete: 'RESTRICT',
    },
    struck_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },

    /**
     * TAKEN BACK — because a mis-strike must not be a dead end.
     *
     * Striking a real line removes it from the sum, so a strike pressed by
     * mistake leaves a check that can never reconcile and a biller with nothing
     * to press. So a strike can be withdrawn, and the row stays: the trail says
     * she struck it, then changed her mind, and both are true. A DELETE would
     * erase the first half, which is why the app role holds no DELETE on this
     * table either.
     */
    withdrawn_at: { type: 'timestamptz' },
    withdrawn_by: { type: 'text', references: 'rcm_user_map', onDelete: 'RESTRICT' },

    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('rcm_eob_line_strikes', 'rcm_eob_line_strikes_office_check', {
    check: OFFICE_CHECK,
  });

  /** Exactly one target. Not both, and not neither. */
  pgm.addConstraint('rcm_eob_line_strikes', 'rcm_eob_line_strikes_one_target_check', {
    check: 'num_nonnulls(line_id, added_line_id) = 1',
  });

  pgm.addConstraint('rcm_eob_line_strikes', 'rcm_eob_line_strikes_reason_check', {
    check: 'length(btrim(reason)) > 0',
  });

  /** A withdrawal has a time and a name, or it has neither. */
  pgm.addConstraint('rcm_eob_line_strikes', 'rcm_eob_line_strikes_withdrawn_check', {
    check: '(withdrawn_at IS NULL) = (withdrawn_by IS NULL)',
  });

  /*
   * ONE LIVE STRIKE PER LINE — partial, so a withdrawn strike does not block a
   * second one.
   *
   * Without this a line could carry two live strikes with different reasons, and
   * the accessor would be reading one of them arbitrarily to decide what to tell
   * a biller about a line that stopped counting.
   *
   * Two indexes rather than one over both columns: a unique index over
   * `(office_id, line_id, added_line_id)` would be satisfied by any two rows
   * whose null column differs, which is every pair.
   */
  pgm.sql(`
    CREATE UNIQUE INDEX rcm_eob_line_strikes_live_extracted_unique
      ON rcm_eob_line_strikes (office_id, line_id)
      WHERE line_id IS NOT NULL AND withdrawn_at IS NULL
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX rcm_eob_line_strikes_live_added_unique
      ON rcm_eob_line_strikes (office_id, added_line_id)
      WHERE added_line_id IS NOT NULL AND withdrawn_at IS NULL
  `);

  pgm.createIndex('rcm_eob_line_strikes', ['office_id', 'batch_id'], {
    name: 'rcm_eob_line_strikes_office_batch_idx',
  });
  pgm.createIndex('rcm_eob_line_strikes', ['office_id', 'claim_id'], {
    name: 'rcm_eob_line_strikes_office_claim_idx',
  });

  // ── 3. Grants ─────────────────────────────────────────────────────────────
  // Same role-guarded mechanism as audit_log, tc_schema, rcm_ocr and the
  // confirmations table: if the least-privilege role is absent — a local
  // superuser database — the grant is SKIPPED with a NOTICE rather than failing
  // the migration.
  //
  // NO DELETE, on either table. An added line is never removed, only struck; a
  // strike is never removed, only withdrawn. Both of those are UPDATEs or INSERTs
  // that leave the earlier statement readable, and that is the point: the trail
  // is the thing that makes a typed figure safe. The ON DELETE CASCADE from the
  // batch is enforced by the referential action, not by the app role.
  pgm.sql(`
    DO $$
    DECLARE
      r text := '${APP_ROLE}';
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE rcm_eob_added_lines TO %I', r);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE rcm_eob_line_strikes TO %I', r);
        RAISE NOTICE 'rcm_eob_added_lines: grants applied for role %', r;
      ELSE
        RAISE NOTICE 'rcm_eob_added_lines: app role % absent — grants SKIPPED (local superuser database).', r;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  /*
   * REFUSES RATHER THAN DISCARDS — the same stance as the confirm migration's
   * down().
   *
   * Every row in these two tables is something a person read off a document and
   * typed, and there is nowhere else it exists: an added line is not in the
   * extraction, and a strike is the only record that a read line is not on the
   * page. Dropping the tables while they hold rows would destroy the only copy of
   * work somebody did, and the arithmetic downstream would silently revert to the
   * incomplete read that made the work necessary.
   *
   * An empty pair of tables rolls back cleanly, which is the case a rollback
   * shortly after a deploy actually is.
   */
  pgm.sql(`
    DO $$
    DECLARE
      added bigint;
      strikes bigint;
    BEGIN
      SELECT count(*) INTO added FROM rcm_eob_added_lines;
      SELECT count(*) INTO strikes FROM rcm_eob_line_strikes;
      IF added > 0 OR strikes > 0 THEN
        RAISE EXCEPTION
          'refusing to drop hand-entered EOB lines: % added line(s) and % strike(s) exist. They are not recorded anywhere else.',
          added, strikes;
      END IF;
    END $$;
  `);

  // Strikes first: they reference the added lines.
  pgm.dropTable('rcm_eob_line_strikes');
  pgm.dropTable('rcm_eob_added_lines');
};
