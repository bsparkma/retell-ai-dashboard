'use strict';

/**
 * Normalize typographic (non-ASCII) punctuation to OD-safe ASCII before a note is
 * written to Open Dental. Smart quotes, em/en dashes, ellipses, and exotic spaces
 * copied out of Word/browsers otherwise land as mojibake in OD (the em-dash ->
 * replacement-char problem). Idempotent — applying twice is a no-op.
 *
 * Deliberately does NOT touch the note's intentional box-drawing/emoji formatting,
 * only the punctuation that mojibakes.
 *
 * @param {string} text
 * @returns {string}
 */
const REPLACEMENTS = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", // single quotes
  '′': "'",                                              // prime
  '“': '"', '”': '"', '„': '"', '‟': '"', // double quotes
  '″': '"',                                              // double prime
  '«': '"', '»': '"',                               // guillemets
  '–': '-', '—': '--', '―': '--',              // en / em dash, horizontal bar
  '…': '...',                                            // ellipsis
  '•': '-', '·': '-',                               // bullet, middle dot
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', // nbsp / figure / thin / narrow-nbsp
  '​': '',                                               // zero-width space
};

const PATTERN = /[‘’‚‛′“”„‟″«»–—―…•·    ​]/g;

function sanitizeForOd(text) {
  if (typeof text !== 'string') return text;
  return text.replace(PATTERN, (ch) => (ch in REPLACEMENTS ? REPLACEMENTS[ch] : ch));
}

module.exports = { sanitizeForOd };
