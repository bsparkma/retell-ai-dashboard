'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { sanitizeForOd } = require('./sanitizeForOd');

test('smart quotes → straight quotes', () => {
  assert.equal(sanitizeForOd('‘single’ and “double”'), "'single' and \"double\"");
});

test('em/en dash → ASCII dashes; ellipsis → ...', () => {
  assert.equal(sanitizeForOd('a — b'), 'a -- b');
  assert.equal(sanitizeForOd('a – b'), 'a - b');
  assert.equal(sanitizeForOd('wait…'), 'wait...');
});

test('exotic spaces → normal space; zero-width stripped', () => {
  assert.equal(sanitizeForOd('a b'), 'a b'); // nbsp
  assert.equal(sanitizeForOd('a​b'), 'ab'); // zero-width
});

test('idempotent + plain ASCII untouched', () => {
  const once = sanitizeForOd('quote ‘x’ — done…');
  assert.equal(sanitizeForOd(once), once);
  assert.equal(sanitizeForOd('plain ASCII - ok.'), 'plain ASCII - ok.');
});

test('non-string passes through', () => {
  assert.equal(sanitizeForOd(undefined), undefined);
  assert.equal(sanitizeForOd(null), null);
});
