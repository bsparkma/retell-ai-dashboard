'use strict';

/**
 * The nightly retention job's decisions.
 *
 * NOTE ON THE SEAM. These tests override `createJob` rather than letting a real
 * node-cron task be scheduled. That is not squeamishness: a live cron task inside
 * a file that `node --test` runs concurrently with forty others keeps that child
 * process alive past its last assertion, and the runner's IPC then intermittently
 * dies with "Unable to deserialize cloned data" — attributing the failure to
 * whichever unrelated file it happened to be parsing at the time. Overriding the
 * one method that touches node-cron makes these tests assert what we actually
 * care about (the schedule and timezone we hand it) rather than node-cron itself.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const scheduler = require('./retentionScheduler');
const store = require('./unifiedCallStore');

const saved = {};
const ENV_KEYS = ['CALL_RETENTION_DAYS', 'CALL_RETENTION_SCHEDULE'];
for (const k of ENV_KEYS) saved[k] = process.env[k];

let originalCreateJob;
let originalRequestPersist;
let originalPersist;
/** Every createJob call this test made, so the wiring can be asserted. */
let jobs;

beforeEach(() => {
  jobs = [];
  originalCreateJob = scheduler.createJob;
  originalRequestPersist = store.requestPersist;
  originalPersist = store.persist;
  scheduler.createJob = (schedule, timezone, handler) => {
    const job = { schedule, timezone, handler, stopped: false, stop() { this.stopped = true; } };
    jobs.push(job);
    return job;
  };
  store.requestPersist = () => {};
  store.persist = async () => {};
  store.clear();
});

afterEach(() => {
  scheduler.stop();
  scheduler.createJob = originalCreateJob;
  store.requestPersist = originalRequestPersist;
  store.persist = originalPersist;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('start() schedules the nightly prune on OFFICE time, not container time', () => {
  delete process.env.CALL_RETENTION_DAYS;
  delete process.env.CALL_RETENTION_SCHEDULE;

  const started = scheduler.start();

  assert.equal(started, true);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].schedule, '30 3 * * *');
  assert.equal(
    jobs[0].timezone, 'America/Chicago',
    'a quiet hour on UTC lands at 9:30pm Central — mid-evening, while calls still come in'
  );
  assert.equal(scheduler.getStatus().running, true);
});

test('start() is a no-op when retention is switched off', () => {
  process.env.CALL_RETENTION_DAYS = '0';

  const started = scheduler.start();

  assert.equal(started, false);
  assert.equal(jobs.length, 0, 'nothing may be scheduled when nothing may be pruned');
  assert.equal(scheduler.getStatus().running, false);
});

test('start() twice schedules only one job', () => {
  scheduler.start();
  const second = scheduler.start();

  assert.equal(second, false);
  assert.equal(jobs.length, 1);
});

test('stop() releases the job so start() can arm a fresh one', () => {
  scheduler.start();
  scheduler.stop();

  assert.equal(jobs[0].stopped, true);
  assert.equal(scheduler.getStatus().running, false);
  scheduler.start();
  assert.equal(jobs.length, 2);
});

test('the scheduled handler is the prune — firing it prunes', async () => {
  process.env.CALL_RETENTION_DAYS = '30';
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  store.addCallInternal({
    id: 'mango_call_fired', external_id: 'mango_call_fired', source: 'mango',
    caller_number: '+15550100321', call_date: old, summary: 'a synthetic summary',
  });
  scheduler.start();

  await jobs[0].handler();

  assert.equal(scheduler.getStatus().lastRun.stubbed, 1);
});

test('runNow() prunes using the configured window and records the run', async () => {
  process.env.CALL_RETENTION_DAYS = '30';
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  store.addCallInternal({
    id: 'mango_call_sched', external_id: 'mango_call_sched', source: 'mango',
    caller_number: '+15550100123', call_date: old, summary: 'a synthetic summary',
  });

  const result = await scheduler.runNow();

  assert.equal(result.stubbed, 1);
  assert.equal(scheduler.getStatus().lastRun.stubbed, 1);
  assert.equal(typeof scheduler.getStatus().lastRun.at, 'string');
});

test('runNow() declines when retention is switched off', async () => {
  process.env.CALL_RETENTION_DAYS = '0';

  const result = await scheduler.runNow();

  assert.equal(result.skipped, 'RETENTION_DISABLED');
  assert.equal(result.stubbed, 0);
});
