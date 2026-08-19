'use strict';

/**
 * The review workbench, end to end through the REAL /api/rcm stack.
 *
 * Booted the way server.js assembles it — auth gate → tenantContext →
 * requireModule('rcm') → requireReadWrite → the real router — so mount order,
 * office scoping and the permission split are under test rather than assumed.
 * A test that called a handler directly would pass with `requireOffice` deleted
 * from index.js.
 *
 * The claims here, in order of how much they matter:
 *
 *  1. Nothing auto-decides. A match produces candidates; only a human
 *     confirming moves `od_claim_num` off NULL.
 *  2. `no_candidate` is a stored, visible outcome and NOT the same as `not_run`.
 *  3. One audit row per PHI read, whatever the Open Dental fan-out cost.
 *  4. Office is a boundary: another practice's remittance is NOT FOUND.
 *  5. D-5 upserts rcm_user_map on the first attributed action, and reuses it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeRcmDb, FakeOd, bootRcmApp, api, auditRows } = require('./rcmTestUtils');

// ─── Fixtures — synthetic, per the repo's no-real-patient-data rule ──────────

const OD_PATIENT = { PatNum: 12828, LName: 'Fixture', FName: 'Synthetic', Birthdate: '1990-01-01' };

function odFixture(over = {}) {
  return new FakeOd({
    patients: [OD_PATIENT],
    claims: [
      { ClaimNum: 53648, PatNum: 12828, DateService: '2026-03-02', ClaimFee: 210.0, ClaimStatus: 'S' },
    ],
    claimProcs: [
      {
        ClaimProcNum: 99001,
        ClaimNum: 53648,
        ProcNum: 8801,
        Status: 'NotReceived',
        FeeBilled: 210.0,
        InsPayAmt: 0,
        WriteOff: 0,
        DedApplied: 0,
        IsTransfer: false,
        ClaimPaymentNum: 0,
      },
    ],
    procedures: [{ ProcNum: 8801, PatNum: 12828, procCode: 'D0150', ProcStatus: 'C', ProcFee: 210.0 }],
    ...over,
  });
}

/** One batch, one claim, one line, one upload — the shape an 835 produces. */
function seed(db, over = {}) {
  const office = over.office || 'roland';
  db.seed('rcm_payment_batches', [
    {
      batch_id: over.batchId || '8acb0e32-35ae-5cd8-9692-7b5e318a31c2',
      office_id: office,
      payer: 'DELTA DENTAL OF ARKANSAS',
      check_number: '830200001',
      eft_number: null,
      trace_number: '830200001',
      payment_method: 'check',
      deposit_date: '2026-03-02',
      total_amount_cents: 15000,
      posted_amount_cents: 0,
      plb_total_cents: 0,
      plb_adjustments: [],
      claim_count: 1,
      status: over.batchStatus || 'ready',
      era_file_key: 'tenant/carein/rcm/era/k1.edi',
      notes: '',
      created_by: null,
      created_at: new Date('2026-03-02T10:00:00Z'),
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: over.claimId || 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d',
      office_id: office,
      claim_number: '53648',
      check_number: '830200001',
      patient_name: 'Fixture, Synthetic',
      od_patient_id: null,
      od_claim_num: null,
      payer: 'DELTA DENTAL OF ARKANSAS',
      service_date: '2026-03-02',
      received_date: '2026-03-02',
      status: 'pending_review',
      payment_status: 'unpaid',
      insurance_type: 'primary',
      total_billed_cents: 21000,
      total_allowed_cents: 15000,
      total_paid_cents: 15000,
      total_deductible_cents: 0,
      patient_balance_cents: 0,
      needs_review_reasons: over.reviewReasons || [],
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
      batch_id: over.batchId || '8acb0e32-35ae-5cd8-9692-7b5e318a31c2',
      claim_id: over.claimId || 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d',
      office_id: office,
      position: 1,
      // What the remittance says this claim moved. It must equal the claim's own
      // total and the sum of its lines — Slice 6b's gate refuses when the three
      // disagree, so a fixture that leaves it unset is an inconsistent fixture.
      paid_cents: 15000,
    },
  ]);
  db.seed('rcm_procedure_lines', [
    {
      line_id: 'a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90',
      claim_id: over.claimId || 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d',
      office_id: office,
      position: 1,
      billed_code: 'D0150',
      paid_code: null,
      code: 'D0150',
      description: 'Comprehensive oral evaluation',
      billed_cents: 21000,
      allowed_cents: 15000,
      deductible_cents: 0,
      copay_cents: 0,
      paid_cents: 15000,
      adjustment_cents: 6000,
      patient_resp_cents: 0,
      write_off_cents: 6000,
      adjustment_reason: null,
      is_downcoded: false,
      is_bundled: false,
      is_denied: false,
      flags: over.lineFlags || [],
      od_claim_proc_num: null,
    },
  ]);
  db.seed('rcm_procedure_adjustments', [
    {
      adjustment_id: 'f448f6a4-77e4-5070-8a44-8fe4968caa77',
      procedure_line_id: 'a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90',
      claim_id: over.claimId || 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d',
      office_id: office,
      group_code: 'CO',
      reason_code: '45',
      // Slice 5 fills this from the shared table; the RARC description below is
      // the one that had NO source of data before Slice 6a.
      reason_description: 'Charge exceeds fee schedule/maximum allowable',
      amount_cents: 6000,
      quantity: 1,
      remark_code: 'N19',
      remark_description: '',
    },
  ]);
  db.seed('rcm_eob_uploads', [
    {
      upload_id: '57c97173-8178-5976-997e-9de296795b28',
      office_id: office,
      filename: 'delta_fixture_multiclaim.edi',
      file_key: 'tenant/carein/rcm/era/k1.edi',
      file_url: '',
      status: 'extracted',
      uploaded_at: new Date('2026-03-02T10:00:00Z'),
      uploaded_by: null,
      result_batch_id: null,
    },
  ]);
  return db;
}

/** Boot, run, close. */
/**
 * A SECOND claim on the same remittance.
 *
 * Deliberately minimal: the tests that need it are about how many rows a RUN
 * produces and which claim a bounded run reaches first, and both of those are
 * unanswerable on a one-claim fixture.
 */
function addSecondClaim(db, over = {}) {
  const first = db.table('rcm_claims')[0];
  db.seed('rcm_claims', [
    {
      ...first,
      claim_id: over.claimId || 'ae21fad8-8cbb-5424-9780-b30be1cf31c9',
      claim_number: '53712',
      patient_name: 'Sample, Placeholder',
      od_match_status: 'not_run',
      od_match_snapshot: null,
      od_match_at: null,
    },
  ]);
  db.seed('rcm_batch_claim_payments', [
    {
      batch_claim_payment_id: 'aa0f152d-3a6e-58aa-aa86-89bbf4b3af17',
      batch_id: '8acb0e32-35ae-5cd8-9692-7b5e318a31c2',
      claim_id: over.claimId || 'ae21fad8-8cbb-5424-9780-b30be1cf31c9',
      office_id: first.office_id,
      position: 2,
      paid_cents: 0,
    },
  ]);
  return db;
}

async function withApp(opts, fn) {
  const app = await bootRcmApp(opts);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

const Q = '?office=roland';
const json = (body) => ({ body: JSON.stringify(body), json: true });

// ─── The remittance list ─────────────────────────────────────────────────────

test('the list returns the office\'s remittances with a computed balance check', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.remittances.length, 1);

    const r = res.body.remittances[0];
    assert.equal(r.payer, 'DELTA DENTAL OF ARKANSAS');
    assert.equal(r.checkNumber, '830200001');
    assert.equal(r.totalAmountCents, 15000);
    // The batch total against the sum of what its claims were paid. They agree
    // here, which is the state the screen paints green.
    assert.equal(r.balance.claimTotalCents, 15000);
    assert.equal(r.balance.differenceCents, 0);
    assert.equal(r.balance.balanced, true);
    // '835' vs 'eob' is not cosmetic: an 835 is PARSED and can only be
    // malformed, an EOB PDF was READ by a model and can be WRONG.
    assert.equal(r.source, '835');
    assert.equal(r.upload.filename, 'delta_fixture_multiclaim.edi');
  });
});

test('an unbalanced remittance reports the difference, not just a false flag', async () => {
  const db = seed(new FakeRcmDb());
  db.table('rcm_payment_batches')[0].total_amount_cents = 20000;
  await withApp({ db }, async (app) => {
    const { body } = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    const { balance } = body.remittances[0];
    assert.equal(balance.balanced, false);
    // The number a biller chases, not merely the fact that there is one.
    assert.equal(balance.differenceCents, 5000);
  });
});

test('a PLB explains a batch/claim difference rather than being counted as an error', async () => {
  // Provider-level money belongs to no single claim, so it is a LEGITIMATE
  // reason for the two totals to differ.
  const db = seed(new FakeRcmDb());
  const batch = db.table('rcm_payment_batches')[0];
  batch.total_amount_cents = 10800;
  batch.plb_total_cents = -4200;
  await withApp({ db }, async (app) => {
    const { body } = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.equal(body.remittances[0].balance.balanced, true);
    assert.equal(body.remittances[0].balance.plbTotalCents, -4200);
  });
});

test('needs-attention is computed server-side, so the list and the detail agree', async () => {
  const db = seed(new FakeRcmDb(), { reviewReasons: ['reversal_not_postable'] });
  await withApp({ db }, async (app) => {
    const { body } = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    const r = body.remittances[0];
    assert.equal(r.needsAttention, true);
    // The OBLIGATION is the unreviewed claim. The flag and the missing match
    // are facts about the file — read them, but they are not work.
    assert.deepEqual(r.attentionReasons, ['claims_unreviewed']);
    assert.ok(r.attentionObservations.includes('claims_flagged'));
    assert.ok(r.attentionObservations.includes('claims_unmatched'));
    assert.equal(r.reviewReasonCount, 1);
    assert.equal(body.needsAttentionCount, 1);
  });
});

test('a batch held open by a flag is SHOWN as open, but that is not work', async () => {
  /*
   * Slice 5's contract: `open` means SOMETHING was flagged — a reversal, a PLB,
   * a downcode, an unreadable adjustment. Nearly every real 835 carries one, so
   * `batch_open` on its own can never be the thing that holds a remittance in
   * the queue: if it were, nothing would ever leave, which is exactly what
   * happened on staging. Posting is what moves it, and posting is 6b.
   */
  const db = seed(new FakeRcmDb(), { batchStatus: 'open' });
  Object.assign(db.table('rcm_claims')[0], {
    reviewed_at: new Date(),
    reviewed_by: 'billing@carein.ai',
  });
  await withApp({ db }, async (app) => {
    const { body } = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    const r = body.remittances[0];
    assert.ok(r.attentionObservations.includes('batch_open'), 'still visible');
    assert.deepEqual(r.attentionReasons, [], 'and still not an obligation');
    assert.equal(r.needsAttention, false);
    assert.equal(body.needsAttentionCount, 0);
  });
});

test('a reviewed, confirmed remittance now owes an APPROVAL (Slice 6b)', async () => {
  /*
   * WHAT CHANGED, AND WHY IT IS NOT THE 6a BUG COMING BACK.
   *
   * Under Slice 6a this remittance left the queue: a biller had done everything
   * the screen let her do. Slice 6b gives the screen one more thing to do, so
   * "confirmed and reviewed and nobody has approved it" is now an outstanding
   * ACTION rather than a permanent fact — which is the D-12 rule working, not
   * the crying-wolf failure repeating. The difference is that a human can
   * discharge this one by pressing a button.
   */
  const db = seed(new FakeRcmDb());
  Object.assign(db.table('rcm_claims')[0], {
    od_match_status: 'confirmed',
    od_claim_num: 53648,
    reviewed_at: new Date(),
    reviewed_by: 'billing@carein.ai',
  });
  await withApp({ db }, async (app) => {
    const { body } = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.equal(body.remittances[0].needsAttention, true);
    assert.deepEqual(body.remittances[0].attentionReasons, ['claims_awaiting_approval']);
    assert.equal(body.needsAttentionCount, 1);
  });
});

test('and once it is APPROVED it leaves the view — queued is an observation', async () => {
  /*
   * The other half. A queued claim owes nothing to any human: the system owes
   * the next step. It becomes an obligation again only when 6c fails a row and
   * has somewhere to say so.
   */
  const db = seed(new FakeRcmDb());
  Object.assign(db.table('rcm_claims')[0], {
    od_match_status: 'confirmed',
    od_claim_num: 53648,
    reviewed_at: new Date(),
    reviewed_by: 'billing@carein.ai',
    posting_queue_id: '9a0d5b6c-1111-4111-8111-111111111111',
    approved_at: new Date(),
    approved_by: 'billing@carein.ai',
  });
  db.seed('rcm_posting_queue', [
    {
      queue_id: '9a0d5b6c-1111-4111-8111-111111111111',
      office_id: 'roland',
      batch_id: '8acb0e32-35ae-5cd8-9692-7b5e318a31c2',
      remittance_key: 'K',
      status: 'approved',
    },
  ]);
  await withApp({ db }, async (app) => {
    const { body } = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.equal(body.remittances[0].needsAttention, false);
    assert.deepEqual(body.remittances[0].attentionReasons, []);
    assert.ok(body.remittances[0].attentionObservations.includes('claims_queued'));
    assert.equal(body.remittances[0].queuedClaimCount, 1);
    assert.equal(body.needsAttentionCount, 0);
  });
});

test('REVIEWING a flagged, unmatched batch is what clears it — the staging walk', async () => {
  /*
   * The bug, end to end. Beau opened the Delta multi-claim batch, ran the match
   * on both claims (honest `no_candidate` — the fixture PatNums do not exist in
   * that database), read the flags, marked both claims reviewed with a note,
   * went back to the list, and the batch was still there.
   *
   * Every condition below is the one he actually had: batch `open` over a
   * downcode and an unreadable CAS, both claims carrying review reasons
   * forever, neither claim confirmable because Open Dental has no such claim.
   * The only thing a human could change was the review stamp, and it cleared
   * one of four reasons.
   */
  const db = seed(new FakeRcmDb(), {
    batchStatus: 'open',
    reviewReasons: ['downcoded_line', 'unreadable_adjustment'],
  });
  addSecondClaim(db);
  for (const claim of db.table('rcm_claims')) {
    claim.od_match_status = 'no_candidate';
    claim.needs_review_reasons = ['downcoded_line'];
  }

  await withApp({ db }, async (app) => {
    const before = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.equal(before.body.remittances[0].needsAttention, true);
    assert.deepEqual(before.body.remittances[0].attentionReasons, ['claims_unreviewed']);
    assert.equal(before.body.needsAttentionCount, 1);

    // One of two reviewed: still owed.
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/review${Q}`, json({ note: 'Downcode is correct.' }));
    const half = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.equal(half.body.remittances[0].needsAttention, true, 'one claim still owes a disposition');

    // Both reviewed: nothing left that a human can do in this slice.
    await api(app.baseUrl, 'POST', `/api/rcm/claims/ae21fad8-8cbb-5424-9780-b30be1cf31c9/review${Q}`, json({ note: 'Carrier owes a corrected EOB.' }));
    const after = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    const r = after.body.remittances[0];

    assert.equal(r.needsAttention, false, 'she did everything the screen lets her do');
    assert.deepEqual(r.attentionReasons, []);
    assert.equal(after.body.needsAttentionCount, 0, 'and the count agrees with the predicate');

    // WHAT SHE SAW IS STILL ON THE SCREEN. Leaving the queue is not the same as
    // the facts going away — the chips are how the next person knows this
    // remittance was worth reading.
    assert.ok(r.attentionObservations.includes('batch_open'));
    assert.ok(r.attentionObservations.includes('claims_flagged'));
    assert.ok(r.attentionObservations.includes('claims_unmatched'));
    assert.equal(r.reviewReasonCount, 2);
    assert.equal(r.unmatchedClaimCount, 2);
    assert.equal(r.status, 'open', 'and the batch is still honestly open');
  });
});

test('a claim with nothing wrong with it STILL owes an explicit review', async () => {
  // No auto-review. A biller marking "looked, nothing to do" is real work, and
  // the audit row is what proves it happened.
  const db = seed(new FakeRcmDb(), { batchStatus: 'ready' });
  Object.assign(db.table('rcm_claims')[0], {
    od_match_status: 'confirmed',
    od_claim_num: 53648,
    needs_review_reasons: [],
  });
  await withApp({ db }, async (app) => {
    const { body } = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.equal(body.remittances[0].needsAttention, true);
    assert.deepEqual(body.remittances[0].attentionReasons, ['claims_unreviewed']);
    assert.deepEqual(body.remittances[0].attentionObservations, []);
  });
});

test('a remittance with NO claims is unworkable, not finished', async () => {
  /*
   * "Every claim is reviewed" is vacuously true of an empty list. Without its
   * own reason, an 835 that produced a payment batch and no claim rows would
   * read as done the moment it landed — the same failure as the one this fix
   * exists for, pointing the other way: silence where somebody should look.
   */
  const db = seed(new FakeRcmDb());
  db.table('rcm_claims').length = 0;
  db.table('rcm_batch_claim_payments').length = 0;
  await withApp({ db }, async (app) => {
    const { body } = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.equal(body.remittances[0].needsAttention, true);
    assert.deepEqual(body.remittances[0].attentionReasons, ['batch_no_claims']);
  });
});

test('an empty office lists honestly rather than erroring', async () => {
  await withApp({ db: new FakeRcmDb() }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.remittances, []);
    assert.equal(res.body.total, 0);
  });
});

// ─── The remittance detail ───────────────────────────────────────────────────

test('the detail carries lines, CARC codes and — newly — RARC descriptions', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2${Q}`);
    assert.equal(res.status, 200);

    const [claim] = res.body.claims;
    assert.equal(claim.patientName, 'Fixture, Synthetic');
    const [line] = claim.lines;
    const [adj] = line.adjustments;

    assert.equal(adj.groupCode, 'CO');
    // The group is the most consequential field on an adjustment: CO is a
    // write-off the practice absorbs, PR is money the patient owes.
    assert.match(adj.groupDescription, /practice writes this off/);
    assert.equal(adj.reasonCode, '45');
    assert.equal(adj.reasonDescription, 'Charge exceeds fee schedule/maximum allowable');
    // Slice 5 wrote '' here because RARC descriptions had no source of data at
    // all. This is where that finally gets seen — resolved from the INGESTED
    // published list, so the assertion is on substance; the exact string is
    // pinned by the content hash in adjustmentCodes.test.js.
    assert.equal(adj.remarkCode, 'N19');
    assert.match(adj.remarkDescription, /incidental to primary procedure/i);
  });
});

test('the detail links to the source document without ever shipping the blob key', async () => {
  // A key in a response is a key in a browser cache.
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2${Q}`);
    assert.equal(res.body.remittance.upload.documentUrl, '/api/rcm/uploads/57c97173-8178-5976-997e-9de296795b28/document?office=roland');
    assert.ok(!JSON.stringify(res.body).includes('tenant/carein/rcm/era/k1.edi'));
  });
});

test("another office's remittance is NOT FOUND, not refused", async () => {
  // office_id is in the WHERE rather than checked afterwards, which makes a
  // cross-office read structurally a miss.
  const db = seed(new FakeRcmDb(), { office: 'valley' });
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2${Q}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'REMITTANCE_NOT_FOUND');
  });
});

test('a missing office is a 400 before anything is read', async () => {
  await withApp({ db: seed(new FakeRcmDb()) }, async (app) => {
    const res = await api(app.baseUrl, 'GET', '/api/rcm/remittances');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_OFFICE');
  });
});

// ─── Matching ────────────────────────────────────────────────────────────────

test('a match stores candidates and evidence — and changes NOTHING about the linkage', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'candidates');
    assert.equal(res.body.snapshot.candidates.length, 1);
    assert.equal(res.body.snapshot.candidates[0].odClaimNum, 53648);
    assert.ok(res.body.snapshot.candidates[0].evidence.length > 0);

    const claim = db.table('rcm_claims')[0];
    assert.equal(claim.od_match_status, 'candidates');
    // THE INVARIANT. A match ranks and explains; it never chooses.
    assert.equal(claim.od_claim_num, null);
    assert.equal(claim.od_matched_by, null);
    assert.equal(claim.status, 'pending_review');
    // And the line is not linked either.
    assert.equal(db.table('rcm_procedure_lines')[0].od_claim_proc_num, null);
  });
});

test('the snapshot records what 6c re-verifies against: amounts, line pairs, and when', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    const { body } = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    const [candidate] = body.snapshot.candidates;
    // TWO billed figures, and the difference matters: `billedCents` is the LIVE
    // lines' FeeBilled — what 6c re-verifies against — while the header total
    // still includes soft-deleted procedures (G12). They agree on this fixture
    // because nothing on it is deleted, which is exactly why the CONTAMINATED
    // one has to be named rather than left as "the billed amount".
    assert.equal(candidate.od.billedCents, 21000);
    assert.equal(candidate.od.claimHeaderFeeCents, 21000);
    assert.equal(candidate.linePairs[0].odClaimProcNum, 99001);
    assert.match(body.snapshot.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.snapshot.version, 2);
    assert.equal(body.snapshot.office, 'roland');
  });
});

test('no candidate is a STORED outcome, distinct from never having looked', async () => {
  // "Nobody has checked" and "we checked on Tuesday and Open Dental has nothing"
  // are different facts a biller acts on differently.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'no_candidate');

    const claim = db.table('rcm_claims')[0];
    assert.equal(claim.od_match_status, 'no_candidate');
    assert.notEqual(claim.od_match_status, 'not_run');
    assert.ok(claim.od_match_at instanceof Date, 'the instant we looked is recorded');
  });
});

test('an office with no Open Dental connection refuses honestly, and reads nothing', async () => {
  // The REAL odOffices, with no customer key in the environment. This is the
  // state the shared OD UI renders as "not connected for this office" rather
  // than as a failed match — different problems, different fixes.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: null }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    assert.ok([409, 503].includes(res.status), `unexpected ${res.status}`);
    assert.equal(res.body.code, 'OFFICE_NOT_CONNECTED');
    assert.equal(db.table('rcm_claims')[0].od_match_status, 'not_run');
  });
});

test('an Open Dental outage is a 502 and leaves the claim un-matched, not no_candidate', async () => {
  const db = seed(new FakeRcmDb());
  const od = new FakeOd({ fail: { '/patients': { status: 503, error: 'gateway' } } });
  await withApp({ db, od }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'OD_READ_FAILED');
    assert.equal(db.table('rcm_claims')[0].od_match_status, 'not_run');
  });
});

test('matching a claim that does not exist for this office is a 404', async () => {
  await withApp({ db: seed(new FakeRcmDb()), od: odFixture() }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/nope/match${Q}`, json({}));
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'CLAIM_NOT_FOUND');
  });
});

// ─── Confirming ──────────────────────────────────────────────────────────────

test('confirming links the claim, the patient and every line, and attributes it', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`,
      json({ odClaimNum: 53648 })
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const claim = db.table('rcm_claims')[0];
    assert.equal(claim.od_match_status, 'confirmed');
    assert.equal(claim.od_claim_num, 53648);
    assert.equal(claim.od_patient_id, 12828);
    assert.equal(claim.status, 'matched');
    assert.equal(claim.od_matched_by, 'billing@carein.ai');
    assert.ok(claim.od_match_confirmed_at instanceof Date);
    // The per-line ClaimProcNum is what §8 recovery needs and what Open Dental
    // will not tell us afterwards once a check is attached.
    assert.equal(db.table('rcm_procedure_lines')[0].od_claim_proc_num, 99001);
  });
});

test('D-5: the first attributed action CREATES the rcm_user_map row', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    assert.equal(db.table('rcm_user_map').length, 0);
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`, json({ odClaimNum: 53648 }));

    const rows = db.table('rcm_user_map');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_key, 'billing@carein.ai');
    // The CHECK constraint is `platform_email = lower(platform_email)`, so this
    // is a correctness requirement, not tidiness.
    assert.equal(rows[0].platform_email, 'billing@carein.ai');
    assert.equal(rows[0].display_name, 'Billing User');
    assert.equal(rows[0].office_id, undefined, 'rcm_user_map is tenant-global');
  });
});

test('D-5: a second action REUSES the row rather than minting another', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`, json({ odClaimNum: 53648 }));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/review${Q}`, json({ note: 'checked' }));
    assert.equal(db.table('rcm_user_map').length, 1);
  });
});

test('D-5: an IMPORTED row for the same person is reused under its legacy key', async () => {
  // Minting a second row keyed by email would split one human's attribution
  // across two ids, and nothing downstream could rejoin them.
  const db = seed(new FakeRcmDb());
  db.seed('rcm_user_map', [
    {
      user_key: 'u_7f3a',
      platform_email: 'billing@carein.ai',
      display_name: 'Imported Biller',
      legacy_role: 'poster',
      active: true,
      created_at: new Date('2020-01-01'),
    },
  ]);
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`, json({ odClaimNum: 53648 }));

    assert.equal(db.table('rcm_user_map').length, 1);
    assert.equal(db.table('rcm_claims')[0].od_matched_by, 'u_7f3a');
  });
});

test('confirming without a match first is refused — the ClaimNum must have been READ', async () => {
  // Otherwise this endpoint is a way to write an arbitrary ClaimNum onto a
  // claim nobody ever read from Open Dental — and 6c posts money against it.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`,
      json({ odClaimNum: 53648 })
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NO_MATCH_TO_CONFIRM');
    assert.equal(db.table('rcm_claims')[0].od_claim_num, null);
  });
});

test('confirming a ClaimNum that was not among the candidates is refused', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`,
      json({ odClaimNum: 999999 })
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'CANDIDATE_NOT_FOUND');
    assert.equal(db.table('rcm_claims')[0].od_claim_num, null);
  });
});

test('a missing or nonsense odClaimNum is a 400, not a NULL write', async () => {
  await withApp({ db: seed(new FakeRcmDb()), od: odFixture() }, async (app) => {
    for (const body of [{}, { odClaimNum: 'abc' }, { odClaimNum: 0 }, { odClaimNum: -1 }]) {
      const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`, json(body));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'INVALID_CLAIM_NUM');
    }
  });
});

test('re-running a match over a CONFIRMED claim is refused unless explicitly forced', async () => {
  // Re-run allowed explicitly, never a silent overwrite of somebody's decision.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`, json({ odClaimNum: 53648 }));

    const blocked = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'MATCH_ALREADY_CONFIRMED');
    assert.equal(db.table('rcm_claims')[0].od_claim_num, 53648, 'the decision survived');

    const forced = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({ force: true }));
    assert.equal(forced.status, 200);
    // A forced re-run un-confirms: the linkage was derived from a snapshot that
    // no longer exists, so keeping it would leave a ClaimNum nobody stands behind.
    assert.equal(db.table('rcm_claims')[0].od_claim_num, null);
    assert.equal(db.table('rcm_claims')[0].od_match_status, 'candidates');
  });
});

// ─── Review ──────────────────────────────────────────────────────────────────

test('marking reviewed is attributed and has NO Open Dental effect', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/review${Q}`,
      json({ note: 'Carrier owes a corrected EOB — nothing to post.' })
    );
    assert.equal(res.status, 200);

    const claim = db.table('rcm_claims')[0];
    assert.ok(claim.reviewed_at instanceof Date);
    assert.equal(claim.reviewed_by, 'billing@carein.ai');
    assert.match(claim.review_note, /corrected EOB/);
    // Reviewed is NOT matched — a claim with no chart linkage can still be a
    // finished piece of work.
    assert.equal(claim.od_match_status, 'not_run');
    assert.equal(claim.od_claim_num, null);
    assert.deepEqual(od(app).methodsUsed(), []);
  });
});

/** The FakeOd this app was booted with. */
function od(app) {
  return app.od;
}

test('an over-long note is refused rather than truncated', async () => {
  await withApp({ db: seed(new FakeRcmDb()), od: odFixture() }, async (app) => {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/review${Q}`,
      json({ note: 'x'.repeat(2001) })
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'NOTE_TOO_LONG');
  });
});

test('an empty note stores NULL rather than an empty string', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/review${Q}`, json({ note: '   ' }));
    assert.equal(db.table('rcm_claims')[0].review_note, null);
  });
});

// ─── Batch matching ──────────────────────────────────────────────────────────

test('a batch match reports each claim individually', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/match${Q}`, json({}));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.matched, [
      { claimId: 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d', status: 'candidates', candidateCount: 1, ambiguous: false },
    ]);
    // Pacing is a documented floor, not an env value that can be lowered away.
    assert.ok(res.body.pacingMs >= 1200);
  });
});

test('a batch match writes ONE row for the run and one per CHART', async () => {
  /*
   * The granularity rule platform/odAccess applies — a 25-call treatment plan
   * is one row — is about not writing a row per CALL. A claim is not a call: it
   * is one patient's chart. Two claims here, deliberately, because the previous
   * version of this test ran on a ONE-claim fixture and so could not tell "one
   * row per run" from "one row per claim" at all — it asserted the design it
   * was written against and would have passed under either.
   */
  const db = seed(new FakeRcmDb());
  addSecondClaim(db);
  await withApp({ db, od: odFixture() }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/match${Q}`, json({}));
    assert.equal(res.body.matched.length, 2);

    const run = auditRows(db).filter((r) => r.resource_type === 'rcm_remittance_match');
    assert.equal(run.length, 1, 'the run itself, once');
    assert.equal(run[0].resource_id, '8acb0e32-35ae-5cd8-9692-7b5e318a31c2');

    const charts = auditRows(db).filter((r) => r.resource_type === 'rcm_claim_match');
    assert.deepEqual(
      charts.map((r) => r.resource_id).sort(),
      ['d1e2b359-a8d7-51a8-978c-7adf27bccc8d', 'ae21fad8-8cbb-5424-9780-b30be1cf31c9'].sort()
    );
    for (const row of charts) {
      assert.equal(row.office, 'roland');
      assert.equal(row.result, 'SUCCESS');
    }
  });
});

test('a chart read that failed part way through a BATCH is still recorded', async () => {
  /*
   * `onPhiRead` fires AFTER findClaimCandidates returns. A claim whose
   * /patients call succeeded and whose /claims call then 503'd therefore had
   * names and dates of birth off the wire with nothing recorded — the batch
   * caught the error, wrote `failed`, and moved on. The single-claim route has
   * handled this since the last round; the batch did not.
   */
  const db = seed(new FakeRcmDb());
  const od = odFixture({ fail: { '/claims': { status: 503, error: 'gateway' } } });
  await withApp({ db, od }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/match${Q}`, json({}));
    assert.equal(res.status, 200);
    assert.equal(res.body.matched[0].status, 'failed');

    const charts = auditRows(db).filter((r) => r.resource_type === 'rcm_claim_match');
    assert.equal(charts.length, 1, 'the chart was read; the trail has to say so');
    assert.equal(charts[0].resource_id, 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d');
    assert.equal(charts[0].result, 'ERROR', 'a disclosure that did not complete');
  });
});

test('a budgeted run stops on the CLOCK and says so, unmatched claims first', async () => {
  /*
   * A claim-count cap alone does not bound the request: at >=1.2s per Open
   * Dental CALL a 25-claim remittance is minutes on one held HTTP request, so
   * the client's timeout becomes the normal outcome. The run is bounded to fit
   * the transport instead — and ORDERED so that pressing again reaches the
   * tail rather than redoing the front.
   */
  const db = seed(new FakeRcmDb());
  addSecondClaim(db);
  // d1e2b359-a8d7-51a8-978c-7adf27bccc8d has already been looked at; ae21fad8-8cbb-5424-9780-b30be1cf31c9 has not. Unmatched goes first.
  db.table('rcm_claims')[0].od_match_status = 'no_candidate';

  const original = process.env.RCM_OD_BATCH_MATCH_BUDGET_MS;
  process.env.RCM_OD_BATCH_MATCH_BUDGET_MS = '1';
  try {
    // The module reads the cap at require time, so it has to be re-read here.
    delete require.cache[require.resolve('./matchService')];
    delete require.cache[require.resolve('./remittances')];
    delete require.cache[require.resolve('./index')];
    await withApp({ db, od: odFixture() }, async (app) => {
      const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/match${Q}`, json({}));
      assert.equal(res.status, 200, JSON.stringify(res.body));

      // One claim got in before the budget was spent; the other did not.
      assert.equal(res.body.outOfTime, true, 'the CLOCK stopped it, not the claim cap');
      assert.equal(res.body.matched.length, 1);
      assert.equal(res.body.matched[0].claimId, 'ae21fad8-8cbb-5424-9780-b30be1cf31c9', 'the unmatched claim went first');
      assert.equal(res.body.skipped, 1);
      assert.match(res.body.note, /budget/i);
      assert.match(res.body.note, /run it again/i);
    });
  } finally {
    if (original === undefined) delete process.env.RCM_OD_BATCH_MATCH_BUDGET_MS;
    else process.env.RCM_OD_BATCH_MATCH_BUDGET_MS = original;
    delete require.cache[require.resolve('./matchService')];
    delete require.cache[require.resolve('./remittances')];
    delete require.cache[require.resolve('./index')];
  }
});

test('a batch match on another office\'s remittance is a 404', async () => {
  const db = seed(new FakeRcmDb(), { office: 'valley' });
  await withApp({ db, od: odFixture() }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/match${Q}`, json({}));
    assert.equal(res.status, 404);
  });
});

// ─── Audit ───────────────────────────────────────────────────────────────────

test('every PHI read writes exactly one audit row, and search terms never appear', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2${Q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d${Q}`);
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));

    const rows = auditRows(db);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => r.resource_type), [
      'rcm_remittance',
      'rcm_remittance',
      'rcm_claim',
      'rcm_claim_match',
    ]);
    for (const row of rows) {
      assert.equal(row.action, 'READ');
      assert.equal(row.office, 'roland');
      assert.equal(row.user_id, 'billing@carein.ai');
      // Names are PHI and must not ride into the trail on a list read.
      assert.ok(!JSON.stringify(row).includes('Fixture'));
    }
  });
});

test('an attributed write is audited as an UPDATE naming the claim', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`, json({ odClaimNum: 53648 }));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/review${Q}`, json({ note: 'ok' }));

    const updates = auditRows(db).filter((r) => r.action === 'UPDATE');
    assert.deepEqual(updates.map((r) => r.resource_type), ['rcm_claim_match', 'rcm_claim_review']);
    // resourceId IS stamped here — a claim id we minted, never PHI.
    for (const row of updates) assert.equal(row.resource_id, 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d');
  });
});

// ─── Gates: entitlement, permission, identity ────────────────────────────────

test('a tenant without the rcm module gets MODULE_NOT_ENTITLED on every route', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, modules: ['voice'] }, async (app) => {
    for (const [method, path] of [
      ['GET', `/api/rcm/remittances${Q}`],
      ['GET', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2${Q}`],
      ['GET', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d${Q}`],
      ['POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`],
      ['POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`],
      ['POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/review${Q}`],
      ['POST', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/match${Q}`],
      ['GET', `/api/rcm/uploads/57c97173-8178-5976-997e-9de296795b28/document${Q}`],
    ]) {
      const res = await api(app.baseUrl, method, path, method === 'GET' ? {} : json({}));
      assert.equal(res.status, 403, `${method} ${path}`);
      // The code arrives in `error`, not `code` — the platform's existing shape.
      assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
    }
  });
});

test('a search that found claims and REJECTED them all does not read as an empty search', async () => {
  /*
   * MUST-FIX from review: `no_candidate` means "a search ran against this
   * office's Open Dental and found nothing". A run that examined three claims
   * and disqualified all three has the same empty candidate list — so without
   * the rejection counts reaching the snapshot, the biller is told the chart
   * has no such claim when the chart had claims we chose not to offer.
   */
  const db = seed(new FakeRcmDb());
  // Same patient, but a claim from another visit: different date, different
  // code, different money. Real, and correctly not offered.
  const od = odFixture({
    claims: [
      { ClaimNum: 70001, PatNum: 12828, DateService: '2025-01-05', ClaimFee: 50.0, ClaimStatus: 'S' },
    ],
    claimProcs: [
      {
        ClaimProcNum: 88001,
        ClaimNum: 70001,
        ProcNum: 7701,
        Status: 'NotReceived',
        FeeBilled: 50.0,
        InsPayAmt: 0,
        WriteOff: 0,
        DedApplied: 0,
        IsTransfer: false,
        ClaimPaymentNum: 0,
      },
    ],
    procedures: [{ ProcNum: 7701, PatNum: 12828, procCode: 'D2740', ProcStatus: 'C' }],
  });

  await withApp({ db, od }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'no_candidate');

    const snap = res.body.snapshot;
    assert.equal(snap.candidates.length, 0);
    assert.equal(snap.rejectedCandidates, 1, 'the claim we examined must be counted');
    assert.equal(snap.rejectedReasons.belowScore, 1);
    assert.equal(snap.rejectedReasons.nameMismatch, 0);
    assert.equal(snap.minScore, 15);

    // And it survives to the read the panel actually renders from.
    const detail = await api(app.baseUrl, 'GET', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d${Q}`);
    assert.equal(detail.body.claim.matchSnapshot.rejectedCandidates, 1);
    assert.deepEqual(detail.body.claim.matchSnapshot.rejectedReasons, {
      nameMismatch: 0,
      belowScore: 1,
    });
  });
});

test('a search that found genuinely nothing says zero rejections', async () => {
  // The other half of the pair: this is what an honest empty search looks like,
  // and the screen must be able to tell it from the one above.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const { body } = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    assert.equal(body.status, 'no_candidate');
    assert.equal(body.snapshot.rejectedCandidates, 0);
    assert.deepEqual(body.snapshot.rejectedReasons, { nameMismatch: 0, belowScore: 0 });
  });
});

test('a batch run whose FIRST claim throws still records the run', async () => {
  /*
   * MUST-FIX from review. The audit obligation used to be handed to claim zero
   * alone: if it threw before reaching the PHI point — a claim somebody had
   * already confirmed, the ordinary outcome of re-running a partly-worked
   * remittance — the catch swallowed it, the loop carried on, and every later
   * claim read a chart with NO audit row for the entire run.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`, json({ odClaimNum: 53648 }));
    db.log.length = 0;

    const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/match${Q}`, json({}));
    assert.equal(res.status, 200);
    assert.equal(res.body.matched[0].status, 'already_confirmed');

    // The RUN is recorded even though not one chart was read.
    const run = auditRows(db).filter((r) => r.resource_type === 'rcm_remittance_match');
    assert.equal(run.length, 1);
    assert.equal(run[0].resource_id, '8acb0e32-35ae-5cd8-9692-7b5e318a31c2', 'stamped with the remittance, not null');
  });
});

test('a batch run audits ONE row per claim, stamped with the claim id', async () => {
  // A claim is one patient's chart, not one Open Dental call. N charts is N
  // rows — anything coarser cannot answer "whose chart was read on Tuesday".
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/match${Q}`, json({}));

    const perClaim = auditRows(db).filter((r) => r.resource_type === 'rcm_claim_match');
    assert.equal(perClaim.length, 1);
    assert.equal(perClaim[0].resource_id, 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d');
    assert.equal(perClaim[0].result, 'SUCCESS');
  });
});

test('a role with NO rcm permission at all is refused the whole surface', async () => {
  // `tc` holds none of rcm.read / rcm.queue / rcm.write. A treatment
  // coordinator has no business in claims, denials or AR.
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'tc', od: odFixture() }, async (app) => {
    for (const [method, path] of [
      ['GET', `/api/rcm/remittances${Q}`],
      ['POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`],
      ['POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/review${Q}`],
      ['POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`],
    ]) {
      const res = await api(app.baseUrl, method, path, method === 'GET' ? {} : json({}));
      assert.equal(res.status, 403, `${method} ${path}`);
    }
    assert.equal(db.table('rcm_claims')[0].od_match_status, 'not_run');
  });
});

test('the reviewer role cannot UN-confirm what it could not confirm (D-9)', async () => {
  /*
   * The seam D-9 turns on. `POST /claims/:id/match` is gated on `rcm.queue`
   * because running a match reads Open Dental and changes no chart — but the
   * same route with `force: true` over a CONFIRMED claim NULLs `od_claim_num`,
   * `od_matched_by` and `od_match_confirmed_at`. A tier that cannot make the
   * decision was able to reverse it, which inverts the whole ruling at the one
   * column Slice 6c reads to pick a chart. And the UI's "Run again" button
   * sends exactly that body for exactly that state.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`, json({ odClaimNum: 53648 }));
  });

  await withApp({ db, role: 'reviewer', od: odFixture() }, async (app) => {
    db.log.length = 0;
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({ force: true }));

    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, 'FORCE_REQUIRES_WRITE');
    // The refusal names the fix rather than the rule.
    assert.match(res.body.error, /approver/i);

    const claim = db.table('rcm_claims')[0];
    assert.equal(claim.od_match_status, 'confirmed', 'the decision survived');
    assert.equal(claim.od_claim_num, 53648);
    assert.equal(claim.od_matched_by, 'billing@carein.ai');

    // Refused BEFORE any Open Dental call — the office's chart is not read to
    // answer a question about permission.
    assert.deepEqual(app.od.pathsRead(), []);

    // A refusal of access in the literal sense, which is what UNAUTHORIZED is
    // for — unlike the routine 409s, which write nothing.
    const denied = auditRows(db).filter((r) => r.result === 'UNAUTHORIZED');
    assert.equal(denied.length, 1);
    assert.equal(denied[0].resource_type, 'rcm_claim_match');
    assert.equal(denied[0].resource_id, 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d');
  });
});

test('a reviewer CAN force a re-run of a claim nobody confirmed', async () => {
  // The gate is on releasing a DECISION, not on the word `force`. Re-running an
  // unconfirmed match discards nothing a human stood behind.
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'reviewer', od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({ force: true }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(db.table('rcm_claims')[0].od_match_status, 'candidates');
  });
});

test('confirming LOCKS the row it read', async () => {
  /*
   * Only match-vs-confirm was closed last round. Confirm-vs-confirm and
   * force-vs-confirm read the claim on one statement and write it on another,
   * with an `rcm_user_map` upsert in between — so without the lock the second
   * write lands on top of the first with no error, replacing one person's
   * ClaimNum, attribution and per-line ClaimProcNums with another's.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    db.log.length = 0;
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`, json({ odClaimNum: 53648 }));

    const read = db.log.filter((q) => /^SELECT .* FROM rcm_claims WHERE/.test(q.sql));
    assert.ok(read.length > 0, 'confirm must read the claim');
    assert.match(read[0].sql, / FOR UPDATE$/, 'and hold it for the length of the transaction');

    const written = db.log.filter((q) => /^UPDATE rcm_claims SET od_match_status = 'confirmed'/.test(q.sql));
    assert.equal(written.length, 1);
    assert.match(
      written[0].sql,
      /od_match_status <> 'confirmed'/,
      'and re-assert the status it checked, so the loser of a race finds out'
    );
  });
});

test('confirming the SAME claim twice is idempotent; a different one is refused', async () => {
  // A double-click asks for a decision that is already recorded, so it gets the
  // recorded one. Two people picking DIFFERENT candidates is a real conflict,
  // and the first decision stands — the shape the voice side uses for
  // ALREADY_SENT_TO_CHART.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    const first = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`,
      json({ odClaimNum: 53648 })
    );
    assert.equal(first.status, 200);

    const again = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`,
      json({ odClaimNum: 53648 })
    );
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.alreadyConfirmed, true);
    assert.equal(again.body.odClaimNum, 53648);
    assert.equal(again.body.confirmedBy, 'billing@carein.ai');

    // A different candidate from the same snapshot.
    db.table('rcm_claims')[0].od_match_snapshot.candidates.push({
      odClaimNum: 53649,
      odPatNum: 12828,
      linePairs: [],
      od: { claimStatus: 'S', billedCents: 0, claimHeaderFeeCents: 0, insPaidCents: 0, writeOffCents: 0 },
    });
    const conflict = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`,
      json({ odClaimNum: 53649 })
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'MATCH_ALREADY_CONFIRMED');
    assert.equal(db.table('rcm_claims')[0].od_claim_num, 53648, 'the first decision stands');
  });
});

test('the reviewer role can READ and WORK the queue, and cannot commit (D-9)', async () => {
  /*
   * The reviewer tier. Its whole point is that judging a remittance and
   * COMMITTING that judgement are different jobs — so running a match (reads
   * Open Dental, changes no chart) and marking a claim reviewed (no Open Dental
   * effect at all) are allowed, while confirming — which writes od_claim_num,
   * the column Slice 6c reads to pick a chart — is not.
   *
   * This route reaches its gate through the mount's real `exempt` list, so a
   * queue path that lost its own requirePermission would 200 here for a role
   * that must not have it.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'reviewer', od: odFixture() }, async (app) => {
    const list = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.equal(list.status, 200, 'a reviewer must be able to open the workbench');

    const detail = await api(app.baseUrl, 'GET', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d${Q}`);
    assert.equal(detail.status, 200);

    const matched = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    assert.equal(matched.status, 200, 'running a match reads OD and writes no chart');
    assert.equal(db.table('rcm_claims')[0].od_match_status, 'candidates');

    const batch = await api(app.baseUrl, 'POST', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/match${Q}`, json({}));
    assert.equal(batch.status, 200, 'and so does the batch form of it');

    const reviewed = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/review${Q}`,
      json({ note: 'Carrier owes a corrected EOB — nothing to post.' })
    );
    assert.equal(reviewed.status, 200, 'worklist hygiene is not a chart write');
    // Attributed all the same: a read-tier user who leaves a note is a named
    // actor, through the same D-5 upsert.
    assert.equal(db.table('rcm_claims')[0].reviewed_by, 'billing@carein.ai');

    // …and the one thing it must not do.
    const confirm = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`,
      json({ odClaimNum: 53648 })
    );
    assert.equal(confirm.status, 403);
    assert.equal(confirm.body.code, 'FORBIDDEN');
    assert.equal(confirm.body.action, 'rcm.write');
    assert.equal(db.table('rcm_claims')[0].od_claim_num, null, 'nothing was linked');

    // Nor upload a new remittance: that is rcm.write too.
    const upload = await api(app.baseUrl, 'POST', `/api/rcm/era${Q}`, json({}));
    assert.equal(upload.status, 403);
  });
});

test('an anonymous caller is 401 before any office or module check', async () => {
  await withApp({ db: seed(new FakeRcmDb()), user: null }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`, { anon: true });
    assert.equal(res.status, 401);
  });
});

// ─── The source-document proxy ───────────────────────────────────────────────

test("another office's document is NOT FOUND", async () => {
  const db = seed(new FakeRcmDb(), { office: 'valley' });
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/57c97173-8178-5976-997e-9de296795b28/document${Q}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'DOCUMENT_NOT_FOUND');
  });
});

test('an unconfigured blob store refuses with the module\'s own 503, not a crash', async () => {
  const db = seed(new FakeRcmDb());
  // eraStore: null leaves the REAL, unconfigured store in place.
  await withApp({ db, eraStore: null }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/57c97173-8178-5976-997e-9de296795b28/document${Q}`);
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'RCM_STORAGE_UNAVAILABLE');

    // Nothing was SERVED — but the attempt is recorded. Auditing only successes
    // means somebody walking upload ids leaves nothing in the tenant's trail,
    // and the attempt is what a HIPAA trail most needs to have.
    const [row] = auditRows(db).filter((r) => r.resource_type === 'rcm_source_document');
    assert.equal(row.result, 'UNAUTHORIZED');
    assert.equal(row.resource_id, '57c97173-8178-5976-997e-9de296795b28');
  });
});

test('a document with an unrecognised key is a 500, never a misleading 404', async () => {
  const db = seed(new FakeRcmDb());
  db.table('rcm_eob_uploads')[0].file_key = 'tenant/carein/other/thing.bin';
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/57c97173-8178-5976-997e-9de296795b28/document${Q}`);
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'DOCUMENT_KEY_UNRECOGNISED');
  });
});

test('a served document is audited BEFORE the bytes, with the filename kept out of the trail', async () => {
  const db = seed(new FakeRcmDb());
  const eraFileStore = require('../../services/rcm/eraFileStore');
  const original = { isConfigured: eraFileStore.isConfigured, getEraFile: eraFileStore.getEraFile };
  eraFileStore.isConfigured = () => true;
  eraFileStore.getEraFile = async () => Buffer.from('ISA*00*…~');
  try {
    await withApp({ db, eraStore: { isConfigured: () => true } }, async (app) => {
      const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/57c97173-8178-5976-997e-9de296795b28/document${Q}`, { raw: true });
      assert.equal(res.status, 200);
      assert.equal(res.bytes.toString(), 'ISA*00*…~');
      assert.match(res.headers['content-disposition'], /delta_fixture_multiclaim\.edi/);
      // PHI must not sit in a shared cache.
      assert.equal(res.headers['cache-control'], 'private, no-store');

      const [row] = auditRows(db).filter((r) => r.resource_type === 'rcm_source_document');
      assert.equal(row.action, 'READ');
      assert.equal(row.resource_id, '57c97173-8178-5976-997e-9de296795b28');
      assert.ok(!JSON.stringify(row).includes('delta_fixture'), 'the filename is PHI');
    });
  } finally {
    eraFileStore.isConfigured = original.isConfigured;
    eraFileStore.getEraFile = original.getEraFile;
  }
});

test('a header-splitting filename is neutralised rather than echoed', async () => {
  const db = seed(new FakeRcmDb());
  db.table('rcm_eob_uploads')[0].filename = 'evil"\r\nX-Injected: 1.edi';
  const eraFileStore = require('../../services/rcm/eraFileStore');
  const original = { isConfigured: eraFileStore.isConfigured, getEraFile: eraFileStore.getEraFile };
  eraFileStore.isConfigured = () => true;
  eraFileStore.getEraFile = async () => Buffer.from('x');
  try {
    await withApp({ db, eraStore: { isConfigured: () => true } }, async (app) => {
      const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/57c97173-8178-5976-997e-9de296795b28/document${Q}`, { raw: true });
      assert.equal(res.status, 200);
      assert.ok(!res.headers['x-injected']);
      assert.ok(!res.headers['content-disposition'].includes('\n'));
    });
  } finally {
    eraFileStore.isConfigured = original.isConfigured;
    eraFileStore.getEraFile = original.getEraFile;
  }
});

// ─── Review findings: races, stale snapshots, and audited refusals ───────────

test('a confirmation is NOT wiped by a match that was already in flight', async () => {
  /*
   * The lost-confirmation race, driven end to end — and driven through the
   * WRITE-side guard specifically.
   *
   * The `confirmed` check at the top of runClaimMatch reads on one connection;
   * the snapshot write lands on another, with the Open Dental round trips in
   * between. Biller B starts a match while the claim still reads `candidates`,
   * so that check passes. Biller A confirms during the round trips. B's UPDATE
   * then used to land afterwards and blank od_claim_num, od_matched_by and
   * od_match_confirmed_at — no error, no record of the reversal, and the claim
   * silently back in needs-attention.
   *
   * The fake Open Dental client BLOCKS on a gate the test opens only after the
   * confirmation has committed, so the interleaving is deterministic rather
   * than hopeful. The 409 asserted below therefore CANNOT have come from the
   * read-side check — that check ran, and passed, before the confirmation
   * existed.
   */
  const db = seed(new FakeRcmDb());
  const od = odFixture();

  await withApp({ db, od }, async (app) => {
    const realGet = od.client.apiGetRaw.bind(od.client);

    // A first match, so there is a snapshot to confirm against and the claim
    // reads `candidates` — the state biller B's read-side check will pass.
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    assert.equal(db.table('rcm_claims')[0].od_match_status, 'candidates');

    // Now hold the NEXT match inside its first Open Dental read. Two promises,
    // because both directions have to be deterministic: `arrival` tells the
    // test the match really is inside an OD call, and `gate` is how the test
    // lets it out again.
    let release = () => {};
    let arrived = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const arrival = new Promise((r) => {
      arrived = r;
    });
    let holding = false;
    od.client.apiGetRaw = async (path, params, opts) => {
      if (!holding) {
        holding = true;
        arrived();
        await gate;
      }
      return realGet(path, params, opts);
    };

    db.log.length = 0;
    const late = api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    await arrival; // it is genuinely mid-flight, not merely started

    // …and the confirmation lands while it is stuck there.
    const confirmed = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`,
      json({ odClaimNum: 53648 })
    );
    assert.equal(confirmed.status, 200);
    assert.equal(db.table('rcm_claims')[0].od_claim_num, 53648);

    release();
    const res = await late;

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'MATCH_ALREADY_CONFIRMED');

    // The UPDATE was ISSUED and matched nothing — this is the write-side guard
    // firing, not the read-side one answering early.
    const updates = db.log.filter((q) => /^UPDATE rcm_claims SET od_match_status = \$3/.test(q.sql));
    assert.equal(updates.length, 1, "the late match must have attempted its write");
    assert.match(updates[0].sql, /od_match_status <> 'confirmed'/);

    const claim = db.table('rcm_claims')[0];
    assert.equal(claim.od_match_status, 'confirmed', 'the decision survived');
    assert.equal(claim.od_claim_num, 53648);
    assert.equal(claim.od_matched_by, 'billing@carein.ai');
    assert.ok(claim.od_match_confirmed_at, 'and so did its attribution');

    od.client.apiGetRaw = realGet;
  });
});

test('a FORCED re-run over a confirmation is audited as its own event, and carries it forward', async () => {
  /*
   * `force` is the one way to discard a decision somebody made, and it used to
   * be indistinguishable in the trail from an ordinary match: same action, same
   * resource type, and the new snapshot set `confirmed: null` — so who
   * confirmed, when, and against which ClaimNum were unrecoverable afterwards.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`, json({ odClaimNum: 53648 }));
    db.log.length = 0;

    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({ force: true }));
    assert.equal(res.status, 200);

    // The overwrite is its own audited event, and it is an UPDATE — a person
    // changed the practice's record — not another read.
    const superseded = auditRows(db).filter((r) => r.resource_type === 'rcm_claim_match_superseded');
    assert.equal(superseded.length, 1);
    assert.equal(superseded[0].action, 'UPDATE');
    assert.equal(superseded[0].resource_id, 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d');

    // And the decision it destroyed is still readable.
    const prior = db.table('rcm_claims')[0].od_match_snapshot.supersededConfirmation;
    assert.equal(prior.odClaimNum, 53648);
    assert.equal(prior.confirmedBy, 'billing@carein.ai');
    assert.ok(prior.confirmedAt);
    assert.equal(db.table('rcm_claims')[0].od_match_snapshot.confirmed, null);
  });
});

test('an ordinary re-run supersedes nothing and says so', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    assert.equal(res.body.snapshot.supersededConfirmation, null);
    assert.equal(
      auditRows(db).filter((r) => r.resource_type === 'rcm_claim_match_superseded').length,
      0
    );
  });
});

test("confirming against ANOTHER OFFICE'S snapshot is refused", async () => {
  // PatNum numbering restarts in every Open Dental database, and confirm writes
  // od_patient_id straight off the snapshot's candidate. A snapshot taken under
  // valley must never be confirmable under roland (hard rule 3).
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    // Re-stamp the stored snapshot as if it had been taken for the other office.
    const claim = db.table('rcm_claims')[0];
    claim.od_match_snapshot = { ...claim.od_match_snapshot, office: 'valley' };

    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`,
      json({ odClaimNum: 53648 })
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'SNAPSHOT_OFFICE_MISMATCH');
    assert.equal(db.table('rcm_claims')[0].od_claim_num, null);
    assert.equal(db.table('rcm_claims')[0].od_patient_id, null);
  });
});

test('confirming against an older snapshot SHAPE is refused', async () => {
  // 6c reads confirmed.linePairs and odAmountsAsRead out of this structure.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    const claim = db.table('rcm_claims')[0];
    claim.od_match_snapshot = { ...claim.od_match_snapshot, version: 0 };

    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`,
      json({ odClaimNum: 53648 })
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'SNAPSHOT_VERSION_STALE');
  });
});

test('a match that READ PHI and then failed still leaves a trail', async () => {
  // /patients returns real names and dates of birth; /claims then 503s. The
  // audit row used to be written only after a successful return, so this
  // sequence read a patient's identity out of Open Dental and recorded nothing.
  const db = seed(new FakeRcmDb());
  const od = odFixture({ fail: { '/claims': { status: 503, error: 'gateway' } } });
  await withApp({ db, od }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    assert.equal(res.status, 502);

    const [row] = auditRows(db).filter((r) => r.resource_type === 'rcm_claim_match');
    assert.ok(row, 'a PHI read that failed must still be audited');
    // ERROR, not UNAUTHORIZED: a read HAPPENED and did not complete. Filing a
    // real disclosure as a refusal under-counts accesses on the report the
    // trail exists to produce, and dilutes the one signal that means "somebody
    // was refused".
    assert.equal(row.result, 'ERROR');
    assert.equal(row.resource_id, 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d');
    // And the patient's name is not in the trail.
    assert.ok(!JSON.stringify(row).includes('Fixture'));
  });
});

test('a routine conflict is NOT filed as a refusal', async () => {
  // A 409 because somebody else confirmed first is an ordinary outcome of two
  // people working one remittance. Recording it as UNAUTHORIZED is how the
  // signal that means "access was refused" stops being readable.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${Q}`, json({ odClaimNum: 53648 }));
    db.log.length = 0;

    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));
    assert.equal(res.body.code, 'MATCH_ALREADY_CONFIRMED');
    assert.equal(
      auditRows(db).filter((r) => r.result === 'UNAUTHORIZED').length,
      0,
      'a conflict is not a refusal'
    );
  });
});

test('the audit row lands BEFORE the snapshot, which carries OD patient names', async () => {
  // documents.js states the rule ("the trail is written before the bytes") and
  // this path used to invert it: an audit failure left PHI on disk, re-readable
  // through GET /claims/:id, with nothing recorded.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${Q}`, json({}));

    const auditAt = db.log.findIndex((q) => /INSERT INTO audit_log/i.test(q.sql));
    const snapshotAt = db.log.findIndex((q) =>
      /^UPDATE rcm_claims SET od_match_status .*od_match_snapshot/.test(q.sql)
    );
    assert.ok(auditAt >= 0 && snapshotAt >= 0, 'both statements should have run');
    assert.ok(auditAt < snapshotAt, 'the trail must precede the PHI write');
  });
});

test('walking claim and remittance ids is not a silent activity', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    await api(app.baseUrl, 'GET', `/api/rcm/claims/does-not-exist${Q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/remittances/does-not-exist${Q}`);

    const denials = auditRows(db).filter((r) => r.result === 'UNAUTHORIZED');
    assert.deepEqual(denials.map((r) => r.resource_type).sort(), ['rcm_claim', 'rcm_remittance']);
  });
});

test('the document proxy never reflects a client-declared content type', async () => {
  // rcm_eob_uploads.content_type is the raw multipart part header, unvalidated
  // on the ERA path. Reflecting it with Content-Disposition: inline lets a
  // parseable 835 declaring text/html render as HTML on the API origin.
  const db = seed(new FakeRcmDb());
  db.table('rcm_eob_uploads')[0].content_type = 'text/html';

  const eraFileStore = require('../../services/rcm/eraFileStore');
  const original = { isConfigured: eraFileStore.isConfigured, getEraFile: eraFileStore.getEraFile };
  eraFileStore.isConfigured = () => true;
  eraFileStore.getEraFile = async () => Buffer.from('<script>alert(1)</script>');
  try {
    await withApp({ db, eraStore: { isConfigured: () => true } }, async (app) => {
      const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/57c97173-8178-5976-997e-9de296795b28/document${Q}`, { raw: true });
      assert.equal(res.status, 200);
      // Derived from the blob KEY path, which we mint — not from the row.
      assert.equal(res.headers['content-type'], 'application/edi-x12');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    });
  } finally {
    eraFileStore.isConfigured = original.isConfigured;
    eraFileStore.getEraFile = original.getEraFile;
  }
});

test('a non-Latin-1 filename serves rather than 500ing after the audit row', async () => {
  // Node rejects a header value outside Latin-1, so this used to throw AFTER
  // the audit row was written — a trail claiming a PHI read that never
  // happened, and a permanently unreachable document.
  const db = seed(new FakeRcmDb());
  db.table('rcm_eob_uploads')[0].filename = '歯科_remittance_“March”.edi';

  const eraFileStore = require('../../services/rcm/eraFileStore');
  const original = { isConfigured: eraFileStore.isConfigured, getEraFile: eraFileStore.getEraFile };
  eraFileStore.isConfigured = () => true;
  eraFileStore.getEraFile = async () => Buffer.from('ISA*00*');
  try {
    await withApp({ db, eraStore: { isConfigured: () => true } }, async (app) => {
      const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/57c97173-8178-5976-997e-9de296795b28/document${Q}`, { raw: true });
      assert.equal(res.status, 200);
      const cd = res.headers['content-disposition'];
      // An ASCII form every client understands, plus the real name encoded.
      assert.match(cd, /filename="[\x20-\x7e]*"/);
      assert.match(cd, /filename\*=UTF-8''/);
      assert.ok(cd.includes(encodeURIComponent('歯科')));
    });
  } finally {
    eraFileStore.isConfigured = original.isConfigured;
    eraFileStore.getEraFile = original.getEraFile;
  }
});

// ─── What this slice deliberately does NOT have ──────────────────────────────

test('there is still no POST endpoint — approving is not posting', async () => {
  /*
   * Slice 6b added exactly ONE mutation: `POST /remittances/:id/approve`, which
   * writes a plan to OUR database. Everything that would MOVE money is still
   * absent, and this is the list that has to stay 404 until 6c ships behind its
   * own gated staging event.
   *
   * `/approve` has moved off this list because it now exists. What replaces it
   * as the guarantee is `rcmNoOdWrites.test.js`, which drives approve to
   * success and asserts the Open Dental client was never called at all.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    for (const path of [
      '/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/approve',
      '/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/post',
      '/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/post',
      '/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/drain',
      '/api/rcm/queue',
      '/api/rcm/queue/drain',
    ]) {
      const res = await api(app.baseUrl, 'POST', `${path}${Q}`, json({}));
      assert.equal(res.status, 404, `${path} must not exist yet`);
    }
    // And nothing on this fixture is approvable, so nothing was queued either.
    assert.equal(db.table('rcm_posting_queue').length, 0);
  });
});
