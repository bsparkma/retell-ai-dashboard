'use strict';

/**
 * DOES THE NOTE CAREIN WRITES READ LIKE THE NOTE SHE WOULD HAVE TYPED?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TWO KINDS OF TEST, AND THEY ANSWER DIFFERENT QUESTIONS
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. PARITY — reads the practice's OWN export at `docs/hyg-autonotes/autonotes.json`
 *    and asserts that `shared/hyg/noteTemplates.ts` still agrees with it about
 *    which templates exist, which pick-lists they use, and what is on each
 *    pick-list. This file is a RE-STATEMENT of somebody else's data, and a
 *    re-statement with nothing checking it drifts. Two spellings are corrected
 *    on purpose and are named explicitly; a THIRD difference is a red build.
 *
 * 2. SNAPSHOT — renders each of the five templates from a fixture visit and
 *    pins the whole note, line for line. That is the only way to review "does
 *    this read like their note" as a diff rather than as an opinion, and it is
 *    what acceptance test 1 asks for.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO REAL PATIENT, ANYWHERE
 * ═════════════════════════════════════════════════════════════════════════════
 * The fixture is PatNum 12827 in roland — `Stedi Test 2`, the staging test
 * patient — and no name is printed by any of this. The clinician names in the
 * signature block are the practice's own staff, from their own signature auto
 * notes; they are not patients.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const composer = require('./stagedWriteComposer');
const contract = require('../../hyg/contract.gen.cjs');
const hygStaff = require('../../config/hygStaff');

const AUTONOTES = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'docs', 'hyg-autonotes', 'autonotes.json'),
    'utf8'
  )
);

const ACTOR = 'hygienist@carein.ai';

/** The practice's own export names carry stray whitespace. Match on the trim. */
function autoNoteNamed(name) {
  return AUTONOTES.AutoNotes.find((n) => n.AutoNoteName.trim() === name.trim()) || null;
}

function controlNamed(descript) {
  return (
    AUTONOTES.AutoNoteControls.find((c) => c.Descript.trim() === descript.trim()) || null
  );
}

/** `"Good\r\nFair \r\nPoor"` → `['Good', 'Fair', 'Poor']`. */
function controlOptions(control) {
  return control.ControlOptions.split(/\r?\n/)
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/** Every `[Prompt:"X"]` hole in a template's MainText, in order, de-duplicated. */
function promptsIn(mainText) {
  const out = [];
  const re = /\[Prompt:"([^"]*)"\]/g;
  let m;
  while ((m = re.exec(mainText)) !== null) {
    const name = m[1].trim();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parity with the practice's export
// ─────────────────────────────────────────────────────────────────────────────

test('every visit type names an auto note that actually exists in the export', () => {
  for (const visitType of contract.VISIT_TYPES) {
    const name = contract.VISIT_TYPE_AUTONOTE[visitType];
    assert.ok(name, `${visitType} has no AutoNoteName`);
    assert.ok(
      autoNoteNamed(name),
      `${visitType} claims to re-state "${name}", which is not in autonotes.json`
    );
  }
});

test('every control this build renders exists in the export, under that name', () => {
  for (const [id, control] of Object.entries(contract.NOTE_CONTROLS)) {
    assert.ok(
      controlNamed(control.descript),
      `control ${id} claims AutoNoteControl "${control.descript}", which does not exist`
    );
  }
});

test('every option list matches the export, apart from two named spellings', () => {
  const corrections = contract.CORRECTED_OPTION_SPELLINGS;
  const used = new Set();

  for (const [id, control] of Object.entries(contract.NOTE_CONTROLS)) {
    // `drs` is deliberately empty here: the doctors are per office and live in
    // backend/config/hygStaff.js, never in a file both practices share.
    if (id === 'drs') {
      assert.deepEqual(control.options, [], 'the doctor list must not be hardcoded here');
      continue;
    }
    const theirs = controlOptions(controlNamed(control.descript));
    const ours = control.options.map((o) => o);
    assert.equal(
      ours.length,
      theirs.length,
      `${id}: ${ours.length} options here, ${theirs.length} in the export`
    );
    for (let i = 0; i < ours.length; i += 1) {
      if (ours[i] === theirs[i]) continue;
      // A difference is allowed ONLY when it is one of the two typo fixes this
      // build declares. Anything else means the practice changed a pick-list
      // and nobody carried it across.
      assert.equal(
        corrections[theirs[i]],
        ours[i],
        `${id} option ${i}: the export says "${theirs[i]}" and this build says "${ours[i]}", ` +
          'which is not one of the declared spelling corrections'
      );
      used.add(theirs[i]);
    }
  }

  // Every declared correction must still be EARNED. A fix left behind after the
  // practice tidied their own pick-list is a licence to differ that nobody
  // needs any more.
  const partial = Object.keys(corrections).filter((k) => !k.includes('/'));
  for (const source of Object.keys(corrections)) {
    if (used.has(source)) continue;
    // `Advaced` appears as a whole option in the export ("Advaced "), so it is
    // matched above; anything unused is stale.
    assert.ok(
      partial.includes(source) === false,
      `the correction "${source}" is no longer needed and should be removed`
    );
  }
});

test('the multi/one-response flag matches the export for every control', () => {
  for (const [id, control] of Object.entries(contract.NOTE_CONTROLS)) {
    const theirs = controlNamed(control.descript);
    assert.equal(
      control.multi,
      theirs.ControlType === 'MultiResponse',
      `${id}: ControlType is ${theirs.ControlType} in the export`
    );
  }
});

test("a template's rows cover every graded hole its auto note has", () => {
  // The other direction: not "does our control exist" but "did we forget one".
  // The templates also print holes this form does not GRADE — the free-text
  // ones — so those are named here rather than silently tolerated.
  const FREE_TEXT_PROMPTS = new Set(['Chief Complaint']);

  for (const visitType of contract.VISIT_TYPES) {
    const source = autoNoteNamed(contract.VISIT_TYPE_AUTONOTE[visitType]);
    const theirs = promptsIn(source.MainText).filter((p) => !FREE_TEXT_PROMPTS.has(p));
    const ours = new Set(
      contract
        .controlsFor(visitType)
        .map((id) => contract.NOTE_CONTROLS[id].descript.trim())
    );
    for (const prompt of theirs) {
      assert.ok(
        ours.has(prompt),
        `${visitType} does not offer a row for the "${prompt}" hole its auto note has`
      );
    }
  }
});

test('the form offers no row the note would not print', () => {
  for (const visitType of contract.VISIT_TYPES) {
    const rendered = contract
      .renderVisitNote(fixtureInput(visitType, { fill: true }))
      .join('\n');
    for (const id of contract.controlsFor(visitType)) {
      if (id === 'drs') {
        assert.match(rendered, /Dr\. /, `${visitType} offers a doctor row it never prints`);
        continue;
      }
      const label = contract.controlLabel(visitType, id);
      assert.ok(
        rendered.includes(`${label}:`),
        `${visitType} offers a "${label}" row that its note never prints`
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// What the note actually says
// ─────────────────────────────────────────────────────────────────────────────

/** A filled answer for every control a visit type shows. */
function filledFields(visitType) {
  const fields = {};
  for (const id of contract.controlsFor(visitType)) {
    if (id === 'drs') {
      fields[id] = { grades: ['Sparkman'], detail: '' };
      continue;
    }
    const control = contract.NOTE_CONTROLS[id];
    fields[id] = { grades: [control.options[0]], detail: '' };
  }
  // The suffix is the half that makes these notes worth reading: their own
  // notes say "Calculus: Slight-mod Lower ant and U post".
  if (fields.calculus) fields.calculus = { grades: ['Slight'], detail: 'Lower ant and U post' };
  if (fields.subCalculus) {
    fields.subCalculus = { grades: ['Moderate'], detail: 'Lower ant' };
  }
  if (fields.hte) fields.hte = { grades: ['RD', 'XD'], detail: '#14' };
  return fields;
}

function fixtureInput(visitType, { fill }) {
  return {
    visitType,
    fields: fill ? filledFields(visitType) : {},
    chiefComplaint: fill ? 'Cold sensitivity upper right.' : '',
    findings: fill ? 'Generalised light calculus, BOP UR.' : '',
    rtc: fill ? '6 mo recall' : '',
    doneToday: fill ? ['prophy', 'fluoride'] : [],
    xrayTypes: fill ? ['BW-4'] : [],
    productsDispensed: [],
    recallMonths: fill ? 6 : null,
    perioChartUpdated: fill ? 'yes' : null,
  };
}

/** A visit whose slip is the auto-note half of the form, filled in. */
function visit(visitType, over = {}) {
  const input = fixtureInput(visitType, { fill: true });
  return {
    visitId: 'visit-0001',
    office: 'roland',
    aptNum: 900001,
    // The roland staging fixture. A PatNum is meaningless without its office.
    patNum: 12827,
    visitDate: '2026-09-08',
    slip: {
      ...contract.emptySlip(),
      visitType,
      visitTypeSource: 'manual',
      noteFields: input.fields,
      patientConcerns: input.chiefComplaint,
      hygieneFindings: input.findings,
      rtc: input.rtc,
      doneToday: input.doneToday,
      xrayTypes: input.xrayTypes,
      nextVisit: { type: null, intervalMonths: 6, lengthMin: 60, withDoctor: false },
      perioChartUpdated: input.perioChartUpdated,
    },
    items: [],
    ...over,
  };
}

const SIGNATURE = hygStaff.signatureBlock({
  office: 'roland',
  hygienistName: 'Raegan McGee',
});

function noteFor(visitType, over = {}) {
  const v = visit(visitType, over);
  return composer.compose('note', {
    visit: v,
    items: v.items,
    actor: ACTOR,
    signature: SIGNATURE,
  });
}

/**
 * ACCEPTANCE 1 — the whole note, pinned.
 *
 * Read this beside `docs/hyg-autonotes/autonotes.json`. If a template changes,
 * this diff is the review.
 */
test('SNAPSHOT: Adult Prophy Recall renders the practice template, line for line', () => {
  assert.deepEqual(noteFor('adult_prophy_recall').preview, [
    'S:  Patient presents for recall appointment.  Chief complaint: Cold sensitivity upper right.',
    '',
    'O:  Reviewed medical history with patient.  Same',
    '    Radiographs taken: BW-4',
    '',
    'A:   STE: Inflammation/bleeding Mild  HTE: RD, XD #14  Polished, flossed, scaled as needed.  ' +
      'Dr. Sparkman performed periodic exam.  Findings: Generalised light calculus, BOP UR.',
    '',
    'P:  Return for Recall in 6 months',
    '',
    'Perio: WNL',
    'Plaque: Minimal',
    'Calculus: Slight Lower ant and U post',
    'Bleeding: Minimal',
    'Stain: Slight',
    'Mallampati: Class 1',
    'RTC: 6 mo recall',
    '',
    'Raegan McGee RDH #4251',
    'Beau Sparkman DDS #6347',
    'Blain VanNice DDS #7971',
    'Joe Farmer DDS #7571',
    'Entered in CareIN by hygienist@carein.ai. Unsigned.',
  ]);
});

test('SNAPSHOT: Adult Prophy NP keeps OH and Bone Loss, and says comp exam', () => {
  assert.deepEqual(noteFor('adult_prophy_np').preview, [
    'S:  Patient presents for new pt appointment.  Chief complaint: Cold sensitivity upper right.',
    '',
    // No "Same" on a new patient: there is nothing to be the same as.
    'O:  Reviewed medical history with patient.',
    '    Radiographs taken: BW-4',
    '',
    'A:   STE: Inflammation/bleeding Mild  HTE: RD, XD #14  Polished, flossed, scaled as needed.  ' +
      'Dr. Sparkman performed comp exam.  Findings: Generalised light calculus, BOP UR.',
    '',
    'P:  Return for Recall in 6 months',
    '',
    'OH: Good',
    'Perio status: WNL',
    'Bone Loss: WNL(1-2mm)',
    'Plaque: Minimal',
    'Calculus: Slight Lower ant and U post',
    'Bleeding: Minimal',
    'Stain: Slight',
    'Mallampati: Class 1',
    'RTC: 6 mo recall',
    '',
    'Raegan McGee RDH #4251',
    'Beau Sparkman DDS #6347',
    'Blain VanNice DDS #7971',
    'Joe Farmer DDS #7571',
    'Entered in CareIN by hygienist@carein.ai. Unsigned.',
  ]);
});

test('SNAPSHOT: a child note carries FL2TX and the behaviour scale', () => {
  const preview = noteFor('child_prophy_recall').preview;
  assert.deepEqual(preview, [
    'S:  Patient presents for recall appointment.  Chief complaint: Cold sensitivity upper right.',
    '',
    'O:  Reviewed medical history with patient.  Same',
    '    Radiographs taken: BW-4',
    '',
    'A:   STE: Inflammation/bleeding Mild  HTE: RD, XD #14  ' +
      'Polished, flossed, scaled as needed, FL2TX.  ' +
      'Dr. Sparkman performed periodic exam.  Findings: Generalised light calculus, BOP UR.',
    '',
    'P:  Return for Recall in 6 months',
    '',
    'OH: Good',
    'Plaque: Minimal',
    'Calculus: Slight Lower ant and U post',
    'Bleeding: Minimal',
    'Stain: Slight',
    '',
    'Pediatric behavior: 1- uncooperative/combative',
    '',
    'RTC: 6 mo recall',
    '',
    'Raegan McGee RDH #4251',
    'Beau Sparkman DDS #6347',
    'Blain VanNice DDS #7971',
    'Joe Farmer DDS #7571',
    'Entered in CareIN by hygienist@carein.ai. Unsigned.',
  ]);
});

test('SNAPSHOT: Perio Maint asks sub and supra separately and has no exam clause', () => {
  assert.deepEqual(noteFor('perio_maint').preview, [
    'S:  Patient presents for perio maintenance appointment.  CC: Cold sensitivity upper right.',
    '',
    'O:  Reviewed medical history with patient.  Same',
    '    Radiographs taken: BW-4',
    '',
    // No doctor and no Findings on the A: line — the source template has
    // neither. The findings box gets its own line further down instead.
    'A:   STE: Inflammation/bleeding Mild  HTE: RD, XD #14  Polished, flossed, scaled as needed.',
    '',
    'P:  Return for Recall in 6 months',
    '',
    'Perio Class: WNL',
    'Perio chart updated',
    'Plaque: Minimal',
    'Sub Calculus: Moderate Lower ant',
    'Supra Calculus: Slight',
    'Bone Loss: WNL(1-2mm)',
    'Bleeding: Minimal',
    'Stain: Slight',
    'Mallampati class: Class 1',
    'Findings: Generalised light calculus, BOP UR.',
    '',
    'RTC: 6 mo recall',
    '',
    'Raegan McGee RDH #4251',
    'Beau Sparkman DDS #6347',
    'Blain VanNice DDS #7971',
    'Joe Farmer DDS #7571',
    'Entered in CareIN by hygienist@carein.ai. Unsigned.',
  ]);
});

test('SNAPSHOT: Child Prophy NP', () => {
  const preview = noteFor('child_prophy_np').preview;
  assert.equal(
    preview[0],
    'S:  Patient presents for new pt appointment.  Chief complaint: Cold sensitivity upper right.'
  );
  assert.equal(preview[2], 'O:  Reviewed medical history with patient.');
  assert.match(preview[5], /FL2TX\.  Dr\. Sparkman performed comp exam\./);
  assert.ok(preview.includes('Pediatric behavior: 1- uncooperative/combative'));
});

/** ACCEPTANCE 2 — grade plus location, which is how their notes actually read. */
test('a chip and its suffix render as "Calculus: Slight Lower ant and U post"', () => {
  const preview = noteFor('adult_prophy_recall').preview;
  assert.ok(
    preview.includes('Calculus: Slight Lower ant and U post'),
    preview.join('\n')
  );
  // A multi-response control joins its picks and keeps the suffix after them.
  assert.ok(preview.some((l) => l.includes('HTE: RD, XD #14')));
});

/** ACCEPTANCE 3 — an unset chip is a blank, never a value. */
test('an unset chip renders as its label and a blank, and NEVER invents a grade', () => {
  const bare = {
    visitId: 'visit-0002',
    office: 'roland',
    aptNum: 900002,
    patNum: 12827,
    visitDate: '2026-09-08',
    slip: { ...contract.emptySlip(), visitType: 'adult_prophy_recall' },
    items: [],
  };
  const composed = composer.compose('note', {
    visit: bare,
    items: [],
    actor: ACTOR,
    signature: SIGNATURE,
  });

  assert.deepEqual(composed.preview.slice(0, 15), [
    'S:  Patient presents for recall appointment.  Chief complaint: ',
    '',
    'O:  Reviewed medical history with patient.  Same',
    '',
    // `Dr.` with nothing after it, exactly as their own blank template reads.
    'A:   STE:   HTE:   Polished, flossed, scaled as needed.  Dr. performed periodic exam.  ' +
      'Findings: ',
    '',
    // NOT "in 6 months". Nobody set an interval, so the note claims none.
    'P:  Return for Recall',
    '',
    'Perio: ',
    'Plaque: ',
    'Calculus: ',
    'Bleeding: ',
    'Stain: ',
    'Mallampati: ',
    'RTC: ',
  ]);

  // The words a default would have printed. None of them may appear.
  const text = composed.preview.join('\n');
  for (const invented of ['WNL', 'None', 'Good', 'Minimal', 'not recorded', 'N/A']) {
    assert.ok(
      !text.includes(invented),
      `an unfilled note printed "${invented}", which nobody said`
    );
  }
});

/** ACCEPTANCE 5 — the rows follow the visit type. */
test('a child type shows the behaviour scale and an adult one does not', () => {
  assert.ok(contract.controlsFor('child_prophy_np').includes('pedBehavior'));
  assert.ok(contract.controlsFor('child_prophy_recall').includes('pedBehavior'));
  assert.ok(!contract.controlsFor('adult_prophy_np').includes('pedBehavior'));
  assert.ok(!contract.controlsFor('adult_prophy_recall').includes('pedBehavior'));
});

test('Perio Maint shows Bone Loss and the perio chart line; the recall note does not', () => {
  assert.ok(contract.controlsFor('perio_maint').includes('boneLoss'));
  assert.ok(contract.hasPerioChartLine('perio_maint'));
  assert.ok(!contract.controlsFor('adult_prophy_recall').includes('boneLoss'));
  assert.ok(!contract.hasPerioChartLine('adult_prophy_recall'));
  // The new-patient adult note DOES ask for it. That is the practice's choice.
  assert.ok(contract.controlsFor('adult_prophy_np').includes('boneLoss'));
});

test('the perio chart line is never an unearned claim', () => {
  // Their template asserts "Perio chart updated" flatly. Perio charting is not
  // built (H4), so CareIN cannot know it happened — an unanswered one keeps the
  // label and the blank, exactly like every other unfilled hole.
  const unanswered = noteFor('perio_maint', {
    slip: { ...visit('perio_maint').slip, perioChartUpdated: null },
  });
  assert.ok(
    unanswered.preview.includes('Perio chart updated: '),
    unanswered.preview.join('\n')
  );

  const no = noteFor('perio_maint', {
    slip: { ...visit('perio_maint').slip, perioChartUpdated: 'no' },
  });
  assert.ok(no.preview.includes('Perio chart NOT updated'));
  assert.ok(!no.preview.includes('Perio chart updated'));
});

test('FL2TX only appears when fluoride was actually done', () => {
  const v = visit('child_prophy_recall');
  const without = composer.compose('note', {
    visit: { ...v, slip: { ...v.slip, doneToday: ['prophy'] } },
    items: [],
    actor: ACTOR,
    signature: SIGNATURE,
  });
  assert.ok(!without.preview.join('\n').includes('FL2TX'));
  assert.ok(without.preview.some((l) => l.includes('Polished, flossed, scaled as needed.')));
});

/** ACCEPTANCE 6 — the block is config, unsigned, and never invents a licence. */
test('the signature block comes from config, carries the licence, and stays unsigned', () => {
  const composed = noteFor('adult_prophy_recall');
  const text = composed.preview.join('\n');

  assert.ok(text.includes('Raegan McGee RDH #4251'), 'her licence line');
  assert.ok(text.includes('Beau Sparkman DDS #6347'), 'the supervising doctors');
  assert.ok(text.includes('Unsigned'));
  // The compliance rule this module is built on, restated for the new lines.
  assert.doesNotMatch(text, /(?<!un)\bsigned\b/i);
});

test('a hygienist the roster does not know gets her NAME and no invented licence', () => {
  const unknown = hygStaff.signatureBlock({
    office: 'roland',
    hygienistName: 'Temp Hygienist',
  });
  assert.equal(unknown[0], 'Temp Hygienist');
  assert.ok(!unknown[0].includes('#'), 'a licence number nobody has must not be printed');
  assert.ok(!unknown[0].includes('RDH'), 'a credential nobody claimed must not be printed');
  // And the doctors still appear: they are the office's, not hers.
  assert.ok(unknown.includes('Beau Sparkman DDS #6347'));
});

test('the composed note is still ASCII once a template has run', () => {
  const v = visit('perio_maint');
  const composed = composer.compose('note', {
    visit: {
      ...v,
      slip: {
        ...v.slip,
        patientConcerns: 'Cold sensitivity — upper right — “sharp”, she said…',
        noteFields: {
          ...v.slip.noteFields,
          plaque: { grades: ['Moderate'], detail: 'U ant · L post' },
        },
      },
    },
    items: [],
    actor: ACTOR,
    signature: SIGNATURE,
  });
  const everything = [composed.title, composed.summary, ...composed.preview, composed.payload.text]
    .join('\n');
  const offenders = [...everything].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code !== 10 && (code < 32 || code > 126);
  });
  assert.deepEqual([...new Set(offenders)], []);
});

test('THE PREVIEW IS THE WRITE still holds for a templated note', () => {
  const composed = noteFor('adult_prophy_np');
  assert.equal(composed.payload.text, composed.preview.join('\n'));
  assert.equal(composed.payload.isSigned, false);
  // Which template wrote it, stored beside the words it wrote.
  assert.equal(composed.payload.visitType, 'adult_prophy_np');
});

test('a visit with no type still composes the generic note, and says nothing about a template', () => {
  const bare = {
    visitId: 'visit-0003',
    office: 'roland',
    aptNum: 900003,
    patNum: 12827,
    visitDate: '2026-09-08',
    slip: { ...contract.emptySlip(), doneToday: ['prophy'] },
    items: [],
  };
  const composed = composer.compose('note', {
    visit: bare,
    items: [],
    actor: ACTOR,
    signature: SIGNATURE,
  });
  assert.ok(composed.preview.includes('Done today: Prophy'));
  assert.ok(!composed.preview.some((l) => l.startsWith('S:  Patient presents')));
  assert.equal(composed.payload.visitType, null);
  assert.match(composed.summary, /An unsigned note for 2026-09-08/);
});

test('the treatment block rides along after the template', () => {
  const composed = noteFor('adult_prophy_recall', {
    items: [
      {
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
      },
    ],
  });
  const at = composed.preview.indexOf('Treatment identified today (1):');
  assert.ok(at > 0, 'the treatment block is present');
  assert.equal(composed.preview[at - 1], '', 'and reads as its own section');
  assert.ok(composed.preview[at + 1].includes('#3'));
  // Still ends where a note must end.
  assert.match(composed.preview[composed.preview.length - 1], /Unsigned\.$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 4 — the auto-pick
// ─────────────────────────────────────────────────────────────────────────────

test('a clean appointment type label maps to a visit type', () => {
  const cases = [
    [{ apptTypeLabel: 'Adult Prophy RC', isNewPatient: false }, 'adult_prophy_recall'],
    [{ apptTypeLabel: 'Adult Prophy NP', isNewPatient: true }, 'adult_prophy_np'],
    [{ apptTypeLabel: 'Child Prophy Recall', isNewPatient: false }, 'child_prophy_recall'],
    [{ apptTypeLabel: 'Child Prophy NP', isNewPatient: true }, 'child_prophy_np'],
    [{ apptTypeLabel: 'Perio Maintenance', isNewPatient: false }, 'perio_maint'],
    [{ apptTypeLabel: 'Perio Maint 60', isNewPatient: null }, 'perio_maint'],
    [{ apptTypeLabel: 'PM', isNewPatient: null }, 'perio_maint'],
    // Separators are word boundaries: `ADULT-PROPHY-RC` is the same label.
    [{ apptTypeLabel: 'ADULT-PROPHY-RC', isNewPatient: null }, 'adult_prophy_recall'],
    // The label says child but not which visit; Open Dental's own flag decides.
    [{ apptTypeLabel: 'Child Prophy', isNewPatient: true }, 'child_prophy_np'],
    [{ apptTypeLabel: 'Child Prophy', isNewPatient: false }, 'child_prophy_recall'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      contract.suggestVisitType(input),
      expected,
      `"${input.apptTypeLabel}" (isNewPatient=${input.isNewPatient})`
    );
  }
});

test('an ambiguous label suggests NOTHING, and the hygienist picks', () => {
  const ambiguous = [
    // Neither adult nor child. "Prophy 60" is most of a real schedule.
    { apptTypeLabel: 'Prophy 60', isNewPatient: false },
    { apptTypeLabel: 'Prophy', isNewPatient: null },
    // Child AND adult in one label. Two answers is not an answer.
    { apptTypeLabel: 'Adult/Child Prophy', isNewPatient: false },
    // The label is silent about new-vs-recall AND so is Open Dental.
    { apptTypeLabel: 'Adult Prophy', isNewPatient: null },
    // Both, which is the front desk telling us two things.
    { apptTypeLabel: 'Adult NP Recall', isNewPatient: null },
    // Nothing at all.
    { apptTypeLabel: null, isNewPatient: true },
    { apptTypeLabel: '', isNewPatient: false },
    // Not a hygiene visit this slice models.
    { apptTypeLabel: 'SRP UR', isNewPatient: false },
    { apptTypeLabel: 'Crown Seat', isNewPatient: false },
  ];
  for (const input of ambiguous) {
    assert.equal(
      contract.suggestVisitType(input),
      null,
      `"${input.apptTypeLabel}" should have been left for the hygienist`
    );
  }
});

test('a suggestion is never a stored decision on its own', () => {
  // The stored slip is what composes. A suggestion that nobody accepted leaves
  // visitType null, and a null composes the generic note — never a template.
  const slip = contract.emptySlip();
  assert.equal(slip.visitType, null);
  assert.equal(slip.visitTypeSource, null);
});
