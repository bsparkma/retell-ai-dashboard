'use strict';

/**
 * WHO SIGNS THE NOTE, AND WHOSE DOCTORS APPEAR UNDER IT.
 *
 * Two rules, and both are the same class of defect as writing Roland's CommLog
 * DefNum into Riley's database:
 *
 *   1. AN OFFICE NEVER GETS ANOTHER OFFICE'S DOCTORS. An unknown office gets an
 *      EMPTY list, never a fallback — a note naming the wrong practice's
 *      clinicians is worse than one naming none.
 *   2. A LICENCE NUMBER IS NEVER INVENTED. A name the roster does not know
 *      prints alone. A licence is a claim about somebody's registration, and
 *      the honest answer to "we do not have hers" is to say less.
 *
 * These are the practice's own staff, from their own signature auto notes.
 * There is no PHI in this file and there must never be.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const hygStaff = require('./hygStaff');
const { useSyntheticStaff } = require('./hygStaff.fixture');

// No real staff in tests (Practice staff page): every test that names a person
// names the synthetic roster. The few that check the SHIPPED lists' shape run
// inside `shipped()` and assert structure only — they name nobody.
useSyntheticStaff();

/** Run `fn` against the shipped config lists, then restore the synthetic roster. */
function shipped(fn) {
  hygStaff.setRosterForTests(null);
  try {
    fn();
  } finally {
    useSyntheticStaff();
  }
}

test('each office answers with its OWN doctors, and an unknown one with none', () => {
  shipped(() => {
    for (const office of ['roland', 'valley']) {
      const doctors = hygStaff.supervisingDoctors(office);
      assert.ok(doctors.length > 0, `${office} has no supervising doctors`);
      for (const d of doctors) {
        assert.ok(d.name && d.credential && d.license, `${office}: an incomplete doctor entry`);
      }
    }
  });

  // NOT roland's, and not a default. The `unknown` bucket has no Open Dental
  // database, so it has no note to sign either.
  assert.deepEqual(hygStaff.supervisingDoctors('unknown'), []);
  assert.deepEqual(hygStaff.supervisingDoctors(''), []);
  assert.deepEqual(hygStaff.doctorOptions('not-an-office'), []);
});

test('the doctor pick-list is the same people the block prints', () => {
  // The form offers names and the note prints lines built from the same
  // entries. Two lists would eventually name two different sets of doctors.
  for (const office of ['roland', 'valley']) {
    const options = hygStaff.doctorOptions(office);
    // RULING (feedback round 1): the block prints only the examining doctor(s)
    // the slip picked, so pick every offered name to compare the two lists.
    const block = hygStaff.signatureBlock({ office, hygienistName: null, examiningDoctors: options });
    assert.equal(options.length, block.length);
    for (let i = 0; i < options.length; i += 1) {
      assert.ok(
        block[i].startsWith(options[i]),
        `${office}: "${block[i]}" does not begin with the offered name "${options[i]}"`
      );
    }
  }
});

test('a hygienist the roster knows gets her credential and licence', () => {
  const block = hygStaff.signatureBlock({ office: 'roland', hygienistName: 'Avery Example' });
  assert.equal(block[0], 'Avery Example RDH #9101');
});

test('the roster is matched on the name, not on its spacing or case', () => {
  const messy = hygStaff.signatureBlock({
    office: 'roland',
    hygienistName: '  avery   EXAMPLE ',
  });
  // And her OWN spelling comes back, not what she typed.
  assert.equal(messy[0], 'Avery Example RDH #9101');
});

test('a hygienist the roster does not know is named, and nothing is invented', () => {
  const block = hygStaff.signatureBlock({ office: 'valley', hygienistName: 'Temp Hygienist' });
  assert.equal(block[0], 'Temp Hygienist');
  assert.ok(!block[0].includes('#'));
  assert.ok(!block[0].includes('RDH'));
  // RULING (feedback round 1): no examining doctor picked, so no doctor line.
  assert.equal(block.length, 1);
});

// RULING (feedback round 1): the block no longer lists the office's doctors by
// default, so "nobody at all" is an EMPTY block — and still never a blank line.
test('no hygienist and no examining doctor is an empty block, never a blank line', () => {
  const block = hygStaff.signatureBlock({ office: 'roland', hygienistName: null });
  assert.deepEqual(block, []);
  const picked = hygStaff.signatureBlock({ office: 'roland', hygienistName: null, examiningDoctors: [''] });
  assert.deepEqual(picked, [], 'an empty pick is no pick');
});

/**
 * ONE PERSON, ONE LINE — the 2026-09-09 staging walk.
 *
 * A doctor wrote the note and appeared TWICE in the block: once as the bare
 * name the session gave, and again three lines down with his credential and
 * licence. Two lines for one person, one of them worse than the other, in a
 * chart note.
 */
test('an author who is also a supervising doctor is printed ONCE, with the licence', () => {
  // RULING (feedback round 1): the doctors printed are the slip's examining
  // pick. The author examined, with one colleague; the third doctor did not.
  const block = hygStaff.signatureBlock({
    office: 'roland',
    hygienistName: 'Drew Example',
    examiningDoctors: ['Drew Example', 'Morgan Example'],
  });

  // The better line wins: name, credential and licence, not the bare name.
  assert.equal(block[0], 'Drew Example DDS #9001');
  // And exactly once, anywhere in the block.
  assert.equal(
    block.filter((l) => l.includes('Drew Example')).length,
    1,
    'the author is named twice: ' + JSON.stringify(block)
  );
  // The other examining doctor is still there. Deduplicating one person must
  // not quietly drop someone else who examined.
  assert.ok(block.includes('Morgan Example DDS #9002'));
  // RULING (feedback round 1): a doctor who did not examine is not printed.
  assert.ok(!block.some((l) => l.includes('Quinn Example')));
  assert.equal(block.length, 2);
});

test('the author match is case- and spacing-insensitive, like the roster', () => {
  // What a session actually hands over is not guaranteed to match the config's
  // spelling character for character.
  for (const typed of ['drew example', 'DREW EXAMPLE', '  Drew   Example ']) {
    const block = hygStaff.signatureBlock({ office: 'valley', hygienistName: typed });
    assert.equal(block[0], 'Drew Example DDS #9001', typed);
    assert.equal(block.filter((l) => l.includes('Drew Example')).length, 1, typed);
  }
});

// RULING (feedback round 1): was "every doctor still appears". Now the
// examining doctor appears, and only them.
test('a HYGIENIST author is followed by the examining doctor, and only that doctor', () => {
  const block = hygStaff.signatureBlock({
    office: 'roland',
    hygienistName: 'Avery Example',
    examiningDoctors: ['Quinn Example'],
  });
  assert.deepEqual(block, ['Avery Example RDH #9101', 'Quinn Example DDS #9003']);
});

test('an author nobody knows is still named once, and gains nothing', () => {
  const block = hygStaff.signatureBlock({ office: 'roland', hygienistName: 'Temp Hygienist' });
  assert.equal(block[0], 'Temp Hygienist');
  // RULING (feedback round 1): no examining doctor picked, so no doctor lines.
  assert.equal(block.length, 1);
});

// ── Feedback round 1 ────────────────────────────────────────────────────────

test('A1: only the doctor the slip picked is printed; nobody picked prints none', () => {
  for (const office of ['roland', 'valley']) {
    const one = hygStaff.signatureBlock({ office, hygienistName: 'Temp Hygienist', examiningDoctors: ['Morgan Example'] });
    assert.deepEqual(one, ['Temp Hygienist', 'Morgan Example DDS #9002'], office);
    const none = hygStaff.signatureBlock({ office, hygienistName: 'Temp Hygienist', examiningDoctors: [] });
    assert.deepEqual(none, ['Temp Hygienist'], office);
  }
});

test('A1: a pick is matched to THIS office, case-insensitively, and printed once', () => {
  const block = hygStaff.signatureBlock({
    office: 'valley',
    hygienistName: null,
    examiningDoctors: ['  morgan  example ', 'Morgan Example'],
  });
  assert.deepEqual(block, ['Morgan Example DDS #9002']);
  // A picked name this office does not list is printed as the name alone —
  // never another office's licence, never an invented one.
  const stranger = hygStaff.signatureBlock({ office: 'roland', hygienistName: null, examiningDoctors: ['Visiting Doctor'] });
  assert.deepEqual(stranger, ['Visiting Doctor']);
  const unknownOffice = hygStaff.signatureBlock({ office: 'unknown', hygienistName: null, examiningDoctors: ['Drew Example'] });
  assert.ok(!unknownOffice.join(' ').includes('#'), 'an office with no doctors lends no licence');
});

/** A synthetic roster: no real staff in this round's own tests. */
const ROSTER = [
  { fullName: 'Sample Hygienist', credential: 'RDH', license: '0000', signIn: ['Sample', 'sample.hyg@carein.ai'] },
  { fullName: 'Pending Hygienist', credential: 'RDH', license: null, signIn: ['pending.hyg@carein.ai'] },
  { fullName: 'Blank Licence', credential: 'RDH', license: '   ', signIn: [] },
];

test('A3: the hygienist prints as her FULL name and licence, matched by sign-in name or email', () => {
  const byShortName = hygStaff.signatureBlock({ office: 'roland', hygienistName: 'Sample', roster: ROSTER });
  assert.equal(byShortName[0], 'Sample Hygienist RDH #0000');
  const byEmail = hygStaff.signatureBlock({
    office: 'roland',
    hygienistName: 'S. H.',
    hygienistEmail: 'Sample.Hyg@carein.ai',
    roster: ROSTER,
  });
  assert.equal(byEmail[0], 'Sample Hygienist RDH #0000');
});

test('A3: a missing licence prints the full name ONLY — never a placeholder or a number', () => {
  for (const [name, email, expected] of [
    [null, 'pending.hyg@carein.ai', 'Pending Hygienist'],
    ['Blank Licence', null, 'Blank Licence'],
  ]) {
    const block = hygStaff.signatureBlock({ office: 'roland', hygienistName: name, hygienistEmail: email, roster: ROSTER });
    assert.equal(block[0], expected);
    assert.doesNotMatch(block[0], /#|RDH|TBD|XXXX|0000/);
  }
});

test('A3: the shipped roster has a full name on every entry, and any licence is digits', () => {
  for (const h of hygStaff.HYGIENISTS) {
    assert.ok(h.fullName && h.fullName.includes(' '), 'a full name, not a first name');
    assert.ok(h.license === null || /^\d+$/.test(h.license), `${h.fullName}: a licence is digits or null`);
  }
});

test('no name appears twice in any block this file can produce', () => {
  shipped(() => {
    // The general form of the rule, across every author the config knows about.
    const authors = [
      null,
      'Temp Hygienist',
      ...Object.values(hygStaff.HYGIENIST_ROSTER).map((h) => h.name),
      ...hygStaff.doctorOptions('roland'),
      ...hygStaff.doctorOptions('valley'),
    ];
    for (const office of ['roland', 'valley']) {
      for (const author of authors) {
        // Every doctor picked too, so the dedupe is exercised against all of them.
        const block = hygStaff.signatureBlock({
          office,
          hygienistName: author,
          examiningDoctors: hygStaff.doctorOptions(office),
        });
        // The NAME half of each line, so `Drew Example` and
        // `Drew Example DDS #9001` are recognised as one person.
        const names = block.map((l) =>
          hygStaff.normalizeName(l.replace(/\s+(?:RDH|DDS)\b.*$/, ''))
        );
        assert.equal(
          new Set(names).size,
          names.length,
          `${office} / ${author}: a name is repeated — ${JSON.stringify(block)}`
        );
      }
    }
  });
});

test('nothing this file produces claims a signature', () => {
  // The typed name block stands in for a signature and is not one. B1, locked.
  for (const office of ['roland', 'valley']) {
    const text = hygStaff.signatureBlock({ office, hygienistName: 'Avery Example' }).join('\n');
    assert.doesNotMatch(text, /\bsigned\b/i);
  }
});

test('the registries are frozen, so nothing can edit them at runtime', () => {
  shipped(() => {
    assert.ok(Object.isFrozen(hygStaff.SUPERVISING_DOCTORS));
    assert.ok(Object.isFrozen(hygStaff.HYGIENIST_ROSTER));
    assert.ok(Object.isFrozen(hygStaff.SUPERVISING_DOCTORS.roland));
    // And the list a caller gets is the frozen one, not a mutable copy that a
    // caller could push another practice's doctor onto.
    assert.ok(Object.isFrozen(hygStaff.supervisingDoctors('roland')));
  });
});
