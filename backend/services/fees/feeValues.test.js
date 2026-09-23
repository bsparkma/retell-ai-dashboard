'use strict';

/**
 * The two value normalisers. Every test here is one of the reference's silent
 * data-corruption defects, pinned so it cannot come back.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProcCode,
  parseFeeCents,
  findProcCodes,
  findAmounts,
  formatCents,
} = require('./feeValues');

// ─── parseFeeCents ──────────────────────────────────────────────────────────

test('THE STAR: a six-figure fee is not truncated by three orders of magnitude', () => {
  // The reference did `parseFloat(str.replace(',', ''))`. String.replace with a
  // string argument replaces the FIRST match only, so "1,234,567.00" became
  // "1234,567.00" and parseFloat stopped at the comma: 1234. A $1.2m amount
  // silently became $1,234, with a plausible-looking number left in its place.
  assert.equal(parseFeeCents('1,234,567.00').value, 123456700);
  assert.equal(parseFeeCents('$1,234,567.00').value, 123456700);

  // The single-comma case the reference DID get right, so the fix is not a
  // regression in the other direction.
  assert.equal(parseFeeCents('1,150.00').value, 115000);
});

test('cents are integers, never floats — no value round-trips through binary', () => {
  // 18.20 has no exact binary representation. The reference stored the float.
  assert.equal(parseFeeCents('18.20').value, 1820);
  assert.equal(parseFeeCents('0.10').value, 10);
  assert.equal(parseFeeCents('0.20').value, 20);
  // The classic: 0.1 + 0.2 !== 0.3 in floats. In cents it is exact.
  assert.equal(parseFeeCents('0.10').value + parseFeeCents('0.20').value, 30);
  for (const [raw, cents] of [['45.00', 4500], ['92.00', 9200], ['1150.00', 115000]]) {
    assert.equal(parseFeeCents(raw).value, cents);
    assert.equal(Number.isInteger(parseFeeCents(raw).value), true);
  }
});

test('$0.00 is a value, not a hole — the reference dropped every one of them', () => {
  // `if (feeAmount > 0)` discarded these. In a fee schedule 0.00 means not
  // covered, bundled, or no fee: a fact the office needs to see.
  const zero = parseFeeCents('0.00');
  assert.equal(zero.value, 0);
  assert.deepEqual(zero.warnings, []);
  assert.equal(parseFeeCents('$0.00').value, 0);
});

test('malformed thousands grouping is refused, not silently truncated', () => {
  // "1,23.00" is a captured column boundary, not a number. The reference would
  // have made it 123.00.
  const r = parseFeeCents('1,23.00');
  assert.equal(r.value, null);
  assert.equal(r.warnings[0].code, 'malformed_amount');
});

test('a negative amount is refused — a fee schedule has no negative fees', () => {
  for (const raw of ['-45.00', '(45.00)', '$-45.00']) {
    const r = parseFeeCents(raw);
    assert.equal(r.value, null, `${raw} must not parse`);
    assert.equal(r.warnings[0].code, 'negative_amount');
  }
});

test('an implausible amount is refused rather than overflowing the integer column', () => {
  // fee_cents is an `integer` (~$21.4m). A value past that would throw at the
  // INSERT, which is a 500 where a warning belongs.
  const r = parseFeeCents('99,999,999.00');
  assert.equal(r.value, null);
  assert.equal(r.warnings[0].code, 'implausible_amount');
});

test('unreadable input is a warning with a reason, never a throw and never a guess', () => {
  for (const raw of ['', '   ', 'N/A', 'see plan', null, undefined, {}]) {
    const r = parseFeeCents(raw);
    assert.equal(r.value, null, `${JSON.stringify(raw)} must not parse`);
    assert.ok(r.warnings.length >= 1, 'a refusal must say why');
    assert.ok(r.warnings[0].message.length > 0);
  }
});

// ─── normalizeProcCode ──────────────────────────────────────────────────────

test('a plain CDT code passes through, upper-cased and trimmed, with no warning', () => {
  for (const raw of ['D0120', ' d0120 ', 'd0120']) {
    const r = normalizeProcCode(raw);
    assert.equal(r.value, 'D0120');
    assert.deepEqual(r.warnings, []);
  }
});

test("a payer's suffix is stripped WITH a warning — the reference stripped it silently", () => {
  // D2740A and D2740B are a payer's two rates for the same procedure. Collapsing
  // both to D2740 in silence turns them into a duplicate whose winner is
  // whichever the parser reached first.
  const r = normalizeProcCode('D2740A');
  assert.equal(r.value, 'D2740');
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'suffix_stripped');
  assert.match(r.warnings[0].message, /D2740A/);
  assert.match(r.warnings[0].message, /D2740/);
});

test('a five-digit run is not a CDT code at all', () => {
  // The reference's /D\d{4}[\w\d]?/ matched D01201 as D0120 + suffix "1", and
  // its stripper only removed [A-Z] — so it stored "D01201", a code Open Dental
  // has never heard of, and the failure surfaced at post time.
  assert.equal(normalizeProcCode('D01201').value, null);
  assert.equal(findProcCodes('line with D01201 in it').length, 0);
});

test('anything that is not D plus four digits is refused with a reason', () => {
  for (const raw of ['TOTAL', 'Crown', '0120', 'DD120', 'D012', '', null, 42]) {
    const r = normalizeProcCode(raw);
    assert.equal(r.value, null, `${JSON.stringify(raw)} must not parse`);
    assert.equal(r.warnings[0].code, 'invalid_proc_code');
  }
});

// ─── the line scanners ──────────────────────────────────────────────────────

test('findProcCodes returns every distinct code on a line, in source order', () => {
  assert.deepEqual(findProcCodes('D0210 D0220 D0230 Radiographs 145.00'), [
    'D0210',
    'D0220',
    'D0230',
  ]);
  assert.deepEqual(findProcCodes('D2740 Crown 1,150.00'), ['D2740']);
  assert.deepEqual(findProcCodes('Effective January 1, 2027'), []);
});

test('findAmounts returns every money token and does NOT collapse repeats', () => {
  // A row printing the same number in two columns is genuinely ambiguous;
  // de-duplicating would hide exactly that.
  assert.deepEqual(findAmounts('D2740 Crown 1,150.00 920.00 805.00'), [
    '1,150.00',
    '920.00',
    '805.00',
  ]);
  assert.deepEqual(findAmounts('D2740 Crown 920.00 920.00'), ['920.00', '920.00']);
});

test('two decimal places are required, so quantities and years are not read as fees', () => {
  // This is the rule that stops "Effective January 1, 2027" and a tooth number
  // column becoming fees.
  assert.deepEqual(findAmounts('Effective January 1, 2027'), []);
  assert.deepEqual(findAmounts('Tooth 14, quantity 4'), []);
  assert.deepEqual(findAmounts('D2740 1150'), []);
});

test('formatCents renders what a warning message shows an office', () => {
  assert.equal(formatCents(115000), '$1,150.00');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(4500), '$45.00');
  assert.equal(formatCents(123456700), '$1,234,567.00');
});
