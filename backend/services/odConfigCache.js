'use strict';

/**
 * Per-office cache of Open Dental's PRACTICE CONFIGURATION lists.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THESE THREE AND NOT THE PATIENT RECORD
 * ═════════════════════════════════════════════════════════════════════════════
 * `/appointmenttypes`, `/providers` and `/operatories` are the practice's own
 * vocabulary: the chairs, the people who work in them, and the names the front
 * desk gives a visit. They are edited when somebody is hired or a room is
 * renamed — months apart — and nothing on them is clinical.
 *
 * `services/commlogTypes.js` is the precedent: it holds the same KIND of thing
 * and caches for an hour, and the reason it is safe there is the reason it is
 * safe here.
 *
 * **`/patients` is NOT in this file and must never be added to it.** A premed
 * flag or a medical alert can be added to a chart mid-morning, and
 * `services/odPatientCache.js` holds that one at five minutes for exactly that
 * reason — see its §2, which also says why the next person to read it will want
 * to raise the number and why they must not. The two caches are separate files
 * so that "config ages slowly, clinical facts do not" is a property of the
 * code rather than a comment somebody has to notice.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE KEY IS office + resource, AND THE OFFICE HALF IS NOT OPTIONAL
 * ═════════════════════════════════════════════════════════════════════════════
 * Operatory 4 is a different room in each practice and ProvNum 7 is a different
 * person. A cache keyed on the resource alone would put Roland's chair names on
 * Riley's schedule — quieter than the cross-office PHI bug `odPatientCache`
 * guards against, and the same mistake. `cacheKey()` therefore refuses an
 * office that is not a key of the Open Dental registry rather than defaulting
 * one, exactly as that file does.
 *
 * The resource must also be one of three named below, so nothing can mint a
 * namespace here by passing a path, and this cache cannot quietly grow to hold
 * something clinical.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A FAILED OR TRUNCATED READ IS NEVER STORED
 * ═════════════════════════════════════════════════════════════════════════════
 * `pagedList` returns partial rows plus an `error` when Open Dental stops
 * answering mid-walk, and that is the right thing to RENDER — three quarters of
 * the chairs beats an outage. It is the wrong thing to KEEP: storing it would
 * hold a half-list for an hour and turn one bad minute into an hour of missing
 * chair names, with nothing on the screen saying so after the first request.
 *
 * So only a clean, complete read is cached. A partial one is served to the
 * caller that asked for it and forgotten.
 */

const odOffices = require('../config/odOffices');

/**
 * An hour. See the header: this holds configuration, not clinical facts.
 *
 * The number is the same one `services/commlogTypes.js` uses, deliberately —
 * two different hours for two lists of practice configuration would be two
 * numbers to reason about and no extra safety.
 */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * The only resources this file will hold.
 *
 * A closed set rather than "whatever path you pass": it is what stops
 * `/patients` — or anything else clinical — being cached for an hour by a
 * caller who did not read the header.
 */
const CONFIG_RESOURCES = Object.freeze(['appointmenttypes', 'providers', 'operatories']);

/**
 * A non-negative integer from the environment, or the default. `0` turns the
 * cache off (every read is a miss), which is a useful thing to be able to do
 * from an app setting without a deploy. Garbage falls back rather than
 * disabling anything by accident.
 *
 * @param {unknown} raw @param {number} fallback @returns {number}
 */
function parseNonNegative(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/** How long a config list is served without re-reading Open Dental. @returns {number} */
function ttlMs() {
  return parseNonNegative(process.env.OD_CONFIG_CACHE_TTL_MS, DEFAULT_TTL_MS);
}

/**
 * `office::resource` → `{ rows, storedAt }`.
 *
 * No eviction policy and none needed: the key space is the registry's offices
 * times the three resources above, so it is bounded by construction at six
 * entries. That is only true because both halves of the key are validated.
 *
 * @type {Map<string, { rows: unknown[], storedAt: number }>}
 */
const cache = new Map();

/**
 * The cache key, and the two guards that keep it bounded and per-practice.
 *
 * THROWS rather than defaulting, for the same reason `odPatientCache.cacheKey`
 * does: a caller that has not established which practice it is talking about
 * has not earned an answer, and a loud throw in a test run is the cheapest
 * place to find that out.
 *
 * @param {string} officeKey a frozen internal office key ('roland' | 'valley')
 * @param {string} resource one of CONFIG_RESOURCES
 * @returns {string}
 */
function cacheKey(officeKey, resource) {
  if (typeof officeKey !== 'string' || officeKey.trim() === '') {
    throw new Error('[odConfigCache] an office key is required — chairs and providers are per-practice');
  }
  if (!Object.prototype.hasOwnProperty.call(odOffices.OFFICE_OD_SETTINGS, officeKey)) {
    throw new Error(
      `[odConfigCache] '${officeKey}' is not an Open Dental office — refusing to cache under it`
    );
  }
  if (!CONFIG_RESOURCES.includes(resource)) {
    throw new Error(
      `[odConfigCache] '${resource}' is not practice configuration. Only ` +
        `${CONFIG_RESOURCES.join(', ')} may be cached for an hour — see the header.`
    );
  }
  return officeKey + '::' + resource;
}

/**
 * A config list, from the cache or from Open Dental.
 *
 * `load()` is the CALLER's transport — the same discipline the rest of the
 * hygiene module follows, so this file cannot reach Open Dental on its own and
 * a test drives it with a plain function. It must resolve
 * `{ rows, error, truncated }`, which is `pagedList`'s shape.
 *
 * @param {string} officeKey
 * @param {string} resource
 * @param {() => Promise<{ rows: unknown[], error: string|null, truncated: boolean }>} load
 * @returns {Promise<{ rows: unknown[], error: string|null, truncated: boolean,
 *                     source: 'cache'|'od' }>}
 */
async function getList(officeKey, resource, load) {
  const key = cacheKey(officeKey, resource);
  const ttl = ttlMs();

  if (ttl > 0) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.storedAt < ttl) {
      return { rows: hit.rows, error: null, truncated: false, source: 'cache' };
    }
    // Expired. Delete BEFORE the read so a failed refresh cannot fall back onto
    // it — the same rule odPatientCache follows, for a milder reason: an hour
    // of stale chair names is not dangerous, but "stale is never served" is
    // easier to keep true than "stale is served only when it is harmless".
    if (hit) cache.delete(key);
  }

  const read = await load();
  const clean = read.error === null && read.truncated !== true;
  if (ttl > 0 && clean) {
    cache.set(key, { rows: read.rows, storedAt: Date.now() });
  }
  return { rows: read.rows, error: read.error, truncated: read.truncated === true, source: 'od' };
}

/**
 * Counts for an ops surface. Never rows — a cache summary must stay a summary.
 * @returns {{ entries: number, ttlMs: number }}
 */
function stats() {
  return { entries: cache.size, ttlMs: ttlMs() };
}

/**
 * Forget everything. TESTS ONLY — in the app the TTL is what manages this.
 * @returns {void}
 */
function resetOdConfigCache() {
  cache.clear();
}

module.exports = {
  DEFAULT_TTL_MS,
  CONFIG_RESOURCES,
  ttlMs,
  cacheKey,
  getList,
  stats,
  resetOdConfigCache,
};
