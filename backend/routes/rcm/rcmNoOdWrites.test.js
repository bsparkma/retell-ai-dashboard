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

/** A proposal claim on a batch, seeded straight into the fake tenant DB. */
function seedProposal(db) {
  db.seed('rcm_payment_batches', [
    {
      batch_id: 'b-1',
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
      claim_id: 'c-1',
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
    { batch_claim_payment_id: 'l-1', batch_id: 'b-1', claim_id: 'c-1', office_id: 'roland', position: 1 },
  ]);
  db.seed('rcm_procedure_lines', [
    {
      line_id: 'pl-1',
      claim_id: 'c-1',
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
      upload_id: 'u-1',
      office_id: 'roland',
      filename: 'delta_fixture.edi',
      file_key: 'tenant/carein/rcm/era/k1.edi',
      file_url: '',
      status: 'extracted',
      uploaded_at: new Date('2026-03-02T10:00:00Z'),
      uploaded_by: null,
    },
  ]);
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
    await api(app.baseUrl, 'GET', `/api/rcm/remittances/b-1${q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/claims/c-1${q}`);

    const matched = await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/match${q}`, {
      body: JSON.stringify({}),
      json: true,
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));

    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/confirm-match${q}`, {
      body: JSON.stringify({ odClaimNum: 53648 }),
      json: true,
    });
    await api(app.baseUrl, 'POST', `/api/rcm/claims/c-1/review${q}`, {
      body: JSON.stringify({ note: 'checked' }),
      json: true,
    });

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
    const res = await api(app.baseUrl, 'POST', '/api/rcm/remittances/b-1/match?office=roland', {
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

test('no rcm source touches the posting queue — approval and posting are 6b/6c', () => {
  const offenders = [];
  for (const { label, code } of rcmSources()) {
    if (/INSERT INTO rcm_posting_queue|UPDATE rcm_posting_queue/i.test(code)) {
      offenders.push(label);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'rcm_posting_queue is Slice 6b/6c. A workbench that could enqueue would ship ' +
      'the approval decision without the approval gate. Found: ' + offenders.join(', ')
  );
});
