'use strict';

/**
 * The two value normalisers every fee-schedule parser runs on: a CDT procedure
 * code, and a money amount.
 *
 * PURE. Strings in, a result out. No I/O, no database, no Open Dental, no
 * clock. Both parsers (PDF and CSV) share these so a code read out of a PDF and
 * the same code read out of a CSV normalise identically — a difference between
 * the two lanes would show up as a phantom fee change when an office re-imported
 * the same schedule in the other format.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RESULT SHAPE
 * ─────────────────────────────────────────────────────────────────────────────
 * Every function returns `{ value, warnings }` rather than a bare value or a
 * throw. A fee schedule is a few hundred lines of somebody else's formatting;
 * roughly ten of them will be odd, and the odd ones are exactly what an office
 * needs to see. Throwing loses them; returning null silently loses WHY. So a
 * refusal comes back as `value: null` with at least one warning saying what was
 * wrong, and the caller decides whether that kills the row or the file.
 *
 * A warning is `{ code, message }`. `code` is a stable machine token the UI can
 * switch on; `message` is one sentence an office manager can read. Neither ever
 * carries anything but procedure codes, amounts and the file's own text.
 */

/**
 * A CDT code as Open Dental stores it: the letter D and exactly four digits.
 *
 * Open Dental's `procedurecode.ProcCode` is this shape, and it is what a later
 * slice has to match against. Anything else stored here would fail to join at
 * post time rather than at import time, which is the wrong end of the process
 * to discover it.
 */
const CDT_CODE = /^D\d{4}$/;

/**
 * A CDT code carrying a payer's own single-letter suffix — D2740A, D0150B.
 *
 * Payers use these to distinguish their own variants (in-network vs out, a
 * downgrade tier, an amendment). Open Dental has no such code, so the suffix
 * must come off before the fee can land anywhere — see `normalizeProcCode`,
 * which strips it AND says so.
 */
const CDT_CODE_SUFFIXED = /^D\d{4}[A-Z]$/;

/**
 * Scan a line for CDT codes.
 *
 * DELIBERATELY NARROWER THAN THE REFERENCE, which used `/\bD\d{4}[\w\d]?\b/g`.
 * `[\w\d]` is just `[\w]`, so that pattern also admitted a digit and an
 * underscore. Two consequences it did not intend:
 *
 *   - `D01201` matched as code `D0120` + suffix `1`, and the suffix stripper
 *     only removed `[A-Z]` — so the row was stored under `D01201`, a code
 *     Open Dental has never heard of.
 *   - A page footer reading `D2015_3` parsed as a procedure.
 *
 * Here the optional trailing character is a LETTER and nothing else, and the
 * `\b` that follows means a five-digit run does not match at all. A line
 * carrying one is reported as having no code, which is true.
 *
 * @type {RegExp}
 */
const CDT_IN_TEXT = /\bD\d{4}[A-Za-z]?\b/g;

/**
 * Scan a line for money amounts: an optional `$`, digits with optional
 * thousands grouping, and exactly two decimal places.
 *
 * Two decimals is the reference's rule and it is a good one — a fee schedule
 * prints cents, and requiring them is what stops a quantity column ("4"), a
 * tooth number ("14") or a year ("2026") being read as a fee. The cost is a
 * schedule that prints whole dollars as `45`, which is rare enough that
 * inventing a rule to catch it would misread more than it caught. A file like
 * that parses to zero rows and is refused with NO_ROWS_PARSED, which is honest.
 *
 * @type {RegExp}
 */
const MONEY_IN_TEXT = /\$?\s?-?\d[\d,]*\.\d{2}\b/g;

/**
 * The largest amount admitted, in cents: $20,000,000.00. See `parseFeeCents`.
 */
const MAX_FEE_CENTS = 2000000000;

/** Well-formed thousands grouping: 1234.00, 1,234.00, 12,345,678.90. */
const GROUPED_AMOUNT = /^(?:\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})$/;

/** @typedef {{ code: string, message: string }} ParseWarning */
/** @typedef {{ value: string|null, warnings: ParseWarning[] }} CodeResult */
/** @typedef {{ value: number|null, warnings: ParseWarning[] }} CentsResult */

/**
 * @param {string} code
 * @param {string} message
 * @returns {ParseWarning}
 */
function warn(code, message) {
  return { code, message };
}

/**
 * Normalise a procedure code to the shape Open Dental stores.
 *
 * Upper-cases and trims, accepts `D` + four digits, and strips a single
 * trailing letter — WITH A WARNING, never silently. The reference stripped it
 * silently, and that matters more than it looks: `D2740A` and `D2740B` are a
 * payer's two different rates for the same procedure, and collapsing both to
 * `D2740` turns two rows into a duplicate whose winner is whichever the parser
 * happened to reach first. Flagging it is what lets an office see that the file
 * said something the importer had to reinterpret.
 *
 * @param {unknown} raw
 * @returns {CodeResult}
 */
function normalizeProcCode(raw) {
  /** @type {ParseWarning[]} */
  const warnings = [];
  if (typeof raw !== 'string') {
    return { value: null, warnings: [warn('invalid_proc_code', 'No procedure code found.')] };
  }

  const cleaned = raw.trim().toUpperCase();
  if (cleaned === '') {
    return { value: null, warnings: [warn('invalid_proc_code', 'No procedure code found.')] };
  }

  if (CDT_CODE.test(cleaned)) return { value: cleaned, warnings };

  if (CDT_CODE_SUFFIXED.test(cleaned)) {
    const base = cleaned.slice(0, 5);
    warnings.push(
      warn(
        'suffix_stripped',
        `The file says ${cleaned}; Open Dental has no such code, so this was read as ${base}. ` +
          'Check that it is the rate you meant — a payer uses these suffixes for different tiers of the same procedure.'
      )
    );
    return { value: base, warnings };
  }

  return {
    value: null,
    warnings: [
      warn('invalid_proc_code', `"${cleaned}" is not a CDT procedure code (expected D and four digits).`),
    ],
  };
}

/**
 * Parse a money amount into INTEGER CENTS.
 *
 * Never floating point. The reference did `parseFloat(str.replace(',', ''))`,
 * which carries two defects this function exists to not have:
 *
 *  1. `String.replace` with a string argument replaces only the FIRST match.
 *     `"1,234,567.00"` became `"1234,567.00"`, and `parseFloat` stops at the
 *     first character it cannot read — so the value silently became `1234`.
 *     A six-figure amount lost three orders of magnitude with no error, no
 *     warning, and a plausible-looking number left in its place.
 *  2. Dollars as a float. `18.20` is not representable in binary; multiply a
 *     few of them and compare for equality, which is exactly what reconciling
 *     an allowed amount against a contracted one does, and they stop matching.
 *
 * Cents are computed from the digit STRING — `whole * 100 + frac` — so no
 * float is ever constructed, not even transiently.
 *
 * MALFORMED GROUPING IS REFUSED, NOT TRUNCATED. `"1,23.00"` is not a number any
 * fee schedule prints; it is the parser having captured a column boundary. The
 * reference would have turned it into 123.00. Here it is a warning and a null.
 *
 * ZERO IS A VALUE. `$0.00` in a fee schedule means not covered, bundled, or no
 * fee — a fact the office needs. The reference discarded every one of them with
 * a `feeAmount > 0` guard. Negative is refused: a fee schedule has no concept
 * of one, so a minus sign means the parser read an adjustment column.
 *
 * @param {unknown} raw
 * @returns {CentsResult}
 */
function parseFeeCents(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { value: null, warnings: [warn('missing_amount', 'No fee amount found.')] };
  }

  // Strip the currency symbol, spaces (including the non-breaking space a PDF
  // export leaves between `$` and the digits), and any wrapping.
  const cleaned = String(raw).replace(/[$\s ]/g, '').trim();
  if (cleaned === '') {
    return { value: null, warnings: [warn('missing_amount', 'No fee amount found.')] };
  }

  // Accounting parentheses mean a negative, and a negative is refused below
  // rather than quietly read as its absolute value.
  /*
   * A CELL THAT IS A MEASUREMENT, not a fee — the CSV lane's half of the D74xx
   * defect. `1.25 cm` in a fee column already failed to parse, but it failed as
   * "could not be read as a dollar amount", which tells an office nothing about
   * why. Naming it means somebody can see they pointed the importer at a size
   * column.
   *
   * Only when the cell yields NO fee-shaped token at all: a cell holding a real
   * amount is never diverted here, whatever else is written beside it.
   */
  const scan = scanAmounts(String(raw));
  if (scan.amounts.length === 0 && scan.measurements.length > 0) {
    return {
      value: null,
      warnings: [
        warn(
          'measurement_not_a_fee',
          `"${String(raw).trim()}" is a measurement, not a fee. It was not read as one.`
        ),
      ],
    };
  }

  const negated = /^\((.*)\)$/.test(cleaned);
  const unwrapped = negated ? cleaned.slice(1, -1) : cleaned;
  const isNegative = negated || unwrapped.startsWith('-');
  const digits = unwrapped.replace(/^-/, '');

  const match = GROUPED_AMOUNT.exec(digits);
  if (!match) {
    if (/^[\d,]*\.\d{2}$/.test(digits)) {
      return {
        value: null,
        warnings: [
          warn(
            'malformed_amount',
            `"${String(raw).trim()}" is not a well-formed amount — its thousands separators do not group in threes. ` +
              'It was not read as a fee.'
          ),
        ],
      };
    }
    return {
      value: null,
      warnings: [
        warn('unparseable_amount', `"${String(raw).trim()}" could not be read as a dollar amount.`),
      ],
    };
  }

  if (isNegative) {
    return {
      value: null,
      warnings: [
        warn(
          'negative_amount',
          `"${String(raw).trim()}" is negative. A fee schedule has no negative fees, so this line was probably an adjustment column.`
        ),
      ],
    };
  }

  const [whole, frac] = digits.replace(/,/g, '').split('.');
  const cents = Number(whole) * 100 + Number(frac);

  // A fee this large is a parser error, not a crown. The column is an `integer`,
  // which tops out at 2,147,483,647 cents ($21,474,836.47), so the ceiling is
  // set just below it — refusing here is what stops the INSERT throwing, which
  // would be a 500 where a warning belongs. $20m is four orders of magnitude
  // past the most expensive procedure any schedule lists, so nothing real is
  // caught by it.
  if (!Number.isSafeInteger(cents) || cents > MAX_FEE_CENTS) {
    return {
      value: null,
      warnings: [
        warn(
          'implausible_amount',
          `"${String(raw).trim()}" is larger than any real fee; it was not read as one.`
        ),
      ],
    };
  }

  return { value: cents, warnings: [] };
}

/**
 * Every CDT code appearing in a line, in source order, de-duplicated.
 * @param {string} line
 * @returns {string[]}
 */
function findProcCodes(line) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const m of String(line).matchAll(CDT_IN_TEXT)) {
    const token = m[0].toUpperCase();
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Every money-shaped token in a line, in source order. NOT de-duplicated — a
 * row printing the same amount in two columns is a genuinely ambiguous row and
 * collapsing them would hide that.
 * @param {string} line
 * @returns {string[]}
 */
const MEASUREMENT_UNIT = /^ ?(?:cm|mm)\b/i;

/**
 * Split a line's money-shaped tokens into fees and measurements.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY MEASUREMENTS HAD TO BE SEPARATED OUT
 * ═════════════════════════════════════════════════════════════════════════════
 * The D74xx surgical family prints its size thresholds in the description:
 *
 *     D7410  excision of benign lesion up to 1.25 cm ...  285.00
 *
 * `1.25` is money-shaped — digits, a point, two decimals — so the scanner read
 * it, found two amounts on the line, flagged the row ambiguous and took the
 * FIRST. The office was offered $1.25 as the fee for a surgical excision, under
 * a warning that said the line was ambiguous rather than that the number was a
 * lesion diameter.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONLY `cm` AND `mm`, AND ONLY IMMEDIATELY AFTER
 * ═════════════════════════════════════════════════════════════════════════════
 * Deliberately the narrowest rule that covers the observed defect:
 *
 *  - TWO UNITS. `%` is not here: a schedule really does print "80%" beside a
 *    fee, and a percentage is not money-shaped anyway (no two decimals), so
 *    adding it would be inventing a rule for a case nobody has hit. `x` is not
 *    here either — "2 x 285.00" means the fee twice over, not a dimension.
 *  - AT MOST ONE SPACE. The gap between two columns in a PDF text layer is
 *    several spaces, so one space is what keeps a real fee in one column from
 *    being discarded because the next column happens to begin with "cm".
 *  - WORD-BOUNDED. "1.25 cmx" is not a measurement. A unit is a whole word.
 *
 * ONE SCANNER, so `findAmounts` and `findMeasurements` cannot disagree about
 * which bucket a token fell into — and so a caller explaining why a line
 * yielded no fee is looking at the same decision the caller that read the fee
 * made.
 *
 * @param {string} line
 * @returns {{ amounts: string[], measurements: string[] }}
 */
function scanAmounts(line) {
  const text = String(line);
  /** @type {string[]} */
  const amounts = [];
  /** @type {string[]} */
  const measurements = [];
  for (const m of text.matchAll(MONEY_IN_TEXT)) {
    // What FOLLOWS the token decides which it is. `m.index + m[0].length` is
    // the character after the match, so "1.25 cm" is caught and "1.25  cm" —
    // two spaces, i.e. the next column — is not.
    const after = text.slice(m.index + m[0].length);
    (MEASUREMENT_UNIT.test(after) ? measurements : amounts).push(m[0].trim());
  }
  return { amounts, measurements };
}

function findAmounts(line) {
  return scanAmounts(line).amounts;
}

/**
 * The tokens on this line that are MEASUREMENTS rather than fees.
 *
 * Exists so a caller can tell "this line has no fee on it" from "this line's
 * only number was a lesion diameter". The first is most of a PDF and is skipped
 * in silence; the second is a line the parser deliberately declined to read a
 * fee from, and saying nothing about it would be exactly the silent
 * interpretation this module exists to not make.
 *
 * @param {string} line
 * @returns {string[]}
 */
function findMeasurements(line) {
  return scanAmounts(line).measurements;
}

/** Format cents back to `$1,234.00`, for warning text an office reads. */
function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

module.exports = {
  MAX_FEE_CENTS,
  CDT_CODE,
  CDT_CODE_SUFFIXED,
  CDT_IN_TEXT,
  MONEY_IN_TEXT,
  normalizeProcCode,
  parseFeeCents,
  findProcCodes,
  findAmounts,
  findMeasurements,
  MEASUREMENT_UNIT,
  formatCents,
  warn,
};
