'use strict';

/**
 * THE PERIO SEND (H4 slice 11) — resumable, confirmed, and impossible to
 * half-lie about.
 *
 * Booted through the REAL /api/hyg stack against a fake Open Dental that
 * behaves like one: a POST puts a row where the next GET finds it, measurement
 * lists page at 100, and a write can LAND WITHOUT ANSWERING — which is the case
 * a retry double-writes on and the case these tests are mostly about.
 *
 * The acceptance, as tests:
 *   1. Kill-and-resume: no row sent twice, no row lost.           (two ways)
 *   2. Fingerprint gate: a chart edited after it was read ⇒ PREVIEW_CHANGED.
 *   3. Every write inside OD_WRITE_LAYER.                         (hygNoOdWrites)
 *   4. Read-before-resend, with the write count asserted.
 *   5. CAL never written; ProvNum explicit; flags → BleedSupPlaqCalc.
 *
 * NO PHI: 12827 is the designated roland fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeOd, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');
const contract = require('../../hyg/contract.gen.cjs');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const BASE = '/api/hyg/visit/900001';

/**
 * A fake Open Dental that keeps what is written to it.
 *
 * @param {{ provHyg?: number, provNum?: number,
 *           onMeasure?: (body: object, state: object) => object | null,
 *           onExam?: (body: object, state: object) => object | null }} [opts]
 *   A hook returning an envelope REPLACES the default answer. `landed: true` on
 *   that envelope still stores the row — a write that landed and did not answer.
 */
function perioOd({ provHyg = 7, provNum = 1, onMeasure = null, onExam = null } = {}) {
  const client = new FakeOd({
    '/appointments': [
      apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00', ProvHyg: provHyg, ProvNum: provNum }),
    ],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Perio Maint' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
  });
  const state = { exams: [], measures: [], posts: [], nextExam: 7001, nextMeasure: 90001 };

  const publish = () => {
    client.routes['/perioexams'] = state.exams.slice();
    for (const key of Object.keys(client.routes)) {
      if (key.startsWith('/periomeasures')) delete client.routes[key];
    }
    // Paged at 100, exactly like Open Dental: an unscripted Offset would fall
    // back to page one and never end.
    client.routes['/periomeasures'] = state.measures.slice(0, 100);
    for (let offset = 100; offset <= state.measures.length; offset += 100) {
      client.routes['/periomeasures?Offset=' + offset] = state.measures.slice(offset, offset + 100);
    }
  };

  client.writeRoutes = {
    '/perioexams': (body) => {
      state.posts.push({ path: '/perioexams', body });
      const hooked = onExam ? onExam(body, state) : null;
      if (hooked && !hooked.landed) return hooked;
      const exam = { PerioExamNum: state.nextExam++, PatNum: body.PatNum, ExamDate: body.ExamDate, ProvNum: body.ProvNum };
      state.exams.push(exam);
      publish();
      return hooked || { ok: true, status: 201, data: exam };
    },
    '/periomeasures': (body) => {
      state.posts.push({ path: '/periomeasures', body });
      const hooked = onMeasure ? onMeasure(body, state) : null;
      if (hooked && !hooked.landed) return hooked;
      const row = { PerioMeasureNum: state.nextMeasure++, ...body };
      state.measures.push(row);
      publish();
      return hooked || { ok: true, status: 201, data: row };
    },
  };
  publish();
  return { client, state, publish };
}

/**
 * Teeth 1–8: #1 skipped, #2–#8 fully probed, bleeding on #3 and #5.
 * 10 rows: 1 SkipTooth + 7 Probing + 2 BleedSupPlaqCalc.
 */
function quadrant() {
  let chart = contract.withPerioSkipped(contract.emptyPerioChart(), 1, true);
  for (const c of contract.chartingOrder(chart.sweep)) {
    if (c.tooth < 2 || c.tooth > 8) continue;
    chart = contract.withPerioSite(chart, c.tooth, c.surface, {
      depth: (c.tooth % 3) + 2,
      bleeding: (c.tooth === 3 || c.tooth === 5) && c.surface === 'DB',
    });
  }
  return chart;
}

/** All 32 teeth probed, every tooth flagged somewhere: 64 rows, six steps. */
function fullMouth() {
  let chart = contract.emptyPerioChart();
  for (const c of contract.chartingOrder(chart.sweep)) {
    chart = contract.withPerioSite(chart, c.tooth, c.surface, { depth: 3, plaque: c.surface === 'B' });
  }
  return chart;
}

async function stage(app, chart) {
  await api(app.baseUrl, 'POST', BASE + '/open' + Q);
  await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart } });
  const res = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.visit.stagedWrites.find((w) => w.kind === 'perio');
}

function confirmOf(write, over = {}) {
  return { previewFingerprint: write.previewFingerprint, examDate: DATE, provNum: 7, ...over };
}

/** Step until done, halted or paused. */
async function drain(app, res, limit = 40) {
  let current = res;
  for (let i = 0; i < limit; i += 1) {
    if (current.status !== 200) return current;
    const p = current.body.progress;
    if (!p || p.done || p.halted || current.body.paused) return current;
    current = await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q);
  }
  return current;
}

function postsFor(state, tooth, type) {
  return state.posts.filter((p) => p.path === '/periomeasures' && p.body.IntTooth === tooth && p.body.SequenceType === type).length;
}

function odKeys(state) {
  return state.measures.map((m) => `${m.IntTooth}:${m.SequenceType}`);
}

function withLease(ms, fn) {
  return async () => {
    const saved = process.env.HYG_PERIO_SEND_LEASE_MS;
    process.env.HYG_PERIO_SEND_LEASE_MS = String(ms);
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.HYG_PERIO_SEND_LEASE_MS;
      else process.env.HYG_PERIO_SEND_LEASE_MS = saved;
    }
  };
}

test('a confirmed chart goes in whole: one exam, every row once, each read back, then Written', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };
  try {
    const write = await stage(app, quadrant());
    const plan = contract.perioMeasureRows(quadrant());
    assert.equal(plan.length, 10);

    const done = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) }));
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(contract.HygPerioSendResponseSchema.safeParse(done.body).success);
    const p = done.body.progress;
    assert.equal(p.done, true);
    assert.equal(p.rowsConfirmed, 10);
    assert.equal(p.rowsTotal, 10);
    assert.equal(p.sitesConfirmed, 42, '#2-#8 at six sites each');
    assert.equal(done.body.stagedWrite.state, 'Written');
    assert.match(done.body.stagedWrite.writtenRef, /^Perio exam 7001: 10 rows read back$/);
    assert.equal(done.body.stagedWrite.sentBy, 'hygienist@carein.ai');

    // ONE exam, ProvNum EXPLICIT — the hygienist, not the patient's primary.
    const examPosts = od.state.posts.filter((x) => x.path === '/perioexams');
    assert.deepEqual(examPosts.map((x) => x.body), [{ PatNum: 12827, ExamDate: DATE, ProvNum: 7 }]);

    // Every planned row exactly once, and nothing else. No CAL anywhere.
    assert.equal(od.state.posts.filter((x) => x.path === '/periomeasures').length, 10);
    assert.deepEqual(odKeys(od.state).sort(), plan.map((r) => `${r.tooth}:${r.sequenceType}`).sort());
    for (const x of od.state.posts) {
      if (x.path === '/periomeasures') {
        assert.ok(['Probing', 'BleedSupPlaqCalc', 'SkipTooth'].includes(x.body.SequenceType));
        assert.equal(x.body.PerioExamNum, 7001);
      }
    }
    // Flags → BleedSupPlaqCalc, bleeding = 1 on DB; SkipTooth → ToothValue 1.
    const bleed3 = od.state.measures.find((m) => m.IntTooth === 3 && m.SequenceType === 'BleedSupPlaqCalc');
    assert.deepEqual([bleed3.DBvalue, bleed3.Bvalue, bleed3.MBvalue], [1, 0, 0]);
    const skip1 = od.state.measures.find((m) => m.IntTooth === 1);
    assert.deepEqual([skip1.SequenceType, skip1.ToothValue, skip1.MBvalue], ['SkipTooth', 1, -1]);

    // One audit row for the confirmation, one per write, each with the user.
    const sends = app.db.audit.filter((r) => r.resource_type === 'hyg_perio_send' && r.action === 'UPDATE');
    assert.equal(sends.length, 1 + 11);
    assert.ok(sends.every((r) => r.result === 'SUCCESS'));

    assert.ok(
      logs.some((l) => /^\[hygperio\] office=roland exam=7001 rows=10 confirmed=10 failed=0 ms=\d+$/.test(l)),
      logs.join('\n')
    );
  } finally {
    console.log = origLog;
    await app.close();
  }
});

test('a full mouth sends in bounded steps and still writes each of its 64 rows once', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, fullMouth());
    let res = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) });
    let steps = 1;
    while (res.status === 200 && !res.body.progress.done && steps < 20) {
      assert.ok(res.body.progress.secondsRemaining > 0, 'an honest time remaining while it is not done');
      assert.equal(res.body.paused, null);
      res = await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q);
      steps += 1;
    }
    assert.equal(res.body.progress.done, true);
    assert.ok(steps >= 6, `64 rows at ${contract.PERIO_SEND_BATCH} a step takes several steps, took ${steps}`);
    assert.equal(od.state.measures.length, 64);
    assert.equal(new Set(odKeys(od.state)).size, 64);
    assert.equal(res.body.progress.secondsRemaining, 0);
  } finally {
    await app.close();
  }
});

test('FINGERPRINT GATE: a chart edited after it was read refuses with PREVIEW_CHANGED, and writes nothing', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const read = await stage(app, quadrant());
    // Another tab changes a reading and stages again.
    const edited = contract.withPerioSite(quadrant(), 4, 'MB', { depth: 9 });
    await stage(app, edited);

    const res = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(read) });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PREVIEW_CHANGED');
    assert.deepEqual(od.client.writes, [], 'not one Open Dental write');
    assert.deepEqual(app.db.hyg_perio_send_row || [], [], 'no queue was planned');
    assert.equal(app.db.hyg_staged_write.find((w) => w.kind === 'perio').state, 'Staged');
  } finally {
    await app.close();
  }
});

test('the exam date and the provider are re-derived, and a mismatch or a missing provider writes nothing', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, quadrant());
    const wrongProv = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write, { provNum: 99 }) });
    assert.equal(wrongProv.body.code, 'PROVIDER_CHANGED');
    const wrongDate = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write, { examDate: '2026-09-07' }) });
    assert.equal(wrongDate.body.code, 'EXAM_DATE_CHANGED');
    assert.deepEqual(od.client.writes, []);
  } finally {
    await app.close();
  }

  const noProv = perioOd({ provHyg: 0, provNum: 0 });
  const app2 = await bootHygApp({ od: noProv.client });
  try {
    const write = await stage(app2, quadrant());
    const res = await api(app2.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NO_PROVIDER');
    assert.deepEqual(noProv.client.writes, [], "never left to Open Dental's primary-provider default");
  } finally {
    await app2.close();
  }
});

test('KILL AND RESUME (1): a row that LANDED WITHOUT ANSWERING is found by reading, never posted twice', withLease(0, async () => {
  let first = true;
  const od = perioOd({
    onMeasure: (body) => {
      if (first && body.IntTooth === 5 && body.SequenceType === 'Probing') {
        first = false;
        return { ok: false, status: 0, data: null, error: 'timeout of 30000ms exceeded', landed: true };
      }
      return null;
    },
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, quadrant());
    const stopped = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) }));
    assert.equal(stopped.status, 200);
    assert.match(stopped.body.paused, /did not answer for #5 Probing/);
    assert.equal(stopped.body.progress.halted, false, 'no answer is a pause, not a failure');
    const row5 = stopped.body.rows.find((r) => r.tooth === 5 && r.sequenceType === 'Probing');
    assert.equal(row5.state, 'sending');

    // The tab is gone. Somebody opens the chart and sends the next step.
    const done = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q));
    assert.equal(done.body.progress.done, true, JSON.stringify(done.body.progress));

    assert.equal(postsFor(od.state, 5, 'Probing'), 1, 'READ, not re-posted: the row had landed');
    assert.equal(od.state.measures.length, 10, 'no row lost');
    assert.equal(new Set(odKeys(od.state)).size, 10, 'no row doubled');
  } finally {
    await app.close();
  }
}));

test('KILL AND RESUME (2): the process dies after the EXAM HEADER lands — the exam is adopted, not posted twice', withLease(0, async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, quadrant());
    // The first `sent` a send records is the exam header's.
    app.db.failOnce = (text, params) =>
      /UPDATE hyg_perio_send_row\s+SET state = \$3/i.test(text) && params[2] === 'sent';
    const crashed = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) });
    assert.equal(crashed.status, 500);
    assert.equal(od.state.exams.length, 1, 'the header reached Open Dental before the crash');
    const exam = app.db.hyg_perio_send_row.find((r) => r.target === 'exam');
    assert.equal(exam.state, 'sending');
    assert.deepEqual(exam.prior_exam_nums, [], 'what was there before is on record');

    const done = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q));
    assert.equal(done.body.progress.done, true, JSON.stringify(done.body));
    assert.equal(od.state.posts.filter((x) => x.path === '/perioexams').length, 1, 'ONE header — adopted by reading');
    assert.equal(done.body.progress.examNum, 7001);
    assert.equal(new Set(odKeys(od.state)).size, 10);
  } finally {
    await app.close();
  }
}));

test('KILL AND RESUME (3): the process dies between a MEASUREMENT and its record — still once, still whole', withLease(0, async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, quadrant());
    // Skip the exam header's `sent`; die recording the FIRST measurement's.
    let sents = 0;
    app.db.failOnce = (text, params) =>
      /UPDATE hyg_perio_send_row\s+SET state = \$3/i.test(text) && params[2] === 'sent' && ++sents === 2;
    const crashed = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) });
    assert.equal(crashed.status, 500);
    assert.equal(od.state.measures.length, 1, 'one row reached Open Dental before the crash');
    const orphan = app.db.hyg_perio_send_row.find((r) => r.state === 'sending' && r.target === 'measure');
    assert.ok(orphan, 'the row the crash interrupted is left sending, not pending');

    const done = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q));
    assert.equal(done.body.progress.done, true, JSON.stringify(done.body));
    assert.equal(postsFor(od.state, orphan.tooth, orphan.sequence_type), 1, 'found by reading, not re-posted');
    assert.equal(od.state.measures.length, 10);
    assert.equal(new Set(odKeys(od.state)).size, 10);
  } finally {
    await app.close();
  }
}));

test('READ BEFORE RESEND: a refused row halts beside its site, and resume re-sends only what never landed', async () => {
  let refusedOnce = false;
  const od = perioOd({
    onMeasure: (body) => {
      if (!refusedOnce && body.IntTooth === 4 && body.SequenceType === 'Probing') {
        refusedOnce = true;
        return { ok: false, status: 400, data: null, error: '"IntTooth 4 is not valid for this exam."' };
      }
      return null;
    },
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, quadrant());
    const halted = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) }));
    const p = halted.body.progress;
    assert.equal(p.halted, true);
    assert.equal(p.done, false, 'the chart never claims Written with a row outstanding');
    assert.match(p.haltMessage, /#4 Probing: Open Dental refused it - "IntTooth 4 is not valid for this exam."/);
    const row4 = halted.body.rows.find((r) => r.tooth === 4 && r.sequenceType === 'Probing');
    assert.equal(row4.state, 'failed');
    assert.match(row4.errorMessage, /IntTooth 4 is not valid/);
    assert.equal(halted.body.stagedWrite.state, 'Failed');
    // HALTS: nothing after #4 was attempted in that step.
    assert.equal(postsFor(od.state, 6, 'Probing'), 0);

    // A stopped chart cannot be edited or re-staged — rows of it are permanent.
    const edit = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: contract.emptyPerioChart() } });
    assert.equal(edit.status, 409);
    const retry = await api(app.baseUrl, 'POST', BASE + '/staged-writes/perio/retry' + Q);
    assert.equal(retry.body.code, 'PERIO_USE_RESUME');

    const resumed = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send/resume' + Q));
    assert.equal(resumed.body.progress.done, true, JSON.stringify(resumed.body.progress));

    // THE WRITE COUNT. #4 Probing was refused (it did not land) and posted again;
    // every row that landed before the halt was READ on resume, not re-posted.
    assert.equal(postsFor(od.state, 4, 'Probing'), 2);
    for (const planned of contract.perioMeasureRows(quadrant())) {
      if (planned.tooth === 4 && planned.sequenceType === 'Probing') continue;
      assert.equal(postsFor(od.state, planned.tooth, planned.sequenceType), 1, `${planned.tooth} ${planned.sequenceType}`);
    }
    assert.equal(new Set(odKeys(od.state)).size, 10);
    assert.equal(od.state.posts.filter((x) => x.path === '/perioexams').length, 1, 'one exam header, ever');
  } finally {
    await app.close();
  }
});

test('a DIFFERENT row already in the exam halts the send, and nothing is written beside it', async () => {
  const od = perioOd({
    onExam: () => null,
  });
  // Somebody charts #2 in Open Dental the instant the exam exists.
  const origExam = od.client.writeRoutes['/perioexams'];
  od.client.writeRoutes['/perioexams'] = (body, client) => {
    const res = origExam(body, client);
    od.state.measures.push({
      PerioMeasureNum: 88001, PerioExamNum: res.data.PerioExamNum, SequenceType: 'Probing', IntTooth: 2,
      ToothValue: -1, MBvalue: 9, Bvalue: 9, DBvalue: 9, MLvalue: 9, Lvalue: 9, DLvalue: 9,
    });
    od.publish();
    return res;
  };
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, quadrant());
    const res = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) }));
    assert.equal(res.body.progress.halted, true);
    assert.match(res.body.progress.haltMessage, /#2 Probing: Open Dental already holds a different row/);
    assert.equal(postsFor(od.state, 2, 'Probing'), 0, 'never a second Probing row beside the first');
  } finally {
    await app.close();
  }
});

test('two tabs stepping the same send at once never write a row twice', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, fullMouth());
    await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) });
    for (let i = 0; i < 20; i += 1) {
      const [a, b] = await Promise.all([
        api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q),
        api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q),
      ]);
      if (a.body.progress.done && b.body.progress.done) break;
    }
    assert.equal(od.state.measures.length, 64);
    assert.equal(new Set(odKeys(od.state)).size, 64);
    assert.equal(od.state.posts.filter((x) => x.path === '/periomeasures').length, 64);
  } finally {
    await app.close();
  }
});

test('confirming twice plans one queue and posts one exam header', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, quadrant());
    const [a, b] = await Promise.all([
      api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) }),
      api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(od.state.posts.filter((x) => x.path === '/perioexams').length, 1);
    assert.equal(app.db.hyg_perio_send_row.filter((r) => r.target === 'exam').length, 1);
  } finally {
    await app.close();
  }
});

test('OPENDENTAL_WRITE_DISABLED, arriving from the transport, halts honestly on the exam header', async () => {
  const od = perioOd({
    onExam: () => ({ ok: false, status: 403, data: null, error: 'OD_WRITE_DISABLED: Open Dental writes are disabled in this environment' }),
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, quadrant());
    const res = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) });
    assert.equal(res.body.progress.halted, true);
    assert.match(res.body.progress.haltMessage, /OD_WRITE_DISABLED/);
    assert.equal(od.state.exams.length, 0);
    assert.equal(od.state.posts.filter((x) => x.path === '/periomeasures').length, 0);
  } finally {
    await app.close();
  }
});

test('progress is readable without Open Dental, and a batch send still refuses perio', async () => {
  const od = perioOd();
  const app = await bootHygApp({ od: od.client });
  try {
    const before = await api(app.baseUrl, 'GET', BASE + '/perio/send' + Q);
    assert.equal(before.status, 200);
    assert.equal(before.body.progress, null);

    const write = await stage(app, fullMouth());
    await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write) });
    const calls = od.client.calls.length;
    const mid = await api(app.baseUrl, 'GET', BASE + '/perio/send' + Q);
    assert.equal(od.client.calls.length, calls, 'reading progress reads no Open Dental');
    assert.ok(contract.HygPerioSendResponseSchema.safeParse(mid.body).success);
    assert.equal(mid.body.progress.rowsTotal, 64);
    assert.ok(mid.body.progress.rowsConfirmed > 0 && mid.body.progress.rowsConfirmed < 64);
  } finally {
    await app.close();
  }
});
