'use strict';

/**
 * Existing treatment → note, Router and TC (hygiene Slice 2b), through the
 * assembled /api/hyg chain and the REAL visit Send.
 *
 *   1. What she approves is what lands: the note's and the Router's previews
 *      carry the lines, and the GroupNote / Router PDF / TC body carry the same.
 *   2. Not discussed is omitted from the chart note and listed on the Router.
 *   3. An answer changed after staging refuses the whole send, nothing written.
 *   4. An answered item keeps its FROZEN snapshot after Open Dental changes.
 *   5. The Router is honest about a read that never happened or failed.
 *   6. No new Open Dental write path: GroupNote and the Images upload only,
 *      through the existing human-approved Send.
 *   7. Sending the TC handoff freezes the answers it carried.
 *
 * Synthetic rows only: roland 12827 is the staging fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
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

/** Treatment-planned rows. `/procedurelogs` also answers the appointment-procedures read. */
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
  const client = new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
    '/procedurelogs': [tpRow(), tpRow({ ProcNum: 5002, procCode: 'D2391', descript: 'Composite', ToothNum: '14', Surf: 'O', DateTP: '2026-05-01' })],
    '/procedurelogs/GroupNotes': [],
    '/definitions': [{ DefNum: 473, ItemName: 'Routers' }],
  });
  let next = 60001;
  client.writeRoutes = {
    '/procedurelogs/GroupNote': (body) => {
      const procNum = next++;
      client.routes['/procedurelogs/GroupNotes'] = [
        ...client.routes['/procedurelogs/GroupNotes'],
        { ProcNum: procNum, PatNum: body.PatNum, ProcNums: body.ProcNums, ProvNum: body.ProvNum, isSigned: false, Note: body.Note },
      ];
      return { ok: true, status: 200, data: { ProcNum: procNum } };
    },
    '/documents/Upload': { ok: true, status: 200, data: { DocNum: 4711 } },
  };
  return client;
}

/** Open the visit, add a crown, read the plan, and answer 5001. */
async function answered(app) {
  assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q)).status, 200);
  assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, { body: CROWN })).status, 201);
  const read = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + QO);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const put = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + QO, {
    body: { clinical: 'worse_urgent', patient: 'wants_to_wait', waitTimeframe: '3_months', note: 'cold sensitivity' },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
}

async function stage(app, kind) {
  const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, { body: { kind } });
  assert.equal(res.status, 201, kind + ' ' + JSON.stringify(res.body));
  return res.body.visit.stagedWrites.find((w) => w.kind === kind);
}

const confirm = (...writes) => writes.map((w) => ({ kind: w.kind, previewFingerprint: w.previewFingerprint }));

/** The text the Router PDF carries, from its (uncompressed or Flate) content stream. */
function pdfText(base64) {
  const buf = Buffer.from(base64, 'base64');
  const raw = buf.toString('latin1');
  const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((m) => {
    const bytes = Buffer.from(m[1], 'latin1');
    try {
      return zlib.inflateSync(bytes).toString('latin1');
    } catch {
      return m[1];
    }
  });
  // PDF string literals escape ( ) and \ — undo that so the text reads as written.
  return streams.join('\n').replace(/\\([()\\])/g, '$1');
}

test('what she approves is what lands: note, Router PDF and TC body all carry the answers', async () => {
  const client = od();
  const submitted = [];
  const app = await bootHygApp({
    od: client,
    tcSubmit: async (_req, { office, body }) => {
      submitted.push({ office, body });
      return { ok: true, caseId: '8f3c1d20-0000-4000-8000-000000000001' };
    },
  });
  try {
    await answered(app);
    const noteRow = await stage(app, 'note');
    const routerRow = await stage(app, 'router');
    const handoffRow = await stage(app, 'tc-handoff');

    // THE PREVIEWS SHE APPROVES.
    const noteLine = '  #30 D2740 Crown -- getting worse, moved to urgent; patient wants to wait (3 months). Note: cold sensitivity';
    assert.ok(noteRow.preview.includes('Existing treatment reviewed (1):'), noteRow.preview.join('\n'));
    assert.ok(noteRow.preview.includes(noteLine));
    assert.ok(!noteRow.preview.some((l) => /D2391/.test(l)), 'the not-discussed item is omitted from the note');
    assert.ok(routerRow.preview.includes('Existing treatment (2):'));
    assert.ok(routerRow.preview.includes('    Patient: Not discussed'), 'the Router lists it');
    assert.ok(routerRow.preview.includes('    Clinical: Getting worse -> urgent'));

    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirm(noteRow, routerRow, handoffRow) },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.outcomes.map((o) => [o.kind, o.state]), [
      ['note', 'Written'],
      ['router', 'Written'],
      ['tc-handoff', 'Written'],
    ]);

    // THE NOTE OPEN DENTAL RECEIVED is the preview's lines.
    const groupNote = client.writes.find((w) => w[2] === '/procedurelogs/GroupNote')[3];
    assert.ok(groupNote.Note.includes(noteLine.trim()));
    assert.ok(!/D2391/.test(groupNote.Note));
    // THE ROUTER PDF carries the section.
    const upload = client.writes.find((w) => w[2] === '/documents/Upload')[3];
    const text = pdfText(upload.RawBase64 || upload.rawBase64);
    assert.match(text, /Existing treatment \(2\):/);
    assert.match(text, /Patient: Not discussed/);
    // NO NEW OPEN DENTAL WRITE PATH: exactly the two the Send always made.
    assert.deepEqual(client.writes.map((w) => w[2]).sort(), ['/documents/Upload', '/procedurelogs/GroupNote']);

    // THE TC BODY: every item, server-built, no fee.
    assert.equal(submitted.length, 1);
    const tx = submitted[0].body.existingTx;
    assert.deepEqual(tx.map((i) => [i.procNum, i.patient]), [[5001, 'wants_to_wait'], [5002, 'not_discussed']]);
    assert.equal(tx[0].clinical, 'worse_urgent');
    assert.equal(tx[0].waitTimeframe, '3_months');
    assert.equal(tx[0].note, 'cold sensitivity');
    assert.ok(!('fee' in tx[0]) && !('ProcFee' in tx[0]));

    // And now they are frozen.
    const late = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + QO, {
      body: { clinical: null, patient: 'declined', waitTimeframe: null, note: null },
    });
    assert.equal(late.status, 409);
  } finally {
    await app.close();
  }
});

test('an answer changed AFTER staging refuses the whole send, and nothing is written', async () => {
  const client = od();
  const app = await bootHygApp({ od: client });
  try {
    await answered(app);
    const noteRow = await stage(app, 'note');
    const routerRow = await stage(app, 'router');
    const put = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + QO, {
      body: { clinical: null, patient: 'declined', waitTimeframe: null, note: null },
    });
    assert.equal(put.status, 200);

    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirm(noteRow, routerRow) },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PREVIEW_CHANGED');
    assert.match(res.body.error, /existing-treatment answers changed/);
    assert.deepEqual(client.writes, [], 'not one Open Dental write');
    assert.ok(app.db.hyg_staged_write.every((w) => w.state === 'Staged'), 'nothing moved to Sending');

    // Staging again picks up the answer, and the send goes.
    const note2 = await stage(app, 'note');
    assert.ok(note2.preview.some((l) => /patient declined\./.test(l)));
  } finally {
    await app.close();
  }
});

test('a note staged BEFORE any answer is refused once one is given', async () => {
  const client = od();
  const app = await bootHygApp({ od: client });
  try {
    assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q)).status, 200);
    const noteRow = await stage(app, 'note');
    assert.equal(noteRow.preview.some((l) => l.startsWith('Existing treatment')), false);
    await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + QO);
    await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + QO, {
      body: { clinical: null, patient: 'ready_to_schedule', waitTimeframe: null, note: null },
    });
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, { body: { confirm: confirm(noteRow) } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PREVIEW_CHANGED');
    assert.deepEqual(client.writes, []);
  } finally {
    await app.close();
  }
});

test('an answered item keeps its FROZEN snapshot after Open Dental changes; the rest follow the new read', async () => {
  const client = od();
  const app = await bootHygApp({ od: client });
  try {
    await answered(app);
    // Open Dental changes both procedures after she answered 5001.
    client.routes['/procedurelogs'] = [
      tpRow({ procCode: 'D2750', descript: 'Crown edited in OD', ToothNum: '31' }),
      tpRow({ ProcNum: 5002, procCode: 'D2392', descript: 'Composite edited in OD', ToothNum: '15', Surf: 'MO', DateTP: '2026-05-01' }),
    ];
    const refreshed = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + QO + '&refresh=1');
    assert.equal(refreshed.status, 200);

    const routerRow = await stage(app, 'router');
    const p = routerRow.preview.join('\n');
    assert.match(p, /#30 D2740 Crown/, 'the answered item, as it was when answered');
    assert.doesNotMatch(p, /Crown edited in OD/);
    assert.match(p, /#15 MO D2392 Composite edited in OD/, 'the unanswered item, as Open Dental says now');
  } finally {
    await app.close();
  }
});

test('the Router is honest: a failed read says so, a never-loaded plan prints nothing', async () => {
  const client = od();
  client.routes['/procedurelogs'] = { ok: false, status: 500, data: null, error: 'An unexpected error occurred' };
  const app = await bootHygApp({ od: client });
  try {
    assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q)).status, 200);
    // Never loaded: no section.
    const before = await stage(app, 'router');
    assert.ok(!before.preview.some((l) => /existing treatment/i.test(l)));
    await api(app.baseUrl, 'DELETE', '/api/hyg/visit/900001/staged-writes/router' + Q);

    // The read fails.
    const read = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + QO);
    assert.equal(read.status, 502);
    assert.equal(app.db.hyg_visit[0].existing_tx_read.status, 'failed');
    const after = await stage(app, 'router');
    assert.ok(after.preview.includes('Existing treatment could not be loaded from Open Dental.'));
    assert.ok(!after.preview.some((l) => /none planned/.test(l)));
  } finally {
    await app.close();
  }
});

test('a failure after a successful read leaves the loaded plan on the Router', async () => {
  const client = od();
  const app = await bootHygApp({ od: client });
  try {
    await answered(app);
    client.routes['/procedurelogs'] = { ok: false, status: 500, data: null, error: 'down' };
    const read = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + QO + '&refresh=1');
    assert.equal(read.status, 502);
    assert.equal(app.db.hyg_visit[0].existing_tx_read.status, 'loaded');
  } finally {
    await app.close();
  }
});

test('sending the TC handoff alone freezes the answers it carried', async () => {
  const client = od();
  const app = await bootHygApp({
    od: client,
    tcSubmit: async () => ({ ok: true, caseId: '8f3c1d20-0000-4000-8000-000000000002' }),
  });
  try {
    await answered(app);
    const handoff = await stage(app, 'tc-handoff');
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, { body: { confirm: confirm(handoff) } });
    assert.equal(res.status, 200);
    assert.deepEqual(client.writes, [], 'a TC handoff writes nothing to Open Dental');
    const late = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5002' + QO, {
      body: { clinical: null, patient: 'declined', waitTimeframe: null, note: null },
    });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'EXISTING_TX_FROZEN');
  } finally {
    await app.close();
  }
});

test('the checkout alert carries the answers, built from the stored rows', async (t) => {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' ? { key, value: { roland: true }, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
  });
  const calls = [];
  const app = await bootHygApp({
    od: od(),
    checkoutSubmit: async (_req, { body }) => {
      calls.push(body);
      return { ok: true, handoffId: '5d2a7e10-0000-4000-8000-0000000000c1', replayed: false, final: body.final === true };
    },
  });
  try {
    await answered(app);
    // The appointment snapshot (the name the handoff carries) is recorded by the visit GET.
    assert.equal((await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q)).status, 200);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/checkout/alert' + Q);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(calls.length, 1);
    const tx = calls[0].snapshot.existingTx;
    assert.deepEqual(tx.map((i) => [i.procNum, i.patient]), [[5001, 'wants_to_wait'], [5002, 'not_discussed']]);
  } finally {
    await app.close();
  }
});
