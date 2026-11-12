'use strict';

/**
 * The reader for office_setting (MT-2a). DARK: nothing is SERVED from here yet.
 *
 * In MT-2a its only consumer is the parity tripwire
 * (platform/officeSettingsParity.js), which compares what each of the ten
 * readers resolved from platform_setting with what this table holds. MT-2b
 * switches the readers over to it.
 *
 * CACHE RULES — copied from config/tcOfficeSwitch.js, verbatim in substance:
 *   - ONE cached read of ALL of a tenant's rows (every office, every key).
 *   - A read stays fresh for the refresh window (default 5 minutes,
 *     TC_SWITCH_REFRESH_MINUTES — the same knob as the switches it shadows).
 *   - Concurrent callers share one read.
 *   - A failed refresh KEEPS THE PREVIOUS CACHE: a control-plane blip must not
 *     flip a setting either way.
 *   - Never read at all => get() answers null, which means "nobody chose".
 *
 * get() never throws. No value is ever logged here (tc_email_identity holds
 * email addresses and practice names).
 */

const registry = require('./registry');

/**
 * @typedef {Object} OfficeSettingValue
 * @property {unknown} value
 * @property {string|null} updatedAt ISO
 * @property {string|null} updatedBy
 */

/**
 * @typedef {Object} TenantCache
 * @property {boolean} loaded       ever read successfully
 * @property {boolean} lastOk       the most recent attempt succeeded
 * @property {number} loadedAt      last attempt (ms); 0 = never
 * @property {Map<string, OfficeSettingValue>} byKey  `${officeKey}\u0000${settingKey}` -> value
 * @property {Promise<{ ok: boolean, error: string|null }>|null} inFlight
 * @property {string|null} lastLoggedError
 * @property {number} generation   bumped by invalidate(); a read started before it is discarded
 */

/** @type {Map<string, TenantCache>} */
const caches = new Map();

/** Minutes a cached read stays fresh (default 5). @returns {number} */
function refreshMinutes() {
  const raw = Number(String(process.env.TC_SWITCH_REFRESH_MINUTES ?? '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/** @param {string} tenantSlug @returns {TenantCache} */
function cacheFor(tenantSlug) {
  let c = caches.get(tenantSlug);
  if (!c) {
    c = {
      loaded: false,
      lastOk: false,
      loadedAt: 0,
      byKey: new Map(),
      inFlight: null,
      lastLoggedError: null,
      generation: 0,
    };
    caches.set(tenantSlug, c);
  }
  return c;
}

/** @param {string} officeKey @param {string} settingKey */
function cellKey(officeKey, settingKey) {
  return `${officeKey}\u0000${settingKey}`;
}

/**
 * Re-read every row of one tenant. NEVER THROWS; a failed read keeps the cache.
 * @param {string} tenantSlug
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function refreshFromDb(tenantSlug) {
  const c = cacheFor(tenantSlug);
  const generation = c.generation;
  try {
    const rows = await registry.listOfficeSettings(tenantSlug);
    // invalidate() ran while this read was in flight: what it read may predate
    // a write that has since committed. Report success, keep nothing.
    if (generation !== c.generation) return { ok: true, error: null };
    /** @type {Map<string, OfficeSettingValue>} */
    const byKey = new Map();
    for (const row of rows) {
      byKey.set(cellKey(row.office_key, row.setting_key), {
        value: row.value,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        updatedBy: row.updated_by || null,
      });
    }
    c.byKey = byKey;
    c.loaded = true;
    c.lastOk = true;
    c.loadedAt = Date.now();
    c.lastLoggedError = null;
    return { ok: true, error: null };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (message !== c.lastLoggedError) {
      console.error(`[officeSettings] could not read office_setting for '${tenantSlug}': ${message}`);
      c.lastLoggedError = message;
    }
    // Stamp the attempt so a down control plane is not re-asked on every call.
    c.loadedAt = Date.now();
    c.lastOk = false;
    return { ok: false, error: message };
  }
}

/**
 * Refresh when the cache is older than the window. Concurrent callers share one read.
 * @param {string} tenantSlug
 * @returns {Promise<{ ok: boolean, loaded: boolean }>} whether the MOST RECENT read succeeded
 */
async function ensureFresh(tenantSlug) {
  const c = cacheFor(tenantSlug);
  if (!(c.loadedAt && Date.now() - c.loadedAt < refreshMinutes() * 60 * 1000)) {
    if (!c.inFlight) {
      const p = refreshFromDb(tenantSlug).finally(() => {
        if (c.inFlight === p) c.inFlight = null;
      });
      c.inFlight = p;
    }
    await c.inFlight;
    // A read discarded by invalidate() leaves loadedAt at 0: read again, once.
    if (!c.loadedAt) await refreshFromDb(tenantSlug);
  }
  return { ok: c.lastOk, loaded: c.loaded };
}

/**
 * One cell from the cache, without reading. Synchronous.
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @param {string} settingKey
 * @returns {OfficeSettingValue|null} null = nobody chose (or never read)
 */
function peek(tenantSlug, officeKey, settingKey) {
  const c = caches.get(tenantSlug);
  if (!c || !c.loaded) return null;
  return c.byKey.get(cellKey(officeKey, settingKey)) || null;
}

/**
 * Every office that holds a row for one key, from the cache. Synchronous.
 * @param {string} tenantSlug
 * @param {string} settingKey
 * @returns {Map<string, unknown>} officeKey -> value
 */
function rowsForKey(tenantSlug, settingKey) {
  /** @type {Map<string, unknown>} */
  const out = new Map();
  const c = caches.get(tenantSlug);
  if (!c || !c.loaded) return out;
  for (const [k, v] of c.byKey) {
    const [officeKey, key] = k.split('\u0000');
    if (key === settingKey) out.set(officeKey, v.value);
  }
  return out;
}

/**
 * THE getter: refresh if stale, then answer.
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @param {string} settingKey
 * @returns {Promise<OfficeSettingValue|null>}
 */
async function get(tenantSlug, officeKey, settingKey) {
  await ensureFresh(tenantSlug);
  return peek(tenantSlug, officeKey, settingKey);
}

/**
 * Mark one tenant's cache stale so the next ensureFresh() re-reads. Called
 * after a dual-write commits, so the tripwire never compares a fresh
 * platform_setting read with an office_setting read from before the write.
 * @param {string} tenantSlug
 * @returns {void}
 */
function invalidate(tenantSlug) {
  const c = caches.get(tenantSlug);
  if (!c) return;
  c.loadedAt = 0;
  c.generation += 1;
  c.inFlight = null;
}

/** TESTS ONLY. @returns {void} */
function resetCacheForTests() {
  caches.clear();
}

module.exports = {
  refreshMinutes,
  refreshFromDb,
  ensureFresh,
  peek,
  rowsForKey,
  get,
  invalidate,
  resetCacheForTests,
};
