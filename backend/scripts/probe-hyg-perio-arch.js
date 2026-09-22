#!/usr/bin/env node
'use strict';

/**
 * Probe Open Dental's perio ARCH STRINGS before the perio send is designed.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═════════════════════════════════════════════════════════════════════════════
 * H0 documents a bulk write on `POST /perioexams`: `UpperFacial`,
 * `UpperLingual`, `LowerLingual`, `LowerFacial`, strings of depths (0-9) and
 * the flags b/s/p/c — exactly v1's scope. Open Dental's page adds only: *"Other
 * characters are ignored"* and *"parsed left to right and will traverse
 * surfaces in that region from the right side of the mouth to the left side."*
 * It is marked Docs in H0 and has never been exercised. If it works, a v1 chart
 * is one request; if not, the send needs a per-row queue. This answers which.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY IT IS SAFE — READ BEFORE RUNNING
 * ═════════════════════════════════════════════════════════════════════════════
 * It WRITES to a live practice database, and its safety is one property:
 *
 *   IT ONLY EVER CREATES ITS OWN NEW EXAMS, and `DELETE /perioexams/{n}` removes
 *   an exam and all of its measurements — the one complete undo perio has.
 *
 * So:
 *   - designated staging fixtures only: roland 12827 / 12828, valley 7115.
 *     11373 is INVALID. Anything else is refused.
 *   - refused when OPENDENTAL_WRITE_DISABLED is set.
 *   - `--dry` prints every payload and touches Open Dental not at all.
 *   - every exam is written to a manifest THE MOMENT it is created, and its
 *     number is printed in a box. `--cleanup <n>[,<n>…]` deletes exactly those,
 *     only if the manifest recorded them (or with `--force-cleanup`), and only
 *     after reading that the exam belongs to the fixture.
 *   - it NEVER posts a measurement row, to any exam. Every reading it causes
 *     arrives through its own new exam's arch strings.
 *   - every exam is dated 2000-01-01 (override: HYG_PROBE_EXAM_DATE) and carries
 *     a "delete me" note, so none can become a patient's "last perio exam".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HOW TO RUN IT (from backend/, in the staging container)
 * ═════════════════════════════════════════════════════════════════════════════
 *   HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 HYG_PROBE_PROVNUM=<n> \
 *     node scripts/probe-hyg-perio-arch.js --dry
 *   HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 HYG_PROBE_PROVNUM=<n> \
 *     node scripts/probe-hyg-perio-arch.js
 *   HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 \
 *     node scripts/probe-hyg-perio-arch.js --cleanup <n>,<n>,…
 *
 * `--only mapping,flags` runs a subset. The experiments, and the questions of
 * docs/reports/feature-hyg-perio-arch-probe.md each one answers:
 *
 *   mapping    Q1 does it land · Q2 the position→tooth/site mapping · Q7 ProvNum+date
 *   flags      Q4 the four flags, several on one site · Q6 one partial arch alone
 *   deep       Q3 depths above 9
 *   skip       Q5 how (whether) a skipped tooth is expressed
 *   malformed  Q6 an over-long string and a garbage string: refused, or half-charted?
 */

const fs = require('node:fs');
const path = require('node:path');

/** The only PatNums this script will touch. */
// The designated test patients: ONE list, shared with the hygiene write gate (item 20).
const { DESIGNATED_TEST_PATIENTS: FIXTURES } = require('../config/testPatients');

const DEFAULT_MANIFEST = path.join(__dirname, '.probe-hyg-perio-arch.json');
const DEFAULT_EXAM_DATE = '2000-01-01';

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** The four regions, and the teeth each covers in tooth-number order. */
const REGIONS = Object.freeze({
  UpperFacial: { teeth: range(1, 16), side: 'facial', upper: true },
  UpperLingual: { teeth: range(1, 16), side: 'lingual', upper: true },
  LowerLingual: { teeth: range(17, 32), side: 'lingual', upper: false },
  LowerFacial: { teeth: range(17, 32), side: 'facial', upper: false },
});

const SURFACE_FIELD = Object.freeze({
  DB: 'DBvalue', B: 'Bvalue', MB: 'MBvalue', DL: 'DLvalue', L: 'Lvalue', ML: 'MLvalue',
});

const TOOTH_ORDERS = Object.freeze(['patient-right-to-left', 'patient-left-to-right']);
const SITE_RULES = Object.freeze(['sweep', 'reverse-sweep', 'distal-first', 'mesial-first']);

function isPatientRight(tooth) {
  return (tooth >= 1 && tooth <= 8) || (tooth >= 25 && tooth <= 32);
}

/**
 * One tooth's three sites on one side, under a candidate rule.
 *   sweep          distal first on the patient's right, mesial first on the left
 *                  — a probe moving continuously from right to left
 *   reverse-sweep  the opposite
 *   distal-first / mesial-first  the same order on every tooth
 */
function sitesFor(tooth, side, rule) {
  const distal = side === 'facial' ? 'DB' : 'DL';
  const mid = side === 'facial' ? 'B' : 'L';
  const mesial = side === 'facial' ? 'MB' : 'ML';
  const dFirst = [distal, mid, mesial];
  const mFirst = [mesial, mid, distal];
  if (rule === 'sweep') return isPatientRight(tooth) ? dFirst : mFirst;
  if (rule === 'reverse-sweep') return isPatientRight(tooth) ? mFirst : dFirst;
  if (rule === 'distal-first') return dFirst;
  return mFirst;
}

/** Every site of a region in the order a candidate says the string walks it. */
function candidateOrder(region, toothOrder, siteRule) {
  const { teeth, side, upper } = REGIONS[region];
  // The patient's right: #1 on the upper arch, #32 on the lower.
  const rightToLeft = upper ? teeth.slice() : teeth.slice().reverse();
  const ordered = toothOrder === 'patient-right-to-left' ? rightToLeft : rightToLeft.reverse();
  const out = [];
  for (const tooth of ordered) {
    for (const surface of sitesFor(tooth, side, siteRule)) out.push({ tooth, surface });
  }
  return out;
}

/**
 * A deterministic, NON-PERIODIC digit string. A repeating or symmetric pattern
 * would fit several candidate orders at once and prove nothing; this one is
 * checked by the test suite to single out each of the eight.
 */
function patternDigits(seed, length) {
  let x = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += String((x >>> 16) % 10);
  }
  return out;
}

/** The mapping experiment's four strings. */
const MAPPING_STRINGS = Object.freeze({
  UpperFacial: patternDigits(11, 48),
  UpperLingual: patternDigits(23, 48),
  LowerLingual: patternDigits(37, 48),
  LowerFacial: patternDigits(41, 48),
});

/** Latest row per tooth for one SequenceType. */
function rowsByTooth(rows, sequenceType) {
  const byTooth = new Map();
  for (const r of rows || []) {
    if (!r || String(r.SequenceType || '').trim() !== sequenceType) continue;
    const tooth = Number(r.IntTooth);
    const prev = byTooth.get(tooth);
    if (!prev || Number(r.PerioMeasureNum) > Number(prev.PerioMeasureNum)) byTooth.set(tooth, r);
  }
  return byTooth;
}

/**
 * THE MAPPING. Given the string written into one region and the Probing rows
 * read back, which walk of the region explains every reading?
 *
 * Pure. Each of the eight candidate orders predicts a reading at every site; a
 * candidate FITS when every written digit is found where it predicts and no
 * reading turns up at a site it says was not written. Exactly one fit is the
 * answer. None means the strings do not behave like any simple walk — say so,
 * do not guess.
 *
 * @param {{ region: string, written: string, rows: object[] }} args
 */
function deriveMapping({ region, written, rows }) {
  const digits = String(written).replace(/[^0-9]/g, '').split('').map(Number);
  const probing = rowsByTooth(rows, 'Probing');
  const readAt = (c) => {
    const row = probing.get(c.tooth);
    if (!row) return null;
    const v = Number(row[SURFACE_FIELD[c.surface]]);
    return Number.isInteger(v) && v >= 0 ? v : null;
  };

  const candidates = [];
  for (const toothOrder of TOOTH_ORDERS) {
    for (const siteRule of SITE_RULES) {
      const order = candidateOrder(region, toothOrder, siteRule);
      const compared = Math.min(digits.length, order.length);
      let matches = 0;
      for (let i = 0; i < compared; i += 1) if (readAt(order[i]) === digits[i]) matches += 1;
      let extra = 0;
      for (let i = compared; i < order.length; i += 1) if (readAt(order[i]) !== null) extra += 1;
      candidates.push({
        name: `${toothOrder}, ${siteRule}`,
        toothOrder,
        siteRule,
        matches,
        compared,
        extra,
        fits: compared > 0 && matches === compared && extra === 0,
      });
    }
  }

  const fitting = candidates.filter((c) => c.fits);
  const best = fitting[0] || candidates.slice().sort((a, b) => b.matches - a.matches || a.extra - b.extra)[0];
  const order = candidateOrder(region, best.toothOrder, best.siteRule);
  return {
    region,
    verdict: fitting.length === 1 ? 'unique' : fitting.length > 1 ? 'ambiguous' : 'none',
    fitting: fitting.map((c) => c.name),
    best: best.name,
    matches: best.matches,
    compared: best.compared,
    extra: best.extra,
    overflow: Math.max(0, digits.length - order.length),
    table: digits.slice(0, order.length).map((d, i) => ({
      position: i + 1,
      written: d,
      tooth: order[i].tooth,
      surface: order[i].surface,
      readBack: readAt(order[i]),
    })),
    candidates,
  };
}

/** The mapping as printable lines. */
function formatMapping(result) {
  const lines = [
    `${result.region}: ${result.verdict.toUpperCase()} — best fit "${result.best}" ` +
      `(${result.matches}/${result.compared} positions match, ${result.extra} unexpected readings, ` +
      `${result.overflow} characters past the region)`,
  ];
  if (result.fitting.length > 1) lines.push(`  also fits: ${result.fitting.slice(1).join(' | ')}`);
  lines.push('  pos  written  tooth  site  read back');
  for (const row of result.table) {
    lines.push(
      `  ${String(row.position).padStart(3)}  ${String(row.written).padStart(7)}  ` +
        `${String(row.tooth).padStart(5)}  ${row.surface.padEnd(4)}  ` +
        `${row.readBack === null ? '-' : row.readBack}${row.readBack === row.written ? '' : '   <- differs'}`
    );
  }
  return lines;
}

/** Every measurement row a region's teeth carry, flattened for printing. */
function dumpRows(rows, teeth) {
  const wanted = new Set(teeth);
  return (rows || [])
    .filter((r) => wanted.has(Number(r.IntTooth)))
    .sort((a, b) => Number(a.IntTooth) - Number(b.IntTooth) || String(a.SequenceType).localeCompare(String(b.SequenceType)))
    .map(
      (r) =>
        `  #${r.IntTooth} ${String(r.SequenceType).padEnd(16)} tooth=${r.ToothValue} ` +
        `MB=${r.MBvalue} B=${r.Bvalue} DB=${r.DBvalue} ML=${r.MLvalue} L=${r.Lvalue} DL=${r.DLvalue}`
    );
}

/** The experiments, as complete request bodies. */
function experiments({ patNum, provNum, examDate }) {
  const base = (id) => ({
    PatNum: patNum,
    ProvNum: provNum,
    ExamDate: examDate,
    Note: `CareIN arch-string probe (${id}). Test data - delete with --cleanup.`,
  });
  return [
    {
      id: 'mapping',
      answers: [1, 2, 7],
      body: { ...base('mapping'), ...MAPPING_STRINGS },
    },
    {
      id: 'flags',
      answers: [4, 6],
      // Seven sites of ONE partial arch: one flag each, then two, then all four.
      // "flag follows its depth" predicts BleedSupPlaqCalc 1,2,4,8,3,12,15 on the
      // first seven sites; "flag precedes its depth" predicts 0,1,2,4,8,3,12.
      body: { ...base('flags'), UpperFacial: '3b2s4p5c6bs7pc8bspc' },
    },
    {
      id: 'deep',
      answers: [3],
      // If digits are single sites, this is 1,0,1,1,1,9,3 on seven sites. If
      // Open Dental reads runs, it is 10,11,19,3. Anything else is its own answer.
      body: { ...base('deep'), UpperFacial: '10 11 19 3' },
    },
    {
      id: 'skip',
      answers: [5],
      // "Other characters are ignored": if so, the six 3s land on the first six
      // sites. If x, -, _ or space consume a site, they land spread out — and a
      // SkipTooth row appearing would mean one of them means "skip".
      body: { ...base('skip'), UpperFacial: '3x3-3_3 3X3' },
    },
    {
      id: 'malformed',
      answers: [6],
      // Sixty digits into a 48-site region, and a string with no digit at all.
      body: { ...base('malformed'), UpperFacial: '4'.repeat(60), UpperLingual: 'zzz!!' },
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

/** A PatNum is a designated staging fixture FOR THAT OFFICE. */
function isFixture(office, patNum) {
  return Boolean(FIXTURES[office]) && FIXTURES[office].includes(patNum);
}

function writesDisabled(env) {
  return String(env.OPENDENTAL_WRITE_DISABLED || '').trim().toLowerCase() === 'true';
}

function defaultDeps() {
  // LAZY. Requiring this file must reach no config and no Open Dental — the
  // rcmD7ProbeScripts lesson: an import that runs something is how a "read"
  // script once re-issued writes.
  return {
    loadSecrets: () => require('../config/secrets').loadSecrets(),
    getOd: (office) => {
      const odOffices = require('../config/odOffices');
      return odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
    },
    pagedList: (...args) => require('../services/hyg/odDay').pagedList(...args),
  };
}

function banner(log, lines) {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  log('#'.repeat(width));
  for (const l of lines) log(`# ${l.padEnd(width - 4)} #`);
  log('#'.repeat(width));
}

/** The exams a fixture has, filtered to that fixture. */
async function readExams(odGet, deps, patNum) {
  const list = await deps.pagedList(odGet, '/perioexams', { PatNum: patNum });
  if (list.error && list.rows.length === 0) return { ok: false, error: list.error };
  return {
    ok: true,
    exams: list.rows.filter((r) => r && Number(r.PatNum) === patNum),
  };
}

async function readMeasures(odGet, deps, examNum) {
  const list = await deps.pagedList(odGet, '/periomeasures', { PerioExamNum: examNum });
  if (list.error && list.rows.length === 0) return { ok: false, error: list.error };
  return {
    ok: true,
    truncated: Boolean(list.truncated || list.error),
    rows: list.rows.filter((r) => r && Number(r.PerioExamNum) === examNum),
  };
}

async function runCleanup({ args, office, patNum, env, deps, log, manifestPath }) {
  const manifest = readManifest(manifestPath);
  const recorded = new Set(
    manifest.exams.filter((e) => e.office === office && e.patNum === patNum).map((e) => e.examNum)
  );
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
    try {
      // apiWriteRaw is POST/PUT only, by design; DELETE goes through the raw
      // client, as scripts/rcm-s11-unwind.js does. The env guard above is the
      // OPENDENTAL_WRITE_DISABLED check that transport would otherwise have made.
      await od.client.client.delete(`/perioexams/${examNum}`);
    } catch (err) {
      log(`DELETE /perioexams/${examNum} failed: ${(err && err.message) || err}`);
      code = 1;
      continue;
    }
    const after = await readExams(odGet, deps, patNum);
    const gone = after.ok && !after.exams.some((e) => Number(e.PerioExamNum) === examNum);
    log(gone ? `Deleted exam ${examNum} and its measurements; confirmed gone.` : `Exam ${examNum}: delete sent, NOT confirmed gone.`);
    if (gone) {
      manifest.exams = manifest.exams.filter(
        (e) => !(e.office === office && e.patNum === patNum && e.examNum === examNum)
      );
      writeManifest(manifestPath, manifest);
    } else code = 1;
  }
  return code;
}

async function printFindings({ experiment, examNum, body, exams, measures, log }) {
  log(`\n── ${experiment.id}: exam ${examNum} — answers Q${experiment.answers.join(', Q')}`);
  if (!measures.ok) {
    log(`   could not read its measurements back: ${measures.error}`);
    return;
  }
  if (measures.truncated) log('   ⚠ the measurement read was TRUNCATED; findings below are partial');
  log(`   ${measures.rows.length} measurement rows landed.`);

  if (experiment.id === 'mapping') {
    const exam = exams.ok ? exams.exams.find((e) => Number(e.PerioExamNum) === examNum) : null;
    log(`   Q1 LANDED: ${measures.rows.length > 0 ? 'yes' : 'NO — no rows came back'}`);
    log(
      `   Q7 exam header: ExamDate=${exam ? exam.ExamDate : '?'} (sent ${body.ExamDate}), ` +
        `ProvNum=${exam ? exam.ProvNum : '?'} (sent ${body.ProvNum}), Note=${exam ? JSON.stringify(exam.Note) : '?'}`
    );
    for (const region of Object.keys(REGIONS)) {
      log('');
      for (const line of formatMapping(deriveMapping({ region, written: body[region], rows: measures.rows }))) {
        log('   ' + line);
      }
    }
    return;
  }
  const teeth = experiment.id === 'malformed' ? range(1, 16) : range(1, 4);
  log(`   raw rows for teeth ${teeth[0]}-${teeth[teeth.length - 1]}:`);
  for (const line of dumpRows(measures.rows, teeth)) log('   ' + line);
  if (experiment.id === 'malformed') {
    const probing = measures.rows.filter((r) => r.SequenceType === 'Probing');
    log(`   Q6 upper teeth with Probing rows: ${probing.length} (60 digits into 48 sites; lingual got "zzz!!")`);
  }
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
  manifestPath = DEFAULT_MANIFEST,
} = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    log(args.error);
    return 2;
  }
  const office = String(env.HYG_PROBE_OFFICE || '').trim();
  const patNum = Number(env.HYG_PROBE_PATNUM);
  if (!isFixture(office, patNum)) {
    log(
      'Refusing to run. HYG_PROBE_OFFICE / HYG_PROBE_PATNUM must be a designated staging fixture:\n' +
        `  roland: ${FIXTURES.roland.join(', ')}\n  valley: ${FIXTURES.valley.join(', ')}\n  (11373 is INVALID)`
    );
    return 2;
  }

  if (args.cleanup) return runCleanup({ args, office, patNum, env, deps, log, manifestPath });

  const provNum = Number(env.HYG_PROBE_PROVNUM);
  if (!Number.isInteger(provNum) || provNum <= 0) {
    log('Set HYG_PROBE_PROVNUM to the hygienist ProvNum the exams are filed under (Q7 checks it lands).');
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
  const chosen = args.only ? all.filter((e) => args.only.includes(e.id)) : all;
  if (chosen.length === 0) {
    log(`--only matched nothing. Experiments: ${all.map((e) => e.id).join(', ')}`);
    return 2;
  }

  if (args.dry) {
    for (const experiment of chosen) {
      log(`── ${experiment.id} (Q${experiment.answers.join(', Q')}): POST /perioexams`);
      log(JSON.stringify(experiment.body, null, 2));
    }
    log('\n(dry run — nothing was sent; Open Dental was not contacted)');
    return 0;
  }

  await deps.loadSecrets();
  const od = deps.getOd(office);
  const odGet = (p, params, opts) => od.client.apiGetRaw(p, params, { ...(opts || {}), module: 'hyg-probe' });

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

    const res = await od.client.apiWriteRaw('POST', '/perioexams', experiment.body, {
      module: 'hyg-probe',
      timeoutMs: 30000,
    });
    const after = await readExams(odGet, deps, patNum);
    const appeared = after.ok ? after.exams.filter((e) => !priorNums.has(Number(e.PerioExamNum))) : [];
    const minted = Number(res && res.data && res.data.PerioExamNum);
    const examNum = Number.isInteger(minted) && minted > 0 ? minted : appeared.length === 1 ? Number(appeared[0].PerioExamNum) : null;

    if (!res || !res.ok) {
      log(`\n── ${experiment.id}: POST refused (${res && res.status}): ${res && res.error}`);
      if (appeared.length > 0) {
        log(`   ⚠ but ${appeared.length} new exam(s) appeared anyway: ${appeared.map((e) => e.PerioExamNum).join(', ')}`);
      } else {
        log('   and no exam was created — a refusal wrote nothing.');
        continue;
      }
    }
    if (examNum === null) {
      log(`\n── ${experiment.id}: could not tell which exam was created (${appeared.length} appeared). Check ${patNum} by hand.`);
      code = 1;
      continue;
    }

    // RECORDED BEFORE ANYTHING ELSE CAN FAIL, so cleanup is always possible.
    const manifest = readManifest(manifestPath);
    manifest.exams.push({ office, patNum, examNum, experiment: experiment.id, createdAt: new Date().toISOString() });
    writeManifest(manifestPath, manifest);
    created.push(examNum);
    banner(log, [`CREATED PerioExamNum ${examNum}  (${experiment.id})`, `clean up: --cleanup ${examNum}`]);

    const measures = await readMeasures(odGet, deps, examNum);
    await printFindings({ experiment, examNum, body: experiment.body, exams: after, measures, log });
  }

  if (created.length > 0) {
    log('');
    banner(log, [
      `This run created ${created.length} exam(s) on ${office} ${patNum}: ${created.join(', ')}`,
      `When the findings are recorded, delete them:`,
      `  node scripts/probe-hyg-perio-arch.js --cleanup ${created.join(',')}`,
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

module.exports = {
  main,
  deriveMapping,
  formatMapping,
  candidateOrder,
  experiments,
  parseArgs,
  isFixture,
  patternDigits,
  MAPPING_STRINGS,
  REGIONS,
  TOOTH_ORDERS,
  SITE_RULES,
  FIXTURES,
};
