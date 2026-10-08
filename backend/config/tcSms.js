'use strict';

/**
 * The TC text-messaging KILL SWITCH, read at RUN time (queue item 39).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PRECEDENCE (shaped after config/retention.js and config/hygPilot.js)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 *     TC_SMS_ENABLED=false               ← break-glass. Forces OFF. Always.
 *       ↓ (anything else)
 *     platform_setting['tc_sms_enabled'] ← a boolean; a runbook writes it
 *       ↓ (no row, or a row that is not a boolean)
 *     TC_SMS_ENABLED=true                ← the env FALLBACK the spec asks for
 *       ↓ (unset / unparseable)
 *     false                              ← the hardcoded floor
 *
 * Why the env var can turn SMS on here when HYG_OD_ENABLED_<X>=true cannot:
 * the item-39 spec asks for retention's shape ("env fallback"), and texting has
 * a second, independent gate the hygiene switch does not — an office with no
 * Twilio sender in Key Vault is FEATURE_DISABLED whatever this says. But the
 * hygiene lesson still applies in the OFF direction: `=false` beats a stored
 * `true`, so the fast always-available lever is the safe one, and a STORED row
 * beats an enabling env var, so a stale `=true` cannot re-enable texting that
 * somebody switched off in the database.
 *
 * Stuck-off is the safe direction. Control DB never readable since boot ⇒ the
 * stored row is unknown ⇒ only the env fallback or the floor answers.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT GATES — AND WHAT IT DOES NOT
 * ═════════════════════════════════════════════════════════════════════════════
 * It gates SENDING (adapters/smsAdapter.js `enabled()` and the re-check inside
 * `send()`). It does NOT stop the webhooks from recording an inbound STOP: an
 * opt-out arriving while texting is switched off must still land in
 * tc_contact_consent, or switching texting back on would text somebody who
 * asked us to stop.
 *
 * Synchronous accessor over a cache, refreshed at boot, on a timer, and by the
 * adapter immediately before every send (so a row written by a runbook stops
 * the very next send, not the next timer tick).
 */

const registry = require('../platform/registry');

const SETTING_KEY = 'tc_sms_enabled';
const ENV_KEY = 'TC_SMS_ENABLED';

/** @type {{ loaded: boolean, value: boolean|null, updatedAt: string|null, updatedBy: string|null }} */
let cache = { loaded: false, value: null, updatedAt: null, updatedBy: null };

/** @type {string|null} */
let lastLoggedError = null;
/** @type {NodeJS.Timeout|null} */
let refreshTimer = null;

/**
 * The environment's answer: true / false / null (unset or not plainly boolean).
 * @returns {boolean|null}
 */
function envValue() {
  const raw = process.env[ENV_KEY];
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/** Is texting switched on right now? THE accessor. @returns {boolean} */
function smsEnabled() {
  if (envValue() === false) return false;
  if (cache.loaded && cache.value !== null) return cache.value;
  return envValue() === true;
}

/** Which layer answered. @returns {'env'|'db'|'default'} */
function source() {
  if (envValue() === false) return 'env';
  if (cache.loaded && cache.value !== null) return 'db';
  return envValue() === true ? 'env' : 'default';
}

/**
 * Re-read the stored value. NEVER THROWS; a failed read keeps the previous
 * cache (a blip must not flip texting either way).
 * @returns {Promise<{ ok: boolean, value: boolean|null, error: string|null }>}
 */
async function refreshFromDb() {
  try {
    const row = await registry.getPlatformSetting(SETTING_KEY);
    lastLoggedError = null;
    if (!row) {
      cache = { loaded: true, value: null, updatedAt: null, updatedBy: null };
      return { ok: true, value: null, error: null };
    }
    if (typeof row.value !== 'boolean') {
      console.warn(
        `[tcSms] platform_setting['${SETTING_KEY}'] is ${JSON.stringify(row.value)}, not a boolean — ` +
          'ignoring it (the env fallback, then OFF, answers)'
      );
      cache = { loaded: true, value: null, updatedAt: null, updatedBy: null };
      return { ok: true, value: null, error: null };
    }
    cache = {
      loaded: true,
      value: row.value,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row.updated_by || null,
    };
    return { ok: true, value: row.value, error: null };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (message !== lastLoggedError) {
      console.error(`[tcSms] could not read the texting switch: ${message}`);
      lastLoggedError = message;
    }
    return { ok: false, value: cache.value, error: message };
  }
}

/** Minutes between background refreshes (default 5). */
function refreshMinutes() {
  const raw = Number(String(process.env.TC_SMS_REFRESH_MINUTES ?? '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/** Start the background refresh. Idempotent. Unref'd so it never holds the process open. */
function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshFromDb();
  }, refreshMinutes() * 60 * 1000);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

function stopRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/** For a status line / runbook: what is in force and why. */
function state() {
  return {
    enabled: smsEnabled(),
    source: source(),
    policyKnown: cache.loaded,
    dbValue: cache.loaded ? cache.value : null,
    envValue: envValue(),
    settingKey: SETTING_KEY,
    envKey: ENV_KEY,
    updatedAt: cache.updatedAt,
    updatedBy: cache.updatedBy,
  };
}

/** TESTS ONLY. */
function resetCacheForTests() {
  cache = { loaded: false, value: null, updatedAt: null, updatedBy: null };
  lastLoggedError = null;
}

module.exports = {
  SETTING_KEY,
  ENV_KEY,
  smsEnabled,
  source,
  refreshFromDb,
  startRefreshTimer,
  stopRefreshTimer,
  state,
  resetCacheForTests,
};
