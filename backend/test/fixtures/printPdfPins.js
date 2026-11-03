'use strict';

/**
 * CO-3b — the documents whose PDF bytes are PINNED (test/printStylingDefaults.test.js).
 *
 * Their SHA-256s were taken from the CO-3 renderer (origin/develop 2f228b7)
 * BEFORE styling existed. An untouched template must keep printing exactly
 * those bytes, so nothing shipped changes until an office manager opts in.
 *
 * Synthetic letterhead and sample values only — never a patient.
 */

const zlib = require('node:zlib');
const contract = require('../../tc/contract.gen.cjs');

const LETTERHEAD = { name: 'Synthetic Roland Dental', address: '1 Example Way\nRoland, OK 74954', phone: '(555) 010-0001' };

/** A real RGBA PNG of the given size (two flat colours). */
function png(width, height) {
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const b of buf) {
      let c = (crc ^ b) & 0xff;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Buffer.from([0]), Buffer.alloc(width * 4, y % 2 ? 200 : 90));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function sampleDoc(type, over = {}) {
  const t = { ...contract.defaultPrintTemplate(type, LETTERHEAD), ...over };
  return contract.composePrintDocument(t, contract.samplePrintValues(t));
}

const longBody = Array.from({ length: 14 }, (_, i) =>
  `Paragraph ${i + 1}. {{patient_full_name}} was seen on {{date_seen}}; this sentence is long enough to wrap across more than one printed line of the letter.`
).join('\n\n');

/** name → { doc, logo: PNG bytes | null }. */
const PINNED_DOCS = {
  excuse: { doc: () => sampleDoc('excuse'), logo: null },
  appointment_card: { doc: () => sampleDoc('appointment_card'), logo: null },
  multi_page: { doc: () => sampleDoc('excuse', { body: longBody }), logo: null },
  excuse_wide_logo: { doc: () => sampleDoc('excuse'), logo: () => png(8, 3) },
  card_tall_logo: { doc: () => sampleDoc('appointment_card'), logo: () => png(3, 9) },
};

/** SHA-256 of each pinned document's PDF, from the CO-3 renderer before styling. */
const PINNED_SHA256 = {
  excuse: '7e3a5f3220223b7c1e5a2b95760bb18ec42dcef50d26dcaf2bcdfb6b3d023d0b',
  appointment_card: '414ef8c4c6f6207b0a631c34c7bb32b5777d9f790c7da1b04227ef7c9a6a7289',
  multi_page: '84c5b5b7c5a6fad66cfbe833157978b365b1575a4dd112f21bfb15713ea9536b',
  excuse_wide_logo: '3b0a360ee7dc781190f9a5b8ae2638169a45f78c8d042e8157553caa32968081',
  card_tall_logo: 'c86e3cc728aae70837b969f25f5328d7d06d03c941850477dcfa4eb16eb76fbd',
};

module.exports = { PINNED_DOCS, PINNED_SHA256, LETTERHEAD, png, sampleDoc };
