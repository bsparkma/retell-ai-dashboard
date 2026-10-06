'use strict';

/**
 * THE TWO PLACES AN UNINTERPRETABLE v2 VALUE STILL WENT QUIET (H4 item 32).
 *
 * Item 31 taught `chartFromMeasures` to list v2 values it cannot interpret, and
 * made drift answer `unknown` rather than `matches` for them. Two surfaces still
 * read such a value as "nothing charted":
 *
 *   1. The correction path. `readExamChart` took only `.chart`, so a correction
 *      could supersede an exam holding a value somebody put there. It now
 *      REFUSES `AMEND_BASE_UNREADABLE`, naming the position first — at Amend,
 *      and again at send time. The refusal PREVENTS a write; nothing is written.
 *   2. `unknown` meant one thing on screen. It now carries a `reason`:
 *      `unreadable_od` (transient, silent — item 14 unchanged) or
 *      `uninterpretable` (durable, named on a quiet line).
 *
 * The screen half is new-dashboard/tests/hyg-perio-uninterpretable.test.tsx.
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

/** A recession, a furcation and a mobility beside a probing depth. #3 is a molar. */
function v2Chart() {
  let chart = contract.emptyPerioChart();
  chart = contract.withPerioSite(chart, 3, 'B', { depth: 4, gm: 2 });
  chart = contract.withPerioSite(chart, 3, 'ML', { furcation: 2 });
  chart = contract.withPerioMobility(chart, 3, 1);
  return contract.normalizePerioChart(chart);
}

async function drain(app, res, limit = 400) {
  let current = res;
  for (let i = 0; i < limit; i += 1) {
    if (current.status !== 200) return current;
    const s = current.body.send;
    if (!s || !['posting', 'filling'].includes(s.state) || current.body.paused) return current;
    current = await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q);
  }
  return current;
}

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
  return done.body.send.examNum;
}

/** Somebody edits one v2 row in Open Dental's own perio chart. Not through CareIN. */
function editInOpenDental(od, examNum, tooth, type, key, value) {
  const row = od.state.measures.find(
    (m) => m.PerioExamNum === examNum && m.IntTooth === tooth && m.SequenceType === type
  );
  assert.ok(row, `no ${type} row for #${tooth} in exam ${examNum}`);
  row[key] = value;
  od.publish();
}

const prior = (app) => api(app.baseUrl, 'GET', BASE + '/perio/prior' + Q);
const amend = (app) => api(app.baseUrl, 'POST', BASE + '/perio/amend' + Q);
const perioStaged = (app) => app.db.hyg_staged_write.find((w) => w.kind === 'perio');
const driftAudits = (app) => app.db.audit.filter((r) => r.resource_type === 'hyg_perio_drift');

/** Everything a refusal must leave exactly as it was: OD's writes, and our own rows. */
function snapshot(app, od) {
  return JSON.stringify({
    order: od.state.order,
    posts: od.state.posts.length,
    deletes: od.state.deletes.length,
    staged: perioStaged(app),
    sends: app.db.hyg_perio_send,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 1 — the correction path refuses AMEND_BASE_UNREADABLE
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 1: Amend on an exam holding an uninterpretable value refuses AMEND_BASE_UNREADABLE, naming it first, and changes nothing', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, v2Chart());
    // 50 is in neither gingival-margin family: CareIN cannot interpret it.
    editInOpenDental(od, examNum, 3, 'GingMargin', 'Bvalue', 50);
    const before = snapshot(app, od);

    const refused = await amend(app);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'AMEND_BASE_UNREADABLE');
    const firstSentence = refused.body.error.split('. ')[0];
    assert.match(firstSentence, /#3 B gingival margin/, 'the FIRST sentence names the position');
    assert.match(firstSentence, new RegExp(`Exam ${examNum}`));
    assert.doesNotMatch(refused.body.error, /\b50\b/, 'the uninterpretable value itself is never printed');

    assert.equal(snapshot(app, od), before, 'nothing was written to Open Dental, and nothing in CareIN moved');
    assert.equal(perioStaged(app).state, 'Written', 'the chart was NOT opened for a correction');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 1: a value that turns uninterpretable AFTER Amend refuses at send time, and writes nothing', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, v2Chart());
    const opened = await amend(app);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const corrected = contract.withPerioSite(v2Chart(), 3, 'B', { depth: 6 });
    assert.equal((await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: corrected } })).status, 200);
    const staged = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
    assert.equal(staged.status, 201, JSON.stringify(staged.body));
    const write = staged.body.visit.stagedWrites.find((w) => w.kind === 'perio');

    // Somebody grades #3's mobility 7 in Open Dental meanwhile.
    editInOpenDental(od, examNum, 3, 'Mobility', 'ToothValue', 7);
    const orderBefore = od.state.order.slice();
    const postsBefore = od.state.posts.length;

    const refused = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, {
      body: { previewFingerprint: write.previewFingerprint, examDate: DATE, provNum: 7 },
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    // NOT AMEND_BASE_CHANGED: that would call the position "not charted", and
    // something IS charted there.
    assert.equal(refused.body.code, 'AMEND_BASE_UNREADABLE');
    assert.match(refused.body.error.split('. ')[0], /#3 mobility/);
    assert.match(refused.body.error, /Nothing was sent/);
    assert.deepEqual(od.state.order, orderBefore, 'no exam posted, nothing deleted');
    assert.equal(od.state.posts.length, postsBefore);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 1: a fully readable exam still opens for a correction (the refusal is not a blanket one)', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    await writeChart(app, v2Chart());
    const opened = await amend(app);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.stagedWrite.state, 'Amending');
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 2/3/4 — the drift answer carries the reason
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 2: an Open Dental that cannot be read is `unknown` for `unreadable_od`, names nothing, audits nothing', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, v2Chart());
    od.client.routes['/perioexams'] = { ok: false, status: 503, data: null, error: 'Service Unavailable' };

    const answer = await prior(app);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body.drift, { status: 'unknown', reason: 'unreadable_od', examNum, positions: [] });
    assert.equal(driftAudits(app).length, 0, 'a failed read discloses nothing, so nothing is audited');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 3: an uninterpretable value is `unknown` for `uninterpretable`, naming where and never what', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, v2Chart());
    editInOpenDental(od, examNum, 3, 'GingMargin', 'Bvalue', 50);

    const answer = await prior(app);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body.drift, {
      status: 'unknown',
      reason: 'uninterpretable',
      examNum,
      positions: [{ tooth: 3, surface: 'B', kind: 'gm' }],
    });
    assert.equal('raw' in answer.body.drift.positions[0], false, 'the raw value never leaves the server');
    assert.equal(
      contract.perioUnreadableList(answer.body.drift.positions),
      '#3 B gingival margin',
      'the same words the refusal uses'
    );

    // `unknown` writes no drift audit row for either reason (item 31's ruling,
    // pinned by hygPerioV2Drift ACCEPTANCE 8).
    assert.deepEqual(driftAudits(app), []);
  } finally {
    await app.close();
  }
});

test('perioUnreadableList: position + family, a tooth CareIN cannot place, and the count past three', () => {
  assert.equal(contract.perioUnreadableRef({ tooth: 30, surface: null, kind: 'mobility' }), '#30 mobility');
  assert.equal(contract.perioUnreadableRef({ tooth: 3, surface: 'ML', kind: 'furcation' }), '#3 ML furcation');
  assert.equal(
    contract.perioUnreadableRef({ tooth: -1, surface: null, kind: 'mobility' }),
    'mobility on a tooth CareIN cannot place'
  );
  const four = [
    { tooth: 3, surface: 'B', kind: 'gm' },
    { tooth: 4, surface: 'B', kind: 'gm' },
    { tooth: 5, surface: 'B', kind: 'gm' },
    { tooth: 6, surface: 'B', kind: 'gm' },
  ];
  assert.equal(
    contract.perioUnreadableList(four),
    '#3 B gingival margin, #4 B gingival margin, #5 B gingival margin and 1 more'
  );
});
