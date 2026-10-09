'use strict';

/**
 * The nightly Opportunities sync (item 41), against a fake Open Dental client
 * and the TC harness's FakeTenantDb (which executes the store's real SQL).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { FakeTenantDb } = require('../../routes/tc/tcTestUtils');
const odPatientCache = require('../odPatientCache');
const { syncOffice } = require('./sync');
const { odProc, fakeOdClient, fakeOdOffices, testConfig } = require('./tcOppsTestUtils');

function run(db, client, over = {}) {
  return syncOffice({
    office: over.office || 'roland',
    pool: db,
    odOffices: fakeOdOffices({ [over.office || 'roland']: client }),
    odPatientCache,
    config: testConfig(over.config),
  });
}

const rows = (db) => db.table('tc_opportunities');
const procsOf = (r) => (typeof r.procedures === 'string' ? JSON.parse(r.procedures) : r.procedures);

test.beforeEach(() => odPatientCache.resetOdPatientCache());

test('a complete sweep creates ONE row per patient with the snapshot, value and earliest planned date', async () => {
  const db = new FakeTenantDb();
  const client = fakeOdClient({
    procs: [
      odProc({ procNum: 1, patNum: 12827, fee: '1200.00', dateTP: '2026-09-01' }),
      odProc({ procNum: 2, patNum: 12827, code: 'D2950', fee: '300.00', dateTP: '2026-08-15' }),
      odProc({ procNum: 3, patNum: 12828, code: 'D3330', fee: '1100.50' }),
    ],
  });
  const out = await run(db, client);
  assert.equal(out.status, 'ok');
  assert.equal(rows(db).length, 2);
  const a = rows(db).find((r) => r.od_patient_id === 12827);
  assert.equal(a.value_cents, 150000);
  assert.equal(a.planned_date, '2026-08-15');
  assert.equal(a.status, 'new');
  assert.equal(a.office_id, 'roland');
  assert.deepEqual(procsOf(a).map((p) => p.procNum), [2, 1]);
  assert.equal(a.patient_name, 'Test 2, Stedi', 'name pass filled the snapshot');
  const sync = db.table('tc_opportunity_sync')[0];
  assert.equal(sync.last_status, 'ok');
  assert.ok(sync.last_synced_at instanceof Date);
  assert.equal(sync.watermark, '2026-10-08 02:30:01');
});

test('IDEMPOTENT: the same Open Dental data twice → no duplicate rows, last_seen moves, names not re-read', async () => {
  const db = new FakeTenantDb();
  const client = fakeOdClient({ procs: [odProc({ procNum: 1, patNum: 12827 }), odProc({ procNum: 2, patNum: 12828 })] });
  await run(db, client);
  const firstSeen = new Map(rows(db).map((r) => [r.opportunity_id, r.last_seen_at]));
  const nameReadsFirst = client.calls.filter((c) => c.path.startsWith('/patients/')).length;
  await new Promise((r) => setTimeout(r, 15));
  odPatientCache.resetOdPatientCache();
  const out = await run(db, client);
  assert.equal(out.inserted, 0);
  assert.equal(rows(db).length, 2);
  for (const r of rows(db)) {
    assert.ok(r.last_seen_at instanceof Date);
    assert.ok(r.last_seen_at.getTime() > firstSeen.get(r.opportunity_id).getTime(), 'last_seen_at moved');
  }
  const nameReadsTotal = client.calls.filter((c) => c.path.startsWith('/patients/')).length;
  assert.equal(nameReadsTotal, nameReadsFirst, 'a name snapshot is never re-read');
});

test('qualification: AptNum>0, non-D codes, $0 fees and too-old plans are excluded and counted', async () => {
  const db = new FakeTenantDb();
  const client = fakeOdClient({
    procs: [
      odProc({ procNum: 1, patNum: 12827, aptNum: 555 }),
      odProc({ procNum: 2, patNum: 12827, code: '0000', fee: '9.84' }),
      odProc({ procNum: 3, patNum: 12827, fee: '0.00' }),
      odProc({ procNum: 4, patNum: 12828, dateTP: '2019-01-01' }),
      odProc({ procNum: 5, patNum: 12828, dateTP: '2026-09-20' }),
    ],
  });
  const out = await run(db, client, { config: { lookbackDays: () => 730 } });
  assert.equal(out.excluded.on_appointment, 1);
  assert.equal(out.excluded.not_billable, 2);
  assert.equal(out.excluded.too_old, 1);
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db)[0].od_patient_id, 12828);
});

test('FILTER IGNORED: one non-TP row in a ProcStatus=TP answer aborts the sweep and applies nothing', async () => {
  const db = new FakeTenantDb();
  const client = fakeOdClient({
    ignoreFilter: true,
    procs: [odProc({ procNum: 1, patNum: 12827 }), odProc({ procNum: 2, patNum: 12827, status: 'C' })],
  });
  const out = await run(db, client);
  assert.equal(out.status, 'failed');
  assert.match(out.error, /^FILTER_IGNORED/);
  assert.equal(rows(db).length, 0);
  assert.equal(client.calls.filter((c) => c.path === '/procedurelogs').length, 1, 'stopped at the first page');
});

test('PARTIAL: a sweep that fails mid-way applies NOTHING and leaves last_synced_at at the last good sweep', async () => {
  const db = new FakeTenantDb();
  const procs = [];
  for (let i = 1; i <= 150; i += 1) procs.push(odProc({ procNum: i, patNum: i <= 100 ? 12827 : 12828 }));
  const client = fakeOdClient({ procs });
  await run(db, client);
  const good = db.table('tc_opportunity_sync')[0].last_synced_at;
  const before = JSON.stringify(rows(db).map((r) => [r.od_patient_id, r.value_cents, r.cleared_at]));

  client.state.procs = procs.slice(0, 120); // would shrink 12828 — if it were applied
  client.state.failPage = 1;
  const out = await run(db, client);
  assert.equal(out.status, 'partial');
  assert.match(out.error, /OD_READ_FAILED/);
  assert.equal(JSON.stringify(rows(db).map((r) => [r.od_patient_id, r.value_cents, r.cleared_at])), before);
  const sync = db.table('tc_opportunity_sync')[0];
  assert.equal(sync.last_status, 'partial');
  assert.equal(sync.last_synced_at, good, 'honest last_synced_at');
});

test('PAGE CAP: a sweep that hits the cap is partial, not a truncated success', async () => {
  const db = new FakeTenantDb();
  const procs = [];
  for (let i = 1; i <= 250; i += 1) procs.push(odProc({ procNum: i, patNum: 12827 }));
  const out = await run(db, fakeOdClient({ procs }), { config: { maxPages: () => 2 } });
  assert.equal(out.status, 'partial');
  assert.match(out.error, /PAGE_CAP/);
  assert.equal(rows(db).length, 0);
});

test('re-sync updates an OPEN row; treatment that left TP clears it; it returns if planned again', async () => {
  const db = new FakeTenantDb();
  const client = fakeOdClient({ procs: [odProc({ procNum: 1, patNum: 12827 }), odProc({ procNum: 2, patNum: 12828 })] });
  await run(db, client);
  client.state.procs = [odProc({ procNum: 1, patNum: 12827, fee: '1500.00' })];
  const out = await run(db, client);
  assert.equal(out.refreshed, 1);
  assert.equal(out.cleared, 1);
  const a = rows(db).find((r) => r.od_patient_id === 12827);
  const b = rows(db).find((r) => r.od_patient_id === 12828);
  assert.equal(a.value_cents, 150000);
  assert.ok(b.cleared_at, 'scheduled/completed treatment stops being offered');
  client.state.procs.push(odProc({ procNum: 2, patNum: 12828 }));
  await run(db, client);
  assert.equal(rows(db).find((r) => r.od_patient_id === 12828).cleared_at, null);
});

test('RESURRECTION: a dismissed row returns ONLY for a new ProcNum — never for a fee change', async () => {
  const db = new FakeTenantDb();
  const client = fakeOdClient({ procs: [odProc({ procNum: 1, patNum: 12827, fee: '1000.00' })] });
  await run(db, client);
  const row = rows(db)[0];
  Object.assign(row, { status: 'dismissed', dismissed_reason: 'Patient declined', dismissed_by: 'tc@carein.ai', dismissed_at: new Date() });

  client.state.procs = [odProc({ procNum: 1, patNum: 12827, fee: '2500.00' })];
  let out = await run(db, client);
  assert.equal(out.resurrected, 0);
  assert.equal(row.status, 'dismissed', 'value grew by a FEE change — stays dismissed');
  assert.equal(row.value_cents, 100000, 'dismissed snapshot is frozen');

  client.state.procs.push(odProc({ procNum: 9, patNum: 12827, code: 'D6010', fee: '3000.00' }));
  out = await run(db, client);
  assert.equal(out.resurrected, 1);
  assert.equal(row.status, 'new');
  assert.equal(row.dismissed_reason, null);
  assert.ok(row.resurrected_at instanceof Date);
  assert.deepEqual(procsOf(row).map((p) => p.procNum), [1, 9]);
});

test('a CLAIMED row keeps the snapshot the TC acted on; last_seen still moves', async () => {
  const db = new FakeTenantDb();
  const client = fakeOdClient({ procs: [odProc({ procNum: 1, patNum: 12827 })] });
  await run(db, client);
  const row = rows(db)[0];
  Object.assign(row, { status: 'claimed', claimed_case_id: '00000000-0000-4000-8000-000000000001' });
  client.state.procs = [odProc({ procNum: 1, patNum: 12827 }), odProc({ procNum: 2, patNum: 12827 })];
  const out = await run(db, client);
  assert.equal(out.touched, 1);
  assert.equal(procsOf(row).length, 1);
  assert.equal(row.status, 'claimed');
});

test('existing_case: marked when the patient has an OPEN case, unmarked when it closes (terminal)', async () => {
  const db = new FakeTenantDb();
  db.table('tc_cases').push({ case_id: 'c-open', office_id: 'roland', od_patient_id: 12827, status: 'presented', updated_at: new Date() });
  // Same PatNum in the OTHER office is a different person: must not mark.
  db.table('tc_cases').push({ case_id: 'c-valley', office_id: 'valley', od_patient_id: 12828, status: 'presented', updated_at: new Date() });
  const client = fakeOdClient({ procs: [odProc({ procNum: 1, patNum: 12827 }), odProc({ procNum: 2, patNum: 12828 })] });
  await run(db, client);
  assert.equal(rows(db).find((r) => r.od_patient_id === 12827).status, 'existing_case');
  assert.equal(rows(db).find((r) => r.od_patient_id === 12828).status, 'new', 'office is part of the match');

  db.table('tc_cases')[0].status = 'completed';
  await run(db, client);
  assert.equal(rows(db).find((r) => r.od_patient_id === 12827).status, 'new');
});

test('names: budgeted per night, highest value first, remainder reported as pending', async () => {
  const db = new FakeTenantDb();
  const client = fakeOdClient({
    procs: [
      odProc({ procNum: 1, patNum: 12827, fee: '100.00' }),
      odProc({ procNum: 2, patNum: 12828, fee: '900.00' }),
    ],
  });
  const out = await run(db, client, { config: { maxNameReads: () => 1 } });
  assert.equal(out.nameReads, 1);
  assert.equal(out.namesPending, 1);
  assert.equal(rows(db).find((r) => r.od_patient_id === 12828).patient_name, 'Test, MangoTest');
  assert.equal(rows(db).find((r) => r.od_patient_id === 12827).patient_name ?? null, null);
  assert.equal(db.table('tc_opportunity_sync')[0].names_pending, 1);
});

test('an office the registry refuses is a failed pass with ZERO Open Dental requests', async () => {
  const db = new FakeTenantDb();
  const out = await syncOffice({
    office: 'valley',
    pool: db,
    odOffices: fakeOdOffices({}),
    odPatientCache,
    config: testConfig(),
  });
  assert.equal(out.status, 'failed');
  assert.equal(out.error, 'OFFICE_NOT_OD_CONNECTED');
  assert.equal(out.odRequests, 0);
  assert.equal(db.table('tc_opportunity_sync')[0].last_status, 'failed');
});

test('THROTTLE DISCIPLINE: every request goes through apiGetRaw on the office client, holding ≥1200 ms', async () => {
  const db = new FakeTenantDb();
  const procs = [];
  for (let i = 1; i <= 230; i += 1) procs.push(odProc({ procNum: i, patNum: i % 2 ? 12827 : 12828 }));
  const client = fakeOdClient({ procs });
  const out = await run(db, client, { config: { minIntervalMs: () => 1200 } });
  assert.equal(out.odRequests, client.calls.length);
  assert.ok(client.calls.length > 0);
  for (const c of client.calls) {
    assert.ok(c.opts.minIntervalMs >= 1200, `${c.path} held the slot at ${c.opts.minIntervalMs}`);
    assert.equal(c.opts.module, 'tc-opps');
  }
  assert.deepEqual(
    client.calls.filter((c) => c.path === '/procedurelogs').map((c) => c.params.Offset),
    [0, 100, 200],
    'sequential pages, one sweep'
  );
});

test('config floor: TC_OPPS_MIN_INTERVAL_MS cannot lower the spacing below 1200', () => {
  const cfg = require('../../config/tcOpportunities');
  const prev = process.env.TC_OPPS_MIN_INTERVAL_MS;
  process.env.TC_OPPS_MIN_INTERVAL_MS = '100';
  try {
    assert.equal(cfg.minIntervalMs(), 1200);
  } finally {
    if (prev === undefined) delete process.env.TC_OPPS_MIN_INTERVAL_MS;
    else process.env.TC_OPPS_MIN_INTERVAL_MS = prev;
  }
});

test('STATIC: no direct transport anywhere in the sync, store, scheduler or routes', () => {
  const files = [
    path.join(__dirname, 'sync.js'),
    path.join(__dirname, 'store.js'),
    path.join(__dirname, 'core.js'),
    path.join(__dirname, 'scheduler.js'),
    path.join(__dirname, '..', '..', 'routes', 'tc', 'opportunities.js'),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\bfetch\s*\(/, `${path.basename(f)} calls fetch`);
    assert.doesNotMatch(src, /require\(['"](axios|node:https?|https?|undici|node-fetch)['"]\)/, `${path.basename(f)} imports a transport`);
    assert.doesNotMatch(src, /\b(apiPost|apiPut|apiDelete|apiPostRaw|apiPutRaw|apiDeleteRaw)\b/, `${path.basename(f)} names an OD write verb`);
  }
  // The routes never touch Open Dental at all.
  const routes = fs.readFileSync(files[4], 'utf8');
  assert.doesNotMatch(routes, /odOffices|openDental|odPatientCache|apiGetRaw|odAccess/);
});
