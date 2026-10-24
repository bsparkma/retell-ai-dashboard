'use strict';

/**
 * "Import from Open Dental" for the provider directory: read the office's
 * providers ONCE, read-only, and merge them into the app's own list.
 *
 * THE MERGE IS ADDITIVE.
 *   - A provider whose ProvNum is not in the list yet is ADDED (active).
 *   - A row already linked to that ProvNum gets Open Dental's NAME (and its
 *     credential suffix, when Open Dental has one — an empty OD suffix never
 *     blanks one staff typed).
 *   - Nothing is ever deleted, and `active` is never touched: a provider who
 *     left is deactivated by staff, by hand. A hand-added row (no ProvNum) is
 *     never touched at all.
 *   - Left out, and counted so the screen can say so: providers HIDDEN in Open
 *     Dental (no longer practising there), HYGIENISTS (they neither refer nor
 *     sign a pre-auth), and rows with no name to show.
 *
 * planImport is pure (rows in, plan out); readOdProviders is the one Open
 * Dental read, through the GET-only closure the route hands it. Nothing here
 * can write to Open Dental.
 */

/** OD paginates list reads at 100 rows via `Offset`. */
const OD_PAGE_SIZE = 100;
/** A practice has tens of providers; ten pages is a circuit breaker, not a limit. */
const MAX_PAGES = 10;
const OD_CALL_TIMEOUT_MS = Number(process.env.TC_OD_CALL_TIMEOUT_MS || 30000);

const NAME_MAX = 200;
const SUFFIX_MAX = 40;

/** Open Dental answers booleans as true/false or as the STRINGS "true"/"false". */
function odFlag(v) {
  return v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** A positive whole ProvNum, or null. */
function provNumOf(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * One OD provider row → what the directory would hold, or why it is left out.
 * @returns {{ skip: 'hidden'|'hygienist'|'no_name'|'no_prov_num' } | { odProvNum: number, name: string, credentialSuffix: string }}
 */
function fromOdRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  const odProvNum = provNumOf(r.ProvNum);
  if (odProvNum === null) return { skip: 'no_prov_num' };
  if (odFlag(r.IsHidden)) return { skip: 'hidden' };
  if (odFlag(r.IsHygienist)) return { skip: 'hygienist' };
  const name = [text(r.FName), text(r.LName)].filter(Boolean).join(' ') || text(r.Abbr);
  if (!name) return { skip: 'no_name' };
  return {
    odProvNum,
    name: name.slice(0, NAME_MAX),
    credentialSuffix: text(r.Suffix).slice(0, SUFFIX_MAX),
  };
}

/**
 * What an import would do to this office's list. Pure.
 *
 * @param {unknown[]} odRows      Open Dental's /providers rows
 * @param {Array<{ provider_id: string, name: string, credential_suffix: string, od_prov_num: unknown }>} existing
 *                                the office's directory rows (every one, active or not)
 */
function planImport(odRows, existing) {
  const byProvNum = new Map();
  for (const row of existing) {
    const n = provNumOf(row.od_prov_num);
    if (n !== null) byProvNum.set(n, row);
  }

  const plan = {
    inserts: [],
    updates: [],
    unchanged: 0,
    skippedHidden: 0,
    skippedHygienists: 0,
    skippedNoName: 0,
  };
  const seen = new Set();
  for (const raw of odRows) {
    const p = fromOdRow(raw);
    if ('skip' in p) {
      if (p.skip === 'hidden') plan.skippedHidden += 1;
      else if (p.skip === 'hygienist') plan.skippedHygienists += 1;
      else plan.skippedNoName += 1;
      continue;
    }
    // A page boundary can repeat a row; one ProvNum is one provider.
    if (seen.has(p.odProvNum)) continue;
    seen.add(p.odProvNum);

    const current = byProvNum.get(p.odProvNum);
    if (!current) {
      plan.inserts.push(p);
      continue;
    }
    const credentialSuffix = p.credentialSuffix || current.credential_suffix || '';
    if (current.name === p.name && (current.credential_suffix || '') === credentialSuffix) {
      plan.unchanged += 1;
      continue;
    }
    plan.updates.push({ providerId: String(current.provider_id), name: p.name, credentialSuffix });
  }
  return plan;
}

/**
 * The office's providers, every page, through `odGet` (GET-only). Throws an
 * Error carrying `odStatus` when Open Dental refuses or fails, and
 * `truncated` when the list did not end inside the page budget — an import
 * from half a list would be a guess, so it is refused rather than merged.
 * @param {(path: string, params: object, opts: object) => Promise<{ ok: boolean, status: number, data: unknown, error?: string }>} odGet
 */
async function readOdProviders(odGet) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // Offset omitted on the first page: some OD builds do not recognise Offset=0.
    const res = await odGet('/providers', page === 0 ? {} : { Offset: page * OD_PAGE_SIZE }, {
      timeoutMs: OD_CALL_TIMEOUT_MS,
    });
    if (!res || !res.ok) {
      const err = new Error(`providers read failed (OD status ${res ? res.status : 'n/a'})`);
      err.odStatus = res ? res.status : null;
      throw err;
    }
    const batch = Array.isArray(res.data) ? res.data : [];
    rows.push(...batch);
    if (batch.length < OD_PAGE_SIZE) return rows;
  }
  const err = new Error('providers list did not end within the page budget');
  err.truncated = true;
  throw err;
}

module.exports = { planImport, readOdProviders, fromOdRow, MAX_PAGES, OD_PAGE_SIZE };
