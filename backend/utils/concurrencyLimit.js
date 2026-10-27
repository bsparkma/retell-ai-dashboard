'use strict';

/**
 * A tiny promise pool: at most `max` tasks run at once, the rest wait in FIFO
 * order. No dependency — this is the whole of it.
 *
 * WHY (2026-10-26): the calls list resolved every call's patient status with
 * one Promise.all, so a page of ~150 calls opened ~150 simultaneous Open
 * Dental requests. Open Dental queued them, the tail hit axios's 30s timeout,
 * and prod logged two storms of ~150 "timeout of 30000ms exceeded" in a day.
 *
 * A task's result or rejection is passed straight back to its caller; a
 * rejection frees its slot like a success does, so one failure never stalls
 * the queue.
 *
 * @param {number} max  concurrent tasks allowed (integer >= 1)
 * @returns {<T>(task: () => Promise<T>) => Promise<T>}
 */
function createLimiter(max) {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`createLimiter: max must be an integer >= 1 (got ${max})`);
  }
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];

  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };

  return function limit(task) {
    return new Promise((resolve, reject) => {
      const start = () => {
        active += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(release);
      };
      if (active < max) start();
      else waiting.push(start);
    });
  };
}

module.exports = { createLimiter };
