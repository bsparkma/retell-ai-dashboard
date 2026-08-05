/**
 * Tests for the transcription budget's LOCAL (America/Chicago) accounting day and its
 * durable persistence.
 *
 * The bug (diagnosis H1/§3b): the 120 audio-minute breaker rolled on the UTC day. UTC
 * midnight is 7:00 PM CDT, so the 7:15 PM sync spent 35-40% of the *next* business day's
 * budget on the *previous* evening's calls, and the office's day was exhausted by
 * ~12:15 PM CDT — a total afternoon transcription blackout, every business day.
 *
 * The second bug (H11): the counter lived only on the singleton, so a container restart
 * handed back a fresh 120 minutes mid-day.
 *
 * The day key MUST come from real timezone data. A hardcoded -5 or -6 offset fails half
 * the year, so the DST cases below run in both directions.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carein-budget-'));
const SAVED_CALLSTORE_DIR = process.env.CALLSTORE_DIR;
process.env.CALLSTORE_DIR = TMP_DIR;

const svc = require('./transcriptionService');
const { DurableState } = require('./durableState');

const STATE_FILE = path.join(TMP_DIR, 'transcription_budget.json');

let saved;
beforeEach(() => {
  saved = {
    dailyBudgetMinutes: svc.dailyBudgetMinutes,
    budgetTimezone: svc.budgetTimezone,
    dailyKey: svc.dailyKey,
    dailyMinutes: svc.dailyMinutes,
    dailyBudgetTripped: svc.dailyBudgetTripped,
    dailyLoaded: svc._dailyLoaded,
  };
  try { fs.unlinkSync(STATE_FILE); } catch (_) {}
  svc._dailyState.reset();
  svc._dailyLoaded = false;
  svc.dailyKey = null;
  svc.dailyMinutes = 0;
});

afterEach(() => {
  svc.dailyBudgetMinutes = saved.dailyBudgetMinutes;
  svc.budgetTimezone = saved.budgetTimezone;
  svc.dailyKey = saved.dailyKey;
  svc.dailyMinutes = saved.dailyMinutes;
  svc.dailyBudgetTripped = saved.dailyBudgetTripped;
  svc._dailyLoaded = saved.dailyLoaded;
  svc._dailyState.reset();
  try { fs.unlinkSync(STATE_FILE); } catch (_) {}
});

test.after(() => {
  if (SAVED_CALLSTORE_DIR === undefined) delete process.env.CALLSTORE_DIR;
  else process.env.CALLSTORE_DIR = SAVED_CALLSTORE_DIR;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

// ── Local-midnight bucketing ────────────────────────────────────────────────────────

test('the accounting day is America/Chicago, not UTC', () => {
  // 2026-08-04T23:30Z = 6:30 PM CDT on 08-04. Same day either way — a weak case, so pair
  // it with the one that actually diverges: 00:30Z = 7:30 PM CDT on the PREVIOUS day.
  const evening = new Date('2026-08-05T00:30:00Z');
  assert.equal(svc._todayKey(evening), '2026-08-04', '7:30 PM CDT belongs to the local day that is still open');
  assert.equal(evening.toISOString().slice(0, 10), '2026-08-05', 'the old UTC key would have rolled here — the blackout');
});

test('23:59 and 00:01 local land in different day buckets (CDT)', () => {
  // CDT = UTC-5.
  assert.equal(svc._todayKey(new Date('2026-08-05T04:59:00Z')), '2026-08-04'); // 23:59 CDT
  assert.equal(svc._todayKey(new Date('2026-08-05T05:01:00Z')), '2026-08-05'); // 00:01 CDT
});

test('23:59 and 00:01 local land in different day buckets (CST)', () => {
  // CST = UTC-6.
  assert.equal(svc._todayKey(new Date('2026-01-15T05:59:00Z')), '2026-01-14'); // 23:59 CST
  assert.equal(svc._todayKey(new Date('2026-01-15T06:01:00Z')), '2026-01-15'); // 00:01 CST
});

// ── DST boundaries, both directions ─────────────────────────────────────────────────

test('CST → CDT spring-forward (2026-03-08) keeps the whole local day in one bucket', () => {
  // 01:59 CST = 07:59Z; the clock then jumps to 03:00 CDT = 08:00Z. Same local day.
  assert.equal(svc._todayKey(new Date('2026-03-08T07:59:00Z')), '2026-03-08');
  assert.equal(svc._todayKey(new Date('2026-03-08T08:00:00Z')), '2026-03-08');
  // The midnight either side of the transition still splits correctly.
  assert.equal(svc._todayKey(new Date('2026-03-08T05:59:00Z')), '2026-03-07'); // 23:59 CST
  assert.equal(svc._todayKey(new Date('2026-03-08T06:01:00Z')), '2026-03-08'); // 00:01 CST
  assert.equal(svc._todayKey(new Date('2026-03-09T04:59:00Z')), '2026-03-08'); // 23:59 CDT
  assert.equal(svc._todayKey(new Date('2026-03-09T05:01:00Z')), '2026-03-09'); // 00:01 CDT
});

test('CDT → CST fall-back (2026-11-01) keeps the repeated hour in one bucket', () => {
  // 01:30 happens twice: 06:30Z (CDT) and 07:30Z (CST). Both are 2026-11-01 locally.
  assert.equal(svc._todayKey(new Date('2026-11-01T06:30:00Z')), '2026-11-01');
  assert.equal(svc._todayKey(new Date('2026-11-01T07:30:00Z')), '2026-11-01');
  assert.equal(svc._todayKey(new Date('2026-11-01T04:59:00Z')), '2026-10-31'); // 23:59 CDT
  assert.equal(svc._todayKey(new Date('2026-11-01T05:01:00Z')), '2026-11-01'); // 00:01 CDT
  assert.equal(svc._todayKey(new Date('2026-11-02T05:59:00Z')), '2026-11-01'); // 23:59 CST
  assert.equal(svc._todayKey(new Date('2026-11-02T06:01:00Z')), '2026-11-02'); // 00:01 CST
});

test('no hardcoded offset: the same wall-clock time maps to different UTC instants in summer and winter', () => {
  // If the implementation used a fixed offset, one of these two would be off by an hour.
  assert.equal(svc._todayKey(new Date('2026-07-01T05:30:00Z')), '2026-07-01'); // 00:30 CDT (-5)
  assert.equal(svc._todayKey(new Date('2026-12-01T05:30:00Z')), '2026-11-30'); // 23:30 CST (-6)
});

// ── Roll + persistence ──────────────────────────────────────────────────────────────

test('a local day roll resets the counters and persists the new day', () => {
  svc.dailyKey = '2020-01-01';
  svc.dailyMinutes = 99;
  svc.dailyBudgetTripped = true;

  svc._rollDailyIfNeeded();

  assert.equal(svc.dailyKey, svc._todayKey());
  assert.equal(svc.dailyMinutes, 0);
  assert.equal(svc.dailyBudgetTripped, false);

  const doc = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  assert.equal(doc.day_key, svc._todayKey());
  assert.equal(doc.minutes_used, 0);
});

test('a restart mid-day restores minutesUsed instead of handing back a fresh budget (H11)', () => {
  const today = svc._todayKey();

  // Simulate a process that already spent 90 of its 120 minutes today.
  svc.dailyKey = today;
  svc.dailyMinutes = 90;
  svc._saveDailyState();

  // Simulate the restart: forget everything in memory, reload from disk.
  svc.dailyKey = null;
  svc.dailyMinutes = 0;
  svc._dailyLoaded = false;
  svc._dailyState.reset();

  svc.dailyBudgetMinutes = 120;
  const budget = svc.checkDailyBudget();

  assert.equal(svc.dailyKey, today);
  assert.equal(svc.dailyMinutes, 90, 'the restart does NOT hand back a fresh 120 minutes');
  assert.equal(budget.remainingMinutes, 30);
});

test('persisted state from a PREVIOUS day is discarded on load', () => {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ day_key: '2020-05-05', minutes_used: 118 }), 'utf-8');
  svc._dailyState.reset();
  svc._dailyLoaded = false;
  svc.dailyKey = null;
  svc.dailyMinutes = 0;
  svc.dailyBudgetMinutes = 120;

  const budget = svc.checkDailyBudget();
  assert.equal(svc.dailyKey, svc._todayKey());
  assert.equal(budget.usedMinutes, 0, 'yesterday’s spend does not eat today’s budget');
});

// ── Graceful degradation where there is no durable volume (staging) ─────────────────

test('a missing/unwritable state directory degrades to in-memory without throwing', () => {
  // Point at a path that cannot be a directory (it is an existing FILE), so mkdir fails.
  const blocker = path.join(TMP_DIR, 'not-a-dir');
  fs.writeFileSync(blocker, 'x', 'utf-8');

  const savedDir = process.env.CALLSTORE_DIR;
  process.env.CALLSTORE_DIR = blocker;
  const warnings = [];
  const savedWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));

  try {
    const state = new DurableState('degrade-probe.json', { minutes_used: 0 });
    const first = state.read(); // must not throw
    assert.deepEqual(first.minutes_used, 0);
    state.write({ minutes_used: 42 }); // must not throw
    assert.equal(state.read().minutes_used, 42, 'in-memory state still works');
    assert.equal(state.durable, false, 'and it knows it is not durable');

    state.write({ minutes_used: 43 });
    assert.equal(warnings.filter((w) => w.includes('degrade-probe.json')).length, 1,
      'exactly ONE startup line about degrading, not one per write');
  } finally {
    console.warn = savedWarn;
    process.env.CALLSTORE_DIR = savedDir;
  }
});
