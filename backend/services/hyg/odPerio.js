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
 * A patient with NO perio exams answers **HTTP 200 with an empty array** — not
 * the 404-with-a-sentence that `/procedurelogs/GroupNotes?PatNum=` gives for the
 * same question (item 21, `isNoGroupNotesAnswer`). Measured 2026-09-29, and the
 * capture is new-dashboard/tests/fixtures/od-perioexams-none-measured.json. That
 * asymmetry is load-bearing for item 14's drift check: the one case it exists for
 * — a `Written` chart whose only exam was deleted — arrives here as a clean empty
 * list, so nothing has to recognise a refusal as an absence, and a refusal stays
 * a refusal.
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
 * Probing, BleedSupPlaqCalc, SkipTooth, and — since item 26 — GingMargin,
 * Furcation and Mobility. MGJ is read (it arrives on the same pages) and ignored;
 * CAL is never stored by Open Dental and so is never read.
 *
 * ⚠️ ITEM 26's THREE ARE MAPPED SO THE SEND CAN READ BACK WHAT IT WROTE. A row
 * posted and never verified is a row the send would claim without checking, and
 * `Written` means every site was read back and matched.
 *
 * A GINGIVAL MARGIN IS TAKEN AS SENT, IN EITHER FAMILY. Open Dental accepts 0–19
 * and 101–119 and stores both verbatim (item 19 §2). §0 proved the low family is
 * recession, which is the only one CareIN writes — but a row written by somebody
 * else can carry the other one, and this reader does not convert it. It comes
 * through as the number Open Dental holds, and `perioCal` refuses to compute a
 * CAL from it. H0 says subtract 100; that sign has never been observed, and a
 * guess here becomes a clinical number that looks plausible.
 *
 * A row whose every surface is `-1` carries nothing, which is a shape Open Dental
 * really does store (measured). It is tolerated and read as "nothing charted" —
 * never as a value.
 */

const contract = require('../../hyg/contract.gen.cjs');
const { pagedList, odInt } = require('./odDay');

/** Item 26's three SequenceTypes → the change kind each one is compared as. */
const V2_KINDS = Object.freeze({ GingMargin: 'gm', Furcation: 'furcation', Mobility: 'mobility' });

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
 * The newest exam for this patient.
 *
 * Newest by ExamDate, then by PerioExamNum, because two exams on one day is
 * possible and the higher number is the later one. An exam with no readable
 * date sorts last rather than being guessed into a position.
 *
 * @param {Function} odGet
 * @param {{ patNum: number }} opts
 * @returns {Promise<{ ok: true, exam: object|null, exams: object[], truncated: boolean,
 *                     odReads: number, dropped: number }
 *                   | { ok: false, error: string, exams: object[], truncated: boolean, odReads: number }>}
 */
async function readLatestExam(odGet, { patNum }) {
  const list = await pagedList(odGet, '/perioexams', { PatNum: patNum });
  if (list.error && list.rows.length === 0) {
    return { ok: false, error: list.error, exams: [], truncated: true, odReads: list.pages };
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

  exams.sort((a, b) => {
    if (a.examDate !== b.examDate) {
      if (a.examDate === null) return 1;
      if (b.examDate === null) return -1;
      return a.examDate < b.examDate ? 1 : -1;
    }
    return b.examNum - a.examNum;
  });

  return {
    ok: true,
    exam: exams[0] || null,
    // The whole filtered list, so a caller asking "is exam N present?" does not
    // have to read `/perioexams` a second time to find out (item 14).
    exams,
    truncated: list.truncated || Boolean(list.error),
    odReads: list.pages,
    dropped,
  };
}

/**
 * One exam's measurement rows → the contract's chart.
 *
 * `-1` on a surface is Open Dental's "no measurement" and becomes `null`, never
 * zero. When the same (tooth, SequenceType) appears twice the higher
 * PerioMeasureNum wins — it is the later write.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ITEM 31: A v2 VALUE IT CANNOT INTERPRET IS NAMED, NOT ABSORBED
 * ═════════════════════════════════════════════════════════════════════════════
 * A GingMargin outside both families, a Furcation outside classes 1–3, a Mobility
 * grade outside 0–3, or a v2 row on a tooth it cannot place all land in the chart
 * as `null` — "nothing charted" — because the chart has no way to hold them. That
 * is right for the chart and WRONG for a comparison: CareIN never writes such a
 * value, so one being there means somebody put it there, and comparing the `null`
 * would either say "matches" (when CareIN also wrote nothing) or report it as
 * "not charted" (when it is charted, with something unreadable).
 *
 * So each one is listed in `uninterpretable`, with where it is and the raw value,
 * and the drift check refuses to call that position matching. `-1` is NOT on the
 * list: it is Open Dental's own "nothing here", and an all-`-1` row is a shape it
 * really stores (measured, item 26).
 *
 * v1 rows are unchanged — what they did before item 31 they still do.
 *
 * @param {object[]} rows already filtered to one exam
 * @returns {{ chart: object, ignored: number,
 *             uninterpretable: Array<{ tooth: number|null, surface: string|null, kind: string, raw: unknown }> }}
 */
function chartFromMeasures(rows) {
  let chart = contract.emptyPerioChart();
  let ignored = 0;
  /**
   * Keyed by position, so the later of two rows for one (tooth, type) decides it
   * exactly as it decides the chart: a readable later row clears an unreadable
   * earlier one, and an unreadable later row replaces a readable one.
   */
  // A readable position is recorded as `null`, never removed: this file is
  // scanned for write-shaped calls (hygNoOdWrites.test.js), and a `.delete(` on
  // a local Map reads exactly like one.
  const unreadable = new Map();
  /** `-1` is OD's absence. Anything else that did not map is unreadable. */
  const note = (tooth, surface, kind, raw, known) => {
    const key = `${tooth}|${surface}|${kind}`;
    const readable = known || odInt(raw) === -1;
    unreadable.set(key, readable ? null : { tooth, surface, kind, raw: raw === undefined ? null : raw });
  };

  const ordered = [...rows].sort(
    (a, b) => (odInt(a.PerioMeasureNum) ?? 0) - (odInt(b.PerioMeasureNum) ?? 0)
  );

  for (const row of ordered) {
    const tooth = odInt(row.IntTooth);
    const type = typeof row.SequenceType === 'string' ? row.SequenceType.trim() : '';
    if (tooth === null || tooth < 1 || tooth > 32) {
      // Primary teeth and anything unreadable. v1 is the permanent chart.
      ignored += 1;
      // ITEM 31: a v2 row CareIN cannot place, CARRYING a value, is still a
      // value somebody wrote. An all -1 one carries nothing and is let go.
      if (V2_KINDS[type]) {
        const fields = type === 'Mobility' ? ['ToothValue'] : Object.values(SURFACE_FIELDS);
        if (fields.some((f) => odInt(row[f]) !== -1)) {
          // Set directly, NOT through `note`: its `-1` test is for a VALUE, and a
          // row on IntTooth -1 carrying a grade would otherwise read as absent.
          const kind = V2_KINDS[type];
          unreadable.set(`${tooth}|null|${kind}`, { tooth, surface: null, kind, raw: row.IntTooth ?? null });
        }
      }
      continue;
    }

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
    } else if (type === 'GingMargin') {
      // ITEM 26. Either family, as sent — see the header.
      const { recessionMin, recessionMax, otherMin, otherMax } = contract.PERIO_GM_FAMILIES;
      for (const [surface, field] of Object.entries(SURFACE_FIELDS)) {
        const v = odInt(row[field]);
        const known =
          v !== null && ((v >= recessionMin && v <= recessionMax) || (v >= otherMin && v <= otherMax));
        note(tooth, surface, 'gm', row[field], known);
        chart = contract.withPerioSite(chart, tooth, surface, { gm: known ? v : null });
      }
    } else if (type === 'Furcation') {
      for (const [surface, field] of Object.entries(SURFACE_FIELDS)) {
        const v = odInt(row[field]);
        /*
         * CLASSES 1–3 ONLY, EVEN ON THE WAY IN. Open Dental accepted and stored a
         * `5` when the probe sent one (§7), so a value outside the clinical range
         * is already in some chart somewhere. Reading it as a class would carry
         * that corruption into CareIN's comparison; it is read as nothing charted,
         * and the read-back then disagrees with what we sent, which is the honest
         * outcome.
         */
        const known = v !== null && v >= contract.PERIO_MIN_FURCATION && v <= contract.PERIO_MAX_FURCATION;
        note(tooth, surface, 'furcation', row[field], known);
        chart = contract.withPerioSite(chart, tooth, surface, { furcation: known ? v : null });
      }
    } else if (type === 'Mobility') {
      // PER TOOTH: the grade is in ToothValue and the surface columns are -1.
      const v = odInt(row.ToothValue);
      const known = v !== null && v >= 0 && v <= contract.PERIO_MAX_MOBILITY;
      note(tooth, null, 'mobility', row.ToothValue, known);
      chart = contract.withPerioMobility(chart, tooth, known ? v : null);
    } else {
      // MGJ — out of scope, and read off the same pages.
      ignored += 1;
    }
  }

  return { chart: contract.normalizePerioChart(chart), ignored, uninterpretable: [...unreadable.values()].filter(Boolean) };
}

/**
 * The prior exam, as the contract's three-way answer.
 *
 * Never throws for an Open Dental failure: an unanswered read is
 * `unavailable` with Open Dental's own status line, which the screen draws
 * differently from `none`. A patient with no history and a practice we could
 * not reach are different sentences.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT ALSO HANDS BACK WHAT IT READ, SO ITEM 14 NEEDS NO SECOND REQUEST
 * ═════════════════════════════════════════════════════════════════════════════
 * The drift check (services/hyg/perioDrift.js) asks whether the exam CareIN
 * wrote is still in Open Dental. That is the SAME `/perioexams?PatNum=` answer
 * this function already has, and the same `/periomeasures` answer whenever the
 * exam in question is the newest one — which it is on every ordinary open of a
 * chart CareIN wrote. So `exams` and `latest` are returned alongside `prior`
 * rather than re-fetched: one exam-list read per open, and measures only for an
 * exam that is still there.
 *
 * `exams.ok` is the LIST read's own verdict, not the prior panel's. They differ:
 * a list whose later pages failed still yields a newest exam (`prior: 'found'`)
 * while being useless for "is exam N present?", because an exam missing from
 * half a list is not missing from the chart. So `ok` is false when any page
 * failed or the page budget ran out, and the drift check answers `unknown`.
 *
 * @param {Function} odGet
 * @param {{ patNum: number }} opts
 * @returns {Promise<{ prior: object, odReads: number,
 *                     exams: { ok: boolean, list: Array<object>, error: string|null },
 *                     latest: { examNum: number, chart: object, uninterpretable: object[] }|null }>}
 */
async function readPriorPerio(odGet, { patNum }) {
  if (!Number.isSafeInteger(patNum) || patNum <= 0) {
    throw new Error('[hyg/odPerio] readPriorPerio requires a positive PatNum');
  }

  const latest = await readLatestExam(odGet, { patNum });
  /**
   * Every exam the list read returned, for this patient, and whether the read
   * was WHOLE. `readLatestExam` tolerates a partial list because a newest exam
   * from half a list is still a real exam; presence does not tolerate it.
   */
  const exams = {
    ok: latest.ok && !latest.truncated,
    list: latest.exams || [],
    error: latest.ok ? (latest.truncated ? 'the exam list came back truncated' : null) : String(latest.error),
  };
  if (!latest.ok) {
    return {
      odReads: latest.odReads,
      exams,
      latest: null,
      prior: {
        status: 'unavailable',
        message: 'The last perio exam could not be read from Open Dental.',
        detail: String(latest.error).slice(0, 200),
      },
    };
  }
  if (!latest.exam) {
    return { odReads: latest.odReads, exams, latest: null, prior: { status: 'none' } };
  }

  const { examNum } = latest.exam;
  const list = await pagedList(odGet, '/periomeasures', { PerioExamNum: examNum });
  const odReads = latest.odReads + list.pages;
  if (list.error && list.rows.length === 0) {
    return {
      odReads,
      exams,
      latest: null,
      prior: {
        status: 'unavailable',
        message: 'A perio exam is on file, but its readings could not be read from Open Dental.',
        detail: String(list.error).slice(0, 200),
      },
    };
  }

  const mine = list.rows.filter((r) => r && odInt(r.PerioExamNum) === examNum);
  const { chart, uninterpretable } = chartFromMeasures(mine);
  // A page that failed after the first, or a budget that ran out: some
  // readings are missing and the screen must say so.
  const truncated = list.truncated || Boolean(list.error);
  return {
    odReads,
    exams,
    // A PARTIAL chart is not a baseline anything may be compared against: the
    // sites that did not come back would read as changed. Withheld, so the
    // drift check reaches its own honest `unknown` instead.
    latest: truncated ? null : { examNum, chart, uninterpretable },
    prior: {
      status: 'found',
      examNum,
      examDate: latest.exam.examDate,
      provNum: latest.exam.provNum,
      chart,
      counts: contract.countPerioChart(chart),
      truncated,
    },
  };
}

/**
 * Every exam this patient has, for the SEND (item 12).
 *
 * The send must tell the exam IT created from one that was already there, so it
 * reads the list before it posts and again after. Unlike `readLatestExam`, a
 * failed page here is a failure, whole: an exam missing from half a list is not
 * missing from the chart, and "no new exam appeared" read off a partial list is
 * how a second exam header gets posted.
 *
 * @param {Function} odGet
 * @param {{ patNum: number }} opts
 * @returns {Promise<{ ok: true, exams: Array<{ examNum: number, examDate: string|null, provNum: number|null }>,
 *                     truncated: boolean, odReads: number }
 *                   | { ok: false, error: string, odReads: number }>}
 */
async function readExams(odGet, { patNum }) {
  const list = await pagedList(odGet, '/perioexams', { PatNum: patNum });
  if (list.error) return { ok: false, error: String(list.error), odReads: list.pages };
  const exams = [];
  for (const row of list.rows) {
    const examNum = odInt(row && row.PerioExamNum);
    // The filter-ignored guard. See the header.
    if (examNum === null || odInt(row.PatNum) !== patNum) continue;
    exams.push({ examNum, examDate: examDateOf(row.ExamDate), provNum: odInt(row.ProvNum) });
  }
  return { ok: true, exams, truncated: list.truncated, odReads: list.pages };
}

/**
 * One exam's measurement rows, for the send's read-before-write and its
 * read-back — WHOLE, or reported as not whole.
 *
 * @param {Function} odGet
 * @param {{ examNum: number }} opts
 * @returns {Promise<{ ok: true, rows: object[], truncated: boolean, odReads: number }
 *                   | { ok: false, error: string, odReads: number }>}
 */
async function readExamMeasures(odGet, { examNum }) {
  const list = await pagedList(odGet, '/periomeasures', { PerioExamNum: examNum });
  if (list.error) return { ok: false, error: String(list.error), odReads: list.pages };
  return {
    ok: true,
    rows: list.rows.filter((r) => r && odInt(r.PerioExamNum) === examNum),
    truncated: list.truncated,
    odReads: list.pages,
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
  V2_KINDS,
};
