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
 * THE SAME FUNCTION AS THE SEND. `staleReason` below is what the tray's flag
 * AND sendVisit.checkStagedCurrent both call, over `existingTxStore.loadForSend`
 * — the stored rows and the plan the server last read. A flag computed any
 * other way could disagree with the refusal it predicts.
 *
 * NEVER CLIENT INFERENCE. The client cannot know the digest: it is a property of
 * the server's composition. It only reads the boolean (and reason) this attaches.
 *
 * Which rows: `note`, `router` and `tc-handoff` in `Staged` or `Failed` — the
 * states whose stored words will still be sent (a Failed row's Retry re-sends
 * them). Sending and Written rows are history.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CHECKOUT V2: TWO MORE REASONS, AND ONLY TWO
 * ═════════════════════════════════════════════════════════════════════════════
 *   medical_history  the NOTE prints the medical-history answer; its payload
 *                    carries `medicalHistoryDigest` of that one line. This is
 *                    the ONLY slip field a staged note is checked against —
 *                    the general slip-currency fix is a separate item.
 *   handoff          the TC HANDOFF's preview now prints what TC receives (the
 *                    items, the existing answers, the records, the collect
 *                    list). It is checked by RECOMPOSING it from what is stored
 *                    now and comparing the fingerprint with the stored preview:
 *                    nothing in that preview depends on who is looking or on
 *                    the clock, so "would it print differently" is exact.
 * The flag keeps its old name, `existingTxStale`; `staleReason` says which.
 */

const existingTxStore = require('./existingTxStore');
const composer = require('./stagedWriteComposer');
const visitStore = require('./visitStore');

const CARRIER_KINDS = Object.freeze(['note', 'router', 'tc-handoff']);
const STALE_STATES = Object.freeze(['Staged', 'Failed']);

/**
 * Why ONE staged write's stored words are out of date, or null when current.
 *
 * @param {{ kind: string, existingTxDigest: string|null, medicalHistoryDigest: string|null,
 *           preview: string[] }} row  the stored row's digests and preview
 * @param {{ visit: Record<string, any>, existingTx: object }} ctx  the visit as stored
 *   now (slip and items) and existingTxStore.loadForSend's answer
 * @returns {'existing_tx'|'medical_history'|'handoff'|null}
 */
function staleReason(row, { visit, existingTx }) {
  if (row.kind === 'note' || row.kind === 'router') {
    if ((row.existingTxDigest || null) !== composer.existingTxDigest(row.kind, existingTx)) {
      return 'existing_tx';
    }
    if (row.kind === 'note' && (row.medicalHistoryDigest || null) !== composer.medicalHistoryDigest(visit.slip)) {
      return 'medical_history';
    }
    return null;
  }
  if (row.kind === 'tc-handoff') {
    const now = composer.compose('tc-handoff', {
      visit,
      items: Array.isArray(visit.items) ? visit.items : [],
      existingTx,
    });
    // Nothing to hand off any more is out of date too: the staged words would
    // describe a handoff the send will now refuse.
    if (!now || !Array.isArray(now.preview)) return 'handoff';
    const stored = Array.isArray(row.preview) ? row.preview : [];
    return visitStore.fingerprintPreview(stored) === visitStore.fingerprintPreview(now.preview)
      ? null
      : 'handoff';
  }
  return null;
}

/**
 * The out-of-date kinds for this visit, and why.
 *
 * @param {import('pg').Pool} pool
 * @param {Record<string, any>} visit  the stored visit (getVisit): slip, items, stagedWrites
 * @returns {Promise<Map<string, string>>}
 */
async function staleKinds(pool, visit) {
  // The digests alone, not the payload: previews are the bulk of a row, and
  // the handoff's preview is already on the visit (stagedWrites).
  const staged = await pool.query(
    `SELECT kind, state, payload->>'existingTxDigest' AS existing_tx_digest,
            payload->>'medicalHistoryDigest' AS medical_history_digest
       FROM hyg_staged_write
      WHERE visit_id = $1 AND office = $2 AND kind = ANY($3::text[]) AND state = ANY($4::text[])`,
    [visit.visitId, visit.office, CARRIER_KINDS, STALE_STATES]
  );
  const carriers = staged.rows;
  /** @type {Map<string, string>} */
  const stale = new Map();
  if (carriers.length === 0) return stale;
  const existingTx = await existingTxStore.loadForSend(pool, { office: visit.office, visitId: visit.visitId });
  const previews = new Map(
    (Array.isArray(visit.stagedWrites) ? visit.stagedWrites : []).map((w) => [w.kind, w.preview])
  );
  for (const row of carriers) {
    const reason = staleReason(
      {
        kind: row.kind,
        existingTxDigest: typeof row.existing_tx_digest === 'string' ? row.existing_tx_digest : null,
        medicalHistoryDigest: typeof row.medical_history_digest === 'string' ? row.medical_history_digest : null,
        preview: previews.get(row.kind) || [],
      },
      { visit, existingTx }
    );
    if (reason) stale.set(row.kind, reason);
  }
  return stale;
}

/**
 * The visit with `existingTxStale` set on every staged write (false for kinds
 * that cannot go stale), and `staleReason` beside every true one. Null passes
 * through, so a route can wrap getVisit.
 *
 * @param {import('pg').Pool} pool
 * @param {Record<string, any>|null} visit
 */
async function annotate(pool, visit) {
  if (!visit || !Array.isArray(visit.stagedWrites)) return visit;
  const stale = await staleKinds(pool, visit);
  return {
    ...visit,
    // The row's OWN state must still be one that sends its stored words: the
    // visit was read in a separate statement, and a row that moved to Sending
    // in between is history, never "out of date".
    stagedWrites: visit.stagedWrites.map((w) => {
      const reason = STALE_STATES.includes(w.state) ? stale.get(w.kind) : undefined;
      return reason ? { ...w, existingTxStale: true, staleReason: reason } : { ...w, existingTxStale: false };
    }),
  };
}

module.exports = { staleKinds, staleReason, annotate, CARRIER_KINDS, STALE_STATES };
