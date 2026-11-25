'use strict';

/**
 * tc_messages: APPROVED UP FRONT (EL-2c, Beau 2026-11-25).
 *
 *   "Nothing sends that a human has not approved word for word. Approved
 *    emails send on their scheduled date unless a stop condition fires."
 *
 * A library nurture campaign is written in full when it starts: every step is
 * a 'draft' with a planned send time. A person approves each one word for
 * word (draft → 'scheduled'). THIS SLICE HAS NO SENDER: a 'scheduled' row
 * waits. The automatic sender is EL-2d, reviewed on its own.
 *
 *   scheduled_for  the planned send time (Mon–Fri 09:00–16:00 office time).
 *                  Set on every library draft; NULL on every other message.
 *   approved_by    who approved it (an SSO email), and
 *   approved_at    when. Both set exactly while the row is 'scheduled';
 *                  Unapprove clears them.
 *   skip_reason    why a 'skipped' row was skipped: manual, case_terminal,
 *                  opted_out, stopped_by_user. NULL on rows skipped before
 *                  EL-2c, and on every row that is not skipped.
 *
 * CHECK LITERALS INLINE (house rule):
 *   - status: a STRICT SUPERSET of 1791100000000's list, adding 'scheduled'.
 *   - tc_messages_scheduled_check: a 'scheduled' row carries approved_by,
 *     approved_at, scheduled_for AND enrollment_id. WRITTEN NULL-SAFE: a CHECK
 *     that evaluates to NULL PASSES (the #359 lesson), so every term here is
 *     two-valued — `IS DISTINCT FROM` and `IS NOT NULL` never yield NULL.
 *   - tc_messages_skip_reason_check: NULL, or one of the four reasons on a
 *     'skipped' row. `skip_reason IS NULL OR (...)`: when skip_reason is not
 *     NULL both inner terms are two-valued (status is NOT NULL).
 *
 * The partial index is the EL-2d sender's scan (this office's approved emails
 * by planned time) and the outbox's sort. No new grants: ALTERs on a table the
 * app role already reads and writes (1790300000000_tc_messaging.js).
 *
 * NUMBERING: the newest tenant migration on origin/develop at authoring time
 * was 1795500000000_tc_nurture_library.js (PR #359); 1795600000000 sorts after
 * it. Re-checked at push (see the EL-2c report).
 *
 * Proven against real Postgres by scripts/tc-nurture-approve-verify-queries.js
 * (CI runs it after migrate).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const TABLE = 'tc_messages';
const STATUS_CHECK = 'tc_messages_status_check';
const SCHEDULED_CHECK = 'tc_messages_scheduled_check';
const SKIP_REASON_CHECK = 'tc_messages_skip_reason_check';
const SCHEDULED_INDEX = 'tc_messages_scheduled_idx';

/** The status list before this migration (1791100000000_tc_nurture.js). */
const STATUS_BEFORE =
  "status IN ('draft', 'queued', 'sending', 'sent', 'delivered', 'failed', 'received', 'skipped')";
/** …and after: the same list plus 'scheduled', last. */
const STATUS_AFTER =
  "status IN ('draft', 'queued', 'sending', 'sent', 'delivered', 'failed', 'received', 'skipped', 'scheduled')";
const SCHEDULED_RULE =
  "status IS DISTINCT FROM 'scheduled' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND scheduled_for IS NOT NULL AND enrollment_id IS NOT NULL)";
const SKIP_REASON_RULE =
  "skip_reason IS NULL OR (status = 'skipped' AND skip_reason IN ('manual', 'case_terminal', 'opted_out', 'stopped_by_user'))";

exports.TABLE = TABLE;
exports.STATUS_CHECK = STATUS_CHECK;
exports.SCHEDULED_CHECK = SCHEDULED_CHECK;
exports.SKIP_REASON_CHECK = SKIP_REASON_CHECK;
exports.SCHEDULED_INDEX = SCHEDULED_INDEX;
exports.STATUS_BEFORE = STATUS_BEFORE;
exports.STATUS_AFTER = STATUS_AFTER;
exports.SCHEDULED_RULE = SCHEDULED_RULE;
exports.SKIP_REASON_RULE = SKIP_REASON_RULE;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns(TABLE, {
    scheduled_for: { type: 'timestamptz', notNull: false },
    approved_by: { type: 'text', notNull: false },
    approved_at: { type: 'timestamptz', notNull: false },
    skip_reason: { type: 'text', notNull: false },
  });
  pgm.dropConstraint(TABLE, STATUS_CHECK, { ifExists: true });
  pgm.addConstraint(TABLE, STATUS_CHECK, { check: STATUS_AFTER });
  pgm.addConstraint(TABLE, SCHEDULED_CHECK, { check: SCHEDULED_RULE });
  pgm.addConstraint(TABLE, SKIP_REASON_CHECK, { check: SKIP_REASON_RULE });
  pgm.createIndex(TABLE, ['office_id', 'scheduled_for'], {
    name: SCHEDULED_INDEX,
    where: "status = 'scheduled'",
  });
};

/**
 * Approved emails go back to being drafts (nothing was sent from them: EL-2c
 * has no sender), then the CHECKs narrow and the columns go. A draft keeps its
 * text; only its planned time and approval are lost.
 *
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.sql("UPDATE tc_messages SET status = 'draft' WHERE status = 'scheduled'");
  pgm.dropIndex(TABLE, ['office_id', 'scheduled_for'], { name: SCHEDULED_INDEX, ifExists: true });
  pgm.dropConstraint(TABLE, SKIP_REASON_CHECK, { ifExists: true });
  pgm.dropConstraint(TABLE, SCHEDULED_CHECK, { ifExists: true });
  pgm.dropConstraint(TABLE, STATUS_CHECK, { ifExists: true });
  pgm.addConstraint(TABLE, STATUS_CHECK, { check: STATUS_BEFORE });
  pgm.dropColumns(TABLE, ['scheduled_for', 'approved_by', 'approved_at', 'skip_reason'], { ifExists: true });
};
