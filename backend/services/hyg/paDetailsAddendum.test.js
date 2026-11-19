'use strict';

/**
 * PA details + the after-Send addendum — the pure halves.
 *
 *   1. PA DETAILS is live only while PAs is picked: the one predicate
 *      (contract.paDetailsText) decides the note (generic AND template), the
 *      routing slip, and the checkout card. A slip saved before the field parses.
 *   2. THE ADDENDUM's composed lines: heading naming the note it follows, the
 *      words, the typed-name block — Unsigned, OD-safe, never "signed".
 *   3. THE WINDOW: the office-local calendar day the visit note was sent.
 *
 * Synthetic data only: roland 12827 is the staging fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const composer = require('./stagedWriteComposer');
const tcHandoff = require('./tcHandoffClient');
const addendum = require('./addendum');
const contract = require('../../hyg/contract.gen.cjs');
const tcContract = require('../../tc/contract.gen.cjs');

const ACTOR = 'hygienist@carein.ai';
const PA = { xrayTypes: ['BW-4', 'PA'], paDetails: '  #19 and #30, sensitivity on biting  ' };

function visit(slip = {}) {
  return {
    visitId: 'visit-0001',
    office: 'roland',
    aptNum: 900001,
    patNum: 12827,
    visitDate: '2026-09-08',
    slip: { ...contract.emptySlip(), ...slip },
    items: [],
    stagedWrites: [],
  };
}

const compose = (kind, v) => composer.compose(kind, { visit: v, items: [], actor: ACTOR, existingTx: { status: 'loaded', items: [] } });

// ─────────────────────────────────────────────────────────────────────────────
// 1. PA details
// ─────────────────────────────────────────────────────────────────────────────

test('1: the slip field defaults, caps, and a slip saved before it still parses', () => {
  const old = { ...contract.emptySlip() };
  delete old.paDetails;
  assert.equal(contract.HygSlipSchema.parse(old).paDetails, '', "yesterday's slip gains ''");
  assert.equal(contract.emptySlip().paDetails, '');
  assert.equal(contract.HygSlipSchema.safeParse({ ...old, paDetails: 'x'.repeat(contract.PA_DETAILS_MAX) }).success, true);
  assert.equal(contract.HygSlipSchema.safeParse({ ...old, paDetails: 'x'.repeat(contract.PA_DETAILS_MAX + 1) }).success, false);
  assert.equal(contract.PA_XRAY, 'PA');
  assert.ok(contract.XRAY_OPTIONS.includes(contract.PA_XRAY));
});

test('1: live only while PAs is picked — typed text left behind when PAs is un-ticked prints nowhere', () => {
  assert.equal(contract.paDetailsLine({ ...PA }), 'PA details: #19 and #30, sensitivity on biting');
  assert.equal(contract.paDetailsLine({ xrayTypes: ['BW-4'], paDetails: 'left behind' }), null);
  assert.equal(contract.paDetailsLine({ xrayTypes: ['PA'], paDetails: '   ' }), null);
  assert.equal(contract.paDetailsLine(null), null);
});

test('1: the GENERIC note and the routing slip print it right under the X-rays line', () => {
  for (const kind of ['note', 'router']) {
    const lines = compose(kind, visit(PA)).preview;
    const x = lines.indexOf('X-rays: BW-4, PA');
    assert.ok(x >= 0, kind);
    assert.equal(lines[x + 1], 'PA details: #19 and #30, sensitivity on biting', kind);
    const unpicked = compose(kind, visit({ xrayTypes: ['BW-4'], paDetails: 'left behind' })).preview;
    assert.ok(!unpicked.some((l) => /PA details/.test(l)), `${kind}: nothing when PAs is not picked`);
  }
  // And the slip's PDF lines are the preview's lines.
  assert.ok(compose('router', visit(PA)).payload.lines.includes('PA details: #19 and #30, sensitivity on biting'));
});

test('1: a TEMPLATE note prints it under "Radiographs taken", inside the same staged note text', () => {
  const v = visit({ ...PA, visitType: 'adult_prophy_recall' });
  const out = compose('note', v);
  const r = out.preview.findIndex((l) => l.trim().startsWith('Radiographs taken:'));
  assert.ok(r >= 0);
  assert.equal(out.preview[r + 1], '    PA details: #19 and #30, sensitivity on biting');
  assert.ok(out.payload.text.includes('PA details: #19 and #30'), 'the preview IS the write');
  const without = compose('note', visit({ visitType: 'adult_prophy_recall', xrayTypes: ['BW-4'], paDetails: 'x' }));
  assert.ok(!without.preview.some((l) => /PA details/.test(l)));
});

test('1: a note WITHOUT PA details composes byte-identically to before this slice', () => {
  const v = visit({ visitType: 'adult_prophy_recall', xrayTypes: ['FMX'] });
  const lines = composer.noteTemplateLines(v);
  const direct = contract.renderVisitNote({
    visitType: 'adult_prophy_recall', fields: {}, chiefComplaint: '', findings: '', rtc: '',
    doneToday: [], xrayTypes: ['FMX'], productsDispensed: [], recallMonths: null, perioChartUpdated: null, srpQuads: [],
  });
  assert.deepEqual(lines, direct);
});

test('1: the checkout card carries it only while live, and TC takes it (caps agree)', () => {
  const snap = { patientName: 'Test 2, Stedi', providerName: 'HYG1', opName: 'Hyg 1' };
  const built = tcHandoff.buildCheckoutIntake({ visit: visit(PA), snapshot: snap, date: '2026-09-08', final: false, existingTx: { status: 'loaded', items: [] } });
  assert.equal(built.ok, true);
  assert.equal(built.body.snapshot.paDetails, '#19 and #30, sensitivity on biting');
  assert.equal(tcContract.TcCheckoutSubmit.safeParse(built.body).success, true);

  const none = tcHandoff.buildCheckoutIntake({
    visit: visit({ xrayTypes: ['BW-4'], paDetails: 'left behind' }), snapshot: snap, date: '2026-09-08', final: false,
    existingTx: { status: 'loaded', items: [] },
  });
  assert.equal('paDetails' in none.body.snapshot, false, 'absent, so the snapshot is what it always was');
  assert.equal(tcContract.TC_CHECKOUT_PA_DETAILS_MAX, contract.PA_DETAILS_MAX);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The addendum's words
// ─────────────────────────────────────────────────────────────────────────────

test('2: heading, words (inner blank lines kept), typed-name block — Unsigned and OD-safe', () => {
  const out = composer.composeAddendum({
    visitDate: '2026-09-08',
    noteRef: 'GroupNote 60001',
    text: '\n\nCalled back — “sensitivity” resolved.\r\n\r\nNo further action.  \n\n',
    author: ACTOR,
    enteredAt: '2026-09-08 16:30 CDT',
  });
  assert.deepEqual(out.preview, [
    'ADDENDUM to the hygiene visit note of 2026-09-08 (GroupNote 60001)',
    // The platform sanitizer's own spelling of an em dash and smart quotes.
    'Called back -- "sensitivity" resolved.',
    '',
    'No further action.',
    'Entered in CareIN by hygienist@carein.ai at 2026-09-08 16:30 CDT. Unsigned.',
  ]);
  assert.equal(out.text, out.preview.join('\n'));
  for (const l of out.preview) {
    assert.doesNotMatch(l, /(?<!un)\bsigned\b/i, 'never claims a signature');
    assert.match(l, /^[\x20-\x7e]*$/, 'ASCII, as every composed line is');
  }
});

test('2: no note reference → the heading still names the visit', () => {
  const out = composer.composeAddendum({ visitDate: null, noteRef: null, text: 'x', author: ACTOR, enteredAt: 't' });
  assert.equal(out.preview[0], 'ADDENDUM to the hygiene visit note of this visit');
  assert.equal(addendum.noteRefOf({ writtenRef: 'GroupNote 60001 on 2 procedures (5001, 5002)' }), 'GroupNote 60001');
  assert.equal(addendum.noteRefOf({ writtenRef: 'GroupNote on 2 procedures (5001, 5002)' }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The window
// ─────────────────────────────────────────────────────────────────────────────

const TZ = 'America/Chicago';
const sentOn = (sentAt) => ({ stagedWrites: [{ kind: 'note', state: 'Written', sentAt }] });

test('3: closed before the note is Written — a Failed or Staged note opens nothing', () => {
  const now = new Date('2026-09-08T20:00:00Z');
  assert.deepEqual(addendum.addendumWindow({ stagedWrites: [] }, { now, timeZone: TZ }), { open: false, reason: 'note_not_sent', day: null });
  for (const state of ['Staged', 'Sending', 'Failed']) {
    const v = { stagedWrites: [{ kind: 'note', state, sentAt: null }] };
    assert.equal(addendum.addendumWindow(v, { now, timeZone: TZ }).reason, 'note_not_sent', state);
  }
  // A sent SLIP is not a sent note.
  const slipOnly = { stagedWrites: [{ kind: 'router', state: 'Written', sentAt: '2026-09-08T15:00:00Z' }] };
  assert.equal(addendum.addendumWindow(slipOnly, { now, timeZone: TZ }).reason, 'note_not_sent');
});

test('3: open the whole office-local day, closed from local midnight — whatever UTC says', () => {
  const v = sentOn('2026-09-08T15:00:00Z'); // 10:00 CDT
  const at = (iso) => addendum.addendumWindow(v, { now: new Date(iso), timeZone: TZ });
  assert.deepEqual(at('2026-09-08T15:00:01Z'), { open: true, reason: null, day: '2026-09-08' });
  // 23:59 CDT is still the day, though UTC is already the 9th.
  assert.equal(at('2026-09-09T04:59:00Z').open, true);
  // 00:00 CDT is not.
  assert.deepEqual(at('2026-09-09T05:00:00Z'), { open: false, reason: 'day_closed', day: '2026-09-08' });
  assert.equal(at('2026-10-01T15:00:00Z').reason, 'day_closed', 'read-only forever');
});

test('3: the time label is office-local with its zone', () => {
  assert.equal(addendum.officeStamp(TZ, new Date('2026-09-08T21:30:00Z')), '2026-09-08 16:30 CDT');
  assert.equal(addendum.officeStamp(TZ, new Date('2026-12-08T21:30:00Z')), '2026-12-08 15:30 CST');
});
