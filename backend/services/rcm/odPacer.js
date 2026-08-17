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
 * It deliberately does NOT slow the voice module down. RCM waits for RCM; the
 * transport's shared per-key slot (config/openDental.js) is what keeps the two
 * modules from bursting past each other.
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

/** Observability — how many calls this process has paced, and total wait. */
const stats = { calls: 0, waitedMs: 0 };

/** Test seam — reset the queue and counters. */
function _resetForTests() {
  chain = Promise.resolve();
  nextSlotAt = 0;
  stats.calls = 0;
  stats.waitedMs = 0;
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
     * Safe to compute here rather than reserve because `chain` already
     * serializes this section — only one caller is ever inside it.
     */
    nextSlotAt = Date.now() + interval;
    stats.calls += 1;
    return fn();
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
    paced(() => odGet(path, params, { ...(opts || {}), minIntervalMs: interval }));
}

module.exports = {
  FLOOR_MS,
  resolveMinIntervalMs,
  paced,
  pacedOdGet,
  stats,
  _resetForTests,
  _setIntervalForTests,
};
