'use strict';

/**
 * THE CHART IN OPEN DENTAL IS NO LONGER WHAT CAREIN WROTE (H4 item 14).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS ARE ABOUT
 * ═════════════════════════════════════════════════════════════════════════════
 * `Written` is a claim — "exam 2260, every site read back and matching" — that
 * CareIN makes forever on the strength of a read it did once. Open Dental's own
 * perio chart has a Delete button. So the claim is re-checked when the chart is
 * OPENED, and the answer is one of four things, only two of which say anything.
 *
 * TWO OF THESE TESTS EXIST TO STOP A FIX, NOT TO PROVE ONE:
 *
 *   `changed` MUST NOT OFFER A RESEND. A reading that differs is a human who
 *   corrected the chart in Open Dental. Resending would create a duplicate exam
 *   and bury their correction under CareIN's stale numbers.
 *
 *   `unknown` MUST SAY NOTHING. A read that failed is not evidence the exam is
 *   gone. Same doctrine as NOTE_PRECHECK_UNAVAILABLE.
 *
 * The acceptance, as tests:
 *   1. A Written chart whose exam is GONE says so and offers Send again.
 *   2. A Written chart that MATCHES says nothing and adds no request.
 *   3. A Written chart whose sites DIFFER names them and offers NO resend.
 *   4. An unreadable Open Dental leaves the Written line unqualified.
 *   5. The resend confirmation lists every same-date exam, CareIN's or not.
 *   6. The resend creates a NEW exam number and reads back every site.
 *   7. The check fires on open only — no timer, no poll.
 *   8. The disclosure audits; the re-read alone does not.
 *
 * NO PHI: 12827 is the designated roland fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { bootHygApp, api, perioOd } = require('./hygTestUtils');
const contract = require('../../hyg/contract.gen.cjs');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const BASE = '/api/hyg/visit/900001';

const perioFake = (opts) => perioOd({ date: DATE, patNum: 12827, ...opts });

/** A small chart: one arch string's worth, so a send is one write. */
function someChart(depth = (i) => (i % 4) + 2) {
  let chart = contract.emptyPerioChart();
  contract.PERIO_ARCH_STRING_SITES.UpperFacial.forEach((c, i) => {
    chart = contract.withPerioSite(chart, c.tooth, c.surface, { depth: depth(i) });
  });
  return contract.normalizePerioChart(chart);
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

/** A chart written to Open Dental and read back — the state every test starts from. */
async function writeChart(app, chart) {
  await api(app.baseUrl, 'POST', BASE + '/open' + Q);
  const put = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const staged = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  const write = staged.body.visit.stagedWrites.find((w) => w.kind === 'perio');
  const done = await drain(
    app,
    await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, {
      body: { previewFingerprint: write.previewFingerprint, examDate: DATE, provNum: 7 },
    })
  );
  assert.equal(done.body.send.state, 'written', JSON.stringify(done.body.send));
  assert.equal(done.body.stagedWrite.state, 'Written');
  return done.body.send.examNum;
}

const prior = (app) => api(app.baseUrl, 'GET', BASE + '/perio/prior' + Q);
const resend = (app, examNum) => api(app.baseUrl, 'POST', BASE + '/perio/resend' + Q, { body: { examNum } });

function driftAudits(app) {
  return app.db.audit.filter((r) => String(r.resource_type).startsWith('hyg_perio_drift'));
}

/** Somebody deletes the exam in Open Dental's own perio chart. Not through CareIN. */
function deleteInOpenDental(od, examNum) {
  od.state.exams = od.state.exams.filter((e) => e.PerioExamNum !== examNum);
  od.state.measures = od.state.measures.filter((m) => m.PerioExamNum !== examNum);
  od.publish();
}

/** Somebody EDITS one site in Open Dental's own perio chart. */
function editInOpenDental(od, examNum, tooth, valueKey, value) {
  const row = od.state.measures.find(
    (m) => m.PerioExamNum === examNum && m.IntTooth === tooth && m.SequenceType === 'Probing'
  );
  assert.ok(row, `no Probing row for #${tooth} in exam ${examNum}`);
  row[valueKey] = value;
  od.publish();
}

test('ACCEPTANCE 1: a Written chart whose exam is GONE from Open Dental says so, and offers Send again', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, someChart());
    deleteInOpenDental(od, examNum);

    const answer = await prior(app);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.drift.status, 'missing');
    assert.equal(answer.body.drift.examNum, examNum);
    // The contract validates it, so the screen's discriminated union is honoured.
    assert.equal(contract.PerioDriftSchema.safeParse(answer.body.drift).success, true);

    // And the resend it offers works: the chart becomes sendable again.
    const again = await resend(app, examNum);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.stagedWrite.state, 'Staged');
    // The false claim is gone with it.
    assert.equal(again.body.stagedWrite.writtenRef, null);
    // The send that wrote exam N is no longer the live one…
    assert.equal(again.body.live, null);
    // …but the record of what it wrote is not lost.
    const row = app.db.hyg_perio_send.find((r) => Number(r.exam_num) === examNum);
    assert.ok(row.chart, 'the chart the send wrote is still on the row');
    assert.equal(row.state, 'written', 'its history is not rewritten');
    assert.ok(row.exam_gone_at instanceof Date);
    assert.equal(row.exam_gone_by, 'hygienist@carein.ai');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 2: a Written chart whose exam MATCHES offers nothing, and costs no request beyond the prior read', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, someChart());

    // The prior read on its own is one /perioexams and one /periomeasures. The
    // drift check has to ride those two, not add a third.
    const before = app.od.calls.length;
    const answer = await prior(app);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.drift.status, 'matches');
    assert.equal(answer.body.drift.examNum, examNum);

    const made = app.od.calls.slice(before).filter((c) => c.path.startsWith('/perio'));
    assert.deepEqual(
      made.map((c) => c.path),
      ['/perioexams', '/periomeasures'],
      'one exam-list read and one measures read — the prior panel already needed both'
    );

    // Nothing is offered, and nothing can be: the chart is still Written.
    const refused = await resend(app, examNum);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'PERIO_EXAM_PRESENT');
    assert.match(refused.body.error, /IS in Open Dental/);
    assert.equal(app.db.hyg_staged_write.find((w) => w.kind === 'perio').state, 'Written');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 3: a Written chart whose sites DIFFER names the sites and offers NO resend', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, someChart());
    // A hygienist corrects #8 MB in Open Dental itself. Her correction is the
    // thing a resend would destroy.
    editInOpenDental(od, examNum, 8, 'MBvalue', 7);

    const answer = await prior(app);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.drift.status, 'changed');
    assert.equal(answer.body.drift.examNum, examNum);
    assert.equal(contract.PerioDriftSchema.safeParse(answer.body.drift).success, true);

    // It NAMES the sites.
    const refs = answer.body.drift.changes.map(contract.perioChangeSiteRef);
    assert.ok(refs.includes('#8 MB'), 'the changed site is named: ' + refs.join(', '));
    assert.ok(
      answer.body.drift.changes.every((c) => c.from !== c.to),
      'every reported change is an actual difference'
    );

    // AND THERE IS NO RESEND. Not on the wire, not by asking for it directly.
    assert.equal('sameDateExams' in answer.body.drift, false, 'a changed chart is offered no exam list');
    const refused = await resend(app, examNum);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'PERIO_EXAM_PRESENT');
    // Open Dental is untouched: her correction is still there, and there is no
    // second exam beside it.
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [examNum]);
    assert.deepEqual(od.state.deletes, []);
    assert.equal(
      od.state.measures.find((m) => m.PerioExamNum === examNum && m.IntTooth === 8 && m.SequenceType === 'Probing')
        .MBvalue,
      7
    );
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 4: an Open Dental that cannot be read leaves the Written line unqualified and offers nothing', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, someChart());

    // The exam list refuses. A refusal is NOT an absence.
    od.client.routes['/perioexams'] = { ok: false, status: 503, data: null, error: 'Service Unavailable' };

    const answer = await prior(app);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.prior.status, 'unavailable', 'the prior panel says it could not read');
    assert.equal(answer.body.drift.status, 'unknown', 'and the drift check says nothing at all');
    assert.equal(answer.body.drift.examNum, examNum);
    assert.equal('sameDateExams' in answer.body.drift, false);

    // A truncated list is the same answer, for the same reason: an exam missing
    // from half a list is not missing from the chart.
    od.client.routes['/perioexams'] = Array.from({ length: 100 }, (_, i) => ({
      PerioExamNum: 8000 + i,
      PatNum: 12827,
      ExamDate: DATE,
      ProvNum: 7,
    }));
    delete od.client.routes['/perioexams?Offset=100'];
    const truncated = await prior(app);
    assert.equal(truncated.body.drift.status, 'unknown');

    // And the resend refuses rather than acting on a read it could not finish.
    od.client.routes['/perioexams'] = { ok: false, status: 503, data: null, error: 'Service Unavailable' };
    const refused = await resend(app, examNum);
    assert.equal(refused.status, 502);
    assert.equal(refused.body.code, 'OD_READ_FAILED');
    assert.equal(app.db.hyg_staged_write.find((w) => w.kind === 'perio').state, 'Written');
    assert.equal(app.db.hyg_perio_send.find((r) => Number(r.exam_num) === examNum).exam_gone_at, null);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 5: the resend answer lists EVERY same-date exam, including ones CareIN did not write', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, someChart());
    // She deleted CareIN's exam and re-charted the visit by hand in Open Dental.
    deleteInOpenDental(od, examNum);
    od.state.exams.push({ PerioExamNum: 9100, PatNum: 12827, ExamDate: DATE, ProvNum: 7 });
    // …and there is an older exam on another date, which is NOT this visit's.
    od.state.exams.push({ PerioExamNum: 9101, PatNum: 12827, ExamDate: '2026-03-02', ProvNum: 7 });
    od.publish();

    const answer = await prior(app);
    assert.equal(answer.body.drift.status, 'missing');
    const listed = answer.body.drift.sameDateExams;
    assert.deepEqual(
      listed.map((e) => e.examNum),
      [9100],
      'the hand-charted exam on this visit’s date is listed; the other date is not'
    );
    assert.equal(listed[0].careinWrote, false, 'CareIN did not write it, and the screen must be able to say so');
    assert.equal(listed[0].examDate, DATE);

    // An exam CareIN's OWN sends created is listed as ours. The flag is answered
    // from this chart's send rows, so a send that got as far as an exam number
    // and then failed still counts — its exam is in Open Dental either way.
    const careinExam = Number(
      app.db.hyg_perio_send.find((r) => r.exam_num !== null).exam_num
    );
    od.state.exams.push({ PerioExamNum: careinExam, PatNum: 12827, ExamDate: DATE, ProvNum: 7 });
    od.publish();
    const back = await prior(app);
    // Its header is back but its readings are not, so the answer is `changed`,
    // not `missing` — and a changed chart is offered no list, by design.
    assert.equal(back.body.drift.status, 'changed');

    // Take it away again and the list names both, each flagged honestly.
    deleteInOpenDental(od, careinExam);
    od.state.exams.push({ PerioExamNum: 7002, PatNum: 12827, ExamDate: DATE, ProvNum: 7 });
    od.publish();
    const mixed = await prior(app);
    assert.deepEqual(
      mixed.body.drift.sameDateExams.map((e) => [e.examNum, e.careinWrote]),
      [[7002, false], [9100, false]],
      'every exam on the date, each honestly flagged'
    );
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 6: the resend creates a NEW exam number, and reads back every site before Written', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const chart = someChart();
    const first = await writeChart(app, chart);
    deleteInOpenDental(od, first);

    const again = await resend(app, first);
    assert.equal(again.status, 200, JSON.stringify(again.body));

    // The ordinary send path, re-run. Nothing new: same confirm, same steps.
    const staged = again.body.stagedWrite;
    const done = await drain(
      app,
      await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, {
        body: { previewFingerprint: staged.previewFingerprint, examDate: DATE, provNum: 7 },
      })
    );
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.send.state, 'written');
    assert.notEqual(done.body.send.examNum, first, 'a NEW exam number — the old one is not resurrected');
    assert.equal(done.body.stagedWrite.state, 'Written');

    // It is a FIRST send, not an amendment: there was nothing to supersede.
    assert.equal(done.body.send.supersedesExamNum, null);
    assert.deepEqual(done.body.send.mismatches, []);

    // EVERY SITE WAS READ BACK, and matches the chart. `writtenChart` is what
    // the send read back, so comparing it to the chart is the read-back claim.
    assert.deepEqual(contract.comparePerioReadback(chart, done.body.send.writtenChart), []);
    assert.match(done.body.stagedWrite.writtenRef, /read back and match/);

    // The old exam was never re-created, and nothing was deleted to do any of it.
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [done.body.send.examNum]);
    assert.deepEqual(od.state.deletes, []);

    // Opening the chart again now says nothing: the new exam is the live one.
    const settled = await prior(app);
    assert.equal(settled.body.drift.status, 'matches');
    assert.equal(settled.body.drift.examNum, done.body.send.examNum);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 7: the check fires on open only — there is no timer, no poll, and no auto-resend', async () => {
  const SOURCES = [
    '../../services/hyg/perioDrift.js',
    '../../services/hyg/perioSendStore.js',
    'visit.js',
  ].map((f) => ({ file: f, src: fs.readFileSync(path.join(__dirname, f), 'utf8') }));

  for (const { file, src } of SOURCES) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const pattern of [/setInterval/, /setTimeout/, /cron/i, /\.schedule\(/, /node-cron/]) {
      assert.doesNotMatch(code, pattern, `${file} must hold no timer or schedule: ${pattern}`);
    }
  }

  // And behaviourally: the drift check is only ever reached from the READ route.
  // The resend service is the only thing that changes state, and it is only ever
  // reached from a POST — so a GET can never re-arm a send.
  const od = perioOd({ date: DATE, patNum: 12827 });
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, someChart());
    od.state.exams = od.state.exams.filter((e) => e.PerioExamNum !== examNum);
    od.publish();

    // Read it as many times as you like. It says the same thing and changes nothing.
    for (let i = 0; i < 3; i += 1) {
      const answer = await prior(app);
      assert.equal(answer.body.drift.status, 'missing');
      assert.equal(app.db.hyg_staged_write.find((w) => w.kind === 'perio').state, 'Written');
      assert.equal(app.db.hyg_perio_send.find((r) => Number(r.exam_num) === examNum).exam_gone_at, null);
    }
    // No write verb was reached on any of them.
    assert.deepEqual(od.state.posts, od.state.posts.filter((p) => p.path === '/perioexams' || p.path === '/periomeasures'));
    const postsAfter = od.state.posts.length;
    await prior(app);
    assert.equal(od.state.posts.length, postsAfter, 'a re-read posts nothing');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 8: the disclosure audits, with the answer and the exam; the re-read alone does not', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, someChart());

    // MATCHES: nothing is said, so nothing is disclosed, so nothing is recorded.
    await prior(app);
    assert.deepEqual(driftAudits(app), [], 'a re-read that says nothing writes no drift row');

    // MISSING: a statement about what a chart of record does not contain.
    deleteInOpenDental(od, examNum);
    await prior(app);
    let rows = driftAudits(app);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'READ');
    assert.equal(rows[0].resource_type, 'hyg_perio_drift');
    assert.equal(Number(rows[0].resource_id), 900001);
    assert.equal(rows[0].office, 'roland');
    assert.equal(rows[0].source_ref, 'perio_exam:' + examNum);
    assert.equal(rows[0].prior_state, 'missing', 'WHICH of the answers it was');
    assert.equal(rows[0].user_id, 'hygienist@carein.ai');

    // UNKNOWN: CareIN could not see, so it said nothing, so it recorded nothing.
    od.client.routes['/perioexams'] = { ok: false, status: 503, data: null, error: 'Service Unavailable' };
    await prior(app);
    assert.equal(driftAudits(app).length, 1, 'an unreadable Open Dental discloses nothing');

    // NO READINGS ANYWHERE IN THE TRAIL. audit_log carries identifiers only.
    for (const row of driftAudits(app)) {
      assert.equal(row.prior_state.includes('mm'), false);
      assert.match(String(row.source_ref), /^perio_exam:\d+$/);
    }
  } finally {
    await app.close();
  }

  // CHANGED is also a disclosure, and is recorded as its own answer. On its own
  // chart, because an exam whose HEADER was put back still has no readings — the
  // delete above took those with it, and that is `changed`, not a way back.
  const od2 = perioFake();
  const app2 = await bootHygApp({ od: od2.client });
  try {
    const examNum = await writeChart(app2, someChart());
    editInOpenDental(od2, examNum, 8, 'MBvalue', 7);
    await prior(app2);
    const rows = driftAudits(app2);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'READ');
    assert.equal(rows[0].prior_state, 'changed');
    assert.equal(rows[0].source_ref, 'perio_exam:' + examNum);
  } finally {
    await app2.close();
  }
});

test('the resend is refused for a chart that is not Written, and for the wrong exam number', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, someChart());
    deleteInOpenDental(od, examNum);

    // A number that is not this chart's exam cannot re-arm it.
    const wrong = await resend(app, examNum + 50);
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.code, 'NOT_RESENDABLE');
    assert.equal(app.db.hyg_staged_write.find((w) => w.kind === 'perio').state, 'Written');

    // Once re-armed, a second press has nothing to re-arm: the chart is Staged.
    assert.equal((await resend(app, examNum)).status, 200);
    const twice = await resend(app, examNum);
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, 'NOT_RESENDABLE');
    // And the drift check has nothing to check any more.
    assert.equal((await prior(app)).body.drift.status, 'not_applicable');
  } finally {
    await app.close();
  }
});

test('a chart that was never sent is never drift-checked, and never audited for it', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    await api(app.baseUrl, 'POST', BASE + '/open' + Q);
    const answer = await prior(app);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.drift.status, 'not_applicable');
    assert.deepEqual(driftAudits(app), []);

    // A STAGED chart makes no claim either.
    await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: someChart() } });
    await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
    assert.equal((await prior(app)).body.drift.status, 'not_applicable');
    assert.deepEqual(driftAudits(app), []);
  } finally {
    await app.close();
  }
});

test('the drift check reads the live exam directly when a NEWER exam exists in Open Dental', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, someChart());
    // Somebody charts a second, newer exam by hand. CareIN's is no longer the
    // newest, so the prior panel's measures read is about the wrong exam.
    od.state.exams.push({ PerioExamNum: 9200, PatNum: 12827, ExamDate: '2026-09-20', ProvNum: 7 });
    od.publish();

    const before = app.od.calls.length;
    const answer = await prior(app);
    assert.equal(answer.body.prior.examNum, 9200, 'the prior panel shows the NEWEST exam');
    assert.equal(answer.body.drift.status, 'matches', 'and the drift check still checks CareIN’s own');
    assert.equal(answer.body.drift.examNum, examNum);

    // It cost exactly one extra measures read, and only because of this.
    const made = app.od.calls.slice(before).filter((c) => c.path.startsWith('/perio'));
    assert.deepEqual(made.map((c) => c.path), ['/perioexams', '/periomeasures', '/periomeasures']);
    assert.equal(made[2].params.PerioExamNum, examNum);
  } finally {
    await app.close();
  }
});

test('a truncated measures read on the live exam is `unknown`, never `changed`', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, someChart());
    // A partial read of the exam's readings would show the missing sites as
    // changed. It must not: a partial chart is not a chart to compare against.
    od.client.routes['/periomeasures'] = Array.from({ length: 100 }, (_, i) => ({
      PerioMeasureNum: 50000 + i,
      PerioExamNum: examNum,
      SequenceType: 'Probing',
      IntTooth: (i % 32) + 1,
      ToothValue: -1,
      MBvalue: -1,
      Bvalue: -1,
      DBvalue: -1,
      MLvalue: -1,
      Lvalue: -1,
      DLvalue: -1,
    }));
    delete od.client.routes['/periomeasures?Offset=100'];

    const answer = await prior(app);
    assert.equal(answer.body.prior.status, 'found');
    assert.equal(answer.body.prior.truncated, true, 'the prior panel says some readings are missing');
    assert.equal(answer.body.drift.status, 'unknown', 'and the drift check refuses to draw a conclusion');
    assert.deepEqual(driftAudits(app), []);
  } finally {
    await app.close();
  }
});
