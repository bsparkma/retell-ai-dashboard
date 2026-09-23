'use strict';

/**
 * CSV fee schedule parser — ported from the inline `parseCSV` in
 * `RCM Project v2/fee-schedule-importer/server.js`.
 *
 * PURE and SYNCHRONOUS: a string in, a parse result out. The reference was
 * neither — it was a `csv-parser` stream over a path on disk, wrapped in a
 * Promise. Two reasons that could not come across:
 *
 *  - This module never writes an upload to disk. The bytes arrive in memory and
 *    leave scope when the request ends (see routes/fees/imports.js).
 *  - `csv-parser` is not a dependency of this repo and adding one to read a
 *    two-column file would be a poor trade. `splitCsv` below is forty lines and
 *    handles the only thing a hand-rolled splitter usually gets wrong: quoted
 *    fields containing commas, newlines and escaped quotes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HEADLINE CHANGE: COLUMN DETECTION REFUSES AMBIGUITY
 * ─────────────────────────────────────────────────────────────────────────────
 * The reference chose its columns like this, per row:
 *
 *     for (const [key, value] of Object.entries(row)) {
 *       if (keyLower.includes('code') || keyLower.includes('cdt')) cdtCode = value;
 *       else if (keyLower.includes('fee') || keyLower.includes('amount')
 *                || keyLower.includes('allowed')) feeAmount = parseFloat(...);
 *     }
 *
 * Substring matching with LAST-WINS. Three ways that reads the wrong column,
 * all of them silent:
 *
 *  - `Zip Code`, `Code Description`, `Area Code` all contain "code". A payer
 *    export with a description column after the code column parsed the
 *    DESCRIPTION as the procedure code, and every row was then discarded as
 *    unmatched — which looks exactly like an empty file.
 *  - A schedule with `UCR Fee`, `Allowed Amount` and `Contracted Fee` has three
 *    fee-ish columns. Whichever came last in key order won. Key order is the
 *    file's column order, so inserting a column changed which rate got
 *    imported, with nothing to show it had.
 *  - There was no check that a column was found at all. A file whose headers
 *    matched nothing produced zero rows and reported success.
 *
 * Here headers are normalised and matched against explicit lists, and the file
 * is REFUSED unless exactly one column wins each role. The refusal names the
 * candidates, because "I cannot tell whether you meant UCR Fee or Contracted
 * Fee" is a question an office can answer in five seconds and a parser cannot
 * answer at all. This is hard rule 4: ambiguity is a refusal, not a coin flip.
 */

const { normalizeProcCode, parseFeeCents, warn } = require('./feeValues');

/**
 * Header names that mean "this column holds the procedure code".
 *
 * EXACT matches after normalisation (lower-cased, every non-alphanumeric
 * character removed), never substrings — `zipcode` normalises to something that
 * is not in this list, which is the entire point.
 */
const CODE_HEADERS = Object.freeze([
  'code',
  'cdt',
  'cdtcode',
  'adacode',
  'proccode',
  'procedure',
  'procedurecode',
  'proceduregcode',
  'servicecode',
]);

/**
 * Header names that mean "this column holds the fee".
 *
 * Ordered by nothing — a file matching two of these is refused, so precedence
 * would only be a way to silently pick one. If a payer's format genuinely needs
 * a preference, it is a decision for the office and belongs in a request field,
 * not in the order of this array.
 */
const FEE_HEADERS = Object.freeze([
  'fee',
  'fees',
  'amount',
  'feeamount',
  'allowed',
  'allowedfee',
  'allowedamount',
  'ucr',
  'ucrfee',
  'rate',
  'contractedfee',
  'contractedrate',
  'contractedamount',
  'negotiatedfee',
  'negotiatedrate',
  'scheduledfee',
  'planfee',
]);

/** Lower-case, strip everything that is not a letter or a digit. */
function normalizeHeader(raw) {
  return String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Split CSV text into rows of fields.
 *
 * RFC 4180 as far as it matters here: `"` quotes a field, `""` inside a quoted
 * field is a literal quote, a quoted field may contain commas and newlines.
 * CRLF, LF and CR line endings all terminate a row. A trailing newline does not
 * produce a final empty row.
 *
 * @param {string} text
 * @returns {string[][]}
 */
function splitCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === ',') {
      started = true;
      endField();
      continue;
    }
    if (ch === '\r') {
      // Swallow the LF of a CRLF pair; a lone CR is still a row terminator.
      if (text[i + 1] === '\n') i += 1;
      endRow();
      continue;
    }
    if (ch === '\n') {
      endRow();
      continue;
    }
    started = true;
    field += ch;
  }

  // A trailing newline leaves nothing pending; anything else is a final row.
  if (started || field !== '' || row.length > 0) endRow();

  return rows;
}

/**
 * Which column holds `role`, or why we cannot tell.
 *
 * @param {string[]} headers normalised header names, by column index
 * @param {ReadonlyArray<string>} vocabulary
 * @param {string[]} original the headers as the file spells them, for the message
 * @returns {{ index: number|null, candidates: string[] }}
 */
function pickColumn(headers, vocabulary, original) {
  /** @type {number[]} */
  const hits = [];
  headers.forEach((h, i) => {
    if (vocabulary.includes(h)) hits.push(i);
  });
  if (hits.length === 1) return { index: hits[0], candidates: [] };
  return { index: null, candidates: hits.map((i) => original[i]) };
}

/** A failure result: the file is not parseable, and this is why. */
function failed(code, reason) {
  return { ok: false, failureCode: code, failureReason: reason, rows: [], warnings: [] };
}

/**
 * @typedef {object} FeeRow
 * @property {string} procCode      D + four digits
 * @property {number} feeCents      integer cents, >= 0
 * @property {string} rawLine       the source line, verbatim
 * @property {Array<{code: string, message: string}>} warnings
 */

/**
 * @typedef {object} ParseResult
 * @property {boolean} ok
 * @property {string|null} [failureCode]
 * @property {string|null} [failureReason]
 * @property {FeeRow[]} rows
 * @property {Array<{code: string, message: string}>} warnings file-level
 */

/**
 * Parse a CSV fee schedule.
 *
 * @param {string} text the whole file, decoded as UTF-8
 * @returns {ParseResult}
 */
function parseCsvFeeSchedule(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return failed('CSV_EMPTY', 'The file is empty.');
  }

  // A UTF-8 BOM is what Excel writes, and it would otherwise become part of the
  // first header name — turning `Code` into something that matches nothing.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const grid = splitCsv(body).filter((r) => r.some((cell) => cell.trim() !== ''));
  if (grid.length === 0) return failed('CSV_EMPTY', 'The file is empty.');
  if (grid.length === 1) {
    return failed(
      'CSV_NO_DATA_ROWS',
      'The file has a header row and nothing else — there are no fees in it.'
    );
  }

  const original = grid[0].map((c) => c.trim());
  const headers = original.map(normalizeHeader);

  const codeCol = pickColumn(headers, CODE_HEADERS, original);
  if (codeCol.index === null) {
    if (codeCol.candidates.length === 0) {
      return failed(
        'CSV_NO_CODE_COLUMN',
        `No procedure-code column. Expected one headed something like "Code", "CDT Code" or "Procedure Code"; the file has: ${original.join(', ')}`
      );
    }
    return failed(
      'CSV_AMBIGUOUS_COLUMNS',
      `More than one column could be the procedure code (${codeCol.candidates.join(', ')}). ` +
        'Rename or remove one so there is exactly one.'
    );
  }

  const feeCol = pickColumn(headers, FEE_HEADERS, original);
  if (feeCol.index === null) {
    if (feeCol.candidates.length === 0) {
      return failed(
        'CSV_NO_FEE_COLUMN',
        `No fee column. Expected one headed something like "Fee", "Amount" or "Allowed Amount"; the file has: ${original.join(', ')}`
      );
    }
    return failed(
      'CSV_AMBIGUOUS_COLUMNS',
      `More than one column could be the fee (${feeCol.candidates.join(', ')}). ` +
        'Rename or remove the ones you did not mean, so there is exactly one.'
    );
  }

  /** @type {FeeRow[]} */
  const rows = [];
  /** @type {Array<{code: string, message: string}>} */
  const fileWarnings = [];

  for (let i = 1; i < grid.length; i += 1) {
    const cells = grid[i];
    // Line number as the OFFICE counts them: the header is line 1. Reported so
    // a warning about a skipped row can be looked up in the file.
    const lineNumber = i + 1;
    const rawLine = cells.join(',');

    const rawCode = cells[codeCol.index];
    const rawFee = cells[feeCol.index];

    const code = normalizeProcCode(rawCode);
    if (code.value === null) {
      fileWarnings.push(
        warn(
          'row_skipped',
          `Line ${lineNumber} was skipped: ${code.warnings[0].message}`
        )
      );
      continue;
    }

    const fee = parseFeeCents(rawFee);
    if (fee.value === null) {
      fileWarnings.push(
        warn('row_skipped', `Line ${lineNumber} (${code.value}) was skipped: ${fee.warnings[0].message}`)
      );
      continue;
    }

    rows.push({
      procCode: code.value,
      feeCents: fee.value,
      rawLine,
      // The code's own warnings ride with the row (a stripped suffix is a fact
      // about THIS fee, not about the file). Amount warnings never reach here:
      // an amount that warned has no value, so the row was skipped above.
      warnings: code.warnings,
    });
  }

  if (rows.length === 0) {
    return failed(
      'NO_ROWS_PARSED',
      'No fees could be read out of the file. Every row was missing a procedure code or an amount.'
    );
  }

  return { ok: true, failureCode: null, failureReason: null, rows, warnings: fileWarnings };
}

module.exports = {
  parseCsvFeeSchedule,
  splitCsv,
  normalizeHeader,
  CODE_HEADERS,
  FEE_HEADERS,
};
