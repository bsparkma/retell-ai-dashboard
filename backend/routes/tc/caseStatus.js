'use strict';

/**
 * The case status transition — the body of POST /api/tc/cases/:caseId/status
 * (routes/tc/cases.js), extracted UNCHANGED so the checkout card's "Route to →
 * Pipeline" (CO-6, routes/tc/checkoutRouting.js) sets a status through the very
 * same path instead of a second copy of it. The endpoint is still the only
 * status-transition ROUTE; this is the one status-transition FUNCTION, and it
 * runs inside the caller's transaction.
 *
 *   same status  no change. A note becomes an ordinary `note_added` event (no
 *                note: a pure no-op).
 *   new status   UPDATE + a `status_change` event in the funnel's `from → to`
 *                format (+ `nurture_enrolled` on a first move into nurture),
 *                and any running nurture enrollment stops when the new status
 *                is terminal — all in the caller's transaction.
 *
 * The caller validates the input (lostReason with `lost`, and only with it) and
 * writes the audit rows after its commit.
 */

const { randomUUID } = require('node:crypto');

const store = require('./caseStore');
const nurtureHooks = require('../../services/tcNurture/hooks');

/**
 * @param {import('pg').PoolClient | { query: Function }} client  inside a transaction
 * @param {{ office: string, caseId: string, status: string, lostReason: string|null,
 *           note: string, actor: string, now: string }} input
 * @returns {Promise<
 *   | { missing: true }
 *   | { unchanged: true, fromStatus: string, noteEventId: string|null }
 *   | { unchanged: false, fromStatus: string, stoppedEnrollments: string[] }>}
 */
async function applyStatusChange(client, { office, caseId, status, lostReason, note, actor, now }) {
  const header = await store.getCaseHeader(client, office, caseId);
  if (!header) return { missing: true };
  if (header.status === status) {
    // Same status. A note typed in the Change-status dialog used to be
    // dropped here without a word. Keep it as an ordinary note_added event
    // (an existing type, so no vocabulary change). With no note, this stays a
    // pure no-op.
    const trimmed = note.trim();
    let noteEventId = null;
    if (trimmed) {
      noteEventId = randomUUID();
      await store.insertEventRow(client, {
        event_id: noteEventId,
        case_id: caseId,
        office_id: office,
        ts: now,
        type: 'note_added',
        description: trimmed,
        actor,
        detail: null,
        legacy_id: null,
      });
    }
    return { unchanged: true, fromStatus: header.status, noteEventId };
  }

  const enrollingInNurture = status === 'nurture' && !header.nurture_enrolled_at;
  await client.query(
    `UPDATE tc_cases
        SET status = $3,
            lost_reason = $4,
            status_changed_at = $5,
            nurture_enrolled_at = CASE WHEN $6 THEN $5::timestamptz ELSE nurture_enrolled_at END,
            updated_at = now()
      WHERE office_id = $1 AND case_id = $2`,
    [office, caseId, status, lostReason, now, enrollingInNurture]
  );

  await store.insertEventRow(client, {
    event_id: randomUUID(),
    case_id: caseId,
    office_id: office,
    ts: now,
    type: 'status_change',
    description: note ? `${header.status} → ${status}: ${note}` : `${header.status} → ${status}`,
    actor,
    detail: null,
    legacy_id: null,
  });
  if (enrollingInNurture) {
    await store.insertEventRow(client, {
      event_id: randomUUID(),
      case_id: caseId,
      office_id: office,
      ts: now,
      type: 'nurture_enrolled',
      description: 'Enrolled in nurture campaign',
      actor,
      detail: null,
      legacy_id: null,
    });
  }

  // (item 47) Into a TERMINAL status ⇒ any running nurture enrollment on this
  // case stops (stop_reason 'case_terminal'), in this transaction, so the
  // status and the stop commit together.
  const stoppedEnrollments = await nurtureHooks.stopForTerminalCase(client, {
    office,
    caseId,
    newStatus: status,
    actor,
    now: new Date(now),
  });
  return { unchanged: false, fromStatus: header.status, stoppedEnrollments };
}

module.exports = { applyStatusChange };
