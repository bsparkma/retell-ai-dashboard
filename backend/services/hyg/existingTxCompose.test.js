'use strict';

/**
 * Existing treatment → the note, the Router and TC (hygiene Slice 2b). PURE.
 *
 *   - the chart-note line for every answer combination, and the OMISSION of
 *     what nobody discussed; no section at N = 0
 *   - the Router section: every item, and the three honest states
 *   - a visit with no existing-treatment data composes BYTE-FOR-BYTE what it
 *     did before this slice
 *   - buildExistingTx describes an answered item by its FROZEN snapshot, not
 *     by a later Open Dental read
 *   - TC bodies: the new field is additive, and every old shape still parses
 *
 * Synthetic data only. PatNum 12827 is the roland staging fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const composer = require('./stagedWriteComposer');
const store = require('./existingTxStore');
const tcHandoff = require('./tcHandoffClient');
const slipPdf = require('./slipPdf');
const hyg = require('../../hyg/contract.gen.cjs');
const tc = require('../../tc/contract.gen.cjs');

const VISIT = {
  visitId: 'visit-0001',
  office: 'roland',
  aptNum: 900001,
  patNum: 12827,
  visitDate: '2026-09-08',
  slip: hyg.emptySlip(),
  items: [],
  stagedWrites: [],
};

function item(over = {}) {
  return {
    procNum: 5001,
    code: 'D2740',
    description: 'Crown',
    tooth: '30',
    surface: '',
    dateTp: '2026-06-20',
    priorityName: null,
    scheduled: false,
    clinical: null,
    patient: 'not_discussed',
    waitTimeframe: null,
    note: null,
    ...over,
  };
}

const loaded = (items) => ({ status: 'loaded', items });

function note(existingTx, visit = VISIT) {
  return composer.compose('note', { visit, items: visit.items, actor: 'hygienist@carein.ai', existingTx });
}
function router(existingTx, visit = VISIT) {
  return composer.compose('router', { visit, items: visit.items, actor: 'hygienist@carein.ai', existingTx });
}

// ── the chart note ──────────────────────────────────────────────────────────

test('one note line per answer combination, in the words the chart keeps', () => {
  const cases = [
    [{ clinical: 'worse_urgent', patient: 'wants_to_wait', waitTimeframe: '3_months' },
      '#30 D2740 Crown -- getting worse, moved to urgent; patient wants to wait (3 months).'],
    [{ patient: 'wants_to_wait', waitTimeframe: 'next_recall' },
      '#30 D2740 Crown -- patient wants to wait (next recall).'],
    [{ patient: 'wants_to_wait' }, '#30 D2740 Crown -- patient wants to wait.'],
    [{ patient: 'ready_to_schedule' }, '#30 D2740 Crown -- patient ready to schedule.'],
    [{ clinical: 'no_change', patient: 'see_plan_again' },
      '#30 D2740 Crown -- no change; patient wants to see the plan again.'],
    [{ clinical: 're_evaluate', patient: 'cost_questions' },
      '#30 D2740 Crown -- needs re-evaluation; patient has cost questions.'],
    [{ clinical: 'no_longer_needed', patient: 'declined' },
      '#30 D2740 Crown -- no longer needed; patient declined.'],
    // A clinical answer alone is still something said — and the line says the
    // patient was not asked, rather than leaving it to be guessed.
    [{ clinical: 'worse_urgent' },
      '#30 D2740 Crown -- getting worse, moved to urgent; not discussed with the patient.'],
    [{ patient: 'declined', note: 'prefers to wait for insurance' },
      '#30 D2740 Crown -- patient declined. Note: prefers to wait for insurance'],
    [{ tooth: '3', surface: 'MOD', patient: 'declined' }, '#3 MOD D2740 Crown -- patient declined.'],
    [{ tooth: '', surface: 'UR', code: 'D4341', description: 'Scaling', patient: 'declined' },
      'UR D4341 Scaling -- patient declined.'],
  ];
  for (const [over, expected] of cases) {
    const out = note(loaded([item(over)]));
    const i = out.preview.indexOf('Existing treatment reviewed (1):');
    assert.ok(i >= 0, JSON.stringify(over));
    assert.equal(out.preview[i + 1], '  ' + expected, JSON.stringify(over));
  }
});

test('not discussed is OMITTED from the chart note; the count is what was said', () => {
  const out = note(
    loaded([
      item({ procNum: 1, patient: 'declined' }),
      item({ procNum: 2 }),
      item({ procNum: 3, clinical: 'no_change' }),
      item({ procNum: 4 }),
    ])
  );
  const i = out.preview.indexOf('Existing treatment reviewed (2):');
  assert.ok(i >= 0);
  assert.equal(out.preview.filter((l) => l.startsWith('  #30 D2740')).length, 2);
  // Item 3 said something (a clinical answer); items 2 and 4 said nothing.
  assert.ok(out.preview.some((l) => /no change; not discussed with the patient/.test(l)));
  // The lines ARE the write: the note text carries the same bytes.
  assert.ok(out.payload.text.includes('Existing treatment reviewed (2):'));
  assert.ok(out.payload.text.includes('#30 D2740 Crown -- patient declined.'));
});

test('N = 0: no section, no digest, and the note is what it was before this slice', () => {
  const before = note(undefined);
  for (const existingTx of [
    undefined,
    { status: 'not_loaded', items: [] },
    { status: 'failed', items: [] },
    loaded([]),
    loaded([item(), item({ procNum: 2 })]), // all not discussed
  ]) {
    const out = note(existingTx);
    assert.ok(!out.preview.some((l) => l.startsWith('Existing treatment')), JSON.stringify(existingTx));
    assert.deepEqual(out, before, 'byte-for-byte the pre-2b note');
    assert.ok(!('existingTxDigest' in out.payload));
  }
});

test('the section sits after the treatment block and before the name block', () => {
  const visit = {
    ...VISIT,
    slip: { ...hyg.emptySlip(), visitType: 'adult_prophy_recall' },
    items: [{ teeth: [3], code: 'Crown', category: 'Restorative', priority: 'urgent', status: 'proposed', surfaces: [], dx: [] }],
  };
  const out = composer.compose('note', {
    visit,
    items: visit.items,
    actor: 'hygienist@carein.ai',
    signature: ['Sam Hygienist, RDH'],
    existingTx: loaded([item({ patient: 'declined' })]),
  });
  const p = out.preview;
  const treat = p.findIndex((l) => l.startsWith('Treatment identified today'));
  const existing = p.indexOf('Existing treatment reviewed (1):');
  const name = p.findIndex((l) => l.startsWith('Entered in CareIN by'));
  assert.ok(treat >= 0 && existing > treat && name > existing, p.join('\n'));
  assert.equal(p[existing - 1], '', 'a section break after a template, as the treatment block has');
  assert.ok(out.payload.existingTxDigest.match(/^[0-9a-f]{64}$/));
});

// ── the Router ──────────────────────────────────────────────────────────────

test('the Router lists EVERY item, Not discussed included, with both answers', () => {
  const out = router(
    loaded([
      item({ procNum: 1, scheduled: true, clinical: 'worse_urgent', patient: 'wants_to_wait', waitTimeframe: '6_months', note: 'cold sensitivity' }),
      item({ procNum: 2, tooth: '14', code: 'D2391', description: 'Composite', dateTp: null }),
    ])
  );
  const p = out.preview;
  const i = p.indexOf('Existing treatment (2):');
  assert.ok(i >= 0, p.join('\n'));
  assert.deepEqual(p.slice(i + 1, i + 8), [
    '  #30 D2740 Crown - planned 2026-06-20 - Already scheduled',
    '    Clinical: Getting worse -> urgent',
    '    Patient: Wants to wait (6 months)',
    '    Note: cold sensitivity',
    '  #14 D2391 Composite',
    '    Clinical: Not recorded',
    '    Patient: Not discussed',
  ]);
  assert.deepEqual(out.payload.lines, p, 'the payload is the preview');
});

test('the Router never prints an empty section that reads as "none"', () => {
  assert.ok(!router(undefined).preview.some((l) => /existing treatment/i.test(l)), 'never loaded: absent');
  assert.ok(!router({ status: 'not_loaded', items: [] }).preview.some((l) => /existing treatment/i.test(l)));

  const failed = router({ status: 'failed', items: [] }).preview;
  assert.ok(failed.includes('Existing treatment could not be loaded from Open Dental.'));
  assert.ok(!failed.some((l) => /none planned/.test(l)));

  // "None" only when a READ said so.
  assert.ok(router(loaded([])).preview.includes('Existing treatment: none planned in Open Dental.'));

  // Failed, but some items were answered earlier: say both things.
  const partial = router({ status: 'failed', items: [item({ patient: 'declined' })] }).preview;
  assert.ok(partial.includes('Existing treatment (1):'));
  assert.ok(partial.some((l) => /could not be loaded from Open Dental\. These are the items answered/.test(l)));
});

test('a Router with no existing-treatment data is byte-for-byte the pre-2b slip', () => {
  const before = router(undefined);
  assert.deepEqual(router({ status: 'not_loaded', items: [] }), before);
  assert.ok(!('existingTxDigest' in before.payload));
  // …and its PDF is the same bytes too.
  const pdf = (c) => slipPdf.renderSlipPdf({ title: c.title, subtitle: 'x', lines: c.payload.lines });
  assert.ok(pdf(router({ status: 'not_loaded', items: [] })).equals(pdf(before)));
});

test('the Router section renders into the PDF, OD-safe, with no character dropped', async () => {
  const out = router(loaded([item({ clinical: 'worse_urgent', patient: 'declined' })]));
  for (const l of out.preview) assert.match(l, /^[\x20-\x7e]*$/, 'ASCII-safe: ' + l);
  const pdf = slipPdf.renderSlipPdf({ title: out.title, subtitle: 'Roland Family Dental - 2026-09-08', lines: out.payload.lines });
  const { PDFParse } = require('pdf-parse');
  const text = (await new PDFParse({ data: pdf }).getText()).text;
  assert.match(text, /Existing treatment \(1\):/);
  assert.match(text, /Clinical: Getting worse -> urgent/);
  assert.match(text, /Patient: Declined/);
});

// ── the digest ──────────────────────────────────────────────────────────────

test('the digest follows exactly the lines each kind prints', () => {
  const a = loaded([item({ patient: 'declined' }), item({ procNum: 2 })]);
  const b = loaded([item({ patient: 'declined' }), item({ procNum: 2, description: 'Crown (edited in OD)' })]);
  // The note does not print the not-discussed item, so its edit does not move the note's digest…
  assert.equal(composer.existingTxDigest('note', a), composer.existingTxDigest('note', b));
  // …but the Router prints every item, so it does.
  assert.notEqual(composer.existingTxDigest('router', a), composer.existingTxDigest('router', b));
  // An answer changing moves both.
  const c = loaded([item({ patient: 'ready_to_schedule' }), item({ procNum: 2 })]);
  assert.notEqual(composer.existingTxDigest('note', a), composer.existingTxDigest('note', c));
  assert.equal(composer.existingTxDigest('note', loaded([item()])), null);
});

// ── buildExistingTx: frozen snapshots, server-side ──────────────────────────

test('an answered item is described by its FROZEN snapshot, not a later Open Dental read', () => {
  const read = {
    status: 'loaded',
    readAt: '2026-09-08T14:00:00.000Z',
    // Open Dental changed after she answered: new description, new tooth.
    items: [
      { procNum: 5001, code: 'D2750', description: 'Crown -- edited later', tooth: '31', surface: '', dateTp: '2026-07-01', priorityName: null, scheduled: true },
      { procNum: 5002, code: 'D2391', description: 'Composite', tooth: '14', surface: 'O', dateTp: '2026-05-01', priorityName: 'Watch', scheduled: false },
    ],
  };
  const rows = [
    {
      proc_num: '5001',
      clinical: 'worse_urgent',
      patient: 'wants_to_wait',
      wait_timeframe: '3_months',
      note: null,
      proc_snapshot: { code: 'D2740', description: 'Crown', tooth: '30', surface: '', date_tp: '2026-06-20', priority_name: null },
    },
    // Answered, but no longer in the latest plan: still what was said.
    {
      proc_num: '4999',
      clinical: null,
      patient: 'declined',
      wait_timeframe: null,
      note: 'synthetic',
      proc_snapshot: { code: 'D1110', description: 'Prophy', tooth: '', surface: '', date_tp: '2026-01-02', priority_name: null, scheduled: false },
    },
  ];
  const built = store.buildExistingTx(read, rows);
  assert.equal(built.status, 'loaded');
  assert.deepEqual(built.items.map((i) => i.procNum), [5001, 5002, 4999]);
  const [answered, unanswered, dropped] = built.items;
  assert.equal(answered.code, 'D2740', 'the snapshot taken when she answered');
  assert.equal(answered.tooth, '30');
  assert.equal(answered.scheduled, true, '"Already scheduled" follows the latest plan');
  assert.equal(answered.patient, 'wants_to_wait');
  assert.equal(unanswered.patient, 'not_discussed');
  assert.equal(unanswered.priorityName, 'Watch');
  assert.equal(dropped.patient, 'declined');
  for (const i of built.items) assert.ok(hyg.ExistingTxHandoffItemSchema.safeParse(i).success, JSON.stringify(i));

  assert.equal(store.buildExistingTx(null, []).status, 'not_loaded');
  assert.equal(store.buildExistingTx({ status: 'failed', at: 'x' }, []).status, 'failed');
});

// ── TC: additive, and every old shape still parses ──────────────────────────

const APPOINTMENT = { patientName: 'Test, Stedi', providerName: 'DOC1', opName: 'Hygiene 1' };
const WITH_ITEMS = {
  ...VISIT,
  items: [{ teeth: [3], code: 'Crown', category: 'Restorative', priority: 'urgent', status: 'proposed', dx: [], motivation: [] }],
};

test('the case handoff carries existingTx only when there is something to carry', () => {
  const base = tcHandoff.buildIntake({ visit: WITH_ITEMS, appointment: APPOINTMENT, handoffCategory: 'Restorative', date: '2026-09-08' });
  for (const existingTx of [undefined, { status: 'not_loaded', items: [] }, { status: 'failed', items: [] }]) {
    const b = tcHandoff.buildIntake({ visit: WITH_ITEMS, appointment: APPOINTMENT, handoffCategory: 'Restorative', date: '2026-09-08', existingTx });
    assert.deepEqual(b, base, 'the body is the pre-2b body');
  }
  const carried = tcHandoff.buildIntake({
    visit: WITH_ITEMS,
    appointment: APPOINTMENT,
    handoffCategory: 'Restorative',
    date: '2026-09-08',
    existingTx: loaded([item({ patient: 'cost_questions' }), item({ procNum: 2 })]),
  });
  assert.equal(carried.body.existingTx.length, 2, 'every item, not discussed included');
  assert.equal(carried.body.existingTx[0].patient, 'cost_questions');
  assert.ok(!('fee' in carried.body.existingTx[0]) && !('patNum' in carried.body.existingTx[0]));
});

test('TC’s intake schema: an old body parses unchanged, and a new one parses with its items', () => {
  // The route's own schema is TcHygieneIntake minus the stamped fields plus the
  // case fields; the stored row is TcHygieneIntake. Pin the stored contract.
  const stored = {
    submittedBy: 'hygienist@carein.ai',
    submittedByName: 'Hyg User',
    submittedAt: '2026-09-08T13:00:00.000Z',
    operatory: 'Hygiene 1',
    visitDate: '2026-09-08',
    providerSeen: 'DOC1',
    chiefConcern: '',
    perioStatus: 'unknown',
    recallType: 'prophy',
    radiographs: ['none'],
    intraoralPhotosTaken: false,
    areasOfConcern: '',
    suspectedTreatment: '',
    hygienistRecommendation: '',
    insuranceNoted: '',
    patientInterestLevel: 'unknown',
    flagUrgent: false,
  };
  const old = tc.TcHygieneIntake.parse(stored);
  assert.equal(old.existingTx, null, 'an intake from before 2b reads as carrying none');
  assert.equal(old.orthoScreening, null);
  const now = tc.TcHygieneIntake.parse({ ...stored, existingTx: [item({ patient: 'declined' })] });
  assert.equal(now.existingTx[0].patient, 'declined');
  assert.ok(!tc.TcHygieneIntake.safeParse({ ...stored, existingTx: [{ ...item(), fee: 1 }] }).success, 'strict items');
});

test('the checkout snapshot: an old payload parses, a new one carries the items', () => {
  const snap = {
    procedures: [],
    priority: null,
    nextVisit: { type: null, intervalMonths: null, lengthMin: null, withDoctor: false, rtc: '' },
    notesPending: true,
    frontDeskNote: '',
    financialNote: '',
  };
  assert.ok(tc.TcCheckoutSnapshot.safeParse(snap).success, 'a snapshot stored before 2b still parses');
  assert.equal(tc.TcCheckoutSnapshot.parse(snap).existingTx, undefined);

  const snapshotOfVisit = { patientName: 'Test, Stedi', providerName: 'HYG1', doctorName: 'DOC1', opName: 'Hygiene 1' };
  const without = tcHandoff.buildCheckoutIntake({ visit: VISIT, snapshot: snapshotOfVisit, date: '2026-09-08', final: false });
  assert.ok(!('existingTx' in without.body.snapshot), 'no field when there is nothing');
  assert.ok(tc.TcCheckoutSubmit.safeParse(without.body).success);

  const withTx = tcHandoff.buildCheckoutIntake({
    visit: VISIT,
    snapshot: snapshotOfVisit,
    date: '2026-09-08',
    final: true,
    existingTx: loaded([item({ clinical: 'worse_urgent', patient: 'ready_to_schedule' })]),
  });
  const parsed = tc.TcCheckoutSubmit.safeParse(withTx.body);
  assert.ok(parsed.success, JSON.stringify(parsed.error && parsed.error.issues));
  assert.equal(parsed.data.snapshot.existingTx[0].clinical, 'worse_urgent');
});

test('an item TC would refuse is dropped, not the whole handoff', () => {
  const carried = tcHandoff.existingTxForTc(loaded([item({ procNum: 0 }), item({ procNum: 7 })]));
  assert.deepEqual(carried.map((i) => i.procNum), [7]);
  assert.equal(tcHandoff.existingTxForTc(loaded([])), undefined);
});
