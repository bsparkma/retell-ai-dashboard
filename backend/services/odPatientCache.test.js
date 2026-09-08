'use strict';

/**
 * The shared Open Dental patient cache.
 *
 * The first two tests are the ones that matter. Everything else here is about
 * making a screen faster; those two are about not showing a hygienist one
 * practice's patient under another practice's name.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const cache = require('./odPatientCache');

/** Restore whatever the environment had, so a suite cannot leak a knob. */
function withEnv(vars, fn) {
  const originals = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(originals)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  })();
}

/**
 * A scripted transport that COUNTS. `reads` is what the cache actually spent on
 * Open Dental — the number every assertion here is really about.
 * @param {Record<number, object|null>} byPatNum
 */
function transport(byPatNum) {
  const t = {
    reads: [],
    readOne: async (patNum) => {
      t.reads.push(patNum);
      const record = byPatNum[patNum];
      return record ? { ok: true, record } : { ok: false, record: null };
    },
  };
  return t;
}

test.beforeEach(() => cache.resetOdPatientCache());

// ─── 1. Cross-office isolation. The whole reason for the key shape. ──────────

test('PatNum 7115 cached for ROLAND is never served for VALLEY', async () => {
  /*
   * PatNum numbering restarts in every Open Dental database. 7115 is the valley
   * test patient AND a different, real person in roland — which is why this
   * platform's hard rule 3 says a PatNum needs an office.
   *
   * IF THIS TEST FAILS, the cache is serving one practice's patient under
   * another practice's name: a cross-office PHI disclosure, and the worst bug
   * this codebase can produce. It is not a caching regression.
   */
  const roland = transport({ 7115: { PatNum: 7115, LName: 'RolandSide', FName: 'Synthetic' } });
  const valley = transport({ 7115: { PatNum: 7115, LName: 'ValleySide', FName: 'Synthetic' } });

  const first = await cache.getPatient('roland', 7115, roland.readOne);
  assert.equal(first.record.LName, 'RolandSide');
  assert.deepEqual(roland.reads, [7115]);

  const second = await cache.getPatient('valley', 7115, valley.readOne);
  assert.equal(second.source, 'fetch', 'valley must MISS — roland has its own 7115');
  assert.equal(second.record.LName, 'ValleySide');
  assert.deepEqual(valley.reads, [7115], "valley's own read must have been issued");

  // And roland's entry is untouched by valley's, in both directions.
  const back = await cache.getPatient('roland', 7115, roland.readOne);
  assert.equal(back.source, 'cache');
  assert.equal(back.record.LName, 'RolandSide');
  assert.deepEqual(roland.reads, [7115], 'roland must not have been re-read');
});

test('PatNum 7115 cached for VALLEY is never served for ROLAND', async () => {
  // The same claim from the other side. Written out rather than parameterised
  // because a one-directional key bug — a fallback that only fires when the
  // FIRST office happens to be the one missing — passes half of this pair.
  const valley = transport({ 7115: { PatNum: 7115, LName: 'ValleySide', FName: 'Synthetic' } });
  const roland = transport({ 7115: { PatNum: 7115, LName: 'RolandSide', FName: 'Synthetic' } });

  await cache.getPatient('valley', 7115, valley.readOne);
  const crossed = await cache.getPatient('roland', 7115, roland.readOne);

  assert.equal(crossed.source, 'fetch');
  assert.equal(crossed.record.LName, 'RolandSide');
  assert.deepEqual(roland.reads, [7115]);
});

test('a key cannot be minted without a REGISTERED office', () => {
  // Throws rather than defaulting. A caller that has not resolved an office has
  // not established which database its PatNum came from, and a string that
  // arrived off a request cannot mint a namespace of its own.
  assert.throws(() => cache.cacheKey(undefined, 7115), /office key is required/);
  assert.throws(() => cache.cacheKey('', 7115), /office key is required/);
  assert.throws(() => cache.cacheKey('  ', 7115), /office key is required/);
  assert.throws(() => cache.cacheKey('unknown', 7115), /not an Open Dental office/);
  assert.throws(() => cache.cacheKey('roland', 0), /positive integer/);
  assert.throws(() => cache.cacheKey('roland', '7115'), /positive integer/);

  assert.equal(cache.cacheKey('roland', 7115), cache.cacheKey('roland', 7115));
  assert.notEqual(cache.cacheKey('roland', 7115), cache.cacheKey('valley', 7115));
});

// ─── 2. Don't ask twice ──────────────────────────────────────────────────────

test('a second read inside the TTL costs Open Dental nothing', async () => {
  const t = transport({ 12827: { PatNum: 12827, LName: 'Test 2', FName: 'Stedi' } });

  const a = await cache.getPatient('roland', 12827, t.readOne);
  const b = await cache.getPatient('roland', 12827, t.readOne);

  assert.equal(a.source, 'fetch');
  assert.equal(b.source, 'cache');
  assert.deepEqual(t.reads, [12827], 'one request, not two');
  assert.deepEqual(b.record, a.record);
});

test('concurrent identical reads collapse into ONE Open Dental request', async () => {
  // Two hygienists opening the same day at the same moment. Without the
  // in-flight guard the second one pays for the first one's requests AND its
  // own, on a credential that serves one request a second.
  let resolveRead;
  const gate = new Promise((r) => {
    resolveRead = r;
  });
  const reads = [];
  const readOne = async (patNum) => {
    reads.push(patNum);
    await gate;
    return { ok: true, record: { PatNum: patNum, LName: 'Test', FName: 'MangoTest' } };
  };

  const both = Promise.all([
    cache.getPatient('roland', 12828, readOne),
    cache.getPatient('roland', 12828, readOne),
  ]);
  resolveRead();
  const [first, second] = await both;

  assert.deepEqual(reads, [12828], 'one request served both callers');
  const sources = [first.source, second.source].sort();
  assert.deepEqual(sources, ['fetch', 'inflight']);
  assert.equal(second.record.PatNum, 12828);
  assert.equal(first.record.PatNum, 12828);
});

// ─── 3. Stale is never served ────────────────────────────────────────────────

test('an expired entry plus a FAILED refresh is a MISS, never the stale record', () =>
  withEnv({ OD_PATIENT_CACHE_TTL_MS: 1 }, async () => {
    /*
     * The rule this file exists to enforce, and the one that separates this
     * cache from services/commlogTypes.js — which serves stale deliberately and
     * is right to, because a definitions list is not clinical.
     *
     * A patient record carries `Premed` and `MedUrgNote` in the same object as
     * the name. A stale name is harmless; a stale medical alert is not; they
     * cannot be split without deciding per field which staleness is safe. So
     * past the TTL there is nothing to fall back onto.
     */
    const good = { PatNum: 12827, LName: 'Test 2', FName: 'Stedi', Premed: true };
    let fail = false;
    const readOne = async () => (fail ? { ok: false, record: null } : { ok: true, record: good });

    const warm = await cache.getPatient('roland', 12827, readOne);
    assert.equal(warm.record.Premed, true);

    await new Promise((r) => setTimeout(r, 5));
    fail = true;
    const after = await cache.getPatient('roland', 12827, readOne);

    assert.equal(after.ok, false);
    assert.equal(after.record, null, 'the stale record must NOT be served');
    assert.equal(cache.hasFresh('roland', 12827), false);
  }));

test('a failed read is not cached, so the next look retries', async () => {
  let ok = false;
  const reads = [];
  const readOne = async (patNum) => {
    reads.push(patNum);
    return ok
      ? { ok: true, record: { PatNum: patNum, LName: 'Test 2', FName: 'Stedi' } }
      : { ok: false, record: null };
  };

  const missed = await cache.getPatient('roland', 12827, readOne);
  assert.equal(missed.ok, false);

  ok = true;
  const retried = await cache.getPatient('roland', 12827, readOne);
  assert.equal(retried.ok, true);
  assert.deepEqual(reads, [12827, 12827], 'a blip must not stick for the whole TTL');
});

test('a transport that THROWS costs one patient, not the day', async () => {
  const readOne = async () => {
    throw new Error('socket hang up');
  };
  const got = await cache.getPatient('roland', 12827, readOne);
  assert.equal(got.ok, false);
  assert.equal(got.record, null);

  // And the failure left no in-flight entry behind to wedge the next read.
  assert.equal(cache.stats().inFlight, 0);
});

test('TTL 0 turns the cache off rather than caching forever', () =>
  withEnv({ OD_PATIENT_CACHE_TTL_MS: 0 }, async () => {
    const t = transport({ 12827: { PatNum: 12827, LName: 'Test 2', FName: 'Stedi' } });
    await cache.getPatient('roland', 12827, t.readOne);
    const second = await cache.getPatient('roland', 12827, t.readOne);
    assert.equal(second.source, 'fetch');
    assert.deepEqual(t.reads, [12827, 12827]);
  }));

// ─── 4. Bounded ──────────────────────────────────────────────────────────────

test('the cache is BOUNDED — past the ceiling it evicts rather than grows', () =>
  withEnv({ OD_PATIENT_CACHE_MAX_ENTRIES: 3 }, async () => {
    // This is PHI in process memory on a single-replica container: nothing else
    // will ever evict for us, so the ceiling is the only thing between a busy
    // month and a practice's whole patient list living in the heap.
    const readOne = async (patNum) => ({ ok: true, record: { PatNum: patNum } });

    for (const patNum of [901, 902, 903, 904]) {
      await cache.getPatient('roland', patNum, readOne);
    }

    assert.equal(cache.stats().entries, 3, 'the ceiling holds');
    assert.equal(cache.hasFresh('roland', 901), false, 'the oldest went');
    assert.equal(cache.hasFresh('roland', 904), true);
  }));

test('eviction is by LEAST RECENTLY USED, not by arrival', () =>
  withEnv({ OD_PATIENT_CACHE_MAX_ENTRIES: 3 }, async () => {
    const readOne = async (patNum) => ({ ok: true, record: { PatNum: patNum } });
    for (const patNum of [901, 902, 903]) {
      await cache.getPatient('roland', patNum, readOne);
    }

    // Touch the oldest — a hygienist looking again at the 8am patient.
    const touched = await cache.getPatient('roland', 901, readOne);
    assert.equal(touched.source, 'cache');

    await cache.getPatient('roland', 904, readOne);

    assert.equal(cache.hasFresh('roland', 901), true, 'the one in use survived');
    assert.equal(cache.hasFresh('roland', 902), false, 'the truly idle one went');
  }));

test('a ceiling of 0 retains nothing at all', () =>
  withEnv({ OD_PATIENT_CACHE_MAX_ENTRIES: 0 }, async () => {
    const t = transport({ 12827: { PatNum: 12827, LName: 'Test 2', FName: 'Stedi' } });
    const first = await cache.getPatient('roland', 12827, t.readOne);
    assert.equal(first.ok, true, 'the answer is still returned — it is simply not kept');
    assert.equal(cache.stats().entries, 0);
  }));

// ─── 5. Housekeeping ─────────────────────────────────────────────────────────

test('a garbage knob falls back to its default rather than disabling the cache', () =>
  withEnv({ OD_PATIENT_CACHE_TTL_MS: 'soon', OD_PATIENT_CACHE_MAX_ENTRIES: '-4' }, async () => {
    assert.equal(cache.ttlMs(), cache.DEFAULT_TTL_MS);
    assert.equal(cache.maxEntries(), cache.DEFAULT_MAX_ENTRIES);
  }));

test('the default TTL is five minutes, and that is a clinical bound', () => {
  /*
   * services/commlogTypes.js caches for an HOUR and is right to — it holds
   * practice configuration. This holds a patient's `Premed` and `MedUrgNote`,
   * which a front desk can change mid-morning, in front of a screen somebody
   * reads standing at a chair.
   *
   * If this assertion is failing because the number was raised to make the
   * morning warm reach further, read §2 of odPatientCache.js first: the honest
   * fix for that is progressive fill, not an older medical alert.
   */
  assert.equal(cache.DEFAULT_TTL_MS, 5 * 60 * 1000);
});

test('stats report counts, never who is in them', async () => {
  const t = transport({ 12827: { PatNum: 12827, LName: 'Test 2', FName: 'Stedi' } });
  await cache.getPatient('roland', 12827, t.readOne);

  const stats = cache.stats();
  assert.deepEqual(Object.keys(stats).sort(), ['entries', 'inFlight', 'maxEntries', 'ttlMs']);
  assert.equal(stats.entries, 1);
  // A cache summary must not become a list of who was seen.
  assert.ok(!JSON.stringify(stats).includes('12827'));
});
