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
 *
 * CO-3b — STYLING. WHERE things go is decided by the shared layout engine
 * (`layoutPrintDocument`, shared/tc/printStyling.ts), which the Settings
 * preview draws from too; this file only SERIALISES its operations. With no
 * styling saved the engine reproduces CO-3's arithmetic exactly and every op is
 * written as CO-3 wrote it — no colour operators, the base-14 Helvetica pair,
 * the same object numbers — so an untouched template's PDF is byte-identical
 * to before (test/printStylingDefaults.test.js pins the hashes). An accent
 * colour wraps only the letterhead text and the rule under it in `q … Q`; a
 * bundled font pair is embedded, subset (services/tc/printFonts.js).
 */

const { asciiSafe, pdfEscape } = require('../hyg/slipPdf');
const contract = require('../../tc/contract.gen.cjs');
const { fontObjects } = require('./printFonts');

const PAGE_WIDTH = contract.PRINT_PAGE.width;
const PAGE_HEIGHT = contract.PRINT_PAGE.height;

/** CO-3's number format: two decimals, except a whole number stays as written (the logo's x was `54`). */
function num(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** `#rrggbb` → "r g b" in 0..1. */
function rgb(hex) {
  return [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
}

/** One engine op → its content-stream text. */
function opText(op) {
  switch (op.kind) {
    case 'text': {
      const font = op.slot === 'heading' ? 'F2' : 'F1';
      const t = `BT /${font} ${op.size} Tf 1 0 0 1 ${op.x.toFixed(2)} ${op.y.toFixed(2)} Tm (${pdfEscape(asciiSafe(op.text))}) Tj ET`;
      return op.color ? `q ${rgb(op.color)} rg ${t} Q` : t;
    }
    case 'rule': {
      const r = `0.6 w ${op.x1.toFixed(2)} ${op.y.toFixed(2)} m ${op.x2.toFixed(2)} ${op.y.toFixed(2)} l S`;
      return op.color ? `q ${rgb(op.color)} RG ${r} Q` : r;
    }
    case 'image':
      return `q ${op.w.toFixed(2)} 0 0 ${op.h.toFixed(2)} ${num(op.x)} ${op.y.toFixed(2)} cm /Im1 Do Q`;
    case 'frame':
      return `q 0.55 G 0.8 w ${num(op.x)} ${num(op.y)} ${num(op.w)} ${num(op.h)} re S Q`;
    default:
      throw new Error(`unknown print op ${op && op.kind}`);
  }
}

/**
 * Render a composed printout.
 *
 * @param {import('../../tc/contract.gen.cjs').PrintDocument} doc
 * @param {{ logo?: ReturnType<typeof import('./printImage').prepareLogo> | null, styling?: unknown }} [opts]
 *   styling: the STORED value — null/absent is the defaults, today's printout
 * @returns {Buffer} the PDF, deterministic for the same input
 */
function renderPrintPdf(doc, { logo = null, styling = null } = {}) {
  const layout = contract.layoutPrintDocument(
    doc,
    contract.effectivePrintStyling(styling),
    logo ? { width: logo.width, height: logo.height } : null
  );
  const pages = layout.pages.map((ops) => ops.map(opText));
  const embedded = contract.PRINT_FONT_FACES[layout.faces.body].file !== null;

  // ── objects ─────────────────────────────────────────────────────────────
  // 1 catalog, 2 pages, 3 the body font (/F1), 4 the heading font (/F2),
  // 5 logo, 6 its mask, then a Page and its Contents per page, then — for a
  // bundled pair only — each face's descriptor and font file.
  /** @type {Array<Buffer|null>} */
  const objects = [];
  const firstPage = 7;
  const pageNums = pages.map((_, i) => firstPage + i * 2);
  const str = (s) => Buffer.from(s, 'latin1');
  const streamObj = (dict, data) =>
    Buffer.concat([str(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, str('\nendstream')]);

  objects[1] = str('<< /Type /Catalog /Pages 2 0 R >>');
  objects[2] = str(`<< /Type /Pages /Count ${pages.length} /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] >>`);
  if (!embedded) {
    objects[3] = str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objects[4] = str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  }
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
  if (embedded) {
    // Each face subset to exactly the characters it draws.
    const drawn = { body: '', heading: '' };
    for (const ops of layout.pages) for (const op of ops) if (op.kind === 'text') drawn[op.slot] += asciiSafe(op.text);
    let next = firstPage + pages.length * 2;
    for (const [slot, at] of [['body', 3], ['heading', 4]]) {
      const [font, descriptor, file] = fontObjects(layout.faces[slot], drawn[slot], next - 1);
      objects[at] = font;
      objects[next] = descriptor;
      objects[next + 1] = file;
      next += 2;
    }
  }

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

module.exports = { renderPrintPdf, opText };
