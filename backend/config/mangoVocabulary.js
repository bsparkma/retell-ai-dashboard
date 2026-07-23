'use strict';

/**
 * Known office vocabulary + deterministic spelling corrections (day-1 item 3).
 *
 * Transcripts/summaries were mis-hearing "Roland" as "Rowland" and mangling staff
 * names. Three layers use the constants below — structured as CONFIG so a future
 * office-admin UI edits the same source:
 *
 *   (a) callAnalyzer injects KNOWN_VOCABULARY into the summary prompt (use exact
 *       spellings in the output).
 *   (b) applyCorrections() deterministically fixes transcript + summary TEXT.
 *   (c) transcriptionService passes KNOWN_VOCABULARY as an Azure Speech `phraseList`
 *       so the ENGINE biases toward these words (the best fix — needs API 2025-10-15).
 */

// Exact spellings the LLM should use and the phrase list should bias toward:
// offices/brand + the front-desk staff who answer calls.
const KNOWN_VOCABULARY = Object.freeze([
  // Offices / brand
  'Roland', 'Riley', 'Valley Family Dental',
  // Front-desk staff (answer inbound calls)
  'Sam', 'Holly', 'Krishana', 'Aarionna', 'Jen', 'Hayley',
]);

// Deterministic corrections applied to transcript + summary text (layer b). Matched
// case-insensitively as WHOLE WORDS; the replacement casing is used verbatim.
//
// SAFETY: this is a destructive whole-word rewrite that also runs over caller/patient
// speech. We therefore seed ONLY the office-name mis-hearings, which don't collide with
// real names. Staff first-name mis-hearings (e.g. "Arianna"→"Aarionna") are LEFT OUT on
// purpose: those variants are common PATIENT names, and rewriting a patient's name in a
// chart note is worse than a mangled staff name. Staff-name accuracy is handled by the
// phrase list (c) + prompt vocabulary (a), which bias without destructive rewriting.
// Add entries here only for tokens proven safe (won't hit a real name) as they surface.
const CORRECTION_MAP = Object.freeze({
  Rowland: 'Roland',
  Rolland: 'Roland',
  Roeland: 'Roland',
  Rowlands: 'Roland',
});

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Case-insensitive key → replacement lookup + one combined word-boundary pattern.
const _lookup = new Map(Object.keys(CORRECTION_MAP).map((k) => [k.toLowerCase(), CORRECTION_MAP[k]]));
const _keys = Object.keys(CORRECTION_MAP).sort((a, b) => b.length - a.length).map(escapeRegExp);
const _pattern = _keys.length ? new RegExp(`\\b(${_keys.join('|')})\\b`, 'gi') : null;

/**
 * Apply the deterministic correction map to a string. Non-strings pass through
 * unchanged. Idempotent for the seeded office-name fixes.
 * @param {*} text
 * @returns {*}
 */
function applyCorrections(text) {
  if (typeof text !== 'string' || !_pattern) return text;
  return text.replace(_pattern, (m) => _lookup.get(m.toLowerCase()) ?? m);
}

module.exports = { KNOWN_VOCABULARY, CORRECTION_MAP, applyCorrections };
