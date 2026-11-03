'use strict';

/**
 * CO-3b — the bundled print fonts.
 *
 *   licence    every bundled face is an UNMODIFIED file with its SIL Open Font
 *              License beside it, permits embedding (OS/2 fsType 0), and the
 *              directory holds nothing the contract does not list
 *   metrics    the advance widths the layout engine measures with (shared
 *              contract) are re-derived here from the files themselves, so the
 *              preview, the wrap and the PDF's /Widths cannot drift from the
 *              glyphs that are drawn
 *   subset     the embedded program is a valid TrueType font: same glyph ids,
 *              the used glyphs' outlines intact (composites with their
 *              components), unused outlines empty, checksums right; and the
 *              same text gives the same bytes
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const contract = require('../tc/contract.gen.cjs');
const { FONT_DIR, loadFace, subsetFace } = require('../services/tc/printFonts');

const BUNDLED = Object.entries(contract.PRINT_FONT_FACES).filter(([, f]) => f.file !== null);

/** The SHA-256 of each file as fetched from github.com/google/fonts (ofl/…), 2026-11-02. */
const UPSTREAM_SHA256 = {
  'Lato-Regular.ttf': 'd636e4683231f931eda222d588e944d082bfd3bdba02f928bee461c0f185b251',
  'Lato-Bold.ttf': '8a0aace75d33794eece4b28187bfc1df0bbd2888b5d8a56e01788c8d65d16be1',
  'PT_Serif-Web-Regular.ttf': 'a4951fade06ff8f09b7673aa81ffb65a8cd409e24d3289a6dc670bc4dda2557a',
  'PT_Serif-Web-Bold.ttf': '038ba7336bd7ea14f12ad155bed51a4345cac5153275d521dec3ba04021c526e',
  'PT_Sans-Web-Regular.ttf': '9cc831490532009bae2b3ce0d39c62adfc889060beb421593bfd9d2396d0f10a',
  'CrimsonText-Regular.ttf': '48e6c5d5ad1d01599d374ecb817e15890d1feb3b8a3a88e527d44c90389e1f06',
  'CrimsonText-Bold.ttf': 'a3a0765fc5e8d0b49b540a23aefe0184887dd79f06a0bdf4db7035cea6befa93',
};
const LICENCE_FOR = {
  'Lato-Regular.ttf': 'OFL-Lato.txt',
  'Lato-Bold.ttf': 'OFL-Lato.txt',
  'PT_Serif-Web-Regular.ttf': 'OFL-PTSerif.txt',
  'PT_Serif-Web-Bold.ttf': 'OFL-PTSerif.txt',
  'PT_Sans-Web-Regular.ttf': 'OFL-PTSans.txt',
  'CrimsonText-Regular.ttf': 'OFL-CrimsonText.txt',
  'CrimsonText-Bold.ttf': 'OFL-CrimsonText.txt',
};

function tables(buf) {
  const out = new Map();
  for (let i = 0; i < buf.readUInt16BE(4); i += 1) {
    const r = 12 + i * 16;
    out.set(buf.toString('latin1', r, r + 4), { checksum: buf.readUInt32BE(r + 4), offset: buf.readUInt32BE(r + 8), length: buf.readUInt32BE(r + 12) });
  }
  return out;
}
function sum(buf) {
  const padded = buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf;
  let s = 0;
  for (let i = 0; i < padded.length; i += 4) s = (s + padded.readUInt32BE(i)) >>> 0;
  return s;
}

test('every bundled face is the unmodified upstream file, with its OFL beside it, and permits embedding', () => {
  const listed = new Set(contract.PRINT_FONT_FILES);
  assert.deepEqual([...listed].sort(), Object.keys(UPSTREAM_SHA256).sort());
  for (const file of fs.readdirSync(FONT_DIR)) {
    if (file.endsWith('.ttf')) assert.ok(listed.has(file), `${file} is bundled but not on the contract's list`);
    else assert.match(file, /^OFL-[A-Za-z]+\.txt$/, `unexpected file ${file}`);
  }
  for (const [file, digest] of Object.entries(UPSTREAM_SHA256)) {
    const buf = fs.readFileSync(path.join(FONT_DIR, file));
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), digest, `${file} differs from the upstream file`);
    const os2 = tables(buf).get('OS/2');
    assert.equal(buf.readUInt16BE(os2.offset + 8), 0, `${file}: fsType must allow embedding`);
    const licence = fs.readFileSync(path.join(FONT_DIR, LICENCE_FOR[file]), 'utf8');
    assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/, file);
  }
});

test("the layout engine's widths are the files' own advance widths, for every printable character", () => {
  for (const [face, meta] of BUNDLED) {
    const f = loadFace(face);
    for (let c = 32; c <= 126; c += 1) {
      const gid = f.glyphOf(c);
      assert.ok(gid > 0, `${face}: no glyph for ${String.fromCharCode(c)}`);
      assert.equal(meta.widths[c - 32], Math.round((f.advance(gid) * 1000) / f.unitsPerEm), `${face}: width of "${String.fromCharCode(c)}"`);
    }
  }
});

test("each face's PostScript name is the file's own (name table id 6)", () => {
  for (const [face, meta] of BUNDLED) {
    const f = loadFace(face);
    const name = tables(f.buf).get('name');
    const base = name.offset;
    const count = f.buf.readUInt16BE(base + 2);
    const strings = base + f.buf.readUInt16BE(base + 4);
    const found = [];
    for (let i = 0; i < count; i += 1) {
      const r = base + 6 + i * 12;
      if (f.buf.readUInt16BE(r + 6) !== 6) continue;
      const platform = f.buf.readUInt16BE(r);
      const len = f.buf.readUInt16BE(r + 8);
      const off = strings + f.buf.readUInt16BE(r + 10);
      const raw = f.buf.subarray(off, off + len);
      found.push(platform === 3 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1'));
    }
    assert.ok(found.includes(meta.postscriptName), `${face}: ${found.join(', ')}`);
  }
});

test('a subset is a valid TrueType program: same glyph ids, used outlines intact, the rest empty, checksums right, deterministic', () => {
  const text = 'Synthetic Roland Dental (555) 010-0001 Ag&?';
  for (const [face] of BUNDLED) {
    const f = loadFace(face);
    const { program } = subsetFace(face, text);
    assert.ok(program.length < f.buf.length, face);
    const t = tables(program);
    for (const tag of ['cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'post']) assert.ok(t.has(tag), `${face}: ${tag}`);
    for (const tag of ['GPOS', 'GSUB', 'kern', 'DSIG']) assert.ok(!t.has(tag), `${face}: ${tag} is dropped`);
    for (const [tag, rec] of t) {
      if (tag === 'head') continue;
      assert.equal(sum(program.subarray(rec.offset, rec.offset + rec.length)), rec.checksum, `${face}: ${tag} checksum`);
    }
    assert.equal(sum(program), 0xb1b0afba, `${face}: whole-font checksum adjustment`);
    const head = t.get('head').offset;
    assert.equal(program.readInt16BE(head + 50), 1, 'long loca');
    assert.equal(program.readUInt16BE(t.get('maxp').offset + 4), f.numGlyphs, `${face}: glyph ids unchanged`);
    const loca = t.get('loca').offset;
    const glyphLen = (g) => program.readUInt32BE(loca + (g + 1) * 4) - program.readUInt32BE(loca + g * 4);
    for (const ch of new Set(text)) {
      const g = f.glyphOf(ch.charCodeAt(0));
      const { start, end } = f.glyphRange(g);
      const expected = end - start;
      assert.ok(glyphLen(g) >= expected && glyphLen(g) - expected < 4, `${face}: "${ch}" outline kept`);
    }
    const unused = f.glyphOf('Z'.charCodeAt(0));
    assert.equal(glyphLen(unused), 0, `${face}: "Z" is not used and is emptied`);
    assert.ok(subsetFace(face, text).program.equals(program), `${face}: deterministic`);
  }
});
