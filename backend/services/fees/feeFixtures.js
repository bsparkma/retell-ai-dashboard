'use strict';

/**
 * SYNTHETIC fee schedule fixtures.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY BYTE HERE WAS WRITTEN BY HAND. NOTHING WAS COPIED FROM A PAYER FILE.
 * ═════════════════════════════════════════════════════════════════════════════
 * The reference implementation at `RCM Project v2/fee-schedule-importer` ships
 * real payer PDFs in `uploads/`. None of them are in this repo and none of them
 * should be: they are executed contract documents, they are not ours to
 * redistribute, and a repo that contains one grows a habit of containing more.
 *
 * The CDT codes below are real published CDT nomenclature, which is public.
 * The FEES are invented round numbers that resemble no payer's schedule. There
 * is no patient name, no subscriber id, no group number and no carrier name
 * anywhere in this file — the payers are `NORTHSTAR DENTAL` and `MERIDIAN
 * BENEFIT`, which do not exist.
 *
 * Each fixture is named for the ONE parser behaviour it exists to pin, so a
 * test that goes red says which rule broke.
 */

/**
 * A minimal, VALID PDF whose text layer is `lines`, one per text-showing
 * operator.
 *
 * Built by hand rather than committed as a binary so no blob enters the repo
 * and so a test can state in one line exactly what the extractor will see —
 * the same argument rcmTestUtils.syntheticPdf makes, extended to multiple
 * lines. Each line gets its own `Td` offset, which is what makes pdf.js emit
 * them as separate lines rather than one run.
 *
 * Parentheses and backslashes are escaped because they delimit a PDF string
 * literal; an unescaped `(` in a fee description produces a corrupt file that
 * fails to open, which would look like a parser bug.
 *
 * @param {string[]} lines
 * @returns {Buffer}
 */
function syntheticFeePdf(lines) {
  const esc = (s) => String(s).replace(/([\\()])/g, '\\$1');
  const stream = [
    'BT',
    '/F1 10 Tf',
    '12 TL',
    '40 750 Td',
    ...lines.map((line) => `(${esc(line)}) Tj T*`),
    'ET',
  ].join('\n');

  const body =
    '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]' +
    '/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n' +
    '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
    `5 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n` +
    'trailer<</Root 1 0 R>>\n';
  return Buffer.from(body, 'latin1');
}

/**
 * The clean baseline: one code, one amount, one row each. What most of a real
 * schedule looks like.
 */
const PDF_CLEAN = [
  'NORTHSTAR DENTAL - PARTICIPATING PROVIDER FEE SCHEDULE',
  'Effective January 1, 2027',
  '',
  'Code    Description                                 Fee',
  'D0120   Periodic oral evaluation                    45.00',
  'D0150   Comprehensive oral evaluation               85.00',
  'D0210   Intraoral - complete series                 130.00',
  'D1110   Prophylaxis - adult                         92.00',
  'D2740   Crown - porcelain/ceramic                   1,150.00',
  'D4341   Periodontal scaling - four or more teeth    245.00',
];

/**
 * A MULTI-COLUMN table — the shape that made the reference import the wrong
 * tier. Three rate columns per row; the parser takes the first and flags it.
 */
const PDF_MULTI_COLUMN = [
  'MERIDIAN BENEFIT - FEE SCHEDULE BY NETWORK TIER',
  '',
  'Code    Description                  Tier1      Tier2      Tier3',
  'D2740   Crown - porcelain/ceramic    1,150.00   920.00     805.00',
  'D2750   Crown - porcelain to metal   1,090.00   872.00     763.00',
];

/**
 * MEASUREMENT UNITS IN THE DESCRIPTION — the D74xx surgical family.
 *
 * Every one of these lines carries a size threshold that is money-shaped:
 * `1.25` is digits, a point and two decimals, exactly like a fee. Before the
 * unit filter the scanner found two amounts on each line, flagged the row
 * ambiguous and took the FIRST — offering the office $1.25 for a surgical
 * excision.
 *
 * Three spellings on purpose, because the filter has to hold for all of them:
 * a space before the unit, none, and upper case. The last line is the one that
 * matters most for the empty-set rule — its ONLY number is the measurement, so
 * the filter leaves nothing behind and the line must say so rather than being
 * dropped in silence.
 */
const PDF_LESION_UNITS = [
  'SOUTHVALE ORAL SURGERY - EXCISIONS',
  '',
  'Code    Description                                          Fee',
  'D7410   Excision of benign lesion up to 1.25 cm              285.00',
  'D7411   Excision of benign lesion greater than 1.25cm        395.00',
  'D7412   Excision of benign lesion, complicated, to 1.25 CM   470.00',
  'D7413   Excision of malignant lesion up to 1.25 cm',
];

/**
 * A GENUINE $1.25 FEE, with no unit after it.
 *
 * The control for the fixture above: the filter must key on the UNIT and not on
 * the number. A per-unit nitrous charge really is $1.25, and a rule that
 * discarded small amounts would silently drop it.
 */
const PDF_SMALL_REAL_FEE = [
  'SOUTHVALE - ANCILLARY',
  '',
  'D9230   Nitrous oxide, per unit                    1.25',
  'D9944   Occlusal guard, hard, full arch          450.00',
];

/**
 * SEVERAL CODES ON ONE LINE — the reference wrote the line's single amount
 * against every one of them. Here it yields no rows and one file warning.
 */
const PDF_MULTIPLE_CODES = [
  'NORTHSTAR DENTAL - RADIOGRAPHS',
  '',
  'D0210 D0220 D0230 Radiographs, bundled            145.00',
  'D1110   Prophylaxis - adult                        92.00',
];

/** A code on one line and its fee on the next — the narrowed cross-line pair. */
const PDF_WRAPPED = [
  'NORTHSTAR DENTAL - SURGICAL',
  '',
  'D7210   Extraction, erupted tooth requiring removal of bone',
  '        315.00',
  'D7240   Removal of impacted tooth - completely bony',
  '        485.00',
];

/**
 * THE SAME CODE TWICE AT TWO FEES — a base page and an amendment page. The
 * reference kept the first silently.
 */
const PDF_DUPLICATE_CODES = [
  'MERIDIAN BENEFIT - FEE SCHEDULE',
  '',
  'D2740   Crown - porcelain/ceramic                  1,150.00',
  'D1110   Prophylaxis - adult                           92.00',
  '',
  'AMENDMENT - EFFECTIVE JULY 1',
  'D2740   Crown - porcelain/ceramic                  1,275.00',
];

/**
 * A six-figure amount and a $0.00 line. The first is what
 * `replace(',', '')` truncated to $1,234; the second is what `> 0` discarded.
 */
const PDF_EDGE_AMOUNTS = [
  'MERIDIAN BENEFIT - SPECIALTY',
  '',
  'D5911   Facial moulage, sectional                  1,234,567.00',
  'D9986   Missed appointment                                0.00',
  'D1110   Prophylaxis - adult                              92.00',
];

/** Text, but not a fee schedule. Parses to nothing and says so. */
const PDF_NOT_A_SCHEDULE = [
  'NORTHSTAR DENTAL',
  'Provider Newsletter, Fourth Quarter',
  '',
  'Our claims address has changed. Please update your records.',
  'Remittance advice is now available in the provider portal.',
];

/** The CSV baseline. `Fee` is the only fee-ish header. */
const CSV_CLEAN = [
  'Code,Description,Fee',
  'D0120,Periodic oral evaluation,45.00',
  'D0150,Comprehensive oral evaluation,85.00',
  'D1110,Prophylaxis - adult,92.00',
  'D2740,"Crown - porcelain/ceramic, single unit","1,150.00"',
  'D4341,Periodontal scaling,245.00',
].join('\n');

/**
 * THREE fee-ish columns. The reference took whichever came LAST in key order,
 * so inserting a column changed which rate was imported. Refused here.
 */
const CSV_AMBIGUOUS_FEE = [
  'Code,Description,UCR Fee,Allowed Amount,Contracted Fee',
  'D2740,Crown,1400.00,1150.00,920.00',
  'D1110,Prophylaxis,110.00,92.00,74.00',
].join('\n');

/**
 * `Zip Code` also contains "code". The reference's substring match took it as
 * the procedure code column and every row was silently discarded.
 */
const CSV_DECOY_CODE_COLUMN = [
  'Provider Zip Code,Procedure Code,Fee',
  '72901,D0120,45.00',
  '72901,D1110,92.00',
].join('\n');

/** No column that could be a fee at all. */
const CSV_NO_FEE_COLUMN = [
  'Code,Description,Effective Date',
  'D0120,Periodic oral evaluation,2027-01-01',
].join('\n');

/** Mixed validity: a suffixed code, a blank fee, a header-only decoy row. */
const CSV_MESSY = [
  'CDT Code,Description,Allowed Amount',
  'D2740A,Crown - porcelain (in network),1150.00',
  'D1110,Prophylaxis - adult,92.00',
  'TOTAL,Sum of the above,1242.00',
  'D0120,Periodic oral evaluation,',
  'D9986,Missed appointment,0.00',
].join('\n');

/** Excel's UTF-8 BOM in front of the first header. */
const CSV_WITH_BOM = '﻿' + CSV_CLEAN;

module.exports = {
  syntheticFeePdf,
  PDF_CLEAN,
  PDF_MULTI_COLUMN,
  PDF_LESION_UNITS,
  PDF_SMALL_REAL_FEE,
  PDF_MULTIPLE_CODES,
  PDF_WRAPPED,
  PDF_DUPLICATE_CODES,
  PDF_EDGE_AMOUNTS,
  PDF_NOT_A_SCHEDULE,
  CSV_CLEAN,
  CSV_AMBIGUOUS_FEE,
  CSV_DECOY_CODE_COLUMN,
  CSV_NO_FEE_COLUMN,
  CSV_MESSY,
  CSV_WITH_BOM,
};
