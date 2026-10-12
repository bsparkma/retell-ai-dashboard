'use strict';

/**
 * The ortho screening's send to TC, on the visit it was sent from (item 33).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. WHY THE SEND NEEDS A SNAPSHOT OF THE APPOINTMENT
 * ═════════════════════════════════════════════════════════════════════════════
 * TC opens a case with the patient's name, age and phone and the diagnosing
 * provider. Those must be derived SERVER-SIDE — a client that could name the
 * patient could file a case against somebody else — and this slice makes NO
 * Open Dental call, so the send cannot re-read the appointment the way the
 * visit Send does.
 *
 * So the routes that ALREADY read the appointment from Open Dental (opening a
 * visit, loading one) record what they read in `appointment_snapshot`, and the
 * ortho send files the case from that. It is written only when the
 * appointment's PatNum still equals the visit's, so it can never describe a
 * different person than the row it sits on. Age and phone come from the shared
 * patient cache only — never a new Open Dental request.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. ONE SEND PER VISIT — AND A CLAIM, BECAUSE TC HAS NO IDEMPOTENCY KEY
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /api/tc/hygiene-intakes` creates a case every time it is called. The
 * guarantee that a second press creates nothing therefore lives HERE:
 *
 *   ortho_tc_case_id     set once TC answered with a case; a sent visit is a
 *                        no-op that returns this id.
 *   ortho_send_claimed_at  set by a conditional UPDATE before TC is called, so
 *                        two presses racing each other cannot both reach TC.
 *                        Cleared when TC answers either way; a claim older than
 *                        two minutes (a process that died mid-send) is stale
 *                        and may be re-taken.
 *
 * The residual risk is the one the treatment handoff already documents in
 * services/hyg/tcHandoffClient.js: if TC created the case and the answer was
 * lost on the way back, a retry opens a second one. A unique key inside TC would
 * close it and is a TC-side change this additive slice does not make.
 *
 * Attribution is all-or-nothing, written the long way because Postgres ACCEPTS
 * a CHECK that evaluates to NULL.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. GRANTS
 * ═════════════════════════════════════════════════════════════════════════════
 * No new table. `carein_app` holds CRUD on hyg_visit from
 * 1788200000000_hyg_visit.js, and a table-level grant covers columns added
 * later.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('hyg_visit', {
    // { patientName, providerName, opName, birthdate, phone, capturedAt } —
    // what Open Dental last said about this appointment. NULL until a route
    // that reads the appointment has run since this deploy.
    appointment_snapshot: { type: 'jsonb' },
    ortho_tc_case_id: { type: 'text' },
    ortho_sent_at: { type: 'timestamptz' },
    ortho_sent_by: { type: 'text' },
    ortho_send_claimed_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('hyg_visit', 'hyg_visit_ortho_sent_check', {
    check:
      '(ortho_tc_case_id IS NULL) = (ortho_sent_at IS NULL) AND ' +
      '(ortho_sent_at IS NULL) = (ortho_sent_by IS NULL)',
  });
  pgm.addConstraint('hyg_visit', 'hyg_visit_appointment_snapshot_object_check', {
    check: "appointment_snapshot IS NULL OR jsonb_typeof(appointment_snapshot) = 'object'",
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('hyg_visit', 'hyg_visit_appointment_snapshot_object_check', {
    ifExists: true,
  });
  pgm.dropConstraint('hyg_visit', 'hyg_visit_ortho_sent_check', { ifExists: true });
  pgm.dropColumns(
    'hyg_visit',
    [
      'appointment_snapshot',
      'ortho_tc_case_id',
      'ortho_sent_at',
      'ortho_sent_by',
      'ortho_send_claimed_at',
    ],
    { ifExists: true }
  );
};
