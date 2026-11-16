'use strict';

/**
 * The reader for office_setting. SERVING since MT-2b: the ten per-office
 * readers (config/tcOfficeSwitch.js, hygPilot.js, tcNurture.js,
 * tcOpportunities.js, emailIdentity.js) answer their STORED layer from here,
 * for (tenant, office). platform_setting is still written in the same
 * transaction (registry.setPlatformSetting) so a rollback is a source flip,
 * and the parity tripwire (platform/officeSettingsParity.js) now reports
 * office_setting as the SERVED side.
 *
 * CACHE RULES (unchanged from MT-2a):
 *   - ONE cached read of ALL of a tenant's rows (every office, every key).
 *   - A read stays fresh for the refresh window (default 5 minutes,
 *     TC_SWITCH_REFRESH_MINUTES).
 *   - Concurrent callers share one read.
 *   - Never read at all => nothing is served ("nobody chose").
 *
 * WHAT IS SERVED, AND WHEN (MT-2b). servedRows() / servedCell() hand out the
 * rows of the LAST SUCCESSFUL read while both of these hold, and otherwise
 * answer "nobody chose" (null):
 *   - a read has succeeded at least once;
 *   - that success is younger than 3 x the refresh window (15 minutes by
 *     default).
 * A FAILED refresh therefore keeps serving the last good read, up to that
 * bound. This is the original tcOfficeSwitch rule: a control-plane blip must
 * not flip a feature either way. Serving nothing after a few-second blip would
 * switch tc_checkout_enabled / tc_referrals_enabled (and every other switch)
 * OFF for a refresh window, and drop tc_email_identity to the app-setting
 * fallback, so a letter sent in the blip would carry the wrong reply-to.
 * The staleness is BOUNDED: when every refresh keeps failing past 3 windows,
 * nothing is served, and the readers fall to their env fallback (tenant
 * 'carein' only), then to the floor, OFF. (officeRegistry.servedOffices drops
 * its rows on the first failed read instead. That suits the registry, because
 * its fallback, the code maps, gives the same answer. Settings have no such
 * fallback.)
 * And only rows for one of the tenant's OWN offices are served
 * (officeRegistry.isTenantOffice): a key is an office of tenant T only if T has
 * an active office row (or, for 'carein' with an unreadable registry, the code
 * maps). 'unknown' never holds a setting.
 *
 * Stuck-off-safe is the point: every failure mode answers "nobody chose", and
 * no reader can turn "nobody chose" into ON except tenant 'carein's env
 * `=true` fallback, exactly as before.
 *
 * get() never throws. No value is ever logged here (tc_email_identity holds
 * email addresses and practice names).
 */

const registry = require('./registry');
const officeRegistry = require('./officeRegistry');

/**
 * @typedef {Object} OfficeSettingValue
 * @property {unknown} value
 * @property {string|null} updatedAt ISO
 * @property {string|null} updatedBy
 */

/**
 * @typedef {Object} TenantCache
 * @property {boolean} loaded       ever read successfully
 * @property {boolean} lastOk       the most recent attempt succeeded (diagnostics; NOT the served rule)
 * @property {number} loadedAt      last attempt (ms); 0 = never
 * @property {number} lastSuccessAt last SUCCESSFUL read (ms); 0 = never (MT-2b)
 * @property {Map<string, OfficeSettingValue>} byKey  `${officeKey}\u0000${settingKey}` -> value
 * @property {Promise<{ ok: boolean, error: string|null }>|null} inFlight
 * @property {string|null} lastLoggedError
 * @property {number} generation   bumped by invalidate(); a read started before it is discarded
 */

/** @type {Map<string, TenantCache>} */
const caches = new Map();

/** @type {Array<(tenantSlug: string) => void>} */
const listeners = [];

/** @type {ReturnType<typeof setInterval>|null} */
let refreshTimer = null;

/** Minutes a cached read stays fresh (default 5). @returns {number} */
function refreshMinutes() {
  const raw = Number(String(process.env.TC_SWITCH_REFRESH_MINUTES ?? '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/** How old the last SUCCESSFUL read may be and still be served: 3 windows. @returns {number} ms */
function maxServedAgeMs() {
  return 3 * refreshMinutes() * 60 * 1000;
}

/** @param {unknown} tenantSlug @returns {tenantSlug is string} */
function isSlug(tenantSlug) {
  return typeof tenantSlug === 'string' && tenantSlug !== '';
}

/** @param {string} tenantSlug @returns {TenantCache} */
function cacheFor(tenantSlug) {
  let c = caches.get(tenantSlug);
  if (!c) {
    c = {
      loaded: false,
      lastOk: false,
      loadedAt: 0,
      lastSuccessAt: 0,
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
 * Be told about every SUCCESSFUL read of a tenant (the parity tripwire). A
 * failed read notifies nobody.
 * @param {(tenantSlug: string) => void} listener
 * @returns {void}
 */
function onRefresh(listener) {
  listeners.push(listener);
}

/**
 * Re-read every row of one tenant. NEVER THROWS. A failed read keeps the
 * previous rows, and they stay SERVED until the last success is older than
 * maxServedAgeMs() — see the header.
 * @param {string} tenantSlug
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function refreshFromDb(tenantSlug) {
  if (!isSlug(tenantSlug)) return { ok: false, error: 'no tenant' };
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
    c.lastSuccessAt = c.loadedAt;
    c.lastLoggedError = null;
    for (const listener of listeners) {
      try {
        listener(tenantSlug);
      } catch (err) {
        console.error(`[officeSettings] refresh listener threw: ${err && err.message ? err.message : String(err)}`);
      }
    }
    return { ok: true, error: null };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (message !== c.lastLoggedError) {
      const servingUntil = c.lastSuccessAt ? c.lastSuccessAt + maxServedAgeMs() : 0;
      const what =
        servingUntil > Date.now()
          ? `serving the last good read (${new Date(c.lastSuccessAt).toISOString()}) until ` +
            `${new Date(servingUntil).toISOString()} unless a read succeeds first; after that the readers fall back, then OFF`
          : 'no good read to serve: the readers fall back, then OFF, until a read succeeds';
      console.error(`[officeSettings] could not read office_setting for '${tenantSlug}': ${message} (${what})`);
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
  if (!isSlug(tenantSlug)) return { ok: false, loaded: false };
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
 * ensureFresh() for a reader's request path: also reads the tenant's office
 * REGISTRY when it is not the code-map tenant (whose registry read is kept
 * fresh by officeRegistry's own timer), because which keys are the tenant's
 * offices comes from there (MT-1c). Never throws.
 * @param {unknown} tenantSlug
 * @returns {Promise<{ ok: boolean, loaded: boolean }>}
 */
async function ensureTenantFresh(tenantSlug) {
  if (!isSlug(tenantSlug)) return { ok: false, loaded: false };
  if (tenantSlug !== officeRegistry.CODE_MAP_TENANT_SLUG) {
    await officeRegistry.ensureFresh(tenantSlug).catch(() => {});
  }
  return ensureFresh(tenantSlug);
}

/**
 * Why nothing is served for this tenant right now, or null when its rows are.
 * Synchronous, never reads, never throws.
 * @param {unknown} tenantSlug
 * @returns {string|null}
 */
function notServedReason(tenantSlug) {
  if (!isSlug(tenantSlug)) return 'no tenant';
  const c = caches.get(tenantSlug);
  if (!c || !c.loaded) return 'office_setting has never been read';
  if (Date.now() - c.lastSuccessAt > maxServedAgeMs()) return 'the last good office_setting read is stale';
  return null;
}

/** @param {unknown} tenantSlug @returns {boolean} */
function isServed(tenantSlug) {
  return notServedReason(tenantSlug) === null;
}

/**
 * The SERVED rows of one key for one tenant: officeKey -> value, the tenant's
 * own offices only. null = nothing is served (see the header), which every
 * reader reads as "nobody chose". Synchronous.
 * @param {unknown} tenantSlug
 * @param {string} settingKey
 * @returns {Map<string, unknown>|null}
 */
function servedRows(tenantSlug, settingKey) {
  if (!isServed(tenantSlug)) return null;
  const c = /** @type {TenantCache} */ (caches.get(/** @type {string} */ (tenantSlug)));
  /** @type {Map<string, unknown>} */
  const out = new Map();
  for (const [k, v] of c.byKey) {
    const [officeKey, key] = k.split('\u0000');
    if (key !== settingKey) continue;
    if (!officeRegistry.isTenantOffice(tenantSlug, officeKey)) continue;
    out.set(officeKey, v.value);
  }
  return out;
}

/**
 * One SERVED cell, with its provenance. null = nobody chose, not served, or
 * not one of the tenant's offices. Synchronous.
 * @param {unknown} tenantSlug
 * @param {unknown} officeKey
 * @param {string} settingKey
 * @returns {OfficeSettingValue|null}
 */
function servedCell(tenantSlug, officeKey, settingKey) {
  if (!isServed(tenantSlug) || !officeRegistry.isTenantOffice(tenantSlug, officeKey)) return null;
  const c = /** @type {TenantCache} */ (caches.get(/** @type {string} */ (tenantSlug)));
  return c.byKey.get(cellKey(/** @type {string} */ (officeKey), settingKey)) || null;
}

/**
 * One cell from the cache, without reading and WITHOUT the served rule
 * (diagnostics and the tripwire only — never a reader). Synchronous.
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @param {string} settingKey
 * @returns {OfficeSettingValue|null}
 */
function peek(tenantSlug, officeKey, settingKey) {
  const c = caches.get(tenantSlug);
  if (!c || !c.loaded) return null;
  return c.byKey.get(cellKey(officeKey, settingKey)) || null;
}

/**
 * Every office that holds a row for one key, from the cache, WITHOUT the
 * served rule (the tripwire only). Synchronous.
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
 * Refresh if stale, then answer one SERVED cell.
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @param {string} settingKey
 * @returns {Promise<OfficeSettingValue|null>}
 */
async function get(tenantSlug, officeKey, settingKey) {
  await ensureFresh(tenantSlug);
  return servedCell(tenantSlug, officeKey, settingKey);
}

/**
 * Mark one tenant's cache stale so the next ensureFresh() re-reads. Called
 * after a dual-write commits. The rows already cached stay SERVED until that
 * re-read (a sync reader must not flap OFF in the gap); every writer re-reads
 * inline right after.
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

/**
 * The offices an 'on'-kind setting (tc_nurture_enabled, tc_opportunities_sync)
 * switches ON for one tenant, read FRESH from office_setting — no cache: those
 * readers run once a pass and never hold a copy. Never throws; every failure
 * is "nothing is on".
 *
 * ON only for one of the tenant's own offices holding the literal `true`.
 *
 * @param {unknown} tenantSlug
 * @param {string} settingKey
 * @param {{ listOfficeSettings?: (slug: string) => Promise<Array<{ office_key: string, setting_key: string, value: unknown }>> }} [deps]
 *        the registry (default: platform/registry.js) — injectable for tests
 * @returns {Promise<{ offices: string[], reason: string|null }>}
 */
async function switchedOnFromDb(tenantSlug, settingKey, deps = registry) {
  if (!isSlug(tenantSlug)) return { offices: [], reason: 'NO_TENANT' };
  const { answerFromRows } = require('./officeSettingKeys');
  if (tenantSlug !== officeRegistry.CODE_MAP_TENANT_SLUG) {
    await officeRegistry.ensureFresh(tenantSlug).catch(() => {});
  }
  let rows;
  try {
    const list = deps && typeof deps.listOfficeSettings === 'function' ? deps.listOfficeSettings : registry.listOfficeSettings;
    rows = await list.call(deps, tenantSlug);
  } catch (err) {
    return { offices: [], reason: `CONTROL_PLANE_UNREADABLE: ${(err && err.message) || err}` };
  }
  /** @type {Map<string, unknown>} */
  const mine = new Map();
  for (const r of rows || []) {
    if (r && r.setting_key === settingKey && officeRegistry.isTenantOffice(tenantSlug, r.office_key)) {
      mine.set(r.office_key, r.value);
    }
  }
  if (mine.size === 0) return { offices: [], reason: 'NO_SETTING_ROW' };
  const offices = [...mine.keys()].filter((o) => answerFromRows(settingKey, mine, o) === true).sort();
  return { offices, reason: offices.length ? null : 'NO_OFFICE_SWITCHED_ON' };
}

/**
 * Every ACTIVE tenant's slug, for the background jobs (MT-2b):
 * registry.listTenants() filtered to status 'active'. When the list cannot be
 * read, the code-map tenant ('carein') alone, with the error — the jobs that
 * use this read Open Dental through carein's handles and have always run for
 * carein; its own office_setting read still has to succeed before anything is
 * ON for it. Never throws.
 * @returns {Promise<{ slugs: string[], error: string|null }>}
 */
async function activeTenantSlugs() {
  try {
    const tenants = await registry.listTenants();
    const slugs = (tenants || [])
      .filter((t) => t && t.status === 'active' && isSlug(t.slug))
      .map((t) => t.slug);
    return { slugs, error: null };
  } catch (err) {
    return {
      slugs: [officeRegistry.CODE_MAP_TENANT_SLUG],
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * The background refresh: every ACTIVE tenant's office_setting and office
 * registry reads, in turn. Never throws. Used by the readers' timers, so a
 * synchronous request-path reader (hygiene, the email identity) never serves
 * a read older than the window for any tenant.
 * @returns {Promise<{ tenants: string[], error: string|null }>}
 */
async function refreshActiveTenants() {
  const { slugs, error } = await activeTenantSlugs();
  if (error) {
    // Nothing read => after the window nothing is served => OFF. Still try the
    // code-map tenant, whose readers have always refreshed on a timer.
    await refreshFromDb(officeRegistry.CODE_MAP_TENANT_SLUG);
    return { tenants: slugs, error };
  }
  for (const slug of slugs) {
    if (slug !== officeRegistry.CODE_MAP_TENANT_SLUG) {
      await officeRegistry.refreshFromDb(slug).catch(() => {});
    }
    await refreshFromDb(slug);
  }
  return { tenants: slugs, error: null };
}

/** Start the shared background refresh. Idempotent; unref'd. @returns {boolean} armed by this call */
function startRefreshTimer() {
  if (refreshTimer) return false;
  refreshTimer = setInterval(() => {
    refreshActiveTenants().catch(() => {});
  }, refreshMinutes() * 60 * 1000);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  return true;
}

/** @returns {void} */
function stopRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** TESTS ONLY. Listeners stay registered. @returns {void} */
function resetCacheForTests() {
  caches.clear();
  stopRefreshTimer();
}

module.exports = {
  refreshMinutes,
  maxServedAgeMs,
  onRefresh,
  refreshFromDb,
  ensureFresh,
  ensureTenantFresh,
  notServedReason,
  isServed,
  servedRows,
  servedCell,
  peek,
  rowsForKey,
  get,
  invalidate,
  switchedOnFromDb,
  activeTenantSlugs,
  refreshActiveTenants,
  startRefreshTimer,
  stopRefreshTimer,
  resetCacheForTests,
};
