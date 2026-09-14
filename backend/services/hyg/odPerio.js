'use strict';

/**
 * The last perio exam Open Dental holds for a patient — READ ONLY (H4 slice 10).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * READ-ONLY BY CONSTRUCTION, THE SAME WAY odDay.js IS
 * ═════════════════════════════════════════════════════════════════════════════
 * Every function takes `odGet(path, params, opts)` and nothing else that can
 * reach Open Dental. There is no write counterpart in scope, and
 * `routes/hyg/hygNoOdWrites.test.js` names this file and proves it: a perio
 * chart written into Open Dental cannot be deleted row by row, so the file that
 * READS perio must not be one refactor away from writing it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TWO READS, BOTH PAGED
 * ═════════════════════════════════════════════════════════════════════════════
 *   GET /perioexams?PatNum=           → the exam headers; pick the newest
 *   GET /periomeasures?PerioExamNum=  → one row per (tooth, SequenceType)
 *
 * Open Dental caps every list at 100 rows. A full-mouth exam is 32 Probing rows
 * plus 32 BleedSupPlaqCalc rows plus whatever else was charted — past one page
 * before recession is even counted — and a truncated read looks exactly like a
 * complete one. Both reads go through `odDay.pagedList`, which keeps asking
 * until a page comes back SHORT and says `truncated` when its budget runs out.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY ROW IS CHECKED AGAINST WHAT WAS ASKED FOR
 * ═════════════════════════════════════════════════════════════════════════════
 * RCM's spikes found Open Dental list endpoints that SILENTLY IGNORE a filter
 * they do not recognise and return everything. For `/perioexams` that would
 * put another patient's pockets beside this patient's chart. So an exam row is
 * kept only when its own `PatNum` is the patient asked about, and a measure row
 * only when its own `PerioExamNum` is the exam asked about. A row that does not
 * say is dropped, not trusted.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONLY WHAT v1 CHARTS IS MAPPED
 * ═════════════════════════════════════════════════════════════════════════════
 * Probing, BleedSupPlaqCalc and SkipTooth. GingMargin, Mobility, Furcation and
 * MGJ rows are read (they arrive on the same pages) and ignored; CAL is never
 * stored by Open Dental and so is never read.
 */

const contract = require('../../hyg/contract.gen.cjs');
const { pagedList, odInt } = require('./odDay');

/** `MBvalue` etc. → the contract's surface codes. */
const SURFACE_FIELDS = Object.freeze({
  MB: 'MBvalue',
  B: 'Bvalue',
  DB: 'DBvalue',
  ML: 'MLvalue',
  L: 'Lvalue',
  DL: 'DLvalue',
});

/**
 * `2025-05-12` from whatever Open Dental put in ExamDate, or null.
 * Its zero date (`0001-01-01`) is "no date", not the year one.
 * @param {unknown} value @returns {string|null}
 */
function examDateOf(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (!m || m[1] === '0001-01-01') return null;
  return m[1];
}

/**
 * Every perio exam Open Dental holds for this patient, unsorted.
 *
 * The filter-ignored guard lives HERE, once: a row is kept only when its own
 * PatNum is the patient asked about. The send (slice 11) reads through this to
 * tell the exam it created from one that was already there, so the guard that
 * keeps a stranger's history off the screen also keeps a stranger's exam from
 * being adopted as ours.
 *
 * @param {Function} odGet
 * @param {{ patNum: number }} opts
 * @returns {Promise<{ ok: true, exams: Array<{ examNum: number, examDate: string|null,
 *                     provNum: number|null }>, odReads: number, dropped: number, truncated: boolean }
 *                   | { ok: false, error: string, odReads: number }>}
 */
async function readExams(odGet, { patNum }) {
  const list = await pagedList(odGet, '/perioexams', { PatNum: patNum });
  if (list.error && list.rows.length === 0) {
    return { ok: false, error: list.error, odReads: list.pages };
  }

  let dropped = 0;
  const exams = [];
  for (const row of list.rows) {
    const examNum = odInt(row && row.PerioExamNum);
    // The filter-ignored guard. See the header.
    if (examNum === null || odInt(row.PatNum) !== patNum) {
      dropped += 1;
      continue;
    }
    exams.push({
      examNum,
      examDate: examDateOf(row.ExamDate),
      provNum: odInt(row.ProvNum),
    });
  }
  return {
    ok: true,
    exams,
    odReads: list.pages,
    dropped,
    truncated: list.truncated || Boolean(list.error),
  };
}

/**
 * One exam's measurement rows, whole or saying it is not.
 *
 * `truncated` matters more to the send than to the screen: a row missing from a
 * truncated read is NOT evidence it is missing from the chart, and posting it on
 * that evidence is how a permanent second copy gets written. The send refuses to
 * post anything on a truncated read.
 *
 * @param {Function} odGet
 * @param {{ examNum: number }} opts
 * @returns {Promise<{ ok: true, rows: object[], truncated: boolean, odReads: number }
 *                   | { ok: false, error: string, odReads: number }>}
 */
async function readExamMeasures(odGet, { examNum }) {
  const list = await pagedList(odGet, '/periomeasures', { PerioExamNum: examNum });
  if (list.error && list.rows.length === 0) {
    return { ok: false, error: list.error, odReads: list.pages };
  }
  return {
    ok: true,
    rows: list.rows.filter((r) => r && odInt(r.PerioExamNum) === examNum),
    truncated: list.truncated || Boolean(list.error),
    odReads: list.pages,
  };
}

/**
 * The newest exam for this patient.
 *
 * Newest by ExamDate, then by PerioExamNum, because two exams on one day is
 * possible and the higher number is the later one. An exam with no readable
 * date sorts last rather than being guessed into a position.
 *
 * @param {Function} odGet
 * @param {{ patNum: number }} opts
 * @returns {Promise<{ ok: true, exam: object|null, odReads: number, dropped: number }
 *                   | { ok: false, error: string, odReads: number }>}
 */
async function readLatestExam(odGet, { patNum }) {
  const read = await readExams(odGet, { patNum });
  if (!read.ok) return read;
  const { exams, dropped } = read;
  const list = { pages: read.odReads };

  exams.sort((a, b) => {
    if (a.examDate !== b.examDate) {
      if (a.examDate === null) return 1;
      if (b.examDate === null) return -1;
      return a.examDate < b.examDate ? 1 : -1;
    }
    return b.examNum - a.examNum;
  });

  return { ok: true, exam: exams[0] || null, odReads: list.pages, dropped };
}

/**
 * One exam's measurement rows → the contract's chart.
 *
 * `-1` on a surface is Open Dental's "no measurement" and becomes `null`, never
 * zero. When the same (tooth, SequenceType) appears twice the higher
 * PerioMeasureNum wins — it is the later write.
 *
 * @param {object[]} rows already filtered to one exam
 * @returns {{ chart: object, ignored: number }}
 */
function chartFromMeasures(rows) {
  let chart = contract.emptyPerioChart();
  let ignored = 0;

  const ordered = [...rows].sort(
    (a, b) => (odInt(a.PerioMeasureNum) ?? 0) - (odInt(b.PerioMeasureNum) ?? 0)
  );

  for (const row of ordered) {
    const tooth = odInt(row.IntTooth);
    if (tooth === null || tooth < 1 || tooth > 32) {
      // Primary teeth and anything unreadable. v1 is the permanent chart.
      ignored += 1;
      continue;
    }
    const type = typeof row.SequenceType === 'string' ? row.SequenceType.trim() : '';

    if (type === 'Probing') {
      for (const [surface, field] of Object.entries(SURFACE_FIELDS)) {
        const v = odInt(row[field]);
        const depth = v !== null && v >= 0 && v <= contract.PERIO_MAX_DEPTH ? v : null;
        chart = contract.withPerioSite(chart, tooth, surface, { depth });
      }
    } else if (type === 'BleedSupPlaqCalc') {
      for (const [surface, field] of Object.entries(SURFACE_FIELDS)) {
        const flags = contract.flagsFromBits(odInt(row[field]));
        chart = contract.withPerioSite(
          chart,
          tooth,
          surface,
          flags || { bleeding: false, suppuration: false, plaque: false, calculus: false }
        );
      }
    } else if (type === 'SkipTooth') {
      chart = contract.withPerioSkipped(chart, tooth, true);
    } else {
      // GingMargin, Mobility, Furcation, MGJ — out of v1's locked scope.
      ignored += 1;
    }
  }

  return { chart: contract.normalizePerioChart(chart), ignored };
}

/**
 * The prior exam, as the contract's three-way answer.
 *
 * Never throws for an Open Dental failure: an unanswered read is
 * `unavailable` with Open Dental's own status line, which the screen draws
 * differently from `none`. A patient with no history and a practice we could
 * not reach are different sentences.
 *
 * @param {Function} odGet
 * @param {{ patNum: number }} opts
 * @returns {Promise<{ prior: object, odReads: number }>}
 */
async function readPriorPerio(odGet, { patNum }) {
  if (!Number.isSafeInteger(patNum) || patNum <= 0) {
    throw new Error('[hyg/odPerio] readPriorPerio requires a positive PatNum');
  }

  const latest = await readLatestExam(odGet, { patNum });
  if (!latest.ok) {
    return {
      odReads: latest.odReads,
      prior: {
        status: 'unavailable',
        message: 'The last perio exam could not be read from Open Dental.',
        detail: String(latest.error).slice(0, 200),
      },
    };
  }
  if (!latest.exam) {
    return { odReads: latest.odReads, prior: { status: 'none' } };
  }

  const { examNum } = latest.exam;
  const list = await pagedList(odGet, '/periomeasures', { PerioExamNum: examNum });
  const odReads = latest.odReads + list.pages;
  if (list.error && list.rows.length === 0) {
    return {
      odReads,
      prior: {
        status: 'unavailable',
        message: 'A perio exam is on file, but its readings could not be read from Open Dental.',
        detail: String(list.error).slice(0, 200),
      },
    };
  }

  const mine = list.rows.filter((r) => r && odInt(r.PerioExamNum) === examNum);
  const { chart } = chartFromMeasures(mine);
  return {
    odReads,
    prior: {
      status: 'found',
      examNum,
      examDate: latest.exam.examDate,
      provNum: latest.exam.provNum,
      chart,
      counts: contract.countPerioChart(chart),
      // A page that failed after the first, or a budget that ran out: some
      // readings are missing and the screen must say so.
      truncated: list.truncated || Boolean(list.error),
    },
  };
}

module.exports = {
  readPriorPerio,
  readLatestExam,
  readExams,
  readExamMeasures,
  chartFromMeasures,
  examDateOf,
  SURFACE_FIELDS,
};
