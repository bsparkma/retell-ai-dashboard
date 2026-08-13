'use strict';

/**
 * The delete + stub primitives on the store itself.
 *
 * Everything here goes through the store's normal mutate → persist path. That is
 * not incidental: the ONLY way a record has ever left this store before today
 * was a hand-edit of unified_calls.json followed by `kill -9`, because a graceful
 * shutdown persists the in-memory state straight back over the file. A primitive
 * that wrote to disk directly would inherit exactly that failure mode.
 *
 * All fixtures synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const store = require('./unifiedCallStore');
const retention = require('./callRetention');

let originalRequestPersist;

beforeEach(() => {
  originalRequestPersist = store.requestPersist;
  store.requestPersist = () => {};
  store.clear();
});

afterEach(() => {
  store.requestPersist = originalRequestPersist;
});

/** A Mango leg and the Retell leg that answered it, already twin-linked. */
function seedTwinPair() {
  const mango = store.addCallInternal({
    id: 'mango_call_7001',
    external_id: 'mango_call_7001',
    source: 'mango',
    caller_number: '+15550100777',
    called_number: '+15550199999',
    call_date: '2026-06-01T15:00:00.000Z',
    duration_seconds: 60,
  });
  const retell = store.addCallInternal({
    id: 'call_retell_7001',
    source: 'retell',
    caller_number: '+15550100777',
    call_date: '2026-06-01T15:00:05.000Z',
    duration_seconds: 55,
  });
  mango.linked_call_id = retell.id;
  mango.link_role = 'duplicate_leg';
  retell.linked_call_id = mango.id;
  retell.link_role = 'primary';
  return { mango, retell };
}

// --- delete ----------------------------------------------------------------

test('deleteCalls removes the record and every index entry', () => {
  store.addCallInternal({
    id: 'mango_call_1', external_id: 'mango_call_1', source: 'mango',
    caller_number: '+15550100001', call_date: '2026-06-01T15:00:00.000Z',
  });

  const result = store.deleteCalls(['mango_call_1']);

  assert.equal(result.deleted, 1);
  assert.equal(store.getCall('mango_call_1'), undefined);
  assert.equal(store.bySource.mango.has('mango_call_1'), false);
  assert.equal(store.byCallerNumber.has('+15550100001'), false);
  assert.equal(store.byCallerKey.has('5550100001'), false);
  assert.equal(store.byDate.get('2026-06-01')?.has('mango_call_1') ?? false, false);
  assert.equal(store.findByExternalId('mango_call_1'), undefined);
});

test('deleteCalls is idempotent — a missing id is reported, never thrown', () => {
  const result = store.deleteCalls(['never_existed']);

  assert.equal(result.deleted, 0);
  assert.deepEqual(result.missing, ['never_existed']);
});

test('deleteCalls takes both legs of a twin — a link never dangles', () => {
  seedTwinPair();

  const result = store.deleteCalls(['mango_call_7001']);

  assert.equal(result.deleted, 2, 'the Retell leg goes with its Mango leg');
  assert.equal(store.getCall('mango_call_7001'), undefined);
  assert.equal(store.getCall('call_retell_7001'), undefined);
});

test('a deleted call is tombstoned and cannot be re-ingested', () => {
  store.addCallInternal({
    id: 'mango_call_legacy', external_id: 'mango_call_legacy', source: 'mango',
    caller_number: '+15550100002', call_date: '2026-01-01T15:00:00.000Z',
  });
  store.deleteCalls(['mango_call_legacy']);

  // The Mango walk finds it again and hands it straight back.
  store.addMangoCalls([{
    id: 'mango_call_legacy', external_id: 'mango_call_legacy',
    caller_number: '+15550100002', call_date: '2026-01-01T15:00:00.000Z',
  }]);

  assert.equal(store.getCall('mango_call_legacy'), undefined, 'the purge must stay purged');
});

test('a deleted Retell call cannot be re-created by a webhook re-delivery', () => {
  store.addRetellCall({ call_id: 'call_purged', from_number: '+15550100003', start_timestamp: 1777908187899 });
  store.deleteCalls(['call_purged']);

  const stored = store.addRetellCall({ call_id: 'call_purged', from_number: '+15550100003', start_timestamp: 1777908187899 });

  assert.equal(stored, null);
  assert.equal(store.getCall('call_purged'), undefined);
});

// --- stub ------------------------------------------------------------------

test('stubCalls replaces the record in place under the same id', () => {
  store.addCallInternal({
    id: 'mango_call_2', external_id: 'mango_call_2', source: 'mango',
    caller_number: '+15550100004', called_number: '+15550199999',
    caller_name: 'Synthetic Fixture', summary: 'a synthetic summary',
    call_date: '2026-06-01T15:00:00.000Z',
  });

  const result = store.stubCalls(['mango_call_2']);
  const stub = store.getCall('mango_call_2');

  assert.equal(result.stubbed, 1);
  assert.equal(retention.isStub(stub), true);
  assert.equal(stub.id, 'mango_call_2');
  assert.equal(JSON.stringify(stub).includes('Synthetic Fixture'), false);
});

test('stubbing drops the caller indexes so a stub can never be matched by phone', () => {
  store.addCallInternal({
    id: 'mango_call_3', external_id: 'mango_call_3', source: 'mango',
    caller_number: '+15550100005', call_date: '2026-06-01T15:00:00.000Z',
  });

  store.stubCalls(['mango_call_3']);

  assert.equal(store.byCallerNumber.has('+15550100005'), false);
  assert.equal(store.byCallerKey.has('5550100005'), false);
  // The date index KEEPS it: a stub still has a date, and the store still owns the id.
  assert.equal(store.byDate.get('2026-06-01').has('mango_call_3'), true);
});

test('stubCalls is idempotent — stubbing a stub changes nothing', () => {
  store.addCallInternal({
    id: 'mango_call_4', external_id: 'mango_call_4', source: 'mango',
    caller_number: '+15550100006', call_date: '2026-06-01T15:00:00.000Z',
  });
  store.stubCalls(['mango_call_4']);
  const first = store.getCall('mango_call_4');

  const result = store.stubCalls(['mango_call_4']);

  assert.equal(result.stubbed, 0);
  assert.equal(result.alreadyStubbed, 1);
  assert.deepEqual(store.getCall('mango_call_4'), first);
});

test('stubCalls takes both legs of a twin, however young the other leg is', () => {
  seedTwinPair();

  const result = store.stubCalls(['mango_call_7001']);

  assert.equal(result.stubbed, 2);
  assert.equal(retention.isStub(store.getCall('mango_call_7001')), true);
  assert.equal(retention.isStub(store.getCall('call_retell_7001')), true);
  // And the link still resolves on both sides.
  assert.equal(store.getCall('mango_call_7001').linked_call_id, 'call_retell_7001');
  assert.equal(store.getCall('call_retell_7001').linked_call_id, 'mango_call_7001');
});

// --- the resurrection guards ----------------------------------------------

test('a Retell webhook re-delivery does not resurrect a stub', () => {
  store.addRetellCall({
    call_id: 'call_stubbed', from_number: '+15550100007',
    start_timestamp: 1777908187899, transcript: 'Agent: hello\n',
  });
  store.stubCalls(['call_stubbed']);

  store.addRetellCall({
    call_id: 'call_stubbed', from_number: '+15550100007',
    start_timestamp: 1777908187899, transcript: 'Agent: hello\n',
  });

  assert.equal(retention.isStub(store.getCall('call_stubbed')), true);
  assert.equal(store.getCall('call_stubbed').transcript, undefined);
});

test('a Mango watermark-overlap re-ingest does not resurrect a stub', () => {
  store.addMangoCalls([{
    id: 'mango_call_5', external_id: 'mango_call_5',
    caller_number: '+15550100008', called_number: '+15550199999',
    call_date: '2026-06-01T15:00:00.000Z', summary: 'a synthetic summary',
  }]);
  store.stubCalls(['mango_call_5']);

  store.addMangoCalls([{
    id: 'mango_call_5', external_id: 'mango_call_5',
    caller_number: '+15550100008', called_number: '+15550199999',
    call_date: '2026-06-01T15:00:00.000Z', summary: 'a synthetic summary',
  }]);

  const after = store.getCall('mango_call_5');
  assert.equal(retention.isStub(after), true);
  assert.equal(after.summary, undefined);
});

test('updateCall refuses to write to a stub', () => {
  store.addCallInternal({
    id: 'mango_call_6', external_id: 'mango_call_6', source: 'mango',
    caller_number: '+15550100009', call_date: '2026-06-01T15:00:00.000Z',
  });
  store.stubCalls(['mango_call_6']);

  assert.equal(store.updateCall('mango_call_6', { triage_status: 'done' }), null);
  assert.equal(store.setDisposition('mango_call_6', 'lab', null), null);
  assert.equal(store.addNote('mango_call_6', 'a note', null), null);
  assert.equal(store.getCall('mango_call_6').triage_status, undefined);
});

test('twin relinking skips stubs entirely', () => {
  seedTwinPair();
  store.stubCalls(['mango_call_7001']);

  // The backlog pass runs on every boot; it must not try to re-link stubs.
  const { linked } = store.relinkAllTwins();

  assert.equal(linked, 0);
  assert.equal(retention.isStub(store.getCall('mango_call_7001')), true);
});

// --- stats -----------------------------------------------------------------

test('getStats counts stubs separately from live calls', () => {
  store.addCallInternal({
    id: 'mango_call_8', external_id: 'mango_call_8', source: 'mango',
    caller_number: '+15550100010', call_date: '2026-06-01T15:00:00.000Z',
  });
  store.addCallInternal({
    id: 'mango_call_9', external_id: 'mango_call_9', source: 'mango',
    caller_number: '+15550100011', call_date: '2026-06-01T15:00:00.000Z',
  });
  store.stubCalls(['mango_call_9']);

  const stats = store.getStats();

  assert.equal(stats.totalCalls, 2, 'the store still holds two records');
  assert.equal(stats.prunedCalls, 1);
  assert.equal(stats.liveCalls, 1);
});
