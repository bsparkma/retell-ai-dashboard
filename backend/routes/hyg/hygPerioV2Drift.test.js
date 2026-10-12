'use strict';

/**
 * DRIFT SEES THE v2 ROWS TOO (H4 item 31 — the 26b that item 26 deferred).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE GAP THESE TESTS CLOSE
 * ═════════════════════════════════════════════════════════════════════════════
 * Item 14 re-checks a `Written` chart when it is opened and says `changed` when
 * Open Dental no longer holds what CareIN wrote. Until item 31 it compared
 * PROBING ONLY: recession, furcation and mobility were filtered out on the way
 * through, so a hygienist's recession edited in Open Dental left CareIN saying
 * the chart matched. That is the false claim item 14 exists to prevent.
 *
 * The doctrine is unchanged and these tests hold it for every v2 family:
 *   present and matching → silence; missing → resend; present but differing →
 *   say so, name it, NO resend. And, new: a v2 value CareIN cannot interpret is
 *   `unknown`, never `matches`.
 *
 * The acceptance, as tests:
 *   1. An edited recession is `changed`, naming tooth + site + type.
 *   2. An edited mobility is reported per TOOTH.
 *   3. An edited furcation is reported.
 *   4. `changed` offers no resend for any v2 type — item 14's blocks hold.
 *   5. An unchanged v2 chart is silent, all -1 rows included.
 *   6. Zero added OD requests on an ordinary open; a ~130-row exam is whole.
 *   7. A margin in the OTHER family (101–119) is `changed`, never normalised.
 *   8. A v2 value the comparison cannot interpret is `unknown`, never `matches`.
 *
 * NO PHI: 12827 is the designated roland fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootHygApp, api, perioOd } = require('./hygTestUtils');
const contract = require('../../hyg/contract.gen.cjs');
const odPerio = require('../../services/hyg/odPerio');
const perioDrift = require('../../services/hyg/perioDrift');
const odDay = require('../../services/hyg/odDay');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const BASE = '/api/hyg/visit/900001';

const perioFake = (opts) => perioOd({ date: DATE, patNum: 12827, ...opts });

/** One of each v2 value beside a probing depth. #3 is a molar, so it may carry a furcation. */
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
const driftAudits = (app) => app.db.audit.filter((r) => String(r.resource_type).startsWith('hyg_perio_drift'));

/** Somebody edits one v2 row in Open Dental's own perio chart. Not through CareIN. */
function editInOpenDental(od, examNum, tooth, type, key, value) {
  const row = od.state.measures.find(
    (m) => m.PerioExamNum === examNum && m.IntTooth === tooth && m.SequenceType === type
  );
  assert.ok(row, `no ${type} row for #${tooth} in exam ${examNum}`);
  row[key] = value;
  od.publish();
}

/** Somebody adds a v2 row CareIN never wrote. */
function addInOpenDental(od, examNum, tooth, type, values = {}) {
  od.state.measures.push({
    PerioMeasureNum: od.state.nextMeasure++,
    PerioExamNum: examNum,
    SequenceType: type,
    IntTooth: tooth,
    ToothValue: -1,
    MBvalue: -1,
    Bvalue: -1,
    DBvalue: -1,
    MLvalue: -1,
    Lvalue: -1,
    DLvalue: -1,
    ...values,
  });
  od.publish();
}

/**
 * Item 14's four structural blocks against a resend, asserted on one `changed`
 * answer: no exam list on the wire, the resend route refuses, the chart stays
 * Written, and Open Dental is left exactly as the human left it.
 */
async function assertNoResend(app, od, answer, examNum) {
  assert.equal(answer.body.drift.status, 'changed');
  assert.equal(contract.PerioDriftSchema.safeParse(answer.body.drift).success, true);
  // 1. The variant cannot carry the list a resend dialog would need.
  assert.equal('sameDateExams' in answer.body.drift, false, 'a changed chart is offered no exam list');
  // 2. Asking for one directly is refused, because the exam is present.
  const examsBefore = od.state.exams.map((e) => e.PerioExamNum);
  const postsBefore = od.state.posts.length;
  const refused = await resend(app, examNum);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'PERIO_EXAM_PRESENT');
  // 3. The claim is not re-armed.
  assert.equal(app.db.hyg_staged_write.find((w) => w.kind === 'perio').state, 'Written');
  assert.equal(app.db.hyg_perio_send.find((r) => Number(r.exam_num) === examNum).exam_gone_at, null);
  // 4. Open Dental is untouched: no second exam, no delete, no post.
  assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), examsBefore);
  assert.deepEqual(od.state.deletes, []);
  assert.equal(od.state.posts.length, postsBefore);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 1 — recession
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 1: a recession edited in Open Dental after a Written send is `changed`, naming tooth, site and type', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, v2Chart());
    // A hygienist re-measures #3 B's recession in Open Dental itself: 2 → 3.
    editInOpenDental(od, examNum, 3, 'GingMargin', 'Bvalue', 3);

    const answer = await prior(app);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.drift.status, 'changed');
    assert.equal(answer.body.drift.examNum, examNum);

    const changes = answer.body.drift.changes;
    assert.equal(changes.length, 1, JSON.stringify(changes));
    assert.deepEqual(
      { tooth: changes[0].tooth, surface: changes[0].surface, kind: changes[0].kind },
      { tooth: 3, surface: 'B', kind: 'gm' }
    );
    // The line a hygienist reads names all three — a recession change, never a
    // depth change — and runs CareIN → Open Dental.
    assert.equal(contract.perioChangeLine(changes[0]), '#3 B gingival margin: 2 mm recession → 3 mm recession');

    // Deleting it outright is a change too, not a silence.
    editInOpenDental(od, examNum, 3, 'GingMargin', 'Bvalue', -1);
    const deleted = await prior(app);
    assert.equal(deleted.body.drift.status, 'changed');
    assert.equal(
      contract.perioChangeLine(deleted.body.drift.changes[0]),
      '#3 B gingival margin: 2 mm recession → not charted'
    );

    // It is a disclosure, so it audits as `changed`, with identifiers only.
    const rows = driftAudits(app);
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => r.prior_state === 'changed'));
    assert.ok(rows.every((r) => !String(r.prior_state).includes('mm')));
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 2 — mobility, per tooth
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 2: a mobility edited in Open Dental is reported per TOOTH, with no site', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, v2Chart());
    editInOpenDental(od, examNum, 3, 'Mobility', 'ToothValue', 2);

    const answer = await prior(app);
    assert.equal(answer.body.drift.status, 'changed');
    const changes = answer.body.drift.changes;
    assert.equal(changes.length, 1, JSON.stringify(changes));
    assert.equal(changes[0].kind, 'mobility');
    assert.equal(changes[0].tooth, 3);
    assert.equal(changes[0].surface, null, 'mobility is a property of the tooth, not of a site');
    assert.equal(contract.perioChangeLine(changes[0]), '#3 mobility: grade 1 → grade 2');
    assert.equal(contract.perioChangeSiteRef(changes[0]), '#3');
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 3 — furcation
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 3: a furcation edited in Open Dental is reported', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, v2Chart());
    editInOpenDental(od, examNum, 3, 'Furcation', 'MLvalue', 3);

    const answer = await prior(app);
    assert.equal(answer.body.drift.status, 'changed');
    const changes = answer.body.drift.changes;
    assert.equal(changes.length, 1, JSON.stringify(changes));
    assert.deepEqual(
      { tooth: changes[0].tooth, surface: changes[0].surface, kind: changes[0].kind },
      { tooth: 3, surface: 'ML', kind: 'furcation' }
    );
    assert.equal(contract.perioChangeLine(changes[0]), '#3 ML furcation: class 2 → class 3');
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 4 — no resend, for any v2 type
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 4: `changed` offers NO resend for any v2 type — item 14’s four blocks hold', async () => {
  const edits = [
    ['recession', 3, 'GingMargin', 'Bvalue', 5],
    ['other-family margin', 3, 'GingMargin', 'Bvalue', 102],
    ['furcation', 3, 'Furcation', 'MLvalue', 1],
    ['mobility', 3, 'Mobility', 'ToothValue', 3],
  ];
  for (const [label, tooth, type, key, value] of edits) {
    const od = perioFake();
    const app = await bootHygApp({ od: od.client });
    try {
      const examNum = await writeChart(app, v2Chart());
      editInOpenDental(od, examNum, tooth, type, key, value);
      const answer = await prior(app);
      assert.equal(answer.body.drift.status, 'changed', label);
      await assertNoResend(app, od, answer, examNum);
      // And the human's value is still exactly what they typed.
      const row = od.state.measures.find(
        (m) => m.PerioExamNum === examNum && m.IntTooth === tooth && m.SequenceType === type
      );
      assert.equal(row[key], value, label);
    } finally {
      await app.close();
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 5 — silence, earned
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 5: an unchanged v2 chart stays silent, and an all -1 row is no false positive', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, v2Chart());

    const answer = await prior(app);
    assert.equal(answer.body.drift.status, 'matches');
    assert.equal(answer.body.drift.examNum, examNum);

    // Open Dental's own UI leaves rows whose every value is -1 — a measured
    // shape. One per v2 family, on teeth CareIN charted nothing for.
    addInOpenDental(od, examNum, 14, 'GingMargin');
    addInOpenDental(od, examNum, 30, 'Furcation');
    addInOpenDental(od, examNum, 19, 'Mobility');
    const withEmpties = await prior(app);
    assert.equal(withEmpties.body.drift.status, 'matches', 'an all -1 row carries nothing, so nothing changed');

    // Silence is silent: nothing was disclosed, so nothing was audited.
    assert.deepEqual(driftAudits(app), []);
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 6 — the request budget
// ─────────────────────────────────────────────────────────────────────────────

/** Every family on every tooth: ~140 measure rows, past one 100-row page. */
function fullV2Chart() {
  let chart = contract.emptyPerioChart();
  for (let tooth = 1; tooth <= 32; tooth += 1) {
    for (const surface of ['MB', 'B', 'DB', 'ML', 'L', 'DL']) {
      chart = contract.withPerioSite(chart, tooth, surface, {
        depth: 3,
        gm: 1,
        bleeding: surface === 'B',
        ...(contract.PERIO_FURCATION_TEETH.includes(tooth) && surface === 'B' ? { furcation: 1 } : {}),
      });
    }
    chart = contract.withPerioMobility(chart, tooth, 0);
  }
  return contract.normalizePerioChart(chart);
}

test('ACCEPTANCE 6: zero added Open Dental requests on an ordinary open, and a ~130-row exam reads whole', async () => {
  // Small chart: one exam-list read and one measures read, the two the prior
  // panel already needed. The v2 rows ride that same read.
  {
    const od = perioFake();
    const app = await bootHygApp({ od: od.client });
    try {
      await writeChart(app, v2Chart());
      const before = app.od.calls.length;
      const answer = await prior(app);
      assert.equal(answer.body.drift.status, 'matches');
      const made = app.od.calls.slice(before).filter((c) => c.path.startsWith('/perio'));
      assert.deepEqual(made.map((c) => c.path), ['/perioexams', '/periomeasures']);
    } finally {
      await app.close();
    }
  }

  // A full v2 exam. Its rows run past one page, so the prior read takes two
  // measures pages — and still adds nothing for drift.
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, fullV2Chart());
    const rows = od.state.measures.filter((m) => m.PerioExamNum === examNum).length;
    assert.ok(rows >= 130, `a full v2 exam is ~130 rows (got ${rows})`);
    assert.ok(rows > odDay.OD_PAGE_SIZE, 'it does not fit one page');
    assert.ok(odDay.MAX_PAGES * odDay.OD_PAGE_SIZE > rows, `MAX_PAGES ${odDay.MAX_PAGES} covers it`);

    const before = app.od.calls.length;
    const answer = await prior(app);
    assert.equal(answer.body.prior.status, 'found');
    assert.equal(answer.body.prior.truncated, false, 'the exam did NOT truncate');
    assert.equal(answer.body.drift.status, 'matches', 'every one of its families compared, and matched');

    const pages = Math.ceil(rows / odDay.OD_PAGE_SIZE);
    const made = app.od.calls.slice(before).filter((c) => c.path.startsWith('/perio'));
    assert.deepEqual(
      made.map((c) => c.path),
      ['/perioexams', ...Array.from({ length: pages }, () => '/periomeasures')],
      'the exam list and the measures pages the prior panel reads anyway — drift adds none'
    );

    // And one edited recession in the SECOND page is still seen.
    const late = od.state.measures
      .filter((m) => m.PerioExamNum === examNum)
      .findIndex((m) => m.SequenceType === 'GingMargin' && m.IntTooth === 32);
    assert.ok(late >= odDay.OD_PAGE_SIZE, '#32’s margin row sits past the first page');
    editInOpenDental(od, examNum, 32, 'GingMargin', 'DLvalue', 4);
    const changed = await prior(app);
    assert.equal(changed.body.drift.status, 'changed');
    assert.deepEqual(
      changed.body.drift.changes.map(contract.perioChangeLine),
      ['#32 DL gingival margin: 1 mm recession → 4 mm recession']
    );
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 7 — the other family
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 7: a margin Open Dental holds in the OTHER family (101–119) is `changed`, never matching, never normalised', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, v2Chart());
    // CareIN wrote 2 (recession, §0's low family). Someone's hand put 102 there.
    // "Subtract 100" would make it read as 2 and match. It must not.
    editInOpenDental(od, examNum, 3, 'GingMargin', 'Bvalue', 102);

    const answer = await prior(app);
    assert.equal(answer.body.drift.status, 'changed', 'never `matches`');
    const changes = answer.body.drift.changes;
    assert.equal(changes.length, 1, JSON.stringify(changes));
    assert.equal(changes[0].kind, 'gm');
    assert.equal(changes[0].from, '2 mm recession');
    assert.equal(changes[0].to, '102 (unrecognised margin)', 'the value Open Dental holds, raw');
    assert.equal(
      contract.perioChangeLine(changes[0]),
      '#3 B gingival margin: 2 mm recession → 102 (unrecognised margin)'
    );
    // And the prior panel carries it raw too — nothing anywhere converted it.
    assert.equal(contract.perioTooth(answer.body.prior.chart, 3).sites.B.gm, 102);
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 8 — what cannot be interpreted is `unknown`
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 8: a v2 value the comparison cannot interpret is `unknown`, never `matches`', async () => {
  const cases = [
    // CareIN wrote class 2 at #3 ML; Open Dental holds a 5 (it accepted one, §7).
    ['furcation out of range over a CareIN value', (od, n) => editInOpenDental(od, n, 3, 'Furcation', 'MLvalue', 5), '3-ML:furcation'],
    // A margin row CareIN never wrote, carrying a number in neither family.
    ['margin in neither family', (od, n) => addInOpenDental(od, n, 14, 'GingMargin', { Bvalue: 50 }), '14-B:gm'],
    // A mobility grade past 3.
    ['mobility out of range', (od, n) => editInOpenDental(od, n, 3, 'Mobility', 'ToothValue', 9), '3:mobility'],
    // A value that is not a number at all.
    ['unparseable margin', (od, n) => editInOpenDental(od, n, 3, 'GingMargin', 'MBvalue', 'x'), '3-MB:gm'],
    // A v2 row with a value on a tooth CareIN cannot place.
    ['v2 row on an unplaceable tooth', (od, n) => addInOpenDental(od, n, 0, 'Mobility', { ToothValue: 2 }), '0:mobility'],
    // …including tooth -1, which must not be mistaken for Open Dental's -1 "nothing here".
    ['v2 row on tooth -1', (od, n) => addInOpenDental(od, n, -1, 'Mobility', { ToothValue: 2 }), '-1:mobility'],
  ];
  for (const [label, edit, where] of cases) {
    const od = perioFake();
    const app = await bootHygApp({ od: od.client });
    try {
      const examNum = await writeChart(app, v2Chart());
      edit(od, examNum);
      const answer = await prior(app);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.equal(answer.body.drift.status, 'unknown', `${label}: never matches, never a made-up line`);
      assert.equal(answer.body.drift.examNum, examNum);
      assert.equal(contract.PerioDriftSchema.safeParse(answer.body.drift).success, true);
      /*
       * ITEM 32 — A PREMISE UPDATE, NOT A WEAKENING. This line used to read
       * "`unknown` says nothing, so it discloses nothing" and assert no row.
       * Since item 32 an `uninterpretable` answer NAMES the position on screen,
       * and naming teeth is the disclosure, so it writes exactly one row:
       * identifiers only — the exam number and the position, never the value.
       * `unreadable_od` still names nothing and still writes none (below).
       */
      const rows = driftAudits(app);
      assert.equal(rows.length, 1, label);
      assert.equal(rows[0].resource_type, 'hyg_perio_drift', label);
      assert.equal(rows[0].prior_state, 'unknown:uninterpretable', label);
      assert.equal(rows[0].source_ref, `perio_exam:${examNum};${where}`, `${label}: identifiers only, never the value`);
    } finally {
      await app.close();
    }
  }

  // ITEM 32: an Open Dental that cannot be READ is `unknown` for `unreadable_od`,
  // names nothing, and still writes no drift row.
  {
    const od = perioFake();
    const app = await bootHygApp({ od: od.client });
    try {
      await writeChart(app, v2Chart());
      od.client.routes['/perioexams'] = { ok: false, status: 503, data: null, error: 'Service Unavailable' };
      const answer = await prior(app);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.equal(answer.body.drift.status, 'unknown');
      assert.equal(answer.body.drift.reason, 'unreadable_od');
      assert.deepEqual(driftAudits(app), [], 'unreadable_od discloses nothing, so it records nothing');
    } finally {
      await app.close();
    }
  }

  // An unreadable value does not HIDE a readable change elsewhere: that one is
  // real and is reported — and no line is invented at the unreadable position.
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, v2Chart());
    editInOpenDental(od, examNum, 3, 'Furcation', 'MLvalue', 5);
    editInOpenDental(od, examNum, 3, 'GingMargin', 'Bvalue', 4);
    const answer = await prior(app);
    assert.equal(answer.body.drift.status, 'changed');
    assert.deepEqual(answer.body.drift.changes.map(contract.perioChangeLine), [
      '#3 B gingival margin: 2 mm recession → 4 mm recession',
    ]);
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The pieces, without Open Dental
// ─────────────────────────────────────────────────────────────────────────────

const row = (type, tooth, values = {}, num = 1) => ({
  PerioMeasureNum: num,
  PerioExamNum: 2268,
  SequenceType: type,
  IntTooth: tooth,
  ToothValue: -1,
  MBvalue: -1,
  Bvalue: -1,
  DBvalue: -1,
  MLvalue: -1,
  Lvalue: -1,
  DLvalue: -1,
  ...values,
});

test('chartFromMeasures names every v2 value it cannot interpret, and nothing else', () => {
  const { uninterpretable } = odPerio.chartFromMeasures([
    row('GingMargin', 3, { Bvalue: 2, MBvalue: 102 }, 1), // both families: readable
    row('GingMargin', 4, { Bvalue: 50 }, 2), // neither family
    row('Furcation', 3, { MLvalue: 5 }, 3), // class out of range
    row('Mobility', 3, { ToothValue: 7 }, 4), // grade out of range
    row('Mobility', 4, {}, 5), // all -1: nothing charted, not unreadable
    row('Probing', 3, { Bvalue: 99 }, 6), // v1 rows are untouched by item 31
    row('MGJ', 3, { Bvalue: 4 }, 7), // out of scope, as before
    row('Mobility', -1, { ToothValue: 2 }, 8), // a value on a tooth that cannot be placed
    row('GingMargin', -1, {}, 9), // an all -1 row on one: carries nothing
  ]);
  assert.deepEqual(
    uninterpretable.map((u) => [u.tooth, u.surface, u.kind, u.raw]),
    [
      [4, 'B', 'gm', 50],
      [3, 'ML', 'furcation', 5],
      [3, null, 'mobility', 7],
      [-1, null, 'mobility', -1],
    ]
  );
});

test('chartFromMeasures: the later of two rows decides readability exactly as it decides the chart', () => {
  // An unreadable value later corrected to a readable one is readable.
  let out = odPerio.chartFromMeasures([
    row('Furcation', 3, { MLvalue: 5 }, 1),
    row('Furcation', 3, { MLvalue: 2 }, 2),
  ]);
  assert.deepEqual(out.uninterpretable, []);
  assert.equal(contract.perioTooth(out.chart, 3).sites.ML.furcation, 2);
  // And the other way round.
  out = odPerio.chartFromMeasures([row('Furcation', 3, { MLvalue: 2 }, 1), row('Furcation', 3, { MLvalue: 5 }, 2)]);
  assert.equal(out.uninterpretable.length, 1);
});

test('driftAnswer: matches only when nothing differs AND nothing was unreadable', () => {
  const chart = (fn) => contract.normalizePerioChart(fn(contract.emptyPerioChart()));
  const wrote = chart((c) => contract.withPerioSite(c, 3, 'B', { gm: 2 }));
  const same = wrote;
  const moved = chart((c) => contract.withPerioSite(c, 3, 'B', { gm: 3 }));
  const blindAt3B = [{ tooth: 3, surface: 'B', kind: 'gm', raw: 50 }];
  const blindElsewhere = [{ tooth: 9, surface: null, kind: 'mobility', raw: 7 }];

  assert.equal(perioDrift.driftAnswer({ examNum: 1, baseline: wrote, odChart: same }).status, 'matches');
  assert.equal(
    perioDrift.driftAnswer({ examNum: 1, baseline: wrote, odChart: same, unreadable: blindElsewhere }).status,
    'unknown'
  );
  assert.equal(perioDrift.driftAnswer({ examNum: 1, baseline: wrote, odChart: moved }).status, 'changed');
  // A difference AT the unreadable position is not a readable difference.
  assert.equal(
    perioDrift.driftAnswer({ examNum: 1, baseline: wrote, odChart: moved, unreadable: blindAt3B }).status,
    'unknown'
  );
  assert.equal(
    perioDrift.driftAnswer({ examNum: 1, baseline: wrote, odChart: moved, unreadable: blindElsewhere }).status,
    'changed'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The same diff serves the correction (item 13) — so it widened there too
// ─────────────────────────────────────────────────────────────────────────────

async function stageAmendment(app, chart) {
  const opened = await api(app.baseUrl, 'POST', BASE + '/perio/amend' + Q);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal((await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart } })).status, 200);
  const staged = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  return staged.body.visit.stagedWrites.find((w) => w.kind === 'perio');
}

test('a correction that changes ONLY a recession is a correction, not "nothing to correct"', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    await writeChart(app, v2Chart());
    const write = await stageAmendment(app, contract.withPerioSite(v2Chart(), 3, 'B', { gm: 4 }));
    const res = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, {
      body: { previewFingerprint: write.previewFingerprint, examDate: DATE, provNum: 7 },
    });
    // Before item 31 the diff dropped `gm`, so this was refused NOTHING_TO_SEND.
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.send.amendDiff.map(contract.perioChangeLine), [
      '#3 B gingival margin: 2 mm recession → 4 mm recession',
    ]);
  } finally {
    await app.close();
  }
});

test('a recession edited in Open Dental after a correction began refuses AMEND_BASE_CHANGED, and writes nothing', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const examNum = await writeChart(app, v2Chart());
    const write = await stageAmendment(app, contract.withPerioSite(v2Chart(), 3, 'B', { depth: 6 }));
    editInOpenDental(od, examNum, 3, 'GingMargin', 'Bvalue', 5);
    const orderBefore = od.state.order.slice();

    const refused = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, {
      body: { previewFingerprint: write.previewFingerprint, examDate: DATE, provNum: 7 },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'AMEND_BASE_CHANGED');
    assert.match(refused.body.error, /#3 B gingival margin/);
    assert.deepEqual(od.state.order, orderBefore, 'nothing was written and nothing deleted');
  } finally {
    await app.close();
  }
});
