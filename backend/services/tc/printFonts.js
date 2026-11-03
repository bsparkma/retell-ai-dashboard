'use strict';

/**
 * The bundled print fonts (CO-3b), as things a hand-written PDF can embed.
 *
 * The files live in backend/assets/print-fonts, UNMODIFIED, with their SIL Open
 * Font License texts beside them. Nothing is fetched at run time.
 *
 * EMBEDDING, NOT INSTALLING. A printout embeds each face it uses as a simple
 * TrueType font (/FontFile2) with WinAnsi encoding, so it looks the same on
 * every machine and every PDF viewer. To keep a one-page letter small, the
 * embedded program is SUBSET: the outlines of glyphs the page does not use are
 * emptied (their loca entries become zero-length), so every glyph id — and the
 * font's own cmap — stays valid, and the tables a PDF renderer does not read
 * (OpenType layout, kerning, device metrics, signatures) are left out. The
 * OFL FAQ treats subsetting a font for embedding in a document as permitted
 * embedding, not as distributing a modified font; the bundled files themselves
 * are never altered.
 *
 * DETERMINISTIC: the same face and the same characters give the same bytes
 * (no timestamps; the subset tag is a hash of what was kept).
 *
 * The advance widths the layout engine measures with live in the shared
 * contract (PRINT_FONT_FACES[...].widths); test/printStylingFonts.test.js
 * re-derives them from these files so the two cannot drift.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const contract = require('../../tc/contract.gen.cjs');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'print-fonts');

/** Tables a PDF TrueType renderer needs (plus name, which carries the copyright and licence). */
const KEEP_TABLES = ['OS/2', 'cmap', 'cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post', 'prep'];

/** A file name on the allow-list, or null. Never a path from a request. */
function fontFileFor(name) {
  return contract.PRINT_FONT_FILES.includes(name) ? path.join(FONT_DIR, name) : null;
}

/** @param {Buffer} buf */
function tableDirectory(buf) {
  const numTables = buf.readUInt16BE(4);
  /** @type {Map<string, { offset: number, length: number }>} */
  const tables = new Map();
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    tables.set(buf.toString('latin1', rec, rec + 4), { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) });
  }
  return tables;
}

/** Unicode → glyph id from the (3,1) format-4 cmap subtable. */
function readCmap(buf, cmapOffset) {
  const count = buf.readUInt16BE(cmapOffset + 2);
  let sub = null;
  for (let i = 0; i < count; i += 1) {
    const rec = cmapOffset + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const offset = cmapOffset + buf.readUInt32BE(rec + 4);
    if (platform === 3 && encoding === 1 && buf.readUInt16BE(offset) === 4) sub = offset;
  }
  if (sub === null) throw new Error('print font has no (3,1) format-4 cmap');
  const segX2 = buf.readUInt16BE(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const rangeOffsets = deltas + segX2;
  /** @param {number} code */
  return (code) => {
    for (let s = 0; s < segX2; s += 2) {
      const end = buf.readUInt16BE(ends + s);
      if (code > end) continue;
      const start = buf.readUInt16BE(starts + s);
      if (code < start) return 0;
      const delta = buf.readInt16BE(deltas + s);
      const ro = buf.readUInt16BE(rangeOffsets + s);
      if (ro === 0) return (code + delta) & 0xffff;
      const g = buf.readUInt16BE(rangeOffsets + s + ro + (code - start) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
}

/** @type {Map<string, ReturnType<typeof parseFace>>} */
const cache = new Map();

/** Parse one bundled face (cached). @param {string} face a PRINT_FONT_FACES key with a file */
function loadFace(face) {
  if (!cache.has(face)) cache.set(face, parseFace(face));
  return cache.get(face);
}

function parseFace(face) {
  const meta = contract.PRINT_FONT_FACES[face];
  if (!meta || !meta.file) throw new Error(`not a bundled print font: ${face}`);
  const buf = fs.readFileSync(path.join(FONT_DIR, meta.file));
  const tables = tableDirectory(buf);
  const t = (tag) => {
    const rec = tables.get(tag);
    if (!rec) throw new Error(`print font ${meta.file} has no ${tag} table`);
    return rec;
  };
  const head = t('head').offset;
  const unitsPerEm = buf.readUInt16BE(head + 18);
  const bbox = [36, 38, 40, 42].map((o) => buf.readInt16BE(head + o));
  const longLoca = buf.readInt16BE(head + 50) === 1;
  const hhea = t('hhea').offset;
  const ascent = buf.readInt16BE(hhea + 4);
  const descent = buf.readInt16BE(hhea + 6);
  const numberOfHMetrics = buf.readUInt16BE(hhea + 34);
  const numGlyphs = buf.readUInt16BE(t('maxp').offset + 4);
  const os2 = tables.get('OS/2');
  const os2Version = os2 ? buf.readUInt16BE(os2.offset) : 0;
  const capHeight = os2 && os2Version >= 2 ? buf.readInt16BE(os2.offset + 88) : ascent;
  const weightClass = os2 ? buf.readUInt16BE(os2.offset + 4) : 400;
  const italicAngle = buf.readInt32BE(t('post').offset + 4) / 65536;
  const glyphOf = readCmap(buf, t('cmap').offset);
  const loca = t('loca').offset;
  const glyfStart = t('glyf').offset;
  const glyphRange = (g) => {
    const a = longLoca ? buf.readUInt32BE(loca + g * 4) : buf.readUInt16BE(loca + g * 2) * 2;
    const b = longLoca ? buf.readUInt32BE(loca + (g + 1) * 4) : buf.readUInt16BE(loca + (g + 1) * 2) * 2;
    return { start: glyfStart + a, end: glyfStart + b };
  };
  const hmtx = t('hmtx').offset;
  const advance = (g) => buf.readUInt16BE(hmtx + Math.min(g, numberOfHMetrics - 1) * 4);
  return { face, meta, buf, tables, unitsPerEm, bbox, ascent, descent, capHeight, weightClass, italicAngle, numGlyphs, glyphOf, glyphRange, advance };
}

/** Component glyph ids of a composite glyph (empty for a simple one). */
function components(f, g) {
  const { start, end } = f.glyphRange(g);
  if (end - start < 10 || f.buf.readInt16BE(start) >= 0) return [];
  const out = [];
  let p = start + 10;
  for (;;) {
    const flags = f.buf.readUInt16BE(p);
    out.push(f.buf.readUInt16BE(p + 2));
    p += 4 + (flags & 0x0001 ? 4 : 2);
    if (flags & 0x0008) p += 2;
    else if (flags & 0x0040) p += 4;
    else if (flags & 0x0080) p += 8;
    if (!(flags & 0x0020)) break;
  }
  return out;
}

function checksum(buf) {
  const padded = buf.length % 4 === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

/**
 * The face, subset to the characters a printout uses. Returns the TrueType
 * program and what the PDF's /FontDescriptor needs.
 *
 * @param {string} face
 * @param {string} text  every character drawn in this face (printable ASCII)
 */
function subsetFace(face, text) {
  const f = loadFace(face);
  const chars = Array.from(new Set(Array.from(text))).sort();
  /** @type {Set<number>} */
  const keep = new Set([0]);
  const stack = chars.map((c) => f.glyphOf(c.charCodeAt(0))).filter((g) => g > 0);
  while (stack.length > 0) {
    const g = stack.pop();
    if (keep.has(g) || g >= f.numGlyphs) continue;
    keep.add(g);
    stack.push(...components(f, g));
  }

  // glyf + a LONG loca with the same glyph ids; unused glyphs are zero-length.
  const glyfParts = [];
  const loca = Buffer.alloc((f.numGlyphs + 1) * 4);
  let at = 0;
  for (let g = 0; g < f.numGlyphs; g += 1) {
    loca.writeUInt32BE(at, g * 4);
    if (!keep.has(g)) continue;
    const { start, end } = f.glyphRange(g);
    let data = f.buf.subarray(start, end);
    if (data.length % 4 !== 0) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
    glyfParts.push(data);
    at += data.length;
  }
  loca.writeUInt32BE(at, f.numGlyphs * 4);

  const original = (tag) => {
    const rec = f.tables.get(tag);
    return rec ? Buffer.from(f.buf.subarray(rec.offset, rec.offset + rec.length)) : null;
  };
  const head = original('head');
  head.writeUInt32BE(0, 8); // checkSumAdjustment, set below
  head.writeInt16BE(1, 50); // indexToLocFormat: long
  const post = original('post').subarray(0, 32);
  post.writeUInt32BE(0x00030000, 0); // version 3: no glyph names

  /** @type {Array<[string, Buffer]>} */
  const out = [];
  for (const tag of KEEP_TABLES) {
    if (tag === 'glyf') out.push([tag, Buffer.concat(glyfParts)]);
    else if (tag === 'loca') out.push([tag, loca]);
    else if (tag === 'head') out.push([tag, head]);
    else if (tag === 'post') out.push([tag, post]);
    else {
      const data = original(tag);
      if (data) out.push([tag, data]);
    }
  }

  const n = out.length;
  const entrySelector = Math.floor(Math.log2(n));
  const searchRange = 2 ** entrySelector * 16;
  const header = Buffer.alloc(12 + n * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(n * 16 - searchRange, 10);
  let offset = header.length;
  const bodies = [];
  let headOffset = 0;
  out.forEach(([tag, data], i) => {
    const rec = 12 + i * 16;
    header.write(tag, rec, 4, 'latin1');
    header.writeUInt32BE(checksum(data), rec + 4);
    header.writeUInt32BE(offset, rec + 8);
    header.writeUInt32BE(data.length, rec + 12);
    if (tag === 'head') headOffset = offset;
    const padded = data.length % 4 === 0 ? data : Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
    bodies.push(padded);
    offset += padded.length;
  });
  const program = Buffer.concat([header, ...bodies]);
  program.writeUInt32BE((0xb1b0afba - checksum(program)) >>> 0, headOffset + 8);

  const scale = (v) => Math.round((v * 1000) / f.unitsPerEm);
  const tag = crypto
    .createHash('sha256')
    .update(`${face}:${chars.join('')}`)
    .digest()
    .subarray(0, 6)
    .reduce((s, b) => s + String.fromCharCode(65 + (b % 26)), '');
  return {
    program,
    baseFont: `${tag}+${f.meta.postscriptName}`,
    bbox: f.bbox.map(scale),
    ascent: scale(f.ascent),
    descent: scale(f.descent),
    capHeight: scale(f.capHeight),
    italicAngle: f.italicAngle,
    stemV: f.weightClass >= 600 ? 120 : 80,
  };
}

/**
 * The PDF objects for one embedded face: [font dict, descriptor, font file],
 * numbered from `first`. Widths are the shared contract's, so the PDF advances
 * exactly where the layout engine measured.
 *
 * @param {string} face @param {string} text @param {number} first
 * @returns {Buffer[]}
 */
function fontObjects(face, text, first) {
  const s = subsetFace(face, text);
  const str = (v) => Buffer.from(v, 'latin1');
  const widths = contract.PRINT_FONT_FACES[face].widths;
  const data = zlib.deflateSync(s.program, { level: 9 });
  return [
    str(
      `<< /Type /Font /Subtype /TrueType /BaseFont /${s.baseFont} /FirstChar 32 /LastChar 126 /Widths [${widths.join(' ')}] ` +
        `/Encoding /WinAnsiEncoding /FontDescriptor ${first + 1} 0 R >>`
    ),
    str(
      `<< /Type /FontDescriptor /FontName /${s.baseFont} /Flags 32 /FontBBox [${s.bbox.join(' ')}] /ItalicAngle ${s.italicAngle} ` +
        `/Ascent ${s.ascent} /Descent ${s.descent} /CapHeight ${s.capHeight} /StemV ${s.stemV} /FontFile2 ${first + 2} 0 R >>`
    ),
    Buffer.concat([str(`<< /Length ${data.length} /Length1 ${s.program.length} /Filter /FlateDecode >>\nstream\n`), data, str('\nendstream')]),
  ];
}

module.exports = { FONT_DIR, fontFileFor, loadFace, subsetFace, fontObjects };
