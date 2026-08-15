'use strict';

/**
 * The EOB extraction cost breaker (decision D-4).
 *
 * The five properties that make a cost rail a rail rather than a suggestion:
 *   1. it accumulates from real token usage,
 *   2. it TRIPS at the cap,
 *   3. it REFUSES at the point of spend, not just at the polite pre-check,
 *   4. it ROLLS at local midnight, not UTC midnight,
 *   5. it SURVIVES a restart.
 *
 * (5) is the one with an incident behind it: the voice transcription counter was
 * in-memory only, so a mid-day container recycle handed back a fresh budget
 * (diagnosis H11). This asserts against a real on-disk doc under a temp
 * CALLSTORE_DIR, not a mock — a persistence test with a stubbed filesystem
 * would have passed for the transcription counter too.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ExtractionBudget, DEFAULT_CAP_CENTS } = require('./extractionBudget');

/** A fresh breaker over its own temp state directory. */
function freshBudget(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-budget-'));
  const prior = { ...process.env };
  process.env.CALLSTORE_DIR = dir;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const budget = new ExtractionBudget();
  return {
    budget,
    dir,
    restore() {
      for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k];
      Object.assign(process.env, prior);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Token usage that prices to roughly `cents` at the default rates. */
function usageWorth(cents) {
  // Output is the expensive side (200¢/Mtok by default), so drive it from there.
  return { prompt_tokens: 0, completion_tokens: Math.ceil((cents * 1_000_000) / 200), total_tokens: 0 };
}

test('the default cap is $10.00, in integer cents', () => {
  assert.equal(DEFAULT_CAP_CENTS, 1000);
  const { budget, restore } = freshBudget();
  try {
    assert.equal(budget.capCents, 1000);
    assert.equal(budget.check().capCents, 1000);
  } finally {
    restore();
  }
});

test('spend accumulates from token usage and is charged UP to the cent', () => {
  const { budget, restore } = freshBudget();
  try {
    // 1 output token at 200¢/Mtok is 0.0002¢ — a rail that rounded this DOWN
    // would count a thousand calls as $0.00.
    const first = budget.charge({ prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 });
    assert.equal(first.chargedCents, 1, 'a sub-cent call must still cost a cent, not zero');

    budget.charge(usageWorth(300));
    assert.equal(budget.check().usedCents, 301);
    assert.equal(budget.check().remainingCents, 699);
  } finally {
    restore();
  }
});

test('the gate trips exactly at the cap and reports the honest numbers', () => {
  const { budget, restore } = freshBudget({ RCM_EXTRACTION_MAX_CENTS_PER_DAY: '500' });
  try {
    budget.charge(usageWorth(499));
    assert.equal(budget.check().allowed, true, '1¢ under the cap is still allowed');

    budget.charge(usageWorth(1));
    const tripped = budget.check();
    assert.equal(tripped.allowed, false);
    assert.equal(tripped.usedCents, 500);
    assert.equal(tripped.capCents, 500);
    assert.equal(tripped.remainingCents, 0);
    assert.ok(Date.parse(tripped.resetsAt) > Date.now(), 'resetsAt must be in the future');
  } finally {
    restore();
  }
});

test('assertAllowed REFUSES at the point of spend, with a typed code', () => {
  const { budget, restore } = freshBudget({ RCM_EXTRACTION_MAX_CENTS_PER_DAY: '100' });
  try {
    budget.assertAllowed(); // fine while unspent
    budget.charge(usageWorth(100));

    // The backstop is what makes the cap impossible to spend past even if a
    // caller skips check() — the reason the transcription rail has both.
    assert.throws(
      () => budget.assertAllowed(),
      (err) => {
        assert.equal(err.code, 'RCM_EXTRACTION_BUDGET_EXCEEDED');
        assert.equal(err.capCents, 100);
        assert.ok(err.resetsAt);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('a cap of 0 means unlimited, not "refuse everything"', () => {
  const { budget, restore } = freshBudget({ RCM_EXTRACTION_MAX_CENTS_PER_DAY: '0' });
  try {
    budget.charge(usageWorth(999_999));
    const state = budget.check();
    assert.equal(state.allowed, true);
    assert.equal(state.remainingCents, Infinity);
    assert.doesNotThrow(() => budget.assertAllowed());
    assert.equal(budget.status().remainingCents, null, 'unlimited surfaces as null, not Infinity');
  } finally {
    restore();
  }
});

test('a non-numeric cap falls back to the default rather than storing NaN', () => {
  const { budget, restore } = freshBudget({ RCM_EXTRACTION_MAX_CENTS_PER_DAY: 'ten dollars' });
  try {
    assert.equal(budget.capCents, DEFAULT_CAP_CENTS);
  } finally {
    restore();
  }
});

test('the counter rolls on the LOCAL day boundary, not the UTC one', () => {
  const { budget, restore } = freshBudget({ RCM_EXTRACTION_BUDGET_TZ: 'America/Chicago' });
  try {
    // 2026-08-14 04:00 UTC is 2026-08-13 23:00 in Chicago — still the 13th
    // locally. A UTC-keyed rail would already have rolled and handed back a
    // fresh $10 four hours before the office closed.
    const lateEvening = new Date('2026-08-14T04:00:00Z');
    budget._rollIfNeeded(lateEvening);
    budget.charge(usageWorth(600), lateEvening);
    assert.equal(budget.dayKey, '2026-08-13');
    assert.equal(budget.check(lateEvening).usedCents, 600);

    // 06:00 UTC is 01:00 Chicago — now it is genuinely the next local day.
    const afterMidnight = new Date('2026-08-14T06:00:00Z');
    const rolled = budget.check(afterMidnight);
    assert.equal(budget.dayKey, '2026-08-14');
    assert.equal(rolled.usedCents, 0);
    assert.equal(rolled.allowed, true);
  } finally {
    restore();
  }
});

test('nextResetIso lands on local midnight', () => {
  const { budget, restore } = freshBudget({ RCM_EXTRACTION_BUDGET_TZ: 'America/Chicago' });
  try {
    const iso = budget.nextResetIso(new Date('2026-08-14T18:30:00Z'));
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Chicago',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
    assert.equal(local, '00:00', `expected local midnight, got ${local} (${iso})`);
  } finally {
    restore();
  }
});

test('spend SURVIVES a restart — a new instance reads the persisted counter', () => {
  const { budget, dir, restore } = freshBudget({ RCM_EXTRACTION_MAX_CENTS_PER_DAY: '400' });
  try {
    budget.charge(usageWorth(400));
    assert.equal(budget.check().allowed, false);

    // The state really is on disk, not just in this object.
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'rcm_extraction_budget.json'), 'utf8'));
    assert.equal(doc.cents_used, 400);
    assert.equal(doc.day_key, budget.dayKey);

    // A "restart": a brand-new instance over the same directory. It must NOT
    // hand back a fresh $4.00.
    const restarted = new ExtractionBudget();
    const state = restarted.check();
    assert.equal(state.usedCents, 400);
    assert.equal(state.allowed, false, 'a restart must not reset the day’s spend');
    assert.equal(restarted.status().persisted, true);
  } finally {
    restore();
  }
});

test('status() names the pause honestly and carries the reset instant', () => {
  const { budget, restore } = freshBudget({ RCM_EXTRACTION_MAX_CENTS_PER_DAY: '50' });
  try {
    assert.equal(budget.status().paused, false);
    budget.charge(usageWorth(50));
    const status = budget.status();
    assert.equal(status.paused, true);
    assert.equal(status.usedCents, 50);
    assert.equal(status.capCents, 50);
    assert.equal(status.remainingCents, 0);
    assert.equal(status.timezone, 'America/Chicago');
    assert.ok(Date.parse(status.resetsAt) > Date.now());
  } finally {
    restore();
  }
});

test('missing or malformed usage charges nothing rather than NaN', () => {
  const { budget, restore } = freshBudget();
  try {
    budget.charge(null);
    budget.charge(undefined);
    budget.charge({ prompt_tokens: 'lots', completion_tokens: null });
    const state = budget.check();
    assert.equal(state.usedCents, 0);
    assert.ok(Number.isInteger(state.usedCents), 'the counter must never become NaN');
  } finally {
    restore();
  }
});
