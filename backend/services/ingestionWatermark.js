/**
 * Mango ingestion high-water mark (diagnosis H3 — silent call loss).
 *
 * THE DEFECT THIS CLOSES: fullSync used to re-ask Mango for "the newest N calls in the
 * last 1 day" every hour with no cursor. MANGO_MAX_CALLS_PER_SYNC=25 in prod, `found` was
 * pinned at exactly 25 on every business-hours sync, and 2026-08-03 hit `added 25` — the
 * cap saturated, so calls made in that hour were NEVER ingested. No metadata, no worklist
 * row, no button a human could ever click. Silent, permanent loss.
 *
 * THE CONTRACT (this is the seam M4's on-demand transcribe button depends on):
 *
 *   The watermark advances on successful INGESTION ONLY. It is NEVER gated on the
 *   transcription outcome. A call that was ingested but not transcribed — budget spent,
 *   no recording published yet, Azure error — keeps its store row and stays transcribable
 *   later. Ingestion captures everything; transcription is a separate, later decision
 *   over the store.
 *
 * SEMANTICS: `started_at` is the watermark, and it means "every call at or before this
 * instant has been ingested". The next sync walks back to `watermark − OVERLAP` rather
 * than to the watermark itself, so late-arriving / late-finalized calls that Mango only
 * published after we passed their timestamp are still picked up. Re-ingesting inside the
 * overlap is free: the store dedups on external_id (unifiedCallStore.addMangoCalls).
 *
 * The watermark is only advanced when the walk actually REACHED the floor. If the page
 * cap truncated the walk there is an unfetched gap below the oldest call we saw, so the
 * watermark is HELD and the next sync re-walks the same floor. Nothing is dropped silently.
 */

const { DurableState } = require('./durableState');

/** How far back past the watermark each sync re-walks, to absorb late-published calls. */
const OVERLAP_MINUTES = (() => {
  const raw = process.env.MANGO_WATERMARK_OVERLAP_MINUTES;
  if (raw === undefined || raw === '') return 120; // 2 hours
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 120;
})();

/**
 * Runaway guard on the backwards walk. 10 pages × 50/page = 500 calls, far above any real
 * hour of volume (peak observed: 25/hr), so hitting this means something is wrong — it is
 * a circuit breaker, NOT a routine limiter. When it trips we log it explicitly.
 */
const MAX_PAGES = (() => {
  const raw = process.env.MANGO_SYNC_MAX_PAGES;
  if (raw === undefined || raw === '') return 10;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 10;
})();

const OVERLAP_MS = OVERLAP_MINUTES * 60 * 1000;

const state = new DurableState('mango_ingestion_watermark.json', { started_at: null });

/**
 * Read the current watermark.
 * @returns {{ startedAt: string|null, updatedAt: string|null }}
 */
function get() {
  const doc = state.read();
  const startedAt = typeof doc.started_at === 'string' && Number.isFinite(Date.parse(doc.started_at))
    ? doc.started_at
    : null;
  return { startedAt, updatedAt: doc.updated_at || null };
}

/**
 * The instant a sync must walk back to. `watermark − OVERLAP` in steady state; null on a
 * cold start, where the caller falls back to its configured lookback window.
 * @returns {number|null} epoch ms, or null when no watermark is stored yet
 */
function floorMs() {
  const { startedAt } = get();
  if (!startedAt) return null;
  return Date.parse(startedAt) - OVERLAP_MS;
}

/**
 * Advance the watermark to `isoTs` — call this ONLY with the newest `started_at` that was
 * successfully ingested, and ONLY when the walk reached its floor. Never moves backwards.
 * @param {string|null} isoTs
 * @returns {string|null} the watermark in effect after the call
 */
function advance(isoTs) {
  const next = isoTs ? Date.parse(isoTs) : NaN;
  if (!Number.isFinite(next)) return get().startedAt;

  const current = get().startedAt;
  if (current && Date.parse(current) >= next) return current; // monotonic

  const iso = new Date(next).toISOString();
  state.write({ started_at: iso });
  return iso;
}

/** Clear the stored watermark (tests only). */
function _reset() {
  state.reset();
  state.write({ started_at: null });
  state.reset();
}

module.exports = {
  get,
  floorMs,
  advance,
  OVERLAP_MINUTES,
  OVERLAP_MS,
  MAX_PAGES,
  _state: state,
  _reset,
};
