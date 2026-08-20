'use strict';

/**
 * The CARC/RARC vocabularies.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE LEARNED
 * ─────────────────────────────────────────────────────────────────────────────
 * The first version of this suite asserted four hand-picked description strings
 * — and **three of them were wrong**, so the test locked the bug in rather than
 * catching it. CARC 22 was pinned as "care already paid" when it means
 * *coordination of benefits*: bill the secondary carrier. A biller reading our
 * screen would have closed a claim that still had money owed on it.
 *
 * So this file no longer asserts what a description SAYS. It asserts:
 *
 *  1. the data is the PUBLISHED data — by entry count and content hash, so both
 *     silent upstream drift and a hand edit fail the build;
 *  2. the codes that were wrong now match the published text, spot-checked on
 *     the substance that made each one dangerous;
 *  3. the BEHAVIOUR around the data — unknown → null, stored wording wins,
 *     normalization, the Usage split.
 *
 * Re-running `node scripts/fetch-x12-codes.mjs` when X12 publishes an update is
 * expected to turn (1) red. That is the point: a human looks at the diff and
 * re-pins deliberately.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');

const codes = require('./adjustmentCodes');
const generated = require('./x12Codes.generated');

// ─── 1. The data is the published data ───────────────────────────────────────

/**
 * Pinned from the 2026-08-17 ingest of the published X12 lists.
 * Update these ONLY by re-running the generator and reading the diff.
 */
const PINNED = Object.freeze({
  carcCount: 407,
  rarcCount: 1216,
  sha256: 'de05e9d88c5cc0dc236033064e2f6adfa6ac5b4fabdb069333d4ad8c988e26ec',
});

/** The same canonicalisation the generator hashes. */
function canonical(map) {
  return JSON.stringify(
    Object.keys(map)
      .sort()
      .map((k) => [k, map[k].text, map[k].status])
  );
}

test('the code lists are the published ones, by count', () => {
  assert.equal(Object.keys(generated.CARC).length, PINNED.carcCount);
  assert.equal(Object.keys(generated.RARC).length, PINNED.rarcCount);
});

test('the code lists are the published ones, by content hash', () => {
  // Catches a hand edit to a single description — the exact failure mode that
  // put "care already paid" on CARC 22 and kept it there through a review.
  const hash = createHash('sha256')
    .update(`${canonical(generated.CARC)}\n${canonical(generated.RARC)}`)
    .digest('hex');
  assert.equal(
    hash,
    PINNED.sha256,
    'The X12 tables changed. Re-run `node scripts/fetch-x12-codes.mjs`, READ THE DIFF, ' +
      'and update PINNED above deliberately. Never hand-edit x12Codes.generated.js.'
  );
  assert.equal(generated.SOURCE.sha256, PINNED.sha256, 'the file header disagrees with its own data');
});

test('the data carries its provenance', () => {
  assert.match(generated.SOURCE.carcUrl, /^https:\/\/x12\.org\//);
  assert.match(generated.SOURCE.rarcUrl, /^https:\/\/x12\.org\//);
  assert.match(generated.SOURCE.retrievedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test('deactivated codes are retained, with their status', () => {
  // An old denial being worked today legitimately carries a retired code.
  // Dropping them would leave a gap exactly where the work is hardest.
  const nonCurrent = Object.values(generated.CARC).filter((c) => c.status !== 'current');
  assert.ok(nonCurrent.length > 0, 'no retired CARCs retained — the ingest dropped them');
  for (const entry of Object.values(generated.CARC)) {
    assert.ok(['current', 'tobe', 'deactivated'].includes(entry.status), entry.status);
  }
});

test('no description carries the scraper’s presentation noise', () => {
  // "Start: 01/01/1995" is a date span in the page, not part of the meaning.
  for (const [code, entry] of Object.entries(generated.CARC)) {
    assert.ok(!/^Start:|Last Modified:/.test(entry.text), `${code}: ${entry.text.slice(0, 60)}`);
    assert.ok(!/[<>]/.test(entry.text), `${code} still contains markup`);
    assert.ok(!/&[a-z]+;/i.test(entry.text), `${code} still contains an HTML entity`);
  }
});

// ─── 2. The codes that were wrong now carry the published meaning ────────────

/**
 * Each entry names the SUBSTANCE that made the old string dangerous, not the
 * new string verbatim — the hash above is what pins the exact text, and
 * re-asserting it here by hand would reintroduce the transcription risk this
 * whole change exists to remove.
 */
test('CARC 22 is coordination of benefits — BILL THE OTHER PAYER', () => {
  // The one that costs money. The old table said "care already paid", which
  // tells a biller to close a claim that still has money owed on it.
  const text = codes.describeCarc('22');
  assert.match(text, /coordination of benefits/i);
  assert.doesNotMatch(text, /already paid/i);
});

test('CARC 51 is a pre-existing condition, not a location', () => {
  assert.match(codes.describeCarc('51'), /pre-existing condition/i);
});

test('CARC 50 is medical necessity, not a bare non-covered service', () => {
  assert.match(codes.describeCarc('50'), /medical necessity/i);
});

test('CARC 151 is the FREQUENCY limit, not a pre-payment review', () => {
  assert.match(codes.describeCarc('151'), /many\/frequency of services/i);
});

test('CARC 49 is a routine/preventive exam, not an emergency rule', () => {
  assert.match(codes.describeCarc('49'), /routine\/preventive/i);
});

test('CARC 54 and 234 are not swapped', () => {
  // 234 is the "not paid separately" one; 54 is about multiple physicians.
  assert.match(codes.describeCarc('234'), /not paid separately/i);
  assert.match(codes.describeCarc('54'), /multiple physicians/i);
});

test('CARC B15 requires a qualifying service — the sequencing code', () => {
  assert.match(codes.describeCarc('B15'), /qualifying service/i);
});

test('CARC 97 is bundling and 119 is the benefit maximum, still distinct', () => {
  // The parser's D10 correction, now satisfied by the published list itself.
  assert.match(codes.describeCarc('97'), /included in the payment\/allowance/i);
  assert.match(codes.describeCarc('119'), /benefit maximum/i);
});

test('the deductible / coinsurance / copay trio is intact', () => {
  assert.match(codes.describeCarc('1'), /deductible/i);
  assert.match(codes.describeCarc('2'), /coinsurance/i);
  assert.match(codes.describeCarc('3'), /co-?payment/i);
});

test('RARC codes resolve, which they could not before this table existed', () => {
  // Parser D9 reads the LQ*HE remark code, but there was nothing to resolve it
  // in — so every remark_description Slice 5 wrote is the empty string.
  assert.match(codes.describeRarc('N19'), /incidental to primary procedure/i);
  assert.match(codes.describeRarc('M15'), /bundled/i);
});

// ─── 3. The behaviour around the data ────────────────────────────────────────

test('an unknown code is null — never a guess', () => {
  assert.equal(codes.describeCarc('9999'), null);
  assert.equal(codes.describeRarc('ZZ99'), null);
  assert.equal(codes.describeGroup('XX'), null);
  assert.equal(codes.describeCarc(''), null);
  assert.equal(codes.describeCarc(null), null);
  assert.equal(codes.describeCarc({}), null);
});

test('codes are normalized for lookup — trimmed and uppercased, nothing more', () => {
  assert.equal(codes.describeCarc('  45  '), codes.describeCarc('45'));
  assert.equal(codes.describeRarc(' n19 '), codes.describeRarc('N19'));
  assert.equal(codes.describeCarc('b15'), codes.describeCarc('B15'));
  // A token that needs more than that to match is not the code it claims to be.
  assert.equal(codes.describeCarc('CARC-45'), null);
});

test('a numeric code works as well as its string form', () => {
  assert.equal(codes.describeCarc(45), codes.describeCarc('45'));
});

test('implementer guidance is split off the meaning, losslessly', () => {
  // The published entry for 45 appends "Usage: This adjustment amount cannot
  // equal…", which is instruction to the payer, not what the code means.
  const meaning = codes.describeCarc('45');
  const full = codes.describeCarcFull('45');
  assert.ok(full.startsWith(meaning), 'the meaning must be a prefix of the published text');
  assert.doesNotMatch(meaning, /Usage:/);
  assert.match(full, /Usage:/);
});

test('an entry with no Usage clause splits to itself', () => {
  const { description, usage } = codes.splitUsage('Deductible Amount');
  assert.equal(description, 'Deductible Amount');
  assert.equal(usage, null);
});

test('the group code distinguishes a write-off from money the patient owes', () => {
  // The single most consequential field on an adjustment, and the one most
  // often skimmed past as two anonymous letters.
  assert.match(codes.describeGroup('CO'), /practice writes this off/);
  assert.match(codes.describeGroup('PR'), /patient owes/);
  assert.equal(codes.labelGroup('CO'), 'Contractual');
  assert.equal(codes.labelGroup('PR'), 'Patient resp.');
});

test('an unknown group falls back to the code itself as its label', () => {
  assert.equal(codes.labelGroup('ZZ'), 'ZZ');
});

test('every group the schema CHECK allows has a description and a label', () => {
  // `group_code IN ('CO','PR','OA','PI','CR')` — a group the database can store
  // but this map does not name would render as two anonymous letters.
  for (const group of ['CO', 'PR', 'OA', 'PI', 'CR']) {
    assert.ok(codes.describeGroup(group), `${group} has no description`);
    assert.notEqual(codes.labelGroup(group), group, `${group} has no label`);
  }
  // And nothing beyond the constraint's vocabulary.
  assert.deepEqual(Object.keys(codes.GROUP_DESCRIPTIONS).sort(), ['CO', 'CR', 'OA', 'PI', 'PR']);
});

test("a payer's own stored wording wins over ours", () => {
  // Overwriting it would make two uploads of the same remittance read
  // differently depending on when the code list was last pulled.
  const out = codes.describeAdjustment({
    groupCode: 'CO',
    reasonCode: '45',
    reasonDescription: 'Exceeds our contracted rate for this provider',
  });
  assert.equal(out.reasonDescription, 'Exceeds our contracted rate for this provider');
});

test("the parser's placeholder is treated as blank, so the list can improve it", () => {
  // `Adjustment code 253` is what the parser writes when it has no description.
  // It is a stand-in, not a payer's words.
  const out = codes.describeAdjustment({
    groupCode: 'CO',
    reasonCode: '253',
    reasonDescription: 'Adjustment code 253',
  });
  assert.match(out.reasonDescription, /sequestration/i);
});

test('a blank stored description is filled from the published list', () => {
  const out = codes.describeAdjustment({
    groupCode: 'PR',
    reasonCode: '1',
    reasonDescription: '',
    remarkCode: 'N19',
    remarkDescription: '',
  });
  assert.match(out.reasonDescription, /deductible/i);
  assert.match(out.remarkDescription, /incidental/i);
});

test('an unknown code renders as the bare code with no gloss', () => {
  const out = codes.describeAdjustment({ groupCode: 'CO', reasonCode: '9999', reasonDescription: '' });
  assert.equal(out.reasonCode, '9999');
  assert.equal(out.reasonDescription, null);
  assert.equal(out.reasonStatus, null);
});

test('no remark code means no remark description, rather than an empty string', () => {
  const out = codes.describeAdjustment({ groupCode: 'CO', reasonCode: '45' });
  assert.equal(out.remarkCode, null);
  assert.equal(out.remarkDescription, null);
});

test("a retired code's status is surfaced, not hidden", () => {
  const retired = Object.entries(generated.CARC).find(([, v]) => v.status === 'deactivated');
  const out = codes.describeAdjustment({ groupCode: 'CO', reasonCode: retired[0] });
  assert.equal(out.reasonStatus, 'deactivated');
  assert.ok(out.reasonDescription, 'a retired code still describes itself');
});

test('the ERA parser and the workbench resolve a code through ONE accessor', () => {
  // Two tables would drift, and the drift would be invisible: the parser's copy
  // decides what is STORED and the workbench's decides what is SHOWN. The
  // parser now CALLS describeCarc rather than indexing a table, so the
  // normalization is shared too.
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('./eraParser'), 'utf8');
  assert.match(src, /require\('\.\/adjustmentCodes'\)/);
  assert.match(src, /describeCarc\(reasonCode\)/);
  assert.doesNotMatch(src, /CARC_DESCRIPTIONS\[/, 'the parser must not index the table directly');
});

test('the tables are frozen — a code list is not runtime state', () => {
  assert.ok(Object.isFrozen(generated.CARC));
  assert.ok(Object.isFrozen(generated.RARC));
  assert.ok(Object.isFrozen(codes.GROUP_DESCRIPTIONS));
});
