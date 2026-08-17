'use strict';

/**
 * The CARC/RARC vocabularies — and the rule that an unknown code is never
 * guessed at.
 *
 * Open Dental's `ClaimAdjReasonCodes` is read-only over its API (RCM_OD_WRITES
 * G3), so this table is the ONLY place a denial reason becomes a sentence a
 * biller can read. That makes "we do not know this code" a real answer worth
 * testing, because the alternative — a plausible-looking description we made up
 * — lands in front of staff who will act on it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const codes = require('./adjustmentCodes');

test('a known CARC resolves to its published meaning', () => {
  assert.equal(codes.describeCarc('45'), 'Charge exceeds fee schedule/maximum allowable');
  assert.equal(codes.describeCarc(45), 'Charge exceeds fee schedule/maximum allowable');
  assert.equal(codes.describeCarc('b15'), 'Procedure has been combined with another procedure');
});

test('CARC 97 carries the BUNDLING text, not the benefit-maximum one', () => {
  // Parser deviation D10. The source table said "Benefit maximum reached" for
  // 97, which is 119 — and that string lands in front of billing staff.
  assert.match(codes.describeCarc('97'), /included in the allowance for another service/);
  assert.match(codes.describeCarc('119'), /Benefit maximum reached/);
});

test('an unknown code is null — never a guess', () => {
  assert.equal(codes.describeCarc('9999'), null);
  assert.equal(codes.describeRarc('ZZ99'), null);
  assert.equal(codes.describeGroup('XX'), null);
  assert.equal(codes.describeCarc(''), null);
  assert.equal(codes.describeCarc(null), null);
  assert.equal(codes.describeCarc({}), null);
});

test('RARC codes resolve, which they could not before this table existed', () => {
  // Parser D9 reads the LQ*HE remark code, but there was nothing to look it up
  // in — so every remark_description Slice 5 wrote is the empty string.
  assert.match(codes.describeRarc('N19'), /incidental to primary procedure/);
  assert.match(codes.describeRarc('m15'), /bundled/i);
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

test("a payer's own stored wording wins over ours", () => {
  // Overwriting it would make two uploads of the same remittance read
  // differently depending on when this table last changed.
  const out = codes.describeAdjustment({
    groupCode: 'CO',
    reasonCode: '45',
    reasonDescription: 'Exceeds our contracted rate for this provider',
  });
  assert.equal(out.reasonDescription, 'Exceeds our contracted rate for this provider');
});

test("the parser's placeholder is treated as blank, so the table can improve it", () => {
  // `Adjustment code 253` is what the parser writes when it has no description.
  // It is a placeholder, not a payer's words.
  const out = codes.describeAdjustment({ groupCode: 'CO', reasonCode: '253', reasonDescription: 'Adjustment code 253' });
  assert.equal(out.reasonDescription, 'Sequestration - reduction in federal payment');
});

test('a blank stored description is filled from the table', () => {
  const out = codes.describeAdjustment({
    groupCode: 'PR',
    reasonCode: '1',
    reasonDescription: '',
    remarkCode: 'N19',
    remarkDescription: '',
  });
  assert.equal(out.reasonDescription, 'Deductible amount');
  assert.match(out.remarkDescription, /incidental/);
});

test('an unknown code renders as the bare code with no gloss', () => {
  const out = codes.describeAdjustment({ groupCode: 'CO', reasonCode: '9999', reasonDescription: '' });
  assert.equal(out.reasonCode, '9999');
  assert.equal(out.reasonDescription, null);
});

test('no remark code means no remark description, rather than an empty string', () => {
  const out = codes.describeAdjustment({ groupCode: 'CO', reasonCode: '45' });
  assert.equal(out.remarkCode, null);
  assert.equal(out.remarkDescription, null);
});

test('codes are normalized for lookup — trimmed and uppercased, nothing more', () => {
  assert.equal(codes.describeCarc('  45  '), 'Charge exceeds fee schedule/maximum allowable');
  assert.equal(codes.describeRarc(' n19 '), codes.describeRarc('N19'));
  // A token that needs more than that to match is not the code it claims to be.
  assert.equal(codes.describeCarc('CARC-45'), null);
});

test('every group the schema CHECK allows has both a description and a label', () => {
  // `group_code IN ('CO','PR','OA','PI','CR')` — a group the database can store
  // but this table does not name would render as two anonymous letters.
  for (const group of ['CO', 'PR', 'OA', 'PI', 'CR']) {
    assert.ok(codes.describeGroup(group), `${group} has no description`);
    assert.notEqual(codes.labelGroup(group), group, `${group} has no label`);
  }
});

test('the ERA parser and the workbench read ONE table, not two', () => {
  // Two tables would drift, and the drift would be invisible: the parser's copy
  // decides what is STORED and the workbench's copy decides what is SHOWN.
  const { CARC_DESCRIPTIONS } = require('./eraParser');
  assert.equal(CARC_DESCRIPTIONS, codes.CARC_DESCRIPTIONS);
});

test('the tables are frozen — a code list is not runtime state', () => {
  assert.ok(Object.isFrozen(codes.CARC_DESCRIPTIONS));
  assert.ok(Object.isFrozen(codes.RARC_DESCRIPTIONS));
  assert.ok(Object.isFrozen(codes.GROUP_DESCRIPTIONS));
});
