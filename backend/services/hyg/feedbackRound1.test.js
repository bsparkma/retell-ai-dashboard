'use strict';

/**
 * Hygienist feedback round 1 — what reaches the chart, the Router and TC.
 *
 *   A1. The note names ONLY the examining doctor the slip picked; none picked,
 *       none named, and the note is still complete.
 *   A2. A primary tooth prints as its bare letter ("B"), a permanent one as
 *       "#30" — on the note, the Router, the TC handoff and TC's own text. The
 *       stored 102 never reaches a reader.
 *   B.  The nine draft templates render; Polish is retired but a saved Polish
 *       still prints; SSC is a tooth-level Restorative code.
 *   C.  A visit with no new treatment but a TC-actionable existing-treatment
 *       answer stages and builds a handoff with an EXPLICITLY EMPTY treatment
 *       list; with neither, it is refused. Day progress applies the tc step the
 *       same way.
 *
 * Synthetic data only: roland 12827 is the staging fixture, and the only staff
 * names are the office config's own.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const composer = require('./stagedWriteComposer');
const tcHandoff = require('./tcHandoffClient');
const { deriveVisitProgress } = require('./visitProgress');
const contract = require('../../hyg/contract.gen.cjs');
const tcContract = require('../../tc/contract.gen.cjs');
const hygStaff = require('../../config/hygStaff');
const tcCheckout = require('../../routes/tc/checkout');

const ACTOR = 'hygienist@carein.ai';

function item(over = {}) {
  return {
    id: 'item-1',
    teeth: [30],
    code: 'Crown',
    category: 'Restorative',
    surfaces: [],
    dx: ['D'],
    priority: 'urgent',
    motivation: [],
    status: 'proposed',
    scheduleNext: false,
    photos: [],
    createdBy: ACTOR,
    createdAt: '2026-09-08T13:00:00.000Z',
    ...over,
  };
}

function visit(over = {}, slip = {}) {
  return {
    visitId: 'visit-0001',
    office: 'roland',
    aptNum: 900001,
    patNum: 12827,
    visitDate: '2026-09-08',
    slip: { ...contract.emptySlip(), ...slip },
    items: [],
    stagedWrites: [],
    ...over,
  };
}

function compose(kind, v, extra = {}) {
  return composer.compose(kind, { visit: v, items: v.items, actor: ACTOR, signature: [], ...extra });
}

const PRIMARY_B = contract.primaryToNumber('B');
const PRIMARY_I = contract.primaryToNumber('I');

// ─────────────────────────────────────────────────────────────────────────────
// A2 — teeth
// ─────────────────────────────────────────────────────────────────────────────

test('A2 evidence: the picker stores B as 102 and I as 109 — and that is what used to print', () => {
  assert.equal(PRIMARY_B, 102);
  assert.equal(PRIMARY_I, 109);
  assert.equal(contract.toothText(102), 'B');
  assert.equal(contract.toothText(30), '#30');
  assert.equal(contract.teethText([102, 109]), 'B, I');
  assert.equal(contract.teethText([30, 102]), '#30, B');
  // The encoding round-trips for every primary tooth, upper A-J and lower T-K.
  for (const letter of 'ABCDEFGHIJKLMNOPQRST') {
    assert.equal(contract.toothLabel(contract.primaryToNumber(letter)), letter);
  }
  // And Open Dental's own tooth text (the existing-treatment read).
  assert.equal(contract.odToothText('B'), 'B');
  assert.equal(contract.odToothText('30'), '#30');
  assert.equal(contract.odToothText(''), '');
});

for (const [label, teeth, expected] of [
  ['primary only', [PRIMARY_B, PRIMARY_I], 'B, I'],
  ['permanent only', [3, 30], '#3, #30'],
  ['mixed', [30, PRIMARY_B], '#30, B'],
]) {
  test(`A2 ${label}: the note, the Router and the TC handoff all print "${expected}"`, () => {
    const v = visit({ items: [item({ teeth, code: 'SSC' })] });
    const note = compose('note', v).preview.join('\n');
    const router = compose('router', v).preview.join('\n');
    const handoff = compose('tc-handoff', v).preview.join('\n');
    for (const [surface, text] of [['note', note], ['router', router], ['handoff', handoff]]) {
      assert.ok(text.includes(`${expected} - SSC`), `${surface}: ${text}`);
      assert.doesNotMatch(text, /#1\d\d\b/, `${surface} printed a stored primary number`);
    }

    const intake = tcHandoff.buildIntake({
      visit: v,
      appointment: { patientName: 'Test 2, Stedi', providerName: 'DOC1', opName: 'Hyg 1' },
      handoffCategory: 'Restorative',
      date: '2026-09-08',
    });
    assert.equal(intake.ok, true);
    assert.equal(intake.body.suspectedTreatment, `${expected} SSC (urgent)`);
    // TC's own text for a checkout procedure, from TC's contract bundle.
    assert.deepEqual(tcCheckout.procedureLines({ procedures: [{ teeth, code: 'SSC', priority: 'urgent' }] }), [
      `${expected} SSC (urgent)`,
    ]);
    assert.equal(tcContract.teethText(teeth), expected, 'one mapping, in both bundles');
  });
}

test('A2: an existing-treatment line names an Open Dental primary tooth by its letter', () => {
  const v = visit();
  const existingTx = {
    status: 'loaded',
    items: [
      {
        procNum: 5001, code: 'D2930', description: 'Prefabricated stainless steel crown - primary tooth',
        tooth: 'B', surface: '', dateTp: '2026-06-20', priorityName: null, scheduled: false,
        clinical: null, patient: 'ready_to_schedule', waitTimeframe: null, note: null,
      },
    ],
  };
  const note = compose('note', v, { existingTx }).preview.join('\n');
  assert.ok(note.includes('  B D2930'), note);
  assert.ok(!note.includes('#B'));
});

// ─────────────────────────────────────────────────────────────────────────────
// A1 — the examining doctor only
// ─────────────────────────────────────────────────────────────────────────────

test('A1: the composed note names only the doctor the slip picked — and none when none was', () => {
  const picked = visit({}, {
    visitType: 'adult_prophy_recall',
    visitTypeSource: 'manual',
    noteFields: { drs: { grades: ['Blain VanNice'], detail: '' } },
  });
  const sig = (v) =>
    hygStaff.signatureBlock({
      office: 'roland',
      hygienistName: 'Temp Hygienist',
      examiningDoctors: v.slip.noteFields.drs ? v.slip.noteFields.drs.grades : [],
    });
  const text = compose('note', picked, { signature: sig(picked) }).preview.join('\n');
  assert.ok(text.includes('Dr. Blain VanNice performed periodic exam.'));
  assert.ok(text.includes('Blain VanNice DDS #7971'));
  assert.ok(!text.includes('Beau Sparkman'), 'a doctor who did not examine is not named');
  assert.ok(!text.includes('Joe Farmer'), 'a doctor who did not examine is not named');

  const none = visit({}, { visitType: 'adult_prophy_recall', visitTypeSource: 'manual', noteFields: {} });
  const plain = compose('note', none, { signature: sig(none) }).preview;
  assert.ok(!plain.some((l) => / DDS #\d+/.test(l)), 'no doctor line at all');
  // Still a whole note: the template, the author, and the unsigned line.
  assert.ok(plain[0].startsWith('S:  Patient presents for recall appointment.'));
  assert.ok(plain.includes('Temp Hygienist'));
  assert.match(plain[plain.length - 1], /Unsigned\.$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// B — vocabulary
// ─────────────────────────────────────────────────────────────────────────────

test('B: every draft template renders, says what it is, and prints no unearned grade', () => {
  for (const type of contract.DRAFT_VISIT_TYPES) {
    const v = visit({}, { visitType: type, visitTypeSource: 'manual' });
    const lines = compose('note', v).preview;
    assert.ok(lines.length > 3, type);
    // Nothing answered, so every graded row is its label and a blank.
    for (const id of contract.controlsFor(type)) {
      const label = contract.controlLabel(type, id);
      if (id === 'drs') continue;
      // A row on its own line ends at the blank; STE and HTE sit inside the A:
      // line, where the blank is followed by the next label's two spaces.
      assert.ok(
        lines.some((l) => l === `${label}: ` || l.includes(`${label}:   `) || l.endsWith(`${label}: `)),
        `${type}: "${label}: " left blank`
      );
    }
  }
  const quad3 = compose('note', visit({}, { visitType: 'srp_quad_3', visitTypeSource: 'manual' })).preview;
  assert.ok(quad3.includes('Cavitron and hand scaled Quad 3'));
  assert.ok(quad3.some((l) => l.startsWith('Anesthetic sites: IA, LB, Mental')), 'quad 3 is lower');
  const quad1 = compose('note', visit({}, { visitType: 'srp_quad_1', visitTypeSource: 'manual' })).preview;
  assert.ok(quad1.some((l) => l.startsWith('Anesthetic sites: PSA, MSA, ASA')), 'quad 1 is upper');
  const fmd = compose('note', visit({}, { visitType: 'd4346', visitTypeSource: 'manual' })).preview;
  assert.ok(fmd.includes('P:  4346'));
});

test('B: the Laser note names only the quadrants she tapped', () => {
  const none = compose('note', visit({}, { visitType: 'laser', visitTypeSource: 'manual' })).preview;
  assert.ok(none.includes('Quadrants: '));
  const two = compose('note', visit({}, {
    visitType: 'laser',
    visitTypeSource: 'manual',
    doneToday: ['laser-ur', 'prophy', 'laser-ll'],
  })).preview;
  assert.ok(two.includes('Quadrants: UR, LL'));
});

test('B: Polish is no longer offered, but a slip that has it still prints and keeps it', () => {
  assert.ok(!contract.doneTodayChoices([]).some((o) => o.id === 'polish'));
  assert.ok(contract.doneTodayChoices(['polish']).some((o) => o.id === 'polish'));
  for (const id of ['add-pmt', 'laser-ur', 'laser-ul', 'laser-ll', 'laser-lr', 'ofi']) {
    assert.ok(contract.doneTodayChoices([]).some((o) => o.id === id), id);
  }
  const old = visit({}, { doneToday: ['prophy', 'polish'] });
  const router = compose('router', old).preview.join('\n');
  assert.match(router, /Polish/);
  // The schema keeps it on a re-save.
  const parsed = contract.HygSlipSchema.parse({ ...contract.emptySlip(), doneToday: ['prophy', 'polish'] });
  assert.deepEqual(parsed.doneToday, ['prophy', 'polish']);
});

// ─────────────────────────────────────────────────────────────────────────────
// C — the handoff without new treatment
// ─────────────────────────────────────────────────────────────────────────────

function existing(patient, clinical = null) {
  return {
    status: 'loaded',
    items: [
      {
        procNum: 5001, code: 'D2740', description: 'Crown - porcelain/ceramic', tooth: '30', surface: '',
        dateTp: '2026-06-20', priorityName: null, scheduled: false, clinical, patient,
        waitTimeframe: null, note: null,
      },
    ],
  };
}

test('C: no new treatment + a TC-actionable answer stages a handoff with an explicitly empty list', () => {
  for (const patient of contract.EXISTING_TX_TC_ACTIONABLE) {
    const staged = compose('tc-handoff', visit(), { existingTx: existing(patient) });
    assert.ok(!staged.empty, patient);
    assert.deepEqual(staged.payload.items, []);
    assert.ok(staged.preview.includes('Treatment identified today: none'));
  }
});

test('C: neither new treatment nor a TC-actionable answer is still refused', () => {
  for (const ex of [undefined, existing('not_discussed'), existing('wants_to_wait'), existing('declined')]) {
    const staged = compose('tc-handoff', visit(), { existingTx: ex });
    assert.ok(staged.empty, JSON.stringify(ex && ex.items[0].patient));
  }
});

test('C: the handoff body carries the existing items, an empty treatment line, and their urgency', () => {
  const appointment = { patientName: 'Test 2, Stedi', providerName: 'DOC1', opName: 'Hyg 1' };
  const built = tcHandoff.buildIntake({
    visit: visit(),
    appointment,
    handoffCategory: 'Other',
    date: '2026-09-08',
    existingTx: existing('ready_to_schedule', 'worse_urgent'),
  });
  assert.equal(built.ok, true);
  assert.equal(built.body.suspectedTreatment, '');
  assert.equal(built.body.existingTx.length, 1);
  assert.equal(built.body.flagUrgent, true, 'the hygienist marked it getting worse -> urgent');
  const calm = tcHandoff.buildIntake({
    visit: visit(), appointment, handoffCategory: 'Other', date: '2026-09-08',
    existingTx: existing('cost_questions'),
  });
  assert.equal(calm.body.flagUrgent, false);
  // Re-checked at SEND: the answers may have changed since staging.
  const gone = tcHandoff.buildIntake({
    visit: visit(), appointment, handoffCategory: 'Other', date: '2026-09-08',
    existingTx: existing('declined'),
  });
  assert.equal(gone.ok, false);
  assert.equal(gone.code, 'NOTHING_TO_STAGE');
});

test('C: the checkout alert builds with no treatment items', () => {
  const built = tcHandoff.buildCheckoutIntake({
    visit: visit(),
    snapshot: { patientName: 'Test 2, Stedi', providerName: 'HYG1', doctorName: 'DOC1', opName: 'Hyg 1' },
    date: '2026-09-08',
    final: false,
    existingTx: existing('ready_to_schedule'),
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.body.snapshot.procedures, []);
  assert.equal(built.body.snapshot.existingTx.length, 1);
});

test('C: day progress applies the tc step to a TC-actionable visit with no items', () => {
  const base = {
    stagedWrites: [], treatmentItemCount: 0, checkoutSentAt: null, checkoutFinalAt: null,
    latestPerioSendState: null,
  };
  assert.equal(deriveVisitProgress({ ...base }).steps.tc.state, 'not_applicable');
  assert.equal(deriveVisitProgress({ ...base, tcActionableCount: 0 }).steps.tc.state, 'not_applicable');
  assert.equal(deriveVisitProgress({ ...base, tcActionableCount: 1 }).steps.tc.state, 'none');
});
