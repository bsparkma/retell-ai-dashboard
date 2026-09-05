#!/usr/bin/env node
'use strict';

/**
 * Find out exactly what Open Dental refuses in a GroupNote — by bisection, on
 * ONE designated test patient, converging on the FIRST success and stopping.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS SCRIPT EXISTS, AND WHY IT STOPS
 * ═════════════════════════════════════════════════════════════════════════════
 * The first real send (staging, 2026-09-05) came back **"Invalid JSON"**.
 * That is Open Dental's PARSE-stage refusal, which writes nothing — so a FAILED
 * probe is free and can be repeated. A SUCCESSFUL probe writes a real note, and
 * `procnote` rows can never be edited or deleted (H0 §"Notes are append-only").
 *
 * So this walks candidates from most-likely to least, and **stops at the first
 * one that lands**. Every success is a permanent row in a chart; one is a
 * diagnosis, five are litter in a patient's record.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CANDIDATES, IN ORDER, AND WHAT EACH OUTCOME MEANS
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. **The payload H0 documented** — `PatNum` present, `ProcNums` an ARRAY,
 *    ASCII note. This is what the fix now sends. If it LANDS, the cause was the
 *    envelope (a missing required field, a wrongly-typed one, or both) and the
 *    typography was never the problem.
 * 2. **The same, with the original typography** (`·`, `—`). If 1 landed we
 *    never get here. If it is run deliberately and lands, the characters were
 *    innocent and only the envelope mattered.
 * 3. **The original envelope with ASCII text** — no PatNum, ProcNums as a
 *    comma-joined string. If THIS lands, the PM's diagnosis was right and the
 *    envelope was innocent.
 * 4. **CRLF instead of LF**, on whichever of the above landed. Open Dental's
 *    docs prefer `\r\n` in note fields; nothing in this codebase has ever
 *    proven which it accepts, and the app currently sends `\n`.
 *
 * Run it with `--dry` first: it prints every payload and sends nothing.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HOW TO RUN IT
 * ═════════════════════════════════════════════════════════════════════════════
 *   # ON STAGING ONLY, and only with a designated test patient.
 *   HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 HYG_PROBE_APTNUM=<n> \
 *     node scripts/probe-hyg-groupnote.js --dry
 *   #   ...read the payloads, then drop --dry.
 *
 * It refuses to run against a PatNum that is not one of the designated staging
 * fixtures, and it refuses when `OPENDENTAL_WRITE_DISABLED` is set (that would
 * make every probe fail for a reason that has nothing to do with the question).
 *
 * NO REAL PATIENT, EVER. roland 12827 / 12828, valley 7115. 11373 is INVALID.
 */

const odOffices = require('../config/odOffices');
const { loadSecrets } = require('../config/secrets');

/** The only PatNums this script will touch. */
const FIXTURES = { roland: [12827, 12828], valley: [7115] };

const LF = '\n';
const CRLF = '\r\n';

/** The note, as the failed send composed it — middots and an em dash. */
function typographicNote(newline) {
  return [
    'Done today: Prophy, Fluoride',
    'Recare scheduled: not answered',
    'Treatment identified today (1):',
    '  #30 · Build-up · Preventative · Restorative · proposed',
    '  Pre-op PA — Needed',
    'Entered in CareIN by probe@carein.ai. Unsigned.',
  ].join(newline);
}

/** The same note, through the platform's sanitizer. */
function asciiNote(newline) {
  const { sanitizeForOd } = require('../utils/sanitizeForOd');
  return sanitizeForOd(typographicNote(newline));
}

/**
 * The candidates, most likely first. Each is a complete request body.
 *
 * `label` is what goes in the verdict; `note` is what a landed probe leaves in
 * the chart, so every one of them says it is a probe.
 */
function candidates({ patNum, procNums }) {
  return [
    {
      label: '1. H0 payload (PatNum + ProcNums[]) with ASCII text',
      body: { PatNum: patNum, ProcNums: procNums, Note: asciiNote(LF), isSigned: false },
    },
    {
      label: '2. H0 payload with the ORIGINAL typography (middots, em dash)',
      body: { PatNum: patNum, ProcNums: procNums, Note: typographicNote(LF), isSigned: false },
    },
    {
      label: '3. the ORIGINAL envelope (no PatNum, ProcNums as a string) with ASCII text',
      body: { ProcNums: procNums.join(','), Note: asciiNote(LF), isSigned: false },
    },
    {
      label: '4. H0 payload, ASCII text, CRLF newlines',
      body: { PatNum: patNum, ProcNums: procNums, Note: asciiNote(CRLF), isSigned: false },
    },
  ];
}

async function main() {
  const dry = process.argv.includes('--dry');
  const office = String(process.env.HYG_PROBE_OFFICE || '').trim();
  const patNum = Number(process.env.HYG_PROBE_PATNUM);
  const aptNum = Number(process.env.HYG_PROBE_APTNUM);

  if (!FIXTURES[office] || !FIXTURES[office].includes(patNum)) {
    console.error(
      `Refusing to run. HYG_PROBE_PATNUM must be a designated staging fixture for that office:\n` +
        `  roland: ${FIXTURES.roland.join(', ')}\n  valley: ${FIXTURES.valley.join(', ')}`
    );
    process.exit(2);
  }
  if (!Number.isInteger(aptNum) || aptNum <= 0) {
    console.error('Set HYG_PROBE_APTNUM to the appointment whose procedures the note attaches to.');
    process.exit(2);
  }
  if (String(process.env.OPENDENTAL_WRITE_DISABLED || '').trim() === 'true') {
    console.error(
      'OPENDENTAL_WRITE_DISABLED is set, so every probe would fail for a reason that has ' +
        'nothing to do with the question. Unset it, on STAGING only.'
    );
    process.exit(2);
  }

  await loadSecrets();
  const od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  const odGet = (path, params) => od.client.apiGetRaw(path, params, { module: 'hyg-probe' });

  const procs = await odGet('/procedurelogs', { AptNum: aptNum });
  if (!procs.ok || !Array.isArray(procs.data)) {
    console.error('Could not read the appointment procedures:', procs.error);
    process.exit(1);
  }
  const procNums = procs.data.map((p) => Number(p.ProcNum)).filter((n) => Number.isInteger(n) && n > 0);
  if (procNums.length === 0) {
    console.error(
      `Appointment ${aptNum} has no procedures, so there is nothing to attach a note to. ` +
        'Pick an appointment that has some — the probe is about the payload, not about this.'
    );
    process.exit(2);
  }
  console.log(`office=${office} patNum=${patNum} aptNum=${aptNum} procNums=${procNums.join(',')}\n`);

  for (const candidate of candidates({ patNum, procNums })) {
    console.log('──', candidate.label);
    console.log(JSON.stringify(candidate.body, null, 2).slice(0, 900));
    if (dry) {
      console.log('   (dry run — not sent)\n');
      continue;
    }

    const res = await od.client.apiWriteRaw('POST', '/procedurelogs/GroupNote', candidate.body, {
      module: 'hyg-probe',
      timeoutMs: 30000,
    });
    if (res.ok) {
      console.log('\n   ✅ LANDED. Stopping here — a successful probe writes a PERMANENT note.\n');
      console.log(`   VERDICT: ${candidate.label}`);
      console.log(
        '   Check the chart, then record the verdict in ' +
          'docs/reports/feature-hyg-send-fixes.md.'
      );
      process.exit(0);
    }
    console.log(`   ❌ refused (${res.status}): ${res.error}\n`);
  }

  console.log(
    dry
      ? 'Dry run complete. Drop --dry to send them.'
      : 'Every candidate was refused. The cause is none of these — capture the exact error text ' +
          'above and widen the search rather than guessing again.'
  );
}

// Guarded, so requiring this file does not fire a chart write.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { candidates, typographicNote, asciiNote };
