'use strict';

/**
 * CO-3b — DEFAULTS ARE TODAY'S PRINTOUT, BYTE FOR BYTE.
 *
 * Beau's ruling: nothing shipped changes until an office manager opts in. Every
 * template before CO-3b has no styling (NULL), so its PDF must be exactly what
 * the CO-3 renderer printed. The SHA-256s in test/fixtures/printPdfPins.js were
 * taken from that renderer (origin/develop 2f228b7) before the layout engine
 * existed; this file holds the new renderer to them — with styling NULL,
 * absent, and spelled out as the defaults (the same state, stored as NULL).
 *
 * Plus the GEOMETRY of the default page, asserted independently of the hashes
 * so a failure says WHAT moved: the CO-3 constants (54 pt margins, the one-inch
 * logo top-left with the letterhead 14 pt beside it, the rule, the heading 34 pt
 * under it, 15 pt body leading, the 252 pt signature rule) and no colour, no
 * frame, no embedded font.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const contract = require('../tc/contract.gen.cjs');
const { renderPrintPdf } = require('../services/tc/printPdf');
const { prepareLogo } = require('../services/tc/printImage');
const { asciiSafe } = require('../services/hyg/slipPdf');
const { PINNED_DOCS, PINNED_SHA256 } = require('./fixtures/printPdfPins');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

for (const [name, entry] of Object.entries(PINNED_DOCS)) {
  test(`untouched "${name}" prints the pinned CO-3 bytes — styling null, absent, or the defaults spelled out`, () => {
    const logo = entry.logo ? prepareLogo(entry.logo()) : null;
    for (const styling of [null, undefined, { ...contract.PRINT_STYLING_DEFAULTS }, 'not an object']) {
      const pdf = renderPrintPdf(entry.doc(), styling === undefined ? { logo } : { logo, styling });
      assert.equal(sha(pdf), PINNED_SHA256[name], `${name} with styling ${JSON.stringify(styling)}`);
    }
  });
}

test('the default page geometry is CO-3\'s, op for op', () => {
  const logo = prepareLogo(PINNED_DOCS.excuse_wide_logo.logo());
  const doc = PINNED_DOCS.excuse_wide_logo.doc();
  const { pages, faces } = contract.layoutPrintDocument(doc, contract.PRINT_STYLING_DEFAULTS, { width: logo.width, height: logo.height });
  assert.deepEqual(faces, { heading: 'helvetica_bold', body: 'helvetica' });
  assert.equal(pages.length, 1);
  const ops = pages[0];
  const image = ops[0];
  assert.equal(image.kind, 'image');
  assert.equal(image.x, 54);
  assert.equal(image.w, 72, 'a wide logo fills the one-inch box across');
  assert.equal(image.y + image.h, 738);
  const letterhead = ops.filter((o) => o.kind === 'text' && o.role === 'letterhead');
  assert.deepEqual(letterhead.map((o) => [o.size, o.x]), [[14, 54 + 72 + 14], [10, 140], [10, 140], [10, 140]]);
  assert.equal(letterhead[0].y, 738 - 14);
  const rule = ops.find((o) => o.kind === 'rule' && o.role === 'letterhead');
  assert.deepEqual([rule.x1, rule.x2], [54, 558]);
  const heading = ops.find((o) => o.kind === 'text' && o.role === 'heading');
  assert.deepEqual([heading.size, heading.x, heading.y], [16, 54, rule.y - 34]);
  const body = ops.filter((o) => o.kind === 'text' && o.role === 'body');
  assert.equal(body[0].y, heading.y - 30);
  // body[1] and body[2] are the two rows of the wrapped second paragraph.
  assert.equal(body[1].y - body[2].y, 15, 'body leading within a paragraph');
  assert.equal(body[0].y - body[1].y, 15 + 8, 'leading plus the paragraph gap');
  assert.ok(body.every((o) => o.x === 54 && o.size === 11));
  const sig = ops.find((o) => o.kind === 'rule' && o.role === 'signature');
  assert.deepEqual([sig.x1, sig.x2], [54, 54 + 252]);
  assert.ok(ops.every((o) => o.kind !== 'frame' && (!('color' in o) || o.color === null)), 'no frame, no colour');
  // CO-3's character-count wrap: no body row over 88 characters.
  assert.ok(body.every((o) => o.text.length <= 88));
  const raw = renderPrintPdf(doc, { logo }).toString('latin1');
  assert.ok(!/ rg | RG |FontFile2| re S/.test(raw));
});

test("the shared transliteration is slipPdf's asciiSafe, character for character", () => {
  const sample = 'Plain ASCII ~ — – · ’ ‘ “ ” … ½   é ü 中 🙂 \t\n';
  assert.equal(contract.printableAscii(sample), asciiSafe(sample));
  for (let c = 0; c < 0x2200; c += 1) {
    const ch = String.fromCodePoint(c);
    assert.equal(contract.printableAscii(ch), asciiSafe(ch), `U+${c.toString(16)}`);
  }
});
