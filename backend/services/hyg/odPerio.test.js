'use strict';

/**
 * The prior perio exam, read from Open Dental — the pure half (H4 slice 10).
 *
 * Three things here are the reason the file exists:
 *
 *   1. PAGING PAST 100. Open Dental caps a list at 100 rows and a full-mouth
 *      exam is more than that before recession is counted. A reader that stopped
 *      at one page would draw the lower right quadrant as "not charted" and look
 *      completely normal doing it.
 *   2. A FILTER OPEN DENTAL IGNORES. If `?PatNum=` were silently dropped, the
 *      newest exam in the practice would be somebody else's. Rows that do not
 *      name the patient (or the exam) asked about are dropped.
 *   3. THREE ANSWERS. `found`, `none` and `unavailable` are different sentences,
 *      and "no exam on file" is never a chart of zeros.
 *
 * NO PHI: 12827 is the designated roland fixture; exam numbers are synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const odPerio = require('./odPerio');
const contract = require('../../hyg/contract.gen.cjs');

const PAT = 12827;
const EXAM = 5001;

/**
 * A scripted `odGet`. Keys are `path` for the first page and `path?Offset=N`
 * for the rest — scripted explicitly, so an unscripted page answers 404 rather
 * than repeating page one forever.
 */
function scriptedGet(routes) {
  const calls = [];
  const get = async (path, params = {}) => {
    calls.push({ path, params });
    const key = params.Offset !== undefined ? `${path}?Offset=${params.Offset}` : path;
    if (!Object.prototype.hasOwnProperty.call(routes, key)) {
      return { ok: false, status: 404, data: null, error: `'${key}' is not scripted` };
    }
    const v = routes[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && 'ok' in v) return v;
    return { ok: true, status: 200, data: v };
  };
  get.calls = calls;
  return get;
}

let measureNum = 0;
/** One measurement row, in Open Dental's GET shape (H0 §2). */
function measure(tooth, type, [db, b, mb, dl, l, ml], over = {}) {
  measureNum += 1;
  return {
    PerioMeasureNum: measureNum,
    PerioExamNum: EXAM,
    SequenceType: type,
    IntTooth: tooth,
    ToothValue: -1,
    DBvalue: db,
    Bvalue: b,
    MBvalue: mb,
    DLvalue: dl,
    Lvalue: l,
    MLvalue: ml,
    SecDateTEdit: '2025-05-12 09:00:00',
    ...over,
  };
}

/** Four rows per tooth — Probing, GingMargin, BleedSupPlaqCalc, Mobility — × 32 = 128. */
function fullExamRows() {
  const rows = [];
  for (let tooth = 1; tooth <= 32; tooth += 1) {
    rows.push(measure(tooth, 'Probing', [3, 2, 3, 3, 2, 4]));
    rows.push(measure(tooth, 'GingMargin', [0, 0, 0, 0, 0, 0]));
    // Bleeding on DB for every tooth; calculus on ML for tooth 32 only.
    rows.push(measure(tooth, 'BleedSupPlaqCalc', [1, 0, 0, 0, 0, tooth === 32 ? 8 : 0]));
    rows.push(measure(tooth, 'Mobility', [-1, -1, -1, -1, -1, -1], { ToothValue: 1 }));
  }
  return rows;
}

const ONE_EXAM = [{ PerioExamNum: EXAM, PatNum: PAT, ExamDate: '2025-05-12', ProvNum: 7 }];

test('a full exam is 128 rows, and BOTH pages are read — the lower right is not "not charted"', async () => {
  const rows = fullExamRows();
  assert.equal(rows.length, 128);
  const get = scriptedGet({
    '/perioexams': ONE_EXAM,
    '/periomeasures': rows.slice(0, 100),
    '/periomeasures?Offset=100': rows.slice(100),
  });

  const { prior, odReads } = await odPerio.readPriorPerio(get, { patNum: PAT });
  assert.equal(prior.status, 'found');
  assert.equal(prior.truncated, false);

  // Page two was asked for, with the offset, and the exam filter kept.
  const measureCalls = get.calls.filter((c) => c.path === '/periomeasures');
  assert.deepEqual(
    measureCalls.map((c) => c.params),
    [{ PerioExamNum: EXAM }, { PerioExamNum: EXAM, Offset: 100 }]
  );
  assert.equal(odReads, 3, 'one exam list read, two measure pages');

  // Everything on page two landed: tooth #32's rows are all past row 100.
  assert.equal(prior.counts.sitesCharted, 192);
  assert.equal(prior.counts.complete, true);
  assert.equal(prior.chart.teeth['32'].sites.ML.depth, 4);
  assert.equal(prior.chart.teeth['32'].sites.ML.calculus, true);
  assert.equal(prior.counts.bleeding, 32);
  assert.equal(prior.counts.calculus, 1);
});

test('exactly 100 rows is NOT the end of the list — the reader asks once more', async () => {
  const rows = fullExamRows().slice(0, 100);
  const get = scriptedGet({
    '/perioexams': ONE_EXAM,
    '/periomeasures': rows,
    '/periomeasures?Offset=100': [],
  });
  const { prior } = await odPerio.readPriorPerio(get, { patNum: PAT });
  assert.equal(get.calls.filter((c) => c.path === '/periomeasures').length, 2);
  assert.equal(prior.status, 'found');
  assert.equal(prior.truncated, false);
});

test('a measure page that fails after the first is FOUND but TRUNCATED, and says so', async () => {
  const rows = fullExamRows();
  const get = scriptedGet({
    '/perioexams': ONE_EXAM,
    '/periomeasures': rows.slice(0, 100),
    '/periomeasures?Offset=100': { ok: false, status: 504, data: null, error: 'timeout' },
  });
  const { prior } = await odPerio.readPriorPerio(get, { patNum: PAT });
  assert.equal(prior.status, 'found');
  assert.equal(prior.truncated, true, 'three quarters of a chart must not pass for all of it');
  assert.ok(prior.counts.sitesCharted < 192);
});

test('the newest exam wins, by date and then by number; a zero date sorts last', async () => {
  const get = scriptedGet({
    '/perioexams': [
      { PerioExamNum: 10, PatNum: PAT, ExamDate: '2024-01-02', ProvNum: 1 },
      { PerioExamNum: 11, PatNum: PAT, ExamDate: '2025-05-12T00:00:00', ProvNum: 2 },
      { PerioExamNum: 13, PatNum: PAT, ExamDate: '2025-05-12', ProvNum: 3 },
      { PerioExamNum: 99, PatNum: PAT, ExamDate: '0001-01-01', ProvNum: 4 },
    ],
    '/periomeasures': [],
  });
  const latest = await odPerio.readLatestExam(get, { patNum: PAT });
  assert.equal(latest.exam.examNum, 13);
  assert.equal(latest.exam.examDate, '2025-05-12');
  assert.equal(latest.exam.provNum, 3);
});

test('an exam list that ignored ?PatNum= cannot put another patient beside this one', async () => {
  // The newest row belongs to somebody else. If Open Dental dropped the filter,
  // taking the newest row would draw a stranger's pockets on this chart.
  const get = scriptedGet({
    '/perioexams': [
      { PerioExamNum: 777, PatNum: 99999, ExamDate: '2026-09-01', ProvNum: 1 },
      { PerioExamNum: 778, ExamDate: '2026-09-02', ProvNum: 1 },
      { PerioExamNum: EXAM, PatNum: PAT, ExamDate: '2025-05-12', ProvNum: 7 },
    ],
    // And a measure list that ignored ?PerioExamNum= too.
    '/periomeasures': [
      measure(3, 'Probing', [3, 2, 3, -1, -1, -1]),
      measure(3, 'Probing', [9, 9, 9, 9, 9, 9], { PerioExamNum: 777 }),
    ],
  });
  const { prior } = await odPerio.readPriorPerio(get, { patNum: PAT });
  assert.equal(prior.status, 'found');
  assert.equal(prior.examNum, EXAM);
  assert.equal(prior.chart.teeth['3'].sites.DB.depth, 3, "the other exam's 9s were dropped");
});

test('-1 is "no measurement", never zero; flags unpack from one integer; SkipTooth skips', async () => {
  const { chart } = odPerio.chartFromMeasures([
    measure(3, 'Probing', [0, -1, 5, 3, 3, 19]),
    // bleed 1 + sup 2 on DB, plaque 4 + calc 8 on ML, -1 on B.
    measure(3, 'BleedSupPlaqCalc', [3, -1, 0, 0, 0, 12]),
    measure(1, 'SkipTooth', [-1, -1, -1, -1, -1, -1], { ToothValue: 1 }),
    // A primary tooth: ignored, and it does not throw.
    measure(51, 'Probing', [3, 3, 3, 3, 3, 3]),
    // Out of scope even for v2, and read off the same page.
    measure(6, 'MGJ', [2, 2, 2, 2, 2, 2]),
  ]);
  const t3 = chart.teeth['3'].sites;
  assert.equal(t3.DB.depth, 0, 'a zero is a reading');
  assert.equal(t3.B.depth, null, '-1 is not a reading');
  assert.equal(t3.ML.depth, 19);
  assert.deepEqual(
    [t3.DB.bleeding, t3.DB.suppuration, t3.DB.plaque, t3.DB.calculus],
    [true, true, false, false]
  );
  assert.deepEqual(
    [t3.ML.bleeding, t3.ML.suppuration, t3.ML.plaque, t3.ML.calculus],
    [false, false, true, true]
  );
  assert.equal(t3.B.bleeding, false);
  assert.equal(chart.teeth['1'].skipped, true);
  assert.equal(chart.teeth['51'], undefined);
  assert.equal(chart.teeth['6'], undefined, 'MGJ is still out of scope and draws nothing');
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 26: the three v2 types are READ BACK, because the send must verify them
// ─────────────────────────────────────────────────────────────────────────────

test('ITEM 26: a gingival margin comes back as sent, in EITHER family, and -1 is nothing', async () => {
  // `measure()` takes its six values as [DB, B, MB, DL, L, ML].
  const { chart } = odPerio.chartFromMeasures([
    measure(3, 'GingMargin', [2, -1, 0, 101, 119, -1]),
  ]);
  const t3 = chart.teeth['3'].sites;
  // §0's family, taken as the recession it is.
  assert.equal(t3.DB.gm, 2);
  assert.equal(t3.MB.gm, 0, 'a zero margin is a reading');
  // The OTHER family. NOT converted — H0 says subtract 100 and that sign has
  // never been observed. It comes through as what Open Dental holds.
  assert.equal(t3.DL.gm, 101);
  assert.equal(t3.L.gm, 119);
  // And it gets no CAL, however much depth sits beside it.
  assert.equal(contract.perioCal({ ...t3.DL, depth: 4 }), null);
  assert.equal(contract.perioCal({ ...t3.DB, depth: 4 }), 6, 'depth + recession');
  // -1 is "nothing charted", never a value.
  assert.equal(t3.B.gm, null);
  assert.equal(t3.ML.gm, null);
});

test('ITEM 26: a GingMargin row of all -1 is tolerated and read as nothing', async () => {
  // MEASURED: Open Dental really does store an empty GingMargin row. Reading one
  // as a value would put a 0 mm recession on six sites nobody charted.
  const { chart } = odPerio.chartFromMeasures([
    measure(3, 'GingMargin', [-1, -1, -1, -1, -1, -1]),
  ]);
  assert.equal(chart.teeth['3'], undefined, 'a row that says nothing charts nothing');
});

test('ITEM 26: mobility comes back from ToothValue, and the surfaces are ignored', async () => {
  const { chart } = odPerio.chartFromMeasures([
    measure(30, 'Mobility', [-1, -1, -1, -1, -1, -1], { ToothValue: 2 }),
    measure(19, 'Mobility', [-1, -1, -1, -1, -1, -1], { ToothValue: 0 }),
    // Out of the clinical range: read as nothing, so the read-back disagrees with
    // whatever we sent rather than importing a grade no tooth has.
    measure(18, 'Mobility', [-1, -1, -1, -1, -1, -1], { ToothValue: 9 }),
  ]);
  assert.equal(chart.teeth['30'].mobility, 2);
  assert.equal(chart.teeth['19'].mobility, 0, 'grade 0 is a reading — tested, firm');
  assert.equal(chart.teeth['18'], undefined);
});

test('ITEM 26: furcation comes back per site, classes 1-3 only', async () => {
  const { chart } = odPerio.chartFromMeasures([
    measure(3, 'Furcation', [1, 2, 3, -1, -1, -1]),
    // Open Dental ACCEPTED a 5 when the probe sent one (§7), so one may already
    // be in a chart. It is not read as a class.
    measure(14, 'Furcation', [5, -1, -1, -1, -1, -1]),
  ]);
  const t3 = chart.teeth['3'].sites;
  assert.equal(t3.DB.furcation, 1);
  assert.equal(t3.B.furcation, 2);
  assert.equal(t3.MB.furcation, 3);
  assert.equal(t3.ML.furcation, null);
  assert.equal(chart.teeth['14'], undefined, 'there is no class 5');
});

test('no exam on file is NONE — an honest empty, not a chart of zeros', async () => {
  const get = scriptedGet({ '/perioexams': [] });
  const { prior } = await odPerio.readPriorPerio(get, { patNum: PAT });
  assert.deepEqual(prior, { status: 'none' });
  assert.equal(get.calls.some((c) => c.path === '/periomeasures'), false, 'nothing to page');
});

test('Open Dental not answering is UNAVAILABLE, with its own status line', async () => {
  const exams = scriptedGet({
    '/perioexams': { ok: false, status: 503, data: null, error: 'HTTP 503' },
  });
  const a = await odPerio.readPriorPerio(exams, { patNum: PAT });
  assert.equal(a.prior.status, 'unavailable');
  assert.equal(a.prior.detail, 'HTTP 503');

  const measures = scriptedGet({
    '/perioexams': ONE_EXAM,
    '/periomeasures': { ok: false, status: 504, data: null, error: 'timeout of 30000ms exceeded' },
  });
  const b = await odPerio.readPriorPerio(measures, { patNum: PAT });
  assert.equal(b.prior.status, 'unavailable');
  assert.match(b.prior.message, /readings could not be read/);
  assert.match(b.prior.detail, /timeout/);
});

test('an exam with no readings at all is FOUND and empty, not NONE', async () => {
  const get = scriptedGet({ '/perioexams': ONE_EXAM, '/periomeasures': [] });
  const { prior } = await odPerio.readPriorPerio(get, { patNum: PAT });
  assert.equal(prior.status, 'found');
  assert.equal(prior.counts.sitesCharted, 0);
  assert.equal(prior.counts.empty, true);
});

test('the prior answer parses through the SAME contract the screen parses it with', async () => {
  const rows = fullExamRows();
  const get = scriptedGet({
    '/perioexams': ONE_EXAM,
    '/periomeasures': rows.slice(0, 100),
    '/periomeasures?Offset=100': rows.slice(100),
  });
  const { prior } = await odPerio.readPriorPerio(get, { patNum: PAT });
  const parsed = contract.PerioPriorSchema.safeParse(prior);
  assert.ok(parsed.success, JSON.stringify(parsed.error && parsed.error.issues.slice(0, 3)));
});

test('a PatNum that is not a positive integer is refused loudly', async () => {
  await assert.rejects(() => odPerio.readPriorPerio(scriptedGet({}), { patNum: 0 }), /positive PatNum/);
});
