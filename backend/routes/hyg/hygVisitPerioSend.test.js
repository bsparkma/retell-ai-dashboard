'use strict';

/**
 * A STAGED PERIO CHART RIDES THE VISIT SEND (item 15) — through the real /api/hyg
 * stack, against the same fake Open Dental the perio send suite drives (it parses
 * arch strings with the PROBE's table, not the code's).
 *
 * The chart is one more unit on the visit's one Send, and it is still written by
 * services/hyg/perioSend.js and nothing else: its confirm runs before any unit
 * writes, its first step runs in the visit's request, and the rest are the chart's
 * own step route. What these tests hold it to:
 *
 *   2. the confirmation carries the exam date and provider, and the server checks them
 *   3. a drifted perio fingerprint refuses the WHOLE send; nothing is written by ANY unit
 *   4. note Written + perio Failed is a legal outcome, honest on both pages
 *   5. perio reaches Open Dental only through odPerioWriter (the guard lives in
 *      hygNoOdWrites.test.js; the behavioural half is here)
 *   6. every site is read back before perio shows Written
 *   7. Retry on an interrupted perio unit resumes; the exam it created is adopted, not duplicated
 *   8. Draft, Amending, in-flight, Written and a staged CORRECTION are refused server-side
 *   9. a send in flight from either page shows on both; the visit Send cannot start a second
 *  10. pressing Send twice cannot double-write any unit
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

/** Every site of the four sweeps at depth(i); bleeding on every seventh. */
function fullMouth(depth = (i) => (i * 7) % 10) {
  let chart = contract.emptyPerioChart();
  for (const f of contract.PERIO_ARCH_STRING_FIELDS) {
    contract.PERIO_ARCH_STRING_SITES[f].forEach((c, i) => {
      chart = contract.withPerioSite(chart, c.tooth, c.surface, { depth: depth(i), bleeding: i % 7 === 3 });
    });
  }
  return chart;
}

/**
 * The perio fake, plus what a visit NOTE needs: the appointment's procedures, the
 * GroupNotes surface a note is read back from, and a GroupNote write that lands
 * the way Open Dental's does (a new `~GRP~` row with a minted ProcNum).
 */
function visitFake(opts = {}) {
  const fake = perioOd({ date: DATE, patNum: 12827, ...opts });
  const { client } = fake;
  client.routes['/procedurelogs'] = [{ ProcNum: 5001 }, { ProcNum: 5002 }];
  client.routes['/procedurelogs/GroupNotes'] = [];
  let nextProcNum = 60001;
  client.writeRoutes['/procedurelogs/GroupNote'] = (body) => {
    const procNum = nextProcNum++;
    client.routes['/procedurelogs/GroupNotes'] = [
      ...client.routes['/procedurelogs/GroupNotes'],
      {
        ProcNum: procNum,
        PatNum: body.PatNum,
        ProcNums: body.ProcNums,
        ProvNum: body.ProvNum,
        isSigned: false,
        Note: String(body.Note).replace(/\n/g, '\r\n'),
      },
    ];
    fake.state.order.push('POST note');
    return { ok: true, status: 200, data: { ProcNum: procNum } };
  };
  return fake;
}

function examPosts(state) {
  return state.posts.filter((p) => p.path === '/perioexams');
}
function noteWrites(client) {
  return client.writes.filter((w) => w[2] === '/procedurelogs/GroupNote').length;
}

/** Open the visit, store and stage the chart, then stage the other kinds. */
async function stageVisit(app, { chart = fullMouth(), kinds = ['note'] } = {}) {
  assert.equal((await api(app.baseUrl, 'POST', BASE + '/open' + Q)).status, 200);
  assert.equal((await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart } })).status, 200);
  let res = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  for (const kind of kinds) {
    res = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind } });
    assert.equal(res.status, 201, kind + ' ' + JSON.stringify(res.body));
  }
  return res.body.visit;
}

function writeOf(visit, kind) {
  return visit.stagedWrites.find((w) => w.kind === kind);
}

/** The perio confirmation the visit's dialog sends: fingerprint, exam date, provider. */
function perioConfirm(visit, over = {}) {
  return {
    kind: 'perio',
    previewFingerprint: writeOf(visit, 'perio').previewFingerprint,
    examDate: DATE,
    provNum: 7,
    ...over,
  };
}
function plainConfirm(visit, kind, over = {}) {
  return { kind, previewFingerprint: writeOf(visit, kind).previewFingerprint, ...over };
}

async function sendVisit(app, confirm) {
  return api(app.baseUrl, 'POST', BASE + '/send' + Q, { body: { confirm } });
}

function states(app) {
  return Object.fromEntries(app.db.hyg_staged_write.map((r) => [r.kind, r.state]));
}

function outcomeOf(res, kind) {
  return res.body.outcomes.find((o) => o.kind === kind);
}

test('ACCEPTANCE 1+2: the note and a staged chart go on ONE Send; perio carries date and provider and lands Written', async () => {
  const od = visitFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const visit = await stageVisit(app);
    const res = await sendVisit(app, [plainConfirm(visit, 'note'), perioConfirm(visit)]);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(contract.HygSendResponseSchema.safeParse(res.body).success, 'the response is the contract');
    // In SEND_ORDER: the three units first, unchanged, then the chart.
    assert.deepEqual(res.body.outcomes.map((o) => o.kind), ['note', 'perio']);
    assert.equal(outcomeOf(res, 'note').state, 'Written');
    assert.equal(outcomeOf(res, 'perio').state, 'Written');
    assert.match(outcomeOf(res, 'perio').writtenRef, /^Perio exam 7001: 192 sites read back and match$/);
    assert.equal(res.body.written, 2);
    assert.equal(res.body.failed, 0);

    // One note write, one exam POST (the arch strings), no rows.
    assert.equal(noteWrites(od.client), 1);
    assert.equal(examPosts(od.state).length, 1);
    const exam = examPosts(od.state)[0].body;
    assert.equal(exam.ExamDate, DATE, 'the exam date she confirmed');
    assert.equal(exam.ProvNum, 7, 'the hygienist she confirmed, not the patient primary');
    assert.deepEqual(od.state.order, ['POST note', 'POST exam 7001'], 'the note first, then the chart');

    // The chart's own record agrees, which is what the chart page renders.
    const page = await api(app.baseUrl, 'GET', BASE + '/perio/send' + Q);
    assert.equal(page.body.send.state, 'written');
    assert.equal(page.body.stagedWrite.state, 'Written');
    assert.equal(page.body.send.startedBy, 'hygienist@carein.ai');

    // Audited as the chart page audits its send: the confirm, then one row per write.
    // (The READ row is this test's own GET of the chart page's view, above.)
    const perioRows = app.db.audit.filter((r) => r.resource_type === 'hyg_perio_send' && r.action !== 'READ');
    assert.deepEqual(perioRows.map((r) => [r.action, r.result]), [['UPDATE', 'SUCCESS'], ['CREATE', 'SUCCESS']]);
    const visitRows = app.db.audit.filter((r) => r.resource_type === 'hyg_visit_send');
    assert.equal(visitRows.length, 1, 'the note, once; the chart is audited by its writes');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 2: a confirmation naming a different exam date or provider refuses the whole send', async () => {
  for (const [over, code] of [
    [{ examDate: '2026-09-09' }, 'EXAM_DATE_CHANGED'],
    [{ provNum: 1 }, 'PROVIDER_CHANGED'],
  ]) {
    const od = visitFake();
    const app = await bootHygApp({ od: od.client });
    try {
      const visit = await stageVisit(app);
      const res = await sendVisit(app, [plainConfirm(visit, 'note'), perioConfirm(visit, over)]);
      assert.equal(res.status, 409, code);
      assert.equal(res.body.code, code);
      assert.deepEqual(od.client.writes, [], 'not one Open Dental write, by any unit');
      assert.deepEqual(states(app), { perio: 'Staged', note: 'Staged' });
      assert.equal(app.db.hyg_perio_send.length, 0, 'no send was recorded');
    } finally {
      await app.close();
    }
  }

  // And a perio confirmation without them is not a confirmation at all.
  const od = visitFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const visit = await stageVisit(app);
    const bare = await sendVisit(app, [plainConfirm(visit, 'perio')]);
    assert.equal(bare.status, 400);
    assert.equal(bare.body.code, 'INVALID_BODY');
    assert.deepEqual(od.client.writes, []);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 3: a drifted perio fingerprint refuses the WHOLE send with PREVIEW_CHANGED — nothing written by any unit', async () => {
  const od = visitFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const visit = await stageVisit(app, { kinds: ['note', 'router'] });
    const res = await sendVisit(app, [
      plainConfirm(visit, 'note'),
      plainConfirm(visit, 'router'),
      perioConfirm(visit, { previewFingerprint: 'the-chart-she-read-before-it-changed' }),
    ]);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PREVIEW_CHANGED');
    assert.match(res.body.error, /Nothing was sent/);
    assert.deepEqual(od.client.writes, [], 'not the note, not the slip, not the chart');
    assert.deepEqual(states(app), { perio: 'Staged', note: 'Staged', router: 'Staged' });
    assert.equal(app.db.hyg_perio_send.length, 0);

    // The other direction: the NOTE drifted, and the chart that rode along was
    // not claimed either.
    const again = await sendVisit(app, [
      plainConfirm(visit, 'note', { previewFingerprint: 'stale-note' }),
      perioConfirm(visit),
    ]);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'PREVIEW_CHANGED');
    assert.deepEqual(od.client.writes, []);
    assert.equal(states(app).perio, 'Staged');
    assert.equal(app.db.hyg_perio_send.length, 0);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 4: the note lands and Open Dental refuses the exam — note Written, perio Failed with its reason, on both pages', async () => {
  const od = visitFake({
    onExam: () => ({ ok: false, status: 400, data: null, error: 'ProvNum is not valid.' }),
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const visit = await stageVisit(app);
    const res = await sendVisit(app, [plainConfirm(visit, 'note'), perioConfirm(visit)]);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(outcomeOf(res, 'note').state, 'Written');
    const perio = outcomeOf(res, 'perio');
    assert.equal(perio.state, 'Failed');
    assert.equal(perio.code, 'PERIO_SEND_STOPPED');
    assert.match(perio.errorMessage, /Open Dental refused this perio exam - ProvNum is not valid/);
    assert.equal(res.body.written, 1);
    assert.equal(res.body.failed, 1);

    // The visit's own rows say the same, each its own truth.
    const rows = Object.fromEntries(res.body.visit.stagedWrites.map((w) => [w.kind, w]));
    assert.equal(rows.note.state, 'Written');
    assert.ok(rows.note.writtenRef);
    assert.equal(rows.perio.state, 'Failed');
    assert.match(rows.perio.errorMessage, /refused this perio exam/);
    assert.equal(rows.perio.writtenRef, null);

    // …and the chart page reads the same send.
    const page = await api(app.baseUrl, 'GET', BASE + '/perio/send' + Q);
    assert.equal(page.body.send.state, 'refused');
    assert.equal(page.body.stagedWrite.state, 'Failed');
    assert.equal(od.state.exams.length, 0, 'a refusal creates nothing');

    // A refused chart's Retry puts it back on the list, and the next Send takes it.
    const retry = await api(app.baseUrl, 'POST', BASE + '/staged-writes/perio/retry' + Q);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(writeOf(retry.body.visit, 'perio').state, 'Staged');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 5 (behavioural): every perio write the visit Send makes goes through odPerioWriter', async () => {
  const writer = require('../../services/hyg/odPerioWriter');
  const original = { exam: writer.createPerioExam, measure: writer.createPerioMeasure, del: writer.deletePerioExam };
  const through = [];
  writer.createPerioExam = (...args) => {
    through.push('exam');
    return original.exam(...args);
  };
  writer.createPerioMeasure = (...args) => {
    through.push('measure');
    return original.measure(...args);
  };
  writer.deletePerioExam = (...args) => {
    through.push('delete');
    return original.del(...args);
  };
  // One reading of 10+ forces rows, so both of the writer's POSTs are in the claim.
  const od = visitFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = contract.withPerioSite(fullMouth(() => 4), 9, 'ML', { depth: 11 });
    const visit = await stageVisit(app, { chart });
    const res = await sendVisit(app, [plainConfirm(visit, 'note'), perioConfirm(visit)]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // Drive the rest through the chart's own step route, as the page does.
    let step = null;
    for (let i = 0; i < 10; i += 1) {
      step = await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q);
      if (!['posting', 'filling'].includes(step.body.send.state)) break;
    }
    assert.equal(step.body.send.state, 'written', JSON.stringify(step.body.send));

    const perioWrites = od.client.writes.filter((w) => /^\/perio/.test(w[2]));
    assert.ok(perioWrites.length > 1, 'the claim is not vacuous: perio really was written');
    assert.ok(through.includes('exam') && through.includes('measure'));
    assert.equal(through.length, perioWrites.length, 'every perio write reached Open Dental through the writer');
  } finally {
    Object.assign(writer, {
      createPerioExam: original.exam,
      createPerioMeasure: original.measure,
      deletePerioExam: original.del,
    });
    await app.close();
  }
});

test('ACCEPTANCE 6: every site is read back before perio shows Written — and a site that does not read back blocks it', async () => {
  // The happy path: the read of the exam's measures comes AFTER the POST, and
  // before the answer that says Written.
  {
    const od = visitFake();
    const app = await bootHygApp({ od: od.client });
    // One ordered log of writes AND the measure reads, and of the moment the
    // staged row turned Written — an ordering can only be asserted against one log.
    const getRaw = od.client.apiGetRaw.bind(od.client);
    od.client.apiGetRaw = (path, params, opts) => {
      if (path === '/periomeasures') {
        const row = app.db.hyg_staged_write.find((w) => w.kind === 'perio');
        od.state.order.push(`GET measures (perio ${row.state})`);
      }
      return getRaw(path, params, opts);
    };
    try {
      const visit = await stageVisit(app);
      od.state.order.length = 0;
      const res = await sendVisit(app, [perioConfirm(visit)]);
      assert.equal(outcomeOf(res, 'perio').state, 'Written');
      assert.deepEqual(
        od.state.order,
        ['POST exam 7001', 'GET measures (perio Sending)'],
        'the exam, then EVERY measure read back while the chart still said Sending'
      );
      assert.equal(states(app).perio, 'Written', 'and only then Written');
    } finally {
      await app.close();
    }
  }

  // A site Open Dental holds differently: NOT Written, the site named, the note untouched.
  const od = visitFake({
    corrupt: (state, exam) => {
      const row = state.measures.find(
        (m) => m.PerioExamNum === exam.PerioExamNum && m.IntTooth === 3 && m.SequenceType === 'Probing'
      );
      row.DBvalue = 9;
    },
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const visit = await stageVisit(app);
    const res = await sendVisit(app, [plainConfirm(visit, 'note'), perioConfirm(visit)]);
    assert.equal(outcomeOf(res, 'note').state, 'Written');
    const perio = outcomeOf(res, 'perio');
    assert.equal(perio.state, 'Failed', 'a mismatch is never Written');
    assert.match(perio.errorMessage, /does not match this chart at 1 place: #3 DB/);
    assert.match(perio.errorMessage, /understates disease/);
    const page = await api(app.baseUrl, 'GET', BASE + '/perio/send' + Q);
    assert.equal(page.body.send.state, 'incomplete');
    assert.equal(page.body.send.canDelete, true, 'the undo is on the chart page');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 7: Retry on an interrupted perio unit RESUMES — the exam the interrupted send created is adopted, never posted twice', async () => {
  // The exam POST lands in Open Dental and its answer never comes back.
  let n = 0;
  const od = visitFake({
    onExam: () => (++n === 1 ? { ok: false, status: 503, data: null, error: 'upstream timeout', landed: true } : null),
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const visit = await stageVisit(app);
    const res = await sendVisit(app, [plainConfirm(visit, 'note'), perioConfirm(visit)]);
    assert.equal(res.status, 200);
    assert.equal(outcomeOf(res, 'note').state, 'Written');
    const perio = outcomeOf(res, 'perio');
    assert.equal(perio.state, 'Sending', 'we tried and do not know — not Failed, not Staged');
    assert.equal(perio.code, 'PERIO_PAUSED');
    assert.match(perio.errorMessage, /did not answer for the exam/);
    assert.equal(od.state.exams.length, 1, 'the exam IS in Open Dental');

    // A second visit Send cannot re-post it: the chart is not Staged.
    const again = await sendVisit(app, [perioConfirm(visit)]);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'NOT_STAGED');

    // THE RETRY: the tray asks the chart's own step route, which reads before it writes.
    const retry = await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.send.state, 'written', JSON.stringify(retry.body.send));
    assert.equal(retry.body.stagedWrite.state, 'Written');
    assert.equal(examPosts(od.state).length, 1, 'ONE exam POST, ever');
    assert.equal(od.state.exams.length, 1, 'ONE exam in Open Dental');
    assert.equal(retry.body.send.examNum, 7001, 'the exam the interrupted send created, adopted');
    assert.equal(noteWrites(od.client), 1, 'and the note was not touched again');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 8: Draft, Amending, in-flight, Written and a staged correction are refused server-side — nothing written', async () => {
  const od = visitFake();
  const app = await bootHygApp({ od: od.client });
  try {
    // Draft: stored, never staged.
    assert.equal((await api(app.baseUrl, 'POST', BASE + '/open' + Q)).status, 200);
    await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: fullMouth() } });
    const draft = await sendVisit(app, [
      { kind: 'perio', previewFingerprint: 'anything', examDate: DATE, provNum: 7 },
    ]);
    assert.equal(draft.status, 409);
    assert.equal(draft.body.code, 'NOT_STAGED');
    assert.deepEqual(od.client.writes, []);

    // In flight: claimed by a send that has not finished.
    const staged = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
    const visit = staged.body.visit;
    app.db.hyg_staged_write.find((w) => w.kind === 'perio').state = 'Sending';
    const inFlight = await sendVisit(app, [perioConfirm(visit)]);
    assert.equal(inFlight.status, 409);
    assert.equal(inFlight.body.code, 'NOT_STAGED');
    assert.deepEqual(od.client.writes, []);
    app.db.hyg_staged_write.find((w) => w.kind === 'perio').state = 'Staged';

    // Written: a real send, then a second confirmation of the same chart.
    const first = await sendVisit(app, [perioConfirm(visit)]);
    assert.equal(outcomeOf(first, 'perio').state, 'Written');
    const writes = od.client.writes.length;
    const written = await sendVisit(app, [perioConfirm(visit)]);
    assert.equal(written.status, 409);
    assert.equal(written.body.code, 'NOT_STAGED');

    // Amending: opened for a correction on the chart page.
    const amend = await api(app.baseUrl, 'POST', BASE + '/perio/amend' + Q);
    assert.equal(amend.status, 200, JSON.stringify(amend.body));
    assert.equal(amend.body.stagedWrite.state, 'Amending');
    const amending = await sendVisit(app, [perioConfirm(visit)]);
    assert.equal(amending.status, 409);
    assert.equal(amending.body.code, 'NOT_STAGED');

    // A STAGED correction: sent from the chart page only.
    const corrected = contract.withPerioSite(fullMouth(), 3, 'DB', { depth: 5 });
    await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: corrected } });
    const restaged = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
    assert.equal(restaged.status, 201, JSON.stringify(restaged.body));
    const correction = await sendVisit(app, [perioConfirm(restaged.body.visit)]);
    assert.equal(correction.status, 422);
    assert.equal(correction.body.code, 'PERIO_SENDS_FROM_ITS_CHART');
    assert.match(correction.body.error, /correction to exam 7001/);
    assert.equal(states(app).perio, 'Staged', 'left exactly where it was');

    assert.equal(od.client.writes.length, writes, 'not one Open Dental write after the first send');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 9: a send in flight from the chart page shows on the visit, and the visit Send cannot start a second', async () => {
  let answer = false;
  const od = visitFake({ onExam: () => (answer ? null : { ok: false, status: 503, data: null, error: 'down' }) });
  const app = await bootHygApp({ od: od.client });
  try {
    const visit = await stageVisit(app);
    // Started on the CHART page, and paused there.
    const started = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, {
      body: { previewFingerprint: writeOf(visit, 'perio').previewFingerprint, examDate: DATE, provNum: 7 },
    });
    assert.equal(started.body.send.state, 'posting');

    // The visit reads it as in flight…
    const page = await api(app.baseUrl, 'GET', BASE + Q);
    assert.equal(writeOf(page.body.visit, 'perio').state, 'Sending');
    const progress = await api(app.baseUrl, 'GET', BASE + '/perio/send' + Q);
    assert.equal(progress.body.send.state, 'posting');

    // …and its Send cannot start a second one. The note still goes on its own.
    const refused = await sendVisit(app, [plainConfirm(visit, 'note'), perioConfirm(visit)]);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'NOT_STAGED');
    assert.deepEqual(od.client.writes.filter((w) => w[2] === '/procedurelogs/GroupNote'), []);
    const noteOnly = await sendVisit(app, [plainConfirm(visit, 'note')]);
    assert.equal(outcomeOf(noteOnly, 'note').state, 'Written');
    assert.equal(app.db.hyg_perio_send.length, 1, 'still ONE send');

    // The other direction: started from the VISIT, it is the chart page's send too.
    answer = true;
    const resumed = await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q);
    assert.equal(resumed.body.send.state, 'written');
    assert.equal(examPosts(od.state).length, 2, 'the one that did not land, then the one that did');
    assert.equal(od.state.exams.length, 1);
  } finally {
    await app.close();
  }

  const od2 = visitFake({ onExam: () => ({ ok: false, status: 503, data: null, error: 'down' }) });
  const app2 = await bootHygApp({ od: od2.client });
  try {
    const visit = await stageVisit(app2, { kinds: [] });
    const res = await sendVisit(app2, [perioConfirm(visit)]);
    assert.equal(outcomeOf(res, 'perio').state, 'Sending');
    const chartPage = await api(app2.baseUrl, 'GET', BASE + '/perio/send' + Q);
    assert.equal(chartPage.body.send.state, 'posting', 'the chart page sees the visit-started send');
    assert.equal(chartPage.body.stagedWrite.state, 'Sending');
    const second = await api(app2.baseUrl, 'POST', BASE + '/perio/send' + Q, {
      body: { previewFingerprint: writeOf(visit, 'perio').previewFingerprint, examDate: DATE, provNum: 7 },
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'PERIO_SEND_IN_PROGRESS', 'nor can the chart page start another');
  } finally {
    await app2.close();
  }
});

test('ACCEPTANCE 10: pressing the visit Send twice cannot double-write any unit — in sequence or at once', async () => {
  {
    const od = visitFake();
    const app = await bootHygApp({ od: od.client });
    try {
      const visit = await stageVisit(app, { kinds: ['note'] });
      const confirm = [plainConfirm(visit, 'note'), perioConfirm(visit)];
      const first = await sendVisit(app, confirm);
      assert.equal(first.status, 200);
      const writes = od.client.writes.length;
      const second = await sendVisit(app, confirm);
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'NOT_STAGED');
      assert.equal(od.client.writes.length, writes, 'the second press wrote nothing');
    } finally {
      await app.close();
    }
  }

  const od = visitFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const visit = await stageVisit(app, { kinds: ['note'] });
    const confirm = [plainConfirm(visit, 'note'), perioConfirm(visit)];
    const [a, b] = await Promise.all([sendVisit(app, confirm), sendVisit(app, confirm)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], `one send, one refusal: ${a.status} ${b.status}`);
    assert.equal(noteWrites(od.client), 1, 'ONE note');
    assert.equal(examPosts(od.state).length, 1, 'ONE exam');
    assert.equal(od.state.exams.length, 1);
    assert.equal(app.db.hyg_perio_send.length, 1, 'ONE recorded send');
  } finally {
    await app.close();
  }
});
