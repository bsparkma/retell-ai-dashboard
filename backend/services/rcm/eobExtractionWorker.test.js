'use strict';

/**
 * The extraction worker: status transitions, atomicity, and the cost breaker.
 *
 * The four claims under test, each of which is a promise the UI makes to a
 * person who just uploaded a document:
 *
 *   1. 'extracted' NEVER appears before the rows it refers to. The upload flip
 *      is inside the same transaction as the claims, lines, adjustments, batch
 *      and batch links — so a mid-write failure leaves NOTHING, and the upload
 *      is retryable rather than lying.
 *   2. A tripped cost breaker PAUSES; it does not fail and does not drop. The
 *      row stays 'uploaded' with a reason and a reset time.
 *   3. A failure says WHY, in a sentence a poster can act on.
 *   4. Nothing crosses offices, even here where the office came from a job
 *      rather than from a request.
 *
 * The LLM and Blob are stubbed; the DB is the same FakeRcmDb the route tests
 * use, running the worker's ACTUAL SQL, with real BEGIN/ROLLBACK semantics —
 * which is what makes claim (1) testable rather than merely asserted.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FakeRcmDb } = require('../../routes/rcm/rcmTestUtils');
const tenantDb = require('../../platform/tenantDb');
const blobStore = require('./eobBlobStore');
const llm = require('./rcmLlm');
const budget = require('./extractionBudget');
const ocrBudget = require('./ocrBudget');
const documentOcr = require('./documentOcr');
const { runExtraction } = require('./eobExtractionWorker');

const JOB = Object.freeze({
  tenantId: 'T1',
  tenantSlug: 'carein',
  office: 'roland',
  uploadId: 'upload-1',
});

/** A minimal PDF with a real text layer, built in memory. No fixture, no PHI. */
function pdfWithText(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  return Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]' +
      '/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n' +
      '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
      `5 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n` +
      'trailer<</Root 1 0 R>>\n',
    'latin1'
  );
}

/** A clean, internally consistent one-claim extraction answer. */
function answer(overrides = {}) {
  return {
    payment: {
      payer: 'Example Dental Plan',
      checkNumber: 'CHK-100200',
      checkDate: '2026-08-10',
      paymentMethod: 'eft',
      totalPaidCents: 16300,
    },
    confidence: 96,
    claims: [
      {
        patientName: 'Testpatient, Alpha',
        patientDOB: '1985-03-15',
        subscriberId: 'SUB-0001',
        groupNumber: 'GRP-4470',
        claimNumber: 'CLM-2026-1001',
        serviceDate: '2026-07-21',
        providerNPI: '1598324220',
        renderingProvider: 'Example Dental',
        totalBilledCents: 16700,
        totalAllowedCents: 16300,
        totalDeductibleCents: 0,
        totalCopayCents: 0,
        totalPaidCents: 16300,
        procedures: [
          {
            code: 'D0120',
            description: 'Periodic oral evaluation',
            billedCents: 5900,
            allowedCents: 5700,
            deductibleCents: 0,
            copayCents: 0,
            paidCents: 5700,
            confidence: 97,
            flags: [],
            adjustments: [
              {
                groupCode: 'CO',
                reasonCode: '45',
                reasonDescription: 'Charge exceeds fee schedule',
                amountCents: 200,
                remarkCode: 'N130',
                remarkDescription: 'Consult plan benefit documents',
              },
            ],
          },
          {
            code: 'D1110',
            description: 'Prophylaxis - adult',
            billedCents: 10800,
            allowedCents: 10600,
            deductibleCents: 0,
            copayCents: 0,
            paidCents: 10600,
            confidence: 95,
            flags: [],
            adjustments: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

/**
 * Stub the world around the worker.
 * `ocr` patches the Document Intelligence module in place. `eobDocumentText`
 * requires it LAZILY from inside the escalation branch, so the same require
 * cache the worker's own graph uses is the one patched here — no network, and no
 * injection seam threaded through the worker that production would not use.
 *
 * @param {{ db?: FakeRcmDb, json?: unknown, llmError?: Error, pdf?: Buffer,
 *           blobError?: Error, llmConfigured?: boolean, capCents?: string,
 *           ocr?: { configured?: boolean, text?: string, pages?: number,
 *                   meanConfidence?: number|null, error?: Error },
 *           ocrCapCents?: string }} [opts]
 */
function harness(opts = {}) {
  const db =
    opts.db ||
    new FakeRcmDb().seed('rcm_eob_uploads', [
      {
        upload_id: 'upload-1',
        office_id: 'roland',
        filename: 'remittance.pdf',
        file_key: 'tenant/carein/rcm/eob/00000000-0000-4000-8000-000000000001.pdf',
        status: 'uploaded',
        result_claim_id: null,
        result_batch_id: null,
        error_message: null,
      },
    ]);

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-worker-'));
  const priorEnv = { ...process.env };
  process.env.CALLSTORE_DIR = stateDir;
  process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com';
  process.env.AZURE_OPENAI_DEPLOYMENT = 'test-deployment';
  if (opts.capCents !== undefined) process.env.RCM_EXTRACTION_MAX_CENTS_PER_DAY = opts.capCents;
  if (opts.ocrCapCents !== undefined) process.env.RCM_OCR_MAX_CENTS_PER_DAY = opts.ocrCapCents;
  budget._resetForTests();
  ocrBudget._resetForTests();

  const originals = {
    getTenantPool: tenantDb.getTenantPool,
    getEob: blobStore.getEob,
    isConfigured: llm.isConfigured,
    completeJson: llm.completeJson,
    ocrIsConfigured: documentOcr.isConfigured,
    ocrAnalyze: documentOcr.analyze,
  };

  const calls = { llm: 0, ocr: 0 };

  tenantDb.getTenantPool = async () => db;
  blobStore.getEob = async () => {
    if (opts.blobError) throw opts.blobError;
    return opts.pdf || pdfWithText('PLAN PAID 163.00 CHECK CHK-100200');
  };
  const ocrOpts = opts.ocr || {};
  documentOcr.isConfigured = () => ocrOpts.configured === true;
  documentOcr.analyze = async () => {
    calls.ocr++;
    if (ocrOpts.error) throw ocrOpts.error;
    return {
      // The default is what the REAL staging resource returned for
      // Test_EOB_Scanned.pdf on 2026-08-19.
      text: ocrOpts.text ?? 'PLAN PAID 163.00 CHECK CHK-100200 D0120 PERIODIC ORAL EVALUATION',
      pages: ocrOpts.pages ?? 1,
      meanConfidence: 'meanConfidence' in ocrOpts ? ocrOpts.meanConfidence : 0.9909,
      words: 77,
      model: 'prebuilt-read',
      elapsedMs: 2333,
    };
  };
  llm.isConfigured = () => opts.llmConfigured !== false;
  llm.completeJson = async () => {
    calls.llm++;
    if (opts.llmError) throw opts.llmError;
    return {
      json: 'json' in opts ? opts.json : answer(),
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    };
  };

  return {
    db,
    calls,
    budget,
    restore() {
      tenantDb.getTenantPool = originals.getTenantPool;
      blobStore.getEob = originals.getEob;
      llm.isConfigured = originals.isConfigured;
      llm.completeJson = originals.completeJson;
      documentOcr.isConfigured = originals.ocrIsConfigured;
      documentOcr.analyze = originals.ocrAnalyze;
      for (const k of Object.keys(process.env)) if (!(k in priorEnv)) delete process.env[k];
      Object.assign(process.env, priorEnv);
      budget._resetForTests();
      ocrBudget._resetForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

const upload = (db) => db.table('rcm_eob_uploads')[0];

// ─── The happy path ──────────────────────────────────────────────────────────

test('a successful extraction writes the whole proposal and flips the upload', async () => {
  const h = harness();
  try {
    const result = await runExtraction(JOB);
    assert.equal(result.status, 'extracted');

    const row = upload(h.db);
    assert.equal(row.status, 'extracted');
    assert.equal(row.error_message, null);
    assert.equal(row.result_claim_id, result.claimId);
    assert.equal(row.result_batch_id, result.batchId);
    assert.ok(row.processed_at instanceof Date);

    const claims = h.db.table('rcm_claims');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].status, 'pending_review', 'a proposal, never posted');
    assert.equal(claims[0].source, 'manual_upload');
    assert.equal(claims[0].office_id, 'roland');
    assert.equal(claims[0].total_paid_cents, 16300);
    assert.equal(claims[0].confidence, 96);
    assert.deepEqual(claims[0].needs_review_reasons, [], 'a clean document needs no review flags');
    assert.equal(claims[0].od_patient_id, undefined, 'no Open Dental linkage is invented here');

    const lines = h.db.table('rcm_procedure_lines');
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((l) => l.position),
      [0, 1]
    );
    assert.equal(lines[0].claim_id, claims[0].claim_id);
    assert.equal(lines[0].paid_code, null, 'no paid_code is manufactured on a clean line');

    const adjustments = h.db.table('rcm_procedure_adjustments');
    assert.equal(adjustments.length, 1, 'structured CARC/RARC, not free text');
    assert.equal(adjustments[0].group_code, 'CO');
    assert.equal(adjustments[0].reason_code, '45');
    assert.equal(adjustments[0].remark_code, 'N130');
    assert.equal(adjustments[0].procedure_line_id, lines[0].line_id);

    const batches = h.db.table('rcm_payment_batches');
    assert.equal(batches.length, 1);
    assert.equal(batches[0].status, 'open', "'open', not 'ready' — nobody has looked yet");
    assert.equal(batches[0].total_amount_cents, 16300);
    assert.equal(batches[0].claim_count, 1);
    assert.equal(batches[0].payment_method, 'eft');

    const links = h.db.table('rcm_batch_claim_payments');
    assert.equal(links.length, 1);
    assert.equal(links[0].batch_id, batches[0].batch_id);
    assert.equal(links[0].claim_id, claims[0].claim_id);
    assert.equal(links[0].status, 'pending');
  } finally {
    h.restore();
  }
});

test('the upload passes through processing on its way to extracted', async () => {
  const h = harness();
  try {
    await runExtraction(JOB);
    const statuses = h.db.log
      .filter((q) => /^UPDATE rcm_eob_uploads/i.test(q.sql))
      .map((q) => (q.sql.match(/status = '(\w+)'/) || [])[1]);
    assert.deepEqual(statuses, ['processing', 'extracted'], `saw: ${statuses.join(' → ')}`);
  } finally {
    h.restore();
  }
});

test('an extraction is charged to the budget the moment the tokens are spent', async () => {
  const h = harness();
  try {
    assert.equal(budget.check().usedCents, 0);
    await runExtraction(JOB);
    assert.ok(budget.check().usedCents > 0, 'a completed call must move the counter');
  } finally {
    h.restore();
  }
});

test('re-running an already-extracted upload is a free no-op', async () => {
  const h = harness();
  try {
    await runExtraction(JOB);
    const claimCount = h.db.table('rcm_claims').length;
    const llmCalls = h.calls.llm;

    const again = await runExtraction(JOB);
    assert.equal(again.status, 'exists');
    assert.equal(h.calls.llm, llmCalls, 'a re-run must not re-spend');
    assert.equal(h.db.table('rcm_claims').length, claimCount, 'and must not duplicate the proposal');
  } finally {
    h.restore();
  }
});

// ─── Atomicity ───────────────────────────────────────────────────────────────

test('a failure mid-write leaves NO rows and never says extracted', async () => {
  const h = harness();
  try {
    // Fail on the batch-claim link — after the batch, the claim, its lines and
    // its adjustments are already inserted. If the transaction is real, all of
    // them disappear.
    h.db.failWhen = (sql) => /INSERT INTO rcm_batch_claim_payments/i.test(sql);

    const result = await runExtraction(JOB);
    assert.equal(result.status, 'failed');

    assert.deepEqual(h.db.table('rcm_claims'), [], 'no orphan claim');
    assert.deepEqual(h.db.table('rcm_procedure_lines'), [], 'no orphan lines');
    assert.deepEqual(h.db.table('rcm_procedure_adjustments'), [], 'no orphan adjustments');
    assert.deepEqual(h.db.table('rcm_payment_batches'), [], 'no orphan batch');

    const row = upload(h.db);
    assert.equal(row.status, 'failed');
    assert.equal(row.result_claim_id, null, 'never a pointer to a claim that does not exist');
    assert.equal(row.result_batch_id, null);
    assert.ok(row.error_message, 'and it says why');
  } finally {
    h.restore();
  }
});

test('the upload flip is INSIDE the transaction, not after it', async () => {
  const h = harness();
  try {
    // Fail on the flip itself. Everything written before it must roll back too
    // — the alternative is a proposal nothing points at.
    h.db.failWhen = (sql) => /UPDATE rcm_eob_uploads SET status = 'extracted'/i.test(sql);
    const result = await runExtraction(JOB);
    assert.equal(result.status, 'failed');
    assert.deepEqual(h.db.table('rcm_claims'), []);
    assert.deepEqual(h.db.table('rcm_payment_batches'), []);
    assert.equal(upload(h.db).status, 'failed');
  } finally {
    h.restore();
  }
});

// ─── The breaker ─────────────────────────────────────────────────────────────

test('a tripped breaker PAUSES the document — it does not fail it and does not drop it', async () => {
  const h = harness({ capCents: '1' });
  try {
    budget.charge({ prompt_tokens: 0, completion_tokens: 100_000, total_tokens: 100_000 });
    assert.equal(budget.check().allowed, false, 'precondition: tripped');

    const result = await runExtraction(JOB);
    assert.equal(result.status, 'deferred');
    assert.ok(result.resetsAt, 'the caller is told WHEN it will run');
    assert.equal(h.calls.llm, 0, 'nothing was spent');

    const row = upload(h.db);
    assert.equal(row.status, 'uploaded', "paused is 'uploaded', not 'failed' — nothing was attempted");
    assert.match(row.error_message, /paused/i);
    assert.match(row.error_message, /cap/i);
    assert.deepEqual(h.db.table('rcm_claims'), []);
  } finally {
    h.restore();
  }
});

test('once the budget rolls, the same job extracts normally', async () => {
  const h = harness({ capCents: '1' });
  try {
    budget.charge({ prompt_tokens: 0, completion_tokens: 100_000, total_tokens: 100_000 });
    assert.equal((await runExtraction(JOB)).status, 'deferred');

    // The day rolls: the counter resets through the same path production uses.
    process.env.RCM_EXTRACTION_MAX_CENTS_PER_DAY = '1000';
    budget._resetForTests();

    const result = await runExtraction(JOB);
    assert.equal(result.status, 'extracted');
    assert.equal(upload(h.db).status, 'extracted');
    assert.equal(upload(h.db).error_message, null, 'the stale pause reason is cleared');
  } finally {
    h.restore();
  }
});

test('an unconfigured LLM pauses rather than failing the document', async () => {
  const h = harness({ llmConfigured: false });
  try {
    const result = await runExtraction(JOB);
    assert.equal(result.status, 'deferred');
    assert.equal(result.resetsAt, undefined, 'there is no clock to wait on here');
    assert.equal(upload(h.db).status, 'uploaded');
    assert.match(upload(h.db).error_message, /not available|not configured/i);
  } finally {
    h.restore();
  }
});

// ─── Honest failures ─────────────────────────────────────────────────────────

test('a PDF with no text layer fails with a reason a poster can act on', async () => {
  // A valid PDF with no text content — what a photographed or faxed EOB is.
  const imageOnly = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
      'trailer<</Root 1 0 R>>\n',
    'latin1'
  );
  const h = harness({ pdf: imageOnly });
  try {
    const result = await runExtraction(JOB);
    assert.equal(result.status, 'failed');
    assert.equal(h.calls.llm, 0, 'no money is spent on a document with nothing to read');
    const row = upload(h.db);
    assert.equal(row.status, 'failed');
    assert.match(row.error_message, /scanned image|extractable text/i);
    assert.match(row.error_message, /manually|text PDF/i, 'and says what to do instead');
  } finally {
    h.restore();
  }
});

test('an unusable model answer fails without leaking internals', async () => {
  const h = harness({ json: 'not an object' });
  try {
    const result = await runExtraction(JOB);
    assert.equal(result.status, 'failed');
    const message = upload(h.db).error_message;
    assert.match(message, /unusable answer|Try again/i);
    assert.ok(!/at Object|node_modules|\.js:\d+/.test(message), 'no stack in a user-facing field');
  } finally {
    h.restore();
  }
});

test('a transport failure is reported as one, and is retryable', async () => {
  const err = new Error('socket hang up');
  err.code = 'LLM_CALL_FAILED';
  const h = harness({ llmError: err });
  try {
    const result = await runExtraction(JOB);
    assert.equal(result.status, 'failed');
    assert.match(upload(h.db).error_message, /could not be reached/i);
    assert.ok(!upload(h.db).error_message.includes('socket hang up'));
  } finally {
    h.restore();
  }
});

// ─── Office scoping ──────────────────────────────────────────────────────────

test('a job whose office does not match the row extracts nothing', async () => {
  const h = harness();
  try {
    const result = await runExtraction({ ...JOB, office: 'valley' });
    assert.equal(result.status, 'not_found');
    assert.equal(h.calls.llm, 0);
    assert.equal(upload(h.db).status, 'uploaded', 'the roland row is untouched');
    assert.deepEqual(h.db.table('rcm_claims'), []);
  } finally {
    h.restore();
  }
});

test('every row the worker writes carries the job office', async () => {
  const h = harness();
  try {
    await runExtraction(JOB);
    for (const table of [
      'rcm_claims',
      'rcm_procedure_lines',
      'rcm_procedure_adjustments',
      'rcm_payment_batches',
      'rcm_batch_claim_payments',
    ]) {
      const rows = h.db.table(table);
      assert.ok(rows.length > 0, `${table} should have rows`);
      for (const row of rows) {
        assert.equal(row.office_id, 'roland', `${table} row is missing or mis-scoped by office`);
      }
    }
  } finally {
    h.restore();
  }
});

// ─── Review reasons reach the row ────────────────────────────────────────────

test('an unbalanced bulk check is flagged on every claim in the batch', async () => {
  const two = answer();
  two.claims.push({ ...two.claims[0], claimNumber: 'CLM-2026-1002', patientName: 'Testpatient, Beta' });
  // The check total still says one claim's worth, so Σ(claims) ≠ check total.
  const h = harness({ json: two });
  try {
    await runExtraction(JOB);
    const claims = h.db.table('rcm_claims');
    assert.equal(claims.length, 2);
    for (const claim of claims) {
      assert.ok(
        claim.needs_review_reasons.includes('batch_paid_total_mismatch'),
        'a reviewer works one claim at a time — a batch-only flag is a flag nobody sees'
      );
    }
    // Slice 5.5 (B6): the SIGNAL is in the CHECKed `flags` column the UI switches
    // on — the same one the ERA path writes — not a machine token appended to
    // prose. `notes` stays a human summary and nothing parses it.
    const batch = h.db.table('rcm_payment_batches')[0];
    assert.deepEqual(batch.flags, ['claim_total_mismatch']);
    assert.doesNotMatch(batch.notes, /UNBALANCED/);
  } finally {
    h.restore();
  }
});

test('an uncertain line reaches the stored review reasons', async () => {
  const doc = answer();
  doc.claims[0].procedures[1].confidence = 30;
  const h = harness({ json: doc });
  try {
    await runExtraction(JOB);
    assert.ok(h.db.table('rcm_claims')[0].needs_review_reasons.includes('uncertain_line:2'));
  } finally {
    h.restore();
  }
});

test('the raw extraction payload is stored, so per-line confidence survives', async () => {
  const h = harness();
  try {
    await runExtraction(JOB);
    // Read as an OBJECT: jsonb comes back parsed from pg, and FakeRcmDb models
    // that (JSONB_COLUMNS in rcmTestUtils) so the route is tested against what
    // it will actually receive.
    const raw = h.db.table('rcm_claims')[0].raw_extracted_json;
    assert.equal(raw.confidence, 96);
    assert.equal(raw.claim.procedures[0].confidence, 97);
    assert.equal(raw.payment.checkNumber, 'CHK-100200');
  } finally {
    h.restore();
  }
});

// ─── OCR: provenance, the confidence reason, and the second cost rail ────────

/**
 * A one-page PDF with NO text layer — a picture of a page, in miniature.
 *
 * The committed fixtures in test/fixtures/rcm/eob are the real thing and are
 * what `eobDocumentText.test.js` drives. Here the document is incidental: what
 * is under test is what the WORKER does with the escalation's result, so a
 * minimal image-only PDF keeps the test about that.
 */
function pdfWithNoTextLayer() {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
      'trailer<</Root 1 0 R>>\n',
    'latin1'
  );
}

test('a scanned document records HOW it was read, in the same transaction as its claims', async () => {
  const h = harness({ pdf: pdfWithNoTextLayer(), ocr: { configured: true, pages: 3 } });
  try {
    const result = await runExtraction(JOB);
    assert.equal(result.status, 'extracted');
    assert.equal(h.calls.ocr, 1);

    const row = upload(h.db);
    assert.equal(row.status, 'extracted');
    assert.equal(row.text_source, 'ocr');
    assert.equal(row.ocr_page_count, 3);
    assert.equal(row.ocr_mean_confidence, 0.991, 'rounded to the column, not to a lie');

    // The provenance and the rows it describes are committed together. A screen
    // that told a biller how a proposal was read, about a proposal that does not
    // exist, is the honest-states rule failing where it costs most.
    assert.ok(row.result_batch_id, 'the batch exists');
    assert.equal(h.db.table('rcm_claims').length, 1);
  } finally {
    h.restore();
  }
});

test('a text-layer document says so, and carries no OCR numbers at all', async () => {
  const h = harness();
  try {
    await runExtraction(JOB);
    const row = upload(h.db);
    assert.equal(row.text_source, 'text_layer');
    // NULL, not 0. "OCR read no pages" would be a different and untrue claim,
    // and the database CHECK forbids it on this path.
    assert.equal(row.ocr_page_count, null);
    assert.equal(row.ocr_mean_confidence, null);
    assert.equal(h.calls.ocr, 0);
  } finally {
    h.restore();
  }
});

test('low OCR confidence lands on EVERY claim from the document', async () => {
  const twoClaims = answer();
  twoClaims.claims.push({ ...answer().claims[0], claimNumber: 'CLM-2026-1002' });
  twoClaims.payment.totalPaidCents = 32600;

  const h = harness({
    pdf: pdfWithNoTextLayer(),
    json: twoClaims,
    ocr: { configured: true, meanConfidence: 0.72 },
  });
  try {
    await runExtraction(JOB);
    const claims = h.db.table('rcm_claims');
    assert.equal(claims.length, 2);
    for (const claim of claims) {
      // Confidence is a property of the READING, and the reading produced all of
      // them. A reason living only on the document is a reason the reviewer —
      // who works one claim at a time — never sees.
      assert.ok(
        claim.needs_review_reasons.includes('ocr_low_confidence'),
        `every claim carries it; saw ${claim.needs_review_reasons}`
      );
    }
    assert.equal(upload(h.db).ocr_mean_confidence, 0.72);
  } finally {
    h.restore();
  }
});

test('a confidently-read scan adds no reason — the flag is not a scan tax', async () => {
  const h = harness({ pdf: pdfWithNoTextLayer(), ocr: { configured: true, meanConfidence: 0.99 } });
  try {
    await runExtraction(JOB);
    assert.ok(
      !h.db.table('rcm_claims')[0].needs_review_reasons.includes('ocr_low_confidence'),
      'a clean scan is a clean proposal'
    );
  } finally {
    h.restore();
  }
});

test('a spent OCR budget PAUSES the document — it does not fail or drop it', async () => {
  // A 1¢ cap. One page costs 1¢ (rounded up from 0.15¢), so spending one page
  // leaves nothing a second document can fit into. `0` would mean UNLIMITED on
  // this rail, the same convention the extraction rail uses.
  const h = harness({ pdf: pdfWithNoTextLayer(), ocr: { configured: true }, ocrCapCents: '1' });
  try {
    ocrBudget.charge(1);
    assert.equal(ocrBudget.check(1).allowed, false, 'the rail really is spent');

    const result = await runExtraction(JOB);

    assert.equal(result.status, 'deferred');
    assert.ok(result.resetsAt, 'and says when it will be read');
    assert.equal(h.calls.ocr, 0, 'a spent budget costs zero round trips');
    assert.equal(h.calls.llm, 0);

    const row = upload(h.db);
    // 'uploaded', never 'failed': nothing about this document is wrong.
    assert.equal(row.status, 'uploaded');
    assert.equal(row.failure_code ?? null, null, 'a pause is not a failure code');
    assert.match(row.error_message, /OCR/i, 'and names WHICH cap stopped it');
    assert.match(row.error_message, /separate cap/i);
    assert.equal(row.text_source ?? null, null, 'nothing was read, so nothing is claimed');

    // And the EXTRACTION rail is untouched: the document never got that far, so
    // there is nothing to charge it for.
    assert.equal(budget.check().usedCents, 0);
  } finally {
    h.restore();
  }
});

test('an unreadable scan fails with the rescan advice, not a generic error', async () => {
  const tooFaint = new Error(
    'Almost nothing could be read from this document (1 page(s), 4 characters). ' +
      'This scan is too faint or too low-resolution to read. Rescan it at 300 dpi in ' +
      'black and white, ask the payer for a text PDF, or enter this EOB manually.'
  );
  tooFaint.code = 'OCR_UNREADABLE';
  const h = harness({ pdf: pdfWithNoTextLayer(), ocr: { configured: true, error: tooFaint } });
  try {
    const result = await runExtraction(JOB);
    assert.equal(result.status, 'failed');

    const row = upload(h.db);
    assert.equal(row.failure_code, 'ocr_unreadable');
    assert.match(row.error_message, /300 dpi/, 'the advice survives to the user verbatim');
    assert.match(row.error_message, /manually/);
    assert.equal(h.calls.llm, 0, 'nothing is sent to the extraction model');
  } finally {
    h.restore();
  }
});

test('a reader that could not open the file is ocr_failed, a different conversation', async () => {
  const refused = new Error('Document Intelligence could not read this document: InvalidContent');
  refused.code = 'OCR_ANALYZE_FAILED';
  const h = harness({ pdf: pdfWithNoTextLayer(), ocr: { configured: true, error: refused } });
  try {
    await runExtraction(JOB);
    const row = upload(h.db);
    // `ocr_unreadable` means the SCAN was bad; `ocr_failed` means the reader
    // never got that far. The panel says different things about them, which is
    // the whole reason failure_code exists (A6).
    assert.equal(row.failure_code, 'ocr_failed');
    assert.match(row.error_message, /rescan|text PDF|manually/i);
    assert.ok(!/InvalidContent/.test(row.error_message), 'no service internals in a user field');
  } finally {
    h.restore();
  }
});

test('an unconfigured reader leaves the pre-slice behaviour exactly as it was', async () => {
  const h = harness({ pdf: pdfWithNoTextLayer(), ocr: { configured: false } });
  try {
    const result = await runExtraction(JOB);
    assert.equal(result.status, 'failed');
    const row = upload(h.db);
    assert.equal(row.failure_code, 'no_extractable_text');
    assert.match(row.error_message, /scanned image/i);
    assert.equal(h.calls.ocr, 0);
    assert.equal(h.calls.llm, 0);
  } finally {
    h.restore();
  }
});
