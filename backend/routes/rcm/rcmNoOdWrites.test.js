'use strict';

/**
 * EXACTLY ONE FILE IN THE RCM MODULE MAY WRITE TO OPEN DENTAL — enforced, not
 * asserted in prose.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT SLICE 6c CHANGED — READ THIS FIRST
 * ═════════════════════════════════════════════════════════════════════════════
 * Through 6b this file proved a flat invariant: **no RCM source can reach an
 * Open Dental write verb.** 6c is the slice where posting arrives, so that
 * invariant had to either be deleted or defeated with an allow-list — and
 * deleting it is how a guard quietly stops guarding.
 *
 * It is REPLACED, by the same move 6b made for the posting queue and 6a made for
 * the read seam: an enumerated allow-list of ONE file, plus the behavioural
 * statements that make the list mean something.
 *
 *   `services/rcm/odPostingWrites.js` may name `apiWriteRaw` and the posting
 *   endpoints. Nothing else may. A second writer is a second policy about when
 *   money moves, and the second one is always the one nobody reviewed.
 *
 * The three statements that carry the weight:
 *
 *   1. **The old claim, unweakened.** Driving approve, match, review and every
 *      read route STILL yields `od.methodsUsed()` with no write verb in it. The
 *      surface that could never write still cannot.
 *   2. **The new claim, bounded.** Driving the DRAIN yields exactly the verbs the
 *      forced order uses — `PUT /claimprocs/{n}`, `PUT /claims/{n}`,
 *      `POST /claimpayments*` — in that order, and nothing else. Not "some
 *      writes happened": the exact sequence, so a fifth call added three files
 *      deep fails here rather than in a chart.
 *   3. **The graph, unchanged.** The extraction worker and the ERA parser still
 *      reach no Open Dental module at all, and the approval gate still reaches
 *      none either. Approving is still not posting.
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

const { FakeRcmDb, FakeOd, bootRcmApp, api, seedOfficeSettings } = require('./rcmTestUtils');

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

/**
 * THE ALLOW-LIST. One file, and this constant is the whole of it.
 *
 * `services/rcm/odPostingWrites.js` is the only RCM source that may name an Open
 * Dental write verb or a posting endpoint. Adding a second name here is a
 * deliberate act that shows up in a diff titled "another file can now write to a
 * patient's chart", which is exactly how large a decision that is.
 */
const OD_WRITE_LAYER = new Set(['rcm/odPostingWrites.js']);

test('only the match and posting layers name an Open Dental module, and only through the seam', () => {
  /**
   * Files allowed to name the per-office registry.
   *
   * `odPostingWrites.js` joins the match layer in 6c. It is the file that
   * resolves the office's own client for a WRITE, so it must call
   * `assertOfficeMatch(office, getOdOffice(office))` — and it can only do that by
   * naming the registry. It is on this list and on OD_WRITE_LAYER above; those
   * are two separate permissions and it needs both.
   */
  const MATCH_LAYER = new Set([
    'rcm/matchService.js',
    'rcm/claims.js',
    'rcm/odPostingWrites.js',
  ]);
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

test('only the one allow-listed file names an Open Dental write method', () => {
  /**
   * Method names and endpoints that only appear when someone is writing to a
   * chart. Every one of these exists on the real client or its callers, so
   * naming one is not a typo — it is an intent.
   */
  const WRITE_SIGNALS = [
    'apiWriteRaw',
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
    // 6d's two new verbs. They live in the allow-listed file like every other
    // write; naming one anywhere ELSE is what this list exists to catch.
    "'/adjustments'",
  ];
  const offenders = [];

  for (const { label, code } of rcmSources()) {
    if (OD_WRITE_LAYER.has(label)) continue;
    for (const signal of WRITE_SIGNALS) {
      if (code.includes(signal)) offenders.push(`${label} → ${signal}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'Exactly ONE file may reach an Open Dental write verb: ' +
      [...OD_WRITE_LAYER].join(', ') +
      '. Found: ' + offenders.join(', ')
  );
});

test('the allow-listed file is REAL, and it does not reach for the verbs 6c excluded', () => {
  /*
   * The allow-list is only a guarantee if the file it names actually exists and
   * actually holds the writes — a list pointing at a deleted file would pass the
   * test above trivially while the writes moved somewhere unwatched.
   *
   * The second half is the more interesting one. Three write paths are
   * DELIBERATELY out of scope for 6c and each is dangerous in its own way:
   *
   *   `claimprocs/Supplemental`  the recoupment path. A negative supplemental is
   *                              the ONE irreversible Open Dental operation (G10)
   *                              — it cannot be reverted, cannot be deleted, and
   *                              permanently pins its claim and procedure. 6d.
   *   `documents/Upload`         the EOB attach. 6d.
   *   `/payments`, `/paysplits`  the patient-portion flow. PRD-deferred, and
   *                              `ApiPayments` is not even enabled on this key
   *                              (G11).
   *
   * Naming any of them here would be building an unproven-for-this-slice path
   * behind a gate that was not designed for it.
   */
  const sources = rcmSources();
  const writer = sources.find((s) => OD_WRITE_LAYER.has(s.label));
  assert.ok(writer, `the allow-listed write layer ${[...OD_WRITE_LAYER]} is missing`);
  assert.ok(
    writer.code.includes('apiWriteRaw'),
    'the allow-listed file does not actually reach the transport — the writes moved somewhere else'
  );

  /*
   * 6d MOVED TWO OF THESE FROM "out of scope" TO "in scope, in this file".
   *
   * `claimprocs/Supplemental` and `documents/Upload` were on this list because
   * 6c refused a recoupment and left the EOB unfiled. 6d does both, behind a
   * typed confirmation and a posted-plan precondition respectively — so the
   * list shrinks to what genuinely remains unbuilt and un-entitled.
   *
   * PATIENT MONEY STAYS OFF IT, and not merely by policy: `ApiPayments` is not
   * enabled on this key at all (G11), so `/payments` and `/paysplits` are an
   * unproven path in the strongest sense — nothing has ever exercised them.
   */
  const outOfScope = [
    "'/payments'",
    "'/paysplits'",
  ].filter((signal) => writer.code.includes(signal));

  assert.deepEqual(
    outOfScope,
    [],
    'The patient-portion flow is PRD-deferred and the key is not entitled for it ' +
      '(G11). Found: ' + outOfScope.join(', ')
  );

  /*
   * AND THE THREE 6d VERBS REALLY ARE HERE. An allow-list is only a guarantee
   * if the file it names holds the writes — if these moved somewhere unwatched
   * the test above would pass trivially while the module grew a second writer.
   */
  for (const signal of ['/adjustments', 'claimprocs/Supplemental', 'documents/Upload']) {
    assert.ok(
      writer.code.includes(signal),
      `6d's ${signal} must live in the allow-listed write layer, not elsewhere`
    );
  }
});

test('only the approval gate may CREATE a posting plan, and only the drain may advance one', () => {
  /**
   * Two permissions, deliberately split — because they are two different powers
   * and 6c needs only the second.
   *
   * CREATE (`INSERT INTO rcm_posting_queue`) is the approval decision: a row
   * exists because a human authorised money to move. `rcm/approvalGate.js` and
   * nothing else, unchanged from 6b.
   *
   * ADVANCE (`UPDATE rcm_posting_queue`) is the execution record: which step, what
   * came back, how it ended. `services/rcm/postingDrain.js` and nothing else. The
   * drain must never be able to mint a plan — that would let it post money nobody
   * approved, which is the entire thing the gate exists to prevent — and the gate
   * must never be able to move one past `approved`.
   */
  const CREATE_LAYER = new Set(['rcm/approvalGate.js']);
  const ADVANCE_LAYER = new Set(['rcm/postingDrain.js']);
  const offenders = [];
  for (const { label, code } of rcmSources()) {
    if (/INSERT INTO rcm_posting_queue/i.test(code) && !CREATE_LAYER.has(label)) {
      offenders.push(`${label} CREATES a posting plan`);
    }
    if (/UPDATE rcm_posting_queue/i.test(code) && !ADVANCE_LAYER.has(label) && !CREATE_LAYER.has(label)) {
      offenders.push(`${label} ADVANCES a posting plan`);
    }
    if (/INSERT INTO rcm_posting_queue/i.test(code) && ADVANCE_LAYER.has(label)) {
      offenders.push(`${label} can MINT a plan — the drain must only ever execute one`);
    }
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

// ─── 5. The behavioural INVERSE — what the drain does, exactly ───────────────

/**
 * An approved posting plan over the seeded proposal, in the shape 6b's gate
 * writes it.
 *
 * Separate from `seedProposal({ approvable: true })` because that helper
 * produces a plan that COULD be approved; this one has been.
 */
function seedApprovedPlan(db) {
  seedProposal(db, { approvable: true });
  // The shadow gate, OPEN. This suite's claim is about which Open Dental verbs
  // a drain emits, so the gate that decides whether it drains at all has to be
  // out of the way — and saying so here is what keeps "the drain wrote nothing"
  // from silently becoming "the drain never ran".
  seedOfficeSettings(db, { roland: true, valley: true });
  db.seed('rcm_posting_queue', [
    {
      queue_id: '11111111-2222-4333-8444-555555555555',
      office_id: 'roland',
      batch_id: '8acb0e32-35ae-5cd8-9692-7b5e318a31c2',
      remittance_key: 'roland:830200001',
      status: 'approved',
      is_recoupment: false,
      carrier_eob_date: '2026-03-01',
      intended_total_cents: 15000,
      posted_total_cents: 0,
      od_claim_payment_num: null,
      approved_by: 'user-1',
      approved_at: new Date('2026-03-02T11:10:00Z'),
      started_at: null,
      finished_at: null,
      attempt_count: 0,
      last_error: null,
      blocked_reason: null,
      drain_step: null,
      drained_by: null,
      drain_attempt_at: null,
      reconciled_at: null,
    },
  ]);
  db.seed('rcm_posting_queue_line', [
    {
      queue_line_id: '66666666-7777-4888-8999-000000000000',
      queue_id: '11111111-2222-4333-8444-555555555555',
      office_id: 'roland',
      position: 1,
      od_claim_proc_num: 99001,
      od_claim_num: 53648,
      claim_id: 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d',
      batch_claim_payment_id: 'e9247d49-d687-56bc-ba36-ebbf4f05b56c',
      intended_ins_pay_amt_cents: 15000,
      intended_write_off_cents: 6000,
      intended_ded_applied_cents: 0,
      is_supplemental: false,
      status: 'pending',
      claimproc_written_at: null,
      claim_received_at: null,
      paid_at: null,
      od_claim_payment_num: null,
      last_error: null,
      readback: null,
      readback_at: null,
      skip_reason: null,
    },
  ]);
  const claim = db.table('rcm_claims')[0];
  claim.posting_queue_id = '11111111-2222-4333-8444-555555555555';
  claim.approved_at = new Date('2026-03-02T11:10:00Z');
  claim.approved_by = 'user-1';
  const batch = db.table('rcm_payment_batches')[0];
  batch.payment_method = 'check';
  batch.deposit_date = '2026-03-01';
  batch.eft_number = null;
  return db;
}

/**
 * The same recorded-shape Open Dental as the read tests, made WRITABLE and given
 * Roland's real Category-32 rows so the per-office registry can resolve.
 */
function writableOdFixture() {
  const od = odFixture();
  od.writable = true;
  od.rows.definitions = [
    { DefNum: 296, Category: 32, ItemName: 'Check', isHidden: 'false' },
    { DefNum: 472, Category: 32, ItemName: 'Insurance Check', isHidden: 'false' },
    { DefNum: 12, Category: 1, ItemName: 'Insurance Write-off', ItemValue: '-', isHidden: 'false' },
    { DefNum: 131, Category: 18, ItemName: 'Insurance', isHidden: 'false' },
  ];
  od.rows.preferences = [
    { PrefName: 'ClaimPaymentBatchOnly', ValueString: '0' },
    { PrefName: 'ShowAutoDeposit', ValueString: '0' },
  ];
  od.rows.claims[0].ClaimNote = '';
  od.rows.claims[0].DateReceived = '0001-01-01';
  // `writable` is read in the constructor, so the method is re-bound here.
  od.client.apiWriteRaw = (method, path, body, opts) => od.write(method, path, body, opts);
  return od;
}

test('DRIVING THE DRAIN emits exactly the forced order, in order, and nothing else', async () => {
  /*
   * THE NEW CLAIM, BOUNDED.
   *
   * Not "some writes happened" — the exact sequence RCM_OD_WRITES section 8
   * forces:
   *
   *     per line   PUT  /claimprocs/{n}
   *     per claim  PUT  /claims/{n}
   *     per check  POST /claimpayments
   *
   * A fifth call added three files deep fails HERE rather than in a patient's
   * chart. `POST /claimprocs/Supplemental` and `POST /documents/Upload` are 6d's,
   * and their absence from this list is the assertion that they are not built.
   */
  const db = seedApprovedPlan(new FakeRcmDb());
  const od = writableOdFixture();
  const app = await bootRcmApp({ db, od });
  try {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/posting/drain?office=roland', {
      body: JSON.stringify({}),
      json: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.outcomes[0].status, 'posted', JSON.stringify(res.body.outcomes[0]));

    assert.deepEqual(od.writesIssued(), [
      'PUT /claimprocs/99001',
      'PUT /claims/53648',
      'POST /claimpayments',
    ]);

    // And the only two client methods used at all are the read and the write —
    // no legacy verb, no commlog writer, nothing from the voice module.
    assert.deepEqual(od.methodsUsed().sort(), ['apiGetRaw', 'apiWriteRaw']);
  } finally {
    await app.close();
  }
});

test('the READ surface still reaches no write verb, with the drain mounted alongside it', async () => {
  /*
   * THE OLD CLAIM, UNWEAKENED.
   *
   * The whole point of an allow-list is that adding one writer does not widen
   * anything else. This is the same drive as the first test in this file, run
   * against a plan that IS drainable and a client that CAN write — so a route
   * that started posting as a side effect of a read would show up here.
   */
  const db = seedApprovedPlan(new FakeRcmDb());
  const od = writableOdFixture();
  const app = await bootRcmApp({ db, od });
  try {
    const q = '?office=roland';
    await api(app.baseUrl, 'GET', `/api/rcm/remittances${q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2${q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d${q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/remittances/8acb0e32-35ae-5cd8-9692-7b5e318a31c2/approval${q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/posting/queue${q}`);
    await api(app.baseUrl, 'GET', `/api/rcm/posting/queue/11111111-2222-4333-8444-555555555555${q}`);
    await api(app.baseUrl, 'POST', `/api/rcm/claims/d1e2b359-a8d7-51a8-978c-7adf27bccc8d/review${q}`, {
      body: JSON.stringify({ note: 'checked' }),
      json: true,
    });

    assert.deepEqual(
      od.methodsUsed().filter((m) => m !== 'apiGetRaw'),
      [],
      'reading the queue, the workbench and the checklist must reach no write verb'
    );
  } finally {
    await app.close();
  }
});

test('the drain reaches Open Dental through the per-office registry; approve still reaches nothing', () => {
  /*
   * The GRAPH statement, updated for 6c.
   *
   * `routes/rcm/posting.js` is ALLOWED to reach the write layer — that is what it
   * is for — but it must do so through `config/odOffices`, never through
   * `services/openDentalSync` (the voice commlog writer) or `platform/odAccess`
   * (the TENANT-level seam bound to one configured client, which would write
   * Roland's database under a valley selector).
   *
   * And `routes/rcm/approvalGate.js` still reaches no Open Dental module at all,
   * so "approving is not posting" survives 6c as a require-graph fact rather than
   * as a sentence in a header.
   */
  const fromApprove = modulesReachableFrom('./approvalGate', [...OD_READ_SEAM, ...OD_WRITE_SURFACE]);
  assert.deepEqual(
    fromApprove,
    [],
    'the approval gate must not be able to touch Open Dental even to read it. Found: ' +
      fromApprove.join(', ')
  );

  const fromDrain = modulesReachableFrom('./posting', OD_WRITE_SURFACE);
  assert.deepEqual(
    fromDrain,
    [],
    'the drain must write through config/odOffices. Found: ' + fromDrain.join(', ')
  );
});

test('a NAMED allow-list of operational scripts may reach an OD write, and they are not module code', () => {
  /*
   * THE EVASION PATH THIS CLOSES.
   *
   * Every guard above scans `services/rcm` and `routes/rcm`. `backend/scripts/`
   * is neither, so a file moved there could reach a chart without appearing in
   * any of them — and "put it in scripts/" is exactly the shape a future
   * shortcut takes.
   *
   * A small, NAMED set of operational scripts legitimately lives there. They are
   * checked in rather than pasted from a scratchpad so the thing that gets run is
   * the thing that got reviewed. Anything ELSE under scripts/ that names an Open
   * Dental write is a module trying to escape the allow-list.
   */
  const scriptsDir = path.join(__dirname, '../../scripts');
  /*
   * FIVE FILES, EACH FOR A NAMED REASON. Adding a sixth is a review decision.
   *
   *   rcm-d7-write-probe.js  D-7's write-verb entitlement check (RCM_POSTING §9a).
   *   rcm-d7-read-sweep.js   the read sweep that proves it landed nothing.
   *   rcm-s10-prep.js        §10.1 — creates the two disposable $1.00 targets on
   *                          the designated test patient. POST only.
   *   rcm-s11-unwind.js      §11 — the ONLY file anywhere in this repo that may
   *                          name DELETE against Open Dental. The block below
   *                          pins the properties that keep it narrow.
   *   rcm/reseed-prep.js     §10.8 — creates the seven disposable claims the
   *                          staging reseed's four 835s pay. POST only.
   *
   * Deliberately NOT here: `rcm-s10-inventory.js`, `rcm-s10-835.js`,
   * `rcm/reseed-835.js`, `rcm/reseed-targets.js` and
   * `rcm/reset-staging-fixtures.js`. They belong to the same operations and they
   * name no write verb, so they are scanned like any other script. An allow-list
   * that covered a whole feature rather than the files that actually need it
   * would be the escape hatch this test exists to close.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THE NAMES ARE PATHS RELATIVE TO `scripts/`, BECAUSE THE SCAN NOW RECURSES
   * ─────────────────────────────────────────────────────────────────────────
   * This was one `readdirSync` over `scripts/` matched against bare basenames,
   * which made any SUBDIRECTORY invisible to it: a file under `scripts/rcm/`
   * could have named `apiWriteRaw` and no guard in this file would have looked.
   * "Put it in scripts/" is the shape this test exists to close, and "put it in
   * scripts/anything/" was a strictly easier version of the same move.
   *
   * Found when `scripts/rcm/` was created for the staging reseed (2026-09-01).
   * Nothing had exploited it — no subdirectory existed until then — but the hole
   * was real for as long as the scan was one level deep, and a guard that only
   * works while nobody makes a folder is not a guard.
   */
  const ALLOWED = new Set([
    'rcm-d7-write-probe.js',
    'rcm-d7-read-sweep.js',
    'rcm-s10-prep.js',
    'rcm-s11-unwind.js',
    'rcm/reseed-prep.js',
  ]);

  const WRITE_SIGNALS = [
    'apiWriteRaw',
    'client.post(',
    'client.put(',
    'axios.post(',
    'axios.put(',
    "'/claimpayments'",
    'claimprocs/Supplemental',
    'documents/Upload',
    /*
     * DELETE, added with the §11 unwind.
     *
     * The transport has no delete verb at all — `apiWriteRaw` is POST/PUT only,
     * deliberately — so until §11 nothing under scripts/ could name one and the
     * scan did not look. It looks now: `rcm-s11-unwind.js` reaches the raw axios
     * instance to issue DELETE, which is exactly the shape a second, unreviewed
     * deleter would take. Bare `.delete(` is NOT a signal — `Map` and `Set` use
     * it — so the two client-shaped spellings are named instead.
     */
    'axios.delete(',
    'client.delete(',
  ];

  /**
   * Every `.js`/`.cjs` under `scripts/`, AT ANY DEPTH, as a path relative to it
   * and with forward slashes so the allow-list reads the same on every platform.
   *
   * `node_modules` is skipped because a scripts folder that ever grows one would
   * otherwise make this test scan a few thousand third-party files and fail on
   * somebody else's `axios.post(`.
   *
   * @param {string} dir @param {string} prefix @returns {string[]}
   */
  const scriptFiles = (dir, prefix = '') => {
    /** @type {string[]} */
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...scriptFiles(path.join(dir, entry.name), rel));
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) out.push(rel);
    }
    return out;
  };

  const offenders = [];
  /** Scripts that DO name a write verb — allowed or not — must not self-execute. */
  const unguarded = [];
  const scanned = scriptFiles(scriptsDir);
  for (const name of scanned) {
    const code = fs
      .readFileSync(path.join(scriptsDir, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const namesAWrite = WRITE_SIGNALS.some((signal) => code.includes(signal));
    if (namesAWrite && !/require\.main\s*===\s*module/.test(code)) {
      unguarded.push(`scripts/${name}`);
    }
    if (ALLOWED.has(name)) continue;
    for (const signal of WRITE_SIGNALS) {
      if (code.includes(signal)) offenders.push(`scripts/${name} → ${signal}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a script that writes to Open Dental is module code in the wrong folder. Found: ' +
      offenders.join(', ')
  );

  /*
   * AND A SCRIPT THAT NAMES A WRITE MUST NOT RUN ON IMPORT.
   *
   * The scan above asks WHICH files may name a write verb. It cannot ask when
   * those verbs FIRE, and on 2026-08-24 that gap was live: the read sweep
   * imported the write probe for its shared ghost id, the probe called `main()`
   * at module load, and so a script named "read sweep" re-issued every write
   * verb — invisibly to this guard, because the verbs sat in the one file that
   * is allowed to name them.
   *
   * Requiring a file must not be enough to make it write to a chart. Both D-7
   * scripts now guard `main()`, and share the ghost id through a one-constant
   * module that requires nothing, so no file's import can run anything.
   * `test/rcmD7ProbeScripts.test.js` proves the behaviour; this is the static
   * rule that keeps a third script from reopening the hole.
   */
  assert.deepEqual(
    unguarded,
    [],
    'a script that names an Open Dental write verb must guard main() behind ' +
      '`require.main === module`, or requiring it writes to a chart. Found: ' +
      unguarded.join(', ')
  );

  // And every file that IS allowed really is there — an allow-list pointing at
  // deleted files passes vacuously.
  for (const name of ALLOWED) {
    assert.ok(fs.existsSync(path.join(scriptsDir, name)), `scripts/${name} is missing`);
  }

  /*
   * AND THE SCAN REALLY DID GO DOWN A LEVEL.
   *
   * The recursion is the whole fix, and a `scriptFiles` that quietly stopped
   * recursing would leave every assertion above passing over a smaller set —
   * which is exactly the failure mode the one-level scan already had. So the
   * scan must be able to point at a file it could not have seen before.
   */
  assert.ok(
    scanned.some((n) => n.includes('/')),
    'the scan must reach files in subdirectories of scripts/, or the allow-list is bypassable ' +
      'by making a folder'
  );
  assert.ok(scanned.includes('rcm/reseed-prep.js'), 'the reseed prep must be among the scanned files');
});

test('the D-7 write probe cannot run without GET-checking its targets first', () => {
  /*
   * The probe's whole claim to being zero-risk is that it writes only to ids it
   * has just proven do not exist, and ABORTS if any of them does. That is a
   * property of a script nothing else tests, against a live practice database.
   */
  const src = fs.readFileSync(
    path.join(__dirname, '../../scripts/rcm-d7-write-probe.js'),
    'utf8'
  );
  assert.match(src, /precheck GET/, 'the probe must GET-check its targets');
  assert.match(src, /ABORTING — a probe target exists/, 'and abort if one exists');
  // POST and PUT only. A DELETE against a live practice database is not a probe.
  assert.ok(!/axios\.delete|\.delete\(/.test(src), 'the probe must never issue a DELETE');
  // The precheck must come BEFORE the first write in the file, not after it.
  assert.ok(
    src.indexOf('ABORTING') < src.indexOf('async function probe'),
    'the abort path must precede the write helper'
  );
});
