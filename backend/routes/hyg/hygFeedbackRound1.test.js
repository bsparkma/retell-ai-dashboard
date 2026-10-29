'use strict';

/**
 * Feedback round 1, item C, through the assembled /api/hyg chain: a visit with
 * NO "Treatment identified today" item but an existing-treatment answer TC has
 * to act on can stage the handoff, send it, and alert checkout. Beau hit the
 * opposite on staging: the card stayed unavailable and nothing could be sent.
 *
 * Also: the note's signature block, as the STAGE route builds it, names only
 * the examining doctor the stored slip picked (A1).
 *
 * Synthetic rows only: roland 12827 is the staging fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const { FakeOd, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');

// No real staff in tests: the synthetic roster stands in for the shipped lists
// for this whole file (Practice staff page).
const { useSyntheticStaff } = require('../../config/hygStaff.fixture');
useSyntheticStaff();

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const QO = '?office=roland';

function od() {
  return new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
    '/procedurelogs': [
      {
        ProcNum: 5001, PatNum: 12827, AptNum: 0, ProcStatus: 'TP', ProcFee: '1200.00',
        procCode: 'D2740', descript: 'Crown', ToothNum: '30', Surf: '', DateTP: '2026-06-20',
        priority: '', ClinicNum: 0,
      },
    ],
    '/procedurelogs/GroupNotes': [],
    '/definitions': [{ DefNum: 473, ItemName: 'Routers' }],
  });
}

async function openAndAnswer(app, patient) {
  assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q)).status, 200);
  assert.equal((await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/existing-tx' + QO)).status, 200);
  const put = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/existing-tx/5001' + QO, {
    body: { clinical: null, patient, waitTimeframe: null, note: null },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
}

test('C: no new treatment + "ready to schedule" stages and SENDS the handoff, with an empty treatment list', async () => {
  const submitted = [];
  const app = await bootHygApp({
    od: od(),
    tcSubmit: async (_req, { body }) => {
      submitted.push(body);
      return { ok: true, caseId: '8f3c1d20-0000-4000-8000-000000000001' };
    },
  });
  try {
    await openAndAnswer(app, 'ready_to_schedule');
    const staged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'tc-handoff' },
    });
    assert.equal(staged.status, 201, JSON.stringify(staged.body));
    const row = staged.body.visit.stagedWrites.find((w) => w.kind === 'tc-handoff');
    assert.ok(row.preview.includes('Treatment identified today: none'));

    const sent = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: [{ kind: 'tc-handoff', previewFingerprint: row.previewFingerprint }] },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(submitted.length, 1, JSON.stringify(sent.body.visit && sent.body.visit.stagedWrites.map((w) => [w.kind, w.state, w.errorMessage])));
    assert.equal(submitted[0].suspectedTreatment, '', 'an explicitly empty treatment list');
    assert.deepEqual(submitted[0].existingTx.map((i) => [i.procNum, i.patient]), [[5001, 'ready_to_schedule']]);
  } finally {
    await app.close();
  }
});

test('C: an answer that is not TC work ("declined") still has nothing to hand off', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await openAndAnswer(app, 'declined');
    const staged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'tc-handoff' },
    });
    assert.equal(staged.status, 422);
    assert.equal(staged.body.code, 'NOTHING_TO_STAGE');
  } finally {
    await app.close();
  }
});

test('C: the checkout alert goes with no treatment items, carrying the answer', async (t) => {
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
    await openAndAnswer(app, 'cost_questions');
    assert.equal((await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q)).status, 200);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/checkout/alert' + Q);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(calls[0].snapshot.procedures, []);
    assert.equal(calls[0].snapshot.existingTx[0].patient, 'cost_questions');
  } finally {
    await app.close();
  }
});

test('A1: the staged note names only the examining doctor the stored slip picked', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    const open = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    assert.equal(open.status, 200);
    const slip = {
      ...open.body.visit.slip,
      visitType: 'adult_prophy_recall',
      visitTypeSource: 'manual',
      noteFields: { drs: { grades: ['Quinn Example'], detail: '' } },
    };
    const saved = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, { body: { slip } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const staged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, { body: { kind: 'note' } });
    assert.equal(staged.status, 201, JSON.stringify(staged.body));
    const text = staged.body.visit.stagedWrites.find((w) => w.kind === 'note').preview.join('\n');
    assert.ok(text.includes('Quinn Example DDS #9003'));
    assert.ok(!text.includes('Drew Example DDS'), 'a doctor who did not examine is not named');
    assert.ok(!text.includes('Morgan Example DDS'), 'a doctor who did not examine is not named');
  } finally {
    await app.close();
  }
});

test('review fix H1: a doctor picked on an exam template does not follow the slip to one without an exam', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    const open = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    for (const visitType of ['perio_maint', 'srp_quad_1', 'laser', 'fl2', null]) {
      const slip = {
        ...open.body.visit.slip,
        visitType,
        visitTypeSource: visitType ? 'manual' : null,
        // Tapped on Adult Prophy Recall, then the type was switched: the pick survives.
        noteFields: { drs: { grades: ['Quinn Example'], detail: '' } },
      };
      const saved = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, { body: { slip } });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const staged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, { body: { kind: 'note' } });
      assert.equal(staged.status, 201, JSON.stringify(staged.body));
      const text = staged.body.visit.stagedWrites.find((w) => w.kind === 'note').preview.join('\n');
      assert.ok(!text.includes('Quinn Example'), `${visitType}: a stale examiner was printed`);
    }
  } finally {
    await app.close();
  }
});
