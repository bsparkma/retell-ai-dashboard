'use strict';

/**
 * Existing treatment dispositions (Slice 2a), through the assembled /api/hyg
 * chain:
 *
 *   GET /api/hyg/visit/:aptNum/existing-tx
 *   PUT /api/hyg/visit/:aptNum/existing-tx/:procNum
 *
 * The claims pinned here:
 *   1. Office and PatNum come from the STORED visit. The same ProcNum in roland
 *      and valley is two procedures, and each office reads and writes only its
 *      own.
 *   2. A ProcNum that is not in this visit's own Open Dental read is a 404.
 *   3. Once the visit's note or slip is sent, the answers are frozen (409).
 *   4. An Open Dental failure is an honest error, never an empty list.
 *   5. The read audits fail-closed.
 *   6. Watch is grouped ONLY on Open Dental's explicit priority name.
 *   7. "Last discussed" comes from an EARLIER visit only.
 *
 * Synthetic rows only: staging fixture PatNums (roland 12827, valley 7115) and
 * obviously synthetic ProcNums and AptNums. No names anywhere.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeHygDb, FakeOd, bootHygApp, api } = require('./hygTestUtils');
const { ExistingTxResponseSchema, ExistingTxSaveResponseSchema } = require('../../hyg/contract.gen.cjs');

const DATE = '2026-09-08';

function visitRow(db, { office, aptNum, patNum, visitDate = DATE }) {
  const row = {
    visit_id: db.nextId('visit'),
    office,
    apt_num: aptNum,
    pat_num: patNum,
    visit_date: visitDate,
    slip: {},
    created_by: 'hygienist@carein.ai',
    created_at: new Date(),
    updated_at: new Date(),
  };
  db.hyg_visit.push(row);
  return row;
}

function stagedRow(db, visit, kind, state) {
  db.hyg_staged_write.push({
    staged_write_id: db.nextId('sw'),
    visit_id: visit.visit_id,
    office: visit.office,
    kind,
    state,
    title: '',
    summary: '',
    preview: [],
    payload: {},
    error_message: state === 'Failed' ? 'Open Dental refused the write' : null,
    written_ref: state === 'Written' ? 'ref-1' : null,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

function dispositionRow(db, visit, procNum, patient, over = {}) {
  db.hyg_existing_tx_disposition.push({
    id: db.nextId('etx'),
    office: visit.office,
    visit_id: visit.visit_id,
    pat_num: visit.pat_num,
    proc_num: procNum,
    clinical: null,
    patient,
    wait_timeframe: null,
    note: null,
    proc_snapshot: { code: 'D2392' },
    created_by: 'hygienist@carein.ai',
    created_at: new Date(),
    updated_by: 'hygienist@carein.ai',
    updated_at: new Date(),
    ...over,
  });
}

/** A synthetic treatment-planned procedurelog row, in Open Dental's shape. */
function procRow(over = {}) {
  return {
    ProcNum: 5001,
    PatNum: 12827,
    AptNum: 0,
    ProcStatus: 'TP',
    ProcFee: '120.00',
    procCode: 'D2392',
    descript: 'Resin-based composite - two surfaces, posterior',
    ToothNum: '30',
    Surf: 'MO',
    DateTP: '2026-05-01',
    Priority: 0,
    priority: '',
    ClinicNum: 0,
    ...over,
  };
}

const BODY = { clinical: null, patient: 'ready_to_schedule', waitTimeframe: null, note: null };
const Q = '?office=roland';

test('GET lists the plan newest first, with no fee, for the STORED visit’s patient', async () => {
  const db = new FakeHygDb();
  visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
  const od = new FakeOd({
    '/procedurelogs': [
      procRow({ ProcNum: 5001, DateTP: '2026-01-15' }),
      procRow({ ProcNum: 5002, DateTP: '2026-06-20', procCode: 'd2740', descript: 'Crown', ToothNum: '3', Surf: '', AptNum: 777 }),
      procRow({ ProcNum: 5003, DateTP: '0001-01-01', ToothNum: '', Surf: '', AptNum: 888 }),
      // $0 still counts: the hygiene list must not drop a watch item.
      procRow({ ProcNum: 5004, DateTP: '2026-03-02', ProcFee: '0.00' }),
    ],
    '/appointments': [
      { AptNum: 777, PatNum: 12827, AptStatus: 'Scheduled' },
      // The fake ignores AptStatus=Scheduled, so this proves the row is checked.
      { AptNum: 888, PatNum: 12827, AptStatus: 'Broken' },
    ],
  });
  const app = await bootHygApp({ db, od });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(ExistingTxResponseSchema.safeParse(res.body).success, 'the screen can read it');

    assert.deepEqual(res.body.items.map((i) => i.procNum), [5002, 5004, 5001, 5003]);
    const crown = res.body.items[0];
    assert.equal(crown.code, 'D2740');
    assert.equal(crown.scheduled, true, 'on a Scheduled appointment');
    assert.equal(res.body.items[3].scheduled, false, 'on a Broken appointment is not scheduled');
    assert.equal(res.body.items[3].dateTp, null, "OD's null date is no date");
    assert.equal(res.body.frozen, false);
    for (const item of res.body.items) {
      assert.equal(item.disposition, null);
      assert.ok(!('fee' in item) && !('ProcFee' in item), 'no fee on the wire');
    }

    // The PatNum asked for is the stored visit's. GET verbs only.
    const procCalls = od.calls.filter((c) => c.path === '/procedurelogs');
    assert.equal(procCalls.length, 1);
    assert.equal(procCalls[0].params.PatNum, 12827);
    assert.equal(procCalls[0].params.ProcStatus, 'TP');
    assert.equal(procCalls[0].opts.module, 'hyg');
    assert.deepEqual(od.writes, []);

    const types = db.audit.map((a) => a.resource_type);
    assert.ok(types.includes('hyg_existing_tx'));
    assert.ok(types.includes('hyg_existing_tx_patient'));
    const patientRow = db.audit.find((a) => a.resource_type === 'hyg_existing_tx_patient');
    assert.equal(String(patientRow.resource_id), '12827');
    assert.equal(patientRow.office, 'roland');
  } finally {
    await app.close();
  }
});

test('no appointment read when no procedure is attached to one', async () => {
  const db = new FakeHygDb();
  visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
  const od = new FakeOd({ '/procedurelogs': [procRow()] });
  const app = await bootHygApp({ db, od });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q);
    assert.equal(res.status, 200);
    assert.deepEqual(od.calls.map((c) => c.path), ['/procedurelogs']);
  } finally {
    await app.close();
  }
});

test('Watch is grouped ONLY on Open Dental’s explicit priority name', async () => {
  const db = new FakeHygDb();
  visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
  const od = new FakeOd({
    '/procedurelogs': [
      procRow({ ProcNum: 6001, priority: 'Watch', Priority: 101 }),
      procRow({ ProcNum: 6002, priority: ' watch ', Priority: 101 }),
      // A DefNum with no name is not a name. Never guessed.
      procRow({ ProcNum: 6003, priority: '', Priority: 101 }),
      procRow({ ProcNum: 6004, priority: undefined, Priority: 101 }),
      // The word in a description or a different priority is not Watch.
      procRow({ ProcNum: 6005, descript: 'Watch area - recheck', priority: '' }),
      procRow({ ProcNum: 6006, priority: 'Watchlist' }),
      procRow({ ProcNum: 6007, priority: 'Urgent' }),
    ],
  });
  const app = await bootHygApp({ db, od });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q);
    assert.equal(res.status, 200);
    const watch = Object.fromEntries(res.body.items.map((i) => [i.procNum, i.watch]));
    assert.deepEqual(watch, {
      6001: true, 6002: true, 6003: false, 6004: false, 6005: false, 6006: false, 6007: false,
    });
    const names = Object.fromEntries(res.body.items.map((i) => [i.procNum, i.priorityName]));
    assert.equal(names[6002], 'watch', 'trimmed, as Open Dental spelled it');
    assert.equal(names[6003], null);
    assert.equal(names[6007], 'Urgent');
  } finally {
    await app.close();
  }
});

test('office isolation: the same ProcNum in roland and valley never crosses', async () => {
  const db = new FakeHygDb();
  const roland = visitRow(db, { office: 'roland', aptNum: 100, patNum: 12827 });
  const valley = visitRow(db, { office: 'valley', aptNum: 100, patNum: 7115 });
  const rolandOd = new FakeOd({ '/procedurelogs': [procRow({ ProcNum: 5001, procCode: 'D2392' })] });
  const valleyOd = new FakeOd({
    '/procedurelogs': [
      procRow({ ProcNum: 5001, PatNum: 7115, procCode: 'D4341', descript: 'Perio scaling' }),
      procRow({ ProcNum: 7001, PatNum: 7115, procCode: 'D2740' }),
    ],
  });
  const app = await bootHygApp({
    db,
    od: new FakeOd({}),
    odByOffice: { roland: rolandOd, valley: valleyOd },
    hygOffices: ['roland', 'valley'],
  });
  try {
    const put = await api(app.baseUrl, 'PUT', '/api/hyg/visit/100/existing-tx/5001?office=valley', {
      body: { ...BODY, patient: 'declined' },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.ok(ExistingTxSaveResponseSchema.safeParse(put.body).success);

    // Stored on VALLEY's visit, with VALLEY's PatNum and valley's procedure.
    assert.equal(db.hyg_existing_tx_disposition.length, 1);
    const stored = db.hyg_existing_tx_disposition[0];
    assert.equal(stored.office, 'valley');
    assert.equal(stored.visit_id, valley.visit_id);
    assert.equal(stored.pat_num, 7115);
    assert.equal(stored.proc_snapshot.code, 'D4341');

    // Each office asked its OWN database, for its OWN patient.
    assert.ok(valleyOd.calls.every((c) => c.params.PatNum === 7115));
    assert.equal(rolandOd.calls.length, 0, 'a valley request never reaches roland');

    // Roland's same AptNum and same ProcNum shows nothing answered.
    const rolandGet = await api(app.baseUrl, 'GET', '/api/hyg/visit/100/existing-tx?office=roland');
    assert.equal(rolandGet.status, 200);
    assert.equal(rolandGet.body.items.length, 1);
    assert.equal(rolandGet.body.items[0].code, 'D2392');
    assert.equal(rolandGet.body.items[0].disposition, null);
    assert.ok(rolandOd.calls.every((c) => c.params.PatNum === 12827));

    // A ProcNum only in valley's plan is not in roland's.
    const cross = await api(app.baseUrl, 'PUT', '/api/hyg/visit/100/existing-tx/7001?office=roland', {
      body: BODY,
    });
    assert.equal(cross.status, 404);
    assert.equal(cross.body.code, 'PROC_NOT_IN_PLAN');
    assert.ok(!db.hyg_existing_tx_disposition.some((d) => d.visit_id === roland.visit_id));
  } finally {
    await app.close();
  }
});

test('a ProcNum not in this visit’s plan is a 404 and stores nothing', async () => {
  const db = new FakeHygDb();
  visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
  const od = new FakeOd({ '/procedurelogs': [procRow({ ProcNum: 5001 })] });
  const app = await bootHygApp({ db, od });
  try {
    const res = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5999' + Q, { body: BODY });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'PROC_NOT_IN_PLAN');
    assert.equal(db.hyg_existing_tx_disposition.length, 0);
    assert.deepEqual(od.writes, []);
  } finally {
    await app.close();
  }
});

test('frozen after send: a sent note, slip or TC handoff refuses edits with 409; a sent perio chart does not', async () => {
  for (const [kind, state, frozen] of [
    ['note', 'Written', true],
    ['router', 'Written', true],
    ['router', 'Sending', true],
    ['note', 'Failed', true],
    // Amending is reached only from Written: a visit being amended was sent.
    ['note', 'Amending', true],
    ['note', 'Staged', false],
    ['router', 'Draft', false],
    ['perio', 'Written', false],
    // Slice 2b: the handoff now CARRIES these answers, so sending it freezes
    // them — what TC holds and what the visit says can never disagree.
    ['tc-handoff', 'Written', true],
    ['tc-handoff', 'Sending', true],
    ['tc-handoff', 'Staged', false],
  ]) {
    const db = new FakeHygDb();
    const visit = visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
    stagedRow(db, visit, kind, state);
    const od = new FakeOd({ '/procedurelogs': [procRow({ ProcNum: 5001 })] });
    const app = await bootHygApp({ db, od });
    try {
      const put = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + Q, { body: BODY });
      const label = `${kind} ${state}`;
      if (frozen) {
        assert.equal(put.status, 409, label);
        assert.equal(put.body.code, 'EXISTING_TX_FROZEN', label);
        assert.equal(db.hyg_existing_tx_disposition.length, 0, label);
        assert.equal(od.calls.length, 0, `${label}: a frozen visit costs no Open Dental request`);
      } else {
        assert.equal(put.status, 200, label);
      }
      const get = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q);
      assert.equal(get.body.frozen, frozen, label);
    } finally {
      await app.close();
    }
  }
});

test('the freeze is re-checked INSIDE the write, not only before it', async () => {
  const db = new FakeHygDb();
  const visit = visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
  const od = new FakeOd({ '/procedurelogs': [procRow({ ProcNum: 5001 })] });
  // The send starts between the route's early check and its upsert.
  const original = od.apiGetRaw.bind(od);
  od.apiGetRaw = async (...args) => {
    stagedRow(db, visit, 'note', 'Sending');
    return original(...args);
  };
  const app = await bootHygApp({ db, od });
  try {
    const put = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + Q, { body: BODY });
    assert.equal(put.status, 409);
    assert.equal(put.body.code, 'EXISTING_TX_FROZEN');
    assert.equal(db.hyg_existing_tx_disposition.length, 0);
  } finally {
    await app.close();
  }
});

test('an Open Dental failure is an honest error, never an empty list — and is not cached', async () => {
  const db = new FakeHygDb();
  visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
  const od = new FakeOd({
    '/procedurelogs': { ok: false, status: 500, data: null, error: 'An unexpected error occurred' },
  });
  const app = await bootHygApp({ db, od });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q);
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'OD_READ_FAILED');
    assert.equal(res.body.error, "Couldn't load existing treatment from Open Dental");
    assert.ok(!('items' in res.body), 'no list at all — not an empty one');
    const denial = db.audit.find((a) => a.resource_type === 'hyg_existing_tx');
    assert.equal(denial.result, 'ERROR');

    // The PUT can't verify the plan either, so it refuses the same way.
    const put = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + Q, { body: BODY });
    assert.equal(put.status, 502);
    assert.equal(db.hyg_existing_tx_disposition.length, 0);

    // Open Dental recovers: the next try asks again rather than replaying the failure.
    od.routes['/procedurelogs'] = [procRow()];
    const again = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q);
    assert.equal(again.status, 200);
    assert.equal(again.body.items.length, 1);
  } finally {
    await app.close();
  }
});

test('an office that is not ready refuses, and asks Open Dental nothing', async () => {
  const db = new FakeHygDb();
  visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
  const od = new FakeOd({ '/procedurelogs': [procRow()] });
  const app = await bootHygApp({ db, od, odUnavailableFor: ['roland'] });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q);
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'OFFICE_NOT_READY');
    assert.equal(od.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('audit fail-closed: no trail, no treatment plan', async () => {
  const db = new FakeHygDb();
  visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
  const od = new FakeOd({ '/procedurelogs': [procRow()] });
  const app = await bootHygApp({ db, od });
  try {
    db.failAudit = true;
    const res = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q);
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'AUDIT_FAILED');
    assert.ok(!('items' in res.body));
  } finally {
    await app.close();
  }
});

test('no started visit: 404, and Open Dental is not asked', async () => {
  const db = new FakeHygDb();
  const od = new FakeOd({ '/procedurelogs': [procRow()] });
  const app = await bootHygApp({ db, od });
  try {
    const get = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q);
    assert.equal(get.status, 404);
    assert.equal(get.body.code, 'VISIT_NOT_FOUND');
    const put = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + Q, { body: BODY });
    assert.equal(put.status, 404);
    assert.equal(od.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('the read is cached per visit; Retry with refresh=1 asks again; a PUT reuses it', async () => {
  const db = new FakeHygDb();
  visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
  const od = new FakeOd({ '/procedurelogs': [procRow({ ProcNum: 5001 })] });
  const app = await bootHygApp({ db, od });
  const reads = () => od.calls.filter((c) => c.path === '/procedurelogs').length;
  try {
    await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q);
    await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q);
    assert.equal(reads(), 1);
    const put = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + Q, { body: BODY });
    assert.equal(put.status, 200);
    assert.equal(reads(), 1, 'a chip tap does not cost an Open Dental request');
    await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q + '&refresh=1');
    assert.equal(reads(), 2);
    // Every audited read is audited, cache hit or not.
    const visitReads = db.audit.filter((a) => a.resource_type === 'hyg_existing_tx' && a.action === 'READ');
    assert.equal(visitReads.length, 3);
  } finally {
    await app.close();
  }
});

test('two reads at once on a cold cache cost ONE Open Dental read', async () => {
  const db = new FakeHygDb();
  visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
  const od = new FakeOd({ '/procedurelogs': [procRow({ ProcNum: 5001 })] });
  // Open Dental is slow (seconds, in life), so the three requests overlap.
  const original = od.apiGetRaw.bind(od);
  od.apiGetRaw = async (...args) => {
    await new Promise((r) => setTimeout(r, 300));
    return original(...args);
  };
  const app = await bootHygApp({ db, od });
  try {
    const [a, b, c] = await Promise.all([
      api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q),
      api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q + '&refresh=1'),
      api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + Q, { body: BODY }),
    ]);
    assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
    assert.equal(od.calls.filter((x) => x.path === '/procedurelogs').length, 1);
  } finally {
    await app.close();
  }
});

test('PUT stores the whole disposition with the SERVER’s snapshot, and reads it back', async () => {
  const db = new FakeHygDb();
  visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
  const od = new FakeOd({
    '/procedurelogs': [procRow({ ProcNum: 5001, priority: 'Watch', ToothNum: '19', Surf: 'DO' })],
  });
  const app = await bootHygApp({ db, od });
  try {
    const put = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + Q, {
      body: { clinical: 'worse_urgent', patient: 'wants_to_wait', waitTimeframe: '3_months', note: '  sensitive to cold  ' },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(
      { ...put.body.disposition, updatedAt: undefined },
      {
        clinical: 'worse_urgent',
        patient: 'wants_to_wait',
        waitTimeframe: '3_months',
        note: 'sensitive to cold',
        updatedBy: 'hygienist@carein.ai',
        updatedAt: undefined,
      }
    );
    assert.deepEqual(db.hyg_existing_tx_disposition[0].proc_snapshot, {
      code: 'D2392',
      description: 'Resin-based composite - two surfaces, posterior',
      tooth: '19',
      surface: 'DO',
      date_tp: '2026-05-01',
      priority_name: 'Watch',
      // Slice 2b: the Router's "Already scheduled", as the server's read said it.
      scheduled: false,
    });
    const update = db.audit.find((a) => a.action === 'UPDATE');
    assert.equal(update.resource_type, 'hyg_existing_tx');
    assert.equal(update.source_ref, 'proc_num:5001');

    // Back to "not discussed" is an ordinary save; the row stays, the answer clears.
    const reset = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + Q, {
      body: { clinical: null, patient: 'not_discussed', waitTimeframe: null, note: '   ' },
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.disposition.note, null, 'a blank note is no note');
    assert.equal(db.hyg_existing_tx_disposition.length, 1);

    const get = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + Q);
    assert.equal(get.body.items[0].disposition.patient, 'not_discussed');
    assert.deepEqual(od.writes, []);
  } finally {
    await app.close();
  }
});

test('the PUT body is refused when it is not a disposition', async () => {
  const db = new FakeHygDb();
  visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827 });
  const od = new FakeOd({ '/procedurelogs': [procRow({ ProcNum: 5001 })] });
  const app = await bootHygApp({ db, od });
  try {
    const cases = [
      [{ ...BODY, waitTimeframe: '6_months' }, 'waitTimeframe'],
      [{ ...BODY, note: 'x'.repeat(501) }, 'note'],
      [{ ...BODY, patient: 'maybe' }, 'patient'],
      [{ ...BODY, clinical: 'better' }, 'clinical'],
      // The client cannot supply the snapshot: it is the server's read.
      [{ ...BODY, code: 'D0000' }, 'code'],
    ];
    for (const [body, field] of cases) {
      const res = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + Q, { body });
      assert.equal(res.status, 400, field);
      assert.equal(res.body.code, 'INVALID_BODY', field);
      assert.equal(res.body.field, field);
    }
    const bad = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/abc' + Q, { body: BODY });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_PROC_NUM');
    assert.equal(db.hyg_existing_tx_disposition.length, 0);
  } finally {
    await app.close();
  }
});

test('last discussed picks the most recent EARLIER visit only, same office, patient and procedure', async () => {
  const db = new FakeHygDb();
  const current = visitRow(db, { office: 'roland', aptNum: 900005, patNum: 12827, visitDate: '2026-09-08' });
  const older = visitRow(db, { office: 'roland', aptNum: 900001, patNum: 12827, visitDate: '2026-01-10' });
  const earlier = visitRow(db, { office: 'roland', aptNum: 900002, patNum: 12827, visitDate: '2026-06-01' });
  const quiet = visitRow(db, { office: 'roland', aptNum: 900003, patNum: 12827, visitDate: '2026-07-01' });
  const later = visitRow(db, { office: 'roland', aptNum: 900006, patNum: 12827, visitDate: '2026-10-01' });
  const otherOffice = visitRow(db, { office: 'valley', aptNum: 900004, patNum: 12827, visitDate: '2026-08-01' });
  dispositionRow(db, older, 5001, 'ready_to_schedule');
  dispositionRow(db, earlier, 5001, 'wants_to_wait', { wait_timeframe: '6_months', clinical: 'no_change' });
  // Not discussed is not "discussed", however recent.
  dispositionRow(db, quiet, 5001, 'not_discussed');
  // A later visit is not an earlier one.
  dispositionRow(db, later, 5001, 'declined');
  // Same number, other office: a different procedure.
  dispositionRow(db, otherOffice, 5001, 'cost_questions');
  // This visit's own answer is the disposition, not "last discussed".
  dispositionRow(db, current, 5001, 'see_plan_again');
  // A procedure only ever discussed later has no line.
  dispositionRow(db, later, 5002, 'declined');

  const od = new FakeOd({
    '/procedurelogs': [procRow({ ProcNum: 5001 }), procRow({ ProcNum: 5002, DateTP: '2026-02-01' })],
  });
  const app = await bootHygApp({ db, od });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/visit/900005/existing-tx' + Q);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const byProc = Object.fromEntries(res.body.items.map((i) => [i.procNum, i]));
    assert.deepEqual(byProc[5001].lastDiscussed, {
      visitDate: '2026-06-01',
      patient: 'wants_to_wait',
      waitTimeframe: '6_months',
      clinical: 'no_change',
    });
    assert.equal(byProc[5001].disposition.patient, 'see_plan_again');
    assert.equal(byProc[5002].lastDiscussed, null);
  } finally {
    await app.close();
  }
});
