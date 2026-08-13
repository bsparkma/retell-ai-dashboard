'use strict';

/**
 * Per-office Open Dental commlog-type catalogue.
 *
 * Until this module, the CommType on every CareIN chart note was a single
 * hardcoded per-office constant (`OFFICE_OD_SETTINGS[x].defaultCommTypeDefNum`
 * — Roland 486, Riley/valley 451). The team wants to file a note under the
 * office's OWN commlog types instead of always getting that one default, so the
 * list has to come from the office's Open Dental database.
 *
 * ── Where the list comes from ────────────────────────────────────────────────
 * Open Dental's commlogs doc pins the field: *"CommType: Optional.
 * definition.DefNum where definition.Category=27."* So the catalogue is
 * `GET /definitions?Category=27` on THAT OFFICE's client, and nothing else.
 * Probed live against both practices on 2026-08-13 (12 types each):
 *
 *     roland  486 = "CareIN AI Call"   ...  401 = "ODHQ"
 *     valley  451 = "CareIN AI Call"   ...  401 = "Crown by Moolah"
 *
 * Two things that table proves, and that this module is built around:
 *
 *   1. **The same DefNum means different things in different practices.** 401 is
 *      a real, selectable type in BOTH databases and names a different thing in
 *      each. So "is this DefNum allowed?" can only ever be answered against ONE
 *      office's list — there is no global allowlist to check against, and a
 *      number that looks plausible is not evidence of anything.
 *   2. **The 486/451 never-cross rule stops being a convention.** 486 does not
 *      appear in valley's list at all and 451 does not appear in roland's, so
 *      list membership *is* the cross-office check — enforced, not documented.
 *
 * ── Hidden types ─────────────────────────────────────────────────────────────
 * `includeHidden` defaults to `false`, so OD already omits retired types. We
 * filter again anyway, because the live field name is NOT what the published
 * doc says: the doc lists `IsHidden`, the API actually returns lowercase
 * `isHidden` carrying the STRING `"false"`. A `if (row.IsHidden)` written from
 * the doc would read `undefined` and pass everything; a `if (row.isHidden)`
 * written for a boolean would read `"false"` — a truthy string — and drop
 * everything. isHiddenRow() below handles both spellings and both types.
 *
 * ── Availability, and why a lookup can never block a chart write ─────────────
 * A definitions read is a network call to OD, and OD being unreachable must not
 * stop a front-desk user filing a note the way they file one today. So the
 * office's OWN default is accepted WITHOUT consulting the list (it is the
 * verified, configured DefNum for that practice — see odOffices.js), and only a
 * NON-default choice needs the catalogue. When the catalogue cannot be produced
 * and nothing is cached, a non-default choice is refused honestly
 * (COMMLOG_TYPE_UNVERIFIABLE) rather than written on a guess.
 *
 * The cache serves STALE on a failed refresh for the same reason: definitions
 * change on the order of months, so last hour's list is a far better answer than
 * an error toast.
 */

const odOffices = require('../config/odOffices');

/**
 * `definition.Category` for commlog types. From Open Dental's published
 * commlogs contract, not inferred: "definition.DefNum where
 * definition.Category=27". Confirmed live — every row comes back with
 * `Category: 27, category: "CommLogTypes"`.
 */
const COMMLOG_TYPES_CATEGORY = 27;

/**
 * How long a fetched catalogue is served without re-reading OD.
 *
 * Deliberately long: commlog types are practice configuration that changes when
 * somebody edits a list in Open Dental's setup screens — months apart, not
 * minutes. A short TTL would buy nothing and add a network round trip to the
 * confirm dialog. A stale entry is also the fallback when a refresh fails, so
 * this bounds freshness, not availability.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Give OD a short leash — this read sits in front of a dialog the user is waiting on. */
const FETCH_TIMEOUT_MS = 8000;

/**
 * Typed refusal, same shape as OdOfficeError so routes can map it to a status
 * and an honest message without inspecting internals.
 */
class CommlogTypeError extends Error {
  /**
   * @param {string} message internal message (logged)
   * @param {string} code stable machine code
   * @param {string} publicMessage safe message for the client / UI
   * @param {string|null} [officeKey]
   */
  constructor(message, code, publicMessage, officeKey = null) {
    super(message);
    this.name = 'CommlogTypeError';
    this.code = code;
    this.publicMessage = publicMessage;
    this.officeKey = officeKey;
  }
}

/**
 * code → HTTP status.
 *
 * INVALID is a 400 because the client sent something this office cannot accept;
 * UNVERIFIABLE is a 503 because the value might be perfectly valid and we simply
 * cannot tell right now. Collapsing the two would tell an operator their choice
 * was wrong when the truth is that Open Dental did not answer.
 */
const STATUS_BY_CODE = Object.freeze({
  COMMLOG_TYPE_INVALID: 400,
  COMMLOG_TYPE_UNVERIFIABLE: 503,
});

/**
 * Map an error to an HTTP status. Non-commlog-type errors fall through to 500.
 * @param {unknown} err
 * @returns {number}
 */
function httpStatusFor(err) {
  const code = err && /** @type {any} */ (err).code;
  return (code && STATUS_BY_CODE[code]) || 500;
}

/**
 * Per-office catalogue cache.
 * @typedef {Object} CacheEntry
 * @property {Array<{defNum: number, name: string}>} options last good list
 * @property {number} fetchedAt epoch ms of that list
 * @property {Promise<Array<{defNum: number, name: string}>|null>|null} inFlight
 * @type {Map<string, CacheEntry>}
 */
const cache = new Map();

/**
 * Is this definition row hidden?
 *
 * Tolerates both the documented `IsHidden` and the live `isHidden`, and both a
 * boolean and OD's stringified `"true"`/`"false"`. Anything unrecognised counts
 * as NOT hidden, which matches OD's own default (`includeHidden=false` already
 * filtered the response) rather than silently emptying the dropdown.
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
 * OD rows → the offered list. Keeps only visible Category-27 rows with a usable
 * DefNum and name, de-duped, sorted by name so the dropdown order is stable
 * across refreshes (OD returns no ItemOrder on this resource).
 * @param {unknown} data raw `GET /definitions` body
 * @returns {Array<{defNum: number, name: string}>}
 */
function normalizeDefinitions(data) {
  if (!Array.isArray(data)) return [];
  const seen = new Set();
  const options = [];

  for (const row of data) {
    if (!row || typeof row !== 'object') continue;

    const defNum = Number(row.DefNum);
    if (!Number.isInteger(defNum)) continue;

    // Defensive: the request already filters by category, but a row from some
    // other category would be a DefNum that is not a commlog type at all.
    if (row.Category !== undefined && Number(row.Category) !== COMMLOG_TYPES_CATEGORY) continue;

    if (isHiddenRow(row)) continue;

    const name = typeof row.ItemName === 'string' ? row.ItemName.trim() : '';
    if (!name) continue;

    if (seen.has(defNum)) continue;
    seen.add(defNum);
    options.push({ defNum, name });
  }

  return options.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read this office's commlog types from Open Dental. Returns null on any
 * failure — the caller decides whether to fall back to a stale entry.
 * @param {import('../config/odOffices').OdOfficeHandle} od
 * @returns {Promise<Array<{defNum: number, name: string}>|null>}
 */
async function fetchFromOd(od) {
  // apiGetRaw reports the outcome instead of throwing, and already answers
  // "this client is in direct-DB mode" / "OD is not configured" without a round
  // trip — both of which are simply "no catalogue", not an error to surface.
  const res = await od.client.apiGetRaw(
    '/definitions',
    // includeHidden is left at its default (false) so OD does the first pass.
    { Category: COMMLOG_TYPES_CATEGORY },
    { timeoutMs: FETCH_TIMEOUT_MS }
  );

  if (!res.ok) {
    console.warn(
      `[commlogTypes] ${od.officeKey}: definitions read failed (${res.status}): ${res.error || 'unknown'}`
    );
    return null;
  }

  const options = normalizeDefinitions(res.data);
  if (options.length === 0) {
    // A 200 with nothing usable is not a catalogue. Treating it as one would
    // empty the dropdown and make every non-default choice look invalid.
    console.warn(`[commlogTypes] ${od.officeKey}: definitions read returned no usable commlog types`);
    return null;
  }
  return options;
}

/**
 * This office's catalogue, from cache when fresh, otherwise from OD.
 *
 * Never throws. Returns `{ options, stale }` where `options` is null when there
 * is nothing to offer at all — no fresh read AND no earlier one to fall back on.
 *
 * @param {import('../config/odOffices').OdOfficeHandle} od
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ options: Array<{defNum: number, name: string}>|null, stale: boolean }>}
 */
async function loadCatalogue(od, opts = {}) {
  const key = od.officeKey;
  const entry = cache.get(key);
  const now = Date.now();

  if (!opts.force && entry && entry.options && now - entry.fetchedAt < CACHE_TTL_MS) {
    return { options: entry.options, stale: false };
  }

  // Collapse concurrent refreshes: the confirm dialog and the send that follows
  // it would otherwise each hit OD for the same list.
  const existing = entry && entry.inFlight;
  const inFlight = existing || fetchFromOd(od).catch((err) => {
    console.warn(`[commlogTypes] ${key}: definitions read threw: ${err && err.message}`);
    return null;
  });

  const base = entry || { options: null, fetchedAt: 0, inFlight: null };
  cache.set(key, { ...base, inFlight });

  let fetched = null;
  try {
    fetched = await inFlight;
  } finally {
    const current = cache.get(key);
    if (current && current.inFlight === inFlight) {
      cache.set(key, { ...current, inFlight: null });
    }
  }

  if (fetched) {
    cache.set(key, { options: fetched, fetchedAt: Date.now(), inFlight: null });
    return { options: fetched, stale: false };
  }

  // Serve the last good list rather than erroring the UI. An hour-old list of
  // practice configuration is a better answer than no list.
  const previous = cache.get(key);
  if (previous && previous.options) {
    return { options: previous.options, stale: true };
  }
  return { options: null, stale: false };
}

/**
 * The commlog types to OFFER for an office, plus that office's default.
 *
 * Never throws and never blocks anything: `available: false` simply means the
 * UI shows the default alone. The office is always the CALL's office, resolved
 * server-side by the caller — this function takes a bound handle, never a key
 * off a request.
 *
 * @param {import('../config/odOffices').OdOfficeHandle} od
 * @returns {Promise<{
 *   available: boolean,
 *   options: Array<{defNum: number, name: string}>,
 *   defaultDefNum: number,
 *   defaultName: string|null,
 *   stale: boolean
 * }>}
 */
async function listForOffice(od) {
  const defaultDefNum = od.commTypeDefNum;
  const { options, stale } = await loadCatalogue(od);

  if (!options) {
    return { available: false, options: [], defaultDefNum, defaultName: null, stale: false };
  }

  const match = options.find((o) => o.defNum === defaultDefNum);
  return {
    available: true,
    options,
    defaultDefNum,
    // null when the configured default is not in the office's own list — an
    // honest "we don't know what this DefNum is called here" rather than a
    // fabricated label. The UI still offers it; it is what a send omitting a
    // choice writes today.
    defaultName: match ? match.name : null,
    stale,
  };
}

/**
 * Validate a caller-chosen CommType against the office it is about to be
 * written to. THE enforcement point of this slice.
 *
 * @param {import('../config/odOffices').OdOfficeHandle} od the office-bound connection the write will use
 * @param {unknown} chosen the requested DefNum
 * @returns {Promise<number>} the accepted DefNum
 * @throws {CommlogTypeError} COMMLOG_TYPE_INVALID | COMMLOG_TYPE_UNVERIFIABLE
 */
async function assertAllowed(od, chosen) {
  const defNum = typeof chosen === 'number' ? chosen : Number(String(chosen).trim());
  if (!Number.isInteger(defNum) || defNum <= 0) {
    throw new CommlogTypeError(
      `commTypeDefNum must be a positive integer, got ${JSON.stringify(chosen)}`,
      'COMMLOG_TYPE_INVALID',
      'That chart note type is not valid',
      od.officeKey
    );
  }

  // The office's own default needs no lookup — it IS this practice's configured,
  // verified CommType. Checking it against the catalogue would mean a definitions
  // outage could block a send that works today, which is exactly the coupling
  // this slice must not introduce.
  if (defNum === od.commTypeDefNum) return defNum;

  const { options } = await loadCatalogue(od);

  if (!options) {
    throw new CommlogTypeError(
      `cannot verify commTypeDefNum ${defNum} for office '${od.officeKey}': no commlog-type catalogue available`,
      'COMMLOG_TYPE_UNVERIFIABLE',
      "Can't check that chart note type against this office's Open Dental right now — send with the default type, or try again shortly",
      od.officeKey
    );
  }

  if (!options.some((o) => o.defNum === defNum)) {
    // Loud, because the overwhelmingly likely cause is a DefNum from ANOTHER
    // practice's database — the 486-into-Riley class of bug this check exists
    // to make impossible.
    console.error(
      `[commlogTypes] BLOCKED commlog type ${defNum} for office '${od.officeKey}': ` +
        `not a commlog type in that practice's Open Dental`
    );
    throw new CommlogTypeError(
      `commTypeDefNum ${defNum} is not a commlog type in office '${od.officeKey}'`,
      'COMMLOG_TYPE_INVALID',
      'That chart note type does not exist in this office — refusing to write it',
      od.officeKey
    );
  }

  return defNum;
}

/**
 * The catalogue for an office KEY, for callers that hold a key rather than a
 * handle. Resolves the office connection through the same seam every other
 * OD-touching path uses, and reports the office's own refusal (unknown /
 * not connected / unkeyed) as simply "no list", because a picker is never a
 * reason to surface an OD connection error.
 *
 * @param {string} officeKey
 * @returns {Promise<{
 *   available: boolean,
 *   options: Array<{defNum: number, name: string}>,
 *   defaultDefNum: number|null,
 *   defaultName: string|null,
 *   stale: boolean
 * }>}
 */
async function listForOfficeKey(officeKey) {
  let od;
  try {
    od = odOffices.assertOfficeMatch(officeKey, odOffices.getOdOffice(officeKey));
  } catch {
    return { available: false, options: [], defaultDefNum: null, defaultName: null, stale: false };
  }
  return listForOffice(od);
}

/**
 * Drop cached catalogues. Tests only — the app builds them lazily per office
 * and lets the TTL do the rest.
 * @returns {void}
 */
function resetCommlogTypeCache() {
  cache.clear();
}

module.exports = {
  CommlogTypeError,
  COMMLOG_TYPES_CATEGORY,
  CACHE_TTL_MS,
  httpStatusFor,
  listForOffice,
  listForOfficeKey,
  assertAllowed,
  resetCommlogTypeCache,
  /** Exposed for tests. */
  normalizeDefinitions,
};
