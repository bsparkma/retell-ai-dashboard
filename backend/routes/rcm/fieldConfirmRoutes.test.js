'use strict';

/**
 * THE CONFIRM STEP, through the FULLY-ASSEMBLED chain.
 *
 * Everything here goes over a real HTTP server running the real auth gate,
 * tenantContext, `requireModule('rcm')`, the mount's method-based read/write
 * split and the real `routes/rcm/index.js` — the same harness the rest of the
 * module uses, and for the same reason: a test that called the handler directly
 * would stay green with the permission gate deleted.
 *
 * No real patient data. Synthetic names, invented amounts, uuid ids.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeRcmDb, bootRcmApp, api, auditRows } = require('./rcmTestUtils');

const BATCH = '8acb0e32-35ae-5cd8-9692-7b5e318a31c2';
const CLAIM = 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d';
const LINE = 'a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90';
const UPLOAD = 'f4c1a0de-6b52-4a1e-9f77-2c6a0b9d4e31';

const Q = '?office=roland';
const json = (body) => ({ body: JSON.stringify(body), json: true });

/**
 * A one-claim, one-line check read off a SCAN.
 *
 * The figures are the real case, reduced: the crown line's covered amount is
 * $1,229.00 and its payment is NOT STATED, which is what a category-subtotal
 * layout produces once the read stops promoting covered into paid. The cheque is
 * for $184.00, so the claim total as read does NOT reconcile — which is exactly
 * the state a biller has to resolve on this screen.
 */
function seedScannedCheck(db, { textSource = 'ocr', claimTotalPaidCents = 18400 } = {}) {
  db.seed('rcm_payment_batches', [
    {
      batch_id: BATCH,
      office_id: 'roland',
      payer: 'Meridian Mutual Dental',
      check_number: 'SYN-000123',
      deposit_date: '2026-09-15',
      total_amount_cents: 18400,
      plb_total_cents: 0,
      flags: [],
      status: 'open',
    },
  ]);
  db.seed('rcm_eob_uploads', [
    {
      upload_id: UPLOAD,
      office_id: 'roland',
      result_batch_id: BATCH,
      filename: 'SYNTHETIC-scan.pdf',
      text_source: textSource,
      ocr_page_count: 1,
      ocr_mean_confidence: 0.991,
      status: 'extracted',
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: CLAIM,
      office_id: 'roland',
      patient_name: 'Synthetic, Patient A',
      claim_number: 'SYNCLM0001',
      service_date: '2026-09-15',
      total_paid_cents: claimTotalPaidCents,
      needs_review_reasons: ['line_paid_not_stated'],
      status: 'pending_review',
    },
  ]);
  db.seed('rcm_batch_claim_payments', [
    {
      batch_claim_payment_id: '0b2f9a54-1d7e-4c3a-8f21-5b6d7e8a9c01',
      batch_id: BATCH,
      claim_id: CLAIM,
      office_id: 'roland',
      position: 0,
      paid_cents: claimTotalPaidCents,
      status: 'pending',
    },
  ]);
  db.seed('rcm_procedure_lines', [
    {
      line_id: LINE,
      claim_id: CLAIM,
      office_id: 'roland',
      position: 0,
      code: 'D2750',
      description: 'Crown - porcelain/ceramic',
      billed_cents: 131500,
      allowed_cents: 122900,
      deductible_cents: 0,
      copay_cents: 0,
      // NOT STATED. The whole point of Part 1.
      paid_cents: null,
      flags: [],
    },
  ]);
  return db;
}

/** Boot with a scanned check already seeded. */
async function bootConfirm(opts = {}) {
  const db = new FakeRcmDb();
  seedScannedCheck(db, opts);
  return bootRcmApp({ ...opts, db });
}

// ─── The gate ────────────────────────────────────────────────────────────────

test('the POST demands rcm.write — confirming a figure is not a read-tier act', async () => {
  // Deliberately NOT one of the mount's enumerated read-tier exceptions:
  // confirming a figure is what lets money reach a chart.
  const { baseUrl, close } = await bootConfirm({ role: 'tc' });
  try {
    const res = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({ fields: [{ field: 'check_total', confirmedCents: 18400 }] }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
    assert.equal(res.body.action, 'rcm.write');
  } finally {
    await close();
  }
});

test('an anonymous caller gets 401, not a confirmation', async () => {
  const { baseUrl, db, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      anon: true,
      ...json({ fields: [{ field: 'check_total', confirmedCents: 18400 }] }),
    });
    assert.equal(res.status, 401);
    assert.equal(db.table('rcm_eob_field_confirmations').length, 0);
  } finally {
    await close();
  }
});

test('another office cannot see the check at all — a miss, not a refusal', async () => {
  const { baseUrl, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'GET', `/api/rcm/field-confirm/${BATCH}?office=valley`);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'BATCH_NOT_FOUND');
  } finally {
    await close();
  }
});

// ─── What the screen renders ─────────────────────────────────────────────────

test('the GET puts the CHECK TOTAL at the top level — it is the anchor, not one of the claims', async () => {
  const { baseUrl, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'GET', `/api/rcm/field-confirm/${BATCH}${Q}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.required, true);
    assert.equal(res.body.checkTotal.cents, 18400);
    assert.equal(res.body.checkTotal.stated, true);
    assert.equal(res.body.checkTotal.confirmed, false);
    assert.equal(res.body.checkTotal.source, 'extracted');
    assert.equal(res.body.payer, 'Meridian Mutual Dental');
  } finally {
    await close();
  }
});

test('a figure the document does not state renders as NOT STATED, never as a number', async () => {
  const { baseUrl, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'GET', `/api/rcm/field-confirm/${BATCH}${Q}`);
    const line = res.body.claims[0].lines[0];
    const paid = line.fields.find((f) => f.field === 'line_paid');
    assert.equal(paid.cents, null);
    assert.equal(paid.stated, false);
    assert.equal(paid.confirmed, false);

    // The covered amount IS on the page, and is reported as itself.
    const allowed = line.fields.find((f) => f.field === 'line_allowed');
    assert.equal(allowed.cents, 122900);
    assert.equal(allowed.stated, true);
    // The fabrication, by value: it must not have travelled into paid.
    assert.notEqual(paid.cents, 122900);
  } finally {
    await close();
  }
});

test('the GET carries the provenance, the outstanding count and the difference', async () => {
  const { baseUrl, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'GET', `/api/rcm/field-confirm/${BATCH}${Q}`);
    assert.equal(res.body.provenance.textSource, 'ocr');
    assert.equal(res.body.provenance.ocrPageCount, 1);
    assert.equal(res.body.provenance.uploadId, UPLOAD);
    // One check total + one claim total + five line fields.
    assert.equal(res.body.outstanding.outstanding, 7);
    assert.equal(res.body.outstanding.ok, false);
    // As read, the claim total already equals the cheque.
    assert.equal(res.body.sums.comparable, true);
    assert.equal(res.body.sums.differenceCents, 0);
  } finally {
    await close();
  }
});

test('the check-snapshot slot and the per-line region are present and EMPTY, not omitted', async () => {
  /*
   * Both are seams a later slice fills, and both are rendered as explicit nulls
   * so the client can distinguish "there is no image" from "this server does not
   * say". `region` is null because the stored OCR result carries no geometry —
   * `documentOcr.summarize` keeps text, pages, words and confidence and discards
   * the polygons — and re-running OCR to recover a box is ruled out.
   */
  const { baseUrl, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'GET', `/api/rcm/field-confirm/${BATCH}${Q}`);
    assert.ok('checkImage' in res.body);
    assert.equal(res.body.checkImage, null);
    const line = res.body.claims[0].lines[0];
    assert.ok('region' in line);
    assert.equal(line.region, null);
  } finally {
    await close();
  }
});

test('the GET audits the read — patient names make it a PHI path', async () => {
  const { baseUrl, db, close } = await bootConfirm();
  try {
    await api(baseUrl, 'GET', `/api/rcm/field-confirm/${BATCH}${Q}`);
    const rows = auditRows(db).filter((r) => r.resource_type === 'rcm_eob_field_confirmation');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'READ');
    assert.equal(rows[0].result, 'SUCCESS');
    assert.equal(rows[0].resource_id, BATCH);
  } finally {
    await close();
  }
});

// ─── An 835 has no page to check against ─────────────────────────────────────

test('an 835 says the step does not apply, and refuses a confirmation', async () => {
  const { baseUrl, db, close } = await bootConfirm({ textSource: null });
  try {
    const get = await api(baseUrl, 'GET', `/api/rcm/field-confirm/${BATCH}${Q}`);
    assert.equal(get.status, 200);
    assert.equal(get.body.required, false, 'the screen says so rather than rendering an empty list');

    const post = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({ fields: [{ field: 'check_total', confirmedCents: 18400 }] }),
    });
    assert.equal(post.status, 409);
    assert.equal(post.body.code, 'NOT_A_SCANNED_CHECK');
    assert.equal(
      db.table('rcm_eob_field_confirmations').length,
      0,
      'a row asserting somebody verified something unverifiable must not exist'
    );
  } finally {
    await close();
  }
});

// ─── Confirming, and correcting ──────────────────────────────────────────────

test('confirming a figure that matches the read is recorded as CONFIRMED', async () => {
  const { baseUrl, db, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({ fields: [{ field: 'check_total', confirmedCents: 18400 }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.confirmed[0].state, 'confirmed');
    assert.equal(res.body.confirmed[0].cents, 18400);
    assert.equal(res.body.confirmed[0].extractedCents, 18400);

    const rows = db.table('rcm_eob_field_confirmations');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].field, 'check_total');
    assert.equal(rows[0].state, 'confirmed');
    assert.ok(rows[0].confirmed_by, 'a confirmation with no author is not one');
  } finally {
    await close();
  }
});

test('typing a DIFFERENT figure is recorded as CORRECTED, with the original preserved', async () => {
  /*
   * The act the whole screen exists for. The read said the claim was paid
   * $1,229.00 — a promoted covered amount — and the biller reads $184.00 off the
   * page. The original survives in `extracted_cents`, which is what lets the
   * screen say "corrected by <name> from the page image" afterwards.
   */
  const { baseUrl, db, close } = await bootConfirm({ claimTotalPaidCents: 122900 });
  try {
    const res = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({ fields: [{ claimId: CLAIM, field: 'claim_total_paid', confirmedCents: 18400 }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.confirmed[0].state, 'corrected');
    assert.equal(res.body.confirmed[0].cents, 18400);
    assert.equal(res.body.confirmed[0].extractedCents, 122900);

    const row = db.table('rcm_eob_field_confirmations')[0];
    assert.equal(Number(row.extracted_cents), 122900);
    assert.equal(Number(row.confirmed_cents), 18400);
  } finally {
    await close();
  }
});

test('the SERVER decides what was extracted — a client cannot file a correction as an agreement', async () => {
  /*
   * A request carries a field and a figure and nothing else. If it could also
   * supply the extracted value, it could make the two match and the
   * "corrected by" line would never appear over a changed number.
   */
  const { baseUrl, db, close } = await bootConfirm({ claimTotalPaidCents: 122900 });
  try {
    await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({
        fields: [
          {
            claimId: CLAIM,
            field: 'claim_total_paid',
            confirmedCents: 18400,
            // A lie, and it must be ignored.
            extractedCents: 18400,
            state: 'confirmed',
          },
        ],
      }),
    });
    const row = db.table('rcm_eob_field_confirmations')[0];
    assert.equal(row.state, 'corrected');
    assert.equal(Number(row.extracted_cents), 122900);
  } finally {
    await close();
  }
});

test('confirming NOT STATED is a real answer, and stays null rather than becoming zero', async () => {
  // A category-subtotal EOB has no per-line payment to type. Demanding a number
  // would force the invention this slice exists to remove.
  const { baseUrl, db, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({ fields: [{ claimId: CLAIM, lineId: LINE, field: 'line_paid', confirmedCents: null }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.confirmed[0].state, 'confirmed', 'null agrees with an unstated read');
    assert.equal(res.body.confirmed[0].cents, null);

    const row = db.table('rcm_eob_field_confirmations')[0];
    assert.equal(row.confirmed_cents, null);

    // ...and the GET then reports it as confirmed AND not stated, which are
    // different axes and must both survive the round trip.
    const get = await api(baseUrl, 'GET', `/api/rcm/field-confirm/${BATCH}${Q}`);
    const paid = get.body.claims[0].lines[0].fields.find((f) => f.field === 'line_paid');
    assert.equal(paid.confirmed, true);
    assert.equal(paid.stated, false);
    assert.equal(paid.cents, null);
    assert.equal(paid.source, 'confirmed');
  } finally {
    await close();
  }
});

test('confirming a whole line in one request writes one row per field', async () => {
  const { baseUrl, db, close } = await bootConfirm();
  try {
    const fields = [
      { claimId: CLAIM, lineId: LINE, field: 'line_paid', confirmedCents: null },
      { claimId: CLAIM, lineId: LINE, field: 'line_billed', confirmedCents: 131500 },
      { claimId: CLAIM, lineId: LINE, field: 'line_allowed', confirmedCents: 122900 },
      { claimId: CLAIM, lineId: LINE, field: 'line_deductible', confirmedCents: 0 },
      { claimId: CLAIM, lineId: LINE, field: 'line_copay', confirmedCents: 0 },
    ];
    const res = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, { ...json({ fields }) });
    assert.equal(res.status, 200);
    assert.equal(res.body.confirmed.length, 5);
    assert.equal(db.table('rcm_eob_field_confirmations').length, 5);
  } finally {
    await close();
  }
});

test('re-confirming a field UPDATES the one row rather than stacking answers', async () => {
  // The table holds current state; history is audit_log. Two rows for one field
  // would leave the accessor reading one of them arbitrarily.
  const { baseUrl, db, close } = await bootConfirm();
  try {
    await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({ fields: [{ field: 'check_total', confirmedCents: 18400 }] }),
    });
    await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({ fields: [{ field: 'check_total', confirmedCents: 19900 }] }),
    });
    const rows = db.table('rcm_eob_field_confirmations');
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].confirmed_cents), 19900);
    assert.equal(rows[0].state, 'corrected');
  } finally {
    await close();
  }
});

test('every confirmation is audited, one row per field', async () => {
  const { baseUrl, db, close } = await bootConfirm();
  try {
    await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({
        fields: [
          { field: 'check_total', confirmedCents: 18400 },
          { claimId: CLAIM, field: 'claim_total_paid', confirmedCents: 18400 },
        ],
      }),
    });
    const rows = auditRows(db).filter(
      (r) => r.resource_type === 'rcm_eob_field_confirmation' && r.action === 'UPDATE'
    );
    assert.equal(rows.length, 2, 'the trail\'s unit is the field, not the request');
    for (const row of rows) {
      assert.equal(row.result, 'SUCCESS');
      assert.equal(row.source_ref, BATCH, 'the check it belongs to');
    }
  } finally {
    await close();
  }
});

// ─── Refusals ────────────────────────────────────────────────────────────────

test('a field outside the vocabulary is refused by name', async () => {
  const { baseUrl, db, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({ fields: [{ claimId: CLAIM, lineId: LINE, field: 'line_invented', confirmedCents: 1 }] }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'UNKNOWN_FIELD');
    assert.match(res.body.error, /line_invented/);
    assert.equal(db.table('rcm_eob_field_confirmations').length, 0);
  } finally {
    await close();
  }
});

test('a field sent against the wrong scope is refused before the database sees it', async () => {
  const { baseUrl, close } = await bootConfirm();
  try {
    // check_total belongs to the check, not to a claim.
    const a = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({ fields: [{ claimId: CLAIM, field: 'check_total', confirmedCents: 1 }] }),
    });
    assert.equal(a.status, 400);
    assert.equal(a.body.code, 'FIELD_SCOPE');

    // line_paid needs a line.
    const b = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({ fields: [{ claimId: CLAIM, field: 'line_paid', confirmedCents: 1 }] }),
    });
    assert.equal(b.status, 400);
    assert.equal(b.body.code, 'FIELD_SCOPE');
  } finally {
    await close();
  }
});

test('a claim or line that is not on this check is refused', async () => {
  const { baseUrl, close } = await bootConfirm();
  try {
    const a = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({
        fields: [
          { claimId: '11111111-1111-4111-8111-111111111111', field: 'claim_total_paid', confirmedCents: 1 },
        ],
      }),
    });
    assert.equal(a.status, 400);
    assert.equal(a.body.code, 'CLAIM_NOT_ON_CHECK');

    const b = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({
        fields: [
          {
            claimId: CLAIM,
            lineId: '22222222-2222-4222-8222-222222222222',
            field: 'line_paid',
            confirmedCents: 1,
          },
        ],
      }),
    });
    assert.equal(b.status, 400);
    assert.equal(b.body.code, 'LINE_NOT_ON_CLAIM');
  } finally {
    await close();
  }
});

test('an omitted figure is a refusal, not a silent "not stated"', async () => {
  // Recording "the page says nothing" on a field nobody looked at would be the
  // same class of lie as inventing a number for it.
  const { baseUrl, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({ fields: [{ field: 'check_total' }] }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'FIGURE_MISSING');
  } finally {
    await close();
  }
});

test('a non-integer, a fractional cent and a negative figure are all refused', async () => {
  const { baseUrl, close } = await bootConfirm();
  try {
    for (const [value, code] of [
      ['18400', 'FIGURE_NOT_AN_INTEGER'],
      [184.5, 'FIGURE_NOT_AN_INTEGER'],
      [-100, 'FIGURE_NEGATIVE'],
    ]) {
      const res = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
        ...json({ fields: [{ field: 'check_total', confirmedCents: value }] }),
      });
      assert.equal(res.status, 400, `${value} must be refused`);
      assert.equal(res.body.code, code);
    }
  } finally {
    await close();
  }
});

test('the same field twice in one request is refused rather than silently last-wins', async () => {
  const { baseUrl, db, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({
        fields: [
          { field: 'check_total', confirmedCents: 18400 },
          { field: 'check_total', confirmedCents: 19900 },
        ],
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'DUPLICATE_FIELD');
    assert.equal(db.table('rcm_eob_field_confirmations').length, 0);
  } finally {
    await close();
  }
});

test('an empty or missing field list says what to send', async () => {
  const { baseUrl, close } = await bootConfirm();
  try {
    for (const body of [{}, { fields: [] }, { fields: 'all' }]) {
      const res = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, { ...json(body) });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'NO_FIELDS');
    }
  } finally {
    await close();
  }
});

test('ONE bad field refuses the WHOLE request — a confirm list is all or nothing', async () => {
  /*
   * A partial write would leave the biller looking at a line where four figures
   * are confirmed and one silently is not, with a success toast over it. The
   * outstanding count would be right and the screen would be wrong.
   */
  const { baseUrl, db, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({
        fields: [
          { claimId: CLAIM, lineId: LINE, field: 'line_billed', confirmedCents: 131500 },
          { claimId: CLAIM, lineId: LINE, field: 'line_invented', confirmedCents: 1 },
        ],
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(db.table('rcm_eob_field_confirmations').length, 0, 'nothing may be written');
  } finally {
    await close();
  }
});

// ─── The check page needs to know whether bringing this check in is finished ──

test('the check detail carries how much of a scanned read is still unchecked', async () => {
  /*
   * A SUMMARY, not the figures. The check page's rail and its one primary need
   * exactly two things — is the confirm step finished, and if not how much is
   * left — and shipping the amounts as well would put a second copy of every
   * figure on a page that does not render them.
   */
  const { baseUrl, close } = await bootConfirm();
  try {
    const res = await api(baseUrl, 'GET', `/api/rcm/remittances/${BATCH}${Q}`);
    assert.equal(res.status, 200);

    const fc = res.body.remittance.fieldConfirm;
    assert.ok(fc, 'the check page cannot draw the step without this');
    assert.equal(fc.required, true);
    assert.equal(fc.ok, false);
    // One check total + one claim total + five line fields.
    assert.equal(fc.outstanding, 7);
    // And no figures rode along with it.
    assert.ok(!('claims' in fc));
    assert.ok(!('checkTotal' in fc));
  } finally {
    await close();
  }
});

test('the count falls as the work is done, and clears when it is', async () => {
  const { baseUrl, close } = await bootConfirm();
  try {
    await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, {
      ...json({ fields: [{ field: 'check_total', confirmedCents: 18400 }] }),
    });
    const part = await api(baseUrl, 'GET', `/api/rcm/remittances/${BATCH}${Q}`);
    assert.equal(part.body.remittance.fieldConfirm.outstanding, 6);
    assert.equal(part.body.remittance.fieldConfirm.ok, false);

    const rest = [
      { claimId: CLAIM, field: 'claim_total_paid', confirmedCents: 18400 },
      { claimId: CLAIM, lineId: LINE, field: 'line_paid', confirmedCents: null },
      { claimId: CLAIM, lineId: LINE, field: 'line_billed', confirmedCents: 131500 },
      { claimId: CLAIM, lineId: LINE, field: 'line_allowed', confirmedCents: 122900 },
      { claimId: CLAIM, lineId: LINE, field: 'line_deductible', confirmedCents: 0 },
      { claimId: CLAIM, lineId: LINE, field: 'line_copay', confirmedCents: 0 },
    ];
    await api(baseUrl, 'POST', `/api/rcm/field-confirm/${BATCH}${Q}`, { ...json({ fields: rest }) });

    const done = await api(baseUrl, 'GET', `/api/rcm/remittances/${BATCH}${Q}`);
    assert.equal(done.body.remittance.fieldConfirm.ok, true);
    assert.equal(done.body.remittance.fieldConfirm.outstanding, 0);
  } finally {
    await close();
  }
});

test('an 835 reports the step as NOT REQUIRED, so its rail is untouched', async () => {
  /*
   * The 835 flow is untouched BY CONSTRUCTION: `required: false` makes the
   * client draw exactly what it drew before the confirm step existed, rather
   * than by a branch on the screen that somebody has to remember to write.
   */
  const { baseUrl, close } = await bootConfirm({ textSource: null });
  try {
    const res = await api(baseUrl, 'GET', `/api/rcm/remittances/${BATCH}${Q}`);
    assert.deepEqual(res.body.remittance.fieldConfirm, {
      required: false,
      ok: true,
      outstanding: 0,
    });
  } finally {
    await close();
  }
});

test('a text-layer PDF is not confirmed either — only a scan is', async () => {
  const { baseUrl, close } = await bootConfirm({ textSource: 'text_layer' });
  try {
    const res = await api(baseUrl, 'GET', `/api/rcm/remittances/${BATCH}${Q}`);
    assert.equal(res.body.remittance.fieldConfirm.required, false);
  } finally {
    await close();
  }
});
