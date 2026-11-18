'use strict';

/**
 * "Holding" — the 4th treatment-item priority (Beau's ruling).
 *
 * Holding marks an ALTERNATIVE or secondary option to the proposed treatment
 * (a bridge held as the alternative to the proposed implant). It is NOT an
 * urgency, so a holding item never raises, and never determines, the urgency
 * of a visit, a checkout card or a TC case:
 *
 *   - urgent + holding         → exactly what urgent alone gives
 *   - holding only             → exactly what a visit with NO items gives
 *   - the visit-level value    → never 'holding'
 *   - per item, to TC          → 'holding' as itself (never coerced)
 *   - in the note text         → the label "Holding", nothing else changed
 *
 * Synthetic data only (roland 12827).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const tcHandoff = require('./tcHandoffClient');
const composer = require('./stagedWriteComposer');
const contract = require('../../hyg/contract.gen.cjs');
const tcContract = require('../../tc/contract.gen.cjs');
const tcCheckout = require('../../routes/tc/checkout');

const ACTOR = 'hygienist@carein.ai';
const APPOINTMENT = { patientName: 'Test 2, Stedi', providerName: 'DOC1', opName: 'Hyg 1' };
const SNAP = { patientName: 'Test 2, Stedi', providerName: 'HYG1', doctorName: 'DOC1', opName: 'Hyg 1' };

let n = 0;
function item(over = {}) {
  n += 1;
  return {
    id: `item-${String(n).padStart(4, '0')}`,
    teeth: [30],
    code: 'Implant',
    category: 'Prosth',
    surfaces: [],
    dx: [],
    priority: 'preventative',
    motivation: [],
    status: 'proposed',
    scheduleNext: false,
    photos: [],
    createdBy: ACTOR,
    createdAt: '2026-11-16T14:00:00.000Z',
    ...over,
  };
}

function visit(items) {
  return {
    visitId: 'visit-0001',
    office: 'roland',
    aptNum: 900001,
    patNum: 12827,
    visitDate: '2026-11-16',
    slip: contract.emptySlip(),
    items,
    stagedWrites: [],
  };
}

/** An existing Open Dental item TC must act on, so a no-new-items visit is still sendable. */
function existing(clinical = null) {
  return {
    status: 'loaded',
    items: [
      {
        procNum: 5001, code: 'D2740', description: 'Crown - porcelain/ceramic', tooth: '30', surface: '',
        dateTp: '2026-06-20', priorityName: null, scheduled: false, clinical, patient: 'ready_to_schedule',
        waitTimeframe: null, note: null,
      },
    ],
  };
}

function intake(items, existingTx) {
  return tcHandoff.buildIntake({
    visit: visit(items),
    appointment: APPOINTMENT,
    handoffCategory: 'Restorative',
    date: '2026-11-16',
    existingTx,
  });
}

function checkout(items) {
  return tcHandoff.buildCheckoutIntake({
    visit: visit(items),
    snapshot: SNAP,
    date: '2026-11-16',
    final: false,
    existingTx: { status: 'loaded', items: [] },
  });
}

const holding = () => item({ code: 'Bridge', priority: 'holding' });

// ── the vocabulary ─────────────────────────────────────────────────────────

test("the item schema accepts 'holding', labelled \"Holding\", LAST in the order", () => {
  assert.deepEqual(contract.TreatmentPrioritySchema.options, ['urgent', 'preventative', 'cosmetic', 'holding']);
  assert.equal(contract.TREATMENT_PRIORITY_LABELS.holding, 'Holding');
  assert.equal(contract.TreatmentPrioritySchema.safeParse('holding').success, true);
  assert.equal(contract.countsTowardUrgency('holding'), false);
  for (const p of ['urgent', 'preventative', 'cosmetic']) assert.equal(contract.countsTowardUrgency(p), true, p);
});

test("TC: a PROCEDURE may be 'holding'; the visit-level priority may NOT", () => {
  assert.equal(tcContract.TcCheckoutItemPriority.safeParse('holding').success, true);
  assert.equal(tcContract.TcCheckoutPriority.safeParse('holding').success, false, 'visit level stays three-valued');
  assert.deepEqual(tcContract.TC_CHECKOUT_PRIORITY_ORDER, ['urgent', 'preventative', 'cosmetic']);
  assert.equal(tcContract.TC_CHECKOUT_PRIORITY_LABELS.holding, 'Holding');
  assert.equal(tcContract.checkoutPriorityOf([{ priority: 'holding' }]), null, 'all holding reads as none');
  assert.equal(tcContract.checkoutPriorityOf([{ priority: 'holding' }, { priority: 'cosmetic' }]), 'cosmetic');
});

// ── the treatment handoff (a TC case) ──────────────────────────────────────

test('urgent + holding → urgency high and flagUrgent true, exactly as urgent alone', () => {
  const both = intake([item({ priority: 'urgent' }), holding()]);
  const alone = intake([item({ priority: 'urgent' })]);
  assert.equal(both.ok, true);
  assert.equal(both.body.urgency, 'high');
  assert.equal(both.body.flagUrgent, true);
  assert.equal(both.body.urgency, alone.body.urgency);
  assert.equal(both.body.flagUrgent, alone.body.flagUrgent);
});

test('a holding item never RAISES the urgency: cosmetic + holding is still low', () => {
  const built = intake([item({ priority: 'cosmetic' }), holding()]);
  assert.equal(built.body.urgency, 'low');
  assert.equal(built.body.flagUrgent, false);
});

test('holding only → the same urgency and flagUrgent as a visit with NO items', () => {
  for (const clinical of [null, 'worse_urgent']) {
    const onlyHolding = intake([holding(), holding()], existing(clinical));
    const none = intake([], existing(clinical));
    assert.equal(onlyHolding.ok, true, String(clinical));
    assert.equal(none.ok, true, String(clinical));
    assert.equal(onlyHolding.body.urgency, none.body.urgency, `urgency (${clinical})`);
    assert.equal(onlyHolding.body.flagUrgent, none.body.flagUrgent, `flagUrgent (${clinical})`);
  }
  // And with no existing items either: preventative → medium, not urgent, not low.
  const bare = intake([holding()]);
  assert.equal(bare.body.urgency, 'medium');
  assert.equal(bare.body.flagUrgent, false);
});

test("the handoff body still LISTS a holding item, as '(holding)' — nothing is dropped", () => {
  const built = intake([item({ priority: 'urgent' }), holding()]);
  assert.equal(built.body.suspectedTreatment, '#30 Implant (urgent)\n#30 Bridge (holding)');
});

// ── the checkout alert (the card) ──────────────────────────────────────────

test("checkout: a holding procedure arrives as 'holding' (never coerced) and the card's priority ignores it", () => {
  const built = checkout([item({ priority: 'preventative' }), holding()]);
  assert.equal(built.ok, true);
  assert.deepEqual(built.body.snapshot.procedures.map((p) => p.priority), ['preventative', 'holding']);
  assert.equal(built.body.snapshot.priority, 'preventative');
  assert.equal(tcContract.TcCheckoutSubmit.safeParse(built.body).success, true, 'TC accepts it');
});

test('checkout: urgent + holding → the card reads urgent', () => {
  const built = checkout([holding(), item({ priority: 'urgent' })]);
  assert.equal(built.body.snapshot.priority, 'urgent');
});

test('checkout: holding only → priority null, exactly as a visit with no items', () => {
  const onlyHolding = checkout([holding()]);
  const none = checkout([]);
  assert.equal(onlyHolding.body.snapshot.priority, null);
  assert.equal(onlyHolding.body.snapshot.priority, none.body.snapshot.priority);
  assert.equal(tcContract.TcCheckoutSubmit.safeParse(onlyHolding.body).success, true);
});

test('checkout: an UNKNOWN priority is still coerced to preventative (unchanged)', () => {
  const built = checkout([item({ priority: 'someday' })]);
  assert.equal(built.body.snapshot.procedures[0].priority, 'preventative');
});

// ── TC's own derivations ───────────────────────────────────────────────────

test("TC plan item: holding → 'elective' (the lowest step), never the 'medium' fallback", () => {
  assert.equal(tcCheckout.itemUrgency('holding'), 'elective');
  assert.equal(tcCheckout.itemUrgency('urgent'), 'high');
  assert.equal(tcCheckout.itemUrgency('preventative'), 'medium');
  assert.equal(tcCheckout.itemUrgency('cosmetic'), 'low');
  assert.equal(tcCheckout.itemUrgency('someday'), 'medium', 'unknown still falls back as before');
  assert.equal('holding' in tcHandoff.URGENCY_BY_PRIORITY, false, 'the visit-level map has no holding row');
});

test("TC's notes line prints a holding procedure as '(holding)'", () => {
  assert.deepEqual(
    tcCheckout.procedureLines({ procedures: [{ teeth: [30], code: 'Bridge', priority: 'holding' }] }),
    ['#30 Bridge (holding)']
  );
});

test('holdingLast: a stable partition — holding after the rest, each group in entry order', () => {
  const rows = ['holding', 'urgent', 'cosmetic', 'holding', 'preventative'].map((priority, i) => ({ priority, i }));
  assert.deepEqual(tcContract.holdingLast(rows, (r) => r.priority).map((r) => r.i), [1, 2, 4, 0, 3]);
});

// ── the note text ──────────────────────────────────────────────────────────

test('note text: a holding item prints "Holding" where the priority label prints', () => {
  const line = composer.itemLine(holding());
  assert.equal(line, '#30 · Bridge · Holding · Prosth · proposed');
  // Same shape as any other priority — only the label differs.
  assert.equal(composer.itemLine(item({ code: 'Bridge', priority: 'cosmetic' })), '#30 · Bridge · Cosmetic · Prosth · proposed');

  const note = composer.compose('note', { visit: visit([holding()]), items: [holding()], actor: ACTOR });
  // The composed note goes through the existing sanitizer (· → -), unchanged here.
  assert.ok(note.payload.text.includes('#30 - Bridge - Holding - Prosth - proposed'), note.payload.text);
});

test("the staged TC handoff payload carries priority 'holding' per item", () => {
  const items = [item({ priority: 'urgent' }), holding()];
  const staged = composer.compose('tc-handoff', { visit: visit(items), items, actor: ACTOR, signature: [] });
  assert.deepEqual(staged.payload.items.map((i) => i.priority), ['urgent', 'holding']);
});
