/**
 * Regenerate `services/rcm/x12Codes.generated.js` from the PUBLISHED X12 code lists.
 *
 *   node scripts/fetch-x12-codes.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SCRIPT EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Slice 6a originally shipped a hand-written CARC table that claimed to carry
 * "the published X12/WPC meaning" of each code. A spot-check in review found it
 * did not, and the errors clustered on exactly the codes a dental biller acts
 * on:
 *
 *   22  said "care already paid"          — actually COORDINATION OF BENEFITS,
 *                                           i.e. BILL THE SECONDARY CARRIER
 *   51  said "delivered in a different location" — actually PRE-EXISTING CONDITION
 *   50  said "non-covered service"        — actually NOT A MEDICAL NECESSITY
 *   151 said "automatic pre-payment review" — actually THE FREQUENCY LIMIT code
 *   B15 said "combined with another procedure" — actually REQUIRES A QUALIFYING
 *                                           SERVICE (the buildup/crown and SRP
 *                                           sequencing code)
 *   54 and 234 were swapped with each other
 *
 * Code 22 is the one that costs money: it means bill the other payer, and the
 * table told the biller it had already been paid.
 *
 * Confidently wrong text in front of billing staff is worse than no text — the
 * same judgement the parser's D5 ruling made about inventing a CARC from a
 * malformed CAS. So the fix is not to hand-correct the table. **The list is
 * INGESTED, never typed**, and this script is the only way the data file
 * changes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT GUARANTEES
 * ─────────────────────────────────────────────────────────────────────────────
 *  - Descriptions are the published strings, VERBATIM, entity-decoded and with
 *    the "Start:/Last Modified:" date spans (presentation, not meaning) removed.
 *  - Deactivated and to-be-deactivated codes are KEPT, with their status. A
 *    remittance for work done three years ago legitimately carries a code that
 *    was retired since, and refusing to describe it would be a gap exactly where
 *    an old denial is being worked.
 *  - The output carries the source URL, the retrieval date, and a content hash.
 *    `adjustmentCodes.test.js` pins the counts and that hash, so BOTH silent
 *    upstream drift AND a hand edit fail the build.
 *
 * Re-running when X12 publishes an update is expected to turn the test red.
 * That is the point: someone looks at the diff and re-pins deliberately.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../services/rcm/x12Codes.generated.js');

const SOURCES = {
  CARC: 'https://x12.org/codes/claim-adjustment-reason-codes',
  RARC: 'https://x12.org/codes/remittance-advice-remark-codes',
};

/**
 * One row of the published table.
 *
 *   <tr class="prod-set current">
 *     <td class="code">1</td>
 *     <td class="description">Deductible Amount<span class="dates">…</span></td>
 *   </tr>
 *
 * Anchored on the real classes rather than on position, so a layout change
 * yields ZERO rows — a loud, obvious failure — instead of plausible garbage.
 */
const ROW =
  /<tr class="prod-set ([^"]*)"><td class="code">([^<]+)<\/td><td class="description">([\s\S]*?)<\/td><\/tr>/g;

/** Minimal, complete entity decode for the entities this content actually uses. */
function decode(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&sect;/g, '§')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** `current` | `tobe` | `deactivated` — first recognised token wins. */
function statusOf(classList) {
  for (const s of ['deactivated', 'tobe', 'current']) {
    if (classList.split(/\s+/).includes(s)) return s;
  }
  return 'current';
}

async function scrape(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'carein-rcm-codelist-sync' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const html = await res.text();

  /** @type {Record<string, { text: string, status: string }>} */
  const out = {};
  let m;
  let rows = 0;
  while ((m = ROW.exec(html)) !== null) {
    rows++;
    const code = decode(m[2]).toUpperCase();
    // The date span is presentation, not meaning — dropped before decoding so
    // "Start: 01/01/1995" never lands in a description a biller reads.
    const text = decode(m[3].replace(/<span class="dates">[\s\S]*?<\/span>/g, ''));
    if (!code || !text) continue;
    // First occurrence wins: the page lists a code once per status set, and the
    // table is ordered current-first.
    if (!(code in out)) out[code] = { text, status: statusOf(m[1]) };
  }

  if (rows === 0) {
    throw new Error(
      `${url} produced 0 rows — the page layout changed. Fix the ROW pattern; do NOT hand-write the table.`
    );
  }
  return out;
}

/**
 * The same map with keys in sorted order.
 *
 * Built explicitly rather than via JSON.stringify's replacer argument: an ARRAY
 * replacer is a property FILTER, not a key order, so passing the key list there
 * silently emits `{}` for every entry. (It did, once.)
 */
function sorted(map) {
  /** @type {Record<string, { text: string, status: string }>} */
  const out = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key];
  return out;
}

/** Stable JSON over sorted keys, so the hash tracks CONTENT, not key order. */
function canonical(map) {
  return JSON.stringify(
    Object.keys(map)
      .sort()
      .map((k) => [k, map[k].text, map[k].status])
  );
}

const carc = await scrape(SOURCES.CARC);
const rarc = await scrape(SOURCES.RARC);

const hash = createHash('sha256').update(`${canonical(carc)}\n${canonical(rarc)}`).digest('hex');
const retrievedAt = new Date().toISOString().slice(0, 10);

const body = `'use strict';

/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * The published X12 Claim Adjustment Reason Codes and Remittance Advice Remark
 * Codes, ingested verbatim. Regenerate with:
 *
 *     node backend/scripts/fetch-x12-codes.mjs
 *
 * A hand edit fails \`adjustmentCodes.test.js\`, which pins the entry counts and
 * the content hash below. That is deliberate: Slice 6a shipped a hand-written
 * table whose entries for CARC 22, 50, 51, 54, 151, 234 and B15 carried the
 * WRONG meaning — including telling a biller that a coordination-of-benefits
 * adjustment had "already been paid". This data is machine-ingested so that
 * class of error cannot recur.
 *
 * Deactivated codes are retained with their status: an old denial being worked
 * today legitimately carries a code that has since been retired.
 *
 * Source:    ${SOURCES.CARC}
 *            ${SOURCES.RARC}
 * Retrieved: ${retrievedAt}
 * Codes:     ${Object.keys(carc).length} CARC · ${Object.keys(rarc).length} RARC
 * SHA-256:   ${hash}
 */

/** @typedef {{ text: string, status: 'current'|'tobe'|'deactivated' }} X12Code */

const SOURCE = Object.freeze({
  carcUrl: ${JSON.stringify(SOURCES.CARC)},
  rarcUrl: ${JSON.stringify(SOURCES.RARC)},
  retrievedAt: ${JSON.stringify(retrievedAt)},
  sha256: ${JSON.stringify(hash)},
});

/** @type {Readonly<Record<string, X12Code>>} */
const CARC = Object.freeze(${JSON.stringify(sorted(carc), null, 2)});

/** @type {Readonly<Record<string, X12Code>>} */
const RARC = Object.freeze(${JSON.stringify(sorted(rarc), null, 2)});

module.exports = { SOURCE, CARC, RARC };
`;

writeFileSync(OUT, body, 'utf8');
console.log(`wrote ${OUT}`);
console.log(`  CARC ${Object.keys(carc).length} · RARC ${Object.keys(rarc).length}`);
console.log(`  sha256 ${hash}`);
console.log(`  retrieved ${retrievedAt}`);
