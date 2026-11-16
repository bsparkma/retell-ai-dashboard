'use strict';

/**
 * A PER-OFFICE dark-launch switch for a TC feature, read at RUN time, for ONE
 * TENANT's office (MT-2b).
 *
 * The checkout handoff (queue item 49) and referrals (item 52) both ship dark,
 * office by office. This is config/tcEmail.js's precedence, generalised from
 * one boolean to a map keyed by office:
 *
 *     <ENV_PREFIX><OFFICE>=false            <- break-glass. Forces OFF. Always,
 *       |                                      for EVERY tenant's office with that key.
 *       | (anything else)
 *     office_setting(tenant, office, key)   <- MT-2b: the served stored layer
 *       | (no row, not served — never read, or no good read in 3 windows)
 *     <ENV_PREFIX><OFFICE>=true             <- the env FALLBACK, tenant 'carein' ONLY
 *       | (unset / unparseable / any other tenant)
 *     false                                 <- the hardcoded floor
 *
 * WHY THE ENV CAN ENABLE ONLY AS A FALLBACK. `=false` beats a stored `true`, so
 * the always-available lever is the safe one. A STORED row beats an enabling
 * env var, so a stale `=true` left from an earlier test cannot re-enable an
 * office somebody switched off in the database. The safety override may only
 * DISABLE; the fallback answers only when nobody has chosen.
 *
 * WHY THE FALLBACK IS 'carein' ONLY (MT-2b, the one PRD change). The env vars
 * are keyed by office key alone and are this deployment's settings for
 * tenant 'carein's offices. Another tenant with an office keyed 'roland' must
 * not be switched on by them. The `=false` break-glass still applies to every
 * tenant: a lever that can only turn things OFF is safe to share.
 *
 * WHICH OFFICES. A key is an office of tenant T only if T has an ACTIVE row in
 * the office registry (platform/officeRegistry.tenantOfficeKeys); for 'carein'
 * with an unreadable registry, the code maps (roland, valley). Anything else —
 * 'unknown', a typo, another tenant's office — is OFF.
 *
 * FRESHNESS WITHOUT A BOOT HOOK. The request paths call
 * `isEnabled(tenant, office)`, which refreshes that tenant's office_setting
 * read first when it is older than the window (platform/officeSettings.js,
 * default 5 minutes, `TC_SWITCH_REFRESH_MINUTES`). Concurrent callers share one
 * read. A failed read keeps serving the last good read — a control-plane blip
 * must not flip a feature either way — until that read is older than three
 * refresh windows; then the answer falls to the env fallback (carein only) and
 * then OFF.
 *
 * WRITES. platform_setting is still written, with office_setting in the same
 * transaction (registry.setPlatformSetting, MT-2a), so a rollback is a source
 * flip. platform_setting has no tenant dimension and holds 'carein's settings,
 * so in this slice only tenant 'carein' can be written; any other tenant is
 * refused (OFFICE_SETTING_TENANT_NOT_WRITABLE) rather than written into
 * carein's rows. MT-2d removes that.
 */

const registry = require('../platform/registry');
const officeSettings = require('../platform/officeSettings');
const officeRegistry = require('../platform/officeRegistry');
const { MT2A_TENANT_SLUG } = require('../platform/officeSettingKeys');

/**
 * One tenant's real offices (MT-1c). Never includes the `unknown` bucket.
 * @param {unknown} tenantSlug
 * @returns {string[]}
 */
function realOffices(tenantSlug) {
  return officeRegistry.tenantOfficeKeys(tenantSlug);
}

/** @param {unknown} tenantSlug @param {unknown} officeKey @returns {boolean} */
function isKnownOffice(tenantSlug, officeKey) {
  return officeRegistry.isTenantOffice(tenantSlug, officeKey);
}

/** The only tenant whose env `=true` fallback answers. @param {unknown} tenantSlug */
function fallbackApplies(tenantSlug) {
  return tenantSlug === MT2A_TENANT_SLUG;
}

/**
 * @param {string} message
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function codedError(message, code) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = code;
  return err;
}

/**
 * Build one switch.
 *
 * @param {{ settingKey: string, envPrefix: string, label: string }} spec
 */
function createOfficeSwitch({ settingKey, envPrefix, label }) {
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
   * The SERVED stored-layer answer: the office's row, or null (nobody chose,
   * or nothing is served). Synchronous.
   * @param {string} tenantSlug
   * @param {string} officeKey
   * @returns {boolean|null}
   */
  function storedFor(tenantSlug, officeKey) {
    const cell = officeSettings.servedCell(tenantSlug, officeKey, settingKey);
    return cell && typeof cell.value === 'boolean' ? cell.value : null;
  }

  /**
   * Is the feature on for this tenant's office, right now, from the cache?
   * Synchronous. An office that is not the tenant's is always OFF.
   * @param {string} tenantSlug
   * @param {string} officeKey
   * @returns {boolean}
   */
  function enabledFor(tenantSlug, officeKey) {
    if (!isKnownOffice(tenantSlug, officeKey)) return false;
    if (envValue(officeKey) === false) return false;
    const stored = storedFor(tenantSlug, officeKey);
    if (stored !== null) return stored;
    return fallbackApplies(tenantSlug) && envValue(officeKey) === true;
  }

  /**
   * Which layer answered.
   * @param {string} tenantSlug
   * @param {string} officeKey
   * @returns {'env'|'db'|'default'}
   */
  function sourceFor(tenantSlug, officeKey) {
    if (envValue(officeKey) === false) return 'env';
    if (isKnownOffice(tenantSlug, officeKey) && storedFor(tenantSlug, officeKey) !== null) return 'db';
    return fallbackApplies(tenantSlug) && isKnownOffice(tenantSlug, officeKey) && envValue(officeKey) === true
      ? 'env'
      : 'default';
  }

  /**
   * Re-read the tenant's office_setting rows. NEVER THROWS.
   * @param {string} tenantSlug
   * @returns {Promise<{ ok: boolean, error: string|null }>}
   */
  async function refreshFromDb(tenantSlug) {
    if (tenantSlug !== officeRegistry.CODE_MAP_TENANT_SLUG && typeof tenantSlug === 'string' && tenantSlug) {
      await officeRegistry.refreshFromDb(tenantSlug).catch(() => {});
    }
    // A failure is logged once per distinct message by platform/officeSettings.js.
    return officeSettings.refreshFromDb(tenantSlug);
  }

  /** Refresh when the read is older than the window. @param {string} tenantSlug */
  async function ensureFresh(tenantSlug) {
    await officeSettings.ensureTenantFresh(tenantSlug);
  }

  /**
   * THE request-path accessor: refresh if stale, then answer.
   * @param {string} tenantSlug
   * @param {string} officeKey
   * @returns {Promise<boolean>}
   */
  async function isEnabled(tenantSlug, officeKey) {
    await ensureFresh(tenantSlug);
    return enabledFor(tenantSlug, officeKey);
  }

  /**
   * Store a new value for ONE office (read-modify-write against the DATABASE),
   * then refresh FROM office_setting and confirm the SERVED row reads back as
   * asked, so what is reported is what is served.
   * @param {string} tenantSlug
   * @param {string} officeKey
   * @param {boolean} enabled
   * @param {string|null} [updatedBy]
   */
  async function persist(tenantSlug, officeKey, enabled, updatedBy = null) {
    if (tenantSlug !== MT2A_TENANT_SLUG) {
      throw codedError(
        `per-office settings can only be written for tenant '${MT2A_TENANT_SLUG}' until platform_setting is retired (MT-2d)`,
        'OFFICE_SETTING_TENANT_NOT_WRITABLE'
      );
    }
    if (!isKnownOffice(tenantSlug, officeKey)) {
      throw codedError(`'${officeKey}' is not an office`, 'INVALID_OFFICE');
    }
    if (typeof enabled !== 'boolean') {
      throw codedError('enabled must be a boolean', 'INVALID_BODY');
    }
    const current = await registry.getPlatformSetting(settingKey);
    const base =
      current && current.value && typeof current.value === 'object' && !Array.isArray(current.value)
        ? { .../** @type {Record<string, unknown>} */ (current.value) }
        : {};
    base[officeKey] = enabled;
    // The registry writes platform_setting AND office_setting in one
    // transaction, and refuses (OFFICE_SETTING_READBACK_MISMATCH) if either
    // table does not read back as asked.
    await registry.setPlatformSetting(settingKey, base, updatedBy, { officeKey });
    const read = await refreshFromDb(tenantSlug);
    if (!read.ok || storedFor(tenantSlug, officeKey) !== enabled) {
      throw codedError('The switch was written but could not be read back', 'SWITCH_READBACK_FAILED');
    }
    return officeState(tenantSlug, officeKey);
  }

  /**
   * What is in force for one office, and why.
   * @param {string} tenantSlug
   * @param {string} officeKey
   */
  function officeState(tenantSlug, officeKey) {
    const cell = isKnownOffice(tenantSlug, officeKey) ? officeSettings.servedCell(tenantSlug, officeKey, settingKey) : null;
    return {
      office: officeKey,
      enabled: enabledFor(tenantSlug, officeKey),
      source: sourceFor(tenantSlug, officeKey),
      policyKnown: officeSettings.isServed(tenantSlug),
      envValue: envValue(officeKey),
      settingKey,
      envVar: envVarFor(officeKey),
      updatedAt: cell ? cell.updatedAt : null,
      updatedBy: cell ? cell.updatedBy : null,
    };
  }

  /** TESTS ONLY: forget every tenant's office_setting read. */
  function resetCacheForTests() {
    officeSettings.resetCacheForTests();
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

module.exports = { createOfficeSwitch, isKnownOffice, realOffices };
