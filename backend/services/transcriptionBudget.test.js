/**
 * Tests for the transcription daily circuit breaker (cost-investigation #2c).
 * Guarantees no code path can bill Azure Speech beyond MAX_TRANSCRIPTION_MINUTES_PER_DAY.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterEach } = test;

const svc = require('./transcriptionService');

// Snapshot the breaker fields so each test restores them.
let saved;
afterEach(() => {
  Object.assign(svc, saved);
});
test.beforeEach(() => {
  saved = {
    dailyBudgetMinutes: svc.dailyBudgetMinutes,
    dailyKey: svc.dailyKey,
    dailyMinutes: svc.dailyMinutes,
    dailyBudgetTripped: svc.dailyBudgetTripped,
    isInitialized: svc.isInitialized,
    provider: svc.provider,
    authMode: svc.authMode,
    apiKey: svc.apiKey,
    endpoint: svc.endpoint,
  };
});

test('checkDailyBudget allows transcription under the cap', () => {
  svc.dailyBudgetMinutes = 120;
  svc.dailyKey = svc._todayKey();
  svc.dailyMinutes = 30;
  const b = svc.checkDailyBudget();
  assert.equal(b.allowed, true);
  assert.equal(b.usedMinutes, 30);
  assert.equal(b.capMinutes, 120);
  assert.equal(b.remainingMinutes, 90);
});

test('checkDailyBudget blocks transcription once the cap is reached', () => {
  svc.dailyBudgetMinutes = 120;
  svc.dailyKey = svc._todayKey();
  svc.dailyMinutes = 120;
  assert.equal(svc.checkDailyBudget().allowed, false);
});

test('counters reset when the UTC day rolls over', () => {
  svc.dailyBudgetMinutes = 120;
  svc.dailyKey = '2020-01-01'; // a stale day
  svc.dailyMinutes = 999;
  svc.dailyBudgetTripped = true;
  const b = svc.checkDailyBudget(); // triggers _rollDailyIfNeeded
  assert.equal(b.allowed, true);
  assert.equal(b.usedMinutes, 0);
  assert.equal(svc.dailyKey, svc._todayKey());
  assert.equal(svc.dailyBudgetTripped, false);
});

test('cap of 0 disables the breaker (unlimited)', () => {
  svc.dailyBudgetMinutes = 0;
  svc.dailyKey = svc._todayKey();
  svc.dailyMinutes = 10_000;
  const b = svc.checkDailyBudget();
  assert.equal(b.allowed, true);
  assert.equal(b.remainingMinutes, Infinity);
});

test('transcribeBuffer hard-throws TRANSCRIPTION_BUDGET_EXCEEDED before any network call', async () => {
  // Force an initialized provider so we reach the budget backstop (not the init guard).
  svc.isInitialized = true;
  svc.provider = 'azure';
  svc.authMode = 'api_key';
  svc.apiKey = 'test-key';
  svc.endpoint = 'https://unused.example';
  svc.dailyBudgetMinutes = 1;
  svc.dailyKey = svc._todayKey();
  svc.dailyMinutes = 5; // over cap

  await assert.rejects(
    () => svc.transcribeBuffer(Buffer.from('fake-audio'), 'x.mp3'),
    (err) => err && err.code === 'TRANSCRIPTION_BUDGET_EXCEEDED',
  );
});
