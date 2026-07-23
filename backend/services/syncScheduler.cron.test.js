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
