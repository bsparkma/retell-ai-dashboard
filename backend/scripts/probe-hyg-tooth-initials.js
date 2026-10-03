#!/usr/bin/env node
'use strict';

/**
 * What does Open Dental actually answer for a patient's TOOTH INITIALS?
 * READ ONLY — there is no write verb anywhere in this file.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ⚠️ THIS SCRIPT HAS NOT BEEN RUN. THAT IS WHY IT IS COMMITTED.
 * ═════════════════════════════════════════════════════════════════════════════
 * Item 18 wants a perio chart to open with the patient's MISSING teeth already
 * skipped. The read it needs is `GET /toothinitials?PatNum=`, and that surface
 * is **Docs-only**: `docs/HYG_SPIKE_H0_OD_COVERAGE.md` covers `/perioexams` and
 * `/periomeasures` and says nothing about tooth initials, so nothing in this
 * repo has ever asked the live API for one.
 *
 * Open Dental's own documentation (opendental.com/site/apitoothinitials.html,
 * read 2026-09-30) says:
 *
 *     GET /toothinitials            optional ?PatNum=
 *     fields  ToothInitialNum, PatNum, ToothNum, InitialType, Movement,
 *             DrawingSegment, ColorDraw, SecDateTEntry, SecDateTEdit, DrawText
 *     InitialType ∈ Missing | Hidden | Primary | ShiftM | ShiftO | ShiftB
 *                 | Rotate | TipM | TipB
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY DOCUMENTATION IS NOT ENOUGH TO BUILD ON, TWICE OVER
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. **ABSENCE.** Item 21 measured `/procedurelogs/GroupNotes?PatNum=` for a
 *    patient with none: Open Dental answers an HTTP **404 with a sentence**, not
 *    `[]`. Item 14 then measured `/perioexams?PatNum=` for the same question and
 *    got **200 with `[]`**. Two sibling endpoints, two different answers — so
 *    this one's is unknowable without asking. It is load-bearing here: the whole
 *    feature rests on telling "this patient has no missing teeth" apart from
 *    "Open Dental could not be read", and reading one as the other either
 *    pre-skips nothing forever or claims teeth are absent on a failed read.
 *
 * 2. **`ToothNum`'s TYPE.** Open Dental stores tooth numbers as strings and the
 *    same column carries primary letters A–T. The docs do not say whether this
 *    endpoint returns `"3"` or `3`, nor what it does with a primary tooth. A
 *    permanent-dentition chart must parse the first and ignore the second.
 *
 * Both are one GET away, and neither is a guess worth shipping.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HOW TO RUN IT
 * ═════════════════════════════════════════════════════════════════════════════
 *   # STAGING, designated test patients only.
 *   env HYG_PROBE_OFFICE=roland node scripts/probe-hyg-tooth-initials.js
 *
 * `HYG_PROBE_PATNUMS` narrows it to a subset (comma separated); the default is
 * every designated test patient for that office. `HYG_PROBE_APP_ROOT` lets the
 * file run from outside the image tree, where relative requires break.
 *
 * Paste its output into docs/reports/feature-hyg-perio-od-layout.md §2 — status,
 * keys and row shape — and item 18's part 2 can then be built on a measurement.
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

const PATH = '/toothinitials';

/** The PatNums asked for, or every fixture for this office. Refuses anything else. */
function patNumsFor(office, raw) {
  const fixtures = DESIGNATED_TEST_PATIENTS[office] || [];
  if (!raw || !String(raw).trim()) return [...fixtures];
  return String(raw)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0 && isDesignatedTestPatient(office, n));
}

/** The body, as a line: its type, its size, and what it says. */
function describeBody(data) {
  if (Array.isArray(data)) return `array(${data.length})`;
  if (typeof data === 'string') return `string(${data.length}) ${JSON.stringify(data.slice(0, 300))}`;
  if (data === null || data === undefined) return String(data);
  return `${typeof data} ${JSON.stringify(data).slice(0, 300)}`;
}

/** Every key seen across the rows, so the report records the real shape. */
function keysSeen(rows) {
  const keys = new Set();
  for (const r of rows) {
    if (r && typeof r === 'object') for (const k of Object.keys(r)) keys.add(k);
  }
  return keys.size ? [...keys].sort().join(', ') : '(none)';
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

  await loadSecrets();
  const od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  // apiGetRaw is the ONLY client call in this file. There is no write path.
  const get = (params) => od.client.apiGetRaw(PATH, params, { module: 'hyg-probe', timeoutMs: 30000 });

  for (const patNum of patNums) {
    const startedAt = Date.now();
    const res = await get({ PatNum: patNum });
    const rows = Array.isArray(res && res.data) ? res.data : [];
    log(
      `\nGET ${PATH}?PatNum=${patNum}  ok=${Boolean(res && res.ok)} status=${res && res.status} ` +
        `ms=${Date.now() - startedAt}`
    );
    log(`  error=${JSON.stringify((res && res.error) || null)}`);
    log(`  body=${describeBody(res && res.data)}`);
    if (rows.length > 0) {
      log(`  keys=[${keysSeen(rows)}]`);
      // The two facts the feature turns on, printed explicitly.
      log(`  typeof ToothNum=${rows.map((r) => typeof r.ToothNum).join(', ')}`);
      log(`  InitialType values=${[...new Set(rows.map((r) => r.InitialType))].join(', ')}`);
      for (const r of rows.slice(0, 40)) log(`  ${JSON.stringify(r)}`);
    }
  }

  /*
   * THE FILTER-IGNORED GUARD, ASKED DIRECTLY. RCM's spikes found Open Dental
   * list endpoints that silently ignore a parameter they do not recognise and
   * return the whole practice. For this endpoint that would pre-skip one
   * patient's teeth on another patient's chart, so the answer belongs in the
   * report whether or not the feature is built.
   */
  log(`\nGET ${PATH} (no params) — does it honour the filter?`);
  const all = await get({});
  const allRows = Array.isArray(all && all.data) ? all.data : [];
  log(`  ok=${Boolean(all && all.ok)} status=${all && all.status} body=${describeBody(all && all.data)}`);
  if (allRows.length > 0) {
    log(`  distinct PatNum in the answer: ${[...new Set(allRows.map((r) => r.PatNum))].length}`);
  }
}

// Guarded, so requiring this file reaches Open Dental for nothing.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, patNumsFor, describeBody, keysSeen, PATH };
