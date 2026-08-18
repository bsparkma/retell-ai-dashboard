'use strict';

/**
 * The one gate every RCM Open Dental read passes through.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Open Dental's published throttle is **1 request / 1 second** on the paid tier
 * (docs/RCM_OD_WRITES.md §Throttle), and the credential is shared with the VOICE
 * module and TC — both of which are live in production. The transport's own
 * default spacing is `OD_API_MIN_INTERVAL_MS = 120`, i.e. ~8 req/s, which the
 * 429 backoff then papers over by replaying requests.
 *
 * Slice 6a's batch matcher paced **between claims** at 1200ms, and not at all
 * WITHIN a claim — where one unlinked patient with a common surname is 35–40
 * sequential GETs. A 25-claim remittance is therefore ~900 requests, spaced
 * 1.2s only 24 times. The modules that would have eaten the resulting 429s are
 * the phone system and TC, not RCM.
 *
 * **A biller pressing "Match all claims" must never be able to degrade the
 * phones.** So RCM holds itself to the documented rate — every call, not every
 * claim — through this module.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT GUARANTEES
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. **No two RCM Open Dental calls are ever in flight at once.** Serialization,
 *     not merely spacing: a fan-out that issued ten calls simultaneously would
 *     satisfy an interval check and still burst.
 *  2. **At least `minIntervalMs` between the START of consecutive calls**, with a
 *     hard floor of 1200ms that no env var can lower.
 *  3. It is **process-wide for RCM**, not per office, per request or per claim.
 *     Both practices' customer keys sit behind ONE developer key, so a
 *     per-office pacer would double the rate against whichever limit applies.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT COSTS THE PHONES — decision D-8
 * ─────────────────────────────────────────────────────────────────────────────
 * An earlier version of this header said it "deliberately does NOT slow the
 * voice module down". THAT WAS NOT TRUE AS WRITTEN, and it is the sentence that
 * would mislead the next reader into thinking there is no tradeoff here.
 *
 * `pacedOdGet` passes `minIntervalMs: 1200` down to the TRANSPORT's shared
 * per-credential slot, and the voice module runs per-office clients against the
 * same customer keys. So while a biller runs a batch match, a live phone-path
 * patient lookup on that office's key queues behind RCM's reservation — bounded
 * and interleaved, never starved, but up to ~1.2s of added latency mid-call for
 * as long as the batch runs.
 *
 * Beau chose that (D-8, 2026-08-17). The alternative — RCM raising only its own
 * queue and leaving the shared slot at the transport's 120ms default — keeps
 * phones fast but lets COMBINED traffic against one credential exceed Open
 * Dental's published 1 req/s, and the 429 backoff that follows degrades both
 * modules worse than bounded latency degrades one. Total traffic against the
 * key never exceeding the documented rate is the property being bought.
 *
 * Because the key stays under the published rate BY CONSTRUCTION, there is
 * nothing for RCM to yield to: do NOT add contention backoff here. That
 * mechanism belongs only to the rejected option.
 *
 * The cost is COUNTED rather than assumed — config/openDental.js attributes
 * 429s per calling module and records the worst wait a non-RCM caller took
 * behind an RCM reservation, and GET /api/rcm/eob surfaces both. Beau chose
 * this on reasoning; he should be able to revisit it on data.
 */

/**
 * The floor, in milliseconds. Open Dental's paid tier is 1 req/s; 1200ms leaves
 * 20% of headroom for clock skew and for the fact that our "interval" is
 * measured from request START while the limiter measures arrival.
 */
const FLOOR_MS = 1200;

/**
 * Resolve the configured interval, never below the floor.
 *
 * A garbage value does not silently disable pacing — it falls back to the floor.
 * The failure mode of a too-slow match is a slow screen; the failure mode of a
 * too-fast one is the practice's phones.
 *
 * @returns {number}
 */
function resolveMinIntervalMs() {
  const raw = Number(process.env.RCM_OD_MIN_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return FLOOR_MS;
  return Math.max(FLOOR_MS, raw);
}

/**
 * Test seam. Lets a suite prove the MECHANISM (serialization + spacing) in
 * milliseconds instead of minutes, without loosening what production uses —
 * `resolveMinIntervalMs()` is tested separately and independently.
 * @type {number|null}
 */
let overrideIntervalMs = null;

/** @param {number|null} ms */
function _setIntervalForTests(ms) {
  overrideIntervalMs = ms;
}

/** The tail of the queue: resolves when the previous caller's turn is over. */
let chain = Promise.resolve();

/** When the next call may start. */
let nextSlotAt = 0;

/** When the previous call actually started, for the observed-interval counter. */
let lastStartedAt = 0;

/**
 * Observability — how many calls this process has paced, how long they waited,
 * and the total span between consecutive call STARTS (the thing the limiter
 * actually sees).
 */
const stats = { calls: 0, waitedMs: 0, spacedMs: 0 };

/** Test seam — reset the queue and counters. */
function _resetForTests() {
  chain = Promise.resolve();
  nextSlotAt = 0;
  lastStartedAt = 0;
  stats.calls = 0;
  stats.waitedMs = 0;
  stats.spacedMs = 0;
  overrideIntervalMs = null;
}

/**
 * Run `fn` in the RCM Open Dental queue: after everything already queued, and
 * no sooner than `minIntervalMs` after the previous call started.
 *
 * Failures do NOT break the chain — a rejected call still yields its turn, or
 * one bad patient read would wedge every later match in the process.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function paced(fn) {
  const interval = overrideIntervalMs ?? resolveMinIntervalMs();

  const turn = chain.then(async () => {
    /*
     * SLEEP UNTIL THE SLOT, VERIFIED — not once for a computed duration.
     *
     * `setTimeout(n)` may fire before n milliseconds have elapsed on the clock
     * we measure with, and on Windows its granularity is ~15ms. A single sleep
     * therefore under-spaces by a few milliseconds at a time, which against a
     * 1 req/s limiter is the difference between compliant and not.
     */
    while (Date.now() < nextSlotAt) {
      const remaining = nextSlotAt - Date.now();
      stats.waitedMs += remaining;
      await new Promise((r) => setTimeout(r, remaining));
    }

    /*
     * The next slot is measured from when this call ACTUALLY starts, not from
     * when it was reserved.
     *
     * Reserving up front lets drift compound in the wrong direction: a call
     * that starts 6ms late still hands the next one its original slot, so two
     * consecutive requests land 6ms closer together than the interval promises.
     * The limiter sees arrivals, so the guarantee has to be about arrivals.
     *
     * STAMPED AFTER `fn()` IS ENTERED, not before it. An earlier version took
     * the timestamp on the line above the call, which meant the pacer spaced
     * its own BOOKKEEPING by the interval while the request inside `fn` started
     * an unbounded moment later. That lag varies per call, and the difference
     * between two consecutive lags subtracts straight off the real spacing:
     * with a 40ms interval, an 8ms lag on one call and none on the next puts
     * two requests 32ms apart. CI caught it as a 39ms gap where 40 was promised
     * (`consecutive calls are spaced by at least the interval`, 2026-08-18);
     * Windows never saw it because its ~15ms timer granularity overshoots every
     * sleep by enough to hide the difference, while Linux lands on the boundary.
     *
     * Calling `fn()` runs its synchronous prefix — for `pacedOdGet` that is
     * everything up to the request's first await — so a stamp taken once it
     * returns is at or after the moment the call really began. The next slot is
     * therefore never earlier than one interval after this request started,
     * which is the property Open Dental's throttle is counting.
     *
     * `finally` so a synchronously-throwing `fn` still yields its slot rather
     * than letting the next caller through immediately.
     *
     * Safe to compute here rather than reserve because `chain` already
     * serializes this section — only one caller is ever inside it.
     */
    stats.calls += 1;
    let pending;
    try {
      // NOT `await fn()` inside the try: the stamp must land when the request
      // STARTS, and awaiting here would move `finally` to when it FINISHES —
      // spacing calls an interval apart from completion, which is a different
      // and much slower contract than the one this module promises.
      pending = fn();
    } finally {
      const startedAt = Date.now();
      if (lastStartedAt) stats.spacedMs += startedAt - lastStartedAt;
      lastStartedAt = startedAt;
      nextSlotAt = startedAt + interval;
    }
    return pending;
  });

  // The NEXT caller waits for this turn to settle either way. `catch` rather
  // than `finally` so a rejection is absorbed here and still surfaces to the
  // caller through `turn`.
  chain = turn.then(
    () => undefined,
    () => undefined
  );

  return turn;
}

/**
 * Wrap a raw `odGet` so every call through it is paced.
 *
 * This is what routes hand to the read shell, so pacing is a property of the
 * transport the shell was given rather than something each call site remembers.
 * It also raises the TRANSPORT's per-key slot to the same interval, so RCM's
 * calls occupy a fair share of the shared credential rather than queueing
 * politely here and then bursting there.
 *
 * @param {(path: string, params?: object, opts?: object) => Promise<any>} odGet
 * @returns {(path: string, params?: object, opts?: object) => Promise<any>}
 */
function pacedOdGet(odGet) {
  const interval = overrideIntervalMs ?? resolveMinIntervalMs();
  return (path, params, opts) =>
    paced(() =>
      // `module: 'rcm'` is for ATTRIBUTION only — it buys no priority. It is
      // what lets the transport count 429s and contention per module, so D-8
      // can be revisited on measurements instead of on argument.
      odGet(path, params, { ...(opts || {}), minIntervalMs: interval, module: 'rcm' })
    );
}

/**
 * RCM's OBSERVED interval — total time spent inside the queue divided by the
 * calls that went through it. Reported next to the configured floor so the two
 * can be compared rather than assumed equal.
 * @returns {number|null} null until at least two calls have been paced
 */
function observedIntervalMs() {
  if (stats.calls < 2) return null;
  return Math.round(stats.spacedMs / (stats.calls - 1));
}

module.exports = {
  FLOOR_MS,
  resolveMinIntervalMs,
  paced,
  pacedOdGet,
  observedIntervalMs,
  stats,
  _resetForTests,
  _setIntervalForTests,
};
