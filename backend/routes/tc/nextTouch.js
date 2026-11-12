'use strict';

/**
 * Next touch, server side. The DERIVATION itself (earliest pending follow-up,
 * open-status test) is shared/tc/nextTouch.ts, bundled into contract.gen.cjs,
 * the same code the dashboard runs. This file only does the office-scoped
 * reads that feed it.
 *
 * Every query here is single-table, names its columns, and is scoped by
 * office_id = $1. A case id from another office can never contribute a row.
 */

const { contract } = require('./helpers');
const store = require('./caseStore');

const { nextTouchByCase } = contract;

/**
 * snake_case pending row → the candidate shape the shared derivation reads.
 * @param {Record<string, unknown>} r  a normalized tc_followups row
 */
function toCandidate(r) {
  return {
    followupId: String(r.followup_id),
    caseId: String(r.case_id),
    dueDate: String(r.due_date),
    status: String(r.status),
    owner: r.owner == null ? null : String(r.owner),
    channel: String(r.channel),
    kind: String(r.kind),
    row: r,
  };
}

/** The compact next touch the case list carries per card. */
function summarize(c) {
  return { followupId: c.followupId, dueDate: c.dueDate, owner: c.owner, channel: c.channel, kind: c.kind };
}

/**
 * Pending follow-ups for a set of cases in ONE office, keyed by case id to
 * that case's next touch.
 * @param {{ query: Function }} q
 * @param {string} office
 * @param {string[]} caseIds
 * @returns {Promise<Map<string, ReturnType<typeof toCandidate>>>}
 */
async function nextTouchesForCases(q, office, caseIds) {
  if (caseIds.length === 0) return new Map();
  const res = await q.query(
    `SELECT ${store.FOLLOWUP_COLS.join(', ')} FROM tc_followups
      WHERE office_id = $1 AND case_id = ANY($2) AND status = 'pending'
      ORDER BY due_date`,
    [office, caseIds]
  );
  return nextTouchByCase(res.rows.map((r) => toCandidate(store.normalizeFollowupRow(r))));
}

/**
 * Does this case (in this office) have any pending follow-up right now?
 * @param {{ query: Function }} q
 * @param {string} office
 * @param {string} caseId
 * @returns {Promise<boolean>}
 */
async function hasPendingFollowup(q, office, caseId) {
  const res = await q.query(
    `SELECT followup_id, case_id, due_date, status FROM tc_followups
      WHERE office_id = $1 AND case_id = $2 AND status = 'pending'
      LIMIT 1`,
    [office, caseId]
  );
  return res.rows.length > 0;
}

module.exports = { nextTouchesForCases, hasPendingFollowup, summarize };
