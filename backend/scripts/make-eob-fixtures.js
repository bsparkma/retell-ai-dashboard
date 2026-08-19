'use strict';

/**
 * Generator for the three EOB PDF fixtures in test/fixtures/rcm/eob/.
 *
 *     node backend/scripts/make-eob-fixtures.js
 *
 * Run it only to REGENERATE the fixtures. The tests read the committed PDFs and
 * never invoke this file — a test that generated its own inputs would be testing
 * this script rather than the code under test, and would need Chromium in CI.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ IT LIVES IN scripts/, NOT BESIDE THE FIXTURES, AND MUST STAY THERE
 * ─────────────────────────────────────────────────────────────────────────────
 * Node 22's test runner treats EVERY `.js` file under a directory named `test/`
 * as a test file. A bare `node --test` — which is exactly what CI runs — therefore
 * executed this script as though it were a suite: it succeeded silently, launched
 * Chromium, and REWROTE the committed fixtures on every test run. The degraded
 * page is blurred and rotated and so renders slightly differently each time, so
 * the corpus the tests assert against and the docs describe drifted underneath
 * them, with nothing failing to say so.
 *
 * Anything executable that is not a test belongs outside `test/`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO REAL SCAN, EVER
 * ─────────────────────────────────────────────────────────────────────────────
 * A real scanned EOB is a photograph of a document full of a real patient's name,
 * date of birth and subscriber id. There is no redaction that survives OCR — the
 * whole point of the fixture is that a machine can read the pixels. So the
 * scanned fixtures are MANUFACTURED from synthetic content, end to end, and the
 * content is the same invented EOB the ingestion doc uses for its staging walk.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW A "SCAN" IS MADE WITHOUT A SCANNER
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. The EOB is laid out as HTML in a monospace face — the same content, line
 *      for line, as the text-layer PDF beside it.
 *   2. Chromium (via the puppeteer this repo already depends on) RASTERISES it
 *      to a JPEG. This is a genuine rasterisation: real glyph rendering, real
 *      antialiasing, real JPEG artefacts. It is not a drawing of text.
 *   3. The JPEG is wrapped in a one-page PDF as a `/DCTDecode` image XObject.
 *      The JPEG bytes go in VERBATIM — PDF's DCTDecode filter *is* JPEG — so
 *      nothing here decodes or re-encodes an image, and there is no image
 *      library in the dependency tree.
 *
 * The result has NO text layer at all, which is the property under test:
 * `pdf-parse` finds nothing, and `eobDocumentText` escalates to OCR.
 *
 * The DEGRADED copy is the same page rendered pale grey on white at roughly a
 * third of the resolution, then JPEG-compressed hard. It is what a fax of a
 * photocopy of a fax looks like, and it exists so the "we could not read this"
 * path has an input that is genuinely unreadable rather than merely asserted to
 * be.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The fixtures themselves stay beside the corpus they belong to. */
const OUT_DIR = path.resolve(__dirname, '..', 'test', 'fixtures', 'rcm', 'eob');

/**
 * The EOB itself. Invented payer, invented people, invented money.
 *
 * `TESTPATIENT, ALPHA` and `SUB-0001` are deliberately unmistakable as
 * placeholders: a fixture whose names look plausible is a fixture somebody
 * eventually mistakes for a leak.
 */
const EOB_LINES = [
  'EXAMPLE DENTAL PLAN - EXPLANATION OF BENEFITS',
  '',
  'CHECK NUMBER: CHK-100200   CHECK DATE: 2026-08-10   PAYMENT: EFT',
  '',
  'PATIENT: TESTPATIENT, ALPHA   DOB: 1985-03-15   SUBSCRIBER ID: SUB-0001',
  'CLAIM: CLM-2026-1001   DATE OF SERVICE: 2026-07-21   NPI: 1598324220',
  'PROVIDER: EXAMPLE DENTAL   GROUP: GRP-4470',
  '',
  'CODE   DESCRIPTION                BILLED   ALLOWED     PAID   ADJ',
  'D0120  PERIODIC ORAL EVALUATION    59.00     57.00    57.00  CO-45  2.00',
  'D1110  PROPHYLAXIS - ADULT        108.00    106.00   106.00  CO-45  2.00',
  '',
  'CLAIM TOTALS:  BILLED 167.00   ALLOWED 163.00   DEDUCTIBLE 0.00   PAID 163.00',
  'PATIENT RESPONSIBILITY: 0.00',
  '',
  'CHECK TOTAL PAID: 163.00',
];

/** US Letter at 72 pt/inch — the PDF page size every fixture uses. */
const PAGE_WIDTH_PT = 612;
const PAGE_HEIGHT_PT = 792;

// ─── 1. The text-layer PDF ───────────────────────────────────────────────────

/**
 * A minimal, hand-assembled PDF with a real text layer.
 *
 * Deliberately the same generator the ingestion doc documents for the staging
 * walk, so the fixture and the walk are provably the same document.
 */
function textLayerPdf() {
  let y = 720;
  let content = '';
  for (const line of EOB_LINES) {
    // Parentheses and backslashes are PDF string syntax. None of the content
    // above contains them, but escaping them here means a future edit to
    // EOB_LINES cannot silently produce a corrupt PDF.
    const escaped = line.replace(/([\\()])/g, '\\$1');
    content += `BT /F1 10 Tf 40 ${y} Td (${escaped}) Tj ET\n`;
    y -= 18;
  }
  const pdf =
    '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PAGE_WIDTH_PT} ${PAGE_HEIGHT_PT}]` +
    '/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n' +
    '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
    `5 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n` +
    'trailer<</Root 1 0 R>>\n';
  return Buffer.from(pdf, 'latin1');
}

// ─── 2. HTML → JPEG (the rasterisation) ──────────────────────────────────────

/**
 * @param {{ degraded: boolean }} opts
 * @returns {string} a full HTML document sized to a Letter page
 */
function eobHtml({ degraded }) {
  const ink = degraded ? '#b4b4b4' : '#111111';
  const paper = degraded ? '#f2f2f0' : '#ffffff';
  // A slight rotation and blur on the degraded copy: a page fed through a fax is
  // never square to the glass, and skew is a large part of why a bad scan is
  // hard to read. Kept small enough that the page still fits its own box.
  const skew = degraded ? 'transform: rotate(-0.7deg); filter: blur(0.6px);' : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: ${paper}; }
  pre {
    margin: 0; padding: 40px;
    font-family: "Courier New", Courier, monospace;
    font-size: 13px; line-height: 1.5;
    color: ${ink}; background: ${paper};
    white-space: pre;
    ${skew}
  }
</style></head>
<body><pre>${EOB_LINES.join('\n')}</pre></body></html>`;
}

/**
 * Rasterise one page to JPEG.
 *
 * `scale` stands in for scanner resolution: 2 is roughly 150 dpi against a
 * 72 pt/inch page, 0.7 is roughly 50 dpi — below what any OCR engine can be
 * expected to read, which is the point of the degraded fixture.
 *
 * @param {{ degraded: boolean, scale: number, quality: number }} opts
 * @returns {Promise<Buffer>}
 */
async function rasterise({ degraded, scale, quality }) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: PAGE_WIDTH_PT,
      height: PAGE_HEIGHT_PT,
      deviceScaleFactor: scale,
    });
    await page.setContent(eobHtml({ degraded }), { waitUntil: 'load' });
    const shot = await page.screenshot({ type: 'jpeg', quality, fullPage: false });
    return Buffer.from(shot);
  } finally {
    await browser.close();
  }
}

// ─── 3. JPEG → one-page PDF ──────────────────────────────────────────────────

/**
 * Pixel dimensions of a JPEG, from its Start-Of-Frame marker.
 *
 * Walks the marker chain rather than guessing an offset. SOF0/1/2/9/10 are the
 * baseline and progressive frames Chromium can emit; the two-byte length after
 * each marker is what makes the walk possible.
 *
 * @param {Buffer} jpeg
 * @returns {{ width: number, height: number, components: number }}
 */
function jpegSize(jpeg) {
  let i = 2; // skip SOI
  while (i < jpeg.length) {
    if (jpeg[i] !== 0xff) throw new Error(`not a JPEG marker at offset ${i}`);
    const marker = jpeg[i + 1];
    const length = jpeg.readUInt16BE(i + 2);
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return {
        height: jpeg.readUInt16BE(i + 5),
        width: jpeg.readUInt16BE(i + 7),
        components: jpeg[i + 9],
      };
    }
    i += 2 + length;
  }
  throw new Error('no SOF marker in JPEG');
}

/**
 * Wrap a JPEG in a one-page PDF, with a proper xref table.
 *
 * The JPEG bytes are the stream, unmodified — `/DCTDecode` IS the JPEG decoder,
 * so nothing is decoded, re-encoded or lost. That is what makes this a "scan"
 * rather than a re-drawing.
 *
 * There is NO text layer, no font, and no content beyond a `Do` on the image.
 * `pdf-parse` therefore extracts an empty string, which is the exact condition
 * `eobDocumentText` escalates to OCR on.
 *
 * @param {Buffer} jpeg
 * @returns {Buffer}
 */
function jpegToPdf(jpeg) {
  const { width, height, components } = jpegSize(jpeg);
  const colorSpace = components === 1 ? '/DeviceGray' : '/DeviceRGB';
  // Draw the image to fill the page. `cm` sets the transform; the image's own
  // unit square is then scaled to the full MediaBox.
  const content = `q ${PAGE_WIDTH_PT} 0 0 ${PAGE_HEIGHT_PT} 0 0 cm /Im0 Do Q\n`;

  /** @type {Buffer[]} */
  const parts = [];
  /** @type {number[]} */
  const offsets = [];
  let position = 0;
  const push = (buf) => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1');
    parts.push(b);
    position += b.length;
  };
  const startObject = () => offsets.push(position);

  push('%PDF-1.4\n');

  startObject();
  push('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n');

  startObject();
  push('2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n');

  startObject();
  push(
    '3 0 obj\n<</Type/Page/Parent 2 0 R' +
      `/MediaBox[0 0 ${PAGE_WIDTH_PT} ${PAGE_HEIGHT_PT}]` +
      '/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>\nendobj\n'
  );

  startObject();
  push(
    '4 0 obj\n<</Type/XObject/Subtype/Image' +
      `/Width ${width}/Height ${height}/ColorSpace ${colorSpace}` +
      `/BitsPerComponent 8/Filter/DCTDecode/Length ${jpeg.length}>>\nstream\n`
  );
  push(jpeg);
  push('\nendstream\nendobj\n');

  startObject();
  push(`5 0 obj\n<</Length ${content.length}>>\nstream\n${content}endstream\nendobj\n`);

  const xrefAt = position;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<</Size ${offsets.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return Buffer.concat(parts);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const write = (name, buf) => {
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    console.log(`wrote ${name} (${buf.length.toLocaleString()} bytes)`);
  };

  write('Test_EOB_TextLayer.pdf', textLayerPdf());

  const clean = await rasterise({ degraded: false, scale: 2, quality: 85 });
  write('Test_EOB_Scanned.pdf', jpegToPdf(clean));

  const degraded = await rasterise({ degraded: true, scale: 0.7, quality: 25 });
  write('Test_EOB_Scanned_Degraded.pdf', jpegToPdf(degraded));

  // Prove the property the fixtures exist for, here rather than in a comment.
  const { PDFParse } = require('pdf-parse');
  for (const name of [
    'Test_EOB_TextLayer.pdf',
    'Test_EOB_Scanned.pdf',
    'Test_EOB_Scanned_Degraded.pdf',
  ]) {
    const parser = new PDFParse({ data: fs.readFileSync(path.join(OUT_DIR, name)) });
    const parsed = await parser.getText();
    await parser.destroy();
    console.log(`  ${name}: text layer = ${(parsed.text || '').trim().length} chars`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { textLayerPdf, jpegToPdf, jpegSize, EOB_LINES };
