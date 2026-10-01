'use strict';

/**
 * ARCHIVE — the third way off the board, and the guard that earns it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS AT STAKE
 * ═════════════════════════════════════════════════════════════════════════════
 * Archive is the one state that takes a check out of EVERY list and count,
 * including `view=all`. That is only safe because of its precondition: a check
 * with any posting history — a plan queued, posted, failed, swept back to
 * approved, blocked, retired — REFUSES, by name, pointing at Set aside. The
 * refusal IS the feature; a green suite here with that guard inverted would be
 * a product that can hide the record of money. So the guard is tested from
 * both sides and mutation-proved in the PR.
 *
 * Booted through the REAL /api/rcm stack, like worklistState.test.js: auth
 * gate → tenantContext → requireModule('rcm') → requireReadWrite → the real
 * router. NO REAL PATIENTS — every name and number below is synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeRcmDb, bootRcmApp, api, auditRows } = require('./rcmTestUtils');

const BATCH = '8acb0e32-35ae-5cd8-9692-7b5e318a31c2';
const CLAIM = 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d';

/** One check, one claim — the minimum the attention predicate reads. */
function seed(db, over = {}) {
  const office = over.office || 'roland';
  const batchId = over.batchId || BATCH;
  const claimId = over.claimId || CLAIM;
  db.seed('rcm_payment_batches', [
    {
      batch_id: batchId,
      office_id: office,
      payer: 'SYNTHETIC DENTAL',
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
      status: 'ready',
      era_file_key: over.eraFileKey ?? 'tenant/carein/rcm/era/k1.edi',
      notes: '',
      created_by: null,
      created_at: new Date('2026-03-02T10:00:00Z'),
      parked_at: null,
      parked_by: null,
      parked_note: null,
      set_aside_at: null,
      set_aside_by: null,
      set_aside_reason: null,
      set_aside_reason_note: null,
      archived_at: over.archivedAt ?? null,
      archived_by: over.archivedBy ?? null,
      archived_reason: over.archivedReason ?? null,
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: claimId,
      office_id: office,
      claim_number: '53648',
      check_number: '830200001',
      patient_name: 'Fixture, Synthetic',
      od_patient_id: null,
      od_claim_num: null,
      payer: 'SYNTHETIC DENTAL',
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
      batch_id: batchId,
      claim_id: claimId,
      office_id: office,
      position: 1,
      paid_cents: 15000,
    },
  ]);
  return db;
}

/** A posting plan for the batch — the thing that must refuse an archive. */
function seedPlan(db, status, over = {}) {
  db.seed('rcm_posting_queue', [
    {
      queue_id: over.queueId || 'b3a3b7c1-1d2e-4f50-8a9b-0c1d2e3f4a5b',
      office_id: over.office || 'roland',
      batch_id: over.batchId || BATCH,
      remittance_key: over.remittanceKey || 'K1|SYNTHETIC|2026-03-02|15000|830200001',
      status,
      blocked_reason: status === 'blocked' ? 'od_write_disabled' : null,
      approved_at: new Date('2026-03-03T10:00:00Z'),
      approved_by: null,
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

const archive = (app, reason, batchId = BATCH) =>
  api(app.baseUrl, 'POST', `/api/rcm/remittances/${batchId}/archive${Q}`, json({ reason }));
const unarchive = (app, batchId = BATCH) =>
  api(app.baseUrl, 'POST', `/api/rcm/remittances/${batchId}/unarchive${Q}`, json({}));
const listing = (app, view) =>
  api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}${view ? `&view=${view}` : ''}`);

// ─────────────────────────────────────────────────────────────────────────────
// THE ACT — stamps, reason, audit
// ─────────────────────────────────────────────────────────────────────────────

test('archiving a never-queued check records who, when and why, and is audited', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await archive(app, 'Test upload — not a real check');
    assert.equal(res.status, 200);
    assert.equal(res.body.archived, true);

    const row = db.table('rcm_payment_batches')[0];
    assert.ok(row.archived_at, 'an archived check must carry its instant');
    assert.ok(row.archived_by, 'and the person');
    assert.equal(row.archived_reason, 'Test upload — not a real check');

    const trail = auditRows(db).filter((r) => r.resource_type === 'rcm_remittance_archive');
    assert.equal(trail.length, 1);
    assert.equal(trail[0].resource_id, BATCH);
    assert.equal(trail[0].result, 'SUCCESS');
    // The reason is PHI-capable free text and must never reach the trail.
    assert.ok(!JSON.stringify(trail[0]).includes('Test upload'));
  });
});

test('a reason is required — a blank one refuses and stamps nothing', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      const res = await api(
        app.baseUrl,
        'POST',
        `/api/rcm/remittances/${BATCH}/archive${Q}`,
        json(body)
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'ARCHIVE_REASON_REQUIRED');
    }
    assert.equal(db.table('rcm_payment_batches')[0].archived_at, null);
    assert.equal(
      auditRows(db).filter((r) => r.resource_type === 'rcm_remittance_archive').length,
      0
    );
  });
});

test('archive and unarchive are the write tier — a reviewer is refused, naming rcm.write', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'reviewer' }, async (app) => {
    const res = await archive(app, 'Test upload');
    assert.equal(res.status, 403);
    assert.equal(res.body.action, 'rcm.write');

    const back = await unarchive(app);
    assert.equal(back.status, 403);
    assert.equal(back.body.action, 'rcm.write');

    assert.equal(db.table('rcm_payment_batches')[0].archived_at, null);
  });
});

test("another office's check is NOT FOUND, never archived", async () => {
  const db = seed(new FakeRcmDb(), { office: 'valley' });
  await withApp({ db }, async (app) => {
    const res = await archive(app, 'Test upload');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'REMITTANCE_NOT_FOUND');
    assert.equal(db.table('rcm_payment_batches')[0].archived_at, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE GUARD — any posting history refuses, by name
// ─────────────────────────────────────────────────────────────────────────────

for (const status of ['approved', 'posting', 'posted', 'failed', 'partially_posted', 'blocked', 'withdrawn']) {
  test(`a check whose plan is '${status}' cannot be archived — 409, named, pointing at Set aside`, async () => {
    const db = seedPlan(seed(new FakeRcmDb()), status);
    await withApp({ db }, async (app) => {
      const res = await archive(app, 'Trying to tidy up');
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'ARCHIVE_POSTING_HISTORY');
      assert.deepEqual(res.body.statuses, [status], 'the refusal names the plan state');
      assert.match(res.body.error, /Set aside/, 'and points at the affordance that fits');

      const row = db.table('rcm_payment_batches')[0];
      assert.equal(row.archived_at, null, 'nothing was stamped');
      assert.equal(row.archived_reason, null);
      assert.equal(
        auditRows(db).filter((r) => r.resource_type === 'rcm_remittance_archive').length,
        0,
        'a refusal files no archive audit row'
      );
    });
  });
}

test('the refusal also leaves every dedupe guard armed', async () => {
  const db = seedPlan(seed(new FakeRcmDb()), 'posted');
  db.seed('rcm_eob_uploads', [
    {
      upload_id: 'u-1',
      office_id: 'roland',
      filename: 'synthetic.pdf',
      file_hash: 'a'.repeat(64),
      status: 'extracted',
      result_batch_id: BATCH,
    },
  ]);
  db.seed('rcm_remittance_keys', [
    {
      remittance_key_id: 'k-1',
      office_id: 'roland',
      remittance_key: 'K1|SYNTHETIC|2026-03-02|15000|830200001',
      status: 'posted',
      batch_id: BATCH,
    },
  ]);
  await withApp({ db }, async (app) => {
    const res = await archive(app, 'Trying to tidy up');
    assert.equal(res.status, 409);
    assert.equal(db.table('rcm_eob_uploads')[0].status, 'extracted', 'the hash is still held');
    assert.equal(db.table('rcm_remittance_keys')[0].status, 'posted', 'the key still blocks');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OFF THE BOARD — every view, every count, except its own tab
// ─────────────────────────────────────────────────────────────────────────────

test('an archived check disappears from every view and count, and lives under view=archived', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const before = await listing(app);
    assert.equal(before.body.total, 1);
    assert.equal(before.body.needsAttentionCount, 1, 'the unreviewed claim makes it work');
    assert.equal(before.body.archivedCount, 0);

    assert.equal((await archive(app, 'Test upload')).status, 200);

    const after = await listing(app);
    assert.equal(after.body.total, 0, 'out of the total');
    assert.equal(after.body.needsAttentionCount, 0, 'out of the attention count');
    assert.equal(after.body.archivedCount, 1, 'counted under its own partition');
    assert.equal(after.body.remittances.length, 0, 'and off the default (all) view');

    for (const view of ['attention', 'parked', 'set_aside']) {
      const page = await listing(app, view);
      assert.equal(page.body.remittances.length, 0, `absent from view=${view}`);
    }

    const archived = await listing(app, 'archived');
    assert.equal(archived.body.remittances.length, 1, 'present under its own tab');
    const row = archived.body.remittances[0];
    assert.equal(row.batchId, BATCH);
    assert.ok(row.archivedAt, 'the row says when');
    assert.equal(row.archivedReason, 'Test upload');
    assert.equal(row.needsAttention, false);
    assert.deepEqual(row.attentionObservations, ['archived']);
  });
});

test('the office summary stops counting an archived check', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const before = await api(app.baseUrl, 'GET', `/api/rcm/summary${Q}`);
    assert.equal(before.body.batches.total, 1);

    await archive(app, 'Test upload');

    const after = await api(app.baseUrl, 'GET', `/api/rcm/summary${Q}`);
    assert.equal(after.body.batches.total, 0);
  });
});

test('the detail still opens an archived check — the Archived tab has to lead somewhere', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    await archive(app, 'Test upload');
    const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances/${BATCH}${Q}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.remittance.archivedAt);
    assert.equal(res.body.remittance.archivedReason, 'Test upload');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DUP-HASH IS FREED, AND NOTHING IS DELETED
// ─────────────────────────────────────────────────────────────────────────────

test('archiving frees the EOB hash and releases the ERA key; rows and blobs are kept', async () => {
  const db = seed(new FakeRcmDb());
  db.seed('rcm_eob_uploads', [
    {
      upload_id: 'u-1',
      office_id: 'roland',
      filename: 'synthetic.pdf',
      file_key: 'tenant/carein/rcm/eob/u-1.pdf',
      file_hash: 'a'.repeat(64),
      status: 'extracted',
      result_batch_id: BATCH,
    },
  ]);
  db.seed('rcm_remittance_keys', [
    {
      remittance_key_id: 'k-1',
      office_id: 'roland',
      remittance_key: 'K1|SYNTHETIC|2026-03-02|15000|830200001',
      status: 'posted',
      batch_id: BATCH,
    },
  ]);
  await withApp({ db }, async (app) => {
    assert.equal((await archive(app, 'Test upload')).status, 200);

    const upload = db.table('rcm_eob_uploads')[0];
    assert.equal(upload.status, 'archived', 'the upload stops holding its hash');
    assert.equal(upload.file_key, 'tenant/carein/rcm/eob/u-1.pdf', 'the blob pointer is kept');
    assert.equal(db.table('rcm_eob_uploads').length, 1, 'nothing deleted');

    const key = db.table('rcm_remittance_keys')[0];
    assert.equal(key.status, 'failed', 'released — the state a new upload takes over');
    assert.equal(db.table('rcm_remittance_keys').length, 1, 'nothing deleted');
    assert.equal(db.table('rcm_claims').length, 1, 'claims are kept');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UNARCHIVE — the half that makes it safe to press
// ─────────────────────────────────────────────────────────────────────────────

test('unarchiving clears the stamps, re-arms both dedupe guards, and the check rejoins the lists', async () => {
  const db = seed(new FakeRcmDb());
  db.seed('rcm_eob_uploads', [
    {
      upload_id: 'u-1',
      office_id: 'roland',
      filename: 'synthetic.pdf',
      file_hash: 'a'.repeat(64),
      status: 'extracted',
      result_batch_id: BATCH,
    },
  ]);
  db.seed('rcm_remittance_keys', [
    {
      remittance_key_id: 'k-1',
      office_id: 'roland',
      remittance_key: 'K1|SYNTHETIC|2026-03-02|15000|830200001',
      status: 'posted',
      batch_id: BATCH,
    },
  ]);
  await withApp({ db }, async (app) => {
    await archive(app, 'Test upload');
    const res = await unarchive(app);
    assert.equal(res.status, 200);
    assert.equal(res.body.wasArchived, true);

    const row = db.table('rcm_payment_batches')[0];
    assert.equal(row.archived_at, null);
    assert.equal(row.archived_by, null);
    assert.equal(row.archived_reason, null);

    assert.equal(db.table('rcm_eob_uploads')[0].status, 'extracted', 'the hash is held again');
    assert.equal(db.table('rcm_remittance_keys')[0].status, 'posted', 'the key blocks again');

    const page = await listing(app);
    assert.equal(page.body.total, 1, 'back in the total');
    assert.equal(page.body.archivedCount, 0);
  });
});

test('unarchiving does NOT reclaim a hash a newer live upload now holds', async () => {
  const db = seed(new FakeRcmDb());
  db.seed('rcm_eob_uploads', [
    {
      upload_id: 'u-old',
      office_id: 'roland',
      filename: 'synthetic.pdf',
      file_hash: 'a'.repeat(64),
      status: 'archived',
      result_batch_id: BATCH,
    },
    // The same file, re-uploaded while the first check was archived.
    {
      upload_id: 'u-new',
      office_id: 'roland',
      filename: 'synthetic.pdf',
      file_hash: 'a'.repeat(64),
      status: 'uploaded',
      result_batch_id: null,
    },
  ]);
  // Seeded as already archived, so only the unarchive path runs.
  const batch = db.table('rcm_payment_batches')[0];
  batch.archived_at = new Date('2026-03-04T10:00:00Z');
  batch.archived_by = 'u-actor';
  batch.archived_reason = 'Test upload';
  db.seed('rcm_user_map', [{ user_key: 'u-actor', email: 'x@example.com', display_name: 'X' }]);

  await withApp({ db }, async (app) => {
    const res = await unarchive(app);
    assert.equal(res.status, 200);
    assert.equal(db.table('rcm_payment_batches')[0].archived_at, null, 'the check comes back');
    const statuses = db
      .table('rcm_eob_uploads')
      .map((u) => [u.upload_id, u.status].join(':'))
      .sort();
    // The old row STAYS archived: flipping it would put two live rows on one
    // hash, and the newer upload's dedupe is the one that should win.
    assert.deepEqual(statuses, ['u-new:uploaded', 'u-old:archived']);
  });
});

test('unarchiving a check nobody archived is an idempotent no-op with no audit row', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await unarchive(app);
    assert.equal(res.status, 200);
    assert.equal(res.body.wasArchived, false);
    assert.equal(
      auditRows(db).filter((r) => r.resource_type === 'rcm_remittance_archive').length,
      0
    );
  });
});
