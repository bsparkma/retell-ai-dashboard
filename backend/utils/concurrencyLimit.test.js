'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLimiter } = require('./concurrencyLimit');

/** A task that records how many tasks are in flight, then settles after `ms`. */
function tracker() {
  const state = { inFlight: 0, peak: 0, started: 0 };
  /** @param {number} ms @param {() => unknown} settle */
  const task = (ms, settle) => async () => {
    state.started += 1;
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      await new Promise((r) => setTimeout(r, ms));
      return settle();
    } finally {
      state.inFlight -= 1;
    }
  };
  return { state, task };
}

test('N tasks through a limit of 5 never exceed 5 in flight, and every result comes back in order', async () => {
  const limit = createLimiter(5);
  const { state, task } = tracker();
  const N = 40;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => limit(task(1 + (i % 4), () => i)))
  );
  assert.equal(state.peak, 5, 'the pool fills to the cap and no further');
  assert.equal(state.started, N);
  assert.deepEqual(results, Array.from({ length: N }, (_, i) => i));
});

test('a rejection frees its slot and is passed back to its own caller only', async () => {
  const limit = createLimiter(2);
  const { state, task } = tracker();
  const boom = new Error('synthetic failure');
  const settled = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      limit(
        task(1, () => {
          if (i % 3 === 0) throw boom;
          return i;
        })
      )
    )
  );
  assert.ok(state.peak <= 2);
  assert.equal(state.started, 10, 'failures never stall the queue');
  settled.forEach((s, i) => {
    if (i % 3 === 0) assert.deepEqual(s, { status: 'rejected', reason: boom });
    else assert.deepEqual(s, { status: 'fulfilled', value: i });
  });
});

test('a task that throws synchronously is a rejection, not a crash, and frees its slot', async () => {
  const limit = createLimiter(1);
  await assert.rejects(
    limit(() => {
      throw new Error('sync throw');
    }),
    /sync throw/
  );
  assert.equal(await limit(async () => 'next'), 'next');
});

test('the cap must be a positive integer', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => createLimiter(bad), /integer >= 1/);
  }
});
