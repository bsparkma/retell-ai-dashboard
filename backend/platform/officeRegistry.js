'use strict';

/**
 * The office registry, read from the control plane (MT-1a, SERVING since MT-1b).
 *
 * WHAT IT IS. A cached read of one tenant's rows in the control-plane `office`
 * table (migrations/1789400000000_office_registry.js), mapped to a domain
 * shape. Since MT-1b, config/officeAgents.js and config/odOffices.js ANSWER
 * from these rows, field by field, with their own code maps as the fallback.
 *
 * WHAT IS SERVED, AND WHEN (MT-1b). servedOffices() is the only door the
 * getters use. It is synchronous and never reads the database: a request never
 * waits on the control plane. It hands out the cached rows only while ALL of
 * these hold, and otherwise says why not, so the getters serve the CODE maps:
 *   - a read has succeeded at least once (absence -> code);
 *   - the MOST RECENT read succeeded (error -> code, immediately; the previous
 *     rows are not served on after a failed read);
 *   - that success is younger than 3 x the refresh window, 15 minutes by
 *     default (staleness -> code);
 *   - and only rows with status 'active' are handed out. A 'disabled' row is as
 *     good as absent, so that office serves the code maps.
 * The 'unknown' bucket can never come from here (the schema's CHECK refuses the
 * row, and this module drops one regardless). Office KEYS never come from here
 * at all: the getters only look up keys their own code maps already define.
 *
 * cachedOffices() and getOffices() keep their MT-1a meaning (the last good read,
 * kept through a failure). They are not what the getters serve from.
 *
 * THE PARITY TRIPWIRE STAYS. officeAgents and odOffices still compare every
 * successful read with their code maps and console.warn once per divergent
 * field. The warning now says which side is SERVED and, when it is the code,
 * why.
 *
 * CACHE RULES (copied from config/tcOfficeSwitch.js):
 *   - A read stays fresh for 5 minutes (OFFICE_REGISTRY_REFRESH_MINUTES).
 *   - Concurrent callers share ONE read.
 *   - A failed refresh keeps the previous cache. A control-plane blip must not
 *     make the offices disappear.
 *   - Never read at all, or never read successfully: getOffices() serves the
 *     CODE maps, tagged source 'code'.
 *
 * NO CYCLE. officeAgents and odOffices require THIS module (to register their
 * listeners). This module needs their maps only for the code fallback, so it
 * requires them lazily inside codeOffices(), at call time, after both have
 * finished loading. It must never require them at the top.
 *
 * No Open Dental calls, no secret values. The registry holds secret NAMES and
 * env var NAMES only, and that is all this module ever logs.
 */

const registry = require('./registry');

/**
 * The tenant whose offices the code maps describe. The code maps ARE this
 * tenant's configuration, so it is the only tenant parity can be checked for.
 */
const CODE_MAP_TENANT_SLUG = 'carein';

/**
 * @typedef {Object} RegistryOffice
 * @property {string} officeKey           frozen internal key
 * @property {string} displayName
 * @property {number} sortOrder
 * @property {string[]} retellAgentIds
 * @property {string[]} mangoDids          E.164
 * @property {string|null} odCustomerKeySecret  Key Vault secret NAME
 * @property {string|null} odCustomerKeyEnv     process.env variable NAME
 * @property {{ call: number|null, referral: number|null }} commTypeDefNums  null = unconfigured
 * @property {boolean} odEnabled
 * @property {boolean} hygOdEnabled        the hygiene FLOOR, not the live pilot switch
 * @property {'active'|'disabled'} status
 */

/**
 * @typedef {Object} OfficesRead
 * @property {'registry'|'code'} source  which answered
 * @property {RegistryOffice[]} offices
 */

/** Minutes a cached read stays fresh (default 5). @returns {number} */
function refreshMinutes() {
  const raw = Number(String(process.env.OFFICE_REGISTRY_REFRESH_MINUTES ?? '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/**
 * How old the last SUCCESSFUL read may be and still be served (MT-1b): three
 * refresh windows, so one slow timer tick does not flap the source, but a
 * control plane that has not answered for 15 minutes no longer does.
 * @returns {number} ms
 */
function maxServedAgeMs() {
  return 3 * refreshMinutes() * 60 * 1000;
}

// --- mapping ----------------------------------------------------------------

/** @param {unknown} v @returns {string[]} */
function stringArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

/** A DefNum: a positive integer, else null (UNCONFIGURED, never a guess). @param {unknown} v */
function defNum(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * A control-plane row → RegistryOffice. Lenient on purpose: the schema's CHECKs
 * already refuse a malformed row, and anything that still reads oddly becomes
 * an "unconfigured" value, which the parity check reports as a divergence.
 * @param {Record<string, unknown>} row
 * @returns {RegistryOffice}
 */
function mapRow(row) {
  const defnums =
    row.commtype_defnums && typeof row.commtype_defnums === 'object'
      ? /** @type {Record<string, unknown>} */ (row.commtype_defnums)
      : {};
  return {
    officeKey: String(row.office_key),
    displayName: String(row.display_name),
    sortOrder: Number(row.sort_order),
    retellAgentIds: stringArray(row.retell_agent_ids),
    mangoDids: stringArray(row.mango_dids),
    odCustomerKeySecret: typeof row.od_customer_key_secret === 'string' ? row.od_customer_key_secret : null,
    odCustomerKeyEnv: typeof row.od_customer_key_env === 'string' ? row.od_customer_key_env : null,
    commTypeDefNums: { call: defNum(defnums.call), referral: defNum(defnums.referral) },
    odEnabled: row.od_enabled === true,
    hygOdEnabled: row.hyg_od_enabled === true,
    status: row.status === 'disabled' ? 'disabled' : 'active',
  };
}

/**
 * The CODE maps in the registry's shape: what the registry SHOULD say for the
 * code-map tenant. Built fresh on every call from the live module objects, so a
 * test that toggles `odEnabled` is compared with what it toggled to.
 *
 * Real offices only: the 'unknown' bucket is code-only and never a row.
 * sortOrder is the office's 1-based position in officeAgents.OFFICES.
 *
 * @returns {RegistryOffice[]}
 */
function codeOffices() {
  // LAZY on purpose: see "NO CYCLE" in the header.
  const officeAgents = require('../config/officeAgents');
  const { OFFICE_OD_SETTINGS } = require('../config/odOffices');
  const keys = Object.keys(officeAgents.OFFICES).filter((k) => k !== officeAgents.UNMAPPED_OFFICE);
  return keys.map((officeKey, i) => {
    const od = OFFICE_OD_SETTINGS[officeKey];
    return {
      officeKey,
      displayName: officeAgents.OFFICES[officeKey].officeName,
      sortOrder: i + 1,
      retellAgentIds: Object.keys(officeAgents.AGENT_OFFICE).filter(
        (id) => officeAgents.AGENT_OFFICE[id] === officeKey
      ),
      mangoDids: Object.keys(officeAgents.MANGO_LINE_OFFICE).filter(
        (did) => officeAgents.MANGO_LINE_OFFICE[did] === officeKey
      ),
      odCustomerKeySecret: od ? od.customerKeySecret : null,
      odCustomerKeyEnv: od ? od.customerKeyEnv : null,
      commTypeDefNums: {
        call: od ? defNum(od.defaultCommTypeDefNum) : null,
        referral: od ? defNum(od.defaultReferralCommTypeDefNum) : null,
      },
      odEnabled: od ? od.odEnabled === true : false,
      hygOdEnabled: od ? od.hygOdEnabled === true : false,
      status: 'active',
    };
  });
}

// --- the parity tripwire's arithmetic ----------------------------------------

/**
 * The field names a parity check can own. 'row' is the office's PRESENCE: in
 * the code maps but not the registry, or the reverse.
 * @typedef {'row'|'displayName'|'sortOrder'|'retellAgentIds'|'mangoDids'|'status'|
 *           'odCustomerKeySecret'|'odCustomerKeyEnv'|'commTypeDefNums.call'|
 *           'commTypeDefNums.referral'|'odEnabled'|'hygOdEnabled'} ParityField
 */

/**
 * @typedef {Object} Divergence
 * @property {string} officeKey
 * @property {ParityField} field
 * @property {unknown} code       what the code map says (and what is SERVED)
 * @property {unknown} registry   what the registry row says
 */

/** @param {RegistryOffice} o @param {ParityField} field @returns {unknown} */
function fieldValue(o, field) {
  switch (field) {
    case 'commTypeDefNums.call':
      return o.commTypeDefNums.call;
    case 'commTypeDefNums.referral':
      return o.commTypeDefNums.referral;
    case 'retellAgentIds':
    case 'mangoDids':
      // Order carries no meaning in a set of ids; sort so it is not a divergence.
      return [...o[field]].sort();
    case 'row':
      return 'present';
    default:
      return o[field];
  }
}

/**
 * Compare the code view with the registry view over `fields`. Pure.
 *
 * Presence ('row') is reported only when it is in `fields`. An office missing
 * from either side has no other field compared: the one 'row' divergence
 * already says everything, and repeating it per field would bury it.
 *
 * @param {RegistryOffice[]} code
 * @param {RegistryOffice[]} reg
 * @param {ReadonlyArray<ParityField>} fields
 * @returns {Divergence[]}
 */
function diffOffices(code, reg, fields) {
  /** @type {Divergence[]} */
  const out = [];
  const regByKey = new Map(reg.map((o) => [o.officeKey, o]));
  const codeByKey = new Map(code.map((o) => [o.officeKey, o]));
  const wantsRow = fields.includes('row');

  for (const c of code) {
    const r = regByKey.get(c.officeKey);
    if (!r) {
      if (wantsRow) out.push({ officeKey: c.officeKey, field: 'row', code: 'present', registry: 'missing' });
      continue;
    }
    for (const field of fields) {
      if (field === 'row') continue;
      const a = fieldValue(c, field);
      const b = fieldValue(r, field);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        out.push({ officeKey: c.officeKey, field, code: a, registry: b });
      }
    }
  }
  if (wantsRow) {
    for (const r of reg) {
      if (!codeByKey.has(r.officeKey)) {
        out.push({ officeKey: r.officeKey, field: 'row', code: 'missing', registry: 'present' });
      }
    }
  }
  return out;
}

/**
 * Build a parity check for one module: compare, warn ONCE per divergent field
 * per process, report clean ONCE, and return what it found. Never throws: a
 * tripwire that could crash the process would be worse than no tripwire.
 *
 * It only ever LOGS. Which value a consumer is served is decided by the
 * caller's getters, not here; `servedCode` only lets the warning SAY which side
 * won: it returns null when the registry value is served, or a short reason
 * when the code value is (MT-1b). Without it the warning says CODE, as in MT-1a.
 *
 * @param {{ label: string, fields: ReadonlyArray<ParityField>,
 *           servedCode?: (d: Divergence) => string|null }} spec
 * @returns {{ check: (offices: RegistryOffice[]) => Divergence[], resetForTests: () => void }}
 */
function createParityCheck({ label, fields, servedCode }) {
  const warned = new Set();
  let reportedClean = false;

  /** @param {RegistryOffice[]} offices */
  function check(offices) {
    try {
      const divergences = diffOffices(codeOffices(), offices, fields);
      for (const d of divergences) {
        const key = `${d.officeKey}.${d.field}`;
        if (warned.has(key)) continue;
        warned.add(key);
        const reason = servedCode ? servedCode(d) : 'MT-1a: the registry is dark';
        console.warn(
          `[${label}] office registry parity: '${d.officeKey}' ${d.field} differs — ` +
            `code=${JSON.stringify(d.code)} registry=${JSON.stringify(d.registry)}. ` +
            (reason === null
              ? 'Serving the REGISTRY value (MT-1b).'
              : `Serving the CODE value (${reason}).`)
        );
      }
      if (divergences.length === 0 && !reportedClean) {
        reportedClean = true;
        console.log(
          `[${label}] office registry parity OK — ${offices.length} office(s), ` +
            `${fields.length} field(s) match the code maps`
        );
      }
      return divergences;
    } catch (err) {
      console.error(
        `[${label}] office registry parity check failed: ${err && err.message ? err.message : String(err)}`
      );
      return [];
    }
  }

  return {
    check,
    resetForTests() {
      warned.clear();
      reportedClean = false;
    },
  };
}

// --- the cache -----------------------------------------------------------------

/**
 * @typedef {Object} TenantCache
 * @property {boolean} loaded           a read has SUCCEEDED at least once
 * @property {RegistryOffice[]} offices the last successful read
 * @property {number} loadedAt          last ATTEMPT (success or failure), ms
 * @property {Promise<unknown>|null} inFlight
 * @property {string|null} lastLoggedError
 * @property {boolean} lastOk           the MOST RECENT read succeeded (MT-1b)
 * @property {number} lastSuccessAt     last SUCCESSFUL read, ms (MT-1b)
 * @property {Map<string, RegistryOffice>|null} servedByKey  active rows by key; a new Map per successful read
 * @property {string|null|undefined} lastServedReason  what servedOffices() last answered (transition log)
 */

/** @type {Map<string, TenantCache>} */
const caches = new Map();

/** @type {Array<(offices: RegistryOffice[], tenantSlug: string) => void>} */
const listeners = [];

/** @type {ReturnType<typeof setInterval>|null} */
let refreshTimer = null;

/** @param {string} tenantSlug @returns {TenantCache} */
function cacheFor(tenantSlug) {
  let c = caches.get(tenantSlug);
  if (!c) {
    c = {
      loaded: false,
      offices: [],
      loadedAt: 0,
      inFlight: null,
      lastLoggedError: null,
      lastOk: false,
      lastSuccessAt: 0,
      servedByKey: null,
      lastServedReason: undefined,
    };
    caches.set(tenantSlug, c);
  }
  return c;
}

/**
 * Be told about every SUCCESSFUL read. A failed read notifies nobody: there is
 * nothing new to compare, and the previous cache is still in force.
 * @param {(offices: RegistryOffice[], tenantSlug: string) => void} listener
 * @returns {void}
 */
function onRefresh(listener) {
  listeners.push(listener);
}

/**
 * Re-read one tenant's offices. NEVER THROWS. On failure the previous cache is
 * kept, the error is logged once per distinct message, and the attempt is
 * stamped so a down control plane is not re-asked on every call.
 *
 * @param {string} [tenantSlug]
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function refreshFromDb(tenantSlug = CODE_MAP_TENANT_SLUG) {
  const c = cacheFor(tenantSlug);
  try {
    const rows = await registry.listTenantOffices(tenantSlug);
    const offices = rows.map((row) => mapRow(/** @type {Record<string, unknown>} */ (row)));
    c.loaded = true;
    c.offices = offices;
    c.loadedAt = Date.now();
    c.lastLoggedError = null;
    c.lastOk = true;
    c.lastSuccessAt = c.loadedAt;
    // A NEW Map per successful read: consumers memoize derived maps on its identity.
    c.servedByKey = new Map(
      offices
        .filter((o) => o.status === 'active' && o.officeKey !== 'unknown')
        .map((o) => [o.officeKey, o])
    );
    for (const listener of listeners) {
      try {
        listener(offices, tenantSlug);
      } catch (err) {
        console.error(`[officeRegistry] refresh listener threw: ${err && err.message ? err.message : String(err)}`);
      }
    }
    return { ok: true, error: null };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (message !== c.lastLoggedError) {
      console.error(
        `[officeRegistry] could not read the offices for '${tenantSlug}': ${message} ` +
          '(keeping the previous read; the code maps answer regardless)'
      );
      c.lastLoggedError = message;
    }
    c.loadedAt = Date.now();
    c.lastOk = false;
    return { ok: false, error: message };
  }
}

/**
 * Refresh when the cache is older than the window. Concurrent callers share one read.
 * @param {string} [tenantSlug]
 * @returns {Promise<void>}
 */
async function ensureFresh(tenantSlug = CODE_MAP_TENANT_SLUG) {
  const c = cacheFor(tenantSlug);
  if (c.loadedAt && Date.now() - c.loadedAt < refreshMinutes() * 60 * 1000) return;
  if (!c.inFlight) {
    c.inFlight = refreshFromDb(tenantSlug).finally(() => {
      c.inFlight = null;
    });
  }
  await c.inFlight;
}

/**
 * One tenant's offices from the cache, without reading. Synchronous. Never
 * read successfully → the code maps.
 * @param {string} [tenantSlug]
 * @returns {OfficesRead}
 */
function cachedOffices(tenantSlug = CODE_MAP_TENANT_SLUG) {
  const c = cacheFor(tenantSlug);
  if (c.loaded) return { source: 'registry', offices: c.offices };
  return { source: 'code', offices: codeOffices() };
}

/**
 * @typedef {Object} ServedOffices
 * @property {Map<string, RegistryOffice>|null} byKey  active rows by office key; null = serve the code maps
 * @property {string|null} reason   why byKey is null; null when it is not
 */

/**
 * What the getters may serve from the registry RIGHT NOW (MT-1b). Synchronous,
 * never reads, never throws. See "WHAT IS SERVED, AND WHEN" in the header.
 *
 * Logs once per TRANSITION (to the registry, to the code maps, or a new
 * reason), never per call: this sits on every attribution and chart-path
 * lookup. The boot state ("never read") is not logged.
 *
 * @param {string} [tenantSlug]
 * @returns {ServedOffices}
 */
function servedOffices(tenantSlug = CODE_MAP_TENANT_SLUG) {
  try {
    const c = cacheFor(tenantSlug);
    /** @type {string|null} */
    let reason = null;
    if (!c.loaded) reason = 'the registry has never been read';
    else if (!c.lastOk) reason = 'the last registry read failed';
    else if (Date.now() - c.lastSuccessAt > maxServedAgeMs()) reason = 'the last good registry read is stale';
    else if (!c.servedByKey) reason = 'no registry rows are cached';

    if (reason !== c.lastServedReason && c.loaded) {
      if (reason === null) {
        console.log(`[officeRegistry] '${tenantSlug}' office config is served from the registry`);
      } else {
        console.warn(`[officeRegistry] '${tenantSlug}' office config is served from the CODE maps: ${reason}`);
      }
    }
    c.lastServedReason = reason;
    return reason === null ? { byKey: c.servedByKey, reason: null } : { byKey: null, reason };
  } catch (err) {
    return { byKey: null, reason: `registry lookup failed: ${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * Refresh if stale, then answer.
 * @param {string} [tenantSlug]
 * @returns {Promise<OfficesRead>}
 */
async function getOffices(tenantSlug = CODE_MAP_TENANT_SLUG) {
  await ensureFresh(tenantSlug);
  return cachedOffices(tenantSlug);
}

/** Keep the code-map tenant's read fresh, so a row changed by a runbook trips parity. */
function startRefreshTimer() {
  if (refreshTimer) return false;
  refreshTimer = setInterval(() => {
    refreshFromDb(CODE_MAP_TENANT_SLUG).catch(() => {});
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

/** TESTS ONLY: forget every read. Listeners stay registered. @returns {void} */
function resetCacheForTests() {
  caches.clear();
  stopRefreshTimer();
}

module.exports = {
  CODE_MAP_TENANT_SLUG,
  mapRow,
  codeOffices,
  diffOffices,
  createParityCheck,
  onRefresh,
  refreshFromDb,
  maxServedAgeMs,
  ensureFresh,
  cachedOffices,
  servedOffices,
  getOffices,
  startRefreshTimer,
  stopRefreshTimer,
  resetCacheForTests,
};
