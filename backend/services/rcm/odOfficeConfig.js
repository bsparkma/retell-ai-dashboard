'use strict';

/**
 * RCM Slice 6c — the per-office posting configuration registry.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * `POST /claimpayments` takes a `PayType`, and `PayType` is a DefNum from
 * `definition.Category = 32`. Roland's are 296 "Check", 297 "EFT", 404 "Credit
 * Card", 472 "Insurance Check" (RCM_OD_WRITES §1, verified live). **Those are
 * Roland's numbers.** Riley's database numbers its own definitions and the two
 * sets have no reason to agree — the commlog-type probe found DefNum 401 alive
 * in both practices meaning two different things, and CommType 486 vs 451 is the
 * same lesson with money attached.
 *
 * So there is no constant to hardcode, and a plausible-looking number is not
 * evidence of anything. The office's own database is the only source, and this
 * module is the only thing that reads it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NUMERIC `Category=` ONLY — A STRING FILTER IS A LIE, NOT AN ERROR
 * ─────────────────────────────────────────────────────────────────────────────
 * `?category=InsurancePaymentType` and `?category=NotARealCategory` both
 * returned the SAME unfiltered 100-row page spanning Categories 0–6
 * (RCM_OD_WRITES §9, verified). The filter is silently ignored: a caller that
 * trusts it gets a plausible wrong answer with a 200 on it.
 *
 * Two consequences, both implemented below:
 *   1. only `Category=<number>` is ever sent; and
 *   2. every row is re-checked client-side against the category we asked for, so
 *      an ignored filter yields a correct (possibly empty) set rather than a
 *      wrong one. `filterHonored` records which happened — the same discipline
 *      `odClaimReads.js` applies to `?PatNum=`.
 *
 * The same applies to `/preferences?PrefName=`: rows are re-matched by name.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FAIL-CLOSED, AND WHY THERE IS NO STALE FALLBACK HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * `commlogTypes.js` serves a stale catalogue when a refresh fails, and that is
 * right for a dropdown: the office's own verified default is accepted without
 * consulting the list, so a stale list only ever narrows what a user may pick.
 *
 * Posting has no such default. There is no PayType we may assume, and writing a
 * check with the wrong one puts money in the practice's books under the wrong
 * payment method. So a config that cannot be resolved is a REFUSAL — the queue
 * row blocks with `office_config_unresolved` and no Open Dental call is made —
 * and the cache is a freshness optimisation only, never an availability one.
 *
 * A cached entry IS reused within its TTL, because definitions change on the
 * order of months and a drain of twenty claims must not read the same four
 * definition lists twenty times through a 1.2 s pacer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRANSPORT AS AN ARGUMENT
 * ─────────────────────────────────────────────────────────────────────────────
 * Like `odClaimReads.js`, every function here takes `odGet` as its first
 * argument rather than importing a client. That keeps the module unit-testable
 * against a recorded-shape fake and keeps a write verb out of scope — there is
 * no client object in this file to find one on. The caller resolves the office's
 * own client through `assertOfficeMatch(office, getOdOffice(office))` and passes
 * a paced closure over `apiGetRaw`.
 */

/**
 * Definition categories, from Open Dental's own documentation and confirmed
 * live against Roland (RCM_OD_WRITES §Probe C). Numeric because the string form
 * of the filter is ignored.
 */
const CATEGORY = Object.freeze({
  /** AdjType — `ItemValue` is "+" or "-" and `AdjAmt`'s sign must agree. */
  ADJ_TYPE: 1,
  /** DocCategory — where an EOB PDF is filed. Read here; used by 6d. */
  DOC_CATEGORY: 18,
  /** InsurancePaymentType — `claimpayment.PayType`. NOT Category 10. */
  PAY_TYPE: 32,
});

/**
 * The preferences that GATE the posting path, read rather than assumed.
 *
 * `ClaimPaymentBatchOnly` is not a preference we may guess at: when true, `POST
 * /claimpayments` (single) is REFUSED and the Batch endpoint is mandatory. Live
 * on Roland it is 0, but it is a checkbox a front office can flip in Open
 * Dental's own setup screen without telling anybody, and discovering it through
 * a 400 mid-drain would strand a row in the §8 window.
 *
 * `ShowAutoDeposit` decides whether `POST /claimpayments/Batch` also creates a
 * deposit. Live on Roland it is 0. Nothing in this slice acts on it — it is read
 * and reported so the drain's effect on the practice's books is a stated fact
 * rather than an assumption, and so 6d's deposit work starts from a measurement.
 */
const PREF_NAMES = Object.freeze(['ClaimPaymentBatchOnly', 'ShowAutoDeposit']);

/**
 * How long a resolved configuration is reused without re-reading Open Dental.
 *
 * One hour, for the same reason `commlogTypes.js` uses one hour: definitions and
 * preferences are practice configuration edited months apart. The cost this buys
 * is real — every read is paced at ≥1.2 s and there are five of them, so an
 * uncached resolve is ~6 s of a drain's wall clock.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Short leash. A configuration read that hangs must not hold the drain open. */
const FETCH_TIMEOUT_MS = 15000;

/**
 * Per-office cache. Keyed by office key, and ONLY by office key — the whole
 * point of this module is that roland's answer is never valid for valley.
 * @type {Map<string, { config: PostingConfig, fetchedAt: number }>}
 */
const cache = new Map();

/**
 * @typedef {{ defNum: number, name: string, sign: '+'|'-'|null }} OdDefinition
 * @typedef {Object} PostingConfig
 * @property {string} officeKey
 * @property {OdDefinition[]} payTypes        Category 32
 * @property {OdDefinition[]} adjTypes        Category 1 (sign carried)
 * @property {OdDefinition[]} docCategories   Category 18 (6d)
 * @property {{ claimPaymentBatchOnly: boolean|null, showAutoDeposit: boolean|null }} prefs
 * @property {{ payTypes: boolean, adjTypes: boolean, docCategories: boolean }} filterHonored
 * @property {string} resolvedAt ISO
 */

/** Typed refusal — the caller turns this into a `blocked` queue row. */
class OdConfigError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'OdConfigError';
    this.code = code;
  }
}

/** OD list endpoints return a bare array; be defensive about envelopes. */
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

/**
 * Open Dental returns booleans as STRINGS on several resources (`IsPartial:
 * "false"`, `isHidden: "false"` — both verified live). `if (row.isHidden)` is
 * therefore true for a hidden-ness of "false", which drops every row. Both
 * spellings and all three types are handled, exactly as `commlogTypes.js` does.
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
function isHiddenRow(row) {
  const raw = row.isHidden !== undefined ? row.isHidden : row.IsHidden;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  if (typeof raw === 'number') return raw === 1;
  return false;
}

/**
 * `ItemValue` on an AdjType row is "+" or "-", and `AdjAmt`'s sign must agree or
 * Open Dental refuses with `400 "AdjAmt must be negative for this AdjType."`
 * (Spike 0b test 8). Carried onto the definition so a caller can pre-check
 * rather than discover the refusal.
 * @param {Record<string, unknown>} row
 * @returns {'+'|'-'|null}
 */
function signOf(row) {
  const raw = typeof row.ItemValue === 'string' ? row.ItemValue.trim() : '';
  if (raw === '+' || raw === '-') return raw;
  return null;
}

/**
 * Read one definition category, re-filtering client-side.
 *
 * @param {(path: string, params?: object, opts?: object) => Promise<{ok:boolean,status:number,data:unknown,error?:string}>} odGet
 * @param {number} category
 * @returns {Promise<{ rows: OdDefinition[], filterHonored: boolean }>}
 * @throws {OdConfigError} when the read itself failed — never an empty list
 */
async function readDefinitions(odGet, category) {
  const res = await odGet('/definitions', { Category: category }, { timeoutMs: FETCH_TIMEOUT_MS });
  if (!res.ok) {
    throw new OdConfigError(
      `definitions read for Category ${category} failed (${res.status}): ${res.error || 'unknown'}`,
      'OD_CONFIG_READ_FAILED'
    );
  }

  const raw = asArray(res.data);
  /** @type {OdDefinition[]} */
  const rows = [];
  const seen = new Set();
  let foreign = 0;

  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    /*
     * THE RE-FILTER. `Category` is present on every live definition row, so a
     * row from another category is proof the server ignored our filter — which
     * it demonstrably does for the string form and which we must not assume it
     * honours for the numeric one either.
     */
    if (row.Category === undefined || Number(row.Category) !== category) {
      foreign += 1;
      continue;
    }
    if (isHiddenRow(row)) continue;

    const defNum = Number(row.DefNum);
    if (!Number.isInteger(defNum) || seen.has(defNum)) continue;
    const name = typeof row.ItemName === 'string' ? row.ItemName.trim() : '';
    if (!name) continue;

    seen.add(defNum);
    rows.push({ defNum, name, sign: signOf(row) });
  }

  return { rows, filterHonored: foreign === 0 };
}

/**
 * Read one preference by name, re-matching on the name client-side.
 *
 * Returns `null` when the preference is absent or unreadable, which the caller
 * reports as "unknown" rather than as a value. Guessing `false` for
 * `ClaimPaymentBatchOnly` would let the drain choose the single-claim endpoint
 * on a practice that refuses it.
 *
 * @param {(path: string, params?: object, opts?: object) => Promise<{ok:boolean,status:number,data:unknown,error?:string}>} odGet
 * @param {string} prefName
 * @returns {Promise<boolean|null>}
 */
async function readPreference(odGet, prefName) {
  const res = await odGet('/preferences', { PrefName: prefName }, { timeoutMs: FETCH_TIMEOUT_MS });
  if (!res.ok) return null;

  // `?PrefName=` is another filter we have not proven Open Dental honours, so
  // the name is matched here rather than trusted. `[0]` would otherwise read
  // whichever preference happened to sort first on an unfiltered page.
  const rows = asArray(res.data);
  const match = rows.find(
    (r) => r && typeof r === 'object' && String(r.PrefName || '').trim() === prefName
  );
  if (!match) return null;

  const value = match.ValueString !== undefined ? match.ValueString : match.valueString;
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toLowerCase();
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  return null;
}

/**
 * Resolve this office's posting configuration from ITS OWN Open Dental.
 *
 * Five paced reads on a cache miss: three definition categories and two
 * preferences. Throws `OdConfigError` if any DEFINITION read fails — the drain
 * turns that into `blocked: office_config_unresolved` and makes no write. A
 * failed PREFERENCE read is recorded as `null` (unknown) rather than thrown,
 * because `resolveCheckEndpoint` below refuses on unknown anyway and a null is
 * more informative on the screen than an outage.
 *
 * @param {(path: string, params?: object, opts?: object) => Promise<{ok:boolean,status:number,data:unknown,error?:string}>} odGet
 * @param {string} officeKey
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ config: PostingConfig, cached: boolean }>}
 */
async function resolvePostingConfig(odGet, officeKey, opts = {}) {
  const now = Date.now();
  const entry = cache.get(officeKey);
  if (!opts.force && entry && now - entry.fetchedAt < CACHE_TTL_MS) {
    return { config: entry.config, cached: true };
  }

  const payTypes = await readDefinitions(odGet, CATEGORY.PAY_TYPE);
  const adjTypes = await readDefinitions(odGet, CATEGORY.ADJ_TYPE);
  const docCategories = await readDefinitions(odGet, CATEGORY.DOC_CATEGORY);

  /** @type {Record<string, boolean|null>} */
  const prefs = {};
  for (const name of PREF_NAMES) {
    prefs[name] = await readPreference(odGet, name);
  }

  /*
   * AN EMPTY PayType LIST IS A REFUSAL, NOT A CONFIGURATION.
   *
   * A 200 carrying nothing usable is not an answer — it is the same shape a
   * silently-ignored filter produces once the client-side re-filter has done its
   * job. Accepting it would leave `pickPayType` with nothing to pick and the
   * drain choosing to omit `PayType` entirely, which posts the check under
   * whatever default the practice happens to have. That is money filed under the
   * wrong payment method, silently.
   */
  if (payTypes.rows.length === 0) {
    throw new OdConfigError(
      `${officeKey}: Open Dental returned no usable insurance payment types ` +
        `(definitions Category ${CATEGORY.PAY_TYPE})`,
      'OD_CONFIG_EMPTY'
    );
  }

  /** @type {PostingConfig} */
  const config = {
    officeKey,
    payTypes: payTypes.rows,
    adjTypes: adjTypes.rows,
    docCategories: docCategories.rows,
    prefs: {
      claimPaymentBatchOnly: prefs.ClaimPaymentBatchOnly,
      showAutoDeposit: prefs.ShowAutoDeposit,
    },
    filterHonored: {
      payTypes: payTypes.filterHonored,
      adjTypes: adjTypes.filterHonored,
      docCategories: docCategories.filterHonored,
    },
    resolvedAt: new Date(now).toISOString(),
  };

  cache.set(officeKey, { config, fetchedAt: Date.now() });
  return { config, cached: false };
}

/**
 * Names we will accept for each payment method, most specific first.
 *
 * Matching is by NAME because the numbers differ per practice and there is
 * nothing else on a definition row to match on. It is exact and
 * case-insensitive rather than substring: "Insurance Check" and "Check" are both
 * live on Roland and a substring rule would make the choice depend on list
 * order.
 *
 * Order matters. Roland carries both 296 "Check" and 472 "Insurance Check"; the
 * insurance-specific one is the right home for an insurance check, so it is
 * tried first.
 */
const PAY_TYPE_NAMES = Object.freeze({
  check: ['insurance check', 'check'],
  eft: ['insurance eft', 'eft', 'electronic funds transfer'],
});

/**
 * Choose the office's DefNum for a payment method.
 *
 * Returns null when the office's list carries nothing recognisable, which is a
 * REFUSAL upstream — never "omit PayType and let Open Dental decide". A check
 * posted under the practice's default payment type is a reconciliation problem
 * that surfaces weeks later in a deposit that does not tie out.
 *
 * @param {PostingConfig} config
 * @param {'check'|'eft'} method
 * @returns {OdDefinition|null}
 */
function pickPayType(config, method) {
  const wanted = PAY_TYPE_NAMES[method];
  if (!wanted) return null;
  for (const name of wanted) {
    const hit = config.payTypes.find((p) => p.name.trim().toLowerCase() === name);
    if (hit) return hit;
  }
  return null;
}

/**
 * Which `/claimpayments` endpoint this office permits.
 *
 * `ClaimPaymentBatchOnly = true` makes the single-claim POST a hard refusal, so
 * the Batch endpoint is not merely preferred — it is the only one that works.
 * Unknown (the preference could not be read) resolves to `batch` as well: Batch
 * is legal on a practice that permits both, so preferring it is the choice that
 * is correct under either truth. Guessing `single` would be a coin flip whose
 * losing side is a 400 in the middle of the posting sequence.
 *
 * @param {PostingConfig} config
 * @param {number} claimCount how many distinct OD claims this check covers
 * @returns {'single'|'batch'}
 */
function resolveCheckEndpoint(config, claimCount) {
  if (claimCount > 1) return 'batch';
  if (config.prefs.claimPaymentBatchOnly !== false) return 'batch';
  return 'single';
}

/** Test seam — the cache is process-wide and must not leak between suites. */
function _resetForTests() {
  cache.clear();
}

module.exports = {
  CATEGORY,
  PREF_NAMES,
  CACHE_TTL_MS,
  FETCH_TIMEOUT_MS,
  PAY_TYPE_NAMES,
  OdConfigError,
  readDefinitions,
  readPreference,
  resolvePostingConfig,
  pickPayType,
  resolveCheckEndpoint,
  isHiddenRow,
  _resetForTests,
};
