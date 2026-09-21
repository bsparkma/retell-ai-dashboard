'use strict';

/**
 * The perio workspace routes (H4 slice 10) — read, display, stage. NOTHING SENDS.
 *
 * Driven through the REAL assembled /api/hyg stack (hygTestUtils.bootHygApp), so
 * the mount's permission pair, the router-wide office check and the audit rows
 * are what answer, not stubs.
 *
 * What these tests pin, in the order a hygienist meets it:
 *
 *   - the stored chart is ours: GET and PUT reach no Open Dental at all
 *   - a partial chart stages, and SAYS it is partial
 *   - changing a staged reading un-stages it; a save that changes nothing does not
 *   - un-staging a chart keeps its readings
 *   - a stale perio confirmation refuses the visit Send, whole, and writes nothing
 *     anywhere (item 15: a CURRENT one rides it — hygVisitPerioSend.test.js)
 *   - the prior exam is audited per patient and is found / none / unavailable
 *
 * NO PHI: 12827 / 12828 are the designated roland fixtures.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FakeOd,
  bootHygApp,
  api,
  apptRow,
  patientRow,
  operatoryRow,
} = require('./hygTestUtils');
const contract = require('../../hyg/contract.gen.cjs');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const BASE = '/api/hyg/visit/900001';

function od(extra = {}) {
  return new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Perio Maint' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
    ...extra,
  });
}

/** A chart with the first `n` sites of the default sweep charted at 3 mm. */
function chartWith(n) {
  let chart = contract.emptyPerioChart();
  for (const c of contract.chartingOrder(chart.sweep).slice(0, n)) {
    chart = contract.withPerioSite(chart, c.tooth, c.surface, { depth: 3 });
  }
  return chart;
}

function perioRow(app) {
  return app.db.hyg_staged_write.find((r) => r.kind === 'perio') || null;
}

function auditTypes(app) {
  return app.db.audit.map((r) => r.resource_type);
}

test('before a visit exists the chart is empty, reaches no Open Dental and discloses nobody', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    const res = await api(app.baseUrl, 'GET', BASE + '/perio' + Q);
    assert.equal(res.status, 200);
    assert.equal(res.body.visitStarted, false);
    assert.equal(res.body.stagedWrite, null);
    assert.equal(res.body.counts.sitesCharted, 0);
    assert.equal(res.body.counts.sitesExpected, 192);
    assert.ok(contract.HygPerioResponseSchema.safeParse(res.body).success);

    assert.equal(app.od.calls.length, 0, 'the stored chart is ours — no Open Dental read');
    assert.deepEqual(app.db.audit, [], 'nothing stored, nobody disclosed');
  } finally {
    await app.close();
  }
});

test('PUT stores the chart as a DRAFT on the visit, and GET reads the same chart back', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await api(app.baseUrl, 'POST', BASE + '/open' + Q);
    app.od.calls.length = 0;

    const put = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: chartWith(84) } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.stagedWrite.state, 'Draft');
    assert.equal(put.body.counts.sitesCharted, 84);
    assert.equal(put.body.counts.complete, false);
    assert.ok(contract.HygPerioResponseSchema.safeParse(put.body).success);

    // ONE row, of the kind the contract already had, in the state nothing used.
    assert.equal(app.db.hyg_staged_write.length, 1);
    assert.equal(perioRow(app).state, 'Draft');
    assert.deepEqual(perioRow(app).preview, [], 'a draft carries no preview to confirm');

    const got = await api(app.baseUrl, 'GET', BASE + '/perio' + Q);
    assert.equal(got.status, 200);
    assert.equal(got.body.visitStarted, true);
    assert.deepEqual(got.body.chart, contract.normalizePerioChart(chartWith(84)));

    // The readings are a patient's clinical data: audited, per patient.
    const patientRows = app.db.audit.filter((r) => r.resource_type === 'hyg_perio_patient');
    assert.equal(patientRows.length, 1);
    assert.equal(Number(patientRows[0].resource_id), 12827);

    assert.equal(app.od.calls.length, 0, 'no Open Dental on the stored-chart routes');
    assert.deepEqual(app.od.writes, []);
  } finally {
    await app.close();
  }
});

test('a chart is refused before a visit exists, and a bad reading is a 400 naming the site', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    const early = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: chartWith(3) } });
    assert.equal(early.status, 404);
    assert.equal(early.body.code, 'VISIT_NOT_FOUND');

    await api(app.baseUrl, 'POST', BASE + '/open' + Q);

    const deep = contract.withPerioSite(contract.emptyPerioChart(), 3, 'DB', { depth: 3 });
    deep.teeth['3'].sites.DB.depth = 20;
    const tooDeep = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: deep } });
    assert.equal(tooDeep.status, 400);
    assert.equal(tooDeep.body.code, 'INVALID_BODY');
    assert.equal(tooDeep.body.field, 'chart.teeth.3.sites.DB.depth');

    const badTooth = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, {
      body: { chart: { teeth: { 33: contract.emptyPerioTooth() } } },
    });
    assert.equal(badTooth.status, 400);

    // CAL is derived by Open Dental and is not a field anybody can send.
    const cal = contract.emptyPerioChart();
    const withCal = { ...cal, teeth: { 3: { ...contract.emptyPerioTooth(), cal: 4 } } };
    const calRes = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: withCal } });
    assert.equal(calRes.status, 400);
    assert.match(calRes.body.field, /cal$/);

    assert.equal(perioRow(app), null, 'nothing refused was stored');
  } finally {
    await app.close();
  }
});

test('a PARTIAL chart stages, and says it is partial in the summary and the preview', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await api(app.baseUrl, 'POST', BASE + '/open' + Q);
    await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: chartWith(84) } });

    const staged = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, {
      body: { kind: 'perio' },
    });
    assert.equal(staged.status, 201, JSON.stringify(staged.body));
    const write = staged.body.visit.stagedWrites.find((w) => w.kind === 'perio');
    assert.equal(write.state, 'Staged');
    assert.match(write.summary, /^Partial chart: 84 of 192 sites charted/);
    assert.equal(write.preview[0], 'Partial chart: 84 of 192 sites charted');
    assert.ok(write.previewFingerprint.length > 0);
    // Composed from the STORED draft: the payload is the chart that was saved.
    assert.deepEqual(perioRow(app).payload.chart, contract.normalizePerioChart(chartWith(84)));
    assert.deepEqual(app.od.writes, []);
  } finally {
    await app.close();
  }
});

test('staging a visit with no readings refuses rather than staging an empty chart', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await api(app.baseUrl, 'POST', BASE + '/open' + Q);
    const res = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'NOTHING_TO_STAGE');
    assert.match(res.body.error, /no perio readings/);
    assert.equal(perioRow(app), null);
  } finally {
    await app.close();
  }
});

test('a save that changes no reading keeps a chart staged; a changed reading un-stages it', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await api(app.baseUrl, 'POST', BASE + '/open' + Q);
    await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: chartWith(84) } });
    await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
    const fingerprint = perioRow(app).preview;

    // The same chart again — a repeated debounce.
    const same = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: chartWith(84) } });
    assert.equal(same.body.stagedWrite.state, 'Staged');

    // Only the typing direction changed. The readings did not, so neither did
    // the preview, so the state stays — and the new direction IS stored.
    const flipped = { ...chartWith(84), sweep: { ...contract.defaultPerioSweep(), lowerFacial: 'ltr' } };
    const dir = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: flipped } });
    assert.equal(dir.body.stagedWrite.state, 'Staged');
    assert.deepEqual(perioRow(app).preview, fingerprint);
    assert.equal(perioRow(app).payload.chart.sweep.lowerFacial, 'ltr');

    // One more reading: the staged snapshot is wrong now, so it is not staged.
    const changed = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: chartWith(85) } });
    assert.equal(changed.body.stagedWrite.state, 'Draft');
    assert.deepEqual(perioRow(app).preview, []);
    assert.equal(changed.body.counts.sitesCharted, 85);
  } finally {
    await app.close();
  }
});

test('un-staging a chart takes it off the list and KEEPS its readings', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await api(app.baseUrl, 'POST', BASE + '/open' + Q);
    await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: chartWith(84) } });
    await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });

    const off = await api(app.baseUrl, 'DELETE', BASE + '/staged-writes/perio' + Q);
    assert.equal(off.status, 200);
    assert.equal(perioRow(app).state, 'Draft');

    const got = await api(app.baseUrl, 'GET', BASE + '/perio' + Q);
    assert.equal(got.body.counts.sitesCharted, 84, 'not one reading was thrown away');

    // A draft is already off the list.
    const again = await api(app.baseUrl, 'DELETE', BASE + '/staged-writes/perio' + Q);
    assert.equal(again.status, 404);
    assert.equal(again.body.code, 'STAGED_WRITE_NOT_FOUND');
    assert.ok(perioRow(app), 'and still not deleted');
  } finally {
    await app.close();
  }
});

test('a chart that has left Draft/Staged cannot be changed or taken off the list', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await api(app.baseUrl, 'POST', BASE + '/open' + Q);
    await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: chartWith(84) } });
    await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
    // The state the send slice will set. Nothing in this slice can reach it.
    perioRow(app).state = 'Sending';

    const put = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: chartWith(90) } });
    assert.equal(put.status, 409);
    assert.equal(put.body.code, 'STAGED_WRITE_IMMUTABLE');

    const del = await api(app.baseUrl, 'DELETE', BASE + '/staged-writes/perio' + Q);
    assert.equal(del.status, 409);
    assert.equal(perioRow(app).state, 'Sending');
    assert.equal(contract.countPerioChart(perioRow(app).payload.chart).sitesCharted, 84);
  } finally {
    await app.close();
  }
});

test('a stale perio confirmation refuses the visit Send for the WHOLE batch, and writes nothing anywhere', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await api(app.baseUrl, 'POST', BASE + '/open' + Q);
    await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: chartWith(84) } });
    const staged = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
    await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'router' } });
    const perio = staged.body.visit.stagedWrites.find((w) => w.kind === 'perio');
    const visit = await api(app.baseUrl, 'GET', BASE + Q);
    const router = visit.body.visit.stagedWrites.find((w) => w.kind === 'router');

    const res = await api(app.baseUrl, 'POST', BASE + '/send' + Q, {
      body: {
        confirm: [
          { kind: 'router', previewFingerprint: router.previewFingerprint },
          // Item 15: a staged chart rides the visit Send — but only the chart
          // she read. This one changed since.
          {
            kind: 'perio',
            previewFingerprint: perio.previewFingerprint + '-stale',
            examDate: DATE,
            provNum: 7,
          },
        ],
      },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PREVIEW_CHANGED');

    // WHOLE batch: the slip that rode along was not quietly sent either.
    assert.deepEqual(app.od.writes, [], 'not one Open Dental write verb');
    const states = Object.fromEntries(app.db.hyg_staged_write.map((r) => [r.kind, r.state]));
    assert.deepEqual(states, { perio: 'Staged', router: 'Staged' });
  } finally {
    await app.close();
  }
});

test('the prior exam is FOUND, drawn from Open Dental, and audited per patient', async () => {
  const app = await bootHygApp({
    od: od({
      '/perioexams': [{ PerioExamNum: 5001, PatNum: 12827, ExamDate: '2025-05-12', ProvNum: 7 }],
      '/periomeasures': [
        {
          PerioMeasureNum: 1, PerioExamNum: 5001, SequenceType: 'Probing', IntTooth: 3, ToothValue: -1,
          DBvalue: 3, Bvalue: 2, MBvalue: 3, DLvalue: 3, Lvalue: 3, MLvalue: 4,
        },
        {
          PerioMeasureNum: 2, PerioExamNum: 5001, SequenceType: 'BleedSupPlaqCalc', IntTooth: 3,
          ToothValue: -1, DBvalue: 1, Bvalue: 0, MBvalue: 0, DLvalue: 0, Lvalue: 0, MLvalue: 0,
        },
      ],
    }),
  });
  try {
    const res = await api(app.baseUrl, 'GET', BASE + '/perio/prior' + Q);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(contract.HygPerioPriorResponseSchema.safeParse(res.body).success);
    assert.equal(res.body.prior.status, 'found');
    assert.equal(res.body.prior.examDate, '2025-05-12');
    assert.equal(res.body.prior.chart.teeth['3'].sites.MB.depth, 3);
    assert.equal(res.body.prior.chart.teeth['3'].sites.DB.bleeding, true);
    assert.equal(res.body.appointment.patNum, 12827);

    // Asked for THIS patient's exams, and only ever with GETs.
    const exams = app.od.calls.find((c) => c.path === '/perioexams');
    assert.deepEqual(exams.params, { PatNum: 12827 });
    assert.deepEqual(app.od.writes, []);

    assert.ok(auditTypes(app).includes('hyg_perio_prior'));
    const patientRows = app.db.audit.filter((r) => r.resource_type === 'hyg_perio_prior_patient');
    assert.equal(patientRows.length, 1);
    assert.equal(Number(patientRows[0].resource_id), 12827);
  } finally {
    await app.close();
  }
});

test('no prior exam is NONE, and an Open Dental outage is UNAVAILABLE — both still 200', async () => {
  const none = await bootHygApp({ od: od({ '/perioexams': [] }) });
  try {
    const res = await api(none.baseUrl, 'GET', BASE + '/perio/prior' + Q);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.prior, { status: 'none' });
  } finally {
    await none.close();
  }

  const down = await bootHygApp({
    od: od({ '/perioexams': { ok: false, status: 504, data: null, error: 'timeout' } }),
  });
  try {
    const res = await api(down.baseUrl, 'GET', BASE + '/perio/prior' + Q);
    assert.equal(res.status, 200, 'the page still has a chart to work in');
    assert.equal(res.body.prior.status, 'unavailable');
    assert.equal(res.body.prior.detail, 'timeout');
    // The appointment's name went out in this body, so it is still audited.
    assert.ok(auditTypes(down).includes('hyg_perio_prior_patient'));
  } finally {
    await down.close();
  }
});

test('a chart entered for one patient is never drawn beside another patient\'s history', async () => {
  const app = await bootHygApp({
    od: od({
      '/patients/12828': patientRow({ PatNum: 12828, LName: 'Test', FName: 'MangoTest' }),
      '/perioexams': [],
    }),
  });
  try {
    await api(app.baseUrl, 'POST', BASE + '/open' + Q);
    // Open Dental moves the appointment to a different patient.
    app.od.routes['/appointments'] = [
      apptRow({ AptNum: 900001, PatNum: 12828, AptDateTime: DATE + ' 08:00:00' }),
    ];
    const res = await api(app.baseUrl, 'GET', BASE + '/perio/prior' + Q);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PATIENT_CHANGED');
    assert.equal(app.od.calls.some((c) => c.path === '/perioexams'), false, 'no history was read');
  } finally {
    await app.close();
  }
});

test('the prior exam needs a real date, and an office that is switched off is refused', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    const noDate = await api(app.baseUrl, 'GET', BASE + '/perio/prior?office=roland');
    assert.equal(noDate.status, 400);
    assert.equal(noDate.body.code, 'INVALID_DATE');

    const valley = await api(app.baseUrl, 'GET', BASE + '/perio/prior?office=valley&date=' + DATE);
    assert.equal(valley.status, 409);
    assert.equal(valley.body.code, 'OFFICE_NOT_READY');
    assert.deepEqual(app.od.calls, []);
  } finally {
    await app.close();
  }
});
