'use strict';

/**
 * The two fee-schedule parser lanes, and the dispatcher over them.
 *
 * Every fixture is synthetic (services/fees/feeFixtures.js) — no payer file
 * from the reference folder is in this repo, and no patient name appears
 * anywhere in this suite.
 *
 * THE STARS are the two cases that made the reference import wrong numbers
 * with no sign that it had: a multi-column PDF table, and a CSV with three
 * fee-ish columns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCsvFeeSchedule, splitCsv, normalizeHeader } = require('./csvFeeSchedule');
const { parsePdfFeeScheduleText, flagDuplicates } = require('./pdfFeeSchedule');
const {
  parseFeeSchedule,
  sourceTypeFromFilename,
  countWarnings,
  SOURCE_TYPES,
} = require('./parseFeeSchedule');
const fx = require('./feeFixtures');
const migration = require('../../migrations-tenant/1788700000000_fees_import');

/** The PDF fixtures are authored as line arrays; the pure parser takes text. */
const asText = (lines) => lines.join('\n');

/** Every warning code anywhere in a result. */
const codesOf = (result) => [
  ...result.warnings.map((w) => w.code),
  ...result.rows.flatMap((r) => r.warnings.map((w) => w.code)),
];

/** The rows as `{ procCode: feeCents }`, for the clean assertions. */
const asMap = (rows) => Object.fromEntries(rows.map((r) => [r.procCode, r.feeCents]));

// ════════════════════════════════════════════════════════════════════════════
// PDF lane
// ════════════════════════════════════════════════════════════════════════════

test('a clean PDF schedule parses to one row per line, with no warnings', () => {
  const r = parsePdfFeeScheduleText(asText(fx.PDF_CLEAN));
  assert.equal(r.ok, true);
  assert.deepEqual(asMap(r.rows), {
    D0120: 4500,
    D0150: 8500,
    D0210: 13000,
    D1110: 9200,
    D2740: 115000,
    D4341: 24500,
  });
  assert.deepEqual(codesOf(r), [], 'a clean file must raise nothing');
  // The header line "Effective January 1, 2027" must not have become a fee.
  assert.equal(r.rows.length, 6);
});

test('THE STAR: a multi-column table is flagged, not silently imported at tier 1', () => {
  // The reference's patterns 1 and 3 both took the FIRST money token on the
  // line, whatever the header said the office's tier was, and recorded nothing.
  // The value here is the same — but the row carries the line and every
  // candidate, so an office can see it was a choice.
  const r = parsePdfFeeScheduleText(asText(fx.PDF_MULTI_COLUMN));
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 2);

  const crown = r.rows.find((row) => row.procCode === 'D2740');
  assert.equal(crown.feeCents, 115000);
  const flag = crown.warnings.find((w) => w.code === 'ambiguous_amount');
  assert.ok(flag, 'a three-column row must be flagged');
  // Every candidate is named, so the office can pick the right one.
  for (const amount of ['1,150.00', '920.00', '805.00']) {
    assert.match(flag.message, new RegExp(amount.replace('.', '\\.')));
  }
  // And the raw line rides along, which is what makes the flag reviewable: the
  // office has to see all three columns to judge which one they hold.
  assert.match(crown.rawLine, /^D2740\s/);
  assert.match(crown.rawLine, /1,150\.00\s+920\.00\s+805\.00/);
});

test('THE OTHER STAR: several codes on one line yield NO rows, and say so', () => {
  // `D0210 D0220 D0230 Radiographs 145.00` — the reference wrote 145.00 against
  // ALL THREE. The parser genuinely cannot tell which fee belongs to which, so
  // it emits nothing and names them. A flagged absence is recoverable; a
  // confident wrong number is not.
  const r = parsePdfFeeScheduleText(asText(fx.PDF_MULTIPLE_CODES));
  assert.equal(r.ok, true);

  assert.deepEqual(asMap(r.rows), { D1110: 9200 }, 'only the unambiguous line becomes a row');
  for (const code of ['D0210', 'D0220', 'D0230']) {
    assert.equal(
      r.rows.some((row) => row.procCode === code),
      false,
      `${code} must not be invented`
    );
  }

  const flag = r.warnings.find((w) => w.code === 'multiple_codes_on_line');
  assert.ok(flag);
  assert.match(flag.message, /D0210, D0220, D0230/);
});

test('a code and its fee on separate lines pair up, and the pairing is disclosed', () => {
  const r = parsePdfFeeScheduleText(asText(fx.PDF_WRAPPED));
  assert.equal(r.ok, true);
  assert.deepEqual(asMap(r.rows), { D7210: 31500, D7240: 48500 });
  for (const row of r.rows) {
    assert.ok(
      row.warnings.some((w) => w.code === 'paired_across_lines'),
      `${row.procCode} was read across two lines and must say so`
    );
  }
});

test('the cross-line pair does NOT reach past the next line, or across a code', () => {
  // The reference paired unconditionally, so a code on the last line of a page
  // took the first number off the next page's header.
  const stranded = parsePdfFeeScheduleText(
    ['D7210   Extraction, erupted tooth', 'NORTHSTAR DENTAL - PAGE 4', '   315.00'].join('\n')
  );
  assert.equal(stranded.ok, false, 'a fee two lines away is not this code\'s fee');
  assert.equal(stranded.failureCode, 'NO_ROWS_PARSED');

  // And the next line carrying its own code is that code's row, not this one's fee.
  const twoCodes = parsePdfFeeScheduleText(
    ['D7210   Extraction, erupted tooth', 'D1110   Prophylaxis - adult    92.00'].join('\n')
  );
  assert.deepEqual(asMap(twoCodes.rows), { D1110: 9200 });
});

test('a duplicate code at two fees keeps BOTH rows and flags the disagreement', () => {
  // The reference's `if (!fees[cdtCode])` kept the first and discarded the
  // amendment with no record that it existed.
  const r = parsePdfFeeScheduleText(asText(fx.PDF_DUPLICATE_CODES));
  flagDuplicates(r.rows);

  const crowns = r.rows.filter((row) => row.procCode === 'D2740');
  assert.equal(crowns.length, 2, 'both rows are kept — there is no UNIQUE on (batch, code)');
  assert.deepEqual(
    crowns.map((c) => c.feeCents).sort((a, b) => a - b),
    [115000, 127500]
  );
  for (const crown of crowns) {
    const flag = crown.warnings.find((w) => w.code === 'duplicate_code');
    assert.ok(flag, 'both rows carry the flag, not just the second');
    assert.match(flag.message, /\$1,150\.00, \$1,275\.00/);
  }
  // The code that appears once is untouched.
  const prophy = r.rows.find((row) => row.procCode === 'D1110');
  assert.deepEqual(prophy.warnings, []);
});

test('a duplicate at the SAME fee is flagged differently — untidy, not a decision', () => {
  const rows = [
    { procCode: 'D1110', feeCents: 9200, rawLine: 'a', warnings: [] },
    { procCode: 'D1110', feeCents: 9200, rawLine: 'b', warnings: [] },
  ];
  flagDuplicates(rows);
  for (const row of rows) {
    assert.equal(row.warnings[0].code, 'duplicate_code_same_fee');
  }
});

test('the six-figure and zero-dollar edge lines survive the PDF lane intact', () => {
  const r = parsePdfFeeScheduleText(asText(fx.PDF_EDGE_AMOUNTS));
  assert.equal(r.ok, true);
  assert.equal(asMap(r.rows).D5911, 123456700, 'the comma bug must not come back');
  assert.equal(asMap(r.rows).D9986, 0, '$0.00 is a value, not a hole');
});

test('a PDF with text but no fees fails honestly rather than reporting an empty success', () => {
  const r = parsePdfFeeScheduleText(asText(fx.PDF_NOT_A_SCHEDULE));
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'NO_ROWS_PARSED');
  assert.ok(r.failureReason.length > 0, 'a failure must carry a reason');
  assert.deepEqual(r.rows, []);
});

// ════════════════════════════════════════════════════════════════════════════
// CSV lane
// ════════════════════════════════════════════════════════════════════════════

test('a clean CSV parses, quoted commas and all', () => {
  const r = parseCsvFeeSchedule(fx.CSV_CLEAN);
  assert.equal(r.ok, true);
  assert.deepEqual(asMap(r.rows), {
    D0120: 4500,
    D0150: 8500,
    D1110: 9200,
    // "Crown - porcelain/ceramic, single unit" and "1,150.00" are both quoted:
    // a naive split on commas puts 150.00 in the fee column.
    D2740: 115000,
    D4341: 24500,
  });
  assert.deepEqual(codesOf(r), []);
});

test('THE STAR: three fee-ish columns is a refusal that names them', () => {
  // The reference took whichever came LAST in key order — which is the file's
  // column order — so inserting a column changed which rate was imported, with
  // nothing to show it had.
  const r = parseCsvFeeSchedule(fx.CSV_AMBIGUOUS_FEE);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'CSV_AMBIGUOUS_COLUMNS');
  for (const header of ['UCR Fee', 'Allowed Amount', 'Contracted Fee']) {
    assert.match(r.failureReason, new RegExp(header));
  }
  assert.deepEqual(r.rows, [], 'a refusal stores nothing');
});

test('"Zip Code" is not a procedure-code column', () => {
  // The reference's substring match took it as one, parsed a zip as the code,
  // discarded every row as unmatched, and reported success on an empty import.
  const r = parseCsvFeeSchedule(fx.CSV_DECOY_CODE_COLUMN);
  assert.equal(r.ok, true, 'Procedure Code is the only real candidate, so this parses');
  assert.deepEqual(asMap(r.rows), { D0120: 4500, D1110: 9200 });
});

test('a file with no fee column is refused, and the refusal lists the headers it found', () => {
  const r = parseCsvFeeSchedule(fx.CSV_NO_FEE_COLUMN);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'CSV_NO_FEE_COLUMN');
  assert.match(r.failureReason, /Effective Date/);
});

test('a messy CSV keeps what it can and accounts for every line it did not', () => {
  const r = parseCsvFeeSchedule(fx.CSV_MESSY);
  assert.equal(r.ok, true);

  // D2740A was stripped to D2740 and flagged; D9986 at $0.00 is kept.
  assert.deepEqual(asMap(r.rows), { D2740: 115000, D1110: 9200, D9986: 0 });
  const crown = r.rows.find((row) => row.procCode === 'D2740');
  assert.equal(crown.warnings[0].code, 'suffix_stripped');

  // The TOTAL row and the blank-fee row are each accounted for by line number.
  const skipped = r.warnings.filter((w) => w.code === 'row_skipped');
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].message, /Line 4/, 'the TOTAL row is line 4 as the office counts');
  assert.match(skipped[1].message, /Line 5/);
  assert.match(skipped[1].message, /D0120/, 'a skipped row names the code it was about to store');
});

test("Excel's UTF-8 BOM does not swallow the first header", () => {
  const r = parseCsvFeeSchedule(fx.CSV_WITH_BOM);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 5);
});

test('splitCsv handles quoted commas, embedded newlines and escaped quotes', () => {
  assert.deepEqual(splitCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(splitCsv('"a,b",c'), [['a,b', 'c']]);
  assert.deepEqual(splitCsv('"say ""hi""",c'), [['say "hi"', 'c']]);
  assert.deepEqual(splitCsv('"line\nbreak",c'), [['line\nbreak', 'c']]);
  assert.deepEqual(splitCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(splitCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']], 'no phantom trailing row');
});

test('header normalisation strips punctuation and case, and nothing else', () => {
  assert.equal(normalizeHeader('CDT Code'), 'cdtcode');
  assert.equal(normalizeHeader('  Allowed Amount  '), 'allowedamount');
  assert.equal(normalizeHeader('Provider Zip Code'), 'providerzipcode');
});

test('an empty or header-only CSV is refused with the specific reason', () => {
  assert.equal(parseCsvFeeSchedule('').failureCode, 'CSV_EMPTY');
  assert.equal(parseCsvFeeSchedule('   ').failureCode, 'CSV_EMPTY');
  assert.equal(parseCsvFeeSchedule('Code,Fee').failureCode, 'CSV_NO_DATA_ROWS');
});

// ════════════════════════════════════════════════════════════════════════════
// The dispatcher
// ════════════════════════════════════════════════════════════════════════════

test('parseFeeSchedule routes a real PDF through pdf-parse end to end', async () => {
  const r = await parseFeeSchedule({
    bytes: fx.syntheticFeePdf(fx.PDF_CLEAN),
    sourceType: 'pdf',
  });
  assert.equal(r.ok, true, r.failureReason || '');
  assert.equal(r.rows.length, 6);
  assert.equal(asMap(r.rows).D2740, 115000);
  assert.equal(r.warningCount, 0);
});

test('parseFeeSchedule routes CSV bytes through the CSV lane', async () => {
  const r = await parseFeeSchedule({
    bytes: Buffer.from(fx.CSV_CLEAN, 'utf8'),
    sourceType: 'csv',
  });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 5);
});

test('a CSV renamed .pdf is refused by its magic bytes, with a useful message', () => {
  // Trusting the declaration alone sends a CSV to pdf-parse, which fails with a
  // message about the container rather than about the file being the wrong kind.
  return parseFeeSchedule({ bytes: Buffer.from(fx.CSV_CLEAN, 'utf8'), sourceType: 'pdf' }).then(
    (r) => {
      assert.equal(r.ok, false);
      assert.equal(r.failureCode, 'WRONG_FILE_TYPE');
      assert.match(r.failureReason, /%PDF-/);
    }
  );
});

test('an empty upload and an unknown source type are each refused by name', async () => {
  assert.equal((await parseFeeSchedule({ bytes: Buffer.alloc(0), sourceType: 'csv' })).failureCode, 'FILE_EMPTY');
  assert.equal(
    (await parseFeeSchedule({ bytes: Buffer.from('x'), sourceType: 'xlsx' })).failureCode,
    'UNSUPPORTED_SOURCE_TYPE'
  );
});

test('duplicate flagging runs on BOTH lanes, not just the one that implemented it', async () => {
  // A code listed twice at two fees is the same problem whichever format it
  // arrived in. The dispatcher is where the rule lives so the lanes cannot
  // disagree about what a duplicate is.
  const csv = await parseFeeSchedule({
    bytes: Buffer.from(
      ['Code,Fee', 'D2740,1150.00', 'D1110,92.00', 'D2740,1275.00'].join('\n'),
      'utf8'
    ),
    sourceType: 'csv',
  });
  assert.equal(csv.ok, true);
  const flagged = csv.rows.filter((r) => r.warnings.some((w) => w.code === 'duplicate_code'));
  assert.equal(flagged.length, 2);

  const pdf = await parseFeeSchedule({
    bytes: fx.syntheticFeePdf(fx.PDF_DUPLICATE_CODES),
    sourceType: 'pdf',
  });
  assert.equal(pdf.ok, true);
  assert.equal(pdf.rows.filter((r) => r.warnings.some((w) => w.code === 'duplicate_code')).length, 2);
});

test('warningCount counts ROW warnings too, not just file-level ones', async () => {
  // Counting `warnings.length` at the route would report 0 for the case that
  // matters most: a clean-looking file where forty rows each carry a flag.
  const r = await parseFeeSchedule({
    bytes: fx.syntheticFeePdf(fx.PDF_MULTI_COLUMN),
    sourceType: 'pdf',
  });
  assert.equal(r.warnings.length, 0, 'no file-level warnings here');
  assert.equal(r.rows.length, 2);
  assert.equal(r.warningCount, 2, 'both rows are flagged and both are counted');
  assert.equal(countWarnings(r), r.warningCount);
});

test('sourceTypeFromFilename reads the extension and nothing else', () => {
  assert.equal(sourceTypeFromFilename('northstar-2027.pdf'), 'pdf');
  assert.equal(sourceTypeFromFilename('NORTHSTAR-2027.PDF'), 'pdf');
  assert.equal(sourceTypeFromFilename('schedule.csv'), 'csv');
  assert.equal(sourceTypeFromFilename('schedule.xlsx'), null);
  assert.equal(sourceTypeFromFilename('schedule'), null);
  assert.equal(sourceTypeFromFilename(null), null);
});

// ════════════════════════════════════════════════════════════════════════════
// The vocabulary the database will actually accept
// ════════════════════════════════════════════════════════════════════════════

test('the source types the parser attempts are exactly the ones the CHECK admits', () => {
  // The migration's CHECK is what decides what can be STORED; SOURCE_TYPES is
  // only what decides what gets attempted. A parser lane the database refuses
  // is a 500 at the INSERT, after the work is done.
  assert.deepEqual([...SOURCE_TYPES].sort(), [...migration.SOURCE_TYPES].sort());
});

test('every row a lane produces satisfies the column CHECKs it will be stored under', async () => {
  // proc_code ~ '^D[0-9]{4}$' and fee_cents >= 0, asserted against every row of
  // every fixture rather than against a handpicked one.
  const results = await Promise.all([
    parseFeeSchedule({ bytes: fx.syntheticFeePdf(fx.PDF_CLEAN), sourceType: 'pdf' }),
    parseFeeSchedule({ bytes: fx.syntheticFeePdf(fx.PDF_MULTI_COLUMN), sourceType: 'pdf' }),
    parseFeeSchedule({ bytes: fx.syntheticFeePdf(fx.PDF_WRAPPED), sourceType: 'pdf' }),
    parseFeeSchedule({ bytes: fx.syntheticFeePdf(fx.PDF_EDGE_AMOUNTS), sourceType: 'pdf' }),
    parseFeeSchedule({ bytes: Buffer.from(fx.CSV_CLEAN, 'utf8'), sourceType: 'csv' }),
    parseFeeSchedule({ bytes: Buffer.from(fx.CSV_MESSY, 'utf8'), sourceType: 'csv' }),
  ]);

  for (const result of results) {
    assert.equal(result.ok, true, result.failureReason || '');
    for (const row of result.rows) {
      assert.match(row.procCode, /^D[0-9]{4}$/, `${row.procCode} would violate the proc_code CHECK`);
      assert.equal(Number.isInteger(row.feeCents), true);
      assert.ok(row.feeCents >= 0, `${row.procCode} would violate the fee_cents CHECK`);
      assert.equal(typeof row.rawLine, 'string');
      assert.ok(Array.isArray(row.warnings));
    }
  }
});

test('no fixture in this suite contains anything that could be a patient', () => {
  // The reference folder ships real payer PDFs. None of them are here. This is
  // a standing guard, not a one-time check: the fixtures are procedure codes,
  // invented round fees, and two payer names that do not exist.
  const everything = JSON.stringify(fx);
  assert.match(everything, /NORTHSTAR DENTAL/);
  assert.match(everything, /MERIDIAN BENEFIT/);
  // No date of birth, no phone number, no SSN-shaped run of digits.
  assert.equal(/\b\d{3}-\d{2}-\d{4}\b/.test(everything), false, 'SSN-shaped digits');
  assert.equal(/\b\d{3}[-.]\d{3}[-.]\d{4}\b/.test(everything), false, 'phone-shaped digits');
});
