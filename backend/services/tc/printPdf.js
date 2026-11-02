'use strict';

/**
 * A print template's PDF (CO-3) — the school/work excuse and the appointment
 * card, drawn from `composePrintDocument` (shared/tc/printTemplates.ts), the
 * same composition the Settings page previews.
 *
 * services/hyg/slipPdf.js's approach, extended only as far as a letter needs:
 * written directly (no PDF library on the path), DETERMINISTIC (no /Info, no
 * /ID, no timestamp — the same document is the same bytes), WinAnsi text with
 * the slip's transliteration (asciiSafe), plus what a letter has that a slip
 * does not: a bold face, a rule under the letterhead, a signature line, and an
 * optional logo (services/tc/printImage.js prepares it).
 *
 * US Letter, one column. A body longer than a page continues on the next.
 */

const { asciiSafe, pdfEscape } = require('../hyg/slipPdf');

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const RIGHT = PAGE_WIDTH - MARGIN;

const NAME_SIZE = 14;
const SMALL_SIZE = 10;
const HEADING_SIZE = 16;
const BODY_SIZE = 11;
const BODY_LEADING = 15;
/** Characters per body line before a word wrap: Helvetica 11pt in 504pt. */
const BODY_CHARS = 88;
const LOGO_BOX = 72;

/**
 * Word-wrap one line to `width` characters (a long unbroken token is cut).
 * @param {string} line @param {number} width @returns {string[]}
 */
function wrapTo(line, width) {
  const safe = asciiSafe(line);
  if (safe.length <= width) return [safe];
  const out = [];
  let rest = safe;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** A text-showing op at an absolute position. */
function text(font, size, x, y, value) {
  return `BT /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfEscape(asciiSafe(value))}) Tj ET`;
}

/** A thin horizontal rule. */
function rule(x1, x2, y) {
  return `0.6 w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S`;
}

/**
 * Render a composed printout.
 *
 * @param {import('../../tc/contract.gen.cjs').PrintDocument} doc
 * @param {{ logo?: ReturnType<typeof import('./printImage').prepareLogo> | null }} [opts]
 * @returns {Buffer} the PDF, deterministic for the same input
 */
function renderPrintPdf(doc, { logo = null } = {}) {
  /** @type {string[][]} one op list per page */
  const pages = [[]];
  let ops = pages[0];
  let y = PAGE_HEIGHT - MARGIN;

  // ── letterhead ──────────────────────────────────────────────────────────
  let textX = MARGIN;
  let blockBottom = y;
  if (logo) {
    const scale = Math.min(LOGO_BOX / logo.width, LOGO_BOX / logo.height);
    const w = logo.width * scale;
    const h = logo.height * scale;
    ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${MARGIN} ${(y - h).toFixed(2)} cm /Im1 Do Q`);
    textX = MARGIN + w + 14;
    blockBottom = y - h;
  }
  // Wrapped to the width left beside the logo, so a long line cannot run off the page.
  const room = RIGHT - textX;
  let ty = y - NAME_SIZE;
  if (doc.letterhead.name) {
    for (const row of wrapTo(doc.letterhead.name, Math.floor(room / (NAME_SIZE * 0.6)))) {
      ops.push(text('F2', NAME_SIZE, textX, ty, row));
      ty -= NAME_SIZE + 2;
    }
    ty += NAME_SIZE + 2 - (SMALL_SIZE + 6);
  }
  for (const line of [...doc.letterhead.addressLines, doc.letterhead.phone].filter(Boolean)) {
    for (const row of wrapTo(line, Math.floor(room / (SMALL_SIZE * 0.5)))) {
      ops.push(text('F1', SMALL_SIZE, textX, ty, row));
      ty -= SMALL_SIZE + 3;
    }
  }
  blockBottom = Math.min(blockBottom, ty + SMALL_SIZE);
  y = blockBottom - 10;
  ops.push(rule(MARGIN, RIGHT, y));
  y -= 34;

  // ── heading ─────────────────────────────────────────────────────────────
  if (doc.heading) {
    ops.push(text('F2', HEADING_SIZE, MARGIN, y, doc.heading));
    y -= 30;
  }

  // ── body ────────────────────────────────────────────────────────────────
  const newPage = () => {
    ops = [];
    pages.push(ops);
    y = PAGE_HEIGHT - MARGIN - BODY_SIZE;
  };
  for (const para of doc.paragraphs) {
    for (const line of para) {
      const rows = line.trim() === '' ? [''] : wrapTo(line, BODY_CHARS);
      for (const row of rows) {
        if (y < MARGIN + BODY_SIZE) newPage();
        if (row) ops.push(text('F1', BODY_SIZE, MARGIN, y, row));
        y -= BODY_LEADING;
      }
    }
    y -= 8;
  }

  // ── signature line ──────────────────────────────────────────────────────
  if (doc.signatureLine) {
    if (y < MARGIN + 60) newPage();
    y -= 36;
    ops.push(rule(MARGIN, MARGIN + 252, y));
    y -= 14;
    for (const row of wrapTo(doc.signatureLine, 60)) {
      ops.push(text('F1', SMALL_SIZE, MARGIN, y, row));
      y -= SMALL_SIZE + 3;
    }
  }

  // ── objects ─────────────────────────────────────────────────────────────
  // 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 logo, 6 its mask,
  // then a Page and its Contents per page.
  /** @type {Array<Buffer|null>} */
  const objects = [];
  const firstPage = 7;
  const pageNums = pages.map((_, i) => firstPage + i * 2);
  const str = (s) => Buffer.from(s, 'latin1');
  const streamObj = (dict, data) =>
    Buffer.concat([str(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, str('\nendstream')]);

  objects[1] = str('<< /Type /Catalog /Pages 2 0 R >>');
  objects[2] = str(`<< /Type /Pages /Count ${pages.length} /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] >>`);
  objects[3] = str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects[4] = str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  if (logo) {
    objects[5] = streamObj(`/Type /XObject /Subtype /Image ${logo.dict}${logo.smask ? ' /SMask 6 0 R' : ''}`, logo.data);
    if (logo.smask) objects[6] = streamObj(`/Type /XObject /Subtype /Image ${logo.smask.dict}`, logo.smask.data);
  }
  const resources = `/Font << /F1 3 0 R /F2 4 0 R >>${logo ? ' /XObject << /Im1 5 0 R >>' : ''}`;
  pages.forEach((pageOps, i) => {
    const n = pageNums[i];
    objects[n] = str(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << ${resources} >> /Contents ${n + 1} 0 R >>`
    );
    objects[n + 1] = streamObj('', str(pageOps.join('\n')));
  });

  // ── assembly, with a real xref table ────────────────────────────────────
  const chunks = [str('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let length = chunks[0].length;
  const offsets = [];
  for (let n = 1; n < objects.length; n += 1) {
    const body = objects[n];
    if (!body) continue;
    offsets[n] = length;
    const piece = Buffer.concat([str(`${n} 0 obj\n`), body, str('\nendobj\n')]);
    chunks.push(piece);
    length += piece.length;
  }
  const count = objects.length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n += 1) {
    // Unused numbers (no logo) are free entries, not offsets.
    xref += offsets[n] === undefined ? '0000000000 65535 f \n' : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(str(xref));
  return Buffer.concat(chunks);
}

module.exports = { renderPrintPdf, wrapTo };
