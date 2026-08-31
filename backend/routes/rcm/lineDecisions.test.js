'use strict';

/**
 * The per-line write-off decision, end to end through the REAL /api/rcm stack.
 *
 * Booted the way server.js assembles it, so the tier this route runs at, its
 * place in `QUEUE_PATHS`, the office scoping and the audit row are under test
 * rather than assumed. A test that called the handler directly would pass with
 * the whole permission split deleted.
 *
 * The claims, in order of how much they matter:
 *
 *  1. An office write-off cannot be recorded without a reason — refused by the
 *     route AND by a CHECK constraint, in both directions.
 *  2. A decision is attributed, and the attribution reaches the screen.
 *  3. THE SCREEN AND THE GATE CANNOT DISAGREE. The verdict the claim read
 *     returns and the checklist the approve gate returns are produced by one
 *     function over the same rows.
 *  4. An approved claim is frozen (D-14).
 *  5. Approving SNAPSHOTS the decision onto the posting, and the drain reads
 *     that rather than the review row.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FakeRcmDb,
  FakeOd,
  bootRcmApp,
  api,
  auditRows,
  seedOfficeSettings,
} = require('./rcmTestUtils');

const OFFICE = 'roland';
const Q = `?office=${OFFICE}`;
const BATCH = '8acb0e32-35ae-5cd8-9692-7b5e318a31c2';
const CLAIM = 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d';
const LINE_A = 'a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90';
const LINE_B = 'b13f4318-e84b-6de8-bf3e-b1ffb5f7ad01';
const OD_CLAIM = 53648;

const json = (body) => ({ body: JSON.stringify(body), json: true });

async function withApp(opts, fn) {
  const app = await bootRcmApp(opts);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

/**
 * One check, one claim, TWO lines — synthetic throughout (the repo's
 * no-real-patient-data rule).
 *
 * Line A: billed 150.00, allowed 100.00, paid 80.00 → W 50.00, R 20.00
 * Line B: billed  60.00, allowed  40.00, paid 10.00 → W 20.00, R 30.00
 *
 * The claim's paid total is 90.00, which is what the batch says it moved and
 * what the lines sum to — the three figures the gate refuses a disagreement
 * between.
 */
function seed(db, over = {}) {
  db.seed('rcm_user_map', [
    {
      user_key: 'user-1',
      platform_email: 'billing@carein.ai',
      display_name: 'Billing User',
      active: true,
    },
  ]);
  db.seed('rcm_payment_batches', [
    {
      batch_id: BATCH,
      office_id: OFFICE,
      payer: 'DELTA DENTAL OF ARKANSAS',
      check_number: '830200001',
      eft_number: null,
      trace_number: '830200001',
      payment_method: 'check',
      deposit_date: '2026-03-02',
      total_amount_cents: 9000,
      posted_amount_cents: 0,
      plb_total_cents: 0,
      plb_adjustments: [],
      claim_count: 1,
      status: 'ready',
      era_file_key: null,
      notes: '',
      created_by: null,
      created_at: new Date('2026-03-02T10:00:00Z'),
      approval_attempted_at: null,
      approval_attempted_by: null,
      parked_at: null,
      parked_by: null,
      parked_note: null,
      set_aside_at: null,
      set_aside_by: null,
      set_aside_reason: null,
      set_aside_reason_note: null,
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: CLAIM,
      office_id: OFFICE,
      claim_number: '53648',
      check_number: '830200001',
      patient_name: 'Fixture, Synthetic',
      patient_dob: '1990-01-01',
      subscriber_id: 'ABC123456',
      od_patient_id: 12828,
      od_claim_num: over.confirmed === false ? null : OD_CLAIM,
      payer: 'DELTA DENTAL OF ARKANSAS',
      service_date: '2026-03-02',
      received_date: '2026-03-02',
      status: 'matched',
      payment_status: 'unpaid',
      insurance_type: 'primary',
      total_billed_cents: 21000,
      total_allowed_cents: 14000,
      total_paid_cents: 9000,
      total_deductible_cents: 0,
      patient_balance_cents: 5000,
      needs_review_reasons: [],
      confidence: 95,
      od_match_status: over.confirmed === false ? 'not_run' : 'confirmed',
      od_match_snapshot: over.confirmed === false ? null : snapshot(over),
      od_match_at: new Date('2026-03-02T11:00:00Z'),
      od_match_confirmed_at: new Date('2026-03-02T11:05:00Z'),
      od_matched_by: 'user-1',
      reviewed_at: new Date('2026-03-02T11:10:00Z'),
      reviewed_by: 'user-1',
      review_note: 'checked',
      posting_queue_id: over.postingQueueId || null,
      approved_at: over.postingQueueId ? new Date('2026-03-02T12:00:00Z') : null,
      approved_by: over.postingQueueId ? 'user-1' : null,
      created_at: new Date('2026-03-02T10:00:00Z'),
    },
  ]);
  db.seed('rcm_batch_claim_payments', [
    {
      batch_claim_payment_id: '5f46bb33-d78e-573d-87a6-bb42a7bd7478',
      batch_id: BATCH,
      claim_id: CLAIM,
      office_id: OFFICE,
      position: 1,
      paid_cents: 9000,
    },
  ]);
  db.seed('rcm_procedure_lines', [
    procLine({
      line_id: LINE_A,
      position: 1,
      code: 'D0150',
      billed_cents: 15000,
      allowed_cents: 10000,
      paid_cents: 8000,
      write_off_cents: 5000,
      od_claim_proc_num: over.confirmed === false ? null : 99001,
      ...(over.lineA || {}),
    }),
    procLine({
      line_id: LINE_B,
      position: 2,
      code: 'D0274',
      billed_cents: 6000,
      allowed_cents: 4000,
      paid_cents: 1000,
      write_off_cents: 2000,
      od_claim_proc_num: over.confirmed === false ? null : 99002,
      ...(over.lineB || {}),
    }),
  ]);
  db.seed('rcm_procedure_adjustments', []);
  return db;
}

/** A line row with every column the reads name — omitted keys read as undefined. */
function procLine(over) {
  return {
    claim_id: CLAIM,
    office_id: OFFICE,
    paid_code: null,
    billed_code: over.code,
    description: '',
    deductible_cents: 0,
    copay_cents: 0,
    adjustment_cents: 0,
    patient_resp_cents: 0,
    adjustment_reason: null,
    is_downcoded: false,
    is_bundled: false,
    is_denied: false,
    flags: [],
    /*
     * SEEDED EXPLICITLY, NOT OMITTED. An omitted key reads as `undefined` out of
     * the fake, which is a shape pg never produces — 6d's FakeRcmDb lesson.
     */
    line_decision: null,
    decision_reason: null,
    decided_by: null,
    decided_at: null,
    ...over,
  };
}

/** A v2 snapshot with a confirmation, which is what the gate and the view read. */
function snapshot(over = {}) {
  return {
    version: 2,
    office: OFFICE,
    officeName: 'Roland Family Dental',
    fetchedAt: '2026-03-02T11:00:00.000Z',
    odCalls: 3,
    truncated: false,
    notes: [],
    patientsConsidered: [{ patNum: 12828, name: 'Fixture, Synthetic' }],
    ambiguous: false,
    margin: null,
    rejectedCandidates: 0,
    rejectedReasons: { nameMismatch: 0, belowScore: 0 },
    minScore: 40,
    nameRuleApplied: true,
    takeback: false,
    candidates: [
      {
        odClaimNum: OD_CLAIM,
        odPatNum: 12828,
        score: 92,
        confidence: 'HIGH',
        evidence: [],
        blockers: [],
        od: {
          claimStatus: 'S',
          dateService: '2026-03-02',
          claimHeaderFeeCents: 21000,
          billedCents: 21000,
          insPaidCents: 0,
          writeOffCents: 0,
          patientName: 'Fixture, Synthetic',
          patientBirthdate: over.odBirthdate === undefined ? '1990-01-01' : over.odBirthdate,
          subscriberId: over.odSubscriberId === undefined ? 'ABC123456' : over.odSubscriberId,
          lines: [
            {
              claimProcNum: 99001,
              code: 'D0150',
              status: 'NotReceived',
              feeBilledCents: 15000,
              insEstCents: 8000,
              insPayAmtCents: 0,
              writeOffCents: 0,
              dedAppliedCents: 0,
              deleted: false,
              isTransfer: false,
              claimPaymentNum: null,
              blockedStatus: false,
            },
            {
              claimProcNum: 99002,
              code: 'D0274',
              status: 'NotReceived',
              feeBilledCents: 6000,
              insEstCents: null,
              insPayAmtCents: 0,
              writeOffCents: 0,
              dedAppliedCents: 0,
              deleted: false,
              isTransfer: false,
              claimPaymentNum: null,
              blockedStatus: false,
            },
          ],
          deletedLineCount: 0,
          unknownDeletedLineCount: 0,
        },
        linePairs: [
          { lineId: LINE_A, position: 1, code: 'D0150', odClaimProcNum: 99001, billedDeltaCents: 0, reason: null },
          { lineId: LINE_B, position: 2, code: 'D0274', odClaimProcNum: 99002, billedDeltaCents: over.feeDeltaB ?? 0, reason: null },
        ],
      },
    ],
    confirmed: {
      odClaimNum: OD_CLAIM,
      odPatNum: 12828,
      confirmedAt: '2026-03-02T11:05:00.000Z',
      confirmedBy: 'user-1',
      linePairs: [
        { lineId: LINE_A, position: 1, code: 'D0150', odClaimProcNum: 99001, billedDeltaCents: 0, reason: null },
        { lineId: LINE_B, position: 2, code: 'D0274', odClaimProcNum: 99002, billedDeltaCents: over.feeDeltaB ?? 0, reason: null },
      ],
      odAmountsAsRead: {
        billedCents: 21000,
        claimHeaderFeeCents: 21000,
        insPaidCents: 0,
        writeOffCents: 0,
        claimStatus: 'S',
      },
    },
    supersededConfirmation: null,
  };
}

const decide = (app, lineId, body) =>
  api(app.baseUrl, 'PUT', `/api/rcm/claims/${CLAIM}/lines/${lineId}/decision${Q}`, json(body));

const readClaim = (app) => api(app.baseUrl, 'GET', `/api/rcm/claims/${CLAIM}${Q}`);

const checklist = (app) =>
  api(app.baseUrl, 'GET', `/api/rcm/remittances/${BATCH}/approval${Q}`);

// ─── The verdict on the claim read ───────────────────────────────────────────

test('with nothing decided, the claim reads GREEN and the patient owes the EOB figure', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const res = await readClaim(app);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const v = res.body.claim.verdict;
    assert.equal(v.state, 'green');
    // Line A leaves 20.00, line B leaves 30.00.
    assert.equal(v.eobPatientCents, 5000);
    assert.equal(v.projectedPatientCents, 5000);
    assert.equal(v.decidedWriteOffCents, 0);
    assert.equal(v.register, 'projection', 'a read can only ever hold a projection');
    assert.match(v.sentence, /once posted — matches the EOB/);
  });
});

test('the carrier arithmetic ships per line, so the client never subtracts', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const lines = (await readClaim(app)).body.claim.lines;
    const a = lines.find((l) => l.lineId === LINE_A);
    assert.equal(a.contractualWriteOffCents, 5000, 'billed − allowed');
    assert.equal(a.patientRemainderCents, 2000, 'allowed − paid');
  });
});

test('the identity block compares the EOB against the chart, field by field', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const identity = (await readClaim(app)).body.claim.identity;
    assert.equal(identity.blocking, false);
    assert.deepEqual(
      identity.fields.map((f) => `${f.field}:${f.status}`),
      ['name:agrees', 'dob:agrees', 'subscriber:agrees']
    );
  });
});

test('a date of birth that disagrees BLOCKS, and both values are on the wire', async () => {
  const db = seed(new FakeRcmDb(), { odBirthdate: '1991-01-01' });
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const identity = (await readClaim(app)).body.claim.identity;
    assert.equal(identity.blocking, true);
    const dob = identity.fields.find((f) => f.field === 'dob');
    assert.equal(dob.eob, '1990-01-01');
    assert.equal(dob.od, '1991-01-01');
  });
});

// ─── Recording a decision ────────────────────────────────────────────────────

test('writing a line off turns the claim AMBER and names the reason and the person', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const res = await decide(app, LINE_B, {
      decision: 'office_writeoff',
      reason: 'xrays_bitewings',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.verdict.state, 'amber');
    assert.equal(res.body.verdict.projectedPatientCents, 2000, 'only line A reaches the patient');
    assert.equal(res.body.verdict.decidedWriteOffCents, 3000);
    assert.equal(res.body.verdict.decisions[0].reasonLabel, 'X-rays — bitewings');
    assert.equal(res.body.verdict.decisions[0].decidedBy, 'Billing User');

    // …and it is on the row, with its attribution.
    const line = db.table('rcm_procedure_lines').find((l) => l.line_id === LINE_B);
    assert.equal(line.line_decision, 'office_writeoff');
    assert.equal(line.decision_reason, 'xrays_bitewings');
    assert.equal(line.decided_by, 'user-1');
    assert.ok(line.decided_at, 'a decision is a person AND an instant');
  });
});

test('a decision is audited as an UPDATE against the claim, never as a read', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    await decide(app, LINE_B, { decision: 'office_writeoff', reason: 'build_up' });
    const rows = auditRows(db).filter((r) => r.resource_type === 'rcm_line_decision');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'UPDATE');
    assert.equal(rows[0].result, 'SUCCESS');
    assert.equal(rows[0].resource_id, CLAIM, 'an id we minted, never PHI');
    assert.equal(rows[0].office, OFFICE);
  });
});

test('an office write-off with NO reason is refused, and nothing is written', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const res = await decide(app, LINE_B, { decision: 'office_writeoff' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'WRITEOFF_REASON_REQUIRED');
    const line = db.table('rcm_procedure_lines').find((l) => l.line_id === LINE_B);
    assert.equal(line.line_decision, null, 'the refusal left the row alone');
  });
});

test('a reason that is not one of the canned five is refused', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const res = await decide(app, LINE_B, {
      decision: 'office_writeoff',
      reason: 'because she said so',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'WRITEOFF_REASON_REQUIRED');
  });
});

test('an unrecognised decision is refused rather than coerced', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    for (const decision of ['adjust', '', null, 'BILL_PATIENT']) {
      const res = await decide(app, LINE_B, { decision });
      assert.equal(res.status, 400, JSON.stringify(decision));
      assert.equal(res.body.code, 'INVALID_LINE_DECISION');
    }
  });
});

test('billing the patient CLEARS a reason rather than leaving it beside a bill', async () => {
  const db = seed(new FakeRcmDb(), {
    lineB: { line_decision: 'office_writeoff', decision_reason: 'build_up', decided_by: 'user-1', decided_at: new Date() },
  });
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const res = await decide(app, LINE_B, { decision: 'bill_patient', reason: 'build_up' });
    assert.equal(res.status, 200);
    const line = db.table('rcm_procedure_lines').find((l) => l.line_id === LINE_B);
    assert.equal(line.line_decision, 'bill_patient');
    assert.equal(line.decision_reason, null, 'a reason for a bill is a reason for nothing');
    assert.equal(res.body.verdict.state, 'green');
  });
});

test('pressing the same choice twice is the same state — PUT means what it says', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const first = await decide(app, LINE_B, { decision: 'office_writeoff', reason: 'build_up' });
    const second = await decide(app, LINE_B, { decision: 'office_writeoff', reason: 'build_up' });
    assert.equal(second.status, 200);
    assert.equal(first.body.verdict.decidedWriteOffCents, second.body.verdict.decidedWriteOffCents);
    assert.equal(
      db.table('rcm_procedure_lines').filter((l) => l.line_id === LINE_B).length,
      1,
      'one line, one decision'
    );
  });
});

test('a line on another claim, or another office, is NOT FOUND', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const res = await api(
      app.baseUrl,
      'PUT',
      `/api/rcm/claims/${CLAIM}/lines/00000000-0000-4000-8000-000000000000/decision${Q}`,
      json({ decision: 'bill_patient' })
    );
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'LINE_NOT_FOUND');
  });
});

// ─── The tier this runs at (D-9) ─────────────────────────────────────────────

test('a REVIEWER may decide — it is the reviewing act, not the authorising one', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'reviewer', od: new FakeOd({}) }, async (app) => {
    const res = await decide(app, LINE_B, { decision: 'office_writeoff', reason: 'not_chargeable' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
});

test('a role with no RCM tier at all cannot', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'tc', od: new FakeOd({}) }, async (app) => {
    const res = await decide(app, LINE_B, { decision: 'bill_patient' });
    assert.equal(res.status, 403);
  });
});

// ─── D-14: an approved claim is frozen ───────────────────────────────────────

test('a claim already on a posting cannot be re-decided, and the refusal says why', async () => {
  const db = seed(new FakeRcmDb(), { postingQueueId: 'c8a0b3f4-0000-4000-8000-000000000001' });
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const res = await decide(app, LINE_B, { decision: 'office_writeoff', reason: 'build_up' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'CLAIM_ON_POSTING_PLAN');
    assert.match(res.body.error, /approved for posting/i);
    const line = db.table('rcm_procedure_lines').find((l) => l.line_id === LINE_B);
    assert.equal(line.line_decision, null, 'the frozen record did not move');
  });
});

// ─── The screen and the gate cannot disagree ─────────────────────────────────

test('THE SCREEN AND THE GATE READ ONE FUNCTION — green', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const screen = (await readClaim(app)).body.claim.verdict;
    const gate = (await checklist(app)).body.claims[0];
    const check = gate.checks.find((c) => c.code === 'PATIENT_RESPONSIBILITY_MATCHES');

    assert.equal(screen.state, 'green');
    assert.equal(check.passed, true);
    assert.equal(gate.verdict.state, screen.state);
    assert.equal(gate.verdict.projectedPatientCents, screen.projectedPatientCents);
    assert.equal(gate.verdict.eobPatientCents, screen.eobPatientCents);
    assert.equal(gate.verdict.sentence, screen.sentence);
  });
});

test('THE SCREEN AND THE GATE READ ONE FUNCTION — amber passes, with the decisions named', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    await decide(app, LINE_B, { decision: 'office_writeoff', reason: 'xrays_bitewings' });

    const screen = (await readClaim(app)).body.claim.verdict;
    const gate = (await checklist(app)).body.claims[0];
    const check = gate.checks.find((c) => c.code === 'PATIENT_RESPONSIBILITY_MATCHES');

    assert.equal(screen.state, 'amber');
    assert.equal(check.passed, true, 'a decided, explained write-off is the case this allows');
    assert.match(check.detail, /D0274 \$30\.00 — X-rays — bitewings \(Billing User\)/);
    assert.equal(gate.verdict.sentence, screen.sentence);
    assert.equal(gate.postable, true);
  });
});

test('THE SCREEN AND THE GATE READ ONE FUNCTION — red refuses, and the claim is withheld', async () => {
  // Open Dental was billed 10.00 less on line B than the carrier says.
  const db = seed(new FakeRcmDb(), { feeDeltaB: 1000 });
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    const screen = (await readClaim(app)).body.claim.verdict;
    const gate = (await checklist(app)).body.claims[0];
    const check = gate.checks.find((c) => c.code === 'PATIENT_RESPONSIBILITY_MATCHES');

    assert.equal(screen.state, 'red');
    assert.equal(check.passed, false, 'RED CANNOT APPROVE');
    assert.equal(check.detail, screen.sentence, 'the checklist prints the screen’s own sentence');
    assert.equal(gate.postable, false);
    assert.ok(gate.failed.includes('PATIENT_RESPONSIBILITY_MATCHES'));
  });
});

// ─── Approving snapshots the decision (D-14) ─────────────────────────────────

test('approving FREEZES the decision onto the posting line, beside the contractual figure', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, od: new FakeOd({}) }, async (app) => {
    await decide(app, LINE_B, { decision: 'office_writeoff', reason: 'xrays_panoramic' });

    const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/${BATCH}/approve${Q}`, json({}));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.queued.length, 1);

    const lines = db.table('rcm_posting_queue_line');
    const a = lines.find((l) => Number(l.od_claim_proc_num) === 99001);
    const b = lines.find((l) => Number(l.od_claim_proc_num) === 99002);

    // The undecided line carries no decision at all — NULL, not zero.
    assert.equal(a.decided_write_off_cents, null);
    assert.equal(a.decided_reason, null);
    assert.equal(a.decided_by, null);

    // The decided one carries all three, SEPARATE from the carrier's own figure.
    assert.equal(b.intended_write_off_cents, 2000, "the carrier's contractual write-off");
    assert.equal(b.decided_write_off_cents, 3000, "and the office's own, kept apart from it");
    assert.equal(b.decided_reason, 'xrays_panoramic');
    assert.equal(b.decided_by, 'user-1');

    /*
     * STAGE B2: AND IT FREEZES THE PROMISE.
     *
     * R as approved, before the office's decision — what this claim said the
     * patient would owe. After the post the drain compares Open Dental against
     * THIS, because the only other way to recover R later is to derive it from
     * the chart's own fee, which moves if somebody edits the fee and takes the
     * promise with it. A confirmation that cannot disagree is not one.
     */
    assert.equal(a.intended_patient_cents, 2000, 'the line being billed: allowed − paid');
    assert.equal(b.intended_patient_cents, 3000, 'the written-off line, BEFORE the write-off');
  });
});
