'use strict';

/**
 * The TC EMAIL KILL SWITCH, read at RUN time (queue item 40).
 *
 * A mirror of config/tcSms.js (item 39), with the names changed and nothing
 * else. Same precedence, same failure behaviour, same cadence:
 *
 *     TC_EMAIL_ENABLED=false               <- break-glass. Forces OFF. Always.
 *       | (anything else)
 *     platform_setting['tc_email_enabled'] <- a boolean; a runbook writes it
 *       | (no row, or a row that is not a boolean)
 *     TC_EMAIL_ENABLED=true                <- the env FALLBACK
 *       | (unset / unparseable)
 *     false                                <- the hardcoded floor
 *
 * `=false` beats a stored `true`, so the always-available lever is the safe
 * one. A STORED row beats an enabling env var, so a stale `=true` cannot
 * re-enable email somebody switched off in the database. Control DB never
 * readable since boot => only the env fallback or the floor answers.
 *
 * WHAT IT GATES: SENDING only (adapters/emailAdapter.js `enabled()` and the
 * re-check inside `send()`). It does NOT stop the unsubscribe link from
 * recording an opt-out: a patient unsubscribing while email is switched off
 * must still land in tc_contact_consent, or switching email back on would
 * email somebody who asked us to stop.
 *
 * Synchronous accessor over a cache, refreshed at boot, on a timer, and by the
 * adapter immediately before every send.
 */

const registry = require('../platform/registry');

const SETTING_KEY = 'tc_email_enabled';
const ENV_KEY = 'TC_EMAIL_ENABLED';

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

/** Is email sending switched on right now? THE accessor. @returns {boolean} */
function emailEnabled() {
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
 * cache (a blip must not flip email either way).
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
        `[tcEmail] platform_setting['${SETTING_KEY}'] is ${JSON.stringify(row.value)}, not a boolean — ` +
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
      console.error(`[tcEmail] could not read the email switch: ${message}`);
      lastLoggedError = message;
    }
    return { ok: false, value: cache.value, error: message };
  }
}

/** Minutes between background refreshes (default 5). */
function refreshMinutes() {
  const raw = Number(String(process.env.TC_EMAIL_REFRESH_MINUTES ?? '').trim());
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
    enabled: emailEnabled(),
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
  emailEnabled,
  source,
  refreshFromDb,
  startRefreshTimer,
  stopRefreshTimer,
  state,
  resetCacheForTests,
};
