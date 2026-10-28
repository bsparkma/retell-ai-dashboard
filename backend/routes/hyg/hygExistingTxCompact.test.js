'use strict';

/**
 * Existing treatment — the stale-staging fix and the bulk answer.
 *
 *   1. An answer saved AFTER the note or Router was staged marks that write
 *      `existingTxStale` — in the save's own response and on the visit GET —
 *      by the server's digest, the same comparison the Send refuses on.
 *   2. Staging again clears it. The handoff never goes stale (it prints no
 *      existing-treatment lines and reads the answers at send time).
 *   3. PUT /existing-tx (the bulk answer) has the single PUT's guards for every
 *      row, all or nothing: a stranger ProcNum 404s the batch, a frozen visit
 *      409s it, duplicates and oversize batches 400, and one audit row per
 *      procedure is written exactly as the single PUT writes it.
 *
 * Synthetic rows only: roland 12827 is the staging fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeOd, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const QO = '?office=roland';

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

function tpRow(over = {}) {
  return {
    ProcNum: 5001,
    PatNum: 12827,
    AptNum: 0,
    ProcStatus: 'TP',
    ProcFee: '1200.00',
    procCode: 'D2740',
    descript: 'Crown',
    ToothNum: '30',
    Surf: '',
    DateTP: '2026-06-20',
    priority: '',
    ClinicNum: 0,
    ...over,
  };
}

function od() {
  return new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
    '/procedurelogs': [
      tpRow(),
      tpRow({ ProcNum: 5002, procCode: 'D2950', descript: 'Core buildup', DateTP: '2026-06-20' }),
      tpRow({ ProcNum: 5003, procCode: 'D2391', descript: 'Composite', ToothNum: '14', Surf: 'O', DateTP: '2026-05-01' }),
    ],
    '/procedurelogs/GroupNotes': [],
    '/definitions': [{ DefNum: 473, ItemName: 'Routers' }],
  });
}

const ANSWER = { clinical: null, patient: 'wants_to_wait', waitTimeframe: '3_months', note: null };

async function opened(app) {
  assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q)).status, 200);
  assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, { body: CROWN })).status, 201);
  const read = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + QO);
  assert.equal(read.status, 200, JSON.stringify(read.body));
}

async function stage(app, kind) {
  const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, { body: { kind } });
  assert.equal(res.status, 201, kind + ' ' + JSON.stringify(res.body));
  return res.body.visit.stagedWrites.find((w) => w.kind === kind);
}

const staleOf = (writes) => Object.fromEntries(writes.map((w) => [w.kind, w.existingTxStale]));

test('an answer saved after staging marks the note and Router out of date — never the handoff', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await opened(app);
    for (const kind of ['note', 'router', 'tc-handoff']) {
      const row = await stage(app, kind);
      assert.equal(row.existingTxStale, false, `${kind} is current the moment it is staged`);
    }

    const put = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + QO, { body: ANSWER });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    // In the save's own response — the tray need not wait for another GET.
    assert.deepEqual(staleOf(put.body.stagedWrites), { note: true, router: true, 'tc-handoff': false });

    // And on the visit GET.
    const visit = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.equal(visit.status, 200);
    assert.deepEqual(staleOf(visit.body.visit.stagedWrites), { note: true, router: true, 'tc-handoff': false });

    // The flag predicts the Send's refusal exactly: it still refuses (kept).
    const note = visit.body.visit.stagedWrites.find((w) => w.kind === 'note');
    const send = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: [{ kind: 'note', previewFingerprint: note.previewFingerprint }] },
    });
    assert.equal(send.status, 409);
    assert.equal(send.body.code, 'PREVIEW_CHANGED');
  } finally {
    await app.close();
  }
});

test('staging again clears it, kind by kind', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await opened(app);
    await stage(app, 'note');
    await stage(app, 'router');
    await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + QO, { body: ANSWER });

    const restaged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, { body: { kind: 'note' } });
    assert.equal(restaged.status, 201);
    assert.deepEqual(staleOf(restaged.body.visit.stagedWrites), { note: false, router: true });
    const note = restaged.body.visit.stagedWrites.find((w) => w.kind === 'note');
    assert.ok(note.preview.some((l) => /patient wants to wait \(3 months\)/.test(l)), 'the new words say what was answered');

    await stage(app, 'router');
    const visit = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.deepEqual(staleOf(visit.body.visit.stagedWrites), { note: false, router: false });
  } finally {
    await app.close();
  }
});

test('an answer put back the way it was is current again — the digest, not a dirty bit', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await opened(app);
    await stage(app, 'note');
    const changed = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + QO, { body: ANSWER });
    assert.equal(staleOf(changed.body.stagedWrites).note, true);
    const back = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + QO, {
      body: { clinical: null, patient: 'not_discussed', waitTimeframe: null, note: null },
    });
    assert.equal(staleOf(back.body.stagedWrites).note, false, 'the note would print the same words again');
  } finally {
    await app.close();
  }
});

test('a Failed note is out of date too — its Retry re-sends the stored words', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await opened(app);
    await stage(app, 'note');
    await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + QO, { body: ANSWER });
    // Failed freezes the answers, so the change has to land before the failure.
    app.db.hyg_staged_write.find((w) => w.kind === 'note').state = 'Failed';
    const visit = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.equal(staleOf(visit.body.visit.stagedWrites).note, true);
    // A Written row is history, never "out of date".
    app.db.hyg_staged_write.find((w) => w.kind === 'note').state = 'Written';
    app.db.hyg_staged_write.find((w) => w.kind === 'note').written_ref = 'ProcNum 60001';
    const written = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.equal(staleOf(written.body.visit.stagedWrites).note, false);
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The bulk answer
// ─────────────────────────────────────────────────────────────────────────────

const bulk = (procNums, answer = ANSWER) => ({ items: procNums.map((procNum) => ({ procNum, ...answer })) });

test('bulk: every row stored in ONE statement, snapshots from the server, one audit row each', async () => {
  const client = od();
  const app = await bootHygApp({ od: client });
  try {
    await opened(app);
    await stage(app, 'note');
    const before = app.db.audit.filter((a) => a.action === 'UPDATE').length;
    const res = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx' + QO, {
      body: bulk([5001, 5002], { clinical: 'worse_urgent', patient: 'ready_to_schedule', waitTimeframe: null, note: '  ' }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.items.map((i) => i.procNum), [5001, 5002]);
    assert.ok(res.body.items.every((i) => i.disposition.patient === 'ready_to_schedule' && i.disposition.note === null));
    assert.equal(app.db.batchUpserts, 1, 'one statement, so all or nothing');
    assert.equal(app.db.hyg_existing_tx_disposition.length, 2);
    const snap = app.db.hyg_existing_tx_disposition.find((d) => d.proc_num === 5002).proc_snapshot;
    assert.equal(snap.code, 'D2950');
    assert.equal(snap.tooth, '30');
    assert.ok(app.db.hyg_existing_tx_disposition.every((d) => d.pat_num === 12827 && d.office === 'roland'));

    const updates = app.db.audit.filter((a) => a.action === 'UPDATE').slice(before);
    const tx = updates.filter((a) => a.resource_type === 'hyg_existing_tx');
    assert.deepEqual(tx.map((a) => a.source_ref).sort(), ['proc_num:5001', 'proc_num:5002']);

    // The staged note is out of date in the bulk answer's response as well.
    assert.equal(staleOf(res.body.stagedWrites).note, true);
    assert.deepEqual(client.writes, [], 'no Open Dental write');
  } finally {
    await app.close();
  }
});

test('bulk: one ProcNum not in this visit’s plan refuses the WHOLE batch with 404', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await opened(app);
    const res = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx' + QO, { body: bulk([5001, 5999]) });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'PROC_NOT_IN_PLAN');
    assert.equal(app.db.hyg_existing_tx_disposition.length, 0, 'not even the one that was in the plan');
  } finally {
    await app.close();
  }
});

test('bulk: a frozen visit is a 409 and stores nothing', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await opened(app);
    await stage(app, 'tc-handoff');
    app.db.hyg_staged_write.find((w) => w.kind === 'tc-handoff').state = 'Sending';
    const res = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx' + QO, { body: bulk([5001, 5002]) });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'EXISTING_TX_FROZEN');
    assert.equal(app.db.hyg_existing_tx_disposition.length, 0);
  } finally {
    await app.close();
  }
});

test('bulk: the freeze is re-checked inside the one statement', async () => {
  const client = od();
  const app = await bootHygApp({ od: client });
  try {
    await opened(app);
    await stage(app, 'note');
    // The send claims the note between the route's early check and the write:
    // the moment the bulk statement itself is issued.
    const original = app.db.query.bind(app.db);
    app.db.query = async (text, params) => {
      if (/jsonb_to_recordset/.test(String(text))) {
        app.db.hyg_staged_write.find((w) => w.kind === 'note').state = 'Sending';
      }
      return original(text, params);
    };
    const res = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx' + QO, { body: bulk([5001]) });
    assert.equal(res.status, 409);
    assert.equal(app.db.hyg_existing_tx_disposition.length, 0);
  } finally {
    await app.close();
  }
});

test('bulk: duplicates, an empty list, more than 200 rows and a body office are refused with 400', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await opened(app);
    const cases = [
      ['duplicate', bulk([5001, 5001])],
      ['empty', { items: [] }],
      ['oversize', bulk(Array.from({ length: 201 }, (_, i) => 6000 + i))],
      ['wait without waiting', bulk([5001], { clinical: null, patient: 'declined', waitTimeframe: '3_months', note: null })],
      ['unknown key', { items: [{ procNum: 5001, ...ANSWER, patNum: 7115 }] }],
      ['office in body', { ...bulk([5001]), office: 'valley' }],
    ];
    for (const [label, body] of cases) {
      const res = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx' + QO, { body });
      assert.equal(res.status, 400, label + ' ' + JSON.stringify(res.body));
    }
    assert.equal(app.db.hyg_existing_tx_disposition.length, 0);
  } finally {
    await app.close();
  }
});

test('bulk: no visit is a 404 and the office is the stored visit’s, not the request’s', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    const none = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx' + QO, { body: bulk([5001]) });
    assert.equal(none.status, 404);
    assert.equal(none.body.code, 'VISIT_NOT_FOUND');
    await opened(app);
    // The same AptNum asked of valley finds no valley visit — never roland's.
    const valley = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx?office=valley', { body: bulk([5001]) });
    assert.notEqual(valley.status, 200);
    assert.equal(app.db.hyg_existing_tx_disposition.length, 0);
  } finally {
    await app.close();
  }
});

test('review fix: every visit response carries the flag — open, an item edit, not only the GET', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await opened(app);
    await stage(app, 'note');
    await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + QO, { body: ANSWER });
    // A response that dropped the flag would read as "not out of date" and let
    // the tray re-enable a Send the server refuses.
    const open = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    assert.equal(open.status, 200);
    assert.equal(staleOf(open.body.visit.stagedWrites).note, true, 'open');
    const add = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, { body: { ...CROWN, teeth: [14] } });
    assert.equal(add.status, 201);
    assert.equal(staleOf(add.body.visit.stagedWrites).note, true, 'item add');
  } finally {
    await app.close();
  }
});
