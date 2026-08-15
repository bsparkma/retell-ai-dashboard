'use strict';

/**
 * Remittance-key tests (RCM Slice 5).
 *
 *  1. **The ported suite** — `rcm-posting @ fix/prod-acr-registry-identity`,
 *     `server/remittanceKey.test.ts`. Semantics unchanged; harness moved from
 *     vitest to node:test. The one case that could not port as written is the
 *     source's "fail closed when the database is unavailable": these functions
 *     now take a client rather than reaching for a global connection, so the
 *     unavailable-database branch does not exist to test. The property it
 *     protected — that a reservation is never skipped — is now structural, and
 *     `era.test.js` pins it end to end.
 *
 *  2. **The office-scoping suite** — the port's one structural change, and the
 *     reason it matters: a duplicate under `roland` is refused while the same
 *     key under `valley` is accepted.
 *
 *  3. **The protocol suite** — reserve → finalize / release, run against the
 *     harness's FakeRcmDb so the ACTUAL SQL executes, including the unique
 *     constraint behind ON CONFLICT.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RemittanceIdentityError,
  generateRemittanceKey,
  buildBatchRemittanceKey,
  buildRemittanceKey,
  reserveRemittanceKey,
  finalizeRemittanceKey,
  releaseRemittanceKey,
  checkRemittanceProcessed,
} = require('./remittanceKey');
const { FakeRcmDb } = require('../../routes/rcm/rcmTestUtils');

// ─── Ported: generateRemittanceKey ──────────────────────────────────────────

test('builds a stable uppercase key from identity components', () => {
  assert.equal(
    generateRemittanceKey({
      traceNumber: 'trn123',
      payerId: 'Delta Dental',
      paymentDate: '2026-07-01',
      paymentAmountCents: 123456,
      checkNumber: 'chk-9',
    }),
    'TRN123|DELTA DENTAL|2026-07-01|123456|CHK-9'
  );
});

test('is deterministic — same inputs always produce the same key', () => {
  const params = {
    traceNumber: 'TRN1',
    payerId: 'Cigna',
    paymentDate: '2026-06-15',
    paymentAmountCents: 5000,
    checkNumber: '100',
  };
  assert.equal(generateRemittanceKey(params), generateRemittanceKey(params));
});

test('trims whitespace so equivalent inputs cannot diverge', () => {
  assert.equal(
    generateRemittanceKey({
      traceNumber: ' TRN1 ',
      payerId: 'Cigna ',
      paymentDate: '2026-06-15',
      paymentAmountCents: 5000,
      checkNumber: ' 100',
    }),
    generateRemittanceKey({
      traceNumber: 'TRN1',
      payerId: 'Cigna',
      paymentDate: '2026-06-15',
      paymentAmountCents: 5000,
      checkNumber: '100',
    })
  );
});

test('throws RemittanceIdentityError when trace and check are both empty', () => {
  assert.throws(
    () =>
      generateRemittanceKey({
        traceNumber: '',
        payerId: 'Cigna',
        paymentDate: '2026-06-15',
        paymentAmountCents: 5000,
      }),
    RemittanceIdentityError
  );
});

test('throws when trace and check are whitespace-only', () => {
  assert.throws(
    () =>
      generateRemittanceKey({
        traceNumber: '  ',
        payerId: 'Cigna',
        paymentDate: '2026-06-15',
        paymentAmountCents: 5000,
        checkNumber: ' ',
      }),
    RemittanceIdentityError
  );
});

test('accepts a check number alone as identity', () => {
  assert.equal(
    generateRemittanceKey({
      traceNumber: '',
      payerId: 'Cigna',
      paymentDate: '2026-06-15',
      paymentAmountCents: 5000,
      checkNumber: 'CHK1',
    }),
    'NO_TRACE|CIGNA|2026-06-15|5000|CHK1'
  );
});

// ─── Ported: buildBatchRemittanceKey ────────────────────────────────────────

const baseBatch = {
  traceNumber: null,
  checkNumber: null,
  eftNumber: null,
  payer: 'Delta Dental',
  depositDate: '2026-07-01',
  totalAmountCents: 250000,
};

test('uses traceNumber first, then checkNumber, then eftNumber', () => {
  assert.ok(
    buildBatchRemittanceKey({ ...baseBatch, traceNumber: 'T1', checkNumber: 'C1', eftNumber: 'E1' }).includes('T1|')
  );
  assert.ok(buildBatchRemittanceKey({ ...baseBatch, checkNumber: 'C1', eftNumber: 'E1' }).includes('C1|'));
  assert.ok(buildBatchRemittanceKey({ ...baseBatch, eftNumber: 'E1' }).includes('E1|'));
});

test('throws when the batch has no trace, check, or EFT number (no batch-id fallback)', () => {
  assert.throws(() => buildBatchRemittanceKey(baseBatch), RemittanceIdentityError);
});

test('does not embed today when depositDate is missing — the key must be time-independent', () => {
  const key = buildBatchRemittanceKey({ ...baseBatch, checkNumber: 'C1', depositDate: null });
  assert.equal(key, 'C1|DELTA DENTAL|NO_DATE|250000|C1');
  assert.ok(!key.includes(new Date().toISOString().slice(0, 10)));
});

test('produces the same key for the same batch regardless of call site', () => {
  const batch = { ...baseBatch, checkNumber: 'CHK-42' };
  assert.equal(buildBatchRemittanceKey(batch), buildBatchRemittanceKey({ ...batch }));
});

// ─── The ERA adapter ────────────────────────────────────────────────────────

/** A parsed remittance, in the shape eraParser produces. */
function remittance(over = {}) {
  return {
    traceNumber: '830200001',
    checkNumber: '830200001',
    payerName: 'DELTA DENTAL OF ARKANSAS',
    paymentDate: '2026-03-02',
    totalPaymentCents: 65_100,
    ...over,
  };
}

test('an ERA remittance keys on its own trace, payer, date and amount', () => {
  assert.equal(
    buildRemittanceKey(remittance()),
    '830200001|DELTA DENTAL OF ARKANSAS|2026-03-02|65100|830200001'
  );
});

test("the parser's 'UNKNOWN' check-number placeholder is never treated as identity", () => {
  // eraParser sets checkNumber = 'UNKNOWN' when a transaction carries no TRN.
  // Letting that into the key would make every trace-less remittance from one
  // payer, on one date, for one amount collide with every other one.
  assert.throws(
    () => buildRemittanceKey(remittance({ traceNumber: '', checkNumber: 'UNKNOWN' })),
    RemittanceIdentityError
  );
});

test('two different checks from one payer on one day get different keys', () => {
  assert.notEqual(
    buildRemittanceKey(remittance({ traceNumber: 'A1', checkNumber: 'A1' })),
    buildRemittanceKey(remittance({ traceNumber: 'A2', checkNumber: 'A2' }))
  );
});

// ─── The reservation protocol, against real SQL ─────────────────────────────

const IDENTITY = {
  remittanceKey: '830200001|DELTA DENTAL OF ARKANSAS|2026-03-02|65100|830200001',
  traceNumber: '830200001',
  payerId: 'DELTA DENTAL OF ARKANSAS',
  paymentDate: '2026-03-02',
  paymentAmountCents: 65_100,
  checkNumber: '830200001',
};

test('reserve claims a free key, and reports the row it created', async () => {
  const db = new FakeRcmDb();
  const result = await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });

  assert.equal(result.reserved, true);
  assert.ok(result.remittanceKeyId);

  const [row] = db.table('rcm_remittance_keys');
  assert.equal(row.office_id, 'roland');
  assert.equal(row.status, 'pending');
  assert.equal(row.remittance_key, IDENTITY.remittanceKey);
  assert.ok(row.reserved_at instanceof Date);
});

test('reserve REFUSES a key this office already holds', async () => {
  const db = new FakeRcmDb();
  await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });
  const second = await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });

  assert.equal(second.reserved, false);
  assert.equal(second.status, 'pending');
  // One row, not two — ON CONFLICT DO NOTHING, backed by the unique index.
  assert.equal(db.table('rcm_remittance_keys').length, 1);
});

test('a pending reservation blocks as firmly as a posted one', async () => {
  // 'pending' means a run is in flight or died mid-flight. Until a human has
  // checked what landed, "we may already have done this" reads as "we did".
  const db = new FakeRcmDb();
  await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });
  const blocked = await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });
  assert.equal(blocked.reserved, false);

  const seen = await checkRemittanceProcessed(db, {
    officeId: 'roland',
    remittanceKey: IDENTITY.remittanceKey,
  });
  assert.equal(seen.alreadyProcessed, true);
  assert.equal(seen.status, 'pending');
});

test('OFFICE IS IN THE UNIQUENESS: the same key is free for the other office', async () => {
  // The port's one structural change. Two practices legitimately receive
  // distinct checks whose components collide; under the source's global unique
  // one office's remittance would silently block the other's, and the failure
  // would look exactly like successful dedupe.
  const db = new FakeRcmDb();
  const roland = await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });
  const valley = await reserveRemittanceKey(db, { officeId: 'valley', ...IDENTITY });

  assert.equal(roland.reserved, true);
  assert.equal(valley.reserved, true);
  assert.equal(db.table('rcm_remittance_keys').length, 2);
});

test('finalize marks the key posted and links the batch it produced', async () => {
  const db = new FakeRcmDb();
  await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });
  await finalizeRemittanceKey(db, {
    officeId: 'roland',
    remittanceKey: IDENTITY.remittanceKey,
    batchId: 'batch-1',
  });

  const [row] = db.table('rcm_remittance_keys');
  assert.equal(row.status, 'posted');
  assert.equal(row.batch_id, 'batch-1');

  // The link is what lets the NEXT upload refuse by naming what already exists.
  const seen = await checkRemittanceProcessed(db, {
    officeId: 'roland',
    remittanceKey: IDENTITY.remittanceKey,
  });
  assert.equal(seen.alreadyProcessed, true);
  assert.equal(seen.batchId, 'batch-1');
});

test('a finalized key blocks forever — there is no override', async () => {
  const db = new FakeRcmDb();
  await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });
  await finalizeRemittanceKey(db, { officeId: 'roland', remittanceKey: IDENTITY.remittanceKey, batchId: 'b1' });

  const retry = await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });
  assert.equal(retry.reserved, false);
  assert.equal(retry.status, 'posted');
  assert.equal(retry.batchId, 'b1');
});

test('release returns a reservation to retryable, and reserve takes it back over', async () => {
  const db = new FakeRcmDb();
  await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });

  assert.equal(
    await releaseRemittanceKey(db, { officeId: 'roland', remittanceKey: IDENTITY.remittanceKey }),
    true
  );
  assert.equal(db.table('rcm_remittance_keys')[0].status, 'failed');
  // A released key is not "already processed" — it is a run that did nothing.
  assert.equal(
    (await checkRemittanceProcessed(db, { officeId: 'roland', remittanceKey: IDENTITY.remittanceKey }))
      .alreadyProcessed,
    false
  );

  const retry = await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });
  assert.equal(retry.reserved, true);
  assert.equal(db.table('rcm_remittance_keys')[0].status, 'pending');
  assert.equal(db.table('rcm_remittance_keys').length, 1, 'taken over, not duplicated');
});

test('release can never un-post a finalized key', async () => {
  const db = new FakeRcmDb();
  await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });
  await finalizeRemittanceKey(db, { officeId: 'roland', remittanceKey: IDENTITY.remittanceKey, batchId: 'b1' });

  // The UPDATE re-asserts status = 'pending' in its own WHERE, so a stray
  // release after a successful post is a no-op rather than an unlock.
  assert.equal(
    await releaseRemittanceKey(db, { officeId: 'roland', remittanceKey: IDENTITY.remittanceKey }),
    false
  );
  assert.equal(db.table('rcm_remittance_keys')[0].status, 'posted');
});

test('release is office-scoped — it cannot reach the other office', async () => {
  const db = new FakeRcmDb();
  await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });
  await reserveRemittanceKey(db, { officeId: 'valley', ...IDENTITY });

  await releaseRemittanceKey(db, { officeId: 'roland', remittanceKey: IDENTITY.remittanceKey });

  const rows = db.table('rcm_remittance_keys');
  assert.equal(rows.find((r) => r.office_id === 'roland').status, 'failed');
  assert.equal(rows.find((r) => r.office_id === 'valley').status, 'pending');
});

test('checkRemittanceProcessed does not see the other office at all', async () => {
  const db = new FakeRcmDb();
  await reserveRemittanceKey(db, { officeId: 'roland', ...IDENTITY });
  await finalizeRemittanceKey(db, { officeId: 'roland', remittanceKey: IDENTITY.remittanceKey, batchId: 'b1' });

  assert.equal(
    (await checkRemittanceProcessed(db, { officeId: 'valley', remittanceKey: IDENTITY.remittanceKey }))
      .alreadyProcessed,
    false
  );
});
