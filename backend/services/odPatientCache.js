'use strict';

/**
 * Shared per-office cache of Open Dental patient records.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ARITHMETIC THIS EXISTS TO FIX
 * ═════════════════════════════════════════════════════════════════════════════
 * Open Dental's cloud API throttles at ONE REQUEST PER SECOND PER CREDENTIAL,
 * and the reservation slot is shared by every module on that credential
 * (`OD_SLOTS` / `odSlotKeyFor` in config/openDental.js). `GET /appointments`
 * returns `PatNum` and no name, and Open Dental offers no bulk patient read, so
 * naming the people on a day costs one `GET /patients/{PatNum}` per DISTINCT
 * patient — which the throttle turns into one SECOND per distinct patient.
 *
 * A 40-patient day is therefore 40+ seconds before the hygiene Day View paints.
 *
 * **CONCURRENCY IS NOT THE LEVER, AND RAISING ONE IS NOT A FIX.**
 * routes/tc/odReads.js already runs this exact fan-out through
 * `mapLimit(top, OD_CONCURRENCY = 5, ...)` and gets no benefit from it: the
 * shared per-credential slot serializes the requests whatever the caller's
 * concurrency number says. All a higher number buys is a burstier share of a
 * slot the voice path is also waiting on (decision D-8). If you are here
 * because a screen is slow and you are about to raise a concurrency constant —
 * that is the thing that does not work. The two levers that do are DON'T ASK
 * TWICE (this file) and ASK BEFORE ANYONE IS WAITING (services/hygDayWarm.js).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS CACHED: THE RAW OPEN DENTAL RECORD, NOT A MODULE'S SHAPE
 * ═════════════════════════════════════════════════════════════════════════════
 * The value is the body Open Dental returned for `GET /patients/{PatNum}`,
 * untouched. Every module keeps its own normalizer and runs it on the way out.
 *
 * That is what lets three modules share one entry. If this cached hyg's
 * `{displayName, premed, ...}` shape, TC and RCM could not read it, and a cache
 * per module would defeat the point — the whole win is that a patient TC looked
 * at ten seconds ago is free for hyg, on the same credential, in the same
 * second.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. THE KEY IS office + PatNum. THIS IS THE ONE THAT MUST NOT BE WRONG.
 * ═════════════════════════════════════════════════════════════════════════════
 * **PatNum numbering restarts in every Open Dental database.** 7115 is the
 * valley test patient AND a different, real person in roland. A cache keyed on
 * PatNum alone would serve one practice's patient under another practice's
 * name: a cross-office PHI disclosure, and the worst bug available in this
 * codebase.
 *
 * So `cacheKey()` below REFUSES a missing, empty or unregistered office rather
 * than defaulting one. There is no code path that can store or read an entry
 * without naming the practice it belongs to, and the office must be a key of
 * the Open Dental registry — never a string off a request.
 * `odPatientCache.test.js` drives it from both directions.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. THE TTL IS SHORT, AND DELIBERATELY NOT THE commlogTypes NUMBER
 * ═════════════════════════════════════════════════════════════════════════════
 * services/commlogTypes.js caches for an HOUR and is right to: it holds
 * practice CONFIGURATION, edited months apart.
 *
 * **Patient records are not configuration.** A premed flag or a medical alert
 * can be added to a chart mid-morning, and this cache feeds a screen a
 * hygienist reads standing at a chair with an instrument in their hand.
 *
 * Five minutes collapses the bursts that actually happen — a refresh, a back
 * navigation, flipping to tomorrow and back, two hygienists opening the same
 * day — and cannot put a medical alert added at 9:02 in front of somebody at
 * 9:40. **The next person to read this will be tempted to raise it.** The
 * reason not to is that every minute added is a minute in which an alert
 * entered in Open Dental is invisible here, and nothing on the screen would say
 * so. If a longer window is ever genuinely needed, the honest change is to stop
 * carrying clinical flags in the cached value — not to age them further.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. STALE IS NEVER SERVED. NOT EVEN ON A FAILED REFRESH.
 * ═════════════════════════════════════════════════════════════════════════════
 * commlogTypes serves a stale list when a refresh fails, and is right to: a
 * stale list of definitions beats an error toast, and none of it is clinical.
 *
 * **This cache does the exact opposite.** Past the TTL the entry is DELETED
 * before the refresh is attempted, so a failed refresh has nothing to fall back
 * onto and returns a miss. The caller then renders that patient the way a
 * failed read already renders — no name, null flags, and the warning it already
 * emits.
 *
 * The reason is that `premed`, `MedUrgNote` and the patient's name arrive in
 * ONE record. A stale name is harmless; a stale medical alert is not; and
 * splitting them so the harmless half could be served would mean deciding, per
 * field, which staleness is safe. Refusing to split is the safe choice, and
 * deleting on expiry is how that refusal is made structural rather than
 * remembered.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 4. AUDIT IS NOT THIS FILE'S JOB, AND THAT IS THE TRAP
 * ═════════════════════════════════════════════════════════════════════════════
 * A PHI-read audit row records a DISCLOSURE TO A USER, not a fetch from Open
 * Dental. **A cache hit still discloses that patient.** So the audit row must
 * fire on a hit exactly as it does on a miss, which means it must be written by
 * the route, downstream of this cache, from what it is about to send.
 *
 * routes/hyg/day.js audits from `day.appointments`, so it is already correct —
 * and `routes/hyg/hygDayCache.test.js` pins it: the same day loaded twice
 * issues zero patient reads the second time AND writes the same number of
 * `hyg_day_patient` rows.
 *
 * **NEVER move an audit call inside this file.** It would silently convert the
 * trail from "who was shown to whom" into "what we happened to fetch", and the
 * better the cache got the emptier the trail would be.
 *
 * services/hygDayWarm.js is the mirror image of the same rule: the warm READS
 * without disclosing, so it writes no audit rows at all.
 */

const odOffices = require('../config/odOffices');

/** See §2 of the header before changing this. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Entry ceiling, across all offices.
 *
 * Bounded because this is PHI held in process memory: unbounded, a practice's
 * whole patient list would accumulate here over weeks and never leave. 2,000
 * records is many multiples of any single day across both offices and small
 * enough to be uninteresting next to the call store.
 *
 * `maxReplicas` is 1, so this is one process — which is a reason the bound
 * matters (nothing else will evict for us), not a reason to skip it.
 */
const DEFAULT_MAX_ENTRIES = 2000;

/**
 * A non-negative integer from the environment, or the default.
 *
 * Zero is ACCEPTED and meaningful for both knobs: `HYG_PATIENT_CACHE_TTL_MS=0`
 * turns caching off (every read is a miss) and `..._MAX_ENTRIES=0` stops
 * anything being retained. Garbage and negatives fall back to the default
 * rather than disabling the cache by accident.
 *
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function parseNonNegative(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/** How long a fetched record is served without re-reading Open Dental. @returns {number} */
function ttlMs() {
  return parseNonNegative(process.env.OD_PATIENT_CACHE_TTL_MS, DEFAULT_TTL_MS);
}

/** Ceiling on retained records, across every office. @returns {number} */
function maxEntries() {
  return parseNonNegative(process.env.OD_PATIENT_CACHE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES);
}

/**
 * office+PatNum → { record, storedAt }.
 *
 * A plain Map, used as an LRU: JavaScript Maps iterate in INSERTION order, so
 * re-inserting on every touch puts the most recently used entry last and makes
 * `keys().next().value` the least recently used one. That is the whole eviction
 * policy — no library, no timers.
 *
 * @type {Map<string, { record: Record<string, unknown>, storedAt: number }>}
 */
const cache = new Map();

/**
 * Reads currently in flight, same key space.
 *
 * Without this, two hygienists opening the same day at the same moment issue
 * two `GET /patients/{PatNum}` per patient against a credential that can serve
 * one request a second — so the second one waits for the first one's requests
 * AND pays for its own. Collapsing them is worth as much as the cache itself on
 * the first load of a day, which is the load that matters.
 *
 * @type {Map<string, Promise<{ ok: boolean, record: Record<string, unknown>|null }>>}
 */
const inFlight = new Map();

/**
 * The cache key, and the cross-office guard.
 *
 * THROWS rather than defaulting. A caller that has not resolved an office has
 * not established which database its PatNum came from, and the failure mode of
 * guessing is serving one practice's patient under another practice's name (§1).
 * A loud throw in a test run is the cheapest possible place to find that out.
 *
 * The office must be a key of the Open Dental registry, so a value that reached
 * here off a request without being validated cannot mint a namespace of its own.
 *
 * `::` is the separator because office keys are lowercase letters and PatNums
 * are digits, so no pair of inputs can collide into one key.
 *
 * @param {string} officeKey a frozen internal office key ('roland' | 'valley')
 * @param {number} patNum
 * @returns {string}
 */
function cacheKey(officeKey, patNum) {
  if (typeof officeKey !== 'string' || officeKey.trim() === '') {
    throw new Error('[odPatientCache] an office key is required — a bare PatNum identifies nobody');
  }
  if (!Object.prototype.hasOwnProperty.call(odOffices.OFFICE_OD_SETTINGS, officeKey)) {
    throw new Error(
      `[odPatientCache] '${officeKey}' is not an Open Dental office — refusing to cache under it`
    );
  }
  if (!Number.isInteger(patNum) || patNum <= 0) {
    throw new Error(`[odPatientCache] PatNum must be a positive integer, got ${JSON.stringify(patNum)}`);
  }
  return officeKey + '::' + patNum;
}

/**
 * Store a record, evicting the least recently used entries past the bound.
 * @param {string} key
 * @param {Record<string, unknown>} record
 * @returns {void}
 */
function store(key, record) {
  const max = maxEntries();
  if (max <= 0) return;

  // delete-then-set moves the key to the end of the insertion order, which is
  // what makes the first key the least recently used one.
  cache.delete(key);
  cache.set(key, { record, storedAt: Date.now() });

  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Is there a FRESH entry for this patient? Does not fetch and does not touch
 * the LRU order — for the warm's logging and for tests.
 * @param {string} officeKey
 * @param {number} patNum
 * @returns {boolean}
 */
function hasFresh(officeKey, patNum) {
  const ttl = ttlMs();
  if (ttl <= 0) return false;
  const entry = cache.get(cacheKey(officeKey, patNum));
  return Boolean(entry && Date.now() - entry.storedAt < ttl);
}

/**
 * One patient's raw Open Dental record, from cache when fresh, otherwise read.
 *
 * `readOne` is the CALLER's transport — the same discipline services/hyg/odDay.js
 * uses for `odGet`. This file never imports an Open Dental client, so it can
 * neither reach a write verb nor choose which office it is talking to.
 *
 * `source` says where the answer came from, and callers use it to count:
 *   `cache`     served from a fresh entry; NO Open Dental request was made
 *   `inflight`  waited on an identical read already running; also no request
 *   `fetch`     `readOne` was invoked; this is the one that costs a second
 *
 * A failed read is NOT cached. Caching a failure would make a transient blip
 * sticky for the whole TTL, and this is the record a chairside screen shows.
 *
 * @param {string} officeKey
 * @param {number} patNum
 * @param {(patNum: number) => Promise<{ ok: boolean, record: Record<string, unknown>|null }>} readOne
 * @returns {Promise<{ ok: boolean, record: Record<string, unknown>|null, source: 'cache'|'inflight'|'fetch' }>}
 */
async function getPatient(officeKey, patNum, readOne) {
  const key = cacheKey(officeKey, patNum);
  const ttl = ttlMs();

  const entry = cache.get(key);
  if (entry) {
    if (ttl > 0 && Date.now() - entry.storedAt < ttl) {
      // Touch, so the LRU order reflects use rather than arrival.
      cache.delete(key);
      cache.set(key, entry);
      return { ok: true, record: entry.record, source: 'cache' };
    }
    // EXPIRED. Dropped BEFORE the refresh is attempted, so a failure below has
    // nothing stale to fall back onto — see §3 of the header. This is the line
    // that makes "never serve a stale clinical flag" structural.
    cache.delete(key);
  }

  const running = inFlight.get(key);
  if (running) {
    const result = await running;
    return { ok: result.ok, record: result.record, source: 'inflight' };
  }

  const promise = (async () => {
    try {
      const res = await readOne(patNum);
      if (!res || !res.ok || !res.record || typeof res.record !== 'object') {
        return { ok: false, record: null };
      }
      store(key, res.record);
      return { ok: true, record: res.record };
    } catch (err) {
      // A transport that threw is one patient's read failing, not the day
      // failing — services/hyg/odDay.js already renders that as an unnamed card
      // plus a warning. PatNum is an identifier Open Dental minted, never a name.
      console.warn(
        `[odPatientCache] ${officeKey} PatNum ${patNum} read threw: ` +
          ((err && err.message) || String(err))
      );
      return { ok: false, record: null };
    }
  })();

  inFlight.set(key, promise);
  try {
    const result = await promise;
    return { ok: result.ok, record: result.record, source: 'fetch' };
  } finally {
    // Only clear our own promise: a later read for the same key may already
    // have replaced it.
    if (inFlight.get(key) === promise) inFlight.delete(key);
  }
}

/**
 * Counts for an ops surface and for the day read's one log line. Never a record
 * and never a PatNum — a cache summary must not become a list of who was seen.
 * @returns {{ entries: number, inFlight: number, ttlMs: number, maxEntries: number }}
 */
function stats() {
  return { entries: cache.size, inFlight: inFlight.size, ttlMs: ttlMs(), maxEntries: maxEntries() };
}

/**
 * Forget everything. TESTS ONLY — in the app the TTL and the bound are what
 * manage this, and a process-wide flush would hand the next request a cold
 * cache for no reason.
 * @returns {void}
 */
function resetOdPatientCache() {
  cache.clear();
  inFlight.clear();
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  ttlMs,
  maxEntries,
  cacheKey,
  hasFresh,
  getPatient,
  stats,
  resetOdPatientCache,
};
