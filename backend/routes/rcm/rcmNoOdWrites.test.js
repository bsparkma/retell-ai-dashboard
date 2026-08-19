'use strict';

/**
 * THE RCM MODULE NEVER WRITES TO OPEN DENTAL — enforced, not asserted in prose.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED IN SLICE 6a, AND WHAT DID NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * Slices 4 and 5 shipped a guard called "the RCM module does not touch Open
 * Dental", written when nothing in the module legitimately could. Slice 6a is
 * the slice where matching arrives, so RCM reads Open Dental for the first time
 * — and the old invariant would have to be either deleted or defeated with an
 * allow-list, which is how a guard quietly stops guarding.
 *
 * It is replaced here by the invariant that actually matters and that survives
 * every later slice: **reads are allowed, writes are not.** Slice 6c will
 * introduce chart writes in a module of its own, behind an approval gate and a
 * posting queue; nothing under /api/rcm's read and match surface may ever grow
 * one, and this file is what makes that a test failure rather than a review
 * comment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT SLICE 6b CHANGED, AND WHAT IT DID NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * 6b writes `rcm_posting_queue` — the durable record of INTENDED posting — so
 * the flat "no RCM source touches the posting queue" test below could not
 * survive as written. It has been REPLACED rather than deleted, by two stronger
 * statements:
 *
 *   1. only the APPROVAL GATE may name the queue (an enumerated file list, the
 *      same idiom the OD read seam uses), so a workbench route cannot start
 *      enqueueing without appearing in this file's diff; and
 *   2. driving the whole approve surface CREATES queue rows and reaches NO Open
 *      Dental verb at all — not a write, not even a read.
 *
 * (2) is the one that matters. "Approving is not posting" is the central claim
 * of Slice 6b, and it is only a testable claim if something asserts that the
 * money-authorising path never touches a chart.
 *
 * FOUR LAYERS, because each catches what the others miss:
 *
 *   1. BEHAVIOURAL — boot the real router with a client whose every write verb
 *      throws, drive the whole workbench surface, and assert only `apiGetRaw`
 *      was ever called. This is the one that would catch a write added three
 *      files deep through a helper nobody grepped for.
 *   2. GRAPH — the ingestion path (upload, parse, extract) must STILL reach no
 *      Open Dental module at all. Matching is a separate, deliberate act; a
 *      background extraction worker that can reach a chart is a different and
 *      worse thing than a biller pressing Match.
 *   3. IMPORTS — only the two config modules that constitute the read seam may
 *      be named, and `services/openDentalSync` (the WRITE path) may not.
 *   4. STATIC — no RCM source names an OD write method or a write-only verb.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

const { FakeRcmDb, FakeOd, bootRcmApp, api } = require('./rcmTestUtils');

// ─── The Open Dental surface, split by what it is FOR ────────────────────────

/**
 * Modules that can only be here to READ. `config/odOffices` is the per-office
 * registry and `config/openDental` is the client class it hands out — the seam
 * `assertOfficeMatch` guards. `config/officeAgents` rides along as odOffices'
 * own dependency.
 */
const OD_READ_SEAM = ['config/odOffices', 'config/openDental', 'config/officeAgents'];

/**
 * Modules that exist to WRITE, or that route around the per-office registry.
 * `openDentalSync` is the voice module's commlog writer. `platform/odAccess` is
 * the TENANT-level seam bound to one configured client — using it here would
 * silently read Roland's database under a Valley office selector.
 */
const OD_WRITE_SURFACE = [
  'services/openDentalSync',
  'platform/odAccess',
  'routes/opendentalSync',
  'routes/opendental',
  'services/odHealthCheck',
];

/** Every currently-loaded module path, normalized to forward slashes. */
function loadedModules() {
  return Object.keys(require.cache).map((p) => p.split(path.sep).join('/'));
}

/** Load `id` and report which of `surface` came with it. */
function modulesReachableFrom(id, surface) {
  const before = new Set(loadedModules());
  require(id);
  return loadedModules()
    .filter((p) => !before.has(p))
    .filter((p) => !p.includes('/node_modules/'))
    .filter((p) => surface.some((od) => p.toLowerCase().includes(od.toLowerCase())));
}

/** Every non-test .js source in the RCM module, as { name, code-without-comments }. */
function rcmSources() {
  const roots = [__dirname, path.join(__dirname, '../../services/rcm')];
  const out = [];
  for (const root of roots) {
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.js') || name.endsWith('.test.js') || name === 'rcmTestUtils.js') continue;
      const src = fs.readFileSync(path.join(root, name), 'utf8');
      out.push({
        label: `${path.basename(root)}/${name}`,
        raw: src,
        // Strip block and line comments. Half this module's prose explains at
        // length why these calls are absent, and prose is not a call site.
        code: src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
      });
    }
  }
  return out;
}

// ─── 1. Behavioural — drive the surface, assert only reads happened ──────────

/** A minimal but recorded-shape Open Dental, enough for a match to succeed. */
function odFixture() {
  return new FakeOd({
    patients: [{ PatNum: 12828, LName: 'Fixture', FName: 'Synthetic', Birthdate: '1990-01-01' }],
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
  });
}

/**
 * A proposal claim on a batch, seeded straight into the fake tenant DB.
 *
 * `approvable` seeds the extra state Slice 6b's gate demands — a confirmed
 * match with a current snapshot, a review, a paired line and a batch claim
 * payment whose amounts reconcile — so the approve path can be driven to
 * SUCCESS here. A test that only ever drove approve to a refusal would prove
 * nothing about whether the successful path touches Open Dental.
 */
function seedProposal(db, { approvable = false } = {}) {
  db.seed('rcm_payment_batches', [
    {
      batch_id: '8acb0e32-35ae-5cd8-9692-7b5e318a31c2',
      office_id: 'roland',
      payer: 'DELTA DENTAL OF ARKANSAS',
      check_number: '830200001',
      total_amount_cents: 15000,
      plb_total_cents: 0,
      claim_count: 1,
      status: 'ready',
      era_file_key: 'tenant/carein/rcm/era/k1.edi',
      notes: '',
      created_at: new Date('2026-03-02T10:00:00Z'),
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d',
      office_id: 'roland',
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
      needs_review_reasons: [],
      confidence: 95,
      od_match_status: 'not_run',
      created_at: new Date('2026-03-02T10:00:00Z'),
    },
  ]);
  db.seed('rcm_batch_claim_payments', [
    {
      batch_claim_payment_id: 'e9247d49-d687-56bc-ba36-ebbf4f05b56c',
      batch_id: '8acb0e32-35ae-5cd8-9692-7b5e318a31c2',
      claim_id: 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d',
      office_id: 'roland',
      position: 1,
      paid_cents: 15000,
    },
  ]);
  db.seed('rcm_procedure_lines', [
    {
      line_id: 'a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90',
      claim_id: 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d',
      office_id: 'roland',
      position: 1,
      billed_code: 'D0150',
      paid_code: null,
      code: 'D0150',
      description: 'Comprehensive oral evaluation',
      billed_cents: 21000,
      allowed_cents: 15000,
      paid_cents: 15000,
      deductible_cents: 0,
      copay_cents: 0,
      adjustment_cents: 6000,
      patient_resp_cents: 0,
      write_off_cents: 6000,
      is_downcoded: false,
      is_bundled: false,
      is_denied: false,
      flags: [],
      od_claim_proc_num: null,
    },
  ]);
  db.seed('rcm_eob_uploads', [
    {
      upload_id: '57c97173-8178-5976-997e-9de296795b28',
      office_id: 'roland',
      filename: 'delta_fixture.edi',
      file_key: 'tenant/carein/rcm/era/k1.edi',
      file_url: '',
      status: 'extracted',
      uploaded_at: new Date('2026-03-02T10:00:00Z'),
      uploaded_by: null,
    },
  ]);

  if (approvable) {
    const claim = db.table('rcm_claims')[0];
    claim.od_match_status = 'confirmed';
    claim.od_claim_num = 53648;
    claim.od_patient_id = 12828;
    claim.od_match_confirmed_at = new Date('2026-03-02T11:00:00Z');
    claim.od_matched_by = 'user-1';
    claim.reviewed_at = new Date('2026-03-02T11:05:00Z');
    claim.reviewed_by = 'user-1';
    claim.od_match_snapshot = {
      version: 2,
      office: 'roland',
      candidates: [{ odClaimNum: 53648, blockers: [], linePairs: [] }],
      confirmed: {
        odClaimNum: 53648,
        odPatNum: 12828,
        confirmedAt: '2026-03-02T11:00:00.000Z',
        confirmedBy: 'user-1',
        linePairs: [{ lineId: 'a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90', odClaimProcNum: 99001 }],
        odAmountsAsRead: { billedCents: 21000, claimHeaderFeeCents: 21000, insPaidCents: 0, writeOffCents: 0, claimStatus: 'S' },
      },
    };
    db.table('rcm_procedure_lines')[0].od_claim_proc_num = 99001;
    db.seed('rcm_user_map', [
      { user_key: 'user-1', platform_email: 'biller@example.invalid', display_name: 'Fixture Biller', active: true },
    ]);
  }

  return db;
}

test('driving the whole workbench surface calls only apiGetRaw on the OD client', async () => {
  const db = seedProposal(new FakeRcmDb());
  const od = odFixture();
  const app = await bootRcmApp({ db, od });
  try {
    const q = '?office=roland';
    // Every endpoint this slice adds, including the two that mutate our rows.
    await api(app.baseUrl, 'GET', `/api/rcm/remittances${q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2${q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d${q}`);

    const matched = await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/match${q}`, {
      body: JSON.stringify({}),
      json: true,
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));

    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/confirm-match${q}`, {
      body: JSON.stringify({ odClaimNum: 53648 }),
      json: true,
    });
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/review${q}`, {
      body: JSON.stringify({ note: 'checked' }),
      json: true,
    });

    // Slice 6b's checklist — a read, and one a `reviewer` can make.
    const checklist = await api(app.baseUrl, 'GET', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/approval${q}`);
    assert.equal(checklist.status, 200, JSON.stringify(checklist.body));

    // THE ASSERTION. Not "no write was observed to fail" — no write verb was
    // reached at all, which is a stronger and more durable claim.
    assert.deepEqual(od.methodsUsed(), ['apiGetRaw']);
    // And it did do real reads, so the assertion above is not vacuously true.
    assert.ok(od.pathsRead().includes('/claims'), 'the match should have read /claims');
  } finally {
    await app.close();
  }
});

test('a batch match over a remittance also reaches only apiGetRaw', async () => {
  const db = seedProposal(new FakeRcmDb());
  const od = odFixture();
  const app = await bootRcmApp({ db, od });
  try {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/match?office=roland', {
      body: JSON.stringify({}),
      json: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(od.methodsUsed(), ['apiGetRaw']);
  } finally {
    await app.close();
  }
});

// ─── 2. Graph — ingestion stays entirely OD-free ─────────────────────────────

test('the extraction worker graph contains no Open Dental module at all', () => {
  const found = modulesReachableFrom('../../services/rcm/eobExtractionWorker', [
    ...OD_READ_SEAM,
    ...OD_WRITE_SURFACE,
  ]);
  assert.deepEqual(
    found,
    [],
    'the extraction worker runs in the BACKGROUND with no human in the loop. ' +
      'It must not be able to reach a chart even to read one. Found: ' + found.join(', ')
  );
});

test('the ERA parse + ingest path contains no Open Dental module at all', () => {
  const found = modulesReachableFrom('../../services/rcm/eraIngest', [
    ...OD_READ_SEAM,
    ...OD_WRITE_SURFACE,
  ]);
  assert.deepEqual(found, [], 'parsing an 835 needs no chart. Found: ' + found.join(', '));
});

// ─── 3. Imports — the read seam only, never the write path ───────────────────

test('the /api/rcm router graph reaches no Open Dental WRITE module', () => {
  const found = modulesReachableFrom('./index', OD_WRITE_SURFACE);
  assert.deepEqual(
    found,
    [],
    'RCM reads Open Dental through the per-office registry (config/odOffices) and ' +
      'nothing else. openDentalSync is the voice commlog WRITER; platform/odAccess is ' +
      'the tenant-level seam bound to ONE office and would read Roland under a Valley ' +
      'selector. Found: ' + found.join(', ')
  );
});

test('only the match layer names an Open Dental module, and only the read seam', () => {
  /** Files allowed to name the OD read seam. Everything else must not. */
  const MATCH_LAYER = new Set(['rcm/matchService.js', 'rcm/claims.js']);
  const offenders = [];

  for (const { label, raw, code } of rcmSources()) {
    for (const m of code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const target = m[1].toLowerCase();
      const isSeam = target.includes('odoffices') || target.includes('officeagents');
      const isWriter = target.includes('opendentalsync') || target.includes('odaccess');
      if (isWriter) offenders.push(`${label} → ${m[1]} (WRITE path)`);
      else if (isSeam && !MATCH_LAYER.has(label)) offenders.push(`${label} → ${m[1]} (outside the match layer)`);
    }
    // services/rcm/odClaimReads.js takes its transport as an ARGUMENT and must
    // never import a client itself — that is what keeps it pure enough to test
    // against a fake and unable to find a write verb.
    if (label === 'rcm/odClaimReads.js' && /require\(\s*['"][^'"]*od(Offices|Access)/i.test(raw)) {
      offenders.push(`${label} imports an OD client instead of taking odGet as an argument`);
    }
  }

  assert.deepEqual(offenders, [], `Open Dental imports out of place: ${offenders.join(', ')}`);
});

// ─── 4. Static — no write verb named anywhere ────────────────────────────────

test('no rcm source names an Open Dental write method', () => {
  /**
   * Method names that only appear when someone is writing to a chart. Every one
   * of these exists on the real client or its callers, so naming one is not a
   * typo — it is an intent.
   */
  const WRITE_SIGNALS = [
    'apiPost(',
    'apiPut(',
    'apiPatch(',
    'apiDelete(',
    'createCommlog(',
    'bookAppointment(',
    'updateAppointment(',
    'cancelAppointment(',
    "'/claimpayments'",
    'claimprocs/Supplemental',
    'documents/Upload',
  ];
  const offenders = [];

  for (const { label, code } of rcmSources()) {
    for (const signal of WRITE_SIGNALS) {
      if (code.includes(signal)) offenders.push(`${label} → ${signal}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'Slice 6a is READS ONLY. Chart writes are Slice 6c, behind an approval gate ' +
      'and the posting queue. Found: ' + offenders.join(', ')
  );
});

test('only the approval gate may write the posting queue', () => {
  /**
   * The queue is the record that a human authorised money to move. Exactly one
   * file may create one, for the same reason exactly two files may name an Open
   * Dental module: a second writer is a second policy, and the second one is
   * always the one nobody reviewed.
   */
  const APPROVAL_LAYER = new Set(['rcm/approvalGate.js']);
  const offenders = [];
  for (const { label, code } of rcmSources()) {
    if (!/INSERT INTO rcm_posting_queue|UPDATE rcm_posting_queue/i.test(code)) continue;
    if (!APPROVAL_LAYER.has(label)) offenders.push(label);
  }
  assert.deepEqual(
    offenders,
    [],
    'Enqueueing is the approval decision. A route that can write rcm_posting_queue ' +
      'without going through routes/rcm/approvalGate.js has shipped that decision ' +
      'without the gate. Found: ' + offenders.join(', ')
  );
});

test('the approval gate itself reaches no Open Dental module at all', () => {
  /*
   * The GRAPH test, not a grep. Approving is a decision about OUR rows: it
   * re-reads what a match already recorded and writes an intent. If it could
   * reach a chart it would be posting, one refactor away — and the whole shape
   * of 6b (approve now, post later, behind its own gated event) depends on the
   * two being separable.
   */
  const found = modulesReachableFrom('./approvalGate', [...OD_READ_SEAM, ...OD_WRITE_SURFACE]);
  assert.deepEqual(
    found,
    [],
    'the approval gate must not be able to touch Open Dental even to read it. Found: ' +
      found.join(', ')
  );
});

test('APPROVING creates queue rows and calls NOTHING on Open Dental', async () => {
  /*
   * THE CENTRAL CLAIM OF SLICE 6b, as a test.
   *
   * The approve path is driven to real success — rows land in
   * rcm_posting_queue and rcm_posting_queue_line with the intended per-line
   * amounts — and the Open Dental client, whose every verb throws, records that
   * not one method was called. Approving is not posting.
   */
  const db = seedProposal(new FakeRcmDb(), { approvable: true });
  const od = odFixture();
  const app = await bootRcmApp({ db, od });
  try {
    const res = await api(
      app.baseUrl,
      'POST',
      '/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/approve?office=roland',
      { body: JSON.stringify({}), json: true }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.queued.length, 1);

    // The durable intent exists…
    assert.equal(db.table('rcm_posting_queue').length, 1);
    const lines = db.table('rcm_posting_queue_line');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].od_claim_proc_num, 99001);
    assert.equal(lines[0].intended_ins_pay_amt_cents, 15000);

    // …and no chart was touched to create it. Not a write; not even a read.
    assert.deepEqual(od.methodsUsed(), []);
  } finally {
    await app.close();
  }
});
