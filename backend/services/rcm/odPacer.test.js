'use strict';

/**
 * The RCM Open Dental pacer.
 *
 * Slice 6a's first version asserted `res.body.pacingMs >= 1200`, which proves
 * only that a constant is echoed in a response body — the calls themselves were
 * unpaced within a claim. These tests assert the OBSERVED behaviour: real
 * timestamps, real concurrency.
 *
 * The mechanism is exercised at a small interval so the suite runs in
 * milliseconds; the PRODUCTION floor is asserted separately and independently,
 * so neither test can be satisfied by weakening the other.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const pacer = require('./odPacer');

/** Run `fn` with the pacer reset and a small interval, then restore. */
async function withPacer(intervalMs, fn) {
  pacer._resetForTests();
  pacer._setIntervalForTests(intervalMs);
  try {
    return await fn();
  } finally {
    pacer._resetForTests();
  }
}

// ─── The production floor ────────────────────────────────────────────────────

test('the floor is 1200ms and no env var can lower it', () => {
  // Open Dental's published throttle is 1 request / 1 second on the paid tier,
  // against a credential the VOICE module and TC are using in production.
  const original = process.env.RCM_OD_MIN_INTERVAL_MS;
  try {
    for (const value of [undefined, '', '0', '-1', '5', '120', 'banana', 'NaN']) {
      if (value === undefined) delete process.env.RCM_OD_MIN_INTERVAL_MS;
      else process.env.RCM_OD_MIN_INTERVAL_MS = value;
      assert.equal(
        pacer.resolveMinIntervalMs(),
        1200,
        `RCM_OD_MIN_INTERVAL_MS=${JSON.stringify(value)} must not go below the floor`
      );
    }
    // Raising it IS allowed — a practice on the free tier is 1 req / 5 s.
    process.env.RCM_OD_MIN_INTERVAL_MS = '5000';
    assert.equal(pacer.resolveMinIntervalMs(), 5000);
  } finally {
    if (original === undefined) delete process.env.RCM_OD_MIN_INTERVAL_MS;
    else process.env.RCM_OD_MIN_INTERVAL_MS = original;
  }
});

test('the floor constant is what the module says it is', () => {
  assert.equal(pacer.FLOOR_MS, 1200);
});

// ─── Observed spacing ────────────────────────────────────────────────────────

test('consecutive calls are spaced by at least the interval', async () => {
  await withPacer(40, async () => {
    /** @type {number[]} */
    const startedAt = [];
    await Promise.all(
      Array.from({ length: 5 }, () => pacer.paced(async () => startedAt.push(Date.now())))
    );

    assert.equal(startedAt.length, 5);
    for (let i = 1; i < startedAt.length; i++) {
      const gap = startedAt[i] - startedAt[i - 1];
      // No tolerance: the pacer sleeps until the slot is REACHED on the same
      // clock this reads, rather than trusting one setTimeout to be punctual.
      assert.ok(gap >= 40, `call ${i} started only ${gap}ms after call ${i - 1}`);
    }
  });
});

test('NO TWO CALLS ARE EVER IN FLIGHT AT ONCE', async () => {
  // Spacing alone is not enough: a fan-out that issued ten calls simultaneously
  // would satisfy an interval check between their START times and still burst.
  await withPacer(10, async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        pacer.paced(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 15));
          inFlight -= 1;
        })
      )
    );

    assert.equal(maxInFlight, 1, 'the pacer must serialize, not merely space');
  });
});

test('the queue survives a failing call — one bad read cannot wedge the process', async () => {
  await withPacer(10, async () => {
    const seen = [];
    const failing = pacer.paced(async () => {
      seen.push('bad');
      throw new Error('OD exploded');
    });
    const following = pacer.paced(async () => {
      seen.push('good');
      return 'ok';
    });

    await assert.rejects(() => failing, /OD exploded/);
    assert.equal(await following, 'ok');
    assert.deepEqual(seen, ['bad', 'good']);
  });
});

test('a rejection still reaches its own caller', async () => {
  await withPacer(1, async () => {
    await assert.rejects(() => pacer.paced(async () => { throw new Error('mine'); }), /mine/);
  });
});

test('the pacer is process-wide, not per caller', async () => {
  // Both offices sit behind ONE developer key. A per-office pacer would double
  // the rate against whichever limit applies.
  await withPacer(30, async () => {
    const startedAt = [];
    const roland = pacer.pacedOdGet(async () => startedAt.push(Date.now()));
    const valley = pacer.pacedOdGet(async () => startedAt.push(Date.now()));
    await Promise.all([roland('/a'), valley('/b'), roland('/c'), valley('/d')]);
    for (let i = 1; i < startedAt.length; i++) {
      assert.ok(startedAt[i] - startedAt[i - 1] >= 30, 'separate closures must share one queue');
    }
  });
});

// ─── The wrapper ─────────────────────────────────────────────────────────────

test('pacedOdGet passes the path and params through untouched', async () => {
  await withPacer(1, async () => {
    /** @type {any[]} */
    let got = null;
    const wrapped = pacer.pacedOdGet(async (path, params, opts) => {
      got = { path, params, opts };
      return { ok: true };
    });
    const res = await wrapped('/claims', { PatNum: 12828 }, { timeoutMs: 5 });
    assert.deepEqual(res, { ok: true });
    assert.equal(got.path, '/claims');
    assert.deepEqual(got.params, { PatNum: 12828 });
    assert.equal(got.opts.timeoutMs, 5);
  });
});

test("pacedOdGet raises the TRANSPORT's per-key slot to the same interval", async () => {
  // Queueing politely here and then bursting at the transport would be a
  // guarantee in name only: the shared per-key slot in config/openDental.js is
  // what keeps RCM from crowding out the voice module on the same credential.
  await withPacer(25, async () => {
    let opts = null;
    const wrapped = pacer.pacedOdGet(async (_p, _q, o) => {
      opts = o;
      return { ok: true };
    });
    await wrapped('/claims');
    assert.equal(opts.minIntervalMs, 25);
  });
});

test('stats count what was paced and how long it waited', async () => {
  await withPacer(20, async () => {
    await Promise.all([pacer.paced(async () => 1), pacer.paced(async () => 2)]);
    assert.equal(pacer.stats.calls, 2);
    assert.ok(pacer.stats.waitedMs >= 15, 'the second call waited');
  });
});
