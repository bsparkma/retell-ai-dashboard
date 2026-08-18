'use strict';

/**
 * /api/rcm entitlement + fail-closed behavior.
 *
 * The three-step ladder this slice exists to prove:
 *   anonymous            → 401 (auth gate)
 *   authenticated, no rcm→ 403 MODULE_NOT_ENTITLED
 *   entitled             → 200 with the documented shape
 *
 * Plus a source scan of server.js so the mount cannot lose its guards, and the
 * office-scoping proof on both endpoints.
 *
 * Every request here goes through the FULLY-ASSEMBLED chain in
 * rcmTestUtils.bootRcmApp — real auth gate, real tenantContext, real
 * requireModule, real requireReadWrite, real routes/rcm/index.js. See
 * rcmMountOrder.test.js for why that matters.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { bootRcmApp, api, auditRows } = require('./rcmTestUtils');

// --- source scan ------------------------------------------------------------

const serverSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

test('server.js mounts /api/rcm exactly once, with the module + permission guards', () => {
  const mounts = serverSrc.match(/app\.use\(\s*'\/api\/rcm'[\s\S]*?\);/g) || [];
  assert.equal(mounts.length, 1, `expected exactly one /api/rcm mount, got ${mounts.length}`);
  assert.match(mounts[0], /requireModule\('rcm'\)/, 'the /api/rcm mount must carry requireModule(rcm)');
  assert.match(
    mounts[0],
    /requireReadWrite\('rcm\.read', 'rcm\.write'/,
    "the /api/rcm mount must gate reads and writes separately, so the module's first " +
      'mutation demands rcm.write instead of inheriting read permission'
  );
  // The queue tier's exceptions must come from the MODULE, not be spelled out
  // here: a list written at the mount is a list nobody maintains beside the
  // routes it exempts.
  assert.match(
    mounts[0],
    /writeExempt: rcmRouter\.QUEUE_PATHS/,
    "the queue-tier exemptions must be the router's own exported list, and must " +
      'skip only the WRITE gate — a GET at one of those paths still needs rcm.read'
  );
});

// --- the queue tier (D-9) ---------------------------------------------------

/**
 * Every route the RCM router actually mounts, with the permission actions its
 * own middleware names.
 *
 * WALKED, not hand-listed. The previous version of this checked three paths it
 * had been told about by looking for an exact source substring, which failed in
 * both directions: a fourth `QUEUE_PATHS` regex covering an UNGATED route would
 * have passed, and reformatting a gated one would have broken it. What the
 * exemption actually opens is a question about the assembled router, so it is
 * asked of the assembled router.
 *
 * Express keeps the mount path only as a compiled regexp, so it is decoded back
 * — `^\/claims\/?(?=\/|$)` → `/claims`.
 */
function routeTable(router, prefix = '') {
  /** @type {Array<{ method: string, path: string, actions: string[] }>} */
  const out = [];
  for (const layer of router.stack || []) {
    if (layer.route) {
      const actions = layer.route.stack
        .map((l) => l.handle && l.handle.permissionAction)
        .filter(Boolean);
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: prefix + layer.route.path, actions });
      }
      continue;
    }
    if (layer.handle && Array.isArray(layer.handle.stack)) {
      const mount = (layer.regexp ? layer.regexp.source : '')
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
        .replace(/\\\//g, '/');
      out.push(...routeTable(layer.handle, prefix + mount));
    }
  }
  return out;
}

/** Would express route this method+path here? Path patterns use :params. */
function concrete(path) {
  return path.replace(/:[^/]+/g, 'x');
}

test('every path the queue exemption opens is gated on rcm.queue', () => {
  /*
   * `writeExempt` skips the mount's rcm.write gate for these paths, so a route
   * matching one with no gate of its own is reachable by anyone the module
   * guard let through. The exemption and the gates have to agree, in both
   * directions.
   */
  const { QUEUE_PATHS } = require('./index');
  const routes = routeTable(require('./index'));
  assert.ok(routes.length > 5, `expected the router to expose its routes, got ${routes.length}`);

  for (const rx of QUEUE_PATHS) {
    const matched = routes.filter((r) => rx.test(concrete(r.path)));
    assert.ok(
      matched.length > 0,
      `${rx} matches no route in this module — a stale exemption is a hole waiting for a route`
    );
    for (const r of matched) {
      assert.ok(
        r.actions.includes('rcm.queue'),
        `${r.method} ${r.path} is exempted from the write gate but carries no rcm.queue gate ` +
          `(actions: ${r.actions.join(', ') || 'none'})`
      );
    }
  }
});

test('no GET is reachable through the queue exemption', () => {
  /*
   * The exemption is matched on PATH, not on method. `writeExempt` is what
   * keeps a future `GET /claims/:id/match` behind `rcm.read` rather than behind
   * nothing — this asserts the second half: that no such GET exists today, so
   * the pairing cannot rot unnoticed.
   */
  const { QUEUE_PATHS } = require('./index');
  for (const r of routeTable(require('./index'))) {
    if (r.method !== 'GET' && r.method !== 'HEAD') continue;
    for (const rx of QUEUE_PATHS) {
      assert.ok(
        !rx.test(concrete(r.path)),
        `${r.method} ${r.path} matches the queue exemption ${rx} — it would bypass its tier`
      );
    }
  }
});

test('confirm-match is NOT exempt — it stays on rcm.write', () => {
  const { QUEUE_PATHS } = require('./index');
  assert.ok(
    !QUEUE_PATHS.some((rx) => rx.test('/claims/x/confirm-match')),
    'confirming writes od_claim_num, the column Slice 6c reads to pick a chart'
  );
});

test('a role holding neither tier is refused the batch match at runtime', async () => {
  // The guard above is structural. This is the same claim made by a request:
  // `tc` holds no rcm action at all, and POST /remittances/:id/match is
  // exempted from the mount's write gate — so if its own gate ever went
  // missing, only this would notice.
  const { baseUrl, close } = await bootRcmApp({ role: 'tc' });
  try {
    const res = await api(baseUrl, 'POST', '/api/rcm/remittances/b-1/match?office=roland', {
      body: JSON.stringify({}),
      json: true,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
    assert.equal(res.body.action, 'rcm.queue');
  } finally {
    await close();
  }
});

// --- the ladder -------------------------------------------------------------

test('anonymous request → 401 (never reaches the module guard)', async () => {
  const { baseUrl, close } = await bootRcmApp({ user: null });
  try {
    for (const p of ['/api/rcm/summary?office=roland', '/api/rcm/claims?office=roland']) {
      const res = await api(baseUrl, 'GET', p, { anon: true });
      assert.equal(res.status, 401, `${p} must 401 without credentials`);
    }
  } finally {
    await close();
  }
});

test('authenticated but tenant not entitled to rcm → 403 MODULE_NOT_ENTITLED', async () => {
  const { baseUrl, close } = await bootRcmApp({ modules: ['voice', 'tc'] });
  try {
    for (const p of ['/api/rcm/summary?office=roland', '/api/rcm/claims?office=roland']) {
      const res = await api(baseUrl, 'GET', p);
      assert.equal(res.status, 403, `${p} must 403 for an unentitled tenant`);
      // The code lives in `error`, not `code` — the platform's existing shape.
      assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
      assert.equal(res.body.module, 'rcm');
      assert.equal(res.body.success, false);
    }
  } finally {
    await close();
  }
});

test('no tenant context → 403 (fail closed, not 500, not pass-through)', async () => {
  // Authenticated by the shared bearer, but carrying no user identity, so
  // tenantContext cannot resolve a tenant.
  const { baseUrl, close } = await bootRcmApp({ user: null });
  try {
    const res = await api(baseUrl, 'GET', '/api/rcm/summary?office=roland');
    assert.equal(res.status, 403);
    assert.equal(res.body.success, false);
  } finally {
    await close();
  }
});

test('entitled tenant, role without rcm.read (tc) → 403 FORBIDDEN', async () => {
  // Entitlement is the practice; permission is the person. A treatment
  // coordinator's practice may own RCM without the coordinator holding it.
  const { baseUrl, close } = await bootRcmApp({ role: 'tc' });
  try {
    const res = await api(baseUrl, 'GET', '/api/rcm/summary?office=roland');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
    assert.equal(res.body.action, 'rcm.read');
  } finally {
    await close();
  }
});

// --- shape ------------------------------------------------------------------

test('entitled → 200, summary is zero-filled over the whole status vocabulary', async () => {
  const { baseUrl, close } = await bootRcmApp();
  try {
    const res = await api(baseUrl, 'GET', '/api/rcm/summary?office=roland');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.office, 'roland');

    // An empty office answers with measured zeros, not an empty object.
    assert.deepEqual(res.body.claims, {
      byStatus: { posted: 0, pending_review: 0, processing: 0, error: 0, matched: 0 },
      total: 0,
    });
    assert.deepEqual(res.body.batches.byStatus, {
      open: 0,
      ready: 0,
      posting: 0,
      balanced: 0,
      unbalanced: 0,
      posted: 0,
      error: 0,
    });
    assert.deepEqual(res.body.queue, {
      byStatus: { approved: 0, posting: 0, posted: 0, failed: 0, partially_posted: 0 },
      total: 0,
      depth: 0,
    });
  } finally {
    await close();
  }
});

test('summary counts real rows, and queue depth excludes the terminal states', async () => {
  const { baseUrl, db, close } = await bootRcmApp();
  db.seed('rcm_claims', [
    { office_id: 'roland', status: 'posted' },
    { office_id: 'roland', status: 'posted' },
    { office_id: 'roland', status: 'pending_review' },
    // Archived is out of the working set — excluded from the count.
    { office_id: 'roland', status: 'error', archived_at: new Date() },
  ]);
  db.seed('rcm_payment_batches', [{ office_id: 'roland', status: 'open' }]);
  db.seed('rcm_posting_queue', [
    { office_id: 'roland', status: 'approved' },
    { office_id: 'roland', status: 'partially_posted' },
    { office_id: 'roland', status: 'posted' }, // terminal — not depth
    { office_id: 'roland', status: 'failed' }, // terminal — not depth
  ]);

  try {
    const res = await api(baseUrl, 'GET', '/api/rcm/summary?office=roland');
    assert.equal(res.status, 200);
    assert.equal(res.body.claims.byStatus.posted, 2);
    assert.equal(res.body.claims.byStatus.pending_review, 1);
    assert.equal(res.body.claims.byStatus.error, 0, 'archived claims must not be counted');
    assert.equal(res.body.claims.total, 3);
    assert.equal(res.body.batches.byStatus.open, 1);
    assert.equal(res.body.queue.total, 4);
    assert.equal(res.body.queue.depth, 2, 'depth counts only work still owed');
  } finally {
    await close();
  }
});

test('claims list returns the documented wire shape, newest first', async () => {
  const { baseUrl, db, close } = await bootRcmApp();
  db.seed('rcm_claims', [
    {
      claim_id: 'c-old',
      office_id: 'roland',
      claim_number: 'CLM-1',
      check_number: '',
      patient_name: 'Test, MangoTest',
      od_patient_id: '12828',
      payer: 'Delta',
      service_date: '2026-07-01',
      received_date: '2026-07-10',
      status: 'posted',
      payment_status: 'paid',
      insurance_type: 'primary',
      total_billed_cents: '20000',
      total_paid_cents: '15000',
      patient_balance_cents: '5000',
      needs_review_reasons: [],
    },
    {
      claim_id: 'c-new',
      office_id: 'roland',
      claim_number: 'CLM-2',
      check_number: '9981',
      patient_name: 'Test 2, Stedi',
      od_patient_id: null,
      payer: 'BCBS',
      service_date: '2026-08-01',
      received_date: '2026-08-09',
      status: 'pending_review',
      payment_status: 'unpaid',
      insurance_type: 'secondary',
      total_billed_cents: '30000',
      total_paid_cents: '0',
      patient_balance_cents: '0',
      needs_review_reasons: ['missing_procedure_code'],
    },
  ]);

  try {
    const res = await api(baseUrl, 'GET', '/api/rcm/claims?office=roland');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.limit, 50);
    assert.equal(res.body.offset, 0);
    assert.equal(res.body.claims.length, 2);

    // Newest received_date first.
    assert.equal(res.body.claims[0].claimId, 'c-new');
    assert.deepEqual(res.body.claims[0], {
      claimId: 'c-new',
      officeId: 'roland',
      claimNumber: 'CLM-2',
      checkNumber: '9981',
      patientName: 'Test 2, Stedi',
      odPatientId: null,
      payer: 'BCBS',
      serviceDate: '2026-08-01',
      receivedDate: '2026-08-09',
      status: 'pending_review',
      paymentStatus: 'unpaid',
      insuranceType: 'secondary',
      totalBilledCents: 30000,
      totalPaidCents: 0,
      patientBalanceCents: 0,
      needsReviewReasons: ['missing_procedure_code'],
      createdAt: res.body.claims[0].createdAt,
    });
    // pg hands bigints back as strings; the wire shape must be numbers.
    assert.equal(typeof res.body.claims[1].odPatientId, 'number');
    assert.equal(res.body.claims[1].odPatientId, 12828);
    // An empty check_number is normalized to null rather than ''.
    assert.equal(res.body.claims[1].checkNumber, null);
  } finally {
    await close();
  }
});

test('claims list paginates, and an unusable limit falls back to the default', async () => {
  const { baseUrl, db, close } = await bootRcmApp();
  db.seed(
    'rcm_claims',
    Array.from({ length: 5 }, (_, i) => ({
      claim_id: `c-${i}`,
      office_id: 'roland',
      claim_number: `CLM-${i}`,
      patient_name: 'Test, MangoTest',
      payer: 'Delta',
      received_date: `2026-08-0${i + 1}`,
      status: 'posted',
      payment_status: 'paid',
      insurance_type: 'primary',
      needs_review_reasons: [],
    }))
  );

  try {
    const page = await api(baseUrl, 'GET', '/api/rcm/claims?office=roland&limit=2&offset=2');
    assert.equal(page.status, 200);
    assert.equal(page.body.claims.length, 2);
    assert.equal(page.body.total, 5, 'total is the whole filtered set, not the page');
    assert.equal(page.body.limit, 2);
    assert.equal(page.body.offset, 2);

    const junk = await api(baseUrl, 'GET', '/api/rcm/claims?office=roland&limit=banana');
    assert.equal(junk.status, 200, 'a bad limit renders a page, it does not 400');
    assert.equal(junk.body.limit, 50);

    const huge = await api(baseUrl, 'GET', '/api/rcm/claims?office=roland&limit=99999');
    assert.equal(huge.body.limit, 200, 'limit is capped at MAX_LIMIT');
  } finally {
    await close();
  }
});

test('claims list filters on a known status and ignores an unknown one', async () => {
  const { baseUrl, db, close } = await bootRcmApp();
  db.seed('rcm_claims', [
    { claim_id: 'a', office_id: 'roland', status: 'posted', needs_review_reasons: [] },
    { claim_id: 'b', office_id: 'roland', status: 'error', needs_review_reasons: [] },
  ]);
  try {
    const filtered = await api(baseUrl, 'GET', '/api/rcm/claims?office=roland&status=error');
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.claims[0].claimId, 'b');

    const bogus = await api(baseUrl, 'GET', '/api/rcm/claims?office=roland&status=quantum');
    assert.equal(bogus.body.total, 2, 'an unknown status is dropped, not passed to the query');
  } finally {
    await close();
  }
});

// --- office scoping ---------------------------------------------------------

test('office scoping: a valley row is unreachable from a roland context (both endpoints)', async () => {
  const { baseUrl, db, close } = await bootRcmApp();
  db.seed('rcm_claims', [
    { claim_id: 'r1', office_id: 'roland', status: 'posted', needs_review_reasons: [] },
    { claim_id: 'v1', office_id: 'valley', status: 'posted', needs_review_reasons: [] },
    { claim_id: 'v2', office_id: 'valley', status: 'error', needs_review_reasons: [] },
  ]);
  db.seed('rcm_posting_queue', [
    { office_id: 'valley', status: 'approved' },
    { office_id: 'valley', status: 'approved' },
  ]);

  try {
    const rolandClaims = await api(baseUrl, 'GET', '/api/rcm/claims?office=roland');
    assert.equal(rolandClaims.body.total, 1);
    assert.deepEqual(
      rolandClaims.body.claims.map((c) => c.claimId),
      ['r1']
    );

    const rolandSummary = await api(baseUrl, 'GET', '/api/rcm/summary?office=roland');
    assert.equal(rolandSummary.body.claims.total, 1);
    assert.equal(rolandSummary.body.queue.depth, 0, "valley's queue must not show in roland");

    const valleySummary = await api(baseUrl, 'GET', '/api/rcm/summary?office=valley');
    assert.equal(valleySummary.body.claims.total, 2);
    assert.equal(valleySummary.body.queue.depth, 2);
  } finally {
    await close();
  }
});

test('every office_id filter reaches the database as a bound parameter', async () => {
  const { baseUrl, db, close } = await bootRcmApp();
  try {
    await api(baseUrl, 'GET', '/api/rcm/claims?office=valley');
    const selects = db.log.filter((q) => /FROM rcm_claims/.test(q.sql));
    assert.ok(selects.length >= 2, 'expected the page query and the count query');
    for (const q of selects) {
      assert.match(q.sql, /WHERE office_id = \$1/, `office must be parameterized: ${q.sql}`);
      assert.equal(q.params[0], 'valley');
      assert.doesNotMatch(q.sql, /SELECT \*/, 'no SELECT * anywhere');
    }
  } finally {
    await close();
  }
});

// --- audit ------------------------------------------------------------------

test('both reads write an audit row stamped with the office', async () => {
  const { baseUrl, db, close } = await bootRcmApp();
  try {
    await api(baseUrl, 'GET', '/api/rcm/summary?office=roland');
    await api(baseUrl, 'GET', '/api/rcm/claims?office=valley');

    const rows = auditRows(db);
    assert.equal(rows.length, 2);
    const summaryRow = rows.find((r) => r.resource_type === 'rcm_summary');
    const claimRow = rows.find((r) => r.resource_type === 'rcm_claim');
    assert.ok(summaryRow && claimRow, 'both reads must be audited');
    assert.equal(summaryRow.office, 'roland');
    assert.equal(claimRow.office, 'valley');
    for (const r of [summaryRow, claimRow]) {
      assert.equal(r.action, 'READ');
      assert.equal(r.result, 'SUCCESS');
      assert.equal(r.user_id, 'billing@carein.ai');
      // A list read has no single resource — and a query string could be PHI.
      assert.equal(r.resource_id, null);
    }
  } finally {
    await close();
  }
});
