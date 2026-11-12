'use strict';

/**
 * SRP multi-quad + three Done-today chips (4346, FMD, Fine Scale).
 *
 *   1. ONE `srp` visit type: the note's anesthetic-sites line follows the
 *      arches picked, the scaled line names every quad picked, ascending.
 *   2. The shared schema refuses a bad quad pick (empty on SRP, out of range,
 *      duplicate, unsorted, quads on a non-SRP type) — and so does the server
 *      route (400), never only the form.
 *   3. The retired srp_quad_N types: hidden on a fresh slip, still offered on a
 *      slip that holds one, still parse, compose BYTE-IDENTICALLY to the output
 *      pinned before this change, and re-save unchanged.
 *   4. The three chips print on the Router and the generic note like any chip,
 *      match no id prefix a reader keys on, and cause no staged write and no
 *      Open Dental write.
 *
 * Synthetic data only: roland 12827 is the staging fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const composer = require('./stagedWriteComposer');
const contract = require('../../hyg/contract.gen.cjs');
const { FakeOd, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('../../routes/hyg/hygTestUtils');

const { useSyntheticStaff } = require('../../config/hygStaff.fixture');
useSyntheticStaff();

const ACTOR = 'hygienist@carein.ai';
const UPPER =
  'Anesthetic sites: PSA, MSA, ASA, 30 short. Topical anesthetic gel benzocaine 20%.';
const LOWER =
  'Anesthetic sites: IA, LB, Mental, Anterior Infiltration, 30 short. Topical anesthetic gel benzocaine 20%.';

const f = (grades, detail = '') => ({ grades, detail });

/** One filled-in SRP visit's renderer input. */
function srpInput(visitType, srpQuads) {
  return {
    visitType,
    fields: {
      ste: f(['WNL']),
      hte: f(['RD', 'XD']),
      boneLoss: f(['Mild (3-4mm)'], 'UL post'),
      perioClass: f(['Moderate']),
      anesthetic: f([], '2 carps Septocaine'),
      carps: f(['2']),
      calculus: f(['Moderate'], 'UL'),
      plaque: f(['Heavy']),
      bleeding: f(['Minimal']),
      inflammation: f([], 'mild'),
    },
    chiefComplaint: 'sensitivity',
    findings: '',
    rtc: '4 wks',
    doneToday: ['srp-ul'],
    xrayTypes: ['PA'],
    productsDispensed: [],
    recallMonths: 3,
    perioChartUpdated: 'yes',
    ...(srpQuads === undefined ? {} : { srpQuads }),
  };
}

/** The note with the sites sentence(s) and the scaled line substituted in. */
function srpNote(sites, scaled) {
  return [
    'S:  Patient presents for SRP appointment.  CC: sensitivity',
    '',
    'O:  Reviewed medical history with patient.  Same',
    '    Radiographs taken: PA',
    'SRP needed due to bone loss: Mild (3-4mm) UL post',
    '',
    'A:   STE: WNL  HTE: RD, XD',
    '',
    'Perio class: Moderate',
    'Perio chart updated',
    ...sites,
    'Anesthetic: 2 carps Septocaine',
    'Total Carps: 2',
    scaled,
    'Calculus: Moderate UL',
    'Plaque: Heavy',
    'Bleeding: Minimal',
    'Inflammation: mild',
    '',
    'P:  Return for Recall in 3 months',
    '',
    'RTC: 4 wks',
  ];
}

/**
 * PINNED BEFORE THIS CHANGE: renderVisitNote(srpInput('srp_quad_2')) on
 * origin/develop 8adfa0f, captured verbatim. A retired type must keep composing
 * exactly this.
 */
const SRP_QUAD_2_PINNED = [
  'S:  Patient presents for SRP appointment.  CC: sensitivity',
  '',
  'O:  Reviewed medical history with patient.  Same',
  '    Radiographs taken: PA',
  'SRP needed due to bone loss: Mild (3-4mm) UL post',
  '',
  'A:   STE: WNL  HTE: RD, XD',
  '',
  'Perio class: Moderate',
  'Perio chart updated',
  'Anesthetic sites: PSA, MSA, ASA, 30 short. Topical anesthetic gel benzocaine 20%.',
  'Anesthetic: 2 carps Septocaine',
  'Total Carps: 2',
  'Cavitron and hand scaled Quad 2',
  'Calculus: Moderate UL',
  'Plaque: Heavy',
  'Bleeding: Minimal',
  'Inflammation: mild',
  '',
  'P:  Return for Recall in 3 months',
  '',
  'RTC: 4 wks',
];

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

function compose(kind, v) {
  return composer.compose(kind, { visit: v, items: v.items, actor: ACTOR, signature: [] });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The `srp` note
// ─────────────────────────────────────────────────────────────────────────────

test('srp [2]: upper sites only, "Quad 2"', () => {
  assert.deepEqual(
    contract.renderVisitNote(srpInput('srp', [2])),
    srpNote([UPPER], 'Cavitron and hand scaled Quad 2')
  );
});

test('srp [3]: lower sites only, "Quad 3"', () => {
  assert.deepEqual(
    contract.renderVisitNote(srpInput('srp', [3])),
    srpNote([LOWER], 'Cavitron and hand scaled Quad 3')
  );
});

test('srp [1,4]: both arches, upper first, "Quad 1, 4"', () => {
  assert.deepEqual(
    contract.renderVisitNote(srpInput('srp', [1, 4])),
    srpNote([UPPER, LOWER], 'Cavitron and hand scaled Quad 1, 4')
  );
});

test('srp [1,2,3,4]: both arches once each, "Quad 1, 2, 3, 4"', () => {
  assert.deepEqual(
    contract.renderVisitNote(srpInput('srp', [1, 2, 3, 4])),
    srpNote([UPPER, LOWER], 'Cavitron and hand scaled Quad 1, 2, 3, 4')
  );
});

test('srp through the composer: the stored slip srpQuads reach the note', () => {
  const lines = compose('note', visit({ visitType: 'srp', visitTypeSource: 'manual', srpQuads: [1, 3] })).preview;
  assert.ok(lines.includes('Cavitron and hand scaled Quad 1, 3'));
  assert.ok(lines.includes(UPPER) && lines.includes(LOWER));
  // The summary names the type by its label.
  const summary = compose('note', visit({ visitType: 'srp', visitTypeSource: 'manual', srpQuads: [1] })).summary;
  assert.match(summary, /An unsigned SRP note/);
});

test('srp vocabulary: label "SRP", a draft, same rows as the per-quad note', () => {
  assert.equal(contract.VISIT_TYPE_LABELS.srp, 'SRP');
  assert.ok(contract.DRAFT_VISIT_TYPES.has('srp'));
  assert.deepEqual(contract.controlsFor('srp'), contract.controlsFor('srp_quad_1'));
  assert.ok(!contract.controlsFor('srp').includes('drs'), 'no exam clause, so no doctor in the signature');
});

test('srp parity: covers every graded hole of BOTH SRP Upper and SRP Lower (VISIT_TYPE_AUTONOTE names Upper)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const exportJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'hyg-autonotes', 'autonotes.json'), 'utf8')
  );
  assert.equal(contract.VISIT_TYPE_AUTONOTE.srp, 'SRP Upper');
  const ours = new Set(contract.controlsFor('srp').map((id) => contract.NOTE_CONTROLS[id].descript.trim()));
  for (const name of ['SRP Upper', 'SRP Lower']) {
    const note = exportJson.AutoNotes.find((n) => n.AutoNoteName.trim() === name);
    assert.ok(note, name);
    const prompts = [...note.MainText.matchAll(/\[Prompt:"([^"]+)"\]/g)].map((m) => m[1].trim());
    for (const p of prompts) {
      // "Quad" is answered by srpQuads, and the note prints it (tests above).
      if (p === 'Quad') continue;
      assert.ok(ours.has(p), `srp has no row for the "${p}" hole in ${name}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Refusals — the shared schema
// ─────────────────────────────────────────────────────────────────────────────

const BAD_PAIRS = [
  ['srp', [], 'empty quads on SRP'],
  ['srp', [0], 'quad 0'],
  ['srp', [5], 'quad 5'],
  ['srp', [1.5], 'a fractional quad'],
  ['srp', [2, 2], 'a duplicate'],
  ['srp', [3, 1], 'unsorted'],
  ['srp', [1, 2, 3, 4, 4], 'five entries'],
  ['perio_maint', [1], 'quads on a non-SRP type'],
  ['srp_quad_2', [2], 'quads on a retired per-quad type'],
  [null, [2], 'quads with no type'],
];

test('the shared slip schema refuses every bad quad pick, naming srpQuads', () => {
  for (const [visitType, srpQuads, why] of BAD_PAIRS) {
    const parsed = contract.HygSlipSchema.safeParse({ ...contract.emptySlip(), visitType, srpQuads });
    assert.equal(parsed.success, false, why);
    assert.ok(parsed.error.issues.some((i) => i.path[0] === 'srpQuads'), `${why}: names srpQuads`);
  }
  for (const [visitType, srpQuads] of [['srp', [1]], ['srp', [1, 4]], ['srp', [1, 2, 3, 4]], ['perio_maint', []], [null, []]]) {
    assert.ok(contract.HygSlipSchema.safeParse({ ...contract.emptySlip(), visitType, srpQuads }).success, JSON.stringify([visitType, srpQuads]));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The retired per-quad types
// ─────────────────────────────────────────────────────────────────────────────

test('retired srp_quad_N: hidden on a fresh slip, offered on a slip that holds one', () => {
  const fresh = contract.visitTypeChoices(null);
  assert.ok(fresh.includes('srp'));
  for (const q of [1, 2, 3, 4]) assert.ok(!fresh.includes(`srp_quad_${q}`), `srp_quad_${q} hidden`);
  const held = contract.visitTypeChoices('srp_quad_2');
  assert.ok(held.includes('srp_quad_2'));
  assert.ok(!held.includes('srp_quad_1') && !held.includes('srp_quad_3'), 'only the held one');
  // Every value is still a valid enum member.
  for (const q of [1, 2, 3, 4]) assert.ok(contract.VisitTypeSchema.safeParse(`srp_quad_${q}`).success);
});

test('retired srp_quad_2 composes BYTE-IDENTICALLY to the output pinned before this change', () => {
  assert.deepEqual(contract.renderVisitNote(srpInput('srp_quad_2')), SRP_QUAD_2_PINNED);
  // Handing it quads changes nothing: only the srp template reads them.
  assert.deepEqual(contract.renderVisitNote(srpInput('srp_quad_2', [1, 3])), SRP_QUAD_2_PINNED);
});

test('a slip saved before this change with srp_quad_2 loads, gains srpQuads: [], and re-parses unchanged', () => {
  // Yesterday's JSON: no srpQuads key at all.
  const old = { ...contract.emptySlip(), visitType: 'srp_quad_2', visitTypeSource: 'manual' };
  delete old.srpQuads;
  const parsed = contract.HygSlipSchema.parse(JSON.parse(JSON.stringify(old)));
  assert.equal(parsed.visitType, 'srp_quad_2');
  assert.deepEqual(parsed.srpQuads, []);
  // A re-save is a fixed point.
  assert.deepEqual(contract.HygSlipSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The three Done-today chips
// ─────────────────────────────────────────────────────────────────────────────

const NEW_CHIPS = [
  ['d4346', '4346'],
  ['fmd', 'FMD'],
  ['fine-scale', 'Fine Scale'],
];

test('the three chips are live, labelled, after the live ones and before the retired polish', () => {
  const ids = contract.DONE_TODAY_OPTIONS.map((o) => o.id);
  for (const [id, label] of NEW_CHIPS) {
    const opt = contract.DONE_TODAY_OPTIONS.find((o) => o.id === id);
    assert.ok(opt && opt.label === label && !opt.retired, id);
    assert.ok(contract.doneTodayChoices([]).some((o) => o.id === id), `${id} offered on a fresh slip`);
    assert.ok(ids.indexOf(id) < ids.indexOf('polish'), `${id} before polish`);
    assert.ok(ids.indexOf(id) > ids.indexOf('ofi'), `${id} after the existing live chips`);
  }
});

test('no new chip id matches a prefix any reader keys on (srp-, laser-)', () => {
  for (const [id] of NEW_CHIPS) {
    for (const prefix of ['srp-', 'laser-']) assert.ok(!id.startsWith(prefix), `${id} vs ${prefix}`);
  }
  // The Laser note's quadrant line is unmoved by them.
  const laser = compose('note', visit({
    visitType: 'laser', visitTypeSource: 'manual', doneToday: ['laser-ur', 'd4346', 'fmd', 'fine-scale'],
  })).preview;
  assert.ok(laser.includes('Quadrants: UR'));
});

test('the chips print on the Router and on the generic note, by label', () => {
  const v = visit({ doneToday: ['prophy', 'd4346', 'fmd', 'fine-scale'] });
  assert.ok(compose('router', v).preview.includes('Done today: Prophy, 4346, FMD, Fine Scale'));
  assert.ok(compose('note', v).preview.includes('Done today: Prophy, 4346, FMD, Fine Scale'));
});

test('the chips change no staged-write payload shape: same kinds, same keys, only the Done-today text differs', () => {
  const without = visit({ doneToday: ['prophy'] });
  const withChips = visit({ doneToday: ['prophy', 'd4346', 'fmd', 'fine-scale'] });
  for (const kind of ['router', 'note']) {
    const a = compose(kind, without);
    const b = compose(kind, withChips);
    assert.deepEqual(Object.keys(b.payload).sort(), Object.keys(a.payload).sort(), kind);
    assert.equal(b.payload.kind, a.payload.kind);
  }
});

function od() {
  return new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: '2026-09-08 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
    '/procedurelogs': [],
    '/procedurelogs/GroupNotes': [],
    '/definitions': [{ DefNum: 473, ItemName: 'Routers' }],
  });
}

const Q = '?office=roland&date=2026-09-08';

test('route: PUT /visit refuses every bad quad pick with 400 INVALID_BODY naming srpQuads, and stores nothing', async () => {
  const fake = od();
  const app = await bootHygApp({ od: fake });
  try {
    const open = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    assert.equal(open.status, 200, JSON.stringify(open.body));
    for (const [visitType, srpQuads, why] of BAD_PAIRS) {
      const slip = { ...open.body.visit.slip, visitType, visitTypeSource: visitType ? 'manual' : null, srpQuads };
      const res = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, { body: { slip } });
      assert.equal(res.status, 400, `${why}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'INVALID_BODY');
      assert.match(res.body.field, /srpQuads/, why);
    }
    const after = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.equal(after.body.visit.slip.visitType, open.body.visit.slip.visitType, 'nothing was stored');
    assert.deepEqual(fake.writes, [], 'no Open Dental write');
  } finally {
    await app.close();
  }
});

test('route: srp [1,3] saves and stages a note printing "Quad 1, 3"; a retired srp_quad_2 slip re-saves unchanged', async () => {
  const fake = od();
  const app = await bootHygApp({ od: fake });
  try {
    const open = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    const srp = { ...open.body.visit.slip, visitType: 'srp', visitTypeSource: 'manual', srpQuads: [1, 3] };
    const saved = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, { body: { slip: srp } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.visit.slip.srpQuads, [1, 3]);
    const staged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, { body: { kind: 'note' } });
    assert.equal(staged.status, 201, JSON.stringify(staged.body));
    const note = staged.body.visit.stagedWrites.find((w) => w.kind === 'note');
    assert.ok(note.preview.includes('Cavitron and hand scaled Quad 1, 3'));
    assert.ok(note.preview.includes(UPPER) && note.preview.includes(LOWER));

    // A retired type, as an old slip holds it: saves, and reads back exactly.
    const legacy = { ...saved.body.visit.slip, visitType: 'srp_quad_2', srpQuads: [] };
    const re = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, { body: { slip: legacy } });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    assert.deepEqual(re.body.visit.slip, legacy);
    const again = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, { body: { slip: re.body.visit.slip } });
    assert.deepEqual(again.body.visit.slip, legacy, 're-save is a fixed point');
    assert.deepEqual(fake.writes, [], 'staging is not sending: no Open Dental write');
  } finally {
    await app.close();
  }
});

test('route: saving the three chips stages nothing and writes nothing to Open Dental', async () => {
  const fake = od();
  const app = await bootHygApp({ od: fake });
  try {
    const open = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    const callsBefore = fake.calls.length;
    const slip = { ...open.body.visit.slip, doneToday: ['prophy', 'd4346', 'fmd', 'fine-scale'] };
    const saved = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, { body: { slip } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.visit.slip.doneToday, ['prophy', 'd4346', 'fmd', 'fine-scale']);
    assert.deepEqual(saved.body.visit.stagedWrites, [], 'a chip stages nothing by itself');
    assert.equal(fake.calls.length, callsBefore, 'a slip save makes no Open Dental call');
    assert.deepEqual(fake.writes, []);
  } finally {
    await app.close();
  }
});
