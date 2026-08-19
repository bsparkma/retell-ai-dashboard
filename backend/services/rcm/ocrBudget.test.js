'use strict';

/**
 * The OCR cost breaker.
 *
 * The same five properties the extraction rail is held to — accumulate, trip,
 * refuse at the point of spend, roll at LOCAL midnight, survive a restart —
 * plus the two this rail has that that one cannot:
 *
 *   6. it prices a job BEFORE spending, because a page count is knowable and a
 *      token count is not, so a document it cannot afford IN FULL is refused
 *      rather than started;
 *   7. it is SEPARATE from the extraction rail. Spending one must not move the
 *      other by a cent, in either direction — that separation is the whole
 *      reason there are two files, and it is asserted here rather than assumed.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OcrBudget, DEFAULT_CAP_CENTS, DEFAULT_CENTS_PER_KPAGE } = require('./ocrBudget');

/** A fresh breaker over its own temp state directory. */
function freshBudget(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-ocr-budget-'));
  const prior = { ...process.env };
  process.env.CALLSTORE_DIR = dir;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const budget = new OcrBudget();
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

test('the default cap is $2.00 and the default rate is the S0 prebuilt-read list price', () => {
  assert.equal(DEFAULT_CAP_CENTS, 200);
  // $1.50 per 1,000 pages, verified against the Azure retail price API.
  assert.equal(DEFAULT_CENTS_PER_KPAGE, 150);
  const { budget, restore } = freshBudget();
  try {
    assert.equal(budget.capCents, 200);
    // $2.00 at $1.50/1,000 pages is ~1,333 pages a day. Stated as an assertion
    // so the sizing argument in the header cannot drift away from the numbers.
    assert.ok(Math.floor((200 * 1000) / 150) > 1300);
  } finally {
    restore();
  }
});

test('pages are priced UP to the cent — a one-page read is never free', () => {
  const { budget, restore } = freshBudget();
  try {
    // One page really costs 0.15¢. A rail that rounded that DOWN would count a
    // thousand single-page scans as $0.00, which is the failure mode the cap
    // exists to prevent, expressed as a rounding choice.
    assert.equal(budget.costOfPages(1), 1);
    assert.equal(budget.costOfPages(7), 2); // 1.05¢ → 2¢
    assert.equal(budget.costOfPages(1000), 150);
    assert.equal(budget.costOfPages(0), 0, 'no pages, no charge');
    assert.equal(budget.costOfPages(-3), 0, 'a negative page count is not a refund');
    assert.equal(budget.costOfPages('nonsense'), 0);
  } finally {
    restore();
  }
});

test('spend accumulates from the pages ACTUALLY read', () => {
  const { budget, restore } = freshBudget();
  try {
    const first = budget.charge(10);
    assert.equal(first.chargedCents, 2); // 1.5¢ → 2¢
    assert.equal(first.pages, 10);

    const second = budget.charge(1000);
    assert.equal(second.chargedCents, 150);
    assert.equal(second.usedCents, 152);
    assert.equal(budget.pagesRead, 1010);
  } finally {
    restore();
  }
});

test('a job it cannot afford IN FULL is refused before anything is sent', () => {
  const { budget, restore } = freshBudget({ RCM_OCR_MAX_CENTS_PER_DAY: '10' });
  try {
    budget.charge(50); // 7.5¢ → 8¢ used of 10¢

    // Without a page count all the rail can say is "there is something left" —
    // which is all the token rail can EVER say.
    assert.equal(budget.check().allowed, true);

    // With one, it can answer the real question. A 20-page document costs 3¢ and
    // would take the day to 11¢, so it is refused NOW rather than half-read.
    assert.equal(budget.check(20).allowed, false);
    assert.equal(budget.check(20).estimatedCents, 3);

    // A document that fits still goes through.
    assert.equal(budget.check(10).allowed, true, '10 pages is 2¢ and 8+2 = the cap exactly');
  } finally {
    restore();
  }
});

test('assertAllowed REFUSES at the point of spend, with a typed code and a reset', () => {
  const { budget, restore } = freshBudget({ RCM_OCR_MAX_CENTS_PER_DAY: '5' });
  try {
    budget.charge(1000); // 150¢, far past a 5¢ cap
    assert.throws(
      () => budget.assertAllowed(1),
      (err) => {
        assert.equal(err.code, 'RCM_OCR_BUDGET_EXCEEDED');
        // The distinct code is the point: `RCM_EXTRACTION_BUDGET_EXCEEDED` and
        // this one must never be confusable, because the biller is told which
        // cap stopped her and when THAT one resets.
        assert.notEqual(err.code, 'RCM_EXTRACTION_BUDGET_EXCEEDED');
        assert.equal(err.capCents, 5);
        assert.equal(err.usedCents, 150);
        assert.match(err.resetsAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.match(err.message, /OCR/i, 'the message names the rail, not just "the cap"');
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('the two rails are independent — spending one moves the other by nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-two-rails-'));
  const prior = { ...process.env };
  process.env.CALLSTORE_DIR = dir;
  try {
    const extraction = require('./extractionBudget');
    extraction._resetForTests();
    const ocr = new OcrBudget();

    // 2,000 pages of OCR: $3.00, comfortably past the OCR cap.
    ocr.charge(2000);
    assert.equal(ocr.check().allowed, false, 'the OCR rail is spent');
    assert.equal(
      extraction.check().usedCents,
      0,
      'and the extraction rail has not moved — a morning of scans cannot eat the ' +
        "afternoon's extraction money"
    );
    assert.equal(extraction.check().allowed, true);

    // And the reverse: tokens do not consume pages.
    extraction.charge({ prompt_tokens: 0, completion_tokens: 10_000_000, total_tokens: 10_000_000 });
    assert.equal(ocr.centsUsed, 300, 'the OCR counter is untouched by a token charge');

    extraction._resetForTests();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k];
    Object.assign(process.env, prior);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the two rails persist to DIFFERENT documents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-rail-files-'));
  const prior = { ...process.env };
  process.env.CALLSTORE_DIR = dir;
  try {
    const extraction = require('./extractionBudget');
    extraction._resetForTests();
    const ocr = new OcrBudget();

    ocr.charge(100);
    extraction.charge({ prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 });

    const written = fs.readdirSync(dir).sort();
    // One file for two counters would make a restart hand one rail the other's
    // spend — the persistence bug the transcription rail had, with a new shape.
    assert.ok(written.includes('rcm_ocr_budget.json'), `expected the OCR doc; saw ${written}`);
    assert.ok(written.includes('rcm_extraction_budget.json'), `expected the LLM doc; saw ${written}`);

    extraction._resetForTests();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k];
    Object.assign(process.env, prior);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a cap of 0 means unlimited, not "refuse everything"', () => {
  const { budget, restore } = freshBudget({ RCM_OCR_MAX_CENTS_PER_DAY: '0' });
  try {
    budget.charge(100_000);
    assert.equal(budget.check().allowed, true);
    assert.equal(budget.check(50_000).allowed, true, 'and a page estimate cannot trip it either');
    assert.equal(budget.check().remainingCents, Infinity);
    assert.equal(budget.status().remainingCents, null, 'Infinity is not JSON — the wire says null');
  } finally {
    restore();
  }
});

test('a non-numeric cap or rate falls back to the default rather than storing NaN', () => {
  const { budget, restore } = freshBudget({
    RCM_OCR_MAX_CENTS_PER_DAY: 'lots',
    RCM_OCR_CENTS_PER_KPAGE: 'cheap',
  });
  try {
    assert.equal(budget.capCents, DEFAULT_CAP_CENTS);
    assert.equal(budget.costOfPages(1000), DEFAULT_CENTS_PER_KPAGE);
  } finally {
    restore();
  }
});

test('the counter rolls on the LOCAL day boundary, not the UTC one', () => {
  const { budget, restore } = freshBudget({ RCM_OCR_BUDGET_TZ: 'America/Chicago' });
  try {
    // 2026-08-19 23:30 UTC is still 18:30 on the 19th in Chicago — mid-evening,
    // which is exactly when a UTC roll would hand back a fresh cap mid-shift.
    const beforeUtcMidnight = new Date('2026-08-19T23:30:00Z');
    budget._rollIfNeeded(beforeUtcMidnight);
    budget.charge(1000, beforeUtcMidnight);
    assert.equal(budget.centsUsed, 150);

    const afterUtcMidnight = new Date('2026-08-20T02:00:00Z'); // 21:00 on the 19th, Chicago
    assert.equal(budget.check(null, afterUtcMidnight).usedCents, 150, 'same local day, same spend');

    const nextLocalDay = new Date('2026-08-20T06:00:00Z'); // 01:00 on the 20th, Chicago
    assert.equal(budget.check(null, nextLocalDay).usedCents, 0, 'a new local day is a new cap');
  } finally {
    restore();
  }
});

test('nextResetIso lands on local midnight, across a DST boundary', () => {
  const { budget, restore } = freshBudget({ RCM_OCR_BUDGET_TZ: 'America/Chicago' });
  try {
    const inZone = (iso) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Chicago',
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(iso));

    assert.equal(inZone(budget.nextResetIso(new Date('2026-08-19T18:00:00Z'))), '00:00');
    // The day the clocks go forward. A naive "+24h from local midnight" lands on
    // 01:00 here, which would silently move the reset an hour every spring.
    assert.equal(inZone(budget.nextResetIso(new Date('2027-03-14T02:00:00Z'))), '00:00');
    // ...and back, where the naive version lands on 23:00 the previous day.
    assert.equal(inZone(budget.nextResetIso(new Date('2026-11-01T02:00:00Z'))), '00:00');
  } finally {
    restore();
  }
});

test('spend SURVIVES a restart — a new instance reads the persisted counter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-ocr-restart-'));
  const prior = { ...process.env };
  process.env.CALLSTORE_DIR = dir;
  try {
    const first = new OcrBudget();
    first.charge(500); // 75¢
    assert.equal(first.centsUsed, 75);

    // A new object over the same directory is what a container restart looks
    // like. Against a mocked filesystem this test would pass even if nothing
    // were written, which is why it uses a real one.
    const second = new OcrBudget();
    assert.equal(second.check().usedCents, 75, 'a restart must not hand back a fresh cap');
    assert.equal(second.status().pagesRead, 500);
    assert.equal(second.status().persisted, true);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k];
    Object.assign(process.env, prior);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status() names the rail, the pause and the reset instant', () => {
  const { budget, restore } = freshBudget({ RCM_OCR_MAX_CENTS_PER_DAY: '10' });
  try {
    const running = budget.status();
    assert.equal(running.rail, 'ocr', 'the payload says which rail it is, not just which key held it');
    assert.equal(running.paused, false);
    assert.equal(running.capCents, 10);
    assert.equal(running.centsPerKPage, 150);

    budget.charge(1000);
    const paused = budget.status();
    assert.equal(paused.paused, true);
    assert.equal(paused.pagesRead, 1000);
    assert.match(paused.resetsAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(paused.timezone, 'America/Chicago');
  } finally {
    restore();
  }
});

test('a missing or malformed page count charges nothing rather than NaN', () => {
  const { budget, restore } = freshBudget();
  try {
    assert.equal(budget.charge(undefined).chargedCents, 0);
    assert.equal(budget.charge(null).chargedCents, 0);
    assert.equal(budget.charge('twelve').chargedCents, 0);
    assert.equal(budget.centsUsed, 0, 'and the counter is still a number');
    assert.equal(budget.pagesRead, 0);
  } finally {
    restore();
  }
});
