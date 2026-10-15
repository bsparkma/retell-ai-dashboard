'use strict';

/**
 * WHICH provider carries TC text messages (queue item 48).
 *
 *   TC_SMS_PROVIDER=acs      Azure Communication Services SMS (config/acsSms.js).
 *                            THE DEFAULT: unset or blank means acs.
 *   TC_SMS_PROVIDER=twilio   the item-39 Twilio adapter (config/twilio.js). Kept
 *                            as a future per-tenant choice, dormant until named.
 *   anything else            NO provider. Texting is not connected; nothing can
 *                            send. Never "the closest match", never the default.
 *
 * Why the default moved to ACS: a Twilio account that may carry PHI needs
 * Twilio's Security/Enterprise Edition, which is commercially out of reach for
 * CareIN. ACS SMS is covered by the existing Azure BAA, the same decision shape
 * as patient email (D7: PHI stays on Azure). Ruling: PM + Beau, 2026-10-13.
 *
 * Exactly one provider is active per deployment. This decides which SEND
 * adapter adapters/index.js hands out; the two webhook routers stay mounted
 * and each authenticates its own vendor, so a stray callback from the provider
 * that is not selected is still verified before anything is recorded.
 *
 * Read from process.env at CALL time, like every other messaging config.
 */

const PROVIDERS = Object.freeze(['acs', 'twilio']);
const ENV_KEY = 'TC_SMS_PROVIDER';
const DEFAULT_PROVIDER = 'acs';

/** The raw env value, trimmed and lower-cased, or null when unset/blank. @returns {string|null} */
function rawValue() {
  const raw = process.env[ENV_KEY];
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim().toLowerCase();
  return v === '' ? null : v;
}

/**
 * The selected provider, or null when the value names no provider.
 * @returns {'acs'|'twilio'|null}
 */
function smsProvider() {
  const v = rawValue();
  if (v === null) return DEFAULT_PROVIDER;
  return PROVIDERS.includes(v) ? /** @type {'acs'|'twilio'} */ (v) : null;
}

/** For a status line / runbook. Never a secret. */
function state() {
  const raw = rawValue();
  return {
    provider: smsProvider(),
    envKey: ENV_KEY,
    // Echo the value only when it is not a provider name: that is the one case a
    // human needs to see it (a typo), and a provider name is not sensitive.
    invalidValue: raw !== null && !PROVIDERS.includes(raw) ? raw.slice(0, 40) : null,
    defaulted: raw === null,
  };
}

module.exports = { PROVIDERS, ENV_KEY, DEFAULT_PROVIDER, smsProvider, state };
