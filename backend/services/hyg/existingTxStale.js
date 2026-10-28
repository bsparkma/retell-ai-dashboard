'use strict';

/**
 * WHICH STAGED WRITES NO LONGER SAY WHAT WAS ANSWERED — server-side, by digest.
 *
 * The note and the Router print the existing-treatment answers (Slice 2b), and
 * each carries `existingTxDigest`: a hash of exactly the lines it printed. A
 * disposition saved after staging changes what those lines WOULD say, so the
 * staged words are out of date. sendVisit already refuses such a row with
 * PREVIEW_CHANGED; this is the same comparison made EARLIER, so the tray can say
 * so the moment the answer is saved instead of when the hygienist presses Send.
 *
 * THE SAME FUNCTION AS THE SEND. `composer.existingTxDigest` over
 * `existingTxStore.loadForSend` — the stored rows and the plan the server last
 * read — is what sendVisit.checkExistingTxCurrent compares against. A flag
 * computed any other way could disagree with the refusal it predicts.
 *
 * NEVER CLIENT INFERENCE. The client cannot know the digest: it is a property of
 * the server's composition. It only reads the boolean this attaches.
 *
 * Which rows: `note` and `router` in `Staged` or `Failed` — the two states whose
 * stored words will still be sent (a Failed row's Retry re-sends them). Sending
 * and Written rows are history, and the answers are frozen behind them anyway.
 * `tc-handoff` is never stale: its preview prints no existing-treatment lines,
 * and its send reads the answers at send time (sendVisit.sendHandoff).
 */

const existingTxStore = require('./existingTxStore');
const composer = require('./stagedWriteComposer');

const CARRIER_KINDS = Object.freeze(['note', 'router']);
const STALE_STATES = Object.freeze(['Staged', 'Failed']);

/**
 * The kinds whose staged words are out of date for this visit.
 *
 * @param {import('pg').Pool} pool
 * @param {{ office: string, visitId: string }} args
 * @returns {Promise<Set<string>>}
 */
async function staleKinds(pool, { office, visitId }) {
  const staged = await pool.query(
    `SELECT kind, state, payload FROM hyg_staged_write
      WHERE visit_id = $1 AND office = $2`,
    [visitId, office]
  );
  const carriers = staged.rows.filter(
    (r) => CARRIER_KINDS.includes(r.kind) && STALE_STATES.includes(r.state)
  );
  const stale = new Set();
  if (carriers.length === 0) return stale;
  const existingTx = await existingTxStore.loadForSend(pool, { office, visitId });
  for (const row of carriers) {
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const stagedDigest = typeof payload.existingTxDigest === 'string' ? payload.existingTxDigest : null;
    if (stagedDigest !== composer.existingTxDigest(row.kind, existingTx)) stale.add(row.kind);
  }
  return stale;
}

/**
 * The visit with `existingTxStale` set on every staged write (false for kinds
 * that cannot go stale). Null passes through, so a route can wrap getVisit.
 *
 * @param {import('pg').Pool} pool
 * @param {Record<string, any>|null} visit
 */
async function annotate(pool, visit) {
  if (!visit) return visit;
  const stale = await staleKinds(pool, { office: visit.office, visitId: visit.visitId });
  return {
    ...visit,
    stagedWrites: visit.stagedWrites.map((w) => ({ ...w, existingTxStale: stale.has(w.kind) })),
  };
}

module.exports = { staleKinds, annotate, CARRIER_KINDS, STALE_STATES };
