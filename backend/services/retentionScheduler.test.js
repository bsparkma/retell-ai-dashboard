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
const registry = require('../platform/registry');
const retentionConfig = require('../config/retention');

const saved = {};
const ENV_KEYS = ['CALL_RETENTION_DAYS', 'CALL_RETENTION_SCHEDULE'];
for (const k of ENV_KEYS) saved[k] = process.env[k];

let originalCreateJob;
let originalRequestPersist;
let originalPersist;
const originalGetPlatformSetting = registry.getPlatformSetting;
/**
 * What the stubbed control plane answers for the stored window.
 *
 * `null` means NO ROW HAS EVER BEEN WRITTEN — the state every environment starts
 * in, and the one that hands control back to CALL_RETENTION_DAYS. It is not the
 * same as an unreachable control plane, which is stubbed per-test by throwing.
 * @type {{ value: unknown }|null}
 */
let storedWindow;
/** Every createJob call this test made, so the wiring can be asserted. */
let jobs;

beforeEach(() => {
  jobs = [];
  originalCreateJob = scheduler.createJob;
  originalRequestPersist = store.requestPersist;
  originalPersist = store.persist;

  // runNow() re-reads the stored window before every pass, so these tests need
  // a control plane to read. Without a stub the read fails, `policyKnown()`
  // stays false, and the pruner refuses — a real behaviour, asserted below, but
  // not the one most of these tests are about.
  storedWindow = null;
  registry.getPlatformSetting = async () =>
    storedWindow === null
      ? null
      : {
          key: 'call_retention_days',
          value: storedWindow.value,
          updated_at: new Date('2026-08-13T10:00:00Z'),
          updated_by: 'admin@carein.ai',
        };
  retentionConfig.resetCacheForTests();

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
  registry.getPlatformSetting = originalGetPlatformSetting;
  retentionConfig.resetCacheForTests();
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

// --- the stored window (Platform Console, PR C) -----------------------------

/** A call `age` days old, with a synthetic caller and no real content. */
function seedAgedCall(id, age) {
  store.addCallInternal({
    id,
    external_id: id,
    source: 'mango',
    caller_number: '+15550100999',
    call_date: new Date(Date.now() - age * 24 * 60 * 60 * 1000).toISOString(),
    summary: 'a synthetic summary',
  });
}

test('the STORED window beats the environment — the console, not the app setting, is the policy', async () => {
  process.env.CALL_RETENTION_DAYS = '30';
  storedWindow = { value: 90 };
  // 40 days old: past the environment's 30, comfortably inside the stored 90.
  seedAgedCall('mango_call_40d', 40);

  const result = await scheduler.runNow();

  assert.equal(result.stubbed, 0, 'a 40-day-old call is inside a 90-day window');
  assert.equal(scheduler.getStatus().retentionDays, 90);
  assert.equal(scheduler.getStatus().source, 'db');
});

test('runNow() re-reads the window every pass — not a boot-time snapshot', async () => {
  process.env.CALL_RETENTION_DAYS = '30';
  storedWindow = { value: 90 };
  seedAgedCall('mango_call_40d_b', 40);

  // First pass under the stored 90: nothing is old enough.
  assert.equal((await scheduler.runNow()).stubbed, 0);

  // Somebody shortens it in the console between the two nightly runs.
  storedWindow = { value: 30 };

  const second = await scheduler.runNow();
  assert.equal(second.stubbed, 1, 'the shortened window must apply on the very next run');
  assert.equal(scheduler.getStatus().retentionDays, 30);
});

test('with NO stored row the environment still governs — the env var is not dead', async () => {
  process.env.CALL_RETENTION_DAYS = '30';
  storedWindow = null;
  seedAgedCall('mango_call_40d_c', 40);

  const result = await scheduler.runNow();

  assert.equal(result.stubbed, 1);
  assert.equal(scheduler.getStatus().source, 'env');
});

test('an unreadable control plane REFUSES to prune rather than guess the policy', async () => {
  process.env.CALL_RETENTION_DAYS = '30';
  registry.getPlatformSetting = async () => {
    throw new Error('control plane unreachable');
  };
  seedAgedCall('mango_call_40d_d', 40);

  const result = await scheduler.runNow();

  assert.equal(
    result.skipped,
    'RETENTION_POLICY_UNKNOWN',
    'a stored 90 we cannot see must not be overridden by an environment 30 — that is 60 days of records'
  );
  assert.equal(result.stubbed, 0);
  assert.equal(store.getCall('mango_call_40d_d').record_kind !== 'stub', true);
});

test('a control-plane blip AFTER a good read keeps pruning on the last known window', async () => {
  process.env.CALL_RETENTION_DAYS = '90';
  storedWindow = { value: 30 };

  // One good read establishes the policy.
  await scheduler.runNow();
  assert.equal(scheduler.getStatus().retentionDays, 30);

  // Now the control plane goes away mid-life.
  registry.getPlatformSetting = async () => {
    throw new Error('transient blip');
  };
  seedAgedCall('mango_call_40d_e', 40);

  const result = await scheduler.runNow();

  assert.equal(result.stubbed, 1, 'a blip must not silently widen the window to the env 90');
  assert.equal(scheduler.getStatus().retentionDays, 30);
});

test('a stored value the app cannot parse is ignored, and the environment takes over', async () => {
  process.env.CALL_RETENTION_DAYS = '30';
  storedWindow = { value: 'thirty' };
  seedAgedCall('mango_call_40d_f', 40);

  const result = await scheduler.runNow();

  assert.equal(result.stubbed, 1);
  assert.equal(scheduler.getStatus().source, 'env');
});
