'use strict';

/**
 * The routing slip as a PDF — hand-rolled, deterministic, no dependency.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY NOT A LIBRARY
 * ═════════════════════════════════════════════════════════════════════════════
 * This repo has `pdf-parse` (it READS PDFs, for RCM's OCR rail) and nothing that
 * writes one. Adding pdfkit or jsPDF to the backend would put a new package on
 * the path that files documents into a patient's chart, and buy layout features
 * a routing slip does not use: the slip is a title, a date line and a list of
 * short text lines that the server already composed.
 *
 * So this writes the PDF directly. It is about a hundred lines of a
 * thirty-year-old file format, it has no transitive dependencies, and — the
 * property that matters most here — it is DETERMINISTIC: the same lines produce
 * byte-identical output. That is what lets slice 3 say "the preview IS the
 * write" about the PDF and not only about the text, because the bytes are a
 * pure function of the preview a hygienist read.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT SUPPORTS, AND WHAT IT DELIBERATELY DOES NOT
 * ═════════════════════════════════════════════════════════════════════════════
 * Helvetica, one size, US Letter, automatic page breaks, and WinAnsi-safe text.
 * No images, no tables, no wrapping beyond a hard character split, no fonts to
 * embed. If the slip ever needs any of those, that is the moment to take the
 * dependency — not before.
 *
 * NON-ASCII IS TRANSLITERATED, NOT DROPPED. The composer emits en dashes and
 * middots (`—`, `·`), and a PDF using the base WinAnsi encoding cannot carry
 * arbitrary Unicode without an embedded font. Silently dropping them would take
 * "#3 · Crown · Urgent" down to "#3 Crown Urgent" — still readable — but
 * silently dropping a character in a document that goes into a chart is exactly
 * the habit this codebase does not have. So they are mapped to ASCII
 * equivalents, and anything unmapped becomes '?' rather than vanishing.
 */

/** Points. US Letter, and margins wide enough to survive a printer. */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const BODY_SIZE = 10;
const TITLE_SIZE = 16;
const LINE_HEIGHT = 14;
/** Characters per line before a hard split. Helvetica 10pt in 504pt of width. */
const MAX_CHARS = 95;

/**
 * Unicode the composer actually emits → its WinAnsi-safe equivalent.
 * Anything else non-ASCII becomes '?', which is visible rather than silent.
 */
const TRANSLITERATE = new Map([
  ['—', '-'], // em dash
  ['–', '-'], // en dash
  ['·', '-'], // middot
  ['’', "'"],
  ['‘', "'"],
  ['“', '"'],
  ['”', '"'],
  ['…', '...'],
  ['½', '1/2'],
  [' ', ' '],
]);

/**
 * A string as bytes a PDF text object can carry.
 * @param {string} value
 * @returns {string}
 */
function asciiSafe(value) {
  let out = '';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code <= 126) {
      out += ch;
      continue;
    }
    const mapped = TRANSLITERATE.get(ch);
    out += mapped !== undefined ? mapped : '?';
  }
  return out;
}

/** PDF string escaping: backslash, and both parens. */
function pdfEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Break one composed line into rendered lines, keeping the composer's leading
 * indent on the continuations so a wrapped treatment item still reads as one.
 * @param {string} line
 * @returns {string[]}
 */
function wrap(line) {
  const safe = asciiSafe(line);
  if (safe.length <= MAX_CHARS) return [safe];
  const indent = (safe.match(/^\s*/) || [''])[0];
  const out = [];
  let rest = safe;
  let first = true;
  while (rest.length > 0) {
    const width = first ? MAX_CHARS : MAX_CHARS - indent.length;
    if (rest.length <= width) {
      out.push((first ? '' : indent) + rest);
      break;
    }
    // Break on the last space inside the budget; a long unbroken token is cut
    // rather than pushed off the page.
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= indent.length) cut = width;
    out.push((first ? '' : indent) + rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
    first = false;
  }
  return out;
}

/**
 * Render a routing slip.
 *
 * @param {{ title: string, subtitle: string, lines: string[] }} slip
 * @returns {Buffer} the PDF, deterministic for the same input
 */
function renderSlipPdf({ title, subtitle, lines }) {
  /** @type {string[][]} pages of already-wrapped lines */
  const pages = [];
  let page = [];
  // The title and subtitle occupy the first two rows of page one.
  let rowsLeft = Math.floor((PAGE_HEIGHT - MARGIN * 2 - TITLE_SIZE - LINE_HEIGHT * 2) / LINE_HEIGHT);

  for (const line of lines) {
    for (const rendered of wrap(line)) {
      if (rowsLeft === 0) {
        pages.push(page);
        page = [];
        rowsLeft = Math.floor((PAGE_HEIGHT - MARGIN * 2) / LINE_HEIGHT);
      }
      page.push(rendered);
      rowsLeft -= 1;
    }
  }
  pages.push(page);

  /** Content stream for one page. */
  const contentFor = (rows, isFirst) => {
    let y = PAGE_HEIGHT - MARGIN;
    const ops = ['BT'];
    if (isFirst) {
      ops.push(`/F1 ${TITLE_SIZE} Tf`);
      ops.push(`1 0 0 1 ${MARGIN} ${y} Tm`);
      ops.push(`(${pdfEscape(asciiSafe(title))}) Tj`);
      y -= LINE_HEIGHT * 1.6;
      ops.push(`/F1 ${BODY_SIZE} Tf`);
      ops.push(`1 0 0 1 ${MARGIN} ${y} Tm`);
      ops.push(`(${pdfEscape(asciiSafe(subtitle))}) Tj`);
      y -= LINE_HEIGHT * 1.4;
    } else {
      ops.push(`/F1 ${BODY_SIZE} Tf`);
    }
    for (const row of rows) {
      ops.push(`1 0 0 1 ${MARGIN} ${y} Tm`);
      ops.push(`(${pdfEscape(row)}) Tj`);
      y -= LINE_HEIGHT;
    }
    ops.push('ET');
    return ops.join('\n');
  };

  // ── objects ───────────────────────────────────────────────────────────────
  // 1 catalog, 2 pages, 3 font, then per page: a Page and its Contents.
  const objects = [];
  const pageObjNums = pages.map((_, i) => 4 + i * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] =
    `<< /Type /Pages /Count ${pages.length} /Kids [` +
    pageObjNums.map((n) => `${n} 0 R`).join(' ') +
    '] >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  pages.forEach((rows, i) => {
    const pageNum = pageObjNums[i];
    const contentNum = pageNum + 1;
    const stream = contentFor(rows, i === 0);
    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    objects[contentNum] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  // ── assembly, with a real xref table ──────────────────────────────────────
  // No /Info dictionary and no /ID: both conventionally carry a timestamp, and
  // a timestamp would make the bytes differ between the preview and the send.
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let n = 1; n < objects.length; n += 1) {
    if (!objects[n]) continue;
    offsets[n] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  const count = objects.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n += 1) {
    const offset = offsets[n] ?? 0;
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

module.exports = { renderSlipPdf, asciiSafe, wrap };
