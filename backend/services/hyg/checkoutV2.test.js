'use strict';

/**
 * Checkout v2 — what the note, the TC handoff and the checkout alert carry.
 *
 *   1. MEDICAL HISTORY. "No changes" and "these changes" print right after the
 *      visit type's opening line; unanswered prints nothing. A slip saved
 *      before the field parses. A staged note goes out of date when THIS field
 *      changes — and only this slip field.
 *   2. COLLECT AT CHECKOUT. Carried on the checkout alert AND the TC handoff,
 *      as labels; on its own it makes the handoff available.
 *   3. The checkout snapshot carries the records the treatment needs.
 *   4. The handoff preview prints what TC receives, and goes out of date when
 *      any of it would print differently.
 *
 * Synthetic data only: roland 12827 is the staging fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const composer = require('./stagedWriteComposer');
const tcHandoff = require('./tcHandoffClient');
const existingTxStale = require('./existingTxStale');
const visitStore = require('./visitStore');
const { deriveVisitProgress } = require('./visitProgress');
const contract = require('../../hyg/contract.gen.cjs');
const tcContract = require('../../tc/contract.gen.cjs');

const ACTOR = 'hygienist@carein.ai';
const APPOINTMENT = { patientName: 'Test 2, Stedi', providerName: 'HYG1', opName: 'Hyg 1' };

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

function visit(slip = {}, items = []) {
  return {
    visitId: 'visit-0001',
    office: 'roland',
    aptNum: 900001,
    patNum: 12827,
    visitDate: '2026-09-08',
    slip: { ...contract.emptySlip(), ...slip },
    items,
    stagedWrites: [],
  };
}

function existing(patient) {
  return {
    status: 'loaded',
    items: [
      {
        procNum: 5001, code: 'D2740', description: 'Crown', tooth: '30', surface: '',
        dateTp: '2026-06-20', priorityName: null, scheduled: false,
        clinical: null, patient, waitTimeframe: null, note: null,
      },
    ],
  };
}

const NONE = { status: 'loaded', items: [] };

function compose(kind, v, extra = {}) {
  return composer.compose(kind, { visit: v, items: v.items, actor: ACTOR, signature: [], existingTx: NONE, ...extra });
}

/** A staged row, as existingTxStale.staleReason reads one, from a composed write. */
function stagedRow(kind, composed) {
  return {
    kind,
    existingTxDigest: composed.payload.existingTxDigest || null,
    medicalHistoryDigest: composed.payload.medicalHistoryDigest || null,
    preview: composed.preview,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Medical history
// ─────────────────────────────────────────────────────────────────────────────

test('1: "No changes" prints right after the visit type\'s opening line', () => {
  const v = visit({ visitType: 'adult_prophy_recall', visitTypeSource: 'manual', medicalHistory: { status: 'no_changes' } });
  const lines = compose('note', v).preview;
  assert.match(lines[0], /^S: {2}Patient presents/);
  assert.equal(lines[1], 'Medical history: reviewed, no changes');
});

test('1: a changes answer prints "Medical history update: <text>", trimmed', () => {
  const v = visit({
    visitType: 'adult_prophy_recall',
    visitTypeSource: 'manual',
    medicalHistory: { status: 'changes', text: '  Started a blood thinner in August. ' },
  });
  const lines = compose('note', v).preview;
  assert.equal(lines[1], 'Medical history update: Started a blood thinner in August.');
  assert.equal(lines.filter((l) => /^Medical history/.test(l)).length, 1);
});

test('1: unanswered prints NO medical-history line — never "no changes" by default', () => {
  const v = visit({ visitType: 'adult_prophy_recall', visitTypeSource: 'manual' });
  const composed = compose('note', v);
  assert.equal(composed.preview.some((l) => /^Medical history/.test(l)), false);
  assert.equal(composed.payload.medicalHistoryDigest, undefined, 'no digest when nothing is printed');
  // Blank "changes" text is no answer either.
  const blank = visit({ visitType: 'adult_prophy_recall', medicalHistory: { status: 'changes', text: '   ' } });
  assert.equal(compose('note', blank).preview.some((l) => /^Medical history/.test(l)), false);
});

test('1: the generic note (no visit type) carries it as its first line', () => {
  const v = visit({ medicalHistory: { status: 'no_changes' } });
  assert.equal(compose('note', v).preview[0], 'Medical history: reviewed, no changes');
});

test('1: the Router does not print it — the note is where it belongs', () => {
  const v = visit({ medicalHistory: { status: 'no_changes' } });
  assert.equal(compose('router', v).preview.some((l) => /Medical history/.test(l)), false);
});

test('1: a slip saved before this field (no key at all) parses, unanswered and with nothing to collect', () => {
  const old = contract.emptySlip();
  delete old.medicalHistory;
  delete old.collectAtCheckout;
  const parsed = contract.HygSlipSchema.parse(JSON.parse(JSON.stringify(old)));
  assert.equal(parsed.medicalHistory, null);
  assert.deepEqual(parsed.collectAtCheckout, { items: [], other: '' });
  // And the two answers are one value: both at once does not parse.
  assert.equal(
    contract.HygSlipSchema.safeParse({ ...parsed, medicalHistory: { status: 'no_changes', text: 'x' } }).success,
    false
  );
  assert.equal(
    contract.HygSlipSchema.safeParse({ ...parsed, medicalHistory: { status: 'changes', text: 'x'.repeat(1001) } }).success,
    false,
    'max 1000'
  );
});

test('1: a staged note goes out of date when the medical history changes — and ONLY that slip field', () => {
  const before = visit({ visitType: 'adult_prophy_recall', medicalHistory: { status: 'no_changes' } });
  const note = stagedRow('note', compose('note', before));
  const router = stagedRow('router', compose('router', before));
  const ctx = (v) => ({ visit: v, existingTx: NONE });

  assert.equal(existingTxStale.staleReason(note, ctx(before)), null, 'current the moment it is staged');

  const changed = visit({ visitType: 'adult_prophy_recall', medicalHistory: { status: 'changes', text: 'New allergy' } });
  assert.equal(existingTxStale.staleReason(note, ctx(changed)), 'medical_history');
  const cleared = visit({ visitType: 'adult_prophy_recall', medicalHistory: null });
  assert.equal(existingTxStale.staleReason(note, ctx(cleared)), 'medical_history');
  assert.equal(existingTxStale.staleReason(router, ctx(changed)), null, 'the Router never prints it');

  // Any OTHER slip field: the note keeps the words it was staged with (the
  // general slip fix is a separate item, deliberately not this one).
  const otherField = visit({
    visitType: 'adult_prophy_recall',
    medicalHistory: { status: 'no_changes' },
    frontDeskNote: 'Wants an early morning',
    hygieneFindings: 'Changed after staging',
  });
  assert.equal(existingTxStale.staleReason(note, ctx(otherField)), null);

  // A note staged BEFORE this field existed (no digest) reads out of date only
  // once there is an answer it does not print.
  const legacy = { ...note, medicalHistoryDigest: null };
  assert.equal(existingTxStale.staleReason(legacy, ctx(cleared)), null);
  assert.equal(existingTxStale.staleReason(legacy, ctx(before)), 'medical_history');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Collect at checkout — carried on both, and the availability truth table
// ─────────────────────────────────────────────────────────────────────────────

const COLLECT = { items: ['mouthwash', 'fl2'], other: ' Floss picks ' };

test('2: the checkout alert carries the collect list as labels, in the option order', () => {
  const built = tcHandoff.buildCheckoutIntake({
    visit: visit({ collectAtCheckout: COLLECT }),
    snapshot: { patientName: 'Test 2, Stedi', providerName: 'HYG1', opName: 'Hyg 1' },
    date: '2026-09-08',
    final: false,
    existingTx: NONE,
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.body.snapshot.collectAtCheckout, ['Fl2', 'Mouthwash', 'Floss picks']);
  // TC's own schema takes it.
  assert.equal(tcContract.TcCheckoutSubmit.safeParse(built.body).success, true);
});

test('2: the TC handoff carries it too — and TC\'s intake schema takes it', () => {
  const built = tcHandoff.buildIntake({
    visit: visit({ collectAtCheckout: COLLECT }, [item()]),
    appointment: APPOINTMENT,
    handoffCategory: 'Restorative',
    date: '2026-09-08',
    existingTx: NONE,
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.body.collectAtCheckout, ['Fl2', 'Mouthwash', 'Floss picks']);
  const intake = tcContract.TcHygieneIntake.omit({ submittedBy: true, submittedByName: true, submittedAt: true })
    .partial()
    .safeParse({ collectAtCheckout: built.body.collectAtCheckout });
  assert.equal(intake.success, true);
});

test('2: nothing to collect sends no key at all — the body every older visit sent', () => {
  const checkout = tcHandoff.buildCheckoutIntake({
    visit: visit({}, [item()]),
    snapshot: { patientName: 'Test 2, Stedi', providerName: 'HYG1', opName: 'Hyg 1' },
    date: '2026-09-08',
    final: true,
    existingTx: NONE,
  });
  assert.equal('collectAtCheckout' in checkout.body.snapshot, false);
  const handoff = tcHandoff.buildIntake({
    visit: visit({ collectAtCheckout: { items: [], other: '   ' } }, [item()]),
    appointment: APPOINTMENT,
    handoffCategory: 'Restorative',
    date: '2026-09-08',
    existingTx: NONE,
  });
  assert.equal('collectAtCheckout' in handoff.body, false, 'blank Other is nothing to collect');
});

test('2: OLD TC payloads still parse — a snapshot and an intake with none of the new keys', () => {
  const oldSnapshot = {
    procedures: [],
    priority: null,
    nextVisit: { type: null, intervalMonths: null, lengthMin: null, withDoctor: false, rtc: '' },
    notesPending: true,
    frontDeskNote: '',
    financialNote: '',
  };
  assert.equal(tcContract.TcCheckoutSnapshot.safeParse(oldSnapshot).success, true);
  const parsed = tcContract.TcHygieneIntake.shape.collectAtCheckout.parse(undefined);
  assert.equal(parsed, null, 'an intake row from before the column reads as null');
});

/**
 * THE TRUTH TABLE. items × TC-actionable answer × collect item → can the
 * handoff stage, can it build at send, and does the day card's tc step apply?
 * Only the row with none of the three is refused.
 */
test('2: availability truth table — refused only with no items, no actionable answer and nothing to collect', () => {
  for (const hasItems of [false, true]) {
    for (const hasActionable of [false, true]) {
      for (const hasCollect of [false, true]) {
        const label = `items=${hasItems} actionable=${hasActionable} collect=${hasCollect}`;
        const expected = hasItems || hasActionable || hasCollect;
        const v = visit(hasCollect ? { collectAtCheckout: { items: ['sealant'], other: '' } } : {}, hasItems ? [item()] : []);
        const existingTx = hasActionable ? existing('ready_to_schedule') : existing('declined');

        const composed = compose('tc-handoff', v, { existingTx });
        assert.equal(Boolean(composed.preview), expected, `stage: ${label}`);

        const built = tcHandoff.buildIntake({
          visit: v,
          appointment: APPOINTMENT,
          handoffCategory: contract.deriveCategory(v.items),
          date: '2026-09-08',
          existingTx,
        });
        assert.equal(built.ok, expected, `send: ${label}`);
        if (!expected) assert.equal(built.code, 'NOTHING_TO_STAGE');

        const progress = deriveVisitProgress({
          stagedWrites: [],
          treatmentItemCount: hasItems ? 1 : 0,
          tcActionableCount: hasActionable ? 1 : 0,
          collectCount: hasCollect ? 1 : 0,
          checkoutSentAt: null,
          checkoutFinalAt: null,
          latestPerioSendState: null,
        });
        assert.equal(progress.steps.tc.state, expected ? 'none' : 'not_applicable', `progress: ${label}`);
      }
    }
  }
});

test('2: a collect-only handoff says so, and carries an explicitly empty treatment list', () => {
  const v = visit({ collectAtCheckout: { items: ['whitening_gel'], other: '' } });
  const composed = compose('tc-handoff', v);
  // OD-safe text: the sanitizer writes the dash as '--'.
  assert.equal(composed.summary, 'Collect at checkout -- no treatment to hand off today');
  assert.deepEqual(composed.payload.items, []);
  const built = tcHandoff.buildIntake({
    visit: v, appointment: APPOINTMENT, handoffCategory: 'Other', date: '2026-09-08', existingTx: NONE,
  });
  assert.equal(built.body.suspectedTreatment, '');
  assert.deepEqual(built.body.collectAtCheckout, ['Whitening gel']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Records on the checkout snapshot
// ─────────────────────────────────────────────────────────────────────────────

test('3: the checkout snapshot carries the records the treatment needs, with where each stands', () => {
  const built = tcHandoff.buildCheckoutIntake({
    visit: visit({ recordsStatus: { 'Pre-op PA': 'taken_today' } }, [item({ code: 'Crown' })]),
    snapshot: { patientName: 'Test 2, Stedi', providerName: 'HYG1', opName: 'Hyg 1' },
    date: '2026-09-08',
    final: false,
    existingTx: NONE,
  });
  assert.deepEqual(built.body.snapshot.records, [
    { record: 'Pre-op PA', status: 'taken_today' },
    { record: 'Missing teeth note', status: 'needed' },
    { record: 'New/replacement noted', status: 'needed' },
  ]);
  assert.equal(tcContract.TcCheckoutSubmit.safeParse(built.body).success, true);
  // The TC side spells the statuses exactly as the slip does.
  assert.deepEqual([...tcContract.TcCheckoutRecordStatus.options], [...contract.RecordStatusSchema.options]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The handoff preview IS what TC receives — and goes out of date with it
// ─────────────────────────────────────────────────────────────────────────────

test('4: the handoff preview prints the items, the existing answers, the records and the collect list', () => {
  const v = visit({ collectAtCheckout: COLLECT }, [item()]);
  const preview = compose('tc-handoff', v, { existingTx: existing('cost_questions') }).preview;
  // The whole preview, exactly — OD-safe, so '·' prints as '-' and '—' as '--'.
  assert.deepEqual(preview, [
    'Category: Restorative',
    'Treatment (1):',
    '  #30 - Crown - Urgent - Restorative - Dx D - proposed',
    'Existing treatment (1):',
    '  #30 D2740 Crown - planned 2026-06-20',
    '    Clinical: Not recorded',
    '    Patient: Cost questions',
    'Records for the planned treatment:',
    '  Pre-op PA -- Needed',
    '  Missing teeth note -- Needed',
    '  New/replacement noted -- Needed',
    'Collect at checkout:',
    '  Fl2',
    '  Mouthwash',
    '  Floss picks',
  ]);
  const text = preview.join('\n');
  assert.equal(text.includes('as they stand when it is sent'), false, 'no more "it will say something later" line');
});

test('4: a staged handoff goes out of date when the items, an answer, a record or the collect list changes', () => {
  const base = { collectAtCheckout: { items: ['fl2'], other: '' }, recordsStatus: {} };
  const before = visit(base, [item()]);
  const tx = existing('ready_to_schedule');
  const row = stagedRow('tc-handoff', compose('tc-handoff', before, { existingTx: tx }));
  const reason = (v, existingTx = tx) => existingTxStale.staleReason(row, { visit: v, existingTx });

  assert.equal(reason(before), null, 'current as staged');
  assert.equal(reason(visit(base, [item({ priority: 'preventative' })])), 'handoff', 'an item changed');
  assert.equal(reason(visit(base, [])), 'handoff', 'an item removed');
  assert.equal(reason(before, existing('see_plan_again')), 'handoff', 'an existing answer changed');
  assert.equal(reason(visit({ ...base, recordsStatus: { 'Pre-op PA': 'on_file' } }, [item()])), 'handoff', 'a record');
  assert.equal(reason(visit({ ...base, collectAtCheckout: { items: [], other: 'Brush' } }, [item()])), 'handoff', 'collect');
  // Nothing TC receives changed: still current.
  assert.equal(reason(visit({ ...base, frontDeskNote: 'call after 3' }, [item()])), null);
  // Nothing left to hand off at all is out of date too.
  const emptyNow = visit({}, []);
  assert.equal(reason(emptyNow, existing('declined')), 'handoff');
});

test('4: a handoff staged by the previous build (its fixed "as they stand" line) reads out of date', () => {
  const v = visit({}, []);
  const tx = existing('ready_to_schedule');
  const current = compose('tc-handoff', v, { existingTx: tx });
  const legacy = {
    kind: 'tc-handoff',
    existingTxDigest: null,
    medicalHistoryDigest: null,
    preview: [
      'Category: Other',
      'Treatment identified today: none',
      'Existing treatment answers go with it, as they stand when it is sent.',
    ],
  };
  assert.notEqual(visitStore.fingerprintPreview(legacy.preview), visitStore.fingerprintPreview(current.preview));
  assert.equal(existingTxStale.staleReason(legacy, { visit: v, existingTx: tx }), 'handoff');
});

test('review fix: the TC case intake carries the same records its staged preview lists', () => {
  const v = visit({ recordsStatus: { 'Pre-op PA': 'on_file' } }, [item({ code: 'Crown' })]);
  const preview = compose('tc-handoff', v).preview;
  const built = tcHandoff.buildIntake({
    visit: v, appointment: APPOINTMENT, handoffCategory: 'Restorative', date: '2026-09-08', existingTx: NONE,
  });
  assert.deepEqual(built.body.records, [
    { record: 'Pre-op PA', status: 'on_file' },
    { record: 'Missing teeth note', status: 'needed' },
    { record: 'New/replacement noted', status: 'needed' },
  ]);
  for (const r of built.body.records) {
    const label = contract.RECORD_STATUS_LABELS[r.status];
    assert.ok(preview.includes(`  ${r.record} -- ${label}`), `${r.record} is in the preview`);
  }
  // No records needed: no key — the body every older visit sent.
  const none = tcHandoff.buildIntake({
    visit: visit({}, [item({ code: 'Amal' })]), appointment: APPOINTMENT, handoffCategory: 'Restorative',
    date: '2026-09-08', existingTx: NONE,
  });
  assert.equal('records' in none.body, false);
});
