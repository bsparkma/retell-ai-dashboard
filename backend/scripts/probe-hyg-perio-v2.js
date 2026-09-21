#!/usr/bin/env node
'use strict';

/**
 * Probe Open Dental's NON-PROBING perio rows — recession (GingMargin), furcation
 * and mobility — before one line of product code writes them (item 19).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═════════════════════════════════════════════════════════════════════════════
 * The v2 flags cannot ride arch strings (item 11 measured: strings carry depths
 * and the four BleedSupPlaqCalc flags, nothing else). H0 documents them as
 * per-row `POST /periomeasures` with a constraint table — GingMargin 101–119
 * encodes negative, Mobility lives in ToothValue with every surface -1,
 * Furcation is per surface — all marked **Docs**, never exercised. The per-row
 * surface has only ever carried PROBING rows. The arch-string probe exists
 * because a "documented" surface silently corrupted charts; same doctrine here.
 *
 * CAL IS NOT PROBED AND NOT WRITTEN, EVER. Open Dental derives its own CAL from
 * Probing + GingMargin, so a written CAL could disagree with the chart of record.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY IT IS SAFE — READ BEFORE RUNNING
 * ═════════════════════════════════════════════════════════════════════════════
 * It WRITES to a live practice database, and its safety is one property:
 *
 *   IT ONLY EVER WRITES INTO EXAMS IT CREATED IN THE SAME RUN, and
 *   `DELETE /perioexams/{n}` removes an exam and every row in it — the one
 *   complete undo perio has (Q6 proves that holds for v2 rows too).
 *
 * So:
 *   - roland PatNum 12828 ONLY. Every other office and PatNum is refused.
 *   - refused when OPENDENTAL_WRITE_DISABLED is set.
 *   - `--dry` prints every payload and touches Open Dental not at all.
 *   - every exam is recorded in a manifest THE MOMENT it exists, and printed in
 *     a box. `--cleanup <n>[,<n>…]` deletes exactly those — only if the manifest
 *     recorded them (or with `--force-cleanup`), only after reading that the exam
 *     is 12828's — then reads every deleted exam's rows back to prove they went.
 *   - a measurement row is posted ONLY into an exam number this run minted. There
 *     is no path that posts a row into an exam it did not create.
 *   - `PUT /periomeasures` is never used. No CAL row is ever sent.
 *   - every exam is dated 2000-01-01 (override: HYG_PROBE_EXAM_DATE) and carries
 *     a "delete me" note, so none can become the patient's "last perio exam".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HOW TO RUN IT (from backend/, in the staging container)
 * ═════════════════════════════════════════════════════════════════════════════
 *   HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 HYG_PROBE_PROVNUM=<n> \
 *     node scripts/probe-hyg-perio-v2.js --dry
 *   HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 HYG_PROBE_PROVNUM=<n> \
 *     node scripts/probe-hyg-perio-v2.js
 *   HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 \
 *     node scripts/probe-hyg-perio-v2.js --cleanup <n>,<n>
 *
 * `/app` is read-only in the container: set HYG_PROBE_MANIFEST=/tmp/… there.
 * Each run also prints one `FIXTURE {json}` line per experiment — the raw
 * read-back, which is committed as tests/fixtures/perio-v2-probe-staging.json.
 *
 *   types  Q1 how each type is written · Q2 recession sign · Q3 furcation, incl.
 *          a single-rooted tooth · Q4 mobility · Q5 all types in one read-back
 *   bad    Q7 out-of-range values, constraint breaks, a duplicate, a wrong type
 */

const fs = require('node:fs');
const path = require('node:path');

/** The only patient this script will touch. Stricter than item 11's list, on purpose. */
const FIXTURES = Object.freeze({ roland: Object.freeze([12828]) });

const DEFAULT_MANIFEST = path.join(__dirname, '.probe-hyg-perio-v2.json');
const DEFAULT_EXAM_DATE = '2000-01-01';

const VALUE_KEYS = Object.freeze(['ToothValue', 'MBvalue', 'Bvalue', 'DBvalue', 'MLvalue', 'Lvalue', 'DLvalue']);

/** Never sent, by rule. The guard is here so a future edit to the table below cannot send one. */
const NEVER_SENT_TYPES = Object.freeze(['CAL']);

/** One measurement row, with -1 ("no measurement") everywhere not named. */
function measure(sequenceType, tooth, values) {
  const out = { SequenceType: sequenceType, IntTooth: tooth };
  for (const key of VALUE_KEYS) out[key] = values[key] === undefined ? -1 : values[key];
  return out;
}

/** The experiments: one exam each, then its rows, in order. */
function experiments({ patNum, provNum, examDate }) {
  const exam = (id, extra = {}) => ({
    PatNum: patNum,
    ProvNum: provNum,
    ExamDate: examDate,
    Note: `CareIN v2 perio probe (${id}). Test data - delete with --cleanup.`,
    ...extra,
  });
  return [
    {
      id: 'types',
      answers: [1, 2, 3, 4, 5],
      // Probing on #1 DB/B/MB via a string (item 11's measured mapping), so the
      // read-back holds v1 and v2 rows together (Q5).
      exam: exam('types', { UpperFacial: '323' }),
      rows: [
        { id: 'gm-3-mixed', why: 'Q2: 0-3 and 101/102 on one tooth — which way is recession?', body: measure('GingMargin', 3, { MBvalue: 0, Bvalue: 2, DBvalue: 3, MLvalue: 1, Lvalue: 101, DLvalue: 102 }) },
        { id: 'gm-1-beside-probing', why: 'Q2/Q5: recession beside probing on the same tooth', body: measure('GingMargin', 1, { MBvalue: 1, Bvalue: 1, DBvalue: 2 }) },
        { id: 'furc-3-upper-molar', why: 'Q3: an upper molar\'s three furcation entries (B, ML, DL), classes 1-3', body: measure('Furcation', 3, { Bvalue: 1, MLvalue: 2, DLvalue: 3 }) },
        { id: 'furc-30-lower-molar', why: 'Q3: a lower molar\'s two (B, L)', body: measure('Furcation', 30, { Bvalue: 2, Lvalue: 1 }) },
        { id: 'furc-8-single-root', why: 'Q3: a single-rooted incisor — accepted, refused, or silently dropped?', body: measure('Furcation', 8, { Bvalue: 2 }) },
        { id: 'mob-3', why: 'Q4: mobility 2 in ToothValue, every surface -1', body: measure('Mobility', 3, { ToothValue: 2 }) },
        { id: 'mob-30', why: 'Q4: mobility 1', body: measure('Mobility', 30, { ToothValue: 1 }) },
      ],
    },
    {
      id: 'bad',
      answers: [7],
      exam: exam('bad'),
      rows: [
        { id: 'gm-25', why: 'out of range above 19', body: measure('GingMargin', 4, { Bvalue: 25 }) },
        { id: 'gm-99', why: 'the gap between 19 and 101', body: measure('GingMargin', 5, { Bvalue: 99 }) },
        { id: 'gm-neg5', why: 'a literal negative instead of 105', body: measure('GingMargin', 6, { Bvalue: -5 }) },
        { id: 'gm-120', why: 'past the documented 101-119', body: measure('GingMargin', 7, { Bvalue: 120 }) },
        { id: 'furc-5', why: 'a furcation class past III', body: measure('Furcation', 14, { Bvalue: 5 }) },
        { id: 'furc-toothvalue', why: 'furcation with ToothValue set (docs: must be -1)', body: measure('Furcation', 2, { ToothValue: 1, Bvalue: 1 }) },
        { id: 'mob-25', why: 'mobility far out of range', body: measure('Mobility', 14, { ToothValue: 25 }) },
        { id: 'mob-surface', why: 'mobility with a surface value (docs: all must be -1)', body: measure('Mobility', 13, { ToothValue: 1, MBvalue: 2 }) },
        { id: 'gm-dup-a', why: 'a GingMargin row for #12…', body: measure('GingMargin', 12, { Bvalue: 2 }) },
        { id: 'gm-dup-b', why: '…and a SECOND for #12: new row, overwrite, or refusal?', body: measure('GingMargin', 12, { Bvalue: 4 }) },
        { id: 'type-recession', why: 'a type name that does not exist', body: measure('Recession', 9, { Bvalue: 2 }) },
        { id: 'tooth-33', why: 'a tooth that does not exist', body: measure('GingMargin', 33, { Bvalue: 2 }) },
      ],
    },
  ];
}

function readManifest(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.exams) ? parsed : { exams: [] };
  } catch {
    return { exams: [] };
  }
}

function writeManifest(file, manifest) {
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/** @returns {{ dry: boolean, cleanup: number[]|null, forceCleanup: boolean, only: string[]|null, error: string|null }} */
function parseArgs(argv) {
  const out = { dry: false, cleanup: null, forceCleanup: false, only: null, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry') out.dry = true;
    else if (arg === '--force-cleanup') out.forceCleanup = true;
    else if (arg === '--cleanup' || arg === '--only') {
      const value = argv[i + 1];
      i += 1;
      if (!value) {
        out.error = `${arg} needs a value`;
        continue;
      }
      if (arg === '--only') out.only = value.split(',').map((s) => s.trim()).filter(Boolean);
      else {
        const nums = value.split(',').map((s) => Number(s.trim()));
        if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n <= 0)) {
          out.error = '--cleanup takes PerioExamNums, e.g. --cleanup 7001,7002';
        } else out.cleanup = nums;
      }
    } else out.error = `unknown argument ${arg}`;
  }
  return out;
}

function isFixture(office, patNum) {
  return Boolean(FIXTURES[office]) && FIXTURES[office].includes(patNum);
}

function writesDisabled(env) {
  return String(env.OPENDENTAL_WRITE_DISABLED || '').trim().toLowerCase() === 'true';
}

function defaultDeps() {
  // LAZY, so requiring this file reaches no config and no Open Dental.
  // HYG_PROBE_APP_ROOT lets a copy in /tmp resolve the app's own modules.
  const root = process.env.HYG_PROBE_APP_ROOT || path.join(__dirname, '..');
  return {
    loadSecrets: () => require(path.join(root, 'config/secrets')).loadSecrets(),
    getOd: (office) => {
      const odOffices = require(path.join(root, 'config/odOffices'));
      return odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
    },
    pagedList: (...args) => require(path.join(root, 'services/hyg/odDay')).pagedList(...args),
  };
}

function banner(log, lines) {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  log('#'.repeat(width));
  for (const l of lines) log(`# ${l.padEnd(width - 4)} #`);
  log('#'.repeat(width));
}

async function readExams(odGet, deps, patNum) {
  const list = await deps.pagedList(odGet, '/perioexams', { PatNum: patNum });
  if (list.error && list.rows.length === 0) return { ok: false, error: list.error };
  return { ok: true, exams: list.rows.filter((r) => r && Number(r.PatNum) === patNum) };
}

async function readMeasures(odGet, deps, examNum) {
  const list = await deps.pagedList(odGet, '/periomeasures', { PerioExamNum: examNum });
  if (list.error && list.rows.length === 0) return { ok: false, error: list.error };
  return {
    ok: true,
    truncated: Boolean(list.truncated || list.error),
    // Filtered here too: a filter Open Dental ignored would otherwise hand back
    // other exams' rows as though they were this one's.
    rows: list.rows.filter((r) => r && Number(r.PerioExamNum) === examNum),
    unfiltered: list.rows.length,
  };
}

/** Only the perio fields of a row — measurement rows carry no patient identifier. */
function slim(row) {
  const out = { PerioMeasureNum: row.PerioMeasureNum, PerioExamNum: row.PerioExamNum, SequenceType: row.SequenceType, IntTooth: row.IntTooth };
  for (const key of VALUE_KEYS) out[key] = row[key];
  return out;
}

function describeRow(r) {
  return (
    `#${r.IntTooth} ${String(r.SequenceType).padEnd(16)} tooth=${r.ToothValue} ` +
    `MB=${r.MBvalue} B=${r.Bvalue} DB=${r.DBvalue} ML=${r.MLvalue} L=${r.Lvalue} DL=${r.DLvalue}`
  );
}

/** How a sent row compares with what Open Dental holds for (tooth, type) now. */
function compareLanded(sent, rows) {
  const same = rows.filter(
    (r) => Number(r.IntTooth) === sent.IntTooth && String(r.SequenceType).trim() === sent.SequenceType
  );
  if (same.length === 0) return { verdict: 'absent', rows: [] };
  const diffs = [];
  const last = same[same.length - 1];
  for (const key of VALUE_KEYS) if (Number(last[key]) !== Number(sent[key])) diffs.push(`${key} sent ${sent[key]} holds ${last[key]}`);
  return {
    verdict: same.length > 1 ? `${same.length} rows` : diffs.length === 0 ? 'exact' : 'altered',
    diffs,
    rows: same.map(slim),
  };
}

async function runCleanup({ args, office, patNum, env, deps, log, manifestPath }) {
  const manifest = readManifest(manifestPath);
  const recorded = new Set(manifest.exams.filter((e) => e.office === office && e.patNum === patNum).map((e) => e.examNum));
  const unrecorded = args.cleanup.filter((n) => !recorded.has(n));
  if (unrecorded.length > 0 && !args.forceCleanup) {
    log(
      `Refusing: ${unrecorded.join(', ')} ${unrecorded.length === 1 ? 'was' : 'were'} not created by this ` +
        `script for ${office} ${patNum} (not in ${manifestPath}). Pass --force-cleanup only if you are sure.`
    );
    return 2;
  }
  if (args.dry) {
    log(`(dry) would DELETE /perioexams/${args.cleanup.join(', /perioexams/')} after checking each belongs to ${patNum}`);
    return 0;
  }
  if (writesDisabled(env)) {
    log('OPENDENTAL_WRITE_DISABLED is set. Unset it on STAGING to clean up.');
    return 2;
  }

  await deps.loadSecrets();
  const od = deps.getOd(office);
  const odGet = (p, params, opts) => od.client.apiGetRaw(p, params, { ...(opts || {}), module: 'hyg-probe' });

  let code = 0;
  for (const examNum of args.cleanup) {
    const exams = await readExams(odGet, deps, patNum);
    if (!exams.ok) {
      log(`Could not read ${patNum}'s exams (${exams.error}); ${examNum} NOT deleted.`);
      code = 1;
      continue;
    }
    if (!exams.exams.some((e) => Number(e.PerioExamNum) === examNum)) {
      // Even --force-cleanup cannot delete an exam that is not this fixture's.
      log(`Refusing: exam ${examNum} is not one of ${office} ${patNum}'s exams. NOT deleted.`);
      code = 2;
      continue;
    }
    const before = await readMeasures(odGet, deps, examNum);
    try {
      // apiWriteRaw is POST/PUT only, by design; DELETE goes through the raw
      // client, exactly as probe-hyg-perio-arch.js does. The env guard above is
      // the OPENDENTAL_WRITE_DISABLED check that transport would otherwise make.
      await od.client.client.delete(`/perioexams/${examNum}`);
    } catch (err) {
      log(`DELETE /perioexams/${examNum} failed: ${(err && err.message) || err}`);
      code = 1;
      continue;
    }
    const after = await readExams(odGet, deps, patNum);
    const gone = after.ok && !after.exams.some((e) => Number(e.PerioExamNum) === examNum);
    // Q6: did the v2 rows go WITH the exam? Read them back by exam number.
    const rowsAfter = await readMeasures(odGet, deps, examNum);
    const left = rowsAfter.ok ? rowsAfter.rows.length : null;
    const typesBefore = before.ok ? Array.from(new Set(before.rows.map((r) => String(r.SequenceType).trim()))).sort() : [];
    log(
      `Exam ${examNum}: ${gone ? 'deleted, confirmed gone from the exam list' : 'delete sent, NOT confirmed gone'}; ` +
        `rows before ${before.ok ? before.rows.length : '?'} (${typesBefore.join(', ')}), ` +
        `rows after ${left === null ? `unreadable (${rowsAfter.error})` : left}.`
    );
    log(`CLEANUP ${JSON.stringify({ examNum, gone, rowsBefore: before.ok ? before.rows.length : null, typesBefore, rowsAfter: left, readAfterError: rowsAfter.ok ? null : rowsAfter.error })}`);
    if (gone && left === 0) {
      manifest.exams = manifest.exams.filter((e) => !(e.office === office && e.patNum === patNum && e.examNum === examNum));
      writeManifest(manifestPath, manifest);
    } else code = 1;
  }
  return code;
}

/**
 * @returns {Promise<number>} the exit code. Never exits the process itself, so
 *   the whole flow is testable with injected dependencies.
 */
async function main({
  argv = process.argv.slice(2),
  env = process.env,
  deps = defaultDeps(),
  log = console.log,
  manifestPath = env.HYG_PROBE_MANIFEST || DEFAULT_MANIFEST,
} = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    log(args.error);
    return 2;
  }
  const office = String(env.HYG_PROBE_OFFICE || '').trim();
  const patNum = Number(env.HYG_PROBE_PATNUM);
  if (!isFixture(office, patNum)) {
    log('Refusing to run. This probe touches roland PatNum 12828 and nothing else.');
    return 2;
  }

  if (args.cleanup) return runCleanup({ args, office, patNum, env, deps, log, manifestPath });

  const provNum = Number(env.HYG_PROBE_PROVNUM);
  if (!Number.isInteger(provNum) || provNum <= 0) {
    log('Set HYG_PROBE_PROVNUM to the hygienist ProvNum the exams are filed under.');
    return 2;
  }
  const examDate = String(env.HYG_PROBE_EXAM_DATE || DEFAULT_EXAM_DATE).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(examDate)) {
    log('HYG_PROBE_EXAM_DATE must be YYYY-MM-DD.');
    return 2;
  }
  if (writesDisabled(env)) {
    log('OPENDENTAL_WRITE_DISABLED is set, so every probe would fail for a reason unrelated to the question. Unset it on STAGING only.');
    return 2;
  }

  const all = experiments({ patNum, provNum, examDate });
  for (const e of all) {
    for (const row of e.rows) {
      if (NEVER_SENT_TYPES.includes(row.body.SequenceType)) {
        log(`Refusing: experiment ${e.id} would send a ${row.body.SequenceType} row. CAL is never written.`);
        return 2;
      }
    }
  }
  const chosen = args.only ? all.filter((e) => args.only.includes(e.id)) : all;
  if (chosen.length === 0) {
    log(`--only matched nothing. Experiments: ${all.map((e) => e.id).join(', ')}`);
    return 2;
  }

  if (args.dry) {
    for (const experiment of chosen) {
      log(`── ${experiment.id} (Q${experiment.answers.join(', Q')}): POST /perioexams`);
      log(JSON.stringify(experiment.exam));
      for (const row of experiment.rows) {
        log(`   then POST /periomeasures [${row.id}] ${row.why}`);
        log(`   ${JSON.stringify({ PerioExamNum: '<the exam above>', ...row.body })}`);
      }
    }
    log('\n(dry run — nothing was sent; Open Dental was not contacted)');
    return 0;
  }

  await deps.loadSecrets();
  const od = deps.getOd(office);
  const odGet = (p, params, opts) => od.client.apiGetRaw(p, params, { ...(opts || {}), module: 'hyg-probe' });

  const startExams = await readExams(odGet, deps, patNum);
  log(
    startExams.ok
      ? `${office} ${patNum} has ${startExams.exams.length} perio exam(s) before this run: ` +
          startExams.exams.map((e) => `${e.PerioExamNum} (${String(e.ExamDate).slice(0, 10)})`).join(', ')
      : `Could not list ${patNum}'s exams before the run (${startExams.error}).`
  );

  /** Exam numbers THIS run minted — the only ones a row may be posted into. */
  const minted = new Set();
  const created = [];
  let code = 0;
  for (const experiment of chosen) {
    const before = await readExams(odGet, deps, patNum);
    if (!before.ok) {
      log(`Could not read ${patNum}'s exams before "${experiment.id}" (${before.error}); stopping.`);
      code = 1;
      break;
    }
    const priorNums = new Set(before.exams.map((e) => Number(e.PerioExamNum)));

    const res = await od.client.apiWriteRaw('POST', '/perioexams', experiment.exam, { module: 'hyg-probe', timeoutMs: 30000 });
    const after = await readExams(odGet, deps, patNum);
    const appeared = after.ok ? after.exams.filter((e) => !priorNums.has(Number(e.PerioExamNum))) : [];
    const fromBody = Number(res && res.data && res.data.PerioExamNum);
    const examNum = Number.isInteger(fromBody) && fromBody > 0 ? fromBody : appeared.length === 1 ? Number(appeared[0].PerioExamNum) : null;

    if (examNum === null || (!res.ok && appeared.length === 0)) {
      log(`\n── ${experiment.id}: the exam was not created (${res && res.status}: ${res && res.error}). No rows sent.`);
      code = 1;
      continue;
    }

    // RECORDED BEFORE ANYTHING ELSE CAN FAIL, so cleanup is always possible.
    const manifest = readManifest(manifestPath);
    manifest.exams.push({ office, patNum, examNum, experiment: experiment.id, createdAt: new Date().toISOString() });
    writeManifest(manifestPath, manifest);
    minted.add(examNum);
    created.push(examNum);
    banner(log, [`CREATED PerioExamNum ${examNum}  (${experiment.id})`, `clean up: --cleanup ${examNum}`]);

    const header = after.ok ? after.exams.find((e) => Number(e.PerioExamNum) === examNum) : null;
    const results = [];
    for (const row of experiment.rows) {
      if (!minted.has(examNum)) throw new Error('unreachable: a row aimed at an exam this run did not create');
      const body = { PerioExamNum: examNum, ...row.body };
      const r = await od.client.apiWriteRaw('POST', '/periomeasures', body, { module: 'hyg-probe', timeoutMs: 30000 });
      results.push({
        id: row.id,
        why: row.why,
        sent: body,
        response: { ok: Boolean(r && r.ok), status: r ? r.status : null, error: r && !r.ok ? String(r.error || '').slice(0, 300) : null, data: r && r.ok ? r.data : null },
      });
      log(`   [${row.id}] ${r && r.ok ? `accepted ${r.status}` : `REFUSED ${r && r.status}: ${r && r.error}`}`);
    }

    const measures = await readMeasures(odGet, deps, examNum);
    log(`\n── ${experiment.id}: exam ${examNum} — answers Q${experiment.answers.join(', Q')}`);
    if (!measures.ok) {
      log(`   could not read its rows back: ${measures.error}`);
      code = 1;
      continue;
    }
    if (measures.truncated) log('   ⚠ the read-back was TRUNCATED; findings below are partial');
    const types = Array.from(new Set(measures.rows.map((r) => String(r.SequenceType).trim()))).sort();
    log(`   ${measures.rows.length} rows read back (${measures.unfiltered} before filtering to this exam); types: ${types.join(', ')}`);
    for (const r of measures.rows.slice().sort((a, b) => Number(a.IntTooth) - Number(b.IntTooth) || String(a.SequenceType).localeCompare(String(b.SequenceType)))) {
      log('   ' + describeRow(r));
    }
    for (const result of results) {
      result.landed = compareLanded(result.sent, measures.rows);
      log(`   [${result.id}] ${result.response.ok ? 'accepted' : 'refused'} → ${result.landed.verdict}${result.landed.diffs && result.landed.diffs.length ? ' (' + result.landed.diffs.join('; ') + ')' : ''}`);
    }
    log(
      'FIXTURE ' +
        JSON.stringify({
          experiment: experiment.id,
          answers: experiment.answers,
          examNum,
          examSent: experiment.exam,
          examHeader: header ? { PerioExamNum: header.PerioExamNum, ExamDate: header.ExamDate, ProvNum: header.ProvNum, Note: header.Note } : null,
          rows: results,
          readBack: { count: measures.rows.length, unfiltered: measures.unfiltered, truncated: measures.truncated, types, rows: measures.rows.map(slim) },
        })
    );
  }

  if (created.length > 0) {
    log('');
    banner(log, [
      `This run created ${created.length} exam(s) on ${office} ${patNum}: ${created.join(', ')}`,
      'When the findings are recorded, delete them:',
      `  node scripts/probe-hyg-perio-v2.js --cleanup ${created.join(',')}`,
    ]);
  }
  return code;
}

// Guarded, so requiring this file sends nothing.
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}

module.exports = { main, experiments, parseArgs, isFixture, compareLanded, measure, FIXTURES, NEVER_SENT_TYPES, VALUE_KEYS };
