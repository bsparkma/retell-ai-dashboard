'use strict';

/**
 * The extraction queue seam.
 *
 * ── WHY THIS IS NOT BullMQ, WHICH THE SLICE BRIEF ASKED FOR ──────────────────
 * BullMQ is Redis-backed; there is no Redis anywhere on this platform (no
 * dependency, no connection string, no cache resource in either resource
 * group). Adding one is an infrastructure decision with a provisioning task
 * behind it, and an extraction path that cannot run until that lands would be
 * worse than no extraction path. So this is an in-process runner behind the
 * SEAM BullMQ would sit in, and the seam is the deliverable:
 *
 *   - A job is PLAIN SERIALIZABLE DATA — { tenantId, tenantSlug, office,
 *     uploadId }. No req, no pool, no user object, nothing request-scoped.
 *     Everything the worker needs it re-resolves from those four strings, which
 *     is exactly the constraint a Redis payload would impose.
 *   - The handler is registered, not imported at the call site, so swapping
 *     this file for `new Worker('rcm-eob', handler, { connection })` is a
 *     one-file change with no caller edits.
 *   - Concurrency is 1 and ordering is FIFO — the properties a single-worker
 *     BullMQ queue would give, so behavior does not change under the swap.
 *
 * What is genuinely LOST versus BullMQ, stated rather than papered over: jobs do
 * not survive a process restart. Two things cover that, and neither is a
 * background scan:
 *   - a re-POST of the same PDF re-enqueues an upload still sitting at
 *     'uploaded' (routes/rcm/eob.js) — the recovery path is a human action;
 *   - anything caught mid-attempt is marked 'failed' on the next boot by
 *     services/rcm/eobStartupSweep.js, so no row is left claiming that work is
 *     happening when this queue no longer holds it.
 * See docs/RCM_EOB_INGESTION.md.
 *
 * The Redis question is SETTLED, not deferred: no broker, now or for Slices 5/6.
 * Slice 5's 835 parse needs no queue, and Slice 6's posting queue is Postgres —
 * rcm_posting_queue IS the durable queue, decided in Slice 1 for this reason.
 * Revisit only at a ca-carein-rcm worker split, if one ever happens.
 *
 * NO BACKGROUND SCANNING AND NO EXTERNAL POLLING. The only thing that puts work
 * in here is an upload. The only timer that exists is the budget-deferral one
 * below, which waits for a clock, not for a service.
 */

const budget = require('./extractionBudget');

/** @typedef {{ tenantId: string, tenantSlug: string, office: string, uploadId: string }} EobJob */

/** @type {EobJob[]} */
let pending = [];
/** Jobs parked because the daily cost breaker is tripped. */
/** @type {EobJob[]} */
let deferred = [];
let running = false;
/**
 * The uploadId currently in the handler.
 *
 * Needed for dedup, and not obviously so: `pump()` shifts a job off `pending`
 * BEFORE awaiting the handler, so between those two moments the job is in no
 * list at all. Deduping against `pending` alone let a double-submit through in
 * exactly that window — which is the double-click case, i.e. the common one.
 * @type {string|null}
 */
let inFlight = null;
/** @type {NodeJS.Timeout|null} */
let resumeTimer = null;
/** Resolvers waiting on `drain()` — test seam. */
/** @type {Array<() => void>} */
let idleWaiters = [];

/**
 * The job handler. Registered rather than required at the enqueue site so this
 * module has no dependency on the worker (and so a test can swap it).
 * @type {((job: EobJob) => Promise<unknown>)|null}
 */
let handler = null;

/** Lazily default to the real worker. Kept lazy so requiring the queue in a
 *  route does not drag the Azure SDKs in at boot. */
function getHandler() {
  if (!handler) handler = (job) => require('./eobExtractionWorker').runExtraction(job);
  return handler;
}

/**
 * Enqueue one extraction. Returns immediately — the caller (an HTTP POST) must
 * not wait on an LLM round trip.
 * @param {EobJob} job
 */
function enqueue(job) {
  for (const key of ['tenantId', 'tenantSlug', 'office', 'uploadId']) {
    if (typeof job[key] !== 'string' || !job[key]) {
      throw new Error(`[rcm/eobQueue] job.${key} must be a non-empty string`);
    }
  }
  // Idempotent on uploadId: a double-submit, or a re-POST of the same bytes
  // while the first attempt is queued OR RUNNING, must not extract twice.
  if (inFlight === job.uploadId) return;
  if (pending.some((j) => j.uploadId === job.uploadId)) return;
  if (deferred.some((j) => j.uploadId === job.uploadId)) return;

  pending.push({
    tenantId: job.tenantId,
    tenantSlug: job.tenantSlug,
    office: job.office,
    uploadId: job.uploadId,
  });
  void pump();
}

/** Serial runner. One job at a time, in order. */
async function pump() {
  if (running) return;
  running = true;
  try {
    while (pending.length > 0) {
      const job = pending.shift();
      inFlight = job.uploadId;
      try {
        const result = await getHandler()(job);
        // The worker reports 'deferred' when the breaker is tripped (or the
        // provider is unconfigured). The upload stays 'uploaded' and waits —
        // nothing is dropped, which is the whole point of the breaker being a
        // pause rather than a failure.
        if (result && result.status === 'deferred') {
          deferred.push(job);
          scheduleResume(result.resetsAt);
        }
      } catch (err) {
        // A handler that throws has already recorded 'failed' + reason on the
        // row; anything reaching here is a bug in the worker itself, and losing
        // the loop over it would stall every later upload.
        console.error(
          `[rcm/eobQueue] handler threw for upload ${job.uploadId}:`,
          err && err.message ? err.message : err
        );
      } finally {
        inFlight = null;
      }
    }
  } finally {
    running = false;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/**
 * Wake the deferred jobs when the daily budget rolls.
 *
 * ONE timer, rescheduled to the earliest known reset — not one per job. It is
 * `unref`'d so a pending resume never keeps the process (or a test run) alive.
 * A missing/invalid resetsAt means "nothing to wait for" (e.g. the provider is
 * unconfigured), and those jobs sit until a re-POST re-enqueues them.
 * @param {string|undefined} resetsAt ISO-8601
 */
function scheduleResume(resetsAt) {
  if (!resetsAt) return;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return;
  // +5s of slack so the timer cannot fire a hair BEFORE the local day rolls and
  // immediately re-defer everything.
  const delay = Math.max(1000, at - Date.now() + 5000);
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    resumeDeferred();
  }, delay);
  if (typeof resumeTimer.unref === 'function') resumeTimer.unref();
}

/** Move parked jobs back onto the queue. Also the manual-recovery entry point. */
function resumeDeferred() {
  if (deferred.length === 0) return 0;
  const state = budget.check();
  if (!state.allowed) {
    // Still tripped (clock skew, or the cap was lowered) — re-arm rather than
    // burning through the parked jobs to discover it one at a time.
    scheduleResume(state.resetsAt);
    return 0;
  }
  const woken = deferred;
  deferred = [];
  pending.push(...woken);
  void pump();
  return woken.length;
}

/** Queue depth, for the honest state the API reports. */
function stats() {
  return { pending: pending.length, deferred: deferred.length, running };
}

/** Test seam — the uploadId currently in the handler, if any. */
function _inFlight() {
  return inFlight;
}

/** Resolve once the runner is idle. Test seam — production code never waits. */
function drain() {
  if (!running && pending.length === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

/** Test seam — swap the handler. Pass null to restore the real worker. */
function _setHandler(fn) {
  handler = fn;
}

/** Test seam — empty the queue and cancel any resume timer. */
function _resetForTests() {
  pending = [];
  deferred = [];
  inFlight = null;
  idleWaiters = [];
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;
  handler = null;
}

module.exports = { enqueue, drain, stats, resumeDeferred, _setHandler, _inFlight, _resetForTests };
