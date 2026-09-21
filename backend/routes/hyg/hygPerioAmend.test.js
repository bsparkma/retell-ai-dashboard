'use strict';

/**
 * CORRECTING A PERIO CHART THAT IS ALREADY IN OPEN DENTAL (H4 item 13).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AN AMENDMENT IS A SAFE SWAP, AND THE ORDER IS THE WHOLE POINT
 * ═════════════════════════════════════════════════════════════════════════════
 *     POST the corrected exam → read back EVERY site → only then DELETE the old.
 *
 * Never the other way round: a window with no perio exam at all is worse than a
 * window with a wrong digit in one, and a re-create that failed would leave the
 * patient with nothing. So these tests assert an ORDERING against the fake's
 * single ordered write log, and assert that every failure path deletes NOTHING.
 *
 * `PUT /periomeasures` is not used and must never be: it is documented by Open
 * Dental and has never been exercised against a live database — the status arch
 * strings had before the probe found they corrupt a chart silently. One test
 * below holds the whole module to that.
 *
 * The acceptance, as tests:
 *   1. A Written chart can be amended; the readings carry forward.
 *   2. POST → verify → DELETE, asserted as an order.
 *   3. A failed re-create deletes NOTHING and says the amendment failed.
 *   4. The server hands the screen every changed site as old → new.
 *   5. The audit carries the sites, the actor and both exam numbers — and no readings.
 *   6. The undo can only ever target the NEW exam.
 *   7. An un-amended chart, and an abandoned amendment, change nothing in Open Dental.
 *
 * NO PHI: 12827 is the designated roland fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootHygApp, api, perioOd } = require('./hygTestUtils');
const contract = require('../../hyg/contract.gen.cjs');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const BASE = '/api/hyg/visit/900001';

const perioFake = (opts) => perioOd({ date: DATE, patNum: 12827, ...opts });

/** Every site 0–9, so a whole chart is ONE write and a swap is two. */
function fullMouth(depth = (i) => (i % 4) + 2) {
  let chart = contract.emptyPerioChart();
  for (const field of contract.PERIO_ARCH_STRING_FIELDS) {
    contract.PERIO_ARCH_STRING_SITES[field].forEach((c, i) => {
      chart = contract.withPerioSite(chart, c.tooth, c.surface, { depth: depth(i) });
    });
  }
  return contract.normalizePerioChart(chart);
}

function depthAt(chart, tooth, surface) {
  return contract.perioSite(chart, tooth, surface).depth;
}

async function drain(app, res, limit = 20) {
  let current = res;
  for (let i = 0; i < limit; i += 1) {
    if (current.status !== 200) return current;
    const s = current.body.send;
    if (!s || !['posting', 'filling'].includes(s.state) || current.body.paused) return current;
    current = await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q);
  }
  return current;
}

async function stageChart(app, chart) {
  const put = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const staged = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  return staged.body.visit.stagedWrites.find((w) => w.kind === 'perio');
}

async function sendStaged(app, write) {
  return drain(
    app,
    await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, {
      body: { previewFingerprint: write.previewFingerprint, examDate: DATE, provNum: 7 },
    })
  );
}

/** A chart written to Open Dental and read back: the state every amendment starts from. */
async function writeFirstChart(app, chart) {
  await api(app.baseUrl, 'POST', BASE + '/open' + Q);
  const write = await stageChart(app, chart);
  const done = await sendStaged(app, write);
  assert.equal(done.body.send.state, 'written', JSON.stringify(done.body.send));
  return done;
}

async function amend(app) {
  return api(app.baseUrl, 'POST', BASE + '/perio/amend' + Q);
}

function stagedRow(app) {
  return app.db.hyg_staged_write.find((w) => w.kind === 'perio');
}

test('ACCEPTANCE 1: a Written chart can be amended, and its readings carry forward', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    await writeFirstChart(app, chart);
    const writesAfterSend = app.od.writes.length;

    const opened = await amend(app);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.stagedWrite.state, 'Amending');
    assert.equal(opened.body.send.state, 'written', 'the send that wrote the exam is still the live one');
    assert.equal(opened.body.send.examNum, 7001);

    // THE READINGS CARRY FORWARD: what is on the chart is what Open Dental holds.
    const carried = await api(app.baseUrl, 'GET', BASE + '/perio' + Q);
    assert.equal(carried.status, 200);
    assert.deepEqual(contract.comparePerioReadback(chart, carried.body.chart), []);
    assert.equal(carried.body.counts.sitesCharted, 192);

    // And opening it wrote NOTHING to Open Dental.
    assert.equal(app.od.writes.length, writesAfterSend);
    assert.deepEqual(od.state.deletes, []);
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [7001]);

    // A reading can be changed again — the thing slice 12 refused.
    const corrected = contract.withPerioSite(chart, 14, 'B', { depth: 9 });
    const put = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: corrected } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(stagedRow(app).state, 'Amending', 'an unsent correction rests in Amending, not Draft');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 2: the order is POST the new exam, read it back, and only THEN delete the old', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    await writeFirstChart(app, chart);
    assert.deepEqual(od.state.order, ['POST exam 7001']);

    await amend(app);
    const corrected = contract.withPerioSite(chart, 14, 'B', { depth: 9 });
    const done = await sendStaged(app, await stageChart(app, corrected));
    assert.equal(done.status, 200, JSON.stringify(done.body));

    // THE ORDERING, from the fake's single write log.
    assert.deepEqual(od.state.order, ['POST exam 7001', 'POST exam 7002', 'DELETE exam 7001']);
    const s = done.body.send;
    assert.equal(s.state, 'written');
    assert.equal(s.examNum, 7002);
    assert.equal(s.supersedesExamNum, 7001);
    assert.ok(s.supersedesDeletedAt, 'the swap recorded that the old exam is gone');
    assert.equal(done.body.stagedWrite.state, 'Written');
    assert.match(done.body.stagedWrite.writtenRef, /^Perio exam 7002: 192 sites read back and match \(amended; replaced exam 7001, now deleted\)$/);

    // Open Dental holds ONE exam, and it is the corrected one.
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [7002]);
    const prior = await api(app.baseUrl, 'GET', BASE + '/perio/prior' + Q);
    assert.equal(prior.body.prior.examNum, 7002);
    assert.equal(contract.perioSite(prior.body.prior.chart, 14, 'B').depth, 9);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 3: a re-create that is REFUSED deletes nothing and says the correction did not go through', async () => {
  let refuse = true;
  const od = perioFake({
    onExam: (body, state) =>
      refuse && state.exams.length > 0
        ? { ok: false, status: 400, data: null, error: 'UpperFacial must start with a number from 0-9.' }
        : null,
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    await writeFirstChart(app, chart);
    await amend(app);
    const corrected = contract.withPerioSite(chart, 14, 'B', { depth: 9 });
    const done = await sendStaged(app, await stageChart(app, corrected));

    assert.equal(done.body.send.state, 'refused');
    assert.equal(done.body.send.examNum, null);
    assert.equal(done.body.stagedWrite.state, 'Failed');
    assert.match(done.body.send.errorMessage, /Nothing was created in Open Dental/);

    // THE PATIENT KEEPS THE ORIGINAL CHART.
    assert.deepEqual(od.state.deletes, [], 'nothing was deleted');
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [7001]);
    const prior = await api(app.baseUrl, 'GET', BASE + '/perio/prior' + Q);
    assert.equal(prior.body.prior.examNum, 7001);
    assert.deepEqual(contract.comparePerioReadback(chart, prior.body.prior.chart), []);

    // And it can be corrected again once Open Dental will take it.
    refuse = false;
    const retry = await api(app.baseUrl, 'POST', BASE + '/staged-writes/perio/retry' + Q);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    const second = await sendStaged(app, retry.body.visit.stagedWrites.find((w) => w.kind === 'perio'));
    assert.equal(second.body.send.state, 'written');
    assert.deepEqual(od.state.order.slice(-2), ['POST exam 7002', 'DELETE exam 7001']);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 3b: a re-create that does not READ BACK deletes nothing, and the original stands', async () => {
  const od = perioFake({
    // The corrected exam lands wrong: one site comes back as something else.
    corrupt: (state, exam) => {
      if (exam.PerioExamNum !== 7002) return;
      const row = state.measures.find(
        (m) => m.PerioExamNum === 7002 && m.IntTooth === 3 && m.SequenceType === 'Probing'
      );
      row.DBvalue = 1;
    },
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    await writeFirstChart(app, chart);
    await amend(app);
    const corrected = contract.withPerioSite(chart, 14, 'B', { depth: 9 });
    const done = await sendStaged(app, await stageChart(app, corrected));

    assert.equal(done.body.send.state, 'incomplete');
    assert.equal(done.body.send.examNum, 7002);
    assert.match(done.body.send.errorMessage, /#3 DB/);
    assert.equal(done.body.stagedWrite.state, 'Failed');

    // NOTHING WAS DELETED: both exams are there, and the original is untouched.
    assert.deepEqual(od.state.deletes, []);
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [7001, 7002]);
    assert.equal(od.state.order.filter((o) => o.startsWith('DELETE')).length, 0);
    const first = od.state.measures.filter((m) => m.PerioExamNum === 7001);
    assert.equal(first.length, 32, "the original exam's rows are all still there");
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 4: the server hands the screen every changed site, as old → new', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    await writeFirstChart(app, chart);
    await amend(app);

    let corrected = contract.withPerioSite(chart, 14, 'B', { depth: 9 });
    corrected = contract.withPerioSite(corrected, 30, 'DL', { depth: 5, bleeding: true });
    const write = await stageChart(app, corrected);
    const started = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, {
      body: { previewFingerprint: write.previewFingerprint, examDate: DATE, provNum: 7 },
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    const diff = started.body.send.amendDiff;
    assert.deepEqual(
      diff.map((c) => contract.perioChangeLine(c)).sort(),
      [
        `#14 B: ${depthAt(chart, 14, 'B')} mm → 9 mm`,
        `#30 DL: ${depthAt(chart, 30, 'DL')} mm → 5 mm`,
        '#30 DL: no flags → bleeding',
      ].sort()
    );
    // And the baseline it was diffed against is on the wire for the dialog.
    const live = await api(app.baseUrl, 'GET', BASE + '/perio/send' + Q);
    assert.ok(live.body.send.writtenChart, 'the chart the last send wrote is available to diff against');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 5: the audit carries the sites, the actor and both exam numbers — and never a reading', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    await writeFirstChart(app, chart);
    await amend(app);
    const corrected = contract.withPerioSite(chart, 14, 'B', { depth: 9 });
    await sendStaged(app, await stageChart(app, corrected));

    const amendRows = app.db.audit.filter((a) => a.resource_type === 'hyg_perio_amend');
    const siteRows = app.db.audit.filter((a) => a.resource_type === 'hyg_perio_amend_site');

    // One row for opening the correction, one for the completed swap.
    assert.ok(amendRows.some((a) => a.prior_state === 'written' && a.source_ref === 'perio_exam:7001'));
    const swap = amendRows.find((a) => a.source_ref === 'perio_exam:7001->7002');
    assert.ok(swap, 'the swap names BOTH exam numbers');
    assert.equal(swap.prior_state, 'replaced');
    assert.equal(swap.action, 'UPDATE');
    assert.equal(swap.user_id, 'hygienist@carein.ai', 'and who did it');

    // One row per changed site, naming the site and nothing else.
    assert.deepEqual(
      siteRows.map((a) => a.resource_id),
      ['900001:14-B']
    );
    assert.equal(siteRows[0].source_ref, 'perio_exam:7001->7002');
    assert.equal(siteRows[0].prior_state, 'depth');

    /*
     * AND NO READING IS IN THE TRAIL. audit_log is identifiers only — its own
     * columns say "never a PHI value", and `prior_state` is slug-shaped by a
     * CHECK. The readings live on the send (`amend_diff`) and on the screen.
     */
    const trail = JSON.stringify(app.db.audit);
    assert.doesNotMatch(trail, / mm/, 'a depth reached the audit log');
    assert.doesNotMatch(trail, /bleeding|suppuration|plaque|calculus/i, 'a flag reached the audit log');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 6: the undo can only ever target the NEW exam, never the one being replaced', async () => {
  const od = perioFake({
    corrupt: (state, exam) => {
      if (exam.PerioExamNum !== 7002) return;
      state.measures.find(
        (m) => m.PerioExamNum === 7002 && m.IntTooth === 3 && m.SequenceType === 'Probing'
      ).DBvalue = 1;
    },
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    await writeFirstChart(app, chart);
    await amend(app);
    const corrected = contract.withPerioSite(chart, 14, 'B', { depth: 9 });
    const stopped = await sendStaged(app, await stageChart(app, corrected));
    assert.equal(stopped.body.send.state, 'incomplete');
    assert.equal(stopped.body.send.canDelete, true);

    // THE ORIGINAL IS NOT THIS SEND'S TO REMOVE.
    const wrong = await api(app.baseUrl, 'POST', BASE + '/perio/send/delete-exam' + Q, {
      body: { examNum: 7001 },
    });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.code, 'PERIO_EXAM_NOT_DELETABLE');
    assert.deepEqual(od.state.deletes, []);

    // The exam this send created is.
    const undone = await api(app.baseUrl, 'POST', BASE + '/perio/send/delete-exam' + Q, {
      body: { examNum: 7002 },
    });
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.deepEqual(od.state.deletes, [7002]);
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [7001], 'the original still stands');
    assert.equal(undone.body.stagedWrite.state, 'Staged', 'the correction is back on the list');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 7: an un-amended chart and an abandoned correction change nothing in Open Dental', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    await writeFirstChart(app, chart);
    const writesAfterSend = app.od.writes.length;

    // Amend, edit, stage — and walk away.
    await amend(app);
    const corrected = contract.withPerioSite(chart, 14, 'B', { depth: 9 });
    await stageChart(app, corrected);
    assert.equal(stagedRow(app).state, 'Staged');
    assert.equal(app.od.writes.length, writesAfterSend, 'nothing was written');
    assert.deepEqual(od.state.order, ['POST exam 7001']);

    // Abandon it: the chart goes back to what Open Dental holds.
    const cancelled = await api(app.baseUrl, 'POST', BASE + '/perio/amend/cancel' + Q);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.stagedWrite.state, 'Written');
    const back = await api(app.baseUrl, 'GET', BASE + '/perio' + Q);
    assert.deepEqual(contract.comparePerioReadback(chart, back.body.chart), [], 'the correction is gone');
    assert.equal(app.od.writes.length, writesAfterSend);
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [7001]);
    assert.deepEqual(od.state.deletes, []);

    // And it can be amended again afterwards.
    assert.equal((await amend(app)).status, 200);
  } finally {
    await app.close();
  }
});

test('an exam edited in Open Dental since the correction was started is refused, and nothing is written', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    await writeFirstChart(app, chart);
    await amend(app);
    const corrected = contract.withPerioSite(chart, 14, 'B', { depth: 9 });
    const write = await stageChart(app, corrected);

    // Somebody corrects a different site in Open Dental's own chart.
    od.state.measures.find(
      (m) => m.PerioExamNum === 7001 && m.IntTooth === 8 && m.SequenceType === 'Probing'
    ).Bvalue = 7;

    const refused = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, {
      body: { previewFingerprint: write.previewFingerprint, examDate: DATE, provNum: 7 },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'AMEND_BASE_CHANGED');
    assert.match(refused.body.error, /#8 B/);
    assert.deepEqual(od.state.order, ['POST exam 7001'], 'nothing was written and nothing deleted');
    assert.equal(stagedRow(app).state, 'Staged');
  } finally {
    await app.close();
  }
});

test('a swap whose DELETE fails says the old exam is still there, and can finish it later', async () => {
  let failDelete = true;
  const od = perioFake({
    onDelete: (n) =>
      failDelete && n === 7001
        ? { ok: false, status: 503, data: null, error: 'Open Dental is unavailable' }
        : null,
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    await writeFirstChart(app, chart);
    await amend(app);
    const corrected = contract.withPerioSite(chart, 14, 'B', { depth: 9 });
    const done = await sendStaged(app, await stageChart(app, corrected));

    // The CHART is correct, and the duplicate is named rather than hidden.
    assert.equal(done.body.send.state, 'written');
    assert.equal(done.body.send.supersedesDeletedAt, null);
    assert.match(done.body.send.errorMessage, /7001, is STILL in Open Dental/);
    assert.match(done.body.stagedWrite.writtenRef, /STILL in Open Dental/);
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [7001, 7002]);

    // The swap's last step, run again.
    failDelete = false;
    const wrong = await api(app.baseUrl, 'POST', BASE + '/perio/send/remove-replaced' + Q, {
      body: { examNum: 7002 },
    });
    assert.equal(wrong.status, 409, 'only the exam this correction replaced may be removed');
    assert.deepEqual(od.state.deletes, []);

    const removed = await api(app.baseUrl, 'POST', BASE + '/perio/send/remove-replaced' + Q, {
      body: { examNum: 7001 },
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [7002]);
    assert.ok(removed.body.send.supersedesDeletedAt);
    assert.deepEqual(od.state.order, ['POST exam 7001', 'POST exam 7002', 'DELETE exam 7001']);
  } finally {
    await app.close();
  }
});

test('a correction can itself be corrected: the second amendment replaces the first amendment exam', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    await writeFirstChart(app, chart);
    await amend(app);
    await sendStaged(app, await stageChart(app, contract.withPerioSite(chart, 14, 'B', { depth: 9 })));

    const again = await amend(app);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.send.examNum, 7002, 'the live exam is the one the correction wrote');
    const twice = await sendStaged(
      app,
      await stageChart(app, contract.withPerioSite(chart, 14, 'B', { depth: 4 }))
    );
    assert.equal(twice.body.send.supersedesExamNum, 7002);
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [7003]);
    assert.deepEqual(od.state.order, [
      'POST exam 7001',
      'POST exam 7002',
      'DELETE exam 7001',
      'POST exam 7003',
      'DELETE exam 7002',
    ]);
    const diff = twice.body.send.amendDiff.map(contract.perioChangeLine);
    assert.deepEqual(diff, ['#14 B: 9 mm → 4 mm'], 'diffed against the correction, not the original');
  } finally {
    await app.close();
  }
});

test('a chart that is not in Open Dental cannot be amended, and a correction cannot be started twice', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    await api(app.baseUrl, 'POST', BASE + '/open' + Q);
    const chart = fullMouth();
    await stageChart(app, chart);

    const tooEarly = await amend(app);
    assert.equal(tooEarly.status, 409);
    assert.equal(tooEarly.body.code, 'NOT_AMENDABLE');
    assert.deepEqual(od.state.order, []);

    const write = await api(app.baseUrl, 'GET', BASE + Q);
    await sendStaged(app, write.body.visit.stagedWrites.find((w) => w.kind === 'perio'));
    assert.equal((await amend(app)).status, 200);
    const twice = await amend(app);
    assert.equal(twice.status, 409);
    assert.match(twice.body.error, /already open for a correction/);

    // And cancelling something that was never opened is refused too.
    await api(app.baseUrl, 'POST', BASE + '/perio/amend/cancel' + Q);
    const cancelAgain = await api(app.baseUrl, 'POST', BASE + '/perio/amend/cancel' + Q);
    assert.equal(cancelAgain.status, 409);
    assert.equal(cancelAgain.body.code, 'NOT_AMENDING');
  } finally {
    await app.close();
  }
});

test('an amendment writes with POST and DELETE only — PUT /periomeasures is never reached', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = fullMouth();
    await writeFirstChart(app, chart);
    await amend(app);
    await sendStaged(app, await stageChart(app, contract.withPerioSite(chart, 14, 'B', { depth: 9 })));

    const verbs = app.od.writes.map((w) => w[1]);
    assert.deepEqual([...new Set(verbs)].sort(), ['DELETE', 'POST']);
    assert.equal(verbs.filter((v) => v === 'PUT').length, 0, 'PUT /periomeasures has never been exercised live');
  } finally {
    await app.close();
  }
});
