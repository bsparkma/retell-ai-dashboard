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
      batch_id: over.batchId || 'b-1',
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
      claim_id: over.claimId || 'c-1',
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
      batch_claim_payment_id: 'bcp-1',
      batch_id: over.batchId || 'b-1',
      claim_id: over.claimId || 'c-1',
      office_id: office,
      position: 1,
    },
  ]);
  db.seed('rcm_procedure_lines', [
    {
      line_id: 'pl-1',
      claim_id: over.claimId || 'c-1',
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
      adjustment_id: 'adj-1',
      procedure_line_id: 'pl-1',
      claim_id: over.claimId || 'c-1',
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
      upload_id: 'u-1',
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
    assert.ok(r.attentionReasons.includes('claims_flagged'));
    assert.ok(r.attentionReasons.includes('claims_unmatched'));
    assert.equal(r.reviewReasonCount, 1);
    assert.equal(body.needsAttentionCount, 1);
  });
});

test('a batch held open by a flag needs attention even with no claim reasons', async () => {
  // Slice 5's contract: `open` means SOMETHING was flagged, `ready` means a
  // person could act on it now. A status that said ready about a takeback would
  // be a lie, and so would a list that hid it.
  const db = seed(new FakeRcmDb(), { batchStatus: 'open' });
  await withApp({ db }, async (app) => {
    const { body } = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.ok(body.remittances[0].attentionReasons.includes('batch_open'));
  });
});

test('a fully worked remittance leaves the needs-attention view', async () => {
  const db = seed(new FakeRcmDb());
  Object.assign(db.table('rcm_claims')[0], {
    od_match_status: 'confirmed',
    od_claim_num: 53648,
    reviewed_at: new Date(),
    reviewed_by: 'billing@carein.ai',
  });
  await withApp({ db }, async (app) => {
    const { body } = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    assert.equal(body.remittances[0].needsAttention, false);
    assert.deepEqual(body.remittances[0].attentionReasons, []);
    assert.equal(body.needsAttentionCount, 0);
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
    const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances/b-1${Q}`);
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
    const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances/b-1${Q}`);
    assert.equal(res.body.remittance.upload.documentUrl, '/api/rcm/uploads/u-1/document?office=roland');
    assert.ok(!JSON.stringify(res.body).includes('tenant/carein/rcm/era/k1.edi'));
  });
});

test("another office's remittance is NOT FOUND, not refused", async () => {
  // office_id is in the WHERE rather than checked afterwards, which makes a
  // cross-office read structurally a miss.
  const db = seed(new FakeRcmDb(), { office: 'valley' });
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances/b-1${Q}`);
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
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
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
    const { body } = await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    const [candidate] = body.snapshot.candidates;
    assert.equal(candidate.od.claimFeeCents, 21000);
    assert.equal(candidate.linePairs[0].odClaimProcNum, 99001);
    assert.match(body.snapshot.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.snapshot.version, 1);
    assert.equal(body.snapshot.office, 'roland');
  });
});

test('no candidate is a STORED outcome, distinct from never having looked', async () => {
  // "Nobody has checked" and "we checked on Tuesday and Open Dental has nothing"
  // are different facts a biller acts on differently.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
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
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    assert.ok([409, 503].includes(res.status), `unexpected ${res.status}`);
    assert.equal(res.body.code, 'OFFICE_NOT_CONNECTED');
    assert.equal(db.table('rcm_claims')[0].od_match_status, 'not_run');
  });
});

test('an Open Dental outage is a 502 and leaves the claim un-matched, not no_candidate', async () => {
  const db = seed(new FakeRcmDb());
  const od = new FakeOd({ fail: { '/patients': { status: 503, error: 'gateway' } } });
  await withApp({ db, od }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
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
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/c-1/confirm-match${Q}`,
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
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/confirm-match${Q}`, json({ odClaimNum: 53648 }));

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
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/confirm-match${Q}`, json({ odClaimNum: 53648 }));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/review${Q}`, json({ note: 'checked' }));
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
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/confirm-match${Q}`, json({ odClaimNum: 53648 }));

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
      `/api/rcm/claims/c-1/confirm-match${Q}`,
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
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/c-1/confirm-match${Q}`,
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
      const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/confirm-match${Q}`, json(body));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'INVALID_CLAIM_NUM');
    }
  });
});

test('re-running a match over a CONFIRMED claim is refused unless explicitly forced', async () => {
  // Re-run allowed explicitly, never a silent overwrite of somebody's decision.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/confirm-match${Q}`, json({ odClaimNum: 53648 }));

    const blocked = await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'MATCH_ALREADY_CONFIRMED');
    assert.equal(db.table('rcm_claims')[0].od_claim_num, 53648, 'the decision survived');

    const forced = await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({ force: true }));
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
      `/api/rcm/claims/c-1/review${Q}`,
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
      `/api/rcm/claims/c-1/review${Q}`,
      json({ note: 'x'.repeat(2001) })
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'NOTE_TOO_LONG');
  });
});

test('an empty note stores NULL rather than an empty string', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/review${Q}`, json({ note: '   ' }));
    assert.equal(db.table('rcm_claims')[0].review_note, null);
  });
});

// ─── Batch matching ──────────────────────────────────────────────────────────

test('a batch match reports each claim individually', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/b-1/match${Q}`, json({}));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.matched, [
      { claimId: 'c-1', status: 'candidates', candidateCount: 1, ambiguous: false },
    ]);
    // Pacing is a documented floor, not an env value that can be lowered away.
    assert.ok(res.body.pacingMs >= 1200);
  });
});

test('a batch match writes exactly ONE audit row for the whole run', async () => {
  // Matching a twelve-claim remittance is one thing a human asked for, not
  // twelve — the same granularity rule platform/odAccess applies.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/remittances/b-1/match${Q}`, json({}));
    const rows = auditRows(db).filter((r) => r.resource_type === 'rcm_claim_match');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].office, 'roland');
  });
});

test('a batch match on another office\'s remittance is a 404', async () => {
  const db = seed(new FakeRcmDb(), { office: 'valley' });
  await withApp({ db, od: odFixture() }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/b-1/match${Q}`, json({}));
    assert.equal(res.status, 404);
  });
});

// ─── Audit ───────────────────────────────────────────────────────────────────

test('every PHI read writes exactly one audit row, and search terms never appear', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/remittances/b-1${Q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/claims/c-1${Q}`);
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));

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
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/confirm-match${Q}`, json({ odClaimNum: 53648 }));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/review${Q}`, json({ note: 'ok' }));

    const updates = auditRows(db).filter((r) => r.action === 'UPDATE');
    assert.deepEqual(updates.map((r) => r.resource_type), ['rcm_claim_match', 'rcm_claim_review']);
    // resourceId IS stamped here — a claim id we minted, never PHI.
    for (const row of updates) assert.equal(row.resource_id, 'c-1');
  });
});

// ─── Gates: entitlement, permission, identity ────────────────────────────────

test('a tenant without the rcm module gets MODULE_NOT_ENTITLED on every route', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, modules: ['voice'] }, async (app) => {
    for (const [method, path] of [
      ['GET', `/api/rcm/remittances${Q}`],
      ['GET', `/api/rcm/remittances/b-1${Q}`],
      ['GET', `/api/rcm/claims/c-1${Q}`],
      ['POST', `/api/rcm/claims/c-1/match${Q}`],
      ['POST', `/api/rcm/claims/c-1/confirm-match${Q}`],
      ['POST', `/api/rcm/claims/c-1/review${Q}`],
      ['POST', `/api/rcm/remittances/b-1/match${Q}`],
      ['GET', `/api/rcm/uploads/u-1/document${Q}`],
    ]) {
      const res = await api(app.baseUrl, method, path, method === 'GET' ? {} : json({}));
      assert.equal(res.status, 403, `${method} ${path}`);
      // The code arrives in `error`, not `code` — the platform's existing shape.
      assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
    }
  });
});

test('a role without rcm.write may READ the workbench but not act on it', async () => {
  // The read/write split is the mount's requireReadWrite, applied by METHOD.
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'tc', od: odFixture() }, async (app) => {
    const read = await api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}`);
    const write = await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    // Whatever this role's read entitlement is, a write must never be broader.
    if (read.status === 200) assert.equal(write.status, 403);
    else assert.equal(write.status, 403);
    assert.equal(db.table('rcm_claims')[0].od_match_status, 'not_run');
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
    const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/u-1/document${Q}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'DOCUMENT_NOT_FOUND');
  });
});

test('an unconfigured blob store refuses with the module\'s own 503, not a crash', async () => {
  const db = seed(new FakeRcmDb());
  // eraStore: null leaves the REAL, unconfigured store in place.
  await withApp({ db, eraStore: null }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/u-1/document${Q}`);
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'RCM_STORAGE_UNAVAILABLE');

    // Nothing was SERVED — but the attempt is recorded. Auditing only successes
    // means somebody walking upload ids leaves nothing in the tenant's trail,
    // and the attempt is what a HIPAA trail most needs to have.
    const [row] = auditRows(db).filter((r) => r.resource_type === 'rcm_source_document');
    assert.equal(row.result, 'UNAUTHORIZED');
    assert.equal(row.resource_id, 'u-1');
  });
});

test('a document with an unrecognised key is a 500, never a misleading 404', async () => {
  const db = seed(new FakeRcmDb());
  db.table('rcm_eob_uploads')[0].file_key = 'tenant/carein/other/thing.bin';
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/u-1/document${Q}`);
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
      const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/u-1/document${Q}`, { raw: true });
      assert.equal(res.status, 200);
      assert.equal(res.bytes.toString(), 'ISA*00*…~');
      assert.match(res.headers['content-disposition'], /delta_fixture_multiclaim\.edi/);
      // PHI must not sit in a shared cache.
      assert.equal(res.headers['cache-control'], 'private, no-store');

      const [row] = auditRows(db).filter((r) => r.resource_type === 'rcm_source_document');
      assert.equal(row.action, 'READ');
      assert.equal(row.resource_id, 'u-1');
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
      const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/u-1/document${Q}`, { raw: true });
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
   * The lost-confirmation race, driven end to end.
   *
   * The `confirmed` guard reads on one connection and the write lands on
   * another, with the Open Dental round trips in between. Biller A confirms;
   * biller B's match — which passed the guard while the claim still read
   * `candidates` — used to land afterwards and blank od_claim_num,
   * od_matched_by and od_match_confirmed_at. No error, no audit row recording
   * the reversal, and the claim silently back in needs-attention.
   *
   * Simulated by confirming while a match is mid-flight: the fake OD blocks on
   * a gate the test opens after the confirmation has committed.
   */
  const db = seed(new FakeRcmDb());
  const od = odFixture();

  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const realGet = od.client.apiGetRaw;
  let held = false;
  od.client.apiGetRaw = async (path, params, opts) => {
    if (!held) {
      held = true;
      await gate; // the first OD read of the second match hangs here
    }
    return realGet(path, params, opts);
  };

  await withApp({ db, od }, async (app) => {
    // First match + confirm, completed normally.
    od.client.apiGetRaw = realGet;
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/confirm-match${Q}`, json({ odClaimNum: 53648 }));
    assert.equal(db.table('rcm_claims')[0].od_claim_num, 53648);

    // Now a SECOND match that passed its guard before the confirmation existed:
    // force it, so it gets past the read-side check, then assert the write-side
    // guard is what actually protects the decision.
    const late = api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    const res = await late;

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'MATCH_ALREADY_CONFIRMED');

    const claim = db.table('rcm_claims')[0];
    assert.equal(claim.od_match_status, 'confirmed', 'the decision survived');
    assert.equal(claim.od_claim_num, 53648);
    assert.equal(claim.od_matched_by, 'billing@carein.ai');
    if (release) release();
  });
});

test('the guard is in the WHERE, not only in the read', async () => {
  /*
   * Structural, because the race above is timing-dependent and this is not.
   *
   * The read-side check is the fast path and normally answers first — which is
   * exactly why it cannot be the only guard. The write must re-assert the
   * status it checked, so check-and-write is ONE statement and the loser of a
   * race writes nothing.
   */
  const src = require('node:fs').readFileSync(require.resolve('./matchService'), 'utf8');
  // Located by substring rather than by a multi-line regex: the statement is
  // built from concatenated template literals, and a pattern loose enough to
  // span them is loose enough to match the wrong thing.
  const at = src.indexOf('UPDATE rcm_claims SET od_match_status = $3');
  assert.ok(at > 0, "matchService's match UPDATE should be findable");
  const statement = src.slice(at, src.indexOf('[office, claimId, status', at));
  assert.match(statement, /od_match_status <> 'confirmed'/, 'the status must be re-asserted in the WHERE');
  assert.match(src, /written\.rowCount === 0/, 'and a losing UPDATE must be detected');

  // And the guard actually fires end to end.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/confirm-match${Q}`, json({ odClaimNum: 53648 }));
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    assert.equal(res.body.code, 'MATCH_ALREADY_CONFIRMED');
    assert.equal(db.table('rcm_claims')[0].od_claim_num, 53648);
  });
});

test("confirming against ANOTHER OFFICE'S snapshot is refused", async () => {
  // PatNum numbering restarts in every Open Dental database, and confirm writes
  // od_patient_id straight off the snapshot's candidate. A snapshot taken under
  // valley must never be confirmable under roland (hard rule 3).
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    // Re-stamp the stored snapshot as if it had been taken for the other office.
    const claim = db.table('rcm_claims')[0];
    claim.od_match_snapshot = { ...claim.od_match_snapshot, office: 'valley' };

    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/c-1/confirm-match${Q}`,
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
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    const claim = db.table('rcm_claims')[0];
    claim.od_match_snapshot = { ...claim.od_match_snapshot, version: 0 };

    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/claims/c-1/confirm-match${Q}`,
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
    const res = await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));
    assert.equal(res.status, 502);

    const [row] = auditRows(db).filter((r) => r.resource_type === 'rcm_claim_match');
    assert.ok(row, 'a PHI read that failed must still be audited');
    assert.equal(row.result, 'UNAUTHORIZED');
    assert.equal(row.resource_id, 'c-1');
    // And the patient's name is not in the trail.
    assert.ok(!JSON.stringify(row).includes('Fixture'));
  });
});

test('the audit row lands BEFORE the snapshot, which carries OD patient names', async () => {
  // documents.js states the rule ("the trail is written before the bytes") and
  // this path used to invert it: an audit failure left PHI on disk, re-readable
  // through GET /claims/:id, with nothing recorded.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${Q}`, json({}));

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
      const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/u-1/document${Q}`, { raw: true });
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
      const res = await api(app.baseUrl, 'GET', `/api/rcm/uploads/u-1/document${Q}`, { raw: true });
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

test('there is no approve, post or enqueue endpoint under /api/rcm', async () => {
  // The workbench's Approve button is rendered DISABLED so the layout is right
  // when 6b lands. There is nothing behind it to call, and that is on purpose.
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: odFixture() }, async (app) => {
    for (const path of [
      '/api/rcm/claims/c-1/approve',
      '/api/rcm/claims/c-1/post',
      '/api/rcm/remittances/b-1/approve',
      '/api/rcm/remittances/b-1/post',
      '/api/rcm/remittances/b-1/enqueue',
      '/api/rcm/queue',
    ]) {
      const res = await api(app.baseUrl, 'POST', `${path}${Q}`, json({}));
      assert.equal(res.status, 404, `${path} must not exist yet`);
    }
    assert.equal(db.table('rcm_posting_queue').length, 0);
  });
});
