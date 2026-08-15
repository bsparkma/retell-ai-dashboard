'use strict';

/**
 * POST /api/rcm/eob and GET /api/rcm/eob, through the FULLY-ASSEMBLED chain.
 *
 * Everything here goes over a real HTTP server running the real auth gate,
 * tenantContext, requireModule('rcm'), requireReadWrite('rcm.read','rcm.write')
 * and the real routes/rcm/index.js — the same harness Slice 3 established, and
 * for the same reason: a test that called the handler directly would stay green
 * with the permission gate deleted.
 *
 * Blob storage is stubbed (there is no Azure in CI) and the queue's handler is
 * swapped for a recorder, so these tests are about the ROUTE: who may call it,
 * which office the row lands in, what it refuses, and what it does with bytes
 * it has seen before. The extraction itself is eobExtractionWorker.test.js.
 *
 * No real patient data anywhere — `syntheticPdf` builds a valid PDF in memory.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeRcmDb, bootRcmApp, api, auditRows, filePart, syntheticPdf } = require('./rcmTestUtils');
const blobStore = require('../../services/rcm/eobBlobStore');
const queue = require('../../services/rcm/eobExtractionQueue');
const budget = require('../../services/rcm/extractionBudget');

/**
 * Boot the app with storage and the queue stubbed.
 * @returns {Promise<{ baseUrl: string, db: FakeRcmDb, jobs: object[], stored: object[], close: () => Promise<void> }>}
 */
async function bootEob(opts = {}) {
  const jobs = [];
  const stored = [];

  const originals = {
    isConfigured: blobStore.isConfigured,
    putEob: blobStore.putEob,
    accountUrl: process.env.RCM_BLOB_ACCOUNT_URL,
  };

  if (opts.storageConfigured === false) {
    blobStore.isConfigured = () => false;
  } else {
    blobStore.isConfigured = () => true;
    blobStore.putEob = async ({ tenantSlug, data }) => {
      // Mint a real key through the real builder, so an opaque-key regression
      // shows up here too rather than only in the blob-store unit test.
      const key = blobStore.buildEobKey({ tenantSlug });
      stored.push({ key, bytes: data.length });
      return { key, url: `https://example.blob.core.windows.net/rcm-eob/${key}`, bytes: data.length };
    };
  }

  queue._resetForTests();
  queue._setHandler(async (job) => {
    jobs.push(job);
    return { status: 'exists' };
  });

  const booted = await bootRcmApp(opts);
  return {
    ...booted,
    jobs,
    stored,
    close: async () => {
      blobStore.isConfigured = originals.isConfigured;
      blobStore.putEob = originals.putEob;
      if (originals.accountUrl === undefined) delete process.env.RCM_BLOB_ACCOUNT_URL;
      else process.env.RCM_BLOB_ACCOUNT_URL = originals.accountUrl;
      queue._resetForTests();
      await booted.close();
    },
  };
}

/** POST one synthetic PDF. */
function postPdf(baseUrl, office, { bytes, filename = 'remittance.pdf', contentType, anon } = {}) {
  return api(baseUrl, 'POST', `/api/rcm/eob?office=${office}`, {
    anon,
    body: filePart(bytes || syntheticPdf(), filename, contentType),
  });
}

// ─── The gate ────────────────────────────────────────────────────────────────

test('the POST is gated on rcm.write — a role without it is refused, naming the action', async () => {
  // No tenant role holds rcm.read WITHOUT rcm.write today (both are
  // ['admin','office']), so the read-only case is exercised with `tc`, which
  // holds neither. What the assertion actually pins is the important half: the
  // POST is checked against rcm.WRITE, not rcm.read — which is what
  // requireReadWrite's method split is for, and what would silently regress if
  // the mount were ever narrowed to a single read gate.
  const { baseUrl, jobs, close } = await bootEob({ role: 'tc' });
  try {
    const res = await postPdf(baseUrl, 'roland');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
    assert.equal(res.body.action, 'rcm.write', 'the POST must be gated on the WRITE action');
    assert.equal(jobs.length, 0, 'a refused upload must not queue an extraction');
  } finally {
    await close();
  }
});

test('the GET is gated on rcm.read', async () => {
  const { baseUrl, close } = await bootEob({ role: 'hygiene' });
  try {
    const res = await api(baseUrl, 'GET', '/api/rcm/eob?office=roland');
    assert.equal(res.status, 403);
    assert.equal(res.body.action, 'rcm.read');
  } finally {
    await close();
  }
});

test('an unentitled tenant cannot upload at all', async () => {
  const { baseUrl, stored, close } = await bootEob({ modules: ['voice'] });
  try {
    const res = await postPdf(baseUrl, 'roland');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
    assert.equal(stored.length, 0, 'nothing may reach storage before entitlement is checked');
  } finally {
    await close();
  }
});

test('an anonymous caller gets 401, not a stored document', async () => {
  const { baseUrl, stored, close } = await bootEob();
  try {
    const res = await postPdf(baseUrl, 'roland', { anon: true });
    assert.equal(res.status, 401);
    assert.equal(stored.length, 0);
  } finally {
    await close();
  }
});

// ─── Office scoping ──────────────────────────────────────────────────────────

test('office comes from the validated query param, and the row carries it', async () => {
  const { baseUrl, db, jobs, close } = await bootEob();
  try {
    const res = await postPdf(baseUrl, 'valley');
    assert.equal(res.status, 201);
    assert.equal(res.body.office, 'valley');
    assert.equal(res.body.upload.officeId, 'valley');

    const rows = db.table('rcm_eob_uploads');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].office_id, 'valley');
    assert.equal(jobs[0].office, 'valley', 'the queued job carries the same office');
  } finally {
    await close();
  }
});

test('a missing or unknown office is refused before anything is stored', async () => {
  const { baseUrl, stored, close } = await bootEob();
  try {
    for (const qs of ['', '?office=', '?office=riley', '?office=ROLAND']) {
      const res = await api(baseUrl, 'POST', `/api/rcm/eob${qs}`, {
        body: filePart(syntheticPdf(), 'x.pdf'),
      });
      assert.equal(res.status, 400, `POST ${qs}`);
      assert.equal(res.body.code, 'INVALID_OFFICE');
    }
    assert.equal(stored.length, 0);
  } finally {
    await close();
  }
});

test('the list never crosses offices', async () => {
  const db = new FakeRcmDb().seed('rcm_eob_uploads', [
    { upload_id: 'u-rol', office_id: 'roland', filename: 'roland.pdf', status: 'extracted', uploaded_at: new Date('2026-08-01') },
    { upload_id: 'u-val', office_id: 'valley', filename: 'valley.pdf', status: 'uploaded', uploaded_at: new Date('2026-08-02') },
  ]);
  const { baseUrl, close } = await bootEob({ db });
  try {
    const roland = await api(baseUrl, 'GET', '/api/rcm/eob?office=roland');
    assert.equal(roland.status, 200);
    assert.equal(roland.body.total, 1);
    assert.deepEqual(
      roland.body.uploads.map((u) => u.uploadId),
      ['u-rol']
    );

    const valley = await api(baseUrl, 'GET', '/api/rcm/eob?office=valley');
    assert.deepEqual(
      valley.body.uploads.map((u) => u.uploadId),
      ['u-val']
    );
  } finally {
    await close();
  }
});

// ─── What it refuses ─────────────────────────────────────────────────────────

test('a non-PDF is refused on its MAGIC BYTES, not its declared type', async () => {
  const { baseUrl, stored, close } = await bootEob();
  try {
    // A PNG wearing a .pdf name and an application/pdf content type — exactly
    // what a browser that guessed wrong, or a client that lied, would send.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(1024, 0x20),
    ]);
    const res = await postPdf(baseUrl, 'roland', { bytes: png, filename: 'eob.pdf' });
    assert.equal(res.status, 415);
    assert.equal(res.body.code, 'NOT_A_PDF');
    assert.equal(stored.length, 0);
  } finally {
    await close();
  }
});

test('a file too small to be a document is refused', async () => {
  const { baseUrl, close } = await bootEob();
  try {
    const res = await postPdf(baseUrl, 'roland', { bytes: Buffer.from('%PDF-1.4\n') });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'FILE_TOO_SMALL');
  } finally {
    await close();
  }
});

test('a request with no file attached says so', async () => {
  const { baseUrl, close } = await bootEob();
  try {
    const res = await api(baseUrl, 'POST', '/api/rcm/eob?office=roland', { body: new FormData() });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'NO_FILE');
  } finally {
    await close();
  }
});

test('unconfigured storage is a structured 503, not a crash', async () => {
  const { baseUrl, close } = await bootEob({ storageConfigured: false });
  try {
    const res = await postPdf(baseUrl, 'roland');
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'EOB_STORAGE_UNAVAILABLE');
  } finally {
    await close();
  }
});

// ─── The happy path ──────────────────────────────────────────────────────────

test('a new upload stores bytes, writes an uploaded row, and queues extraction', async () => {
  const { baseUrl, db, jobs, stored, close } = await bootEob();
  try {
    const res = await postPdf(baseUrl, 'roland', { filename: 'August remittance.pdf' });
    assert.equal(res.status, 201);
    assert.equal(res.body.duplicate, false);
    assert.equal(res.body.upload.status, 'uploaded');
    assert.equal(res.body.upload.filename, 'August remittance.pdf');
    assert.equal(res.body.upload.resultClaimId, null, 'nothing is extracted yet');

    const row = db.table('rcm_eob_uploads')[0];
    assert.equal(row.status, 'uploaded');
    assert.equal(row.content_type, 'application/pdf');
    assert.equal(row.file_hash.length, 64, 'sha-256 hex');
    assert.equal(row.file_key, stored[0].key);

    assert.equal(jobs.length, 1);
    assert.deepEqual(Object.keys(jobs[0]).sort(), ['office', 'tenantId', 'tenantSlug', 'uploadId']);
    for (const v of Object.values(jobs[0])) {
      assert.equal(typeof v, 'string', 'a job must be plain serializable data — no req, no pool');
    }
  } finally {
    await close();
  }
});

test('the blob key is opaque — the filename is in the row, never in the key or the response', async () => {
  const { baseUrl, db, stored, close } = await bootEob();
  try {
    const res = await postPdf(baseUrl, 'roland', { filename: 'Testpatient Alpha EOB 3-14.pdf' });
    assert.equal(res.status, 201);

    assert.ok(!/Testpatient|Alpha|3-14/i.test(stored[0].key), `key leaked the filename: ${stored[0].key}`);
    assert.match(stored[0].key, /^tenant\/carein\/rcm\/eob\/[0-9a-f-]{36}\.pdf$/);

    // The filename IS stored — it is how the uploader finds their own document.
    assert.equal(db.table('rcm_eob_uploads')[0].filename, 'Testpatient Alpha EOB 3-14.pdf');
    // But the storage coordinates never leave the building.
    assert.ok(!('fileKey' in res.body.upload));
    assert.ok(!('fileUrl' in res.body.upload));
    assert.ok(!JSON.stringify(res.body).includes(stored[0].key));
  } finally {
    await close();
  }
});

test('the upload is audited before the response, with the id and never the filename', async () => {
  const { baseUrl, db, close } = await bootEob();
  try {
    const res = await postPdf(baseUrl, 'roland', { filename: 'Testpatient Alpha EOB.pdf' });
    assert.equal(res.status, 201);

    const rows = auditRows(db);
    const created = rows.filter((r) => r.resource_type === 'rcm_eob_upload' && r.action === 'CREATE');
    assert.equal(created.length, 1);
    assert.equal(created[0].resource_id, res.body.upload.uploadId);
    assert.equal(created[0].office, 'roland');
    assert.equal(created[0].result, 'SUCCESS');
    assert.equal(created[0].source_ref, null);
    assert.ok(!JSON.stringify(created[0]).includes('Testpatient'), 'no PHI in the audit row');
  } finally {
    await close();
  }
});

test('the GET audits the read — filename makes the list a PHI path', async () => {
  const db = new FakeRcmDb().seed('rcm_eob_uploads', [
    { upload_id: 'u1', office_id: 'roland', filename: 'a.pdf', status: 'uploaded', uploaded_at: new Date() },
  ]);
  const { baseUrl, close } = await bootEob({ db });
  try {
    await api(baseUrl, 'GET', '/api/rcm/eob?office=roland');
    const reads = auditRows(db).filter(
      (r) => r.resource_type === 'rcm_eob_upload' && r.action === 'READ'
    );
    assert.equal(reads.length, 1);
    assert.equal(reads[0].resource_id, null, 'a list read has no single resource id');
    assert.equal(reads[0].office, 'roland');
  } finally {
    await close();
  }
});

// ─── Re-submitting the same document ─────────────────────────────────────────

test('re-uploading an extracted document costs nothing and returns the existing result', async () => {
  const db = new FakeRcmDb();
  const { baseUrl, jobs, stored, close } = await bootEob({ db });
  try {
    const first = await postPdf(baseUrl, 'roland');
    assert.equal(first.status, 201);

    // Mark it extracted, as the worker would.
    const row = db.table('rcm_eob_uploads')[0];
    row.status = 'extracted';
    row.result_claim_id = 'claim-1';
    row.result_batch_id = 'batch-1';

    const again = await postPdf(baseUrl, 'roland');
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.upload.status, 'extracted');
    assert.equal(again.body.upload.resultClaimId, 'claim-1');
    assert.equal(db.table('rcm_eob_uploads').length, 1, 'no second row');
    assert.equal(stored.length, 1, 'the bytes are not stored twice');
    assert.equal(jobs.length, 1, 'and no second extraction is queued — that would re-spend');
  } finally {
    await close();
  }
});

test('re-uploading a FAILED document is the retry path — it re-queues and clears the reason', async () => {
  const db = new FakeRcmDb();
  const { baseUrl, jobs, close } = await bootEob({ db });
  try {
    await postPdf(baseUrl, 'roland');
    const row = db.table('rcm_eob_uploads')[0];
    row.status = 'failed';
    row.error_message = 'The extraction service could not be reached. Try again.';

    const retry = await postPdf(baseUrl, 'roland');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.requeued, true);
    assert.equal(retry.body.upload.status, 'uploaded');
    assert.equal(retry.body.upload.message, null, 'the stale failure reason is cleared');

    assert.equal(db.table('rcm_eob_uploads')[0].status, 'uploaded');
    assert.equal(db.table('rcm_eob_uploads')[0].error_message, null);
    assert.equal(jobs.length, 2, 'the retry is queued');
  } finally {
    await close();
  }
});

test('re-uploading while an attempt is IN FLIGHT does not queue a second one', async () => {
  const db = new FakeRcmDb();
  const { baseUrl, jobs, close } = await bootEob({ db });
  try {
    await postPdf(baseUrl, 'roland');
    db.table('rcm_eob_uploads')[0].status = 'processing';

    const again = await postPdf(baseUrl, 'roland');
    assert.equal(again.status, 200);
    assert.equal(again.body.upload.status, 'processing');
    assert.equal(jobs.length, 1);
  } finally {
    await close();
  }
});

test('the same bytes in the OTHER office are a separate document', async () => {
  const db = new FakeRcmDb();
  const { baseUrl, close } = await bootEob({ db });
  try {
    await postPdf(baseUrl, 'roland');
    await postPdf(baseUrl, 'valley');
    const rows = db.table('rcm_eob_uploads');
    assert.equal(rows.length, 2, 'dedup is per-office — two practices can file the same check');
    assert.deepEqual(rows.map((r) => r.office_id).sort(), ['roland', 'valley']);
  } finally {
    await close();
  }
});

// ─── Breaker state on the wire ───────────────────────────────────────────────

test('the list surfaces the breaker state honestly', async () => {
  const { baseUrl, close } = await bootEob();
  try {
    const res = await api(baseUrl, 'GET', '/api/rcm/eob?office=roland');
    assert.equal(res.status, 200);
    const e = res.body.extraction;
    assert.equal(typeof e.paused, 'boolean');
    assert.equal(typeof e.usedCents, 'number');
    assert.equal(e.capCents, budget.check().capCents);
    assert.ok(Date.parse(e.resetsAt) > Date.now());
    assert.equal(typeof e.queue.pending, 'number');
  } finally {
    await close();
  }
});

test('an upload still SUCCEEDS while the breaker is tripped — extraction waits', async () => {
  const prior = process.env.RCM_EXTRACTION_MAX_CENTS_PER_DAY;
  const { baseUrl, db, jobs, close } = await bootEob();
  try {
    // Trip the rail for real, through the same counter production uses.
    budget._resetForTests();
    process.env.RCM_EXTRACTION_MAX_CENTS_PER_DAY = '1';
    budget.charge({ prompt_tokens: 0, completion_tokens: 100_000, total_tokens: 100_000 });
    assert.equal(budget.check().allowed, false, 'precondition: the breaker is tripped');

    const res = await postPdf(baseUrl, 'roland');
    assert.equal(res.status, 201, 'a tripped cost cap must never reject an upload');
    assert.equal(res.body.upload.status, 'uploaded');
    assert.equal(res.body.extraction.paused, true, 'and the response says so');
    assert.equal(db.table('rcm_eob_uploads').length, 1, 'the document is kept');
    assert.equal(jobs.length, 1, 'and it is queued, not dropped');
  } finally {
    if (prior === undefined) delete process.env.RCM_EXTRACTION_MAX_CENTS_PER_DAY;
    else process.env.RCM_EXTRACTION_MAX_CENTS_PER_DAY = prior;
    budget._resetForTests();
    await close();
  }
});
