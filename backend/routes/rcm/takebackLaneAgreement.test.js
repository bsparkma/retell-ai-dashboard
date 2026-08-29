'use strict';

/**
 * THE LANE PREDICATE MUST BE HANDED THE SAME EVIDENCE BY BOTH OF ITS CALLERS.
 *
 * `claimMatch.isTakeback` reads TWO amounts and ORs them: the claim's own
 * `total_paid_cents`, and what the batch says this claim moved
 * (`rcm_batch_claim_payments.paid_cents`). Either being negative is a takeback.
 *
 * `approvalGate.isRecoupment` has always passed both. `matchService` passed only
 * the first — so a claim whose own total was not negative while the batch row
 * WAS would be matched on the payment lane and judged on the takeback lane:
 *
 *   match  -> snapshot.takeback = false   (asked the payment question)
 *   gate   -> isRecoupment = true         (saw the negative batch row)
 *   gate   -> MATCH_TAKEN_FOR_A_TAKEBACK fails: "re-run the match"
 *   biller -> re-runs the match
 *   match  -> reads the same non-negative claim total -> false again
 *
 * A refusal whose own instructions cannot clear it is a loop, not a gate — and
 * it is the SAME class of bug as the one PR #121 fixed, one join further out.
 *
 * Two kinds of test, two different jobs:
 *
 *   1. The corpus pin — for every 835 in the fixture corpus, the two amounts
 *      agree in sign for every claim. This is the property that makes the loop
 *      UNREACHABLE today.
 *   2. The divergence tests — with the two amounts forced apart, the match still
 *      takes the takeback lane. This is what makes the loop IMPOSSIBLE, rather
 *      than merely unreachable.
 *
 * The first can be broken by a future ingest change without anyone noticing.
 * That is exactly why the second exists.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const claimMatch = require('../../services/rcm/claimMatch');
const { FakeRcmDb, FakeOd, bootRcmApp, api, filePart, fixture835 } = require('./rcmTestUtils');

const EDI = 'application/edi-x12';
const Q = '?office=roland';
const json = (body) => ({ body: JSON.stringify(body), json: true });

async function withApp(opts, fn) {
  const app = await bootRcmApp(opts);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'rcm');

/** Every 835 in the corpus, so a new fixture is covered the day it lands. */
function everyFixture() {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.edi'))
    .sort();
}

const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);

// ─── 1. The ingest invariant, across the whole corpus ────────────────────────

test('every 835 in the corpus writes the claim total and the batch row with the SAME sign', async () => {
  /*
   * `eraIngest.writeClaim` binds `claim.totalPaidCents` into BOTH inserts, in
   * one transaction, from one in-memory object — so they cannot disagree. This
   * asserts the consequence rather than the implementation, over every file we
   * have, including the reversal.
   *
   * A file that fails to ingest is skipped, not failed: the corpus deliberately
   * contains malformed files, and their parse behaviour is era.test.js's job.
   */
  const names = everyFixture();
  assert.ok(names.length >= 10, `expected a real corpus, got ${names.length}`);

  let claimsChecked = 0;
  let negativesSeen = 0;

  for (const name of names) {
    await withApp({}, async (app) => {
      const res = await api(app.baseUrl, 'POST', `/api/rcm/era${Q}`, {
        body: filePart(Buffer.from(fixture835(name)), name, EDI),
      });
      // 201 is the success shape (`/api/rcm/era` CREATES an upload). Anything
      // else is a file the corpus keeps precisely because it does not parse —
      // era.test.js owns that behaviour, not this test.
      if (res.status !== 201) return;

      const payments = new Map(
        app.db.table('rcm_batch_claim_payments').map((p) => [p.claim_id, p])
      );

      for (const claim of app.db.table('rcm_claims')) {
        const payment = payments.get(claim.claim_id);
        assert.ok(payment, `${name}: claim ${claim.claim_number} has no batch payment row`);

        assert.equal(
          sign(Number(claim.total_paid_cents)),
          sign(Number(payment.paid_cents)),
          `${name}: claim ${claim.claim_number} — total_paid_cents ` +
            `${claim.total_paid_cents} disagrees in sign with paid_cents ${payment.paid_cents}`
        );

        // And the lane predicate reaches the same verdict from either amount
        // alone, which is the property the match used to depend on silently.
        assert.equal(
          claimMatch.isTakeback({ totalPaidCents: Number(claim.total_paid_cents) }),
          claimMatch.isTakeback({ paidCents: Number(payment.paid_cents) }),
          `${name}: claim ${claim.claim_number} — the two amounts imply different lanes`
        );

        claimsChecked += 1;
        if (Number(claim.total_paid_cents) < 0) negativesSeen += 1;
      }
    });
  }

  assert.ok(claimsChecked > 0, 'no claim was checked — the corpus walk did nothing');
  // The reversal fixture must be among them, or this pins only the happy sign.
  assert.ok(
    negativesSeen > 0,
    'no NEGATIVE claim was checked — Test_Reversal_Recoupment did not ingest'
  );
});

// ─── 2. Divergence: the loop must be impossible, not merely unreachable ──────

const CLAIM_ID = 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d';
const BATCH_ID = '8acb0e32-35ae-5cd8-9692-7b5e318a31c2';

/** A posted chart: the claim is Received and its line carries insurance money. */
function postedOd() {
  return new FakeOd({
    patients: [{ PatNum: 12828, LName: 'Test', FName: 'MangoTest', Birthdate: '1990-01-01' }],
    claims: [
      {
        ClaimNum: 53648,
        PatNum: 12828,
        DateService: '2026-03-02',
        ClaimFee: 210.0,
        ClaimStatus: 'R',
      },
    ],
    claimProcs: [
      {
        ClaimProcNum: 99001,
        ClaimNum: 53648,
        ProcNum: 8801,
        Status: 'Received',
        FeeBilled: 210.0,
        InsPayAmt: 150.0,
        WriteOff: 0,
        DedApplied: 0,
        IsTransfer: false,
        ClaimPaymentNum: 21424,
      },
    ],
    procedures: [
      { ProcNum: 8801, PatNum: 12828, procCode: 'D0150', ProcStatus: 'C', ProcFee: 210.0 },
    ],
  });
}

/**
 * The seed, with the two amounts settable INDEPENDENTLY — which is the whole
 * point. `seed()` in workbench.test.js binds them together, correctly, because
 * that is what ingest produces.
 */
function seedDivergent(db, { totalPaidCents, batchPaidCents }) {
  db.seed('rcm_payment_batches', [
    {
      batch_id: BATCH_ID,
      office_id: 'roland',
      payer: 'CAREIN SYNTHETIC PAYER',
      check_number: '830200001',
      eft_number: null,
      trace_number: '830200001',
      payment_method: 'check',
      deposit_date: '2026-03-02',
      total_amount_cents: totalPaidCents,
      posted_amount_cents: 0,
      plb_total_cents: 0,
      plb_adjustments: [],
      claim_count: 1,
      status: 'ready',
      era_file_key: 'tenant/carein/rcm/era/k1.edi',
      notes: '',
      created_by: null,
      created_at: new Date('2026-03-02T10:00:00Z'),
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: CLAIM_ID,
      office_id: 'roland',
      claim_number: '53648',
      check_number: '830200001',
      patient_name: 'Test, MangoTest',
      od_patient_id: null,
      od_claim_num: null,
      payer: 'CAREIN SYNTHETIC PAYER',
      service_date: '2026-03-02',
      received_date: '2026-03-02',
      status: 'pending_review',
      payment_status: 'unpaid',
      insurance_type: 'primary',
      total_billed_cents: 21000,
      total_allowed_cents: 15000,
      total_paid_cents: totalPaidCents,
      total_deductible_cents: 0,
      patient_balance_cents: 0,
      needs_review_reasons: [],
      confidence: 95,
      od_match_status: 'not_run',
      od_match_snapshot: null,
      od_match_at: null,
      od_match_confirmed_at: null,
      od_matched_by: null,
      reviewed_at: null,
      reviewed_by: null,
      review_note: null,
      created_at: new Date('2026-03-02T10:00:00Z'),
    },
  ]);
  db.seed('rcm_batch_claim_payments', [
    {
      batch_claim_payment_id: '5f46bb33-d78e-573d-87a6-bb42a7bd7478',
      batch_id: BATCH_ID,
      claim_id: CLAIM_ID,
      office_id: 'roland',
      position: 1,
      paid_cents: batchPaidCents,
    },
  ]);
  db.seed('rcm_procedure_lines', [
    {
      line_id: 'a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90',
      claim_id: CLAIM_ID,
      office_id: 'roland',
      position: 1,
      billed_code: 'D0150',
      paid_code: null,
      code: 'D0150',
      description: 'Comprehensive oral evaluation',
      billed_cents: 21000,
      allowed_cents: 15000,
      deductible_cents: 0,
      copay_cents: 0,
      paid_cents: batchPaidCents,
      patient_resp_cents: 0,
      write_off_cents: 0,
      service_date: '2026-03-02',
      od_claim_proc_num: null,
      od_proc_num: null,
      created_at: new Date('2026-03-02T10:00:00Z'),
    },
  ]);
  return db;
}

test('the batch row alone puts the match on the takeback lane — the claim total need not be negative', async () => {
  /*
   * THE LOOP, REPRODUCED. Claim total 0, batch row -100. Before this fix the
   * snapshot came back `takeback: false`, and the gate then refused a snapshot
   * whose only remedy was to take it again the same way.
   */
  const db = seedDivergent(new FakeRcmDb(), { totalPaidCents: 0, batchPaidCents: -10000 });
  await withApp({ db, od: postedOd() }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/${CLAIM_ID}/match${Q}`, json({}));
    assert.equal(res.status, 200);
    assert.equal(
      res.body.snapshot.takeback,
      true,
      'the match ignored the batch row and asked the payment question'
    );
  });
});

test('and the claim total alone still does, with no batch row at all', async () => {
  // The original lane signal must keep working when the new one is absent —
  // `null` is "no batch row", never "the batch moved nothing".
  const db = seedDivergent(new FakeRcmDb(), { totalPaidCents: -10000, batchPaidCents: -10000 });
  db.table('rcm_batch_claim_payments').length = 0;
  await withApp({ db, od: postedOd() }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/${CLAIM_ID}/match${Q}`, json({}));
    assert.equal(res.status, 200);
    assert.equal(res.body.snapshot.takeback, true);
  });
});

test('an ordinary payment is untouched by the extra amount — both non-negative stays the payment lane', async () => {
  const db = seedDivergent(new FakeRcmDb(), { totalPaidCents: 15000, batchPaidCents: 15000 });
  await withApp({ db, od: postedOd() }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/${CLAIM_ID}/match${Q}`, json({}));
    assert.equal(res.status, 200);
    assert.equal(res.body.snapshot.takeback, false);
  });
});

test('the takeback MAGNITUDE follows the gate precedence: the batch row, not the claim total', async () => {
  /*
   * `approvalGate` measures against `payment ? payment.paidCents :
   * claim.totalPaidCents`. `TAKEBACK_EXCEEDS_PAYMENT` is computed at match time
   * against the same number, or the two disagree about what "covers it" means.
   * The chart line carries $150 and the batch takes back $100, so it is covered
   * — but only if the magnitude came from the batch row. Read from the claim
   * total it would be 0, and "a takeback of nothing" is not a question the
   * coverage check can answer honestly.
   */
  const db = seedDivergent(new FakeRcmDb(), { totalPaidCents: 0, batchPaidCents: -10000 });
  await withApp({ db, od: postedOd() }, async (app) => {
    const { body } = await api(app.baseUrl, 'POST', `/api/rcm/claims/${CLAIM_ID}/match${Q}`, json({}));
    // Assert the LANE first. Without it this test passes vacuously on a build
    // that never reaches the takeback lane at all: the coverage check is not
    // computed on the payment lane, so "no TAKEBACK_EXCEEDS_PAYMENT" would be
    // true for the wrong reason.
    assert.equal(body.snapshot.takeback, true, 'not on the takeback lane — nothing to measure');
    const [candidate] = body.snapshot.candidates;
    assert.ok(candidate, 'the takeback lane found no candidate to reverse');
    const codes = (candidate.blockers || []).map((b) => b.code);
    assert.ok(
      !codes.includes('TAKEBACK_EXCEEDS_PAYMENT'),
      `a $100 takeback against a $150 paid line must be covered, got ${codes.join(', ')}`
    );
  });
});

test('both callers of isTakeback pass BOTH amounts — the asymmetry that caused this cannot return', () => {
  /*
   * A source pin, deliberately. The behavioural tests above only catch the
   * regression when a fixture happens to diverge; this catches a caller quietly
   * dropping the second amount again, which is exactly how the bug arrived.
   */
  for (const file of ['matchService.js', 'approvalGate.js']) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const call = src.match(/isTakeback\(\{[\s\S]{0,800}?\}\)/);
    assert.ok(call, `${file}: no isTakeback call found`);
    assert.match(call[0], /totalPaidCents\s*:/, `${file}: isTakeback call omits totalPaidCents`);
    assert.match(call[0], /paidCents\s*:/, `${file}: isTakeback call omits the batch paidCents`);
  }
});
