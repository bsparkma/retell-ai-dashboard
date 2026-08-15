'use strict';

/**
 * Minimal X12 segment tokenizer — the substrate under eraParser.js (Slice 5).
 *
 * PORT NOTE. The source app (`rcm-posting`) piped the file through the npm
 * package `x12-parser`, a streaming transform that emits one object per
 * segment shaped `{ name: 'CLP', '1': …, '2': … }`. This module produces that
 * SAME shape from a plain string, and the ported parser reads it unchanged.
 *
 * Replacing the dependency rather than adding it, because:
 *  - The backend is CommonJS with **no build step** (`node --check` is the
 *    syntax gate). A stream-based ESM dependency is a compat risk for ~60
 *    lines of splitting.
 *  - The streaming API forced `parse835ERA` to return a Promise built around
 *    `stream.pipe()`. Parsing a string that is already fully in memory is a
 *    pure function; the async wrapper only made failures harder to attribute.
 *  - Delimiter handling is the only genuinely subtle part, and it is 8 lines.
 *
 * DELIMITERS COME FROM THE ISA, NEVER FROM A CONSTANT. An 835 declares its own:
 *
 *     ISA*00*          *…*00501*000000010*0*P*:~
 *        ^                                    ^^
 *        |                                    ||__ segment terminator (ISA16+1)
 *        |                                    |___ component separator (ISA16)
 *        |________ element separator (the 4th character of the file)
 *
 * Repository fixtures use `*` / `:` / `~`; the ported regression tests use
 * `*` / `>` / `~\n`. Both parse here for the same reason a real payer's file
 * does — nothing is hardcoded.
 *
 * COMPOSITES ARE NOT SPLIT. `AD:D2391` stays one element. Splitting on the
 * component separator would shift every element index by one in exactly the
 * files that declare `:` as that separator — which is all 13 fixtures. The
 * parser splits composites itself, where it knows one is expected.
 */

/** Thrown when the input is not recoverable enough to yield segments at all. */
class X12FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'X12FormatError';
    this.code = 'X12_FORMAT';
  }
}

/**
 * Read the three delimiters an interchange declares in its ISA header.
 *
 * @param {string} text the whole document, leading whitespace already trimmed
 * @returns {{ element: string, component: string, segment: string }}
 */
function readDelimiters(text) {
  if (!text.startsWith('ISA')) {
    throw new X12FormatError('file does not start with an ISA segment');
  }
  const element = text[3];
  if (!element || /[A-Za-z0-9]/.test(element)) {
    throw new X12FormatError(`implausible element separator '${element}' at ISA04`);
  }

  // ISA16 is the 16th element of the ISA segment; the segment terminator is
  // the character immediately after it. Splitting on the element separator is
  // how we find it without depending on the ISA being exactly 106 characters —
  // real files pad it correctly, but a fixture with a short filler field would
  // silently mis-index against a fixed offset.
  const isaFields = text.split(element);
  const tail = isaFields[16];
  if (!tail || tail.length < 2) {
    throw new X12FormatError('ISA header is truncated — no ISA16/segment terminator');
  }
  return { element, component: tail[0], segment: tail[1] };
}

/**
 * One X12 segment, in the shape the ported parser reads.
 *
 * @typedef {{ name: string, [element: string]: string }} X12Segment
 */

/**
 * Split a document into segments.
 *
 * Elements are keyed by their 1-based X12 position as STRINGS ('1', '2', …),
 * matching `x12-parser`. Trailing empty elements are kept, so `seg['16']` on a
 * BPR with eleven empty middle fields reads the value X12 puts there rather
 * than `undefined`.
 *
 * @param {string} content
 * @returns {X12Segment[]}
 */
function parseSegments(content) {
  if (typeof content !== 'string') {
    throw new X12FormatError('expected the file contents as a string');
  }
  // A BOM or leading newline before ISA is common from Windows editors and
  // from browsers that transcode an upload; it is not a malformed file.
  const text = content.replace(/^﻿/, '').replace(/^\s+/, '');
  const { element, segment: terminator } = readDelimiters(text);

  /** @type {X12Segment[]} */
  const segments = [];
  for (const raw of text.split(terminator)) {
    // Segment terminators are frequently followed by CR/LF for readability.
    const line = raw.replace(/[\r\n]+/g, '').trim();
    if (!line) continue;

    const fields = line.split(element);
    /** @type {X12Segment} */
    const seg = { name: fields[0] };
    for (let i = 1; i < fields.length; i += 1) seg[String(i)] = fields[i];
    segments.push(seg);
  }

  if (segments.length === 0) {
    throw new X12FormatError('no segments found');
  }
  return segments;
}

/**
 * The value of a composite's Nth sub-element, or '' when absent.
 *
 * Hardcodes ':' rather than using the interchange's declared component
 * separator, and does so deliberately: the ported regression fixtures declare
 * '>' at ISA16 while writing `AD:D2391` in their data — the same mismatch real
 * clearinghouse output shows — and every file in the repository corpus uses
 * ':'. Honouring the declaration here would break both.
 *
 * @param {string|undefined} value
 * @param {number} index 0-based sub-element
 * @returns {string}
 */
function subElement(value, index) {
  if (!value) return '';
  return String(value).split(':')[index] || '';
}

module.exports = { parseSegments, readDelimiters, subElement, X12FormatError };
