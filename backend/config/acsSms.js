'use strict';

/**
 * Azure Communication Services (ACS) SMS configuration for TC text messaging
 * (queue item 48). Selected by TC_SMS_PROVIDER (config/tcSmsProvider.js),
 * default `acs`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AUTH: THE SAME TWO MODES AS ACS EMAIL (#231), EXACTLY ONE, NEVER A FALLBACK
 * ═════════════════════════════════════════════════════════════════════════════
 *   TC_SMS_ACS_AUTH_MODE=managed_identity (default)
 *       TC_SMS_ACS_ENDPOINT        https://<resource>.communication.azure.com
 *       the container app's user-assigned identity (AZURE_MANAGED_IDENTITY_CLIENT_ID),
 *       Entra token for https://communication.azure.com/.default
 *   TC_SMS_ACS_AUTH_MODE=connection_string
 *       TC_SMS_ACS_CONNECTION      endpoint=https://...;accesskey=...   (Key Vault
 *                                  `tc-sms-acs-connection`)
 *       HMAC-SHA256 request signing, the SAME signer as email
 *       (services/messaging/acs/client.js hmacHeaders)
 * Any other mode value is NOT a mode: SMS is not configured. Parsing is
 * config/acsEmail.js's own (parseConnectionString, AUTH_MODES), not a copy.
 *
 * SMS has its own variables rather than reusing ACS_EMAIL_*: the two may live
 * on different ACS resources, and switching one channel's auth must not
 * silently move the other.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PER OFFICE, NO FALLBACK (the #230 rule)
 * ═════════════════════════════════════════════════════════════════════════════
 *   TC_SMS_ACS_FROM_ROLAND     Roland's ACS number, E.164   (Key Vault
 *   TC_SMS_ACS_FROM_VALLEY     Valley's ACS number, E.164    `tc-sms-acs-from-<office>`)
 * There is deliberately NO shared sender (unlike email's ACS_EMAIL_FROM): a
 * patient who texts back must reach the office that texted them, and inbound
 * office attribution is BY the receiving number. An office without its own
 * number cannot send; it never borrows another's. A value that is not plain
 * E.164 is missing, not "fixed up".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE WEBHOOK (routes/acsSmsWebhooks.js)
 * ═════════════════════════════════════════════════════════════════════════════
 *   TC_SMS_ACS_WEBHOOK_TOKEN   Key Vault `tc-sms-acs-webhook-token`. The shared
 *                              secret Event Grid sends as the static, secret
 *                              delivery header X-CareIN-Webhook-Token. Fewer than
 *                              32 characters is treated as missing: a short
 *                              token on a public endpoint is not a lock.
 *   TC_SMS_ACS_TENANT_SLUG     which tenant's database the webhook writes to
 *                              (a webhook carries no SSO identity; same shape as
 *                              TWILIO_TENANT_SLUG). Resolved through the
 *                              control-plane registry, never guessed.
 * Without the token every webhook request is refused (401).
 *
 * Everything is read from process.env AT CALL TIME.
 */

const { OFFICES } = require('./officeAgents');
const acsEmail = require('./acsEmail');
const { normalizePhone } = require('../services/messaging/address');

const MIN_WEBHOOK_TOKEN_LENGTH = 32;

/** @param {string} name */
function envValue(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  return v === '' ? null : v;
}

/** Strict E.164: + then 8–15 digits, first digit non-zero. @param {unknown} v */
function isE164(v) {
  return typeof v === 'string' && /^\+[1-9]\d{7,14}$/.test(v);
}

/** A real office of this practice group, never the `unknown` bucket. @param {unknown} officeKey */
function isKnownOffice(officeKey) {
  return (
    typeof officeKey === 'string' &&
    officeKey !== 'unknown' &&
    Object.prototype.hasOwnProperty.call(OFFICES, officeKey)
  );
}

/** Per-office sender env var: roland → TC_SMS_ACS_FROM_ROLAND. @param {string} officeKey */
function fromEnvVarFor(officeKey) {
  return 'TC_SMS_ACS_FROM_' + String(officeKey).toUpperCase();
}

/** @returns {'managed_identity'|'connection_string'|null} */
function authMode() {
  const raw = envValue('TC_SMS_ACS_AUTH_MODE') || 'managed_identity';
  return acsEmail.AUTH_MODES.includes(raw) ? /** @type {'managed_identity'|'connection_string'} */ (raw) : null;
}

/** An https origin (no path/query/hash/credentials), or null. @param {string|null} raw */
function httpsOrigin(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  if (u.pathname && u.pathname !== '/') return null;
  return u.origin;
}

/**
 * The resolved account config; null fields where something is missing. The
 * access key is only ever handed to the client that signs with it.
 * @returns {{ mode: 'managed_identity'|'connection_string'|null, endpoint: string|null, accessKey: string|null }}
 */
function accountConfig() {
  const mode = authMode();
  if (mode === 'connection_string') {
    const cs = acsEmail.parseConnectionString(envValue('TC_SMS_ACS_CONNECTION'));
    return { mode, endpoint: cs ? cs.endpoint : null, accessKey: cs ? cs.accessKey : null };
  }
  if (mode === 'managed_identity') {
    return { mode, endpoint: httpsOrigin(envValue('TC_SMS_ACS_ENDPOINT')), accessKey: null };
  }
  return { mode: null, endpoint: null, accessKey: null };
}

/** Names (never values) of what the DEPLOYMENT is missing to send at all. @returns {string[]} */
function missingAccountConfig() {
  const c = accountConfig();
  if (!c.mode) return ['TC_SMS_ACS_AUTH_MODE'];
  if (c.mode === 'connection_string' && !c.endpoint) return ['TC_SMS_ACS_CONNECTION'];
  if (c.mode === 'managed_identity' && !c.endpoint) return ['TC_SMS_ACS_ENDPOINT'];
  return [];
}

function accountConfigured() {
  return missingAccountConfig().length === 0;
}

/**
 * This office's ACS sender (E.164), or null. Never another office's.
 * @param {string} officeKey
 * @returns {string|null}
 */
function fromNumberFor(officeKey) {
  if (!isKnownOffice(officeKey)) return null;
  const v = envValue(fromEnvVarFor(officeKey));
  return isE164(v) ? v : null;
}

/**
 * Names of what THIS office is missing to send (account-level first). Empty
 * means it can send, as far as configuration goes.
 * @param {string} officeKey
 * @returns {string[]}
 */
function missingFor(officeKey) {
  const missing = missingAccountConfig();
  if (!isKnownOffice(officeKey)) return [...missing, 'a known office'];
  if (!fromNumberFor(officeKey)) missing.push(fromEnvVarFor(officeKey));
  return missing;
}

/**
 * The office a RECEIVING number belongs to. Inbound texts derive their office
 * from our side of the conversation (the number they were sent TO; for a
 * delivery report, the number we sent FROM), never from the patient's number.
 * ACS writes numbers with or without the leading `+`; both normalize. Null when
 * no office, or more than one (a configuration error that must not be resolved
 * by picking one), claims it.
 * @param {unknown} raw
 * @returns {string|null}
 */
function officeForReceivingNumber(raw) {
  const e164 = typeof raw === 'string' ? normalizePhone(raw) : null;
  if (!isE164(e164)) return null;
  const owners = Object.keys(OFFICES).filter((k) => fromNumberFor(k) === e164);
  return owners.length === 1 ? owners[0] : null;
}

/** The webhook shared secret, or null when unset or too short to be a lock. @returns {string|null} */
function webhookToken() {
  const v = envValue('TC_SMS_ACS_WEBHOOK_TOKEN');
  return v && v.length >= MIN_WEBHOOK_TOKEN_LENGTH ? v : null;
}

/** @returns {string|null} */
function tenantSlug() {
  return envValue('TC_SMS_ACS_TENANT_SLUG');
}

module.exports = {
  MIN_WEBHOOK_TOKEN_LENGTH,
  isE164,
  isKnownOffice,
  fromEnvVarFor,
  authMode,
  accountConfig,
  missingAccountConfig,
  accountConfigured,
  fromNumberFor,
  missingFor,
  officeForReceivingNumber,
  webhookToken,
  tenantSlug,
};
