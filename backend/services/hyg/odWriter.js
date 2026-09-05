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
 * READ-BACK: the note text is fetched again from `/procedurelogs?AptNum=` and
 * must be present on at least one procedure. The POST returning 200 is not the
 * claim being made here; "the chart contains this" is.
 *
 * @returns {Promise<{ ok: true, procNums: number[] }
 *          | { ok: false, code: string, error: string }>}
 */
async function writeGroupNote(od, odGet, { aptNum, procNums, note, provNum }) {
  const body = {
    ProcNums: procNums.join(','),
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

  // READ-BACK. A 200 is not the claim.
  const after = await odGet('/procedurelogs', { AptNum: aptNum });
  if (!after || !after.ok || !Array.isArray(after.data)) {
    return {
      ok: false,
      code: 'NOTE_UNCONFIRMED',
      error:
        'Open Dental accepted the note but did not answer when asked to read it back, ' +
        'so this is being reported as unsent rather than guessed at',
    };
  }
  const landed = after.data.some((p) => String(p.Note ?? '').includes(note));
  if (!landed) {
    return {
      ok: false,
      code: 'NOTE_UNCONFIRMED',
      error: 'Open Dental accepted the note but it is not on the appointment when read back',
    };
  }
  return { ok: true, procNums };
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
  writeGroupNote,
  uploadDocument,
  DOC_CATEGORY_DEFINITION_CATEGORY,
};
