#!/usr/bin/env node
'use strict';

/**
 * ITEM 26 §0 — WHICH FAMILY DOES OPEN DENTAL'S OWN CHART STORE A RECESSION IN?
 * READ ONLY. There is no write verb anywhere in this file.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ONE QUESTION, AND WHY IT GATES THE WHOLE SLICE
 * ═════════════════════════════════════════════════════════════════════════════
 * `GET/POST /periomeasures` with `SequenceType: GingMargin` accepts TWO families
 * of values, measured by item 19's probe (docs/reports/feature-hyg-perio-v2-probe.md
 * §2): **0–19 and 101–119**. Both store verbatim — 101/102 are not converted,
 * clamped or re-signed on the way in or out. H0's prose documents 101–119 as
 * "negative (subtract 100)".
 *
 * What neither the API nor the docs say is WHICH FAMILY MEANS RECESSION. That is
 * a convention of Open Dental's own user interface, and the probe could not
 * observe it: it wrote both families itself and got both back unchanged.
 *
 * It is load-bearing twice over:
 *   1. CareIN's gingival-margin entry must write the family Open Dental's chart
 *      writes, or every recession CareIN sends is recorded as its opposite.
 *   2. CAL is `depth + recession` or `depth − recession` depending on it, and a
 *      CAL that is wrong by twice the recession is a clinical number that reads
 *      as plausible. Item 26 computes CAL for DISPLAY only, which limits the
 *      damage to what she sees — it does not make a wrong answer acceptable.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HOW A PERSON CLOSED IT, AND WHAT THIS SCRIPT DOES
 * ═════════════════════════════════════════════════════════════════════════════
 * Beau hand-entered a perio exam in **Open Dental's own perio chart** on roland
 * test patient 12828 on 2026-09-29, with a known **2 mm recession on #3 B**. He
 * also established that OD's UI REFUSED a negative: overgrowth (a margin coronal
 * to the CEJ) could not be typed at all.
 *
 * This script reads that exam back through the API and prints the raw row. If
 * `Bvalue` on the #3 GingMargin row is `2`, the recession family is 0–19. If it
 * is `102`, the recession family is 101–119. One number settles the slice.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 🔴 NEVER `GET /periomeasures/{id}` — IT IGNORES THE ID
 * ═════════════════════════════════════════════════════════════════════════════
 * Probe §6 measured it: that path returns the WHOLE PRACTICE's perio table, not
 * the row asked for. This script uses `GET /periomeasures?PerioExamNum=` only,
 * and additionally drops any row whose own `PerioExamNum` is not the exam asked
 * about — the filter was honoured when measured, but a row from another exam must
 * never be read as this one's.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HOW TO RUN IT
 * ═════════════════════════════════════════════════════════════════════════════
 *   # STAGING, designated test patients only.
 *   env HYG_PROBE_OFFICE=roland node scripts/probe-hyg-perio-gm-sign.js
 *
 * It cannot run from a workstation: config/secrets.js only contacts Key Vault
 * when NODE_ENV=production, so `getOdOffice` throws OFFICE_OD_KEY_MISSING before
 * any request is made. In the staging container managed identity supplies the
 * key. `HYG_PROBE_PATNUMS` narrows the patients; `HYG_PROBE_EXAM_DATE` narrows
 * to one ExamDate (default: every exam is listed, 2026-09-29 called out).
 *
 * Paste the output into docs/reports/feature-hyg-perio-v2.md §0.
 *
 * NO REAL PATIENT, EVER. It refuses any PatNum that is not a designated fixture.
 */

const path = require('node:path');

const APP_ROOT = process.env.HYG_PROBE_APP_ROOT || path.join(__dirname, '..');
const odOffices = require(path.join(APP_ROOT, 'config/odOffices'));
const { loadSecrets } = require(path.join(APP_ROOT, 'config/secrets'));
const {
  DESIGNATED_TEST_PATIENTS,
  isDesignatedTestPatient,
  describeTestPatients,
} = require(path.join(APP_ROOT, 'config/testPatients'));

const EXAMS_PATH = '/perioexams';
const MEASURES_PATH = '/periomeasures';

/** The date Beau hand-entered the exam on. Called out, never used to filter away. */
const HAND_ENTERED_DATE = '2026-09-29';
/** The tooth and surface the known 2 mm recession was entered on. */
const HAND_ENTERED_TOOTH = 3;
const HAND_ENTERED_SURFACE = 'Bvalue';

const SURFACES = ['MBvalue', 'Bvalue', 'DBvalue', 'MLvalue', 'Lvalue', 'DLvalue'];

/** The PatNums asked for, or every fixture for this office. Refuses anything else. */
function patNumsFor(office, raw) {
  const fixtures = DESIGNATED_TEST_PATIENTS[office] || [];
  if (!raw || !String(raw).trim()) return [...fixtures];
  return String(raw)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0 && isDesignatedTestPatient(office, n));
}

/** `2026-09-29` from whatever OD put in ExamDate. Its zero date is "no date". */
function examDateOf(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return !m || m[1] === '0001-01-01' ? null : m[1];
}

/** Which family a GingMargin value falls in — the whole point of the exercise. */
function familyOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'not-a-number';
  if (n === -1) return 'empty(-1)';
  if (n >= 0 && n <= 19) return 'LOW 0-19';
  if (n >= 101 && n <= 119) return 'HIGH 101-119';
  return 'OUT OF BOTH FAMILIES';
}

function describeBody(data) {
  if (Array.isArray(data)) return `array(${data.length})`;
  if (typeof data === 'string') return `string(${data.length}) ${JSON.stringify(data.slice(0, 200))}`;
  if (data === null || data === undefined) return String(data);
  return `${typeof data} ${JSON.stringify(data).slice(0, 200)}`;
}

async function main({ env = process.env, log = console.log } = {}) {
  const office = String(env.HYG_PROBE_OFFICE || '').trim();
  const patNums = patNumsFor(office, env.HYG_PROBE_PATNUMS);
  if (patNums.length === 0) {
    console.error(
      'Refusing to run. HYG_PROBE_OFFICE must be an office with designated test patients, and ' +
        `HYG_PROBE_PATNUMS (optional) must name only those: ${describeTestPatients()}`
    );
    process.exit(2);
  }
  const wantDate = String(env.HYG_PROBE_EXAM_DATE || '').trim() || null;

  await loadSecrets();
  const od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  // apiGetRaw is the ONLY client call in this file. There is no write path.
  const get = (p, params) => od.client.apiGetRaw(p, params, { module: 'hyg-probe', timeoutMs: 30000 });

  let answered = false;

  for (const patNum of patNums) {
    log(`\n${'='.repeat(78)}\nPatNum ${patNum} (designated ${office} fixture)\n${'='.repeat(78)}`);

    const exams = await get(EXAMS_PATH, { PatNum: patNum });
    log(`GET ${EXAMS_PATH}?PatNum=${patNum}  ok=${Boolean(exams && exams.ok)} status=${exams && exams.status}`);
    log(`  error=${JSON.stringify((exams && exams.error) || null)}  body=${describeBody(exams && exams.data)}`);
    const examRows = Array.isArray(exams && exams.data) ? exams.data : [];
    // Every row must say it is this patient's. Same rule odPerio.js applies.
    const mine = examRows.filter((e) => Number(e && e.PatNum) === patNum);
    if (mine.length !== examRows.length) {
      log(`  ⚠️ dropped ${examRows.length - mine.length} exam row(s) belonging to another PatNum`);
    }
    if (mine.length === 0) {
      log('  NO EXAMS for this patient. If this is 12828, the hand-entered exam is NOT here.');
      continue;
    }

    for (const exam of mine) {
      const examNum = Number(exam.PerioExamNum);
      const date = examDateOf(exam.ExamDate);
      const flag = date === HAND_ENTERED_DATE ? '  ← THE HAND-ENTERED DATE' : '';
      log(`\n  exam ${examNum}  ExamDate=${JSON.stringify(exam.ExamDate)} (${date})  ProvNum=${exam.ProvNum}${flag}`);
      log(`    raw exam row: ${JSON.stringify(exam)}`);
      if (wantDate && date !== wantDate) {
        log('    (skipped: HYG_PROBE_EXAM_DATE asked for a different date)');
        continue;
      }

      // 🔴 THE FILTERED PATH ONLY. /periomeasures/{id} returns the whole practice.
      const measures = await get(MEASURES_PATH, { PerioExamNum: examNum });
      log(
        `    GET ${MEASURES_PATH}?PerioExamNum=${examNum}  ok=${Boolean(measures && measures.ok)} ` +
          `status=${measures && measures.status}  body=${describeBody(measures && measures.data)}`
      );
      const rows = Array.isArray(measures && measures.data) ? measures.data : [];
      const ofExam = rows.filter((r) => Number(r && r.PerioExamNum) === examNum);
      if (ofExam.length !== rows.length) {
        log(`    ⚠️ dropped ${rows.length - ofExam.length} measure row(s) from ANOTHER exam`);
      }

      const types = [...new Set(ofExam.map((r) => r.SequenceType))].sort();
      log(`    SequenceTypes present: ${types.join(', ') || '(none)'}`);

      const gm = ofExam.filter((r) => r.SequenceType === 'GingMargin');
      if (gm.length === 0) {
        log('    no GingMargin rows in this exam');
        continue;
      }
      for (const row of gm) {
        log(`    GingMargin #${row.IntTooth} RAW ROW: ${JSON.stringify(row)}`);
        for (const surface of SURFACES) {
          const value = row[surface];
          if (Number(value) === -1) continue;
          log(
            `        ${surface.padEnd(8)} = ${JSON.stringify(value)}  typeof=${typeof value}  ` +
              `family=${familyOf(value)}`
          );
        }
        if (Number(row.IntTooth) === HAND_ENTERED_TOOTH) {
          const value = row[HAND_ENTERED_SURFACE];
          log('');
          log(`    ${'*'.repeat(70)}`);
          log(`    §0 ANSWER — #${HAND_ENTERED_TOOTH} ${HAND_ENTERED_SURFACE} = ${JSON.stringify(value)}`);
          log(`    A KNOWN 2 mm RECESSION STORED AS: ${familyOf(value)}`);
          log(`    => THE RECESSION FAMILY IS ${familyOf(value)}`);
          log(`    ${'*'.repeat(70)}`);
          answered = true;
        }
      }
    }
  }

  if (!answered) {
    log(
      `\nNO ANSWER. No GingMargin row for #${HAND_ENTERED_TOOTH} was found on any designated ` +
        'fixture. Item 26 STOPS here: the sign convention is not guessable, and product code ' +
        'must not be written without it.'
    );
  }
}

// Guarded, so requiring this file reaches Open Dental for nothing.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, patNumsFor, familyOf, examDateOf, EXAMS_PATH, MEASURES_PATH, HAND_ENTERED_DATE };
