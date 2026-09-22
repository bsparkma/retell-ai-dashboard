'use strict';

/**
 * ITEM 20 — with the test-patient rail on, every hygiene Open Dental write entry
 * point refuses anyone who is not a designated test patient. Through the real
 * /api/hyg stack, against the fakes the send suites already drive.
 *
 * Each continuation test builds the state it needs with the gate OFF, turns it
 * ON and is refused with nothing written, then turns it OFF again and makes the
 * SAME call succeed — so the refusal is shown to be the gate and not some other
 * precondition that happened to fail.
 *
 *   1. a visit send for a non-test patient: 422, no unit writes anything
 *   2. perio start / step / delete-exam / amend / remove-replaced, the TC
 *      handoff, and the staged-write retry, one test each
 *   3. a test patient passes through unchanged with the gate on
 *   4. gate off = today's behaviour exactly
 *   5. an unrecognised switch value behaves as ON
 *
 * NO PHI. 4242424 is a synthetic PatNum standing for "not a test patient"; the
 * fakes carry no name for it. 12827 is the designated roland fixture. Roland
 * 7115 appears once, as a number only, because it is the cross-office trap the
 * gate has to get right: 7115 is the VALLEY fixture and somebody else in roland.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootHygApp, api, perioOd } = require('./hygTestUtils');
const contract = require('../../hyg/contract.gen.cjs');
const gate = require('../../config/hygFixtureGate');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const BASE = '/api/hyg/visit/900001';
const NOT_A_TEST_PATIENT = 4242424;
const SWITCH = gate.SWITCH_ENV;

const CROWN = {
  teeth: [3],
  code: 'Crown',
  category: 'Restorative',
  surfaces: ['O'],
  dx: ['D'],
  priority: 'urgent',
  motivation: ['pain'],
  status: 'proposed',
  scheduleNext: true,
  photos: [],
};

/** Run `fn` with the switch at `value` (undefined = unset), restoring it after. */
function withSwitch(value) {
  if (value === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = value;
}

const saved = { value: process.env[SWITCH], vault: process.env.AZURE_KEY_VAULT_NAME };
test.afterEach(() => {
  if (saved.value === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = saved.value;
  if (saved.vault === undefined) delete process.env.AZURE_KEY_VAULT_NAME;
  else process.env.AZURE_KEY_VAULT_NAME = saved.vault;
  gate._resetWarningsForTests();
});

function fullMouth(depth = (i) => (i * 7) % 10) {
  let chart = contract.emptyPerioChart();
  for (const f of contract.PERIO_ARCH_STRING_FIELDS) {
    contract.PERIO_ARCH_STRING_SITES[f].forEach((c, i) => {
      chart = contract.withPerioSite(chart, c.tooth, c.surface, { depth: depth(i), bleeding: i % 7 === 3 });
    });
  }
  return chart;
}

/** The perio fake, for `patNum`, plus the note surfaces a visit send needs. */
function visitFake(patNum, opts = {}) {
  const fake = perioOd({ date: DATE, patNum, ...opts });
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
    return { ok: true, status: 200, data: { ProcNum: procNum } };
  };
  return fake;
}

function tcRecorder() {
  const submitted = [];
  return {
    submitted,
    submit: async (_req, { office, body }) => {
      submitted.push({ office, body });
      return { ok: true, caseId: '8f3c1d20-0000-4000-8000-000000000001' };
    },
  };
}

async function open(app) {
  const res = await api(app.baseUrl, 'POST', BASE + '/open' + Q);
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function stagePerio(app, chart = fullMouth()) {
  assert.equal((await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart } })).status, 200);
  const res = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind: 'perio' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.visit.stagedWrites.find((w) => w.kind === 'perio');
}

async function stageKind(app, kind) {
  const res = await api(app.baseUrl, 'POST', BASE + '/staged-writes' + Q, { body: { kind } });
  assert.equal(res.status, 201, kind + ' ' + JSON.stringify(res.body));
  return res.body.visit;
}

function perioConfirmBody(write) {
  return { previewFingerprint: write.previewFingerprint, examDate: DATE, provNum: 7 };
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

function states(app) {
  return Object.fromEntries(app.db.hyg_staged_write.map((r) => [r.kind, r.state]));
}

function assertRefused(res) {
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'HYG_TEST_PATIENTS_ONLY');
  assert.match(res.body.error, /only writes to the designated test patients/);
  assert.match(res.body.error, /roland 12827, 12828; valley 7115/);
  assert.match(res.body.error, /Nothing was sent to Open Dental/);
}

// ── 1 + 2: the visit send, every unit including the TC handoff ──────────────

test('ACCEPTANCE 1+2: a visit send for a non-test patient is refused 422 — no note, no slip, no TC case, no chart', async () => {
  withSwitch('on');
  const od = visitFake(NOT_A_TEST_PATIENT);
  const tc = tcRecorder();
  const app = await bootHygApp({ od: od.client, tcSubmit: tc.submit });
  try {
    await open(app);
    await api(app.baseUrl, 'POST', BASE + '/items' + Q, { body: CROWN });
    const perio = await stagePerio(app);
    await stageKind(app, 'note');
    await stageKind(app, 'router');
    const visit = await stageKind(app, 'tc-handoff');
    const confirm = visit.stagedWrites.map((w) =>
      w.kind === 'perio'
        ? { kind: 'perio', ...perioConfirmBody(perio) }
        : { kind: w.kind, previewFingerprint: w.previewFingerprint }
    );

    const res = await api(app.baseUrl, 'POST', BASE + '/send' + Q, { body: { confirm } });
    assertRefused(res);
    assert.deepEqual(od.client.writes, [], 'not one Open Dental write, by any unit');
    assert.equal(tc.submitted.length, 0, 'no TC case');
    assert.deepEqual(
      states(app),
      { perio: 'Staged', note: 'Staged', router: 'Staged', 'tc-handoff': 'Staged' },
      'every unit exactly as it was — Staged, not Failed: nothing was attempted'
    );
    assert.equal(app.db.hyg_perio_send.length, 0, 'no perio send recorded');
    const denial = app.db.audit.filter((r) => r.resource_type === 'hyg_visit_send');
    assert.deepEqual(denial.map((r) => r.result), ['UNAUTHORIZED'], 'the refusal is on the audit trail');

    // ACCEPTANCE 4 on the same visit: gate off, the same confirmation goes out.
    withSwitch('off');
    const sent = await api(app.baseUrl, 'POST', BASE + '/send' + Q, { body: { confirm } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(tc.submitted.length, 1);
    assert.equal(sent.body.outcomes.find((o) => o.kind === 'note').state, 'Written');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 2: the TC handoff alone is refused for a non-test patient, and nothing reaches TC', async () => {
  withSwitch('on');
  const od = visitFake(NOT_A_TEST_PATIENT);
  const tc = tcRecorder();
  const app = await bootHygApp({ od: od.client, tcSubmit: tc.submit });
  try {
    await open(app);
    await api(app.baseUrl, 'POST', BASE + '/items' + Q, { body: CROWN });
    const visit = await stageKind(app, 'tc-handoff');
    const confirm = visit.stagedWrites.map((w) => ({ kind: w.kind, previewFingerprint: w.previewFingerprint }));
    assertRefused(await api(app.baseUrl, 'POST', BASE + '/send' + Q, { body: { confirm } }));
    assert.equal(tc.submitted.length, 0);
    assert.equal(states(app)['tc-handoff'], 'Staged');
  } finally {
    await app.close();
  }
});

// ── 2: the perio entry points ───────────────────────────────────────────────

test('ACCEPTANCE 2: perio START from the chart page is refused, nothing written, no send recorded', async () => {
  withSwitch('on');
  const od = perioOd({ date: DATE, patNum: NOT_A_TEST_PATIENT });
  const app = await bootHygApp({ od: od.client });
  try {
    await open(app);
    const write = await stagePerio(app);
    assertRefused(await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: perioConfirmBody(write) }));
    assert.deepEqual(od.client.writes, []);
    assert.equal(app.db.hyg_perio_send.length, 0);
    assert.equal(states(app).perio, 'Staged');

    withSwitch('off');
    const done = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: perioConfirmBody(write) }));
    assert.equal(done.body.send.state, 'written', JSON.stringify(done.body));
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 2: perio STEP on a send already in flight is refused and writes nothing more', async () => {
  withSwitch('off');
  let n = 0;
  const od = perioOd({
    date: DATE,
    patNum: NOT_A_TEST_PATIENT,
    // The exam lands without answering: the send pauses mid-flight.
    onExam: () => (++n === 1 ? { ok: false, status: 503, data: null, error: 'upstream timeout', landed: true } : null),
  });
  const app = await bootHygApp({ od: od.client });
  try {
    await open(app);
    const write = await stagePerio(app);
    const first = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: perioConfirmBody(write) });
    assert.equal(first.body.send.state, 'posting');
    const writesBefore = od.client.writes.length;

    withSwitch('on');
    assertRefused(await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q));
    assert.equal(od.client.writes.length, writesBefore, 'the step wrote nothing');
    assert.equal(app.db.hyg_perio_send[0].state, 'posting', 'the send is left exactly where it was');

    withSwitch('off');
    const done = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send/step' + Q));
    assert.equal(done.body.send.state, 'written', JSON.stringify(done.body.send));
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 2: perio DELETE-EXAM is refused and no DELETE reaches Open Dental', async () => {
  withSwitch('off');
  const od = perioOd({
    date: DATE,
    patNum: NOT_A_TEST_PATIENT,
    afterMeasure: (row) => {
      if (row.IntTooth === 30 && row.SequenceType === 'Probing') row.DLvalue = 0;
    },
  });
  const app = await bootHygApp({ od: od.client });
  try {
    await open(app);
    const chart = contract.withPerioSite(fullMouth(() => 2), 30, 'DL', { depth: null });
    const write = await stagePerio(app, chart);
    const stopped = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: perioConfirmBody(write) }));
    assert.equal(stopped.body.send.state, 'incomplete', JSON.stringify(stopped.body.send));

    withSwitch('on');
    assertRefused(await api(app.baseUrl, 'POST', BASE + '/perio/send/delete-exam' + Q, { body: { examNum: 7001 } }));
    assert.deepEqual(od.state.deletes, []);
    assert.equal(od.state.exams.length, 1, 'the exam is still there');

    withSwitch('off');
    const deleted = await api(app.baseUrl, 'POST', BASE + '/perio/send/delete-exam' + Q, { body: { examNum: 7001 } });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.deepEqual(od.state.deletes, [7001]);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 2: perio AMEND and REMOVE-REPLACED are refused; the correction and the swap stay where they were', async () => {
  withSwitch('off');
  let failDelete = true;
  const od = perioOd({
    date: DATE,
    patNum: NOT_A_TEST_PATIENT,
    onDelete: (num) =>
      failDelete && num === 7001 ? { ok: false, status: 503, data: null, error: 'Open Dental is unavailable' } : null,
  });
  const app = await bootHygApp({ od: od.client });
  try {
    await open(app);
    const chart = fullMouth();
    const first = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, {
      body: perioConfirmBody(await stagePerio(app, chart)),
    }));
    assert.equal(first.body.send.state, 'written');

    // AMEND, gated.
    withSwitch('on');
    assertRefused(await api(app.baseUrl, 'POST', BASE + '/perio/amend' + Q));
    assert.equal(states(app).perio, 'Written', 'still Written — the chart was not opened for correction');

    // Gate off: open the correction, send it, and let the old exam's delete fail.
    withSwitch('off');
    assert.equal((await api(app.baseUrl, 'POST', BASE + '/perio/amend' + Q)).status, 200);
    const corrected = contract.withPerioSite(chart, 14, 'B', { depth: 9 });
    const swapped = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, {
      body: perioConfirmBody(await stagePerio(app, corrected)),
    }));
    assert.match(swapped.body.send.errorMessage, /7001, is STILL in Open Dental/);
    failDelete = false;

    // REMOVE-REPLACED, gated.
    withSwitch('on');
    assertRefused(await api(app.baseUrl, 'POST', BASE + '/perio/send/remove-replaced' + Q, { body: { examNum: 7001 } }));
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [7001, 7002], 'the replaced exam is untouched');

    withSwitch('off');
    const removed = await api(app.baseUrl, 'POST', BASE + '/perio/send/remove-replaced' + Q, { body: { examNum: 7001 } });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(od.state.exams.map((e) => e.PerioExamNum), [7002]);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 2: RETRY of a failed write is refused, so a non-test patient cannot have one re-armed', async () => {
  withSwitch('off');
  let refuse = true;
  const od = perioOd({
    date: DATE,
    patNum: NOT_A_TEST_PATIENT,
    onExam: () => (refuse ? { ok: false, status: 400, data: null, error: 'ProvNum is not a valid provider.' } : null),
  });
  const app = await bootHygApp({ od: od.client });
  try {
    await open(app);
    const write = await stagePerio(app);
    const res = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: perioConfirmBody(write) });
    assert.equal(res.body.send.state, 'refused');
    assert.equal(states(app).perio, 'Failed');
    refuse = false;

    withSwitch('on');
    assertRefused(await api(app.baseUrl, 'POST', BASE + '/staged-writes/perio/retry' + Q));
    assert.equal(states(app).perio, 'Failed', 'not put back on the list');
    const denial = app.db.audit.filter((r) => r.resource_type === 'hyg_staged_write' && r.result === 'UNAUTHORIZED');
    assert.equal(denial.length, 1);

    withSwitch('off');
    const retried = await api(app.baseUrl, 'POST', BASE + '/staged-writes/perio/retry' + Q);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(states(app).perio, 'Staged');
  } finally {
    await app.close();
  }
});

// ── 3: test patients pass through ───────────────────────────────────────────

test('ACCEPTANCE 3: with the gate ON, a test patient sends exactly as before — note, TC case and chart', async () => {
  withSwitch('on');
  const od = visitFake(12827);
  const tc = tcRecorder();
  const app = await bootHygApp({ od: od.client, tcSubmit: tc.submit });
  try {
    await open(app);
    await api(app.baseUrl, 'POST', BASE + '/items' + Q, { body: CROWN });
    const perio = await stagePerio(app);
    await stageKind(app, 'note');
    const visit = await stageKind(app, 'tc-handoff');
    const confirm = visit.stagedWrites.map((w) =>
      w.kind === 'perio'
        ? { kind: 'perio', ...perioConfirmBody(perio) }
        : { kind: w.kind, previewFingerprint: w.previewFingerprint }
    );
    const res = await api(app.baseUrl, 'POST', BASE + '/send' + Q, { body: { confirm } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      Object.fromEntries(res.body.outcomes.map((o) => [o.kind, o.state])),
      { note: 'Written', 'tc-handoff': 'Written', perio: 'Written' }
    );
    assert.equal(tc.submitted.length, 1);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 3: the office is part of the key — roland 7115 is NOT the valley fixture and is refused', async () => {
  withSwitch('on');
  const od = perioOd({ date: DATE, patNum: 7115 });
  const app = await bootHygApp({ od: od.client });
  try {
    await open(app);
    const write = await stagePerio(app);
    assertRefused(await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: perioConfirmBody(write) }));
    assert.deepEqual(od.client.writes, []);
  } finally {
    await app.close();
  }
});

// ── 4 + 5: the switch ───────────────────────────────────────────────────────

test('ACCEPTANCE 4: gate unset off-staging (prod, dev, tests) is today exactly — a non-test patient sends', async () => {
  withSwitch(undefined);
  process.env.AZURE_KEY_VAULT_NAME = 'kv-carein-prod';
  const od = perioOd({ date: DATE, patNum: NOT_A_TEST_PATIENT });
  const app = await bootHygApp({ od: od.client });
  try {
    await open(app);
    const write = await stagePerio(app);
    const done = await drain(app, await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: perioConfirmBody(write) }));
    assert.equal(done.body.send.state, 'written', JSON.stringify(done.body));
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 5: an unrecognised switch value is ON — a typo cannot remove the rail', async () => {
  for (const value of ['yes', 'true', 'false', '0', '', 'of', 'disabled']) {
    withSwitch(value);
    const od = perioOd({ date: DATE, patNum: NOT_A_TEST_PATIENT });
    const app = await bootHygApp({ od: od.client });
    try {
      await open(app);
      const write = await stagePerio(app);
      const res = await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: perioConfirmBody(write) });
      assert.equal(res.status, 422, `${JSON.stringify(value)} must mean ON`);
      assert.equal(res.body.code, 'HYG_TEST_PATIENTS_ONLY');
      assert.deepEqual(od.client.writes, []);
    } finally {
      await app.close();
    }
  }
});

test('staging with the variable ABSENT is gated by default', async () => {
  withSwitch(undefined);
  process.env.AZURE_KEY_VAULT_NAME = 'kv-carein-staging';
  const od = perioOd({ date: DATE, patNum: NOT_A_TEST_PATIENT });
  const app = await bootHygApp({ od: od.client });
  try {
    await open(app);
    const write = await stagePerio(app);
    assertRefused(await api(app.baseUrl, 'POST', BASE + '/perio/send' + Q, { body: perioConfirmBody(write) }));
    assert.deepEqual(od.client.writes, []);
  } finally {
    await app.close();
  }
});
