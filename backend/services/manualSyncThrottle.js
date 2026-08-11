'use strict';

/**
 * Throttle for the worklist's manual "Sync now" button.
 *
 * Guards TWO things a button-mash produces: a second click while the first sync is still
 * working, and a second click seconds after it finished. Both get a polite 429 with a
 * countdown rather than another full Retell + Mango walk.
 *
 * The scheduled syncs are NOT affected — this is only consulted by the manual route, so
 * the :15 cron keeps its own cadence no matter how the button is used.
 *
 * State is in-memory ON PURPOSE: the backend runs at maxReplicas=1 (ACA config), so
 * process memory is the shared view. If it ever scales out the failure mode is benign —
 * each replica allows one manual run per window.
 */

/** A manual sync inside this window after the last one completed is refused. */
const COOLDOWN_MS = 60_000;

let lastCompletedAt = 0; // ms epoch; 0 = no manual sync has completed in this process
let inFlight = false;

/**
 * Claim the right to run a manual sync.
 * @param {number} [now] ms epoch, injectable for tests
 * @returns {{ allowed: true } | { allowed: false, retryAfter: number }} retryAfter in SECONDS
 */
function begin(now = Date.now()) {
  if (inFlight) {
    // No completion time to count down from yet, so quote the full window.
    return { allowed: false, retryAfter: Math.ceil(COOLDOWN_MS / 1000) };
  }
  const sinceLast = now - lastCompletedAt;
  if (lastCompletedAt > 0 && sinceLast < COOLDOWN_MS) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((COOLDOWN_MS - sinceLast) / 1000)) };
  }
  inFlight = true;
  return { allowed: true };
}

/**
 * Release the claim and start the cooldown. Must run even when the sync threw — an
 * error that left `inFlight` set would wedge the button until the next deploy.
 * @param {number} [now] ms epoch, injectable for tests
 */
function end(now = Date.now()) {
  inFlight = false;
  lastCompletedAt = now;
}

/** Drop all throttle state (tests only). */
function reset() {
  lastCompletedAt = 0;
  inFlight = false;
}

module.exports = { begin, end, reset, COOLDOWN_MS };
