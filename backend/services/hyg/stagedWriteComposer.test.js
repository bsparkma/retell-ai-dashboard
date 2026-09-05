'use strict';

/**
 * What a staged write SAYS — the pure half, with no server and no database.
 *
 * The composer is where a slip becomes words, and one slice later those words
 * become a chart note and a PDF in a patient's images. Two of the statements
 * below are compliance rather than formatting:
 *
 *   - NOTHING composed anywhere in this module may claim a signature. CareIN
 *     writes the note unsigned with a typed name block; Open Dental's own
 *     signature block is the only thing allowed to say "signed". The prototype
 *     said "Signed by" and that is a defect, not copy to lift.
 *   - A field nobody answered prints as "not answered", never as "No". The
 *     front desk acts on the difference.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const composer = require('./stagedWriteComposer');
const { emptySlip } = require('../../hyg/contract.gen.cjs');

const ACTOR = 'hygienist@carein.ai';

function visit(over = {}) {
  return {
    visitId: 'visit-0001',
    office: 'roland',
    aptNum: 900001,
    patNum: 12827,
    visitDate: '2026-09-08',
    slip: emptySlip(),
    items: [],
    ...over,
  };
}

function item(over = {}) {
  return {
    id: 'item-0001',
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
    createdBy: ACTOR,
    createdAt: '2026-09-08T14:00:00.000Z',
    ...over,
  };
}

test('the visit note carries a typed name block and NEVER claims a signature', () => {
  const composed = composer.compose('note', {
    visit: visit(),
    items: [item()],
    actor: ACTOR,
  });
  const text = [composed.title, composed.summary, ...composed.preview].join('\n');

  assert.match(text, new RegExp(composer.NAME_BLOCK_PREFIX));
  assert.match(text, /hygienist@carein\.ai/);
  assert.match(text, /Unsigned/);
  // The payload carries the fact too, so what she confirmed and what goes to
  // Open Dental say the same thing.
  assert.equal(composed.payload.isSigned, false);
  assert.ok(composed.payload.text.includes(composer.NAME_BLOCK_PREFIX));

  // The word, anywhere, in any composed output. `Unsigned` is allowed and
  // `signed` on its own is not, so the boundary is the word itself.
  assert.doesNotMatch(text, /(?<!un)\bsigned\b/i);
});

test('no source line in the composer can produce the word "signed"', () => {
  // Belt and braces over the test above, which can only see the branches it
  // exercises. A future kind that said "Signed by Dr X" would pass that one.
  //
  // Comments are stripped FIRST: the composer's own header quotes the
  // prototype's defect by name, and a scan that matched that would report the
  // documentation of the rule as a breach of it. What is under test is what the
  // CODE can emit.
  const src = fs
    .readFileSync(path.join(__dirname, 'stagedWriteComposer.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const strings = [...src.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map(
    (m) => m[1] ?? m[2] ?? m[3]
  );
  const offenders = strings.filter((s) => /(?<!un)\bsigned\b/i.test(s));
  assert.deepEqual(offenders, [], 'a compliance claim is not a styling decision');
});

test('an unanswered field prints as "not answered", not as "No"', () => {
  const composed = composer.compose('router', { visit: visit(), items: [], actor: ACTOR });
  assert.ok(composed.preview.includes('Recare scheduled: not answered'));
  assert.ok(composed.preview.includes('Treatment entered in Open Dental: not answered'));

  const answered = composer.compose('router', {
    visit: visit({ slip: { ...emptySlip(), recareScheduled: 'no' } }),
    items: [],
    actor: ACTOR,
  });
  assert.ok(answered.preview.includes('Recare scheduled: No'));
});

test('a treatment line says the teeth, the work, the urgency and the status', () => {
  const line = composer.itemLine(item());
  assert.match(line, /#3/);
  assert.match(line, /Crown/);
  assert.match(line, /Urgent/);
  assert.match(line, /Restorative/);
  assert.match(line, /Dx D/);
  // The status is on the line because "the doctor has confirmed this" and "the
  // hygienist proposed it" are different claims to put in front of a patient.
  assert.match(line, /proposed/);
});

test('a whole-mouth item says so, and an empty tooth list never prints as nothing', () => {
  assert.equal(composer.teethLabel({ teeth: 'mouth' }), 'Whole mouth');
  assert.equal(composer.teethLabel({ teeth: [] }), 'No teeth recorded');
  assert.equal(composer.teethLabel({ teeth: [3, 14] }), '#3, #14');
});

test('the handoff derives its category and refuses an empty one', () => {
  const empty = composer.compose('tc-handoff', { visit: visit(), items: [], actor: ACTOR });
  assert.match(empty.empty, /worse than no case/);

  const implant = composer.compose('tc-handoff', {
    visit: visit(),
    items: [item({ code: 'IMP', category: 'Prosth' })],
    actor: ACTOR,
  });
  assert.equal(implant.payload.category, 'Implant');
  assert.ok(implant.preview.includes('Category: Implant'));
  // The records the case needs travel WITH it — the most common reason a case
  // stalls is arriving without them.
  assert.ok(implant.preview.some((l) => l.includes('CT scan')));
});

test('perio composes to nothing, and says why', () => {
  const res = composer.compose('perio', { visit: visit(), items: [item()], actor: ACTOR });
  assert.ok(res.unavailable);
  assert.match(res.unavailable, /cannot be deleted/);
  assert.equal(res.preview, undefined, 'there is no empty envelope to send');
});

test('the router slip prints the records each treatment needs, with their status', () => {
  const composed = composer.compose('router', {
    visit: visit({
      slip: { ...emptySlip(), recordsStatus: { 'Pre-op PA': 'taken_today' } },
    }),
    items: [item()],
    actor: ACTOR,
  });
  assert.ok(composed.preview.includes('  Pre-op PA — Taken today'));
  // One nobody has touched still prints, as "Needed" — the list is a prompt,
  // and a prompt that hides the outstanding half is not one.
  assert.ok(composed.preview.some((l) => l.startsWith('  Missing teeth note — Needed')));
});

test('the payload and the preview are built from the same snapshot', () => {
  // Slice 3's rule is "the preview IS the write". That is only true if one call
  // produced both, which is what this asserts — a future refactor that composed
  // them separately would let them drift between the screen and the send.
  const composed = composer.compose('router', {
    visit: visit(),
    items: [item()],
    actor: ACTOR,
  });
  assert.deepEqual(composed.payload.lines, composed.preview);
  assert.equal(composed.payload.aptNum, 900001);
  assert.equal(composed.payload.patNum, 12827);
});
