'use strict';

/**
 * The scheduled pruner: selection, the 30-day boundary, idempotency, and what a
 * half-finished run leaves behind.
 *
 * All fixtures synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const store = require('./unifiedCallStore');
const retention = require('./callRetention');

const NOW = new Date('2026-08-13T09:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

let originalRequestPersist;
let originalPersist;

beforeEach(() => {
  originalRequestPersist = store.requestPersist;
  originalPersist = store.persist;
  store.requestPersist = () => {};
  store.persist = async () => {};
  store.clear();
});

afterEach(() => {
  store.requestPersist = originalRequestPersist;
  store.persist = originalPersist;
});

function seed(id, ageDays, extra = {}) {
  return store.addCallInternal({
    id,
    external_id: id,
    source: 'mango',
    caller_number: `+1555010${String(id).slice(-4).padStart(4, '0')}`,
    called_number: '+15550199999',
    call_date: daysAgo(ageDays),
    duration_seconds: 60,
    summary: 'a synthetic summary',
    ...extra,
  });
}

test('the pruner stubs a 31-day-old call and leaves a 29-day-old one alone', async () => {
  seed('mango_call_old', 31);
  seed('mango_call_young', 29);

  const result = await retention.runPrune(store, { now: NOW, retentionDays: 30 });

  assert.equal(result.stubbed, 1);
  assert.equal(retention.isStub(store.getCall('mango_call_old')), true);
  assert.equal(retention.isStub(store.getCall('mango_call_young')), false);
  assert.equal(store.getCall('mango_call_young').summary, 'a synthetic summary');
});

test('the pruner is idempotent — a second run finds nothing new to do', async () => {
  seed('mango_call_old', 31);
  await retention.runPrune(store, { now: NOW, retentionDays: 30 });
  const afterFirst = store.getCall('mango_call_old');

  const second = await retention.runPrune(store, { now: NOW, retentionDays: 30 });

  assert.equal(second.stubbed, 0);
  assert.deepEqual(store.getCall('mango_call_old'), afterFirst, 'pruned_at must not be restamped');
});

test('a run that dies partway leaves every record either live or fully stubbed', async () => {
  for (let i = 0; i < 6; i++) seed(`mango_call_p${i}`, 40 + i);

  // Kill the run after two records. This is the crash: no cleanup, no unwind.
  let seen = 0;
  await assert.rejects(
    retention.runPrune(store, {
      now: NOW,
      retentionDays: 30,
      onProgress: () => {
        if (++seen === 2) throw new Error('container died mid-run');
      },
    }),
    /container died mid-run/
  );

  // No half-record anywhere: each is a valid stub or a valid live call.
  let stubbed = 0;
  for (const call of store.calls.values()) {
    if (retention.isStub(call)) {
      assert.equal(typeof call.pruned_at, 'string');
      assert.ok(Array.isArray(call.actions));
      stubbed++;
    } else {
      assert.equal(call.summary, 'a synthetic summary');
    }
  }
  assert.equal(stubbed, 2);

  // And the next run simply finishes the job.
  const resumed = await retention.runPrune(store, { now: NOW, retentionDays: 30 });
  assert.equal(resumed.stubbed, 4);
  assert.equal(resumed.alreadyStubbed, 0, 'already-stubbed rows are not re-selected');
});

test('the pruner takes both legs of a twin even when one leg is young', async () => {
  const old = seed('mango_call_twin', 31);
  const young = store.addCallInternal({
    id: 'call_retell_twin', source: 'retell',
    caller_number: '+15550100777', call_date: daysAgo(1),
  });
  old.linked_call_id = young.id;
  old.link_role = 'duplicate_leg';
  young.linked_call_id = old.id;
  young.link_role = 'primary';

  await retention.runPrune(store, { now: NOW, retentionDays: 30 });

  assert.equal(retention.isStub(store.getCall('mango_call_twin')), true);
  assert.equal(
    retention.isStub(store.getCall('call_retell_twin')), true,
    'a twin pair ages out as a unit or the survivor points at a stub-less link'
  );
});

test('retentionDays 0 prunes nothing at all', async () => {
  seed('mango_call_ancient', 900);

  const result = await retention.runPrune(store, { now: NOW, retentionDays: 0 });

  assert.equal(result.stubbed, 0);
  assert.equal(retention.isStub(store.getCall('mango_call_ancient')), false);
});

test('the pruner persists once at the end, not once per record', async () => {
  for (let i = 0; i < 5; i++) seed(`mango_call_q${i}`, 40);
  let persists = 0;
  store.persist = async () => { persists++; };

  await retention.runPrune(store, { now: NOW, retentionDays: 30 });

  assert.equal(persists, 1, 'five whole-store writes for one nightly job is the bug we are fixing');
});

test('a run that stubbed nothing does not write the store at all', async () => {
  seed('mango_call_young2', 3);
  let persists = 0;
  store.persist = async () => { persists++; };

  await retention.runPrune(store, { now: NOW, retentionDays: 30 });

  assert.equal(persists, 0);
});

test('the run reports the cutoff it used, so a log line is auditable', async () => {
  seed('mango_call_r', 31);

  const result = await retention.runPrune(store, { now: NOW, retentionDays: 30 });

  assert.equal(result.cutoff, '2026-07-14T09:00:00.000Z');
  assert.equal(result.scanned, 1);
  assert.equal(typeof result.durationMs, 'number');
});
