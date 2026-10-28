'use strict';

/**
 * Checkout v2, through the assembled /api/hyg chain.
 *
 *   - The medical-history answer reaches the staged note, and changing it after
 *     staging marks the NOTE out of date (reason: medical_history) — not the
 *     Router, and no other slip field does. The Send refuses the stale note.
 *   - A visit with only something to collect at checkout opens NO TC case
 *     (checkout v2 fix): the handoff is refused, and the visit Send carries the
 *     list on the checkout alert alone. The alert carries it with the records
 *     the treatment needs.
 *   - A staged handoff goes out of date when what TC would receive changes.
 *   - The day card's tc step stays not-applicable for a collect-only visit.
 *
 * Synthetic rows only: roland 12827 is the staging fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const { FakeOd, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;

const CROWN = {
  teeth: [30], code: 'Crown', category: 'Restorative', surfaces: [], dx: ['D'],
  priority: 'urgent', motivation: [], status: 'proposed', scheduleNext: false, photos: [],
};

function od() {
  return new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
    '/procedurelogs': [],
    '/procedurelogs/GroupNotes': [],
    '/definitions': [{ DefNum: 473, ItemName: 'Routers' }],
  });
}

/** od(), plus a GroupNote that lands and reads back (hygCheckoutAlert.test.js's helper). */
function odWithNoteWrites() {
  const client = od();
  client.routes['/procedurelogs'] = [{ ProcNum: 5001 }];
  client.routes['/providers'] = [{ ProvNum: 1, Abbr: 'DOC1' }, { ProvNum: 7, Abbr: 'HYG1' }];
  client.routes['/definitions'] = [{ DefNum: 401, ItemName: 'ODHQ' }, { DefNum: 473, ItemName: 'Routers' }];
  let nextProcNum = 60001;
  client.writeRoutes = {
    '/procedurelogs/GroupNote': (body) => {
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
    },
  };
  return client;
}

async function openWith(app, slipPatch) {
  const open = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
  assert.equal(open.status, 200, JSON.stringify(open.body));
  return saveSlip(app, { ...open.body.visit.slip, ...slipPatch });
}

async function saveSlip(app, slip) {
  const saved = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, { body: { slip } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return saved.body.visit;
}

async function stage(app, kind) {
  const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, { body: { kind } });
  assert.equal(res.status, 201, kind + ' ' + JSON.stringify(res.body));
  return res.body.visit;
}

const byKind = (visit, kind) => visit.stagedWrites.find((w) => w.kind === kind);

function checkoutOn(t) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' ? { key, value: { roland: true }, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
  });
}

test('medical history: it reaches the note; changing it marks the NOTE out of date, and the Send refuses', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    let visit = await openWith(app, {
      visitType: 'adult_prophy_recall',
      visitTypeSource: 'manual',
      medicalHistory: { status: 'no_changes' },
    });
    await stage(app, 'router');
    visit = await stage(app, 'note');
    const note = byKind(visit, 'note');
    assert.equal(note.preview[1], 'Medical history: reviewed, no changes');
    assert.equal(note.existingTxStale, false);

    // Another slip field: nothing goes out of date (the general fix is separate).
    visit = await saveSlip(app, { ...visit.slip, frontDeskNote: 'Prefers mornings' });
    assert.equal(byKind(visit, 'note').existingTxStale, false);
    assert.equal(byKind(visit, 'router').existingTxStale, false);

    // The medical history: the note, with its reason — the Router never printed it.
    visit = await saveSlip(app, { ...visit.slip, medicalHistory: { status: 'changes', text: 'New allergy: latex' } });
    assert.equal(byKind(visit, 'note').existingTxStale, true);
    assert.equal(byKind(visit, 'note').staleReason, 'medical_history');
    assert.equal(byKind(visit, 'router').existingTxStale, false);
    assert.equal(byKind(visit, 'router').staleReason, undefined);

    const send = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: [{ kind: 'note', previewFingerprint: byKind(visit, 'note').previewFingerprint }] },
    });
    assert.equal(send.status, 409, JSON.stringify(send.body));
    assert.equal(send.body.code, 'PREVIEW_CHANGED');
    assert.match(send.body.error, /medical-history answer changed/);

    // Stage again: current, and it prints the new words.
    visit = await stage(app, 'note');
    assert.equal(byKind(visit, 'note').existingTxStale, false);
    assert.equal(byKind(visit, 'note').preview[1], 'Medical history update: New allergy: latex');
  } finally {
    await app.close();
  }
});

// RULING (checkout v2 fix): a collect-only visit used to stage and SEND a TC
// case with an empty treatment list. It sends the checkout alert ONLY now.
test('collect at checkout ALONE opens no case: the handoff is refused, the Send carries it on the checkout alert', async (t) => {
  checkoutOn(t);
  const cases = [];
  const alerts = [];
  const app = await bootHygApp({
    od: odWithNoteWrites(),
    tcSubmit: async (_req, { body }) => {
      cases.push(body);
      return { ok: true, caseId: '8f3c1d20-0000-4000-8000-0000000000c2' };
    },
    checkoutSubmit: async (_req, { body }) => {
      alerts.push(body);
      return { ok: true, handoffId: '5d2a7e10-0000-4000-8000-0000000000c5', replayed: false, final: body.final === true };
    },
  });
  try {
    // Nothing at all: refused, in the words it always used.
    const open = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    const none = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, { body: { kind: 'tc-handoff' } });
    assert.equal(none.status, 422);
    assert.equal(none.body.code, 'NOTHING_TO_STAGE');
    assert.match(none.body.error, /An empty case in a treatment coordinator's queue is worse than no case/);

    // Only something to collect: STILL refused — and it says where the list goes.
    await saveSlip(app, { ...open.body.visit.slip, collectAtCheckout: { items: ['fl2_toothpaste'], other: '' } });
    const refused = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, { body: { kind: 'tc-handoff' } });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.code, 'NOTHING_TO_STAGE');
    assert.match(refused.body.error, /checkout alert, not in a TC case/);

    // The visit Send: the note goes, the checkout alert rides it with the list,
    // and no case intake is attempted at all.
    assert.equal((await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q)).status, 200);
    const visit = await stage(app, 'note');
    const sent = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: [{ kind: 'note', previewFingerprint: byKind(visit, 'note').previewFingerprint }] },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.checkout.state, 'delivered', JSON.stringify(sent.body.checkout));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].final, true);
    assert.deepEqual(alerts[0].snapshot.collectAtCheckout, ['Fl2 toothpaste']);
    assert.equal(cases.length, 0, 'no TC case intake');
    assert.equal(sent.body.visit.stagedWrites.some((w) => w.kind === 'tc-handoff'), false);
  } finally {
    await app.close();
  }
});

test('collect items WITH treatment: the case AND the checkout alert both carry the list', async (t) => {
  checkoutOn(t);
  const cases = [];
  const alerts = [];
  const app = await bootHygApp({
    od: od(),
    tcSubmit: async (_req, { body }) => {
      cases.push(body);
      return { ok: true, caseId: '8f3c1d20-0000-4000-8000-0000000000c6' };
    },
    checkoutSubmit: async (_req, { body }) => {
      alerts.push(body);
      return { ok: true, handoffId: '5d2a7e10-0000-4000-8000-0000000000c7', replayed: false, final: body.final === true };
    },
  });
  try {
    await openWith(app, { collectAtCheckout: { items: ['sealant'], other: '' } });
    assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, { body: CROWN })).status, 201);
    const visit = await stage(app, 'tc-handoff');
    const row = byKind(visit, 'tc-handoff');
    assert.ok(row.preview.includes('Collect at checkout:'));
    assert.ok(row.preview.includes('  Sealant'));
    const sent = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: [{ kind: 'tc-handoff', previewFingerprint: row.previewFingerprint }] },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(cases.length, 1);
    assert.deepEqual(cases[0].collectAtCheckout, ['Sealant']);
    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0].snapshot.collectAtCheckout, ['Sealant']);
  } finally {
    await app.close();
  }
});

test('the checkout alert carries the collect list and the records the treatment needs', async (t) => {
  checkoutOn(t);
  const calls = [];
  const app = await bootHygApp({
    od: od(),
    checkoutSubmit: async (_req, { body }) => {
      calls.push(body);
      return { ok: true, handoffId: '5d2a7e10-0000-4000-8000-0000000000c3', replayed: false, final: body.final === true };
    },
  });
  try {
    await openWith(app, {
      collectAtCheckout: { items: ['sealant', 'mouthwash'], other: 'Floss picks' },
      recordsStatus: { 'Pre-op PA': 'on_file' },
      frontDeskNote: 'Book with the doctor',
      financialNote: 'Asked about the crown estimate',
    });
    assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, { body: CROWN })).status, 201);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/checkout/alert' + Q);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const snap = calls[0].snapshot;
    assert.deepEqual(snap.collectAtCheckout, ['Sealant', 'Mouthwash', 'Floss picks']);
    assert.deepEqual(snap.records[0], { record: 'Pre-op PA', status: 'on_file' });
    assert.equal(snap.records[1].status, 'needed');
    assert.equal(snap.frontDeskNote, 'Book with the doctor');
    assert.equal(snap.financialNote, 'Asked about the crown estimate');
  } finally {
    await app.close();
  }
});

test('a staged handoff goes out of date when what TC would receive changes, and the Send refuses it', async () => {
  const submitted = [];
  const app = await bootHygApp({
    od: od(),
    tcSubmit: async (_req, { body }) => {
      submitted.push(body);
      return { ok: true, caseId: '8f3c1d20-0000-4000-8000-0000000000c4' };
    },
  });
  try {
    let visit = await openWith(app, { collectAtCheckout: { items: ['fl2'], other: '' } });
    assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, { body: CROWN })).status, 201);
    visit = await stage(app, 'tc-handoff');
    assert.equal(byKind(visit, 'tc-handoff').existingTxStale, false);

    // The collect list changed after staging.
    visit = await saveSlip(app, { ...visit.slip, collectAtCheckout: { items: ['fl2', 'mouthwash'], other: '' } });
    assert.equal(byKind(visit, 'tc-handoff').existingTxStale, true);
    assert.equal(byKind(visit, 'tc-handoff').staleReason, 'handoff');

    const send = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: [{ kind: 'tc-handoff', previewFingerprint: byKind(visit, 'tc-handoff').previewFingerprint }] },
    });
    assert.equal(send.status, 409, JSON.stringify(send.body));
    assert.equal(send.body.code, 'PREVIEW_CHANGED');
    assert.equal(submitted.length, 0, 'nothing reached TC');

    // An item added after staging is the same: restage, then add one.
    visit = await stage(app, 'tc-handoff');
    assert.equal(byKind(visit, 'tc-handoff').existingTxStale, false);
    const added = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, {
      body: { ...CROWN, teeth: [19], priority: 'preventative' },
    });
    assert.equal(added.status, 201);
    const read = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.equal(byKind(read.body.visit, 'tc-handoff').staleReason, 'handoff');
  } finally {
    await app.close();
  }
});

// RULING (checkout v2 fix): a collect-only visit has no case to send, so the
// tc step stays not applicable (it used to read `none`, a handoff to send).
test('the day card does NOT apply the tc step to a visit with only something to collect', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    const progress = async () => {
      const r = await api(app.baseUrl, 'GET', '/api/hyg/day/progress?office=roland&apt=900001');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.progress[0].steps.tc.state;
    };
    const open = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    assert.equal(await progress(), 'not_applicable');
    await saveSlip(app, { ...open.body.visit.slip, collectAtCheckout: { items: [], other: 'Prescription toothpaste' } });
    assert.equal(await progress(), 'not_applicable', 'no case to send');
  } finally {
    await app.close();
  }
});
