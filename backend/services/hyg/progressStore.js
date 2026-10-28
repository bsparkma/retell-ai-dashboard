'use strict';

/**
 * The day-card progress read, in Postgres — every statement it owns.
 *
 * READ-ONLY, AND ONLY OUR OWN TABLES. Six fixed SELECTs over hyg_visit,
 * hyg_staged_write, hyg_perio_send, hyg_treatment_item and
 * hyg_existing_tx_disposition (a count only — feedback round 1). No Open Dental, no
 * write, and no column that carries a patient: not pat_num, not the slip, not a
 * preview or payload. What leaves here is AptNums, states and counts — the
 * slip's collect-at-checkout list included (checkout v2): counted in SQL.
 *
 * Same rule as visitStore.js: every WHERE clause names `office`. An AptNum is a
 * different appointment in each practice's database, so a lookup by AptNum
 * alone would hand roland's 100 the state of valley's 100.
 */

const contract = require('../../hyg/contract.gen.cjs');

/** The answers that are work for a treatment coordinator — the contract's list. */
const TC_ACTIONABLE = [...contract.EXISTING_TX_TC_ACTIONABLE];

/**
 * Rows for one office's set of appointments.
 *
 * @param {{ query: Function }} pool
 * @param {{ office: string, aptNums: number[] }} args
 * @returns {Promise<Map<number, {
 *   checkoutSentAt: unknown, checkoutFinalAt: unknown, treatmentItemCount: number,
 *   tcActionableCount: number, collectCount: number,
 *   stagedWrites: Array<{ kind: string, state: string, hasError: boolean }>,
 *   latestPerioSendState: string | null,
 * }>>} keyed by AptNum; an appointment with no visit is absent.
 */
async function readDayProgress(pool, { office, aptNums }) {
  /** @type {Map<number, any>} */
  const byApt = new Map();
  if (aptNums.length === 0) return byApt;

  const visits = await pool.query(
    `SELECT visit_id, apt_num, checkout_sent_at, checkout_final_at
       FROM hyg_visit
      WHERE office = $1 AND apt_num = ANY($2::bigint[])`,
    [office, aptNums]
  );
  if (visits.rowCount === 0) return byApt;

  /** @type {Map<string, any>} */
  const byVisit = new Map();
  for (const row of visits.rows) {
    const entry = {
      checkoutSentAt: row.checkout_sent_at ?? null,
      checkoutFinalAt: row.checkout_final_at ?? null,
      treatmentItemCount: 0,
      tcActionableCount: 0,
      collectCount: 0,
      stagedWrites: [],
      latestPerioSendState: null,
    };
    // node-postgres returns bigint as a string.
    byApt.set(Number(row.apt_num), entry);
    byVisit.set(row.visit_id, entry);
  }
  const visitIds = [...byVisit.keys()];

  const staged = await pool.query(
    `SELECT visit_id, kind, state, (error_message IS NOT NULL) AS has_error
       FROM hyg_staged_write
      WHERE office = $1 AND visit_id = ANY($2::uuid[])`,
    [office, visitIds]
  );
  for (const row of staged.rows) {
    const entry = byVisit.get(row.visit_id);
    if (entry) entry.stagedWrites.push({ kind: row.kind, state: row.state, hasError: row.has_error === true });
  }

  // The latest send that has not been deleted, per visit. send_id breaks a
  // created_at tie so the answer cannot change between two identical reads.
  const sends = await pool.query(
    `SELECT DISTINCT ON (visit_id) visit_id, state
       FROM hyg_perio_send
      WHERE office = $1 AND visit_id = ANY($2::uuid[]) AND state <> 'deleted'
      ORDER BY visit_id, created_at DESC, send_id DESC`,
    [office, visitIds]
  );
  for (const row of sends.rows) {
    const entry = byVisit.get(row.visit_id);
    if (entry) entry.latestPerioSendState = row.state;
  }

  // A count, never the items: it only answers "is there treatment to hand off".
  const items = await pool.query(
    `SELECT visit_id, COUNT(*)::int AS item_count
       FROM hyg_treatment_item
      WHERE office = $1 AND visit_id = ANY($2::uuid[])
      GROUP BY visit_id`,
    [office, visitIds]
  );
  for (const row of items.rows) {
    const entry = byVisit.get(row.visit_id);
    if (entry) entry.treatmentItemCount = Number(row.item_count);
  }

  // Feedback round 1: existing-treatment answers TC has to act on also make a
  // handoff to send. A count again — never the answers, never a ProcNum.
  const actionable = await pool.query(
    `SELECT visit_id, COUNT(*)::int AS actionable_count
       FROM hyg_existing_tx_disposition
      WHERE office = $1 AND visit_id = ANY($2::uuid[]) AND patient = ANY($3::text[])
      GROUP BY visit_id`,
    [office, visitIds, TC_ACTIONABLE]
  );
  for (const row of actionable.rows) {
    const entry = byVisit.get(row.visit_id);
    if (entry) entry.tcActionableCount = Number(row.actionable_count);
  }

  // Checkout v2: something to collect at checkout makes a handoff to send too.
  // COUNTED IN SQL, so nothing of the slip leaves the database — not even the
  // free-text "Other", which is only tested for being non-blank.
  const collect = await pool.query(
    `SELECT visit_id,
            (CASE WHEN jsonb_typeof(slip->'collectAtCheckout'->'items') = 'array'
                  THEN jsonb_array_length(slip->'collectAtCheckout'->'items') ELSE 0 END
             + CASE WHEN COALESCE(slip->'collectAtCheckout'->>'other', '') ~ '[^[:space:]]' THEN 1 ELSE 0 END
            )::int AS collect_count
       FROM hyg_visit
      WHERE office = $1 AND visit_id = ANY($2::uuid[])`,
    [office, visitIds]
  );
  for (const row of collect.rows) {
    const entry = byVisit.get(row.visit_id);
    if (entry) entry.collectCount = Number(row.collect_count);
  }

  return byApt;
}

module.exports = { readDayProgress };
