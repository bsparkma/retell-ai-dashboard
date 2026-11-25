'use strict';

/**
 * EL-2 carry-forward from the EL-1 review: the email library's free-text
 * validator refuses the invisible Unicode bidi and format controls with the
 * SAME code as every other control character (EMAIL_LIBRARY_TEXT_FORBIDDEN_CHARACTER),
 * and the https link check refuses them too. They print nothing but can
 * reorder or hide what a patient reads around them.
 *
 *   U+200B–U+200F  zero-width space / non-joiner / joiner, LRM, RLM
 *   U+202A–U+202E  LRE, RLE, PDF, LRO, RLO
 *   U+2066–U+2069  LRI, RLI, FSI, PDI
 *   U+FEFF         BOM / zero-width no-break space
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const contract = require('../tc/contract.gen.cjs');

const RANGES = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const CODEPOINTS = RANGES.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));

test('every bidi / format control in a text answer is refused with the control-character code', () => {
  assert.equal(CODEPOINTS.length, 15);
  for (const cp of CODEPOINTS) {
    const ch = String.fromCharCode(cp);
    // Inside the text: refused, always.
    const v = contract.validateEmailLibraryAnswers({ doctor_name: `Dr.${ch} Sample` });
    assert.equal(v.ok, false, `U+${cp.toString(16).toUpperCase()} accepted`);
    assert.equal(v.code, contract.EMAIL_LIBRARY_ANSWER_CODES.TEXT_FORBIDDEN_CHARACTER);
    assert.equal(v.key, 'doctor_name');
    // At either end: refused, or (U+FEFF only, which String#trim treats as
    // whitespace) trimmed away by the validator's normalizing — either way it
    // is never STORED.
    for (const value of [`${ch}Dr. Sample`, `Dr. Sample${ch}`]) {
      const edge = contract.validateEmailLibraryAnswers({ doctor_name: value });
      if (edge.ok) {
        assert.equal(cp, 0xfeff, `U+${cp.toString(16).toUpperCase()} accepted at an edge`);
        assert.equal(edge.answers.doctor_name, 'Dr. Sample');
      } else {
        assert.equal(edge.code, contract.EMAIL_LIBRARY_ANSWER_CODES.TEXT_FORBIDDEN_CHARACTER);
      }
    }
    // The schema agrees with the validator (it is what a stored row re-validates through).
    assert.equal(contract.EmailLibraryAnswers.safeParse({ amenities: `Wi${ch}Fi` }).success, false);
    // And a link may not hide one either.
    assert.equal(contract.isHttpsLink(`https://book.example.test/a${ch}b`), false);
  }
});

test('the neighbours of those ranges are still allowed (nothing over-refused)', () => {
  for (const cp of [0x200a, 0x2010, 0x2030, 0x202f, 0x2065, 0x206a, 0xfefe, 0xe9]) {
    const v = contract.validateEmailLibraryAnswers({ amenities: `Coffee ${String.fromCharCode(cp)} bar` });
    assert.equal(v.ok, true, `U+${cp.toString(16).toUpperCase()} refused: ${JSON.stringify(v)}`);
  }
  // Ordinary accented text, the everyday case.
  assert.equal(contract.validateEmailLibraryAnswers({ doctor_name: 'Dr. Renée Sample' }).ok, true);
});
