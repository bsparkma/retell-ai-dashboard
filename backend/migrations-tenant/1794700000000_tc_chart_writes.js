'use strict';

/**
 * Per-tenant data-plane (AT-2): tc_chart_writes — one row per TC activity-feed
 * item a person wrote to the patient's Open Dental chart ("Log to chart").
 *
 * It is the CareIN half of the dedupe. UNIQUE (office_id, feed_item_id) means a
 * feed item can reach the chart once, ever: the write route checks for a row
 * under the case's row lock before it touches Open Dental, and the constraint
 * refuses a second row even if two requests somehow both got that far. The
 * Open Dental half of the dedupe (an identical note already on the chart is
 * refused) lives in services/tc/tcChartNote.js.
 *
 * Columns:
 *   write_id          uuid PK.
 *   office_id         the case's office (req.tcOffice) — never the request's.
 *   case_id           the case the item was charted from.
 *   feed_item_id      the AT-1 feed id, "<source>:<rowId>" — an identifier,
 *                     not PHI. The same id the audit row's source_ref carries.
 *   od_patient_id     the PatNum written to, from the CASE ROW. Meaningless
 *                     without office_id: PatNums restart in every database.
 *   commlog_num       the CommlogNum Open Dental minted AND that was read back.
 *   commtype_defnum   the "CareIN TC" DefNum it was filed under (that office's).
 *   note_text         the EXACT text written — what the person approved.
 *   conversation_date the optional date the person gave; it is IN note_text as
 *                     "[Conversation date: MM/DD/YYYY]" and recorded here too.
 *                     CommDateTime on the commlog is always the write time.
 *   written_by        the signed-in actor's email.
 *   written_at        when it was written.
 *
 * APPEND-ONLY for the app: carein_app gets SELECT + INSERT and nothing else.
 * A chart note cannot be un-written from CareIN, so neither can its record.
 *
 * down() drops the table (and with it the constraints and grant); nothing else
 * references it.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const APP_ROLE = (process.env.AUDIT_APP_ROLE || 'carein_app').trim();
const TABLE = 'tc_chart_writes';
exports.TABLE = TABLE;

/** Named CHECKs. Every checked column is NOT NULL, except where IS NULL is spelled out. */
const CHECKS = Object.freeze({
  tc_chart_writes_office_check: "office_id IN ('roland', 'valley')",
  tc_chart_writes_feed_item_check: "feed_item_id ~ '^[a-z_]+:.+$' AND length(feed_item_id) <= 200",
  tc_chart_writes_patient_check: 'od_patient_id > 0',
  tc_chart_writes_commlog_check: 'commlog_num > 0',
  tc_chart_writes_commtype_check: 'commtype_defnum > 0',
  tc_chart_writes_note_check: 'length(note_text) BETWEEN 1 AND 2000',
  tc_chart_writes_actor_check: 'length(written_by) BETWEEN 1 AND 200',
});
exports.CHECKS = CHECKS;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    write_id: { type: 'uuid', primaryKey: true },
    office_id: { type: 'text', notNull: true },
    case_id: { type: 'uuid', notNull: true },
    feed_item_id: { type: 'text', notNull: true },
    od_patient_id: { type: 'bigint', notNull: true },
    commlog_num: { type: 'bigint', notNull: true },
    commtype_defnum: { type: 'integer', notNull: true },
    note_text: { type: 'text', notNull: true },
    conversation_date: { type: 'date' },
    written_by: { type: 'text', notNull: true },
    written_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(TABLE, 'tc_chart_writes_item_unique', { unique: ['office_id', 'feed_item_id'] });
  for (const [name, check] of Object.entries(CHECKS)) {
    pgm.addConstraint(TABLE, name, { check });
  }
  // The feed's "On chart" read is by (office_id, feed_item_id = ANY(page ids)),
  // which the UNIQUE constraint's index already serves.
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      EXECUTE 'REVOKE ALL ON TABLE ${TABLE} FROM PUBLIC';
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT ON TABLE ${TABLE} TO %I', r);
      ELSE
        RAISE NOTICE '${TABLE}: app role % absent; grant SKIPPED', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable(TABLE, { ifExists: true });
};
