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

    // Naming teeth is the disclosure, so it audits: ONE row, identifiers only.
    const rows = driftAudits(app);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'READ');
    assert.equal(Number(rows[0].resource_id), 900001);
    assert.equal(rows[0].office, 'roland');
    assert.equal(rows[0].prior_state, 'unknown:uninterpretable');
    assert.match(rows[0].prior_state, /^[a-z0-9_]{1,32}(:[a-z0-9_]{1,31})?$/, 'fits the audit_log prior_state CHECK');
    assert.equal(rows[0].source_ref, `perio_exam:${examNum};3-B:gm`);
    assert.doesNotMatch(JSON.stringify(rows[0]), /50/, 'the raw value is nowhere in the trail');
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The audit is fail-CLOSED: no trail, no answer — exactly as for `changed`
// ─────────────────────────────────────────────────────────────────────────────

/** Fail ONLY the drift row's INSERT, so the earlier read audits on the route still land. */
function failDriftAudit(app) {
  const real = app.db.query.bind(app.db);
  app.db.query = async (sql, params = []) => {
    if (/INSERT INTO audit_log/i.test(String(sql)) && params.includes('hyg_perio_drift')) {
      throw new Error('simulated audit_log outage');
    }
    return real(sql, params);
  };
}

test('fail-closed: when the drift audit cannot be written, an uninterpretable answer is withheld, exactly as `changed` is', async () => {
  const cases = [
    ['changed', (od, n) => editInOpenDental(od, n, 3, 'GingMargin', 'Bvalue', 4)],
    ['uninterpretable', (od, n) => editInOpenDental(od, n, 3, 'GingMargin', 'Bvalue', 50)],
  ];
  for (const [label, edit] of cases) {
    const od = perioFake();
    const app = await bootHygApp({ od: od.client });
    try {
      const examNum = await writeChart(app, v2Chart());
      edit(od, examNum);
      failDriftAudit(app);
      const res = await prior(app);
      assert.equal(res.status, 500, `${label}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'AUDIT_FAILED', label);
      assert.equal(res.body.drift, undefined, `${label}: no trail, no answer`);
      assert.doesNotMatch(JSON.stringify(res.body), /gingival margin|#3/, `${label}: nothing named`);
      assert.deepEqual(driftAudits(app), [], label);
    } finally {
      await app.close();
    }
  }
});

test('driftAuditRef / driftDiscloses: the exam, the positions, and nothing for a failed read', () => {
  const { driftAuditRef, driftDiscloses, unreadableOd } = require('../../services/hyg/perioDrift');
  const un = {
    status: 'unknown',
    reason: 'uninterpretable',
    examNum: 7001,
    positions: [
      { tooth: 3, surface: 'B', kind: 'gm' },
      { tooth: 30, surface: null, kind: 'mobility' },
      { tooth: null, surface: null, kind: 'mobility' },
    ],
  };
  assert.equal(driftAuditRef(un), 'perio_exam:7001;3-B:gm,30:mobility,x:mobility');
  assert.equal(driftAuditRef({ status: 'changed', examNum: 7001, changes: [] }), 'perio_exam:7001');
  assert.equal(driftDiscloses(un), true);
  assert.equal(driftDiscloses({ status: 'missing', examNum: 1, sameDateExams: [] }), true);
  assert.equal(driftDiscloses({ status: 'changed', examNum: 1, changes: [] }), true);
  assert.equal(driftDiscloses(unreadableOd(7001)), false);
  assert.equal(driftDiscloses({ status: 'matches', examNum: 1 }), false);
  assert.equal(driftDiscloses({ status: 'not_applicable' }), false);
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
