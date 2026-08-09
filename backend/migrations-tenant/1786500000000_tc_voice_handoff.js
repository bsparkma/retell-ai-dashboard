'use strict';

/**
 * Per-tenant data-plane: the voice → TC handoff (POST /api/tc/cases/from-call).
 *
 * ADDITIVE ONLY — no table is created, no existing column changes type, nothing
 * is backfilled. Three changes, each justified below.
 *
 * 1. tc_case_events.type gains 'voice_handoff'.
 *    The handoff's durable artifact is a timeline event on the case, not a row
 *    in the voice module. The voice side prunes call records on its own
 *    schedule, so the summary text, the call id and the deep link are SNAPSHOT
 *    into this event at handoff time; nothing in TC dereferences a call row.
 *    Widening a CHECK constraint means DROP + ADD (Postgres has no ALTER
 *    CONSTRAINT for CHECK) — the new list is a strict superset, so no existing
 *    row can fail the re-validation.
 *
 * 2. tc_case_events.source_call_id — nullable text, UNIQUE where non-null.
 *    This is the idempotency key. A TC clicking "Send to TC" twice on the same
 *    call must land on the same case with no second event, and the guarantee
 *    has to live in the database rather than in a read-then-write race: the
 *    partial unique index makes a duplicate handoff a constraint violation the
 *    route catches, not a duplicate case someone finds later. Uniqueness is
 *    per-tenant because this is a per-tenant database — a call id belongs to
 *    exactly one office within a tenant, so no office_id in the index key.
 *
 * 3. audit_log.source_ref — nullable text.
 *    The HIPAA trail records WHO did WHAT to WHICH resource; a handoff also has
 *    a cause (the call). tc_case_events is normal CRUD for the app role, so the
 *    event carrying the call id is mutable; audit_log is append-only and is the
 *    record that has to survive. Deliberately GENERIC ("the external identifier
 *    that caused this action"), not a voice-specific column — same precedent as
 *    the `office` column added in 1785900000000. No new grant: audit_log's
 *    append-only grant is table-level INSERT.
 *
 * PHI: source_call_id and source_ref are opaque call identifiers — identifiers,
 * not PHI values, same class as resource_id. The snapshot text that IS PHI
 * (call summary) lands in tc_case_events.detail, which was already PHI-bearing.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

/** Mirrors contract.ts CaseEventType — voice_handoff appended. */
const EVENT_TYPES_WITH_HANDOFF = [
  'status_change',
  'follow_up_completed',
  'objection_logged',
  'note_added',
  'case_created',
  'nurture_enrolled',
  'contact_attempt',
  'voice_handoff',
];

/** The pre-slice list, for down(). */
const EVENT_TYPES_BEFORE = EVENT_TYPES_WITH_HANDOFF.filter((t) => t !== 'voice_handoff');

/** @param {string[]} types */
function typeCheck(types) {
  return `type IN (${types.map((t) => `'${t}'`).join(',')})`;
}

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // 1. Widen the event-type vocabulary.
  pgm.dropConstraint('tc_case_events', 'tc_case_events_type_check');
  pgm.addConstraint('tc_case_events', 'tc_case_events_type_check', {
    check: typeCheck(EVENT_TYPES_WITH_HANDOFF),
  });

  // 2. The idempotency key + its uniqueness guarantee.
  pgm.addColumn('tc_case_events', {
    source_call_id: { type: 'text' },
  });
  pgm.createIndex('tc_case_events', 'source_call_id', {
    name: 'tc_case_events_source_call_id_key',
    unique: true,
    where: 'source_call_id IS NOT NULL',
  });

  // 3. What caused an audited action, when the cause is external to the row.
  pgm.addColumn('audit_log', {
    source_ref: { type: 'text' },
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropColumn('audit_log', 'source_ref');

  // Rows written by the handoff endpoint would violate the narrowed CHECK, so
  // they go first — down() on a slice that shipped means the feature is being
  // removed, and a half-removed handoff (event kept, column dropped) would be
  // an event nobody can trace back to a call.
  pgm.sql("DELETE FROM tc_case_events WHERE type = 'voice_handoff';");

  pgm.dropIndex('tc_case_events', 'source_call_id', {
    name: 'tc_case_events_source_call_id_key',
  });
  pgm.dropColumn('tc_case_events', 'source_call_id');

  pgm.dropConstraint('tc_case_events', 'tc_case_events_type_check');
  pgm.addConstraint('tc_case_events', 'tc_case_events_type_check', {
    check: typeCheck(EVENT_TYPES_BEFORE),
  });
};
