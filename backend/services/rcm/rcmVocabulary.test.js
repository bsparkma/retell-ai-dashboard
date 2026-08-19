'use strict';

/**
 * The vocabulary is only "frozen" if the code and the database agree about it.
 *
 * `rcmVocabulary.js` is what the parser and the extraction import; the CHECK
 * constraints in `…_rcm_fidelity.js` are what the database enforces. If those
 * two drift, the failure mode is the worst available: a route writes a reason
 * the constraint rejects, the whole transaction rolls back, and an upload that
 * parsed perfectly fails with a constraint error nobody can read.
 *
 * These tests read the migration's SOURCE and compare the lists literally. It
 * is a blunt instrument on purpose — a clever test that imported the migration
 * and inspected it would follow a refactor into being wrong.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const vocabulary = require('./rcmVocabulary');
const { deriveClaimReviewReasons, deriveBatchReviewReasons } = require('./eobExtraction');

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', '..', 'migrations-tenant', '1787060000000_rcm_fidelity.js'),
  'utf8'
);

/** Pull a `const NAME = [ 'a', 'b' ];` literal out of the migration source. */
function migrationList(name) {
  const m = MIGRATION.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(m, `migration must declare ${name}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('the review-reason vocabulary matches the migration exactly', () => {
  assert.deepEqual(migrationList('REVIEW_REASONS').sort(), [...vocabulary.REVIEW_REASONS].sort());
});

test('the line-flag vocabulary matches the migration exactly', () => {
  assert.deepEqual(migrationList('LINE_FLAGS').sort(), [...vocabulary.LINE_FLAGS].sort());
});

test('the remittance-flag vocabulary matches the migration exactly', () => {
  assert.deepEqual(
    migrationList('REMITTANCE_FLAGS').sort(),
    [...vocabulary.REMITTANCE_FLAGS].sort()
  );
});

test('the EOB failure-code vocabulary matches the migration exactly', () => {
  assert.deepEqual(
    migrationList('EOB_FAILURE_CODES').sort(),
    [...vocabulary.EOB_FAILURE_CODES].sort()
  );
});

test('the allowed-source and adjustment-scope vocabularies match the migration', () => {
  // Slice 5.5 review: these two were mirrored into the migration as INLINE
  // lists, so the drift test could not see them and they could have diverged
  // silently. Named consts now, under the same guard as the others.
  assert.deepEqual(migrationList('ALLOWED_SOURCES').sort(), [...vocabulary.ALLOWED_SOURCES].sort());
  assert.deepEqual(
    migrationList('ADJUSTMENT_SCOPES').sort(),
    [...vocabulary.ADJUSTMENT_SCOPES].sort()
  );
});

test('the parameterised uncertain_line reason is accepted, and near-misses are not', () => {
  // The one reason the DB CHECK cannot express as `<@ ARRAY[…]`, which is why
  // the migration validates each element through an IMMUTABLE function.
  assert.ok(vocabulary.isReviewReason('uncertain_line:1'));
  assert.ok(vocabulary.isReviewReason('uncertain_line:42'));

  for (const bad of ['uncertain_line', 'uncertain_line:', 'uncertain_line:0', 'uncertain_line:x', 'uncertain_line:-1']) {
    assert.equal(vocabulary.isReviewReason(bad), false, `${bad} must not validate`);
  }
  // And the migration's regex is the same one, character for character.
  assert.ok(MIGRATION.includes("'^uncertain_line:[1-9][0-9]*$'"));
});

test('every reason the ERA parser can emit is in the vocabulary', () => {
  const { REVIEW_REASONS } = require('./eraParser');
  for (const reason of Object.values(REVIEW_REASONS)) {
    assert.ok(vocabulary.isReviewReason(reason), `${reason} must be a known review reason`);
  }
});

test('every reason the ERA ingest can emit is in the vocabulary', () => {
  const { UNSTORABLE_ADJUSTMENT } = require('./eraIngest');
  assert.ok(vocabulary.isReviewReason(UNSTORABLE_ADJUSTMENT));
});

test('every reason the EOB extraction can emit is in the vocabulary', () => {
  // Driven through the real derivation rather than a copy of its list: a new
  // `reasons.push('…')` in eobExtraction.js has to appear here to pass, which
  // is the point. The inputs are chosen to make EVERY branch fire at once.
  const claim = {
    claimNumber: '',
    patientName: '',
    patientDOB: null,
    subscriberId: '',
    providerNPI: '',
    serviceDate: '2999-01-01',
    totalPaidCents: -1,
    totalBilledCents: -1,
    procedures: [
      { position: 0, paidCents: -5, billedCents: -5, confidence: 0.1 },
      { position: 1, paidCents: 1, billedCents: 1, confidence: 0.1 },
    ],
  };
  const payment = { checkNumber: '', payer: '' };

  const reasons = [
    ...deriveClaimReviewReasons(claim, 0.1, payment, { today: '2026-01-01' }),
    ...deriveClaimReviewReasons({ ...claim, serviceDate: null, procedures: [] }, 0.1, payment, {
      today: '2026-01-01',
    }),
    ...deriveBatchReviewReasons({ claims: [], payment: { totalPaidCents: 0 } }),
    ...deriveBatchReviewReasons({
      claims: [{ totalPaidCents: 100 }],
      payment: { totalPaidCents: 900 },
    }),
  ];

  assert.ok(reasons.length > 10, 'the fixture above should exercise most branches');
  for (const reason of reasons) {
    assert.ok(vocabulary.isReviewReason(reason), `${reason} must be a known review reason`);
  }
  // And the parameterised one really did fire, so that branch is covered too.
  assert.ok(reasons.some((r) => r.startsWith('uncertain_line:')));
});

test('the line flags the ERA parser can raise are all storable', () => {
  const { LINE_FLAGS } = require('./eraParser');
  assert.deepEqual([...LINE_FLAGS].sort(), [...vocabulary.LINE_FLAGS].sort());
});

test('the remittance flags the ERA parser can raise are all storable', () => {
  const { REMITTANCE_FLAGS } = require('./eraParser');
  for (const flag of Object.values(REMITTANCE_FLAGS)) {
    assert.ok(vocabulary.REMITTANCE_FLAGS.includes(flag), `${flag} must be storable`);
  }
});

// ─── D-11: the blocking / annotating gate map ────────────────────────────────

test('EVERY vocabulary member has a verdict — the fail-closed default is a backstop', () => {
  /*
   * `isBlockingReason` treats anything absent from REASON_GATE as BLOCKING, which
   * is the right default and a terrible routine path: a reason added without a
   * verdict would silently start withholding every claim that carries it, and
   * the first sign would be a biller unable to post a check nobody changed.
   *
   * So the default must be unreachable in practice. Three vocabularies reach the
   * gate — claim review reasons, remittance flags and line flags — and every
   * member of all three has to be named.
   */
  const all = [
    ...vocabulary.REVIEW_REASONS,
    ...vocabulary.REMITTANCE_FLAGS,
    ...vocabulary.LINE_FLAGS,
  ];
  const missing = [...new Set(all)].filter(
    (r) => !Object.prototype.hasOwnProperty.call(vocabulary.REASON_GATE, r)
  );
  assert.deepEqual(
    missing,
    [],
    `these vocabulary members have no blocking/annotating verdict: ${missing.join(', ')}`
  );
});

test('the gate map names nothing that is not in a vocabulary', () => {
  // The other direction. A verdict for a slug nothing can emit is dead weight
  // that reads as coverage — and it is how a renamed reason keeps its old
  // verdict while the new name falls through to the default.
  const all = new Set([
    ...vocabulary.REVIEW_REASONS,
    ...vocabulary.REMITTANCE_FLAGS,
    ...vocabulary.LINE_FLAGS,
  ]);
  const orphans = vocabulary.GATED_REASONS.filter((r) => !all.has(r));
  assert.deepEqual(orphans, [], `gate verdicts for slugs no vocabulary contains: ${orphans.join(', ')}`);
});

test('every verdict is exactly blocking or annotating', () => {
  for (const [reason, verdict] of Object.entries(vocabulary.REASON_GATE)) {
    assert.ok(
      verdict === 'blocking' || verdict === 'annotating',
      `${reason} has verdict '${verdict}'`
    );
  }
});

test('an UNKNOWN slug blocks — fail closed, in both helpers', () => {
  assert.equal(vocabulary.isBlockingReason('a_reason_nobody_has_written_yet'), true);
  assert.equal(vocabulary.isBlockingReason(''), true);
  assert.equal(vocabulary.isBlockingReason(null), true);
  assert.equal(vocabulary.isBlockingReason(undefined), true);
  // The parameterised one is handled explicitly rather than by the default:
  // reaching the fallback for it would be an accident that happened to be right.
  assert.equal(vocabulary.isBlockingReason('uncertain_line:3'), true);
  // …and it is not a prefix match on a made-up neighbour.
  assert.equal(vocabulary.isBlockingReason('uncertain_line:0'), true);
});

test('blockingReasonsIn keeps order, de-duplicates, and drops the annotating ones', () => {
  const found = vocabulary.blockingReasonsIn([
    'procedure_downcoded', // annotating
    'totals_unreconciled', // blocking
    'plb_adjustments_present', // annotating
    'totals_unreconciled', // the same one again
    'unreadable_amount', // blocking
    '', // nothing
  ]);
  assert.deepEqual(found, ['totals_unreconciled', 'unreadable_amount']);
  assert.deepEqual(vocabulary.blockingReasonsIn([]), []);
  assert.deepEqual(vocabulary.blockingReasonsIn(null), []);
});

test('D-11 ruled allowed_amount_mismatch ANNOTATING, and the takeback BLOCKING', () => {
  // The two verdicts the ruling actually turned on. Named individually so a
  // change to either is a deliberate edit to this test, not a diff nobody read.
  assert.equal(vocabulary.REASON_GATE.allowed_amount_mismatch, 'annotating');
  assert.equal(vocabulary.REASON_GATE.reversal_not_postable, 'blocking');
  assert.equal(vocabulary.REASON_GATE.claim_denied, 'annotating');
  assert.equal(vocabulary.REASON_GATE.envelope_incomplete, 'blocking');
});
