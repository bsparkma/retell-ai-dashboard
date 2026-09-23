'use strict';

/**
 * PDF fee schedule parser — ported from the inline `parsePDF` in
 * `RCM Project v2/fee-schedule-importer/server.js`.
 *
 * Split in two, because only one half can be pure:
 *
 *   extractPdfText(buffer)      → text.  Impure: pdf-parse opens the container.
 *   parsePdfFeeScheduleText(t)  → rows.  PURE. Every test below drives this.
 *
 * The reference had them welded together and read from a path on disk, so its
 * line rules could only be tested by rendering a PDF. Splitting them is what
 * makes the interesting half — which line means what — testable in one line of
 * a fixture.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THE REFERENCE DID, AND WHY ALMOST NONE OF IT SURVIVES
 * ═════════════════════════════════════════════════════════════════════════════
 * It ran THREE overlapping regex patterns over every line and merged their
 * results into one `fees` object guarded by `if (!fees[cdtCode])` — first write
 * wins, silently.
 *
 *   Pattern 1  `line.match(/(D\d{4}[\w\d]?)[\s\S]*?\$?([0-9,]+\.[0-9]{2})/)`
 *              The code, then the first amount anywhere after it.
 *   Pattern 2  a code on this line, the first amount on the NEXT line.
 *   Pattern 3  EVERY code on the line, each paired with the line's FIRST
 *              amount.
 *
 * Pattern 3 is the serious one. A fee schedule is a TABLE, and its text
 * extraction routinely puts a whole row on one line:
 *
 *     D2740  Crown - porcelain/ceramic     1,150.00   920.00   805.00
 *
 * Pattern 1 and 3 both take `1,150.00` — the first column — whatever the
 * header said the office's tier was. And when a line carried several codes:
 *
 *     D0210 D0220 D0230 Radiographs                    145.00
 *
 * Pattern 3 wrote 145.00 against ALL THREE. Nothing recorded that it had
 * guessed. Pattern 2 then fired on lines patterns 1 and 3 had already matched,
 * pairing a code with whatever number happened to open the next row.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE RULE HERE: ONE LINE, ONE CODE, AND AMBIGUITY IS VISIBLE
 * ═════════════════════════════════════════════════════════════════════════════
 * Per line, count the codes and the amounts:
 *
 *   1 code, 1 amount    a row. The clean case, and most of any real file.
 *   1 code, 2+ amounts  a row using the FIRST amount, carrying an
 *                       `ambiguous_amount` warning that names every candidate
 *                       and the raw line. This is the multi-column table above.
 *                       The value is the reference's, but it is no longer
 *                       silent: the preview shows the office a flagged row and
 *                       the line it came from, which is the one thing that lets
 *                       them catch a schedule imported at the wrong tier.
 *   1 code, 0 amounts   look at the NEXT line only, and pair ONLY if that line
 *                       carries exactly one amount and no code of its own.
 *                       Warned as `paired_across_lines`. The reference paired
 *                       unconditionally, so a code on the last line of a page
 *                       took the first number off the next page's header.
 *   2+ codes            NO ROWS, and a `multiple_codes_on_line` file warning
 *                       naming them. This is where the reference invented data.
 *                       Emitting nothing is the honest answer: the parser
 *                       genuinely cannot tell which fee belongs to which code,
 *                       and a flagged absence is recoverable where a confident
 *                       wrong number is not.
 *   0 codes             not a fee line. Skipped in silence — most of a PDF is
 *                       headers, page furniture and prose.
 *
 * Duplicate codes are NOT first-write-wins. See `flagDuplicates`.
 */

const {
  normalizeProcCode,
  parseFeeCents,
  findProcCodes,
  findAmounts,
  formatCents,
  warn,
} = require('./feeValues');

/**
 * Pull the text layer out of a PDF.
 *
 * Uses the same pdf-parse v2 entry point services/rcm/eobDocumentText.js does,
 * and required lazily for the same reason: pdf.js is a heavy import and most
 * requests to this module never touch a PDF.
 *
 * NO OCR ESCALATION. RCM's document rail falls back to Azure Document
 * Intelligence when a PDF turns out to be page images, because an EOB arrives
 * as whatever the payer scanned. A fee schedule is a contract document a payer
 * PUBLISHES, and every one in the corpus carries a real text layer. A scanned
 * one is refused with PDF_NO_TEXT rather than sent to a paid OCR service the
 * office did not ask for — and if that turns out to be wrong, adding the
 * escalation is a slice with a cost conversation in it, not a quiet default.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ ok: boolean, text: string, failureCode?: string, failureReason?: string }>}
 */
async function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, text: '', failureCode: 'PDF_EMPTY', failureReason: 'The file is empty.' };
  }

  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });

  /** @type {{ text?: string }} */
  let parsed;
  try {
    parsed = await parser.getText();
  } catch (err) {
    // An encrypted, corrupt or password-protected PDF lands here. The message is
    // from pdf-parse and describes the FILE, not its contents — safe to surface,
    // and the only thing that makes this state actionable.
    const detail = (err && err.message) || String(err);
    return {
      ok: false,
      text: '',
      failureCode: 'PDF_UNREADABLE',
      failureReason: `The PDF could not be opened: ${detail}`,
    };
  } finally {
    // pdf.js holds a worker open. RCM's rail learned this the same way.
    if (typeof parser.destroy === 'function') await parser.destroy().catch(() => {});
  }

  const text = typeof parsed?.text === 'string' ? parsed.text : '';
  if (text.trim() === '') {
    return {
      ok: false,
      text: '',
      failureCode: 'PDF_NO_TEXT',
      failureReason:
        'The PDF has no text layer — its pages are images. Ask the payer for the schedule as a CSV, ' +
        'or export it from their portal rather than scanning it.',
    };
  }

  return { ok: true, text };
}

/** A failure result: the file is not parseable, and this is why. */
function failed(code, reason) {
  return { ok: false, failureCode: code, failureReason: reason, rows: [], warnings: [] };
}

/**
 * Flag every procedure code that appears more than once.
 *
 * THE REFERENCE DISCARDED THESE SILENTLY (`if (!fees[cdtCode])`), which is the
 * defect with the largest blast radius in the whole port: a payer schedule that
 * lists D2740 on page 2 at the base rate and again on page 9 at an amended rate
 * imported the page-2 number with nothing recording that page 9 existed. The
 * office posts it, and every crown is priced against a superseded contract.
 *
 * Both rows are kept — the schema has no UNIQUE (batch_id, proc_code) precisely
 * so they can be — and both are flagged. Two shapes, because they are different
 * problems: two rows AGREEING is untidy, two rows DISAGREEING is a decision
 * somebody has to make before anything is posted.
 *
 * @param {Array<{procCode: string, feeCents: number, rawLine: string, warnings: Array}>} rows
 * @returns {void} mutates rows' warnings in place
 */
function flagDuplicates(rows) {
  /** @type {Map<string, number[]>} */
  const byCode = new Map();
  rows.forEach((row, i) => {
    const at = byCode.get(row.procCode);
    if (at) at.push(i);
    else byCode.set(row.procCode, [i]);
  });

  for (const [code, indexes] of byCode) {
    if (indexes.length < 2) continue;
    const amounts = new Set(indexes.map((i) => rows[i].feeCents));
    if (amounts.size === 1) {
      const message =
        `${code} appears ${indexes.length} times in this file, always at ${formatCents(rows[indexes[0]].feeCents)}.`;
      for (const i of indexes) rows[i].warnings.push(warn('duplicate_code_same_fee', message));
      continue;
    }
    const spread = [...amounts].sort((a, b) => a - b).map(formatCents).join(', ');
    const message =
      `${code} appears ${indexes.length} times in this file at DIFFERENT fees (${spread}). ` +
      'Decide which one is the rate you hold before posting any of them.';
    for (const i of indexes) rows[i].warnings.push(warn('duplicate_code', message));
  }
}

/**
 * @typedef {object} FeeRow
 * @property {string} procCode
 * @property {number} feeCents
 * @property {string} rawLine
 * @property {Array<{code: string, message: string}>} warnings
 */

/**
 * Parse the text layer of a PDF fee schedule.
 *
 * @param {string} text
 * @returns {{ ok: boolean, failureCode: string|null, failureReason: string|null, rows: FeeRow[], warnings: Array<{code: string, message: string}> }}
 */
function parsePdfFeeScheduleText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return failed('PDF_NO_TEXT', 'The PDF has no text in it.');
  }

  const lines = text.split(/\r\n|\r|\n/);

  /** @type {FeeRow[]} */
  const rows = [];
  /** @type {Array<{code: string, message: string}>} */
  const fileWarnings = [];
  /** Lines already consumed as the amount half of a cross-line pair. */
  const consumed = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    if (consumed.has(i)) continue;

    const line = lines[i];
    const codes = findProcCodes(line);
    if (codes.length === 0) continue;

    // Line numbers as a person reading the extracted text would count them.
    const lineNumber = i + 1;
    const raw = line.trim();

    if (codes.length > 1) {
      // The reference wrote the line's first amount against every one of these.
      fileWarnings.push(
        warn(
          'multiple_codes_on_line',
          `Line ${lineNumber} names ${codes.length} procedure codes (${codes.join(', ')}), so there is no way to tell ` +
            'which fee belongs to which. No fees were read from it: ' +
            raw
        )
      );
      continue;
    }

    const code = normalizeProcCode(codes[0]);
    if (code.value === null) {
      // findProcCodes only yields D + four digits + an optional letter, so
      // normalizeProcCode cannot refuse one. Kept so a future widening of the
      // scanner cannot silently start storing codes the column CHECK rejects.
      fileWarnings.push(warn('row_skipped', `Line ${lineNumber} was skipped: ${code.warnings[0].message}`));
      continue;
    }

    /** @type {Array<{code: string, message: string}>} */
    const rowWarnings = [...code.warnings];
    let amounts = findAmounts(line);

    if (amounts.length === 0) {
      // The cross-line pair, narrowed. Only the immediately following line, and
      // only when it is unambiguously an amount and nothing else.
      const next = lines[i + 1];
      if (next === undefined) continue;
      const nextAmounts = findAmounts(next);
      if (nextAmounts.length !== 1 || findProcCodes(next).length > 0) continue;

      amounts = nextAmounts;
      consumed.add(i + 1);
      rowWarnings.push(
        warn(
          'paired_across_lines',
          `${code.value} and its fee are on separate lines (${lineNumber} and ${lineNumber + 1}); they were read as one row.`
        )
      );
    } else if (amounts.length > 1) {
      rowWarnings.push(
        warn(
          'ambiguous_amount',
          `Line ${lineNumber} carries ${amounts.length} amounts (${amounts.join(', ')}). The first was read as ` +
            `${code.value}'s fee. Check it is the right column: ` +
            raw
        )
      );
    }

    const fee = parseFeeCents(amounts[0]);
    if (fee.value === null) {
      fileWarnings.push(
        warn('row_skipped', `Line ${lineNumber} (${code.value}) was skipped: ${fee.warnings[0].message}`)
      );
      continue;
    }

    rows.push({
      procCode: code.value,
      feeCents: fee.value,
      rawLine: raw,
      warnings: rowWarnings,
    });
  }

  if (rows.length === 0) {
    return {
      ok: false,
      failureCode: 'NO_ROWS_PARSED',
      failureReason:
        'No fees could be read out of the PDF. It has text, but no line pairs a CDT procedure code with a dollar amount.',
      rows: [],
      // The file warnings are dropped with the rows on purpose: the batch CHECK
      // requires a failed batch to carry a reason, and the reason above is the
      // fact that matters. A list of lines that individually failed, on a file
      // where EVERY line failed, is noise in front of it.
      warnings: [],
    };
  }

  flagDuplicates(rows);

  return { ok: true, failureCode: null, failureReason: null, rows, warnings: fileWarnings };
}

module.exports = { extractPdfText, parsePdfFeeScheduleText, flagDuplicates };
