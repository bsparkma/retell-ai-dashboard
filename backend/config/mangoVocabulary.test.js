'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { KNOWN_VOCABULARY, applyCorrections } = require('./mangoVocabulary');

test('applyCorrections fixes the office-name mis-hearing (whole word, any case)', () => {
  assert.equal(applyCorrections('I called Rowland Family Dental'), 'I called Roland Family Dental');
  assert.equal(applyCorrections('rowland'), 'Roland');
  assert.equal(applyCorrections('ROWLAND office'), 'Roland office');
  assert.equal(applyCorrections('Rolland and Roeland'), 'Roland and Roland');
});

test('applyCorrections is a no-op on already-correct text and idempotent', () => {
  const s = 'Roland Family Dental, ask for Sam';
  assert.equal(applyCorrections(s), s);
  assert.equal(applyCorrections(applyCorrections('Rowland')), 'Roland');
});

test('applyCorrections does NOT touch substrings or unrelated real names', () => {
  // Word-boundary: no partial-word rewrites; common patient names are untouched
  // (we deliberately do NOT map staff first-name mis-hearings — collision risk).
  assert.equal(applyCorrections('Arianna Ariana Christina'), 'Arianna Ariana Christina');
  assert.equal(applyCorrections('Rowlandia'), 'Rowlandia'); // substring, not a whole word
});

test('applyCorrections passes non-strings through', () => {
  assert.equal(applyCorrections(null), null);
  assert.equal(applyCorrections(42), 42);
});

test('KNOWN_VOCABULARY includes offices/brand + staff', () => {
  for (const w of ['Roland', 'Riley', 'Valley Family Dental', 'Sam', 'Krishana', 'Aarionna']) {
    assert.ok(KNOWN_VOCABULARY.includes(w), `${w} in vocabulary`);
  }
});
