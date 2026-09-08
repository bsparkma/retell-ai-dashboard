#!/usr/bin/env node
'use strict';

/**
 * READ-ONLY. Print what Open Dental's two note-bearing read surfaces actually
 * return for one designated test patient, side by side.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY
 * ═════════════════════════════════════════════════════════════════════════════
 * On 2026-09-07 a real send reported the visit note as Failed with
 * `NOTE_UNCONFIRMED` — "Open Dental accepted the note but it is not on the
 * appointment when read back" — while the slip and the handoff both landed. The
 * POST had returned 200. So the note very probably IS on the chart and only the
 * read-back looked in the wrong place.
 *
 * `docs/HYG_SPIKE_H0_OD_COVERAGE.md` says a GroupNote creates a synthetic
 * `~GRP~` procedure and names `GET /procedurelogs/GroupNotes?PatNum=` as its
 * read surface — but it marked that row **Docs**, not GET-verified. The spike
 * never called it. This script calls it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT FOUND — roland, PatNum 12828, AptNum 110123, 2026-09-08
 * ═════════════════════════════════════════════════════════════════════════════
 *   GET /procedurelogs/GroupNotes?PatNum=12828   200, 1 row
 *     keys: Note, PatNum, ProcNum, ProcNums, ProvNum, isSigned
 *     ProcNum=406901  ProcNums=[406880, 406881] (an ARRAY)
 *     Note="Done today: Prophy" + CRLF + "X-rays: BW-4, PA" + CRLF + "…"
 *
 *   GET /procedurelogs?AptNum=110123             200, 2 rows
 *     45 keys, and NEITHER `Note` NOR `ProcNote` among them.
 *
 * So: the note was on the chart all along; the read-back was asking a surface
 * that structurally cannot carry note text. And the GroupNotes row has **no
 * date of any kind** — no ProcDate, no AptNum, no EntryDateTime — so it is
 * `ProcNums` that identifies a note, which is a stronger discriminator than a
 * date would have been. See services/hyg/odWriter.js.
 *
 * Worth knowing if you run this: the surface timed out at 30s on three of five
 * attempts against a credential voice and RCM were also using. A timeout is not
 * an empty answer, and the script now says so rather than concluding from one.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT TO LOOK FOR IN THE OUTPUT
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. Does `GET /procedurelogs/GroupNotes?PatNum=` answer 200 at all?
 * 2. Do its rows carry the note TEXT, and under which key — `Note` or
 *    `ProcNote`? services/hyg/odWriter.js reads exactly those two and nothing
 *    else, because inventing a third spelling is how the first read-back came
 *    to look at a field that was never there.
 * 3. Do the rows carry a DATE (`ProcDate`)? The date is what lets a retry tell
 *    today's note from an identical one written at another visit. Without it
 *    the dedupe cannot fire, and a retry would file a second permanent copy.
 *    ⚠️ This is the single most load-bearing thing to check before relying on
 *    the retry guard.
 * 4. Do they carry a `ProcNum` of their own? That is the identifier a
 *    `writtenRef` should point at.
 * 5. Does `GET /procedurelogs?AptNum=` carry note text at ALL? The claim being
 *    tested is that it does not — that the old read-back could never have
 *    confirmed anything.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HOW TO RUN IT
 * ═════════════════════════════════════════════════════════════════════════════
 *   # STAGING. Designated test patient only. Nothing here writes.
 *   HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 HYG_PROBE_APTNUM=<n> \
 *     node scripts/diag-hyg-groupnotes.js
 *
 * `HYG_PROBE_APTNUM` is optional — omit it and the appointment-side read is
 * skipped and everything else still prints.
 *
 * It refuses any PatNum that is not a designated staging fixture. It names no
 * write verb, so `routes/rcm/rcmNoOdWrites.test.js` scans it and finds nothing;
 * it needs no entry in that test's allow-list.
 *
 * NO REAL PATIENT, EVER. roland 12827 / 12828, valley 7115. 11373 is INVALID.
 */

const odOffices = require('../config/odOffices');
const { loadSecrets } = require('../config/secrets');

/** The only PatNums this script will read. */
const FIXTURES = { roland: [12827, 12828], valley: [7115] };

/** Long enough to be honest about a slow read, short enough to fail visibly. */
const READ_TIMEOUT_MS = 30000;

/** How much of a note to print. Enough to recognise; not a transcript. */
const NOTE_PREVIEW_CHARS = 80;

/**
 * One line of note text, escaped, truncated, and never wrapped.
 *
 * @param {unknown} raw @returns {string}
 */
function preview(raw) {
  if (typeof raw !== 'string') return `(no text — ${raw === undefined ? 'absent' : typeof raw})`;
  const flat = raw.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return flat.length > NOTE_PREVIEW_CHARS ? `${flat.slice(0, NOTE_PREVIEW_CHARS)}…` : flat;
}

/**
 * The keys a row actually has, so the next person does not have to guess.
 *
 * @param {any[]} rows @returns {string}
 */
function keysSeen(rows) {
  const keys = new Set();
  for (const row of rows) {
    if (row && typeof row === 'object') for (const k of Object.keys(row)) keys.add(k);
  }
  return keys.size ? Array.from(keys).sort().join(', ') : '(none)';
}

/**
 * Print one surface's answer.
 *
 * @param {string} label @param {any} res
 * @returns {any[]} the rows, or an empty array
 */
function report(label, res) {
  console.log(`\n══ ${label}`);
  if (!res || !res.ok) {
    console.log(`   ✗ ${res && res.status ? `HTTP ${res.status} ` : ''}${(res && res.error) || 'no answer'}`);
    return [];
  }
  if (!Array.isArray(res.data)) {
    console.log(`   ✗ 200, but the body is ${res.data === null ? 'null' : typeof res.data}, not an array`);
    return [];
  }
  console.log(`   ✓ 200 · ${res.data.length} row${res.data.length === 1 ? '' : 's'}`);
  console.log(`   keys: ${keysSeen(res.data)}`);
  return res.data;
}

/**
 * @param {any[]} rows
 * @returns {void}
 */
function printNoteRows(rows) {
  for (const row of rows) {
    const parts = [
      `ProcNum=${row.ProcNum ?? '—'}`,
      `ProcDate=${row.ProcDate ?? '—'}`,
      `AptNum=${row.AptNum ?? '—'}`,
      `ProcCode=${row.procCode ?? row.ProcCode ?? row.CodeSent ?? '—'}`,
      // The procedures a ~GRP~ row spans. Printed with its TYPE because the
      // whole 2026-09-05 "Invalid JSON" turned on array-vs-string, and because
      // this is the field the retry guard has to match on when there is no date.
      `ProcNums=${JSON.stringify(row.ProcNums) ?? '—'} (${Array.isArray(row.ProcNums) ? 'array' : typeof row.ProcNums})`,
      `EntryDateTime=${row.EntryDateTime ?? '—'}`,
    ];
    console.log(`   · ${parts.join('  ')}`);
    console.log(`     Note=${preview(row.Note)}`);
    if (row.ProcNote !== undefined) console.log(`     ProcNote=${preview(row.ProcNote)}`);
  }
}

async function main() {
  const office = String(process.env.HYG_PROBE_OFFICE || '').trim();
  const patNum = Number(process.env.HYG_PROBE_PATNUM);
  const rawApt = String(process.env.HYG_PROBE_APTNUM || '').trim();
  const aptNum = rawApt ? Number(rawApt) : null;

  if (!FIXTURES[office] || !FIXTURES[office].includes(patNum)) {
    console.error(
      'Refusing to run. HYG_PROBE_PATNUM must be a designated staging fixture for that office:\n' +
        `  roland: ${FIXTURES.roland.join(', ')}\n  valley: ${FIXTURES.valley.join(', ')}`
    );
    process.exit(2);
  }
  if (rawApt && (!Number.isInteger(aptNum) || aptNum <= 0)) {
    console.error('HYG_PROBE_APTNUM, when set, must be a positive appointment number.');
    process.exit(2);
  }

  await loadSecrets();
  const od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  const odGet = (path, params) =>
    od.client.apiGetRaw(path, params, { module: 'hyg-diag', timeoutMs: READ_TIMEOUT_MS });

  console.log(`office=${office} patNum=${patNum} aptNum=${aptNum ?? '(skipped)'}`);

  // ── The surface the read-back SHOULD have used ─────────────────────────────
  const groupRows = report(
    `GET /procedurelogs/GroupNotes?PatNum=${patNum}   ← where a ~GRP~ note lives`,
    await odGet('/procedurelogs/GroupNotes', { PatNum: patNum })
  );
  printNoteRows(groupRows);

  // ── The surface it DID use ─────────────────────────────────────────────────
  if (aptNum !== null) {
    const aptRows = report(
      `GET /procedurelogs?AptNum=${aptNum}   ← what the old read-back asked`,
      await odGet('/procedurelogs', { AptNum: aptNum })
    );
    printNoteRows(aptRows);
    const anyText = aptRows.some(
      (row) => typeof (row && (row.Note ?? row.ProcNote)) === 'string' && (row.Note ?? row.ProcNote)
    );
    // A FAILED READ IS NOT EVIDENCE OF AN EMPTY ONE. The first version of this
    // printed "no note text on these rows at all" after a timeout, because an
    // unanswered read and an answered one with no note text both arrive here as
    // an empty array. A diagnostic that states a finding it did not observe is
    // worse than one that says nothing — it is the same class of mistake as the
    // read-back it exists to investigate.
    console.log(
      aptRows.length === 0
        ? '\n   ? This read returned nothing — see the line above for whether that was a ' +
            'refusal or an empty answer. No conclusion is available from it either way.'
        : anyText
          ? '\n   ⚠️ These rows DO carry note text — the old read-back could have worked, so the ' +
              'miss has another cause. Say so in the report rather than assuming.'
          : '\n   → No note text on these rows at all, which is the claim: the old read-back was ' +
              'comparing against an empty string every time.'
    );
  }

  // ── The per-procedure note surface, for completeness ───────────────────────
  const procNoteRows = report(
    `GET /procnotes?PatNum=${patNum}   ← the single-procedure note surface`,
    await odGet('/procnotes', { PatNum: patNum })
  );
  printNoteRows(procNoteRows);

  console.log(
    '\nRecord what came back in docs/reports/feature-hyg-note-readback.md — especially ' +
      'whether the GroupNotes rows carry ProcDate, which is what makes the retry guard work.'
  );
}

// Guarded, so requiring this file does not fire a read against a live practice.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { preview, keysSeen, FIXTURES };
