'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const sched = require('./syncScheduler');
const nextRun = (expr, from) => sched.computeNextCronRun(expr, from);

test('*/5 steps to the next 5-minute boundary (the reported bug)', () => {
  // 14:32 → next */5 fire is 14:35, NOT 15:00 (the old parseInt(*/5)→0 behavior).
  const from = new Date(2026, 6, 23, 14, 32, 10);
  assert.deepEqual(nextRun('*/5 * * * *', from), new Date(2026, 6, 23, 14, 35, 0));
});

test('*/5 already on a boundary advances to the NEXT boundary', () => {
  const from = new Date(2026, 6, 23, 14, 35, 0);
  assert.deepEqual(nextRun('*/5 * * * *', from), new Date(2026, 6, 23, 14, 40, 0));
});

test('fixed minute (hourly at :15) rolls to next hour when past', () => {
  const from = new Date(2026, 6, 23, 14, 20, 0); // past :15
  assert.deepEqual(nextRun('15 * * * *', from), new Date(2026, 6, 23, 15, 15, 0));
});

test('fixed minute later this hour stays in-hour', () => {
  const from = new Date(2026, 6, 23, 14, 5, 0);
  assert.deepEqual(nextRun('15 * * * *', from), new Date(2026, 6, 23, 14, 15, 0));
});

test('every minute is +1 minute', () => {
  const from = new Date(2026, 6, 23, 14, 5, 30);
  assert.deepEqual(nextRun('* * * * *', from), new Date(2026, 6, 23, 14, 6, 0));
});

test('field matcher: *, step, range, and list', () => {
  assert.equal(sched.cronFieldMatches('*', 42, 0), true);
  assert.equal(sched.cronFieldMatches('*/5', 35, 0), true);
  assert.equal(sched.cronFieldMatches('*/5', 33, 0), false);
  assert.equal(sched.cronFieldMatches('10-20', 15, 0), true);
  assert.equal(sched.cronFieldMatches('10-20', 21, 0), false);
  assert.equal(sched.cronFieldMatches('0,15,30,45', 30, 0), true);
  assert.equal(sched.cronFieldMatches('0,15,30,45', 31, 0), false);
});

test('malformed expression returns null (not a crash)', () => {
  assert.equal(nextRun('not a cron', new Date()), null);
  assert.equal(nextRun('*/5 * * *', new Date()), null); // only 4 fields
});

// --- next automatic sync (Sync now's freshness caption) ---------------------
//
// "next auto 1:15 PM" has to account for BOTH cadences: the Mango cron and the 15-minute
// Retell interval. Quoting only the cron would promise a later time than the list will
// actually refresh at.

test('with no cron job armed, the next auto sync is the Retell tick', () => {
  const before = { cronJob: sched.cronJob, nextRetellSync: sched.nextRetellSync };
  try {
    sched.cronJob = null;
    sched.nextRetellSync = '2026-08-11T18:00:00.000Z';
    assert.equal(sched.getNextAutoSync(), '2026-08-11T18:00:00.000Z');
  } finally {
    Object.assign(sched, before);
  }
});

test('the sooner of the two cadences wins', () => {
  const before = { cronJob: sched.cronJob, nextRetellSync: sched.nextRetellSync };
  try {
    // A truthy stand-in for a live cron job: getNextAutoSync only checks that one exists
    // before computing the real next fire from the configured schedule.
    sched.cronJob = { stop() {} };
    const cronNext = sched.computeNextCronRun(require('../config/mango').sync.schedule, new Date());
    assert.ok(cronNext, 'the configured Mango schedule should have a next fire');

    // Retell an hour after the cron → the cron wins.
    sched.nextRetellSync = new Date(cronNext.getTime() + 3_600_000).toISOString();
    assert.equal(sched.getNextAutoSync(), cronNext.toISOString());

    // Retell a minute before the cron → Retell wins.
    const sooner = new Date(cronNext.getTime() - 60_000).toISOString();
    sched.nextRetellSync = sooner;
    assert.equal(sched.getNextAutoSync(), sooner);
  } finally {
    Object.assign(sched, before);
  }
});

test('nothing scheduled at all → null, not a fabricated time', () => {
  const before = { cronJob: sched.cronJob, nextRetellSync: sched.nextRetellSync };
  try {
    sched.cronJob = null;
    sched.nextRetellSync = null;
    assert.equal(sched.getNextAutoSync(), null);
  } finally {
    Object.assign(sched, before);
  }
});

// --- the honest per-source states the manual sync reports -------------------

test("Mango ingestion off returns the MANGO_OFF skip code, not a failure", async () => {
  const before = process.env.MANGO_INGEST_MODE;
  try {
    // mangoConfig reads MANGO_INGEST_MODE at require time, so drive the module the
    // scheduler actually consults rather than the env var.
    const mangoConfig = require('../config/mango');
    const priorMode = mangoConfig.ingestMode;
    mangoConfig.ingestMode = 'off';
    try {
      const result = await sched.runSync({ trigger: 'manual', actor: 'sarah@carein.ai' });
      assert.equal(result.success, false);
      assert.equal(result.code, sched.SYNC_SKIP_OFF);
    } finally {
      mangoConfig.ingestMode = priorMode;
    }
  } finally {
    if (before === undefined) delete process.env.MANGO_INGEST_MODE;
    else process.env.MANGO_INGEST_MODE = before;
  }
});

test('a sync already in flight returns the ALREADY_RUNNING skip code', async () => {
  const mangoConfig = require('../config/mango');
  const priorMode = mangoConfig.ingestMode;
  const priorRunning = sched.isRunning;
  try {
    mangoConfig.ingestMode = 'api';
    sched.isRunning = true;
    const result = await sched.runSync({ trigger: 'manual', actor: 'sarah@carein.ai' });
    assert.equal(result.success, false);
    assert.equal(result.code, sched.SYNC_SKIP_RUNNING);
  } finally {
    mangoConfig.ingestMode = priorMode;
    sched.isRunning = priorRunning;
  }
});

test('getMangoMode reports disabled / off / api', () => {
  const mangoConfig = require('../config/mango');
  const priorMode = mangoConfig.ingestMode;
  const priorDisabled = process.env.MANGO_SYNC_DISABLED;
  try {
    process.env.MANGO_SYNC_DISABLED = 'true';
    assert.equal(sched.getMangoMode(), 'disabled');

    delete process.env.MANGO_SYNC_DISABLED;
    mangoConfig.ingestMode = 'off';
    assert.equal(sched.getMangoMode(), 'off');

    mangoConfig.ingestMode = 'api';
    assert.equal(sched.getMangoMode(), 'api');
  } finally {
    mangoConfig.ingestMode = priorMode;
    if (priorDisabled === undefined) delete process.env.MANGO_SYNC_DISABLED;
    else process.env.MANGO_SYNC_DISABLED = priorDisabled;
  }
});
