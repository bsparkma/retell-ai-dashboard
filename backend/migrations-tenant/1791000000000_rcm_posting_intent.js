'use strict';

/**
 * W-21 — WRITE-AHEAD INTENT, AND A WORD FOR "WE DO NOT KNOW". ADDITIVE ONLY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS EXISTS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * The drain's catch used to decide a plan's ending from WHICH STEP the run died
 * at: a fixed list of "touched the chart" steps meant `partially_posted`, and
 * anything else meant `failed`. The list left out `office_writeoffs` and
 * `confirm_patient` — both of which run AFTER the check exists — so a crash in
 * either wrote `failed` over a plan whose payment was already in the chart. A
 * biller reading "failed" reads "nothing was written", re-enters the payment by
 * hand, and the patient is double-posted.
 *
 * A crash is not evidence of anything having NOT happened. This migration gives
 * the drain somewhere to record, before each Open Dental write leaves the
 * process, exactly what it is about to attempt — so a run that dies one
 * instruction later still leaves a trace the ending can be judged from.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. `rcm_posting_intent` — one row per Open Dental WRITE, committed first
 * ─────────────────────────────────────────────────────────────────────────────
 * Written by `services/rcm/postingIntent.js` and nothing else, BEFORE the call,
 * and `odPostingWrites.js` refuses to issue a write without the receipt that
 * INSERT returns. `outcome` starts `pending` and is settled by evidence only:
 *
 *   pending    the write may or may not have landed. Nothing has read the chart
 *              since. THIS is what a crash leaves behind.
 *   landed     a read of the chart after the write shows it, as sent.
 *   disagreed  a read of the chart after the write shows the target, but not as
 *              sent (G2: a 200 that changed nothing, or something else moved it).
 *   absent     a re-read on a later press found no trace of it.
 *   refused    Open Dental answered with a named 4xx refusal for this write.
 *
 * `target` holds identifiers and cents only — ClaimNum, ClaimProcNum, PatNum,
 * DefNum, amounts. The same judgement that puts a PatNum in an audit row's
 * `resourceId`: an identifier, not patient data. No name, no free text.
 *
 * Rows are never deleted. Intents are the write-ahead log of a patient's money;
 * a later attempt adds rows, it never rewrites an earlier attempt's.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. `outcome_unknown` — the queue's eighth word
 * ─────────────────────────────────────────────────────────────────────────────
 * A plan with at least one `pending` intent the drain could not settle. It is
 * NEVER folded into `failed` (which would say nothing moved) or `posted` (which
 * would say everything did). It is DRAINABLE — pressing Post again is a human
 * act, and the next press re-reads Open Dental and settles every pending intent
 * BEFORE any write is retried. It is NOT withdrawable: a plan that may have
 * moved money cannot be retired as though it had not.
 *
 * No existing status changes meaning, and nothing posted becomes un-posted.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

const APP_ROLE = process.env.AUDIT_APP_ROLE || 'carein_app';

/** The row vocabulary AFTER this migration — 1787300000000's seven, plus one. */
const QUEUE_STATUSES = [
  'approved',
  'posting',
  'posted',
  'failed',
  'partially_posted',
  'blocked',
  'withdrawn',
  'outcome_unknown',
];

/** Every Open Dental write `odPostingWrites.js` can issue, one slug each. */
const WRITE_KINDS = [
  'claimproc_received',
  'claim_received',
  'claim_payment',
  'writeoff_adjustment',
  'recoupment_adjustment',
  'recoupment_supplemental',
  'document_upload',
];

const OUTCOMES = ['pending', 'landed', 'disagreed', 'absent', 'refused'];

/** `'a','b','c'` for a CHECK ... IN (...) list. */
const quoted = (values) => values.map((v) => `'${v}'`).join(',');

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.createTable('rcm_posting_intent', {
    intent_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    office_id: { type: 'text', notNull: true },
    queue_id: {
      type: 'uuid',
      notNull: true,
      references: 'rcm_posting_queue',
      onDelete: 'RESTRICT',
    },
    /** Null for a write that belongs to a patient rather than a line (the EOB). */
    queue_line_id: {
      type: 'uuid',
      references: 'rcm_posting_queue_line',
      onDelete: 'RESTRICT',
    },
    /** The claim this write touches, so recovery can classify CLAIM BY CLAIM. */
    od_claim_num: { type: 'bigint' },
    /** The plan's `attempt_count` when the intent was recorded. */
    attempt: { type: 'integer', notNull: true },
    write_kind: { type: 'text', notNull: true },
    /** Identifiers and cents only. Enough to find the write again on a re-read. */
    target: { type: 'jsonb', notNull: true },
    outcome: { type: 'text', notNull: true, default: 'pending' },
    /** What the read that settled it showed. Money-shaped fields and ids only. */
    evidence: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    resolved_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('rcm_posting_intent', 'rcm_posting_intent_write_kind_check', {
    check: `write_kind IN (${quoted(WRITE_KINDS)})`,
  });
  pgm.addConstraint('rcm_posting_intent', 'rcm_posting_intent_outcome_check', {
    check: `outcome IN (${quoted(OUTCOMES)})`,
  });

  /*
   * PENDING IMPLIES NO EVIDENCE, AND EVIDENCE IMPLIES SETTLED.
   *
   * The same two-way pairing `blocked_reason` has. A settled intent with no
   * evidence would be a verdict nobody can check; a pending one carrying
   * evidence would be a read that was taken and then ignored.
   */
  pgm.addConstraint('rcm_posting_intent', 'rcm_posting_intent_settled_check', {
    check: `(outcome = 'pending' AND resolved_at IS NULL AND evidence IS NULL)
            OR (outcome <> 'pending' AND resolved_at IS NOT NULL AND evidence IS NOT NULL)`,
  });

  pgm.createIndex('rcm_posting_intent', ['office_id', 'queue_id'], {
    name: 'rcm_posting_intent_plan_idx',
  });

  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check');
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check', {
    check: `status IN (${quoted(QUEUE_STATUSES)})`,
  });

  // The new table needs its grant; the queue's is re-asserted out of habit
  // (see 1787300000000). Skips with a NOTICE where the role is absent.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE rcm_posting_intent TO %I', '${APP_ROLE}');
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE rcm_posting_queue TO %I', '${APP_ROLE}');
      ELSE
        RAISE NOTICE 'rcm posting intent: app role ${APP_ROLE} absent — grants SKIPPED.';
      END IF;
    END $$;
  `);
};

/**
 * REFUSES while a plan reads `outcome_unknown` or an intent is still pending.
 *
 * There is no earlier word for either. Rolling back under them would either
 * fail on the re-keyed CHECK or erase the only record that a write may have
 * reached a chart — and that record is the whole point of the table.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM rcm_posting_queue WHERE status = 'outcome_unknown') THEN
        RAISE EXCEPTION 'refusing to roll back: posting plans with an unknown outcome exist.';
      END IF;
      IF EXISTS (SELECT 1 FROM rcm_posting_intent WHERE outcome = 'pending') THEN
        RAISE EXCEPTION 'refusing to roll back: unsettled posting intents exist.';
      END IF;
    END $$;
  `);

  pgm.dropConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check');
  pgm.addConstraint('rcm_posting_queue', 'rcm_posting_queue_status_check', {
    check: `status IN (${quoted(QUEUE_STATUSES.filter((s) => s !== 'outcome_unknown'))})`,
  });
  pgm.dropTable('rcm_posting_intent');
};

module.exports.QUEUE_STATUSES = QUEUE_STATUSES;
module.exports.WRITE_KINDS = WRITE_KINDS;
module.exports.OUTCOMES = OUTCOMES;
