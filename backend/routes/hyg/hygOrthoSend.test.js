'use strict';

/**
 * The ortho screening, end to end on the hygiene side (queue item 33).
 *
 * What is under test, by acceptance row:
 *   3  the screening autosaves with the visit and reads back; an older visit
 *      whose slip has no screening key loads without error.
 *   4  Send to TC creates exactly ONE case — category ortho, status
 *      hygiene_review, office = the visit's — and a second press creates
 *      nothing. Proven twice: against a recording TC submitter, and by posting
 *      the exact body it captured to the REAL TC intake route.
 *   5  the client's body is ignored: a forged office, PatNum, patient name and
 *      provider are discarded and the case is filed from the visit.
 *   6  TC down → an honest refusal, nothing claimed, the screening still saved
 *      and still editable.
 *   7  ZERO Open Dental calls on the send path, asserted on the fake's call log.
 *
 * Test patients only: roland 12827 (named by the fixture as "Test 2, Stedi").
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeOd, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');
const tcUtils = require('../tc/tcTestUtils');
const contract = require('../../hyg/contract.gen.cjs');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const SEND = '/api/hyg/visit/900001/ortho-screening/send?office=roland';
const CASE_ID = '8f3c1d20-0000-4000-8000-0000000000aa';

/** One roland appointment for test patient 12827, with a doctor AND a hygienist. */
function od() {
  return new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    // ProvNum 1 is the appointment's provider (the doctor); 7 is ProvHyg.
    '/providers': [
      { ProvNum: 1, Abbr: 'DOC1' },
      { ProvNum: 7, Abbr: 'HYG1' },
    ],
    // Synthetic phone, 555-01xx — a reserved fictional range.
    '/patients/12827': patientRow({ WirelessPhone: '479-555-0100' }),
  });
}

/** A screening with every group answered. */
function fullScreening() {
  return {
    ...contract.emptyOrthoScreening(),
    interest: 'yes',
    decider: 'parent',
    concerns: ['crowding', 'overbite'],
    arches: 'comprehensive',
    modality: 'aligners',
    months: [18, 24],
    phase: 'phase_1',
    upperAppliances: ['niti_rpe'],
    lowerAppliances: ['lip_bumper'],
    myo: 'before',
    myoReasons: ['tongue_thrust'],
    afterOrtho: ['anterior_bonding'],
    afterOrthoTeeth: '#7, #10',
    recordsToday: ['photos', 'pano'],
    orthoBenefit: 'not_sure',
    consult: 'phone',
    bookedFor: '2026-09-15',
    noteForTc: 'Parent asked about cost before school starts.',
  };
}

/** Open the visit the way the page does, then save a slip carrying `screening`. */
async function visitWithScreening(app, screening) {
  const page = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const opened = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const saved = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, {
    body: { slip: { ...contract.emptySlip(), orthoScreening: screening } },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return saved.body.visit;
}

/** A TC submitter that records what it was handed and answers with a case. */
function recordingTc() {
  /** @type {Array<{ office: string, body: any }>} */
  const calls = [];
  return {
    calls,
    submit: async (_req, { office, body }) => {
      calls.push({ office, body });
      return { ok: true, caseId: CASE_ID };
    },
  };
}

// ── 3. autosave and the older visit ────────────────────────────────────────

test('3: the screening saves with the visit and reads back on reload', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await visitWithScreening(app, fullScreening());
    const reload = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.equal(reload.status, 200);
    assert.deepEqual(reload.body.visit.slip.orthoScreening, fullScreening());
    // And it is stored IN the slip jsonb, beside the rest of the visit.
    assert.deepEqual(app.db.hyg_visit[0].slip.orthoScreening, fullScreening());
    assert.equal(reload.body.visit.orthoSend, null, 'not sent yet');
  } finally {
    await app.close();
  }
});

test('3: a visit saved before the screening existed loads, with orthoScreening null', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    // Yesterday's slip, as stored: no orthoScreening key at all — and none of
    // the item 33 columns either, as a row written before the migration reads.
    const old = { ...contract.emptySlip(), patientConcerns: 'Older slip' };
    delete old.orthoScreening;
    const row = app.db.hyg_visit[0];
    row.slip = old;
    delete row.appointment_snapshot;
    delete row.ortho_tc_case_id;
    delete row.ortho_sent_at;
    delete row.ortho_sent_by;
    delete row.ortho_send_claimed_at;

    const res = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.visit.slip.patientConcerns, 'Older slip', 'NOT blanked');
    assert.equal(res.body.visit.slip.orthoScreening, null);
    assert.equal(res.body.visit.orthoSend, null);
  } finally {
    await app.close();
  }
});

test('3: a screening breaking a chip rule is refused with the field named, not stored', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    const cases = [
      { ...contract.emptyOrthoScreening(), afterOrtho: ['none', 'implants'] },
      { ...contract.emptyOrthoScreening(), months: [18, 19] },
      { ...contract.emptyOrthoScreening(), noteForTc: 'x'.repeat(281) },
      { ...contract.emptyOrthoScreening(), afterOrthoTeeth: '#7, #10, #11, #12, #13, #14, #15, #16, #17' },
      { ...contract.emptyOrthoScreening(), interest: 'definitely' },
    ];
    for (const screening of cases) {
      const res = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, {
        body: { slip: { ...contract.emptySlip(), orthoScreening: screening } },
      });
      assert.equal(res.status, 400, JSON.stringify(screening));
      assert.equal(res.body.code, 'INVALID_BODY');
      assert.match(res.body.field, /orthoScreening/);
    }
    assert.equal(app.db.hyg_visit[0].slip.orthoScreening, null, 'nothing bad was stored');
  } finally {
    await app.close();
  }
});

// ── 4. exactly one case ────────────────────────────────────────────────────

test('4: Send to TC files ONE ortho case for the visit, and a second press creates nothing', async () => {
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), tcSubmit: tc.submit });
  try {
    await visitWithScreening(app, fullScreening());

    const first = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.alreadySent, false);
    assert.equal(first.body.visit.orthoSend.caseId, CASE_ID, 'the returned case id is on the visit');
    assert.match(first.body.visit.orthoSend.sentAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(first.body.visit.orthoSend.sentBy, 'hygienist@carein.ai');
    assert.equal(app.db.hyg_visit[0].ortho_tc_case_id, CASE_ID, 'persisted, not just echoed');

    assert.equal(tc.calls.length, 1);
    const { office, body } = tc.calls[0];
    assert.equal(office, 'roland', 'the visit’s office');
    assert.equal(body.category, 'ortho');
    assert.equal(body.caseType, 'Ortho screening');
    assert.equal(body.urgency, 'elective');
    assert.equal(body.odPatientId, 12827);
    assert.equal(body.patientName, 'Test 2, Stedi');
    assert.equal(body.patientAge, 36, 'from the cached birthdate, on the visit date');
    assert.equal(body.phone, '479-555-0100');
    // The appointment's provider (ProvNum 1), not the hygienist the card names.
    assert.equal(body.diagnosingProvider, 'DOC1');
    assert.equal(body.providerSeen, 'HYG1');
    assert.equal(body.chiefConcern, 'Crowding, Overbite');
    assert.equal(body.suspectedTreatment, contract.orthoScreeningSummary(fullScreening()));
    assert.match(body.suspectedTreatment, /18–24 mo/);
    assert.equal(body.hygienistRecommendation, 'Parent asked about cost before school starts.');
    assert.equal(body.patientInterestLevel, 'hot');
    assert.equal(body.intraoralPhotosTaken, true);
    assert.deepEqual(body.radiographs, ['PANO']);
    assert.equal(body.insuranceNoted, 'Not sure, TC will verify');
    assert.deepEqual(body.orthoScreening, fullScreening());

    // THE SECOND PRESS.
    const second = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(second.status, 200);
    assert.equal(second.body.alreadySent, true);
    assert.equal(second.body.visit.orthoSend.caseId, CASE_ID);
    assert.equal(tc.calls.length, 1, 'TC was not asked again — no second case');
  } finally {
    await app.close();
  }
});

test('4: the captured body, posted to the REAL TC intake, opens one hygiene_review ortho case in the visit’s office', async () => {
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), tcSubmit: tc.submit });
  let captured;
  try {
    await visitWithScreening(app, fullScreening());
    const res = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    captured = tc.calls[0];
  } finally {
    await app.close();
  }

  // The two harnesses patch the same process-wide seams, so they run one after
  // the other rather than side by side.
  const tcApp = await tcUtils.bootTcApp({ role: 'hygiene' });
  try {
    const created = await tcUtils.api(
      tcApp.baseUrl,
      'POST',
      `/api/tc/hygiene-intakes?office=${captured.office}`,
      captured.body
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const c = created.body.case;
    assert.equal(c.status, 'hygiene_review');
    assert.equal(c.category, 'ortho');
    assert.equal(c.officeId, 'roland');
    assert.equal(c.referralSource, 'hygiene');
    assert.equal(c.urgency, 'elective');
    assert.equal(c.diagnosingProvider, 'DOC1');
    assert.equal(c.odPatientId, 12827);
    assert.deepEqual(c.hygieneIntake.orthoScreening, fullScreening());
    assert.equal(tcApp.db.table('tc_cases').length, 1, 'exactly one case');
    assert.equal(tcApp.db.table('tc_hygiene_intakes').length, 1);
    assert.deepEqual(tcApp.db.table('tc_hygiene_intakes')[0].ortho_screening, fullScreening());
  } finally {
    await tcApp.close();
  }
});

test('4: a screening with ONLY "Interested?" answered is sendable; with nothing answered it is not', async () => {
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), tcSubmit: tc.submit });
  try {
    await visitWithScreening(app, contract.emptyOrthoScreening());
    const refused = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.code, 'ORTHO_NOTHING_TO_SEND');
    assert.equal(tc.calls.length, 0);

    await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, {
      body: {
        slip: {
          ...contract.emptySlip(),
          orthoScreening: { ...contract.emptyOrthoScreening(), interest: 'maybe' },
        },
      },
    });
    const sent = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(tc.calls.length, 1);
    assert.equal(tc.calls[0].body.suspectedTreatment, 'Interested: Maybe');
    assert.equal(tc.calls[0].body.chiefConcern, '');
    assert.equal(tc.calls[0].body.patientInterestLevel, 'warm');
  } finally {
    await app.close();
  }
});

// ── 5. the body is ignored ─────────────────────────────────────────────────

test('5: a forged office, PatNum, patient name and provider in the body are discarded unread', async () => {
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), tcSubmit: tc.submit });
  try {
    await visitWithScreening(app, fullScreening());
    const res = await api(app.baseUrl, 'POST', SEND, {
      body: {
        office: 'valley',
        officeId: 'valley',
        patNum: 7115,
        odPatientId: 7115,
        patientName: 'Forged Name',
        providerName: 'Dr Forged',
        diagnosingProvider: 'Dr Forged',
        category: 'implant',
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(tc.calls.length, 1);
    const { office, body } = tc.calls[0];
    assert.equal(office, 'roland');
    assert.equal(body.odPatientId, 12827);
    assert.equal(body.patientName, 'Test 2, Stedi');
    assert.equal(body.diagnosingProvider, 'DOC1');
    assert.equal(body.category, 'ortho');
    assert.doesNotMatch(JSON.stringify(body), /Forged|7115|valley/);
  } finally {
    await app.close();
  }
});

// ── 6. honest states when TC is down ───────────────────────────────────────

test('6: TC down → an honest refusal; nothing claimed; the screening stays saved and editable', async () => {
  let up = false;
  const calls = [];
  const app = await bootHygApp({
    od: od(),
    tcSubmit: async (_req, { office, body }) => {
      calls.push({ office, body });
      if (!up) return { ok: false, code: 'TC_UNREACHABLE', error: 'The TC app did not respond' };
      return { ok: true, caseId: CASE_ID };
    },
  });
  try {
    await visitWithScreening(app, fullScreening());
    const down = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(down.status, 502);
    assert.equal(down.body.success, false);
    assert.equal(down.body.code, 'TC_UNREACHABLE');
    assert.match(down.body.error, /NOT sent/);

    const row = app.db.hyg_visit[0];
    assert.equal(row.ortho_tc_case_id, null, 'no case id — nothing claimed');
    assert.equal(row.ortho_sent_at, null);
    assert.equal(row.ortho_send_claimed_at, null, 'the claim was released');
    assert.deepEqual(row.slip.orthoScreening, fullScreening(), 'still saved');

    const page = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.equal(page.body.visit.orthoSend, null, 'the page cannot say Sent');

    // Still editable: the next autosave lands.
    const edited = { ...fullScreening(), interest: 'maybe' };
    const saved = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, {
      body: { slip: { ...contract.emptySlip(), orthoScreening: edited } },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.visit.slip.orthoScreening.interest, 'maybe');

    // And when TC is back, the same button sends the EDITED screening, once.
    up = true;
    const sent = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.orthoScreening.interest, 'maybe');
  } finally {
    await app.close();
  }
});

test('6: a submitter that throws is the same honest refusal, not a 500', async () => {
  const app = await bootHygApp({
    od: od(),
    tcSubmit: async () => {
      throw new Error('socket hang up');
    },
  });
  try {
    await visitWithScreening(app, fullScreening());
    const res = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'TC_UNREACHABLE');
    assert.equal(app.db.hyg_visit[0].ortho_tc_case_id, null);
    assert.equal(app.db.hyg_visit[0].ortho_send_claimed_at, null);
  } finally {
    await app.close();
  }
});

// ── 7. zero Open Dental calls ──────────────────────────────────────────────

test('7: the send path makes ZERO Open Dental calls — the fake’s call log does not move', async () => {
  const client = od();
  const tc = recordingTc();
  const app = await bootHygApp({ od: client, tcSubmit: tc.submit });
  try {
    await visitWithScreening(app, fullScreening());
    const before = client.calls.length;
    assert.ok(before > 0, 'opening the visit did read Open Dental, so the log is live');

    const first = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const again = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(again.status, 200);

    assert.deepEqual(client.calls.slice(before), [], 'not one Open Dental read');
    assert.deepEqual(client.writes, [], 'not one Open Dental write');
  } finally {
    await app.close();
  }
});

test('7: recording the appointment snapshot costs no Open Dental request of its own', async () => {
  // Two loads of the same visit: the second must make exactly the requests the
  // first made minus the ones the caches now answer — and in particular no
  // /patients or /providers read on behalf of the snapshot.
  const client = od();
  const app = await bootHygApp({ od: client });
  try {
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    const before = client.calls.length;
    const page = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.equal(page.status, 200);
    const during = client.calls.slice(before).map((c) => c.path);
    assert.ok(!during.some((p) => p.startsWith('/patients')), 'patient came from the cache');
    assert.ok(!during.includes('/providers'), 'providers came from the cache');

    const snap = app.db.hyg_visit[0].appointment_snapshot;
    assert.equal(snap.patientName, 'Test 2, Stedi');
    assert.equal(snap.doctorName, 'DOC1');
    assert.equal(snap.providerName, 'HYG1');
    assert.equal(snap.birthdate, '1990-01-01');
    assert.equal(snap.phone, '479-555-0100');
  } finally {
    await app.close();
  }
});

// ── the rest of the contract ───────────────────────────────────────────────

test('once sent, the screening is FROZEN: an autosave keeps the sent sheet and saves the rest', async () => {
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), tcSubmit: tc.submit });
  try {
    await visitWithScreening(app, fullScreening());
    await api(app.baseUrl, 'POST', SEND, { body: {} });

    const res = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, {
      body: {
        slip: {
          ...contract.emptySlip(),
          patientConcerns: 'Edited after the send',
          orthoScreening: { ...fullScreening(), interest: 'not_now', noteForTc: 'changed' },
        },
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.visit.slip.orthoScreening, fullScreening(), 'the sheet TC got');
    assert.equal(res.body.visit.slip.patientConcerns, 'Edited after the send', 'the rest saved');
  } finally {
    await app.close();
  }
});

test('a press while another holds a FRESH claim is refused; a STALE claim is taken over', async () => {
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), tcSubmit: tc.submit });
  try {
    await visitWithScreening(app, fullScreening());
    const row = app.db.hyg_visit[0];

    row.ortho_send_claimed_at = new Date();
    const busy = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'ORTHO_SEND_IN_PROGRESS');
    assert.equal(tc.calls.length, 0, 'TC was not asked while another send is live');

    row.ortho_send_claimed_at = new Date(Date.now() - 3 * 60 * 1000);
    const taken = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(tc.calls.length, 1);
  } finally {
    await app.close();
  }
});

test('no snapshot of the appointment → a plain refusal, never a guessed name', async () => {
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), tcSubmit: tc.submit });
  try {
    await visitWithScreening(app, fullScreening());
    app.db.hyg_visit[0].appointment_snapshot = null;
    const res = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PATIENT_NAME_UNAVAILABLE');
    assert.equal(tc.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('a visit that does not exist cannot be sent', async () => {
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), tcSubmit: tc.submit });
  try {
    const res = await api(app.baseUrl, 'POST', SEND, { body: {} });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'VISIT_NOT_FOUND');
    assert.equal(tc.calls.length, 0);
  } finally {
    await app.close();
  }
});
