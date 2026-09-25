'use strict';

/**
 * The one entry point the route calls: bytes + a declared source type in, a
 * parse result out.
 *
 * Everything the route needs to know about parsing is here, so routes/fees
 * imports this and nothing else from services/fees. That is what keeps the
 * "no Open Dental in this module" guard checkable by reading one import list.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE DUPLICATE FLAGGING RUNS HERE RATHER THAN IN EACH PARSER
 * ─────────────────────────────────────────────────────────────────────────────
 * A code listed twice at two fees is the same problem whether it came out of a
 * PDF or a CSV, and the parser that forgot to check would be the one whose
 * lane quietly regressed. Running it once, after the lane-specific work, means
 * the two lanes cannot disagree about what a duplicate is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SOURCE TYPE IS DECLARED, NOT SNIFFED — AND THEN VERIFIED
 * ─────────────────────────────────────────────────────────────────────────────
 * The caller says which lane it wants (from the upload's filename and content
 * type), and for `pdf` this function then checks the magic bytes and REFUSES a
 * mismatch. Both halves matter:
 *
 *   - Sniffing alone would mean a CSV whose first cell happened to read `%PDF`
 *     chose its own lane. The declared type is what the office asked for.
 *   - Trusting the declaration alone would mean a CSV renamed `.pdf` reached
 *     pdf-parse, which fails with a message about the container rather than
 *     about the file being the wrong kind. `WRONG_FILE_TYPE` says the useful
 *     thing.
 *
 * There is no magic-byte check for CSV because a CSV has none. A PDF sent as
 * `.csv` decodes to mojibake, matches no header vocabulary, and is refused by
 * the CSV lane as CSV_NO_CODE_COLUMN — which names the headers it did find, so
 * the mistake is visible.
 */

const { parseCsvFeeSchedule } = require('./csvFeeSchedule');
const { extractPdfText, parsePdfFeeScheduleText, flagDuplicates } = require('./pdfFeeSchedule');

/**
 * The source types this module admits.
 *
 * Asserted against the migration's own list by feeSchedule.test.js, because the
 * CHECK constraint is what actually decides what can be stored and this array is
 * only what decides what gets attempted.
 */
const SOURCE_TYPES = Object.freeze(['pdf', 'csv']);

/** `%PDF-` — the only four bytes every PDF in existence starts with. */
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/**
 * @typedef {object} FeeRow
 * @property {string} procCode  D + four digits
 * @property {number} feeCents  integer cents, >= 0
 * @property {string} rawLine   the source line, verbatim
 * @property {Array<{code: string, message: string}>} warnings
 */

/**
 * @typedef {object} ParseResult
 * @property {boolean} ok
 * @property {string|null} failureCode
 * @property {string|null} failureReason
 * @property {FeeRow[]} rows
 * @property {Array<{code: string, message: string}>} warnings file-level
 * @property {number} warningCount every warning anywhere in the parse
 */

/** @param {string} code @param {string} reason @returns {ParseResult} */
function failed(code, reason) {
  return {
    ok: false,
    failureCode: code,
    failureReason: reason,
    rows: [],
    warnings: [],
    warningCount: 0,
  };
}

/**
 * Total warnings raised by a parse: the file's own plus every row's.
 *
 * ONE number, computed in ONE place, so the count stored on the batch cannot
 * disagree with what the detail page renders. Counting file warnings only —
 * which is what a `warnings.length` at the route would have done — would report
 * 0 for the case that matters most: a clean-looking file where forty individual
 * rows each carry an ambiguous-amount flag.
 *
 * @param {{ rows: FeeRow[], warnings: Array }} result
 * @returns {number}
 */
function countWarnings(result) {
  return result.warnings.length + result.rows.reduce((n, r) => n + r.warnings.length, 0);
}

/**
 * Parse an uploaded fee schedule.
 *
 * @param {object} input
 * @param {Buffer} input.bytes      the uploaded file, in memory — never a path
 * @param {string} input.sourceType 'pdf' | 'csv'
 * @returns {Promise<ParseResult>}
 */
async function parseFeeSchedule({ bytes, sourceType }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return failed('FILE_EMPTY', 'The file is empty.');
  }
  if (!SOURCE_TYPES.includes(sourceType)) {
    return failed(
      'UNSUPPORTED_SOURCE_TYPE',
      `${JSON.stringify(sourceType)} is not a fee schedule format. Upload a PDF or a CSV.`
    );
  }

  /** @type {{ ok: boolean, failureCode: string|null, failureReason: string|null, rows: FeeRow[], warnings: Array }} */
  let result;

  if (sourceType === 'pdf') {
    if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      return failed(
        'WRONG_FILE_TYPE',
        'That file is named like a PDF but does not start with %PDF-. Check you uploaded the right file.'
      );
    }
    const extracted = await extractPdfText(bytes);
    if (!extracted.ok) {
      return failed(extracted.failureCode, extracted.failureReason);
    }
    result = parsePdfFeeScheduleText(extracted.text);
  } else {
    // 'utf8' with a BOM stripped inside the CSV parser. A Windows-1252 file
    // decodes with replacement characters in its DESCRIPTION column, which
    // nothing here reads — the code and fee columns are ASCII in every format a
    // payer publishes.
    result = parseCsvFeeSchedule(bytes.toString('utf8'));
  }

  if (!result.ok) {
    return failed(result.failureCode, result.failureReason);
  }

  // One rule, both lanes. See the header.
  flagDuplicates(result.rows);

  return {
    ok: true,
    failureCode: null,
    failureReason: null,
    rows: result.rows,
    warnings: result.warnings,
    warningCount: countWarnings(result),
  };
}

/**
 * The source type implied by a filename, or null.
 *
 * Extension only. A browser's `Content-Type` for a `.csv` is variously
 * `text/csv`, `application/vnd.ms-excel` and `application/octet-stream`
 * depending on whether Excel is installed, so it is not a usable signal — the
 * same reason routes/rcm/era.js gives for ignoring it there.
 *
 * @param {unknown} filename
 * @returns {'pdf'|'csv'|null}
 */
function sourceTypeFromFilename(filename) {
  if (typeof filename !== 'string') return null;
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!ext) return null;
  if (ext[1] === 'pdf') return 'pdf';
  if (ext[1] === 'csv') return 'csv';
  return null;
}

module.exports = { parseFeeSchedule, sourceTypeFromFilename, countWarnings, SOURCE_TYPES };
