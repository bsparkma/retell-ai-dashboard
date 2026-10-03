'use strict';

/**
 * PERIO v2 THROUGH THE SEND — recession, furcation, mobility (item 26 part 4).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT A SEND OWES THESE ROWS
 * ═════════════════════════════════════════════════════════════════════════════
 * The same three things it owes a probing depth, and no fewer:
 *
 *   1. Every row is READ BACK from Open Dental before the chart is called
 *      `Written`. A row posted and not verified is a claim nobody checked.
 *   2. A row that is ALREADY THERE is read and compared, never re-posted. Item
 *      19's probe measured that a second POST for the same (tooth, type) is
 *      REFUSED by Open Dental rather than overwriting — so a blind retry turns a
 *      recoverable pause into a dead send.
 *   3. A send that cannot finish deletes the whole exam and claims nothing.
 *
 * NO PHI: 12827 is the designated roland fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootHygApp, api, perioOd } = require('./hygTestUtils');
const contract = require('../../hyg/contract.gen.cjs');
const gate = require('../../config/hygFixtureGate');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const BASE = '/api/hyg/visit/900001';

const perioFake = (opts) => perioOd({ date: DATE, patNum: 12827, ...opts });

/** A small chart carrying one of each v2 value, beside a probing depth. */
function v2Chart() {
  let chart = contract.emptyPerioChart();
  // #3 is a molar, so it may carry a furcation class.
  chart = contract.withPerioSite(chart, 3, 'B', { depth: 4, gm: 2 });
  chart = contract.withPerioSite(chart, 3, 'ML', { furcation: 2 });
  chart = contract.withPerioMobility(chart, 3, 1);
  return contract.normalizePerioChart(chart);
}

async function stage(app, chart) {
  assert.equal((await api(app.baseUrl, 'POST', BASE + '/open' + Q)).status, 200);
  assert.equal((await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart } })).status, 200);
  const res = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.visit.stagedWrites.find((w) => w.kind === 'perio');
}

const confirmOf = (write, over = {}) => ({
  previewFingerprint: write.previewFingerprint,
  examDate: DATE,
  provNum: 7,
  ...over,
});

const send = (app, write, over) =>
  api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: confirmOf(write, over) });

async function drain(app, res, limit = 30) {
  let current = res;
  for (let i = 0; i < limit; i += 1) {
    if (current.status !== 200) return current;
    const s = current.body.send;
    if (!s || !['posting', 'filling'].includes(s.state) || current.body.paused) return current;
    current = await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q);
  }
  return current;
}

const rowsOfType = (od, type) => od.state.measures.filter((m) => m.SequenceType === type);

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 7a: every v2 row goes out, and is read back before Written
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 7: the v2 rows are posted in the measured shapes and READ BACK before Written', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, v2Chart());
    const done = await drain(app, await send(app, write));
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.send.state, 'written', JSON.stringify(done.body.send));
    assert.equal(done.body.stagedWrite.state, 'Written');

    // The gingival margin: per site, ToothValue -1, §0's recession family.
    const gm = rowsOfType(od, 'GingMargin');
    assert.equal(gm.length, 1);
    assert.equal(gm[0].IntTooth, 3);
    assert.equal(gm[0].ToothValue, -1);
    assert.equal(gm[0].Bvalue, 2);
    assert.equal(gm[0].MBvalue, -1, 'a site she did not chart is -1, never 0');

    // Furcation: per site, ToothValue -1.
    const furcation = rowsOfType(od, 'Furcation');
    assert.equal(furcation.length, 1);
    assert.equal(furcation[0].ToothValue, -1);
    assert.equal(furcation[0].MLvalue, 2);

    // Mobility: per TOOTH, grade in ToothValue, every surface -1.
    const mobility = rowsOfType(od, 'Mobility');
    assert.equal(mobility.length, 1);
    assert.equal(mobility[0].ToothValue, 1);
    for (const key of ['MBvalue', 'Bvalue', 'DBvalue', 'MLvalue', 'Lvalue', 'DLvalue']) {
      assert.equal(mobility[0][key], -1, key);
    }

    // AND NOT ONE CAL ROW, ever — Open Dental derives its own.
    assert.equal(
      od.state.measures.some((m) => /cal/i.test(String(m.SequenceType))),
      false
    );
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 9: a v2 row Open Dental REFUSES stops the send and deletes the whole exam', async () => {
  // The furcation row is refused outright. Nothing may be claimed, and the exam
  // CareIN created must not be left behind half-filled.
  const od = perioFake({
    onMeasure: (body) =>
      body.SequenceType === 'Furcation'
        ? { ok: false, status: 400, data: null, error: 'Something is invalid.' }
        : null,
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, v2Chart());
    const stopped = await drain(app, await send(app, write));
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.send.state, 'incomplete');
    // It names the tooth AND the type, and carries Open Dental's own words.
    assert.match(stopped.body.send.errorMessage, /#3 Furcation/);
    assert.match(stopped.body.send.errorMessage, /refused it/);
    // NOTHING IS CLAIMED: the chart does not say Written.
    assert.notEqual(stopped.body.stagedWrite.state, 'Written');

    /*
     * The exam is still in Open Dental, and the UNDO IS OFFERED rather than
     * performed. That is item 12's design and item 26 does not change it: a
     * rollback CareIN decided on its own would delete an exam a hygienist may be
     * looking at. `canDelete` is how the screen knows to offer it.
     */
    assert.equal(od.state.deletes.length, 0, 'nothing was deleted behind her back');
    assert.equal(stopped.body.send.canDelete, true, 'and the undo is offered');

    // When she takes it, the WHOLE exam goes — every row with it.
    const undone = await api(app.baseUrl, 'POST', BASE + '/perio/send/delete-exam' + Q, {
      body: { examNum: stopped.body.send.examNum },
    });
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.deepEqual(od.state.deletes, [stopped.body.send.examNum]);
    assert.equal(od.state.exams.length, 0);
    assert.equal(od.state.measures.length, 0, 'the rows went with the exam');
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 7b: "already exists" — read and compare, both branches
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 7: a v2 row that ALREADY LANDED is not posted again — read, compare, carry on', async () => {
  /*
   * The uncertain-answer case. The row reached Open Dental and the answer did
   * not reach CareIN, so the next step finds it already there. A second POST
   * would be REFUSED (measured), which would turn a pause into a dead send — so
   * the row is read, compared, and skipped.
   */
  let dropped = 0;
  const od = perioFake({
    onMeasure: (body, state) => {
      // Let the mobility row LAND and then answer as though the network died.
      if (body.SequenceType === 'Mobility' && dropped === 0) {
        dropped += 1;
        // `landed: true` makes the fake STORE the row and then answer as though
        // the network died. Pushing it by hand as well would make two rows, which
        // is a different failure (and one the send also refuses).
        return { ok: false, status: 0, data: null, error: 'socket hang up', landed: true };
      }
      return null;
    },
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, v2Chart());
    // The unanswered row PAUSES the send rather than stopping it — "it may have
    // landed" is not "it failed", and the next step is what finds out.
    const paused = await drain(app, await send(app, write));
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.ok(paused.body.paused, 'an unanswered row pauses: ' + JSON.stringify(paused.body.send));
    assert.match(paused.body.paused, /check whether it landed/);

    // Stepping again reads Open Dental, finds the row already there, compares it,
    // and carries on.
    const done = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q));
    assert.equal(done.body.send.state, 'written', 'the send recovered: ' + JSON.stringify(done.body.send));

    // EXACTLY ONE mobility row in Open Dental, and only one POST of it.
    assert.equal(rowsOfType(od, 'Mobility').length, 1);
    assert.equal(
      od.state.posts.filter((p) => p.body && p.body.SequenceType === 'Mobility').length,
      1,
      'it was never posted a second time'
    );
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 7: a v2 row already there with DIFFERENT values is an honest failure naming tooth and type', async () => {
  /*
   * Seeded through `corrupt`, which runs the moment the exam is created and
   * BEFORE any row is posted — so the send's read-before-write finds exactly one
   * GingMargin row for #3 that is not the one it meant to write. A row posted
   * first and then contradicted is the DUPLICATE case, which refuses too but for
   * a different reason, and conflating the two would leave this branch untested.
   */
  const od = perioFake({
    corrupt: (state, exam) => {
      state.measures.push({
        PerioMeasureNum: 99500,
        PerioExamNum: exam.PerioExamNum,
        SequenceType: 'GingMargin',
        IntTooth: 3,
        ToothValue: -1,
        MBvalue: -1,
        Bvalue: 5,
        DBvalue: -1,
        MLvalue: -1,
        Lvalue: -1,
        DLvalue: -1,
      });
    },
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, v2Chart());
    const stopped = await drain(app, await send(app, write));
    assert.equal(stopped.body.send.state, 'incomplete', JSON.stringify(stopped.body.send));
    // It names the tooth AND the type, and does not report a bare 400.
    assert.match(stopped.body.send.errorMessage, /#3 GingMargin/);
    assert.match(stopped.body.send.errorMessage, /already holds a different row/);
    assert.notEqual(stopped.body.stagedWrite.state, 'Written');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 7: a v2 row that comes back WRONG fails the read-back rather than claiming Written', async () => {
  // The row was accepted and stored as something else. `Written` means every site
  // was read back and matched, so this must not reach it.
  const od = perioFake({
    afterMeasure: (row) => {
      if (row.SequenceType === 'GingMargin') row.Bvalue = 7;
    },
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const write = await stage(app, v2Chart());
    const stopped = await drain(app, await send(app, write));
    assert.equal(stopped.body.send.state, 'incomplete', JSON.stringify(stopped.body.send));
    /*
     * THE PROPERTY, NOT A PARTICULAR SENTENCE: a recession that is not what CareIN
     * wrote stops the send and names the tooth and type. Whether the read that
     * catches it is the next step's read-before-write or the final verification
     * depends on when the corruption happened, and both are the same promise —
     * `Written` means every row was read back and matched.
     */
    assert.match(stopped.body.send.errorMessage, /#3 GingMargin/);
    assert.notEqual(stopped.body.stagedWrite.state, 'Written');
    assert.equal(stopped.body.send.canDelete, true);
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 8: the confirm gate covers the v2 values
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ═══════════════════════════════════════════════════════════════════════════════
 * ACCEPTANCE 8 — AND A FINDING WORTH STATING PLAINLY
 * ═══════════════════════════════════════════════════════════════════════════════
 * Editing a v2 value UN-STAGES the chart already, with no change from item 26:
 * `samePerioReadings` compares `normalizePerioChart(chart).teeth` as JSON, and
 * recession, furcation and mobility are now part of that object. So an edited
 * recession behaves exactly as an edited depth does, which is what it should do —
 * and it means the first refusal she meets is NOT_STAGED rather than
 * PREVIEW_CHANGED.
 *
 * PREVIEW_CHANGED is the SECOND line of defence, and the one the fingerprint
 * exists for: a client holding a preview from before the edit — a second tab, a
 * reload, a stale confirm dialog. That is what these two tests exercise, by
 * re-staging after the edit and then confirming with the OLD fingerprint. If the
 * fingerprint did not cover the v2 values, the old one would still match the new
 * preview and the send would go through with a chart she never read.
 */

test('ACCEPTANCE 8: an edited recession un-stages, and the OLD fingerprint is then refused', async () => {
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const before = await stage(app, v2Chart());

    // She changes ONE recession, and nothing else.
    let edited = contract.withPerioSite(v2Chart(), 3, 'B', { depth: 4, gm: 3 });
    edited = contract.normalizePerioChart(edited);
    assert.equal((await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: edited } })).status, 200);

    // The chart left the list, because a v2 value is a reading like any other.
    const offList = await send(app, before);
    assert.equal(offList.status, 409, JSON.stringify(offList.body));
    assert.equal(offList.body.code, 'NOT_STAGED');

    // Re-staged, the preview is DIFFERENT — so the fingerprint she confirmed
    // before the edit no longer matches, and the confirm gate refuses it.
    const after = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
    assert.equal(after.status, 201, JSON.stringify(after.body));
    const restaged = after.body.visit.stagedWrites.find((w) => w.kind === 'perio');
    assert.notEqual(
      restaged.previewFingerprint,
      before.previewFingerprint,
      'the fingerprint MUST move when a recession moves'
    );

    const refused = await send(app, before);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'PREVIEW_CHANGED');
    assert.equal(od.state.posts.length, 0, 'and nothing was written');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 8: the same holds for a mobility grade and a furcation class', async () => {
  for (const edit of [
    (chart) => contract.withPerioMobility(chart, 3, 2),
    (chart) => contract.withPerioSite(chart, 3, 'ML', { furcation: 3 }),
  ]) {
    const od = perioFake();
    const app = await bootHygApp({ od: od.client });
    try {
      const before = await stage(app, v2Chart());
      const edited = contract.normalizePerioChart(edit(v2Chart()));
      assert.equal((await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: edited } })).status, 200);

      const after = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
      assert.equal(after.status, 201, JSON.stringify(after.body));
      const restaged = after.body.visit.stagedWrites.find((w) => w.kind === 'perio');
      assert.notEqual(restaged.previewFingerprint, before.previewFingerprint);

      const refused = await send(app, before);
      assert.equal(refused.body.code, 'PREVIEW_CHANGED', JSON.stringify(refused.body));
      assert.equal(od.state.posts.length, 0);
    } finally {
      await app.close();
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Item 20's gate, and the request arithmetic the UI promises
// ─────────────────────────────────────────────────────────────────────────────

test('a v2 send still refuses a patient who is not a designated fixture (item 20)', async () => {
  /*
   * The gate is a SWITCH, on in staging and prod and off in a plain test boot, so
   * a test that forgets to turn it on proves nothing. 11373 is the PatNum item 20
   * rejected as a fixture: its phone is a shared family number.
   */
  const SWITCH = gate.SWITCH_ENV;
  const saved = process.env[SWITCH];
  process.env[SWITCH] = 'true';
  gate._resetWarningsForTests();
  const od = perioOd({ date: DATE, patNum: 11373 });
  const app = await bootHygApp({ od: od.client });
  try {
    /*
     * Item 20's gate can refuse at any point on the way; which step says no is not
     * the property worth pinning. That NOTHING is ever written for a patient who
     * is not a designated fixture is.
     */
    await api(app.baseUrl, 'POST', BASE + '/open' + Q);
    await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart: v2Chart() } });
    const staged = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
    if (staged.status === 201) {
      const write = staged.body.visit.stagedWrites.find((w) => w.kind === 'perio');
      const res = await send(app, write);
      if (res.status === 200) await drain(app, res);
    }
    assert.equal(od.state.posts.length, 0, 'not one write for a non-fixture patient');
    assert.deepEqual(od.client.writes, [], 'and not one write verb');
  } finally {
    await app.close();
    if (saved === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = saved;
    gate._resetWarningsForTests();
  }
});

test('the estimate the send UI shows counts the v2 rows', async () => {
  // Duration honesty: a typical v2 send is ~50 requests at about one a second,
  // and the screen says so up front rather than appearing to hang.
  const plan = contract.planPerioSend(v2Chart());
  const before = contract.estimatePerioSendRequests({ examCreated: false, rowsRemaining: plan.rows.length });
  const v1Only = contract.planPerioSend(
    contract.normalizePerioChart(contract.withPerioSite(contract.emptyPerioChart(), 3, 'B', { depth: 4 }))
  );
  const v1Estimate = contract.estimatePerioSendRequests({
    examCreated: false,
    rowsRemaining: v1Only.rows.length,
  });
  assert.ok(before > v1Estimate, 'three more rows is a longer send, and the estimate says so');
});
