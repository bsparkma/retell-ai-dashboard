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
 * SEMANTICS: `started_at` is the watermark. Every call newer than `watermark − OVERLAP`
 * has been ingested, EXCEPT anything inside the recorded `gap` (below). The next sync
 * walks back to `watermark − OVERLAP` rather than to the watermark itself, so
 * late-arriving / late-finalized calls that Mango only published after we passed their
 * timestamp are still picked up. Re-ingesting inside the overlap is free: the store
 * dedups on external_id (unifiedCallStore.addMangoCalls).
 *
 * THE GAP. If the page cap truncates a walk, everything from the oldest call we reached
 * up to now IS ingested contiguously — but there is an unfetched range below it. Holding
 * the watermark there does NOT work: the next walk restarts from the newest call, so new
 * arrivals push its reach FORWARD and the unfetched range widens every sync. A backlog
 * deeper than one sync's page budget would never drain.
 *
 * So a truncated walk advances the watermark to the newest ingested call (the top is
 * covered) and records the unfetched range explicitly as `{ gap_from, gap_to }`. Later
 * syncs do their normal short walk, then KEEP PAGING to drain the gap from its newest end
 * downward, and the gap closes when a walk finally crosses `gap_from`.
 *
 * Pages that lie entirely in the already-ingested region between the gap and the floor
 * carry no ingest work, so they are charged to a SEPARATE skip budget (MAX_SKIP_PAGES).
 * Sharing one budget would re-stall: the skip region grows as the gap drains, and would
 * eventually eat the whole page allowance before reaching any un-ingested call.
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

/**
 * Page budget for traversing the ALREADY-INGESTED region between a gap and the floor.
 * These pages do no ingest work — they are list calls and nothing else — so they get
 * their own, much larger allowance. Charging them to MAX_PAGES would re-create the stall.
 */
const MAX_SKIP_PAGES = (() => {
  const raw = process.env.MANGO_SYNC_MAX_SKIP_PAGES;
  if (raw === undefined || raw === '') return 60; // 3000 rows of already-covered history
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 60;
})();

const OVERLAP_MS = OVERLAP_MINUTES * 60 * 1000;

const state = new DurableState('mango_ingestion_watermark.json', {
  started_at: null,
  gap_from: null,
  gap_to: null,
});

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
 * successfully ingested. Never moves backwards. Safe to call after a TRUNCATED walk too:
 * the region from the oldest call reached up to the newest is contiguous, and whatever
 * lies below it is recorded separately by openOrExtendGap().
 * @param {string|null} isoTs
 * @returns {string|null} the watermark in effect after the call
 */
function advance(isoTs) {
  const next = isoTs ? Date.parse(isoTs) : NaN;
  if (!Number.isFinite(next)) return get().startedAt;

  const current = get().startedAt;
  if (current && Date.parse(current) >= next) return current; // monotonic

  const doc = state.read();
  state.write({ ...doc, started_at: new Date(next).toISOString() });
  return get().startedAt;
}

/**
 * The unfetched range a truncated walk left behind, if any.
 * @returns {{ from: string, to: string }|null} `from` is the older bound, `to` the newer
 */
function getGap() {
  const doc = state.read();
  const from = Date.parse(doc.gap_from);
  const to = Date.parse(doc.gap_to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/**
 * Record (or extend) the unfetched range after a truncated walk.
 *
 * `from` is the boundary the walk was TRYING to reach and never did — it is preserved
 * across runs, so a repeat truncation can't shrink the range we still owe. `to` is the
 * oldest call this run reached; it only ever moves OLDER, because a run that made no
 * progress must not discard the deeper coverage an earlier run already achieved.
 *
 * @param {number} fromMs older bound (the walk's stop target)
 * @param {number} toMs   newer bound (oldest call actually reached this run)
 */
function openOrExtendGap(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return getGap();
  const doc = state.read();
  const existingFrom = Date.parse(doc.gap_from);
  const existingTo = Date.parse(doc.gap_to);

  const from = Number.isFinite(existingFrom) ? Math.min(existingFrom, fromMs) : fromMs;
  const to = Number.isFinite(existingTo) ? Math.min(existingTo, toMs) : toMs;
  if (from >= to) return closeGap();

  state.write({ ...doc, gap_from: new Date(from).toISOString(), gap_to: new Date(to).toISOString() });
  return getGap();
}

/** Clear the gap — a walk finally crossed its older bound. */
function closeGap() {
  const doc = state.read();
  state.write({ ...doc, gap_from: null, gap_to: null });
  return null;
}

/** Clear all stored ingestion state (tests only). */
function _reset() {
  state.reset();
  state.write({ started_at: null, gap_from: null, gap_to: null });
  state.reset();
}

module.exports = {
  get,
  floorMs,
  advance,
  getGap,
  openOrExtendGap,
  closeGap,
  OVERLAP_MINUTES,
  OVERLAP_MS,
  MAX_PAGES,
  MAX_SKIP_PAGES,
  _state: state,
  _reset,
};
