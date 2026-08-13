'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterEach } = test;

const retentionConfig = require('./retention');

const ENV_KEYS = ['CALL_RETENTION_DAYS', 'CALL_RETENTION_SCHEDULE', 'OFFICE_TIMEZONE'];
const saved = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('retention defaults to 30 days when unset', () => {
  delete process.env.CALL_RETENTION_DAYS;

  assert.equal(retentionConfig.retentionDays(), 30);
  assert.equal(retentionConfig.isEnabled(), true);
});

test('CALL_RETENTION_DAYS=0 disables pruning', () => {
  process.env.CALL_RETENTION_DAYS = '0';

  assert.equal(retentionConfig.retentionDays(), 0);
  assert.equal(retentionConfig.isEnabled(), false);
});

test('a non-numeric or negative CALL_RETENTION_DAYS falls back to the default', () => {
  // Same shape as MAX_TRANSCRIPTION_MINUTES_PER_DAY: a typo must not silently
  // become NaN and prune (or refuse to prune) by accident.
  for (const bad of ['thirty', '', '-5', '30d']) {
    process.env.CALL_RETENTION_DAYS = bad;
    assert.equal(retentionConfig.retentionDays(), 30, `'${bad}' should fall back to 30`);
  }
});

test('the schedule is a quiet hour by default and is validated', () => {
  delete process.env.CALL_RETENTION_SCHEDULE;
  assert.equal(retentionConfig.schedule(), '30 3 * * *');

  process.env.CALL_RETENTION_SCHEDULE = '15 4 * * *';
  assert.equal(retentionConfig.schedule(), '15 4 * * *');

  // An invalid cron must not silently mean "never runs" — fall back to the default.
  process.env.CALL_RETENTION_SCHEDULE = 'not a cron';
  assert.equal(retentionConfig.schedule(), '30 3 * * *');
});

test('the pruner runs on office time, not container time', () => {
  // The whole point of a "quiet hour" is that it is quiet at the PRACTICE. If this
  // followed the container clock, 3:30am UTC would be 9:30pm Central — mid-evening.
  delete process.env.OFFICE_TIMEZONE;
  assert.equal(retentionConfig.timezone(), 'America/Chicago');

  process.env.OFFICE_TIMEZONE = 'America/New_York';
  assert.equal(retentionConfig.timezone(), 'America/New_York');
});
