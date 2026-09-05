'use strict';

/**
 * The send's pure parts — the PDF, the confirmation check, and the TC mapping.
 *
 * These three are where a defect is invisible from the outside: a PDF that is
 * not a PDF, a fingerprint that compares the wrong thing, a mapping that quietly
 * files a perio case as cosmetic. The route tests drive them end to end; these
 * state what they are, without a server.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const slipPdf = require('./slipPdf');
const sendVisit = require('./sendVisit');
const tcHandoff = require('./tcHandoffClient');
const visitStore = require('./visitStore');
const contract = require('../../hyg/contract.gen.cjs');

// ── the PDF ─────────────────────────────────────────────────────────────────

const LINES = [
  'Done today: Prophy, Fluoride',
  'Recare scheduled: not answered',
  'Treatment identified today (1):',
  '  #3 · Crown · O · Urgent · Restorative · Dx D · proposed',
];

test('the slip PDF is a real PDF, and the same lines make the same bytes', () => {
  const a = slipPdf.renderSlipPdf({ title: 'Routing slip', subtitle: 'Roland — 2026-09-08', lines: LINES });
  const b = slipPdf.renderSlipPdf({ title: 'Routing slip', subtitle: 'Roland — 2026-09-08', lines: LINES });

  assert.equal(a.subarray(0, 8).toString(), '%PDF-1.4');
  assert.ok(a.includes('%%EOF'));
  // DETERMINISM is the property "the preview is the write" rests on for the
  // bytes: no timestamp, no /ID, no /Info. A PDF that differed run to run could
  // not be said to be the thing she read.
  assert.ok(a.equals(b), 'the same lines must produce byte-identical output');

  // And different lines really do differ — a renderer that ignored its input
  // would also pass the test above.
  const c = slipPdf.renderSlipPdf({
    title: 'Routing slip',
    subtitle: 'Roland — 2026-09-08',
    lines: [...LINES, 'Products dispensed: Floss picks'],
  });
  assert.ok(!a.equals(c));
});

test('the PDF a chart would receive can be read back, and carries the preview', async () => {
  // Parsed with the SAME library RCM's OCR rail uses, so this is not this
  // module marking its own homework with its own reader.
  const { PDFParse } = require('pdf-parse');
  const buf = slipPdf.renderSlipPdf({
    title: 'Routing slip',
    subtitle: 'Roland Family Dental — 2026-09-08',
    lines: [...LINES, ...Array.from({ length: 70 }, (_, i) => `filler ${i}`)],
  });
  const parsed = await new PDFParse({ data: buf }).getText();
  assert.ok(parsed.text.includes('Routing slip'));
  assert.ok(parsed.text.includes('Recare scheduled: not answered'));
  // The em dash and middot are transliterated rather than dropped: a document
  // that goes into a chart does not silently lose characters.
  assert.ok(parsed.text.includes('#3 - Crown - O - Urgent'));
  assert.ok(parsed.text.includes('filler 69'), 'the second page is really there');
});

test('a long line is wrapped with its indent, not truncated', () => {
  const wrapped = slipPdf.wrap('  ' + 'word '.repeat(60));
  assert.ok(wrapped.length > 1);
  for (const line of wrapped) assert.ok(line.length <= 95, line.length);
  assert.ok(wrapped.slice(1).every((l) => l.startsWith('  ')), 'continuations keep the indent');
  // Nothing is lost.
  assert.equal(
    wrapped.join(' ').replace(/\s+/g, ' ').trim(),
    'word '.repeat(60).trim()
  );
});

// ── the confirmation check ──────────────────────────────────────────────────

function stagedRow(over = {}) {
  const preview = ['a', 'b'];
  return {
    kind: 'note',
    state: 'Staged',
    preview,
    payload: {},
    ...over,
  };
}

test('a fingerprint is a pure function of the preview and of nothing else', () => {
  const a = visitStore.fingerprintPreview(['one', 'two']);
  assert.equal(a, visitStore.fingerprintPreview(['one', 'two']));
  assert.notEqual(a, visitStore.fingerprintPreview(['one', 'three']));
  // Order is part of it: two lines swapped is a different document.
  assert.notEqual(a, visitStore.fingerprintPreview(['two', 'one']));
  assert.equal(a.length, 32);
});

test('a changed preview refuses the WHOLE batch, not just the changed item', () => {
  const rows = [stagedRow({ kind: 'note' }), stagedRow({ kind: 'router' })];
  const good = visitStore.fingerprintPreview(rows[0].preview);

  const ok = sendVisit.checkConfirmations(rows, [
    { kind: 'note', previewFingerprint: good },
    { kind: 'router', previewFingerprint: good },
  ]);
  assert.equal(ok.ok, true);
  // In SEND_ORDER: the note first, because it is the record that the visit
  // happened and the one whose absence is hardest to notice later.
  assert.deepEqual(ok.rows.map((r) => r.kind), ['note', 'router']);

  const stale = sendVisit.checkConfirmations(rows, [
    { kind: 'note', previewFingerprint: good },
    { kind: 'router', previewFingerprint: 'something-else' },
  ]);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'PREVIEW_CHANGED');
});

test('a write that is not Staged cannot be sent, whatever the fingerprint says', () => {
  for (const state of ['Draft', 'Sending', 'Written', 'Failed']) {
    const row = stagedRow({ state });
    const res = sendVisit.checkConfirmations(
      [row],
      [{ kind: 'note', previewFingerprint: visitStore.fingerprintPreview(row.preview) }]
    );
    assert.equal(res.ok, false, state);
    assert.equal(res.code, 'NOT_STAGED', state);
  }
});

test('a payload from an older build is refused rather than half-interpreted', () => {
  // The payload is composed server-side and stored as jsonb, so this guards a
  // row that predates a change — not a client, which never sees one.
  const schema = sendVisit.PAYLOAD_SCHEMAS.note;
  assert.equal(schema.safeParse({ kind: 'note' }).success, false);
  // isSigned is a LITERAL false in the schema. A payload claiming true cannot
  // be sent at all, which is a stronger statement than the writer's own flag.
  assert.equal(
    schema.safeParse({
      kind: 'note',
      aptNum: 1,
      patNum: 1,
      isSigned: true,
      nameBlock: 'x',
      text: 'y',
    }).success,
    false
  );
});

// ── the TC mapping ──────────────────────────────────────────────────────────

function visit(over = {}) {
  return {
    patNum: 12827,
    slip: { ...contract.emptySlip(), perioStage: 'stage_iii', xrayTypes: ['BW-4', 'PANO'] },
    items: [
      {
        teeth: [3],
        code: 'Crown',
        category: 'Restorative',
        priority: 'preventative',
        status: 'proposed',
        motivation: [],
        dx: [],
      },
    ],
    ...over,
  };
}

const APPT = { patientName: 'Kiwi, Sam', providerName: 'HYG1', opName: 'Hygiene 1' };

test('the handoff maps hygiene vocabulary onto TC’s, and the losses are the documented ones', () => {
  const built = tcHandoff.buildIntake({
    visit: visit(),
    appointment: APPT,
    handoffCategory: 'Perio',
    date: '2026-09-08',
  });
  assert.equal(built.ok, true);
  // TC has no perio CATEGORY; quadrant is the closest thing its pipeline has.
  assert.equal(built.body.category, 'quadrant');
  // Stage III and IV both collapse to advanced: TC's scale has no fourth step,
  // and collapsing is more honest than inventing a distinction it cannot store.
  assert.equal(built.body.perioStatus, 'advanced_perio');
  assert.deepEqual(built.body.radiographs, ['BWX', 'PANO']);
  assert.equal(built.body.urgency, 'medium');
  assert.equal(built.body.flagUrgent, false);
  assert.equal(built.body.diagnosingProvider, 'HYG1');
  assert.equal(built.body.odPatientId, 12827);
});

test('the handoff refuses rather than inventing a name or a provider', () => {
  const noName = tcHandoff.buildIntake({
    visit: visit(),
    appointment: { ...APPT, patientName: null },
    handoffCategory: 'Restorative',
    date: '2026-09-08',
  });
  assert.equal(noName.ok, false);
  assert.equal(noName.code, 'PATIENT_NAME_UNAVAILABLE');

  const noProvider = tcHandoff.buildIntake({
    visit: visit(),
    appointment: { ...APPT, providerName: '' },
    handoffCategory: 'Restorative',
    date: '2026-09-08',
  });
  assert.equal(noProvider.ok, false);
  assert.equal(noProvider.code, 'PROVIDER_UNAVAILABLE');
  // The message names the fix, in Open Dental, where it has to be made.
  assert.match(noProvider.error, /Set the provider on the appointment/);

  const noItems = tcHandoff.buildIntake({
    visit: visit({ items: [] }),
    appointment: APPT,
    handoffCategory: 'Other',
    date: '2026-09-08',
  });
  assert.equal(noItems.ok, false);
});

test('every handoff category maps to a category TC actually has', () => {
  // A mapping that produced a value outside TC's enum would be a 400 from TC at
  // send time — after the hygienist pressed the button, with a patient gone.
  const tcCategories = ['single_tooth', 'quadrant', 'implant', 'full_mouth_rehab', 'full_arch', 'cosmetic', 'ortho'];
  for (const handoff of contract.HandoffCategorySchema.options) {
    const mapped = tcHandoff.CATEGORY_MAP[handoff];
    assert.ok(mapped, `no mapping for ${handoff}`);
    assert.ok(tcCategories.includes(mapped), `${handoff} → ${mapped} is not a TC category`);
  }
  // And every perio stage the slip can hold maps to a status TC has.
  const tcPerio = ['healthy', 'gingivitis', 'early_perio', 'moderate_perio', 'advanced_perio', 'unknown'];
  for (const stage of contract.PerioStageSchema.options) {
    assert.ok(tcPerio.includes(tcHandoff.PERIO_MAP[stage]), stage);
  }
});
