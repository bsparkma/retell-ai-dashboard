'use strict';

/**
 * THE ONLY FILE IN THE HYGIENE MODULE THAT MAY WRITE TO OPEN DENTAL.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ALLOW-LIST, AND WHY IT IS ONE FILE
 * ═════════════════════════════════════════════════════════════════════════════
 * `routes/hyg/hygNoOdWrites.test.js` names this file and no other. A second
 * writer is a second policy about when something lands in a patient's chart,
 * and the second one is always the one nobody reviewed — the same move
 * `services/rcm/odPostingWrites.js` made when RCM's drain arrived.
 *
 * Everything here is a NARROW function over one Open Dental call. There is no
 * orchestration, no state machine, no decision about whether a write should
 * happen: that is `services/hyg/sendVisit.js`, which cannot reach the transport
 * except through the four functions below.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * READ-BACK IS PART OF THE WRITE, NOT AN OPTIONAL EXTRA
 * ═════════════════════════════════════════════════════════════════════════════
 * Every function returns `{ ok, ... }` and never throws, and every `ok: true`
 * carries the identifier OPEN DENTAL minted — a DocNum, the ProcNums whose
 * notes now hold the text. A call that returned 200 with nothing identifying in
 * the body is reported as a FAILURE, because "we think it worked" and "Open
 * Dental says it is there" are different claims and only one of them may set a
 * staged write to `Written`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ENVIRONMENT GUARD IS BELOW THIS FILE, NOT IN IT
 * ═════════════════════════════════════════════════════════════════════════════
 * `OPENDENTAL_WRITE_DISABLED=true` is enforced inside `apiWriteRaw` itself
 * (config/openDental.js), so a dev box cannot file a document into the live
 * practice whose credentials it shares, and no caller can route around it. It
 * comes back here as an ordinary refusal carrying `OD_WRITE_DISABLED`, which is
 * what the queue row should record.
 */

/** Open Dental's image-category definitions live under Category 18. */
const DOC_CATEGORY_DEFINITION_CATEGORY = 18;

/** Longer than a read: a document upload carries a base64 payload. */
const WRITE_TIMEOUT_MS = 30000;

/**
 * The image category a routing slip is filed into, BY NAME.
 *
 * ⚠️ NEVER A DEFNUM. ⚠️ DefNums are per-database: H0 found 473 and 429 for the
 * same category name in the two practices, so a constant copied between them
 * files a document into whatever that number happens to mean at the other
 * office. The name is resolved live, against that office's own definitions,
 * every time.
 *
 * Per-office override so a practice that renames its category does not need a
 * deploy — the same shape every other per-office setting in this codebase has.
 *
 * @param {string} officeKey
 * @returns {string}
 */
function slipCategoryName(officeKey) {
  const override = process.env[`HYG_SLIP_DOC_CATEGORY_${String(officeKey).toUpperCase()}`];
  const generic = process.env.HYG_SLIP_DOC_CATEGORY;
  const name = (override || generic || 'Routers').trim();
  return name || 'Routers';
}

/**
 * Resolve that office's DocCategory DefNum by name.
 *
 * A READ, and it lives in the writer file on purpose: it exists only to feed
 * the upload, and separating a write from the lookup that makes it correct is
 * how the lookup gets skipped. H0's finding is why it is not optional —
 * omitting DocCategory files the document into the FIRST category, and a slip
 * that lands somewhere nobody looks is worse than an upload that failed.
 *
 * @param {(path: string, params?: object, opts?: object) => Promise<any>} odGet
 * @param {string} officeKey
 * @returns {Promise<{ ok: true, defNum: number, name: string }
 *          | { ok: false, code: string, error: string }>}
 */
async function resolveSlipDocCategory(odGet, officeKey) {
  const wanted = slipCategoryName(officeKey);
  const res = await odGet('/definitions', { Category: DOC_CATEGORY_DEFINITION_CATEGORY });
  if (!res || !res.ok || !Array.isArray(res.data)) {
    return {
      ok: false,
      code: 'DOC_CATEGORY_UNREADABLE',
      error: `Could not read this office's image categories from Open Dental`,
    };
  }

  const target = wanted.toLowerCase();
  const match = res.data.find(
    (d) => String(d.ItemName ?? d.Name ?? '').trim().toLowerCase() === target
  );
  if (!match) {
    // Named, not guessed. "Nothing called Routers" is a fixable sentence; a
    // document in the wrong category is a support ticket nobody opens.
    return {
      ok: false,
      code: 'DOC_CATEGORY_NOT_FOUND',
      error:
        `This office has no image category called "${wanted}". Create it in Open Dental, ` +
        `or set HYG_SLIP_DOC_CATEGORY_${String(officeKey).toUpperCase()} to the name it uses.`,
    };
  }
  const defNum = Number(match.DefNum);
  if (!Number.isInteger(defNum) || defNum <= 0) {
    return {
      ok: false,
      code: 'DOC_CATEGORY_UNREADABLE',
      error: `The image category "${wanted}" has no usable DefNum`,
    };
  }
  return { ok: true, defNum, name: wanted };
}

/**
 * The ProcNums on one appointment.
 *
 * A GroupNote attaches to procedures. An appointment with none has nothing to
 * attach to, and the honest answer is to say so — never to create a procedure so
 * a note has somewhere to live. That would be this module inventing clinical
 * data to satisfy its own workflow, which is the worst thing it could do.
 *
 * @returns {Promise<{ ok: true, procNums: number[] }
 *          | { ok: false, code: string, error: string }>}
 */
async function readAppointmentProcedures(odGet, aptNum) {
  const res = await odGet('/procedurelogs', { AptNum: aptNum });
  if (!res || !res.ok || !Array.isArray(res.data)) {
    return {
      ok: false,
      code: 'PROCEDURES_UNREADABLE',
      error: 'Could not read this appointment’s procedures from Open Dental',
    };
  }
  const procNums = res.data
    .map((p) => Number(p.ProcNum))
    .filter((n) => Number.isInteger(n) && n > 0);
  return { ok: true, procNums };
}


/**
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE A GROUP NOTE IS READ BACK FROM — AND WHY IT IS NOT /procedurelogs
 * ═════════════════════════════════════════════════════════════════════════════
 * A GroupNote does not put text on the procedures it spans. It creates a
 * SYNTHETIC procedure whose code is `~GRP~` and whose note holds the text —
 * `docs/HYG_SPIKE_H0_OD_COVERAGE.md` says so in both places it discusses the
 * endpoint, and it names a dedicated read surface for those rows:
 *
 *   > `/procedurelogs/GroupNote` … Read: `GET /procedurelogs/GroupNotes?PatNum=`
 *   > (25.2.38) … creates a `~GRP~` procedure spanning `ProcNums[]`
 *
 * Both practices run 25.4.48, so the surface exists at both.
 *
 * The first version of the read-back asked `GET /procedurelogs?AptNum=` and
 * looked for the text on the appointment's own procedures. That is the wrong
 * question twice over: the `~GRP~` row is not one of them, and a procedurelog
 * row does not carry note text at all — Open Dental's own documentation, quoted
 * in H0, says *"Cannot update notes on single procedures through ProcedureLog
 * endpoints; use API ProcNotes instead"*, because the note lives in `procnote`.
 * `String(p.Note ?? '')` was therefore `''` on every row, and the read-back
 * could never have confirmed anything. On 2026-09-07 it duly reported
 * NOTE_UNCONFIRMED for a note the POST had accepted with a 200.
 *
 * ⚠️ The coverage table marks this surface **Docs**, not GET-verified — the
 * spike never called it. `backend/scripts/diag-hyg-groupnotes.js` is the
 * read-only script that settles its shape; see the slice report.
 */
const GROUP_NOTES_PATH = '/procedurelogs/GroupNotes';

/**
 * The note text on a GroupNotes row, or null.
 *
 * TWO FIELD NAMES, BOTH FROM THE RECORD — not a guess and not a net cast wide.
 * H0 documents the POST field as `Note`, and quotes Open Dental calling the
 * procedure's stored column `ProcNote`. Which one this surface echoes is
 * exactly what the diagnostic prints. Nothing else is read: inventing a third
 * spelling is how the first read-back came to look at a field that was never
 * there.
 *
 * @param {any} row
 * @returns {string | null}
 */
function groupNoteText(row) {
  if (!row || typeof row !== 'object') return null;
  const raw = row.Note ?? row.ProcNote;
  return typeof raw === 'string' ? raw : null;
}

/**
 * The two texts are the same note.
 *
 * EXACT, with ONE normalization: `\r\n` is folded to `\n` on both sides. The
 * app sends `\n` (stagedWriteComposer's NOTE_NEWLINE) and Open Dental's docs
 * prefer `\r\n` in note fields, so a round trip may well come back in the other
 * convention. That is the same note written the same way, not a similar one.
 *
 * Everything else is byte-exact on purpose. The old read-back used
 * `.includes()`, which would have matched a longer note that merely CONTAINED
 * this one — and once this comparison also decides whether to skip a write, a
 * loose match stops being a cosmetic risk and starts being a note that never
 * reaches a chart.
 *
 * @param {string | null} a @param {string | null} b @returns {boolean}
 */
function sameNoteText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

/**
 * The row's procedure date as `YYYY-MM-DD`, or null when it carries none.
 *
 * @param {any} row @returns {string | null}
 */
function groupNoteDate(row) {
  if (!row || typeof row !== 'object') return null;
  const raw = row.ProcDate ?? row.procDate;
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  return m ? m[1] : null;
}

/**
 * The `~GRP~` row's own ProcNum — the identifier OPEN DENTAL minted.
 *
 * @param {any} row @returns {number | null}
 */
function groupNoteProcNum(row) {
  if (!row || typeof row !== 'object') return null;
  const n = Number(row.ProcNum);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Every GroupNote on a patient.
 *
 * @param {(path: string, params?: object, opts?: object) => Promise<any>} odGet
 * @param {number} patNum
 * @returns {Promise<{ ok: true, rows: any[] }
 *          | { ok: false, code: string, error: string }>}
 */
async function readGroupNotes(odGet, patNum) {
  const res = await odGet(GROUP_NOTES_PATH, { PatNum: patNum });
  if (!res || !res.ok || !Array.isArray(res.data)) {
    return {
      ok: false,
      code: 'GROUP_NOTES_UNREADABLE',
      error: 'Could not read this patient’s visit notes back from Open Dental',
    };
  }
  return { ok: true, rows: res.data };
}

/**
 * The rows carrying exactly this note text.
 *
 * @param {any[]} rows @param {string} note @returns {any[]}
 */
function matchingGroupNotes(rows, note) {
  return rows.filter((row) => sameNoteText(groupNoteText(row), note));
}

/**
 * Write the visit note as a GroupNote, UNSIGNED.
 *
 * B1, locked: CareIN never claims a signature. `isSigned: false` is sent
 * explicitly rather than left to a default, and the note text carries a typed
 * name block the composer built. Open Dental's own signature block is the only
 * thing allowed to say a note was signed, and this app cannot produce one.
 *
 * `ProvNum` is the hygienist's Open Dental provider number when the appointment
 * has one. Omitted when it does not — a note attributed to provider zero is
 * worse than a note attributed to nobody.
 *
 * READ-BACK: the note is fetched again from `/procedurelogs/GroupNotes?PatNum=`
 * — see the block above for why that surface and not the appointment's own
 * procedures. The POST returning 200 is not the claim being made here; "the
 * chart contains this" is.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * READ FIRST. A RETRY MUST NOT WRITE A SECOND PERMANENT NOTE.
 * ═════════════════════════════════════════════════════════════════════════════
 * H0: *"No existing procnote can EVER be edited or deleted."* So a POST that
 * landed but could not be confirmed leaves a row the hygienist sees as Failed,
 * with a Retry button, over a note that is already in the chart — and every
 * press of it filed another copy that nobody can take out again. That is the
 * shape this function is built around now:
 *
 *   1. read the patient's GroupNotes BEFORE writing;
 *   2. an identical note already on the visit's date ⇒ do not POST at all,
 *      report the row that is already there;
 *   3. POST;
 *   4. read again, and confirm by the row that APPEARED — not merely by a row
 *      that matches, which an older identical note would also satisfy.
 *
 * Step 4 is why the before-read is not just a dedupe check: comparing the two
 * reads identifies the `~GRP~` ProcNum Open Dental minted for THIS note, which
 * is the identifier this file's header requires of every `ok: true`.
 *
 * ⚠️ An unreadable before-read REFUSES rather than falling through to the POST.
 * A write we could not have confirmed and whose retry could not have deduped is
 * exactly the write that produced the duplicate; declining to make it costs a
 * retry, and making it costs a permanent row.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PAYLOAD, AND THE TWO THINGS THE FIRST REAL SEND GOT WRONG
 * ═════════════════════════════════════════════════════════════════════════════
 * The first real send (staging, 2026-09-05) came back **"Invalid JSON"** — Open
 * Dental's PARSE-stage refusal, which writes nothing. `docs/HYG_SPIKE_H0_OD_COVERAGE.md`
 * §"How the two clinical options differ" is the authoritative record of what H0
 * proved against a live database, and it says:
 *
 *   > POST /procedurelogs/GroupNote — required `PatNum`, `Note`;
 *   > optional `ProcNums[]`, `ProvNum`, `isSigned`.
 *
 * The first version of this function sent **no `PatNum` at all** — a REQUIRED
 * field — and sent `ProcNums` as a comma-joined STRING where the contract says
 * an ARRAY. Both are fixed here. A missing required field and a wrongly-typed
 * one are a better explanation of a parse-stage refusal than any character in
 * the note, and unlike a character they are checkable against this repo's own
 * spike rather than against a guess.
 *
 * The note text is ALSO now ASCII-safe, upstream in the composer — see
 * services/hyg/stagedWriteComposer.js. That change is independent and would
 * have been right regardless: the platform has normalized OD note text for
 * months (utils/sanitizeForOd.js), and this module was the one path that did
 * not.
 *
 * `backend/scripts/probe-hyg-groupnote.js` is what distinguishes the two
 * causes on staging, and it has not been run — see the slice report.
 *
 * @param {number} patNum REQUIRED by Open Dental. Never optional here.
 * @param {string | null} visitDate `YYYY-MM-DD`; the date a prior identical
 *   note must share before this declines to write a second one.
 * @returns {Promise<{ ok: true, procNums: number[], groupProcNum: number | null,
 *            alreadyPresent: boolean }
 *          | { ok: false, code: string, error: string }>}
 */
async function writeGroupNote(od, odGet, { patNum, procNums, note, provNum, visitDate }) {
  // ── 1. WHAT IS ALREADY THERE ───────────────────────────────────────────────
  const before = await readGroupNotes(odGet, patNum);
  if (!before.ok) {
    return {
      ok: false,
      code: 'NOTE_PRECHECK_UNAVAILABLE',
      error:
        'Open Dental did not answer when asked which visit notes this patient already has, ' +
        'so the note was not sent — writing it now could file a second permanent copy of a ' +
        'note that is already in the chart. Try again.',
    };
  }
  const priorMatches = matchingGroupNotes(before.rows, note);

  // ── 2. ALREADY ON THE CHART ────────────────────────────────────────────────
  // The date is required for this branch, not optional: two prophy visits can
  // compose the SAME note text, and "identical text somewhere in this patient's
  // history" is not evidence that today's note was filed. When the surface
  // carries no date, this simply does not fire and the write proceeds — the
  // status quo, and never a Written that isn't true.
  const already = visitDate
    ? priorMatches.find((row) => groupNoteDate(row) === visitDate)
    : undefined;
  if (already) {
    return {
      ok: true,
      procNums,
      groupProcNum: groupNoteProcNum(already),
      alreadyPresent: true,
    };
  }
  // ── 3. WRITE ──────────────────────────────────────────────────────────────
  const body = {
    // REQUIRED. Its absence is the likeliest cause of the "Invalid JSON" that
    // came back from the first real send.
    PatNum: patNum,
    // AN ARRAY, per H0. It was a comma-joined string.
    ProcNums: procNums,
    Note: note,
    // NEVER true. See the note above.
    isSigned: false,
  };
  if (Number.isInteger(provNum) && provNum > 0) body.ProvNum = provNum;

  const res = await od.client.apiWriteRaw('POST', '/procedurelogs/GroupNote', body, {
    module: 'hyg',
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (!res || !res.ok) {
    return {
      ok: false,
      code: writeFailureCode(res),
      error: writeFailureMessage(res, 'Open Dental refused the visit note'),
    };
  }

  // ── 4. READ-BACK. A 200 IS NOT THE CLAIM. ─────────────────────────────────
  const after = await readGroupNotes(odGet, patNum);
  if (!after.ok) {
    return {
      ok: false,
      code: 'NOTE_UNCONFIRMED',
      error:
        'Open Dental accepted the note but did not answer when asked to read it back, ' +
        'so this is being reported as unsent rather than guessed at. Sending it again is ' +
        'safe: CareIN checks for it before writing.',
    };
  }

  // CONFIRM BY WHAT APPEARED, not by what matches. An older identical note
  // would satisfy "a row with this text exists" without our note ever landing.
  const priorProcNums = new Set(
    priorMatches.map((row) => groupNoteProcNum(row)).filter((n) => n !== null)
  );
  const afterMatches = matchingGroupNotes(after.rows, note);
  const appeared = afterMatches.find((row) => {
    const procNum = groupNoteProcNum(row);
    return procNum !== null && !priorProcNums.has(procNum);
  });
  if (appeared) {
    return { ok: true, procNums, groupProcNum: groupNoteProcNum(appeared), alreadyPresent: false };
  }
  // No ProcNum to diff on, but there is one more matching row than there was.
  // Weaker evidence, and still evidence: the count moved because of this write.
  if (afterMatches.length > priorMatches.length) {
    return { ok: true, procNums, groupProcNum: null, alreadyPresent: false };
  }
  return {
    ok: false,
    code: 'NOTE_UNCONFIRMED',
    error:
      'Open Dental accepted the note but it is not among this patient’s visit notes when ' +
      'read back',
  };
}

/**
 * File a document into the patient's images.
 *
 * DocCategory is ALWAYS sent — see resolveSlipDocCategory.
 *
 * READ-BACK: the response must carry a DocNum. Open Dental mints it, so its
 * presence is the database saying the row exists; a 200 with no DocNum is
 * reported as a failure rather than as a document nobody can find.
 *
 * @returns {Promise<{ ok: true, docNum: number }
 *          | { ok: false, code: string, error: string }>}
 */
async function uploadDocument(od, { patNum, docCategory, description, rawBase64 }) {
  const res = await od.client.apiWriteRaw(
    'POST',
    '/documents/Upload',
    {
      PatNum: patNum,
      DocCategory: docCategory,
      Description: description,
      // Open Dental keys the file type off the extension, and the slip is
      // always a PDF because slipPdf.js is what produced these bytes.
      extension: '.pdf',
      rawBase64,
    },
    { module: 'hyg', timeoutMs: WRITE_TIMEOUT_MS }
  );

  if (!res || !res.ok) {
    return {
      ok: false,
      code: writeFailureCode(res),
      error: writeFailureMessage(res, 'Open Dental refused the routing slip'),
    };
  }
  const docNum = Number(res.data && res.data.DocNum);
  if (!Number.isInteger(docNum) || docNum <= 0) {
    return {
      ok: false,
      code: 'SLIP_UNCONFIRMED',
      error:
        'Open Dental accepted the slip but returned no document number, so there is nothing ' +
        'to point at and this is being reported as unsent',
    };
  }
  return { ok: true, docNum };
}

/** `OD_WRITE_DISABLED` and the like arrive in the error text; keep the code. */
function writeFailureCode(res) {
  const text = String((res && res.error) || '');
  if (text.startsWith('OD_WRITE_DISABLED')) return 'OD_WRITE_DISABLED';
  return 'OD_WRITE_FAILED';
}

function writeFailureMessage(res, fallback) {
  const text = String((res && res.error) || '').trim();
  if (!text) return fallback;
  return `${fallback}: ${text}`;
}

module.exports = {
  slipCategoryName,
  resolveSlipDocCategory,
  readAppointmentProcedures,
  readGroupNotes,
  matchingGroupNotes,
  sameNoteText,
  groupNoteText,
  groupNoteDate,
  groupNoteProcNum,
  writeGroupNote,
  uploadDocument,
  DOC_CATEGORY_DEFINITION_CATEGORY,
  GROUP_NOTES_PATH,
};
