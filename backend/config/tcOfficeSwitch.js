'use strict';

/**
 * A PER-OFFICE dark-launch switch for a TC feature, read at RUN time.
 *
 * The checkout handoff (queue item 49) and referrals (item 52) both ship dark,
 * office by office. This is config/tcEmail.js's precedence, generalised from
 * one boolean to a map keyed by office, and nothing else:
 *
 *     <ENV_PREFIX><OFFICE>=false            <- break-glass. Forces OFF. Always.
 *       | (anything else)
 *     platform_setting[<key>][<office>]     <- {"roland": true, "valley": false}
 *       | (no row, a row that is not a map, or an office absent from it)
 *     <ENV_PREFIX><OFFICE>=true             <- the env FALLBACK
 *       | (unset / unparseable)
 *     false                                 <- the hardcoded floor
 *
 * WHY THE ENV CAN ENABLE ONLY AS A FALLBACK. `=false` beats a stored `true`, so
 * the always-available lever is the safe one. A STORED row beats an enabling
 * env var, so a stale `=true` left from an earlier test cannot re-enable an
 * office somebody switched off in the database. The safety override may only
 * DISABLE; the fallback answers only when nobody has chosen.
 *
 * WHY AN OFFICE ABSENT FROM A USABLE ROW FALLS THROUGH. Unlike hygPilot (where
 * a row answers for every office), an office the row does not name is treated
 * as "nobody chose" and goes to the env fallback, then OFF. Either way the
 * answer for an unnamed office is OFF unless an env var deliberately says
 * otherwise, which is the stuck-off-safe property this exists for.
 *
 * FRESHNESS WITHOUT A BOOT HOOK. The request paths call `isEnabled(office)`,
 * which refreshes the cache first when it is older than the refresh window
 * (default 5 minutes, `TC_SWITCH_REFRESH_MINUTES`). Concurrent callers share
 * one read. A failed read keeps the previous cache: a control-plane blip must
 * not flip a feature either way. Never read at all => env fallback, then OFF.
 */

const registry = require('../platform/registry');
const { OFFICES } = require('./officeAgents');

/** @param {unknown} officeKey @returns {boolean} */
function isKnownOffice(officeKey) {
  return typeof officeKey === 'string' && Object.prototype.hasOwnProperty.call(OFFICES, officeKey);
}

/** Minutes a cached read stays fresh (default 5). @returns {number} */
function refreshMinutes() {
  const raw = Number(String(process.env.TC_SWITCH_REFRESH_MINUTES ?? '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/**
 * Build one switch.
 *
 * @param {{ settingKey: string, envPrefix: string, label: string }} spec
 */
function createOfficeSwitch({ settingKey, envPrefix, label }) {
  /** @type {{ loaded: boolean, byOffice: Record<string, boolean>|null, loadedAt: number,
   *           updatedAt: string|null, updatedBy: string|null }} */
  let cache = { loaded: false, byOffice: null, loadedAt: 0, updatedAt: null, updatedBy: null };
  /** @type {string|null} */
  let lastLoggedError = null;
  /** @type {Promise<unknown>|null} */
  let inFlight = null;

  /** @param {string} officeKey */
  function envVarFor(officeKey) {
    return envPrefix + String(officeKey).toUpperCase();
  }

  /**
   * The environment's answer for one office: true / false / null.
   * @param {string} officeKey
   * @returns {boolean|null}
   */
  function envValue(officeKey) {
    const raw = process.env[envVarFor(officeKey)];
    if (raw === undefined || raw === null) return null;
    const v = String(raw).trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
  }

  /**
   * A stored jsonb value -> the per-office map, or null when it is not a map.
   * Junk entries are dropped loudly; the rest of the map still applies.
   * @param {unknown} value
   * @returns {Record<string, boolean>|null}
   */
  function parseStored(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    /** @type {Record<string, boolean>} */
    const byOffice = {};
    for (const [key, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (!isKnownOffice(key) || typeof raw !== 'boolean') {
        console.warn(
          `[${label}] platform_setting['${settingKey}']['${key}'] = ${JSON.stringify(raw)} is ignored ` +
            '(not an office, or not a boolean)'
        );
        continue;
      }
      byOffice[key] = raw;
    }
    return byOffice;
  }

  /**
   * Is the feature on for this office, right now, from the cache? Synchronous.
   * An unknown office is always OFF.
   * @param {string} officeKey
   * @returns {boolean}
   */
  function enabledFor(officeKey) {
    if (!isKnownOffice(officeKey)) return false;
    if (envValue(officeKey) === false) return false;
    if (cache.loaded && cache.byOffice && typeof cache.byOffice[officeKey] === 'boolean') {
      return cache.byOffice[officeKey];
    }
    return envValue(officeKey) === true;
  }

  /** Which layer answered. @param {string} officeKey @returns {'env'|'db'|'default'} */
  function sourceFor(officeKey) {
    if (envValue(officeKey) === false) return 'env';
    if (cache.loaded && cache.byOffice && typeof cache.byOffice[officeKey] === 'boolean') return 'db';
    return envValue(officeKey) === true ? 'env' : 'default';
  }

  /**
   * Re-read the stored map. NEVER THROWS; a failed read keeps the previous cache.
   * @returns {Promise<{ ok: boolean, error: string|null }>}
   */
  async function refreshFromDb() {
    try {
      const row = await registry.getPlatformSetting(settingKey);
      lastLoggedError = null;
      const byOffice = row ? parseStored(row.value) : null;
      if (row && byOffice === null) {
        console.warn(
          `[${label}] platform_setting['${settingKey}'] is ${JSON.stringify(row.value)}, not a map — ` +
            'ignoring it (the env fallback, then OFF, answers)'
        );
      }
      cache = {
        loaded: true,
        byOffice,
        loadedAt: Date.now(),
        updatedAt: row && byOffice && row.updated_at ? new Date(row.updated_at).toISOString() : null,
        updatedBy: row && byOffice ? row.updated_by || null : null,
      };
      return { ok: true, error: null };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (message !== lastLoggedError) {
        console.error(`[${label}] could not read the switch: ${message}`);
        lastLoggedError = message;
      }
      // Stamp the attempt so a down control plane is not re-asked on every request.
      cache = { ...cache, loadedAt: Date.now() };
      return { ok: false, error: message };
    }
  }

  /** Refresh when the cache is older than the window. Concurrent callers share one read. */
  async function ensureFresh() {
    if (cache.loadedAt && Date.now() - cache.loadedAt < refreshMinutes() * 60 * 1000) return;
    if (!inFlight) {
      inFlight = refreshFromDb().finally(() => {
        inFlight = null;
      });
    }
    await inFlight;
  }

  /**
   * THE request-path accessor: refresh if stale, then answer.
   * @param {string} officeKey
   * @returns {Promise<boolean>}
   */
  async function isEnabled(officeKey) {
    await ensureFresh();
    return enabledFor(officeKey);
  }

  /**
   * Store a new value for ONE office (read-modify-write against the DATABASE),
   * then refresh FROM the database so what is reported is what was persisted.
   * @param {string} officeKey
   * @param {boolean} enabled
   * @param {string|null} [updatedBy]
   */
  async function persist(officeKey, enabled, updatedBy = null) {
    if (!isKnownOffice(officeKey)) {
      const err = /** @type {Error & { code?: string }} */ (new Error(`'${officeKey}' is not an office`));
      err.code = 'INVALID_OFFICE';
      throw err;
    }
    if (typeof enabled !== 'boolean') {
      const err = /** @type {Error & { code?: string }} */ (new Error('enabled must be a boolean'));
      err.code = 'INVALID_BODY';
      throw err;
    }
    const current = await registry.getPlatformSetting(settingKey);
    const base =
      current && current.value && typeof current.value === 'object' && !Array.isArray(current.value)
        ? { .../** @type {Record<string, unknown>} */ (current.value) }
        : {};
    base[officeKey] = enabled;
    await registry.setPlatformSetting(settingKey, base, updatedBy);
    const read = await refreshFromDb();
    if (!read.ok) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error('The switch was written but could not be read back')
      );
      err.code = 'SWITCH_READBACK_FAILED';
      throw err;
    }
    return officeState(officeKey);
  }

  /** What is in force for one office, and why. @param {string} officeKey */
  function officeState(officeKey) {
    return {
      office: officeKey,
      enabled: enabledFor(officeKey),
      source: sourceFor(officeKey),
      policyKnown: cache.loaded,
      envValue: envValue(officeKey),
      settingKey,
      envVar: envVarFor(officeKey),
      updatedAt: cache.updatedAt,
      updatedBy: cache.updatedBy,
    };
  }

  /** TESTS ONLY. */
  function resetCacheForTests() {
    cache = { loaded: false, byOffice: null, loadedAt: 0, updatedAt: null, updatedBy: null };
    lastLoggedError = null;
    inFlight = null;
  }

  return Object.freeze({
    settingKey,
    envPrefix,
    envVarFor,
    enabledFor,
    sourceFor,
    isEnabled,
    ensureFresh,
    refreshFromDb,
    persist,
    officeState,
    resetCacheForTests,
  });
}

module.exports = { createOfficeSwitch, isKnownOffice };
