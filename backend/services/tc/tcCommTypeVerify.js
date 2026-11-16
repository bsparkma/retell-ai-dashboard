'use strict';

/**
 * AT-2 step 0, as a pure function: given each office's commlog-type
 * Definitions (GET /definitions?Category=27&includeHidden=true, raw rows), is
 * there exactly ONE visible "CareIN TC" per office, and is its DefNum safe to
 * configure?
 *
 * Refuses (ok: false, with a sentence per problem) when, for any office:
 *   - there is no "CareIN TC", or more than one;
 *   - it is hidden;
 *   - its DefNum equals one of the known call / referral DefNums (any office),
 *     or another office's "CareIN TC" DefNum.
 *
 * No I/O. scripts/tc-commtype-readback.js feeds it live rows (read-only), and
 * routes/tc/tcActivityChart.test.js pins every refusal.
 */

const TC_NAME = 'CareIN TC';

/** OD's hidden flag arrives as the STRING "false"/"true" (see services/commlogTypes.js). */
function hidden(row) {
  const raw = row.isHidden !== undefined ? row.isHidden : row.IsHidden;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  if (typeof raw === 'number') return raw === 1;
  return false;
}

/** @param {unknown[]} rows @param {number|null} defNum */
function nameOf(rows, defNum) {
  const r = rows.find((x) => x && Number(/** @type {any} */ (x).DefNum) === defNum);
  return r ? String(/** @type {any} */ (r).ItemName) : null;
}

/**
 * @param {Record<string, unknown[]>} listsByOffice raw Definition rows per office key
 * @param {Record<string, { call: number|null, referral: number|null }>} known the configured call/referral DefNums per office
 * @returns {{ ok: boolean, problems: string[], offices: Record<string, {
 *   defNum: number|null, itemName: string|null, isHidden: boolean|null,
 *   call: { defNum: number|null, itemName: string|null },
 *   referral: { defNum: number|null, itemName: string|null } }> }}
 */
function verifyTcCommTypes(listsByOffice, known) {
  /** @type {string[]} */
  const problems = [];
  /** @type {ReturnType<typeof verifyTcCommTypes>['offices']} */
  const offices = {};

  for (const [office, list] of Object.entries(listsByOffice)) {
    const rows = Array.isArray(list) ? list.filter((r) => r && typeof r === 'object') : [];
    const matches = rows.filter(
      (r) =>
        typeof (/** @type {any} */ (r).ItemName) === 'string' &&
        /** @type {any} */ (r).ItemName.trim() === TC_NAME &&
        (/** @type {any} */ (r).Category === undefined || Number(/** @type {any} */ (r).Category) === 27)
    );
    const k = known[office] || { call: null, referral: null };
    const one = matches.length === 1 ? /** @type {any} */ (matches[0]) : null;
    offices[office] = {
      defNum: one ? Number(one.DefNum) : null,
      itemName: one ? String(one.ItemName) : null,
      isHidden: one ? hidden(one) : null,
      call: { defNum: k.call, itemName: nameOf(rows, k.call) },
      referral: { defNum: k.referral, itemName: nameOf(rows, k.referral) },
    };
    if (matches.length === 0) problems.push(`${office}: no "${TC_NAME}" commlog type`);
    if (matches.length > 1) problems.push(`${office}: ${matches.length} "${TC_NAME}" commlog types (${matches.map((m) => /** @type {any} */ (m).DefNum).join(', ')})`);
    if (one && hidden(one)) problems.push(`${office}: "${TC_NAME}" (${one.DefNum}) is hidden`);
    if (one && !(Number.isInteger(Number(one.DefNum)) && Number(one.DefNum) > 0)) problems.push(`${office}: "${TC_NAME}" has no usable DefNum`);
  }

  // Collisions: against every office's call/referral, and the other offices' TC.
  for (const [office, o] of Object.entries(offices)) {
    if (o.defNum === null) continue;
    for (const [other, k] of Object.entries(known)) {
      for (const kind of /** @type {const} */ (['call', 'referral'])) {
        if (k[kind] === o.defNum) problems.push(`${office}: "${TC_NAME}" DefNum ${o.defNum} equals ${other}'s ${kind} DefNum`);
      }
    }
    for (const [other, p] of Object.entries(offices)) {
      if (other !== office && p.defNum === o.defNum) problems.push(`${office}: "${TC_NAME}" DefNum ${o.defNum} equals ${other}'s "${TC_NAME}" DefNum`);
    }
  }

  return { ok: problems.length === 0, problems, offices };
}

module.exports = { verifyTcCommTypes, TC_NAME };
