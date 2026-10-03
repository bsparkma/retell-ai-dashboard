'use strict';

/**
 * THE MISSING-TEETH READ, AGAINST THE SHAPES OPEN DENTAL ACTUALLY ANSWERS WITH.
 *
 * Every fake below is built from the probe run of 2026-10-01 (staging revision
 * --0000206, roland, designated test patients only), captured in
 * `new-dashboard/tests/fixtures/od-toothinitials-measured.json`. Item 18 shipped
 * without this feature because the docs could not settle the first two of these,
 * so a fake that models them loosely would put the guess back:
 *
 *   - absence is `200` + `[]`, NOT GroupNotes' 404-with-a-sentence
 *   - `ToothNum` is a STRING, and the rows do not arrive in tooth order
 *   - only `InitialType === 'Missing'` means the tooth is not in the mouth
 *   - unfiltered, this endpoint answers with the WHOLE PRACTICE
 *
 * NO PHI: 12827 and 12828 are the designated roland fixtures.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { readMissingTeeth, permanentToothNum, OD_PAGE_SIZE } = require('./odToothInitials');

const PAT = 12828;
const OTHER_PAT = 12827;

/** One `toothinitial` row, field for field as the probe printed them. */
function initialRow({ num = 1, patNum = PAT, toothNum = '1', initialType = 'Missing' } = {}) {
  return {
    ToothInitialNum: num,
    PatNum: patNum,
    // MEASURED AS A STRING. A fake that answered a number here would let a
    // `===` comparison pass in tests and fail on staging.
    ToothNum: toothNum,
    InitialType: initialType,
    Movement: 0,
    DrawingSegment: '',
    ColorDraw: '',
    SecDateTEntry: '2026-04-02 09:14:11',
    SecDateTEdit: '2026-04-02 09:14:11',
    DrawText: '',
  };
}

/**
 * The exact five rows 12828 answered with — out of tooth order, as measured.
 * "1","16","9","32","17".
 */
function measuredFiveRows() {
  return ['1', '16', '9', '32', '17'].map((toothNum, i) =>
    initialRow({ num: 400 + i, toothNum })
  );
}

/** A recording odGet. `answer` may be a function of the params. */
function fakeOd(answer) {
  const calls = [];
  const odGet = async (path, params, opts) => {
    calls.push({ path, params, opts });
    const value = typeof answer === 'function' ? answer(params) : answer;
    if (value && typeof value === 'object' && 'ok' in value) return value;
    return { ok: true, status: 200, data: value };
  };
  return { odGet, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// The measured shape
// ─────────────────────────────────────────────────────────────────────────────

test('the five Missing rows 12828 answered with become teeth 1, 9, 16, 17, 32 — parsed and sorted', async () => {
  const od = fakeOd(measuredFiveRows());
  const res = await readMissingTeeth(od.odGet, { patNum: PAT });

  assert.equal(res.preSkip.status, 'ready');
  // SORTED. The rows arrived 1,16,9,32,17 and a chart reads left to right.
  assert.deepEqual(res.preSkip.teeth, [1, 9, 16, 17, 32]);
  assert.equal(res.missing, 5);
  assert.equal(res.foreign, 0);
  assert.equal(res.unparsed, 0);
  assert.equal(res.truncated, false);
  assert.equal(res.error, null);
});

test('every tooth comes back a NUMBER even though Open Dental sent strings', async () => {
  const od = fakeOd(measuredFiveRows());
  const res = await readMissingTeeth(od.odGet, { patNum: PAT });
  for (const tooth of res.preSkip.teeth) {
    assert.equal(typeof tooth, 'number', 'the chart indexes teeth by number');
    assert.ok(Number.isInteger(tooth));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ABSENCE IS NOT FAILURE — the measurement item 18 refused to guess
// ─────────────────────────────────────────────────────────────────────────────

test('ABSENCE: 200 with an empty array is `ready` with no teeth, never `unavailable`', async () => {
  // Measured on 12827: ok=true, status=200, body=array(0).
  const od = fakeOd({ ok: true, status: 200, data: [] });
  const res = await readMissingTeeth(od.odGet, { patNum: OTHER_PAT });

  assert.equal(res.preSkip.status, 'ready', 'an empty list is an ANSWER: no missing teeth');
  assert.deepEqual(res.preSkip.teeth, []);
  assert.equal(res.error, null);
  assert.equal(res.rows, 0);
});

test('FAILURE: a non-ok read is `unavailable` and carries Open Dental’s own status line', async () => {
  const od = fakeOd({ ok: false, status: 503, data: null, error: 'Service Unavailable' });
  const res = await readMissingTeeth(od.odGet, { patNum: PAT });

  assert.equal(res.preSkip.status, 'unavailable');
  assert.equal(res.error, 'Service Unavailable');
  // Nothing is claimed about this patient's teeth in either direction.
  assert.equal(res.missing, 0);
});

test('the two are TOLD APART, which is the whole reason the probe was run', async () => {
  const absent = await readMissingTeeth(fakeOd({ ok: true, status: 200, data: [] }).odGet, {
    patNum: OTHER_PAT,
  });
  const failed = await readMissingTeeth(
    fakeOd({ ok: false, status: 404, data: null, error: 'not found' }).odGet,
    { patNum: OTHER_PAT }
  );
  assert.notEqual(absent.preSkip.status, failed.preSkip.status);
  assert.equal(absent.preSkip.status, 'ready');
  assert.equal(failed.preSkip.status, 'unavailable');
});

test('a 200 carrying something that is NOT a list is unavailable, not an absence', async () => {
  // Guessing "no missing teeth" from a shape this code cannot read is exactly
  // the failure the absence measurement exists to prevent.
  for (const data of [null, undefined, {}, 'Missing', 42]) {
    const res = await readMissingTeeth(fakeOd({ ok: true, status: 200, data }).odGet, { patNum: PAT });
    assert.equal(res.preSkip.status, 'unavailable', 'data=' + JSON.stringify(data));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Rows that must be ignored, and rows that must be SHOUTED about
// ─────────────────────────────────────────────────────────────────────────────

test('a PRIMARY tooth letter is ignored, and does not make the read fail', async () => {
  const od = fakeOd([
    initialRow({ num: 1, toothNum: 'A' }),
    initialRow({ num: 2, toothNum: 'T' }),
    initialRow({ num: 3, toothNum: '19' }),
  ]);
  const res = await readMissingTeeth(od.odGet, { patNum: PAT });

  assert.equal(res.preSkip.status, 'ready', 'a child on the schedule is not a failed read');
  assert.deepEqual(res.preSkip.teeth, [19], 'only the permanent tooth');
  assert.equal(res.unparsed, 2);
});

test('a row for ANOTHER PatNum is dropped and COUNTED — the unfiltered-endpoint hazard', async () => {
  /*
   * Unfiltered, this endpoint answered 100 rows across 28 PatNums. The filter
   * was honoured in the probe, so this case models what a SILENTLY IGNORED
   * parameter would look like: somebody else's missing teeth arriving on this
   * patient's chart.
   */
  const od = fakeOd([
    initialRow({ num: 1, toothNum: '3' }),
    initialRow({ num: 2, toothNum: '14', patNum: OTHER_PAT }),
    initialRow({ num: 3, toothNum: '30', patNum: 99999 }),
  ]);
  const res = await readMissingTeeth(od.odGet, { patNum: PAT });

  assert.deepEqual(res.preSkip.teeth, [3], 'only the patient we asked about');
  assert.equal(res.foreign, 2, 'and the route logs this count, once');
  assert.equal(res.unparsed, 0, 'a foreign row is foreign, not unparseable');
});

test('a row that does not SAY whose it is counts as foreign — not trusted by default', async () => {
  const od = fakeOd([
    { ToothInitialNum: 1, ToothNum: '8', InitialType: 'Missing' },
    { ToothInitialNum: 2, PatNum: null, ToothNum: '9', InitialType: 'Missing' },
    initialRow({ num: 3, toothNum: '10' }),
  ]);
  const res = await readMissingTeeth(od.odGet, { patNum: PAT });
  assert.deepEqual(res.preSkip.teeth, [10]);
  assert.equal(res.foreign, 2);
});

test('only InitialType `Missing` pre-skips — every other type is a tooth that gets probed', async () => {
  const types = ['Hidden', 'Primary', 'ShiftM', 'ShiftO', 'ShiftB', 'Rotate', 'TipM', 'TipB'];
  const od = fakeOd([
    ...types.map((initialType, i) => initialRow({ num: 10 + i, toothNum: String(i + 2), initialType })),
    initialRow({ num: 90, toothNum: '30' }),
  ]);
  const res = await readMissingTeeth(od.odGet, { patNum: PAT });

  assert.deepEqual(res.preSkip.teeth, [30], 'a rotated tooth still gets probed');
  assert.equal(res.unparsed, 0, 'an unwanted TYPE is not an unparseable row');
});

test('the match on `Missing` is EXACT — case and whitespace included', async () => {
  const od = fakeOd([
    initialRow({ num: 1, toothNum: '3', initialType: 'missing' }),
    initialRow({ num: 2, toothNum: '4', initialType: 'MISSING' }),
    initialRow({ num: 3, toothNum: '5', initialType: ' Missing' }),
    initialRow({ num: 4, toothNum: '6', initialType: 'Missing' }),
  ]);
  const res = await readMissingTeeth(od.odGet, { patNum: PAT });
  // `Missing` is the value measured. Accepting near-misses would mean accepting
  // a value Open Dental has never been observed to send.
  assert.deepEqual(res.preSkip.teeth, [6]);
});

test('the same tooth marked twice is skipped once', async () => {
  const od = fakeOd([
    initialRow({ num: 1, toothNum: '18' }),
    initialRow({ num: 2, toothNum: '18' }),
  ]);
  const res = await readMissingTeeth(od.odGet, { patNum: PAT });
  assert.deepEqual(res.preSkip.teeth, [18]);
  assert.equal(res.missing, 1);
});

test('a junk row is counted, not thrown', async () => {
  const od = fakeOd([null, 'Missing', 7, initialRow({ num: 1, toothNum: '2' })]);
  const res = await readMissingTeeth(od.odGet, { patNum: PAT });
  assert.deepEqual(res.preSkip.teeth, [2]);
  assert.equal(res.unparsed, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// The request itself
// ─────────────────────────────────────────────────────────────────────────────

test('PatNum IS ALWAYS PASSED, and exactly one request is made', async () => {
  const od = fakeOd(measuredFiveRows());
  await readMissingTeeth(od.odGet, { patNum: PAT });

  assert.equal(od.calls.length, 1, 'one request — this does not page');
  assert.equal(od.calls[0].path, '/toothinitials');
  assert.deepEqual(od.calls[0].params, { PatNum: PAT });
  assert.ok(
    Object.prototype.hasOwnProperty.call(od.calls[0].params, 'PatNum'),
    'unfiltered, this endpoint answers with the whole practice'
  );
});

test('no PatNum to ask about spends NO request at all', async () => {
  for (const patNum of [0, -1, null, undefined, 1.5, NaN, '12828']) {
    const od = fakeOd(measuredFiveRows());
    const res = await readMissingTeeth(od.odGet, { patNum });
    assert.equal(res.preSkip.status, 'unavailable', 'patNum=' + String(patNum));
    assert.equal(od.calls.length, 0, 'patNum=' + String(patNum));
  }
});

test('a full page is reported as TRUNCATED rather than passed off as complete', async () => {
  // One request is the budget, so a patient with more than a page of initials is
  // read short. The teeth seen still pre-skip — under-skipping is today's
  // behaviour for the rest — but the answer says it was cut off.
  const rows = Array.from({ length: OD_PAGE_SIZE }, (_, i) =>
    initialRow({ num: 1000 + i, toothNum: String((i % 32) + 1) })
  );
  const od = fakeOd(rows);
  const res = await readMissingTeeth(od.odGet, { patNum: PAT });

  assert.equal(res.truncated, true);
  assert.equal(res.preSkip.status, 'ready', 'what was read is still usable');
  assert.equal(od.calls.length, 1, 'and it still did not page');
});

test('a short page is not truncated', async () => {
  const rows = Array.from({ length: OD_PAGE_SIZE - 1 }, (_, i) =>
    initialRow({ num: 2000 + i, toothNum: String((i % 32) + 1) })
  );
  const res = await readMissingTeeth(fakeOd(rows).odGet, { patNum: PAT });
  assert.equal(res.truncated, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// The parser on its own
// ─────────────────────────────────────────────────────────────────────────────

test('permanentToothNum parses what Open Dental sends and refuses the rest', () => {
  // Measured: strings.
  assert.equal(permanentToothNum('1'), 1);
  assert.equal(permanentToothNum('32'), 32);
  assert.equal(permanentToothNum(' 9 '), 9);
  // Tolerated, in case a build ever answers a number.
  assert.equal(permanentToothNum(16), 16);
  // Primary dentition — ignored, not an error.
  for (const letter of ['A', 'T', 'a', 'J']) assert.equal(permanentToothNum(letter), null);
  // Out of the permanent range, including supernumeraries.
  for (const value of ['0', '33', '51', '99']) assert.equal(permanentToothNum(value), null);
  // Not a tooth at all. "12B" must NOT read as 12 — that would be a guess.
  for (const value of ['', '  ', '12B', '1.5', 'Missing', null, undefined, {}, []]) {
    assert.equal(permanentToothNum(value), null, JSON.stringify(value));
  }
});
