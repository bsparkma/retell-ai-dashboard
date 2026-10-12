'use strict';

/**
 * Azure Communication Services (ACS) Email configuration for TC patient email
 * (queue item 40). Patient email goes through ACS under the existing Azure BAA
 * (decision D7). No other provider is wired, and none is a fallback.
 *
 * Read from process.env at call time (never cached here), so a Key Vault load
 * at boot and a test's env override both take effect. NOTHING here is a
 * secret except the connection string, which comes from Key Vault
 * (config/secrets.js: `acs-email-connection` -> ACS_EMAIL_CONNECTION).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AUTH: EXACTLY ONE MODE, NEVER A SILENT FALLBACK
 * ═════════════════════════════════════════════════════════════════════════════
 *   ACS_EMAIL_AUTH_MODE=managed_identity (default)
 *       ACS_EMAIL_ENDPOINT        https://<resource>.communication.azure.com
 *       the container app's user-assigned identity (AZURE_MANAGED_IDENTITY_CLIENT_ID),
 *       Entra token for https://communication.azure.com/.default
 *   ACS_EMAIL_AUTH_MODE=connection_string
 *       ACS_EMAIL_CONNECTION      endpoint=https://...;accesskey=...   (Key Vault)
 *       HMAC-SHA256 request signing with the access key
 * Any other mode value is NOT a mode: email is not configured.
 * The rule is copied from services/rcm/documentOcr.js: a missing identity shows
 * up as an auth error naming the mode, never as "it quietly used the key".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PER OFFICE
 * ═════════════════════════════════════════════════════════════════════════════
 *   ACS_EMAIL_FROM_<OFFICE>       this office's verified sender (MailFrom)
 *   ACS_EMAIL_FROM                a SHARED verified sender, used by an office
 *                                 with no sender of its own (the spec allows
 *                                 "per office or shared verified sender"). It is
 *                                 the deployment's address, not another
 *                                 office's, so this is not a cross-office
 *                                 borrow.
 *   ACS_EMAIL_REPLY_TO_<OFFICE>   optional Reply-To (an ACS-managed DoNotReply
 *                                 sender cannot receive replies, and the stock
 *                                 templates say "reply to this email")
 *   TC_EMAIL_PRACTICE_ADDRESS_<OFFICE>, TC_EMAIL_PRACTICE_PHONE_<OFFICE>
 *                                 optional, plain text, for the footer and the
 *                                 {{practice.address}} / {{practice.phone}} tokens
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE UNSUBSCRIBE LINK NEEDS TWO MORE
 * ═════════════════════════════════════════════════════════════════════════════
 *   TC_EMAIL_PUBLIC_BASE_URL      https origin the patient's browser can reach
 *   TC_EMAIL_TENANT_SLUG          which tenant the public unsubscribe endpoint
 *                                 records into (it carries no user; same shape
 *                                 as TWILIO_TENANT_SLUG)
 * Without both, no email may be sent: an email whose unsubscribe link cannot
 * work is not an email we send. They are part of "configured".
 */

const { OFFICES } = require('./officeAgents');

const AUTH_MODES = Object.freeze(['managed_identity', 'connection_string']);

/** The Entra scope for ACS data-plane calls. */
const ACS_SCOPE = 'https://communication.azure.com/.default';

/** @param {string} name */
function envValue(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  return v === '' ? null : v;
}

/** @param {unknown} officeKey */
function isKnownOffice(officeKey) {
  return (
    typeof officeKey === 'string' &&
    officeKey !== 'unknown' &&
    Object.prototype.hasOwnProperty.call(OFFICES, officeKey)
  );
}

/** One address, no display name, no list. Deliberately plain. @param {unknown} v */
function isEmailAddress(v) {
  return typeof v === 'string' && v.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(v);
}

/**
 * An https origin (no path, query or hash), or null.
 * @param {string|null} raw
 */
function httpsOrigin(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (u.search || u.hash) return null;
  if (u.pathname && u.pathname !== '/') return null;
  return u.origin;
}

/** @returns {'managed_identity'|'connection_string'|null} */
function authMode() {
  const raw = envValue('ACS_EMAIL_AUTH_MODE') || 'managed_identity';
  return AUTH_MODES.includes(raw) ? /** @type {'managed_identity'|'connection_string'} */ (raw) : null;
}

/**
 * Parse `endpoint=https://...;accesskey=...` (case-insensitive keys, any order).
 * @param {string|null} cs
 * @returns {{ endpoint: string, accessKey: string } | null}
 */
function parseConnectionString(cs) {
  if (typeof cs !== 'string' || !cs) return null;
  /** @type {Record<string, string>} */
  const parts = {};
  for (const seg of cs.split(';')) {
    const i = seg.indexOf('=');
    if (i <= 0) continue;
    parts[seg.slice(0, i).trim().toLowerCase()] = seg.slice(i + 1).trim();
  }
  const endpoint = httpsOrigin(parts.endpoint || null);
  const accessKey = parts.accesskey || '';
  if (!endpoint || !accessKey) return null;
  // The key must decode as base64; a key that does not is not a key.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(accessKey) || Buffer.from(accessKey, 'base64').length < 16) return null;
  return { endpoint, accessKey };
}

/**
 * The resolved account config, or null fields where something is missing.
 * The access key is only ever returned to the client module that signs with it.
 */
function accountConfig() {
  const mode = authMode();
  if (mode === 'connection_string') {
    const cs = parseConnectionString(envValue('ACS_EMAIL_CONNECTION'));
    return { mode, endpoint: cs ? cs.endpoint : null, accessKey: cs ? cs.accessKey : null };
  }
  if (mode === 'managed_identity') {
    return { mode, endpoint: httpsOrigin(envValue('ACS_EMAIL_ENDPOINT')), accessKey: null };
  }
  return { mode: null, endpoint: null, accessKey: null };
}

/** https origin for the unsubscribe link, or null. */
function publicBaseUrl() {
  return httpsOrigin(envValue('TC_EMAIL_PUBLIC_BASE_URL'));
}

function tenantSlug() {
  return envValue('TC_EMAIL_TENANT_SLUG');
}

/** Names (never values) of what is missing for the DEPLOYMENT to send at all. */
function missingAccountConfig() {
  const missing = [];
  const c = accountConfig();
  if (!c.mode) missing.push('ACS_EMAIL_AUTH_MODE');
  else if (c.mode === 'connection_string' && !c.endpoint) missing.push('ACS_EMAIL_CONNECTION');
  else if (c.mode === 'managed_identity' && !c.endpoint) missing.push('ACS_EMAIL_ENDPOINT');
  if (!publicBaseUrl()) missing.push('TC_EMAIL_PUBLIC_BASE_URL');
  if (!tenantSlug()) missing.push('TC_EMAIL_TENANT_SLUG');
  return missing;
}

function accountConfigured() {
  return missingAccountConfig().length === 0;
}

/** @param {string} officeKey */
function officeEnvSuffix(officeKey) {
  return String(officeKey).toUpperCase();
}

/**
 * The sender for an office: its own, else the shared one, else null. A value
 * that is not one plain address is treated as missing.
 * @param {string} officeKey
 * @returns {string|null}
 */
function fromAddressFor(officeKey) {
  if (!isKnownOffice(officeKey)) return null;
  const own = envValue(`ACS_EMAIL_FROM_${officeEnvSuffix(officeKey)}`);
  if (own !== null) return isEmailAddress(own) ? own.toLowerCase() : null;
  const shared = envValue('ACS_EMAIL_FROM');
  return isEmailAddress(shared) ? /** @type {string} */ (shared).toLowerCase() : null;
}

/** @param {string} officeKey @returns {string|null} */
function replyToFor(officeKey) {
  if (!isKnownOffice(officeKey)) return null;
  const v = envValue(`ACS_EMAIL_REPLY_TO_${officeEnvSuffix(officeKey)}`);
  return isEmailAddress(v) ? /** @type {string} */ (v).toLowerCase() : null;
}

/** @param {string} officeKey */
function practiceDetailsFor(officeKey) {
  if (!isKnownOffice(officeKey)) return { address: null, phone: null };
  const sfx = officeEnvSuffix(officeKey);
  const address = envValue(`TC_EMAIL_PRACTICE_ADDRESS_${sfx}`);
  const phone = envValue(`TC_EMAIL_PRACTICE_PHONE_${sfx}`);
  return { address: address ? address.slice(0, 300) : null, phone: phone ? phone.slice(0, 40) : null };
}

/**
 * The unsubscribe link for a token, or null when the base is not configured.
 * The token is opaque (random, stored only as a hash); nothing else about the
 * patient or the office is in the URL.
 * @param {string} token
 */
function unsubscribeUrl(token) {
  const base = publicBaseUrl();
  if (!base || typeof token !== 'string' || !token) return null;
  return `${base}/api/webhooks/email/unsubscribe?t=${encodeURIComponent(token)}`;
}

module.exports = {
  AUTH_MODES,
  ACS_SCOPE,
  isKnownOffice,
  isEmailAddress,
  authMode,
  parseConnectionString,
  accountConfig,
  publicBaseUrl,
  tenantSlug,
  missingAccountConfig,
  accountConfigured,
  fromAddressFor,
  replyToFor,
  practiceDetailsFor,
  unsubscribeUrl,
};
