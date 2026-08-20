'use strict';

/**
 * POST/GET /api/rcm/era — route tests (RCM Slice 5).
 *
 * Every test boots the REAL assembled chain (auth gate → tenantContext →
 * requireModule('rcm') → requireReadWrite → routes/rcm/index.js) and executes
 * the routes' ACTUAL SQL against FakeRcmDb, transactions and the
 * `(office_id, remittance_key)` unique constraint included. A test that called
 * the handler directly would pass with the office guard or the reservation
 * deleted, which is the whole reason the harness works this way.
 *
 * THE STAR IS `uploading the same 835 twice`. Everything else supports it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FakeRcmDb,
  bootRcmApp,
  api,
  filePart,
  auditRows,
  fixture835,
  defaultEraStoreStub,
} = require('./rcmTestUtils');

/** What a browser labels an .edi upload, and what filePart stamps on it. */
const EDI = 'application/edi-x12';

const MULTI = fixture835('Test_Delta_Dental_MultiClaim.edi');
const REVERSAL = fixture835('Test_Reversal_Recoupment.edi');
// Slice 5.5 moved the "clean" baseline. Test_Guardian_Clean.edi is clean in
// every way its author intended, but its AMT*B6 carries the BILLED amount
// rather than the allowed one, so A3 now (correctly) raises
// allowed_amount_mismatch on it — as it does on 25 of the corpus's 37 AMT*B6
// lines. See the corpus note in test/fixtures/rcm/README.md.
const CLEAN = fixture835('Test_Clean_Conformant.edi');

/** Boot, run, always close. */
async function withApp(opts, fn) {
  const app = await bootRcmApp(opts);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

// ─── The headline: uploading the same 835 twice ─────────────────────────────

test('THE STAR: uploading the same 835 twice creates ZERO new proposals and says so', async () => {
  await withApp({}, async (app) => {
    const first = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'delta_multiclaim.edi', EDI),
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.counts.batches, 1);
    assert.equal(first.body.counts.claims, 2);

    const before = {
      batches: app.db.table('rcm_payment_batches').length,
      claims: app.db.table('rcm_claims').length,
      lines: app.db.table('rcm_procedure_lines').length,
      adjustments: app.db.table('rcm_procedure_adjustments').length,
      uploads: app.db.table('rcm_eob_uploads').length,
    };

    const second = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'delta_multiclaim_again.edi', EDI),
    });

    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'REMITTANCE_ALREADY_PROCESSED');
    assert.equal(second.body.success, false);

    // Honest: it names the remittance and when it was first processed, so an
    // operator can go and look at what they already have.
    assert.match(second.body.error, /^Already processed: remittance /);
    assert.match(second.body.error, /830200001\|DELTA DENTAL OF ARKANSAS\|2026-03-02\|65100\|830200001/);
    assert.equal(second.body.remittances.length, 1);
    assert.equal(second.body.remittances[0].status, 'posted');
    assert.equal(second.body.remittances[0].batchId, first.body.remittances[0].batchId);
    assert.ok(second.body.remittances[0].processedAt);

    // ZERO new proposals. Not one row of any kind.
    assert.deepEqual(
      {
        batches: app.db.table('rcm_payment_batches').length,
        claims: app.db.table('rcm_claims').length,
        lines: app.db.table('rcm_procedure_lines').length,
        adjustments: app.db.table('rcm_procedure_adjustments').length,
        uploads: app.db.table('rcm_eob_uploads').length,
      },
      before
    );
  });
});

test('there is NO override — no query param, header, or body field bypasses dedupe', async () => {
  // `forceDuplicate` has no successor. If one is ever added, this test is where
  // the decision has to be argued.
  await withApp({}, async (app) => {
    await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });

    for (const query of [
      '&force=true',
      '&forceDuplicate=true',
      '&override=1',
      '&allowDuplicate=true',
      '&skipDedupe=true',
    ]) {
      const res = await api(app.baseUrl, 'POST', `/api/rcm/era?office=roland${query}`, {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
      assert.equal(res.status, 409, `${query} must not bypass the remittance key`);
    }
    assert.equal(app.db.table('rcm_payment_batches').length, 1);
  });
});

test('the SAME file uploaded to the OTHER office is accepted', async () => {
  // Office is in the key's uniqueness. Two practices legitimately receive
  // distinct checks whose components collide, and a global key would let one
  // office's remittance silently block the other's.
  await withApp({}, async (app) => {
    const roland = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
    const valley = await api(app.baseUrl, 'POST', '/api/rcm/era?office=valley', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });

    assert.equal(roland.status, 201);
    assert.equal(valley.status, 201);
    assert.notEqual(roland.body.remittances[0].batchId, valley.body.remittances[0].batchId);

    const offices = app.db.table('rcm_payment_batches').map((b) => b.office_id).sort();
    assert.deepEqual(offices, ['roland', 'valley']);
    // Every child row carries the office too, so a cross-office read is
    // structurally impossible rather than merely unlikely.
    assert.deepEqual([...new Set(app.db.table('rcm_claims').map((c) => c.office_id))].sort(), [
      'roland',
      'valley',
    ]);
    assert.deepEqual(
      [...new Set(app.db.table('rcm_procedure_adjustments').map((a) => a.office_id))].sort(),
      ['roland', 'valley']
    );
  });
});

// ─── What a successful upload actually writes ───────────────────────────────

test('the canonical multi-claim file produces one batch, two claims, four lines', async () => {
  await withApp({}, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'delta.edi', EDI),
    });

    assert.equal(res.status, 201);
    // FOSTER001: CO-45, CO-45, (CO-169 + CO-45) = 4. NAVARRO001: CO-45 + PR-2 = 2.
    assert.deepEqual(res.body.counts, { batches: 1, claims: 2, lines: 4, adjustments: 6 });

    const [batch] = app.db.table('rcm_payment_batches');
    assert.equal(batch.payer, 'DELTA DENTAL OF ARKANSAS');
    assert.equal(batch.total_amount_cents, 65_100);
    assert.equal(batch.claim_count, 2);
    assert.equal(batch.payment_method, 'eft');
    // An EFT's trace goes in eft_number, a paper check's in check_number, so a
    // later reconciliation joins on the right one.
    assert.equal(batch.eft_number, '830200001');
    assert.equal(batch.check_number, null);
    assert.equal(batch.deposit_date, '2026-03-02');
    // Slice 5.5: this file's AMT*B6 carries the BILLED amount rather than the
    // allowed one, so A3 (correctly) raises allowed_amount_mismatch and the
    // batch is held. See the corpus note in test/fixtures/rcm/README.md.
    assert.equal(batch.status, 'open');
    assert.deepEqual(batch.flags, []);

    const claims = app.db.table('rcm_claims');
    assert.deepEqual(claims.map((c) => c.claim_number).sort(), ['FOSTER001', 'NAVARRO001']);
    assert.ok(claims.every((c) => c.status === 'pending_review'));
    assert.ok(claims.every((c) => c.source === 'manual_upload'));
    assert.ok(claims.every((c) => c.eob_file_key === res.body.upload.fileKey));

    // One batch_claim_payment per claim, positioned.
    assert.deepEqual(
      app.db.table('rcm_batch_claim_payments').map((p) => p.position).sort(),
      [1, 2]
    );
    assert.ok(app.db.table('rcm_batch_claim_payments').every((p) => p.status === 'pending'));

    // The upload record points at what it produced.
    const [upload] = app.db.table('rcm_eob_uploads');
    assert.equal(upload.status, 'extracted');
    assert.equal(upload.result_batch_id, batch.batch_id);
    assert.equal(upload.filename, 'delta.edi');
    // Platform rule: rows carry blob KEYS, and there is no URL to give.
    assert.equal(upload.file_url, '');
  });
});

test('HARD RULE 1: nothing about Open Dental is touched, read, or written', async () => {
  await withApp({}, async (app) => {
    await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });

    // Matching a remittance line to a real OD claim is Slice 6's job — it needs
    // the odReads seam and one audit row per PHI read, neither of which exists
    // here. Every OD linkage column stays null.
    assert.ok(app.db.table('rcm_claims').every((c) => c.od_patient_id == null));
    assert.ok(app.db.table('rcm_claims').every((c) => c.od_claim_num == null));
    assert.ok(app.db.table('rcm_procedure_lines').every((l) => l.od_claim_proc_num == null));
    // And nothing was claimed about our own chart.
    assert.ok(app.db.table('rcm_claims').every((c) => c.total_received_cents === 0));
    assert.ok(app.db.table('rcm_claims').every((c) => c.payment_status === 'unpaid'));
    assert.ok(app.db.table('rcm_claims').every((c) => c.pms_synced === undefined || c.pms_synced === false));

    // No OD table or route name appears in any SQL this request issued.
    const sql = app.db.log.map((e) => e.sql).join(' ');
    assert.ok(!/opendental|claimproc|claimpayment/i.test(sql));
  });
});

test('STEDI STAYS DORMANT: no poll state, no stedi rows, no stedi linkage', async () => {
  await withApp({}, async (app) => {
    await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });

    assert.equal(app.db.table('rcm_stedi_poll_state').length, 0);
    assert.equal(app.db.table('rcm_stedi_events').length, 0);
    assert.equal(app.db.table('rcm_stedi_transactions').length, 0);
    assert.ok(app.db.table('rcm_payment_batches').every((b) => b.stedi_transaction_id === undefined));
  });
});

test('the blob key is opaque — no filename, no patient name, no office in the path', async () => {
  const store = defaultEraStoreStub();
  await withApp({ eraStore: store }, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'Delta_FOSTER_Emily_0302.edi', EDI),
    });

    const key = res.body.upload.fileKey;
    assert.match(key, /^tenant\/carein\/rcm\/era\/[0-9a-f-]{36}\.edi$/);
    for (const leak of ['FOSTER', 'Emily', 'Delta', 'roland', 'NAVARRO']) {
      assert.ok(!key.includes(leak), `blob key must not carry '${leak}'`);
    }
    // The name IS kept — on the row, where it is documented PHI and guarded.
    assert.equal(app.db.table('rcm_eob_uploads')[0].filename, 'Delta_FOSTER_Emily_0302.edi');
    assert.equal(store.puts.length, 1);
    assert.equal(store.puts[0].bytes, Buffer.byteLength(MULTI));
  });
});

// ─── Honest states: structures we parse but will not act on ─────────────────

test('a reversal is CREATED and FLAGGED — never dropped, and never left looking postable', async () => {
  await withApp({}, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(REVERSAL), 'reversal.edi', EDI),
    });

    assert.equal(res.status, 201);
    // Created: the claim and all three negative lines exist.
    assert.equal(res.body.counts.claims, 1);
    assert.equal(res.body.counts.lines, 3);
    assert.deepEqual(
      app.db.table('rcm_procedure_lines').map((l) => l.paid_cents),
      [-10_200, -10_800, -7_500]
    );

    // Flagged: visible at the claim, at the batch, and in the response.
    const [claim] = app.db.table('rcm_claims');
    assert.deepEqual(claim.needs_review_reasons, ['reversal_not_postable']);
    const [batch] = app.db.table('rcm_payment_batches');
    assert.equal(batch.status, 'open', 'a takeback must never read as ready to act on');
    // Slice 5.5: flags are structured data now (rcm_payment_batches.flags,
    // CHECKed against the frozen vocabulary). `notes` went back to being a
    // place for a human to type, rather than prose the UI had to parse.
    // `envelope_counts_mismatch` is a Slice 5.5 TRUE POSITIVE on this fixture:
    // its SE01 declares 32 segments and the set actually contains 33. Five of
    // the thirteen corpus files declare a wrong SE01 — see the corpus note in
    // test/fixtures/rcm/README.md.
    assert.deepEqual(batch.flags, ['negative_total_payment', 'envelope_counts_mismatch']);
    assert.equal(batch.notes, '');
    assert.deepEqual(res.body.remittances[0].flags, [
      'negative_total_payment',
      'envelope_counts_mismatch',
    ]);
    assert.deepEqual(res.body.remittances[0].claims[0].needsReviewReasons, ['reversal_not_postable']);
  });
});

test('a PLB-carrying file records the provider-level money and holds the batch open', async () => {
  await withApp({}, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(fixture835('Test_PLB_Adjustments.edi')), 'plb.edi', EDI),
    });

    assert.equal(res.status, 201);
    const [batch] = app.db.table('rcm_payment_batches');
    assert.equal(batch.plb_total_cents, -4_200);
    // Read as an OBJECT, not a JSON string: jsonb comes back parsed from pg, and
    // FakeRcmDb models that (see JSONB_COLUMNS in rcmTestUtils) so a route that
    // reads `Array.isArray(plb_adjustments)` is tested against what it will get.
    assert.deepEqual(batch.plb_adjustments.map((a) => a.reasonCode), ['WO', 'L6']);
    // PLB belongs to no single claim, so nothing can act on it yet.
    assert.equal(batch.status, 'open');
    assert.ok(res.body.remittances[0].flags.includes('plb_adjustments_present'));
  });
});

test('a denied claim lands with its CARC/RARC codes, which is the whole product', async () => {
  await withApp({}, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(fixture835('Test_Denied_Claims.edi')), 'denied.edi', EDI),
    });

    assert.equal(res.status, 201);
    const adjustments = app.db.table('rcm_procedure_adjustments');
    assert.deepEqual(
      adjustments.map((a) => `${a.group_code}-${a.reason_code}`),
      ['CO-18', 'CO-29', 'CO-31', 'PR-96', 'CO-50']
    );
    // Slice 5.5 (B2): the RARC belongs to the LINE. X12 gives no CAS<->LQ
    // association, so stamping remarkCodes[0] onto every adjustment stored the
    // first RARC three times on a three-CARC line. Open Dental's
    // ClaimAdjReasonCodes is read-only over its API, so these columns are still
    // the ONLY structured home these codes have.
    assert.ok(adjustments.every((a) => a.remark_code === undefined || a.remark_code === null));
    assert.deepEqual(
      app.db.table('rcm_procedure_lines').map((l) => (l.remark_codes || [])[0] || null),
      ['N19', 'N362', 'N290', 'N130', null]
    );
    assert.ok(app.db.table('rcm_procedure_lines').every((l) => l.is_denied === true));
    assert.equal(app.db.table('rcm_claims')[0].needs_review_reasons[0], 'claim_denied');
  });
});

test('a downcode is recorded on the line and raises review on the claim', async () => {
  await withApp({}, async (app) => {
    await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(fixture835('Test_Cigna_Downcode.edi')), 'cigna.edi', EDI),
    });

    const downcoded = app.db.table('rcm_procedure_lines').filter((l) => l.is_downcoded);
    assert.equal(downcoded.length, 1);
    // Which code lands in which column follows the X12 spec, per the Slice 5
    // PM ruling — see the DOWNCODE test in services/rcm/eraParser.test.js.
    // That the two DIFFER, and that the claim is held for review, holds
    // regardless of that reading.
    assert.notEqual(downcoded[0].billed_code, downcoded[0].paid_code);
    assert.ok(downcoded[0].flags.includes('downcode'));
    assert.ok(app.db.table('rcm_claims')[0].needs_review_reasons.includes('procedure_downcoded'));
    assert.equal(app.db.table('rcm_payment_batches')[0].status, 'open');
  });
});

test('an unreadable CAS pair is flagged all the way to the review path, not written as a fabricated code', async () => {
  // PM ruling (Slice 5 review): this is production behaviour, and the flag must
  // SURFACE — Slice 7 renders it. So the assertions walk the whole path, not
  // just the parse: line flag → claim reason → batch held open → API response
  // → the claims list Slice 7 reads.
  await withApp({}, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(fixture835('Test_Mixed_Adjustments.edi')), 'mixed.edi', EDI),
    });
    assert.equal(res.status, 201);

    assert.ok(
      app.db.table('rcm_procedure_adjustments').every((a) => a.reason_code !== '25.50'),
      'a token that cannot be a CARC must never reach reason_code'
    );

    // 1 — the line says an adjustment could not be read.
    const flagged = app.db.table('rcm_procedure_lines').filter((l) => l.flags.includes('unexplained_adj'));
    assert.equal(flagged.length, 1);

    // 2 — the claim carries the machine-readable reason.
    const [claim] = app.db.table('rcm_claims');
    assert.ok(claim.needs_review_reasons.includes('unparseable_cas'));

    // 3 — the batch is therefore NOT ready to act on.
    assert.equal(app.db.table('rcm_payment_batches')[0].status, 'open');

    // 4 — the uploader is told, in the response to their own upload.
    assert.ok(res.body.remittances[0].claims[0].needsReviewReasons.includes('unparseable_cas'));

    // 5 — and it is on the claims list, which is where Slice 7 will find it.
    const claims = await api(app.baseUrl, 'GET', '/api/rcm/claims?office=roland');
    assert.equal(claims.status, 200);
    assert.ok(claims.body.claims[0].needsReviewReasons.includes('unparseable_cas'));
  });
});

test('a clean file is the only kind that reaches status ready', async () => {
  await withApp({}, async (app) => {
    await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(CLEAN), 'clean.edi', EDI),
    });
    assert.equal(app.db.table('rcm_payment_batches')[0].status, 'ready');
    assert.deepEqual(app.db.table('rcm_claims')[0].needs_review_reasons, []);
  });
});

// ─── Transactionality, and a failure that does not poison the key ───────────

/** Make the fake throw the Nth time it sees `pattern`. */
function failOn(db, pattern) {
  const real = db.query.bind(db);
  let armed = true;
  db.query = async (sql, params) => {
    if (armed && pattern.test(sql)) {
      armed = false;
      throw new Error('simulated database failure mid-ingest');
    }
    return real(sql, params);
  };
  return () => {
    db.query = real;
  };
}

test('TRANSACTIONALITY: a failure mid-ingest leaves no batch, no claim, and no line', async () => {
  const db = new FakeRcmDb();
  await withApp({ db }, async (app) => {
    const restore = failOn(db, /INSERT INTO rcm_procedure_adjustments/i);

    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'INTERNAL_ERROR');

    // Everything rolled back together — including the batch and the claims
    // that had already been written when the failure hit.
    assert.equal(db.table('rcm_payment_batches').length, 0);
    assert.equal(db.table('rcm_claims').length, 0);
    assert.equal(db.table('rcm_procedure_lines').length, 0);
    assert.equal(db.table('rcm_batch_claim_payments').length, 0);
    assert.equal(db.table('rcm_eob_uploads').length, 0);
    assert.ok(db.log.some((e) => e.sql === 'ROLLBACK'));
    assert.ok(!db.log.some((e) => e.sql === 'COMMIT'));

    restore();
  });
});

test('A FAILED INGEST DOES NOT POISON THE KEY: the same file re-uploads cleanly', async () => {
  // The reservation is inside the transaction, so a rollback removes it — a
  // cleaner retry than a 'failed' release, and the property the route relies on.
  const db = new FakeRcmDb();
  await withApp({ db }, async (app) => {
    const restore = failOn(db, /INSERT INTO rcm_procedure_lines/i);
    const failed = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
    assert.equal(failed.status, 500);
    restore();

    // No reservation survives, so nothing blocks the retry.
    assert.equal(db.table('rcm_remittance_keys').length, 0);

    const retry = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
    assert.equal(retry.status, 201);
    assert.equal(retry.body.counts.claims, 2);
    assert.equal(db.table('rcm_remittance_keys').length, 1);
    assert.equal(db.table('rcm_remittance_keys')[0].status, 'posted');

    // And the retry's OWN duplicate is still refused — the guard survived.
    const third = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
    assert.equal(third.status, 409);
  });
});

test('the reservation is finalized only after the proposals commit', async () => {
  await withApp({}, async (app) => {
    await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });

    const sqls = app.db.log.map((e) => e.sql);
    const reserve = sqls.findIndex((s) => /INSERT INTO rcm_remittance_keys/.test(s));
    const batch = sqls.findIndex((s) => /INSERT INTO rcm_payment_batches/.test(s));
    const finalize = sqls.findIndex((s) => /UPDATE rcm_remittance_keys SET status = 'posted'/.test(s));
    const commit = sqls.indexOf('COMMIT');

    assert.ok(reserve > sqls.indexOf('BEGIN'), 'reserve inside the transaction');
    assert.ok(reserve < batch, 'reserve BEFORE the work it guards');
    assert.ok(batch < finalize, 'finalize AFTER the work it guards');
    assert.ok(finalize < commit, 'and all of it before the commit');
  });
});

// ─── Refusals ───────────────────────────────────────────────────────────────

test('an unparseable upload is refused, and nothing is stored or reserved', async () => {
  const store = defaultEraStoreStub();
  const db = new FakeRcmDb();
  await withApp({ db, eraStore: store }, async (app) => {
    // Long enough to clear the min-size floor, so this exercises the PARSER's
    // refusal rather than the size check. (A PDF header, which is what an
    // operator actually mis-drags into this control.)
    const notAn835 = Buffer.from(`%PDF-1.7\n${'%âãÏÓ binary junk '.repeat(8)}`);
    assert.ok(notAn835.length > 64);

    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(notAn835, 'scan.pdf', EDI),
    });

    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'ERA_PARSE_FAILED');
    // Parse first: a blob write for an unparseable upload is litter, and a
    // reservation for one is a key we could not have derived.
    assert.equal(store.puts.length, 0);
    assert.equal(db.table('rcm_remittance_keys').length, 0);
    assert.equal(db.table('rcm_eob_uploads').length, 0);
  });
});

test('an empty file is refused before anything else happens', async () => {
  await withApp({}, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.alloc(0), 'a.edi', EDI),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'NO_FILE');
  });
});

test('a file too short to be an 835 is refused with its own code', async () => {
  await withApp({}, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from('ISA*00*'), 'a.edi', EDI),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'FILE_TOO_SMALL');
  });
});

test('a non-multipart body is refused as a missing file, not parsed', async () => {
  // multer sees no multipart part at all, so req.file is undefined. The refusal
  // names the field the caller should have used rather than blaming the bytes.
  await withApp({}, async (app) => {
    const res = await fetch(`${app.baseUrl}/api/rcm/era?office=roland`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/edi-x12' },
      body: MULTI,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'NO_FILE');
  });
});

test('a file with no payment date is refused rather than dated today', async () => {
  // A key built from today's date detects no duplicates tomorrow, which is the
  // one thing it exists to do.
  const noDate =
    [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260301*1200*^*00501*000000001*0*P*:',
      'GS*HP*SENDER*RECEIVER*20260301*1200*1*X*005010X221A1',
      'ST*835*0001',
      'BPR*I*80.00*C*ACH',
      'TRN*1*T1*1710673405',
      'N1*PR*DELTA DENTAL',
      'CLP*C1*1*100*80*20*12*ICN1',
      'NM1*QC*1*DOE*JOHN****MI*S1',
      'SVC*AD:D0120*100*80',
      'SE*9*0001',
      'GE*1*1',
      'IEA*1*000000001',
    ].join('~\n') + '~\n';

  const store = defaultEraStoreStub();
  await withApp({ eraStore: store }, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(noDate), 'a.edi', EDI),
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'ERA_MISSING_PAYMENT_DATE');
    assert.deepEqual(res.body.transactionIndexes, [0]);
    assert.equal(store.puts.length, 0);
  });
});

test('a file with no trace and no check number is refused as unidentifiable', async () => {
  const noTrace =
    [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260301*1200*^*00501*000000001*0*P*:',
      'GS*HP*SENDER*RECEIVER*20260301*1200*1*X*005010X221A1',
      'ST*835*0001',
      'BPR*I*80.00*C*ACH',
      'DTM*405*20260301',
      'N1*PR*DELTA DENTAL',
      'CLP*C1*1*100*80*20*12*ICN1',
      'NM1*QC*1*DOE*JOHN****MI*S1',
      'SVC*AD:D0120*100*80',
      'SE*9*0001',
      'GE*1*1',
      'IEA*1*000000001',
    ].join('~\n') + '~\n';

  await withApp({}, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(noTrace), 'a.edi', EDI),
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'ERA_NO_REMITTANCE_IDENTITY');
  });
});

test('an unconfigured blob store 503s rather than writing rows with no artifact', async () => {
  // Hard rule 6: the raw file IS the audit artifact. Proposals whose file was
  // never stored would be unverifiable months later.
  const db = new FakeRcmDb();
  await withApp({ db, eraStore: { isConfigured: () => false } }, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'ERA_STORAGE_UNAVAILABLE');
    assert.equal(db.table('rcm_payment_batches').length, 0);
    assert.equal(db.table('rcm_remittance_keys').length, 0);
  });
});

// ─── The gates ──────────────────────────────────────────────────────────────

test('POST demands rcm.WRITE while GET demands rcm.read', async () => {
  // `rcm.read` and `rcm.write` currently hold the same roles, so no role can
  // separate them by outcome. The denial names the action it evaluated, which
  // is what proves requireReadWrite picked the write gate for POST.
  await withApp({ role: 'tc' }, async (app) => {
    const post = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
    assert.equal(post.status, 403);
    assert.equal(post.body.code, 'FORBIDDEN');
    assert.equal(post.body.action, 'rcm.write');

    const get = await api(app.baseUrl, 'GET', '/api/rcm/era?office=roland');
    assert.equal(get.status, 403);
    assert.equal(get.body.action, 'rcm.read');
  });
});

test('a hygienist cannot upload a remittance', async () => {
  await withApp({ role: 'hygiene' }, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
    assert.equal(res.status, 403);
    assert.equal(app.db.table('rcm_payment_batches').length, 0);
  });
});

test('a tenant without the rcm module gets MODULE_NOT_ENTITLED, not a parse attempt', async () => {
  await withApp({ modules: ['voice'] }, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
    assert.equal(app.db.table('rcm_payment_batches').length, 0);
  });
});

test('an anonymous upload is refused by the auth gate', async () => {
  await withApp({ user: null }, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI), anon: true,
    });
    assert.equal(res.status, 401);
  });
});

test('office comes from the validated query param — a missing or unknown one 400s', async () => {
  await withApp({}, async (app) => {
    for (const path of ['/api/rcm/era', '/api/rcm/era?office=', '/api/rcm/era?office=springfield']) {
      const res = await api(app.baseUrl, 'POST', path, {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'INVALID_OFFICE');
    }
    assert.equal(app.db.table('rcm_payment_batches').length, 0);
  });
});

test('an office asserted in the BODY cannot redirect the write', async () => {
  // There is no body field this route reads other than the file bytes. A file
  // whose payee names Valley still lands in whatever office the URL said.
  await withApp({}, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
    assert.equal(res.status, 201);
    assert.ok(app.db.table('rcm_payment_batches').every((b) => b.office_id === 'roland'));
  });
});

// ─── Audit ──────────────────────────────────────────────────────────────────

test('an upload writes a CREATE audit row naming the office and the upload', async () => {
  await withApp({}, async (app) => {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });

    const rows = auditRows(app.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'CREATE');
    assert.equal(rows[0].resource_type, 'rcm_era_upload');
    assert.equal(rows[0].resource_id, res.body.upload.uploadId);
    assert.equal(rows[0].office, 'roland');
    assert.equal(rows[0].user_id, 'billing@carein.ai');

    // Slice 6a discharged the deferral this assertion used to record. Decision
    // D-5 upserts rcm_user_map from the SSO identity on a person's first RCM
    // action, so the batch's created_by FK is now satisfiable at upload time —
    // and the workbench can say who brought a check in without reading the
    // audit log. `user_key` is the lowercased email for someone with no legacy
    // rcm-posting history.
    const [batch] = app.db.table('rcm_payment_batches');
    assert.equal(batch.created_by, 'billing@carein.ai');
    const [mapped] = app.db.table('rcm_user_map');
    assert.equal(mapped.platform_email, 'billing@carein.ai');
    assert.equal(mapped.display_name, 'Billing User');
    // Tenant-global by design: rcm_user_map is one of exactly two rcm_* tables
    // without office_id, because billing staff work across both practices.
    assert.equal(mapped.office_id, undefined);
  });
});

test('a refused duplicate writes no audit row, because nothing happened', async () => {
  await withApp({}, async (app) => {
    await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
    await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'a.edi', EDI),
    });
    assert.equal(auditRows(app.db).length, 1);
  });
});

// ─── GET /api/rcm/era ───────────────────────────────────────────────────────

test('the list shows each upload, its remittances, and their dedupe status', async () => {
  await withApp({}, async (app) => {
    await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'delta.edi', EDI),
    });
    await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(REVERSAL), 'reversal.edi', EDI),
    });

    const res = await api(app.baseUrl, 'GET', '/api/rcm/era?office=roland');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.uploads.length, 2);

    const delta = res.body.uploads.find((u) => u.filename === 'delta.edi');
    assert.equal(delta.status, 'extracted');
    assert.equal(delta.remittances.length, 1);
    assert.equal(delta.remittances[0].payer, 'DELTA DENTAL OF ARKANSAS');
    assert.equal(delta.remittances[0].totalAmountCents, 65_100);
    assert.equal(delta.remittances[0].claimCount, 2);
    // Slice 5.5: held at 'open' because this file's AMT*B6 carries the billed
    // amount rather than the allowed one (A3). The remittance itself is clean —
    // the review reason is on the claims.
    assert.equal(delta.remittances[0].status, 'open');
    assert.deepEqual(delta.remittances[0].flags, []);
    // The dedupe status is the thing that makes a re-upload refuse.
    assert.equal(delta.remittances[0].dedupeStatus, 'posted');
    assert.match(delta.remittances[0].remittanceKey, /^830200001\|DELTA DENTAL OF ARKANSAS\|/);

    const reversal = res.body.uploads.find((u) => u.filename === 'reversal.edi');
    assert.equal(reversal.remittances[0].status, 'open');
    // Slice 5.5: the list carries the structured flags, not prose in `notes`.
    assert.deepEqual(reversal.remittances[0].flags, [
      'negative_total_payment',
      'envelope_counts_mismatch',
    ]);
  });
});

test('the list is office-scoped — the other office sees none of it', async () => {
  await withApp({}, async (app) => {
    await api(app.baseUrl, 'POST', '/api/rcm/era?office=roland', {
      body: filePart(Buffer.from(MULTI), 'delta.edi', EDI),
    });

    const valley = await api(app.baseUrl, 'GET', '/api/rcm/era?office=valley');
    assert.equal(valley.status, 200);
    assert.equal(valley.body.total, 0);
    assert.deepEqual(valley.body.uploads, []);
  });
});

test('the list read is audited, because filenames are PHI', async () => {
  await withApp({}, async (app) => {
    await api(app.baseUrl, 'GET', '/api/rcm/era?office=roland');
    const rows = auditRows(app.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'READ');
    assert.equal(rows[0].resource_type, 'rcm_era_upload');
    // resourceId is null on a list read: the thing read is "this office's
    // uploads", which has no single id.
    assert.equal(rows[0].resource_id, null);
  });
});

test('an empty office lists honestly rather than erroring', async () => {
  await withApp({}, async (app) => {
    const res = await api(app.baseUrl, 'GET', '/api/rcm/era?office=valley');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.total, 0);
    assert.equal(res.body.limit, 50);
  });
});
