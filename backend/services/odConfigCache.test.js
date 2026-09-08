'use strict';

/**
 * services/odConfigCache.js — the hour-long cache for PRACTICE CONFIGURATION.
 *
 * Three claims, in the order they would hurt if they were wrong:
 *
 *   1. **It cannot cross offices.** Operatory 4 is a different room in each
 *      practice and ProvNum 7 is a different person. This is the quieter
 *      sibling of the cross-office PHI bug odPatientCache guards against.
 *   2. **It cannot hold anything clinical.** The resource list is closed, so
 *      nobody can put `/patients` behind an hour-long TTL by passing a path.
 *   3. **It never keeps a broken read.** A partial list is the right thing to
 *      render and the wrong thing to remember for an hour.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const cache = require('./odConfigCache');

test.beforeEach(() => cache.resetOdConfigCache());

/** A loader that counts how many times it actually ran. */
function loader(rows, { error = null, truncated = false } = {}) {
  const calls = { n: 0 };
  return [async () => { calls.n += 1; return { rows, error, truncated }; }, calls];
}

test('THE KEY CARRIES THE OFFICE, so one practice never sees the other\'s chairs', async () => {
  const [roland, rolandCalls] = loader([{ OperatoryNum: 4, OpName: 'Hyg 1' }]);
  const [valley, valleyCalls] = loader([{ OperatoryNum: 4, OpName: 'Dr Reed' }]);

  const a = await cache.getList('roland', 'operatories', roland);
  const b = await cache.getList('valley', 'operatories', valley);

  assert.equal(a.rows[0].OpName, 'Hyg 1');
  assert.equal(b.rows[0].OpName, 'Dr Reed', 'valley must not be served roland\'s chair');
  assert.equal(rolandCalls.n, 1);
  assert.equal(valleyCalls.n, 1);

  // And each office keeps its own entry warm.
  assert.equal((await cache.getList('roland', 'operatories', roland)).source, 'cache');
  assert.equal(rolandCalls.n, 1);
  assert.equal(valleyCalls.n, 1);
});

test('an office that is not in the Open Dental registry cannot mint a namespace', async () => {
  const [load] = loader([]);
  for (const bad of ['', '   ', 'ROLAND', 'notanoffice', 'all']) {
    await assert.rejects(
      () => cache.getList(bad, 'operatories', load),
      /odConfigCache/,
      JSON.stringify(bad)
    );
  }
  await assert.rejects(() => cache.getList(undefined, 'operatories', load), /odConfigCache/);
});

test('THE RESOURCE LIST IS CLOSED — /patients can never be cached for an hour', async () => {
  // The reason this matters is in services/odPatientCache.js §2: a premed flag
  // or a medical alert can be added to a chart mid-morning, and that cache
  // holds five minutes for exactly that reason. A caller who passed 'patients'
  // here would age a clinical fact by an hour with nothing on screen saying so.
  const [load] = loader([]);
  for (const bad of ['patients', '/patients', 'perioexams', 'documents', 'commlogs']) {
    await assert.rejects(() => cache.getList('roland', bad, load), /not practice configuration/, bad);
  }
  assert.deepEqual([...cache.CONFIG_RESOURCES], [
    'appointmenttypes',
    'providers',
    'operatories',
  ]);
});

test('a clean read is kept for an hour; a FAILED one is not kept at all', async () => {
  const [good, goodCalls] = loader([{ ProvNum: 7, Abbr: 'HYG1' }]);
  await cache.getList('roland', 'providers', good);
  await cache.getList('roland', 'providers', good);
  assert.equal(goodCalls.n, 1, 'the second call was served from memory');

  // A partial list is the right thing to RENDER — three quarters of the chairs
  // beats an outage — and the wrong thing to remember. Keeping it would turn
  // one bad minute into an hour of missing names with nothing saying so.
  const [broken, brokenCalls] = loader([{ AppointmentTypeNum: 1 }], { error: 'HTTP 504' });
  const first = await cache.getList('roland', 'appointmenttypes', broken);
  assert.equal(first.error, 'HTTP 504');
  assert.deepEqual(first.rows, [{ AppointmentTypeNum: 1 }], 'served anyway');

  const [recovered, recoveredCalls] = loader([{ AppointmentTypeNum: 1 }, { AppointmentTypeNum: 2 }]);
  const second = await cache.getList('roland', 'appointmenttypes', recovered);
  assert.equal(brokenCalls.n, 1);
  assert.equal(recoveredCalls.n, 1, 'the broken read was not remembered');
  assert.equal(second.rows.length, 2);
});

test('a TRUNCATED read is not kept either', async () => {
  // Same rule as a failure and a different cause: the page budget ran out, so
  // there are rows Open Dental has that this list does not.
  const [cut, cutCalls] = loader([{ OperatoryNum: 1 }], { truncated: true });
  await cache.getList('roland', 'operatories', cut);
  await cache.getList('roland', 'operatories', cut);
  assert.equal(cutCalls.n, 2, 'half a list is never remembered');
});

test('TTL 0 turns the cache off without disabling anything else', async () => {
  const previous = process.env.OD_CONFIG_CACHE_TTL_MS;
  process.env.OD_CONFIG_CACHE_TTL_MS = '0';
  try {
    const [load, calls] = loader([{ ProvNum: 7 }]);
    await cache.getList('roland', 'providers', load);
    await cache.getList('roland', 'providers', load);
    assert.equal(calls.n, 2, 'every read is a miss');
    assert.equal(cache.stats().entries, 0, 'and nothing is retained');
  } finally {
    if (previous === undefined) delete process.env.OD_CONFIG_CACHE_TTL_MS;
    else process.env.OD_CONFIG_CACHE_TTL_MS = previous;
  }
});

test('garbage in the environment falls back rather than disabling the cache', async () => {
  const previous = process.env.OD_CONFIG_CACHE_TTL_MS;
  for (const bad of ['abc', '-1', 'NaN']) {
    process.env.OD_CONFIG_CACHE_TTL_MS = bad;
    assert.equal(cache.ttlMs(), cache.DEFAULT_TTL_MS, bad);
  }
  if (previous === undefined) delete process.env.OD_CONFIG_CACHE_TTL_MS;
  else process.env.OD_CONFIG_CACHE_TTL_MS = previous;
  assert.equal(cache.DEFAULT_TTL_MS, 60 * 60 * 1000, 'an hour — the commlogTypes precedent');
});
