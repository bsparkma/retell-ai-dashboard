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

test('each office answers with its OWN doctors, and an unknown one with none', () => {
  for (const office of ['roland', 'valley']) {
    const doctors = hygStaff.supervisingDoctors(office);
    assert.ok(doctors.length > 0, `${office} has no supervising doctors`);
    for (const d of doctors) {
      assert.ok(d.name && d.credential && d.license, `${office}: an incomplete doctor entry`);
    }
  }

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
    const block = hygStaff.signatureBlock({ office, hygienistName: null });
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
  const block = hygStaff.signatureBlock({ office: 'roland', hygienistName: 'Raegan McGee' });
  assert.equal(block[0], 'Raegan McGee RDH #4251');
});

test('the roster is matched on the name, not on its spacing or case', () => {
  const messy = hygStaff.signatureBlock({
    office: 'roland',
    hygienistName: '  raegan   MCGEE ',
  });
  // And her OWN spelling comes back, not what she typed.
  assert.equal(messy[0], 'Raegan McGee RDH #4251');
});

test('a hygienist the roster does not know is named, and nothing is invented', () => {
  const block = hygStaff.signatureBlock({ office: 'valley', hygienistName: 'Temp Hygienist' });
  assert.equal(block[0], 'Temp Hygienist');
  assert.ok(!block[0].includes('#'));
  assert.ok(!block[0].includes('RDH'));
  // The office's doctors still appear: they are the office's, not hers.
  assert.equal(block.length, hygStaff.doctorOptions('valley').length + 1);
});

test('no hygienist at all still names the office, and never a blank line', () => {
  const block = hygStaff.signatureBlock({ office: 'roland', hygienistName: null });
  assert.equal(block.length, hygStaff.doctorOptions('roland').length);
  for (const line of block) assert.ok(line.trim().length > 0);
});

test('nothing this file produces claims a signature', () => {
  // The typed name block stands in for a signature and is not one. B1, locked.
  for (const office of ['roland', 'valley']) {
    const text = hygStaff.signatureBlock({ office, hygienistName: 'Raegan McGee' }).join('\n');
    assert.doesNotMatch(text, /\bsigned\b/i);
  }
});

test('the registries are frozen, so nothing can edit them at runtime', () => {
  assert.ok(Object.isFrozen(hygStaff.SUPERVISING_DOCTORS));
  assert.ok(Object.isFrozen(hygStaff.HYGIENIST_ROSTER));
  assert.ok(Object.isFrozen(hygStaff.SUPERVISING_DOCTORS.roland));
  // And the list a caller gets is the frozen one, not a mutable copy that a
  // caller could push another practice's doctor onto.
  assert.ok(Object.isFrozen(hygStaff.supervisingDoctors('roland')));
});
